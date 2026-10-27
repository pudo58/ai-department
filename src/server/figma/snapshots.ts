import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { canonicalJson, type DependencyRecord, type ExportIssue, type NodeRecord, type RootInfo } from '../../shared/figma.js';
import type { DesignBinding, DesignSnapshot, DiffEntry, FigmaExportJob, SnapshotDiff, SnapshotFile } from '../../shared/design.js';
import { FIGMA_DATA_NOTICE, coverageLabel, idHash, mdCode, mdText, sha256Hex, type NodeLookup } from '../../core/design.js';
import type { ValidationResult } from '../../core/figmavalidate.js';
import { HttpError } from '../run/support.js';
import type { Store } from '../store.js';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const MIME_BY_EXT: Record<string, string> = { json: 'application/json', md: 'text/markdown; charset=utf-8', ndjson: 'application/x-ndjson', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const mimeOf = (file: string): string => MIME_BY_EXT[path.extname(file).slice(1)] ?? 'application/octet-stream';
const TREE_DEPTH = 4, TREE_LINES = 200;

/** One row per node: enough to find it again with a ranged read, and to build trees without loading every record. */
export interface NodeRow { id: string; type: string; name: string; parentId: string | null; index: number; depth: number; page: string; file: string; offset: number; length: number; hash: string }

export interface StagingFiles {
  dir: string;
  inventory: string; nodes: string; dependencies: string; verification: string; assetsDir: string;
}

async function* lines(file: string): AsyncGenerator<string> {
  if (!existsSync(file)) return;
  const reader = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) if (line.trim()) yield line;
}

/** Reads the records of one NDJSON stream. A line that does not parse is an error of the whole export, never skipped. */
export async function* records<T>(file: string): AsyncGenerator<T> {
  for await (const line of lines(file)) yield JSON.parse(line) as T;
}

/** Random access to a stored snapshot: the node table in memory, node records by ranged read. */
export class SnapshotReader {
  private readonly rows = new Map<string, NodeRow>();
  private readonly fds = new Map<string, number>();
  readonly roots: RootInfo[];
  constructor(readonly dir: string, readonly snapshot: DesignSnapshot) {
    const table = path.join(dir, 'source', 'node-table.ndjson');
    for (const line of readFileSync(table, 'utf8').split('\n')) if (line.trim()) { const r = JSON.parse(line) as NodeRow; this.rows.set(r.id, r); }
    this.roots = snapshot.roots;
  }
  has(id: string): boolean { return this.rows.has(id); }
  row(id: string): NodeRow | undefined { return this.rows.get(id); }
  allRows(): IterableIterator<NodeRow> { return this.rows.values(); }
  node(id: string): NodeRecord | undefined {
    const row = this.rows.get(id);
    if (!row) return undefined;
    const file = path.join(this.dir, row.file);
    let fd = this.fds.get(file);
    if (fd === undefined) { fd = openSync(file, 'r'); this.fds.set(file, fd); }
    const buffer = Buffer.alloc(row.length);
    readSync(fd, buffer, 0, row.length, row.offset);
    return JSON.parse(buffer.toString('utf8')) as NodeRecord;
  }
  childrenOf(id: string): NodeRow[] {
    return [...this.rows.values()].filter((r) => r.parentId === id).sort((a, b) => a.index - b.index);
  }
  /** The node and everything below it, in document order. */
  subtree(id: string): NodeRow[] {
    const byParent = new Map<string, NodeRow[]>();
    for (const r of this.rows.values()) if (r.parentId) (byParent.get(r.parentId) ?? byParent.set(r.parentId, []).get(r.parentId)!).push(r);
    const out: NodeRow[] = [];
    const walk = (at: string) => { const row = this.rows.get(at); if (row) out.push(row); for (const c of (byParent.get(at) ?? []).sort((a, b) => a.index - b.index)) walk(c.id); };
    walk(id);
    return out;
  }
  lookup: NodeLookup = (id) => this.node(id);
  readJson<T>(rel: string): T { return JSON.parse(readFileSync(path.join(this.dir, rel), 'utf8')) as T; }
  *dependencies(): Generator<DependencyRecord> {
    for (const line of readFileSync(path.join(this.dir, 'source', 'dependencies.ndjson'), 'utf8').split('\n')) if (line.trim()) yield JSON.parse(line) as DependencyRecord;
  }
  close(): void { for (const fd of this.fds.values()) { try { closeSync(fd); } catch { /* already closed */ } } this.fds.clear(); }
}

