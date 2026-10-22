import { randomUUID } from 'node:crypto';
import type {
  Artifact, Attempt, CheckResult, Finding, HumanTime, Independence, Interpretation, MemoryItem, Mode,
  ProjectProfile, Role, Run, RunDetail, RunStatus, RunningCheck, Slot, Stage, TaskContract, TaskKind, UsageRecord,
} from '../shared/types.js';
import { MAX_REPAIRS_PER_CANDIDATE, budgetState, candidateCap, candidateSpend, checkEscalation, remainingFor } from '../core/budget.js';
import { parseTestReport, ranNoTests, shouldRetry, summarizeCheck, summarizeFailures, evaluateRedGreen } from '../core/checks.js';
import { buildMatrix, evaluateCompletion } from '../core/completion.js';
import { approveContract, initialContract, isApproved, reviseContract, sha256, validateContract } from '../core/contract.js';
import { gateFinding } from '../core/findings.js';
import { FindingsSchema, ContractProposalSchema, InterpretationSchema, ReuseAssessmentSchema, parseOutput } from '../core/outputs.js';
import { PROMPTS } from '../core/prompts.js';
import { contextRoleOf, selectContext } from '../core/context.js';
import { staleReason } from '../core/memory.js';
import { buildRepoMap } from '../core/repomap.js';
import { buildReport, needsAcknowledgement, readVerdict, type AcceptanceReport, type ChangedFile, type VerifierVerdict } from '../core/report.js';
import { MODE_MULTIPLIER, recommendMode } from '../core/routing.js';
import { classifyPath, evaluateChanges, isSafeRelative, normalizePath, type ScopeInput } from '../core/scope.js';
import { selectCandidate, type CandidateEval } from '../core/selection.js';
import { ANALYSIS_TOOLS, toolDelta } from '../core/tools.js';
import { redactSecrets } from '../runtime/process.js';
import { describeProviderLine, type LogLevel } from '../runtime/describe.js';
import { RuntimeBlockedError, type Runtime, type RuntimeCheckResult, type RuntimeEvent } from '../runtime/types.js';
import { Semaphore, SerialQueue } from './scheduler.js';
import type { Store } from './store.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}
/** A stage cannot continue and needs a person; the run parks in `blocked` with this explanation. */
class Blocked extends Error {}
class Stopped extends Error {}

const TEST_PATH = /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
/** The reviewer's prose without its trailing JSON block, capped: this is what a person reads on the acceptance report. */
const verifierNarrative = (output: string): string => output.replace(/```json[\s\S]*?```/g, '').replace(/\*\*/g, '').trim().slice(0, 3000);
/** Includes the Claude subscription messages ("5-hour limit reached ∙ resets 3pm", "You've hit your weekly limit"). */
const QUOTA = /quota|rate.?limit|usage limit|limit reached|hit your [\w -]*limit|resource.?exhausted|\b429\b/i;
/** The provider's servers are busy: nothing is wrong with the task, and the same model usually works again minutes later. */
const CAPACITY = /at capacity|overloaded|\b503\b|server is busy|try a different model/i;
const FOLLOWUP_DAYS = 7;
const WAITING: RunStatus[] = ['draft', 'awaiting_approval', 'paused', 'blocked', 'failed', 'awaiting_acceptance', 'completed'];

export interface CreateRunInput {
  projectId: string; title: string; originalRequirement: string; mode: Mode; provider: Run['provider'];
  budgetUsd: number; signals: string[]; taskKind?: TaskKind;
}
export interface OrchestratorOptions { agentSlots?: number; now?: () => Date; /** How often a long step reports "still running" (default 30s). */ heartbeatMs?: number }

interface CandidateRecord { slot: Slot; checkpoint: string | null; success: boolean; problems: string[]; fatal: boolean; changedFiles: string[]; testFiles: string[]; newToolIssues: number; flakyChecks: number; summary: string }

export class Orchestrator {
  private readonly queue: SerialQueue;
  private readonly agents: Semaphore;
  private readonly aborts = new Map<string, AbortController>();
  private readonly runningChecks = new Map<string, RunningCheck>();
  private readonly sessions = new Map<string, { sessionId: string; cumulative?: import('../runtime/providers.js').UsageCheckpoint }>();
  private readonly now: () => Date;
  private readonly heartbeatMs: number;

