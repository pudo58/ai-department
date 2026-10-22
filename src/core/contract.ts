import { createHash } from 'node:crypto';
import type { TaskContract } from '../shared/types.js';

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

export function validateContract(contract: TaskContract): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  if (!contract.requirements.some((r) => r.required)) problems.push('Cần ít nhất một tiêu chí bắt buộc.');
  for (const r of contract.requirements) {
    if (!r.text.trim()) problems.push(`Tiêu chí ${r.id} đang trống.`);
    if (!/^R-[A-Za-z0-9_-]+$/.test(r.id)) problems.push(`Mã tiêu chí ${r.id} không hợp lệ (dạng R-xxx).`);
    if (ids.has(r.id)) problems.push(`Mã tiêu chí ${r.id} bị trùng.`);
    ids.add(r.id);
  }
  return problems;
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
  const { approvedHash: _hash, approvedAt: _at, version: _version, ...content } = next as TaskContract;
  const draft: TaskContract = { ...content, version: current.version };
  if (hashContract(draft) === hashContract(current)) return current;
  return { ...draft, version: current.version + 1 };
}

export const isCurrentEvidence = (item: { contractVersion: number; valid?: boolean }, contract: TaskContract): boolean =>
  item.contractVersion === contract.version && item.valid !== false;
