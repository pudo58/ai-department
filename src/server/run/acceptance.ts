import { latestChecks,readManifest } from '../../core/qualityevidence.js';
import type { Run } from '../../shared/types.js';
import { delivered } from '../../core/delivery.js';
import { type AcceptanceReport, buildReport, type ChangedFile, needsAcknowledgement } from '../../core/report.js';
import { redactSecrets } from '../../runtime/process.js';
import { HttpError, FOLLOWUP_DAYS } from './support.js';
import type { RunServices } from './services.js';
import type { RunOutcome } from './outcome.js';
import type { Verification } from './verification.js';
import type { HumanTimers } from './timers.js';

/** The acceptance report and the decision to accept or reject it. */
export class Acceptance {
  constructor(private readonly s: RunServices, private readonly outcome: RunOutcome, private readonly timers: HumanTimers, private readonly verification: Verification) {}

  /**
   * The acceptance report: what was asked, what changed, which tests ran and what they proved, the independent
   * reviewer's verdict and every warning. Built on demand so it always reflects the live checkpoint.
   */
  async report(runId: string): Promise<AcceptanceReport> {
    this.verification.recoverVerdict(runId);
    const detail = this.outcome.detail(runId);
    const run = detail.run;
    let changes: { available: boolean; files: ChangedFile[]; patch: string } = { available: false, files: [], patch: '' };
    const runtime = this.s.runtimeFor(run);
    if (run.checkpoint && runtime.diffSinceBase) {
      try { changes = { available: true, ...(await runtime.diffSinceBase(run, run.selectedSlot)) }; }
      catch (error) { this.s.log(runId, 'report.diff_failed', `Không lấy được thống kê thay đổi: ${redactSecrets((error as Error).message)}`); }
    }
    return buildReport({
      planReview: detail.planReview,
      findingReplays:detail.findingReplays,assertionAudit:readManifest(run,detail.artifacts)?.manifest.assertionAudit,
      environment:detail.environment,
      quality: detail.quality, liveChecks: latestChecks(run, detail.checks), run, attempts: detail.attempts, checks: detail.checks, findings: detail.findings, artifacts: detail.artifacts, matrix: detail.matrix,
      completion: detail.completion, budget: detail.budget, changes, deliveryTarget: runtime.deliveryTarget?.(run, run.selectedSlot), now: this.s.now(),
    });
  }

  async acceptRun(runId: string, options: { acknowledgeWarnings?: boolean } = {}): Promise<Run> {
    this.s.assertNotDelivering(runId);
    this.s.workspaceBusy(runId);
    // Lock before the first await: report generation itself can yield to another acceptance or edit.
    this.s.deliveryLocks.add(runId);
    try { return await this.acceptLocked(runId, options); }
    finally { this.s.deliveryLocks.delete(runId); }
  }

  private async acceptLocked(runId: string, options: { acknowledgeWarnings?: boolean }): Promise<Run> {
    const detail = this.outcome.detail(runId);
    if (detail.run.status === 'completed' && delivered(detail.run)) return detail.run;
    // Legacy acceptance is kept as history, but it still needs a real delivery receipt.
    if (!['awaiting_acceptance', 'completed'].includes(detail.run.status)) throw new HttpError(409, 'Run chưa sẵn sàng nghiệm thu.');
    if (!detail.completion.ready) throw new HttpError(409, `Chưa đủ điều kiện nghiệm thu: ${detail.completion.reasons.join(' ')}`);
    // Accepting is a decision about what the report says, so warnings must have been read and acknowledged.
    const report = await this.report(runId);
    if (needsAcknowledgement(report) && !options.acknowledgeWarnings) {
      throw new HttpError(409, `Báo cáo có ${report.warnings.filter((w) => w.level === 'warn').length} cảnh báo cần đọc; hãy xác nhận đã đọc trước khi nghiệm thu.`);
    }
    this.s.artifact(runId, { kind: 'report', title: 'Báo cáo nghiệm thu', content: JSON.stringify({ report, acknowledgedWarnings: !!options.acknowledgeWarnings }), checkpoint: detail.run.checkpoint });
    const run = detail.run;
    if (!run.checkpoint) throw new HttpError(409, 'Chưa có checkpoint để giao kết quả.');
    const runtime = this.s.runtimeFor(run);
    const target = runtime.deliveryTarget?.(run, run.selectedSlot) ?? { kind: 'branch' as const, target: run.branch ?? `aidept/${run.id}-${run.selectedSlot}` };
    this.s.mutate(runId, (r) => {
      r.status = 'awaiting_acceptance'; r.blocker = null;
      r.delivery = { ...target, status: 'in_progress', checkpoint: run.checkpoint!, contractVersion: run.contract.version, slot: run.selectedSlot, startedAt: this.s.stamp() };
    });
    this.s.log(runId, 'deliver.started', 'Đang giao kết quả về project.', { checkpoint: run.checkpoint, contractVersion: run.contract.version, slot: run.selectedSlot, ...target });
    let result;
    try {
      if (!runtime.deliver) throw new Error('Runtime không hỗ trợ giao kết quả.');
      result = await runtime.deliver(run, run.selectedSlot);
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      this.s.mutate(runId, (r) => { r.status = 'awaiting_acceptance'; r.delivery = { ...r.delivery!, status: 'failed', endedAt: this.s.stamp(), error: message }; });
      this.s.log(runId, 'deliver.failed', `Không giao được kết quả về project gốc: ${message}`);
      throw new HttpError(409, `Chưa giao được kết quả: ${message}`);
    }
    // One instant for both fields, so the follow-up window is exactly seven days.
    const accepted = this.s.now();
    const followup = new Date(accepted.getTime() + FOLLOWUP_DAYS * 86_400_000).toISOString();
    this.s.mutate(runId, (r) => {
      r.delivery = { ...r.delivery!, kind: result.kind, target: redactSecrets(result.target), status: 'succeeded', endedAt: accepted.toISOString(), result: redactSecrets(result.summary) };
      r.status = 'completed'; r.acceptedAt = accepted.toISOString(); r.followupUntil = followup; r.blocker = null; this.timers.closeTimers(r);
    });
    this.s.log(runId, 'deliver', `Đã giao kết quả: ${redactSecrets(result.summary)}.`, { kind: result.kind, target: redactSecrets(result.target), checkpoint: run.checkpoint });
    this.s.log(runId, 'run.accepted', 'Đã nghiệm thu; bắt đầu cửa sổ theo dõi 7 ngày.');
    return this.s.run(runId);
  }

  /** A person found the delivery lacking. This is rework, not a new task, so the cost stays attached. */
  rejectAcceptance(runId: string, reason: string): Run {
    this.s.assertNotDelivering(runId);
    const run = this.s.run(runId);
    if (run.status !== 'awaiting_acceptance') throw new HttpError(409, 'Run không ở bước nghiệm thu.');
    this.s.mutate(runId, (r) => { r.status = 'blocked'; r.blocker = `Từ chối nghiệm thu: ${reason}`; });
    this.s.log(runId, 'run.rejected', `Từ chối nghiệm thu: ${reason}`);
    return this.s.run(runId);
  }
}
