import type { HumanTime, Mode, Run } from '../shared/types.js';
import { usageCost } from './budget.js';

export interface ModeSummary {
  /** Mode the task STARTED in. A Single→Team task keeps its full history under Single (intent-to-treat). */
  mode: Mode;
  runs: number; accepted: number; unfinished: number; escalated: number;
  costUsd: number; costEstimated: boolean;
  humanMinutes: Record<HumanTime['category'], number>; humanMinutesTotal: number;
  acceptedRate: number; costPerRun: number; humanMinutesPerRun: number;
}

const CATEGORIES: HumanTime['category'][] = ['clarification', 'approval', 'review', 'quota', 'acceptance', 'rework', 'onboarding', 'research'];

export const humanMinutes = (run: Run): Record<HumanTime['category'], number> => {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<HumanTime['category'], number>;
  for (const t of run.humanTime) out[t.category] += (t.durationMs ?? 0) / 60_000;
  return out;
};

/**
 * Groups by initial mode and counts every run, including ones that never completed.
 * Only closed timers count as human work: an open screen is not evidence of effort.
 */
export function summarizeRuns(runs: readonly Run[]): ModeSummary[] {
  const modes: Mode[] = ['single', 'clarify', 'verify', 'compare'];
  return modes.flatMap((mode) => {
    const group = runs.filter((r) => r.initialMode === mode);
    if (!group.length) return [];
    const minutes = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<HumanTime['category'], number>;
    let cost = 0, estimated = false;
    for (const run of group) {
      cost += run.usage.reduce((sum, u) => sum + usageCost(u), 0);
      estimated ||= run.usage.some((u) => u.source !== 'reported');
      const m = humanMinutes(run);
      for (const c of CATEGORIES) minutes[c] += m[c];
    }
    const total = CATEGORIES.reduce((sum, c) => sum + minutes[c], 0);
    const accepted = group.filter((r) => r.status === 'completed').length;
    return [{
      mode, runs: group.length, accepted, unfinished: group.filter((r) => r.status !== 'completed').length,
      escalated: group.filter((r) => r.escalations.length).length, costUsd: cost, costEstimated: estimated,
      humanMinutes: minutes, humanMinutesTotal: total, acceptedRate: accepted / group.length,
      costPerRun: cost / group.length, humanMinutesPerRun: total / group.length,
    }];
  });
}

export interface ContextArm { runs: number; accepted: number; acceptedRate: number; repairsPerRun: number; costPerRun: number; costEstimated: boolean }
/**
 * Runs with project context against runs without it, for deciding whether context earns its tokens. Runs that never
 * reached an agent have no context record and are left out; this is a comparison aid, not a controlled experiment.
 */
export function summarizeContext(runs: readonly Run[]): { on: ContextArm; off: ContextArm } {
  const arm = (group: readonly Run[]): ContextArm => {
    const accepted = group.filter((r) => r.status === 'completed').length;
    const cost = group.reduce((sum, r) => sum + r.usage.reduce((s, u) => s + usageCost(u), 0), 0);
    const n = group.length || 1;
    return {
      runs: group.length, accepted, acceptedRate: group.length ? accepted / group.length : 0,
      repairsPerRun: group.reduce((s, r) => s + r.repairCount, 0) / n, costPerRun: cost / n,
      costEstimated: group.some((r) => r.usage.some((u) => u.source !== 'reported')),
    };
  };
  const seen = runs.filter((r) => r.context && r.provider !== 'fake');
  return { on: arm(seen.filter((r) => r.context!.enabled)), off: arm(seen.filter((r) => !r.context!.enabled)) };
}
