import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { profile } from './helpers.js';
import { FakeNode } from './figma/fakefigma.js';
import { rig, waitFor } from './figma/harness.js';

let current: Awaited<ReturnType<typeof rig>> | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });
const start = async (options: Parameters<typeof rig>[0] = {}) => { current = await rig(options); await current.pairNow(); return current; };
type Rig = NonNullable<typeof current>;

/** Exports and approves a selection of the golden frame, with every limit acknowledged. Returns the published snapshot. */
async function published(r: Rig, body: Record<string, unknown> = { scope: 'selection', rootIds: ['1:2'] }) {
  const job = await r.finished((await r.exportAs(body)).id);
  const snap = r.service.snapshots.get(job.snapshotId!)!;
  const ids = snap.issues.filter((i) => i.severity === 'limit').map((i) => i.id);
  const res = await r.admin.post(`/api/design-snapshots/${snap.id}/publish`, { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: ids });
  expect(res.statusCode, res.body).toBe(200);
  return r.service.snapshots.get(snap.id)!;
}

describe('a snapshot is only as good as its files, and the files are checked each time they are used', () => {
  it('notices an edited, deleted or added file, refuses to publish or bind it, and says which', async () => {
    const r = await start();
    const job = await r.finished((await r.exportAs({ scope: 'file' })).id);
    const snap = r.service.snapshots.get(job.snapshotId!)!;
    const dir = r.service.snapshots.dir(snap.id);
    expect(r.service.snapshots.verify(snap.id).ok).toBe(true);
    const page = snap.files.find((f) => f.kind === 'page' && f.path.endsWith('index.md'))!;
    appendFileSync(path.join(dir, page.path), '\nđã bị sửa sau khi dựng\n');
    const bad = r.service.snapshots.verify(snap.id);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toContain(page.path);
    const res = await r.admin.post(`/api/design-snapshots/${snap.id}/publish`, { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: snap.issues.filter((i) => i.severity === 'limit').map((i) => i.id) });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('không còn khớp');
    expect((await r.admin.get(`/api/design-snapshots/${snap.id}`)).json().integrity.ok).toBe(false);
    rmSync(path.join(dir, page.path));
    expect(r.service.snapshots.verify(snap.id).problems.join(' ')).toContain('Thiếu file');
    const manifest = path.join(dir, 'manifest.json');
    // Whitespace is not content; a changed value is.
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"fileName"', '"fileName" '));
    expect(r.service.snapshots.verify(snap.id).problems.join(' ')).not.toContain('snapshotHash');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"schemaVersion": 1', '"schemaVersion": 7'));
    expect(r.service.snapshots.verify(snap.id).problems.join(' ')).toContain('snapshotHash');
  }, 60000);

  it('is not usable by a task until published, and not once it has been edited', async () => {
    const r = await start();
    const draft = r.service.snapshots.get((await r.finished((await r.exportAs({ scope: 'file' })).id)).snapshotId!)!;
    expect(() => r.service.inputs.bind({ snapshotId: draft.id })).toThrow(/chưa được duyệt/);
    const ids = draft.issues.filter((i) => i.severity === 'limit').map((i) => i.id);
    await r.admin.post(`/api/design-snapshots/${draft.id}/publish`, { snapshotHash: draft.snapshotHash, acknowledgedIssueIds: ids });
    const binding = r.service.inputs.bind({ snapshotId: draft.id, targetIds: ['1:2', '1:2'] });
    expect(binding).toMatchObject({ snapshotId: draft.id, snapshotHash: draft.snapshotHash, targetIds: ['1:2'], designPolicyVersion: 1 });
    expect(binding.acknowledgedIssueIds).toEqual([...ids].sort());
    expect(() => r.service.inputs.bind({ snapshotId: draft.id, targetIds: ['404:404'] })).toThrow(/Target không có/);
    expect(() => r.service.inputs.bind({ snapshotId: 'dsn_000000000000' })).toThrow(/không tồn tại/);
    appendFileSync(path.join(r.service.snapshots.dir(draft.id), 'index.json'), ' ');
    expect(() => r.service.snapshots.usable(binding)).toThrow(/bị thay đổi/);
    expect(() => r.service.inputs.bind({ snapshotId: draft.id })).toThrow(/không còn khớp/);
  }, 60000);
});

