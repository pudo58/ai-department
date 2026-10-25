import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Delivery, Run } from '../src/shared/types.js';
import { buildApp } from '../src/server/app.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import { removability } from '../src/server/storage.js';
import { delivered } from '../src/core/delivery.js';
import { renderReportMarkdown } from '../src/core/report.js';
import { runStatus } from '../src/client/labels.js';
import { green, setupLegacy as setup } from './helpers.js';

const receipt = (run: Run, status: Delivery['status']): Delivery => ({
  kind: 'branch', target: `aidept/${run.id}-A`, status, checkpoint: run.checkpoint!,
  contractVersion: run.contract.version, slot: run.selectedSlot, startedAt: '2026-01-01T00:00:00Z',
});
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function api(env: ReturnType<typeof setup>, dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-delivery-'))) {
  app = await buildApp({ ...env, dataDir, port: 4310 });
  const headers = { host: '127.0.0.1:4310', 'x-csrf-token': '' };
  headers['x-csrf-token'] = (await app.inject({ method: 'GET', url: '/api/session', headers })).json<{ token: string }>().token;
  return {
    dataDir,
    post: (url: string, payload: object = {}) => app!.inject({ method: 'POST', url, headers, payload }),
    get: (url: string) => app!.inject({ method: 'GET', url, headers }),
  };
}

