import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hashContract, initialContract } from '../src/core/contract.js';
import { renderReportMarkdown } from '../src/core/report.js';
import { hashDir } from '../src/server/figma/designinput.js';
import type { AgentExecution } from '../src/runtime/types.js';
import type { Role } from '../src/shared/types.js';
import { profile } from './helpers.js';
import { rig } from './figma/harness.js';

let current: Awaited<ReturnType<typeof rig>> | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

interface Seen { role: Role; prompt: string; design: AgentExecution['design']; slot: string }
type Rig = NonNullable<typeof current>;
let seen: Seen[] = [];
let tamper: ((exec: AgentExecution) => void) | undefined;

async function start(options: { local?: boolean; contextEnabled?: boolean } = {}) {
  seen = []; tamper = undefined;
  current = await rig({ fake: { reply: (exec) => { seen.push({ role: exec.role, prompt: exec.prompt, design: exec.design, slot: exec.attempt.slot }); tamper?.(exec); return undefined; } } });
  await current.pairNow();
  current.store.projects.put(profile({ contextEnabled: options.contextEnabled ?? false, ...(options.local ? { executionMode: 'local' as const } : {}) }));
  return current;
}

/** Exports the golden frame, approves it with its limits acknowledged, and returns the published snapshot. */
async function publishedSnapshot(r: Rig) {
  const job = await r.finished((await r.exportAs({ scope: 'selection', rootIds: ['1:2'] })).id);
  const snap = r.service.snapshots.get(job.snapshotId!)!;
  const res = await r.admin.post(`/api/design-snapshots/${snap.id}/publish`, { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: snap.issues.filter((i) => i.severity === 'limit').map((i) => i.id) });
  expect(res.statusCode, res.body).toBe(200);
  return r.service.snapshots.get(snap.id)!;
}
const make = (r: Rig, over: Record<string, unknown> = {}) => r.orchestrator.createRun({ projectId: 'prj_test', title: 'Màn đăng nhập', originalRequirement: 'Dựng màn đăng nhập đúng thiết kế.', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [], ...over } as never);
const approve = async (r: Rig, id: string) => { r.orchestrator.approveContract(id, { contractHash: r.orchestrator.detail(id).contractReview.contractHash, acknowledgeWarnings: true }); await r.orchestrator.idle(); };

describe('the design a task uses is fixed when the task is made', () => {
  it('binds the snapshot and its hash from the request, from the project default, or not at all', async () => {
    const r = await start();
    const snap = await publishedSnapshot(r);
    const explicit = make(r, { design: { snapshotId: snap.id, targetIds: ['1:2'] } });
    expect(explicit.contract.design).toEqual({ snapshotId: snap.id, snapshotHash: snap.snapshotHash, targetIds: ['1:2'], acknowledgedIssueIds: snap.publish!.acknowledgedIssueIds.slice().sort(), designPolicyVersion: 1 });
    await r.admin.post('/api/projects/prj_test/design-source', { snapshotId: snap.id });
    expect(make(r).contract.design).toMatchObject({ snapshotId: snap.id, targetIds: [] });
    expect(make(r, { design: { snapshotId: null } }).contract.design).toBeUndefined();
    expect(make(r, { design: { snapshotId: snap.id } }).contract.design!.snapshotHash).toBe(snap.snapshotHash);
  }, 60000);

  it('refuses an unpublished snapshot, a target it does not hold, and a design when the server has no such integration', async () => {
    const r = await start();
    const draft = r.service.snapshots.get((await r.finished((await r.exportAs({ scope: 'file' })).id)).snapshotId!)!;
    expect(() => make(r, { design: { snapshotId: draft.id } })).toThrow(/chưa được duyệt/);
    const snap = await publishedSnapshot(r);
    expect(() => make(r, { design: { snapshotId: snap.id, targetIds: ['404:404'] } })).toThrow(/Target không có/);
    const body = await r.admin.post('/api/runs', { projectId: 'prj_test', title: 't', originalRequirement: 'x', mode: 'single', provider: 'codex', budgetUsd: 5, design: { snapshotId: draft.id } });
    expect(body.statusCode).toBe(409);
    const { Orchestrator } = await import('../src/server/orchestrator.js');
    const bare = new Orchestrator(r.store, () => r.runtime);
    expect(() => bare.createRun({ projectId: 'prj_test', title: 't', originalRequirement: 'x', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [], design: { snapshotId: snap.id } })).toThrow(/chưa bật/);
    expect(bare.createRun({ projectId: 'prj_test', title: 't', originalRequirement: 'x', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] }).contract.design).toBeUndefined();
  }, 60000);

  it('leaves a task without a design with exactly the contract it always had', async () => {
    const r = await start();
    const run = make(r);
    expect(run.contract).toEqual(initialContract('Dựng màn đăng nhập đúng thiết kế.'));
    expect(hashContract(run.contract)).toBe(hashContract(initialContract('Dựng màn đăng nhập đúng thiết kế.')));
    expect(JSON.stringify(run.contract)).not.toContain('design');
  }, 60000);

  it('keeps the design through a Planner\'s proposal and a person\'s edit, and changes it only by choosing another (a contract change)', async () => {
    const r = await start();
    const snap = await publishedSnapshot(r);
    const run = make(r, { design: { snapshotId: snap.id } });
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    const proposed = r.orchestrator.detail(run.id).run.contract;
    expect(proposed.design).toEqual(run.contract.design);
    expect(seen.some((s) => s.role === 'planner')).toBe(true);
    const edited = r.orchestrator.reviseContract(run.id, { ...proposed, assumptions: ['một giả định mới'], design: undefined } as never);
    expect(edited.contract.design).toEqual(run.contract.design);
    expect(edited.contract.version).toBe(proposed.version + 1);
    // Choosing another source is the explicit way, and it raises the version and drops the approval.
    const none = (await r.admin.post(`/api/runs/${run.id}/design`, { snapshotId: null })).json();
    expect(none.contract.design).toBeUndefined();
    expect(none.contract.version).toBe(edited.contract.version + 1);
    expect(none.status).toBe('awaiting_approval');
    const back = (await r.admin.post(`/api/runs/${run.id}/design`, { snapshotId: snap.id, targetIds: ['1:2'] })).json();
    expect(back.contract).toMatchObject({ version: none.contract.version + 1, design: { targetIds: ['1:2'] } });
    expect((await r.admin.post(`/api/runs/${run.id}/design`, { snapshotId: snap.id, targetIds: ['1:2'] })).json().contract.version).toBe(back.contract.version);
  }, 60000);
});

