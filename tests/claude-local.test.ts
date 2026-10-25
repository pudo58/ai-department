import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeStatus, forgetCliStatus, resolveClaudeCommand } from '../src/runtime/agentclis.js';
import { LocalRuntime } from '../src/runtime/local.js';
import { buildCliCommand, JsonlCollector, LOCAL_CLAUDE_TOOLS } from '../src/runtime/providers.js';
import { buildApp } from '../src/server/app.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import type { Role, RoleConfig } from '../src/shared/types.js';
import { green, profile, setup } from './helpers.js';

const FAKE = path.resolve('tests/fixtures/fake-claude.mjs');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let argsLog = '';
beforeEach(() => {
  argsLog = path.join(mkdtempSync(path.join(tmpdir(), 'aidept-claude-args-')), 'args.jsonl');
  process.env.AIDEPT_CLAUDE_ENTRY = FAKE;
  process.env.AIDEPT_AGY_ENTRY = path.resolve('tests/fixtures/fake-agy.mjs');
  process.env.FAKE_CLAUDE_ARGS_LOG = argsLog;
  delete process.env.FAKE_CLAUDE_LOGGED_OUT;
  forgetCliStatus();
});
afterEach(() => { delete process.env.AIDEPT_CLAUDE_ENTRY; delete process.env.AIDEPT_AGY_ENTRY; delete process.env.FAKE_CLAUDE_ARGS_LOG; delete process.env.FAKE_CLAUDE_LOGGED_OUT; forgetCliStatus(); });

