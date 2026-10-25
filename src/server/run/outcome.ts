import { qualityDetail, deepQuality } from '../../core/qualityevidence.js';
import { readTestPlanReview, validateTestPlan } from '../../core/testplan.js';
import type { RunDetail } from '../../shared/types.js';
import { budgetState } from '../../core/budget.js';
import { buildMatrix, evaluateCompletion } from '../../core/completion.js';
import { reviewContract } from '../../core/contract.js';
import { pendingTestRepair } from '../../core/recovery.js';
import { pendingAuthorDraft } from '../../core/authordraft.js';
import { executionMetrics } from '../../core/execution.js';
import { readEnvironment } from '../../core/environment.js';
import {readFindingReplays} from '../../core/reproduction.js';
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
    const artifacts = this.s.store.artifacts.list(runId);
    const quality = qualityDetail(run, checks, artifacts);
    const completion = evaluateCompletion(run, checks, findings, budget);
    if (quality.enabled) {
      completion.reasons.push(...quality.manifestProblems);
      for (const c of quality.cases.filter(c => c.required && c.method === 'automated' && c.status !== 'passed')) completion.reasons.push(`${c.caseId}: ca bắt buộc ${c.status === 'failed' ? 'thất bại' : 'chưa có bằng chứng đạt'}.`);
      completion.ready = completion.reasons.length === 0;
    }
    const contractReview = reviewContract(run.contract);
    if ((run.qualityPolicyVersion??0) >= 2 && run.contract.testPlan?.schemaVersion !== 2) contractReview.problems.push('Chính sách v2+ cần kế hoạch ca có căn cứ v2.');
    if(run.qualityPolicyVersion===3&&run.contract.testPlan)contractReview.problems.push(...validateTestPlan(run.contract,true,true).filter(p=>!contractReview.problems.includes(p)));
    if (deepQuality(run) && !run.contract.testPlan) contractReview.problems.push(...validateTestPlan(run.contract, true));
    return {
      planReview: readTestPlanReview(run.contract, artifacts, contractReview.contractHash),
      execution:executionMetrics(run,attempts,this.s.now().getTime()), authorDraft:pendingAuthorDraft(run,artifacts),
      environment:readEnvironment(run,artifacts),
      findingReplays:readFindingReplays(run,artifacts),
      quality, contractReview, testRepair: pendingTestRepair(run, artifacts),
      run, attempts, artifacts: this.s.store.artifacts.list(runId), findings, checks, events: this.s.store.events(runId),
      matrix: buildMatrix(run, checks), completion, budget,
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
