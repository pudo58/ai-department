import { deepQuality } from '../core/qualityevidence.js';
import { policyOf } from '../core/policy.js';
import { EVIDENCE_POLICY_V4 } from '../shared/regression.js';
import { readRegressionProposals, regressionFor } from '../core/regression.js';
import { validateTestPlan } from '../core/testplan.js';
import { randomUUID } from 'node:crypto';
import type { CheckResult, ContractApprovalInput, Finding, HumanTime, Mode, ProjectProfile, Run, RunDetail, RunStatus, Slot, TaskContract, TaskKind } from '../shared/types.js';
import { budgetState, checkEscalation, remainingFor } from '../core/budget.js';
import { approveContract, sha256, initialContract, isApproved, reviewContract, reviseContract, validateContract } from '../core/contract.js';
import { type AcceptanceReport } from '../core/report.js';
import { MODE_MULTIPLIER, recommendMode } from '../core/routing.js';
import { classifyPath, isSafeRelative, normalizePath } from '../core/scope.js';
import { selectCandidate } from '../core/selection.js';
import { redactSecrets } from '../runtime/process.js';
import { RuntimeBlockedError, type Runtime } from '../runtime/types.js';
import { SerialQueue } from './scheduler.js';
import type { Store } from './store.js';
import { Blocked, CAPACITY, HttpError, QUOTA, Stopped, WAITING, type CandidateRecord } from './run/support.js';
import { RunServices } from './run/services.js';
import type { SkillLibrary } from '../runtime/skilllibrary.js';
import { ScopePolicy } from './run/scope.js';
import { RunOutcome } from './run/outcome.js';
import { CheckRunner } from './run/checks.js';
import { CandidateBuilder } from './run/candidates.js';
import { Verification } from './run/verification.js';
import { Planning } from './run/planning.js';
import { Acceptance } from './run/acceptance.js';
import { HumanTimers } from './run/timers.js';
import { TestRecovery } from './run/recovery.js';
import { pendingTestRepair } from '../core/recovery.js';
import { pendingAuthorDraft } from '../core/authordraft.js';
import { EnvironmentChecks } from './run/environment.js';
import {REPLAY_TITLE} from '../core/reproduction.js';

export { HttpError };

export interface CreateRunInput {
  projectId: string; title: string; originalRequirement: string; mode: Mode; provider: Run['provider'];
  budgetUsd: number; signals: string[]; taskKind?: TaskKind;
}
export interface OrchestratorOptions { agentSlots?: number; now?: () => Date; /** How often a long step reports "still running" (default 30s). */ heartbeatMs?: number; /** Library the roles' skills come from; without it assigned skills are skipped with a warning. */ skills?: SkillLibrary }

/**
 * The public face of a run: lifecycle (create, start, stop, resume, delete), the person's decisions (approve a
 * contract, accept, reject, escalate, confirm findings) and the driver that moves a run through its stages. Each stage's
 * work lives in its own class under ./run, wired together here around one shared RunServices.
 */
export class Orchestrator {
  private readonly queue: SerialQueue;
  private readonly aborts = new Map<string, AbortController>();
  private readonly now: () => Date;
  private readonly s: RunServices;
  private readonly scope: ScopePolicy;
  private readonly outcome: RunOutcome;
  private readonly checks: CheckRunner;
  private readonly candidates: CandidateBuilder;
  private readonly verification: Verification;
  private readonly planning: Planning;
  private readonly timers: HumanTimers;
  private readonly acceptance: Acceptance;
  private readonly recovery: TestRecovery;

  constructor(private readonly store: Store, private readonly runtimeFor: (run: Run) => Runtime, options: OrchestratorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.s = new RunServices(store, runtimeFor, this.now, options.agentSlots ?? 3, options.heartbeatMs ?? 30_000, options.skills);
    this.scope = new ScopePolicy(this.s);
    this.outcome = new RunOutcome(this.s, this.scope);
    this.checks = new CheckRunner(this.s);
    this.candidates = new CandidateBuilder(this.s, this.scope, this.checks);
    this.verification = new Verification(this.s, this.scope, this.outcome, this.checks);
    this.planning = new Planning(this.s);
    this.timers = new HumanTimers(this.s);
    this.acceptance = new Acceptance(this.s, this.outcome, this.timers, this.verification);
    this.recovery = new TestRecovery(this.s, this.scope);
    this.queue = new SerialQueue((id) => this.drive(id));
  }

  // ---------------------------------------------------------------- lifecycle

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

