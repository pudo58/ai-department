import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildMonitor } from '../src/core/monitor.js';
import { findWaste } from '../src/core/waste.js';
import { resolveCodexModel } from '../src/runtime/codexmodel.js';
import { buildApp } from '../src/server/app.js';
import { removability, StorageMonitor } from '../src/server/storage.js';
import type { Attempt, Role, Run, UsageRecord } from '../src/shared/types.js';
import { profile, setup } from './helpers.js';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const H = 3_600_000;
const activity = { providers: [], stages: { setup: false, check: false } };

let seq = 0;
function makeRun(over: Partial<Run> = {}): Run {
  const { create } = setup();
  const run = create();
  return { ...run, id: `run_${++seq}`, updatedAt: iso(-H), ...over };
}
function att(run: Run, role: Role, offsetMs: number, over: Partial<Attempt> = {}, tokens = 1_000_000): { a: Attempt; u: UsageRecord } {
  const a: Attempt = { id: `att_${++seq}`, runId: run.id, slot: 'A', role, stage: role === 'verifier' ? 'verify' : 'implement', provider: 'codex', model: 'gpt-6.1-sol', status: 'completed', startedAt: iso(offsetMs), endedAt: iso(offsetMs + 60_000), checkpoint: 'cp1', contractVersion: 1, ...over };
  const u: UsageRecord = { id: `use_${seq}`, attemptId: a.id, inputTokens: tokens, cachedTokens: tokens / 2, outputTokens: 1000, costUsd: null, source: 'estimated', createdAt: iso(offsetMs + 60_000) };
  return { a, u };
}

describe('waste: spending that bought nothing new', () => {
  it('counts reviewer passes after the first on the same checkpoint and contract, not the first or a new checkpoint', () => {
    const run = makeRun({ title: 'Sổ chi tiêu' });
    const parts = [att(run, 'developer', -5 * H), att(run, 'verifier', -4 * H), att(run, 'verifier', -3 * H), att(run, 'verifier', -2 * H), att(run, 'verifier', -H, { checkpoint: 'cp2' })];
    run.usage = parts.map((p) => p.u);
    const report = findWaste([run], parts.map((p) => p.a), NOW - 24 * H, NOW);
    const repeat = report.items.find((i) => i.kind === 'repeat-review')!;
    expect(repeat.count).toBe(2);
    expect(repeat.detail).toMatch(/3 lần trên cùng checkpoint cp1/);
    expect(repeat.costUsd).toBeCloseTo(report.items.filter((i) => i.kind === 'repeat-review').reduce((s, i) => s + i.costUsd, 0));
    expect(repeat.costUsd).toBeGreaterThan(0);
    expect(report.costUsd).toBeCloseTo(repeat.costUsd);
  });

  it('separates provider errors from other failures and flags tasks waiting on a person for over a day', () => {
    const run = makeRun();
    const busy = att(run, 'verifier', -H, { status: 'failed', error: 'Selected model is at capacity. Please try a different model.' }, 0);
    const crash = att(run, 'developer', -2 * H, { status: 'interrupted', error: 'Execution interrupted' }, 0);
    const stuck = makeRun({ status: 'awaiting_acceptance', updatedAt: iso(-50 * H), title: 'Cũ' });
    const fresh = makeRun({ status: 'blocked', updatedAt: iso(-2 * H) });
    const report = findWaste([run, stuck, fresh], [busy.a, crash.a], NOW - 24 * H, NOW);
    expect(report.items.find((i) => i.kind === 'provider-error')?.count).toBe(1);
    expect(report.items.find((i) => i.kind === 'failed')?.count).toBe(1);
    const stale = report.items.filter((i) => i.kind === 'stuck');
    expect(stale.map((i) => i.runId)).toEqual([stuck.id]);
    expect(stale[0]!.detail).toMatch(/2 ngày/);
  });
});

