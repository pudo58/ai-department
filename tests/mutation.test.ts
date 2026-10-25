import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitWorkspaces } from '../src/runtime/gitworkspace.js';
import { detectMutation } from '../src/runtime/mutationdetect.js';
import { parseMutationReport, runMutation } from '../src/runtime/mutation.js';
import { assertProcessSucceeded, executeFile } from '../src/runtime/process.js';
import { setup } from './helpers.js';

const dependencies = fileURLToPath(new URL('../node_modules', import.meta.url));
const cleanup: string[] = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(path.join(tmpdir(), 'aidept-mutation-test-')); cleanup.push(root); return root; }
async function pkg(root: string, dependencies: object = { vitest: '3.2.4', '@stryker-mutator/core': '9.6.1', '@stryker-mutator/vitest-runner': '9.6.1' }) {
  await mkdir(root, { recursive: true }); await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'mutation-fixture', private: true, type: 'module', devDependencies: dependencies }));
}

describe('read-only mutation capability detection', () => {
  it('supports installed compatible tools and returns installation guidance when absent', async () => {
    const root = await directory(); await pkg(root);
    expect(await detectMutation(root)).toMatchObject({ status: 'missing_tool', root: '.', install: expect.stringContaining('9.6.1') });
    await symlink(dependencies, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await detectMutation(root)).toMatchObject({ status: 'available', adapter: 'stryker-vitest', toolVersion: '9.6.1', vitestVersion: '3.2.4' });
  });
  it('recognizes unsupported stacks, monorepo candidates and explicit selection without executing scripts', async () => {
    const root = await directory(); await writeFile(path.join(root, 'pyproject.toml'), '[project]\nname="python"');
    expect((await detectMutation(root)).status).toBe('unsupported');
    await pkg(path.join(root, 'packages/a')); await pkg(path.join(root, 'packages/b'));
    expect(await detectMutation(root)).toMatchObject({ status: 'ambiguous', candidates: ['packages/a', 'packages/b'] });
    expect(await detectMutation(root, 'packages/b')).toMatchObject({ status: 'missing_tool', root: 'packages/b' });
    expect((await detectMutation(root, '../outside')).status).toBe('ambiguous');
    expect((await detectMutation(root, 'absent')).status).toBe('unsupported');
  });
  it('rejects incompatible installed versions rather than claiming the adapter is available', async () => {
    const root = await directory(); await pkg(root);
    for (const [name, version] of [['vitest', '1.0.0'], ['@stryker-mutator/core', '9.6.1'], ['@stryker-mutator/vitest-runner', '9.6.1']]) {
      const dir = path.join(root, 'node_modules', name!); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
    }
    expect((await detectMutation(root)).status).toBe('missing_tool');
  });
  it('does not follow package symlinks outside the project', async () => {
    const root = await directory(), outside = await directory(); await pkg(outside);
    await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await detectMutation(root)).status).toBe('unsupported');
  });
});

