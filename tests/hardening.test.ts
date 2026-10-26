import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeFile, scrubbedEnv } from '../src/runtime/process.js';
import { LocalRuntime } from '../src/runtime/local.js';
import { SkillLibrary } from '../src/runtime/skilllibrary.js';
import type { AgentExecution, CheckExecution } from '../src/runtime/types.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import type { Attempt } from '../src/shared/types.js';
import { red, profile, setup } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `aidept-${p}-`));

const SECRETS = { OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-anthropic', NPM_TOKEN: 'npm-secret', AWS_SECRET_ACCESS_KEY: 'aws', SSH_AUTH_SOCK: '/tmp/agent.sock', AIDEPT_TEST_PLAIN: 'visible' };
const touched: string[] = [];
const setEnv = (values: Record<string, string>) => { for (const [k, v] of Object.entries(values)) { process.env[k] = v; touched.push(k); } };
afterEach(() => { for (const k of touched.splice(0)) delete process.env[k]; delete process.env.AIDEPT_PASS_ENV; });

describe('credentials are kept out of the commands that run repository code', () => {
  it('names what counts as a secret, whole words only', () => {
    const base = { PATH: '/bin', OPENAI_API_KEY: 'a', GOOGLE_API_KEY: 'b', ANTHROPIC_AUTH_TOKEN: 'c', NPM_TOKEN: 'd', GITHUB_TOKEN: 'e', AWS_ACCESS_KEY_ID: 'f', SSH_AUTH_SOCK: 'g', DB_PASSWORD: 'h',
      TOKENIZERS_PARALLELISM: 'false', KEYBOARD_LAYOUT: 'us', NODE_ENV: 'test' };
    expect(Object.keys(scrubbedEnv('all', base)).sort()).toEqual(['KEYBOARD_LAYOUT', 'NODE_ENV', 'PATH', 'TOKENIZERS_PARALLELISM']);
    // Setup may need a registry token; the agents' own keys it never needs.
    expect(Object.keys(scrubbedEnv('provider', base)).sort()).toEqual(['AWS_ACCESS_KEY_ID', 'DB_PASSWORD', 'GITHUB_TOKEN', 'KEYBOARD_LAYOUT', 'NODE_ENV', 'NPM_TOKEN', 'PATH', 'SSH_AUTH_SOCK', 'TOKENIZERS_PARALLELISM']);
  });

  it('lets a named variable through when a project really needs it', () => {
    expect(scrubbedEnv('all', { NPM_TOKEN: 'x', OPENAI_API_KEY: 'y', AIDEPT_PASS_ENV: 'npm_token, OPENAI_API_KEY' })).toMatchObject({ NPM_TOKEN: 'x', OPENAI_API_KEY: 'y' });
  });

  it('a real child process does not see them', async () => {
    setEnv(SECRETS);
    const probe = ['-e', 'console.log(JSON.stringify(["OPENAI_API_KEY","NPM_TOKEN","SSH_AUTH_SOCK","AIDEPT_TEST_PLAIN"].map((k) => process.env[k] ?? null)))'];
    expect(JSON.parse((await executeFile(process.execPath, probe, { scrubSecrets: 'all' })).stdout)).toEqual([null, null, null, 'visible']);
    expect(JSON.parse((await executeFile(process.execPath, probe, { scrubSecrets: 'provider' })).stdout)).toEqual([null, 'npm-secret', '/tmp/agent.sock', 'visible']);
    expect(JSON.parse((await executeFile(process.execPath, probe)).stdout)).toEqual(['sk-openai', 'npm-secret', '/tmp/agent.sock', 'visible']);
  });

  function repo() {
    const dir = tmp('repo');
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
    git(dir, 'init', '-q'); git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    return dir;
  }
  const dump = ['node', '-e', 'require("fs").writeFileSync(".aidept-report.env", JSON.stringify({ key: process.env.OPENAI_API_KEY ?? null, npm: process.env.NPM_TOKEN ?? null, path: !!process.env.PATH }))'];
  const readDump = (runtime: LocalRuntime, run: Parameters<LocalRuntime['workspacePath']>[0]) => JSON.parse(readFileSync(path.join(runtime.workspacePath(run, 'A'), '.aidept-report.env'), 'utf8')) as { key: string | null; npm: string | null; path: boolean };

  it('checks and the setup command run without the agents’ keys; checks lose the tokens too', async () => {
    setEnv(SECRETS);
    const store = new Store(':memory:');
    store.projects.put(profile({ repository: repo(), executionMode: 'local', checks: [{ id: 'dump', command: dump, required: true, timeoutMs: 60_000 }], setupCommand: dump }));
    const runtime = new LocalRuntime({ dataDir: tmp('data') });
    const run = new Orchestrator(store, () => runtime).createRun({ projectId: 'prj_test', title: 't', originalRequirement: 'r', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    await runtime.prepare(run, 'A');
    expect(readDump(runtime, run)).toEqual({ key: null, npm: 'npm-secret', path: true }); // setup: provider keys gone, registry token kept
    const exec: CheckExecution = { run: { ...run, checkpoint: await runtime.commit(run, 'A', 'cp') }, recipe: run.configSnapshot.checks[0]!, slot: 'A', ref: 'candidate' };
    await runtime.runCheck(exec);
    expect(readDump(runtime, run)).toEqual({ key: null, npm: null, path: true }); // checks: everything credential-like gone
  }, 60_000);
});

describe('no agent may leave a hook or a git config key behind', () => {
  function workspace() {
    const source = tmp('repo');
    mkdirSync(path.join(source, 'src'));
    writeFileSync(path.join(source, 'src', 'a.mjs'), 'export const a = 1;\n');
    git(source, 'init', '-q'); git(source, 'add', '-A'); git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const store = new Store(':memory:');
    store.projects.put(profile({ repository: source, executionMode: 'local' }));
    // A scripted Codex: edits a file, then (optionally) plants a config key and a hook the way a hostile turn would.
    const script = path.join(tmp('codex'), 'codex.mjs');
    writeFileSync(script, `import { appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
writeFileSync('src/a.mjs', 'export const a = 2;\\n');
if (process.env.PLANT === 'config') appendFileSync('.git/config', '\\n[diff]\\n\\texternal = evil\\n');
if (process.env.PLANT === 'hook') { mkdirSync('.git/hooks', { recursive: true }); writeFileSync('.git/hooks/pre-commit', '#!/bin/sh\\necho pwned\\n'); }
const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
out({ type: 'thread.started', thread_id: 't' });
out({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'done' } });
out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
`);
    const runtime = new LocalRuntime({ dataDir: tmp('data'), codexCommand: [process.execPath, script] });
    const run = new Orchestrator(store, () => runtime).createRun({ projectId: 'prj_test', title: 't', originalRequirement: 'r', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    const attempt = { id: 'att_1', runId: run.id, slot: 'A', role: 'developer', stage: 'implement', provider: 'codex', model: 'default', status: 'running', startedAt: new Date().toISOString(), checkpoint: null, contractVersion: 1 } as Attempt;
    const exec = (): AgentExecution => ({ run, attempt, role: 'developer', prompt: 'x' });
    return { runtime, run, exec };
  }

  it('an ordinary Codex turn is untouched', async () => {
    const { runtime, run, exec } = workspace();
    await runtime.prepare(run, 'A');
    expect((await runtime.runAgent(exec())).output).toBe('done');
    expect(readFileSync(path.join(runtime.workspacePath(run, 'A'), 'src', 'a.mjs'), 'utf8')).toContain('= 2');
  }, 60_000);

  for (const [plant, what] of [['config', '.git/config'], ['hook', '.git/hooks/pre-commit']] as const) {
    it(`a Codex turn that plants ${what} is void: restored, rolled back, and refused`, async () => {
      const { runtime, run, exec } = workspace();
      await runtime.prepare(run, 'A');
      const ws = runtime.workspacePath(run, 'A');
      const configBefore = readFileSync(path.join(ws, '.git', 'config'), 'utf8');
      process.env.PLANT = plant; touched.push('PLANT');
      await expect(runtime.runAgent(exec())).rejects.toThrow(/đã sửa .*\.git\//);
      expect(readFileSync(path.join(ws, '.git', 'config'), 'utf8')).toBe(configBefore);
      expect(existsSync(path.join(ws, '.git', 'hooks', 'pre-commit'))).toBe(false);
      expect(readFileSync(path.join(ws, 'src', 'a.mjs'), 'utf8')).toContain('= 1'); // the turn's edit was rolled back too
    }, 60_000);
  }
});

describe('the preview is released by the orchestrator, not guessed from URLs', () => {
  it('tells the registered handler before a run uses its working copy', async () => {
    const { orchestrator, create } = setup({ check: () => red });
    const told: string[] = [];
    orchestrator.onWorkspaceBusy((id) => { told.push(id); });
    const run = create();
    orchestrator.startRun(run.id); await orchestrator.idle();
    expect(told).toContain(run.id);
  });

  it('a handler that throws never fails the run', async () => {
    const { orchestrator, create } = setup({ check: () => red });
    orchestrator.onWorkspaceBusy(() => { throw new Error('boom'); });
    const run = create();
    orchestrator.startRun(run.id); await orchestrator.idle();
    expect(orchestrator.detail(run.id).run.status).toBe('awaiting_approval');
  });
});

describe('a repair or recheck request survives a restart', () => {
  it('is stored with the run, carried out on resume after an interruption, and cleared when the step ends', async () => {
    const env = setup({ check: () => red });
    const run = await env.drive(env.create());
    expect(env.orchestrator.detail(run.id).run.status).toBe('failed');

    // A recheck is requested, then the server dies mid-turn (the drive's cleanup never runs).
    const stored = env.store.runs.get(run.id)!;
    env.store.runs.put({ ...stored, status: 'running', pendingAction: 'recheck' });
    const restarted = new Orchestrator(env.store, () => env.runtime);
    await restarted.recover();
    expect(env.store.runs.get(run.id)).toMatchObject({ status: 'paused', pendingAction: 'recheck' });

    const callsBefore = env.runtime.calls.length;
    restarted.startRun(run.id); await restarted.idle();
    const after = env.runtime.calls.slice(callsBefore);
    expect(after.some((c) => c.startsWith('check:'))).toBe(true);
    expect(after.some((c) => c.startsWith('agent:'))).toBe(false); // a recheck, not a new build
    expect(env.store.runs.get(run.id)!.pendingAction).toBeUndefined();
  });

  it('stopping a queued request drops it', async () => {
    const env = setup({ check: () => red });
    const run = await env.drive(env.create());
    env.orchestrator.recheck(run.id);
    expect(env.store.runs.get(run.id)!.pendingAction).toBe('recheck');
    env.orchestrator.stopRun(run.id);
    await env.orchestrator.idle();
    expect(env.store.runs.get(run.id)!.pendingAction).toBeUndefined();
  });
});

describe('GitHub downloads', () => {
  it('only follow redirects to GitHub itself, never to the local machine', async () => {
    const store = new Store(':memory:');
    const redirected = (async () => { const r = new Response('x', { status: 200 }); Object.defineProperty(r, 'url', { value: 'http://127.0.0.1:9/evil.zip' }); return r; }) as unknown as typeof fetch;
    await expect(new SkillLibrary(tmp('data'), store.skills, redirected).fromGitHub('https://github.com/o/r')).rejects.toThrow(/máy lạ/);
  });
});
