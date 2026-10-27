import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DependencyRecord } from '../../shared/figma.js';
import { DESIGN_POLICY_VERSION, type DesignBinding, type DesignInputReceipt, type DesignReportFacts, type DesignSnapshot } from '../../shared/design.js';
import type { Role, Run } from '../../shared/types.js';
import { DESIGN_BLOCK_NOTE, FIGMA_DATA_NOTICE, designRefProblems, designSummary, idHash, sha256Hex, type SummaryInput } from '../../core/design.js';
import { HttpError, Blocked } from '../run/support.js';
import type { AttemptDesign, DesignProvider } from '../run/design.js';
import type { SnapshotReader, SnapshotStore } from './snapshots.js';

const MOUNT_DOCKER = '/aidept-design';
const MAX_RECEIPT_FILES = 400;

/** Hash of a folder: its relative paths and the hash of each file, so any added, removed or changed file changes it. */
export function hashDir(dir: string): { hash: string; files: { path: string; sha256: string }[] } {
  const files: { path: string; sha256: string }[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files.push({ path: next, sha256: sha256Hex(readFileSync(path.join(dir, next))) });
    }
  };
  if (existsSync(dir)) walk('');
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { hash: sha256Hex(files.map((f) => `${f.path}\0${f.sha256}`).join('\n')), files };
}

/**
 * Gives a run its design: a private copy of the part of the snapshot its targets need, outside the source code, and a summary for each role.
 * The canonical snapshot is never handed to an agent; the copy is checked before and after every turn.
 */
export class DesignInputs implements DesignProvider {
  constructor(private readonly dataDir: string, private readonly snapshots: SnapshotStore) {}

  /**
   * The binding a contract stores for a snapshot and some targets: only a published snapshot whose files still match, only targets it
   * really holds. The hash and the accepted limits come from the snapshot, never from whoever asks.
   */
  bind(input: { snapshotId: string; targetIds?: string[] }): DesignBinding {
    const snapshot = this.snapshots.get(input.snapshotId);
    if (!snapshot) throw new HttpError(404, 'Snapshot thiết kế không tồn tại.');
    if (snapshot.status !== 'published' || !snapshot.publish) throw new HttpError(409, 'Snapshot chưa được duyệt; vào MCP → Thư viện snapshot để xem và duyệt trước khi dùng cho task.');
    const verified = this.snapshots.verify(snapshot.id);
    if (!verified.ok) throw new HttpError(409, `Dữ liệu snapshot không còn khớp: ${verified.problems.slice(0, 2).join(' ')}`);
    const targets = [...new Set(input.targetIds ?? [])].sort();
    const reader = this.snapshots.reader(snapshot.id);
    const missing = targets.filter((t) => !reader.has(t));
    if (missing.length) throw new HttpError(400, `Target không có trong snapshot: ${missing.slice(0, 3).join(', ')}.`);
    return { snapshotId: snapshot.id, snapshotHash: snapshot.snapshotHash, targetIds: targets, acknowledgedIssueIds: [...snapshot.publish.acknowledgedIssueIds].sort(), designPolicyVersion: DESIGN_POLICY_VERSION };
  }

  private dirFor(run: Run, binding: DesignBinding): string { return path.join(this.dataDir, 'design-inputs', run.id, binding.snapshotHash.slice(0, 16)); }

  problems(run: Run): string[] {
    const binding = run.contract.design;
    let reader: SnapshotReader | undefined;
    if (binding) {
      try { this.snapshots.usable(binding); reader = this.snapshots.reader(binding.snapshotId); }
      catch (error) { return [`Nguồn thiết kế của task không dùng được: ${(error as HttpError).message}`]; }
    }
    return designRefProblems(run.contract, reader?.lookup, binding);
  }

