import { describe, expect, it } from 'vitest';
import { initialContract } from '../src/core/contract.js';
import { DiagnosisSchema, diagnosisProblems, normalizeDiagnosis } from '../src/core/diagnosis.js';
import { authorRepairSourceProblems } from '../src/core/authoring.js';
import { manifestFindings, StoredManifestSchema } from '../src/core/testplan.js';
import { blocksCompletion, needsAutoRepair } from '../src/core/findings.js';
import type { Finding } from '../src/shared/types.js';
import { reasoningPlan } from './reasoning-fixtures.js';
import { setup } from './helpers.js';

const runWithContract = () => {
  const run = setup().create({ mode: 'verify' });
  const base = initialContract('Claim each ready job once.');
  run.contract = { ...base, testPlan: reasoningPlan(base) };
  run.originalRequirement = 'Original text: claim each ready job once, in order.';
  return run;
};
const failedId = '@json:' + JSON.stringify(['tests/queue.test.js', ['suite', '[R-1][C-1] claims once']]);
const ctx = { failingCaseIds: ['C-1'], testPaths: ['tests/queue.test.js'], changedPaths: ['tests/queue.test.js'], failedTestIds: [failedId] };
const diagnosis = (over: Record<string, unknown> = {}, assessment: Record<string, unknown> = {}) => DiagnosisSchema.parse({
  decision: 'test_setup', reason: 'The setup claims from the wrong queue.', evidence: 'Runner shows LEASE_LOST at line 12.', caseIds: ['C-1'],
  assessment: { target: 'source', testConformsToContract: true, expected: 'C', actual: 'null', location: 'src/queue.js:10', failingTestIds: ['readable title that is not the runner id'],
    oracle: { references: [{ requirementId: 'R-1', quote: 'Never said this' }, { requirementId: 'R-77', quote: 'unknown clause' }], explanation: 'R-1 requires C.' }, ...assessment },
  assertionChanges: [], ...over,
});

describe('normalizeDiagnosis', () => {
  it('restates the redundant fields of a "the test is wrong" diagnosis from the runner facts, so it is no longer thrown away', () => {
    const run = runWithContract(), raw = diagnosis();
    expect(diagnosisProblems(run, raw, ['C-1'], [failedId], ctx.testPaths, ctx.changedPaths).length).toBeGreaterThan(0);
    const { diagnosis: fixed, notes } = normalizeDiagnosis(run, raw, ctx);
    expect(diagnosisProblems(run, fixed, ['C-1'], [failedId], ctx.testPaths, ctx.changedPaths)).toEqual([]);
    expect(fixed.assessment).toMatchObject({ target: 'test', testConformsToContract: false, location: 'tests/queue.test.js:10', failingTestIds: [failedId] });
    expect(fixed.assessment!.oracle.references).toEqual([{ requirementId: 'R-1', quote: run.contract.requirements[0]!.text }]);
    expect(notes.length).toBeGreaterThan(2);
  });
  it('keeps a quotation that really is in the clause or in the original requirement', () => {
    const run = runWithContract();
    const raw = diagnosis({}, { oracle: { references: [{ requirementId: 'R-1', quote: 'CLAIM each ready job once' }, { requirementId: 'R-1', quote: 'claim each ready job once, in order' }], explanation: 'x' } });
    const { diagnosis: fixed } = normalizeDiagnosis(run, raw, ctx);
    expect(fixed.assessment!.oracle.references.map((r) => r.quote)).toEqual(['CLAIM each ready job once', 'claim each ready job once, in order']);
  });
  it('leaves implementation and ambiguous diagnoses exactly as they were', () => {
    const run = runWithContract();
    for (const decision of ['implementation', 'ambiguous'] as const) {
      const raw = diagnosis({ decision });
      const out = normalizeDiagnosis(run, raw, ctx);
      expect(out.diagnosis).toEqual(raw);
      expect(out.notes).toEqual([]);
    }
  });
  it('does nothing for policies before v3', () => {
    const run = runWithContract();
    run.qualityPolicyVersion = 2;
    expect(normalizeDiagnosis(run, diagnosis(), ctx).notes).toEqual([]);
  });
});