describe('monitor: where the money went, what changed, what waits for you', () => {
  it('splits cost by task, role and project, compares with the same span a period earlier, and lists waiting work', () => {
    const big = makeRun({ title: 'Sổ chi tiêu', projectId: 'prj_a', status: 'completed', acceptedAt: iso(-H) });
    const small = makeRun({ title: 'Nhỏ', projectId: 'prj_b', status: 'awaiting_approval' });
    const bigParts = [att(big, 'developer', -6 * H), att(big, 'verifier', -5 * H), att(big, 'verifier', -4 * H)];
    const smallParts = [att(small, 'planner', -3 * H, {}, 100_000)];
    const yesterday = att(small, 'planner', -25 * H, {}, 100_000); // 13:00 yesterday counts for "previous"
    big.usage = bigParts.map((p) => p.u);
    small.usage = [...smallParts, yesterday].map((p) => p.u);
    const attempts = [...bigParts, ...smallParts, yesterday].map((p) => p.a);
    const projects = [profile({ id: 'prj_a', name: 'Quản lý tài chính' }), profile({ id: 'prj_b', name: 'CV', approved: false, version: 3 })];
    const data = buildMonitor({ runs: [big, small], attempts, now: NOW, period: '24h', errorsLastHour: 0, activity, projects });

    expect(data.byTask[0]).toMatchObject({ runId: big.id, label: 'Sổ chi tiêu', requests: 3, accepted: true });
    expect(data.byTask[0]!.costUsd).toBeGreaterThan(data.byTask[1]!.costUsd);
    expect(data.byRole.map((r) => r.key)).toEqual(['verifier', 'developer', 'planner']);
    expect(data.byRole[0]).toMatchObject({ label: 'Verifier', requests: 2 });
    expect(data.byProject.map((p) => p.label)).toEqual(['Quản lý tài chính', 'CV']);
    expect(data.previous.requests).toBe(1);
    expect(data.previous.inputTokens).toBe(100_000);
    expect(data.cacheRate).toBeCloseTo(0.5);
    expect(data.acceptedInPeriod).toBe(1);
    expect(data.costPerAccepted).toBeCloseTo(big.usage.reduce((s, u) => s + (u.inputTokens - u.cachedTokens) * 3e-6 + u.cachedTokens * 3e-7 + u.outputTokens * 15e-6, 0));
    expect(data.series.some((b) => (b.costByRole.verifier ?? 0) > 0)).toBe(true);
    expect(data.waste.items.some((i) => i.kind === 'repeat-review' && i.runId === big.id)).toBe(true);
    expect(data.waiting.map((w) => w.kind)).toEqual(['approve-contract', 'approve-policy']);
    expect(data.waiting[1]).toMatchObject({ projectId: 'prj_b', title: 'CV' });
  });

  it('shows running tasks with their role, budget share and latest console line, and passes alerts through', () => {
    const run = makeRun({ status: 'running', stage: 'verify', budgetUsd: 10 });
    const done = att(run, 'developer', -2 * H);
    const live = att(run, 'verifier', -60_000, { status: 'running', endedAt: undefined });
    run.usage = [done.u];
    const data = buildMonitor({ runs: [run], attempts: [done.a, live.a], now: NOW, period: 'today', errorsLastHour: 0, activity, lastLogByRun: { [run.id]: 'check:e2e 51 passed' }, alerts: [{ level: 'warn', text: 'Ổ C còn 3 GB' }] });
    expect(data.live[0]).toMatchObject({ id: run.id, role: 'verifier', lastLog: 'check:e2e 51 passed' });
    expect(data.live[0]!.budgetPct).toBeGreaterThan(0);
    expect(data.alerts).toEqual([{ level: 'warn', text: 'Ổ C còn 3 GB' }]);
  });
});