  describe(run: Run, receipts: readonly { role: string; attemptId: string }[], changedByAgent: number): DesignReportFacts | undefined {
    const binding = run.contract.design;
    if (!binding) return undefined;
    const problems = this.problems(run).filter((p) => /Nguồn thiết kế/.test(p));
    const snapshot = this.snapshots.get(binding.snapshotId);
    const byRole = new Map<string, number>();
    for (const r of receipts) byRole.set(r.role, (byRole.get(r.role) ?? 0) + 1);
    const accepted = new Set(binding.acknowledgedIssueIds);
    return {
      snapshotId: binding.snapshotId, snapshotHash: binding.snapshotHash, fileName: snapshot?.source.fileName ?? '(snapshot không còn)', identity: snapshot?.source.identity ?? 'user_attested',
      label: snapshot ? (snapshot.limited ? 'Có giới hạn' : 'Đã đọc đủ cấu trúc trong phạm vi') : 'Không rõ', limited: !!snapshot?.limited,
      acknowledged: (snapshot?.issues ?? []).filter((i) => accepted.has(i.id)).map((i) => ({ id: i.id, message: i.message })), targetIds: binding.targetIds,
      counts: { nodes: snapshot?.counts.nodes ?? 0, pages: snapshot?.counts.pages ?? 0, components: snapshot?.counts.components ?? 0, styles: snapshot?.counts.styles ?? 0, variables: snapshot?.counts.variables ?? 0, assets: snapshot?.counts.assets ?? 0 },
      usable: problems.length === 0, problems, inputs: [...byRole].map(([role, attempts]) => ({ role, attempts })), changedByAgent,
    };
  }

  async prepare(run: Run, role: Role, attemptId: string): Promise<AttemptDesign | undefined> {
    const binding = run.contract.design;
    if (!binding || run.provider === 'fake') return undefined;
    const snapshot = this.snapshots.usable(binding);
    const reader = this.snapshots.reader(snapshot.id);
    const dir = this.dirFor(run, binding);
    const expectedFile = `${dir}.sha256`;
    const current = existsSync(dir) ? hashDir(dir).hash : '';
    if (!current || !existsSync(expectedFile) || readFileSync(expectedFile, 'utf8').trim() !== current) this.build(dir, expectedFile, snapshot, reader, binding);
    const { hash, files } = hashDir(dir);
    const docker = run.configSnapshot.executionMode !== 'local';
    const mountPath = docker ? MOUNT_DOCKER : dir;
    const summary = designSummary(role, this.summaryInput(snapshot, reader, binding, mountPath));
    const receipt: DesignInputReceipt = {
      schemaVersion: 1, attemptId, role, runId: run.id, snapshotId: snapshot.id, snapshotHash: snapshot.snapshotHash, targetIds: binding.targetIds, summaryHash: sha256Hex(summary),
      files: files.slice(0, MAX_RECEIPT_FILES), mount: mountPath, mountKind: docker ? 'docker_ro' : 'local_copy', hashBefore: hash, at: new Date().toISOString(),
    };
    return {
      block: `\n\n<design_source>\n${summary}\n${DESIGN_BLOCK_NOTE}\n</design_source>\n`, receipt, exec: { hostDir: dir, mountPath },
      verifyAfter: () => {
        const after = hashDir(dir).hash;
        receipt.hashAfter = after;
        if (after !== hash) throw new Blocked(`Agent (${role}) đã thay đổi thư mục dữ liệu thiết kế được cấp. Bản cấp không còn khớp snapshot nên không được dùng; lượt sau sẽ cấp lại bản sạch từ snapshot đã duyệt.`);
      },
    };
  }

  private summaryInput(snapshot: DesignSnapshot, reader: SnapshotReader, binding: DesignBinding, mountPath: string): SummaryInput {
    const targets = this.targetsOf(reader, binding);
    const deps = [...reader.dependencies()];
    const index = reader.readJson<{ components: { id: string; name: string; axes: string[] }[] }>('index.json');
    const accepted = new Set(binding.acknowledgedIssueIds);
    return {
      snapshotId: snapshot.id, snapshotHash: snapshot.snapshotHash, coverageText: snapshot.limited ? 'Có giới hạn' : 'Đã đọc đủ cấu trúc trong phạm vi', limited: snapshot.limited, identity: snapshot.source.identity,
      issues: snapshot.issues.filter((i) => accepted.has(i.id)).map((i) => ({ id: i.id, message: i.message })),
      targets: targets.map((r) => ({ id: r.id, name: r.name, type: r.type, ...(reader.row(r.page)?.name ? { page: reader.row(r.page)!.name } : {}) })),
      // The components in the snapshot, and the main components its nodes use that live outside it.
      components: [...index.components.map((c) => ({ id: c.id, name: c.name, axes: c.axes })), ...deps.flatMap((d) => (d.k === 'component' && d.scope !== 'unavailable' && !index.components.some((c) => c.id === d.id) ? [{ id: d.id, name: d.name, axes: [] as string[] }] : []))],
      tokens: { styles: deps.filter((d) => d.k === 'style').length, variables: deps.filter((d) => d.k === 'variable').length, collections: deps.flatMap((d) => (d.k === 'collection' ? [d.name] : [])) },
      assets: deps.flatMap((d) => (d.k === 'asset' && d.status === 'stored' ? [{ id: d.id, kind: d.assetKind, mime: d.mime, bytes: d.bytes }] : [])),
      mountPath,
    };
  }

