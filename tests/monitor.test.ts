import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describeProviderLine } from '../src/runtime/describe.js';
import { LocalRuntime } from '../src/runtime/local.js';
import { lineSplitter } from '../src/runtime/process.js';
import type { RuntimeEvent } from '../src/runtime/types.js';
import { FakeRuntime } from '../src/runtime/fake.js';
import { buildApp } from '../src/server/app.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { eventLevel, matchesLog, Store } from '../src/server/store.js';
import { green, profile, setup } from './helpers.js';

describe('log store', () => {
  const add = (store: Store, over: Partial<Parameters<Store['logs']['append']>[0]> = {}) =>
    store.logs.append({ runId: 'r1', source: 'run', level: 'info', message: 'hello', ...over });

  it('returns the newest N oldest-first, and everything after an id in order', () => {
    const store = new Store(':memory:');
    for (let i = 1; i <= 10; i++) add(store, { message: `m${i}` });
    expect(store.logs.list({ limit: 3 }).map((e) => e.message)).toEqual(['m8', 'm9', 'm10']);
    expect(store.logs.list({ after: 7 }).map((e) => e.message)).toEqual(['m8', 'm9', 'm10']);
    expect(store.logs.list({ after: 10 })).toEqual([]);
  });

  it('filters by run, source prefix, minimum level and text, treating % and _ literally', () => {
    const store = new Store(':memory:');
    add(store, { source: 'agent:developer', message: 'writing file' });
    add(store, { source: 'check:test', level: 'error', message: '100% failed_test' });
    add(store, { runId: 'r2', source: 'setup', level: 'warn', message: 'npm warn deprecated' });
    expect(store.logs.list({ runId: 'r2' })).toHaveLength(1);
    expect(store.logs.list({ source: 'agent' }).map((e) => e.source)).toEqual(['agent:developer']);
    expect(store.logs.list({ minLevel: 'warn' })).toHaveLength(2);
    expect(store.logs.list({ minLevel: 'error' })).toHaveLength(1);
    expect(store.logs.list({ q: '100%' })).toHaveLength(1);
    expect(store.logs.list({ q: '%' })).toHaveLength(1);
    expect(store.logs.list({ q: 'x_t' })).toHaveLength(0);
    expect(store.logs.list({ q: "'; DROP TABLE logs; --" })).toEqual([]);
    expect(store.logs.list({})).toHaveLength(3);
  });

  it('redacts secrets and caps line length before storing', () => {
    const store = new Store(':memory:');
    const saved = add(store, { message: `key sk-ant-${'a'.repeat(30)} ${'x'.repeat(9000)}` });
    expect(saved.message).not.toContain('sk-ant');
    expect(saved.message.length).toBeLessThanOrEqual(4000);
  });

  it('timeline events become console lines with a severity', () => {
    const store = new Store(':memory:');
    store.addEvent('r1', 'run.failed', 'boom');
    store.addEvent('r1', 'patch.empty', 'nothing');
    store.addEvent('r1', 'attempt.start', 'go');
    expect(store.logs.list({}).map((e) => e.level)).toEqual(['error', 'warn', 'info']);
    expect(eventLevel('scope.rejected')).toBe('warn');
    expect(store.logs.countSince('2000-01-01', 'error')).toBe(1);
  });

  it('notifies live subscribers and survives one that throws', () => {
    const store = new Store(':memory:');
    const seen: string[] = [];
    store.logs.subscribe(() => { throw new Error('bad subscriber'); });
    const off = store.logs.subscribe((e) => seen.push(e.message));
    add(store, { message: 'a' }); off(); add(store, { message: 'b' });
    expect(seen).toEqual(['a']);
  });

  it('matchesLog mirrors the SQL filters for the live stream', () => {
    const e = { id: 1, ts: '', runId: 'r1', source: 'agent:developer', level: 'warn' as const, message: 'Hello World' };
    expect(matchesLog(e, { source: 'agent', minLevel: 'warn', q: 'hello', runId: 'r1' })).toBe(true);
    expect(matchesLog(e, { source: 'agents' })).toBe(false);
    expect(matchesLog(e, { minLevel: 'error' })).toBe(false);
  });
});