const finding = (over: Partial<Finding> = {}): Finding => ({ id: 'f', runId: 'r', category: 'behavior', severity: 'major', title: 't', location: 'x', evidence: 'e', suggestion: 's', status: 'open', confirmed: false, checkpoint: 'c', contractVersion: 1, createdAt: '', ...over });

describe('findings without a runnable counterexample', () => {
  it('open one automatic repair round, and after it stop blocking', () => {
    expect(needsAutoRepair(finding(), 1)).toBe(true);
    expect(needsAutoRepair(finding({ attempted: true }), 1)).toBe(false);
    expect(blocksCompletion(finding())).toBe(true);
    expect(blocksCompletion(finding({ attempted: true }))).toBe(false);
  });
  it('keep their old rules when a person confirmed them or the runner has a counterexample', () => {
    const reproduction = { scenario: 'x' } as unknown as Finding['reproduction'];
    expect(blocksCompletion(finding({ attempted: true, confirmed: true }))).toBe(true);
    expect(blocksCompletion(finding({ attempted: true, reproduction }))).toBe(true);
    expect(needsAutoRepair(finding({ reproduction }), 1)).toBe(false);
    expect(needsAutoRepair(finding({ confirmed: true }), 1)).toBe(false);
  });
  it('ignore minor, resolved and other-contract findings', () => {
    expect(needsAutoRepair(finding({ severity: 'minor' }), 1)).toBe(false);
    expect(needsAutoRepair(finding({ status: 'resolved' }), 1)).toBe(false);
    expect(needsAutoRepair(finding(), 2)).toBe(false);
    expect(blocksCompletion(finding({ severity: 'minor' }))).toBe(false);
  });
});

describe('manifest repair may add a whole test', () => {
  const before = "describe('s',()=>{test('old',()=>{const q=make();expect(q.a()).toBe(1);});});";
  const added = "describe('s',()=>{test('old',()=>{const q=make();expect(q.a()).toBe(1);});test('new',()=>{const q=make();expect(q.a()).toBe(2);});});";
  it('accepts an added test (for example a missing required case)', () => {
    expect(authorRepairSourceProblems('tests/a.test.js', before, added)).toEqual([]);
  });
  it('still rejects a rewritten or weakened old test, even next to an added one', () => {
    expect(authorRepairSourceProblems('tests/a.test.js', before, added.replace('make()', 'make(5)')).length).toBeGreaterThan(0);
    expect(authorRepairSourceProblems('tests/a.test.js', before, added.replace('expect(q.a()).toBe(1);', '')).length).toBeGreaterThan(0);
    expect(authorRepairSourceProblems('tests/a.test.js', before, added.replace("test('old'", "test('renamed'")).length).toBeGreaterThan(0);
  });
});

describe('derived manifests', () => {
  it('are not blocked for lacking assertion links, and the stored schema keeps the flag', () => {
    const base = initialContract('Claim each ready job once.');
    const contract = { ...base, testPlan: reasoningPlan(base) };
    const entries = [{ caseId: 'C-1', requirementIds: ['R-1'], recipeId: 'test', path: 'tests/q.test.js', identity: { kind: 'json' as const, file: 'tests/q.test.js', titles: ['[R-1][C-1] all jobs'] }, testId: '@json:' + JSON.stringify(['tests/q.test.js', ['[R-1][C-1] all jobs']]) }];
    const recipes = [{ id: 'test', reportPath: 'r.json' }];
    expect(manifestFindings(contract, entries, recipes, ['tests/q.test.js']).blocking.join(' ')).toContain('thiếu liên kết assertion');
    expect(manifestFindings(contract, entries, recipes, ['tests/q.test.js'], { derived: true }).blocking).toEqual([]);
    const stored = StoredManifestSchema.parse({ schemaVersion: 2, source: 'author', contractHash: 'a'.repeat(64), contractVersion: 1, slot: 'A', entries, derived: true });
    expect(stored.derived).toBe(true);
  });
});
