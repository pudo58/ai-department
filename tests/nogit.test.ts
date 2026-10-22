import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitWorkspaces } from '../src/runtime/gitworkspace.js';
import { LocalRuntime } from '../src/runtime/local.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import { profile } from './helpers.js';
import type { Run } from '../src/shared/types.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const NODE_TEST = ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=.aidept-report.xml', 'tests/*.test.mjs'];
const BUGGY = 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n';

/** `init` = a git repo with no commit yet; `none` = a plain folder. */
function project(kind: 'init' | 'none'): string {
  const dir = mkdtempSync(path.join(tmpdir(), `aidept-${kind}-src-`));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'nogit', private: true, type: 'module' }));
  writeFileSync(path.join(dir, 'src', 'sum.mjs'), BUGGY);
  writeFileSync(path.join(dir, '.gitignore'), 'secret.env\n');
  writeFileSync(path.join(dir, 'secret.env'), 'TOKEN=abc');
  mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), 'big');
  if (kind === 'init') git(dir, 'init', '-q');
  return dir;
}

function harness(source: string, withProject = true) {
  const store = new Store(':memory:');
  if (withProject) store.projects.put(profile({ repository: source, executionMode: 'local', modules: ['src', 'tests'], checks: [{ id: 'test', command: NODE_TEST, required: true, timeoutMs: 60_000, reportPath: '.aidept-report.xml' }] }));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-nogit-data-'));
  const runtime = new LocalRuntime({ dataDir, codexCommand: [process.execPath, path.resolve('tests/fixtures/fake-codex-nodetest.mjs')] });
  const orchestrator = new Orchestrator(store, () => runtime);
  const create = () => orchestrator.createRun({ projectId: 'prj_test', title: 'Sửa sumTo', originalRequirement: 'sumTo bỏ sót n', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
  return { store, dataDir, orchestrator, create };
}

describe.each([['init', 'a git repository with no commits'], ['none', 'a folder that is not a git repository']] as const)('project that is %s (%s)', (kind, _label) => {
  it('prepares a snapshot, passes the checks, and on acceptance writes the changed files into the folder without touching git or other files', async () => {
    const source = project(kind);
    const { orchestrator, create, store, dataDir } = harness(source);
    const run = create();
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id); await orchestrator.idle();
    const done = orchestrator.detail(run.id);
    expect(done.run.status, `${done.run.blocker}\n${done.events.map((e) => e.message).join('\n')}`).toBe('awaiting_acceptance');
    expect(done.run.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(done.events.some((e) => /chưa có commit nào hoặc không dùng git/.test(e.message)) || store.logs.list({ runId: run.id, limit: 500 }).some((l) => /chưa có commit nào hoặc không dùng git/.test(l.message))).toBe(true);
    expect(readFileSync(path.join(source, 'src', 'sum.mjs'), 'utf8')).toBe(BUGGY); // untouched until acceptance

    // The snapshot has the tracked content but neither node_modules nor files the project's .gitignore excludes.
    const ws = path.join(dataDir, 'workspaces', `${run.id}-A`);
    expect(existsSync(path.join(ws, 'node_modules', 'x'))).toBe(false); // the project's own node_modules is not copied
    expect(existsSync(path.join(ws, 'secret.env'))).toBe(false);

    await orchestrator.acceptRun(run.id, { acknowledgeWarnings: true });
    expect(store.runs.get(run.id)!.status).toBe('completed');
    expect(orchestrator.detail(run.id).events.some((e) => e.type === 'deliver' && /đã ghi \d+ file/.test(e.message))).toBe(true);
    expect(readFileSync(path.join(source, 'src', 'sum.mjs'), 'utf8')).not.toBe(BUGGY);
    expect(readdirTests(source).length).toBeGreaterThan(0);
    expect(readFileSync(path.join(source, 'secret.env'), 'utf8')).toBe('TOKEN=abc');
    expect(readFileSync(path.join(source, 'node_modules', 'x', 'index.js'), 'utf8')).toBe('big');
    if (kind === 'none') expect(existsSync(path.join(source, '.git'))).toBe(false);
    else expect(git(source, 'branch', '--list')).toBe(''); // still no commits and no new branch
  }, 180_000);

  it('still delivers when the folder holds a copy of a version this task produced (copied out to try it)', async () => {
    const source = project(kind);
    const { orchestrator, create, store, dataDir } = harness(source);
    const run = create();
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id); await orchestrator.idle();
    expect(orchestrator.detail(run.id).run.status).toBe('awaiting_acceptance');
    const ws = path.join(dataDir, 'workspaces', `${run.id}-A`);
    writeFileSync(path.join(source, 'src', 'sum.mjs'), readFileSync(path.join(ws, 'src', 'sum.mjs')));
    await orchestrator.acceptRun(run.id, { acknowledgeWarnings: true });
    expect(orchestrator.detail(run.id).events.some((e) => e.type === 'deliver')).toBe(true);
    expect(store.logs.list({ runId: run.id, limit: 500 }).some((l) => /Không giao được kết quả/.test(l.message))).toBe(false);
  }, 180_000);

  it('refuses to overwrite a file the person edited after the task started, and reports why', async () => {
    const source = project(kind);
    const { orchestrator, create, store } = harness(source);
    const run = create();
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id); await orchestrator.idle();
    expect(orchestrator.detail(run.id).run.status).toBe('awaiting_acceptance');
    writeFileSync(path.join(source, 'src', 'sum.mjs'), `${BUGGY}// my own edit\n`);
    await orchestrator.acceptRun(run.id, { acknowledgeWarnings: true });
    expect(readFileSync(path.join(source, 'src', 'sum.mjs'), 'utf8')).toBe(`${BUGGY}// my own edit\n`);
    expect(readdirTests(source)).toEqual([]); // all-or-nothing: no partial write
    const failure = store.logs.list({ runId: run.id, limit: 500 }).find((l) => /Không giao được kết quả/.test(l.message))
      ?? orchestrator.detail(run.id).events.find((e) => e.type === 'deliver.failed');
    expect(failure?.message).toMatch(/xung đột.*src\/sum\.mjs/);
  }, 180_000);
});

