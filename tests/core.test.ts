import { describe, expect, it } from 'vitest';
import { allocate, budgetCeiling, candidateCap, checkEscalation, PHASE_SHARE, remainingFor } from '../src/core/budget.js';
import { classifyRepeats, evaluateRedGreen, extractRequirementIds, parseTestReport, shouldRetry, summarizeCheck, summarizeFailures } from '../src/core/checks.js';
import { approveContract, hashContract, initialContract, isApproved, reviseContract, validateContract } from '../src/core/contract.js';
import { blocksCompletion, gateFinding, type RawFinding } from '../src/core/findings.js';
import { extractJsonBlock, FindingsSchema, parseOutput } from '../src/core/outputs.js';
import { recommendMode } from '../src/core/routing.js';
import { classifyPath, evaluateChanges, globToRegExp, isSafeRelative } from '../src/core/scope.js';
import { anonymize, selectCandidate } from '../src/core/selection.js';
import { notAnalyzed, toolDelta } from '../src/core/tools.js';
import { summarizeRuns } from '../src/core/metrics.js';
import { profile, report } from './helpers.js';
import type { BudgetState, Run } from '../src/shared/types.js';

describe('routing', () => {
  it('keeps Single when no registered signal is present', () => expect(recommendMode([]).mode).toBe('single'));
  it('proposes Clarify for ambiguity even when other signals exist', () => expect(recommendMode(['ambiguity', 'permissions']).mode).toBe('clarify'));
  it.each([['permissions'], ['concurrency'], ['public-api']])('proposes Verify for %s', (s) => expect(recommendMode([s]).mode).toBe('verify'));
  it('proposes Compare for competing hypotheses and states the cost', () => {
    const r = recommendMode(['alternatives']);
    expect(r.mode).toBe('compare');
    expect(r.multiplier).toBeGreaterThan(1);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
  it('ignores unknown free text instead of inferring risk from it', () => expect(recommendMode(['llm-is-unsure']).mode).toBe('single'));
});

describe('budget', () => {
  it('splits 20/40/10/30 and sums to the cap', () => {
    const a = allocate(10);
    expect(a).toEqual({ prepare: 2, implement: 4, repair: 1, verify: 3 });
    expect(Object.values(PHASE_SHARE).reduce((x, y) => x + y)).toBeCloseTo(1);
  });
  it('caps Team at three times Single', () => expect(budgetCeiling(5, 'compare')).toBe(15));
  it('lets a stage borrow earlier unused share but never exceed the cap', () => {
    const state: BudgetState = { capUsd: 10, spentUsd: 1, estimated: false, phases: { prepare: { allocatedUsd: 2, spentUsd: 1 }, implement: { allocatedUsd: 4, spentUsd: 0 }, repair: { allocatedUsd: 1, spentUsd: 0 }, verify: { allocatedUsd: 3, spentUsd: 0 } } };
    expect(remainingFor(state, 'implement')).toBe(5);
    expect(remainingFor({ ...state, spentUsd: 9.5 }, 'verify')).toBe(0.5);
  });
  it('compare splits implementation instead of doubling it, and never touches final verify', () => {
    const state: BudgetState = { capUsd: 10, spentUsd: 0, estimated: false, phases: { prepare: { allocatedUsd: 2, spentUsd: 0 }, implement: { allocatedUsd: 4, spentUsd: 0 }, repair: { allocatedUsd: 1, spentUsd: 0 }, verify: { allocatedUsd: 3, spentUsd: 0 } } };
    expect(candidateCap(state, 2)).toBe(2.5);
  });
  it('escalation needs real money', () => {
    const run = { baseBudgetUsd: 10, budgetUsd: 10 } as Run;
    expect(checkEscalation(run, 7, 'compare').allowed).toBe(false);
    expect(checkEscalation(run, 7, 'compare', 12).allowed).toBe(true);
    expect(checkEscalation(run, 0, 'compare', 31).allowed).toBe(false);
  });
});

describe('scope', () => {
  const scope = { modules: ['src', 'tests'], protectedPaths: ['package.json', 'vitest.config.*', '.github/**'], lockedPaths: ['tests/locked.test.ts'] };
  it('classifies into the three tiers', () => {
    expect(classifyPath('src/a/b.ts', scope)).toBe('allowed');
    expect(classifyPath('package.json', scope)).toBe('protected');
    expect(classifyPath('vitest.config.ts', scope)).toBe('protected');
    expect(classifyPath('.github/workflows/ci.yml', scope)).toBe('protected');
    expect(classifyPath('tests/locked.test.ts', scope)).toBe('protected');
    expect(classifyPath('docs/readme.md', scope)).toBe('needs_approval');
  });
  it('does not let a module prefix match a sibling directory', () => expect(classifyPath('src-old/x.ts', scope)).toBe('needs_approval'));
  it('treats traversal and absolute paths as protected', () => {
    for (const p of ['../x.ts', 'src/../../x.ts', '/etc/passwd', 'C:\\x.ts']) expect(classifyPath(p, scope)).toBe('protected');
    expect(isSafeRelative('src/ok.ts')).toBe(true);
  });
  it('accepts a change set only if every file is allowed', () => {
    expect(evaluateChanges(['src/a.ts'], scope).accepted).toBe(true);
    expect(evaluateChanges(['src/a.ts', 'package.json'], scope)).toMatchObject({ accepted: false, protected: ['package.json'] });
  });
  it('globs stay inside segments for * and cross them for **', () => {
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/b.ts')).toBe(true);
  });
});

describe('contract', () => {
  it('hash ignores key order and approval fields', () => {
    const c = initialContract('x');
    expect(hashContract(c)).toBe(hashContract({ ...c, approvedHash: 'zzz', approvedAt: 'now' }));
  });
  it('approval is bound to content', () => {
    const approved = approveContract(initialContract('x'));
    expect(isApproved(approved)).toBe(true);
    expect(isApproved({ ...approved, assumptions: ['changed after approval'] })).toBe(false);
  });
  it('revision bumps the version, drops approval, and is a no-op when nothing changed', () => {
    const approved = approveContract(initialContract('x'));
    const same = reviseContract(approved, { ...approved });
    expect(same).toBe(approved);
    const next = reviseContract(approved, { ...approved, scope: ['src'] });
    expect(next.version).toBe(2);
    expect(next.approvedHash).toBeUndefined();
  });
  it('rejects empty, duplicate and malformed requirements', () => {
    const c = initialContract('x');
    expect(validateContract({ ...c, requirements: [{ id: 'R-1', text: '', required: true, manual: false }] }).length).toBeGreaterThan(0);
    expect(validateContract({ ...c, requirements: [c.requirements[0]!, c.requirements[0]!] }).join()).toMatch(/trùng/);
    expect(validateContract({ ...c, requirements: [{ id: 'bad id', text: 'x', required: true, manual: false }] }).join()).toMatch(/không hợp lệ/);
    expect(() => approveContract({ ...c, requirements: [{ id: 'R-1', text: 'x', required: false, manual: false }] })).toThrow();
  });
});

describe('checks', () => {
  const recipe = profile().checks[0]!;
  const attempt = (exitCode: number | null, extra = {}) => ({ exitCode, log: '', durationMs: 1, checkpoint: 'c1', incomplete: false, report: report([{ title: '[R-1] a' }]), ...extra });
  const input = { runId: 'r', id: 'c', recipe, checkpoint: 'c1', contractVersion: 1 };

  it('pass / flaky / failed / incomplete', () => {
    expect(summarizeCheck(input, [attempt(0)]).status).toBe('passed');
    expect(summarizeCheck(input, [attempt(1), attempt(0)]).status).toBe('flaky');
    expect(summarizeCheck(input, [attempt(1), attempt(1)]).status).toBe('failed');
    expect(summarizeCheck(input, [attempt(0, { incomplete: true })]).status).toBe('incomplete');
  });
  it('a missing report is incomplete even when the exit code is zero', () => expect(summarizeCheck(input, [attempt(0, { report: undefined })]).status).toBe('incomplete'));
  it('only a real failure earns the single retry', () => {
    expect(shouldRetry(attempt(1))).toBe(true);
    expect(shouldRetry(attempt(1, { incomplete: true }))).toBe(false);
    expect(shouldRetry(attempt(0))).toBe(false);
  });
  it('maps passing tests to requirements by tag', () => {
    expect(summarizeCheck(input, [attempt(0)]).requirementIds).toEqual(['R-1']);
    expect(extractRequirementIds('[R-1] and [R-2] both')).toEqual(['R-1', 'R-2']);
  });
  it('a suite that fails without assertions is a collection error', () => {
    const parsed = parseTestReport({ testResults: [{ name: 'a.test.ts', status: 'failed', assertionResults: [] }] });
    expect(parsed.collectionErrors).toBe(1);
    expect(parseTestReport('not a report').valid).toBe(false);
  });
  it('repeats: three same failures reproduce, three passes fix, mixed is unstable', () => {
    const f = { passed: false, cause: 'timeout' };
    expect(classifyRepeats([f, f, f])).toBe('reproduced');
    expect(classifyRepeats([{ passed: true }, { passed: true }, { passed: true }])).toBe('fixed');
    expect(classifyRepeats([f, { passed: true }, f])).toBe('unstable');
    expect(classifyRepeats([f, f, { passed: false, cause: 'other' }])).toBe('unstable');
  });
  it('red/green rules per task kind', () => {
    const fail = parseTestReport(report([{ title: '[R-1] t', status: 'failed' }])), pass = parseTestReport(report([{ title: '[R-1] t' }]));
    expect(evaluateRedGreen('bugfix', fail, pass).valid).toBe(true);
    expect(evaluateRedGreen('bugfix', pass, pass).valid).toBe(false);
    expect(evaluateRedGreen('refactor', pass, pass).valid).toBe(true);
    expect(evaluateRedGreen('refactor', pass, fail).valid).toBe(false);
    expect(evaluateRedGreen('feature', fail, pass).valid).toBe(false);
  });
});

describe('findings', () => {
  const base: RawFinding = { category: 'design', severity: 'major', code: 'D2', title: 't', location: 'src/a.ts:1', rule: 'API v1 is public', evidence: 'consumer X breaks', suggestion: 'keep the old field' };
  it('keeps a fully evidenced D-group major', () => expect(gateFinding(base).severity).toBe('major'));
  it.each([
    ['no code', { code: undefined }], ['unknown code', { code: 'D9' }], ['no rule or precedent', { rule: undefined }],
    ['no evidence', { evidence: '' }], ['no location', { location: '' }], ['no fix', { suggestion: '' }],
  ])('demotes a design major with %s', (_n, patch) => expect(gateFinding({ ...base, ...patch })).toMatchObject({ severity: 'minor' }));
  it('a precedent can stand in for a rule', () => expect(gateFinding({ ...base, rule: undefined, precedent: 'src/b.ts does it this way' }).severity).toBe('major'));
  it('behavior blockers need location and evidence but not a D-code', () => {
    expect(gateFinding({ ...base, category: 'behavior', code: undefined, rule: undefined }).severity).toBe('major');
    expect(gateFinding({ ...base, category: 'behavior', evidence: '' }).severity).toBe('minor');
  });
  it('only unresolved blocker/major findings block', () => {
    expect(blocksCompletion({ severity: 'major', status: 'open' })).toBe(true);
    expect(blocksCompletion({ severity: 'major', status: 'resolved' })).toBe(false);
    expect(blocksCompletion({ severity: 'minor', status: 'open' })).toBe(false);
  });
});

describe('selection and tools', () => {
  const ok = (slot: 'A' | 'B', o = {}) => ({ slot, eliminatedBecause: null, changedFiles: 3, newToolIssues: 0, flakyChecks: 0, ...o });
  it('eliminates violators before comparing numbers', () => {
    expect(selectCandidate(ok('A', { eliminatedBecause: 'fail' }), ok('B', { changedFiles: 99 })).slot).toBe('B');
    expect(selectCandidate(ok('A', { eliminatedBecause: 'x' }), ok('B', { eliminatedBecause: 'y' })).slot).toBeNull();
  });
  it('uses objective metrics in a fixed order and keeps A on a tie', () => {
    expect(selectCandidate(ok('A', { newToolIssues: 2 }), ok('B')).slot).toBe('B');
    expect(selectCandidate(ok('A', { changedFiles: 9 }), ok('B', { changedFiles: 2 })).slot).toBe('B');
    expect(selectCandidate(ok('A'), ok('B')).slot).toBe('A');
  });
  it('hides model names from trade-off review', () => expect(anonymize('Written by GPT-5 and gpt-5', ['gpt-5'])).toBe('Written by [model] and [model]'));
  it('a tool that did not run is "not analyzed", never clean', () => {
    const ok1 = { tool: 'knip' as const, status: 'ok' as const, issues: ['a'] };
    expect(toolDelta(ok1, notAnalyzed('knip', 'no config')).status).toBe('not_analyzed');
    expect(toolDelta(ok1, { ...ok1, issues: ['a', 'b'] })).toMatchObject({ status: 'ok', newIssues: ['b'], resolvedIssues: [] });
  });
});

describe('agent output parsing', () => {
  it('takes the last json block and rejects prose-only replies', () => {
    expect(extractJsonBlock('a\n```json\n{"x":1}\n```\nb\n```json\n{"x":2}\n```')).toEqual({ x: 2 });
    expect(() => extractJsonBlock('no block here')).toThrow();
    expect(() => extractJsonBlock('```json\n{broken\n```')).toThrow();
  });
  it('rejects schema violations rather than guessing', () => {
    expect(() => parseOutput(FindingsSchema, '```json\n{"findings":[{"category":"nope"}]}\n```')).toThrow(/sai định dạng/);
  });
});

describe('metrics', () => {
  it('groups by starting mode, counts unfinished runs, and only counts closed timers', () => {
    const mk = (over: Partial<Run>): Run => ({ initialMode: 'single', mode: 'single', status: 'completed', usage: [], humanTime: [], escalations: [], ...over }) as Run;
    const usage = (cost: number) => ({ id: 'u', attemptId: 'a', inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: cost, source: 'reported' as const, createdAt: '' });
    const rows = summarizeRuns([
      mk({ usage: [usage(1)], humanTime: [{ id: 't', category: 'review', startedAt: '', endedAt: '', durationMs: 600_000, note: '' }] }),
      mk({ status: 'failed', mode: 'compare', escalations: [{ from: 'single', to: 'compare', reason: '', at: '' }], usage: [usage(3)], humanTime: [{ id: 't', category: 'rework', startedAt: '', note: '' }] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'single', runs: 2, accepted: 1, unfinished: 1, escalated: 1, costUsd: 4, humanMinutesTotal: 10, acceptedRate: 0.5 });
  });
});

describe('JUnit reports (node --test) and grouped requirement tags', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
<testsuite name="test" tests="4" failures="1" skipped="1">
\t<testcase name="[R-1, R-4] rejects a &quot;foreign&quot; shop &amp; stops" time="0.001" classname="test"/>
\t<testcase name="[R-2] boom" time="0.002" classname="test">
\t\t<failure type="testCodeFailure" message="expected 6 &amp; got 5">stack</failure>
\t</testcase>
\t<testcase name="[R-3] later" classname="test"><skipped/></testcase>
\t<testcase name="no tag at all" classname="test"/>
</testsuite>
</testsuites>`;

  it('parses passed, failed and skipped cases and decodes XML entities', () => {
    const parsed = parseTestReport(xml);
    expect(parsed.valid).toBe(true);
    expect(parsed.tests.map((t) => t.status)).toEqual(['passed', 'failed', 'skipped', 'passed']);
    expect(parsed.tests[0]!.id).toBe('test::[R-1, R-4] rejects a "foreign" shop & stops');
    expect(parsed.failures).toEqual(['Test "[R-2] boom" fail: expected 6 & got 5']);
  });
  it('treats text without a testsuite as an invalid report, never as zero failures', () => {
    expect(parseTestReport('<html>oops</html>').valid).toBe(false);
    expect(parseTestReport('').valid).toBe(false);
  });
  it('a JUnit check feeds the same pass/fail and requirement logic as JSON', () => {
    const recipe = { id: 'test', command: ['node', '--test'], required: true, timeoutMs: 1000, reportPath: '.aidept-report.xml' };
    const run = (report: string, exitCode: number) => summarizeCheck({ runId: 'r', id: 'c', recipe, checkpoint: 'c1', contractVersion: 1 }, [{ exitCode, log: '', durationMs: 1, checkpoint: 'c1', incomplete: false, report }]);
    const ok = run(xml.replace(/<failure[\s\S]*?<\/failure>/, ''), 0);
    expect(ok.status).toBe('passed');
    expect(ok.requirementIds).toEqual(expect.arrayContaining(['R-1', 'R-4']));
    expect(run(xml, 1).status).toBe('failed');
    expect(summarizeFailures(xml)).toEqual(['Test "[R-2] boom" fail: expected 6 & got 5']);
  });
  it('requirement tags: single, adjacent, grouped, and non-id brackets', () => {
    expect(extractRequirementIds('[R-1] a')).toEqual(['R-1']);
    expect(extractRequirementIds('[R-1][R-2] a')).toEqual(['R-1', 'R-2']);
    expect(extractRequirementIds('[R-1, R-4] a [R-2]')).toEqual(['R-1', 'R-4', 'R-2']);
    expect(extractRequirementIds('[R-1; R-3 R-5] x')).toEqual(['R-1', 'R-3', 'R-5']);
    expect(extractRequirementIds('[wip] [R-] [r-1] [R_1]')).toEqual([]);
    expect(extractRequirementIds('[R-1x y]')).toEqual(['R-1x']);
    expect(extractRequirementIds('items[0] and [R-7]')).toEqual(['R-7']);
  });
});
