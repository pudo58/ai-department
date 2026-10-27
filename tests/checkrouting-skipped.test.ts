import { describe, expect, it } from 'vitest';
import { routeCheckFailure } from '../src/core/checkrouting.js';
import { hashContract, initialContract, sha256 } from '../src/core/contract.js';
import { recipeHash } from '../src/core/qualityevidence.js';
import type { Artifact, CheckIssue, CheckResult, Run } from '../src/shared/types.js';
import { reasoningPlan } from './reasoning-fixtures.js';
import { setup } from './helpers.js';

const SKIPPED = '@json:["src/lib/acceptance-v2.test.ts",["Contract v2 manual report acceptance","[R-1] review the report"]]';
const FAILED = '@junit:["e2e\\\\expense-ambiguity.spec.ts","[R-7] reject an ambiguous sentence"]';

/** `lockedSkipped`: the skipped test is one the Author locked as evidence for case C-1, not a test the project skips on its own. */
function fixture(lockedSkipped = false) {
  const run: Run = setup().create({ mode: 'verify' });
  run.checkpoint = 'c'.repeat(40);
  run.configSnapshot.checks = ['unit', 'e2e'].map(id => ({ id, command: ['node', 'x'], required: true, reportPath: `${id}.json`, timeoutMs: 1000 }));
  if (lockedSkipped) { const base = initialContract('Claim each ready job once.'); run.contract = { ...base, testPlan: reasoningPlan(base) }; }
  const identity = { kind: 'json' as const, file: 'src/lib/acceptance-v2.test.ts', titles: ['Contract v2 manual report acceptance', '[R-1] review the report'] };
  const entries = lockedSkipped ? [{ caseId: 'C-1', requirementIds: ['R-1'], recipeId: 'unit', path: identity.file, identity, testId: SKIPPED }] : [];
  const content = JSON.stringify({ schemaVersion: lockedSkipped ? 2 : 1, source: 'author', contractHash: hashContract(run.contract), contractVersion: run.contract.version, slot: 'A', entries });
  const manifest: Artifact = { id: 'art_manifest', runId: run.id, kind: 'acceptance', title: 'Test manifest', content, hash: sha256(content), checkpoint: run.checkpoint, contractVersion: run.contract.version, valid: true, createdAt: '' };
  const check = (recipeId: string, over: Partial<CheckResult>): CheckResult => ({
    id: `chk_${recipeId}`, runId: run.id, recipeId, checkpoint: run.checkpoint!, contractVersion: run.contract.version, status: 'passed', attempts: [], testIds: [], missingTestIds: [], required: true,
    requirementIds: [], quarantined: false, valid: true, createdAt: '', slot: 'A', configHash: recipeHash(run), manifestHash: manifest.hash, ...over,
  });
  const skipped: CheckIssue = { kind: 'test_skipped', testId: SKIPPED, message: `${SKIPPED}: skipped` };
  const failed = check('e2e', { status: 'failed', outcomes: [{ id: FAILED, status: 'failed' }], issues: [{ kind: 'assertion_failed', testId: FAILED, message: `${FAILED}: failed` }] });
  return { run, manifest, check, skipped, failed };
}

describe('which check results stop a run before anyone repairs it', () => {
  it('does not stop for tests the project skips on purpose: the failing test is sent to a diagnosis or a repair', () => {
    const { run, manifest, check, skipped, failed } = fixture();
    const unit = check('unit', { status: 'passed', counts: { passed: 74, failed: 0, skipped: 4 }, issues: [skipped, { ...skipped, message: 'second skipped' }] });
    expect(routeCheckFailure(run, [unit, failed], [manifest])).toEqual({ kind: 'assertion', reasons: [] });
  });

  it('still stops when the evidence cannot be trusted, and names that and nothing about the skipped tests', () => {
    const { run, manifest, check, skipped, failed } = fixture();
    const ambiguous: CheckIssue = { kind: 'identity_ambiguous', message: 'Report chứa định danh test trùng.' };
    const unit = check('unit', { status: 'passed', issues: [skipped, ambiguous] });
    const route = routeCheckFailure(run, [unit, failed], [manifest]);
    expect(route.kind).toBe('blocked');
    expect(route.reasons).toEqual(['Report chứa định danh test trùng.']);
  });

  it('still stops when the skipped test is one the run locked as evidence, even if nothing else says it did not run', () => {
    const { run, manifest, check, skipped, failed } = fixture(true);
    const unit = check('unit', { status: 'passed', issues: [skipped] });
    const route = routeCheckFailure(run, [unit, failed], [manifest]);
    expect(route.kind).toBe('blocked');
    expect(route.reasons).toEqual([skipped.message]);
  });

  it('still stops for a locked test that did not run', () => {
    const { run, manifest, check, skipped, failed } = fixture();
    const unit = check('unit', { status: 'passed', issues: [skipped], missingTestIds: [SKIPPED] });
    const route = routeCheckFailure(run, [unit, failed], [manifest]);
    expect(route.kind).toBe('blocked');
    expect(route.reasons.join(' ')).toContain('thiếu hoặc bỏ qua test đã khóa');
  });
});
