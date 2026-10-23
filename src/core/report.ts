import type { Artifact, Attempt, BudgetState, CheckResult, CompletionState, Finding, MatrixRow, Run } from '../shared/types.js';
import { usageCost } from './budget.js';
import { extractRequirementIds } from './checks.js';
import { isTestPath } from './testpath.js';

export interface ChangedFile { path: string; added: number; removed: number; status: 'added' | 'modified' | 'deleted' | 'renamed' }
export interface ReportWarning { level: 'warn' | 'info'; text: string }
export interface VerifierVerdict { decision: 'pass' | 'block' | 'abstain' | 'skipped' | 'unparsed'; summary: string; findingCount: number }

export interface AcceptanceReport {
  generatedAt: string; runId: string; title: string; requirement: string; mode: Run['mode']; provider: Run['provider'];
  /** ready: every automatic condition holds and nothing needs a second look; with_warnings: acceptable only after the person reads the warnings. */
  readiness: 'ready' | 'ready_with_warnings' | 'not_ready'; notReadyReasons: string[];
  checkpoint: string | null; baseSha: string | null;
  requirements: { id: string; text: string; required: boolean; manual: boolean; status: MatrixRow['status']; tests: string[] }[];
  assumptions: string[];
  changes: { available: boolean; files: ChangedFile[]; added: number; removed: number; testFiles: string[]; patch: string };
  checks: { id: string; command: string; status: CheckResult['status']; passed: number | null; failed: number | null; skipped: number | null; skippedNames: string[]; durationMs: number; runs: number; quarantined: boolean }[];
  verifier: { expected: boolean; ran: boolean; verdict: VerifierVerdict | null; findings: { title: string; severity: Finding['severity']; status: Finding['status']; confirmed: boolean; location: string }[] };
  effort: { costUsd: number; estimated: boolean; tokens: number; aiMs: number; humanMs: number; attempts: number; repairs: number };
  scopeApprovals: string[];
  /** Library skills the agents were given, per role, read from the context record of each attempt. */
  skills: { role: string; name: string; delivery: string; hasScripts: boolean }[];
  warnings: ReportWarning[];
  delivery: { branch: string; repository: string; delivered: boolean; commands: string[] };
}

export interface ReportInput {
  run: Run; attempts: readonly Attempt[]; checks: readonly CheckResult[]; findings: readonly Finding[]; artifacts: readonly Artifact[];
  matrix: readonly MatrixRow[]; completion: CompletionState; budget: BudgetState;
  changes: { available: boolean; files: ChangedFile[]; patch: string };
  delivered: boolean; now?: Date;
}

const MAX_PATCH_CHARS = 300_000;
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Latest valid result per recipe on the live checkpoint and contract version: the only checks that count. */
function currentChecks(run: Run, checks: readonly CheckResult[]): CheckResult[] {
  const live = checks.filter((c) => c.valid && c.contractVersion === run.contract.version && c.checkpoint === run.checkpoint);
  const latest = new Map<string, CheckResult>();
  for (const c of live) latest.set(c.recipeId, c);
  return [...latest.values()];
}

export function readVerdict(artifacts: readonly Artifact[], run: Run): VerifierVerdict | null {
  const mine = artifacts.filter((a) => a.kind === 'report' && a.title === 'Verifier verdict' && a.valid && a.contractVersion === run.contract.version);
  const pick = mine.filter((a) => a.checkpoint === run.checkpoint).at(-1) ?? mine.at(-1);
  if (!pick) return null;
  try { return JSON.parse(pick.content) as VerifierVerdict; } catch { return null; }
}

/**
 * Everything a person needs to decide on acceptance, in one structure: what was asked, what changed, which tests ran
 * and what they proved, what the independent reviewer said, and what could not be proven. Warnings are explicit so
 * that "all green" can never hide a skipped test or a reviewer who declined to give a verdict.
 */
