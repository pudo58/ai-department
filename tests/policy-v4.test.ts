import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { policyOf, policyForVersion } from '../src/core/policy.js';
import { EVIDENCE_POLICY_V4 } from '../src/shared/regression.js';
import { DRAFT_PLAN_MARKER, manifestFindings, testPlanFindings } from '../src/core/testplan.js';
import { draftTestPlan, normalizeTestPlan } from '../src/core/planfix.js';
import { initialContract } from '../src/core/contract.js';
import { DiagnosisSchema, diagnosisProblems, normalizeDiagnosis } from '../src/core/diagnosis.js';
import { assertionCorrectionProblems, setupRepairProblems } from '../src/core/authoring.js';
import { blocksCompletion } from '../src/core/findings.js';
import { regressionDirOf, regressionRecipe } from '../src/core/regression.js';
import { identityId } from '../src/core/testids.js';
import type { TaskContract } from '../src/shared/types.js';
import type { Run } from '../src/shared/types.js';
import { REQUIREMENT, authorEntries, cleanupFixtures, plan, v4Fixture } from './v4-fixtures.js';

afterEach(cleanupFixtures);
import { fence } from './quality-fixtures.js';

const contract = (testPlan = plan()): TaskContract => ({ ...initialContract(REQUIREMENT), testPlan });
const runOf = (version: 3 | 4, c = contract()): Run => ({ qualityPolicyVersion: version, mode: 'verify', contract: c, originalRequirement: REQUIREMENT, approvedPaths: [], configSnapshot: { modules: ['src', 'tests'], protectedPaths: [], checks: [] } } as unknown as Run);

describe('the v4 policy is one frozen record, not scattered conditions', () => {
  const saved = process.env.AIDEPT_AUTO_TEST_REPAIR;
  afterEach(() => { if (saved === undefined) delete process.env.AIDEPT_AUTO_TEST_REPAIR; else process.env.AIDEPT_AUTO_TEST_REPAIR = saved; });
  it('never lets the environment turn on automatic test repair for v4, and leaves older policies as they were', () => {
    process.env.AIDEPT_AUTO_TEST_REPAIR = '1';
    expect(policyOf({ qualityPolicyVersion: 4, evidencePolicy: EVIDENCE_POLICY_V4 })).toMatchObject({ strict: true, autoTestRepair: false, completePlan: false, derivedManifest: false, groundDiagnosis: false, lenientFindings: false, regression: true, verdictRequired: true });
    expect(policyForVersion(3)).toMatchObject({ strict: false, autoTestRepair: true, completePlan: true, derivedManifest: true, groundDiagnosis: true, regression: false });
    // The policy does not read the environment (the page asks it too); the server applies the switch where it acts.
    process.env.AIDEPT_AUTO_TEST_REPAIR = '0';
    expect(policyForVersion(3).autoTestRepair).toBe(true);
    expect(policyForVersion(2)).toMatchObject({ structured: true, reasoning: false, authorRepair: false });
  });
  it('freezes the replay limits that were promised (3 probes, 30 s each, 60 s per batch)', () => {
    expect(EVIDENCE_POLICY_V4.replay).toEqual({ maxProbes: 3, probeMs: 30_000, batchMs: 60_000 });
    expect(policyForVersion(4).replay).toEqual(EVIDENCE_POLICY_V4.replay);
  });
});