describe('real model names from Codex session logs', () => {
  it('reads the model of a session from $CODEX_HOME/sessions, and returns nothing when the log is missing', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'aidept-codexhome-'));
    const day = new Date('2026-10-21T12:49:32');
    const dir = path.join(home, 'sessions', '2026', '10', '21');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'rollout-2026-10-21T12-49-32-01a15d01-f2cb-7283-81c7-55603756f76d.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: 'x' } })}\n${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'medium' } })}\n`);
    expect(await resolveCodexModel('01a15d01-f2cb-7283-81c7-55603756f76d', day.toISOString(), home)).toBe('gpt-6.1-sol');
    expect(await resolveCodexModel('01a15d01-0000-0000-0000-000000000000', day.toISOString(), home)).toBeUndefined();
    expect(await resolveCodexModel('../../etc/passwd', day.toISOString(), home)).toBeUndefined();
  });
});

describe('storage and cleanup', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('decides what may be removed: accepted, idle a week, or orphaned; never running or awaiting acceptance', () => {
    const now = NOW;
    expect(removability(undefined, now).removable).toBe(true);
    expect(removability(makeRun({ status: 'completed' }), now).removable).toBe(true);
    expect(removability(makeRun({ status: 'running' }), now).removable).toBe(false);
    expect(removability(makeRun({ status: 'awaiting_acceptance', updatedAt: iso(-30 * 24 * H) }), now).removable).toBe(false);
    expect(removability(makeRun({ status: 'blocked', updatedAt: iso(-8 * 24 * H) }), now).removable).toBe(true);
    expect(removability(makeRun({ status: 'blocked', updatedAt: iso(-2 * 24 * H) }), now).removable).toBe(false);
  });

  it('measures working copies per run and removes only eligible ones through the API, with CSRF', async () => {
    const env = setup();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-storage-'));
    const done = env.create(); env.store.runs.put({ ...done, status: 'completed' });
    const busy = env.create(); env.store.runs.put({ ...busy, status: 'awaiting_acceptance' });
    for (const [id, size] of [[done.id, 2000], [busy.id, 500], ['run_orphan', 100]] as const) {
      mkdirSync(path.join(dataDir, 'workspaces', `${id}-A`, 'src'), { recursive: true });
      writeFileSync(path.join(dataDir, 'workspaces', `${id}-A`, 'src', 'f.txt'), 'x'.repeat(size));
    }
    const monitor = new StorageMonitor(dataDir, () => env.store.runs.list());
    await monitor.get();
    const report = await monitor.settle();
    expect(report.workspaces.map((w) => [w.runId, w.sizeBytes, w.removable])).toEqual([[done.id, 2000, true], [busy.id, 500, false], ['run_orphan', 100, true]]);
    expect(report.totalBytes).toBe(2600);
    expect(report.disk?.freeBytes).toBeGreaterThan(0);

    app = await buildApp({ ...env, dataDir, port: 4310 });
    const host = { host: '127.0.0.1:4310' };
    const token = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json<{ token: string }>().token;
    expect((await app.inject({ method: 'POST', url: '/api/system/cleanup', payload: { runIds: [done.id] }, headers: host })).statusCode).toBe(403);
    const res = (await app.inject({ method: 'POST', url: '/api/system/cleanup', payload: { runIds: [done.id, busy.id, 'run_orphan'] }, headers: { ...host, 'x-csrf-token': token } })).json<{ removed: string[]; refused: { runId: string }[] }>();
    expect(res.removed.sort()).toEqual([done.id, 'run_orphan'].sort());
    expect(res.refused.map((r) => r.runId)).toEqual([busy.id]);
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(dataDir, 'workspaces', `${done.id}-A`))).toBe(false);
    expect(existsSync(path.join(dataDir, 'workspaces', `${busy.id}-A`))).toBe(true);
    const monitorRes = (await app.inject({ method: 'GET', url: '/api/monitor?period=today', headers: host })).json<{ byTask: unknown[]; waiting: { kind: string }[]; waste: { items: unknown[] }; alerts: unknown[] }>();
    expect(monitorRes.waiting.some((w) => w.kind === 'accept')).toBe(true);
    expect(Array.isArray(monitorRes.byTask) && Array.isArray(monitorRes.waste.items) && Array.isArray(monitorRes.alerts)).toBe(true);
  });
});