export function buildReport(input: ReportInput): AcceptanceReport {
  const { run, attempts, findings, artifacts, matrix, completion, budget, changes } = input;
  const live = currentChecks(run, input.checks);
  const verdictExpected = run.mode === 'verify' || run.mode === 'compare';
  const verdict = readVerdict(artifacts, run);

  // Which passing tests back each requirement, read from the test titles themselves.
  const testsByReq = new Map<string, string[]>();
  for (const check of live.filter((c) => c.status === 'passed' && !c.quarantined)) {
    for (const id of check.testIds) {
      const title = id.includes('::') ? id.slice(id.indexOf('::') + 2) : id;
      for (const req of extractRequirementIds(title)) testsByReq.set(req, [...(testsByReq.get(req) ?? []), title]);
    }
  }

  const checkRows = live.map((c) => {
    const recipe = run.configSnapshot.checks.find((r) => r.id === c.recipeId);
    return {
      id: c.recipeId, command: recipe ? recipe.command.join(' ') : c.recipeId, status: c.status,
      passed: c.counts?.passed ?? null, failed: c.counts?.failed ?? null, skipped: c.counts?.skipped ?? null,
      skippedNames: c.skippedTestIds ?? [], durationMs: c.attempts.at(-1)?.durationMs ?? 0, runs: c.attempts.length, quarantined: c.quarantined,
    };
  });

  const openFindings = findings.filter((f) => f.contractVersion === run.contract.version);
  const warnings: ReportWarning[] = [];
  const warn = (text: string) => warnings.push({ level: 'warn', text });
  const info = (text: string) => warnings.push({ level: 'info', text });

  if (run.provider === 'fake') warn('Run mô phỏng: không có bằng chứng thật.');
  for (const c of checkRows) {
    if (c.skipped) warn(`Check "${c.id}" có ${c.skipped} test bị bỏ qua nên không phải bằng chứng${c.skippedNames.length ? `: ${c.skippedNames.slice(0, 3).map((n) => short(n, 90)).join('; ')}${c.skippedNames.length > 3 ? '…' : ''}` : ''}.`);
    if (c.status === 'flaky') warn(`Check "${c.id}" flaky: fail rồi pass khi chạy lại.`);
    if (c.quarantined) warn(`Check "${c.id}" đang bị quarantine nên không tính là bằng chứng.`);
  }
  if (verdictExpected) {
    if (!verdict) warn('Verifier độc lập chưa chạy trên bản này, nên chưa có kiểm chứng độc lập.');
    else if (verdict.decision === 'abstain') warn(`Verifier từ chối kết luận (abstain): ${short(verdict.summary.replace(/\*\*/g, '').replace(/\s+/g, ' '), 360) || 'không nêu lý do'}`);
    else if (verdict.decision === 'skipped') warn('Verifier bị bỏ qua (hết ngân sách kiểm chứng cuối), nên chưa có kiểm chứng độc lập.');
    else if (verdict.decision === 'unparsed') warn('Phản hồi của Verifier không đọc được; coi như chưa kiểm chứng độc lập.');
    else if (verdict.decision === 'block' && !openFindings.some((f) => f.severity !== 'minor')) warn('Verifier đề nghị chặn nhưng không nêu finding cụ thể nào.');
  } else if (run.mode === 'single') info('Single: Planner, viết test và review do cùng một agent làm. Đây là tự review, không phải kiểm chứng độc lập.');
  const manual = matrix.filter((r) => r.manual && r.required);
  if (manual.length) warn(`Cần bạn tự kiểm tra: ${manual.map((r) => r.requirementId).join(', ')} (tiêu chí thủ công, hệ thống không kiểm được).`);
  const minor = openFindings.filter((f) => f.severity === 'minor' && f.status !== 'resolved').length;
  if (minor) info(`${minor} nhận xét mức minor chưa xử lý (không chặn nghiệm thu).`);
  if ((run.approvedPaths ?? []).length) info(`Bạn đã cho phép agent sửa ngoài module: ${(run.approvedPaths ?? []).join(', ')}.`);
  if (artifacts.some((a) => a.kind === 'tool' && a.valid && /not_analyzed/.test(a.content))) info('Công cụ phân tích mã (knip, jscpd, dependency-cruiser) chưa chạy: chưa có đánh giá về mã chết, trùng lặp hay vi phạm ranh giới module.');
  if (!changes.available) info('Không lấy được thống kê thay đổi so với bản gốc; xem diff ở tab Mã nguồn.');
  if (run.repairCount > 0) info(`Task đã qua ${run.repairCount} vòng sửa.`);
  if (budget.capUsd > 0 && budget.spentUsd / budget.capUsd >= 0.9) info(`Đã dùng ${Math.round((budget.spentUsd / budget.capUsd) * 100)}% ngân sách.`);

  const roleOf = new Map(attempts.map((a) => [a.id, a.role]));
  const skillsUsed = new Map<string, AcceptanceReport['skills'][number]>();
  for (const a of artifacts.filter((x) => x.kind === 'context' && x.contractVersion === run.contract.version)) {
    let used: { name: string; delivery: string; hasScripts: boolean }[] = [];
    try { used = (JSON.parse(a.content) as { skills?: typeof used }).skills ?? []; } catch { /* older record without skills */ }
    const role = (a.attemptId && roleOf.get(a.attemptId)) || '?';
    for (const s of used) skillsUsed.set(`${role}:${s.name}`, { role, name: s.name, delivery: s.delivery, hasScripts: s.hasScripts });
  }
  const skills = [...skillsUsed.values()];
  const scripted = [...new Set(skills.filter((s) => s.hasScripts).map((s) => s.name))];
  if (scripted.length) info(`Agent được nạp skill có kèm script (${scripted.join(', ')}): agent có thể đã chạy các script đó trong bản sao làm việc.`);

  const branch = run.branch ?? `aidept/${run.id}-${run.selectedSlot}`;
  const repo = run.configSnapshot.repository;
  const readiness = !completion.ready ? 'not_ready' : warnings.some((w) => w.level === 'warn') ? 'ready_with_warnings' : 'ready';
  return {
    generatedAt: (input.now ?? new Date()).toISOString(), runId: run.id, title: run.title, requirement: run.originalRequirement, mode: run.mode, provider: run.provider,
    readiness, notReadyReasons: completion.reasons, checkpoint: run.checkpoint, baseSha: run.baseSha,
    requirements: matrix.map((r) => ({ id: r.requirementId, text: r.text, required: r.required, manual: r.manual, status: r.status, tests: testsByReq.get(r.requirementId) ?? [] })),
    assumptions: run.contract.assumptions,
    changes: { available: changes.available, files: changes.files, added: changes.files.reduce((n, f) => n + f.added, 0), removed: changes.files.reduce((n, f) => n + f.removed, 0), testFiles: changes.files.map((f) => f.path).filter((p) => isTestPath(p)), patch: changes.patch.length > MAX_PATCH_CHARS ? `${changes.patch.slice(0, MAX_PATCH_CHARS)}\n… (cắt bớt)` : changes.patch },
    checks: checkRows,
    verifier: { expected: verdictExpected, ran: !!verdict && verdict.decision !== 'skipped', verdict, findings: openFindings.map((f) => ({ title: f.title, severity: f.severity, status: f.status, confirmed: f.confirmed, location: f.location })) },
    effort: {
      costUsd: budget.spentUsd, estimated: budget.estimated, tokens: run.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0),
      aiMs: attempts.reduce((n, a) => n + (a.endedAt ? Date.parse(a.endedAt) - Date.parse(a.startedAt) : 0), 0),
      humanMs: run.humanTime.reduce((n, t) => n + (t.durationMs ?? 0), 0), attempts: attempts.length, repairs: run.repairCount,
    },
    scopeApprovals: run.approvedPaths ?? [],
    skills,
    warnings,
    delivery: {
      branch, repository: repo, delivered: input.delivered,
      commands: [`git -C "${repo}" log --oneline HEAD..${branch}`, `git -C "${repo}" diff HEAD..${branch}`, `git -C "${repo}" merge ${branch}`],
    },
  };
}