describe('plan validation under v4 turns form defects into blockers instead of notes', () => {
  const broken = () => {
    const p = plan();
    const c = p.cases[0]!;
    c.oracle!.references[0]!.quote = 'a sentence the contract never says';
    c.steps![1]!.before = '';
    c.steps![1]!.requirementIds = [];
    delete c.invariants;
    p.notApplicable = p.notApplicable.slice(1);
    return contract(p);
  };
  const oneStep = () => { const p = plan(); p.cases[0]!.steps = [p.cases[0]!.steps![0]!]; return contract(p); };
  it('reports every one of them as blocking for v4 and keeps v3 as advisories', () => {
    const strict = testPlanFindings(broken(), true, true, true), soft = testPlanFindings(broken(), true, true, false);
    const text = strict.blocking.join('\n');
    expect(text).toContain('không có trong điều khoản');
    expect(text).toContain('thiếu trạng thái trước/sau');
    expect(text).toContain('thiếu điều khoản trong căn cứ');
    // A weak chain of states is shown at approval and in the report, but is not what the v4 policy refuses to approve.
    expect(testPlanFindings(oneStep(), true, true, true).advisories.join(' ')).toContain('ít nhất hai bước');
    expect(testPlanFindings(oneStep(), true, true, true).blocking.join(' ')).not.toContain('ít nhất hai bước');
    expect(strict.advisories.join(' ')).toContain('bất biến');
    expect(text).toContain('Chưa xét nhóm');
    expect(soft.blocking.join('\n')).not.toContain('không có trong điều khoản');
    expect(soft.advisories.join('\n')).toContain('không có trong điều khoản');
  });
  it('does not accept a plan the server wrote: the draft stays invalid until a person removes its label', () => {
    const c = initialContract(REQUIREMENT);
    const draft = draftTestPlan(c, ['Which dependency wins on a tie?']);
    const findings = testPlanFindings({ ...c, testPlan: draft }, true, true, true);
    expect(findings.blocking.join(' ')).toContain(DRAFT_PLAN_MARKER);
    expect(findings.blocking.join(' ')).toContain('câu hỏi chưa giải quyết');
    expect(draft.questions).toEqual(['Which dependency wins on a tie?']);
    const rewritten = structuredClone(draft);
    for (const k of rewritten.cases) { k.oracle!.explanation = 'The requirement fixes which dependency is named.'; k.steps = k.steps!.map(s => ({ ...s, before: 'a', after: 'b' })); }
    rewritten.questions = [];
    expect(testPlanFindings({ ...c, testPlan: rewritten }, true, true, true).blocking.join(' ')).not.toContain(DRAFT_PLAN_MARKER);
  });
  it('keeps the Author’s priority and contradictory "not applicable" line for a person to decide', () => {
    const raw = { schemaVersion: 2, cases: [{ id: 'C-1', priority: 'high', required: false, group: 'happy', method: 'automated', requirementIds: ['R-1'] }], notApplicable: [{ group: 'happy', reason: 'x' }], questions: [] };
    const soft = normalizeTestPlan(raw, initialContract('x'), false), strict = normalizeTestPlan(raw, initialContract('x'), true);
    expect((soft.value as { cases: { required: boolean }[] }).cases[0]!.required).toBe(true);
    expect((strict.value as { cases: { required: boolean }[] }).cases[0]!.required).toBe(false);
    expect((strict.value as { notApplicable: unknown[] }).notApplicable).toHaveLength(1);
    expect((soft.value as { notApplicable: unknown[] }).notApplicable).toHaveLength(0);
  });
  it('rejects a manifest guessed from titles and a required step with no assertion', () => {
    const c = contract(), entries = authorEntries();
    expect(manifestFindings(c, entries, [{ id: 'test', reportPath: 'r' }], ['tests/scheduler.test.js'], { strict: true }).blocking).toEqual([]);
    expect(manifestFindings(c, entries, [{ id: 'test', reportPath: 'r' }], ['tests/scheduler.test.js'], { derived: true, strict: true }).blocking.join(' ')).toContain('suy ra từ tên test');
    const partial = authorEntries().map(e => ({ ...e, assertions: e.assertions.slice(0, 1) }));
    expect(manifestFindings(c, partial, [{ id: 'test', reportPath: 'r' }], ['tests/scheduler.test.js'], { strict: true }).blocking.join(' ')).toContain('C-1.S-2: bước bắt buộc chưa có assertion');
    expect(manifestFindings(c, partial, [{ id: 'test', reportPath: 'r' }], ['tests/scheduler.test.js']).blocking.join(' ')).not.toContain('C-1.S-2');
  });
});