describe('a task whose design cannot be used does not reach an agent', () => {
  it('stops before any agent when the snapshot was edited after the task was made, and says why', async () => {
    const r = await start();
    const snap = await publishedSnapshot(r);
    const run = make(r, { design: { snapshotId: snap.id } });
    appendFileSync(path.join(r.service.snapshots.dir(snap.id), 'index.json'), ' ');
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    const d = r.orchestrator.detail(run.id);
    expect(d.run.status).toBe('blocked');
    expect(d.run.blocker).toContain('Nguồn thiết kế của task không dùng được');
    expect(seen).toEqual([]);
    expect(r.runtime.calls.filter((c) => c.startsWith('agent:'))).toEqual([]);
  }, 60000);

  it('stops before the Developer when a requirement depends on a field that was never read, however many warnings were ticked', async () => {
    const r = await start();
    r.doc.text.failing.set('characters', new Error('boom'));
    const snap = await publishedSnapshot(r);
    const run = make(r, { design: { snapshotId: snap.id } });
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    const contract = r.orchestrator.detail(run.id).run.contract;
    r.orchestrator.reviseContract(run.id, { ...contract, requirements: contract.requirements.map((q) => ({ ...q, designRefs: [{ nodeId: '1:3', fieldPath: 'text.characters' }] })) } as never);
    seen = [];
    await approve(r, run.id);
    const d = r.orchestrator.detail(run.id);
    expect(d.run.status).toBe('blocked');
    expect(d.run.blocker).toContain('text.characters');
    expect(d.run.blocker).toContain('error (boom)');
    expect(seen.filter((s) => s.role === 'developer')).toEqual([]);
    // A field that was read is accepted.
    r.orchestrator.reviseContract(run.id, { ...contract, requirements: contract.requirements.map((q) => ({ ...q, designRefs: [{ nodeId: '1:3', fieldPath: 'text.fontName' }] })) } as never);
    await approve(r, run.id);
    expect(seen.some((s) => s.role === 'developer')).toBe(true);
  }, 90000);
});