const readdirTests = (source: string): string[] => (existsSync(path.join(source, 'tests')) ? readdirSync(path.join(source, 'tests')) : []);

describe('GitWorkspaces with a plain folder', () => {
  it('skips symlinks, keeps the base stable when the folder changes later, and refuses a huge or missing folder', async () => {
    const source = project('none');
    let linked = true;
    try { symlinkSync(tmpdir(), path.join(source, 'link-out'), 'junction'); } catch { linked = false; }
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-ws-'));
    const ws = new GitWorkspaces(dataDir);
    const run = { id: 'run_x', baseSha: null, configSnapshot: { repository: source } } as unknown as Run;
    const first = await ws.clone(run, 'A');
    if (linked) expect(existsSync(path.join(first.ws, 'link-out'))).toBe(false);
    expect(await ws.sourceKind(source)).toBe('plain');

    writeFileSync(path.join(source, 'src', 'sum.mjs'), 'changed later');
    const second = await ws.clone({ ...run, baseSha: first.baseSha } as Run, 'B');
    expect(second.baseSha).toBe(first.baseSha);
    expect(readFileSync(path.join(second.ws, 'src', 'sum.mjs'), 'utf8')).toBe(BUGGY); // clones come from the run's snapshot

    await expect(ws.clone({ id: 'run_y', baseSha: null, configSnapshot: { repository: path.join(source, 'missing') } } as unknown as Run, 'A')).rejects.toThrow();
  });

  it('a repository with a commit is still cloned directly and delivered as a branch', async () => {
    const source = project('init');
    git(source, 'add', '-A'); git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const ws = new GitWorkspaces(mkdtempSync(path.join(tmpdir(), 'aidept-ws-')));
    expect(await ws.sourceKind(source)).toBe('git');
    const run = { id: 'run_z', baseSha: null, configSnapshot: { repository: source } } as unknown as Run;
    const cloned = await ws.clone(run, 'A');
    expect(cloned.warnings.join(' ')).not.toMatch(/không dùng git/);
    expect(cloned.branch).toBe('aidept/run_z-A');
  });
});

describe('base file list for scaffolding', () => {
  it('lists exactly what the base snapshot contains', async () => {
    const source = project('none');
    const ws = new GitWorkspaces(mkdtempSync(path.join(tmpdir(), 'aidept-ws-')));
    const run = { id: 'run_bf', baseSha: null, configSnapshot: { repository: source } } as unknown as Run;
    const cloned = await ws.clone(run, 'A');
    const files = await ws.baseFiles({ ...run, baseSha: cloned.baseSha } as Run, 'A');
    expect(files).toEqual(expect.arrayContaining(['package.json', 'src/sum.mjs', '.gitignore']));
    expect(files).not.toContain('secret.env');
    expect(files.some((f) => f.startsWith('node_modules'))).toBe(false);
  });
});

describe('npm stays inside the workspace', () => {
  it('a project without package.json is its own npm root, never the folder that holds the data dir', async () => {
    const outer = mkdtempSync(path.join(tmpdir(), 'aidept-outer-'));
    writeFileSync(path.join(outer, 'package.json'), JSON.stringify({ name: 'outer-tool', private: true }));
    const source = project('none');
    execFileSync('git', ['init', '-q'], { cwd: source }); // irrelevant: no commit, so it is snapshotted
    const ws = new GitWorkspaces(path.join(outer, '.data'));
    const run = { id: 'run_np', baseSha: null, configSnapshot: { repository: source } } as unknown as Run;
    const cloned = await ws.clone(run, 'A');
    expect(existsSync(path.join(cloned.ws, 'node_modules'))).toBe(true);
    const { resolveHostCommand } = await import('../src/runtime/hostcommand.js');
    const [cmd, ...args] = resolveHostCommand(['npm', 'prefix']);
    const prefix = execFileSync(cmd!, args, { cwd: cloned.ws, encoding: 'utf8' }).trim();
    expect(path.resolve(prefix)).toBe(path.resolve(cloned.ws));
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: cloned.ws, encoding: 'utf8' }).trim();
    expect(status).toBe(''); // the folder is ignored, never part of a diff
  }, 60_000);
});
