import { afterEach, describe, expect, it } from 'vitest';
import { nextStep, type NextStep } from '../src/core/nextstep.js';
import { recipeHash } from '../src/core/qualityevidence.js';
import type { CheckResult, Finding, MatrixRow, Run, RunDetail, StopCode } from '../src/shared/types.js';
import { setup } from './helpers.js';
import { cleanupFixtures, v4Fixture } from './v4-fixtures.js';

afterEach(cleanupFixtures);

type Input = Parameters<typeof nextStep>[0];
const blockedRun = (over: Partial<Run> = {}): Run => ({ ...setup().create({ mode: 'verify' }), status: 'blocked', checkpoint: 'c'.repeat(40), ...over });
const input = (run: Run, over: Partial<Input> = {}): Input => ({ run, findings: [], checks: [], artifacts: [], matrix: [], authorDraft: undefined, testRepair: undefined, pendingPaths: [], ...over });
const failingCheck = (run: Run, recipeId = 'unit'): CheckResult => ({
  id: `chk_${recipeId}`, runId: run.id, recipeId, checkpoint: run.checkpoint!, contractVersion: run.contract.version, status: 'failed', attempts: [], testIds: [], missingTestIds: [], required: true,
  requirementIds: [], quarantined: false, valid: true, createdAt: '', slot: 'A', configHash: recipeHash(run),
});
const row = (over: Partial<MatrixRow> = {}): MatrixRow => ({ requirementId: 'R-1', text: 'x', required: true, manual: false, status: 'unverified', evidence: [], ...over });
const finding = (run: Run, over: Partial<Finding> = {}): Finding => ({ id: 'fnd_1', runId: run.id, category: 'behavior', severity: 'major', title: 'Không xử lý đoạn văn nhiều câu', location: 'src/lib/parser.ts', evidence: 'e', suggestion: 's', status: 'open', confirmed: false, checkpoint: 'c', contractVersion: run.contract.version, createdAt: '', ...over });

/** Every answer has the same shape: one move that gets things going, at most two others, and no raw test id in any sentence. */
const wellFormed = (step: NextStep | undefined): NextStep => {
  expect(step).toBeDefined();
  expect(step!.primary.id).toBeTruthy();
  expect(step!.others.length).toBeLessThanOrEqual(2);
  expect(step!.others.map(o => o.id)).not.toContain(step!.primary.id);
  expect(`${step!.title} ${step!.why} ${step!.after.join(' ')}`).not.toMatch(/@json:|@junit:/);
  return step!;
};

