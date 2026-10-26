import { describe, expect, it } from 'vitest';
import { identityId, normalizeTestId, testTitle } from '../src/core/testids.js';
import { parseTestReport, summarizeCheck } from '../src/core/checks.js';
import { hashContract, reviseContract } from '../src/core/contract.js';
import { validateTestPlan, testPlanFindings, IdentitySchema } from '../src/core/testplan.js';
import { unsafeTestPatch } from '../src/core/recovery.js';
import { profile, setupV2 as setup } from './helpers.js';
import { contract, currentPlan, fence, qualityReply, qualityReport, qualityGreen } from './quality-fixtures.js';
import { Orchestrator } from '../src/server/orchestrator.js';

const title = '[R-1][C-1] retry > twice \\ unchanged';
const file = 'tests/quota.test.ts';
const jsonReport = (root = '/workspace', status = 'failed') => ({ testResults: [{ name: `${root}/${file}`, assertionResults: [{ title, ancestorTitles: ['QuotaVault public acceptance contract'], fullName: `QuotaVault public acceptance contract ${title}`, status }] }] });
function summarize(report: unknown, opts: { root?: string; ids?: string[]; structured?: boolean; checkpoint?: string; incomplete?: boolean; exitCode?: number } = {}) {
  return summarizeCheck({ id: 'check', runId: 'run', recipe: profile().checks[0]!, contractVersion: 1, checkpoint: 'cp', reportRoot: opts.root ?? '/workspace', structuredIds: opts.structured, lockedTestIds: opts.ids }, [{ report, reportRoot: opts.root ?? '/workspace', checkpoint: opts.checkpoint ?? 'cp', incomplete: opts.incomplete ?? false, exitCode: opts.exitCode ?? 1, log: '', durationMs: 1 }]);
}

describe('reporter-backed identities', () => {
  it.each(['/workspace', '/tmp/run-A', 'C:\\Work\\run-A'])('matches QuotaVault legacy > names using actual fields under %s', root => {
    const expected = `${file}::QuotaVault public acceptance contract > ${title}`;
    const result = summarize(jsonReport(root), { root, ids: [expected] });
    expect(result.status).toBe('failed'); expect(result.missingTestIds).toEqual([]);
    expect(result.issues?.map(i => i.kind)).toEqual(['assertion_failed']);
    expect(result.outcomes?.[0]?.id).toBe(expected);
  });
  it('computes structured ids without splitting names containing punctuation or backslashes', () => {
    const expected = identityId({ kind: 'json', file, titles: ['QuotaVault public acceptance contract', title] });
    const result = summarize(jsonReport(), { ids: [expected], structured: true });
    expect(result.missingTestIds).toEqual([]); expect(result.outcomes?.[0]?.id).toBe(expected);
    expect(testTitle(expected)).toContain(title);
    expect(normalizeTestId(`C:\\Work\\${file}::${title}`, 'c:/work')).toBe(`${file}::${title}`);
  });
  it('does not merge title boundaries just because reporter fullName is identical', () => {
    const report = { testResults: [{ name: `/workspace/${file}`, assertionResults: [
      { ancestorTitles: ['a > b'], title: '[R-1][C-1] c', fullName: 'same', status: 'passed' },
      { ancestorTitles: ['a', 'b'], title: '[R-1][C-1] c', fullName: 'same', status: 'passed' },
    ] }] };
    expect(summarize(report, { structured: true, exitCode: 0 }).status).toBe('passed');
    expect(summarize(report, { ids: [`${file}::a > b > [R-1][C-1] c`], exitCode: 0 }).issues?.some(i => i.kind === 'identity_ambiguous')).toBe(true);
  });
  it('blocks duplicate structured identities and does not use tags to match other tests', () => {
    const report = jsonReport(); report.testResults[0]!.assertionResults.push(report.testResults[0]!.assertionResults[0]!);
    expect(summarize(report, { structured: true }).status).toBe('incomplete');
    expect(summarize(jsonReport(), { ids: [`${file}::[R-1][C-1] different`] }).missingTestIds).toHaveLength(1);
  });
  it('keeps JUnit class/name separate and rejects a different parameterized name', () => {
    const expected = identityId({ kind: 'junit', className: 'orders::suite', name: 'test_R_1_C_1[2]' });
    const result = summarize('<testsuite><testcase classname="orders::suite" name="test_R_1_C_1[2]"><failure message="bad"/></testcase></testsuite>', { structured: true, ids: [expected] });
    expect(result.missingTestIds).toEqual([]); expect(result.outcomes?.[0]?.id).toBe(expected);
    expect(summarize('<testsuite><testcase classname="orders::suite" name="test_R_1_C_1[1]"/></testsuite>', { structured: true, ids: [expected] }).missingTestIds).toEqual([expected]);
  });
  it.each(['report_error', 'collection_error', 'checkpoint_mismatch', 'environment', 'test_skipped', 'test_missing'] as const)('classifies %s distinctly from an assertion', kind => {
    const report = kind === 'report_error' ? 'bad JSON' : kind === 'collection_error' ? { testResults: [{ name: file, status: 'failed', assertionResults: [] }] } : jsonReport('/workspace', kind === 'test_skipped' ? 'pending' : 'passed');
    const result = summarize(report, { ids: kind === 'test_missing' ? ['absent'] : undefined, checkpoint: kind === 'checkpoint_mismatch' ? 'old' : 'cp', incomplete: kind === 'environment', exitCode: 0 });
    expect(result.issues?.some(i => i.kind === kind)).toBe(true);
    if (kind !== 'test_skipped' && kind !== 'test_missing') expect(result.status).not.toBe('passed');
  });
  it('does not accept a differently cased Linux workspace or test title', () => {
    expect(normalizeTestId('/Work/a.test.ts::Case', '/work')).toBe('/Work/a.test.ts::Case');
    expect(identityId({ kind: 'json', file, titles: ['Case'] })).not.toBe(identityId({ kind: 'json', file, titles: ['case'] }));
  });
  it('preserves leading spaces and punctuation in structured titles at the schema boundary', () => {
    const identity = { kind: 'json', file, titles: [' suite ', ' [R-1][C-1] literal::name > value '] };
    expect(IdentitySchema.parse(identity)).toEqual(identity);
  });
  it.each(['<testsuite><testcase classname="x" name="a"/>', '<testsuite></wrong>', '<testsuite/><testsuite/>'])('rejects incomplete or mismatched XML: %s', xml => {
    expect(parseTestReport(xml).valid).toBe(false);
    expect(summarize(xml).issues?.some(i => i.kind === 'report_error')).toBe(true);
  });
});