describe('readable agent lines', () => {
  it('describes Codex commands with their outcome, messages and file changes; drops noise', () => {
    expect(describeProviderLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Đã sửa\nxong' } }))).toEqual({ level: 'info', text: 'Agent: Đã sửa xong' });
    const failed = describeProviderLine(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test', status: 'failed', exit_code: 1, aggregated_output: 'boom' } }))!;
    expect(failed.level).toBe('warn');
    expect(failed.text).toBe('$ npm test → failed (exit 1) | boom');
    expect(describeProviderLine(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }))).toEqual({ level: 'debug', text: '$ ls' });
    expect(describeProviderLine(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ kind: 'update', path: 'src/a.ts' }] } }))!.text).toContain('update src/a.ts');
    expect(describeProviderLine(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }))).toEqual({ level: 'error', text: 'quota' });
    expect(describeProviderLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }))!.text).toContain('5 token vào');
    expect(describeProviderLine(JSON.stringify({ type: 'item.completed', item: { type: 'unknown_thing' } }))).toBeNull();
    expect(describeProviderLine('not json')!.level).toBe('debug');
  });
  it('describes Claude assistant text and tool calls', () => {
    const line = describeProviderLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Edit', input: { file: 'a' } }] } }))!;
    expect(line.text).toContain('Agent: hi');
    expect(line.text).toContain('Tool: Edit');
  });
});

describe('lineSplitter', () => {
  it('joins chunks into lines, handles CRLF, skips blanks, and flushes the tail', () => {
    const lines: string[] = [];
    const s = lineSplitter((l) => lines.push(l));
    s.push('one\r\ntw'); s.push('o\n\n\nthree'); s.flush();
    expect(lines).toEqual(['one', 'two', 'three']);
  });
  it('emits a runaway line instead of buffering it forever', () => {
    const lines: string[] = [];
    lineSplitter((l) => lines.push(l)).push('x'.repeat(20_000));
    expect(lines[0]!.length).toBe(20_000);
  });
});

describe('live visibility of long steps', () => {
  it('streams setup output from a real process, line by line, with stderr as warnings', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'aidept-mon-repo-'));
    writeFileSync(path.join(repo, 'a.txt'), 'x');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: repo });
    const store = new Store(':memory:');
    store.projects.put(profile({ repository: repo, executionMode: 'local', setupCommand: ['node', '-e', "console.log('installing 1'); console.error('npm warn deprecated x'); console.log('installing 2')"] }));
    const runtime = new LocalRuntime({ dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-mon-data-')) });
    const orchestrator = new Orchestrator(store, () => runtime);
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 't', originalRequirement: 'r', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    const events: RuntimeEvent[] = [];
    await runtime.prepare(run, 'A', (e) => events.push(e));
    expect(events.map((e) => [e.message, (e.data as { level: string }).level])).toEqual([
      ['git clone (snapshot)…', undefined], ['installing 1', 'info'], ['npm warn deprecated x', 'warn'], ['installing 2', 'info'],
    ].map(([m, l]) => [m, l ?? undefined]) as never);
  }, 60_000);

  it('a slow step reports that it is still running, and how long it took', async () => {
    const store = new Store(':memory:');
    const runtime = new FakeRuntime({ delayMs: 120, check: () => green });
    const orchestrator = new Orchestrator(store, () => runtime, { heartbeatMs: 25 });
    store.projects.put(profile());
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 't', originalRequirement: 'r', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    orchestrator.startRun(run.id); await orchestrator.idle();
    const lines = store.logs.list({ runId: run.id, source: 'agent', limit: 500 }).map((e) => e.message);
    expect(lines.some((l) => /planner.*bắt đầu/.test(l))).toBe(true);
    expect(lines.some((l) => /vẫn đang chạy/.test(l))).toBe(true);
    expect(lines.some((l) => /xong sau/.test(l))).toBe(true);
    expect(store.logs.list({ runId: run.id, source: 'setup' }).some((e) => /Chuẩn bị bản sao/.test(e.message))).toBe(true);
  });

  it('records a failing step as an error line with its duration', async () => {
    const { orchestrator, create, store } = setup({ throwOnAgent: () => new Error('429 rate limit') });
    const run = create();
    orchestrator.startRun(run.id); await orchestrator.idle();
    expect(store.logs.list({ runId: run.id, minLevel: 'error' }).some((e) => /dừng sau .*429/.test(e.message))).toBe(true);
  });
});