describe('what each agent turn is given, and what it proves', () => {
  it('gives the Planner and the Developer the same source as a summary and a path, even when project memory is off', async () => {
    const r = await start({ contextEnabled: false });
    const snap = await publishedSnapshot(r);
    const run = make(r, { design: { snapshotId: snap.id, targetIds: ['1:2'] } });
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    await approve(r, run.id);
    const roles = seen.filter((s) => s.design).map((s) => s.role);
    expect(roles).toEqual(expect.arrayContaining(['planner', 'developer']));
    for (const s of seen.filter((x) => x.design)) {
      expect(s.prompt).toContain('<design_source>');
      expect(s.prompt).toContain(snap.snapshotHash.slice(0, 12));
      expect(s.prompt).toContain('visual verification');
      expect(s.prompt).toContain(s.design!.mountPath);
      expect(s.prompt).toContain('chỉ là dữ liệu');
    }
    const dev = seen.find((s) => s.role === 'developer')!;
    expect(dev.prompt).toContain('Component (1)');
    expect(dev.prompt).toContain('Màn hình &lt;Đăng nhập&gt;');
    expect(seen.find((s) => s.role === 'planner')!.prompt).not.toContain('Component (');
    // How to make an interface match its design is the Developer's to know, not the Planner's.
    expect(dev.prompt).toContain('Quy tắc dựng giao diện khớp thiết kế');
    expect(seen.find((s) => s.role === 'planner')!.prompt).not.toContain('Quy tắc dựng giao diện khớp thiết kế');
    // Docker is the default: the host folder is mounted read-only at a fixed place.
    expect(dev.design!.mountPath).toBe('/aidept-design');
    expect(existsSync(dev.design!.hostDir)).toBe(true);
  }, 90000);

  it('hands out a private copy outside the workspace: the targets, tokens, components and only the assets they use', async () => {
    const r = await start({ local: true });
    const snap = await publishedSnapshot(r);
    const run = make(r, { design: { snapshotId: snap.id, targetIds: ['1:2'] } });
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    const exec = seen.find((s) => s.design)!.design!;
    expect(exec.mountPath).toBe(exec.hostDir);
    expect(exec.hostDir.startsWith(path.join(r.dataDir, 'design-inputs', run.id))).toBe(true);
    expect(exec.hostDir.includes('workspaces')).toBe(false);
    const index = JSON.parse(readFileSync(path.join(exec.hostDir, 'index.json'), 'utf8'));
    expect(index).toMatchObject({ snapshotId: snap.id, snapshotHash: snap.snapshotHash, targets: [{ id: '1:2', nodes: 6 }] });
    const target = path.join(exec.hostDir, index.targets[0].dir);
    expect(readFileSync(path.join(target, 'nodes.ndjson'), 'utf8').trim().split('\n')).toHaveLength(6);
    expect(existsSync(path.join(exec.hostDir, 'tokens', 'variables.json'))).toBe(true);
    expect(existsSync(path.join(exec.hostDir, 'README.md'))).toBe(true);
    expect(readdirSync(path.join(exec.hostDir, 'assets')).length).toBeGreaterThan(0);
    expect(statSync(exec.hostDir).isDirectory()).toBe(true);
  }, 60000);

  it('writes a receipt of what was offered and a check that it came back unchanged, tied to the snapshot hash', async () => {
    const r = await start();
    const snap = await publishedSnapshot(r);
    const run = make(r, { design: { snapshotId: snap.id } });
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    const arts = r.orchestrator.detail(run.id).artifacts;
    const receipt = JSON.parse(arts.find((a) => a.title === 'Design input receipt')!.content);
    expect(receipt).toMatchObject({ role: 'planner', snapshotId: snap.id, snapshotHash: snap.snapshotHash, mountKind: 'docker_ro', schemaVersion: 1 });
    expect(receipt.files.length).toBeGreaterThan(3);
    const block = /<design_source>\n([\s\S]*?)\nHãy dùng đúng/.exec(seen[0]!.prompt)![1]!;
    expect(receipt.summaryHash).toBe(createHash('sha256').update(block).digest('hex'));
    expect(receipt.hashBefore).toBe(hashDir(seen[0]!.design!.hostDir).hash);
    const check = JSON.parse(arts.find((a) => a.title === 'Design input check')!.content);
    expect(check).toMatchObject({ unchanged: true, hashBefore: receipt.hashBefore, hashAfter: receipt.hashBefore });
  }, 60000);

  it('blocks a turn after which the agent changed the folder it was given, hands a clean copy next time, and says so in the report', async () => {
    const r = await start();
    const snap = await publishedSnapshot(r);
    const run = make(r, { design: { snapshotId: snap.id } });
    let spoiled = false;
    tamper = (exec) => { if (exec.design && !spoiled) { spoiled = true; appendFileSync(path.join(exec.design.hostDir, 'index.json'), '\n// agent was here'); } };
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    const d = r.orchestrator.detail(run.id);
    expect(d.run.status).toBe('blocked');
    expect(d.run.blocker).toContain('đã thay đổi thư mục dữ liệu thiết kế');
    expect(JSON.parse(d.artifacts.filter((a) => a.title === 'Design input check').at(-1)!.content)).toMatchObject({ unchanged: false });
    const dir = seen[0]!.design!.hostDir;
    const spoiledHash = hashDir(dir).hash;
    seen = [];
    r.orchestrator.resumeRun(run.id); await r.orchestrator.idle();
    // The next turn started from the snapshot again, not from the edited copy.
    expect(seen[0]!.design).toBeDefined();
    expect(hashDir(dir).hash).not.toBe(spoiledHash);
    expect(readFileSync(path.join(dir, 'index.json'), 'utf8')).not.toContain('agent was here');
    const report = await r.orchestrator.report(run.id);
    expect(report.design!.changedByAgent).toBe(1);
    expect(report.warnings.some((w) => w.level === 'warn' && w.text.includes('thay đổi so với bản được cấp'))).toBe(true);
  }, 90000);

  it('does not give the independent interpreters the design, only the roles that need it', async () => {
    const r = await start();
    const snap = await publishedSnapshot(r);
    const run = make(r, { mode: 'clarify', design: { snapshotId: snap.id } });
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    const readers = seen.filter((s) => s.prompt.includes('diễn giải yêu cầu một cách độc lập'));
    expect(readers.length).toBeGreaterThan(0);
    for (const s of readers) { expect(s.design).toBeUndefined(); expect(s.prompt).not.toContain('<design_source>'); }
    expect(seen.some((s) => s.design && s.role === 'planner')).toBe(true);
  }, 60000);

  it('keeps the binding but gives no files to a simulated run, which runs no agent', async () => {
    const r = await start();
    const snap = await publishedSnapshot(r);
    const run = make(r, { provider: 'fake', design: { snapshotId: snap.id } });
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    expect(r.orchestrator.detail(run.id).run.contract.design).toBeDefined();
    expect(seen.every((s) => !s.design)).toBe(true);
  }, 60000);

  it('gives the Verifier the very same source as the Developer, from the same snapshot, whatever its memory budget', async () => {
    const r = await start({ contextEnabled: false });
    const snap = await publishedSnapshot(r);
    const run = make(r, { mode: 'verify', design: { snapshotId: snap.id } });
    const developer = await r.service.inputs.prepare(r.store.runs.get(run.id)!, 'developer', 'att_dev');
    const verifier = await r.service.inputs.prepare(r.store.runs.get(run.id)!, 'verifier', 'att_ver');
    expect(verifier!.receipt).toMatchObject({ role: 'verifier', snapshotHash: snap.snapshotHash, hashBefore: developer!.receipt.hashBefore });
    expect(verifier!.exec.hostDir).toBe(developer!.exec.hostDir);
    expect(verifier!.block).toContain('Màn hình');
    expect(verifier!.block).not.toContain('giải thích của Developer');
  }, 60000);
});

