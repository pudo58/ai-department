import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCodexCommand, resolveHostCommand, type HostEnv } from '../src/runtime/hostcommand.js';
import { LocalRuntime } from '../src/runtime/local.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import { profile } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const win: HostEnv = { platform: 'win32', nodeExec: 'C:\\node\\node.exe', exists: () => true };

describe('host command resolution', () => {
  it('maps npm/npx to node + the bundled npm scripts on Windows, and leaves other platforms alone', () => {
    expect(resolveHostCommand(['npm', 'ci'], win)).toEqual(['C:\\node\\node.exe', 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js', 'ci']);
    expect(resolveHostCommand(['npx.cmd', 'vitest', 'run'], win)[1]).toMatch(/npx-cli\.js$/);
    expect(resolveHostCommand(['npm', 'ci'], { ...win, platform: 'linux' })).toEqual(['npm', 'ci']);
    expect(resolveHostCommand(['node', 'x.js'], win)).toEqual(['node', 'x.js']);
  });
  it('refuses Windows shims with a usable hint instead of failing opaquely', () => {
    expect(() => resolveHostCommand(['pnpm', 'test'], win)).toThrow(/npx/);
    expect(() => resolveHostCommand(['build.cmd'], win)).toThrow(/\.cmd/);
    expect(() => resolveHostCommand(['npm'], { ...win, exists: () => false })).toThrow(/Không tìm thấy/);
    expect(() => resolveHostCommand([], win)).toThrow();
  });
  it('finds Codex via override, then .tools, and explains how to install it otherwise', () => {
    expect(resolveCodexCommand('C:\\p', { ...win, exists: (p) => p === 'X.js' }, 'X.js')).toEqual(['C:\\node\\node.exe', 'X.js']);
    expect(resolveCodexCommand('C:\\p', { ...win, exists: (p) => p.includes('.tools') }, undefined)[1]).toMatch(/\.tools.*codex\.js$/);
    expect(() => resolveCodexCommand('C:\\p', { ...win, exists: () => false }, undefined)).toThrow(/npm install --prefix/);
  });
});

describe('local runtime end to end (host process, scripted Codex)', () => {
  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidept-local-repo-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src', 'sum.mjs'), 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n');
    // Stands in for a test runner: runs the behaviour check and writes a Vitest-shaped report.
    writeFileSync(path.join(dir, 'check.mjs'), "import { sumTo } from './src/sum.mjs';\nimport { writeFileSync } from 'node:fs';\nconst ok = sumTo(3) === 6 && sumTo(0) === 0;\nwriteFileSync('.aidept-report.json', JSON.stringify({ testResults: [{ name: 'check', status: ok ? 'passed' : 'failed', assertionResults: [{ fullName: '[R-1] sumTo includes n', title: 'x', status: ok ? 'passed' : 'failed', failureMessages: ok ? [] : ['expected 6'] }] }] }));\nprocess.exit(ok ? 0 : 1);\n");
    writeFileSync(path.join(dir, '.gitignore'), '.aidept-report.json\n');
    git(dir, 'init', '-q'); git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    return dir;
  }

  it('edits a clone on this machine, verifies with host-run checks, and only adds a branch to the original repo on acceptance', async () => {
    const source = repo();
    const headBefore = git(source, 'rev-parse', 'HEAD');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-local-data-'));
    const fixture = path.resolve('tests/fixtures/fake-codex.mjs');
    const store = new Store(':memory:');
    store.projects.put(profile({
      repository: source, executionMode: 'local', modules: ['src'],
      checks: [{ id: 'test', command: ['node', 'check.mjs'], required: true, timeoutMs: 60_000, reportPath: '.aidept-report.json' }],
    }));
    const runtime = new LocalRuntime({ dataDir, codexCommand: [process.execPath, fixture] });
    const orchestrator = new Orchestrator(store, () => runtime);
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 'Sửa sumTo', originalRequirement: 'sumTo bỏ sót n', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });

    orchestrator.startRun(run.id); await orchestrator.idle();
    expect(orchestrator.detail(run.id).run.status).toBe('awaiting_approval');
    // Structured acceptance examples from a real model are kept as text rather than rejecting the contract.
    expect(orchestrator.detail(run.id).run.contract.acceptanceExamples[0]).toContain('"output":6');
    orchestrator.approveContract(run.id); await orchestrator.idle();

    const detail = orchestrator.detail(run.id);
    expect(detail.run.status, `${detail.run.blocker}\n${detail.events.map((e) => e.message).join('\n')}`).toBe('awaiting_acceptance');
    expect(detail.matrix[0]!.status).toBe('verified');
    // The agent edited only the clone.
    expect(readFileSync(path.join(source, 'src', 'sum.mjs'), 'utf8')).toContain('i < n');
    expect(git(source, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(source, 'branch', '--list', `aidept/${run.id}-A`)).toBe('');

    await orchestrator.acceptRun(run.id);
    expect(git(source, 'rev-parse', `refs/heads/aidept/${run.id}-A`)).toBe(detail.run.checkpoint);
    expect(git(source, 'status', '--porcelain')).toBe('');
    expect(git(source, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(readFileSync(path.join(source, 'src', 'sum.mjs'), 'utf8')).toContain('i < n');
    expect(git(source, 'show', `aidept/${run.id}-A:src/sum.mjs`)).toContain('i <= n');
    expect(existsSync(path.join(dataDir, 'workspaces', `${run.id}-A`))).toBe(true);
  }, 120_000);

  it('never overwrites an existing branch when delivering', async () => {
    const source = repo();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-local-data-'));
    const store = new Store(':memory:');
    store.projects.put(profile({ repository: source, executionMode: 'local', checks: [{ id: 'test', command: ['node', 'check.mjs'], required: true, timeoutMs: 60_000, reportPath: '.aidept-report.json' }] }));
    const runtime = new LocalRuntime({ dataDir });
    const orchestrator = new Orchestrator(store, () => runtime);
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 't', originalRequirement: 'r', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    await runtime.prepare({ ...run, baseSha: null }, 'A');
    git(source, 'branch', `aidept/${run.id}-A`);
    await expect(runtime.deliver(run, 'A')).rejects.toThrow(/đã tồn tại/);
  }, 60_000);
});

describe('a repo with no test script: node --test, JUnit and re-checking without the agent', () => {
  function bareRepo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidept-bare-repo-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bare', private: true, type: 'module' }));
    writeFileSync(path.join(dir, 'src', 'sum.mjs'), 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n');
    git(dir, 'init', '-q'); git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    return dir;
  }
  const NODE_TEST = ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=.aidept-report.xml', 'tests/*.test.mjs'];

  it('is blocked by the wrong default check, then passes after the check is fixed, with no extra agent run', async () => {
    const source = bareRepo();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-bare-data-'));
    const store = new Store(':memory:');
    store.projects.put(profile({ repository: source, executionMode: 'local', modules: ['src', 'tests'], checks: [{ id: 'test', command: ['npm', 'test'], required: true, timeoutMs: 60_000, reportPath: '.aidept-report.xml' }] }));
    const runtime = new LocalRuntime({ dataDir, codexCommand: [process.execPath, path.resolve('tests/fixtures/fake-codex-nodetest.mjs')] });
    const orchestrator = new Orchestrator(store, () => runtime);
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 'Sửa sumTo', originalRequirement: 'sumTo bỏ sót n', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });

    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id); await orchestrator.idle();
    const blocked = orchestrator.detail(run.id);
    expect(['blocked', 'failed']).toContain(blocked.run.status);
    expect(blocked.completion.ready).toBe(false);
    const developerRuns = blocked.attempts.filter((a) => a.role === 'developer').length;
    expect(developerRuns).toBeGreaterThanOrEqual(1);
    const logLines = store.logs.list({ runId: run.id, source: 'check:test', limit: 200 }).map((l) => l.message).join('\n');
    expect(logLines).toMatch(/Missing script/); // the very line the user saw, now visible in the console

    // Fix the project's check, as a person would from the UI, then re-run only the check.
    const project = store.projects.get('prj_test')!;
    project.checks = [{ ...project.checks[0]!, command: NODE_TEST, reportPath: '.aidept-report.xml' }];
    project.version += 1; project.approved = true;
    store.projects.put(project);
    orchestrator.recheck(run.id); await orchestrator.idle();

    const done = orchestrator.detail(run.id);
    expect(done.run.status, `${done.run.blocker}\n${done.events.map((e) => e.message).join('\n')}`).toBe('awaiting_acceptance');
    expect(done.attempts.filter((a) => a.role === 'developer').length).toBe(developerRuns); // no agent was called
    expect(done.checks.at(-1)).toMatchObject({ status: 'passed', requirementIds: expect.arrayContaining(['R-1', 'R-9']) });
    expect(done.matrix[0]!.status).toBe('verified');
    expect(done.events.some((e) => e.type === 'config.refreshed')).toBe(true);
    expect(git(source, 'status', '--porcelain')).toBe(''); // the report file never leaks into the repo or the diff
  }, 180_000);

  it('a second check without a report (typecheck-style) fails on its exit code, prints its output to the console, gives no evidence, and passes once fixed', async () => {
    const source = bareRepo();
    const store = new Store(':memory:');
    const failing = ['node', '-e', 'console.error("src/sum.mjs(3,5): error TS2322: boom"); process.exit(2)'];
    store.projects.put(profile({ repository: source, executionMode: 'local', modules: ['src', 'tests'], checks: [
      { id: 'test', command: NODE_TEST, required: true, timeoutMs: 60_000, reportPath: '.aidept-report.xml' },
      { id: 'typecheck', command: failing, required: true, timeoutMs: 60_000 },
    ] }));
    const runtime = new LocalRuntime({ dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-bare-data-')), codexCommand: [process.execPath, path.resolve('tests/fixtures/fake-codex-nodetest.mjs')] });
    const orchestrator = new Orchestrator(store, () => runtime);
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 'Sửa sumTo', originalRequirement: 'sumTo bỏ sót n', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id); await orchestrator.idle();

    const blocked = orchestrator.detail(run.id);
    expect(blocked.completion.ready).toBe(false);
    expect(blocked.completion.reasons.join(' ')).toMatch(/typecheck.*fail/);
    expect(blocked.checks.filter((c) => c.recipeId === 'typecheck').every((c) => c.status === 'failed' && c.requirementIds.length === 0 && c.testIds.length === 0)).toBe(true);
    expect(store.logs.list({ runId: run.id, source: 'check:typecheck', limit: 200 }).map((l) => l.message).join('\n')).toMatch(/TS2322: boom/);

    const project = store.projects.get('prj_test')!;
    project.checks = [project.checks[0]!, { id: 'typecheck', command: ['node', '-e', 'console.log("no errors")'], required: true, timeoutMs: 60_000 }];
    project.version += 1; project.approved = true;
    store.projects.put(project);
    orchestrator.recheck(run.id); await orchestrator.idle();
    const done = orchestrator.detail(run.id);
    expect(done.run.status, done.run.blocker ?? '').toBe('awaiting_acceptance');
    expect(done.checks.filter((c) => c.recipeId === 'typecheck').at(-1)).toMatchObject({ status: 'passed', requirementIds: [], testIds: [] });
    expect(done.matrix[0]!.evidence.every((e) => e.startsWith('test @'))).toBe(true);
  }, 180_000);
});
