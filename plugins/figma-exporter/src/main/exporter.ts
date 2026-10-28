import {
  MAX_UNACKED_CHUNKS, NODES_PER_SLICE, PLUGIN_VERSION, PREVIEW_MAX_EDGE, PREVIEW_MAX_PIXELS, SCREEN_PREVIEW_MAX_EDGE, PROTOCOL_VERSION, READER_VERSION, SLICE_MS,
  canonicalJson, hiddenNode, type NodeVisibility, type ChunkKind, type DependencyRecord, type ExportLimits, type FieldValue, type HelloInfo, type InventoryRecord, type Json, type NodeRecord, type PageInfo, type PluginEvent, type RootInfo,
} from '../../../../src/shared/figma.js';
import { sha256Bytes, sha256Text, utf8 } from '../../../../src/shared/sha256.js';
import type { FinishedSummary, MainToUi, StartExport } from '../messages.js';
import { References, collectBound, readNodeFields } from './reader.js';
import { fieldError, fieldRead, toJson } from './serialize.js';

/** What the exporter needs from the plugin glue: a way to send to the UI, to give the UI a turn, and to wait for it to store data. */
export interface Host {
  send(message: MainToUi): void;
  /** Gives the UI a turn so Figma can process interaction and a cancel; resolves when the UI has taken it. */
  yieldToUi(): Promise<void>;
  /** Hands data to the UI for upload. Resolves when fewer than MAX_UNACKED_CHUNKS are waiting for the server's acknowledgement. */
  data(message: { kind: ChunkKind; text?: string; bytes?: Uint8Array; assetId?: string; offset?: number; final?: boolean }): Promise<void>;
  /** The most pieces that were waiting for the server's acknowledgement at once, so far. */
  peakUnacked(): number;
  /** Resolves when everything handed over so far has been acknowledged. */
  drain(): Promise<void>;
  now(): number;
}

type Any = Record<string, any>;
const FLUSH_BYTES = 192 * 1024;
const SCREEN_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);
const VECTOR_EXPORT_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION']);
const MAX_VECTOR_EXPORTS = 2000, MAX_PREVIEWS = 100;
const STYLE_FIELDS: Record<string, string[]> = {
  PAINT: ['paints'], EFFECT: ['effects'], GRID: ['layoutGrids'],
  TEXT: ['fontName', 'fontSize', 'letterSpacing', 'lineHeight', 'paragraphIndent', 'paragraphSpacing', 'textCase', 'textDecoration', 'listSpacing', 'leadingTrim'],
};

class Cancelled extends Error {}
class LimitReached extends Error { constructor(readonly which: 'time' | 'nodes' | 'bytes' | 'asset') { super(which); } }

const randomId = (): string => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 24; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
};

export class Exporter {
  readonly sourceSession = randomId();
  private cancelled = false;
  private running = false;

  constructor(private readonly figma: PluginAPI, private readonly host: Host, private readonly info: { bundleHash?: string } = {}) {}

  // ---------------------------------------------------------------- questions the server asks

  async hello(): Promise<HelloInfo> {
    const figma = this.figma as unknown as Any;
    let fileKey: string | undefined;
    try { fileKey = typeof figma.fileKey === 'string' && figma.fileKey ? figma.fileKey : undefined; } catch { fileKey = undefined; }
    const current = figma.currentPage as Any;
    return {
      protocolVersion: PROTOCOL_VERSION, readerVersion: READER_VERSION, pluginVersion: PLUGIN_VERSION, ...(this.info.bundleHash ? { bundleHash: this.info.bundleHash } : {}),
      editorType: String(figma.editorType ?? 'unknown'), apiVersion: String(figma.apiVersion ?? 'unknown'), fileName: String(figma.root?.name ?? ''), ...(fileKey ? { fileKey } : {}),
      pages: this.pages(), selection: (current.selection ?? []).map((n: Any) => this.rootInfo(n, current)), currentPageId: String(current.id), sourceSession: this.sourceSession,
    };
  }

  pages(): PageInfo[] {
    return ((this.figma.root as unknown as Any).children as Any[]).map((p) => {
      // A page's children are readable only once it is loaded; for the others the count is unknown, not zero.
      let childCount = -1;
      try { if (p.id === (this.figma.currentPage as Any).id) childCount = p.children.length; } catch { childCount = -1; }
      return { id: String(p.id), name: String(p.name), childCount };
    });
  }