  private targetsOf(reader: SnapshotReader, binding: DesignBinding) {
    const ids = binding.targetIds.length ? binding.targetIds : reader.roots.map((r) => r.id);
    return ids.flatMap((id) => { const row = reader.row(id); return row ? [row] : []; });
  }

  /** The run's own copy of what its targets need. Rebuilt from the snapshot whenever it does not match what was written. */
  private build(dir: string, expectedFile: string, snapshot: DesignSnapshot, reader: SnapshotReader, binding: DesignBinding): void {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const src = this.snapshots.dir(snapshot.id);
    const copy = (rel: string) => { const from = path.join(src, rel), to = path.join(dir, rel); if (!existsSync(from)) return; mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(from, to); };
    const targets = this.targetsOf(reader, binding);
    const inTarget = new Set<string>();
    const index: { id: string; name: string; type: string; dir: string; nodes: number }[] = [];
    for (const t of targets) {
      const rows = reader.subtree(t.id);
      rows.forEach((r) => inTarget.add(r.id));
      const rel = `targets/${idHash(t.id)}`;
      mkdirSync(path.join(dir, rel), { recursive: true });
      writeFileSync(path.join(dir, rel, 'nodes.ndjson'), rows.map((r) => JSON.stringify(reader.node(r.id))).join('\n') + '\n');
      writeFileSync(path.join(dir, rel, 'tree.json'), JSON.stringify(rows.map((r) => ({ id: r.id, name: r.name, type: r.type, parentId: r.parentId, index: r.index, depth: r.depth }))));
      index.push({ id: t.id, name: t.name, type: t.type, dir: rel, nodes: rows.length });
    }
    // Components that appear in the targets, the tokens in full (they are small), and the assets the targets use.
    const deps = [...reader.dependencies()];
    const wantedComponents = new Set(index.length ? [...inTarget].filter((id) => ['COMPONENT', 'COMPONENT_SET'].includes(reader.row(id)?.type ?? '')) : []);
    for (const d of deps) if (d.k === 'component') for (const u of d.usedBy ?? []) if (inTarget.has(u)) wantedComponents.add(d.id);
    for (const id of wantedComponents) { copy(`components/${idHash(id)}/index.md`); copy(`components/${idHash(id)}/variants.json`); }
    for (const f of ['styles.json', 'variables.json', 'collections.json', 'index.md']) copy(`tokens/${f}`);
    const assets = new Set<string>();
    for (const d of deps as DependencyRecord[]) {
      if (d.k === 'imageRef' && d.assetId && d.refs.some((r) => inTarget.has(r.nodeId))) assets.add(d.assetId);
      if (d.k === 'asset' && d.status === 'stored' && d.source.nodeId && inTarget.has(d.source.nodeId)) assets.add(d.id);
    }
    for (const file of snapshot.files.filter((f) => f.kind === 'asset')) { const id = path.basename(file.path).replace(/\.[^.]+$/, ''); if (assets.has(id)) copy(file.path); }
    copy('review.json');
    writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ schemaVersion: 1, snapshotId: snapshot.id, snapshotHash: snapshot.snapshotHash, limited: snapshot.limited, source: { fileName: snapshot.source.fileName, identity: snapshot.source.identity }, targets: index, components: [...wantedComponents], assets: [...assets], notice: FIGMA_DATA_NOTICE }, null, 1));
    writeFileSync(path.join(dir, 'README.md'), `# Dữ liệu thiết kế cho task\n\n${FIGMA_DATA_NOTICE}\n\nThư mục này chỉ đọc. Bắt đầu từ \`index.json\`; mỗi target có \`nodes.ndjson\` (mọi trường đã đọc, kèm trạng thái từng trường) và \`tree.json\`.\n`);
    writeFileSync(expectedFile, hashDir(dir).hash);
  }

  /** The folder of a finished or abandoned run goes with it. */
  remove(runId: string): void {
    const base = path.join(this.dataDir, 'design-inputs', runId);
    rmSync(base, { recursive: true, force: true });
  }
}