describe('what a person is told to do, from the state a run is really in', () => {
  it('says nothing while a run is working or finished', () => {
    for (const status of ['draft', 'queued', 'running', 'awaiting_approval', 'awaiting_acceptance', 'completed'] as const) expect(nextStep(input(blockedRun({ status })))).toBeUndefined();
  });

  it('leaves a test correction or paths waiting for approval to the panels that already handle them', () => {
    expect(nextStep(input(blockedRun(), { pendingPaths: ['src/outside.ts'] }))).toBeUndefined();
  });

  it.each<[StopCode, NextStep['code'], boolean]>([
    ['setup_failed', 'setup_failed', true], ['capacity', 'capacity', true], ['quota', 'quota', true], ['interrupted', 'interrupted', true], ['user_stop', 'user_stop', true],
  ])('a stop outside the evidence (%s) is told apart by its code, not by its sentence', (stopCode, code, resumeChanges) => {
    const step = wellFormed(nextStep(input(blockedRun({ stopCode, blocker: 'một câu bất kỳ không liên quan' }))));
    expect(step.code).toBe(code);
    expect(step.resumeChanges).toBe(resumeChanges);
  });

  it('sends a setup failure to the project settings, not to "Chạy tiếp"', () => {
    const step = wellFormed(nextStep(input(blockedRun({ stopCode: 'setup_failed', status: 'failed' }))));
    expect(step.primary.id).toBe('edit_project');
    expect(step.others).toEqual([]);
  });

  it('puts a failing required check first, with the free way to check again', () => {
    const run = blockedRun();
    const step = wellFormed(nextStep(input(run, { checks: [failingCheck(run, 'e2e')] })));
    expect(step).toMatchObject({ code: 'checks_failing', resumeChanges: true });
    expect(step.primary).toMatchObject({ id: 'resume', cost: 'ai' });
    expect(step.others).toEqual([{ id: 'recheck', label: 'Chạy lại kiểm tra', cost: 'free' }]);
    expect(step.why).toContain('“e2e”');
  });

  it('asks for the requirement, not for another run, when it has no test behind it', () => {
    const step = wellFormed(nextStep(input(blockedRun(), { matrix: [row({ requirementId: 'R-3' }), row({ requirementId: 'R-4', status: 'verified' }), row({ requirementId: 'R-5', manual: true })] })));
    expect(step).toMatchObject({ code: 'evidence_missing', resumeChanges: false });
    expect(step.why).toContain('R-3');
    expect(step.why).not.toContain('R-4');
    expect(step.why).not.toContain('R-5');
  });

  it('asks Verifier to look at a checkpoint it has not seen, and spends no more than that', () => {
    const step = wellFormed(nextStep(input(blockedRun())));
    expect(step).toMatchObject({ code: 'verifier_pending', resumeChanges: true });
    expect(step.primary).toMatchObject({ id: 'resume', cost: 'ai' });
  });

  it('falls back to the old sentence, readable, for anything it does not know', () => {
    const run = blockedRun({ qualityPolicyVersion: 3, blocker: '@json:["a.test.ts",["suite","[R-1] works"]]: failed' });
    const step = wellFormed(nextStep(input(run)));
    expect(step.code).toBe('generic');
    expect(step.why).toContain('“suite › [R-1] works” (a.test.ts)');
  });

  it('puts the older policies on their own rules: a verdict is not needed and an unconfirmed doubt stops nothing', () => {
    const run = blockedRun({ qualityPolicyVersion: 3, blocker: 'dừng' });
    expect(nextStep(input(run))?.code).toBe('generic');
    const doubt = finding(run, { attempted: true });
    expect(nextStep(input(run, { findings: [doubt] }))?.code).toBe('generic');
  });
});

describe('a project whose checks write no test report', () => {
  const reportless = { id: 'test', command: [process.execPath, '-e', 'process.exit(0)'], required: true, timeoutMs: 60000 };

  it('is stopped before any agent is called, and the card sends the person to the project, not to the contract', async () => {
    const f = await v4Fixture({ project: { checks: [reportless] } });
    const d = f.orch.detail(f.run.id);
    expect(d.run.status).toBe('blocked');
    expect(f.calls).toEqual([]);
    const step = wellFormed(d.nextStep);
    expect(step).toMatchObject({ code: 'project_check_no_report', resumeChanges: true });
    expect(step.primary.id).toBe('edit_project');
    expect(step.why).toContain('“test”');
  }, 90000);

  it('goes on to planning once the project has a check with a report, with no other step', async () => {
    const f = await v4Fixture({ project: { checks: [reportless] } });
    const project = f.store.projects.get('prj_test')!;
    f.store.projects.put({ ...project, version: project.version + 1, checks: [{ ...reportless, reportPath: '.aidept-report.json' }] });
    f.orch.resumeRun(f.run.id);
    await f.orch.idle();
    expect(f.orch.detail(f.run.id).run.status).toBe('awaiting_approval');
    expect(f.calls).toContain('author:plan');
  }, 90000);

  it('is caught at approval too, for a run that was planned before the project changed', async () => {
    const f = await v4Fixture();
    const run = f.store.runs.get(f.run.id)!;
    f.store.runs.put({ ...run, configSnapshot: { ...run.configSnapshot, checks: [reportless] } });
    expect(() => f.orch.approveContract(f.run.id, { contractHash: f.orch.detail(f.run.id).contractReview.contractHash, acknowledgeWarnings: true })).toThrow(/xuất báo cáo test/);
  }, 90000);

  it('gives the Author one new turn when the person changed the project after it failed, and none for a plain resume', async () => {
    const f = await v4Fixture({ authorReply: () => 'Không thể tạo test: manifest không hợp lệ.' });
    await f.approve(f.run.id);
    const authors = () => f.calls.filter((c) => c === 'author').length;
    expect(f.orch.detail(f.run.id).nextStep?.code).toBe('author_stuck');
    expect(authors()).toBe(1);
    f.orch.resumeRun(f.run.id); await f.orch.idle();
    expect(authors()).toBe(1);
    const project = f.store.projects.get('prj_test')!;
    f.store.projects.put({ ...project, version: project.version + 1, checks: project.checks.map((c) => ({ ...c, timeoutMs: c.timeoutMs + 1000 })) });
    f.orch.resumeRun(f.run.id); await f.orch.idle();
    expect(authors()).toBe(2);
    expect(f.orch.detail(f.run.id).events.some((e) => e.type === 'author.reopened')).toBe(true);
  }, 120000);
});

