import { createHash } from 'node:crypto';
import {
  APPLICABLE_GROUPS, FIELD_GROUPS, FIELD_STATUSES, canonicalJson, isKnownNodeType, issueId, nodeRecordCore,
  type DependencyRecord, type ExportIssue, type FieldGroup, type FieldStatus, type FieldValue, type FinishBody, type GroupStatus, type InventoryRecord, type NodeRecord, type StreamSummary,
} from '../shared/figma.js';
import type { ExportCoverage, ExportCounts, GroupCoverage, SourceIdentity } from '../shared/design.js';

const emptyGroup = (): GroupCoverage => ({ total: 0, read: 0, mixed: 0, notApplicable: 0, unsupported: 0, unavailable: 0, error: 0 });
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const GROUP_STATUSES: readonly GroupStatus[] = ['read', 'partial', 'unsupported', 'not_applicable'];

export interface ValidatorInput {
  rootIds: readonly string[]; pageIds: readonly string[]; scope: 'selection' | 'pages' | 'file';
  sourceIdentity: SourceIdentity;
  finish: FinishBody;
  /** What the server measured on the bytes it stored, per stream. Compared with what the plugin says it sent. */
  measured: Record<keyof FinishBody['streams'], StreamSummary>;
  /** Bytes and hashes of each stored asset file, measured on disk. */
  storedAssets: ReadonlyMap<string, { bytes: number; sha256: string }>;
}

export interface ValidationResult {
  issues: ExportIssue[];
  coverage: ExportCoverage;
  counts: Omit<ExportCounts, 'bytes'>;
  /** True when nothing that would make the structure untrustworthy was found. */
  structureComplete: boolean;
  /** Ids of node types the reader had no support for. */
  unsupportedTypes: string[];
}

interface Slim { type: string; pageId: string; parentId: string | null; index: number; childIds: string[] }

/**
 * Checks an export independently of the plugin: the plugin says what it read, this decides whether that is consistent. It is fed the
 * records one at a time so a file with a hundred thousand nodes never sits in memory as parsed JSON; only a small tuple per node is kept.
 */
export class ExportValidator {
  private readonly issues = new Map<string, ExportIssue & { count?: number; samples?: string[] }>();
  private readonly first = new Map<string, Slim>();
  private readonly second = new Map<string, Slim>();
  private readonly nodeSeen = new Set<string>();
  private readonly nodeHash = new Map<string, string>();
  private readonly group = new Map<FieldGroup, GroupCoverage>();
  private readonly all = emptyGroup();
  private readonly styleRefs = new Map<string, Set<string>>();
  private readonly variableRefs = new Map<string, Set<string>>();
  private readonly componentRefs = new Map<string, Set<string>>();
  private readonly imageRefsUsed = new Map<string, Set<string>>();
  private readonly styles = new Set<string>();
  private readonly variables = new Map<string, Extract<DependencyRecord, { k: 'variable' }>>();
  private readonly collections = new Set<string>();
  private readonly components = new Map<string, Extract<DependencyRecord, { k: 'component' }>>();
  private readonly imageRecords = new Map<string, Extract<DependencyRecord, { k: 'imageRef' }>>();
  private readonly assets = new Map<string, Extract<DependencyRecord, { k: 'asset' }>>();
  private readonly unsupportedTypes = new Set<string>();
  private dependencyTotal = 0; private dependencyResolved = 0; private dependencyOnly = 0; private dependencyUnavailable = 0;
  private duplicateInventory = false;
  private structural = true;
  private nodeCount = 0;

  constructor(private readonly input: ValidatorInput) {}

