import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExporterHub, type PluginSession } from '../src/server/figma/exporter.js';
import { SnapshotStore } from '../src/server/figma/snapshots.js';
import { Store } from '../src/server/store.js';
import { CHUNK_MAX_BYTES, type ChunkEnvelope, type FinishBody, type HelloInfo } from '../src/shared/figma.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const hello = (over: Partial<HelloInfo> = {}): HelloInfo => ({
  protocolVersion: 1, readerVersion: 1, pluginVersion: '1.0.0', editorType: 'figma', apiVersion: '1.0.0', fileName: 'F', fileKey: 'FILEKEY1234567',
  pages: [{ id: '0:1', name: 'P', childCount: 1 }], selection: [], currentPageId: '0:1', sourceSession: 'sourcesession0123456789', ...over,
});

/** The server's half alone: no plugin, so each message can be made as wrong as a test needs. */
function hub(options: { now?: () => number } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-transport-'));
  dirs.push(dataDir);
  const store = new Store(':memory:');
  const snapshots = new SnapshotStore(dataDir, store);
  const h = new ExporterHub({ dataDir, store, snapshots, pollMs: 10, ...options });
  const code = h.createPairingCode().code;
  const paired = h.pair({ code, hello: hello() });
  const session = h.authenticate(`Bearer ${paired.token}`);
  const job = h.createExport({ scope: 'selection', rootIds: ['1:1'] });
  const envelope = (seq: number, kind: ChunkEnvelope['kind'], bytes: Uint8Array | string, extra: Partial<ChunkEnvelope> = {}): ChunkEnvelope => {
    const buf = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
    return { protocolVersion: 1, jobId: job.id, sourceSession: job.source.sourceSession, scopeHash: job.scopeHash, seq, kind, byteLength: buf.length, sha256: sha(buf), payload: buf.toString('base64'), ...extra };
  };
  return { dataDir, store, hub: h, session, job, envelope, snapshots, staging: (file: string) => path.join(dataDir, 'design-staging', job.id, file) };
}
type Rig = ReturnType<typeof hub>;
/** Cancels a job and plays the plugin confirming it stopped, so the next export may start. */
const stop = (t: { hub: ExporterHub; session: PluginSession }, jobId: string) => { t.hub.cancel(jobId); t.hub.event(t.session, { type: 'cancelled', jobId }); };
const refused = async (promise: Promise<unknown>, status: number, text?: RegExp) => {
  const error = await promise.then(() => undefined, (e) => e as { status?: number; message: string });
  expect(error, 'phải bị từ chối').toBeDefined();
  expect(error!.status).toBe(status);
  if (text) expect(error!.message).toMatch(text);
};

