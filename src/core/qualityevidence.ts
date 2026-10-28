import type { Artifact, CheckResult, Run } from '../shared/types.js';
import type { QualityDetail, TestManifest, MutationResult, MutationCapability } from '../shared/quality.js';
import { canonicalJson, hashContract, sha256 } from './contract.js';
import { normalizeTestId, manifestFindings, testPlanFindings, StoredManifestSchema } from './testplan.js';
import { policyOf } from './policy.js';
import { extractRequirementIds } from './checks.js';

export const recipeHash = (run: Run): string => sha256(canonicalJson({ checks: run.configSnapshot.checks, mutationRoot: run.configSnapshot.mutationRoot, executionMode: run.configSnapshot.executionMode, runnerImage: run.configSnapshot.runnerImage }));
export const deepQuality = (run: Run): boolean => run.mode === 'verify' && !!run.qualityPolicyVersion;

/**
 * Verify ties each test to a case through the report a check writes. With no check that writes one the Author can never produce a valid
 * manifest, so this is known before any agent is called, and only a change to the project's checks can fix it.
 */
export function verifyNeedsReport(run: Run): string | undefined {
  if (!deepQuality(run) || run.configSnapshot.checks.some((c) => c.reportPath)) return undefined;
  const names = run.configSnapshot.checks.map((c) => `“${c.id}”`).join(', ');
  return `Dự án chưa có check nào xuất báo cáo test${names ? ` (hiện có ${names}, đều chỉ dựa vào mã thoát)` : ''}. Verify cần báo cáo của test runner để gắn từng test vào từng ca, nên Author không thể viết manifest hợp lệ. Vào Sửa dự án → Checks → “Gợi ý từ stack”, chọn check có report (hoặc thêm đường dẫn report cho check test), lưu lại, bấm “Duyệt policy” ở trang Dự án, rồi chạy tiếp.`;
}