  /** Interrupted attempts cannot be trusted; park their runs so a person decides when to resume. */
  async recover(): Promise<void> {
    const interruptedRuns=new Set<string>();
    for(const artifact of this.store.artifacts.list().filter(a=>a.title===REPLAY_TITLE)){
      try{const replay=JSON.parse(artifact.content);if(replay.status!=='in_progress')continue;replay.status='interrupted';replay.endedAt=this.s.stamp();replay.message='Server dừng khi tái hiện; chưa có bằng chứng hoàn tất.';this.store.artifacts.put({...artifact,content:JSON.stringify(replay),hash:sha256(JSON.stringify(replay))});interruptedRuns.add(artifact.runId);}catch{/* Invalid artifacts cannot confirm a finding. */}
    }
    for(const id of interruptedRuns){const run=this.store.runs.get(id);if(run)try{await this.runtimeFor(run).recoverReplays?.(run);}catch(error){this.s.log(id,'replay.cleanup_failed',(error as Error).message);}}
    for(const run of this.store.runs.list().filter(r=>r.executionSpans?.some(s=>s.status==='running' && s.kind!=='approval'))){
      this.s.mutate(run.id,r=>{for(const span of r.executionSpans!.filter(s=>s.status==='running' && s.kind!=='approval')){span.status='interrupted';span.endedAt=this.s.stamp();}});
    }
    for (const run of this.store.runs.list().filter((r) => r.delivery?.status === 'in_progress')) {
      this.s.mutate(run.id, (r) => {
        r.delivery = { ...r.delivery!, status: 'unknown', endedAt: this.s.stamp(), error: 'Server dừng khi đang giao kết quả. Cần thử giao lại để xác nhận.' };
        r.status = 'awaiting_acceptance';
      });
      this.s.log(run.id, 'deliver.interrupted', 'Chưa xác nhận giao kết quả sau khi server khởi động lại; giữ workspace để thử giao lại.');
    }
    for (const artifact of this.store.artifacts.list().filter(a => a.title === 'Mutation result')) {
      try {
        const result = JSON.parse(artifact.content);
        if (result.status !== 'in_progress') continue;
        const run = this.store.runs.get(artifact.runId);
        if (run) { try { await this.runtimeFor(run).recoverMutation?.(run); } catch (error) { this.s.log(run.id, 'mutation.cleanup_failed', `Chưa dọn được mutation: ${(error as Error).message}`); } }
        result.status = 'incomplete'; result.endedAt = this.s.stamp(); result.message = 'Server dừng khi mutation đang chạy; chưa hoàn tất.';
        this.store.artifacts.put({ ...artifact, content: JSON.stringify(result), hash: sha256(JSON.stringify(result)) });
      } catch (error) { this.s.log(artifact.runId, 'mutation.recovery_failed', `Không khôi phục được lượt mutation: ${(error as Error).message}`); }
    }
    for (const attempt of this.store.attempts.list().filter((a) => a.status === 'running')) {
      const run = this.store.runs.get(attempt.runId);
      if (run) await this.runtimeFor(run).stop(attempt.id).catch(() => undefined);
      this.store.attempts.put({ ...attempt, status: 'interrupted', endedAt: this.s.stamp(), error: 'Server dừng khi attempt đang chạy.' });
    }
    for (const run of this.store.runs.list().filter((r) => r.status === 'running' || r.status === 'queued')) {
      this.s.mutate(run.id, (r) => { r.status = 'paused'; r.blocker = `Bị gián đoạn ở giai đoạn "${r.stage}". Resume sẽ chạy lại giai đoạn từ checkpoint đã chấp nhận.`; });
      this.s.log(run.id, 'recovery', 'Run bị gián đoạn và được tạm dừng.');
    }
  }

  createRun(input: CreateRunInput): Run {
    const project = this.store.projects.get(input.projectId);
    if (!project) throw new HttpError(404, 'Project không tồn tại.');
    if (input.provider !== 'fake' && !project.approved) throw new HttpError(409, 'Project chưa duyệt policy; chỉ run mô phỏng được phép.');
    if (!(input.budgetUsd > 0)) throw new HttpError(400, 'Ngân sách phải lớn hơn 0.');
    const recommendation = recommendMode(input.signals);
    const now = this.s.stamp();
    const budget = input.mode === 'single' ? input.budgetUsd : input.budgetUsd * MODE_MULTIPLIER[input.mode];
    const run: Run = {
      id: `run_${randomUUID().slice(0, 8)}`, executionSpans: [], projectId: project.id, title: input.title, originalRequirement: input.originalRequirement,
      mode: input.mode, initialMode: input.mode, taskKind: input.taskKind, selectedSlot: 'A', provider: input.provider,
      status: 'draft', stage: 'prepare', ...(input.mode === 'verify' ? { qualityPolicyVersion: 4 as const, evidencePolicy: structuredClone(EVIDENCE_POLICY_V4) } : {}), contract: initialContract(input.originalRequirement), interpretations: [],
      baseSha: null, checkpoint: null, branch: null, budgetUsd: budget, baseBudgetUsd: input.budgetUsd,
      configSnapshot: structuredClone(project), signals: input.signals, recommendation, escalations: [], usage: [], humanTime: [],
      repairCount: 0, blocker: null, createdAt: now, updatedAt: now,
    };
    this.store.runs.put(run);
    this.s.log(run.id, 'run.created', `Tạo task ở chế độ ${run.mode}; đề xuất: ${recommendation.mode}.`, { recommendation });
    return run;
  }

  startRun(runId: string): Run {
    this.s.assertNotDelivering(runId);
    const run = this.s.run(runId);
    if (!run.testRepairApproval && pendingTestRepair(run, this.store.artifacts.list(runId))) throw new HttpError(409, 'Có đề xuất sửa test đang chờ duyệt; hãy đọc diff và quyết định trước khi chạy tiếp.');
    if (!['draft', 'paused', 'blocked', 'failed'].includes(run.status)) throw new HttpError(409, `Không thể bắt đầu run ở trạng thái ${run.status}.`);
    // An explicit retry of a terminal failure authorizes another bounded batch; crash-resume does not.
    if (run.status === 'failed') this.authorizeDeveloperRetry(runId, 'Người dùng yêu cầu thử lại run thất bại.');
    // "Run again" must actually try again; failed candidates are only kept across an escalation.
    this.scope.discardFailedCandidates(runId);
    return this.enqueue(runId);
  }