describe('Claude Code command for a local run', () => {
  it('uses the person’s own login (no --bare), loads project settings only, no MCP, and a bounded tool list', () => {
    const local = buildCliCommand({ provider: 'claude', model: '', singleAgent: true, local: true, sessionId: 's1' });
    expect(local).not.toContain('--bare');
    expect(local).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--setting-sources', 'project,local', '--strict-mcp-config', '--permission-mode', 'acceptEdits', '--resume', 's1', '--disallowedTools']));
    expect(local.slice(local.indexOf('--allowedTools') + 1, local.indexOf('--allowedTools') + 1 + LOCAL_CLAUDE_TOOLS.length)).toEqual(LOCAL_CLAUDE_TOOLS);
    expect(LOCAL_CLAUDE_TOOLS.some((t) => /^Bash\((rm|curl|powershell)/i.test(t))).toBe(false);
    // The container path keeps API-key-only mode.
    expect(buildCliCommand({ provider: 'claude', model: '', singleAgent: false })).toContain('--bare');
  });

  it('reads the model from the init event', () => {
    const c = new JsonlCollector({ provider: 'claude' });
    c.push(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x', model: 'claude-fable-5-1' })}\n`);
    expect(c.model).toBe('claude-fable-5-1');
  });

  it('resolves the CLI from AIDEPT_CLAUDE_ENTRY and reports a Pro login as a subscription', async () => {
    expect(resolveClaudeCommand()).toEqual([process.execPath, FAKE]);
    expect(resolveClaudeCommand('')).toEqual(['claude']);
    const status = await claudeStatus();
    expect(status).toMatchObject({ installed: true, loggedIn: true, billing: 'subscription', account: 'claude.ai (pro)', version: '9.9.9 (Claude Code)' });
    process.env.FAKE_CLAUDE_LOGGED_OUT = '1';
    expect(await claudeStatus()).toMatchObject({ installed: true, loggedIn: false });
  });
});

describe('Kết nối AI endpoints', () => {
  it('lists the CLIs, and the connection test needs the CSRF token and reports the answering model', async () => {
    const env = setup({ check: () => green });
    const app = await buildApp({ ...env, dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-')), port: 4310 });
    try {
      const host = { host: '127.0.0.1:4310' };
      const token = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json<{ token: string }>().token;
      const list = (await app.inject({ method: 'GET', url: '/api/providers?refresh=1', headers: host })).json<{ id: string; installed: boolean; loggedIn: boolean; billing?: string }[]>();
      expect(list.map((s) => s.id)).toEqual(['codex', 'claude', 'antigravity']);
      expect(list[1]).toMatchObject({ installed: true, loggedIn: true, billing: 'subscription' });
      for (const url of ['/api/providers/claude/test', '/api/providers/claude/login', '/api/providers/codex/install']) {
        expect((await app.inject({ method: 'POST', url, payload: {}, headers: host })).statusCode, url).toBe(403);
      }
      expect((await app.inject({ method: 'POST', url: '/api/providers/gemini/test', payload: {}, headers: { ...host, 'x-csrf-token': token } })).statusCode).toBe(400);
      const test = (await app.inject({ method: 'POST', url: '/api/providers/claude/test', payload: {}, headers: { ...host, 'x-csrf-token': token } })).json<{ ok: boolean; model?: string; reply?: string }>();
      expect(test).toMatchObject({ ok: true, model: 'claude-fable-5-1', reply: 'OK' });
    } finally { await app.close(); }
  }, 60_000);
});

describe('a task where Claude writes the code, on this machine', () => {
  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidept-claude-repo-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'c', private: true, type: 'module' }));
    writeFileSync(path.join(dir, 'src', 'sum.mjs'), 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n');
    git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    return dir;
  }
  const NODE_TEST = ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=.aidept-report.xml', 'tests/*.test.mjs'];
  const claudeRole = (): RoleConfig => ({ ...profile().roles.developer, provider: 'claude', model: '' });
  const claudeRoles: Record<Role, RoleConfig> = { planner: claudeRole(), author: claudeRole(), developer: claudeRole(), verifier: claudeRole(), investigator: claudeRole() };

  it('runs plan → code → checks through Claude, records its model, and charges a Pro subscription nothing', async () => {
    const source = repo();
    const store = new Store(':memory:');
    store.projects.put(profile({ repository: source, executionMode: 'local', roles: claudeRoles, checks: [{ id: 'test', command: NODE_TEST, required: true, timeoutMs: 60_000, reportPath: '.aidept-report.xml' }] }));
    const runtime = new LocalRuntime({ dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-claude-data-')) });
    const orchestrator = new Orchestrator(store, () => runtime);
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 'Sửa sumTo', originalRequirement: 'sumTo bỏ sót n', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id, { contractHash: orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true }); await orchestrator.idle();
    const detail = orchestrator.detail(run.id);
    expect(detail.run.status, `${detail.run.blocker}\n${detail.events.map((e) => e.message).join('\n')}`).toBe('awaiting_acceptance');
    expect(detail.attempts.map((a) => [a.role, a.provider, a.model])).toEqual([['planner', 'claude', 'claude-fable-5-1'], ['developer', 'claude', 'claude-fable-5-1']]);
    expect(detail.run.usage.every((u) => u.costUsd === 0 && u.billing === 'subscription' && u.notionalUsd === 0.42)).toBe(true);
    expect(detail.budget.spentUsd).toBe(0);
    const calls = readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]).filter((a) => a[0] === '-p');
    expect(calls.length).toBe(2);
    expect(calls.every((a) => !a.includes('--bare') && a.includes('--strict-mcp-config'))).toBe(true);
  }, 120_000);

  it('blocks with a pointer to the connect page when Claude is not signed in', async () => {
    process.env.FAKE_CLAUDE_LOGGED_OUT = '1';
    const store = new Store(':memory:');
    store.projects.put(profile({ repository: repo(), executionMode: 'local', roles: claudeRoles }));
    const runtime = new LocalRuntime({ dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-claude-data-')) });
    const orchestrator = new Orchestrator(store, () => runtime);
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 'x', originalRequirement: 'y', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    orchestrator.startRun(run.id); await orchestrator.idle();
    const detail = orchestrator.detail(run.id);
    expect(detail.run.status).toBe('blocked');
    expect(detail.run.blocker).toMatch(/chưa đăng nhập.*Kết nối AI/);
  }, 60_000);

  it('treats a used-up Pro limit as blocked (wait and resume), not as a failed task', async () => {
    process.env.FAKE_CLAUDE_LIMIT = '1';
    try {
      const store = new Store(':memory:');
      store.projects.put(profile({ repository: repo(), executionMode: 'local', roles: claudeRoles }));
      const runtime = new LocalRuntime({ dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-claude-data-')) });
      const orchestrator = new Orchestrator(store, () => runtime);
      const run = orchestrator.createRun({ projectId: 'prj_test', title: 'x', originalRequirement: 'y', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
      orchestrator.startRun(run.id); await orchestrator.idle();
      const detail = orchestrator.detail(run.id);
      expect(detail.run.status).toBe('blocked');
      expect(detail.run.blocker).toMatch(/quota.*limit reached/);
    } finally { delete process.env.FAKE_CLAUDE_LIMIT; }
  }, 60_000);
});
