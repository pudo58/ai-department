import { normalizeTestId, identityId, testTitle } from './testids.js';
import type { CheckResult, CheckStatus, CheckIssue, Recipe, TaskKind } from '../shared/types.js';
import type { TestIdentity } from '../shared/quality.js';
import type { RuntimeCheckResult } from '../runtime/types.js';

export interface TestOutcome { id: string; status: 'passed' | 'failed' | 'skipped'; identity?: TestIdentity; aliases?: string[] }
export interface ParsedReport { tests: TestOutcome[]; collectionErrors: number; valid: boolean; /** First message of each failed test (JUnit only). */ failures?: string[] }

/**
 * An issue that says the evidence itself cannot be trusted (a locked test missing, an id that matches twice, a report that did not
 * finish). A failed assertion is the code or the test being wrong, and a skipped test that nothing locked is only a warning in the
 * report (a locked one is already listed in `missingTestIds`); neither stops a run by itself, so every gate asks this one question.
 */
export const isIntegrityIssue = (issue: CheckIssue): boolean => issue.kind !== 'assertion_failed' && issue.kind !== 'test_skipped';

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
  if (e[0] === '#') { const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m; }
  return XML_ENTITIES[e.toLowerCase()] ?? m;
});
const xmlAttr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeXml(m[1] ?? m[2]!) : undefined;
};

/** Reject truncated/mismatched XML instead of treating its partial test list as evidence. No DTDs. */
function completeXml(xml: string): boolean {
  const stack: string[] = []; let offset = 0, roots = 0;
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w:.-]*(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
  for (const match of xml.matchAll(tokens)) {
    if (xml.slice(offset, match.index).includes('<')) return false;
    const token = match[0]; offset = match.index! + token.length;
    if (token.startsWith('<?') || token.startsWith('<!')) continue;
    const name = /^<\/?([\w:.-]+)/.exec(token)![1]!;
    if (token.startsWith('</')) { if (stack.pop() !== name) return false; }
    else { if (!stack.length) { if (++roots !== 1 || !/^testsuites?$/.test(name)) return false; } if (!token.endsWith('/>')) stack.push(name); }
  }
  return roots === 1 && stack.length === 0 && !xml.slice(offset).trim();
}

/**
 * Parses a JUnit XML report, which is what `node --test --test-reporter=junit` writes. The runner's output is
 * the only input; a report with no `<testsuite>` is invalid, never "zero failures".
 */