  /**
   * A run that has no checkpoint yet has no evidence tied to its configuration, so resuming it picks up the project's
   * latest modules, checks and guidance (e.g. after widening the allowed modules). Runs with a checkpoint keep their
   * snapshot until someone re-runs the checks.
   */
  resumeRun(runId: string): Run {
    this.s.assertNotDelivering(runId);
    const run = this.s.run(runId);
    const project = this.store.projects.get(run.projectId);
    if (project && !run.checkpoint && ['paused', 'blocked', 'failed'].includes(run.status) && project.version !== run.configSnapshot.version && (project.approved || run.provider === 'fake')) {
      this.s.mutate(runId, (r) => { r.configSnapshot = structuredClone(project); });
      this.s.log(runId, 'config.refreshed', `Run chưa có checkpoint nên dùng cấu hình mới nhất của project (v${project.version}): module ${project.modules.join(', ')}`);
    }
    if (!run.checkpoint && run.context && ['paused', 'blocked', 'failed'].includes(run.status)) this.s.mutate(runId, (r) => { delete r.context; });
    return this.startRun(runId);
  }

  stopRun(runId: string): Run {
    this.s.assertNotDelivering(runId);
    const run = this.s.run(runId);
    this.aborts.get(runId)?.abort();
    this.queue.dequeue(runId);
    if (run.status === 'queued') this.s.mutate(runId, (r) => { r.status = 'paused'; r.blocker = 'Đã dừng bởi người dùng.'; delete r.pendingAction; });
    for (const attempt of this.store.attempts.list(runId).filter((a) => a.status === 'running')) void this.runtimeFor(run).stop(attempt.id);
    this.s.log(runId, 'run.stop', 'Người dùng yêu cầu dừng.');
    return this.s.run(runId);
  }