  constructor(private readonly store: Store, private readonly runtimeFor: (run: Run) => Runtime, options: OrchestratorOptions = {}) {
    this.queue = new SerialQueue((id) => this.drive(id));
    this.agents = new Semaphore(options.agentSlots ?? 3);
    this.now = options.now ?? (() => new Date());
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Interrupted attempts cannot be trusted; park their runs so a person decides when to resume. */
  /**
   * Attempts recorded before the real model name was read show "default". Fill in what the Codex session logs still
   * say, newest first and bounded; anything not found stays as it was.
   */
  async backfillModels(limit = 500): Promise<number> {
    const { resolveCodexModel } = await import('../runtime/codexmodel.js');
    let filled = 0;
    const todo = this.store.attempts.list().filter((a) => a.model === 'default' && a.sessionId && a.provider === 'codex').sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
    for (const a of todo) {
      const model = await resolveCodexModel(a.sessionId!, a.startedAt).catch(() => undefined);
      if (!model) continue;
      const current = this.store.attempts.get(a.id);
      if (current && current.model === 'default') { this.store.attempts.put({ ...current, model }); filled++; }
    }
    return filled;
  }

  async recover(): Promise<void> {
    for (const attempt of this.store.attempts.list().filter((a) => a.status === 'running')) {
      const run = this.store.runs.get(attempt.runId);
      if (run) await this.runtimeFor(run).stop(attempt.id).catch(() => undefined);
      this.store.attempts.put({ ...attempt, status: 'interrupted', endedAt: this.stamp(), error: 'Server dừng khi attempt đang chạy.' });
    }
    for (const run of this.store.runs.list().filter((r) => r.status === 'running' || r.status === 'queued')) {
      this.mutate(run.id, (r) => { r.status = 'paused'; r.blocker = `Bị gián đoạn ở giai đoạn "${r.stage}". Resume sẽ chạy lại giai đoạn từ checkpoint đã chấp nhận.`; });
      this.log(run.id, 'recovery', 'Run bị gián đoạn và được tạm dừng.');
    }
  }

  createRun(input: CreateRunInput): Run {
    const project = this.store.projects.get(input.projectId);
    if (!project) throw new HttpError(404, 'Project không tồn tại.');
    if (input.provider !== 'fake' && !project.approved) throw new HttpError(409, 'Project chưa duyệt policy; chỉ run mô phỏng được phép.');
    if (!(input.budgetUsd > 0)) throw new HttpError(400, 'Ngân sách phải lớn hơn 0.');
    const recommendation = recommendMode(input.signals);
    const now = this.stamp();
    const budget = input.mode === 'single' ? input.budgetUsd : input.budgetUsd * MODE_MULTIPLIER[input.mode];
    const run: Run = {
      id: `run_${randomUUID().slice(0, 8)}`, projectId: project.id, title: input.title, originalRequirement: input.originalRequirement,
      mode: input.mode, initialMode: input.mode, taskKind: input.taskKind, selectedSlot: 'A', provider: input.provider,
      status: 'draft', stage: 'prepare', contract: initialContract(input.originalRequirement), interpretations: [],
      baseSha: null, checkpoint: null, branch: null, budgetUsd: budget, baseBudgetUsd: input.budgetUsd,
      configSnapshot: structuredClone(project), signals: input.signals, recommendation, escalations: [], usage: [], humanTime: [],
      repairCount: 0, blocker: null, createdAt: now, updatedAt: now,
    };
    this.store.runs.put(run);
    this.log(run.id, 'run.created', `Tạo task ở chế độ ${run.mode}; đề xuất: ${recommendation.mode}.`, { recommendation });
    return run;
  }

  startRun(runId: string): Run {
    const run = this.run(runId);
    if (!['draft', 'paused', 'blocked', 'failed'].includes(run.status)) throw new HttpError(409, `Không thể bắt đầu run ở trạng thái ${run.status}.`);
    // "Run again" must actually try again; failed candidates are only kept across an escalation.
    this.discardFailedCandidates(runId);
    return this.enqueue(runId);
  }

  /**
   * A run that has no checkpoint yet has no evidence tied to its configuration, so resuming it picks up the project's
   * latest modules, checks and guidance (e.g. after widening the allowed modules). Runs with a checkpoint keep their
   * snapshot until someone re-runs the checks.
   */
  resumeRun(runId: string): Run {
    const run = this.run(runId);
    const project = this.store.projects.get(run.projectId);
    if (project && !run.checkpoint && ['paused', 'blocked', 'failed'].includes(run.status) && project.version !== run.configSnapshot.version && (project.approved || run.provider === 'fake')) {
      this.mutate(runId, (r) => { r.configSnapshot = structuredClone(project); });
      this.log(runId, 'config.refreshed', `Run chưa có checkpoint nên dùng cấu hình mới nhất của project (v${project.version}): module ${project.modules.join(', ')}`);
    }
    if (!run.checkpoint && run.context && ['paused', 'blocked', 'failed'].includes(run.status)) this.mutate(runId, (r) => { delete r.context; });
    return this.startRun(runId);
  }

  stopRun(runId: string): Run {
    const run = this.run(runId);
    this.aborts.get(runId)?.abort();
    this.queue.dequeue(runId);
    if (run.status === 'queued') this.mutate(runId, (r) => { r.status = 'paused'; r.blocker = 'Đã dừng bởi người dùng.'; });
    for (const attempt of this.store.attempts.list(runId).filter((a) => a.status === 'running')) void this.runtimeFor(run).stop(attempt.id);
    this.log(runId, 'run.stop', 'Người dùng yêu cầu dừng.');
    return this.run(runId);
  }

  /**
   * Deletes a run and its records. A run that is queued or still has a step in flight must be stopped first, so no
   * agent or check writes into a run that no longer exists. The caller removes the working copy on disk.
   */
  deleteRun(runId: string): Run {
    const run = this.run(runId);
    if (this.busy(run)) throw new HttpError(409, 'Việc đang chạy; bấm Dừng rồi mới xoá được.');
    this.forget(runId);
    this.store.purgeRun(runId);
    return run;
  }

  /** Deletes a project with all of its runs and memory; refused while any of its runs is working. */
  deleteProject(projectId: string): { project: ProjectProfile; runs: Run[] } {
    const project = this.store.projects.get(projectId);
    if (!project) throw new HttpError(404, 'Project không tồn tại.');
    const runs = this.store.runs.list(projectId);
    const working = runs.filter((r) => this.busy(r));
    if (working.length) throw new HttpError(409, `Dự án còn ${working.length} việc đang chạy; dừng chúng rồi mới xoá được.`);
    runs.forEach((r) => this.forget(r.id));
    this.store.purgeProject(projectId);
    return { project, runs };
  }

  private busy(run: Run): boolean { return ['running', 'queued'].includes(run.status) || this.aborts.has(run.id) || this.queue.isQueued(run.id); }

  private forget(runId: string): void {
    this.queue.dequeue(runId);
    for (const key of [...this.sessions.keys()]) if (key.startsWith(`${runId}:`)) this.sessions.delete(key);
    this.baseFileCache.delete(runId); this.repairRequests.delete(runId); this.recheckRequests.delete(runId);
  }

  approveContract(runId: string): Run {
    const run = this.run(runId);
    if (run.status !== 'awaiting_approval') throw new HttpError(409, 'Hợp đồng chỉ được duyệt khi run đang chờ duyệt.');
    const contract = this.guard(() => approveContract(run.contract, this.now()));
    this.mutate(runId, (r) => { r.contract = contract; });
    this.log(runId, 'contract.approved', `Đã duyệt hợp đồng v${contract.version}.`, { hash: contract.approvedHash });
    return this.enqueue(runId);
  }

  /** Any real change bumps the version and strands every earlier piece of evidence. */
  reviseContract(runId: string, next: Omit<TaskContract, 'version' | 'approvedHash' | 'approvedAt'>): Run {
    const run = this.run(runId);
    if (!WAITING.includes(run.status)) throw new HttpError(409, 'Không thể sửa hợp đồng khi run đang chạy.');
    const revised = reviseContract(run.contract, next);
    const problems = validateContract(revised);
    if (problems.length) throw new HttpError(400, problems.join(' '));
    if (revised === run.contract) return run;
    this.invalidateEvidence(runId, revised.version);
    this.mutate(runId, (r) => { r.contract = revised; r.status = 'awaiting_approval'; r.blocker = null; });
    this.log(runId, 'contract.revised', `Hợp đồng lên v${revised.version}; bằng chứng cũ mất hiệu lực.`);
    return this.run(runId);
  }

  escalate(runId: string, to: Mode, reason: string, approvedCapUsd?: number): Run {
    const run = this.run(runId);
    if (!['blocked', 'paused', 'failed', 'awaiting_acceptance'].includes(run.status)) throw new HttpError(409, 'Chỉ chuyển chế độ khi run đang chờ người dùng.');
    if (to === run.mode) throw new HttpError(400, 'Run đã ở chế độ này.');
    const spent = budgetState(run, this.store.attempts.list(runId)).spentUsd;
    const check = checkEscalation(run, spent, to, approvedCapUsd);
    if (!check.allowed) throw new HttpError(409, check.reason);
    this.mutate(runId, (r) => {
      r.escalations.push({ from: r.mode, to, reason, at: this.stamp() });
      r.mode = to; r.budgetUsd = check.newCapUsd;
    });
    this.log(runId, 'run.escalate', `Chuyển ${run.mode} → ${to}: ${reason}`, { budgetUsd: check.newCapUsd });
    return this.enqueue(runId);
  }

  /**
   * The acceptance report: what was asked, what changed, which tests ran and what they proved, the independent
   * reviewer's verdict and every warning. Built on demand so it always reflects the live checkpoint.
   */
  async report(runId: string): Promise<AcceptanceReport> {
    this.recoverVerdict(runId);
    const detail = this.detail(runId);
    const run = detail.run;
    let changes: { available: boolean; files: ChangedFile[]; patch: string } = { available: false, files: [], patch: '' };
    const runtime = this.runtimeFor(run);
    if (run.checkpoint && runtime.diffSinceBase) {
      try { changes = { available: true, ...(await runtime.diffSinceBase(run, run.selectedSlot)) }; }
      catch (error) { this.log(runId, 'report.diff_failed', `Không lấy được thống kê thay đổi: ${redactSecrets((error as Error).message)}`); }
    }
    return buildReport({
      run, attempts: detail.attempts, checks: detail.checks, findings: detail.findings, artifacts: detail.artifacts, matrix: detail.matrix,
      completion: detail.completion, budget: detail.budget, changes, delivered: detail.events.some((e) => e.type === 'deliver'), now: this.now(),
    });
  }

  async acceptRun(runId: string, options: { acknowledgeWarnings?: boolean } = {}): Promise<Run> {
    const detail = this.detail(runId);
    if (detail.run.status !== 'awaiting_acceptance') throw new HttpError(409, 'Run chưa sẵn sàng nghiệm thu.');
    if (!detail.completion.ready) throw new HttpError(409, `Chưa đủ điều kiện nghiệm thu: ${detail.completion.reasons.join(' ')}`);
    // Accepting is a decision about what the report says, so warnings must have been read and acknowledged.
    const report = await this.report(runId);
    if (needsAcknowledgement(report) && !options.acknowledgeWarnings) {
      throw new HttpError(409, `Báo cáo có ${report.warnings.filter((w) => w.level === 'warn').length} cảnh báo cần đọc; hãy xác nhận đã đọc trước khi nghiệm thu.`);
    }
    this.artifact(runId, { kind: 'report', title: 'Báo cáo nghiệm thu', content: JSON.stringify({ report, acknowledgedWarnings: !!options.acknowledgeWarnings }), checkpoint: detail.run.checkpoint });
    // Delivery adds a new branch to the original repository. It is attempted first but never blocks acceptance:
    // the work stays in the workspace clone, and the failure is recorded for a person to resolve.
    const run = detail.run;
    const deliver = this.runtimeFor(run).deliver;
    if (deliver) {
      try { const result = await deliver.call(this.runtimeFor(run), run, run.selectedSlot); const isBranch = result.startsWith('aidept/'); this.log(runId, 'deliver', isBranch ? `Đã tạo branch ${result} trong repository gốc.` : `Đã giao kết quả: ${result}.`, { branch: isBranch ? result : undefined }); }
      catch (error) { this.log(runId, 'deliver.failed', `Không giao được kết quả về project gốc: ${redactSecrets((error as Error).message)}`); }
    }
    // One instant for both fields, so the follow-up window is exactly seven days.
    const accepted = this.now();
    const followup = new Date(accepted.getTime() + FOLLOWUP_DAYS * 86_400_000).toISOString();
    this.mutate(runId, (r) => { r.status = 'completed'; r.acceptedAt = accepted.toISOString(); r.followupUntil = followup; r.blocker = null; this.closeTimers(r); });
    this.log(runId, 'run.accepted', 'Đã nghiệm thu; bắt đầu cửa sổ theo dõi 7 ngày.');
    return this.run(runId);
  }

  /** A person found the delivery lacking. This is rework, not a new task, so the cost stays attached. */
  rejectAcceptance(runId: string, reason: string): Run {
    const run = this.run(runId);
    if (run.status !== 'awaiting_acceptance') throw new HttpError(409, 'Run không ở bước nghiệm thu.');
    this.mutate(runId, (r) => { r.status = 'blocked'; r.blocker = `Từ chối nghiệm thu: ${reason}`; });
    this.log(runId, 'run.rejected', `Từ chối nghiệm thu: ${reason}`);
    return this.run(runId);
  }

  // ------------------------------------------------------------ findings/checks

  confirmFinding(runId: string, findingId: string): Finding { return this.patchFinding(runId, findingId, (f) => { f.confirmed = true; f.status = 'open'; }); }
  disputeFinding(runId: string, findingId: string, dispute: string): Finding { return this.patchFinding(runId, findingId, (f) => { f.status = 'disputed'; f.dispute = dispute; }); }
  resolveFinding(runId: string, findingId: string): Finding { return this.patchFinding(runId, findingId, (f) => { f.status = 'resolved'; }); }

  private patchFinding(runId: string, id: string, change: (f: Finding) => void): Finding {
    const finding = this.store.findings.get(id);
    if (!finding || finding.runId !== runId) throw new HttpError(404, 'Finding không tồn tại.');
    change(finding);
    this.store.findings.put(finding);
    this.log(runId, 'finding.update', `Finding "${finding.title}" → ${finding.status}${finding.confirmed ? ' (đã xác nhận)' : ''}.`);
    this.refreshAcceptanceState(runId);
    return finding;
  }

  /** Quarantine needs a reason and a condition to revisit; a quarantined check never counts as evidence. */
  quarantineCheck(runId: string, checkId: string, reason: string): CheckResult {
    const check = this.store.checks.get(checkId);
    if (!check || check.runId !== runId) throw new HttpError(404, 'Check không tồn tại.');
    if (reason.trim().length < 3) throw new HttpError(400, 'Cần nêu lý do và điều kiện xem xét lại.');
    check.quarantined = true; check.quarantineReason = reason.trim();
    this.store.checks.put(check);
    this.log(runId, 'check.quarantine', `Quarantine "${check.recipeId}": ${reason}`);
    this.refreshAcceptanceState(runId);
    return check;
  }

  /** Confirmed findings get one repair round funded by the final-verification share. */
  repairFindings(runId: string): Run {
    const run = this.run(runId);
    if (!['blocked', 'awaiting_acceptance'].includes(run.status)) throw new HttpError(409, 'Chỉ sửa finding khi run đang chờ người dùng.');
    const targets = this.store.findings.list(runId).filter((f) => f.confirmed && f.status === 'open' && f.contractVersion === run.contract.version);
    if (!targets.length) throw new HttpError(409, 'Chưa có finding nào được xác nhận.');
    this.mutate(runId, (r) => { r.status = 'queued'; r.blocker = null; });
    this.repairRequests.add(runId);
    this.queue.enqueue(runId);
    return this.run(runId);
  }
  private readonly repairRequests = new Set<string>();
  private readonly recheckRequests = new Set<string>();
  private readonly baseFileCache = new Map<string, ReadonlySet<string>>();

  /**
   * Runs the checks again on the existing checkpoint, optionally with the project's latest configuration
   * (check command, modules, setup). No agent runs, so it costs no tokens.
   */
  recheck(runId: string, refreshConfig = true): Run {
    const run = this.run(runId);
    if (!['blocked', 'paused', 'failed'].includes(run.status)) throw new HttpError(409, 'Chỉ chạy lại check khi run đang chờ người dùng.');
    if (run.mode === 'compare') throw new HttpError(409, 'Chế độ Compare chưa hỗ trợ chạy lại check riêng; dùng Chạy tiếp.');
    if (!run.checkpoint) throw new HttpError(409, 'Chưa có checkpoint nào để chạy lại check; hãy dùng Chạy tiếp.');
    if (refreshConfig) {
      const project = this.store.projects.get(run.projectId);
      if (!project) throw new HttpError(404, 'Project không tồn tại.');
      if (run.provider !== 'fake' && !project.approved) throw new HttpError(409, 'Project đã đổi cấu hình và chưa được duyệt lại policy.');
      this.mutate(runId, (r) => { r.configSnapshot = structuredClone(project); });
      this.log(runId, 'config.refreshed', `Dùng cấu hình mới nhất của project (v${project.version}): check ${project.checks.map((c) => c.command.join(' ')).join(' ; ')}`);
    }
    this.recheckRequests.add(runId);
    return this.enqueue(runId);
  }

  // ------------------------------------------------------------------ human time

  startTimer(runId: string, category: HumanTime['category'], note = ''): HumanTime {
    this.run(runId);
    const timer: HumanTime = { id: `ht_${randomUUID().slice(0, 8)}`, category, startedAt: this.stamp(), note };
    this.mutate(runId, (r) => { r.humanTime.push(timer); });
    return timer;
  }
  stopTimer(runId: string, timerId: string): HumanTime {
    let stopped: HumanTime | undefined;
    this.mutate(runId, (r) => {
      stopped = r.humanTime.find((t) => t.id === timerId);
      if (!stopped) throw new HttpError(404, 'Bộ đếm không tồn tại.');
      if (!stopped.endedAt) this.closeTimer(stopped);
    });
    return stopped!;
  }
  /** Manual entry for corrections and work done away from the screen (e.g. post-delivery fixes). */
  addHumanMinutes(runId: string, category: HumanTime['category'], minutes: number, note = ''): HumanTime {
    if (!(minutes >= 0) || minutes > 24 * 60) throw new HttpError(400, 'Số phút không hợp lệ.');
    const end = this.now();
    const entry: HumanTime = { id: `ht_${randomUUID().slice(0, 8)}`, category, startedAt: new Date(end.getTime() - minutes * 60_000).toISOString(), endedAt: end.toISOString(), durationMs: minutes * 60_000, note: note || 'Nhập thủ công' };
    this.mutate(runId, (r) => { r.humanTime.push(entry); });
    return entry;
  }
  private closeTimer(t: HumanTime): void { t.endedAt = this.stamp(); t.durationMs = Math.max(0, Date.parse(t.endedAt) - Date.parse(t.startedAt)); }
  private closeTimers(run: Run): void { run.humanTime.filter((t) => !t.endedAt).forEach((t) => this.closeTimer(t)); }

  // ----------------------------------------------------------------- read models

  detail(runId: string): RunDetail {
    const run = this.run(runId);
    const attempts = this.store.attempts.list(runId);
    const checks = this.store.checks.list(runId);
    const findings = this.store.findings.list(runId);
    const budget = budgetState(run, attempts);
    return {
      run, attempts, artifacts: this.store.artifacts.list(runId), findings, checks, events: this.store.events(runId),
      matrix: buildMatrix(run, checks), completion: evaluateCompletion(run, checks, findings, budget), budget,
      pendingPaths: this.pendingPaths(runId), runningCheck: this.runningChecks.get(runId),
    };
  }

  idle(): Promise<void> { return this.queue.idle(); }

  // -------------------------------------------------------------------- driver

  private enqueue(runId: string): Run {
    this.mutate(runId, (r) => { r.status = 'queued'; r.blocker = null; });
    this.queue.enqueue(runId);
    return this.run(runId);
  }

  private async drive(runId: string): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(runId, controller);
    try {
      this.mutate(runId, (r) => { r.status = 'running'; });
      if (this.run(runId).baseSha) { await this.ensureContext(runId); await this.loadBaseFiles(runId); }
      if (this.recheckRequests.delete(runId)) await this.recheckPhase(runId, controller.signal);
      else if (this.repairRequests.delete(runId)) await this.repairPhase(runId, controller.signal);
      else if (!isApproved(this.run(runId).contract)) await this.planPhase(runId, controller.signal);
      else await this.buildPhase(runId, controller.signal);
    } catch (error) {
      this.recordStop(runId, error, controller.signal);
    } finally {
      this.aborts.delete(runId);
      const run = this.store.runs.get(runId);
      if (run && run.status === 'running') this.mutate(runId, (r) => { r.status = 'paused'; r.blocker = 'Giai đoạn kết thúc mà không có trạng thái rõ ràng.'; });
    }
  }

