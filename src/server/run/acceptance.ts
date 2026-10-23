import type { Run } from '../../shared/types.js';
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
      run, attempts: detail.attempts, checks: detail.checks, findings: detail.findings, artifacts: detail.artifacts, matrix: detail.matrix,
      completion: detail.completion, budget: detail.budget, changes, delivered: detail.events.some((e) => e.type === 'deliver'), now: this.s.now(),
    });
  }

  async acceptRun(runId: string, options: { acknowledgeWarnings?: boolean } = {}): Promise<Run> {
    const detail = this.outcome.detail(runId);
    if (detail.run.status !== 'awaiting_acceptance') throw new HttpError(409, 'Run chưa sẵn sàng nghiệm thu.');
    if (!detail.completion.ready) throw new HttpError(409, `Chưa đủ điều kiện nghiệm thu: ${detail.completion.reasons.join(' ')}`);
    // Accepting is a decision about what the report says, so warnings must have been read and acknowledged.
    const report = await this.report(runId);
    if (needsAcknowledgement(report) && !options.acknowledgeWarnings) {
      throw new HttpError(409, `Báo cáo có ${report.warnings.filter((w) => w.level === 'warn').length} cảnh báo cần đọc; hãy xác nhận đã đọc trước khi nghiệm thu.`);
    }
    this.s.artifact(runId, { kind: 'report', title: 'Báo cáo nghiệm thu', content: JSON.stringify({ report, acknowledgedWarnings: !!options.acknowledgeWarnings }), checkpoint: detail.run.checkpoint });
    // Delivery adds a new branch to the original repository. It is attempted first but never blocks acceptance:
    // the work stays in the workspace clone, and the failure is recorded for a person to resolve.
    const run = detail.run;
    const deliver = this.s.runtimeFor(run).deliver;
    if (deliver) {
      try { const result = await deliver.call(this.s.runtimeFor(run), run, run.selectedSlot); const isBranch = result.startsWith('aidept/'); this.s.log(runId, 'deliver', isBranch ? `Đã tạo branch ${result} trong repository gốc.` : `Đã giao kết quả: ${result}.`, { branch: isBranch ? result : undefined }); }
      catch (error) { this.s.log(runId, 'deliver.failed', `Không giao được kết quả về project gốc: ${redactSecrets((error as Error).message)}`); }
    }
    // One instant for both fields, so the follow-up window is exactly seven days.
    const accepted = this.s.now();
    const followup = new Date(accepted.getTime() + FOLLOWUP_DAYS * 86_400_000).toISOString();
    this.s.mutate(runId, (r) => { r.status = 'completed'; r.acceptedAt = accepted.toISOString(); r.followupUntil = followup; r.blocker = null; this.timers.closeTimers(r); });
    this.s.log(runId, 'run.accepted', 'Đã nghiệm thu; bắt đầu cửa sổ theo dõi 7 ngày.');
    return this.s.run(runId);
  }

  /** A person found the delivery lacking. This is rework, not a new task, so the cost stays attached. */
  rejectAcceptance(runId: string, reason: string): Run {
    const run = this.s.run(runId);
    if (run.status !== 'awaiting_acceptance') throw new HttpError(409, 'Run không ở bước nghiệm thu.');
    this.s.mutate(runId, (r) => { r.status = 'blocked'; r.blocker = `Từ chối nghiệm thu: ${reason}`; });
    this.s.log(runId, 'run.rejected', `Từ chối nghiệm thu: ${reason}`);
    return this.s.run(runId);
  }
}
