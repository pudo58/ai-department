import type { CheckResult, CheckStatus, Recipe, TaskKind } from '../shared/types.js';
import type { RuntimeCheckResult } from '../runtime/types.js';

export interface TestOutcome { id: string; status: 'passed' | 'failed' | 'skipped' }
export interface ParsedReport { tests: TestOutcome[]; collectionErrors: number; valid: boolean; /** First message of each failed test (JUnit only). */ failures?: string[] }

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
  if (e[0] === '#') { const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
  return XML_ENTITIES[e.toLowerCase()] ?? m;
});
const xmlAttr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]!) : undefined;
};

/**
 * Parses a JUnit XML report, which is what `node --test --test-reporter=junit` writes. The runner's output is
 * the only input; a report with no `<testsuite>` is invalid, never "zero failures".
 */
export function parseJUnit(xml: string): ParsedReport {
  if (!/<testsuites?[\s>]/.test(xml)) return { tests: [], collectionErrors: 0, valid: false };
  const tests: TestOutcome[] = [], failures: string[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = xmlAttr(m[1]!, 'name');
    if (!name) continue;
    const body = m[2] ?? '';
    const failure = /<(?:failure|error)\b([^>]*)/.exec(body);
    const status = failure ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    tests.push({ id: `${xmlAttr(m[1]!, 'classname') ?? ''}::${name}`.replace(/^::/, ''), status });
    if (failure) failures.push(`Test "${name}" fail: ${(xmlAttr(failure[1]!, 'message') ?? 'không có message').slice(0, 300)}`);
  }
  return { tests, collectionErrors: 0, valid: true, failures };
}

/**
 * Parses a Vitest/Jest-style JSON report, or a JUnit XML string. A suite that failed without any assertion is
 * a collection (import/syntax) error, never a valid red test.
 */
export function parseTestReport(report: unknown): ParsedReport {
  if (typeof report === 'string') return parseJUnit(report);
  const root = asRecord(report);
  const suites = Array.isArray(root.testResults) ? root.testResults.map(asRecord) : null;
  if (!suites) return { tests: [], collectionErrors: 0, valid: false };
  const tests: TestOutcome[] = [];
  let collectionErrors = 0;
  for (const suite of suites) {
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults.map(asRecord) : [];
    if (suite.status === 'failed' && assertions.length === 0) collectionErrors++;
    for (const a of assertions) {
      const id = String(a.fullName ?? a.title ?? '');
      if (!id) continue;
      const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
      tests.push({ id: `${String(suite.name ?? '')}::${id}`.replace(/^::/, ''), status });
    }
  }
  return { tests, collectionErrors, valid: true };
}

/**
 * Human-readable failure digest from a Vitest/Jest report: failed test names with their first message, plus
 * suites that failed before any test ran. A raw log tail usually ends in a reporter footer, not the cause.
 */
export function summarizeFailures(report: unknown, limit = 5): string[] {
  if (typeof report === 'string') return (parseJUnit(report).failures ?? []).slice(0, limit);
  const suites = Array.isArray(asRecord(report).testResults) ? (asRecord(report).testResults as unknown[]).map(asRecord) : [];
  const out: string[] = [];
  for (const suite of suites) {
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults.map(asRecord) : [];
    if (suite.status === 'failed' && !assertions.length) out.push(`Suite ${String(suite.name ?? '?')} lỗi trước khi chạy test: ${String(suite.message ?? '').slice(0, 300)}`);
    for (const a of assertions.filter((x) => x.status === 'failed')) {
      const messages = Array.isArray(a.failureMessages) ? a.failureMessages : [];
      out.push(`Test "${String(a.fullName ?? a.title ?? '?')}" fail: ${String(messages[0] ?? '').slice(0, 300)}`);
    }
  }
  return out.slice(0, limit);
}

/**
 * Tests tie to contract requirements through bracketed tags in their title: `[R-1]`, `[R-1][R-2]` and the
 * grouped `[R-1, R-4]` that models like to write. Anything inside brackets that is not an id is ignored.
 */
export function extractRequirementIds(title: string): string[] {
  const ids = [...title.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1]!.split(/[\s,;]+/)).filter((t) => /^R-[A-Za-z0-9_-]+$/.test(t));
  return [...new Set(ids)];
}

/** The report was read and listed no test at all: the command or its file pattern does not match the repo's tests. */
export const ranNoTests = (c: Pick<CheckResult, 'counts'>): boolean => !!c.counts && c.counts.passed + c.counts.failed + c.counts.skipped === 0;

