import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { golden, FakeNode } from './figma/fakefigma.js';
import { rig, waitFor } from './figma/harness.js';

let current: Awaited<ReturnType<typeof rig>> | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

const start = async (options: Parameters<typeof rig>[0] = {}) => { current = await rig(options); await current.pairNow(); return current; };
const blockers = (job: { issues: { severity: string; code: string }[] }) => job.issues.filter((i) => i.severity === 'blocker').map((i) => i.code);
const limits = (job: { issues: { severity: string; code: string }[] }) => job.issues.filter((i) => i.severity === 'limit').map((i) => i.code);
const publish = (r: NonNullable<typeof current>, snapshotId: string, body: Record<string, unknown>) => r.admin.post(`/api/design-snapshots/${snapshotId}/publish`, body);

describe('a field that could not be read stays visible, and publishing needs every limit acknowledged', () => {
  it('records the failure on the field, raises a limit, and publishes only with the hash and each issue id', async () => {
    const r = await start();
    r.doc.text.failing.set('characters', new Error('boom: font not loaded'));
    const done = await r.finished((await r.exportAs({ scope: 'selection', rootIds: [r.doc.frame.id] })).id);
    expect(done.status).toBe('review_ready');
    expect(blockers(done)).toEqual([]);
    expect(limits(done)).toContain('field_error');
    const reader = r.service.snapshots.reader(done.snapshotId!);
    expect(reader.node('1:3')!.fields['text.characters']).toMatchObject({ s: 'error', r: expect.stringContaining('boom') });
    expect(reader.node('1:3')!.groups.text).toBe('partial');
    const snap = r.service.snapshots.get(done.snapshotId!)!;
    expect(snap.limited).toBe(true);
    const ids = snap.issues.filter((i) => i.severity === 'limit').map((i) => i.id);

    expect((await publish(r, snap.id, { snapshotHash: 'a'.repeat(64), acknowledgedIssueIds: ids })).statusCode).toBe(409);
    const none = await publish(r, snap.id, { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: [] });
    expect(none.statusCode).toBe(409);
    expect(none.json().message).toContain('Chưa xác nhận');
    const foreign = await publish(r, snap.id, { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: [...ids, 'khong-co|x|y'] });
    expect(foreign.statusCode).toBe(409);
    expect((await publish(r, snap.id, { snapshotHash: 'xyz', acknowledgedIssueIds: ids })).statusCode).toBe(400);

    const ok = await publish(r, snap.id, { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: ids });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'published', limited: true, publish: { snapshotHash: snap.snapshotHash, limited: true } });
    // The receipt sits beside the snapshot, not inside its hashed manifest.
    expect(existsSync(`${r.service.snapshots.dir(snap.id)}.publish.json`)).toBe(true);
    expect(r.service.snapshots.verify(snap.id).ok).toBe(true);
    expect((await publish(r, snap.id, { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: ids })).statusCode).toBe(200);
  }, 60000);

  it('gives a snapshot with no limit a plain approval, and a published one cannot be approved again with another hash', async () => {
    const r = await start();
    const done = await r.finished((await r.exportAs({ scope: 'pages', pageIds: ['0:2'] })).id);
    expect(done.status).toBe('review_ready');
    expect(limits(done)).not.toContain('source_user_attested');
    const snap = r.service.snapshots.get(done.snapshotId!)!;
    expect((await publish(r, snap.id, { snapshotHash: snap.snapshotHash })).json()).toMatchObject({ status: 'published', limited: false });
    expect((await publish(r, snap.id, { snapshotHash: 'b'.repeat(64) })).statusCode).toBe(409);
  }, 60000);
});