/** Immutable design snapshots on disk, with their metadata in the store. Nothing here talks to Figma or to an agent. */
export class SnapshotStore {
  private readonly cache = new Map<string, SnapshotReader>();
  readonly root: string;
  constructor(dataDir: string, private readonly store: Store) { this.root = path.join(dataDir, 'design-snapshots'); }

  dir(id: string): string {
    if (!/^dsn_[a-f0-9]{8,}$/.test(id)) throw new HttpError(400, 'Mã snapshot không hợp lệ.');
    return path.join(this.root, id);
  }
  get(id: string): DesignSnapshot | undefined { return this.store.designSnapshots.get(id); }
  list(): DesignSnapshot[] { return this.store.designSnapshots.list(); }

  reader(id: string): SnapshotReader {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const snapshot = this.get(id);
    if (!snapshot) throw new HttpError(404, 'Snapshot không tồn tại.');
    const reader = new SnapshotReader(this.dir(id), snapshot);
    if (this.cache.size >= 2) { const [oldest] = this.cache.keys(); this.cache.get(oldest!)?.close(); this.cache.delete(oldest!); }
    this.cache.set(id, reader);
    return reader;
  }
  private forget(id: string): void { this.cache.get(id)?.close(); this.cache.delete(id); }

  /**
   * Builds the draft snapshot from a validated export. Files are written into a temporary folder and renamed into place only when they
   * are all there with their hashes, so a crash leaves either a complete folder or no folder, never half of one.
   */
  async build(job: FigmaExportJob, staging: StagingFiles, validation: ValidationResult, previousId: string | undefined): Promise<DesignSnapshot> {
    const id = `dsn_${sha256Hex(`${job.id}:${job.scopeHash}`).slice(0, 12)}`;
    const final = this.dir(id), tmp = path.join(this.root, `.tmp-${id}`);
    mkdirSync(this.root, { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(path.join(tmp, 'source', 'pages'), { recursive: true });
    for (const d of ['pages', 'components', 'tokens', 'assets']) mkdirSync(path.join(tmp, d), { recursive: true });
    const files: SnapshotFile[] = [];
    const add = (rel: string, kind: SnapshotFile['kind'], content?: string | Buffer) => {
      const full = path.join(tmp, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      if (content !== undefined) writeFileSync(full, content);
      const bytes = readFileSync(full);
      files.push({ id: idHash(rel), path: rel.replace(/\\/g, '/'), kind, bytes: bytes.length, sha256: sha256Hex(bytes), mime: mimeOf(rel) });
    };

    // Node records, grouped by page, with a table of where each one is.
    const rows: NodeRow[] = [];
    const handles = new Map<string, { fd: number; offset: number }>();
    try {
      for await (const record of records<NodeRecord>(staging.nodes)) {
        const file = `source/pages/${idHash(record.pageId)}.ndjson`;
        let h = handles.get(file);
        if (!h) { h = { fd: openSync(path.join(tmp, file), 'a'), offset: 0 }; handles.set(file, h); }
        const text = `${JSON.stringify(record)}\n`, length = Buffer.byteLength(text) - 1;
        writeSync(h.fd, text);
        rows.push({ id: record.id, type: record.type, name: record.name, parentId: record.parentId, index: record.index, depth: record.depth, page: record.pageId, file, offset: h.offset, length, hash: record.hash });
        h.offset += length + 1;
      }
    } finally { for (const h of handles.values()) closeSync(h.fd); }
    for (const file of handles.keys()) add(file, 'source');
    add('source/node-table.ndjson', 'source', rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    // A stream the plugin never sent is an empty one here; the validator has already said what that means.
    if (existsSync(staging.inventory)) copyFileSync(staging.inventory, path.join(tmp, 'source', 'inventory.ndjson')); else writeFileSync(path.join(tmp, 'source', 'inventory.ndjson'), '');
    add('source/inventory.ndjson', 'source');
    if (existsSync(staging.dependencies)) copyFileSync(staging.dependencies, path.join(tmp, 'source', 'dependencies.ndjson')); else writeFileSync(path.join(tmp, 'source', 'dependencies.ndjson'), '');
    add('source/dependencies.ndjson', 'source');

    // Assets, named by what they contain.
    const deps: DependencyRecord[] = [];
    for await (const d of records<DependencyRecord>(staging.dependencies)) deps.push(d);
    for (const d of deps) {
      if (d.k !== 'asset' || d.status !== 'stored') continue;
      const from = path.join(staging.assetsDir, d.id);
      if (!existsSync(from)) continue;
      add(`assets/${d.id}.${EXT[d.mime] ?? 'bin'}`, 'asset', readFileSync(from));
    }

    // Pages, components and tokens: facts laid out by template, no interpretation.
    const byRoot = new Map<string, NodeRow[]>();
    for (const r of rows) (byRoot.get(r.page) ?? byRoot.set(r.page, []).get(r.page)!).push(r);
    const nodeOf = (rowId: string): NodeRecord | undefined => {
      const row = rows.find((x) => x.id === rowId);
      if (!row) return undefined;
      const buffer = Buffer.alloc(row.length), fd = openSync(path.join(tmp, row.file), 'r');
      try { readSync(fd, buffer, 0, row.length, row.offset); } finally { closeSync(fd); }
      return JSON.parse(buffer.toString('utf8')) as NodeRecord;
    };
    const pageList: { id: string; name: string; dir: string; nodes: number }[] = [];
    for (const [pageId, list] of byRoot) {
      const pageRow = list.find((r) => r.id === pageId);
      const name = pageRow?.name ?? list[0]?.name ?? pageId;
      const dir = `pages/${idHash(pageId)}`;
      add(`${dir}/index.md`, 'page', pageMarkdown(pageId, name, list));
      add(`${dir}/tree.json`, 'page', JSON.stringify(list.map((r) => ({ id: r.id, name: r.name, type: r.type, parentId: r.parentId, index: r.index, depth: r.depth }))));
      pageList.push({ id: pageId, name, dir, nodes: list.length });
    }
    const componentRows = rows.filter((r) => r.type === 'COMPONENT_SET' || r.type === 'COMPONENT');
    const componentList: { id: string; name: string; type: string; dir: string; axes: string[] }[] = [];
    for (const row of componentRows) {
      const record = nodeOf(row.id);
      const dir = `components/${idHash(row.id)}`;
      const variants = rows.filter((r) => r.parentId === row.id && r.type === 'COMPONENT').sort((a, b) => a.index - b.index).map((r) => ({ id: r.id, name: r.name, variantProperties: nodeOf(r.id)?.fields['component.variantProperties'] ?? null }));
      const defs = record?.fields['component.propertyDefinitions'];
      const axes = defs?.s === 'read' && defs.v && typeof defs.v === 'object' && !Array.isArray(defs.v) ? Object.keys(defs.v) : [];
      add(`${dir}/index.md`, 'component', componentMarkdown(row, record, variants.length));
      add(`${dir}/variants.json`, 'component', JSON.stringify({ componentId: row.id, name: row.name, propertyDefinitions: defs ?? null, variants }));
      componentList.push({ id: row.id, name: row.name, type: row.type, dir, axes });
    }
    const styles = deps.filter((d) => d.k === 'style'), variables = deps.filter((d) => d.k === 'variable'), collections = deps.filter((d) => d.k === 'collection');
    add('tokens/styles.json', 'tokens', JSON.stringify(styles));
    add('tokens/variables.json', 'tokens', JSON.stringify(variables));
    add('tokens/collections.json', 'tokens', JSON.stringify(collections));
    add('tokens/index.md', 'tokens', tokensMarkdown(styles, variables, collections));

    const label = coverageLabel(validation.coverage, validation.issues);
    const review = { schemaVersion: 1, label: label.text, limited: label.limited, coverage: validation.coverage, issues: validation.issues, counts: { ...validation.counts, bytes: job.counts.bytes }, source: job.source, scope: { kind: job.scope, rootIds: job.rootIds, pageIds: job.pageIds, hash: job.scopeHash }, limits: job.limits, notes: job.notes };
    add('review.json', 'review', JSON.stringify(review, null, 1));
    const index = { schemaVersion: 1, roots: rowsOfRoots(rows, job), pages: pageList, components: componentList, tokens: { styles: styles.length, variables: variables.length, collections: collections.map((c) => ({ id: c.k === 'collection' ? c.id : '', name: c.k === 'collection' ? c.name : '' })) },
      assets: deps.filter((d) => d.k === 'asset').map((d) => (d.k === 'asset' ? { id: d.id, kind: d.assetKind, mime: d.mime, bytes: d.bytes, status: d.status, source: d.source } : null)),
      imageRefs: deps.filter((d) => d.k === 'imageRef').length, nodeTable: 'source/node-table.ndjson', notice: FIGMA_DATA_NOTICE };
    add('index.json', 'index', JSON.stringify(index, null, 1));

    const dataFiles = files.filter((f) => ['source', 'page', 'component', 'tokens', 'asset'].includes(f.kind)).filter((f) => f.path !== 'source/node-table.ndjson').map((f) => [f.path, f.sha256]).sort(([a], [b]) => (a! < b! ? -1 : 1));
    const contentHash = sha256Hex(canonicalJson(dataFiles));
    const roots = rowsOfRoots(rows, job);
    const manifest = {
      schemaVersion: 1, jobId: job.id, readerVersion: 1, protocolVersion: 1, pluginVersion: job.source.pluginVersion, bundleHash: job.source.bundleHash ?? null,
      source: job.source, scope: { kind: job.scope, rootIds: job.rootIds, pageIds: job.pageIds, hash: job.scopeHash }, limits: job.limits,
      startedAt: job.startedAt ?? job.createdAt, endedAt: job.endedAt ?? new Date().toISOString(),
      coverage: validation.coverage, issues: validation.issues, counts: { ...validation.counts, bytes: job.counts.bytes }, contentHash, roots,
      files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
    };
    writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const snapshotHash = sha256Hex(canonicalJson(JSON.parse(readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))));

    rmSync(final, { recursive: true, force: true });
    renameSync(tmp, final);
    const snapshot: DesignSnapshot = {
      id, schemaVersion: 1, jobId: job.id, status: 'draft', limited: label.limited,
      readerVersion: 1, protocolVersion: 1, pluginVersion: job.source.pluginVersion, bundleHash: job.source.bundleHash,
      source: job.source, scope: { kind: job.scope, rootIds: job.rootIds, pageIds: job.pageIds, hash: job.scopeHash }, limits: job.limits,
      startedAt: manifest.startedAt, endedAt: manifest.endedAt, coverage: validation.coverage, issues: validation.issues,
      counts: { ...validation.counts, bytes: job.counts.bytes }, contentHash, snapshotHash, files: manifest.files, roots,
      ...(previousId ? { previousId } : {}), createdAt: new Date().toISOString(),
    };
    this.store.designSnapshots.put(snapshot);
    this.forget(id);
    return snapshot;
  }

  /** Re-hashes every file and the manifest. A snapshot that was edited after it was built, or is missing a file, fails here. */
  verify(id: string): { ok: boolean; problems: string[] } {
    const snapshot = this.get(id);
    if (!snapshot) return { ok: false, problems: ['Snapshot không tồn tại.'] };
    const dir = this.dir(id), problems: string[] = [];
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { files: SnapshotFile[] };
      if (sha256Hex(canonicalJson(manifest)) !== snapshot.snapshotHash) problems.push('manifest.json không khớp snapshotHash.');
      for (const f of manifest.files) {
        const full = path.join(dir, f.path);
        if (!full.startsWith(dir + path.sep) || !existsSync(full)) { problems.push(`Thiếu file ${f.path}.`); continue; }
        if (sha256Hex(readFileSync(full)) !== f.sha256) problems.push(`File ${f.path} đã bị sửa.`);
      }
    } catch (error) { problems.push(`Không đọc được manifest: ${(error as Error).message}`); }
    return { ok: problems.length === 0, problems };
  }

  /** Approval of exactly this content with exactly the limits the person saw. A stale hash or a missing acknowledgement is a 409. */
  publish(id: string, input: { snapshotHash: string; acknowledgedIssueIds: string[] }): DesignSnapshot {
    const snapshot = this.get(id);
    if (!snapshot) throw new HttpError(404, 'Snapshot không tồn tại.');
    if (snapshot.status === 'published') {
      if (snapshot.publish?.snapshotHash === input.snapshotHash) return snapshot;
      throw new HttpError(409, 'Snapshot đã được duyệt; muốn bản khác hãy export lại.');
    }
    if (input.snapshotHash !== snapshot.snapshotHash) throw new HttpError(409, 'Hash snapshot đã đổi; tải lại, xem lại rồi duyệt đúng bản hiện tại.');
    const verified = this.verify(id);
    if (!verified.ok) throw new HttpError(409, `Snapshot không còn khớp dữ liệu đã lưu: ${verified.problems.slice(0, 3).join(' ')}`);
    const blockers = snapshot.issues.filter((i) => i.severity === 'blocker');
    if (blockers.length) throw new HttpError(409, `Chưa thể duyệt: ${blockers.slice(0, 3).map((i) => i.message).join(' ')}`);
    const limits = snapshot.issues.filter((i) => i.severity === 'limit').map((i) => i.id);
    const given = new Set(input.acknowledgedIssueIds);
    const unknown = [...given].filter((x) => !limits.includes(x));
    if (unknown.length) throw new HttpError(409, `Có issue đã xác nhận không thuộc snapshot này (${unknown.slice(0, 2).join(', ')}); tải lại danh sách giới hạn.`);
    const missing = limits.filter((x) => !given.has(x));
    if (missing.length) throw new HttpError(409, `Chưa xác nhận ${missing.length} giới hạn: ${snapshot.issues.filter((i) => missing.includes(i.id)).slice(0, 2).map((i) => i.message).join(' ')}`);
    const receipt = { snapshotHash: snapshot.snapshotHash, acknowledgedIssueIds: [...given].sort(), limited: limits.length > 0, publishedAt: new Date().toISOString() };
    // The receipt lives beside the snapshot, never inside the hashed manifest.
    writeFileSync(`${this.dir(id)}.publish.json`, JSON.stringify(receipt, null, 1));
    return this.store.designSnapshots.put({ ...snapshot, status: 'published', limited: receipt.limited, publish: receipt });
  }

  /** The published snapshot a binding names, checked against disk. Throws with the reason when it cannot be used. */
  usable(binding: DesignBinding): DesignSnapshot {
    const snapshot = this.get(binding.snapshotId);
    if (!snapshot) throw new HttpError(409, `Snapshot thiết kế ${binding.snapshotId} không còn tồn tại.`);
    if (snapshot.status !== 'published') throw new HttpError(409, 'Snapshot thiết kế chưa được duyệt để dùng cho task.');
    if (snapshot.snapshotHash !== binding.snapshotHash) throw new HttpError(409, 'Snapshot thiết kế khác với bản mà hợp đồng đã khóa (hash đổi).');
    const verified = this.verify(snapshot.id);
    if (!verified.ok) throw new HttpError(409, `Dữ liệu snapshot thiết kế bị thay đổi: ${verified.problems.slice(0, 3).join(' ')}`);
    return snapshot;
  }

  file(id: string, fileId: string): { full: string; file: SnapshotFile } {
    const snapshot = this.get(id);
    if (!snapshot) throw new HttpError(404, 'Snapshot không tồn tại.');
    const file = snapshot.files.find((f) => f.id === fileId);
    if (!file) throw new HttpError(404, 'File không có trong manifest của snapshot.');
    const full = path.join(this.dir(id), file.path);
    if (!full.startsWith(this.dir(id) + path.sep) || !existsSync(full)) throw new HttpError(404, 'File không còn trên đĩa.');
    return { full, file };
  }

  remove(id: string): void {
    this.forget(id);
    rmSync(this.dir(id), { recursive: true, force: true });
    rmSync(`${this.dir(id)}.publish.json`, { force: true });
    this.store.designSnapshots.delete(id);
  }

  /** Drops folders with no record (a crash between the rename and the record) and temp folders from a crash before it. */
  recover(): string[] {
    const removed: string[] = [];
    if (!existsSync(this.root)) return removed;
    const known = new Set(this.list().map((s) => s.id));
    for (const name of readdirSync(this.root)) {
      const full = path.join(this.root, name);
      if (name.startsWith('.tmp-')) { rmSync(full, { recursive: true, force: true }); removed.push(name); }
      else if (/^dsn_[a-f0-9]+$/.test(name) && statSync(full).isDirectory() && !known.has(name)) { rmSync(full, { recursive: true, force: true }); removed.push(name); }
    }
    return removed;
  }

  diff(headId: string, baseId: string): SnapshotDiff {
    const head = this.get(headId), base = this.get(baseId);
    if (!head || !base) throw new HttpError(404, 'Snapshot không tồn tại.');
    const empty = (reason: string): SnapshotDiff => ({ comparable: false, reason, baseId, headId, nodes: [], components: [], tokens: [], assets: [], newIssues: [], summary: { added: 0, removed: 0, changed: 0 } });
    const sameFile = !!head.source.fileKey && head.source.fileKey === base.source.fileKey && head.source.identity === 'verified' && base.source.identity === 'verified';
    if (!sameFile && head.previousId !== base.id) return empty('Không có định danh file đáng tin để khẳng định hai snapshot cùng nguồn. Chỉ so sánh sau khi bạn xác nhận cùng nguồn lúc export.');
    if (head.scope.kind !== base.scope.kind) return empty('Hai snapshot có phạm vi khác loại (selection/page/file).');
    const a = this.reader(base.id), b = this.reader(head.id);
    const nodes: DiffEntry[] = [];
    for (const row of b.allRows()) {
      const before = a.row(row.id);
      if (!before) nodes.push({ id: row.id, name: row.name, type: row.type, change: 'added' });
      else if (before.hash !== row.hash) nodes.push({ id: row.id, name: row.name, type: row.type, change: 'changed', fields: changedFields(a.node(row.id), b.node(row.id)) });
    }
    for (const row of a.allRows()) if (!b.has(row.id)) nodes.push({ id: row.id, name: row.name, type: row.type, change: 'removed' });
    const depMap = (r: SnapshotReader) => { const m = new Map<string, DependencyRecord>(); for (const d of r.dependencies()) m.set(depKey(d), d); return m; };
    const da = depMap(a), db = depMap(b);
    const compare = (kinds: DependencyRecord['k'][]): DiffEntry[] => {
      const out: DiffEntry[] = [];
      for (const [key, d] of db) if (kinds.includes(d.k)) { const o = da.get(key); if (!o) out.push({ id: key, name: depName(d), type: d.k, change: 'added' }); else if (canonicalJson(o) !== canonicalJson(d)) out.push({ id: key, name: depName(d), type: d.k, change: 'changed' }); }
      for (const [key, d] of da) if (kinds.includes(d.k) && !db.has(key)) out.push({ id: key, name: depName(d), type: d.k, change: 'removed' });
      return out;
    };
    const baseIssues = new Set(base.issues.map((i) => i.id));
    const all = [...nodes];
    const components = compare(['component']), tokens = compare(['style', 'variable', 'collection']), assets = compare(['asset', 'imageRef']);
    for (const list of [components, tokens, assets]) all.push(...list);
    return {
      comparable: true, baseId, headId, nodes, components, tokens, assets, newIssues: head.issues.filter((i: ExportIssue) => !baseIssues.has(i.id)),
      summary: { added: all.filter((x) => x.change === 'added').length, removed: all.filter((x) => x.change === 'removed').length, changed: all.filter((x) => x.change === 'changed').length },
    };
  }
}

const depKey = (d: DependencyRecord): string => `${d.k}:${d.k === 'imageRef' ? d.hash : d.id}`;
const depName = (d: DependencyRecord): string | undefined => (d.k === 'imageRef' ? d.hash : 'name' in d ? d.name : d.k === 'asset' ? d.id : undefined);
const changedFields = (a?: NodeRecord, b?: NodeRecord): string[] => {
  if (!a || !b) return [];
  const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
  return [...keys].filter((k) => canonicalJson(a.fields[k]) !== canonicalJson(b.fields[k])).sort();
};

function rowsOfRoots(rows: NodeRow[], job: FigmaExportJob): RootInfo[] {
  const ids = job.scope === 'file' ? rows.filter((r) => r.type === 'PAGE').map((r) => r.id) : job.scope === 'pages' ? job.pageIds : job.rootIds;
  const page = new Map(rows.filter((r) => r.type === 'PAGE').map((r) => [r.id, r.name]));
  return ids.flatMap((id) => { const r = rows.find((x) => x.id === id); return r ? [{ id, name: r.name, type: r.type, pageId: r.page, ...(page.has(r.page) ? { pageName: page.get(r.page) } : {}) }] : []; });
}

function pageMarkdown(pageId: string, name: string, list: NodeRow[]): string {
  const byParent = new Map<string, NodeRow[]>();
  for (const r of list) if (r.parentId) (byParent.get(r.parentId) ?? byParent.set(r.parentId, []).get(r.parentId)!).push(r);
  const out: string[] = [`# Trang ${mdText(name)}`, '', FIGMA_DATA_NOTICE, '', `- Mã node: ${mdCode(pageId)}`, `- Số node đã đọc trong trang: ${list.length}`, '', '## Cây node (tối đa 4 cấp)', ''];
  let n = 0, cut = false;
  const walk = (id: string, depth: number) => {
    for (const c of (byParent.get(id) ?? []).sort((x, y) => x.index - y.index)) {
      if (n >= TREE_LINES) { cut = true; return; }
      out.push(`${'  '.repeat(depth)}- ${mdCode(c.id)} ${mdText(c.name)} (${c.type})`); n++;
      if (depth + 1 < TREE_DEPTH) walk(c.id, depth + 1);
    }
  };
  walk(pageId, 0);
  if (cut || list.some((r) => r.depth >= TREE_DEPTH)) out.push('', `Cây đầy đủ ở tree.json cùng thư mục; dữ liệu từng node ở source/pages.`);
  return out.join('\n') + '\n';
}

function componentMarkdown(row: NodeRow, record: NodeRecord | undefined, variants: number): string {
  const f = (k: string) => record?.fields[k];
  const shown = (k: string) => { const v = f(k); return v ? (v.s === 'read' || v.s === 'mixed' ? mdCode(JSON.stringify(v.v)) : `${v.s}${v.r ? ` (${mdText(v.r)})` : ''}`) : 'không có'; };
  return [`# ${row.type === 'COMPONENT_SET' ? 'Component set' : 'Component'} ${mdText(row.name)}`, '', FIGMA_DATA_NOTICE, '',
    `- Mã node: ${mdCode(row.id)}`, `- Key: ${shown('component.key')}`, `- Mô tả: ${shown('component.description')}`, `- Định nghĩa thuộc tính: ${shown('component.propertyDefinitions')}`,
    `- Số variant đọc được trong phạm vi: ${variants}`, '', 'Chi tiết biến thể ở variants.json.'].join('\n') + '\n';
}

function tokensMarkdown(styles: DependencyRecord[], variables: DependencyRecord[], collections: DependencyRecord[]): string {
  const out = ['# Token', '', FIGMA_DATA_NOTICE, '', `- Style: ${styles.length}`, `- Variable: ${variables.length}`, `- Collection: ${collections.length}`, ''];
  for (const c of collections) if (c.k === 'collection') out.push(`## Collection ${mdText(c.name)}`, '', `- Mã: ${mdCode(c.id)}`, `- Mode: ${c.modes.map((m) => mdCode(m.name)).join(', ')}`, `- Số variable: ${c.variableIds.length}`, '');
  out.push('Giá trị theo mode ở variables.json; style ở styles.json.');
  return out.join('\n') + '\n';
}
