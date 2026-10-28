import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { detectStack } from '../src/core/stackdetect.js';
import { planAngularCheck } from '../src/runtime/angularcheck.js';
import { probeEnvironment } from '../src/runtime/preflight.js';
import { setup } from './helpers.js';

const dirs: string[] = [];
const OLD = ['npm', 'test', '--', '--run', '--reporter=json', '--outputFile=.aidept-report.json'];
const FIXED = ['npm', 'test', '--', '--watch=false', '--reporters=json', '--output-file=.aidept-report.json'];
function repo(script = 'ng test', builder = '@angular/build:unit-test', runner = 'vitest') {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidept-angular-')); dirs.push(dir);
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: script }, dependencies: { '@angular/core': '^21.2.0' }, devDependencies: { vitest: '^4.0.8' } }));
  writeFileSync(path.join(dir, 'angular.json'), JSON.stringify({ projects: { demo: { architect: { test: { builder, options: { runner } } } } } }));
  writeFileSync(path.join(dir, 'src/app.spec.ts'), "it('[R-1] works', () => {});"); return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) { if (path.dirname(dir) !== path.resolve(tmpdir()) || !path.basename(dir).startsWith('aidept-angular-')) throw new Error('Unexpected Angular test folder'); rmSync(dir, { recursive: true, force: true }); } });

describe('Angular tests are run through their builder', () => {
  it('suggests Angular reporter flags despite a Vitest dependency', async () => {
    const detection = await detectStack(repo());
    expect(detection.checks.find(c => c.id === 'test')).toMatchObject({ command: FIXED, reportPath: '.aidept-report.json', label: 'Angular (Vitest)' });
  });
  it('adapts an existing wrong recipe without modifying it or losing filters', async () => {
    const original = [...OLD, '--include=src/app.spec.ts'];
    const plan = await planAngularCheck(original, repo('ng test demo'));
    expect(plan.command).toEqual([...FIXED, '--include=src/app.spec.ts']); expect(original).toEqual([...OLD, '--include=src/app.spec.ts']); expect(plan.note).toBeTruthy();
    expect((await planAngularCheck(FIXED, repo())).command).toEqual(FIXED);
  });
  it('does not reinterpret a real Vitest command or a prefix targeting another project', async () => {
    expect((await planAngularCheck(OLD, repo('vitest run'))).command).toEqual(OLD);
    const prefixed = [...OLD, '--prefix=client']; expect((await planAngularCheck(prefixed, repo())).command).toEqual(prefixed);
  });
  it.each([['@angular-devkit/build-angular:karma', 'karma'], ['@angular/build:unit-test', 'karma']])('does not claim a JSON report for unsupported %s/%s', async (builder, runner) => {
    const dir = repo('ng test', builder, runner);
    expect((await detectStack(dir)).checks.find(c => c.id === 'test')?.reportPath).toBeUndefined();
    expect((await planAngularCheck(OLD, dir)).problem).toBeTruthy();
  });
  it('preflights Angular discovery, preserves config and blocks a CLI startup failure', async () => {
    const cwd = repo(), { create } = setup(), run = create();
    run.configSnapshot.checks = [{ id: 'test', command: OLD, required: true, timeoutMs: 60000, reportPath: '.aidept-report.json' }];
    const calls: string[][] = [];
    const green = await probeEnvironment(run, cwd, 'local', async command => { calls.push(command); return { exitCode: 0, stdout: 'src/app.spec.ts', stderr: '', durationMs: 1, timedOut: false }; });
    expect(green.status).toBe('passed'); expect(calls).toHaveLength(1); expect(calls[0]).toEqual(expect.arrayContaining(['--list-tests', '--watch=false', '--reporters=json'])); expect(calls[0]).not.toContain('--run');
    expect(run.configSnapshot.checks[0]!.command).toEqual(OLD);
    const blocked = await probeEnvironment(run, cwd, 'local', async () => ({ exitCode: 1, stdout: '', stderr: 'Unknown arguments: output-file', durationMs: 1, timedOut: false }));
    expect(blocked.status).toBe('blocked'); expect(blocked.checks[0]?.message).toContain('Unknown arguments');
    const empty = await probeEnvironment(run, cwd, 'local', async () => ({ exitCode: 1, stdout: '', stderr: 'No test files found.', durationMs: 1, timedOut: false }));
    expect(empty.status).toBe('unsupported'); expect(empty.checks[0]?.message).toContain('Author');
  });
});