export function parseJUnit(xml: string): ParsedReport {
  if (!completeXml(xml)) return { tests: [], collectionErrors: 0, valid: false };
  const tests: TestOutcome[] = [], failures: string[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = xmlAttr(m[1]!, 'name');
    if (!name) continue;
    const body = m[2] ?? '';
    const failure = /<(?:failure|error)\b([^>]*)/.exec(body);
    const status = failure ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    const className = xmlAttr(m[1]!, 'classname') ?? '';
    tests.push({ id: `${className}::${name}`.replace(/^::/, ''), status, identity: { kind: 'junit', className, name } });
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
      const file = String(suite.name ?? '');
      const titles = Array.isArray(a.ancestorTitles) && a.ancestorTitles.every(t => typeof t === 'string') && typeof a.title === 'string' ? [...a.ancestorTitles as string[], a.title] : null;
      tests.push({ id: `${file}::${id}`.replace(/^::/, ''), status,
        ...(titles && file ? { identity: { kind: 'json' as const, file, titles }, aliases: [`${file}::${titles.join(' > ')}`] } : {}) });
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
 * The identifier-safe spelling `R_1` is accepted too.
 */
export function extractRequirementIds(title: string): string[] {
  title = testTitle(title);
  const ids = [...title.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => m[1]!.split(/[\s,;]+/)).filter((t) => /^R-[A-Za-z0-9_-]+$/.test(t));
  // Java, Python, Go and Rust test names cannot hold brackets, so `R_1` in a name (test_R_1_rejects_empty) means R-1.
  const underscored = [...title.matchAll(/(?<![A-Za-z0-9[])R_(\d+)(?![A-Za-z0-9])/g)].map((m) => `R-${m[1]}`);
  return [...new Set([...ids, ...underscored])];
}

/** The report was read and listed no test at all: the command or its file pattern does not match the repo's tests. */
export const ranNoTests = (c: Pick<CheckResult, 'counts'>): boolean => !!c.counts && c.counts.passed + c.counts.failed + c.counts.skipped === 0;

export function summarizeCheck(
  input: { runId: string; id: string; recipe: Recipe; checkpoint: string; contractVersion: number; lockedTestIds?: readonly string[]; structuredIds?: boolean; reportRoot?: string; quarantined?: { reason: string } },
  attempts: readonly RuntimeCheckResult[],
  now = new Date(),
): CheckResult {
  const last = attempts[attempts.length - 1];
  if (!last) throw new Error('A check needs at least one attempt');
  // Without a reportPath (typecheck, lint, build) the exit code alone decides pass/fail, and the check carries no
  // test ids, so it can never appear as evidence for a requirement.
  const parsed = input.recipe.reportPath ? parseTestReport(last.report) : null;
  const root = last.reportRoot ?? input.reportRoot;
  const issues: CheckIssue[] = [];
  const expected = (input.lockedTestIds ?? []).map(id => normalizeTestId(id, root));
  const tests = (parsed?.tests ?? []).map(t => ({ ...t, id: input.structuredIds && t.identity ? identityId(t.identity, root) : normalizeTestId(t.id, root),
    aliases: [normalizeTestId(t.id, root), ...(t.aliases ?? []).map(id => normalizeTestId(id, root))] }));
  // Legacy aliases are generated only from actual reporter fields, and must be one-to-one.
  const aliases: Record<string, string[]> = Object.create(null);
  for (const t of tests) for (const alias of new Set([t.id, ...t.aliases])) (aliases[alias] ??= []).push(t.id);
  for (const id of expected) {
    const candidates = tests.filter(t => t.id === id || t.aliases.includes(id));
    if (candidates.length > 1) issues.push({ kind: 'identity_ambiguous', testId: id, message: `Định danh test mơ hồ: ${id}` });
  }
  if (!input.structuredIds) for (const t of tests) {
    const matches = expected.filter(id => t.id === id || t.aliases.includes(id));
    if (matches.length === 1 && tests.filter(other => other.id === matches[0] || other.aliases.includes(matches[0]!)).length === 1) t.id = matches[0]!;
    else if (matches.length > 1) issues.push({ kind: 'identity_ambiguous', message: `Một test khớp nhiều ID đã khóa: ${matches.join(', ')}` });
  }
  if (new Set(tests.map(t => t.id)).size !== tests.length) issues.push({ kind: 'identity_ambiguous', message: 'Report chứa định danh test trùng.' });
  if (parsed && (!parsed.valid || (input.structuredIds && tests.some(t => !t.identity)))) issues.push({ kind: 'report_error', message: 'Report thiếu dữ liệu định danh test hợp lệ.' });
  if (parsed?.collectionErrors) issues.push({ kind: 'collection_error', message: 'Test lỗi import/collection trước khi chạy assertion.' });
  if (attempts.some(a => a.incomplete)) issues.push({ kind: 'environment', message: 'Check chưa hoàn tất: môi trường hoặc timeout/thiếu report.' });
  if (attempts.some(a => a.checkpoint !== input.checkpoint)) issues.push({ kind: 'checkpoint_mismatch', message: 'Report không thuộc checkpoint đang kiểm tra.' });
  // A runner that found no tests at all (wrong glob, wrong runner) proves nothing, even with exit code 0.
  const noTests = parsed !== null && parsed.valid && parsed.tests.length === 0 && parsed.collectionErrors === 0;
  if (noTests) issues.push({ kind: 'report_error', message: 'Report không có test nào.' });
  const incomplete = issues.some(i => ['report_error', 'identity_ambiguous', 'environment', 'checkpoint_mismatch'].includes(i.kind));
  const passedAttempt = (a: RuntimeCheckResult) => a.exitCode === 0 && !a.incomplete;
  let status: CheckStatus;
  if (incomplete) status = 'incomplete';
  else if (passedAttempt(last)) status = attempts.length > 1 ? 'flaky' : 'passed';
  else status = 'failed';
  if (status !== 'incomplete' && parsed && (parsed.collectionErrors > 0 || parsed.tests.some(t => t.status === 'failed'))) status = 'failed';

  const passedTests = tests.filter(t => t.status === 'passed').map(t => t.id);
  // A failed assertion ran: it needs a code/test diagnosis, not a missing-test integrity block.
  const executed = new Set(tests.filter(t => t.status !== 'skipped').map(t => t.id));
  const missing = expected.filter(id => !executed.has(id));
  for (const t of tests) if (t.status !== 'passed') issues.push({ kind: t.status === 'failed' ? 'assertion_failed' : 'test_skipped', testId: t.id, message: `${t.id}: ${t.status}` });
  for (const id of missing) if (!tests.some(t => t.id === id && t.status === 'skipped')) issues.push({ kind: 'test_missing', testId: id, message: `Không tìm thấy test đã khóa: ${id}` });
  return {
    id: input.id, runId: input.runId, recipeId: input.recipe.id, checkpoint: input.checkpoint, contractVersion: input.contractVersion,
    issues, aliases, outcomes: tests,
    status, testIds: passedTests, missingTestIds: missing,
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
