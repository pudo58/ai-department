import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agySettings, createAgyHome } from '../src/runtime/agyhome.js';
import { antigravityStatus, forgetCliStatus, resolveAgyCommand, testCli } from '../src/runtime/agentclis.js';
import { describeProviderLine } from '../src/runtime/describe.js';
import { LocalRuntime } from '../src/runtime/local.js';
import { AGY_READ_ONLY_PREAMBLE, buildCliCommand, JsonlCollector } from '../src/runtime/providers.js';
import { buildApp } from '../src/server/app.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import type { ProviderName, Role, RoleConfig } from '../src/shared/types.js';
import { green, profile, setup } from './helpers.js';

const FAKE_AGY = path.resolve('tests/fixtures/fake-agy.mjs');
const FAKE_CLAUDE = path.resolve('tests/fixtures/fake-claude.mjs');
const ENV = ['AIDEPT_AGY_ENTRY', 'AIDEPT_CLAUDE_ENTRY', 'FAKE_AGY_LOG', 'FAKE_AGY_LOGGED_OUT', 'FAKE_AGY_WRITE', 'FAKE_AGY_DENY', 'FAKE_AGY_HOOK', 'FAKE_AGY_USER_FILE', 'FAKE_AGY_ESCAPE'];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const rule = (p: string) => `write_file(${path.resolve(p).replaceAll('\\', '/')})`;
let agyLog = '';
beforeEach(() => {
  agyLog = path.join(mkdtempSync(path.join(tmpdir(), 'aidept-agy-log-')), 'calls.jsonl');
  for (const key of ENV) delete process.env[key];
  process.env.AIDEPT_AGY_ENTRY = FAKE_AGY;
  process.env.AIDEPT_CLAUDE_ENTRY = FAKE_CLAUDE;
  process.env.FAKE_AGY_LOG = agyLog;
  forgetCliStatus();
});
afterEach(() => { for (const key of ENV) delete process.env[key]; forgetCliStatus(); });
interface Call { args: string[]; stdin: string; home: string; settings: { trustedWorkspaces: string[]; allowNonWorkspaceAccess: boolean; permissions: { allow: string[]; ask: string[]; deny: string[] } } | null }
const calls = (): Call[] => (existsSync(agyLog) ? readFileSync(agyLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call) : []);