describe('a chunk is stored before it is acknowledged, and only the right chunk is stored', () => {
  it('acknowledges in order, treats the same chunk again as a no-op, and refuses the same sequence with other bytes', async () => {
    const t = hub();
    expect(await t.hub.ingest(t.session, t.envelope(0, 'nodes', '{"a":1}\n'))).toEqual({ ack: 0, duplicate: false });
    expect(await t.hub.ingest(t.session, t.envelope(0, 'nodes', '{"a":1}\n'))).toEqual({ ack: 0, duplicate: true });
    expect(t.hub.getJob(t.job.id).nextSeq).toBe(1);
    expect(readFileSync(t.staging('nodes.ndjson'), 'utf8')).toBe('{"a":1}\n');
    await refused(t.hub.ingest(t.session, t.envelope(0, 'nodes', '{"a":2}\n')), 409, /nội dung khác/);
    await refused(t.hub.ingest(t.session, t.envelope(0, 'inventory', '{"a":1}\n')), 409);
    expect(readFileSync(t.staging('nodes.ndjson'), 'utf8')).toBe('{"a":1}\n');
  });

  it('refuses a gap, a wrong hash, a wrong length, text that is not base64, and a chunk that is too big', async () => {
    const t = hub();
    await refused(t.hub.ingest(t.session, t.envelope(1, 'nodes', 'x\n')), 409, /Thiếu chunk/);
    await refused(t.hub.ingest(t.session, { ...t.envelope(0, 'nodes', 'x\n'), sha256: sha('khac') }), 400, /Hash/);
    await refused(t.hub.ingest(t.session, { ...t.envelope(0, 'nodes', 'x\n'), byteLength: 5 }), 400, /byteLength/);
    await refused(t.hub.ingest(t.session, { ...t.envelope(0, 'nodes', 'x\n'), payload: 'không phải base64!' }), 400, /base64/);
    await refused(t.hub.ingest(t.session, { ...t.envelope(0, 'nodes', 'x\n'), byteLength: CHUNK_MAX_BYTES + 1 }), 413);
    expect(existsSync(t.staging('nodes.ndjson'))).toBe(false);
    expect(t.hub.getJob(t.job.id).nextSeq).toBe(0);
  });

  it('refuses data from another source session, another scope, or another protocol', async () => {
    const t = hub();
    await refused(t.hub.ingest(t.session, { ...t.envelope(0, 'nodes', 'x\n'), sourceSession: 'khac' }), 409, /phiên nguồn/);
    await refused(t.hub.ingest(t.session, { ...t.envelope(0, 'nodes', 'x\n'), scopeHash: 'f'.repeat(64) }), 409, /Phạm vi/);
    await refused(t.hub.ingest(t.session, { ...t.envelope(0, 'nodes', 'x\n'), protocolVersion: 2 }), 409, /giao thức/);
    await refused(t.hub.ingest(t.session, { ...t.envelope(0, 'nodes', 'x\n'), jobId: 'fej_deadbeef0000' }), 404);
  });

  it('keeps arrival order when several chunks arrive at once, and a record split in the middle of a character is whole again', async () => {
    const t = hub();
    const line = Buffer.from(`${JSON.stringify({ ten: 'Đăng nhập 日本 🎨' })}\n`);
    const cut = line.indexOf(Buffer.from('Đ')) + 1;
    await Promise.all([t.hub.ingest(t.session, t.envelope(0, 'nodes', line.subarray(0, cut))), t.hub.ingest(t.session, t.envelope(1, 'nodes', line.subarray(cut)))]);
    const stored = readFileSync(t.staging('nodes.ndjson'));
    expect(stored.equals(line)).toBe(true);
    expect(JSON.parse(stored.toString('utf8'))).toEqual({ ten: 'Đăng nhập 日本 🎨' });
    expect(t.hub.getJob(t.job.id).nextSeq).toBe(2);
  });

  it('stops a job that goes over its byte limit, and refuses a replaced session', async () => {
    const t = hub();
    const small = t.hub.cancel(t.job.id);
    expect(small.status).toBe('cancelled');
    // Until the plugin says it stopped, nothing new may start.
    expect(() => t.hub.createExport({ scope: 'file' })).toThrow(/đang dừng/);
    const u = hub();
    stop(u, u.job.id);
    const small2 = u.hub.createExport({ scope: 'selection', rootIds: ['1:1'], limits: { maxBytes: 10 } });
    const e = { ...u.envelope(0, 'nodes', 'x'.repeat(20)), jobId: small2.id, sourceSession: small2.source.sourceSession, scopeHash: small2.scopeHash };
    await refused(u.hub.ingest(u.session, e), 413);
    u.hub.disconnect();
    expect(() => u.hub.authenticate('Bearer ' + 'a'.repeat(64))).toThrow();
  });

  it('refuses a byte limit overflow with 413 when the job is live', async () => {
    const t = hub();
    stop(t, t.job.id);
    const job = t.hub.createExport({ scope: 'selection', rootIds: ['1:1'], limits: { maxBytes: 10 } });
    const big = Buffer.from('x'.repeat(20));
    await refused(t.hub.ingest(t.session, { protocolVersion: 1, jobId: job.id, sourceSession: job.source.sourceSession, scopeHash: job.scopeHash, seq: 0, kind: 'nodes', byteLength: 20, sha256: sha(big), payload: big.toString('base64') }), 413, /giới hạn/);
  });
});

