import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { planNpmSetup } from '../src/core/npmsetup.js';
import { detectStack } from '../src/core/stackdetect.js';
import { LocalRuntime } from '../src/runtime/local.js';
import { resolveHostCommand } from '../src/runtime/hostcommand.js';
import { GitWorkspaces } from '../src/runtime/gitworkspace.js';
import { Store } from '../src/server/store.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { profile } from './helpers.js';
import type { RuntimeEvent } from '../src/runtime/types.js';

const roots: string[] = [];
const temp = () => { const p = mkdtempSync(path.join(tmpdir(), 'aidept-npm-setup-')); roots.push(p); return p; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const npm = (cwd: string, ...args: string[]) => { const [exe, ...argv] = resolveHostCommand(['npm', ...args]); return execFileSync(exe!, argv, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 }); };
afterEach(() => {
  for (const dir of roots.splice(0)) {
    if (path.dirname(dir) !== path.resolve(tmpdir()) || !path.basename(dir).startsWith('aidept-npm-setup-')) throw new Error('Unexpected npm test directory');
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture(locked: boolean) {
  const source = temp();
  mkdirSync(path.join(source, 'src'));
  writeFileSync(path.join(source, 'package.json'), '{"name":"setup-fixture","version":"1.0.0","private":true}');
  writeFileSync(path.join(source, 'src/index.js'), 'module.exports = 1;');
  writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(source, '.gitattributes'), '* -text\n');
  if (locked) npm(source, 'install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund');
  git(source, 'init', '-q'); git(source, 'add', '-A'); git(source, '-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'base');
  return source;
}
function runtimeFor(source: string, setupCommand = ['npm', 'install']) {
  const dataDir = temp(), runtime = new LocalRuntime({ dataDir }), store = new Store(':memory:');
  store.projects.put(profile({ repository: source, executionMode: 'local', setupCommand }));
  const orchestrator = new Orchestrator(store, () => runtime);
  const run = orchestrator.createRun({ projectId: 'prj_test', title: 'setup', originalRequirement: 'Keep existing behavior', mode: 'single', provider: 'codex', budgetUsd: 1, signals: [] });
  return { runtime, run, workspace: new GitWorkspaces(dataDir).dir(run, 'A') };
}

describe('npm setup does not change source', () => {
  it('keeps explicit package additions, custom flags, ci and other package managers as configured', () => {
    for (const cmd of [['npm', 'install', 'react'], ['npm', 'install', '--prefix', 'client'], ['npm', 'install', '--package-lock=true'], ['npm', 'ci'], ['npx', 'pnpm', 'install']]) expect(planNpmSetup(cmd, false).command).toEqual(cmd);
    expect(planNpmSetup(['npm', 'i', '--offline'], false).command).toEqual(['npm', 'install', '--package-lock=false', '--offline']);
  });
  it('suggests install without a lockfile side effect, and ci for shrinkwrap', async () => {
    const source = fixture(false);
    expect((await detectStack(source)).setupCommand).toEqual(['npm', 'install', '--package-lock=false']);
    writeFileSync(path.join(source, 'npm-shrinkwrap.json'), '{}');
    expect((await detectStack(source)).setupCommand).toEqual(['npm', 'ci']);
  });
  it.each([false, true])('prepares an existing npm-install profile with a real npm, lockfile=%s', async locked => {
    const source = fixture(locked), { runtime, run, workspace } = runtimeFor(source);
    const before = locked ? readFileSync(path.join(source, 'package-lock.json'), 'utf8') : undefined;
    const events: RuntimeEvent[] = [];
    await runtime.prepare(run, 'A', event => events.push(event));
    expect(git(workspace, 'status', '--porcelain')).toBe('');
    expect(git(source, 'status', '--porcelain')).toBe('');
    expect(existsSync(path.join(workspace, 'package-lock.json'))).toBe(locked);
    if (locked) expect(readFileSync(path.join(workspace, 'package-lock.json'), 'utf8')).toBe(before);
    expect(events.some(e => e.message.includes(locked ? 'npm ci' : 'không tạo package-lock.json'))).toBe(true);
    expect(run.configSnapshot.setupCommand).toEqual(['npm', 'install']);
  }, 60000);
  it('still blocks a custom setup that modifies tracked source', async () => {
    const source = fixture(false), { runtime, run } = runtimeFor(source, ['node', '-e', 'require("fs").writeFileSync("src/index.js", "unexpected")']);
    await expect(runtime.prepare(run, 'A')).rejects.toThrow(/Setup command/);
    expect(readFileSync(path.join(source, 'src/index.js'), 'utf8')).toBe('module.exports = 1;');
  }, 30000);
});