describe('Antigravity command', () => {
  it('runs read-only roles in plan mode and write roles in accept-edits, never with the permission bypass', () => {
    const cmd = buildCliCommand({ provider: 'antigravity', model: '', effort: 'high', singleAgent: true, workdir: 'C:/ws' });
    expect(cmd).toEqual(['agy', '--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--disable-slash-commands', '--add-dir=C:/ws', '--effort', 'high', '--print=']);
    expect(cmd.join(' ')).not.toMatch(/dangerously|skip-permissions|--sandbox|accept-edits|--conversation/);
    const write = buildCliCommand({ provider: 'antigravity', model: '', singleAgent: true, workdir: 'C:/ws', write: true });
    expect(write.slice(5, 8)).toEqual(['--mode', 'accept-edits', '--disable-slash-commands']);
    expect(write.join(' ')).not.toMatch(/dangerously|skip-permissions/);
    // A model id carries its own thinking level, so --effort is not sent with it.
    expect(buildCliCommand({ provider: 'antigravity', model: 'gemini-3.8-flash-low', effort: 'high', singleAgent: true, workdir: 'C:/ws' }).slice(-3)).toEqual(['--model', 'gemini-3.8-flash-low', '--print=']);
  });

  it('gives each turn its own rules: read-only denies every write, write roles may write only the working copy', async () => {
    const ws = path.join(tmpdir(), 'aidept-ws'), home = path.join(tmpdir(), 'aidept-home');
    const readOnly = agySettings(ws, false, home, ['C:/', 'D:/']);
    expect(readOnly).toEqual({ trustedWorkspaces: [path.resolve(ws)], allowNonWorkspaceAccess: false, permissions: { allow: [], ask: [], deny: ['write_file(*)', 'write_file(C:/)', 'write_file(D:/)'] } });
    expect(agySettings(ws, true, home, ['C:/']).permissions).toEqual({
      allow: [rule(ws), rule(path.join(home, '.gemini', 'antigravity-cli', 'brain'))],
      ask: ['write_file(*)', 'write_file(C:/)'],
      deny: [`${rule(ws).slice(0, -1)}/.git)`],
    });
    const created = await createAgyHome(path.join(mkdtempSync(path.join(tmpdir(), 'aidept-agy-')), 'agy'), ws, false);
    expect(created.env).toMatchObject({ USERPROFILE: created.dir, HOME: created.dir });
    expect(JSON.parse(readFileSync(path.join(created.dir, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).permissions.deny[0]).toBe('write_file(*)');
    await created.dispose();
    expect(existsSync(created.dir)).toBe(false);
  });

  it('reads the stream: model and conversation from init, the answer from text deltas or the result, and usage', () => {
    const c = new JsonlCollector({ provider: 'antigravity' });
    const lines = [
      { event: 'init', conversation_id: 'c1', init: { model: 'gemini-3.8-flash-low' } },
      { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Xin ' } },
      { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'chào' } },
      { event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: '', usage: { input_tokens: 100, cache_read_tokens: 40, output_tokens: 10, thinking_tokens: 5 } } },
    ];
    c.push(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); c.finish();
    expect(c).toMatchObject({ model: 'gemini-3.8-flash-low', sessionId: 'c1', output: 'Xin chào', completed: true, failure: undefined, denied: [] });
    expect(c.usage).toEqual({ inputTokens: 100, cachedTokens: 40, outputTokens: 15, costUsd: null });
  });

  it('treats an empty answer after a refused command, or an ERROR status, as a failure', () => {
    const denied = new JsonlCollector({ provider: 'antigravity' });
    denied.push(`${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '', usage: {}, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } })}\n`); denied.finish();
    expect(denied.failure).toMatch(/bị chặn ở chế độ chỉ đọc \(RunCommand\)/);
    expect(denied.denied).toEqual([{ action: 'command', name: 'RunCommand' }]);
    const error = new JsonlCollector({ provider: 'antigravity' });
    error.push(`${JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED: quota', usage: {} } })}\n`); error.finish();
    expect(error.failure).toBe('RESOURCE_EXHAUSTED: quota');
    expect(describeProviderLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 5, output_tokens: 1 }, denied_actions: [{ display_name: 'RunCommand' }] } }))?.text).toMatch(/bị chặn: RunCommand/);
    expect(describeProviderLine(JSON.stringify({ event: 'step_update', step_update: { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'x' } }))).toBeNull();
  });

  it('finds the CLI and reads sign-in and models from `agy models`', async () => {
    expect(resolveAgyCommand()).toEqual([process.execPath, FAKE_AGY]);
    expect(await antigravityStatus()).toMatchObject({ installed: true, loggedIn: true, version: '1.4.5', billing: 'subscription', account: 'Google', models: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'] });
    process.env.FAKE_AGY_LOGGED_OUT = '1';
    expect(await antigravityStatus()).toMatchObject({ installed: true, loggedIn: false });
  });

  it('tests the connection the way a read-only turn runs, from a private home and an empty folder it removes afterwards', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-agy-test-'));
    expect(await testCli('antigravity', dataDir)).toMatchObject({ ok: true, reply: 'OK' });
    const [call] = calls();
    expect(call!.args).toEqual(expect.arrayContaining(['--mode', 'plan']));
    expect(call!.home.startsWith(path.join(dataDir, 'agy'))).toBe(true);
    expect(call!.settings!.permissions.deny).toContain('write_file(*)');
    expect(readdirSync(path.join(dataDir, 'agy'))).toEqual([]);
  });
});