describe('an asset arrives in pieces and is accepted only if it is what its name says', () => {
  const asset = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7) & 255));
  const id = sha(asset);

  it('assembles pieces by offset and keeps the file only when the content hash matches the id', async () => {
    const t = hub();
    await t.hub.ingest(t.session, t.envelope(0, 'asset', asset.subarray(0, 400), { assetId: id, offset: 0 }));
    await refused(t.hub.ingest(t.session, t.envelope(1, 'asset', asset.subarray(500), { assetId: id, offset: 500, final: true })), 409, /offset/);
    await t.hub.ingest(t.session, t.envelope(1, 'asset', asset.subarray(400), { assetId: id, offset: 400, final: true }));
    const stored = readFileSync(path.join(t.staging('assets'), id));
    expect(stored.equals(asset)).toBe(true);
    expect(existsSync(path.join(t.staging('assets'), `${id}.part`))).toBe(false);
    await refused(t.hub.ingest(t.session, t.envelope(2, 'asset', Buffer.from('thêm'), { assetId: id, offset: 1000 })), 409, /hoàn tất/);
  });

  it('refuses a final piece whose whole does not hash to the id, and an asset over its size limit', async () => {
    const t = hub();
    await refused(t.hub.ingest(t.session, t.envelope(0, 'asset', asset, { assetId: 'a'.repeat(64), offset: 0, final: true })), 409, /hash nội dung/);
    const u = hub();
    stop(u, u.job.id);
    const job = u.hub.createExport({ scope: 'selection', rootIds: ['1:1'], limits: { maxAssetBytes: 100 } });
    await refused(u.hub.ingest(u.session, { ...u.envelope(0, 'asset', asset, { assetId: id, offset: 0, final: true }), jobId: job.id, sourceSession: job.source.sourceSession, scopeHash: job.scopeHash }), 413);
    await refused(t.hub.ingest(t.session, t.envelope(0, 'asset', asset.subarray(0, 10), { offset: 0 })), 400, /mã nội dung/);
  });
});