describe('monitor API', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });
  // A fresh port per test: undici keeps sockets alive, and reusing one after app.close() resets the next connection.
  let nextPort = 4400;
  async function boot() {
    const env = setup({ check: () => green });
    const PORT = nextPort++;
    app = await buildApp({ ...env, dataDir: tmpdir(), port: PORT });
    await app.listen({ host: '127.0.0.1', port: PORT });
    return { ...env, PORT };
  }

  it('serves filtered history, validates filters, and summarises activity', async () => {
    const env = await boot();
    const { PORT } = env;
    const run = env.create();
    env.orchestrator.startRun(run.id); await env.orchestrator.idle();
    const get = (url: string) => fetch(`http://127.0.0.1:${PORT}${url}`);
    const logs = await (await get(`/api/logs?run=${run.id}&source=agent&level=info`)).json() as { source: string }[];
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.source.startsWith('agent'))).toBe(true);
    expect((await get('/api/logs?level=loud')).status).toBe(400);
    expect((await get('/api/logs?limit=99999')).status).toBe(400);
    const monitor = await (await get('/api/monitor?period=7d')).json() as { period: string; recent: { role: string; costUsd: number }[]; totals: { costUsd: number; requests: number }; activeRuns: unknown[]; series: unknown[]; tasks: { id: string }[] };
    expect(monitor.period).toBe('7d');
    expect(monitor.recent[0]!.role).toBe('planner');
    expect(monitor.totals).toMatchObject({ requests: 1 });
    expect(monitor.totals.costUsd).toBeGreaterThan(0);
    expect(monitor.activeRuns).toEqual([]);
    expect(monitor.series.length).toBeGreaterThanOrEqual(7);
    expect(monitor.tasks[0]!.id).toBe(run.id);
    expect((await get('/api/monitor?period=forever')).status).toBe(400);
    expect(((await (await get('/api/monitor')).json()) as { period: string }).period).toBe('today');
    const attempt = env.store.attempts.list(run.id)[0]!;
    const raw = await (await get(`/api/runs/${run.id}/attempts/${attempt.id}/raw`)).json() as { raw: string };
    expect(raw.raw).toContain('fake');
    expect((await get(`/api/runs/${run.id}/attempts/none/raw`)).status).toBe(404);
    // Host protection covers the new routes too.
    // fetch() will not let a caller override Host, so use a raw request.
    const status = await new Promise<number>((resolve, reject) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/logs', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject));
    expect(status).toBe(403);
  });

  it('streams new lines over SSE, honours filters, and replays what arrived after `after`', async () => {
    const env = await boot();
    const { PORT } = env;
    env.store.logs.append({ runId: 'r1', source: 'setup', level: 'info', message: 'old line' });
    const tip = env.store.logs.list({ limit: 1 })[0]!.id;
    env.store.logs.append({ runId: 'r1', source: 'setup', level: 'info', message: 'gap line' });
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${PORT}/api/logs/stream?after=${tip}&source=setup&level=info`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!received.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value);
      }
    };
    await readUntil('gap line');
    env.store.logs.append({ runId: 'r1', source: 'agent:developer', level: 'info', message: 'filtered out' });
    env.store.logs.append({ runId: 'r1', source: 'setup', level: 'info', message: 'live line' });
    await readUntil('live line');
    controller.abort();
    expect(received).toContain('gap line');
    expect(received).toContain('live line');
    expect(received).not.toContain('old line');
    expect(received).not.toContain('filtered out');
  }, 15_000);
});

describe('usage aggregation by period', () => {
  const NOW = new Date(2026, 9, 20, 15, 30, 0).getTime(); // local time: 20 Oct 2026 15:30
  const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
  const H = 3_600_000, D = 24 * H;
  const usage = (attemptId: string, at: number, input: number, cached: number, output: number, cost: number | null) =>
    ({ id: `u-${attemptId}-${at}`, attemptId, inputTokens: input, cachedTokens: cached, outputTokens: output, costUsd: cost, source: cost === null ? 'estimated' as const : 'reported' as const, createdAt: iso(at) });
  const attempt = (id: string, at: number, status: string, model = 'm1', provider = 'codex') =>
    ({ id, runId: 'r1', slot: 'A', role: 'developer', stage: 'implement', provider, model, status, startedAt: iso(at), checkpoint: null, contractVersion: 1 }) as never;
  const run = (usages: ReturnType<typeof usage>[]) => ({ id: 'r1', title: 'Task', status: 'running', stage: 'implement', mode: 'single', updatedAt: iso(0), usage: usages }) as never;
  const activity = { providers: [], stages: { setup: false, check: false } };

  it('"today" starts at local midnight; 24h and 7d are rolling windows', async () => {
    const { periodStart } = await import('../src/core/monitor.js');
    expect(periodStart('today', NOW)).toBe(new Date(2026, 9, 20, 0, 0, 0).getTime());
    expect(periodStart('24h', NOW)).toBe(NOW - D);
    expect(periodStart('7d', NOW)).toBe(NOW - 7 * D);
  });

  it('only counts usage and requests inside the window, and keeps input as input-including-cache', async () => {
    const { buildMonitor } = await import('../src/core/monitor.js');
    const runs = [run([usage('a1', -2 * H, 1000, 400, 100, 0.5), usage('a2', -30 * H, 9999, 0, 999, 9)])];
    const attempts = [attempt('a1', -2 * H, 'completed'), attempt('a2', -30 * H, 'completed')];
    const today = buildMonitor({ runs, attempts, now: NOW, period: 'today', errorsLastHour: 0, activity });
    expect(today.totals).toMatchObject({ requests: 1, inputTokens: 1000, cachedTokens: 400, outputTokens: 100, costUsd: 0.5, estimated: false });
    const week = buildMonitor({ runs, attempts, now: NOW, period: '7d', errorsLastHour: 0, activity });
    expect(week.totals).toMatchObject({ requests: 2, inputTokens: 10999, outputTokens: 1099 });
  });

  it('builds hourly buckets for today and daily buckets for longer periods, with no gaps', async () => {
    const { buildMonitor } = await import('../src/core/monitor.js');
    const runs = [run([usage('a1', -2 * H, 10, 0, 5, 0.1), usage('a1', -5 * D, 20, 0, 7, 0.2)])];
    const attempts = [attempt('a1', -2 * H, 'completed')];
    const today = buildMonitor({ runs, attempts, now: NOW, period: 'today', errorsLastHour: 0, activity });
    expect(today.unit).toBe('hour');
    expect(today.series).toHaveLength(16); // 00:00 .. 15:00
    expect(today.series.reduce((n, b) => n + b.inputTokens, 0)).toBe(10);
    const days = buildMonitor({ runs, attempts, now: NOW, period: '7d', errorsLastHour: 0, activity });
    expect(days.unit).toBe('day');
    expect(days.series).toHaveLength(8);
    expect(days.series.reduce((n, b) => n + b.inputTokens, 0)).toBe(30);
    expect(days.series.at(-1)!.requests).toBe(1);
  });

  it('groups by provider/model, counts failures and interruptions, and flags estimated cost', async () => {
    const { buildMonitor } = await import('../src/core/monitor.js');
    const runs = [run([usage('a1', -H, 100, 0, 10, 0.1), usage('a2', -H, 50, 0, 5, null), usage('a3', -H, 1, 0, 1, 0.01)])];
    const attempts = [attempt('a1', -H, 'completed'), attempt('a2', -H, 'failed'), attempt('a3', -H, 'interrupted', 'm2', 'claude')];
    const data = buildMonitor({ runs, attempts, now: NOW, period: '24h', errorsLastHour: 3, activity });
    expect(data.totals).toMatchObject({ requests: 3, failed: 2, estimated: true });
    expect(data.byModel.map((m) => [`${m.provider}/${m.model}`, m.requests, m.failed])).toEqual([['codex/m1', 2, 1], ['claude/m2', 1, 1]]);
    expect(data.errorsLastHour).toBe(3);
  });

  it('reports running attempts and active tasks, and limits the topology to the 8 newest tasks', async () => {
    const { buildMonitor } = await import('../src/core/monitor.js');
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, title: `T${i}`, status: 'completed', stage: 'verify', mode: 'single', updatedAt: iso(-(i + 1) * 1000), usage: [] }) as never);
    const data = buildMonitor({ runs: [...many, run([])], attempts: [attempt('live', -1000, 'running')], now: NOW, period: 'today', errorsLastHour: 0, activity: { providers: ['codex'], stages: { setup: false, check: true } } });
    expect(data.tasks).toHaveLength(8);
    // The standalone run() has the newest updatedAt, so it leads.
    expect(data.tasks[0]!.id).toBe('r1');
    expect(data.runningAttempts.map((a) => a.id)).toEqual(['live']);
    expect(data.activeRuns.map((r) => r.id)).toEqual(['r1']);
    expect(data.activity.providers).toEqual(['codex']);
  });
});