  private raise(code: string, severity: ExportIssue['severity'], message: string, nodeId?: string, field?: string): void {
    const id = issueId(code, nodeId, field);
    const existing = this.issues.get(id);
    if (existing) { existing.count = (existing.count ?? 1) + 1; return; }
    this.issues.set(id, { id, code, severity, message, ...(nodeId ? { nodeId } : {}), ...(field ? { field } : {}), count: 1 });
    if (severity === 'blocker' && STRUCTURAL.has(code)) this.structural = false;
  }
  /** One issue per (code, field) however many nodes have it, with the first few nodes named. */
  private aggregate(code: string, severity: ExportIssue['severity'], field: string, message: string, nodeId: string): void {
    const id = issueId(code, undefined, field);
    const found = this.issues.get(id);
    if (found) { found.count = (found.count ?? 1) + 1; if ((found.samples ?? []).length < 5) found.samples!.push(nodeId); return; }
    this.issues.set(id, { id, code, severity, message, field, count: 1, samples: [nodeId] });
  }

  addInventory(r: InventoryRecord, pass: 1 | 2): void {
    if (!r || typeof r.id !== 'string' || typeof r.type !== 'string' || !Array.isArray(r.childIds) || !Number.isInteger(r.index)) { this.raise('inventory_malformed', 'blocker', 'Một dòng kiểm kê không đúng định dạng (thiếu mã, loại, thứ tự hoặc danh sách con).'); return; }
    const map = pass === 1 ? this.first : this.second;
    if (map.has(r.id)) { if (pass === 1) { this.duplicateInventory = true; this.raise('duplicate_id', 'blocker', `Mã node ${r.id} xuất hiện hai lần trong kiểm kê.`, r.id); } return; }
    map.set(r.id, { type: r.type, pageId: r.pageId, parentId: r.parentId, index: r.index, childIds: r.childIds });
  }

  addNode(r: NodeRecord): void {
    this.nodeCount++;
    if (!r || typeof r.id !== 'string' || typeof r.type !== 'string' || typeof r.hash !== 'string' || !Array.isArray(r.childIds) || !r.groups || typeof r.groups !== 'object' || !r.fields || typeof r.fields !== 'object') {
      this.raise('node_malformed', 'blocker', `Một bản ghi node không đúng định dạng${r && typeof r.id === 'string' ? ` (${r.id})` : ''}: thiếu mã, loại, hash, danh sách con, nhóm trường hoặc trường.`, r && typeof r.id === 'string' ? r.id : undefined);
      return;
    }
    if (this.nodeSeen.has(r.id)) { this.raise('duplicate_id', 'blocker', `Mã node ${r.id} có hai bản ghi dữ liệu.`, r.id); return; }
    this.nodeSeen.add(r.id);
    const core = nodeRecordCore(r);
    if (sha256(canonicalJson(core)) !== r.hash) this.raise('node_hash_mismatch', 'blocker', `Hash của bản ghi node ${r.id} không khớp nội dung.`, r.id);
    this.nodeHash.set(r.id, r.hash);
    const inv = this.first.get(r.id);
    if (!inv) this.raise('unknown_node_record', 'blocker', `Có bản ghi dữ liệu cho node ${r.id} nhưng kiểm kê không có node này.`, r.id);
    else if (inv.type !== r.type || inv.parentId !== r.parentId || inv.index !== r.index || canonicalJson(inv.childIds) !== canonicalJson(r.childIds)) {
      this.raise('record_inventory_mismatch', 'blocker', `Bản ghi của node ${r.id} khác kiểm kê (loại, cha, thứ tự hoặc danh sách con).`, r.id);
    }
    this.checkGroups(r);
    this.collectReferences(r);
  }