describe('diagnosis is judged as written under v4', () => {
  const failed = identityId({ kind: 'json', file: 'tests/scheduler.test.js', titles: ['[R-1][C-1] blocked metadata'] });
  const claim = (over: Record<string, unknown> = {}) => DiagnosisSchema.parse({ decision: 'test_assertion', reason: 'r', evidence: 'e', caseIds: ['C-1'],
    assessment: { target: 'source', testConformsToContract: true, expected: 'B', actual: 'A', location: 'src/scheduler.js:1', failingTestIds: [failed], oracle: { references: [{ requirementId: 'R-1', quote: 'a quotation that is not in the clause' }], explanation: 'x' } },
    assertionChanges: [{ caseId: 'C-1', before: 'expect(a).toBe(1)', after: 'expect(a).toBe(2)', oracle: { references: [{ requirementId: 'R-1', quote: 'also not there' }], explanation: 'x' } }], ...over });
  const ctx = { failingCaseIds: ['C-1'], testPaths: ['tests/scheduler.test.js'], changedPaths: ['tests/scheduler.test.js'], failedTestIds: [failed] };
  it('does not restate the target, the conformity, the location or the quotations to make a contradiction pass', () => {
    const v4 = normalizeDiagnosis(runOf(4), claim(), ctx), v3 = normalizeDiagnosis(runOf(3), claim(), ctx);
    expect(v4.diagnosis.assessment).toMatchObject({ target: 'source', testConformsToContract: true, location: 'src/scheduler.js:1' });
    expect(v4.diagnosis.assessment!.oracle.references[0]!.quote).toBe('a quotation that is not in the clause');
    expect(v4.notes).toEqual([]);
    expect(diagnosisProblems(runOf(4), v4.diagnosis, ['C-1'], [failed], ['tests/scheduler.test.js'], ['tests/scheduler.test.js']).join(' ')).toContain('testConformsToContract=false');
    expect(v3.diagnosis.assessment).toMatchObject({ target: 'test', testConformsToContract: false });
    expect(v3.notes.length).toBeGreaterThan(0);
  });
  it('still maps a readable test title to the runner id, which is only a name', () => {
    const named = claim({ assessment: { ...claim().assessment!, failingTestIds: ['[R-1][C-1] blocked metadata'] } });
    expect(normalizeDiagnosis(runOf(4), named, ctx).diagnosis.assessment!.failingTestIds).toEqual([failed]);
  });
});