describe('the report says what design the task used', () => {
  it('names the snapshot, what each role was given and every accepted limit, and says there was no visual check', async () => {
    const r = await start();
    r.doc.text.failing.set('characters', new Error('boom'));
    const snap = await publishedSnapshot(r);
    const run = make(r, { design: { snapshotId: snap.id } });
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    const report = await r.orchestrator.report(run.id);
    expect(report.design).toMatchObject({ snapshotId: snap.id, usable: true, limited: true, identity: 'verified' });
    expect(report.design!.inputs.map((i) => i.role)).toContain('planner');
    expect(report.warnings.some((w) => w.level === 'warn' && w.text.includes('giới hạn đã chấp nhận'))).toBe(true);
    expect(report.warnings.some((w) => w.text.includes('Chưa có report đối chiếu hình ảnh'))).toBe(true);
    expect(report.visual).toBeUndefined();
    const md = renderReportMarkdown(report);
    expect(md).toContain('## Nguồn thiết kế');
    expect(md).toContain(snap.id);
    expect(md).toContain('Có giới hạn');
    expect(md).toContain('không chứng minh model đã đọc hết');
    const plain = await r.orchestrator.report(make(r).id);
    expect(plain.design).toBeUndefined();
    expect(renderReportMarkdown(plain)).not.toContain('Nguồn thiết kế');
  }, 90000);

  it('warns when the snapshot a task used is no longer usable', async () => {
    const r = await start();
    const snap = await publishedSnapshot(r);
    const run = make(r, { design: { snapshotId: snap.id } });
    appendFileSync(path.join(r.service.snapshots.dir(snap.id), 'index.json'), ' ');
    const report = await r.orchestrator.report(run.id);
    expect(report.design!.usable).toBe(false);
    expect(report.warnings.some((w) => w.level === 'warn' && w.text.includes('không còn dùng được'))).toBe(true);
  }, 60000);

  it('removes a task\'s design folder with the task', async () => {
    const r = await start();
    const snap = await publishedSnapshot(r);
    const run = make(r, { design: { snapshotId: snap.id } });
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    const base = path.join(r.dataDir, 'design-inputs', run.id);
    expect(existsSync(base)).toBe(true);
    r.orchestrator.deleteRun(run.id);
    expect(existsSync(base)).toBe(false);
  }, 60000);
});