  private checkGroups(r: NodeRecord): void {
    const known = isKnownNodeType(r.type);
    if (!known) { this.unsupportedTypes.add(r.type); this.raise('unsupported_node_type', 'limit', `Kiểu node ${r.type} chưa được reader v1 hỗ trợ; chỉ có dữ liệu cây và thuộc tính chung.`, undefined, r.type); }
    const required: readonly FieldGroup[] = known ? APPLICABLE_GROUPS[r.type]! : ['common'];
    for (const g of required) if (!r.groups[g]) this.raise('missing_group_status', 'blocker', `Node ${r.id} (${r.type}) thiếu trạng thái của nhóm trường ${g}.`, r.id, g);
    const byGroup = new Map<FieldGroup, FieldValue[]>();
    for (const [key, value] of Object.entries(r.fields)) {
      const group = key.slice(0, key.indexOf('.')) as FieldGroup;
      if (!FIELD_GROUPS.includes(group)) { this.raise('field_malformed', 'blocker', `Trường ${key} của node ${r.id} thuộc nhóm không biết.`, r.id, key); continue; }
      if (!value || typeof value !== 'object' || !FIELD_STATUSES.includes(value.s)) { this.raise('field_malformed', 'blocker', `Trường ${key} của node ${r.id} có trạng thái không hợp lệ.`, r.id, key); continue; }
      if ((value.s === 'read') && !('v' in value)) this.raise('field_malformed', 'blocker', `Trường ${key} của node ${r.id} đã đọc nhưng không có giá trị.`, r.id, key);
      if (['error', 'unavailable', 'unsupported'].includes(value.s) && !value.r) this.raise('field_malformed', 'blocker', `Trường ${key} của node ${r.id} thất bại mà không nêu lý do.`, r.id, key);
      (byGroup.get(group) ?? byGroup.set(group, []).get(group)!).push(value);
      this.countField(group, value.s);
      if (value.s === 'error' || value.s === 'unavailable' || value.s === 'unsupported') {
        const label = value.s === 'error' ? 'lỗi khi đọc' : value.s === 'unavailable' ? 'không đọc được' : 'chưa hỗ trợ';
        this.aggregate(`field_${value.s}`, 'limit', key, `Trường ${key}: ${label} (${value.r ?? 'không rõ lý do'}).`, r.id);
      }
    }
    for (const [g, status] of Object.entries(r.groups) as [FieldGroup, GroupStatus][]) {
      if (!GROUP_STATUSES.includes(status)) { this.raise('group_inconsistent', 'blocker', `Nhóm ${g} của node ${r.id} có trạng thái không hợp lệ.`, r.id, g); continue; }
      const fields = byGroup.get(g) ?? [];
      const bad = fields.some((f) => f.s === 'error' || f.s === 'unavailable' || f.s === 'unsupported');
      if (status === 'read' && bad) this.raise('group_inconsistent', 'blocker', `Nhóm ${g} của node ${r.id} báo đã đọc nhưng có trường thất bại.`, r.id, g);
      if (status === 'partial' && !bad) this.raise('group_inconsistent', 'blocker', `Nhóm ${g} của node ${r.id} báo thiếu nhưng mọi trường đều đã đọc.`, r.id, g);
      if (status === 'read' && fields.length === 0 && g !== 'common') this.raise('group_inconsistent', 'blocker', `Nhóm ${g} của node ${r.id} báo đã đọc mà không có trường nào.`, r.id, g);
    }
  }

  private countField(group: FieldGroup, status: FieldStatus): void {
    const g = this.group.get(group) ?? this.group.set(group, emptyGroup()).get(group)!;
    const key = status === 'not_applicable' ? 'notApplicable' : status;
    for (const c of [g, this.all]) { c.total++; c[key]++; }
  }

  private collectReferences(r: NodeRecord): void {
    const add = (map: Map<string, Set<string>>, id: unknown, by: string) => { if (typeof id === 'string' && id) (map.get(id) ?? map.set(id, new Set()).get(id)!).add(by); };
    const styleIds = r.fields['style.styleIds'];
    if (styleIds?.s === 'read' && styleIds.v && typeof styleIds.v === 'object' && !Array.isArray(styleIds.v)) for (const v of Object.values(styleIds.v)) add(this.styleRefs, v, r.id);
    // A variable bound to anything shows up as an alias object, wherever it sits: in boundVariables, inside a paint, inside a text segment.
    for (const key of ['style.boundVariables', 'paint.fills', 'paint.strokes', 'paint.effects', 'text.segments']) {
      const f = r.fields[key];
      if (f?.s === 'read' || f?.s === 'mixed') walkAliases(f.v, (id) => add(this.variableRefs, id, r.id));
    }
    const textSegments = r.fields['text.segments'];
    if (textSegments?.s === 'read' && Array.isArray(textSegments.v)) for (const seg of textSegments.v) if (seg && typeof seg === 'object' && !Array.isArray(seg)) for (const k of ['textStyleId', 'fillStyleId']) add(this.styleRefs, (seg as Record<string, unknown>)[k], r.id);
    const main = r.fields['instance.mainComponentId'];
    if (main?.s === 'read') add(this.componentRefs, main.v, r.id);
    const images = r.fields['paint.imageHashes'];
    if (images?.s === 'read' && Array.isArray(images.v)) for (const item of images.v) if (item && typeof item === 'object' && !Array.isArray(item)) add(this.imageRefsUsed, (item as { hash?: unknown }).hash, r.id);
  }

