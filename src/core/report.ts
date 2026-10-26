import type { QualityDetail, TestPlanReview,AssertionAudit } from '../shared/quality.js';
import type { Artifact, Attempt, BudgetState, CheckResult, CompletionState, Delivery, DeliveryTarget, Finding, MatrixRow, Run } from '../shared/types.js';
import { delivered, deliveryMatches } from './delivery.js';
import { extractRequirementIds } from './checks.js';
import { isTestPath } from './testpath.js';
import { executionMetrics } from './execution.js';
import type { EnvironmentProbe, ExecutionMetrics, VerifierScope } from '../shared/execution.js';
import type {FindingReplay} from '../shared/reproduction.js';

export interface ChangedFile { path: string; added: number; removed: number; status: 'added' | 'modified' | 'deleted' | 'renamed' }
export interface ReportWarning { level: 'warn' | 'info'; text: string }
export interface VerifierVerdict { decision: 'pass' | 'block' | 'abstain' | 'skipped' | 'unparsed'; summary: string; findingCount: number; scope?: VerifierScope }

/** Fallbacks that weakened the evidence (level warn), so a run that was patched up never counts as a clean one. */
export interface DegradedRun { stages: string[]; items: number }
export function degradedOf(artifacts: readonly Artifact[]): DegradedRun {
  const notes: { stage: string; level?: string }[] = [];
  for (const a of artifacts) {
    if (a.title !== 'Pipeline fallback' || !a.valid) continue;
    try { notes.push(JSON.parse(a.content) as { stage: string; level?: string }); } catch { /* An unreadable note proves nothing either way. */ }
  }
  const weakening = notes.filter(n => n.level !== 'info');
  return { stages: [...new Set(weakening.map(n => n.stage))], items: weakening.length };
}

export interface AcceptanceReport {
  /** Present only when the run was completed with automatic fallbacks that weaken its evidence. */
  degraded?: DegradedRun;
  findingReplays?: FindingReplay[];
  planReview?: TestPlanReview;
  execution?: ExecutionMetrics; environment?: EnvironmentProbe;
  quality: QualityDetail; qualityPolicyVersion?: 1 | 2 | 3;
  generatedAt: string; runId: string; title: string; requirement: string; mode: Run['mode']; provider: Run['provider'];
  /** ready: every automatic condition holds and nothing needs a second look; with_warnings: acceptable only after the person reads the warnings. */
  readiness: 'ready' | 'ready_with_warnings' | 'not_ready'; notReadyReasons: string[];
  checkpoint: string | null; baseSha: string | null;
  requirements: { id: string; text: string; required: boolean; manual: boolean; kind: 'expected' | 'forbidden'; status: MatrixRow['status']; tests: string[] }[];
  assumptions: string[];
  changes: { available: boolean; files: ChangedFile[]; added: number; removed: number; testFiles: string[]; patch: string };
  checks: { id: string; command: string; status: CheckResult['status']; passed: number | null; failed: number | null; skipped: number | null; skippedNames: string[]; durationMs: number; runs: number; quarantined: boolean; issues?: CheckResult['issues'] }[];
  verifier: { expected: boolean; ran: boolean; verdict: VerifierVerdict | null; findings: { title: string; severity: Finding['severity']; status: Finding['status']; confirmed: boolean; location: string }[] };
  effort: { costUsd: number; estimated: boolean; tokens: number; aiMs: number; humanMs: number; attempts: number; repairs: number };
  scopeApprovals: string[];
  /** Library skills the agents were given, per role, read from the context record of each attempt. */
  skills: { role: string; name: string; delivery: string; hasScripts: boolean }[];
  warnings: ReportWarning[];
  delivery: DeliveryTarget & { branch: string; repository: string; delivered: boolean; status: Delivery['status'] | 'unconfirmed'; error?: string; commands: string[] };
}