  async roots(pageId: string): Promise<RootInfo[]> {
    const page = ((this.figma.root as unknown as Any).children as Any[]).find((p) => p.id === pageId);
    if (!page) throw Object.assign(new Error(`Không có trang ${pageId}`), { code: 'root_missing' });
    await page.loadAsync();
    return (page.children as Any[]).map((n) => this.rootInfo(n, page));
  }

  private rootInfo(node: Any, page: Any): RootInfo {
    let p: Any | null = node;
    while (p && p.type !== 'PAGE') p = p.parent;
    return { id: String(node.id), name: String(node.name), type: String(node.type), pageId: String((p ?? page).id), pageName: String((p ?? page).name) };
  }

  cancel(): void { this.cancelled = true; }
  get busy(): boolean { return this.running; }

  // ---------------------------------------------------------------- the export

  async run(cmd: StartExport): Promise<void> {
    if (this.running) { this.host.send({ type: 'EVENT', event: { type: 'error', jobId: cmd.jobId, code: 'bad_command', message: 'Exporter đang chạy một export khác.' } }); return; }
    this.running = true; this.cancelled = false;
    const figma = this.figma as unknown as Any;
    const startedAt = this.host.now();
    const deadline = startedAt + cmd.limits.jobMs;
    const writers = new Map<ChunkKind, string>();
    const errors: FinishedSummary['errors'] = [];
    const quick = new Map<string, string>();
    const changed: string[] = [];
    let documentChanges = 0, watched = false, limitReached: FinishedSummary['limitReached'] = null;
    let nodeCount = 0, bytesSent = 0, dependencyCount = 0, assetCount = 0, pageCount = 0;
    let lastProgress = 0;
    const previousSkip = figma.skipInvisibleInstanceChildren;
    const onChange = () => { documentChanges++; };

    const phase = (p: Extract<PluginEvent, { type: 'phase' }>['phase'], note?: string) => this.host.send({ type: 'EVENT', event: { type: 'phase', jobId: cmd.jobId, phase: p, nodes: nodeCount, bytes: bytesSent, ...(note ? { note } : {}) } });
    const check = () => {
      if (this.cancelled) throw new Cancelled();
      if (this.host.now() > deadline) throw new LimitReached('time');
    };
    const yieldNow = async () => { check(); await this.host.yieldToUi(); check(); };
    const flush = async (kind: ChunkKind, force = false) => {
      const text = writers.get(kind) ?? '';
      if (!text || (!force && text.length < FLUSH_BYTES)) return;
      writers.set(kind, '');
      bytesSent += text.length;
      await this.host.data({ kind, text });
    };
    const write = async (kind: ChunkKind, record: unknown) => { writers.set(kind, `${writers.get(kind) ?? ''}${JSON.stringify(record)}\n`); await flush(kind); };
    const progress = (force = false) => {
      const now = this.host.now();
      if (!force && now - lastProgress < 500) return;
      lastProgress = now;
      this.host.send({ type: 'EVENT', event: { type: 'progress', jobId: cmd.jobId, nodes: nodeCount, bytes: bytesSent, unacked: this.host.peakUnacked() } });
    };
    const sendAsset = async (assetId: string, bytes: Uint8Array) => {
      for (let offset = 0; offset < bytes.length || offset === 0; offset += cmd.chunkBytes) {
        const piece = bytes.subarray(offset, Math.min(bytes.length, offset + cmd.chunkBytes));
        bytesSent += piece.length;
        await this.host.data({ kind: 'asset', bytes: piece, assetId, offset, final: offset + piece.length >= bytes.length });
        if (bytes.length === 0) break;
      }
    };

    try {
      phase('preparing');
      const expected = await this.scopeHashOf(cmd);
      if (expected !== cmd.scopeHash) throw Object.assign(new Error('Phạm vi hoặc phiên nguồn của lệnh không khớp plugin này.'), { code: 'source_mismatch' });

      // Load what has to be read. Whole file loads every page first, then listens for changes; a smaller scope loads only its own pages.
      phase('loading_pages', 'Đang tải các trang');
      const roots = await this.resolveRoots(cmd);
      if (cmd.scope === 'file') {
        await figma.loadAllPagesAsync();
        try { figma.on('documentchange', onChange); watched = true; } catch { watched = false; }
      }
      figma.skipInvisibleInstanceChildren = false;
      check();

      // Pass 1: inventory. Iterative, in document order; nothing is skipped (hidden, locked, instance children included).
      phase('inventory');
      const list: Any[] = [];
      const pageOf = new Map<string, string>();
      const walkInventory = async (kind: 'inventory' | 'verification', sink: (n: Any, record: InventoryRecord) => void) => {
        let seen = 0;
        for (const root of roots) {
          const stack: { node: Any; parentId: string | null; index: number; depth: number; pageId: string }[] = [{ node: root, parentId: this.parentOf(root, roots), index: Math.max(0, this.indexOf(root)), depth: 0, pageId: this.pageIdOf(root) }];
          while (stack.length) {
            const { node, parentId, index, depth, pageId } = stack.pop()!;
            const children: Any[] = 'children' in node && Array.isArray(node.children) ? node.children : [];
            const record: InventoryRecord = { k: 'inv', id: String(node.id), type: String(node.type), pageId, parentId, index, childIds: children.map((c) => String(c.id)) };
            if (kind === 'inventory' && nodeCount >= cmd.limits.maxNodes) throw new LimitReached('nodes');
            sink(node, record);
            await write(kind, record);
            if (kind === 'inventory') { nodeCount++; if (node.type === 'PAGE') pageCount++; }
            for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], parentId: String(node.id), index: i, depth: depth + 1, pageId });
            if (++seen % NODES_PER_SLICE === 0) { progress(); await yieldNow(); }
          }
        }
        await flush(kind, true);
      };
      const depthOf = new Map<string, number>();
      await walkInventory('inventory', (node, record) => {
        list.push(node); pageOf.set(record.id, record.pageId);
        depthOf.set(record.id, record.parentId !== null && depthOf.has(record.parentId) ? depthOf.get(record.parentId)! + 1 : 0);
      });

      // Pass 2: read each node's properties.
      phase('reading');
      const refs = new References();
      const inScope = new Set(list.map((n) => String(n.id)));
      const visibility = new Map<string, NodeVisibility>();
      let sliceStart = this.host.now(), sliceCount = 0;
      for (const node of list) {
        const id = String(node.id);
        let fields: Record<string, FieldValue>, groups: NodeRecord['groups'];
        try { ({ fields, groups } = await readNodeFields(node, { mixed: figma.mixed, refs })); }
        catch (error) { fields = { 'common.name': fieldError(error, 'readNodeFields') }; groups = { common: 'partial' }; errors.push({ code: 'internal', message: `Node ${id}: ${String((error as Error)?.message ?? error).slice(0, 200)}` }); }
        const inv = this.inventoryOf(node, pageOf, depthOf);
        const visible = fields['common.visible'];
        visibility.set(id, { parentId: inv.parentId, visible: visible?.s === 'read' && typeof visible.v === 'boolean' ? visible.v : undefined });
        const core = { id, type: inv.type, name: String(node.name ?? ''), pageId: inv.pageId, parentId: inv.parentId, index: inv.index, depth: depthOf.get(id) ?? 0, childIds: inv.childIds, groups, fields, k: 'node' as const };
        const record: NodeRecord = { ...core, hash: sha256Text(canonicalJson(core)) };
        quick.set(id, this.quickHash(node, figma.mixed));
        await write('nodes', record);
        if (++sliceCount >= NODES_PER_SLICE || this.host.now() - sliceStart >= SLICE_MS) { progress(); await yieldNow(); sliceStart = this.host.now(); sliceCount = 0; }
      }
      await flush('nodes', true);

      // Pass 3: dependencies, then the assets they point to.
      phase('dependencies');
      const sentAssets = new Set<string>();
      const dependency = async (record: DependencyRecord) => { dependencyCount++; await write('dependencies', record); };
      await this.readDependencies(cmd, refs, inScope, dependency, yieldNow, errors);
      await flush('dependencies', true);

      phase('assets');
      const assetRecord = async (rec: Extract<DependencyRecord, { k: 'asset' }>) => { assetCount++; await dependency(rec); };
      await this.readImages(cmd.limits, refs, assetRecord, async (rec, bytes) => { if (!sentAssets.has(rec.id)) { sentAssets.add(rec.id); await sendAsset(rec.id, bytes); } }, dependency, yieldNow, sentAssets);
      await this.readVectors(cmd.limits, list, visibility, assetRecord, async (rec, bytes) => { sentAssets.add(rec.id); await sendAsset(rec.id, bytes); }, yieldNow);
      await this.readPreviews(cmd, roots, assetRecord, async (rec, bytes) => { if (!sentAssets.has(rec.id)) { sentAssets.add(rec.id); await sendAsset(rec.id, bytes); } }, yieldNow);
      await flush('dependencies', true);

      // Pass 4: read the inventory again and compare it, and a hash of each node's main facts, with the first pass.
      phase('verifying');
      let again = 0;
      await walkInventory('verification', (node, record) => {
        again++;
        const first = quick.get(record.id);
        if (first === undefined || first !== this.quickHash(node, figma.mixed)) changed.push(record.id);
      });
      if (again !== list.length && !changed.length) changed.push('count');
      phase('assembling');
      await flush('verification', true);
      await this.host.drain();
      progress(true);
      this.host.send({ type: 'FINISHED', summary: {
        jobId: cmd.jobId, totals: { nodes: nodeCount, pages: pageCount, dependencies: dependencyCount, assets: assetCount },
        verification: { passes: 2, sourceChanged: changed.length > 0 || documentChanges > 0, changedIds: changed.slice(0, 50), documentChanges, watchedDocumentChanges: watched },
        stats: { peakUnackedChunks: Math.min(this.host.peakUnacked(), MAX_UNACKED_CHUNKS), durationMs: this.host.now() - startedAt, restoredSkipInvisible: true }, limitReached, errors,
      } });
    } catch (error) {
      if (error instanceof Cancelled || this.cancelled) this.host.send({ type: 'EVENT', event: { type: 'cancelled', jobId: cmd.jobId } });
      else if (error instanceof LimitReached) {
        limitReached = error.which;
        // The data collected so far is still sent, so the person can see what was read; the server will not let it be published.
        try {
          for (const kind of ['inventory', 'nodes', 'dependencies', 'verification'] as ChunkKind[]) await flush(kind, true);
          await this.host.drain();
          this.host.send({ type: 'FINISHED', summary: {
            jobId: cmd.jobId, totals: { nodes: nodeCount, pages: pageCount, dependencies: dependencyCount, assets: assetCount },
            verification: { passes: 1, sourceChanged: false, changedIds: [], documentChanges, watchedDocumentChanges: watched },
            stats: { peakUnackedChunks: Math.min(this.host.peakUnacked(), MAX_UNACKED_CHUNKS), durationMs: this.host.now() - startedAt, restoredSkipInvisible: true }, limitReached, errors,
          } });
        } catch { this.host.send({ type: 'EVENT', event: { type: 'error', jobId: cmd.jobId, code: 'limit_reached', message: `Chạm giới hạn ${error.which}.` } }); }
      } else {
        const code = String((error as { code?: unknown })?.code ?? 'internal');
        this.host.send({ type: 'EVENT', event: { type: 'error', jobId: cmd.jobId, code, message: String((error as Error)?.message ?? error).slice(0, 400) } });
      }
    } finally {
      try { figma.skipInvisibleInstanceChildren = previousSkip; } catch { /* the previous value could not be put back */ }
      try { if (watched) figma.off('documentchange', onChange); } catch { /* listener already gone */ }
      this.running = false;
    }
  }

  private async scopeHashOf(cmd: StartExport): Promise<string> {
    const sorted = (xs: readonly string[]) => [...xs].sort();
    return sha256Text(canonicalJson({ scope: cmd.scope, rootIds: sorted(cmd.rootIds), pageIds: sorted(cmd.pageIds), sourceSession: this.sourceSession, limits: cmd.limits }));
  }

  /** The nodes the export starts from. Roots inside another root are dropped; the order of the rest is the document's own. */
  private async resolveRoots(cmd: StartExport): Promise<Any[]> {
    const figma = this.figma as unknown as Any;
    const pages = (figma.root.children as Any[]);
    if (cmd.scope === 'file' || cmd.scope === 'pages') {
      const wanted = cmd.scope === 'file' ? pages : cmd.pageIds.map((id) => pages.find((p) => p.id === id));
      if (wanted.some((p) => !p)) throw Object.assign(new Error('Một trang đã chọn không còn trong file.'), { code: 'root_missing' });
      if (cmd.scope === 'pages') for (const p of wanted) await p!.loadAsync();
      return wanted as Any[];
    }
    const found: Any[] = [];
    for (const id of cmd.rootIds) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node) throw Object.assign(new Error(`Node gốc ${id} không còn trong file.`), { code: 'root_missing' });
      found.push(node);
    }
    const ids = new Set(found.map((n) => String(n.id)));
    const top = found.filter((n) => { for (let p = n.parent; p; p = p.parent) if (ids.has(String(p.id))) return false; return true; });
    const pagesToLoad = new Set(top.map((n) => this.pageOfNode(n)).filter(Boolean));
    for (const p of pagesToLoad) await (p as Any).loadAsync();
    return top;
  }

  private pageOfNode(node: Any): Any | null { let p: Any | null = node; while (p && p.type !== 'PAGE') p = p.parent; return p; }
  private pageIdOf(node: Any): string { return String((this.pageOfNode(node) ?? node).id); }
  private parentOf(root: Any, roots: Any[]): string | null { void roots; return root.parent ? String(root.parent.id) : null; }
  private indexOf(node: Any): number { const siblings = node.parent && Array.isArray(node.parent.children) ? node.parent.children : null; return siblings ? siblings.indexOf(node) : 0; }

  private inventoryOf(node: Any, pageOf: Map<string, string>, depthOf: Map<string, number>): InventoryRecord {
    void depthOf;
    const children: Any[] = 'children' in node && Array.isArray(node.children) ? node.children : [];
    const parent = node.parent ?? null;
    return { k: 'inv', id: String(node.id), type: String(node.type), pageId: pageOf.get(String(node.id)) ?? this.pageIdOf(node), parentId: parent ? String(parent.id) : null,
      index: parent && Array.isArray(parent.children) ? parent.children.indexOf(node) : 0, childIds: children.map((c) => String(c.id)) };
  }

  /** A small hash of what a person would change by editing: structure, name, visibility, geometry and text. */
  private quickHash(node: Any, mixed: unknown): string {
    const pick = (name: string): Json => { try { return name in node ? toJson(node[name], mixed).value : null; } catch { return { $error: true }; } };
    const children: Any[] = 'children' in node && Array.isArray(node.children) ? node.children : [];
    return sha256Text(canonicalJson({ id: node.id, type: node.type, name: pick('name'), visible: pick('visible'), locked: pick('locked'), t: pick('relativeTransform'), w: pick('width'), h: pick('height'), c: pick('characters'), fills: pick('fills'), strokes: pick('strokes'), effects: pick('effects'), kids: children.map((c) => c.id) })).slice(0, 24);
  }

  // ---------------------------------------------------------------- dependencies

  private async readDependencies(cmd: StartExport, refs: References, inScope: Set<string>, emit: (r: DependencyRecord) => Promise<void>, yieldNow: () => Promise<void>, errors: FinishedSummary['errors']): Promise<void> {
    const figma = this.figma as unknown as Any;
    const mixed = figma.mixed;
    const styleIds = new Set(refs.styles.keys());
    const variableIds = new Set(refs.variables.keys());
    const collectionIds = new Set<string>();
    if (cmd.scope === 'file') {
      for (const fn of ['getLocalPaintStylesAsync', 'getLocalTextStylesAsync', 'getLocalEffectStylesAsync', 'getLocalGridStylesAsync']) {
        try { for (const s of await figma[fn]()) styleIds.add(String(s.id)); } catch (error) { errors.push({ code: 'internal', message: `${fn}: ${String((error as Error)?.message ?? error).slice(0, 160)}` }); }
      }
      try { for (const c of await figma.variables.getLocalVariableCollectionsAsync()) { collectionIds.add(String(c.id)); for (const v of c.variableIds as string[]) variableIds.add(String(v)); } }
      catch (error) { errors.push({ code: 'internal', message: `getLocalVariableCollectionsAsync: ${String((error as Error)?.message ?? error).slice(0, 160)}` }); }
    }
    const readProps = (obj: Any, names: string[]): Record<string, FieldValue> => {
      const out: Record<string, FieldValue> = {};
      for (const name of names) {
        if (!(name in obj)) { out[name] = { s: 'not_applicable', r: `không có ${name}`, a: name }; continue; }
        try { const v = toJson(obj[name], mixed); out[name] = v.truncated ? { s: 'error', r: 'Giá trị quá sâu; đã cắt.', a: name, v: v.value } : fieldRead(v.value, name); } catch (error) { out[name] = fieldError(error, name); }
      }
      return out;
    };
    let n = 0;
    for (const id of styleIds) {
      let style: Any | null = null;
      try { style = await figma.getStyleByIdAsync(id); } catch { style = null; }
      if (style) {
        const type = String(style.type);
        await emit({ k: 'style', id, styleType: type, name: String(style.name), key: style.key, description: style.description, remote: !!style.remote, fields: readProps(style, STYLE_FIELDS[type] ?? []), usedBy: [...(refs.styles.get(id) ?? [])].slice(0, 20) });
        for (const v of Object.values(readProps(style, STYLE_FIELDS[type] ?? []))) if (v.s === 'read') collectBound(v.v, { mixed, refs }, id);
      }
      if (++n % 50 === 0) await yieldNow();
    }
    // Variables, following aliases until nothing new turns up. Each id is visited once, so an alias cycle ends.
    const queue = [...variableIds], visited = new Set<string>();
    while (queue.length) {
      const id = queue.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      let v: Any | null = null;
      try { v = await figma.variables.getVariableByIdAsync(id); } catch { v = null; }
      if (!v) continue;
      const valuesByMode: Record<string, FieldValue> = {};
      const aliasIssues: string[] = [];
      for (const [modeId, value] of Object.entries((v.valuesByMode ?? {}) as Record<string, unknown>)) {
        const alias = value && typeof value === 'object' && (value as Any).type === 'VARIABLE_ALIAS' ? String((value as Any).id) : undefined;
        if (alias) { valuesByMode[modeId] = fieldRead({ alias }, 'valuesByMode'); if (!visited.has(alias)) queue.push(alias); }
        else { const j = toJson(value, mixed); valuesByMode[modeId] = fieldRead(j.value, 'valuesByMode'); }
      }
      collectionIds.add(String(v.variableCollectionId));
      await emit({ k: 'variable', id, name: String(v.name), key: v.key, collectionId: String(v.variableCollectionId), resolvedType: String(v.resolvedType), remote: !!v.remote, description: v.description, scopes: Array.isArray(v.scopes) ? v.scopes.map(String) : undefined, valuesByMode, ...(aliasIssues.length ? { aliasIssues } : {}), usedBy: [...(refs.variables.get(id) ?? [])].slice(0, 20) });
      if (++n % 50 === 0) await yieldNow();
    }
    for (const id of collectionIds) {
      let c: Any | null = null;
      try { c = await figma.variables.getVariableCollectionByIdAsync(id); } catch { c = null; }
      if (c) await emit({ k: 'collection', id, name: String(c.name), key: c.key, remote: !!c.remote, modes: (c.modes ?? []).map((m: Any) => ({ modeId: String(m.modeId), name: String(m.name) })), defaultModeId: c.defaultModeId, variableIds: (c.variableIds ?? []).map(String) });
    }
    for (const [id, users] of refs.components) {
      let comp: Any | null = null, reason: string | undefined;
      try { comp = await figma.getNodeByIdAsync(id); } catch (error) { reason = String((error as Error)?.message ?? error).slice(0, 200); }
      const usedBy = [...users].slice(0, 20);
      if (!comp) await emit({ k: 'component', id, name: '', remote: true, scope: 'unavailable', reason: reason ?? 'Không đọc được main component (thư viện ngoài hoặc không đủ quyền).', usedBy });
      else await emit({ k: 'component', id, key: comp.key, name: String(comp.name), remote: !!comp.remote, description: comp.description, componentSetId: comp.parent && comp.parent.type === 'COMPONENT_SET' ? String(comp.parent.id) : null, scope: inScope.has(id) ? 'in_scope' : 'dependency_only', usedBy });
    }
  }

  private mimeOf(bytes: Uint8Array): string {
    const b = bytes;
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return 'application/octet-stream';
  }

  private async readImages(limits: ExportLimits, refs: References, asset: (r: Extract<DependencyRecord, { k: 'asset' }>) => Promise<void>, send: (r: Extract<DependencyRecord, { k: 'asset' }>, bytes: Uint8Array) => Promise<void>, dependency: (r: DependencyRecord) => Promise<void>, yieldNow: () => Promise<void>, seen: Set<string>): Promise<void> {
    const figma = this.figma as unknown as Any;
    let n = 0;
    for (const [hash, users] of refs.images) {
      const list = users.slice(0, 50);
      try {
        const image = figma.getImageByHash(hash);
        if (!image) { await dependency({ k: 'imageRef', hash, refs: list, status: 'missing', reason: 'figma.getImageByHash không trả ảnh' }); continue; }
        const bytes: Uint8Array = await image.getBytesAsync();
        if (bytes.length > limits.maxAssetBytes) { await dependency({ k: 'imageRef', hash, refs: list, status: 'oversize', reason: `${bytes.length} byte vượt ${limits.maxAssetBytes}` }); await asset({ k: 'asset', id: hash, assetKind: 'original_image', mime: this.mimeOf(bytes), bytes: bytes.length, sha256: '', source: { imageHash: hash }, status: 'oversize' }); continue; }
        const id = sha256Bytes(bytes);
        let width: number | undefined, height: number | undefined;
        try { const size = await image.getSizeAsync(); width = size.width; height = size.height; } catch { /* the size is a convenience */ }
        const rec: Extract<DependencyRecord, { k: 'asset' }> = { k: 'asset', id, assetKind: 'original_image', mime: this.mimeOf(bytes), bytes: bytes.length, sha256: id, source: { imageHash: hash }, status: 'stored', ...(width ? { width, height } : {}) };
        if (!seen.has(id)) await asset(rec);
        await send(rec, bytes);
        await dependency({ k: 'imageRef', hash, refs: list, status: 'bytes', assetId: id });
      } catch (error) {
        await dependency({ k: 'imageRef', hash, refs: list, status: 'error', reason: String((error as Error)?.message ?? error).slice(0, 200) });
      }
      if (++n % 5 === 0) await yieldNow();
    }
  }

  private async readVectors(limits: ExportLimits, list: Any[], visibility: ReadonlyMap<string, NodeVisibility>, asset: (r: Extract<DependencyRecord, { k: 'asset' }>) => Promise<void>, send: (r: Extract<DependencyRecord, { k: 'asset' }>, bytes: Uint8Array) => Promise<void>, yieldNow: () => Promise<void>): Promise<void> {
    let n = 0, visited = 0;
    const done = new Set<string>();
    for (const node of list) {
      if (!VECTOR_EXPORT_TYPES.has(String(node.type))) continue;
      const nodeId = String(node.id);
      if (++visited % 100 === 0) await yieldNow();
      const hidden = hiddenNode(nodeId, visibility);
      if (hidden) {
        await asset({ k: 'asset', id: `vector:${nodeId}`, assetKind: 'vector_export', mime: 'image/svg+xml', bytes: 0, sha256: '', source: { nodeId }, status: 'missing',
          reason: `Không xuất SVG vì ${hidden === nodeId ? 'node này' : `layer cha ${hidden}`} đang ẩn. Cấu trúc và thuộc tính vẫn được lưu; SVG cần xuất lại nếu bật hiển thị.` });
        continue;
      }
      if (n >= MAX_VECTOR_EXPORTS) { await asset({ k: 'asset', id: `vector:${nodeId}`, assetKind: 'vector_export', mime: 'image/svg+xml', bytes: 0, sha256: '', source: { nodeId }, status: 'missing', reason: `Quá ${MAX_VECTOR_EXPORTS} vector; chỉ lấy SVG cho ${MAX_VECTOR_EXPORTS} vector đầu` }); continue; }
      n++;
      try {
        const svg: string = await node.exportAsync({ format: 'SVG_STRING' });
        const bytes = utf8(svg);
        if (bytes.length > limits.maxAssetBytes) { await asset({ k: 'asset', id: `vector:${nodeId}`, assetKind: 'vector_export', mime: 'image/svg+xml', bytes: bytes.length, sha256: '', source: { nodeId }, status: 'oversize' }); continue; }
        const id = sha256Bytes(bytes);
        const rec: Extract<DependencyRecord, { k: 'asset' }> = { k: 'asset', id, assetKind: 'vector_export', mime: 'image/svg+xml', bytes: bytes.length, sha256: id, source: { nodeId }, status: 'stored' };
        if (!done.has(id)) { done.add(id); await asset(rec); await send(rec, bytes); }
      } catch (error) {
        await asset({ k: 'asset', id: `vector:${nodeId}`, assetKind: 'vector_export', mime: 'image/svg+xml', bytes: 0, sha256: '', source: { nodeId }, status: 'error', reason: String((error as Error)?.message ?? error).slice(0, 200) });
      }
      if (n % 10 === 0) await yieldNow();
    }
  }

  /** Stop at the first screen boundary: nested layout frames and component internals are not separate screens. */
  private async readPreviews(cmd: StartExport, roots: Any[], asset: (r: Extract<DependencyRecord, { k: 'asset' }>) => Promise<void>, send: (r: Extract<DependencyRecord, { k: 'asset' }>, bytes: Uint8Array) => Promise<void>, yieldNow: () => Promise<void>): Promise<void> {
    const targets: { node: Any; role: 'overview' | 'screen' }[] = [];
    const seen = new Set<string>();
    const stack = roots.slice().reverse();
    while (stack.length) {
      const node = stack.pop()!;
      if (seen.has(String(node.id))) continue;
      seen.add(String(node.id));
      if (SCREEN_TYPES.has(String(node.type))) { targets.push({ node, role: 'screen' }); continue; }
      if (node.type === 'SECTION') targets.push({ node, role: 'overview' });
      if (['PAGE', 'SECTION', 'GROUP'].includes(String(node.type))) {
        if (Array.isArray(node.children)) stack.push(...node.children.slice().reverse());
      } else if (roots.includes(node)) targets.push({ node, role: 'screen' });
    }
    let n = 0;
    for (const { node, role } of targets) {
      const nodeId = String(node.id);
      try {
        if (n >= MAX_PREVIEWS) throw new Error(`Giới hạn ${MAX_PREVIEWS} ảnh xem trước; hãy chọn phạm vi nhỏ hơn để có ảnh của node này.`);
        const width = Math.max(1, Number(node.width ?? 1)), height = Math.max(1, Number(node.height ?? 1)), edge = Math.max(width, height);
        // Preserve screen width on long pages, with explicit raster memory and edge bounds.
        const scale = role === 'overview' ? Math.min(1, PREVIEW_MAX_EDGE / edge)
          : Math.min(1, PREVIEW_MAX_EDGE / width, SCREEN_PREVIEW_MAX_EDGE / edge, Math.sqrt(PREVIEW_MAX_PIXELS / (width * height)));
        const bytes: Uint8Array = await node.exportAsync({ format: 'PNG', contentsOnly: true, useAbsoluteBounds: true, constraint: { type: 'SCALE', value: scale } });
        const id = sha256Bytes(bytes);
        const rec: Extract<DependencyRecord, { k: 'asset' }> = { k: 'asset', id, assetKind: 'preview', mime: 'image/png', bytes: bytes.length, sha256: id, source: { nodeId }, status: bytes.length > cmd.limits.maxAssetBytes ? 'oversize' : 'stored',
          width: Math.ceil(width * scale), height: Math.ceil(height * scale), preview: { role, name: String(node.name ?? nodeId), nodeType: String(node.type), scale } };
        await asset(rec);
        if (rec.status === 'stored') await send(rec, bytes);
      } catch (error) {
        await asset({ k: 'asset', id: `preview:${nodeId}`, assetKind: 'preview', mime: 'image/png', bytes: 0, sha256: '', source: { nodeId }, status: 'error', reason: String((error as Error)?.message ?? error).slice(0, 200) });
      }
      if (++n % 3 === 0) await yieldNow();
    }
  }
}
