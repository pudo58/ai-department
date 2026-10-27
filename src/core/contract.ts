import { testPlanFindings, validateTestPlan } from './testplan.js';
import type { DesignBinding } from '../shared/design.js';
import { createHash } from 'node:crypto';
import type { ContractReview, TaskContract } from '../shared/types.js';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Recursively sorted JSON, so the same contract always hashes the same regardless of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Approval fields are excluded: they describe the decision, not the content being decided on. */
export function hashContract(contract: TaskContract): string {
  const { approvedHash: _hash, approvedAt: _at, ...content } = contract;
  return sha256(canonicalJson(content));
}

export function initialContract(requirementText: string): TaskContract {
  return {
    version: 1,
    requirements: [{ id: 'R-1', text: requirementText.trim(), required: true, manual: false }],
    acceptanceExamples: [], interfaces: [], assumptions: [], scope: [],
  };
}

/** Structural omissions for a person to review, not a claim of semantic correctness. Never normalizes stored content. */
export function reviewContract(contract: TaskContract): ContractReview {
  const warnings: ContractReview['warnings'] = [];
  if (!contract.requirements.some((r) => (r.kind ?? 'expected') === 'expected')) warnings.push({ code: 'missing_expected', message: 'Chưa có tiêu chí về hành vi mong muốn.' });
  if (!contract.requirements.some((r) => r.kind === 'forbidden')) warnings.push({ code: 'missing_forbidden', message: 'Chưa có tiêu chí về hành vi không được xảy ra.' });
  if (!contract.acceptanceExamples.some((text) => text.trim())) warnings.push({ code: 'missing_examples', message: 'Chưa có ví dụ nghiệm thu cụ thể.' });
  if (contract.assumptions.some((text) => text.trim())) warnings.push({ code: 'assumptions_present', message: 'Hợp đồng có giả định cần bạn xác nhận.' });
  // Said here, while it costs nothing: with no case for an Author to write a test for, Verify has no automated evidence and its Verifier tends to decline to conclude at the very end.
  if (contract.testPlan && !contract.testPlan.cases.some((c) => c.method === 'automated')) warnings.push({ code: 'no_automated_case', message: 'Kế hoạch ca không có ca tự động nào, nên Verify không có test để chạy và Verifier có thể từ chối kết luận ở cuối. Thêm ví dụ cụ thể và đánh dấu yêu cầu là tự động, hoặc chuyển sang chế độ Single.' });
  // Form-only findings in the test plan: the person approves knowing about them, rather than being locked out by them.
  const advisories = testPlanFindings(contract).advisories;
  advisories.slice(0, 12).forEach((message) => warnings.push({ code: 'plan_advisory', message: `Kế hoạch ca: ${message}` }));
  if (advisories.length > 12) warnings.push({ code: 'plan_advisory', message: `Kế hoạch ca còn ${advisories.length - 12} lưu ý về hình thức nữa.` });
  return { contractHash: hashContract(contract), contractVersion: contract.version, warnings, problems: validateContract(contract) };
}

export function validateContract(contract: TaskContract): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  if (!contract.requirements.some((r) => r.required)) problems.push('Cần ít nhất một tiêu chí bắt buộc.');
  for (const r of contract.requirements) {
    if (!r.text.trim()) problems.push(`Tiêu chí ${r.id} đang trống.`);
    if (!/^R-[A-Za-z0-9_-]+$/.test(r.id)) problems.push(`Mã tiêu chí ${r.id} không hợp lệ (dạng R-xxx).`);
    if (ids.has(r.id)) problems.push(`Mã tiêu chí ${r.id} bị trùng.`);
    if (r.kind !== undefined && r.kind !== 'expected' && r.kind !== 'forbidden') problems.push(`Loại tiêu chí ${r.id} không hợp lệ.`);
    ids.add(r.id);
  }
  return [...problems, ...validateTestPlan(contract)];
}

export function approveContract(contract: TaskContract, now = new Date()): TaskContract {
  const problems = validateContract(contract);
  if (problems.length) throw new Error(problems.join(' '));
  return { ...contract, approvedHash: hashContract(contract), approvedAt: now.toISOString() };
}

export const isApproved = (contract: TaskContract): boolean => !!contract.approvedHash && contract.approvedHash === hashContract(contract);

/** Any content change bumps the version and drops the approval; all evidence tied to older versions goes stale. */
export function reviseContract(current: TaskContract, next: Omit<TaskContract, 'version' | 'approvedHash' | 'approvedAt'>): TaskContract {
  // Approval state and version belong to the decision, never to the proposed content.
  // The design binding is the server's to write: a proposal (a Planner's output, a form) can neither set nor drop it.
  const { approvedHash: _hash, approvedAt: _at, version: _version, design: _design, ...content } = next as TaskContract;
  const draft: TaskContract = { ...content, version: current.version, ...(current.design ? { design: current.design } : {}) };
  if (hashContract(draft) === hashContract(current)) return current;
  return { ...draft, version: current.version + 1 };
}

/** The only way a design binding changes: an explicit choice that bumps the version and drops the approval, like any other contract change. */
export function bindDesign(current: TaskContract, binding: DesignBinding | undefined): TaskContract {
  const { approvedHash: _hash, approvedAt: _at, design: _old, ...content } = current;
  const draft: TaskContract = { ...content, ...(binding ? { design: binding } : {}), version: current.version };
  if (hashContract(draft) === hashContract(current)) return current;
  return { ...draft, version: current.version + 1 };
}

export const isCurrentEvidence = (item: { contractVersion: number; valid?: boolean }, contract: TaskContract): boolean =>
  item.contractVersion === contract.version && item.valid !== false;
