import { latestChecks } from './qualityevidence.js';
import type { BudgetState, CheckResult, CompletionState, Finding, MatrixRow, Run } from '../shared/types.js';
import { ranNoTests } from './checks.js';
import { isApproved } from './contract.js';
import { blocksCompletion } from './findings.js';
import { policyOf } from './policy.js';

/** Evidence must belong to the live checkpoint and contract version, and come from an unquarantined passed check. */
export function currentChecks(run: Run, checks: readonly CheckResult[]): CheckResult[] {
  return latestChecks(run, checks);
}

export function buildMatrix(run: Run, checks: readonly CheckResult[]): MatrixRow[] {
  const live = currentChecks(run, checks);
  return run.contract.requirements.map((req) => {
    const covering = live.filter((c) => c.requirementIds.includes(req.id));
    const good = covering.filter((c) => c.status === 'passed' && !c.quarantined);
    const evidence = good.map((c) => `${c.recipeId} @ ${c.checkpoint.slice(0, 8)}`);
    let status: MatrixRow['status'];
    if (req.manual) status = 'manual_pending';
    else if (good.length) status = 'verified';
    else if (covering.some((c) => c.status === 'failed')) status = 'failed';
    else status = 'unverified';
    return { requirementId: req.id, text: req.text, required: req.required, manual: req.manual, kind: req.kind ?? 'expected', status, evidence };
  });
}

/** What a person does about an open finding under the v4 policy, where nothing but the runner's proof or their own reasons closes it. */
export const FINDING_NEXT_STEP = ' Việc cần làm (tab Kiểm chứng): nếu bạn đã tự thử và thấy đúng, bấm “Đóng bằng review thủ công…” và ghi lý do; nếu chưa sửa, bấm “Xác nhận bằng review thủ công…” rồi “Sửa … finding đã xác nhận”.';

export function evaluateCompletion(run: Run, checks: readonly CheckResult[], findings: readonly Finding[], budget: BudgetState): CompletionState {
  const reasons: string[] = [];
  if (run.provider === 'fake') reasons.push('Run mô phỏng: không có bằng chứng thật, không thể nghiệm thu.');
  if (!isApproved(run.contract)) reasons.push('Hợp đồng hiện tại chưa được duyệt.');
  if (!run.checkpoint) reasons.push('Chưa có checkpoint được chấp nhận.');
  const live = currentChecks(run, checks);
  for (const recipe of run.configSnapshot.checks.filter((r) => r.required)) {
    const mine = live.filter((c) => c.recipeId === recipe.id);
    const latest = mine[mine.length - 1];
    if (!latest) reasons.push(`Check bắt buộc "${recipe.id}" chưa chạy trên checkpoint hiện tại.`);
    // Results recorded before zero-test reports counted as incomplete still say "passed"; they prove nothing either.
    else if (recipe.reportPath && latest.status === 'passed' && ranNoTests(latest)) reasons.push(`Check "${recipe.id}" không chạy test nào: lệnh check hoặc mẫu file không khớp test của repo.`);
    else if (latest.status === 'incomplete') reasons.push(ranNoTests(latest) ? `Check "${recipe.id}" không chạy test nào: lệnh check hoặc mẫu file không khớp test của repo.` : `Check "${recipe.id}" chưa hoàn tất (thiếu report/timeout).`);
    else if (latest.status === 'failed') reasons.push(`Check "${recipe.id}" đang fail.`);
    else if (latest.status === 'flaky' && !latest.quarantined) reasons.push(`Check "${recipe.id}" flaky, cần quarantine có lý do hoặc sửa.`);
    else if (latest.missingTestIds.length) reasons.push(`Check "${recipe.id}" thiếu ${latest.missingTestIds.length} acceptance test đã khóa.`);
  }
  const unverified = buildMatrix(run, checks).filter((row) => row.required && !row.manual && row.status !== 'verified').map((row) => row.requirementId);
  if (unverified.length) {
    // When no current test carries any [R-x] tag, resuming cannot change the outcome; say what would.
    const tagged = live.some((c) => c.requirementIds.length > 0);
    reasons.push(tagged
      ? `Yêu cầu chưa được xác minh: ${unverified.join(', ')}.`
      : `${unverified.length} yêu cầu chưa có test nào xác minh (${unverified.join(', ')}): không test nào trong lần check gần nhất chạy được và gắn thẻ [R-x]. Bấm Chạy tiếp sẽ không đổi kết quả; cần sửa check của project cho chạy đúng test, hoặc sửa hợp đồng để đánh dấu "Thủ công" các yêu cầu chỉ kiểm được bằng mắt.`);
  }
  const open = findings.filter((f) => f.contractVersion === run.contract.version && blocksCompletion(f, policyOf(run).strict));
  if (open.length) reasons.push(`${open.length} finding blocker/major chưa xử lý.${policyOf(run).strict ? FINDING_NEXT_STEP : ''}`);
  if (budget.spentUsd > budget.capUsd + 1e-9) reasons.push('Đã vượt ngân sách của task.');
  return { ready: reasons.length === 0, reasons };
}