describe('durable acceptance and delivery', () => {
  it('enforces the missing-Verifier warning at the API boundary without calling another agent', async () => {
    const env = setup({ check: () => green, files: (e) => e.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'] });
    const run = await env.drive(env.create({ mode: 'verify', budgetUsd: 10 }));
    for (const artifact of env.store.artifacts.list(run.id).filter((a) => a.title === 'Verifier verdict' || a.kind === 'raw')) env.store.artifacts.put({ ...artifact, checkpoint: 'old' });
    const calls = env.runtime.calls.slice(); const a = await api(env);
    const report = (await a.get(`/api/runs/${run.id}/report`)).json();
    expect(report).toMatchObject({ verifier: { verdict: null }, warnings: expect.arrayContaining([{ level: 'warn', text: 'Bản code này chưa có kết luận Verifier.' }]) });
    expect((await a.post(`/api/runs/${run.id}/accept`)).statusCode).toBe(409);
    expect((await a.post(`/api/runs/${run.id}/accept`, { acknowledgeWarnings: true })).statusCode).toBe(200);
    expect(env.runtime.calls.filter((c) => !c.startsWith('deliver:'))).toEqual(calls);
  });

  it('rejects a second HTTP acceptance while the first request is delivering', async () => {
    const env = setup({ check: () => green }); const run = await env.drive(env.create()); const a = await api(env);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => { enter = r; }); const hold = new Promise<void>((r) => { release = r; });
    const original = env.runtime.deliver.bind(env.runtime);
    const delivery = vi.spyOn(env.runtime, 'deliver').mockImplementation(async (r, slot) => { enter(); await hold; return original(r, slot); });
    const first = a.post(`/api/runs/${run.id}/accept`).then((r) => r);
    await entered;
    expect((await a.post(`/api/runs/${run.id}/accept`)).statusCode).toBe(409);
    expect((await a.post(`/api/runs/${run.id}/contract`, run.contract)).statusCode).toBe(409);
    expect((await a.get(`/api/runs/${run.id}`)).json()).toMatchObject({ run: { status: 'awaiting_acceptance', delivery: { status: 'in_progress' } } });
    release(); expect((await first).statusCode).toBe(200); expect(delivery).toHaveBeenCalledTimes(1);
  });
  it('returns 409 on failure, retains the workspace, and retries only delivery before starting the seven-day window', async () => {
    const env = setup({ check: () => green });
    const run = await env.drive(env.create());
    const a = await api(env);
    const ws = path.join(a.dataDir, 'workspaces', `${run.id}-A`);
    mkdirSync(ws, { recursive: true }); writeFileSync(path.join(ws, 'result.txt'), 'keep');
    const calls = env.runtime.calls.slice();
    const delivery = vi.spyOn(env.runtime, 'deliver').mockRejectedValueOnce(new Error('TOKEN=top-secret delivery failed'));
    const failed = await a.post(`/api/runs/${run.id}/accept`);
    expect(failed.statusCode).toBe(409);
    const saved = env.store.runs.get(run.id)!;
    expect(saved).toMatchObject({ status: 'awaiting_acceptance', delivery: { status: 'failed', checkpoint: run.checkpoint, contractVersion: run.contract.version, slot: 'A' } });
    expect(saved.acceptedAt).toBeUndefined(); expect(saved.followupUntil).toBeUndefined();
    expect(JSON.stringify(saved.delivery)).not.toContain('top-secret');
    expect((await a.get(`/api/runs/${run.id}/report`)).json()).toMatchObject({ delivery: { delivered: false, status: 'failed', kind: 'branch' } });
    // Even changing the run to an old blocked task cannot bypass delivery protection.
    env.store.runs.put({ ...saved, status: 'blocked', updatedAt: '2020-01-01T00:00:00Z' });
    expect((await a.post('/api/system/cleanup', { runIds: [run.id] })).json()).toMatchObject({ removed: [], refused: [{ runId: run.id }] });
    expect(existsSync(ws)).toBe(true);
    env.store.runs.put(saved);
    expect((await a.post(`/api/runs/${run.id}/accept`)).statusCode).toBe(200);
    const done = env.store.runs.get(run.id)!;
    expect(done.status).toBe('completed'); expect(delivered(done)).toBe(true);
    expect(Date.parse(done.followupUntil!) - Date.parse(done.acceptedAt!)).toBe(7 * 86_400_000);
    expect(env.runtime.calls.filter((c) => !c.startsWith('deliver:'))).toEqual(calls);
    expect(delivery).toHaveBeenCalledTimes(2);
    expect((await a.post(`/api/runs/${run.id}/accept`)).statusCode).toBe(200);
    expect(delivery).toHaveBeenCalledTimes(2); // Repeated success is a read, not another write.
    expect((await a.post('/api/system/cleanup', { runIds: [run.id] })).json()).toMatchObject({ removed: [run.id], refused: [] });
  });

  it('locks before report I/O and blocks concurrent acceptance, edits, reruns, rejection and deletion during delivery', async () => {
    const env = setup({ check: () => green });
    const run = await env.drive(env.create());
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => { enter = r; });
    const hold = new Promise<void>((r) => { release = r; });
    const original = env.runtime.deliver.bind(env.runtime);
    vi.spyOn(env.runtime, 'deliver').mockImplementation(async (r, slot) => {
      expect(env.store.runs.get(r.id)?.delivery?.status).toBe('in_progress');
      enter(); await hold; return original(r, slot);
    });
    const pending = env.orchestrator.acceptRun(run.id);
    await expect(env.orchestrator.acceptRun(run.id)).rejects.toMatchObject({ status: 409 });
    expect(() => env.orchestrator.reviseContract(run.id, run.contract)).toThrow(/Đang giao/);
    await entered;
    for (const action of [
      () => env.orchestrator.startRun(run.id), () => env.orchestrator.resumeRun(run.id), () => env.orchestrator.stopRun(run.id),
      () => env.orchestrator.rejectAcceptance(run.id, 'no'), () => env.orchestrator.escalate(run.id, 'verify', 'more'),
      () => env.orchestrator.recheck(run.id), () => env.orchestrator.repairFindings(run.id),
      () => env.orchestrator.quarantineCheck(run.id, 'missing', 'reason'), () => env.orchestrator.confirmFinding(run.id, 'missing'),
      () => env.orchestrator.approvePaths(run.id, ['worker']), () => env.orchestrator.addHumanMinutes(run.id, 'review', 1),
      () => env.orchestrator.deleteRun(run.id), () => env.orchestrator.deleteProject(run.projectId),
    ]) expect(action).toThrow();
    expect(removability(env.store.runs.get(run.id), Date.now()).removable).toBe(false);
    release(); expect((await pending).delivery?.status).toBe('succeeded');
  });

  it('recovers a persisted in-progress delivery as unknown after a database reopen, and retries without agents or checks', async () => {
    const env = setup({ check: () => green });
    const run = await env.drive(env.create());
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-restart-'));
    const file = path.join(dataDir, 'store.db');
    const disk = new Store(file);
    disk.projects.put(env.store.projects.get(run.projectId)!);
    disk.runs.put({ ...run, delivery: receipt(run, 'in_progress') });
    for (const key of ['attempts', 'checks', 'artifacts', 'findings'] as const) for (const row of env.store[key].list(run.id)) disk[key].put(row as never);
    disk.db.close();
    const reopened = new Store(file);
    try {
      const orchestrator = new Orchestrator(reopened, () => env.runtime);
      const calls = env.runtime.calls.slice();
      await orchestrator.recover();
      expect(reopened.runs.get(run.id)).toMatchObject({ status: 'awaiting_acceptance', delivery: { status: 'unknown' } });
      expect(removability(reopened.runs.get(run.id), Date.now() + 30 * 86_400_000).removable).toBe(false);
      const r = await orchestrator.report(run.id);
      expect(r.delivery).toMatchObject({ delivered: false, status: 'unknown' });
      expect((await orchestrator.acceptRun(run.id)).delivery?.status).toBe('succeeded');
      expect(env.runtime.calls.filter((c) => !c.startsWith('deliver:'))).toEqual(calls);
    } finally { reopened.db.close(); }
  });

  it('preserves legacy acceptance history without inferring delivery from completed or an old deliver event', async () => {
    const env = setup({ check: () => green });
    const run = await env.drive(env.create());
    const legacy = { ...run, status: 'completed' as const, acceptedAt: '2020-01-01T00:00:00Z', followupUntil: '2020-01-08T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' };
    env.store.runs.put(legacy); env.store.addEvent(run.id, 'deliver', 'Historical event, without a versioned receipt');
    await env.orchestrator.recover();
    expect(env.store.runs.get(run.id)?.acceptedAt).toBe(legacy.acceptedAt);
    expect(removability(legacy, Date.now()).removable).toBe(false);
    const a = await api(env);
    expect((await a.post('/api/system/cleanup', { runIds: [run.id] })).json()).toMatchObject({ removed: [], refused: [{ runId: run.id }] });
    const r = await env.orchestrator.report(run.id);
    expect(r.delivery).toMatchObject({ delivered: false, status: 'unconfirmed' });
    expect(renderReportMarkdown(r)).toContain('chưa xác nhận giao thành công');
    expect(runStatus(env.store.runSummaries()[0]!).label).toBe('Chưa xác nhận giao');
    await expect(env.orchestrator.acceptRun(run.id)).rejects.toThrow(/cảnh báo/);
    expect((await env.orchestrator.acceptRun(run.id, { acknowledgeWarnings: true })).delivery?.status).toBe('succeeded');
  });

  it.each(['failed', 'unknown', 'in_progress'] as const)('retains an old workspace with %s delivery regardless of task status', (status) => {
    const env = setup(); const run = { ...env.create(), checkpoint: 'cp' };
    for (const taskStatus of ['completed', 'blocked', 'failed', 'paused'] as const) {
      expect(removability({ ...run, status: taskStatus, delivery: receipt(run, status), updatedAt: '2020-01-01' }, Date.now()).removable).toBe(false);
    }
  });

  it.each(['checkpoint', 'contractVersion', 'slot'] as const)('rejects a succeeded receipt for a different %s', (field) => {
    const env = setup(); const run = { ...env.create(), checkpoint: 'cp', status: 'completed' as const };
    const wrong = { ...receipt(run, 'succeeded'), [field]: field === 'contractVersion' ? 99 : field === 'slot' ? 'B' : 'other' } as Delivery;
    expect(delivered({ ...run, delivery: wrong })).toBe(false);
    expect(removability({ ...run, delivery: wrong }, Date.now()).removable).toBe(false);
  });

  it('keeps a missing delivery implementation as a visible failure', async () => {
    const env = setup({ check: () => green }); const run = await env.drive(env.create());
    Object.defineProperty(env.runtime, 'deliver', { value: undefined });
    await expect(env.orchestrator.acceptRun(run.id)).rejects.toMatchObject({ status: 409 });
    expect(env.store.runs.get(run.id)).toMatchObject({ status: 'awaiting_acceptance', delivery: { status: 'failed' } });
  });
});