  addDependency(r: DependencyRecord): void {
    if (!r || typeof r !== 'object' || typeof r.k !== 'string') { this.raise('dependency_malformed', 'blocker', 'Một bản ghi phụ thuộc không đúng định dạng.'); return; }
    switch (r.k) {
      case 'style': this.styles.add(r.id); break;
      case 'collection': this.collections.add(r.id); break;
      case 'variable': this.variables.set(r.id, r); break;
      case 'component': this.components.set(r.id, r); break;
      case 'imageRef': this.imageRecords.set(r.hash, r); break;
      case 'asset': this.assets.set(r.id, r); break;
      default: this.raise('dependency_malformed', 'blocker', 'Có bản ghi phụ thuộc thuộc loại không biết.');
    }
  }

  /** Compares everything that was collected with what the plugin and the disk say, and returns the verdict. */
  finish(): ValidationResult {
    const { input } = this;
    this.checkStreams();
    this.checkGraph();
    this.checkRootsAndRecords();
    this.checkDependencies();
    this.checkAssets();
    this.checkVerification();
    if (input.finish.limitReached) this.raise('limit_reached', 'blocker', `Export dừng vì chạm giới hạn ${LIMIT_LABEL[input.finish.limitReached]}; dữ liệu chưa đầy đủ nên không thể publish. Tạo lượt mới với giới hạn khác nếu cần.`);
    for (const e of input.finish.errors) this.raise(`plugin_${e.code}`, 'blocker', `Plugin báo lỗi ${e.code}: ${e.message.slice(0, 300)}`);
    if (input.sourceIdentity === 'user_attested') this.raise('source_user_attested', 'limit', 'Plugin không trả được file key, nên nguồn là do bạn xác nhận (tên file, trang và preview); hệ thống không đối chiếu tự động với URL.');
    if (!input.finish.verification.watchedDocumentChanges && input.scope !== 'file') this.raise('document_change_unwatched', 'info', 'Phạm vi nhỏ không theo dõi sự kiện thay đổi tài liệu (chỉ đối chiếu hai lượt đọc).');

    const issues = [...this.issues.values()].map(({ count, samples, ...issue }) => ({
      ...issue,
      message: count && count > 1 ? `${issue.message} (${count} chỗ${samples?.length ? `; ví dụ node ${samples.join(', ')}` : ''})` : samples?.length ? `${issue.message} (node ${samples.join(', ')})` : issue.message,
    }));
    const sourceChanged = this.issues.has(issueId('source_changed')) || input.finish.verification.sourceChanged;
    const coverage: ExportCoverage = {
      structureComplete: this.structural && !this.duplicateInventory,
      fieldCoverage: { all: this.all, byGroup: Object.fromEntries([...this.group].map(([k, v]) => [k, v])) },
      dependencyCoverage: { total: this.dependencyTotal, resolved: this.dependencyResolved, dependencyOnly: this.dependencyOnly, unavailable: this.dependencyUnavailable },
      assetCoverage: this.assetCoverage(),
      sourceIdentity: input.sourceIdentity,
      consistency: input.finish.verification.passes >= 2 ? (sourceChanged ? 'source_changed' : 'unchanged_across_passes') : 'not_checked',
    };
    const pages = [...this.first.values()].filter((n) => n.type === 'PAGE').length;
    return {
      issues, coverage, structureComplete: coverage.structureComplete,
      counts: {
        pages, nodes: this.nodeCount, components: this.components.size, styles: this.styles.size, variables: this.variables.size, collections: this.collections.size, assets: this.assets.size,
      },
      unsupportedTypes: [...this.unsupportedTypes],
    };
  }