  private recordStop(runId: string, error: unknown, signal: AbortSignal): void {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    let status: RunStatus = 'failed', blocker = message;
    if (signal.aborted || error instanceof Stopped) { status = 'paused'; blocker = 'Đã dừng bởi người dùng.'; }
    else if (error instanceof Blocked) status = 'blocked';
    else if (error instanceof RuntimeBlockedError) { status = 'blocked'; blocker = `Runtime bị chặn: ${message}`; }
    else if (CAPACITY.test(message)) { status = 'blocked'; blocker = `Máy chủ của model đang quá tải (${message}). Đây không phải lỗi của task; đợi vài phút rồi bấm Chạy tiếp. Công việc đã làm vẫn được giữ.`; this.log(runId, 'capacity', blocker); }
    else if (QUOTA.test(message)) { status = 'blocked'; blocker = `Có thể đã chạm quota: ${message}. Chờ rồi resume; không tự đổi provider.`; this.log(runId, 'quota', blocker); }
    this.mutate(runId, (r) => { r.status = status; r.blocker = blocker; });
    this.log(runId, `run.${status}`, blocker);
  }

  // ---------------------------------------------------------------------- plan

  private async planPhase(runId: string, signal: AbortSignal): Promise<void> {
    let run = this.run(runId);
    this.mutate(runId, (r) => { r.stage = 'prepare'; });
    const runtime = this.runtimeFor(run);
    if (!run.baseSha) {
      const setup = run.configSnapshot.setupCommand;
      this.log(runId, 'prepare.start', `Đang tạo bản sao làm việc${setup.length ? ` và chạy "${setup.join(' ')}" (có thể mất vài phút, tối đa ${Math.round((run.configSnapshot.limits?.setupMs ?? 20 * 60_000) / 60_000)} phút)` : ''}…`);
      const prepared = await this.withHeartbeat(runId, 'setup', 'Chuẩn bị bản sao/cài dependency', () => runtime.prepare(run, 'A', this.runtimeLog(runId, 'setup')));
      this.mutate(runId, (r) => { r.baseSha = prepared.baseSha; r.branch = prepared.branch; });
      for (const warning of prepared.warnings) this.log(runId, 'prepare.warning', warning);
      this.log(runId, 'prepare', `Snapshot tại ${prepared.baseSha}.`);
      run = this.run(runId);
    }
    await this.ensureContext(runId);
    await this.loadBaseFiles(runId);
    run = this.run(runId);
    if (run.mode === 'clarify') await this.interpretIndependently(runId, signal);
    run = this.run(runId);
    const prompt = run.mode === 'clarify' && run.interpretations.length ? PROMPTS.synthesize(run) : PROMPTS.planner(run);
    const { output } = await this.attempt(runId, { role: 'planner', stage: 'prepare', slot: 'A', prompt, signal });
    await this.discardStrayEdits(runId, 'A', 'Planner');
    try {
      const proposal = parseOutput(ContractProposalSchema, output);
      const current = this.run(runId).contract;
      const next = reviseContract(current, { ...proposal });
      this.mutate(runId, (r) => { r.contract = next; });
      if (next !== current) this.log(runId, 'contract.proposed', `Planner đề xuất hợp đồng v${next.version}.`);
    } catch (error) {
      this.log(runId, 'contract.parse_failed', `Giữ hợp đồng nháp: ${(error as Error).message}`);
    }
    this.mutate(runId, (r) => { r.status = 'awaiting_approval'; r.blocker = null; });
    this.log(runId, 'awaiting_approval', 'Chờ người dùng duyệt hợp đồng.');
  }