export function summarizeCheck(
  input: { runId: string; id: string; recipe: Recipe; checkpoint: string; contractVersion: number; lockedTestIds?: readonly string[]; quarantined?: { reason: string } },
  attempts: readonly RuntimeCheckResult[],
  now = new Date(),
): CheckResult {
  const last = attempts[attempts.length - 1];
  if (!last) throw new Error('A check needs at least one attempt');
  // Without a reportPath (typecheck, lint, build) the exit code alone decides pass/fail, and the check carries no
  // test ids, so it can never appear as evidence for a requirement.
  const parsed = input.recipe.reportPath ? parseTestReport(last.report) : null;
  // A runner that found no tests at all (wrong glob, wrong runner) proves nothing, even with exit code 0.
  const noTests = parsed !== null && parsed.valid && parsed.tests.length === 0 && parsed.collectionErrors === 0;
  const incomplete = attempts.some((a) => a.incomplete) || (parsed !== null && !parsed.valid) || (noTests && last.exitCode === 0);
  const passedAttempt = (a: RuntimeCheckResult) => a.exitCode === 0 && !a.incomplete;
  let status: CheckStatus;
  if (incomplete) status = 'incomplete';
  else if (passedAttempt(last)) status = attempts.length > 1 ? 'flaky' : 'passed';
  else status = 'failed';
  const passedTests = parsed?.tests.filter((t) => t.status === 'passed').map((t) => t.id) ?? [];
  const missing = (input.lockedTestIds ?? []).filter((id) => !passedTests.includes(id));
  return {
    id: input.id, runId: input.runId, recipeId: input.recipe.id, checkpoint: input.checkpoint, contractVersion: input.contractVersion,
    status, testIds: passedTests, missingTestIds: status === 'passed' ? missing : [...(input.lockedTestIds ?? [])],
    requirementIds: [...new Set(passedTests.flatMap(extractRequirementIds))],
    attempts: attempts.map((a) => ({ exitCode: a.exitCode, log: a.log, durationMs: a.durationMs })),
    required: input.recipe.required, quarantined: !!input.quarantined, quarantineReason: input.quarantined?.reason,
    valid: true, createdAt: now.toISOString(),
    // Tallies are only recorded when the runner produced a readable report; a missing report is "unknown", not zero.
    ...(parsed?.valid ? {
      counts: { passed: passedTests.length, failed: parsed.tests.filter((t) => t.status === 'failed').length, skipped: parsed.tests.filter((t) => t.status === 'skipped').length },
      skippedTestIds: parsed.tests.filter((t) => t.status === 'skipped').map((t) => (t.id.includes('::') ? t.id.slice(t.id.indexOf('::') + 2) : t.id)),
    } : {}),
  };
}

/** Only a failed first run earns the single allowed retry; timeouts and missing reports are never retried. */
export const shouldRetry = (first: RuntimeCheckResult): boolean => !first.incomplete && first.exitCode !== 0;

export type RepeatVerdict = 'reproduced' | 'fixed' | 'unstable';
/** New E2E tests and counterexamples run three times on a reset environment. Inconsistent results never erase an observed failure. */
export function classifyRepeats(runs: readonly { passed: boolean; cause?: string }[]): RepeatVerdict {
  if (runs.length < 3) return 'unstable';
  if (runs.every((r) => r.passed)) return 'fixed';
  const failures = runs.filter((r) => !r.passed);
  if (failures.length === runs.length && new Set(failures.map((f) => f.cause ?? '')).size === 1) return 'reproduced';
  return 'unstable';
}

export interface RedGreenVerdict { valid: boolean; reasons: string[] }
/**
 * bugfix: fail on base, pass on candidate. refactor: pass on both. A collection error is not a red test.
 * Features need a base+stub phase, which the orchestrator does not wire yet, so they are not judged here.
 */
export function evaluateRedGreen(kind: TaskKind, base: ParsedReport, candidate: ParsedReport, requirementTag?: string): RedGreenVerdict {
  const scope = (r: ParsedReport) => r.tests.filter((t) => !requirementTag || extractRequirementIds(t.id).includes(requirementTag));
  const reasons: string[] = [];
  if (!base.valid || !candidate.valid) reasons.push('Thiếu report test hợp lệ.');
  if (kind === 'bugfix') {
    if (base.collectionErrors) reasons.push('Test trên base lỗi import/collection, không phải red test hợp lệ.');
    if (!scope(base).some((t) => t.status === 'failed')) reasons.push('Không có test nào fail trên base.');
    if (!scope(candidate).length || scope(candidate).some((t) => t.status === 'failed') || candidate.collectionErrors) reasons.push('Candidate chưa pass toàn bộ test liên quan.');
  } else if (kind === 'refactor') {
    if (!scope(base).length || scope(base).some((t) => t.status === 'failed')) reasons.push('Hành vi cần giữ phải pass trên base.');
    if (!scope(candidate).length || scope(candidate).some((t) => t.status === 'failed') || candidate.collectionErrors) reasons.push('Hành vi cần giữ không còn pass trên candidate.');
  } else reasons.push('Feature mới cần phase base+stub, chưa được tự động hóa.');
  return { valid: reasons.length === 0, reasons };
}

/** Detects removed or weakened checks by comparing locked test ids with those found on the candidate. */
export function detectWeakenedChecks(lockedTestIds: readonly string[], candidate: ParsedReport): string[] {
  const present = new Set(candidate.tests.map((t) => t.id));
  return lockedTestIds.filter((id) => !present.has(id));
}