describe('what cannot be read is named, never turned into empty data', () => {
  it('flags a node type the reader does not know, a style the file cannot give, an image with no bytes, and an alias that loops', async () => {
    const r = await start();
    const sticky = new FakeNode('STICKY', '8:1', 'ghi chú', { visible: true, width: 10, height: 10 });
    r.doc.frame.kids!.push(sticky); sticky.parent = r.doc.frame; r.figma.register(sticky);
    r.figma.styles.delete('S:1');
    r.figma.images.clear();
    r.figma.variableMap.get('VariableID:1:2')!.valuesByMode = { 'm:light': { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' }, 'm:dark': { r: 0, g: 0, b: 0, a: 1 } };
    const done = await r.finished((await r.exportAs({ scope: 'selection', rootIds: ['1:2'] })).id);
    expect(blockers(done)).toEqual([]);
    expect(limits(done)).toEqual(expect.arrayContaining(['unsupported_node_type', 'dependency_unresolved', 'asset_missing', 'alias_cycle']));
    const rec = r.service.snapshots.reader(done.snapshotId!).node('8:1')!;
    expect(Object.keys(rec.groups)).toEqual(['common']);
    expect(done.coverage!.dependencyCoverage.unavailable).toBeGreaterThan(0);
  }, 60000);

  it('treats a plugin that cannot return a file key as a source the person must vouch for', async () => {
    const r = await start();
    r.figma.fileKey = undefined;
    await r.admin.post('/api/integrations/figma/check');
    const refused = await r.admin.post('/api/design-exports', { scope: 'file' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain('xác nhận nguồn');
    const done = await r.finished((await r.exportAs({ scope: 'file', attestSource: true, declaredUrl: 'https://www.figma.com/design/abcdefghij123/Ten?node-id=1-2' })).id);
    expect(done.source.identity).toBe('user_attested');
    expect(done.source).toMatchObject({ declaredFileKey: 'abcdefghij123', declaredNodeId: '1:2' });
    expect(limits(done)).toContain('source_user_attested');
    expect(r.service.snapshots.get(done.snapshotId!)!.limited).toBe(true);
  }, 60000);

  it('refuses a URL for another file when the plugin does know its file key, and bad scopes and limits', async () => {
    const r = await start();
    const bad = await r.admin.post('/api/design-exports', { scope: 'file', declaredUrl: 'https://www.figma.com/design/ZZZZZZZZZZZZZZ/Khac' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('ZZZZZZZZZZZZZZ');
    expect((await r.admin.post('/api/design-exports', { scope: 'file', declaredUrl: 'http://example.com/x' })).statusCode).toBe(400);
    expect((await r.admin.post('/api/design-exports', { scope: 'selection', rootIds: [] })).statusCode).toBe(400);
    expect((await r.admin.post('/api/design-exports', { scope: 'file', limits: { maxNodes: 9_999_999 } })).statusCode).toBe(400);
    expect((await r.admin.post('/api/design-exports', { scope: 'pages', pageIds: ['9:9'] })).statusCode).toBe(400);
  }, 60000);
});

describe('an export that is stopped, cut short or disturbed never becomes data to publish', () => {
  it('stops when the source changes between the two reads, and the draft cannot be approved', async () => {
    const r = await start();
    let reads = 0;
    r.doc.text.onRead = (name) => { if (name === 'name' && ++reads === 4) r.doc.text.props.set('characters', 'Đã bị sửa giữa chừng'); };
    const done = await r.finished((await r.exportAs({ scope: 'selection', rootIds: ['1:2'] })).id);
    expect(done.status).toBe('partial');
    expect(blockers(done)).toContain('source_changed');
    expect(done.coverage!.consistency).toBe('source_changed');
    const snap = r.service.snapshots.get(done.snapshotId!)!;
    const res = await publish(r, snap.id, { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: snap.issues.filter((i) => i.severity === 'limit').map((i) => i.id) });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('thay đổi');
  }, 60000);

  it('notices an edit announced by Figma while a whole file is read', async () => {
    const r = await start();
    let release!: () => void;
    r.figma.gate = new Promise<void>((resolve) => { release = resolve; });
    const job = await r.exportAs({ scope: 'file' });
    await waitFor(() => r.job(job.id).status === 'reading');
    r.figma.emit('documentchange');
    release();
    const done = await r.finished(job.id);
    expect(blockers(done)).toContain('source_changed');
    expect(r.service.snapshots.get(done.snapshotId!)!.status).toBe('draft');
  }, 60000);

  it('cancels in the middle of reading: the job ends cancelled, late data is refused, and a new export may start', async () => {
    const r = await start();
    let release!: () => void;
    r.figma.gate = new Promise<void>((resolve) => { release = resolve; });
    const job = await r.exportAs({ scope: 'selection', rootIds: ['1:2'] });
    await waitFor(() => r.job(job.id).status === 'reading');
    expect((await r.admin.post(`/api/design-exports/${job.id}/cancel`)).json().status).toBe('cancelled');
    // Until the plugin has said it stopped, a new export is told to wait, so two exports never overlap in the plugin.
    const early = await r.admin.post('/api/design-exports', { scope: 'pages', pageIds: ['0:3'] });
    expect(early.statusCode).toBe(409);
    expect(early.json().message).toContain('đang dừng');
    release();
    await waitFor(() => r.figma.posted.some((m) => (m as { event?: { type?: string } }).event?.type === 'cancelled'), 10_000, 'plugin dừng đọc');
    const ended = r.job(job.id);
    expect(ended).toMatchObject({ status: 'cancelled', cancelRequested: true });
    // Whatever the plugin still had in flight is refused: the job accepts nothing now.
    const session = (r.service.hub as unknown as { session: never }).session;
    await expect(r.service.hub.ingest(session, { protocolVersion: 1, jobId: job.id, sourceSession: ended.source.sourceSession, scopeHash: ended.scopeHash, seq: ended.nextSeq, kind: 'nodes', byteLength: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', payload: '' })).rejects.toThrow(/hủy|không còn nhận/);
    await waitFor(() => !r.service.hub.isStopping(), 10_000, 'plugin báo đã dừng');
    r.figma.gate = undefined;
    const next = await r.finished((await r.exportAs({ scope: 'pages', pageIds: ['0:3'] })).id);
    expect(next.status, JSON.stringify([next.error, r.ui.status(), r.ui.detail(), r.trace.slice(-14)])).toBe('review_ready');
  }, 60000);

  it('stops at the limit it was given, builds a draft that says so, and refuses to publish it', async () => {
    const r = await start();
    const done = await r.finished((await r.exportAs({ scope: 'selection', rootIds: ['1:2'], limits: { maxNodes: 3 } })).id);
    expect(done.status).toBe('partial');
    expect(blockers(done)).toContain('limit_reached');
    const snap = r.service.snapshots.get(done.snapshotId!)!;
    expect((await publish(r, snap.id, { snapshotHash: snap.snapshotHash })).statusCode).toBe(409);
  }, 60000);

  it('sends a large file in several chunks within the two-chunk backpressure, and every stream hash agrees', async () => {
    const r = await start({ doc: golden({ extraNodes: 1800 }) });
    const done = await r.finished((await r.exportAs({ scope: 'selection', rootIds: ['1:2'] })).id, 90_000);
    expect(done.status, JSON.stringify(blockers(done))).toBe('review_ready');
    expect(done.nextSeq).toBeGreaterThan(5);
    expect(done.stats!.peakUnackedChunks).toBeLessThanOrEqual(2);
    expect(done.counts.nodes).toBe(1806);
    expect(r.fetches.filter((f) => f.path.endsWith('/chunk') && f.status === 200).length).toBe(done.nextSeq);
  }, 120000);

  it('closes an export whose plugin went quiet, and one that a restart interrupted', async () => {
    let now = 1_000_000;
    const r = await start({ now: () => now });
    let release!: () => void;
    r.figma.gate = new Promise<void>((resolve) => { release = resolve; });
    const job = await r.exportAs({ scope: 'selection', rootIds: ['1:2'] });
    await waitFor(() => r.job(job.id).status === 'reading');
    now += 31_000;
    r.service.hub.tick();
    expect(r.job(job.id)).toMatchObject({ status: 'interrupted', error: { code: 'lost_contact' } });
    release();
    // A job left active in the store by a server that died is closed on the next start.
    r.store.designJobs.put({ ...r.job(job.id), id: 'fej_00000000aaaa', status: 'reading', endedAt: undefined });
    expect(r.service.hub.recover()).toBe(1);
    expect(r.job('fej_00000000aaaa')).toMatchObject({ status: 'interrupted', error: { code: 'server_restarted' } });
  }, 60000);
});

describe("the plugin's doorway is narrow", () => {
  const host = { host: '127.0.0.1:14362' };

  it('needs a token for everything but pairing, answers only the opaque origin, and cannot reach the page API', async () => {
    const r = await start();
    expect((await r.app.inject({ method: 'POST', url: '/api/figma-exporter/poll', headers: host, payload: {} })).statusCode).toBe(401);
    expect((await r.app.inject({ method: 'POST', url: '/api/figma-exporter/poll', headers: { ...host, authorization: `Bearer ${'0'.repeat(64)}` }, payload: {} })).statusCode).toBe(401);
    expect((await r.app.inject({ method: 'POST', url: '/api/figma-exporter/poll', headers: { ...host, origin: 'https://evil.example' }, payload: {} })).statusCode).toBe(403);
    const pre = await r.app.inject({ method: 'OPTIONS', url: '/api/figma-exporter/chunk', headers: { ...host, origin: 'null', 'access-control-request-method': 'POST' } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('null');
    expect(String(pre.headers['access-control-allow-headers'])).toContain('authorization');
    expect(pre.headers['access-control-allow-private-network']).toBe('true');
    expect((await r.app.inject({ method: 'OPTIONS', url: '/api/figma-exporter/chunk', headers: { ...host, origin: 'https://evil.example' } })).statusCode).toBe(403);
    // The page's own API still wants its CSRF token, with or without anything the plugin holds.
    expect((await r.app.inject({ method: 'POST', url: '/api/design-exports', headers: host, payload: { scope: 'file' } })).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'POST', url: '/api/design-snapshots/dsn_aaaaaaaaaaaa/publish', headers: { ...host, authorization: `Bearer ${'a'.repeat(64)}`, origin: 'null' }, payload: {} })).statusCode).toBe(403);
    expect((await r.app.inject({ method: 'GET', url: '/api/design-snapshots', headers: { host: 'evil.example' } })).statusCode).toBe(403);
  }, 60000);

  it('burns a pairing code after five wrong tries, expires it, and replaces the live session when paired again', async () => {
    let now = 5_000_000;
    const r = await start({ now: () => now });
    const hello = r.service.hub.connectionState().hello!;
    const first = (r.service.hub as unknown as { session: { tokenHash: Buffer } }).session.tokenHash;
    const code = (await r.admin.post('/api/integrations/figma/pairing')).json().code as string;
    const wrong = code === '00000000' ? '11111111' : '00000000';
    const post = (c: string) => r.app.inject({ method: 'POST', url: '/api/figma-exporter/pair', headers: { ...host, origin: 'null' }, payload: { code: c, hello } });
    for (let i = 0; i < 4; i++) expect((await post(wrong)).statusCode).toBe(403);
    const fifth = await post(wrong);
    expect(fifth.statusCode).toBe(403);
    expect(fifth.json().message).toContain('hủy');
    expect((await post(code)).statusCode).toBe(403);
    // A fresh code works once, and only until it expires.
    const second = (await r.admin.post('/api/integrations/figma/pairing')).json().code as string;
    now += 5 * 60_000 + 1;
    expect((await post(second)).json().message).toContain('hết hạn');
    const third = (await r.admin.post('/api/integrations/figma/pairing')).json().code as string;
    const ok = await post(third);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().token).toMatch(/^[a-f0-9]{64}$/);
    expect((await post(third)).statusCode).toBe(403);
    expect((r.service.hub as unknown as { session: { tokenHash: Buffer } }).session.tokenHash.equals(first)).toBe(false);
    // The old session's token no longer opens anything.
    expect((await r.app.inject({ method: 'POST', url: '/api/figma-exporter/poll', headers: { ...host, authorization: `Bearer ${'f'.repeat(64)}` }, payload: {} })).statusCode).toBe(401);
  }, 60000);
});