export interface ReportInput {
  findingReplays?: FindingReplay[];
  assertionAudit?: AssertionAudit[];
  planReview?: TestPlanReview;
  environment?: EnvironmentProbe;
  quality?: QualityDetail; liveChecks?: readonly CheckResult[];
  run: Run; attempts: readonly Attempt[]; checks: readonly CheckResult[]; findings: readonly Finding[]; artifacts: readonly Artifact[];
  matrix: readonly MatrixRow[]; completion: CompletionState; budget: BudgetState;
  changes: { available: boolean; files: ChangedFile[]; patch: string };
  deliveryTarget?: DeliveryTarget; now?: Date;
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
  if (!run.checkpoint) return null;
  const pick = artifacts.filter((a) => a.kind === 'report' && a.title === 'Verifier verdict' && a.valid
    && a.contractVersion === run.contract.version && a.checkpoint === run.checkpoint).at(-1);
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
  const live = input.liveChecks ?? currentChecks(run, input.checks);
  const quality: QualityDetail = input.quality ?? { enabled: false, manifestHash: null, manifestProblems: [], cases: [], capability: { status: 'unsupported', reason: 'Chưa áp dụng kiểm thử sâu.' }, mutation: null, testMs: 0 };
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
      skippedNames: c.skippedTestIds ?? [], durationMs: c.attempts.at(-1)?.durationMs ?? 0, runs: c.attempts.length, quarantined: c.quarantined, issues: c.issues,
    };
  });

  const openFindings = findings.filter((f) => f.contractVersion === run.contract.version);
  const warnings: ReportWarning[] = [];
  const warn = (text: string) => warnings.push({ level: 'warn', text });
  const info = (text: string) => warnings.push({ level: 'info', text });
  for (const receipt of artifacts.filter(a => a.title === 'Test repair receipt' && a.valid && a.contractVersion === run.contract.version)) {
    try {
      const repair = JSON.parse(receipt.content) as { kind?: 'setup' | 'assertion'; caseIds: string[]; reason: string; previousCheckpoint: string; checkpoint: string };
      info(`Test ${repair.caseIds.join(', ')} đã được sửa ${repair.kind === 'assertion' ? 'assertion' : 'setup'} theo diff người dùng duyệt (${repair.previousCheckpoint.slice(0, 8)} → ${repair.checkpoint.slice(0, 8)}): ${repair.reason}`);
    } catch { /* An unreadable audit record is not evidence that a check passed. */ }
  }

  for (const a of artifacts.filter(a => a.title === 'Pipeline fallback' && a.valid)) {
    try { const f = JSON.parse(a.content) as { stage: string; message: string; level?: 'warn' | 'info' }; (f.level === 'info' ? info : warn)(`Tự xử lý ở bước "${f.stage}" thay vì dừng: ${f.message}`); } catch { /* An unreadable note is not evidence either way. */ }
  }
  if (!quality.enabled) info('Chưa áp dụng kiểm thử sâu cho run này.');
  else {
    for (const x of quality.manifestAdvisories ?? []) warn(`Manifest: ${x}`);
    for (const x of quality.planAdvisories ?? []) info(`Kế hoạch ca (đã xác nhận lúc duyệt): ${x}`);
    for (const c of quality.cases.filter(c => c.method === 'manual')) warn(`${c.caseId}: cần kiểm tra thủ công.`);
    for (const c of quality.cases.filter(c => !c.required && c.method === 'automated' && c.status !== 'passed')) warn(`${c.caseId}: ca bổ sung chưa được kiểm tra đạt.`);
    if (quality.capability.status !== 'available') warn(`Mutation: ${quality.capability.reason}${quality.capability.install ? ` ${quality.capability.install}` : ''}`);
    else if (!quality.mutation || quality.mutation.status !== 'completed') warn(`Mutation chưa hoàn tất: ${quality.mutation?.message ?? 'Chưa chạy trên checkpoint này.'}`);
    if (quality.mutation) {
      const m = quality.mutation;
      if (m.workspace) warn('Chưa dọn được bản sao mutation; dữ liệu này không nằm trong bản bàn giao.');
      if (m.counts.survived || m.counts.no_coverage) warn(`Mutation còn ${m.counts.survived} sống sót và ${m.counts.no_coverage} không được test phủ; cần xem chất lượng assertion.`);
      if (m.counts.timeout || m.counts.errors || m.counts.pending || m.pendingUnknown) warn(`Mutation: ${m.counts.timeout} timeout, ${m.counts.errors} lỗi công cụ/biên dịch, ${m.pendingUnknown ? 'chưa xác định số mutation' : m.counts.pending} chưa chạy; không tính là test bắt lỗi.`);
    }
  }
  if (run.provider === 'fake') warn('Run mô phỏng: không có bằng chứng thật.');
  for(const audit of input.assertionAudit??[])if(audit.status==='unsupported')warn(`Assertion ${audit.path}: ${audit.message}`);
  const findingReplays=input.findingReplays??[];
  for(const finding of findings.filter(f=>f.contractVersion===run.contract.version)){
    if(finding.reproductionLimitation)warn(`Phản ví dụ ${finding.title}: ${finding.reproductionLimitation}`);
    const replay=findingReplays.filter(r=>r.findingId===finding.id&&r.checkpoint===run.checkpoint).at(-1);
    if(finding.reproduction&&!replay)warn(`Chưa có kết quả phản ví dụ phù hợp checkpoint/cấu hình hiện tại: ${finding.title}.`);
    if(replay&&['error','unsupported','timeout','interrupted','in_progress'].includes(replay.status))warn(`Tái hiện ${finding.title}: ${replay.status}. ${replay.message}`);
    if(replay?.status==='reproduced'&&finding.status==='resolved')warn(`Finding đã đánh dấu xử lý nhưng phản ví dụ còn tái hiện ở checkpoint này: ${finding.title}.`);
  }
  for (const c of checkRows) {
    if (c.skipped) warn(`Check "${c.id}" có ${c.skipped} test bị bỏ qua nên không phải bằng chứng${c.skippedNames.length ? `: ${c.skippedNames.slice(0, 3).map((n) => short(n, 90)).join('; ')}${c.skippedNames.length > 3 ? '…' : ''}` : ''}.`);
    if (c.status === 'flaky') warn(`Check "${c.id}" flaky: fail rồi pass khi chạy lại.`);
    if (c.quarantined) warn(`Check "${c.id}" đang bị quarantine nên không tính là bằng chứng.`);
  }
  if (verdictExpected) {
    if(verdict && !verdict.scope)warn('Verifier chưa ghi nhận phạm vi kiểm chứng; pass không xác nhận đã tự chạy test thành công.');
    for(const limitation of verdict?.scope?.limitations??[])warn(`Giới hạn Verifier: ${limitation}`);
    for(const check of verdict?.scope?.additionalChecks.filter(c=>c.status!=='passed')??[])warn(`Verifier: ${check.command} → ${check.status}: ${check.detail}`);
    if (!verdict) warn('Bản code này chưa có kết luận Verifier.');
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
  const receipt = deliveryMatches(run) ? run.delivery : undefined;
  const target = receipt ?? input.deliveryTarget ?? { kind: 'branch' as const, target: branch };
  if (run.status === 'completed' && !delivered(run)) warn('Lịch sử đã nghiệm thu nhưng chưa xác nhận giao kết quả cho bản code này. Workspace được giữ để thử giao lại.');
  const readiness = !completion.ready ? 'not_ready' : warnings.some((w) => w.level === 'warn') ? 'ready_with_warnings' : 'ready';
  return {
    planReview: input.planReview,
    ...(degradedOf(artifacts).items ? { degraded: degradedOf(artifacts) } : {}),
    findingReplays,
    execution:executionMetrics(run,attempts,(input.now??new Date()).getTime()),
    environment:input.environment,
    quality, qualityPolicyVersion: run.qualityPolicyVersion, generatedAt: (input.now ?? new Date()).toISOString(), runId: run.id, title: run.title, requirement: run.originalRequirement, mode: run.mode, provider: run.provider,
    readiness, notReadyReasons: completion.reasons, checkpoint: run.checkpoint, baseSha: run.baseSha,
    requirements: matrix.map((r) => ({ id: r.requirementId, text: r.text, required: r.required, manual: r.manual, kind: r.kind ?? 'expected', status: r.status, tests: testsByReq.get(r.requirementId) ?? [] })),
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
      kind: target.kind, target: target.target, branch, repository: repo, delivered: delivered(run),
      status: receipt?.status ?? 'unconfirmed', error: receipt?.error,
      commands: target.kind === 'files' ? [] : [`git -C "${repo}" log --oneline HEAD..${branch}`, `git -C "${repo}" diff HEAD..${branch}`, `git -C "${repo}" merge ${branch}`],
    },
  };
}

