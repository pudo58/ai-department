import { mulberry32, quantile, mean, requiredTasks } from './stats.js';
import type { Arm, EvaluationTask, HumanMinutes, M0bManifest, Stratum, TaskRecord } from './types.js';

/** Onboarding and blind grading are research overhead and are reported separately from operating effort. */
export const operatingMinutes = (m: HumanMinutes): number => m.clarification + m.approval + m.review + m.quota + m.acceptance + m.rework;

export interface ArmOutcome { assignmentId: string; accepted: boolean; costUsd: number | null; minutes: number; deviations: string[]; complete: boolean }

/**
 * Intent-to-treat: every assignment appears. A missing record, a failed run and a quota stop all count as
 * "not accepted", and their cost and effort are kept. Nothing is silently dropped.
 */
export function outcomesFor(manifest: M0bManifest, records: readonly TaskRecord[]): Map<string, ArmOutcome[]> {
  const byAssignment = new Map(records.filter((r) => r.manifestHash).map((r) => [r.assignmentId, r]));
  const result = new Map<string, ArmOutcome[]>();
  for (const a of manifest.assignments) {
    const r = byAssignment.get(a.id);
    const key = `${a.taskId}|${a.arm}`;
    const outcome: ArmOutcome = r
      ? { assignmentId: a.id, accepted: r.accepted && r.outcome === 'completed' && r.followupComplete, costUsd: r.costUsd, minutes: operatingMinutes(r.humanMinutes), deviations: r.protocolDeviations, complete: true }
      : { assignmentId: a.id, accepted: false, costUsd: null, minutes: 0, deviations: ['Thiếu bản ghi: tính là chưa hoàn thành (ITT).'], complete: false };
    (result.get(key) ?? result.set(key, []).get(key)!).push(outcome);
  }
  return result;
}

export interface ArmSummary { arm: Arm; acceptedRate: number; byStratum: Record<Stratum, number>; meanMinutes: number; meanCostUsd: number | null; missingRecords: number; deviations: number }
export interface Contrast { a: Arm; b: Arm; metric: 'acceptedRate' | 'minutes'; estimate: number; low: number; high: number; samples: number }
export interface M0bReport {
  arms: ArmSummary[]; contrasts: Contrast[];
  /** Always spelled out: a wide interval means "not enough evidence", never "no difference". */
  conclusion: string[];
  plannedTasks: number; tasksNeededForDelta: { delta: number; tasks: number } | null;
}

function taskValue(outcomes: Map<string, ArmOutcome[]>, taskId: string, arm: Arm, metric: 'acceptedRate' | 'minutes'): number {
  const runs = outcomes.get(`${taskId}|${arm}`) ?? [];
  return mean(runs.map((o) => (metric === 'acceptedRate' ? Number(o.accepted) : o.minutes)));
}

/** Stratum-weighted mean of per-task values, using the weights registered before the run. */
function weighted(values: Map<string, number>, tasks: readonly EvaluationTask[], weights: Record<Stratum, number>): number {
  let total = 0, used = 0;
  for (const stratum of ['easy', 'hard'] as const) {
    const vs = tasks.filter((t) => t.stratum === stratum).map((t) => values.get(t.id)!).filter((v) => !Number.isNaN(v));
    if (vs.length) { total += weights[stratum] * mean(vs); used += weights[stratum]; }
  }
  return used ? total / used : NaN;
}