  private checkStreams(): void {
    const { finish, measured } = this.input;
    for (const name of Object.keys(measured) as (keyof FinishBody['streams'])[]) {
      const said = finish.streams[name], got = measured[name];
      if (!said || said.bytes !== got.bytes || said.sha256 !== got.sha256 || said.records !== got.records) {
        this.raise('stream_mismatch', 'blocker', `Luồng ${name}: plugin báo ${said ? `${said.bytes} byte/${said.records} bản ghi` : 'không có'}, server nhận ${got.bytes} byte/${got.records} bản ghi hoặc hash khác.`, undefined, name);
      }
    }
  }

  private checkGraph(): void {
    const inv = this.first;
    const ids = new Set(inv.keys());
    const roots = new Set(this.input.rootIds);
    for (const [id, n] of inv) {
      if (n.parentId !== null && !ids.has(n.parentId) && !roots.has(id) && !(n.type === 'PAGE')) this.raise('parent_missing', 'blocker', `Node ${id} có cha ${n.parentId} không nằm trong kiểm kê.`, id);
      if (n.parentId !== null && ids.has(n.parentId)) {
        const parent = inv.get(n.parentId)!;
        if (parent.childIds[n.index] !== id) this.raise('child_order_mismatch', 'blocker', `Node ${id} không đứng đúng vị trí ${n.index} trong danh sách con của ${n.parentId}.`, id);
      }
      for (const child of n.childIds) if (!ids.has(child)) this.raise('child_missing', 'blocker', `Node ${id} liệt kê con ${child} mà kiểm kê không có.`, id);
      if (new Set(n.childIds).size !== n.childIds.length) this.raise('duplicate_id', 'blocker', `Node ${id} liệt kê một con hai lần.`, id);
    }
    // A cycle cannot be reached from a root, so walk every node up to its top with a bound and a visited set.
    for (const [id] of inv) {
      const seen = new Set<string>();
      let at: string | null = id;
      while (at !== null) {
        if (seen.has(at)) { this.raise('graph_cycle', 'blocker', `Cây node có vòng lặp quanh ${at}.`, at); break; }
        seen.add(at);
        const parent: string | null = inv.get(at)?.parentId ?? null;
        at = parent !== null && inv.has(parent) ? parent : null;
      }
    }
  }

  private checkRootsAndRecords(): void {
    for (const root of this.input.rootIds) if (!this.first.has(root)) this.raise('root_missing', 'blocker', `Node gốc ${root} đã yêu cầu nhưng không có trong kiểm kê.`, root);
    for (const page of this.input.pageIds) if (!this.first.has(page)) this.raise('page_missing', 'blocker', `Trang ${page} đã yêu cầu nhưng không có trong kiểm kê.`, page);
    for (const id of this.first.keys()) if (!this.nodeSeen.has(id)) this.raise('missing_node_record', 'blocker', `Kiểm kê có node ${id} nhưng không có bản ghi dữ liệu.`, id);
  }

