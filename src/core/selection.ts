import type { Slot } from '../shared/types.js';

export interface CandidateEval {
  slot: Slot;
  /** Set when the candidate violates a requirement or has a confirmed serious defect. */
  eliminatedBecause: string | null;
  changedFiles: number;
  newToolIssues: number;
  flakyChecks: number;
}
export interface Selection { slot: Slot | null; reason: string }

/**
 * Both candidates ran the same checks. Eliminate violators first, then compare objective numbers only.
 * A tie keeps the primary candidate; if both fail the task is not complete.
 */
export function selectCandidate(a: CandidateEval, b: CandidateEval): Selection {
  if (a.eliminatedBecause && b.eliminatedBecause) return { slot: null, reason: `Cả hai phương án đều trượt: A (${a.eliminatedBecause}); B (${b.eliminatedBecause}).` };
  if (a.eliminatedBecause) return { slot: 'B', reason: `A bị loại: ${a.eliminatedBecause}` };
  if (b.eliminatedBecause) return { slot: 'A', reason: `B bị loại: ${b.eliminatedBecause}` };
  for (const [key, label] of [['newToolIssues', 'ít vấn đề mới từ công cụ'], ['flakyChecks', 'ít check flaky'], ['changedFiles', 'ít file thay đổi']] as const) {
    if (a[key] !== b[key]) return { slot: a[key] < b[key] ? 'A' : 'B', reason: `Chọn phương án có ${label}.` };
  }
  return { slot: 'A', reason: 'Hai phương án tương đương theo chỉ số khách quan; giữ candidate chính.' };
}

/** Hides authorship so a trade-off reviewer sees artifacts, not model names. */
export function anonymize(text: string, names: readonly string[]): string {
  return names.filter(Boolean).reduce((out, name) => out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[model]'), text);
}