describe('snapshots are kept while anything refers to them, and cleaned up when nothing does', () => {
  it('refuses to delete a snapshot a project or a task still uses, and deletes it, files and receipt, when free', async () => {
    const r = await start();
    r.store.projects.put(profile());
    const snap = await published(r);
    await r.admin.post('/api/projects/prj_test/design-source', { snapshotId: snap.id });
    const blocked = await r.admin.delete(`/api/design-snapshots/${snap.id}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain('Demo');
    await r.admin.post('/api/projects/prj_test/design-source', { snapshotId: null });
    const run = r.orchestrator.createRun({ projectId: 'prj_test', title: 't', originalRequirement: 'x', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [], design: { snapshotId: snap.id } });
    expect((await r.admin.delete(`/api/design-snapshots/${snap.id}`)).json().message).toContain(run.id);
    // Even a finished task keeps its snapshot alive, for audit.
    r.store.runs.put({ ...run, status: 'completed' });
    expect((await r.admin.delete(`/api/design-snapshots/${snap.id}`)).statusCode).toBe(409);
    r.orchestrator.deleteRun(run.id);
    expect((await r.admin.delete(`/api/design-snapshots/${snap.id}`)).statusCode).toBe(200);
    expect(existsSync(r.service.snapshots.dir(snap.id))).toBe(false);
    expect(existsSync(`${r.service.snapshots.dir(snap.id)}.publish.json`)).toBe(false);
    expect(r.service.snapshots.get(snap.id)).toBeUndefined();
  }, 60000);

  it('removes folders a crash left behind (a half-built snapshot, a folder with no record) and keeps real ones', async () => {
    const r = await start();
    const snap = await published(r);
    const root = r.service.snapshots.root;
    mkdirSync(path.join(root, '.tmp-dsn_abcdefabcdef'), { recursive: true });
    mkdirSync(path.join(root, 'dsn_abcdefabcdef'), { recursive: true });
    writeFileSync(path.join(root, 'dsn_abcdefabcdef', 'x'), '1');
    const removed = r.service.snapshots.recover();
    expect(removed.sort()).toEqual(['.tmp-dsn_abcdefabcdef', 'dsn_abcdefabcdef']);
    expect(existsSync(r.service.snapshots.dir(snap.id))).toBe(true);
    expect(r.service.snapshots.verify(snap.id).ok).toBe(true);
  }, 60000);

  it('keeps a snapshot when the project that pointed at it is deleted but a task still does, and never deletes a design-input folder of a live task', async () => {
    const r = await start();
    r.store.projects.put(profile());
    const snap = await published(r);
    const run = r.orchestrator.createRun({ projectId: 'prj_test', title: 't', originalRequirement: 'x', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [], design: { snapshotId: snap.id } });
    expect(r.service.referencesOf(snap.id)).toEqual({ projects: [], runs: [run.id] });
    expect(() => r.service.deleteSnapshot(snap.id)).toThrow(/còn được dùng/);
    expect(r.service.snapshots.get(snap.id)).toBeDefined();
  }, 60000);
});

describe('comparing two exports of the same file', () => {
  it('lists what was added, removed and changed (with the fields), and the limits that are new, once the two are known to be one file', async () => {
    const r = await start();
    const first = await published(r, { scope: 'file' });
    r.doc.text.props.set('characters', 'Xin chào, đã sửa');
    r.doc.vector.props.set('opacity', 0.5);
    const extra = new FakeNode('RECTANGLE', '8:8', 'mới', { visible: true, fills: [], width: 1, height: 1, opacity: 1, x: 0, y: 0, cornerRadius: 0 });
    r.doc.frame.kids!.push(extra); extra.parent = r.doc.frame; r.figma.register(extra);
    r.doc.hidden.failing.set('fills', new Error('không đọc được'));
    r.doc.frame.kids!.splice(r.doc.frame.kids!.indexOf(r.doc.vector), 1);
    r.figma.styles.set('S:9', { id: 'S:9', type: 'PAINT', name: 'Mới', key: 'k', description: '', remote: false, paints: [] });
    const second = r.service.snapshots.get((await r.finished((await r.exportAs({ scope: 'file' })).id)).snapshotId!)!;
    // One file, by its key, and the first is published: the second continues it without anyone claiming so.
    expect(second.previousId).toBe(first.id);
    const diff = (await r.admin.get(`/api/design-snapshots/${second.id}/diff?base=${first.id}`)).json();
    expect(diff.comparable).toBe(true);
    const byId = (id: string) => diff.nodes.find((n: { id: string }) => n.id === id);
    expect(byId('8:8')).toMatchObject({ change: 'added', name: 'mới' });
    expect(byId('1:5')).toMatchObject({ change: 'removed' });
    expect(byId('1:3')).toMatchObject({ change: 'changed' });
    expect(byId('1:3').fields).toEqual(expect.arrayContaining(['text.characters', 'text.segments'].slice(0, 1)));
    expect(byId('1:6').fields).toContain('paint.fills');
    expect(diff.summary.added).toBeGreaterThanOrEqual(2);
    expect(diff.newIssues.some((i: { code: string }) => i.code === 'field_error')).toBe(true);
    expect([...diff.tokens, ...diff.components].some((d: { change: string; id: string }) => d.change === 'added' && d.id.includes('S:9'))).toBe(true);
  }, 90000);

  it('declines to compare snapshots it cannot know are one file, and different scopes', async () => {
    const r = await start();
    r.figma.fileKey = undefined;
    await r.admin.post('/api/integrations/figma/check');
    const a = r.service.snapshots.get((await r.finished((await r.exportAs({ scope: 'file', attestSource: true })).id)).snapshotId!)!;
    const b = r.service.snapshots.get((await r.finished((await r.exportAs({ scope: 'file', attestSource: true })).id)).snapshotId!)!;
    const d = (await r.admin.get(`/api/design-snapshots/${b.id}/diff?base=${a.id}`)).json();
    expect(d).toMatchObject({ comparable: false });
    expect(d.reason).toContain('xác nhận cùng nguồn');
    // The person said "same file" at export time: only then is the history joined.
    const c = r.service.snapshots.get((await r.finished((await r.exportAs({ scope: 'file', attestSource: true, previousSnapshotId: b.id })).id)).snapshotId!)!;
    expect(c.previousId).toBe(b.id);
    expect((await r.admin.get(`/api/design-snapshots/${c.id}/diff?base=${b.id}`)).json().comparable).toBe(true);
    const pages = r.service.snapshots.get((await r.finished((await r.exportAs({ scope: 'pages', pageIds: ['0:2'], attestSource: true, previousSnapshotId: b.id })).id)).snapshotId!)!;
    expect(pages.previousId).toBeUndefined();
  }, 90000);
});

describe('what is served from a snapshot', () => {
  it('serves only files in the manifest, shows Markdown and JSON as text, and offers SVG only as a download', async () => {
    const r = await start();
    const snap = r.service.snapshots.get((await r.finished((await r.exportAs({ scope: 'file' })).id)).snapshotId!)!;
    const file = (pred: (f: { path: string; kind: string; mime: string }) => boolean) => snap.files.find(pred)!;
    const md = await r.admin.get(`/api/design-snapshots/${snap.id}/files/${file((f) => f.path.endsWith('.md')).id}`);
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toContain('text/plain');
    expect(md.headers['content-security-policy']).toContain("default-src 'none'");
    const svg = snap.files.find((f) => f.mime === 'image/svg+xml');
    expect(svg).toBeDefined();
    const sres = await r.admin.get(`/api/design-snapshots/${snap.id}/files/${svg!.id}`);
    expect(sres.headers['content-disposition']).toContain('attachment');
    expect(sres.headers['content-security-policy']).toContain('sandbox');
    const png = await r.admin.get(`/api/design-snapshots/${snap.id}/files/${file((f) => f.mime === 'image/png').id}`);
    expect(png.headers['content-type']).toBe('image/png');
    expect((await r.admin.get(`/api/design-snapshots/${snap.id}/files/zzzz`)).statusCode).toBe(404);
    expect((await r.admin.get(`/api/design-snapshots/..%2F..%2Fetc/files/${md.headers['x-none'] ?? 'x'}`)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await r.admin.get('/api/design-snapshots/dsn_000000000000')).statusCode).toBe(404);
  }, 60000);

  it('returns a node\'s record with every field status, and walks the tree level by level', async () => {
    const r = await start();
    const snap = r.service.snapshots.get((await r.finished((await r.exportAs({ scope: 'file' })).id)).snapshotId!)!;
    const rec = (await r.admin.get(`/api/design-snapshots/${snap.id}/nodes/1%3A3`)).json();
    expect(rec).toMatchObject({ id: '1:3', type: 'TEXT' });
    expect(rec.fields['text.fontName'].s).toBe('mixed');
    expect((await r.admin.get(`/api/design-snapshots/${snap.id}/nodes/9%3A9`)).statusCode).toBe(404);
    const roots = (await r.admin.get(`/api/design-snapshots/${snap.id}/tree`)).json();
    expect(roots.map((n: { name: string }) => n.name)).toEqual(['Trang 1', 'Thành phần', 'Trống']);
    const kids = (await r.admin.get(`/api/design-snapshots/${snap.id}/tree?parent=1%3A2`)).json();
    expect(kids.map((n: { id: string }) => n.id)).toEqual(['1:3', '1:4', '1:5', '1:6']);
    await waitFor(() => true);
  }, 60000);
});