  /**
   * Deletes a run and its records. A run that is queued or still has a step in flight must be stopped first, so no
   * agent or check writes into a run that no longer exists. The caller removes the working copy on disk.
   */
  deleteRun(runId: string): Run {
    const run = this.s.run(runId);
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

  assertNotDelivering(runId: string): void { this.s.assertNotDelivering(runId); }

  private busy(run: Run): boolean { return this.s.isDelivering(run.id) || ['running', 'queued'].includes(run.status) || this.aborts.has(run.id) || this.queue.isQueued(run.id); }

  private forget(runId: string): void {
    this.queue.dequeue(runId);
    for (const key of [...this.s.sessions.keys()]) if (key.startsWith(`${runId}:`)) this.s.sessions.delete(key);
    this.s.baseFileCache.delete(runId);
  }

  approveContract(runId: string, input: ContractApprovalInput): Run {
    this.s.assertNotDelivering(runId);
    const run = this.s.run(runId);
    if (run.status !== 'awaiting_approval') throw new HttpError(409, 'Hợp đồng chỉ được duyệt khi run đang chờ duyệt.');
    const review = reviewContract(run.contract);
    if (input.contractHash !== review.contractHash) throw new HttpError(409, 'Hợp đồng đã thay đổi. Hãy tải lại và đọc bản hiện tại trước khi duyệt.');
    const policy = policyOf(run);
    const planProblems = deepQuality(run) ? validateTestPlan(run.contract, true, policy.reasoning, policy.strict) : [];
    if (planProblems.length) throw new HttpError(400, planProblems.join(' '));
    if (policy.structured && run.contract.testPlan?.schemaVersion !== 2) throw new HttpError(409, 'Chính sách v2+ cần kế hoạch ca có căn cứ v2.');
    const contract = this.s.guard(() => approveContract(run.contract, this.now()));
    if (review.warnings.length && !input.acknowledgeWarnings) throw new HttpError(409, 'Hợp đồng có cảnh báo cần đọc; hãy xác nhận đã đọc và đồng ý dùng hợp đồng này.');
    const receipt = { contractHash: review.contractHash, contractVersion: review.contractVersion, reviewedAt: contract.approvedAt!, acknowledgedWarnings: review.warnings.map((w) => w.code) };
    this.s.mutate(runId, (r) => { r.contract = contract; r.contractReviewReceipt = receipt; });
    this.s.artifact(runId, { kind: 'report', title: 'Soát hợp đồng trước khi duyệt', content: JSON.stringify({ review, receipt }), checkpoint: null });
    this.s.log(runId, 'contract.approved', `Đã duyệt hợp đồng v${contract.version}.`, { hash: contract.approvedHash });
    return this.enqueue(runId);
  }

  approveTestRepair(runId: string, proposalId: string, proposalHash: string): Run {
    this.s.assertNotDelivering(runId);
    this.recovery.approve(runId, proposalId, proposalHash);
    return this.enqueue(runId);
  }

  rejectTestRepair(runId: string, proposalId: string, proposalHash: string): Run {
    this.s.assertNotDelivering(runId);
    this.recovery.reject(runId, proposalId, proposalHash);
    return this.s.run(runId);
  }

  private authorizeDeveloperRetry(runId: string, reason: string): void {
    this.s.retry(runId,'user_request',reason);
    const run = this.s.run(runId);
    this.s.artifact(runId, { kind: 'report', title: 'Developer retry authorization', content: JSON.stringify({ reason, previousAttemptIds: this.store.attempts.list(runId).filter(a => a.role === 'developer' && a.contractVersion === run.contract.version).map(a => a.id) }), checkpoint: run.checkpoint });
  }

  /** Any real change bumps the version and strands every earlier piece of evidence. */
  reviseContract(runId: string, next: Omit<TaskContract, 'version' | 'approvedHash' | 'approvedAt'>): Run {
    this.s.assertNotDelivering(runId);
    const run = this.s.run(runId);
    if (!WAITING.includes(run.status)) throw new HttpError(409, 'Không thể sửa hợp đồng khi run đang chạy.');
    const revised = reviseContract(run.contract, next);
    const problems = validateContract(revised);
    if (problems.length) throw new HttpError(400, problems.join(' '));
    if (revised === run.contract) return run;
    this.invalidateEvidence(runId, revised.version);
    this.s.mutate(runId, (r) => { r.contract = revised; delete r.contractReviewReceipt; delete r.testRepairApproval; r.status = 'awaiting_approval'; r.blocker = null; });
    this.s.log(runId, 'contract.revised', `Hợp đồng lên v${revised.version}; bằng chứng cũ mất hiệu lực.`);
    return this.s.run(runId);
  }

  escalate(runId: string, to: Mode, reason: string, approvedCapUsd?: number): Run {
    this.s.assertNotDelivering(runId);
    const run = this.s.run(runId);
    if (!['blocked', 'paused', 'failed', 'awaiting_acceptance'].includes(run.status)) throw new HttpError(409, 'Chỉ chuyển chế độ khi run đang chờ người dùng.');
    if (to === run.mode) throw new HttpError(400, 'Run đã ở chế độ này.');
    const spent = budgetState(run, this.store.attempts.list(runId)).spentUsd;
    const check = checkEscalation(run, spent, to, approvedCapUsd);
    if (!check.allowed) throw new HttpError(409, check.reason);
    this.s.mutate(runId, (r) => {
      r.escalations.push({ from: r.mode, to, reason, at: this.s.stamp() });
      r.mode = to; r.budgetUsd = check.newCapUsd;
    });
    this.s.log(runId, 'run.escalate', `Chuyển ${run.mode} → ${to}: ${reason}`, { budgetUsd: check.newCapUsd });
    return this.enqueue(runId);
  }

  // ------------------------------------------------------------ delegated to the stage classes

  /** The acceptance report: built on demand so it always reflects the live checkpoint. */
  report(runId: string): Promise<AcceptanceReport> { return this.acceptance.report(runId); }
  acceptRun(runId: string, options: { acknowledgeWarnings?: boolean } = {}): Promise<Run> { return this.acceptance.acceptRun(runId, options); }
  rejectAcceptance(runId: string, reason: string): Run { return this.acceptance.rejectAcceptance(runId, reason); }
  detail(runId: string): RunDetail { return this.outcome.detail(runId); }
  startTimer(runId: string, category: HumanTime['category'], note = ''): HumanTime { return this.timers.startTimer(runId, category, note); }
  stopTimer(runId: string, timerId: string): HumanTime { return this.timers.stopTimer(runId, timerId); }
  /** Manual entry for corrections and work done away from the screen (e.g. post-delivery fixes). */
  addHumanMinutes(runId: string, category: HumanTime['category'], minutes: number, note = ''): HumanTime { return this.timers.addHumanMinutes(runId, category, minutes, note); }

  // ------------------------------------------------------------ findings/checks

  /**
   * v4: a finding is confirmed against the exact regression proposal a person read (its hash), or by a manual review that says why.
   * Older runs keep the one-click confirmation they were made with.
   */
  confirmFinding(runId: string, findingId: string, input: { proposalHash?: string; manualReason?: string } = {}): Finding {
    if (!policyOf(this.s.run(runId)).strict) return this.patchFinding(runId, findingId, (f) => { f.confirmed = true; f.status = 'open'; });
    return this.patchFinding(runId, findingId, (f) => { Object.assign(f, this.verification.regressions.confirm(runId, f, input)); }, true);
  }
  disputeFinding(runId: string, findingId: string, dispute: string): Finding { return this.patchFinding(runId, findingId, (f) => { f.status = 'disputed'; f.dispute = dispute; }); }
  /** v4: closing without the runner's proof is a recorded decision with a reason, never a bare id. */
  resolveFinding(runId: string, findingId: string, input: { reason?: string } = {}): Finding {
    if (!policyOf(this.s.run(runId)).strict) return this.patchFinding(runId, findingId, (f) => { f.status = 'resolved'; });
    const reason = input.reason?.trim();
    if (!reason || reason.length < 10) throw new HttpError(400, 'Đóng finding cần lý do review thủ công (ít nhất 10 ký tự): nêu bạn đã kiểm tra gì. Finding chỉ tự được đánh dấu đã sửa khi runner chứng minh được.');
    return this.patchFinding(runId, findingId, (f) => { f.status = 'resolved'; f.resolution = { kind: 'manual_review', at: this.s.stamp(), reason, checkpoint: this.s.run(runId).checkpoint ?? undefined }; }, true);
  }
  /** Runs the counterexample of one finding again on the live checkpoint. It uses the queue and the run's lock, and calls no AI. */
  replayFinding(runId: string, findingId: string, proposalHash?: string): Run {
    this.s.assertNotDelivering(runId);
    const run = this.s.run(runId), finding = this.store.findings.get(findingId);
    if (!finding || finding.runId !== runId) throw new HttpError(404, 'Finding không tồn tại.');
    if (!['blocked', 'paused', 'failed', 'awaiting_acceptance'].includes(run.status)) throw new HttpError(409, 'Chỉ chạy lại phản ví dụ khi run đang chờ người dùng.');
    if (!finding.reproduction) throw new HttpError(409, 'Finding này chưa có kịch bản phản ví dụ chạy được.');
    if (!run.checkpoint) throw new HttpError(409, 'Chưa có checkpoint để chạy phản ví dụ.');
    const current = regressionFor(readRegressionProposals(run, this.store.artifacts.list(runId)), finding);
    if (proposalHash && proposalHash !== current?.hash) throw new HttpError(409, 'Đề xuất regression đã đổi; tải lại trạng thái hiện tại.');
    this.s.retry(runId, 'user_request', 'Người dùng yêu cầu chạy lại phản ví dụ của một finding; không gọi AI.');
    this.s.mutate(runId, (r) => { r.pendingAction = 'replay'; r.pendingReplay = { findingId, ...(proposalHash ? { proposalHash } : {}) }; });
    return this.enqueue(runId);
  }

  private patchFinding(runId: string, id: string, change: (f: Finding) => void, requireIdle = false): Finding {
    this.s.assertNotDelivering(runId);
    const finding = this.store.findings.get(id);
    if (!finding || finding.runId !== runId) throw new HttpError(404, 'Finding không tồn tại.');
    if (requireIdle && this.busy(this.s.run(runId))) throw new HttpError(409, 'Run đang chạy; chờ nó dừng rồi mới đổi trạng thái finding.');
    change(finding);
    this.store.findings.put(finding);
    this.s.log(runId, 'finding.update', `Finding "${finding.title}" → ${finding.status}${finding.confirmed ? ' (đã xác nhận)' : ''}.`);
    this.outcome.refreshAcceptanceState(runId);
    return finding;
  }

  /** Quarantine needs a reason and a condition to revisit; a quarantined check never counts as evidence. */
  quarantineCheck(runId: string, checkId: string, reason: string): CheckResult {
    this.s.assertNotDelivering(runId);
    const check = this.store.checks.get(checkId);
    if (!check || check.runId !== runId) throw new HttpError(404, 'Check không tồn tại.');
    if (reason.trim().length < 3) throw new HttpError(400, 'Cần nêu lý do và điều kiện xem xét lại.');
    check.quarantined = true; check.quarantineReason = reason.trim();
    this.store.checks.put(check);
    this.s.log(runId, 'check.quarantine', `Quarantine "${check.recipeId}": ${reason}`);
    this.outcome.refreshAcceptanceState(runId);
    return check;
  }

  /** Confirmed findings get one repair round funded by the final-verification share. */
  repairFindings(runId: string): Run {
    this.s.assertNotDelivering(runId);
    const run = this.s.run(runId);
    if (!['blocked', 'awaiting_acceptance'].includes(run.status)) throw new HttpError(409, 'Chỉ sửa finding khi run đang chờ người dùng.');
    const targets = this.store.findings.list(runId).filter((f) => f.confirmed && f.status === 'open' && f.contractVersion === run.contract.version);
    if (!targets.length) throw new HttpError(409, 'Chưa có finding nào được xác nhận.');
    if (policyOf(run).strict) {
      const artifacts = this.store.artifacts.list(runId), stale = targets.filter((f) => !this.verification.regressions.confirmationValid(run, f, artifacts));
      if (stale.length) throw new HttpError(409, `Xác nhận của ${stale.map((f) => `"${f.title}"`).join(', ')} không còn khớp đề xuất hiện tại; chạy lại phản ví dụ rồi xác nhận lại.`);
    }
    this.s.mutate(runId, (r) => { r.status = 'queued'; r.blocker = null; r.pendingAction = 'repair'; });
    this.queue.enqueue(runId);
    return this.s.run(runId);
  }
  /**
   * Runs the checks again on the existing checkpoint, optionally with the project's latest configuration
   * (check command, modules, setup). No agent runs, so it costs no tokens.
   */
  recheck(runId: string, refreshConfig = true): Run {
    this.s.assertNotDelivering(runId);
    const run = this.s.run(runId);
    if (!['blocked', 'paused', 'failed', 'awaiting_acceptance'].includes(run.status)) throw new HttpError(409, 'Chỉ chạy lại check khi run đang chờ người dùng.');
    if (run.mode === 'compare') throw new HttpError(409, 'Chế độ Compare chưa hỗ trợ chạy lại check riêng; dùng Chạy tiếp.');
    if (!run.checkpoint) throw new HttpError(409, 'Chưa có checkpoint nào để chạy lại check; hãy dùng Chạy tiếp.');
    this.s.retry(runId,'user_request','Người dùng yêu cầu chạy lại checks trên checkpoint hiện tại.');
    if (refreshConfig) {
      const project = this.store.projects.get(run.projectId);
      if (!project) throw new HttpError(404, 'Project không tồn tại.');
      if (run.provider !== 'fake' && !project.approved) throw new HttpError(409, 'Project đã đổi cấu hình và chưa được duyệt lại policy.');
      this.s.mutate(runId, (r) => { r.configSnapshot = structuredClone(project); });
      this.s.log(runId, 'config.refreshed', `Dùng cấu hình mới nhất của project (v${project.version}): check ${project.checks.map((c) => c.command.join(' ')).join(' ; ')}`);
    }
    this.s.mutate(runId, (r) => { r.pendingAction = 'recheck'; });
    return this.enqueue(runId);
  }

  preflight(runId:string):Run {
    this.s.assertNotDelivering(runId);const run=this.s.run(runId);
    if(!['blocked','paused','failed','awaiting_approval','awaiting_acceptance'].includes(run.status) || !run.baseSha)throw new HttpError(409,'Cần workspace đã chuẩn bị và run đang chờ để kiểm tra môi trường.');
    const project=this.store.projects.get(run.projectId);
    if(project && project.version!==run.configSnapshot.version){if(run.provider!=='fake' && !project.approved)throw new HttpError(409,'Cấu hình project chưa được duyệt.');this.s.mutate(runId,r=>{r.configSnapshot=structuredClone(project);});}
    this.s.mutate(runId,r=>{r.preflightRequest=true;r.preflightReturnStatus=run.status;});return this.enqueue(runId);
  }
  revalidateAuthorDraft(runId:string,attemptId:string,draftHash:string):Run {
    this.s.assertNotDelivering(runId);const run=this.s.run(runId),draft=pendingAuthorDraft(run,this.store.artifacts.list(runId));
    if(!['blocked','paused','failed'].includes(run.status) || !draft || draft.attemptId!==attemptId || draft.draftHash!==draftHash)throw new HttpError(409,'Draft hoặc trạng thái đã đổi; tải lại dữ liệu.');
    this.s.mutate(runId,r=>{r.authorDraftRequest={attemptId,draftHash};});return this.enqueue(runId);
  }

  idle(): Promise<void> { return this.queue.idle(); }

  // ----------------------------------------------------------------- driver and build flow

  private enqueue(runId: string): Run {
    this.s.mutate(runId, (r) => { r.status = 'queued'; r.blocker = null; });
    this.queue.enqueue(runId);
    return this.s.run(runId);
  }

  /** Registers who serves a run's working copy by hand; it is told before every turn, check and delivery so it can let go. */
  onWorkspaceBusy(handler: (runId: string) => void): void { this.s.onWorkspaceBusy = handler; }

  private async drive(runId: string): Promise<void> {
    this.s.workspaceBusy(runId);
    const controller = new AbortController();
    this.aborts.set(runId, controller);
    const span=this.s.startSpan(runId,'run','Điều phối run');
    try {
      this.s.mutate(runId, (r) => { r.status = 'running'; });
      if (this.s.run(runId).baseSha) { await this.s.ensureContext(runId); await this.s.loadBaseFiles(runId); await this.s.refreshRegressions(runId); }
      if(this.s.run(runId).preflightRequest){
        try {
          await new EnvironmentChecks(this.s).run(runId,controller.signal,true);
          this.s.mutate(runId,r=>{
            const previous=r.preflightReturnStatus;
            r.status=previous==='awaiting_approval'||previous==='awaiting_acceptance'?previous:'paused';
            r.blocker=r.status==='paused'?'Đã kiểm tra lại môi trường; bấm Chạy tiếp hoặc Chạy lại kiểm tra để tiếp tục.':null;
          });
          this.outcome.refreshAcceptanceState(runId);
        } finally { this.s.mutate(runId,r=>{delete r.preflightRequest;delete r.preflightReturnStatus;}); }
      }
      else if(this.s.run(runId).authorDraftRequest){
        try{await this.candidates.revalidateAuthorDraft(runId);}finally{this.s.mutate(runId,r=>{delete r.authorDraftRequest;});}
      }
      else if (this.s.run(runId).testRepairApproval) await this.applyTestRepair(runId, controller.signal);
      else if (this.s.run(runId).pendingAction === 'recheck') await this.recheckPhase(runId, controller.signal);
      else if (this.s.run(runId).pendingAction === 'repair') await this.verification.repairPhase(runId, controller.signal);
      else if (this.s.run(runId).pendingAction === 'replay') await this.verification.replayPhase(runId, controller.signal);
      else if (!isApproved(this.s.run(runId).contract)) await this.planning.planPhase(runId, controller.signal);
      else await this.buildPhase(runId, controller.signal);
      await this.autoRecover(runId, controller.signal);
    } catch (error) {
      this.recordStop(runId, error, controller.signal);
    } finally {
      this.s.endSpan(runId,span,controller.signal.aborted?'interrupted':['blocked','failed'].includes(this.s.run(runId).status)?'failed':'completed');
      this.aborts.delete(runId);
      const run = this.store.runs.get(runId);
      // Reached on every normal exit (finished, blocked, stopped by the person) but not when the server dies mid-turn, so an
      // interrupted request is still there to be carried out when the run is resumed.
      if (run?.pendingAction) this.s.mutate(runId, (r) => { delete r.pendingAction; delete r.pendingReplay; });
      if (run && run.status === 'running') this.s.mutate(runId, (r) => { r.status = 'paused'; r.blocker = 'Giai đoạn kết thúc mà không có trạng thái rõ ràng.'; });
    }
  }

  /**
   * A test correction approved by the system (see TestRecovery.autoApprove) is applied right away instead of waiting for a
   * person; and when the corrected tests still fail, the normal repair loop goes on (twice at most per contract version)
   * instead of the run ending on the first red check.
   */
  private async autoRecover(runId: string, signal: AbortSignal): Promise<void> {
    for (let step = 0; step < 6; step++) {
      const run = this.s.run(runId);
      const stopped = ['blocked', 'failed'].includes(run.status);
      if (stopped && run.testRepairApproval?.auto && !run.testRepairApproval.appliedCheckpoint) {
        this.s.mutate(runId, (r) => { r.status = 'running'; r.blocker = null; });
        await this.applyTestRepair(runId, signal);
        continue;
      }
      const artifacts = this.store.artifacts.list(runId).filter((a) => a.valid && a.contractVersion === run.contract.version);
      const corrected = artifacts.some((a) => a.title === 'Test repair receipt');
      const continued = artifacts.filter((a) => a.title === 'Auto continue after test repair').length;
      if (run.status !== 'failed' || !corrected || continued >= 2) return;
      this.s.artifact(runId, { kind: 'report', title: 'Auto continue after test repair', content: '{}', checkpoint: run.checkpoint });
      this.authorizeDeveloperRetry(runId, 'Bản sửa test đã áp dụng nhưng check vẫn fail: tiếp tục vòng sửa thông thường.');
      this.scope.discardFailedCandidates(runId);
      this.s.mutate(runId, (r) => { r.status = 'running'; r.blocker = null; });
      await this.buildPhase(runId, signal);
    }
  }

  private async applyTestRepair(runId: string, signal: AbortSignal): Promise<void> {
    this.s.mutate(runId, (r) => { delete r.pendingAction; });
    await this.recovery.applyApproved(runId);
    await this.recheckPhase(runId, signal, false);
    this.s.mutate(runId, r => { delete r.testRepairApproval; });
  }

  private recordStop(runId: string, error: unknown, signal: AbortSignal): void {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    let status: RunStatus = 'failed', blocker = message;
    if (signal.aborted || error instanceof Stopped) { status = 'paused'; blocker = 'Đã dừng bởi người dùng.'; }
    else if (error instanceof Blocked) status = 'blocked';
    else if (error instanceof RuntimeBlockedError) { status = 'blocked'; blocker = `Runtime bị chặn: ${message}`; }
    else if (CAPACITY.test(message)) { status = 'blocked'; blocker = `Máy chủ của model đang quá tải (${message}). Đây không phải lỗi của task; đợi vài phút rồi bấm Chạy tiếp. Công việc đã làm vẫn được giữ.`; this.s.log(runId, 'capacity', blocker); }
    else if (QUOTA.test(message)) { status = 'blocked'; blocker = `Có thể đã chạm quota: ${message}. Chờ rồi resume; không tự đổi provider.`; this.s.log(runId, 'quota', blocker); }
    this.s.mutate(runId, (r) => { r.status = status; r.blocker = blocker; });
    this.s.log(runId, `run.${status}`, blocker);
  }

  private async buildPhase(runId: string, signal: AbortSignal): Promise<void> {
    let run = this.s.run(runId);
    const runtime = this.runtimeFor(run);
    await new EnvironmentChecks(this.s).run(runId,signal);
    this.s.mutate(runId, (r) => { r.stage = 'implement'; });
    if (run.mode === 'verify' && !this.scope.hasAuthorTests(runId)) await this.candidates.authorAcceptanceTests(runId, signal);

    const slots: Slot[] = run.mode === 'compare' ? ['A', 'B'] : ['A'];
    const records = new Map<Slot, CandidateRecord>();
    for (const slot of slots) {
      const existing = this.candidates.candidateRecord(runId, slot);
      if (existing) { records.set(slot, existing); continue; }
      if (slot === 'B') {
        run = this.s.run(runId);
        const state = budgetState(run, this.store.attempts.list(runId));
        if (remainingFor(state, 'implement') <= 0) throw new Blocked('Không còn ngân sách để mở phương án B; phần kiểm chứng cuối không được dùng cho việc này.');
        await this.s.withHeartbeat(runId, 'setup', 'Chuẩn bị bản sao B/cài dependency', () => runtime.prepare(run, 'B', this.s.runtimeLog(runId, 'setup')));
      }
      records.set(slot, await this.candidates.implementCandidate(runId, slot, signal));
    }

    await this.concludeBuild(runId, slots, records, signal);
  }

  /** Picks the winning candidate, then either parks the run or moves on to final verification. */
  private async concludeBuild(runId: string, slots: Slot[], records: Map<Slot, CandidateRecord>, signal: AbortSignal, checksOnly = false): Promise<void> {
    const evals = slots.map((slot) => this.candidates.evaluateCandidate(records.get(slot)!));
    let chosen: Slot;
    if (slots.length === 2) {
      const selection = selectCandidate(evals[0]!, evals[1]!);
      this.s.log(runId, 'compare.select', selection.reason);
      if (!selection.slot) throw new Blocked(selection.reason);
      chosen = selection.slot;
    } else chosen = 'A';
    const winner = records.get(chosen)!;
    if (!winner.success) {
      const failed = this.store.checks.list(runId).some((c) => c.checkpoint === winner.checkpoint && c.status === 'failed' && c.required);
      this.s.mutate(runId, (r) => { r.checkpoint = winner.checkpoint; r.selectedSlot = chosen; });
      this.outcome.park(runId, failed && !winner.fatal ? 'failed' : 'blocked', winner.problems.join(' ') || 'Chưa có candidate đạt yêu cầu.');
      return;
    }
    this.s.mutate(runId, (r) => { r.checkpoint = winner.checkpoint; r.selectedSlot = chosen; r.branch = `aidept/${r.id}-${chosen}`; });
    this.scope.lockAcceptance(runId, winner.testFiles, winner.checkpoint!);
    await this.verification.verifyPhase(runId, signal, checksOnly);
  }

  /**
   * Re-runs the checks on the checkpoint that already exists, with no agent involved. This is the right move when
   * the work is done but the check itself was wrong (e.g. a missing `test` script), so no tokens are spent.
   */
  private async recheckPhase(runId: string, signal: AbortSignal, checksOnly = true): Promise<void> {
    const run = this.s.run(runId);
    const slot = run.selectedSlot;
    this.s.mutate(runId, (r) => { r.stage = 'implement'; });
    const record: CandidateRecord = this.candidates.candidateRecord(runId, slot) ?? {
      slot, checkpoint: run.checkpoint, success: false, problems: [], fatal: false, changedFiles: [], testFiles: this.candidates.testFilesFromDiffs(runId), newToolIssues: 0, flakyChecks: 0, summary: '',
    };
    record.checkpoint = run.checkpoint;
    // A stopped attempt can leave half-finished edits in the workspace. Evidence is tied to the checkpoint commit, so
    // the tree must be exactly that commit before anything is measured.
    await this.runtimeFor(run).revert(run, slot);
    await new EnvironmentChecks(this.s).run(runId,signal);
    this.s.log(runId, 'recheck', `Chạy lại check trên đúng checkpoint ${run.checkpoint!.slice(0, 8)} (đã hoàn nguyên mọi thay đổi dở dang; không gọi agent).`);
    const outcome = await this.checks.runChecks(runId, slot, run.checkpoint!, record.testFiles, signal);
    record.flakyChecks = outcome.flaky;
    record.fatal = outcome.fatal.length > 0;
    record.problems = record.fatal ? outcome.fatal : outcome.problems;
    record.success = record.problems.length === 0;
    this.store.artifacts.put({ ...this.s.baseArtifact(runId, { kind: 'checkpoint', title: `Candidate ${slot}`, content: JSON.stringify(record), checkpoint: record.checkpoint }), id: `cand-${runId}-${slot}` });
    await this.concludeBuild(runId, [slot], new Map([[slot, record]]), signal, checksOnly);
  }

  /**
   * A person lets the agent touch paths outside the project's modules for THIS task. Protected files (lockfiles,
   * check configs, locked tests, traversal paths) can never be approved, and a directory approval does not
   * override them either, because classification checks the protected set first.
   */
  approvePaths(runId: string, paths: string[], resume = false): Run {
    this.s.assertNotDelivering(runId);
    const run = this.s.run(runId);
    if (!['blocked', 'paused', 'failed', 'awaiting_approval'].includes(run.status)) throw new HttpError(409, 'Chỉ duyệt đường dẫn khi run đang chờ người dùng.');
    // Validate what the caller sent: normalising first would turn "/etc" into the innocent-looking "etc".
    const bad = paths.find((p) => !isSafeRelative(p.trim()) || /[*?]/.test(p));
    if (bad !== undefined) throw new HttpError(400, `Đường dẫn không hợp lệ: ${bad}`);
    const cleaned = [...new Set(paths.map((p) => normalizePath(p.trim()).replace(/\/+$/, '')).filter(Boolean))];
    if (!cleaned.length) throw new HttpError(400, 'Chưa chọn đường dẫn nào.');
    const scope = this.scope.scopeFor(runId);
    for (const p of cleaned) {
      if (!isSafeRelative(p) || /[*?]/.test(p)) throw new HttpError(400, `Đường dẫn không hợp lệ: ${p}`);
      if (classifyPath(p, { modules: [p], protectedPaths: scope.protectedPaths, lockedPaths: scope.lockedPaths }) === 'protected') {
        throw new HttpError(400, `${p} là file được bảo vệ, không thể phê duyệt.`);
      }
    }
    this.s.mutate(runId, (r) => { r.approvedPaths = [...new Set([...(r.approvedPaths ?? []), ...cleaned])]; });
    this.s.log(runId, 'scope.approved', `Đã cho phép agent sửa: ${cleaned.join(', ')}`);
    if (!resume) return this.s.run(runId);
    this.authorizeDeveloperRetry(runId, 'Người dùng đã duyệt phạm vi sửa file và yêu cầu chạy tiếp.');
    this.scope.discardFailedCandidates(runId);
    return this.enqueue(runId);
  }

  // ----------------------------------------------------------------------- helpers

  private invalidateEvidence(runId: string, currentVersion: number): void {
    for (const a of this.store.artifacts.list(runId)) if (a.contractVersion < currentVersion && a.valid) this.store.artifacts.put({ ...a, valid: false });
    for (const c of this.store.checks.list(runId)) if (c.contractVersion < currentVersion && c.valid) this.store.checks.put({ ...c, valid: false });
  }

  /** The run's working copy at its checkpoint, for trying the result by hand; undefined for simulations or before any checkpoint. */
  workspaceOf(runId: string): string | undefined {
    const run = this.s.run(runId);
    if (!run.checkpoint || run.provider === 'fake') return undefined;
    return this.runtimeFor(run).workspacePath?.(run, run.selectedSlot);
  }

}