/** The sum used by the "all warnings acknowledged" rule: only level "warn" needs a person's explicit OK. */
export const needsAcknowledgement = (report: Pick<AcceptanceReport, 'warnings'>): boolean => report.warnings.some((w) => w.level === 'warn');

const mins = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} phút`);

/** Plain Markdown, so the report can be saved, pasted into a PR description, or kept as the record of what was accepted. */
export function renderReportMarkdown(r: AcceptanceReport): string {
  const state = { ready: 'Sẵn sàng nghiệm thu', ready_with_warnings: 'Có thể nghiệm thu sau khi đọc cảnh báo', not_ready: 'Chưa đủ điều kiện nghiệm thu' }[r.readiness];
  const out: string[] = [`# Báo cáo nghiệm thu: ${r.title}`, '', `**Trạng thái:** ${state}${r.degraded ? ' — **chạy suy giảm**' : ''}`, `**Chế độ:** ${r.mode}${r.provider === 'fake' ? ' (mô phỏng)' : ''} · **Checkpoint:** \`${(r.checkpoint ?? '-').slice(0, 10)}\` · **Tạo lúc:** ${r.generatedAt}`, '', '## Yêu cầu gốc', '', r.requirement, ''];
  if (r.degraded) out.push(`> **Chạy suy giảm:** ${r.degraded.items} bước đã được hệ thống tự xử lý thay vì dừng (${r.degraded.stages.join(', ')}). Bằng chứng yếu hơn một run sạch; xem mục Cảnh báo.`, '');
  if (r.notReadyReasons.length) out.push('## Lý do chưa đủ điều kiện', '', ...r.notReadyReasons.map((x) => `- ${x}`), '');
  if (r.warnings.length) out.push('## Cảnh báo', '', ...r.warnings.map((w) => `- ${w.level === 'warn' ? '**Cần đọc:**' : 'Lưu ý:'} ${w.text}`), '');
  out.push('## Yêu cầu và bằng chứng', '', '| Mã | Yêu cầu | Hành vi | Trạng thái | Test chứng minh |', '|---|---|---|---|---|');
  for (const q of r.requirements) out.push(`| ${q.id} | ${short(q.text.replace(/\|/g, '/'), 120)} | ${q.kind === 'forbidden' ? 'Không được xảy ra' : 'Mong muốn'} | ${q.status}${q.manual ? ' (thủ công)' : ''} | ${q.tests.length ? q.tests.slice(0, 4).map((t) => short(t.replace(/\|/g, '/'), 70)).join('<br>') + (q.tests.length > 4 ? `<br>… +${q.tests.length - 4}` : '') : '—'} |`);
  out.push('', '## Các ca đã khai báo và rủi ro còn lại', '');
  if (!r.quality.enabled) out.push('Chưa áp dụng kiểm thử sâu cho run này.');
  else {
    out.push('| Ca | Bắt buộc | Kết quả | Test chứng minh |', '|---|---|---|---|');
    for (const c of r.quality.cases) out.push(`| ${c.caseId} | ${c.required ? 'Có' : 'Bổ sung'} | ${c.status} | ${c.tests.join('; ').replace(/\|/g, '/')} |`);
    out.push('', `Manifest: ${r.quality.manifestHash ?? 'chưa có'}; thời gian check: ${mins(r.quality.testMs)}.`, '', `Mutation: ${r.quality.capability.status} — ${r.quality.capability.reason}`);
    if (r.quality.mutation) {
      const m = r.quality.mutation;
      out.push(`Trạng thái: ${m.status}; baseline: ${m.baseline}; ${mins(m.durationMs)}.`, `Killed: ${m.counts.killed}; survived: ${m.counts.survived}; no coverage: ${m.counts.no_coverage}; timeout: ${m.counts.timeout}; lỗi: ${m.counts.errors}; chưa chạy: ${m.pendingUnknown ? 'chưa xác định' : m.counts.pending}.`, m.message);
      for (const mutant of m.mutants.filter(x => x.status !== 'Killed')) out.push(`- ${mutant.file}:${mutant.line} — ${mutant.mutator}: ${mutant.status}`);
    }
    for (const c of r.quality.plan?.cases ?? []) if (c.oracle) out.push(`Căn cứ ${c.id}: ${c.oracle.references.map(ref => `${ref.requirementId}: ${ref.quote}`).join('; ')}. ${c.oracle.explanation}`);
    for(const c of r.quality.plan?.cases??[])for(const step of c.steps??[])if(step.id)out.push(`- ${c.id}.${step.id} (${step.requirementIds?.join(', ')??'chưa ghi căn cứ'}): trước=${step.before??'?'}; thao tác=${step.action}; expected=${step.expected}; sau=${step.after??'?'}.`);
    out.push('', 'Các ca đã khai báo đạt không chứng minh mọi tình huống nghiệp vụ đều được kiểm tra.');
  }
  out.push('', '## Thay đổi so với bản gốc', '');
  if (!r.changes.available) out.push('_Không lấy được thống kê._');
  else { out.push(`${r.changes.files.length} file, +${r.changes.added} −${r.changes.removed}`, '', ...r.changes.files.map((f) => `- \`${f.path}\` (${f.status}) +${f.added} −${f.removed}`)); }
  out.push('', '## Kết quả chạy test', '');
  for (const c of r.checks) for (const issue of c.issues ?? []) out.push(`- ${c.id} · ${issue.kind}: ${issue.message}`);
  if (!r.checks.length) out.push('_Chưa có check nào trên checkpoint này._');
  for (const c of r.checks) out.push(`- \`${c.command}\` → **${c.status}**${c.passed !== null ? ` · ${c.passed} pass, ${c.failed ?? 0} fail, ${c.skipped ?? 0} bỏ qua` : ''} · ${mins(c.durationMs)}${c.runs > 1 ? ` · ${c.runs} lần chạy` : ''}`);
  out.push('', '## Verifier độc lập', '');
  if(r.verifier.verdict?.scope){const scope=r.verifier.verdict.scope;out.push(`Đã review: ${scope.reviewed.join('; ')||'chưa ghi nhận'}.`, `Bằng chứng runner: ${scope.checkIds.join(', ')||'không tham chiếu'}.`,...scope.limitations.map(l=>`- Giới hạn: ${l}`),...scope.additionalChecks.map(c=>`- ${c.command}: ${c.status} — ${c.detail}`));}
  if (!r.verifier.expected) out.push('_Chế độ này không có Verifier độc lập._');
  else if (!r.verifier.verdict) out.push('_Bản code này chưa có kết luận Verifier._');
  else out.push(`Kết luận: **${r.verifier.verdict.decision}**`, '', r.verifier.verdict.summary || '_Không có tóm tắt._');
  if (r.verifier.findings.length) out.push('', ...r.verifier.findings.map((f) => `- [${f.severity}/${f.status}] ${f.title}${f.location ? ` (${f.location})` : ''}`));
  if(r.findingReplays?.length)out.push('','## Phản ví dụ đã chạy','',...r.findingReplays.flatMap(p=>[`- ${p.findingId} @ ${p.checkpoint.slice(0,8)}: **${p.status}** (${p.durationMs} ms). ${p.message}`,...(p.oracle?[`  - Căn cứ: ${p.oracle.references.map(r=>`${r.requirementId}: ${r.quote}`).join('; ')}. ${p.oracle.explanation}`]:[]),...p.observations.filter(o=>o.matched!==undefined).map(o=>`  - ${o.stepId}: expected=${JSON.stringify(o.expected)}; actual=${JSON.stringify(o.actual)} (${o.actualType??'JSON'}); matched=${o.matched}`)]));
  if (r.skills.length) out.push('', '## Skill đã dùng', '', ...r.skills.map((s) => `- ${s.role}: ${s.name}${s.hasScripts ? ' (có script)' : ''}`));
  out.push('', '## Công sức', '', `- Chi phí: ~$${r.effort.costUsd.toFixed(2)}${r.effort.estimated ? ' (ước tính)' : ''} · ${r.effort.tokens.toLocaleString('en-US')} token · ${r.effort.attempts} lượt agent · ${mins(r.effort.aiMs)} thời gian AI · ${r.effort.repairs} vòng sửa`, `- Công của bạn: ${mins(r.effort.humanMs)}`);
  out.push('', '## Nhận kết quả', '', `Trạng thái giao: **${r.delivery.status}**${r.delivery.delivered ? ' (đã giao đúng checkpoint và hợp đồng)' : ' (chưa xác nhận giao thành công)'}`,
    r.delivery.kind === 'files' ? `Ghi file trực tiếp vào \`${r.delivery.target}\`.` : `Branch: \`${r.delivery.target}\` trong \`${r.delivery.repository}\`.`);
  if (r.delivery.error) out.push('', `Lỗi giao: ${r.delivery.error}`);
  if (r.delivery.commands.length) out.push('', '```bash', ...r.delivery.commands, '```');
  out.push('');
  out.push('', '## Thời gian thực thi', '');
  if(!r.execution?.available)out.push('Chưa có số đo.');
  else {out.push(`Tự động: ${mins(r.execution.automaticMs??0)}; chờ: ${mins(r.execution.waitingMs??0)}; chờ slot agent: ${mins(r.execution.agentQueueMs??0)}.`, '', '| Bước | Trạng thái | Bắt đầu | Kết thúc |', '|---|---|---|---|');for(const s of r.execution.spans)out.push(`| ${s.label.replace(/\|/g,'/')} | ${s.status} | ${s.startedAt} | ${s.endedAt??'đang chạy'} |`);out.push(`Lượt theo vai: ${JSON.stringify(r.execution.attemptsByRole)}.`, `Nguyên nhân chạy lại: ${JSON.stringify(r.execution.retries)}.`);}
  if(r.planReview) {
    const p = r.planReview;
    out.push('', '## Soát kế hoạch ca', '', `Hợp lệ lượt đầu: ${p.firstPassValid ? 'có' : 'không'}; lượt Author: ${p.attemptIds.length}; đã sửa: ${p.repairAttempted ? 'có' : 'không'}; sửa hợp lệ: ${p.repairAccepted ? 'có' : 'không'}; kết quả: ${p.outcome}.`,
      'Validator chỉ kiểm tra cấu trúc và liên kết, không chứng minh đầy đủ nghiệp vụ.', ...p.remainingProblems.map(x => `- ${x}`),
      ...(p.remainingAdvisories?.length ? ['', 'Lưu ý về hình thức (không chặn duyệt):', ...p.remainingAdvisories.map(x => `- ${x}`)] : []),
      ...(p.normalizations?.length ? ['', 'Server đã chuẩn hoá (không đổi nội dung nghiệp vụ):', ...p.normalizations.map(x => `- ${x}`)] : []));
  }
  if(r.environment)out.push('',`Môi trường: ${r.environment.status}; runtime ${r.environment.runtime}.`,r.environment.limitation,...r.environment.checks.map(c=>`- ${c.recipeId}: ${c.status} — ${c.message}`));
  return out.join('\n');
}