export function latestChecks(run: Run, checks: readonly CheckResult[]): CheckResult[] {
  const latest = new Map<string, CheckResult>();
  for (const c of checks) if (c.valid && c.checkpoint === run.checkpoint && c.contractVersion === run.contract.version
    && (c.slot === undefined ? !deepQuality(run) : c.slot === run.selectedSlot)
    && (c.configHash === undefined ? !deepQuality(run) : c.configHash === recipeHash(run))) latest.set(c.recipeId, c);
  return [...latest.values()];
}
export function readManifest(run: Run, artifacts: readonly Artifact[]): { manifest: TestManifest; hash: string } | null {
  const a = artifacts.filter((a) => a.kind === 'acceptance' && a.title === 'Test manifest' && a.valid && a.contractVersion === run.contract.version).at(-1);
  if (!a) return null;
  try {
    if (a.hash !== sha256(a.content)) return null;
    const manifest = StoredManifestSchema.parse(JSON.parse(a.content));
    if (manifest.contractHash !== hashContract(run.contract) || manifest.slot !== run.selectedSlot || manifest.contractVersion !== run.contract.version || !Array.isArray(manifest.entries)) return null;
    if (manifest.schemaVersion === 2 && manifest.entries.some(e => !e.identity)) return null;
    return { manifest, hash: a.hash };
  } catch { return null; }
}
/** `regression` are tests a repair or an earlier run left in the project: they must run and pass like any locked test. */
export function lockedIds(run: Run, artifacts: readonly Artifact[], recipeId: string, regression: readonly { recipeId: string; testId: string }[] = []): string[] {
  const m = readManifest(run, artifacts)?.manifest;
  const base = m ? [...m.entries.filter((e) => e.recipeId === recipeId && run.contract.testPlan?.cases.some(c => c.id === e.caseId && c.required)).map((e) => normalizeTestId(e.testId)), ...(m.observed?.filter((r) => r.recipeId === recipeId).flatMap((r) => r.testIds) ?? [])] : [];
  return [...new Set([...base, ...regression.filter(r => r.recipeId === recipeId).map(r => normalizeTestId(r.testId))])];
}
export function readMutation(run: Run, artifacts: readonly Artifact[]): MutationResult | null {
  for (const a of [...artifacts].reverse()) {
    if (a.title !== 'Mutation result' || a.hash !== sha256(a.content) || !a.valid || a.checkpoint !== run.checkpoint || a.contractVersion !== run.contract.version) continue;
    try {
      const r = JSON.parse(a.content) as MutationResult;
      if (r.schemaVersion === 1 && r.slot === run.selectedSlot && r.configHash === recipeHash(run) && r.checkpoint === run.checkpoint && r.contractVersion === run.contract.version && ['in_progress', 'completed', 'incomplete', 'error'].includes(r.status) && r.counts && ['killed', 'survived', 'no_coverage', 'timeout', 'errors', 'pending'].every(k => Number.isFinite(r.counts[k as keyof typeof r.counts]) && r.counts[k as keyof typeof r.counts] >= 0) && Array.isArray(r.mutants) && r.capability) return r;
    } catch { /* malformed artifact is not evidence */ }
  }
  return null;
}
export function qualityDetail(run: Run, checks: readonly CheckResult[], artifacts: readonly Artifact[]): QualityDetail {
  const enabled = deepQuality(run), found = readManifest(run, artifacts), live = latestChecks(run, checks), policy = policyOf(run);
  const m = found?.manifest;
  const plan = enabled ? testPlanFindings(run.contract, true, policy.reasoning, policy.strict) : { blocking: [], advisories: [] };
  const mf = m && m.source === 'author' ? manifestFindings(run.contract, m.entries, run.configSnapshot.checks, m.entries.map((e) => e.path), { derived: m.derived, strict: policy.strict }) : { blocking: [], advisories: [] };
  const problems = enabled ? [...plan.blocking, ...(policy.structured && run.contract.testPlan?.schemaVersion !== 2 ? ['Chính sách v2+ cần kế hoạch ca có căn cứ v2.'] : []), ...(!m || m.source !== 'author' ? ['Thiếu manifest test do Author khóa trước Developer.'] : mf.blocking)] : [];
  const manifestAdvisories = [...new Set([...(m?.advisories ?? []), ...mf.advisories])];
  const mutation = readMutation(run, artifacts);
  let capability: MutationCapability = mutation?.capability ?? { status: 'unsupported', reason: 'Chưa nhận diện khả năng mutation trên checkpoint này.' };
  if (!mutation) {
    const a = artifacts.filter((a) => a.title === 'Mutation capability' && a.valid && a.contractVersion === run.contract.version && a.checkpoint === run.checkpoint).at(-1);
    try { if (a) { const stored = JSON.parse(a.content); if (stored.configHash === recipeHash(run)) capability = stored.capability; } } catch { /* unknown */ }
  }
  return {
    enabled, plan: run.contract.testPlan, manifestHash: found?.hash ?? null, manifestProblems: problems, manifestAdvisories, planAdvisories: plan.advisories, capability, mutation,
    testMs: live.reduce((n, c) => n + c.attempts.reduce((n, a) => n + a.durationMs, 0), 0),
    cases: enabled ? (run.contract.testPlan?.cases ?? []).map((c) => {
      const entries = m?.entries.filter((e) => e.caseId === c.id) ?? [], reasons: string[] = [];
      let status: QualityDetail['cases'][number]['status'] = c.method === 'manual' ? 'manual_pending' : 'passed';
      if (c.method === 'automated') {
        if (!entries.length || problems.length) { status = 'missing'; reasons.push(...(problems.length ? problems : ['Chưa có test dự kiến.'])); }
        for (const e of entries) {
          const check = live.find((r) => r.recipeId === e.recipeId && r.manifestHash === found?.hash);
          const id = normalizeTestId(e.testId), outcome = check?.outcomes?.find((o) => normalizeTestId(o.id) === id);
          if (outcome?.status === 'failed') { status = 'failed'; reasons.push(`${e.recipeId}: test thất bại.`); }
          else if (!check || check.status !== 'passed' || check.quarantined || !outcome || outcome.status !== 'passed' || check.missingTestIds.includes(id)) {
            if (status !== 'failed') status = 'missing';
            reasons.push(`${e.recipeId}: test chưa chạy đạt hoặc report không hợp lệ/skip/flaky/quarantine.`);
          }
        }
      }
      const stepIds = (c.steps ?? []).map((s) => s.id).filter((id): id is string => !!id), bound = new Set(entries.flatMap((e) => (e.assertions ?? []).map((a) => a.stepId)));
      return { caseId: c.id, requirementIds: c.requirementIds, required: c.required, method: c.method, status, tests: entries.map((e) => `${e.recipeId}: ${e.testId}`), reasons,
        ...(c.method === 'manual' ? { supportingTests: live.filter(check => check.status === 'passed' && !check.quarantined).flatMap(check => check.testIds.filter(id => extractRequirementIds(id).some(r => c.requirementIds.includes(r))).map(id => `${check.recipeId}: ${id}`)) } : {}),
        ...(c.method === 'automated' && stepIds.length ? { stepsLinked: { linked: stepIds.filter((id) => bound.has(id)).length, total: stepIds.length } } : {}),
        checkpoint: run.checkpoint, slot: run.selectedSlot, contractVersion: run.contract.version, manifestHash: found?.hash ?? null };
    }) : [],
  };
}
