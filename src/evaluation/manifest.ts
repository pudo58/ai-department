import { createHash } from 'node:crypto';
import { canonicalJson } from '../core/contract.js';
import { mulberry32, shuffled } from './stats.js';
import { ARMS, type Arm, type Assignment, type EvaluationManifest, type EvaluationTask, type M0aManifest, type M0bManifest, type Registration } from './types.js';

export const manifestHash = (manifest: EvaluationManifest): string => createHash('sha256').update(canonicalJson(manifest)).digest('hex');

/** The registration freezes protocol, seed, cases and thresholds before any run exists. */
export function register(manifest: EvaluationManifest, now = new Date()): Registration {
  return { algorithm: 'sha256', manifestHash: manifestHash(manifest), registeredAt: now.toISOString() };
}
export const matchesRegistration = (manifest: EvaluationManifest, registration: Registration): boolean =>
  registration.algorithm === 'sha256' && registration.manifestHash === manifestHash(manifest);

/** Reviewer model per variant: same-model reuses the author's model, cross-model uses the other one. */
export function reviewerModel(authorModel: string, models: readonly [string, string], variant: 'same-model-new-session' | 'cross-model-new-session'): string {
  if (variant === 'same-model-new-session') return authorModel;
  return authorModel === models[0] ? models[1] : models[0];
}

export function validateM0a(m: M0aManifest): string[] {
  const problems: string[] = [];
  const count = (kind: string) => m.cases.filter((c) => c.truth.kind === kind).length;
  if (m.cases.length !== 24 || count('clean') !== 12 || count('behavior') !== 6 || count('design') !== 6) problems.push('M0a cần 24 case: 12 clean, 6 behavior, 6 design.');
  if (new Set(m.cases.map((c) => c.caseId)).size !== m.cases.length) problems.push('caseId bị trùng.');
  if (m.models[0] === m.models[1]) problems.push('Hai model phải khác nhau.');
  const authors = m.models.map((model) => m.cases.filter((c) => c.authorModel === model).length);
  if (m.cases.some((c) => !m.models.includes(c.authorModel))) problems.push('authorModel phải là một trong hai model của thử nghiệm.');
  else if (Math.abs(authors[0]! - authors[1]!) > 2) problems.push(`Nguồn candidate không cân bằng giữa hai model (${authors.join(' vs ')}).`);
  for (const kind of ['clean', 'behavior', 'design'] as const) {
    const per = m.models.map((model) => m.cases.filter((c) => c.truth.kind === kind && c.authorModel === model).length);
    if (Math.abs(per[0]! - per[1]!) > 1) problems.push(`Nhóm ${kind} không cân bằng nguồn candidate (${per.join(' vs ')}).`);
  }
  for (const c of m.cases) {
    if (c.truth.kind !== 'clean' && !c.truth.findings.length) problems.push(`${c.caseId}: case lỗi cần ít nhất một finding chuẩn.`);
    if (c.truth.kind === 'clean' && c.truth.findings.length) problems.push(`${c.caseId}: case clean không được có finding chuẩn.`);
    if (m.provenance === 'human-attested' && !c.truth.attestation) problems.push(`${c.caseId}: thiếu xác nhận nhãn độc lập.`);
    if (c.truth.attestation && c.truth.attestation.independentOfReviewer !== true) problems.push(`${c.caseId}: nhãn không độc lập với reviewer.`);
  }
  if (m.repetitions !== 2) problems.push('M0a chạy mỗi cấu hình hai lần.');
  if (m.variants.length !== 2) problems.push('Cần đủ hai biến thể: cùng model và khác model, phiên mới.');
  return problems;
}

export function validateM0b(m: M0bManifest): string[] {
  const problems: string[] = [];
  const easy = m.tasks.filter((t) => t.stratum === 'easy').length, hard = m.tasks.filter((t) => t.stratum === 'hard').length;
  if (m.tasks.length !== 8 || easy !== 4 || hard !== 4) problems.push('M0b cần 8 task: 4 easy và 4 hard, phân nhóm trước khi chạy.');
  if (new Set(m.tasks.map((t) => t.id)).size !== m.tasks.length) problems.push('Task id bị trùng.');
  if (m.arms.length !== ARMS.length || ARMS.some((a) => !m.arms.includes(a))) problems.push('Cần đủ ba nhánh: native-full, harness-single, harness-team.');
  const expected = m.tasks.length * m.arms.length * m.repetitions;
  if (m.assignments.length !== expected) problems.push(`Cần ${expected} assignment, hiện có ${m.assignments.length}.`);
  for (const task of m.tasks) for (const arm of m.arms) {
    const n = m.assignments.filter((a) => a.taskId === task.id && a.arm === arm).length;
    if (n !== m.repetitions) problems.push(`${task.id}/${arm}: cần ${m.repetitions} lần, có ${n}.`);
  }
  if ((m.settings.harnessSingleSubagents as boolean) !== false) problems.push('Harness-Single không được dùng subagent.');
  const weights = Object.values(m.settings.targetWeights);
  if (Math.abs(weights.reduce((a, b) => a + b, 0) - 1) > 1e-9) problems.push('targetWeights phải có tổng bằng 1.');
  if (m.provenance === 'human-attested' && m.tasks.some((t) => !t.source?.attestation)) problems.push('Task thật cần xác nhận evaluator độc lập.');
  if (m.settings.nativeFeatures !== 'all-supported') problems.push('Native Full phải được dùng đủ tính năng hỗ trợ.');
  return problems;
}

/** Deterministic, balanced assignment: every task×arm gets every repetition; run order is shuffled by the registered seed. */
export function createAssignments(tasks: readonly EvaluationTask[], arms: readonly Arm[], repetitions: number, seed: number): Assignment[] {
  const all: Assignment[] = [];
  for (const task of tasks) for (const arm of arms) for (let rep = 1; rep <= repetitions; rep++) all.push({ id: `${task.id}:${arm}:${rep}`, taskId: task.id, arm, repetition: rep });
  return shuffled(all, mulberry32(seed));
}