  private checkVerification(): void {
    const { first, second } = this;
    if (second.size === 0 && first.size > 0) { this.raise('verification_missing', 'blocker', 'Thiếu lượt kiểm kê đối chiếu lần hai.'); return; }
    const changed: string[] = [];
    for (const [id, a] of first) {
      const b = second.get(id);
      if (!b || b.type !== a.type || b.parentId !== a.parentId || b.index !== a.index || canonicalJson(b.childIds) !== canonicalJson(a.childIds)) changed.push(id);
    }
    for (const id of second.keys()) if (!first.has(id)) changed.push(id);
    if (changed.length) this.raise('source_changed', 'blocker', `Nguồn đã thay đổi giữa hai lượt đọc (${changed.length} node khác nhau, ví dụ ${changed.slice(0, 3).join(', ')}). Hãy export lại.`);
    if (this.input.finish.verification.sourceChanged) this.raise('source_changed', 'blocker', `Plugin phát hiện nguồn thay đổi khi đọc (${this.input.finish.verification.changedIds.slice(0, 3).join(', ') || 'không rõ node'}). Hãy export lại.`);
    if (this.input.finish.verification.watchedDocumentChanges && this.input.finish.verification.documentChanges > 0) this.raise('source_changed', 'blocker', `Figma báo ${this.input.finish.verification.documentChanges} thay đổi tài liệu trong lúc export. Hãy export lại.`);
  }

  private checkDependencies(): void {
    const resolve = (kind: 'style' | 'variable' | 'component', refs: Map<string, Set<string>>, has: (id: string) => boolean, label: string) => {
      for (const [id, users] of refs) {
        this.dependencyTotal++;
        if (has(id)) { this.dependencyResolved++; continue; }
        this.dependencyUnavailable++;
        this.aggregate(`dependency_unresolved`, 'limit', kind, `${label} được tham chiếu nhưng không có dữ liệu (thường là thư viện ngoài hoặc không đủ quyền đọc).`, `${id}←${[...users][0]}`);
      }
    };
    resolve('style', this.styleRefs, (id) => this.styles.has(id), 'Style');
    resolve('variable', this.variableRefs, (id) => this.variables.has(id), 'Variable');
    for (const [id, users] of this.componentRefs) {
      this.dependencyTotal++;
      const c = this.components.get(id);
      if (!c || c.scope === 'unavailable') { this.dependencyUnavailable++; this.aggregate('dependency_unresolved', 'limit', 'component', 'Main component được tham chiếu nhưng không đọc được (thư viện ngoài hoặc không đủ quyền).', `${id}←${[...users][0]}`); }
      else if (c.scope === 'dependency_only') { this.dependencyResolved++; this.dependencyOnly++; }
      else this.dependencyResolved++;
    }
    for (const [id, v] of this.variables) {
      if (!this.collections.has(v.collectionId)) this.aggregate('dependency_unresolved', 'limit', 'collection', 'Variable thuộc collection không có dữ liệu.', `${id}`);
      for (const [mode, value] of Object.entries(v.valuesByMode)) {
        const alias = value.s === 'read' && value.v && typeof value.v === 'object' && !Array.isArray(value.v) ? (value.v as { alias?: unknown }).alias : undefined;
        if (typeof alias === 'string' && !this.variables.has(alias)) this.aggregate('alias_missing', 'limit', 'variable.alias', `Alias của variable trỏ tới variable không có dữ liệu (mode ${mode}).`, id);
      }
      for (const issue of v.aliasIssues ?? []) this.aggregate('alias_issue', 'limit', 'variable.alias', `Variable có vấn đề alias: ${issue}`, id);
    }
    for (const id of this.variables.keys()) if (this.hasAliasCycle(id)) this.aggregate('alias_cycle', 'limit', 'variable.alias', 'Chuỗi alias của variable quay vòng; giá trị cuối không xác định được.', id);
    for (const [hash, users] of this.imageRefsUsed) {
      this.dependencyTotal++;
      const rec = this.imageRecords.get(hash);
      if (!rec) { this.dependencyUnavailable++; this.aggregate('asset_missing', 'limit', 'image', 'Ảnh được tham chiếu nhưng không có bản ghi tài nguyên gốc.', `${hash}←${[...users][0]}`); continue; }
      if (rec.status === 'bytes') this.dependencyResolved++;
      else { this.dependencyUnavailable++; this.aggregate(rec.status === 'oversize' ? 'asset_oversize' : 'asset_missing', 'limit', 'image', `Ảnh gốc ${rec.status === 'oversize' ? 'vượt giới hạn dung lượng' : 'không lấy được'}${rec.reason ? ` (${rec.reason})` : ''}; chỉ có thể có ảnh xem trước.`, `${hash}←${[...users][0]}`); }
    }
  }