describe('Antigravity in a run, on this machine', () => {
  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidept-agy-repo-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'g', private: true, type: 'module' }));
    writeFileSync(path.join(dir, 'src', 'sum.mjs'), 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n');
    git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    return dir;
  }
  const NODE_TEST = ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=.aidept-report.xml', 'tests/*.test.mjs'];
  const rolesOf = (map: Partial<Record<Role, ProviderName>>): Record<Role, RoleConfig> => {
    const base = profile().roles.developer;
    return Object.fromEntries((['planner', 'author', 'developer', 'verifier', 'investigator'] as Role[]).map((r) => [r, { ...base, model: '', provider: map[r] ?? 'claude' }])) as Record<Role, RoleConfig>;
  };
  function start(roles: Record<Role, RoleConfig>) {
    const store = new Store(':memory:');
    store.projects.put(profile({ repository: repo(), executionMode: 'local', roles, checks: [{ id: 'test', command: NODE_TEST, required: true, timeoutMs: 60_000, reportPath: '.aidept-report.xml' }] }));
    // The person's own agy files live in a throwaway home here; the tripwire watches them there.
    const userHome = mkdtempSync(path.join(tmpdir(), 'aidept-agy-user-'));
    mkdirSync(path.join(userHome, '.gemini', 'config'), { recursive: true });
    writeFileSync(path.join(userHome, '.gemini', 'config', 'config.json'), '{}');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-agy-data-'));
    const runtime = new LocalRuntime({ dataDir, agyUserHome: userHome });
    const orchestrator = new Orchestrator(store, () => runtime);
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 'Sửa sumTo', originalRequirement: 'sumTo bỏ sót n', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    return { orchestrator, runtime, run, userHome, dataDir };
  }
  const throughContract = async (orchestrator: Orchestrator, runId: string) => {
    orchestrator.startRun(runId); await orchestrator.idle();
    orchestrator.approveContract(runId, { contractHash: orchestrator.detail(runId).contractReview.contractHash, acknowledgeWarnings: true }); await orchestrator.idle();
    return orchestrator.detail(runId);
  };

  it('plans with Antigravity and codes with Claude; the plan costs the budget nothing and agy only ever runs read-only', async () => {
    const { orchestrator, run, dataDir } = start(rolesOf({ planner: 'antigravity' }));
    orchestrator.startRun(run.id); await orchestrator.idle();
    expect(orchestrator.detail(run.id).run.status, orchestrator.detail(run.id).run.blocker ?? '').toBe('awaiting_approval');
    orchestrator.approveContract(run.id, { contractHash: orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true }); await orchestrator.idle();
    const detail = orchestrator.detail(run.id);
    expect(detail.run.status, `${detail.run.blocker}\n${detail.events.map((e) => e.message).join('\n')}`).toBe('awaiting_acceptance');
    expect(detail.attempts.map((a) => [a.role, a.provider, a.model])).toEqual([['planner', 'antigravity', 'gemini-3.8-flash-medium'], ['developer', 'claude', 'claude-fable-5-1']]);
    const planUsage = detail.run.usage.find((u) => u.attemptId === detail.attempts[0]!.id)!;
    expect(planUsage).toMatchObject({ inputTokens: 15000, cachedTokens: 4000, outputTokens: 250, costUsd: 0, billing: 'subscription' });
    const [call] = calls();
    expect(call!.args).toEqual(expect.arrayContaining(['--mode', 'plan', '--disable-slash-commands', '--input-format', 'stream-json']));
    expect(call!.args.join(' ')).not.toMatch(/dangerously/);
    const workdir = call!.args.find((a) => a.startsWith('--add-dir='))!.slice('--add-dir='.length);
    expect(workdir).toMatch(/workspaces/);
    // Its own home under the data dir, with rules that deny every write (gone once the turn ends).
    expect(call!.home.startsWith(path.join(dataDir, 'agy'))).toBe(true);
    expect(call!.settings).toMatchObject({ trustedWorkspaces: [workdir], allowNonWorkspaceAccess: false, permissions: { allow: [], ask: [] } });
    expect(call!.settings!.permissions.deny).toContain('write_file(*)');
    expect(existsSync(call!.home)).toBe(false);
    const message = JSON.parse(call!.stdin) as { event: string; message: { content: string } };
    expect(message.event).toBe('user');
    expect(message.message.content.startsWith(AGY_READ_ONLY_PREAMBLE)).toBe(true);
    expect(message.message.content).toContain('Bạn là Planner');
  }, 120_000);

  it('voids an attempt that changed the working copy and rolls the change back', async () => {
    process.env.FAKE_AGY_WRITE = '1';
    const { orchestrator, runtime, run } = start(rolesOf({ planner: 'antigravity' }));
    orchestrator.startRun(run.id); await orchestrator.idle();
    const detail = orchestrator.detail(run.id);
    expect(detail.run.status).toBe('failed');
    expect(detail.run.blocker).toMatch(/bị thay đổi trong lượt Antigravity \(chế độ chỉ đọc\).*hoàn tác/);
    expect(existsSync(path.join(runtime.workspacePath(detail.run, 'A'), 'agy-was-here.txt'))).toBe(false);
  }, 60_000);

  it('fails clearly when a read-only agy wanted a shell command and stopped without answering', async () => {
    process.env.FAKE_AGY_DENY = '1';
    const { orchestrator, run } = start(rolesOf({ planner: 'antigravity' }));
    orchestrator.startRun(run.id); await orchestrator.idle();
    expect(orchestrator.detail(run.id).run.blocker).toMatch(/bị chặn ở chế độ chỉ đọc \(RunCommand\)/);
  }, 60_000);

  it('keeps a read-only turn from writing outside the working copy: the deny rule refuses it and the answer still comes', async () => {
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'aidept-outside-')), 'escape.txt');
    process.env.FAKE_AGY_ESCAPE = outside;
    const { orchestrator, run } = start(rolesOf({ planner: 'antigravity' }));
    orchestrator.startRun(run.id); await orchestrator.idle();
    expect(orchestrator.detail(run.id).run.status, orchestrator.detail(run.id).run.blocker ?? '').toBe('awaiting_approval');
    expect(existsSync(outside)).toBe(false);
  }, 60_000);

  it('codes with Antigravity (experimental): edits stay in the working copy, a refused command ends the turn and the checks judge it', async () => {
    process.env.FAKE_AGY_DENY = '1';
    const { orchestrator, run } = start(rolesOf({ developer: 'antigravity' }));
    const detail = await throughContract(orchestrator, run.id);
    expect(detail.run.status, `${detail.run.blocker}\n${detail.events.map((e) => e.message).join('\n')}`).toBe('awaiting_acceptance');
    expect(detail.attempts.map((a) => [a.role, a.provider, a.status])).toEqual([['planner', 'claude', 'completed'], ['developer', 'antigravity', 'completed']]);
    expect(detail.checks.map((c) => c.status)).toEqual(['passed']);
    const [call] = calls();
    const workdir = call!.args.find((a) => a.startsWith('--add-dir='))!.slice('--add-dir='.length);
    expect(call!.args[call!.args.indexOf('--mode') + 1]).toBe('accept-edits');
    expect(call!.args.join(' ')).not.toMatch(/dangerously/);
    expect(call!.settings!.permissions).toMatchObject({ allow: expect.arrayContaining([rule(workdir)]), deny: [`${rule(workdir).slice(0, -1)}/.git)`] });
    expect(call!.settings!.permissions.ask).toContain('write_file(*)');
    const content = (JSON.parse(call!.stdin) as { message: { content: string } }).message.content;
    expect(content).toMatch(/^Chế độ sửa file \(thử nghiệm\)/);
    expect(content).toContain(workdir);
    expect(content).toContain('Không chạy bất kỳ lệnh shell nào');
    expect(detail.artifacts.some((a) => a.kind === 'diff' && a.content.includes('i <= n'))).toBe(true);
  }, 120_000);

  it('voids a write-role turn that tried to write outside the working copy, and rolls back its edits', async () => {
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'aidept-outside-')), 'escape.txt');
    process.env.FAKE_AGY_ESCAPE = outside;
    const { orchestrator, runtime, run } = start(rolesOf({ developer: 'antigravity' }));
    const detail = await throughContract(orchestrator, run.id);
    expect(detail.run.status).toBe('failed');
    expect(detail.run.blocker).toMatch(/định ghi ra ngoài bản sao làm việc \(WriteFile\).*hoàn tác/);
    expect(existsSync(outside)).toBe(false);
    expect(git(runtime.workspacePath(detail.run, 'A'), 'status', '--porcelain')).toBe('');
  }, 120_000);

  it('restores .git hooks an agent turn left behind and voids the turn', async () => {
    process.env.FAKE_AGY_HOOK = '1';
    const { orchestrator, runtime, run } = start(rolesOf({ developer: 'antigravity' }));
    const detail = await throughContract(orchestrator, run.id);
    expect(detail.run.status).toBe('failed');
    expect(detail.run.blocker).toMatch(/\.git\/hooks\/post-commit.*khôi phục.*bị huỷ/);
    const ws = runtime.workspacePath(detail.run, 'A');
    expect(existsSync(path.join(ws, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(git(ws, 'status', '--porcelain')).toBe('');
  }, 120_000);

  it("voids the turn when the person's own agy config changed during it", async () => {
    const { orchestrator, run, userHome } = start(rolesOf({ planner: 'antigravity' }));
    process.env.FAKE_AGY_USER_FILE = path.join(userHome, '.gemini', 'config', 'config.json');
    orchestrator.startRun(run.id); await orchestrator.idle();
    const detail = orchestrator.detail(run.id);
    expect(detail.run.status).toBe('failed');
    expect(detail.run.blocker).toMatch(/File cấu hình Antigravity của bạn bị thay đổi.*config\.json/);
  }, 60_000);
});

describe('roles API', () => {
  it('accepts Antigravity for every role, and lists it among the providers', async () => {
    const env = setup({ check: () => green });
    const app = await buildApp({ ...env, dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-')), port: 4310 });
    try {
      const host = { host: '127.0.0.1:4310' };
      const token = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json<{ token: string }>().token;
      const send = (method: 'POST' | 'PATCH', url: string, payload: unknown) => app.inject({ method, url, payload: payload as object, headers: { ...host, 'x-csrf-token': token } });
      const roles = rolesOf({});
      const created = (await send('POST', '/api/projects', { name: 'G', repository: repo(), modules: ['src'], checks: [{ id: 'test', command: ['npm', 'test'] }], singleBudgetUsd: 5, roles, runnerImage: 'node:24-bookworm-slim' })).json<{ id: string }>();
      const developer = await send('PATCH', `/api/projects/${created.id}`, { roles: { ...roles, developer: { ...roles.developer, provider: 'antigravity' }, author: { ...roles.author, provider: 'antigravity' } } });
      expect(developer.statusCode, developer.body).toBe(200);
      const verifier = await send('PATCH', `/api/projects/${created.id}`, { roles: { ...roles, verifier: { ...roles.verifier, provider: 'antigravity', model: 'gemini-3.8-flash-high' } } });
      expect(verifier.statusCode).toBe(200);
      const list = (await app.inject({ method: 'GET', url: '/api/providers?refresh=1', headers: host })).json<{ id: string; loggedIn: boolean }[]>();
      expect(list.map((s) => s.id)).toEqual(['codex', 'claude', 'antigravity']);
      expect(list[2]).toMatchObject({ loggedIn: true });
      const login = (await send('POST', '/api/providers/antigravity/login', {})).json<{ started: boolean; output: string }>();
      expect(login).toMatchObject({ started: false });
      expect(login.output).toMatch(/chạy agy/);
    } finally { await app.close(); }
  }, 60_000);

  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidept-agy-api-'));
    git(dir, 'init', '-q'); writeFileSync(path.join(dir, 'a.txt'), 'x');
    return dir;
  }
  const rolesOf = (map: Partial<Record<Role, ProviderName>>): Record<Role, RoleConfig> => {
    const one = (r: Role): RoleConfig => ({ provider: map[r] ?? 'codex', model: '', effort: 'medium', skills: [] });
    return { planner: one('planner'), author: one('author'), developer: one('developer'), verifier: one('verifier'), investigator: one('investigator') };
  };
});