describe('which check hosts generated regressions', () => {
  const vitest = (id: string) => ({ id, command: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json'], required: true, timeoutMs: 1000, reportPath: 'r.json' });
  it('needs exactly one Vitest check with a report, and a safe folder', () => {
    expect(regressionRecipe({ checks: [vitest('unit')] })).toMatchObject({ recipe: { id: 'unit' } });
    expect(regressionRecipe({ checks: [vitest('unit'), vitest('e2e')] })).toMatchObject({ unsupported: expect.stringContaining('nhiều check Vitest') });
    expect(regressionRecipe({ checks: [vitest('unit'), vitest('e2e')], regressionRecipe: 'e2e' })).toMatchObject({ recipe: { id: 'e2e' } });
    expect(regressionRecipe({ checks: [{ ...vitest('lint'), reportPath: undefined }] })).toMatchObject({ unsupported: expect.stringContaining('chưa có check Vitest') });
    expect(regressionRecipe({ checks: [{ ...vitest('watch'), command: ['npx', 'vitest'] }] })).toMatchObject({ unsupported: expect.any(String) });
    expect(regressionRecipe({ checks: [vitest('unit')], regressionDir: '../outside' })).toMatchObject({ unsupported: expect.stringContaining('đường dẫn tương đối') });
    expect(regressionDirOf({})).toBe('tests/aidept-regressions');
    expect(regressionDirOf({ regressionDir: 'tests\\guards/' })).toBe('tests/guards');
  });
});

describe('a test correction may change only what it declared', () => {
  const before = `import {it,expect} from 'vitest';\nit('[R-1][C-1] a',()=>{\n const s=make();\n expect(s.get()).toBe('A');\n expect(s.other()).toBe(2);\n});\n`;
  it('lets a setup correction change the setup and nothing it asserts', () => {
    expect(setupRepairProblems('t.test.js', before, before.replace('make()', 'make({seed:1})'))).toEqual([]);
    expect(setupRepairProblems('t.test.js', before, before.replace("toBe('A')", "toBe('B')")).join(' ')).toContain('assertion');
    expect(setupRepairProblems('t.test.js', before, before.replace("expect(s.other()).toBe(2);\n", '')).join(' ')).toContain('assertion');
    expect(setupRepairProblems('t.test.js', before, before.replace('[R-1][C-1] a', '[R-1][C-1] renamed')).join(' ')).toContain('tên');
  });
  it('lets an assertion correction change exactly the declared assertions, from their stated before to after', () => {
    const change = { before: "expect(s.get()).toBe('A')", after: "expect(s.get()).toBe('B')" };
    const ok = assertionCorrectionProblems('t.test.js', before, before.replace("toBe('A')", "toBe('B')"), [change]);
    expect(ok).toEqual({ problems: [], used: [expect.any(String)] });
    expect(assertionCorrectionProblems('t.test.js', before, before.replace("toBe('A')", "toBe('B')").replace('toBe(2)', 'toBe(3)'), [change]).problems.join(' ')).toContain('khác với đúng các thay đổi');
    expect(assertionCorrectionProblems('t.test.js', before, before.replace("toBe('A')", "toBe('B')").replace('make()', 'make(1)'), [change]).problems.join(' ')).toContain('setup');
    expect(assertionCorrectionProblems('t.test.js', before, before.replace("toBe('A')", "toBe('C')"), [change]).problems.join(' ')).toContain('khác với đúng các thay đổi');
    expect(assertionCorrectionProblems('t.test.js', before, before, [change]).used).toEqual([expect.any(String)]);
  });
});

describe('an unproven doubt keeps blocking under v4', () => {
  const doubt = { severity: 'major' as const, status: 'open' as const, attempted: true, confirmed: false };
  it('only the older policies let one automatic repair round turn it into a warning', () => {
    expect(blocksCompletion(doubt)).toBe(false);
    expect(blocksCompletion(doubt, true)).toBe(true);
    expect(blocksCompletion({ ...doubt, status: 'resolved' }, true)).toBe(true);
    expect(blocksCompletion({ ...doubt, status: 'resolved', resolution: { kind: 'manual_review', at: 'now', reason: 'checked by hand' } }, true)).toBe(false);
    expect(blocksCompletion({ severity: 'minor', status: 'open' }, true)).toBe(false);
  });
});

describe('planning never fills in what the Author did not write (v4)', () => {
  it('an unreadable Author answer leaves a labelled draft that cannot be approved, and no fallback is recorded', async () => {
    const f = await v4Fixture({ planReply: () => 'Xin lỗi, tôi không trả JSON.' });
    const d = f.orch.detail(f.run.id), p = d.run.contract.testPlan!;
    expect(d.run.status).toBe('awaiting_approval');
    expect(JSON.stringify(p)).toContain(DRAFT_PLAN_MARKER);
    expect(d.planReview!.outcome).toBe('invalid_output');
    expect(d.planReview!.remainingProblems.join(' ')).toContain(DRAFT_PLAN_MARKER);
    expect(d.artifacts.filter(a => a.title === 'Pipeline fallback')).toHaveLength(0);
    expect(d.contractReview.problems.join(' ')).toContain(DRAFT_PLAN_MARKER);
    expect(() => f.orch.approveContract(f.run.id, { contractHash: d.contractReview.contractHash, acknowledgeWarnings: true })).toThrow(/bản nháp/);
    // The raw answer is kept so it can be read and corrected.
    expect(d.artifacts.some(a => a.kind === 'raw' && a.content.includes('Xin lỗi'))).toBe(true);
    f.store.close();
  }, 60000);

  it('keeps a wrong quotation, a missing group and an open question exactly as written', async () => {
    const f = await v4Fixture({ planReply: contract => {
      const p = plan(); p.cases[0]!.oracle!.references[0]!.quote = 'blockedBy points at whatever it likes';
      p.notApplicable = p.notApplicable.slice(2); p.questions = ['Which dependency wins on a tie?'];
      void contract; return fence(p);
    } });
    const d = f.orch.detail(f.run.id), c = d.run.contract.testPlan!.cases[0]!;
    expect(c.oracle!.references[0]!.quote).toBe('blockedBy points at whatever it likes');
    expect(d.run.contract.testPlan!.questions).toEqual(['Which dependency wins on a tie?']);
    expect(d.run.contract.assumptions.join(' ')).not.toContain('tie');
    expect(d.planReview!.remainingProblems.join('\n')).toMatch(/không có trong điều khoản/);
    expect(d.planReview!.remainingProblems.join('\n')).toMatch(/câu hỏi chưa giải quyết/);
    expect(d.artifacts.filter(a => a.title === 'Pipeline fallback')).toHaveLength(0);
    expect(() => f.orch.approveContract(f.run.id, { contractHash: d.contractReview.contractHash, acknowledgeWarnings: true })).toThrow();
    f.store.close();
  }, 60000);
});

describe('a diagnosis never edits tests by itself and never hands a contradiction to the Developer (v4)', () => {
  const failedId = identityId({ kind: 'json', file: 'tests/scheduler.test.js', titles: ['[R-1][C-1] blocked metadata'] });
  const claim = (x: { run: Run }, over: Record<string, unknown> = {}) => fence({ decision: 'test_assertion', reason: 'The contract names B after only B is cancelled; the test expects A.', evidence: 'Runner expected A but received B.', caseIds: ['C-1'],
    assessment: { target: 'test', testConformsToContract: false, expected: 'blockedBy is B', actual: 'test asserts A, runner receives B', location: 'tests/scheduler.test.js:12', failingTestIds: [failedId], oracle: x.run.contract.testPlan!.cases[0]!.oracle },
    assertionChanges: [{ caseId: 'C-1', before: "expect(s.get('C').blockedBy).toBe('A')", after: "expect(s.get('C').blockedBy).toBe('B')", oracle: x.run.contract.testPlan!.cases[0]!.oracle }], ...over });
  const edit = (dir: string, more = (s: string) => s) => { const file = path.join(dir, 'tests/scheduler.test.js'); writeFileSync(file, more(readFileSync(file, 'utf8').replace("blockedBy).toBe('A')", "blockedBy).toBe('B')"))); };
  const savedAuto = process.env.AIDEPT_AUTO_TEST_REPAIR;
  afterEach(() => { if (savedAuto === undefined) delete process.env.AIDEPT_AUTO_TEST_REPAIR; else process.env.AIDEPT_AUTO_TEST_REPAIR = savedAuto; });
  const developers = (calls: string[]) => calls.filter(c => c === 'developer').length;
  const diagnoses = (calls: string[]) => calls.filter(c => c === 'author:diagnose').length;

  it('leaves a well-grounded correction as a proposal even when the environment asks for automatic repair, and applies it only on the exact hash', async () => {
    process.env.AIDEPT_AUTO_TEST_REPAIR = '1';
    const f = await v4Fixture({ wrongAssertion: true, finding: 'none', diagnosis: (x, dir) => { edit(dir); return claim(x); } });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id), p = d.testRepair!;
    expect(d.run.status, d.run.blocker ?? '').toBe('blocked');
    expect(p).toMatchObject({ kind: 'assertion', caseIds: ['C-1'] });
    expect(d.run.testRepairApproval).toBeUndefined();
    expect(d.artifacts.filter(a => a.title === 'Test repair receipt')).toHaveLength(0);
    expect(developers(f.calls)).toBe(1);
    expect(readFileSync(path.join(f.workspace(), 'tests/scheduler.test.js'), 'utf8')).toContain("toBe('A')");
    const api = await f.app();
    expect((await api.post(`/api/runs/${f.run.id}/approve-test-repair`, { proposalId: p.id, proposalHash: '0'.repeat(64) })).statusCode).toBe(409);
    expect((await api.post(`/api/runs/${f.run.id}/approve-test-repair`, { proposalId: p.id, proposalHash: p.hash })).statusCode).toBe(200);
    await f.orch.idle();
    const after = f.orch.detail(f.run.id);
    expect(after.run.status, after.run.blocker ?? '').toBe('awaiting_acceptance');
    expect(JSON.parse(after.artifacts.filter(a => a.title === 'Test repair receipt').at(-1)!.content).source).toBe('human_approved');
    expect(developers(f.calls)).toBe(1);
    expect(readFileSync(path.join(f.workspace(), 'tests/scheduler.test.js'), 'utf8')).toContain("blockedBy).toBe('B')");
    await api.close(); f.store.close();
  }, 180000);

  it.each([
    ['changes another assertion as well', (x: { run: Run }, dir: string) => { edit(dir, s => s.replace("status).toBe('ready')", "status).toBe('pending')")); return claim(x); }],
    ['says "setup" but edits an assertion', (x: { run: Run }, dir: string) => { edit(dir); return claim(x, { decision: 'test_setup', assertionChanges: undefined }); }],
    ['adds a test of its own', (x: { run: Run }, dir: string) => { edit(dir, s => s + "\nit('[R-1][C-1] extra',()=>{ expect(1).toBe(1); });\n"); return claim(x); }],
  ])('stops, with the reason, when the Author %s: no proposal, no Developer', async (_name, script) => {
    const f = await v4Fixture({ wrongAssertion: true, finding: 'none', diagnosis: (x, dir) => script(x, dir) });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    expect(d.run.status).toBe('blocked');
    expect(d.testRepair).toBeUndefined();
    expect(d.run.blocker).toContain('Chẩn đoán test dừng ở đây');
    expect(d.run.blocker).toContain('Developer không được gọi');
    expect(d.artifacts.some(a => a.title === 'Author test proposal rejected')).toBe(true);
    expect(d.artifacts.filter(a => a.title === 'Pipeline fallback')).toHaveLength(0);
    expect(developers(f.calls)).toBe(1);
    f.store.close();
  }, 120000);

  it('stops on a self-contradicting diagnosis after the one allowed correction; resume cannot buy another or call the Developer', async () => {
    const contradictory = (x: { run: Run }) => claim(x, { assessment: { target: 'source', testConformsToContract: true, expected: 'B', actual: 'A', location: 'src/scheduler.js:1', failingTestIds: [failedId], oracle: x.run.contract.testPlan!.cases[0]!.oracle } });
    const f = await v4Fixture({ wrongAssertion: true, finding: 'none', diagnosis: x => contradictory(x) });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    expect(d.run.status).toBe('blocked');
    expect(d.run.blocker).toContain('Chẩn đoán Author không hợp lệ');
    expect(d.artifacts.filter(a => a.title === 'Author diagnosis correction attempt')).toHaveLength(1);
    expect(diagnoses(f.calls)).toBe(2);
    expect(developers(f.calls)).toBe(1);
    // The card says what the blocker says: "Chạy tiếp" changes nothing here, the plan in the contract does.
    expect(d.nextStep).toMatchObject({ code: 'diagnosis_stopped', resumeChanges: false, primary: { id: 'revise_contract' } });
    f.orch.resumeRun(f.run.id); await f.orch.idle();
    expect(diagnoses(f.calls)).toBe(2);
    expect(developers(f.calls)).toBe(1);
    expect(f.orch.detail(f.run.id).run.status).toBe('blocked');
    expect(f.orch.detail(f.run.id).nextStep?.code).toBe('diagnosis_stopped');
    f.store.close();
  }, 120000);

  it('stops, rather than guessing the code is wrong, when the Author cannot say whether the test is right', async () => {
    const f = await v4Fixture({ wrongAssertion: true, finding: 'none', diagnosis: x => claim(x, { decision: 'ambiguous', assertionChanges: undefined, assessment: { target: 'unknown', testConformsToContract: null, expected: 'B?', actual: 'A', location: 'tests/scheduler.test.js:12', failingTestIds: [failedId], oracle: x.run.contract.testPlan!.cases[0]!.oracle } }) });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    expect(d.run.status).toBe('blocked');
    expect(d.run.blocker).toContain('chưa chắc');
    expect(d.run.blocker).toContain('Developer không được gọi');
    expect(d.nextStep).toMatchObject({ code: 'diagnosis_stopped', resumeChanges: false, primary: { id: 'revise_contract' } });
    expect(d.nextStep!.others.map(o => o.id)).toEqual(['switch_single']);
    expect(developers(f.calls)).toBe(1);
    f.store.close();
  }, 120000);
});

describe('acceptance needs the Verifier’s verdict for this checkpoint (v4)', () => {
  it.each([['abstain', 'từ chối kết luận'], ['garbage', 'không đọc được']] as const)('is blocked when the verdict is %s, and ticking warnings cannot pass it', async (verdict, text) => {
    const f = await v4Fixture({ finding: 'none', verdict });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    expect(d.run.status).toBe('blocked');
    expect(d.completion.reasons.join(' ')).toContain(text);
    await expect(f.orch.acceptRun(f.run.id, { acknowledgeWarnings: true })).rejects.toThrow(/Run chưa sẵn sàng|Chưa đủ điều kiện/);
    f.store.close();
  }, 120000);
  it('is ready with a real pass verdict, and the report names no repaired finding that was not proven', async () => {
    const f = await v4Fixture({ finding: 'none' });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    expect(d.run.status, d.run.blocker ?? '').toBe('awaiting_acceptance');
    expect(d.completion.ready).toBe(true);
    expect(d.findingProofs).toEqual([]);
    expect(d.artifacts.filter(a => a.title === 'Pipeline fallback')).toHaveLength(0);
    f.store.close();
  }, 120000);
});