  private hasAliasCycle(start: string): boolean {
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (seen.has(id)) return true;
      seen.add(id);
      const v = this.variables.get(id);
      if (!v) return false;
      for (const value of Object.values(v.valuesByMode)) {
        const alias = value.s === 'read' && value.v && typeof value.v === 'object' && !Array.isArray(value.v) ? (value.v as { alias?: unknown }).alias : undefined;
        if (typeof alias === 'string' && walk(alias)) return true;
      }
      seen.delete(id);
      return false;
    };
    return walk(start);
  }

  private checkAssets(): void {
    const { finish, storedAssets } = this.input;
    const said = new Map(finish.assets.map((a) => [a.id, a]));
    for (const [id, rec] of this.assets) {
      if (rec.status !== 'stored') continue;
      const disk = storedAssets.get(id), told = said.get(id);
      if (!disk) { this.raise('asset_bytes_missing', 'blocker', `Tài nguyên ${id} được ghi là đã lưu nhưng server không có bytes.`, id); continue; }
      if (disk.sha256 !== rec.sha256 || disk.bytes !== rec.bytes || !told || told.sha256 !== disk.sha256 || told.bytes !== disk.bytes) this.raise('asset_hash_mismatch', 'blocker', `Tài nguyên ${id}: bytes hoặc hash khác với bản ghi.`, id);
    }
    for (const id of storedAssets.keys()) if (!this.assets.has(id)) this.raise('asset_unrecorded', 'blocker', `Server nhận bytes của tài nguyên ${id} nhưng không có bản ghi mô tả.`, id);
    for (const [id, a] of said) if (!storedAssets.has(id) && this.assets.get(id)?.status === 'stored') this.raise('asset_bytes_missing', 'blocker', `Plugin báo đã gửi tài nguyên ${id} (${a.bytes} byte) nhưng server không có.`, id);
    for (const rec of this.assets.values()) {
      if (rec.status === 'oversize') this.aggregate('asset_oversize', 'limit', 'asset', 'Tài nguyên vượt giới hạn dung lượng nên không được lưu.', rec.id);
      else if (rec.status === 'missing' || rec.status === 'error') this.aggregate('asset_missing', 'limit', 'asset', `Tài nguyên không lấy được${rec.reason ? ` (${rec.reason})` : ''}.`, rec.id);
    }
  }

  private assetCoverage(): ExportCoverage['assetCoverage'] {
    const list = [...this.assets.values()];
    return {
      total: list.length, stored: list.filter((a) => a.status === 'stored').length, missing: list.filter((a) => a.status === 'missing').length,
      oversize: list.filter((a) => a.status === 'oversize').length, error: list.filter((a) => a.status === 'error').length,
      previewOnly: list.filter((a) => a.assetKind === 'preview' && a.status === 'stored').length,
    };
  }
}

/** Calls `found` with the id of every variable alias inside a value. Mirrors what the plugin collects, so both sides agree on what a node depends on. */
function walkAliases(value: unknown, found: (id: string) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const x of value) walkAliases(x, found); return; }
  const o = value as Record<string, unknown>;
  if (o.type === 'VARIABLE_ALIAS' && typeof o.id === 'string') { found(o.id); return; }
  for (const v of Object.values(o)) walkAliases(v, found);
}

const STRUCTURAL = new Set(['node_malformed', 'inventory_malformed', 'duplicate_id', 'parent_missing', 'child_order_mismatch', 'child_missing', 'graph_cycle', 'root_missing', 'page_missing', 'missing_node_record', 'unknown_node_record', 'record_inventory_mismatch', 'node_hash_mismatch', 'stream_mismatch', 'missing_group_status']);
const LIMIT_LABEL = { time: 'thời gian', nodes: 'số node', bytes: 'dung lượng', asset: 'dung lượng một tài nguyên' } as const;