describe('mutation report states', () => {
  it('the watchdog terminates mutation workers after the parent server disappears', async () => {
    const worker = fileURLToPath(new URL('../src/runtime/mutation-worker.cjs', import.meta.url));
    const out = await executeFile(process.execPath, [worker, '99999999', process.execPath, '-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 4000 });
    expect(out.timedOut).toBe(false);
    expect(out.exitCode).not.toBe(0);
  });
  it('keeps failures, timeouts, compile errors and unexecuted mutations separate', () => {
    const states = ['Killed', 'Survived', 'NoCoverage', 'Timeout', 'CompileError', 'RuntimeError', 'Pending', 'Ignored', 'FutureStatus'];
    const r = parseMutationReport({ files: { 'src/a.ts': { mutants: states.map(status => ({ status, location: { start: { line: 1 } }, mutatorName: 'Conditional' })) } } });
    expect(r.counts).toEqual({ killed: 1, survived: 1, no_coverage: 1, timeout: 1, errors: 2, pending: 3 });
    expect(() => parseMutationReport({})).toThrow();
    expect(() => parseMutationReport({ files: { bad: {} } })).toThrow();
  });
});

async function mutationFixture() {
  const root = await directory(), source = path.join(root, 'project'); await pkg(source);
  await mkdir(path.join(source, 'src')); await mkdir(path.join(source, 'tests'));
  await writeFile(path.join(source, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(source, 'src/price.js'), 'export function eligible(n) { return n > 10; }\n');
  await writeFile(path.join(source, 'tests/price.test.js'), "import { it, expect } from 'vitest'; import { eligible } from '../src/price.js'; it('[R-1][C-1] ordinary', () => { expect(eligible(20)).toBe(true); });\n");
  const git = async (...args: string[]) => assertProcessSucceeded(await executeFile('git', ['-c', 'core.hooksPath=/dev/null', '-C', source, ...args], { timeoutMs: 10_000 }), 'git fixture');
  await git('init', '-q'); await git('config', 'core.autocrlf', 'false'); await git('add', '.'); await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'base');
  const e = setup({}, { repository: source }), run = e.create({ mode: 'verify' });
  const ws = new GitWorkspaces(path.join(root, 'data')), prepared = await ws.clone(run, 'A'); run.baseSha = prepared.baseSha;
  await rm(path.join(prepared.ws, 'node_modules'), { recursive: true, force: true });
  await symlink(dependencies, path.join(prepared.ws, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(prepared.ws, 'src/price.js'), 'export function eligible(n) { return n >= 5; }\n');
  run.checkpoint = await ws.commit(run, 'A', 'feature');
  return { ...e, root, source, ws, run, directory: prepared.ws, capability: await detectMutation(prepared.ws) };
}

describe('real Stryker/Vitest fixture', () => {
  it('runs a nested package whose tools are hoisted into an intermediate workspace directory', async () => {
    const f = await mutationFixture(), packageRoot = path.join(f.directory, 'packages/price');
    await mkdir(packageRoot, { recursive: true });
    for (const name of ['src', 'tests', 'package.json']) await rename(path.join(f.directory, name), path.join(packageRoot, name));
    await rename(path.join(f.directory, 'node_modules'), path.join(f.directory, 'packages/node_modules'));
    f.run.configSnapshot.mutationRoot = 'packages/price';
    f.run.checkpoint = await f.ws.commit(f.run, 'A', 'nested workspace');
    const capability = await detectMutation(f.directory, f.run.configSnapshot.mutationRoot);
    expect(capability.status).toBe('available');
    const events: string[] = [];
    const result = await runMutation(f.ws, { run: f.run, slot: 'A', capability, timeoutMs: 27_000, onEvent: e => events.push(e.message ?? '') });
    const evidence = path.resolve('test-results/reliability'); await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, 'mutation-monorepo.json'), JSON.stringify({ result, log: events.join('') }, null, 2));
    expect(result.status, `${result.message}\n${events.join('')}`).toBe('completed');
    expect(result.baseline).toBe('passed');
    expect(result.files).toEqual(['packages/price/src/price.js']);
    expect(result.counts.killed + result.counts.survived + result.counts.no_coverage).toBeGreaterThan(0);
    expect((await f.ws.changes(f.run, 'A')).files).toEqual([]);
    expect(await readFile(path.join(f.source, 'src/price.js'), 'utf8')).toContain('n > 10');
  }, 60_000);
  it('distinguishes weak assertions from a boundary assertion and leaves the candidate and original unchanged', async () => {
    const f = await mutationFixture();
    expect(f.capability.status).toBe('available');
    const original = await readFile(path.join(f.source, 'src/price.js'), 'utf8'), candidate = await readFile(path.join(f.directory, 'src/price.js'), 'utf8');
    const weak = await runMutation(f.ws, { run: f.run, slot: 'A', capability: f.capability, timeoutMs: 27_000 });
    expect(weak.message).not.toMatch(/baseline.*không đạt/i);
    expect(weak.status, weak.message).toBe('completed'); expect(weak.baseline).toBe('passed');
    expect(weak.counts.survived + weak.counts.no_coverage).toBeGreaterThan(0);
    await writeFile(path.join(f.directory, 'tests/price.test.js'), "import { it, expect } from 'vitest'; import { eligible } from '../src/price.js'; it('[R-1][C-1] boundary', () => { expect(eligible(5)).toBe(true); expect(eligible(4)).toBe(false); expect(eligible(20)).toBe(true); });\n");
    f.run.checkpoint = await f.ws.commit(f.run, 'A', 'strong assertion');
    const strong = await runMutation(f.ws, { run: f.run, slot: 'A', capability: f.capability, timeoutMs: 27_000 });
    expect(strong.status, strong.message).toBe('completed');
    expect(strong.counts.survived + strong.counts.no_coverage).toBeLessThan(weak.counts.survived + weak.counts.no_coverage);
    expect(strong.counts.killed).toBeGreaterThan(weak.counts.killed);
    const evidence = path.resolve('test-results/reliability'); await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'mutation-fixture.json'), JSON.stringify({ weak, strong }, null, 2));
    expect(await readFile(path.join(f.directory, 'src/price.js'), 'utf8')).toBe(candidate);
    expect(await readFile(path.join(f.source, 'src/price.js'), 'utf8')).toBe(original);
    expect((await f.ws.changes(f.run, 'A')).files).toEqual([]);
  }, 60_000);
  it.each(['timeout', 'baselineFail', 'abort'] as const)('keeps %s incomplete or failed and restores the candidate', async kind => {
    const f = await mutationFixture(), controller = new AbortController();
    const result = await runMutation(f.ws, { run: f.run, slot: 'A', capability: f.capability, signal: controller.signal }, async () => {
      if (kind === 'abort') { controller.abort(); throw new Error('interrupted'); }
      return { exitCode: kind === 'baselineFail' ? 1 : null, stdout: '', stderr: 'fixture failure', timedOut: kind === 'timeout', durationMs: 1 };
    });
    expect(result.status).toBe(kind === 'baselineFail' ? 'error' : 'incomplete');
    expect(result.counts.killed).toBe(0);
    expect((await f.ws.changes(f.run, 'A')).files).toEqual([]);
  });
});
