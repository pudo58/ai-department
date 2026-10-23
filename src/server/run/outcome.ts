import type { RunDetail } from '../../shared/types.js';
import { budgetState } from '../../core/budget.js';
import { buildMatrix, evaluateCompletion } from '../../core/completion.js';
import type { RunServices } from './services.js';
import type { ScopePolicy } from './scope.js';

/** Where a run stands: the read model the UI shows and the moves into awaiting_acceptance, blocked or failed. */
export class RunOutcome {
  constructor(private readonly s: RunServices, private readonly scope: ScopePolicy) {}

  detail(runId: string): RunDetail {
    const run = this.s.run(runId);
    const attempts = this.s.store.attempts.list(runId);
    const checks = this.s.store.checks.list(runId);
    const findings = this.s.store.findings.list(runId);
    const budget = budgetState(run, attempts);
    return {
      run, attempts, artifacts: this.s.store.artifacts.list(runId), findings, checks, events: this.s.store.events(runId),
      matrix: buildMatrix(run, checks), completion: evaluateCompletion(run, checks, findings, budget), budget,
      pendingPaths: this.scope.pendingPaths(runId), runningCheck: this.s.runningChecks.get(runId),
    };
  }

  finish(runId: string): void {
    const detail = this.detail(runId);
    if (detail.completion.ready) {
      this.s.mutate(runId, (r) => { r.status = 'awaiting_acceptance'; r.blocker = null; });
      this.s.log(runId, 'awaiting_acceptance', 'Đủ bằng chứng; chờ nghiệm thu.');
    } else this.park(runId, 'blocked', detail.completion.reasons.join(' '));
  }

  park(runId: string, status: 'blocked' | 'failed', blocker: string): void {
    this.s.mutate(runId, (r) => { r.status = status; r.blocker = blocker; });
    this.s.log(runId, `run.${status}`, blocker);
  }

  refreshAcceptanceState(runId: string): void {
    const run = this.s.run(runId);
    if (!['blocked', 'awaiting_acceptance'].includes(run.status) || !run.checkpoint) return;
    const detail = this.detail(runId);
    if (detail.completion.ready && run.status === 'blocked') this.s.mutate(runId, (r) => { r.status = 'awaiting_acceptance'; r.blocker = null; });
    else if (!detail.completion.ready && run.status === 'awaiting_acceptance') this.s.mutate(runId, (r) => { r.status = 'blocked'; r.blocker = detail.completion.reasons.join(' '); });
  }
}