describe('oracle policy v2', () => {
  it.each(['missing', 'unknown', 'unrelated', 'quote', 'explanation', 'questions'] as const)('rejects %s oracle evidence', kind => {
    const c = contract(); c.testPlan = currentPlan(c.testPlan!, c);
    const test = c.testPlan.cases[0]!;
    if (kind === 'missing') delete test.oracle;
    if (kind === 'unknown') test.oracle!.references[0]!.requirementId = 'R-99';
    if (kind === 'unrelated') { c.requirements.push({ ...c.requirements[0]!, id: 'R-2' }); test.oracle!.references[0]!.requirementId = 'R-2'; }
    if (kind === 'quote') test.oracle!.references[0]!.quote = 'cancel must throw ALREADY_TERMINAL';
    if (kind === 'explanation') test.oracle!.explanation = ' ';
    if (kind === 'questions') c.testPlan.questions.push('Cancel repeated outcome?');
    // A quotation that is not in the clause is advisory (the person sees it); a missing or foreign basis blocks.
    expect(kind === 'quote' ? testPlanFindings(c).advisories.length : validateTestPlan(c).length).toBeGreaterThan(0);
  });
  it('invalidates quotes and approval on requirement edits, without modifying legacy content', () => {
    const c = contract(), before = JSON.stringify(c), hash = hashContract(c);
    expect(validateTestPlan(c)).toEqual([]); expect(hashContract(c)).toBe(hash); expect(JSON.stringify(c)).toBe(before);
    const v2 = { ...c, testPlan: currentPlan(c.testPlan!, c) };
    expect(validateTestPlan(v2)).toEqual([]);
    const changed = reviseContract(v2, { ...v2, requirements: [{ ...c.requirements[0]!, text: 'Different public requirement' }] });
    expect(changed.version).toBe(c.version + 1); expect(testPlanFindings(changed).advisories.join(' ')).toContain('Trích dẫn');
  });
  it('blocks schema-v1 downgrade at the approval boundary for a new run', async () => {
    const e = setup({ reply: x => x.prompt.includes('Author lập kế hoạch') ? fence(contract().testPlan) : undefined });
    const run = e.create({ mode: 'verify' }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    expect(() => e.orchestrator.approveContract(run.id, { contractHash: e.orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true })).toThrow('v2');
    expect(e.runtime.calls).not.toContain('agent:developer:A');
  });
  it('retains invalid Author output and field errors without buying another planning call on resume', async () => {
    const e = setup({ reply: x => x.prompt.includes('Author lập kế hoạch') ? fence({ schemaVersion: 2, cases: 'invalid' }) : undefined });
    const run = e.create({ mode: 'verify' }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    expect(e.orchestrator.detail(run.id).artifacts.find(a => a.title === 'Test plan validation error')?.content).toContain('cases');
    const calls = e.runtime.calls.length; e.orchestrator.resumeRun(run.id); await e.orchestrator.idle(); expect(e.runtime.calls).toHaveLength(calls);
  });
});

describe('assertion repair is a bounded proposal', () => {
  function environment(options: { badOracle?: boolean; ambiguous?: boolean; reportError?: boolean } = {}) {
    let applied = () => false;
    const e = setup({ reply: x => x.prompt.includes('Author chẩn đoán') ? fence({ decision: options.ambiguous ? 'ambiguous' : 'test_assertion', caseIds: ['C-2'], reason: 'Repeat must return duplicate, not throw.', evidence: 'The public contract defines idempotent retry.', assertionChanges: [{ caseId: 'C-2', before: 'rejects ALREADY_TERMINAL', after: 'status equals duplicate', oracle: { references: [{ requirementId: 'R-1', quote: options.badOracle ? 'invented requirement' : x.run.contract.requirements[0]!.text }], explanation: 'The assertion must preserve idempotent behavior.' } }] }) : qualityReply(x), files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], check: () => ({ ...qualityGreen, exitCode: applied() ? 0 : 1, report: options.reportError ? undefined : qualityReport(applied() ? 'passed' : 'failed') }) });
    applied = () => e.runtime.calls.includes('applyPatch:A');
    return e;
  }
  it('requires exact approval, rolls back proposed edits, and regenerates evidence before acceptance', async () => {
    const e = environment(), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 })), old = e.orchestrator.detail(run.id), p = old.testRepair!;
    expect(p.kind).toBe('assertion'); expect(p.assertionChanges?.[0]?.before).toContain('ALREADY_TERMINAL');
    expect((await e.runtime.changes(old.run, 'A')).files).toEqual([]); expect(e.runtime.calls).not.toContain('applyPatch:A');
    expect(() => e.orchestrator.approveTestRepair(run.id, p.id, '0'.repeat(64))).toThrow('đã cũ');
    await expect(e.orchestrator.acceptRun(run.id, { acknowledgeWarnings: true })).rejects.toThrow();
    e.orchestrator.approveTestRepair(run.id, p.id, p.hash); await e.orchestrator.idle();
    const ready = e.orchestrator.detail(run.id); expect(ready.run.status).toBe('awaiting_acceptance');
    expect(ready.run.checkpoint).not.toBe(old.run.checkpoint); expect(ready.quality.manifestHash).not.toBe(old.quality.manifestHash);
    expect(ready.attempts.filter(a => a.role === 'developer')).toHaveLength(1); expect(ready.attempts.filter(a => a.role === 'author' && a.stage === 'repair')).toHaveLength(1);
  });
  it.each(['badOracle', 'ambiguous', 'reportError'] as const)('does not repair around %s', async option => {
    const e = environment({ [option]: true }), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    expect(e.orchestrator.detail(run.id).testRepair).toBeUndefined(); expect(e.runtime.calls).not.toContain('applyPatch:A');
    if (option === 'reportError') expect(e.orchestrator.detail(run.id).attempts.filter(a => a.stage === 'repair' && a.role === 'author')).toHaveLength(0);
  });
  it('does not call diagnosis again after persisted restart on the same manifest', async () => {
    const e = environment({ ambiguous: true }), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    const before = e.orchestrator.detail(run.id).attempts.filter(a => a.role === 'author' && a.stage === 'repair').length;
    const restarted = new Orchestrator(e.store, () => e.runtime); restarted.resumeRun(run.id); await restarted.idle();
    expect(restarted.detail(run.id).attempts.filter(a => a.role === 'author' && a.stage === 'repair')).toHaveLength(before);
  });
  it.each(['+test.skip("case", () => {});', '+it.only("case", () => {});', 'deleted file mode 100644'])('rejects an integrity-weakening patch: %s', patch => expect(unsafeTestPatch(patch)).toBe(true));
});
