import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanupFixtures, passed, regressionRun, scenario, TITLE, v4Fixture } from './v4-fixtures.js';
import { evidenceBlockers } from '../src/core/findingproof.js';
import { generateRegression } from '../src/core/regression.js';
import { parseJUnit, summarizeCheck } from '../src/core/checks.js';
import { identityId } from '../src/core/testids.js';
import type { Finding, Recipe } from '../src/shared/types.js';

afterEach(cleanupFixtures);

type Fixture = Awaited<ReturnType<typeof v4Fixture>>;
const confirm = async (f: Fixture) => {
  const api = await f.app(), d = f.orch.detail(f.run.id), finding = d.findings[0]!, proposal = d.regressionProposals![0]!;
  const r = await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/confirm`, { proposalHash: proposal.hash });
  expect(r.statusCode, r.body).toBe(200);
  return { api, finding, proposal };
};
const regressions = (f: Fixture) => (f.orch as unknown as { verification: { regressions: {
  applyConfirmed(id: string, t: Finding[]): Promise<void>;
  confirmationValid(run: unknown, f: Finding, a: unknown[]): boolean;
} } }).verification.regressions;

describe('a regression is evidence only when it ran and passed here', () => {
  const delivered = generateRegression({ finding: { id: 'fnd_0b0b0b0b', title: TITLE }, scenario: scenario(), recipeId: 'old-test', dir: 'tests/aidept-regressions' });
  const install = (source: string) => { mkdirSync(path.join(source, 'tests/aidept-regressions'), { recursive: true }); writeFileSync(path.join(source, delivered.path), delivered.source); };

  it('a regression made for a check that was renamed, under a test config that no longer finds it, still stops acceptance', async () => {
    // The project's check is now "test" and only picks up tests/*.test.js; the delivered regression names "old-test" and lives one folder down.
    const f = await v4Fixture({ finding: 'none', fix: false, preinstall: install, include: 'tests/*.test.js' });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    expect(d.regressionFiles?.map(r => r.path)).toEqual([delivered.path]);
    expect(d.run.status).not.toBe('awaiting_acceptance');
    expect(d.completion.ready).toBe(false);
    const said = [d.run.blocker ?? '', ...d.completion.reasons].join(' ');
    expect(said).toContain(delivered.path.split('/').pop()!.replace('.test.js', ''));
    // The check that runs regressions now was told to expect it, so the missing test is named, not silently skipped.
    expect(d.checks.at(-1)!.missingTestIds).toContain(delivered.testId);
    f.store.close();
  }, 120000);

  it('names a regression no current check can run, and the check it was made for', () => {
    const run = regressionRun([{ id: 'unit', command: ['node', '--test'], reportPath: 'r.xml', required: true, timeoutMs: 1000 }]);
    const ref = { path: delivered.path, recipeId: 'old-test', testId: delivered.testId, identity: delivered.identity, findingId: 'fnd_0b0b0b0b', scenarioHash: 'h', intact: true };
    const reasons = evidenceBlockers(run, { verdict: { decision: 'pass' }, findings: [], artifacts: [], regressions: [ref], checks: [passed(run, 'unit', 'other')] });
    expect(reasons.join(' ')).toContain('“old-test”');
    expect(reasons.join(' ')).toContain('không còn check đó');
  });

  it('maps a regression whose check was renamed onto the regression check, and says so while it has not passed', () => {
    const run = regressionRun();
    const ref = { path: delivered.path, recipeId: 'old-test', testId: delivered.testId, identity: delivered.identity, findingId: 'fnd_0b0b0b0b', scenarioHash: 'h', intact: true };
    const input = (checks: ReturnType<typeof passed>[]) => ({ verdict: { decision: 'pass' }, findings: [], artifacts: [], regressions: [ref], checks });
    const missing = evidenceBlockers(run, input([passed(run, 'test', 'something else')])).join(' ');
    expect(missing).toContain('nay chạy bằng check “test”');
    expect(evidenceBlockers(run, input([passed(run, 'test', delivered.testId)]))).toEqual([]);
    // A result from another checkpoint is not a result for this one.
    expect(evidenceBlockers(run, input([{ ...passed(run, 'test', delivered.testId), checkpoint: 'd'.repeat(40) }])).join(' ')).toContain('chưa có kết quả đạt');
  });
});

describe('a confirmation survives a stop between locking the regression and the Developer', () => {
  it('resumes the repair on the commit that added exactly the confirmed test, and still refuses any other checkpoint', async () => {
    const f = await v4Fixture();
    await f.approve(f.run.id);
    const { api } = await confirm(f);
    // The server stops right after the regression was applied, committed and locked, with the repair still pending.
    await regressions(f).applyConfirmed(f.run.id, f.orch.detail(f.run.id).findings);
    const applied = f.orch.detail(f.run.id);
    f.store.runs.put({ ...applied.run, status: 'paused', pendingAction: 'repair', blocker: 'Server dừng.' });
    const finding = f.store.findings.list(f.run.id)[0]!, artifacts = f.store.artifacts.list(f.run.id);
    expect(regressions(f).confirmationValid(f.store.runs.get(f.run.id)!, finding, artifacts)).toBe(true);
    expect(regressions(f).confirmationValid({ ...f.store.runs.get(f.run.id)!, checkpoint: 'e'.repeat(40) }, finding, artifacts)).toBe(false);
    const developers = f.calls.filter(c => c === 'developer').length;
    f.orch.resumeRun(f.run.id); await f.orch.idle();
    const d = f.orch.detail(f.run.id);
    expect(d.run.status, d.run.blocker ?? '').toBe('awaiting_acceptance');
    expect(f.calls.filter(c => c === 'developer').length).toBe(developers + 1);
    expect(d.findings[0]).toMatchObject({ status: 'resolved', resolution: { kind: 'verified_fix' } });
    // Applied once: the resume did not add the test a second time.
    expect(readdirSync(path.join(f.workspace(), 'tests/aidept-regressions'))).toHaveLength(1);
    await api.close(); f.store.close();
  }, 240000);
});

describe('the regression is tried on its own clone, never on the candidate', () => {
  it('leaves nothing a trial wrote in the candidate, and removes the clone', async () => {
    // A test config that writes into node_modules, and only when the regression file is on the command line.
    const marker = (source: string) => writeFileSync(path.join(source, 'vitest.config.mjs'),
      "import {mkdirSync,writeFileSync} from 'node:fs';\nif(process.argv.some(a=>a.includes('aidept-regressions'))){mkdirSync('node_modules',{recursive:true});writeFileSync('node_modules/.trial-marker','x');}\nexport default {test:{include:['tests/**/*.test.js'],maxWorkers:1,fileParallelism:false}};");
    const f = await v4Fixture({ preinstall: marker });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    expect(d.regressionProposals![0]!.trial?.status).toBe('failed_as_expected');
    expect(existsSync(path.join(f.workspace(), 'node_modules/.trial-marker'))).toBe(false);
    expect(existsSync(path.join(f.workspace(), d.regressionProposals![0]!.path!))).toBe(false);
    expect(readdirSync(path.dirname(f.workspace())).filter(n => n.includes('-regtrial-'))).toEqual([]);
    f.store.close();
  }, 180000);
});

describe('JUnit reports that also name the file', () => {
  const recipe = { id: 'pytest', command: ['pytest'], required: true, timeoutMs: 1000, reportPath: 'report.xml' } as Recipe;
  const green = { exitCode: 0, log: '', incomplete: false, durationMs: 1, checkpoint: 'cp' };
  // pytest --junitxml (xunit1): classname is the module path, and every testcase names its file and line.
  const pytest = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="2" time="0.1" hostname="h">
<testcase classname="tests.test_cart" name="test_total" file="tests/test_cart.py" line="3" time="0.01"/>
<testcase classname="tests.test_cart" name="test_empty" file="tests/test_cart.py" line="9" time="0.01"/></testsuite></testsuites>`;

  it('still meets a manifest that locked the classname/name identity', () => {
    const locked = [identityId({ kind: 'junit', className: 'tests.test_cart', name: 'test_total' }), identityId({ kind: 'junit', className: 'tests.test_cart', name: 'test_empty' })];
    const check = summarizeCheck({ runId: 'r', id: 'c', recipe, checkpoint: 'cp', contractVersion: 1, lockedTestIds: locked, structuredIds: true, reportRoot: '/w' }, [{ ...green, report: pytest }]);
    expect((check.issues ?? []).filter(i => i.kind === 'test_missing')).toEqual([]);
    expect(check.status).toBe('passed');
    expect(check.testIds).toEqual(expect.arrayContaining(locked));
  });

  it('meets a file/titles identity just as well, and never lets one locked id stand for two tests', () => {
    const byFile = identityId({ kind: 'json', file: 'tests/test_cart.py', titles: ['pytest', 'test_total'] });
    const check = summarizeCheck({ runId: 'r', id: 'c', recipe, checkpoint: 'cp', contractVersion: 1, lockedTestIds: [byFile], structuredIds: true, reportRoot: '/w' }, [{ ...green, report: pytest }]);
    expect(check.missingTestIds).toEqual([]);
    const twice = pytest.replace('name="test_empty"', 'name="test_total"');
    const ambiguous = summarizeCheck({ runId: 'r', id: 'c', recipe, checkpoint: 'cp', contractVersion: 1, lockedTestIds: [identityId({ kind: 'junit', className: 'tests.test_cart', name: 'test_total' })], structuredIds: true, reportRoot: '/w' }, [{ ...green, report: twice }]);
    expect(ambiguous.status).not.toBe('passed');
    expect(parseJUnit(pytest).tests[0]!.alternates).toEqual([{ kind: 'junit', className: 'tests.test_cart', name: 'test_total' }]);
  });
});