/** The sum used by the "all warnings acknowledged" rule: only level "warn" needs a person's explicit OK. */
export const needsAcknowledgement = (report: Pick<AcceptanceReport, 'warnings'>): boolean => report.warnings.some((w) => w.level === 'warn');

const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} phút`);

/** Plain Markdown, so the report can be saved, pasted into a PR description, or kept as the record of what was accepted. */
export function renderReportMarkdown(r: AcceptanceReport): string {
  const state = { ready: 'Sẵn sàng nghiệm thu', ready_with_warnings: 'Có thể nghiệm thu sau khi đọc cảnh báo', not_ready: 'Chưa đủ điều kiện nghiệm thu' }[r.readiness];
  const out: string[] = [`# Báo cáo nghiệm thu: ${r.title}`, '', `**Trạng thái:** ${state}`, `**Chế độ:** ${r.mode}${r.provider === 'fake' ? ' (mô phỏng)' : ''} · **Checkpoint:** \`${(r.checkpoint ?? '-').slice(0, 10)}\` · **Tạo lúc:** ${r.generatedAt}`, '', '## Yêu cầu gốc', '', r.requirement, ''];
  if (r.notReadyReasons.length) out.push('## Lý do chưa đủ điều kiện', '', ...r.notReadyReasons.map((x) => `- ${x}`), '');
  if (r.warnings.length) out.push('## Cảnh báo', '', ...r.warnings.map((w) => `- ${w.level === 'warn' ? '**Cần đọc:**' : 'Lưu ý:'} ${w.text}`), '');
  out.push('## Yêu cầu và bằng chứng', '', '| Mã | Yêu cầu | Trạng thái | Test chứng minh |', '|---|---|---|---|');
  for (const q of r.requirements) out.push(`| ${q.id} | ${short(q.text.replace(/\|/g, '/'), 120)} | ${q.status}${q.manual ? ' (thủ công)' : ''} | ${q.tests.length ? q.tests.slice(0, 4).map((t) => short(t.replace(/\|/g, '/'), 70)).join('<br>') + (q.tests.length > 4 ? `<br>… +${q.tests.length - 4}` : '') : '—'} |`);
  out.push('', '## Thay đổi so với bản gốc', '');
  if (!r.changes.available) out.push('_Không lấy được thống kê._');
  else { out.push(`${r.changes.files.length} file, +${r.changes.added} −${r.changes.removed}`, '', ...r.changes.files.map((f) => `- \`${f.path}\` (${f.status}) +${f.added} −${f.removed}`)); }
  out.push('', '## Kết quả chạy test', '');
  if (!r.checks.length) out.push('_Chưa có check nào trên checkpoint này._');
  for (const c of r.checks) out.push(`- \`${c.command}\` → **${c.status}**${c.passed !== null ? ` · ${c.passed} pass, ${c.failed ?? 0} fail, ${c.skipped ?? 0} bỏ qua` : ''} · ${mins(c.durationMs)}${c.runs > 1 ? ` · ${c.runs} lần chạy` : ''}`);
  out.push('', '## Verifier độc lập', '');
  if (!r.verifier.expected) out.push('_Chế độ này không có Verifier độc lập._');
  else if (!r.verifier.verdict) out.push('_Chưa chạy._');
  else out.push(`Kết luận: **${r.verifier.verdict.decision}**`, '', r.verifier.verdict.summary || '_Không có tóm tắt._');
  if (r.verifier.findings.length) out.push('', ...r.verifier.findings.map((f) => `- [${f.severity}/${f.status}] ${f.title}${f.location ? ` (${f.location})` : ''}`));
  if (r.skills.length) out.push('', '## Skill đã dùng', '', ...r.skills.map((s) => `- ${s.role}: ${s.name}${s.hasScripts ? ' (có script)' : ''}`));
  out.push('', '## Công sức', '', `- Chi phí: ~$${r.effort.costUsd.toFixed(2)}${r.effort.estimated ? ' (ước tính)' : ''} · ${r.effort.tokens.toLocaleString('en-US')} token · ${r.effort.attempts} lượt agent · ${mins(r.effort.aiMs)} thời gian AI · ${r.effort.repairs} vòng sửa`, `- Công của bạn: ${mins(r.effort.humanMs)}`);
  out.push('', '## Nhận kết quả', '', `Branch: \`${r.delivery.branch}\` trong \`${r.delivery.repository}\` ${r.delivery.delivered ? '(đã giao)' : '(sẽ được tạo khi nghiệm thu)'}`, '', '```bash', ...r.delivery.commands, '```', '');
  return out.join('\n');
}
