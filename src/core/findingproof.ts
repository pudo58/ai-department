import type { Artifact, CheckResult, Finding, Run } from '../shared/types.js';
import type { FindingProof, RegressionRef } from '../shared/regression.js';
import { policyOf } from './policy.js';
import { readFindingReplays, scenarioHash } from './reproduction.js';
import { latestChecks } from './qualityevidence.js';
import { regressionTargets } from './regression.js';
import { normalizeTestId } from './testids.js';

/**
 * The ladder the report and the page show for each finding. Only `proven_fixed` means the runner demonstrated the repair:
 * the same scenario failed before and passes after, and a regression test (when the stack can host one) did the same.
 */
export function findingProofs(run: Run, findings: readonly Finding[], artifacts: readonly Artifact[]): FindingProof[] {
  const replays = readFindingReplays(run, artifacts);
  return findings.filter(f => f.contractVersion === run.contract.version).map((f): FindingProof => {
    const hash = f.reproduction ? scenarioHash(f.reproduction) : undefined;
    const mine = replays.filter(r => r.findingId === f.id && r.scenarioHash === hash);
    const first = mine.find(r => r.checkpoint === f.checkpoint), latest = mine.at(-1);
    const base = { findingId: f.id, title: f.title, severity: f.severity, replayBefore: first?.status, replayAfter: latest && latest !== first ? latest.status : undefined };
    const r = f.resolution;
    if (f.status === 'resolved' && r?.kind === 'verified_fix') {
      return { ...base, level: 'proven_fixed', regression: r.regression ?? 'none', regressionTestId: r.regressionTestId, regressionBefore: r.before?.regression, regressionAfter: r.after?.regression,
        note: r.regression === 'unsupported' ? 'Phản ví dụ thất bại trước khi sửa và đạt sau khi sửa; chưa có test regression trong project vì stack hoặc runner chưa hỗ trợ.' : 'Phản ví dụ và test regression đều thất bại trước khi sửa và đạt sau khi sửa.' };
    }
    if (f.status === 'resolved') return { ...base, level: 'manual_decision', note: `Đóng bằng quyết định review thủ công: ${r?.reason ?? 'không ghi lý do'}. Đây không phải bằng chứng đã sửa do runner xác minh.` };
    if (latest?.status === 'reproduced') return { ...base, level: 'reproduced', note: 'Sai khác được tái hiện bằng runner; chưa chứng minh là đã sửa.' };
    if (latest?.status === 'not_reproduced') return { ...base, level: 'not_reproduced', note: 'Replay hiện không thấy sai khác, nhưng chưa có bằng chứng trước và sau cho cùng kịch bản nên chưa tính là đã sửa.' };
    return { ...base, level: 'unverified', note: f.reproductionLimitation ?? 'Chưa có phản ví dụ chạy được; finding chỉ là nghi ngờ của Verifier.' };
  });
}

/**
 * v4 reasons that stop acceptance beyond the checks themselves. A warning that is ticked never passes these:
 * the Verifier's verdict for this very checkpoint, an edited regression test, and a "fixed" finding the runner can still reproduce.
 */
/** Chạy tiếp cannot change an abstention, so the two ways out are named: give the Verifier something to check against, or accept without it. */
export const ABSTAIN_NEXT_STEP = ' Thường do hợp đồng chưa có ví dụ cụ thể để đối chiếu. Cách 1: bấm “Sửa hợp đồng”, thêm câu mẫu kèm kết quả mong đợi ở ô “Ví dụ đúng/sai”, rồi duyệt lại. Cách 2 (chấp nhận không có kiểm chứng độc lập): bấm “Chuyển chế độ” và chọn Single.';

export function evidenceBlockers(run: Run, input: { verdict: { decision: string } | null; findings: readonly Finding[]; artifacts: readonly Artifact[]; regressions: readonly RegressionRef[]; checks: readonly CheckResult[] }): string[] {
  const policy = policyOf(run);
  if (!policy.strict) return [];
  const reasons: string[] = [];
  if (policy.verdictRequired && (run.mode === 'verify' || run.mode === 'compare')) {
    const v = input.verdict;
    if (!v) reasons.push('Chưa có kết luận Verifier cho đúng checkpoint hiện tại.');
    else if (v.decision === 'skipped') reasons.push('Verifier bị bỏ qua (hết ngân sách kiểm chứng cuối), nên chưa có kiểm chứng độc lập cho checkpoint hiện tại.');
    else if (v.decision === 'unparsed') reasons.push('Kết luận của Verifier không đọc được, nên chưa có kiểm chứng độc lập cho checkpoint hiện tại.');
    else if (v.decision === 'abstain') reasons.push(`Verifier từ chối kết luận (abstain) cho checkpoint hiện tại; chưa có kiểm chứng độc lập.${ABSTAIN_NEXT_STEP}`);
  }
  for (const ref of input.regressions.filter(r => !r.intact)) reasons.push(`Test regression ${ref.path} không còn khớp hash ghi trong chính nó: đã bị sửa. Đổi hoặc xóa regression chỉ qua diff có duyệt.`);
  // An intact file proves nothing by itself: each regression needs its own passing result on this checkpoint and configuration.
  const live = latestChecks(run, input.checks);
  for (const t of regressionTargets(run, input.regressions, input.artifacts).filter(t => t.intact)) {
    if (!t.recipeId) { reasons.push(`Test regression ${t.path} được tạo cho check “${t.madeFor}”, nhưng cấu hình hiện tại không còn check đó và không có check Vitest có report nào để chạy nó. Thêm lại check “${t.madeFor}” hoặc chọn check chạy regression ở Sửa dự án → regressionRecipe, rồi bấm “Chạy lại kiểm tra”.`); continue; }
    const outcome = live.find(c => c.recipeId === t.recipeId)?.outcomes?.find(o => normalizeTestId(o.id) === normalizeTestId(t.testId));
    if (outcome?.status === 'passed') continue;
    const moved = t.recipeId !== t.madeFor ? ` (tạo cho check “${t.madeFor}”, nay chạy bằng check “${t.recipeId}”)` : '';
    reasons.push(`Test regression ${t.path}${moved} chưa có kết quả đạt trên checkpoint và cấu hình hiện tại: ${outcome?.status === 'failed' ? 'test thất bại' : 'check chưa chạy hoặc không nhận file này'}.`);
  }
  const replays = readFindingReplays(run, input.artifacts);
  for (const f of input.findings.filter(f => f.contractVersion === run.contract.version && f.status === 'resolved' && f.resolution?.kind === 'verified_fix' && f.reproduction)) {
    const now = replays.filter(r => r.findingId === f.id && r.checkpoint === run.checkpoint && r.scenarioHash === scenarioHash(f.reproduction!)).at(-1);
    if (now?.status === 'reproduced') reasons.push(`Finding "${f.title}" đã đánh dấu sửa xong nhưng phản ví dụ còn tái hiện ở checkpoint hiện tại.`);
  }
  return reasons;
}