describe('a generated TypeScript regression passes the project\'s strict typecheck', () => {
  it('declares its types, imports the module the way tsc accepts, and still fails on the differing step under Vitest', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidept-ts-reg-'));
    try {
      mkdirSync(path.join(dir, 'src')); mkdirSync(path.join(dir, 'node_modules'));
      symlinkSync(path.resolve('node_modules/vitest'), path.join(dir, 'node_modules/vitest'), 'junction');
      writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noUnusedLocals: true, noUnusedParameters: true, noImplicitReturns: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', skipLibCheck: true, types: [] }, include: ['src', 'tests'] }));
      writeFileSync(path.join(dir, 'src/scheduler.ts'), [
        'type Job = { id: string; dependsOn?: string[]; status: string; blockedBy?: string };',
        'export function createScheduler() {',
        '  const jobs = new Map<string, Job>();',
        '  return {',
        "    submit(x: { id: string; dependsOn?: string[] }) { jobs.set(x.id, { ...x, status: 'ready' }); return { token: 1 }; },",
        "    cancel(id: string) { jobs.get(id)!.status = 'cancelled'; for (const j of jobs.values()) { if (j.status === 'blocked' || j.status === 'cancelled') continue; const bad = (j.dependsOn ?? []).find(d => jobs.get(d)?.status === 'cancelled'); if (bad) { j.status = 'blocked'; j.blockedBy = bad; } } },",
        '    get(id: string) { return JSON.parse(JSON.stringify(jobs.get(id))) as Job; },',
        '  };',
        '}',
      ].join('\n'));
      const generated = generateRegression({ finding: { id: 'fnd_0c0c0c0c', title: TITLE }, scenario: { ...scenario(), module: 'src/scheduler.ts' }, recipeId: 'test', dir: 'tests/aidept-regressions' });
      expect(generated.path.endsWith('.test.ts')).toBe(true);
      mkdirSync(path.join(dir, 'tests/aidept-regressions'), { recursive: true });
      writeFileSync(path.join(dir, generated.path), generated.source);
      const tsc = spawnSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', dir], { encoding: 'utf8' });
      expect(`${tsc.stdout}${tsc.stderr}`).toBe('');
      expect(tsc.status).toBe(0);
      const vitest = spawnSync(process.execPath, [path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--root', dir, generated.path], { encoding: 'utf8', cwd: dir });
      expect(vitest.status).not.toBe(0);
      expect(`${vitest.stdout}${vitest.stderr}`).toContain('AIDEPT-REG:S-6');
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }, 120000);

  it('refuses to offer a test that breaks a required check which passed on the checkpoint', async () => {
    // A required check (no report) that fails as soon as any file appears in the regression folder stands for a strict typecheck.
    const guard = { id: 'typecheck', command: [process.execPath, '-e', "process.exit(require('fs').existsSync('tests/aidept-regressions')?2:0)"], required: true, timeoutMs: 60000 };
    const f = await v4Fixture({ project: { checks: [
      { id: 'test', command: [process.execPath, path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'runner', '--reporter=json', '--outputFile=.aidept-report.json'], required: true, reportPath: '.aidept-report.json', timeoutMs: 60000 },
      guard,
    ] } });
    await f.approve(f.run.id);
    const proposal = f.orch.detail(f.run.id).regressionProposals![0]!;
    expect(proposal.trial?.status, proposal.trial?.message).toBe('breaks_checks');
    expect(proposal.trial?.message).toContain('“typecheck”');
    const api = await f.app();
    const r = await api.post(`/api/runs/${f.run.id}/findings/${proposal.findingId}/confirm`, { proposalHash: proposal.hash });
    expect(r.statusCode).toBe(400);
    await api.close(); f.store.close();
  }, 180000);
});

describe('what a person is told right after confirming a finding', () => {
  it('sends a confirmed, replayable finding to the repair, not to a manual close', async () => {
    const f = await v4Fixture();
    await f.approve(f.run.id);
    const { api, finding } = await confirm(f);
    const step = f.orch.detail(f.run.id).nextStep!;
    expect(step.code).toBe('finding_open');
    expect(step.primary).toMatchObject({ id: 'repair_findings', cost: 'ai' });
    expect([step.primary, ...step.others].map(a => a.id)).not.toContain('close_finding');
    expect(step.why).not.toContain('không có cách');
    expect(finding.id).toBeTruthy();
    await api.close(); f.store.close();
  }, 180000);
});