/** Percentile bootstrap that resamples whole tasks within each stratum, preserving the paired design. */
function bootstrapContrast(manifest: M0bManifest, outcomes: Map<string, ArmOutcome[]>, a: Arm, b: Arm, metric: 'acceptedRate' | 'minutes', seed: number): Contrast {
  const random = mulberry32(seed);
  const diff = (tasks: readonly EvaluationTask[]) => {
    const va = new Map(tasks.map((t, i) => [`${i}`, taskValue(outcomes, t.id, a, metric)]));
    const vb = new Map(tasks.map((t, i) => [`${i}`, taskValue(outcomes, t.id, b, metric)]));
    const indexed = tasks.map((t, i) => ({ ...t, id: `${i}` }));
    return weighted(va, indexed, manifest.settings.targetWeights) - weighted(vb, indexed, manifest.settings.targetWeights);
  };
  const estimate = diff(manifest.tasks);
  const strata: Record<Stratum, EvaluationTask[]> = { easy: [], hard: [] };
  manifest.tasks.forEach((t) => strata[t.stratum].push(t));
  const draws: number[] = [];
  for (let i = 0; i < manifest.settings.bootstrapSamples; i++) {
    const sample = (['easy', 'hard'] as const).flatMap((s) => strata[s].map(() => strata[s][Math.floor(random() * strata[s].length)]!));
    const d = diff(sample);
    if (!Number.isNaN(d)) draws.push(d);
  }
  draws.sort((x, y) => x - y);
  return { a, b, metric, estimate, low: quantile(draws, 0.025), high: quantile(draws, 0.975), samples: draws.length };
}

export function analyzeM0b(manifest: M0bManifest, records: readonly TaskRecord[], assumptions = { discordant: 0.4, rho: 0.5, delta: 0.15 }): M0bReport {
  const outcomes = outcomesFor(manifest, records);
  const arms: ArmSummary[] = manifest.arms.map((arm) => {
    const all = manifest.tasks.flatMap((t) => outcomes.get(`${t.id}|${arm}`) ?? []);
    const rate = (stratum: Stratum) => mean(manifest.tasks.filter((t) => t.stratum === stratum).flatMap((t) => (outcomes.get(`${t.id}|${arm}`) ?? []).map((o) => Number(o.accepted))));
    const costs = all.map((o) => o.costUsd);
    return {
      arm, acceptedRate: mean(all.map((o) => Number(o.accepted))), byStratum: { easy: rate('easy'), hard: rate('hard') },
      meanMinutes: mean(all.map((o) => o.minutes)), meanCostUsd: costs.some((c) => c === null) ? null : mean(costs as number[]),
      missingRecords: all.filter((o) => !o.complete).length, deviations: all.reduce((n, o) => n + o.deviations.length, 0),
    };
  });
  const pairs: [Arm, Arm][] = [['harness-single', 'native-full'], ['harness-team', 'harness-single'], ['harness-team', 'native-full']];
  const contrasts = pairs.flatMap(([a, b], i) => (['acceptedRate', 'minutes'] as const).map((metric, j) => bootstrapContrast(manifest, outcomes, a, b, metric, manifest.seed + i * 7 + j)));

  let needed: M0bReport['tasksNeededForDelta'] = null;
  try { needed = { delta: assumptions.delta, tasks: requiredTasks({ ...assumptions, repetitions: manifest.repetitions }).tasks }; } catch { needed = null; }
  const conclusion: string[] = [];
  for (const c of contrasts.filter((x) => x.metric === 'acceptedRate')) {
    const spans = c.low <= 0 && c.high >= 0;
    conclusion.push(`${c.a} so với ${c.b}: chênh lệch tỷ lệ nghiệm thu ${(c.estimate * 100).toFixed(1)} điểm (95% CI ${(c.low * 100).toFixed(1)} → ${(c.high * 100).toFixed(1)}). ${spans ? 'Khoảng bao gồm 0: chưa đủ bằng chứng, không phải bằng chứng không khác biệt.' : 'Khoảng không bao gồm 0 trên mẫu thử này.'}`);
  }
  if (needed && manifest.tasks.length < needed.tasks) conclusion.push(`Với ${manifest.tasks.length} task, mẫu thấp hơn ${needed.tasks} task cần để phát hiện chênh lệch ${(needed.delta * 100).toFixed(0)} điểm theo giả định đã nêu; đây là pilot, không chạy thêm để chờ ý nghĩa thống kê.`);
  if (arms.some((a) => a.missingRecords)) conclusion.push('Có assignment thiếu bản ghi; chúng được tính là chưa hoàn thành.');
  return { arms, contrasts, conclusion, plannedTasks: manifest.tasks.length, tasksNeededForDelta: needed };
}