describe('finishing is a claim that is checked against what was received', () => {
  const body = (t: Rig, over: Partial<FinishBody> = {}): FinishBody => ({
    protocolVersion: 1, jobId: t.job.id, sourceSession: t.job.source.sourceSession, scopeHash: t.job.scopeHash, lastSeq: -1,
    streams: Object.fromEntries(['inventory', 'nodes', 'dependencies', 'verification'].map((k) => [k, { bytes: 0, sha256: sha(''), records: 0 }])) as never,
    assets: [], totals: { nodes: 0, pages: 0, dependencies: 0, assets: 0 },
    verification: { passes: 2, sourceChanged: false, changedIds: [], documentChanges: 0, watchedDocumentChanges: false }, stats: { peakUnackedChunks: 1, durationMs: 1, restoredSkipInvisible: true }, errors: [], ...over,
  });

  it('refuses a finish that names the wrong last chunk, another job source, or an asset not fully received', async () => {
    const t = hub();
    await t.hub.ingest(t.session, t.envelope(0, 'nodes', '{}\n'));
    await refused(t.hub.finish(t.session, body(t, { lastSeq: 5 })), 409, /Thiếu chunk/);
    await refused(t.hub.finish(t.session, body(t, { lastSeq: 0, sourceSession: 'khac' })), 409, /không khớp/);
    const id = 'c'.repeat(64);
    await t.hub.ingest(t.session, t.envelope(1, 'asset', Buffer.from('xx'), { assetId: id, offset: 0 }));
    await refused(t.hub.finish(t.session, body(t, { lastSeq: 1 })), 409, /chưa nhận đủ/);
  });

  it('ends partial, with a blocker, when the plugin\'s stream summary is not what the server measured; and closes the lock', async () => {
    const t = hub();
    const record = { k: 'node', id: '1:1', type: 'FRAME', name: 'n', pageId: 'P', parentId: null, index: 0, depth: 0, childIds: [], groups: { common: 'read' }, fields: {}, hash: 'khong-dung' };
    await t.hub.ingest(t.session, t.envelope(0, 'nodes', `${JSON.stringify(record)}\n`));
    const { job, snapshot } = await t.hub.finish(t.session, body(t, { lastSeq: 0 }));
    expect(job.status).toBe('partial');
    expect(job.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['stream_mismatch', 'node_hash_mismatch']));
    expect(job.issues.filter((i) => i.severity === 'blocker').length).toBeGreaterThan(1);
    expect(snapshot!.status).toBe('draft');
    // The lock is released: another export may start.
    expect(t.hub.createExport({ scope: 'file' }).status).toBe('queued');
  });

  it('ends with no draft at all when the records are not even the right shape, and names why', async () => {
    const t = hub();
    await t.hub.ingest(t.session, t.envelope(0, 'nodes', '{"id":"x"}\n'));
    const { job, snapshot } = await t.hub.finish(t.session, body(t, { lastSeq: 0 }));
    expect(snapshot).toBeUndefined();
    expect(job).toMatchObject({ status: 'failed', error: { code: 'invalid_records' } });
    expect(job.issues.some((i) => i.code === 'node_malformed')).toBe(true);
    expect(t.hub.createExport({ scope: 'file' }).status).toBe('queued');
  });

  it('closes a job with no usable draft when what it received cannot be read at all', async () => {
    const t = hub();
    await t.hub.ingest(t.session, t.envelope(0, 'nodes', 'đây không phải JSON\n'));
    await refused(t.hub.finish(t.session, body(t, { lastSeq: 0 })), 500);
    expect(t.hub.getJob(t.job.id)).toMatchObject({ status: 'failed', error: { code: 'finalize_failed' } });
  });
});

describe('what is kept and what is cleaned', () => {
  it('removes the staging of ended jobs after a week and never touches a snapshot or a live job', async () => {
    let now = 10_000_000_000;
    const t = hub({ now: () => now });
    await t.hub.ingest(t.session, t.envelope(0, 'nodes', '{}\n'));
    const live = t.job.id;
    expect(t.hub.cleanStaging()).toEqual([]);
    t.hub.cancel(live);
    expect(t.hub.cleanStaging()).toEqual([]);
    now += 8 * 86_400_000;
    expect(t.hub.cleanStaging()).toEqual([live]);
    expect(existsSync(t.staging('nodes.ndjson'))).toBe(false);
    const snapRoot = path.join(t.dataDir, 'design-snapshots', 'dsn_aaaaaaaaaaaa');
    mkdirSync(snapRoot, { recursive: true }); writeFileSync(path.join(snapRoot, 'x'), '1'); utimesSync(snapRoot, 1, 1);
    expect(t.hub.cleanStaging()).toEqual([]);
    expect(existsSync(snapRoot)).toBe(true);
  });

  it('lets a job be deleted only when it has ended', () => {
    const t = hub();
    expect(() => t.hub.deleteJob(t.job.id)).toThrow(/đang chạy/);
    t.hub.cancel(t.job.id);
    t.hub.deleteJob(t.job.id);
    expect(() => t.hub.getJob(t.job.id)).toThrow(/không tồn tại/);
  });

  it('answers a poll with each command once, and nothing after the session is replaced', async () => {
    const t = hub();
    const first = await t.hub.poll(t.session, 0);
    expect(first.map((c) => c.type)).toEqual(['START_EXPORT']);
    expect(await t.hub.poll(t.session, 0)).toEqual([]);
    t.hub.disconnect();
    await expect(t.hub.poll(t.session as PluginSession, 0)).rejects.toThrow();
  });
});