  /** Independent readings: each sees only the original requirement and snapshot, never the contract or another reading. */
  private async interpretIndependently(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.run(runId);
    const roles: Role[] = ['investigator', 'author'];
    const independence: Independence = { independent: true, reason: 'Chỉ nhận yêu cầu gốc và snapshot; chưa thấy hợp đồng hay kết luận khác.' };
    const results = await Promise.allSettled(roles.map((role) => this.attempt(runId, { role, stage: 'prepare', slot: 'A', prompt: PROMPTS.interpreter(run), independence, signal })));
    await this.runtimeFor(run).revert(run, 'A');
    const found: Interpretation[] = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        if (signal.aborted) return;
        this.log(runId, 'interpretation.failed', `${roles[index]}: ${redactSecrets(String(result.reason))}`);
        return;
      }
      try {
        const parsed = parseOutput(InterpretationSchema, result.value.output);
        found.push({ id: `int_${randomUUID().slice(0, 8)}`, role: roles[index]!, text: parsed.interpretation, questions: parsed.questions, sourceHash: sha256(run.originalRequirement + (run.baseSha ?? '')), contractSeen: false, createdAt: this.stamp() });
      } catch (error) { this.log(runId, 'interpretation.parse_failed', (error as Error).message); }
    });
    if (signal.aborted) throw new Stopped();
    this.mutate(runId, (r) => { r.interpretations = found; });
  }

  // --------------------------------------------------------------------- build

  private async buildPhase(runId: string, signal: AbortSignal): Promise<void> {
    let run = this.run(runId);
    const runtime = this.runtimeFor(run);
    this.mutate(runId, (r) => { r.stage = 'implement'; });
    if (run.mode === 'verify' && !this.hasAuthorTests(runId)) await this.authorAcceptanceTests(runId, signal);

    const slots: Slot[] = run.mode === 'compare' ? ['A', 'B'] : ['A'];
    const records = new Map<Slot, CandidateRecord>();
    for (const slot of slots) {
      const existing = this.candidateRecord(runId, slot);
      if (existing) { records.set(slot, existing); continue; }
      if (slot === 'B') {
        run = this.run(runId);
        const state = budgetState(run, this.store.attempts.list(runId));
        if (remainingFor(state, 'implement') <= 0) throw new Blocked('Không còn ngân sách để mở phương án B; phần kiểm chứng cuối không được dùng cho việc này.');
        await this.withHeartbeat(runId, 'setup', 'Chuẩn bị bản sao B/cài dependency', () => runtime.prepare(run, 'B', this.runtimeLog(runId, 'setup')));
      }
      records.set(slot, await this.implementCandidate(runId, slot, signal));
    }

    await this.concludeBuild(runId, slots, records, signal);
  }

  /** Picks the winning candidate, then either parks the run or moves on to final verification. */
  private async concludeBuild(runId: string, slots: Slot[], records: Map<Slot, CandidateRecord>, signal: AbortSignal): Promise<void> {
    const evals = slots.map((slot) => this.evaluateCandidate(records.get(slot)!));
    let chosen: Slot;
    if (slots.length === 2) {
      const selection = selectCandidate(evals[0]!, evals[1]!);
      this.log(runId, 'compare.select', selection.reason);
      if (!selection.slot) throw new Blocked(selection.reason);
      chosen = selection.slot;
    } else chosen = 'A';
    const winner = records.get(chosen)!;
    if (!winner.success) {
      const failed = this.store.checks.list(runId).some((c) => c.checkpoint === winner.checkpoint && c.status === 'failed' && c.required);
      this.mutate(runId, (r) => { r.checkpoint = winner.checkpoint; r.selectedSlot = chosen; });
      this.park(runId, failed && !winner.fatal ? 'failed' : 'blocked', winner.problems.join(' ') || 'Chưa có candidate đạt yêu cầu.');
      return;
    }
    this.mutate(runId, (r) => { r.checkpoint = winner.checkpoint; r.selectedSlot = chosen; r.branch = `aidept/${r.id}-${chosen}`; });
    this.lockAcceptance(runId, winner.testFiles, winner.checkpoint!);
    await this.verifyPhase(runId, signal);
  }

  /**
   * Re-runs the checks on the checkpoint that already exists, with no agent involved. This is the right move when
   * the work is done but the check itself was wrong (e.g. a missing `test` script), so no tokens are spent.
   */
  private async recheckPhase(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.run(runId);
    const slot = run.selectedSlot;
    this.mutate(runId, (r) => { r.stage = 'implement'; });
    const record: CandidateRecord = this.candidateRecord(runId, slot) ?? {
      slot, checkpoint: run.checkpoint, success: false, problems: [], fatal: false, changedFiles: [], testFiles: this.testFilesFromDiffs(runId), newToolIssues: 0, flakyChecks: 0, summary: '',
    };
    record.checkpoint = run.checkpoint;
    // A stopped attempt can leave half-finished edits in the workspace. Evidence is tied to the checkpoint commit, so
    // the tree must be exactly that commit before anything is measured.
    await this.runtimeFor(run).revert(run, slot);
    this.log(runId, 'recheck', `Chạy lại check trên đúng checkpoint ${run.checkpoint!.slice(0, 8)} (đã hoàn nguyên mọi thay đổi dở dang; không gọi agent).`);
    const outcome = await this.runChecks(runId, slot, run.checkpoint!, record.testFiles, signal);
    record.flakyChecks = outcome.flaky;
    record.fatal = outcome.fatal.length > 0;
    record.problems = record.fatal ? outcome.fatal : outcome.problems;
    record.success = record.problems.length === 0;
    this.store.artifacts.put({ ...this.baseArtifact(runId, { kind: 'checkpoint', title: `Candidate ${slot}`, content: JSON.stringify(record), checkpoint: record.checkpoint }), id: `cand-${runId}-${slot}` });
    await this.concludeBuild(runId, [slot], new Map([[slot, record]]), signal);
  }

  private testFilesFromDiffs(runId: string): string[] {
    const files = new Set<string>();
    for (const a of this.store.artifacts.list(runId).filter((x) => x.kind === 'diff' && x.valid)) {
      for (const m of a.content.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) if (TEST_PATH.test(m[2]!)) files.add(m[2]!);
    }
    return [...files];
  }

  private evaluateCandidate(record: CandidateRecord): CandidateEval {
    return { slot: record.slot, eliminatedBecause: record.success ? null : record.problems.join(' ') || 'Không đạt check bắt buộc.', changedFiles: record.changedFiles.length, newToolIssues: record.newToolIssues, flakyChecks: record.flakyChecks };
  }

  private async implementCandidate(runId: string, slot: Slot, signal: AbortSignal): Promise<CandidateRecord> {
    let run = this.run(runId);
    const runtime = this.runtimeFor(run);
    const record: CandidateRecord = { slot, checkpoint: null, success: false, problems: [], fatal: false, changedFiles: [], testFiles: [], newToolIssues: 0, flakyChecks: 0, summary: '' };
    let problems: string[] = [];
    const primary = slot === 'B' ? this.candidateRecord(runId, 'A') : undefined;

    for (let round = 0; round <= MAX_REPAIRS_PER_CANDIDATE; round++) {
      run = this.run(runId);
      const stage: Stage = round === 0 ? 'implement' : 'repair';
      if (slot === 'B') {
        const cap = candidateCap(budgetState(run, this.store.attempts.list(runId)), 2);
        if (candidateSpend(run, this.store.attempts.list(runId), 'B') >= cap) { record.problems = ['Phương án B đã dùng hết phần ngân sách của nó.']; break; }
      }
      const prompt = round === 0
        ? (slot === 'B' ? PROMPTS.alternative(run, primary?.summary || 'Không có tóm tắt.') : PROMPTS.developer(run, this.hasAuthorTests(runId) ? 'Test nghiệm thu do Author viết đã bị khóa; làm cho chúng pass mà không sửa chúng.' : ''))
        : PROMPTS.repair(run, problems);
      const resume = this.sessions.get(`${runId}:${slot}`);
      const { output } = await this.attempt(runId, { role: 'developer', stage, slot, prompt, signal, resumeSession: round > 0 ? resume : undefined });
      this.recordReuse(runId, output);
      record.summary = output.slice(0, 1500);
      if (round > 0) this.mutate(runId, (r) => { r.repairCount += 1; });

      const changes = await runtime.changes(run, slot);
      if (!changes.files.length) {
        // An empty patch proves nothing; committing it and running checks would only burn a round on the old code.
        problems = ['Developer không thay đổi file nào. Hãy thực sự sửa mã và thêm test gắn thẻ [R-x]; nếu không thể thực thi lệnh hoặc ghi file, hãy nói rõ lý do.'];
        record.problems = problems;
        this.log(runId, 'patch.empty', `Round ${round}: không có thay đổi nào.`);
        continue;
      }
      const scope = evaluateChanges(changes.files, this.scopeFor(runId));
      if (!scope.accepted) {
        this.artifact(runId, { kind: 'diff', title: `Patch bị từ chối (${slot})`, content: changes.patch, checkpoint: null, valid: false });
        await runtime.revert(run, slot);
        problems = [
          ...scope.protected.map((f) => `${f}: file được bảo vệ, không được sửa.`),
          ...scope.needsApproval.map((f) => `${f}: nằm ngoài module cho phép, cần người dùng duyệt.`),
        ];
        this.log(runId, 'scope.rejected', `Patch bị từ chối: ${problems.join(' ')}`);
        record.problems = problems;
        continue;
      }
      const checkpoint = await runtime.commit(run, slot, `${run.title} (${slot}${round ? ` r${round}` : ''})`);
      record.checkpoint = checkpoint;
      record.changedFiles = [...new Set([...record.changedFiles, ...changes.files])];
      record.testFiles = [...new Set([...record.testFiles, ...changes.files.filter((f) => TEST_PATH.test(f))])];
      this.artifact(runId, { kind: 'diff', title: `Diff ${slot} @ ${checkpoint.slice(0, 8)}`, content: changes.patch, checkpoint });
      if (slot === 'A') this.mutate(runId, (r) => { r.checkpoint = checkpoint; });

      const outcome = await this.runChecks(runId, slot, checkpoint, record.testFiles, signal);
      record.flakyChecks = outcome.flaky;
      problems = outcome.problems;
      record.problems = problems;
      if (outcome.fatal.length) { record.fatal = true; record.problems = outcome.fatal; break; }
      if (!problems.length) { record.success = true; record.problems = []; break; }
      if (!outcome.repairable) break;
    }
    if (record.checkpoint) await this.analyzeTools(runId, slot, record);
    this.store.artifacts.put({ ...this.baseArtifact(runId, { kind: 'checkpoint', title: `Candidate ${slot}`, content: JSON.stringify(record), checkpoint: record.checkpoint }), id: `cand-${runId}-${slot}` });
    return record;
  }

  private candidateRecord(runId: string, slot: Slot): CandidateRecord | undefined {
    const run = this.run(runId);
    const artifact = this.store.artifacts.get(`cand-${runId}-${slot}`);
    if (!artifact || artifact.contractVersion !== run.contract.version || !artifact.valid) return undefined;
    return JSON.parse(artifact.content) as CandidateRecord;
  }

  /** Runs every required recipe with the single allowed retry, then red/green validation when the task kind calls for it. */
  private async runChecks(runId: string, slot: Slot, checkpoint: string, testFiles: string[], signal: AbortSignal): Promise<{ problems: string[]; fatal: string[]; repairable: boolean; flaky: number }> {
    const run = this.run(runId);
    const runtime = this.runtimeFor(run);
    const problems: string[] = [], fatal: string[] = [];
    let repairable = true, flaky = 0;
    for (const recipe of run.configSnapshot.checks) {
      const onEvent = this.runtimeLog(runId, `check:${recipe.id}`);
      const runOnce = (ref: 'candidate' | 'base', keepPaths?: string[]) => {
        // The UI shows the test program while it runs, so what is running and since when must be known.
        this.runningChecks.set(runId, { recipeId: recipe.id, command: recipe.command.join(' '), ref, startedAt: this.stamp() });
        return this.withHeartbeat(runId, `check:${recipe.id}`, `Check "${recipe.id}" (${ref})`, () => runtime.runCheck({ run, recipe, slot, ref, keepPaths, signal, onEvent }))
          .finally(() => this.runningChecks.delete(runId));
      };
      const attempts: RuntimeCheckResult[] = [await runOnce('candidate')];
      if (shouldRetry(attempts[0]!)) {
        this.emit(runId, `check:${recipe.id}`, 'warn', 'Check fail; chạy lại một lần để phân biệt lỗi thật với flaky.');
        attempts.push(await runOnce('candidate'));
      }
      const pinned = attempts.map((a) => ({ ...a, checkpoint }));
      const previous = this.store.checks.list(runId).filter((c) => c.recipeId === recipe.id && c.quarantined).pop();
      const result = summarizeCheck({
        runId, id: `chk_${randomUUID().slice(0, 8)}`, recipe, checkpoint, contractVersion: run.contract.version,
        lockedTestIds: [], quarantined: previous ? { reason: previous.quarantineReason ?? 'Kế thừa quarantine trước đó.' } : undefined,
      }, pinned, this.now());
      this.store.checks.put(result);
      this.log(runId, 'check', `${recipe.id}@${checkpoint.slice(0, 8)}: ${result.status}${attempts.length > 1 ? ' (có retry)' : ''}`);
      if (result.status === 'flaky') flaky++;
      if (!recipe.required) continue;
      if (result.status === 'failed') {
        const digest = summarizeFailures(attempts.at(-1)?.report);
        const noTests = recipe.reportPath && !parseTestReport(attempts.at(-1)?.report).tests.length && !digest.length ? ['Report không có test nào: cần thêm test gắn thẻ [R-x] trong thư mục tests.'] : [];
        // Checks without a report (typecheck, lint, build) have no digest; their compiler/linter output is the whole story.
        problems.push(`Check "${recipe.id}" fail (mã thoát ${result.attempts.at(-1)?.exitCode ?? '?'}):\n${[...digest, ...noTests].join('\n')}\n${(result.attempts.at(-1)?.log ?? '').slice(recipe.reportPath ? -1000 : -3000)}`);
      }
      else if (result.status === 'incomplete') {
        // A simulated run never executes a check, so it always ends here; resuming cannot change that.
        problems.push(run.provider === 'fake'
          ? `Check "${recipe.id}" không chạy thật vì đây là chạy mô phỏng: mô phỏng không chạy test nên task dừng ở đây. Muốn chạy thật, tạo task mới và chọn "Chạy thật · theo vai của project".`
          : ranNoTests(result) ? `Check "${recipe.id}" không chạy test nào (report có 0 test): lệnh check hoặc mẫu file không khớp test của repo. Sửa check của project rồi bấm Chạy lại check.` : `Check "${recipe.id}" chưa hoàn tất (timeout, thiếu report hoặc môi trường không chạy thật).`);
        repairable = false;
      }
      else if (result.status === 'flaky' && !result.quarantined) { problems.push(`Check "${recipe.id}" flaky: fail rồi pass khi retry. Cần sửa hoặc quarantine có lý do.`); repairable = false; }

      if (recipe.reportPath && result.status === 'passed' && run.taskKind && run.taskKind !== 'feature' && testFiles.length) {
        const baseRun = await runOnce('base', testFiles);
        const verdict = evaluateRedGreen(run.taskKind, parseTestReport(baseRun.report), parseTestReport(pinned.at(-1)!.report));
        this.artifact(runId, { kind: 'report', title: `Red/green ${recipe.id} (${run.taskKind})`, content: JSON.stringify(verdict), checkpoint });
        if (!verdict.valid) fatal.push(`Test không phải bằng chứng ${run.taskKind} hợp lệ: ${verdict.reasons.join(' ')}`);
      }
    }
    return { problems, fatal, repairable, flaky };
  }

  private async analyzeTools(runId: string, slot: Slot, record: CandidateRecord): Promise<void> {
    const run = this.run(runId);
    const runtime = this.runtimeFor(run);
    const deltas = [];
    for (const tool of ANALYSIS_TOOLS) {
      const [base, candidate] = [await runtime.runTool(run, slot, tool, 'base'), await runtime.runTool(run, slot, tool, 'candidate')];
      deltas.push(toolDelta(base, candidate));
    }
    record.newToolIssues = deltas.reduce((n, d) => n + d.newIssues.length, 0);
    this.artifact(runId, { kind: 'tool', title: `Phân tích công cụ (${slot})`, content: JSON.stringify(deltas), checkpoint: record.checkpoint });
  }

  // -------------------------------------------------------------------- author

  private hasAuthorTests(runId: string): boolean {
    return this.lockedArtifacts(runId).some((a) => a.title === 'Acceptance suite (Author)');
  }

  /** Verify mode: an Author writes tests from the contract alone; they are locked before the Developer starts. */
  private async authorAcceptanceTests(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.run(runId);
    const runtime = this.runtimeFor(run);
    const independence: Independence = { independent: true, reason: 'Author chỉ nhận hợp đồng; chưa có kế hoạch triển khai của Developer.' };
    // A non-test file inside the allowed modules (a .md note, a helper) is a slip the Author can fix, so it gets one retry
    // with the offending files named. Out-of-scope or protected paths need a person, so they block immediately.
    let extra = '';
    let changes: Awaited<ReturnType<typeof runtime.changes>>;
    for (let round = 0; ; round++) {
      await this.attempt(runId, { role: 'author', stage: 'implement', slot: 'A', prompt: PROMPTS.author(run, extra), independence, signal });
      changes = await runtime.changes(run, 'A');
      const stray = changes.files.filter((f) => !TEST_PATH.test(f));
      const scope = evaluateChanges(changes.files, this.scopeFor(runId));
      if (!stray.length && scope.accepted) break;
      const strayOnly = scope.accepted && !scope.protected.length && !scope.needsApproval.length;
      // Recorded like a rejected Developer patch, so the run page can offer to approve the out-of-scope paths.
      this.artifact(runId, { kind: 'diff', title: 'Patch bị từ chối (Author)', content: changes.patch, checkpoint: null, valid: false });
      await runtime.revert(run, 'A');
      const violations = [...new Set([...stray, ...scope.protected, ...scope.needsApproval])];
      if (strayOnly && round === 0) {
        extra = `Lần trước bạn tạo file không phải test (${stray.join(', ')}) nên toàn bộ bị hoàn nguyên. Làm lại và CHỈ tạo file test.\n`;
        this.log(runId, 'author.retry', `Author tạo file không phải test (${stray.join(', ')}); hoàn nguyên và yêu cầu làm lại một lần.`);
        continue;
      }
      throw new Blocked(`Author chỉ được thêm file test (tests/, *.test.ts, *.spec.ts) trong module cho phép. Vi phạm: ${violations.join(', ')}`);
    }
    const checkpoint = await runtime.commit(run, 'A', `${run.title}: acceptance tests`);
    this.mutate(runId, (r) => { r.checkpoint = checkpoint; });
    this.artifact(runId, { kind: 'diff', title: 'Diff Author', content: changes.patch, checkpoint });
    // The artifact is also the marker that the Author step is done. Without it, an Author that wrote nothing would be
    // run again on every resume, spending tokens each time for the same empty result.
    if (!changes.files.length) this.log(runId, 'author.empty', 'Author không viết test nào; tiếp tục với Developer (yêu cầu sẽ chỉ được xác minh bằng test Developer viết).');
    this.lockAcceptance(runId, changes.files, checkpoint, 'Acceptance suite (Author)', true);
  }

  private lockAcceptance(runId: string, files: string[], checkpoint: string, title = 'Acceptance suite', force = false): void {
    if (!files.length && !force) return;
    const content = JSON.stringify({ paths: [...new Set(files)].sort() });
    this.artifact(runId, { kind: 'acceptance', title, content, checkpoint });
    this.log(runId, 'acceptance.locked', `Khóa ${files.length} file test nghiệm thu.`);
  }
  private lockedArtifacts(runId: string): Artifact[] {
    const run = this.run(runId);
    return this.store.artifacts.list(runId).filter((a) => a.kind === 'acceptance' && a.valid && a.contractVersion === run.contract.version);
  }
  private scopeFor(runId: string): ScopeInput {
    const run = this.run(runId);
    const lockedPaths = this.lockedArtifacts(runId).flatMap((a) => (JSON.parse(a.content) as { paths: string[] }).paths);
    // Without a known base file list nothing may be scaffolded: the safe default is the plain protected set.
    const baseFiles = run.configSnapshot.allowScaffold ? this.baseFileCache.get(runId) : undefined;
    return { modules: [...run.configSnapshot.modules, ...(run.approvedPaths ?? [])], protectedPaths: run.configSnapshot.protectedPaths, lockedPaths, ...(baseFiles ? { scaffold: { baseFiles } } : {}) };
  }

  /**
   * A person lets the agent touch paths outside the project's modules for THIS task. Protected files (lockfiles,
   * check configs, locked tests, traversal paths) can never be approved, and a directory approval does not
   * override them either, because classification checks the protected set first.
   */
  approvePaths(runId: string, paths: string[], resume = false): Run {
    const run = this.run(runId);
    if (!['blocked', 'paused', 'failed', 'awaiting_approval'].includes(run.status)) throw new HttpError(409, 'Chỉ duyệt đường dẫn khi run đang chờ người dùng.');
    // Validate what the caller sent: normalising first would turn "/etc" into the innocent-looking "etc".
    const bad = paths.find((p) => !isSafeRelative(p.trim()) || /[*?]/.test(p));
    if (bad !== undefined) throw new HttpError(400, `Đường dẫn không hợp lệ: ${bad}`);
    const cleaned = [...new Set(paths.map((p) => normalizePath(p.trim()).replace(/\/+$/, '')).filter(Boolean))];
    if (!cleaned.length) throw new HttpError(400, 'Chưa chọn đường dẫn nào.');
    const scope = this.scopeFor(runId);
    for (const p of cleaned) {
      if (!isSafeRelative(p) || /[*?]/.test(p)) throw new HttpError(400, `Đường dẫn không hợp lệ: ${p}`);
      if (classifyPath(p, { modules: [p], protectedPaths: scope.protectedPaths, lockedPaths: scope.lockedPaths }) === 'protected') {
        throw new HttpError(400, `${p} là file được bảo vệ, không thể phê duyệt.`);
      }
    }
    this.mutate(runId, (r) => { r.approvedPaths = [...new Set([...(r.approvedPaths ?? []), ...cleaned])]; });
    this.log(runId, 'scope.approved', `Đã cho phép agent sửa: ${cleaned.join(', ')}`);
    if (!resume) return this.run(runId);
    this.discardFailedCandidates(runId);
    return this.enqueue(runId);
  }

  private discardFailedCandidates(runId: string): void {
    for (const slot of ['A', 'B'] as const) {
      const artifact = this.store.artifacts.get(`cand-${runId}-${slot}`);
      if (artifact && !(JSON.parse(artifact.content) as CandidateRecord).success) this.store.artifacts.delete(artifact.id);
    }
  }

  /** Files from the newest rejected patch that still need approval, so the UI can ask exactly about them. */
  private pendingPaths(runId: string): string[] {
    const run = this.run(runId);
    if (!['blocked', 'paused', 'failed'].includes(run.status)) return [];
    const rejected = this.store.artifacts.list(runId).filter((a) => a.kind === 'diff' && !a.valid && a.title.startsWith('Patch') && a.contractVersion === run.contract.version).at(-1);
    if (!rejected) return [];
    const files = new Set<string>();
    for (const m of rejected.content.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) files.add(m[2]!);
    for (const m of rejected.content.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]!);
    const scope = this.scopeFor(runId);
    return [...files].filter((f) => classifyPath(f, scope) === 'needs_approval');
  }

  // -------------------------------------------------------------------- verify

  private async verifyPhase(runId: string, signal: AbortSignal): Promise<void> {
    let run = this.run(runId);
    this.mutate(runId, (r) => { r.stage = 'verify'; });
    if (run.mode === 'verify' || run.mode === 'compare') await this.independentVerifier(runId, signal);
    this.finish(runId);
  }

  private async independentVerifier(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.run(runId);
    const state = budgetState(run, this.store.attempts.list(runId));
    if (remainingFor(state, 'verify') <= 0) {
      this.log(runId, 'verify.skipped', 'Hết ngân sách kiểm chứng cuối; không chạy Verifier.');
      this.recordVerdict(runId, { decision: 'skipped', summary: '', findingCount: 0 });
      return;
    }
    const diff = this.store.artifacts.list(runId).filter((a) => a.kind === 'diff' && a.valid && a.checkpoint === run.checkpoint).at(-1)?.content ?? '';
    const independence: Independence = { independent: true, reason: 'Phiên mới; lập checklist từ hợp đồng trước khi đọc diff, không nhận giải thích của Developer.' };
    const { output, attempt } = await this.attempt(runId, { role: 'verifier', stage: 'verify', slot: run.selectedSlot, prompt: PROMPTS.verifier(run, diff.slice(0, 60_000)), independence, signal });
    await this.discardStrayEdits(runId, run.selectedSlot, 'Verifier');
    try {
      const parsed = parseOutput(FindingsSchema, output);
      for (const raw of parsed.findings) {
        const gated = gateFinding(raw);
        const finding: Finding = {
          id: `fnd_${randomUUID().slice(0, 8)}`, runId, category: gated.category, severity: gated.severity, code: gated.code, title: gated.title,
          location: gated.location, rule: gated.rule, precedent: gated.precedent, evidence: gated.evidence, suggestion: gated.suggestion,
          status: 'open', confirmed: false, checkpoint: run.checkpoint, contractVersion: run.contract.version, createdAt: this.stamp(),
          dispute: gated.downgradedBecause,
        };
        this.store.findings.put(finding);
      }
      this.log(runId, 'verify', `Verifier (${parsed.decision}): ${parsed.findings.length} finding, chờ runner hoặc người xác nhận trước khi chặn.`, { attempt: attempt.id });
      this.recordVerdict(runId, { decision: parsed.decision, summary: verifierNarrative(output), findingCount: parsed.findings.length });
    } catch (error) {
      this.log(runId, 'verify.parse_failed', `Output Verifier không hợp lệ; coi như chưa kiểm tra: ${(error as Error).message}`);
      this.recordVerdict(runId, { decision: 'unparsed', summary: verifierNarrative(output), findingCount: 0 });
    }
  }

  /**
   * The reviewer's decision and its own words are kept, not just its findings: "abstain" and "not enough evidence"
   * are exactly what a person deciding on acceptance must be able to see.
   */
  /**
   * Runs reviewed before verdicts were stored still have the reviewer's raw output. Rebuild the verdict from it so the
   * report never claims "the Verifier did not run" about a review that actually happened.
   */
  private recoverVerdict(runId: string): void {
    const run = this.run(runId);
    if (run.mode !== 'verify' && run.mode !== 'compare') return;
    const artifacts = this.store.artifacts.list(runId);
    if (readVerdict(artifacts, run)) return;
    const attempt = this.store.attempts.list(runId).filter((a) => a.role === 'verifier' && a.status === 'completed').at(-1);
    const raw = attempt && artifacts.filter((a) => a.kind === 'raw' && a.attemptId === attempt.id).at(-1)?.content;
    if (!raw) return;
    let text = '';
    for (const line of raw.split('\n')) {
      try {
        const event = JSON.parse(line) as { type?: string; result?: unknown; item?: { type?: string; text?: unknown } };
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
        else if (event.type === 'result' && typeof event.result === 'string') text = event.result;
      } catch { /* not a JSON line */ }
    }
    if (!text) return;
    try {
      const parsed = parseOutput(FindingsSchema, text);
      this.recordVerdict(runId, { decision: parsed.decision, summary: verifierNarrative(text), findingCount: parsed.findings.length });
    } catch { this.recordVerdict(runId, { decision: 'unparsed', summary: verifierNarrative(text), findingCount: 0 }); }
  }

  private recordVerdict(runId: string, verdict: VerifierVerdict): void {
    this.artifact(runId, { kind: 'report', title: 'Verifier verdict', content: JSON.stringify(verdict), checkpoint: this.run(runId).checkpoint });
  }

  /** One repair round on confirmed findings, then fresh checks on the new checkpoint. */
  private async repairPhase(runId: string, signal: AbortSignal): Promise<void> {
    let run = this.run(runId);
    const runtime = this.runtimeFor(run);
    const slot = run.selectedSlot;
    this.mutate(runId, (r) => { r.stage = 'verify'; });
    const targets = this.store.findings.list(runId).filter((f) => f.confirmed && f.status === 'open' && f.contractVersion === run.contract.version);
    const problems = targets.map((f) => `${f.title} (${f.location}): ${f.evidence}. Gợi ý: ${f.suggestion}`);
    await this.attempt(runId, { role: 'developer', stage: 'verify', slot, prompt: PROMPTS.repair(run, problems), signal, resumeSession: this.sessions.get(`${runId}:${slot}`) });
    run = this.run(runId);
    const changes = await runtime.changes(run, slot);
    const scope = evaluateChanges(changes.files, this.scopeFor(runId));
    if (!scope.accepted) {
      await runtime.revert(run, slot);
      this.artifact(runId, { kind: 'diff', title: `Patch sửa finding bị từ chối (${slot})`, content: changes.patch, checkpoint: null, valid: false });
      throw new Blocked(`Patch sửa finding vượt phạm vi: ${[...scope.protected, ...scope.needsApproval].join(', ')}`);
    }
    const checkpoint = await runtime.commit(run, slot, `${run.title}: sửa finding đã xác nhận`);
    this.mutate(runId, (r) => { r.checkpoint = checkpoint; r.repairCount += 1; });
    this.artifact(runId, { kind: 'diff', title: `Diff sửa finding @ ${checkpoint.slice(0, 8)}`, content: changes.patch, checkpoint });
    const outcome = await this.runChecks(runId, slot, checkpoint, [], signal);
    if (outcome.problems.length) { this.park(runId, 'blocked', outcome.problems.join(' ')); return; }
    for (const f of targets) { f.status = 'resolved'; this.store.findings.put(f); }
    this.log(runId, 'repair.done', `Đã sửa ${targets.length} finding đã xác nhận; check pass trên checkpoint mới.`);
    if (run.mode === 'verify' || run.mode === 'compare') await this.independentVerifier(runId, signal);
    this.finish(runId);
  }

  /**
   * Planner and Verifier only read. Anything they leave in the working copy (test output, browser profiles, scratch
   * notes) is discarded, or the next commit would carry it into the checkpoint and the delivery.
   */
  private async discardStrayEdits(runId: string, slot: Slot, who: string): Promise<void> {
    const run = this.run(runId);
    const runtime = this.runtimeFor(run);
    const left = await runtime.changes(run, slot);
    if (!left.files.length) return;
    await runtime.revert(run, slot);
    this.log(runId, 'workspace.cleaned', `${who} để lại ${left.files.length} file trong bản sao làm việc (ví dụ ${left.files.slice(0, 3).join(', ')}); đã hoàn nguyên, không đưa vào checkpoint.`);
  }

  private finish(runId: string): void {
    const detail = this.detail(runId);
    if (detail.completion.ready) {
      this.mutate(runId, (r) => { r.status = 'awaiting_acceptance'; r.blocker = null; });
      this.log(runId, 'awaiting_acceptance', 'Đủ bằng chứng; chờ nghiệm thu.');
    } else this.park(runId, 'blocked', detail.completion.reasons.join(' '));
  }

  private refreshAcceptanceState(runId: string): void {
    const run = this.run(runId);
    if (!['blocked', 'awaiting_acceptance'].includes(run.status) || !run.checkpoint) return;
    const detail = this.detail(runId);
    if (detail.completion.ready && run.status === 'blocked') this.mutate(runId, (r) => { r.status = 'awaiting_acceptance'; r.blocker = null; });
    else if (!detail.completion.ready && run.status === 'awaiting_acceptance') this.mutate(runId, (r) => { r.status = 'blocked'; r.blocker = detail.completion.reasons.join(' '); });
  }

  private park(runId: string, status: 'blocked' | 'failed', blocker: string): void {
    this.mutate(runId, (r) => { r.status = status; r.blocker = blocker; });
    this.log(runId, `run.${status}`, blocker);
  }

  // ------------------------------------------------------------------ attempts

  private async attempt(runId: string, input: {
    role: Role; stage: Stage; slot: Slot; prompt: string; signal: AbortSignal; independence?: Independence;
    resumeSession?: { sessionId: string; cumulative?: import('../runtime/providers.js').UsageCheckpoint };
  }): Promise<{ output: string; attempt: Attempt }> {
    const run = this.run(runId);
    if (input.signal.aborted) throw new Stopped();
    const state = budgetState(run, this.store.attempts.list(runId));
    if (remainingFor(state, input.stage) <= 0) throw new Blocked(`Hết ngân sách cho giai đoạn "${input.stage}" (${state.spentUsd.toFixed(2)}/${state.capUsd.toFixed(2)} USD). Chưa hoàn thành.`);
    const config = run.configSnapshot.roles[input.role];
    const attempt: Attempt = {
      id: `att_${randomUUID().slice(0, 8)}`, runId, slot: input.slot, independence: input.independence, role: input.role, stage: input.stage,
      provider: run.provider === 'fake' ? 'fake' : config.provider, model: config.model || 'default', status: 'running', startedAt: this.stamp(),
      checkpoint: run.checkpoint, contractVersion: run.contract.version,
    };
    this.store.attempts.put(attempt);
    this.mutate(runId, (r) => { r.stage = input.stage; });
    this.log(runId, 'attempt.start', `${input.role} (${input.slot}) bắt đầu ở giai đoạn ${input.stage}.`, { attempt: attempt.id, independence: input.independence });

    const raw: string[] = [];
    const runtime = this.runtimeFor(run);
    try {
      const source = `agent:${input.role}`;
      const relay = this.runtimeLog(runId, source, attempt.id);
      const result = await this.withHeartbeat(runId, source, `${input.role} (${input.slot})`, () => this.agents.use(() => runtime.runAgent({
        run, attempt, role: input.role, prompt: input.prompt, signal: input.signal,
        sessionId: input.resumeSession?.sessionId, previousUsage: input.resumeSession?.cumulative,
        onEvent: (event) => {
          if (event.type === 'provider.raw') {
            raw.push(redactSecrets(event.message));
            const line = describeProviderLine(event.message);
            if (line) this.emit(runId, source, line.level, line.text, attempt.id);
          } else relay(event);
        },
      })), attempt.id);
      this.recordContext(runId, input.prompt, attempt.id);
      // Raw output is persisted before anything parses it.
      this.artifact(runId, { kind: 'raw', title: `Raw ${input.role} ${attempt.id}`, content: raw.join('\n') || redactSecrets(result.output), checkpoint: run.checkpoint, attemptId: attempt.id });
      // Only the Developer's session is ever resumed. Keeping another role's (a Claude Verifier, an Antigravity Planner)
      // would hand the next Developer repair a session id from a different CLI.
      if (result.sessionId && input.role === 'developer') this.sessions.set(`${runId}:${input.slot}`, { sessionId: result.sessionId, cumulative: result.cumulativeUsage });
      const usage: UsageRecord = {
        id: `use_${randomUUID().slice(0, 8)}`, attemptId: attempt.id, sessionId: result.sessionId, ...result.usage,
        source: result.usage.costUsd !== null ? 'reported' : result.usage.inputTokens + result.usage.outputTokens > 0 ? 'estimated' : 'unknown', createdAt: this.stamp(),
      };
      this.mutate(runId, (r) => { r.usage.push(usage); });
      this.store.attempts.put({ ...attempt, status: 'completed', endedAt: this.stamp(), sessionId: result.sessionId, ...(result.model ? { model: result.model } : {}) });
      return { output: result.output, attempt };
    } catch (error) {
      if (raw.length) this.artifact(runId, { kind: 'raw', title: `Raw ${input.role} ${attempt.id} (lỗi)`, content: raw.join('\n'), checkpoint: run.checkpoint, attemptId: attempt.id });
      const interrupted = input.signal.aborted;
      this.store.attempts.put({ ...attempt, status: interrupted ? 'interrupted' : 'failed', endedAt: this.stamp(), error: redactSecrets(error instanceof Error ? error.message : String(error)) });
      if (interrupted) throw new Stopped();
      throw error;
    }
  }

  private recordReuse(runId: string, output: string): void {
    try {
      const reuse = parseOutput(ReuseAssessmentSchema, output);
      this.artifact(runId, { kind: 'reuse', title: 'ReuseAssessment', content: JSON.stringify(reuse), checkpoint: this.run(runId).checkpoint });
    } catch { this.log(runId, 'reuse.missing', 'Developer không cung cấp ReuseAssessment hợp lệ.'); }
  }

  // ------------------------------------------------------------------- helpers

  private invalidateEvidence(runId: string, currentVersion: number): void {
    for (const a of this.store.artifacts.list(runId)) if (a.contractVersion < currentVersion && a.valid) this.store.artifacts.put({ ...a, valid: false });
    for (const c of this.store.checks.list(runId)) if (c.contractVersion < currentVersion && c.valid) this.store.checks.put({ ...c, valid: false });
  }

  /** Base snapshot file list, needed only when the project lets the agent create setup files. */
  private async loadBaseFiles(runId: string): Promise<void> {
    const run = this.run(runId);
    if (!run.configSnapshot.allowScaffold || this.baseFileCache.has(runId) || !run.baseSha) return;
    const files = await this.runtimeFor(run).baseFiles?.(run, 'A');
    if (files) this.baseFileCache.set(runId, new Set(files));
  }

  /** The run's working copy at its checkpoint, for trying the result by hand; undefined for simulations or before any checkpoint. */
  workspaceOf(runId: string): string | undefined {
    const run = this.run(runId);
    if (!run.checkpoint || run.provider === 'fake') return undefined;
    return this.runtimeFor(run).workspacePath?.(run, run.selectedSlot);
  }

  /**
   * Freezes the project context for this run on first use: the repo map of the working copy and the approved memory
   * that still holds against it. Items that no longer hold are marked stale in the project, never sent.
   */
  private async ensureContext(runId: string): Promise<void> {
    const run = this.run(runId);
    if (run.context) return;
    const capturedAt = this.stamp();
    if (!run.configSnapshot.contextEnabled) { this.mutate(runId, (r) => { r.context = { enabled: false, capturedAt, memory: [] }; }); return; }
    const runtime = this.runtimeFor(run);
    const repoMap = await buildRepoMap(runtime.workspacePath?.(run, 'A') ?? run.configSnapshot.repository);
    const now = this.now().getTime();
    const memory: MemoryItem[] = [];
    for (const item of this.store.memories.list(run.projectId).filter((m) => m.status === 'active')) {
      const reason = staleReason(item, repoMap, now);
      if (reason) { this.store.memories.put({ ...item, status: 'stale', staleReason: reason, updatedAt: capturedAt }); this.log(runId, 'memory.stale', `Bỏ qua mục bộ nhớ "${item.text.slice(0, 60)}": ${reason}`); continue; }
      memory.push(item);
    }
    // The full path list only serves the check above; the run keeps the readable parts.
    this.mutate(runId, (r) => { r.context = { enabled: true, capturedAt, repoMap: { ...repoMap, paths: [] }, memory }; });
    this.log(runId, 'context.captured', `Ngữ cảnh project: ${memory.length} mục bộ nhớ, bản đồ repo ${repoMap.tree ? 'có' : 'trống'}.`);
  }

  /** What context an attempt actually received, recorded beside its raw output; counts each memory item's use. */
  private recordContext(runId: string, prompt: string, attemptId: string): void {
    const run = this.run(runId);
    if (!run.context) return;
    const role = contextRoleOf(prompt);
    const selection = role ? selectContext(run, role) : { role: null, enabled: run.context.enabled, sections: [], memoryIds: [] as string[], usedTokens: 0 };
    this.artifact(runId, { kind: 'context', title: `Ngữ cảnh ${role ?? '(không có)'}`, content: JSON.stringify({ contextOn: run.context.enabled, ...selection }), checkpoint: run.checkpoint, attemptId });
    for (const id of selection.memoryIds) {
      const item = this.store.memories.get(id);
      if (item) this.store.memories.put({ ...item, usedCount: item.usedCount + 1 });
    }
  }

  private baseArtifact(runId: string, a: { kind: Artifact['kind']; title: string; content: string; checkpoint: string | null; attemptId?: string; valid?: boolean }): Artifact {
    return {
      id: `art_${randomUUID().slice(0, 8)}`, runId, attemptId: a.attemptId, kind: a.kind, title: a.title, content: a.content, hash: sha256(a.content),
      checkpoint: a.checkpoint, contractVersion: this.run(runId).contract.version, valid: a.valid ?? true, createdAt: this.stamp(),
    };
  }
  private artifact(runId: string, a: Parameters<Orchestrator['baseArtifact']>[1]): Artifact { return this.store.artifacts.put(this.baseArtifact(runId, a)); }

  private run(id: string): Run {
    const run = this.store.runs.get(id);
    if (!run) throw new HttpError(404, 'Run không tồn tại.');
    return run;
  }
  private mutate(id: string, change: (r: Run) => void): Run {
    const run = this.run(id);
    change(run);
    run.updatedAt = this.stamp();
    return this.store.runs.put(run);
  }
  private guard<T>(fn: () => T): T {
    try { return fn(); } catch (error) { throw new HttpError(400, (error as Error).message); }
  }
  private log(runId: string, type: string, message: string, data?: unknown): void { this.store.addEvent(runId, type, message, data); }

  /** Console line that is not a timeline event (process output, agent activity, heartbeats). */
  private emit(runId: string, source: string, level: LogLevel, message: string, attemptId?: string): void {
    this.store.logs.append({ runId, source, level, message, attemptId });
  }

  /** Adapts runtime `{type:'log'}` events (setup/check output, agent stderr) into console lines. */
  private runtimeLog(runId: string, fallbackSource: string, attemptId?: string): (event: RuntimeEvent) => void {
    return (event) => {
      if (event.type !== 'log') return;
      const data = (event.data ?? {}) as { source?: string; level?: LogLevel };
      this.emit(runId, data.source ?? fallbackSource, data.level ?? 'info', event.message, attemptId);
    };
  }

  /**
   * A silent five-minute `npm ci` is indistinguishable from a hang. While a long step runs, say so periodically
   * with the elapsed time, and record how long it took when it ends.
   */
  private async withHeartbeat<T>(runId: string, source: string, label: string, work: () => Promise<T>, attemptId?: string): Promise<T> {
    const started = Date.now();
    const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
    this.emit(runId, source, 'info', `${label}: bắt đầu`, attemptId);
    const timer = setInterval(() => this.emit(runId, source, 'info', `${label}: vẫn đang chạy (${elapsed()})`, attemptId), this.heartbeatMs);
    try {
      const result = await work();
      this.emit(runId, source, 'info', `${label}: xong sau ${elapsed()}`, attemptId);
      return result;
    } catch (error) {
      this.emit(runId, source, 'error', `${label}: dừng sau ${elapsed()} — ${(error as Error).message.slice(0, 300)}`, attemptId);
      throw error;
    } finally { clearInterval(timer); }
  }
  private stamp(): string { return this.now().toISOString(); }
}