describe('"Chạy tiếp" when the page says it changes nothing', () => {
  it.each<[string, Parameters<typeof v4Fixture>[0]]>([
    ['a finding the Verifier could not prove', { finding: 'prose' }],
    ['a Verifier that would not conclude', { finding: 'none', verdict: 'abstain' }],
    ['an Author that wrote no test', { authorReply: () => 'Không thể tạo test: hợp đồng chưa có ví dụ.' }],
  ])('%s: pressing it calls no agent and leaves the same next step', async (_name, options) => {
    const f = await v4Fixture(options);
    await f.approve(f.run.id);
    const step = f.orch.detail(f.run.id).nextStep!;
    expect(step.resumeChanges).toBe(false);
    const calls = f.calls.length;
    f.orch.resumeRun(f.run.id);
    await f.orch.idle();
    expect(f.calls.length).toBe(calls);
    expect(f.orch.detail(f.run.id).nextStep?.code).toBe(step.code);
  }, 90000);
});

describe('the same answers on runs that really stopped', () => {
  it('a finding the Verifier could not prove: look at it and decide, or close it', async () => {
    const f = await v4Fixture({ finding: 'prose' });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    expect(d.run.status, d.run.blocker ?? '').toBe('blocked');
    const step = wellFormed(d.nextStep);
    expect(step).toMatchObject({ code: 'finding_open', resumeChanges: false });
    expect(step.primary.id).toBe('review_findings');
    expect(step.others[0]).toMatchObject({ id: 'close_finding', findingId: d.findings[0]!.id });
  }, 90000);

  it('after the person asked for a repair: the move that is left is theirs, to close it once they have tried it', async () => {
    const f = await v4Fixture({ finding: 'prose' });
    await f.approve(f.run.id);
    const id = f.orch.detail(f.run.id).findings[0]!.id;
    f.orch.confirmFinding(f.run.id, id, { manualReason: 'Đã đọc: đúng là câu nhiều câu không được tách ra.' });
    const step = wellFormed(f.orch.detail(f.run.id).nextStep);
    expect(step.code).toBe('finding_open');
    expect(step.primary).toMatchObject({ id: 'close_finding', findingId: id, cost: 'free' });
    expect(step.resumeChanges).toBe(false);
  }, 90000);

  it('a Verifier that would not conclude: Single or a better contract, and it says that "Chạy tiếp" changes nothing', async () => {
    const f = await v4Fixture({ finding: 'none', verdict: 'abstain' });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    const step = wellFormed(d.nextStep);
    expect(d.run.status, d.run.blocker ?? '').toBe('blocked');
    expect(step).toMatchObject({ code: 'verifier_inconclusive', resumeChanges: false });
    expect(step.primary.id).toBe('switch_single');
    expect(step.others.map(o => o.id)).toEqual(['revise_contract']);
  }, 90000);

  it('an Author that wrote no test: the contract, not a repair of an empty draft', async () => {
    const f = await v4Fixture({ authorReply: () => 'Không thể tạo test: hợp đồng chưa có ví dụ cho blockedBy.' });
    await f.approve(f.run.id);
    const step = wellFormed(f.orch.detail(f.run.id).nextStep);
    expect(step).toMatchObject({ code: 'author_stuck', resumeChanges: false });
    expect(step.primary.id).toBe('revise_contract');
  }, 90000);

  it('a setup command that fails: the project settings', async () => {
    const f = await v4Fixture({ project: { setupCommand: [process.execPath, '-e', 'process.exit(2)'] } });
    const d: RunDetail = f.orch.detail(f.run.id);
    expect(d.run.stopCode, d.run.blocker ?? '').toBe('setup_failed');
    expect(wellFormed(d.nextStep).primary.id).toBe('edit_project');
  }, 90000);
});
