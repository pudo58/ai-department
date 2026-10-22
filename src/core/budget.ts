import type { Attempt, BudgetState, Mode, Run, Slot, Stage, UsageRecord } from '../shared/types.js';

/** Default phase split of a task budget: prepare / implement / repair-in-implementation / final verify. */
export const PHASE_SHARE: Record<Stage, number> = { prepare: 0.2, implement: 0.4, repair: 0.1, verify: 0.3 };
export const TEAM_CAP_MULTIPLIER = 3;
export const MAX_REPAIRS_PER_CANDIDATE = 2;
const STAGES = Object.keys(PHASE_SHARE) as Stage[];

/** Conservative flat rates (USD per million tokens) used only when a provider reports no cost. */
export const FALLBACK_RATES = { input: 3, cached: 0.3, output: 15 };
export function estimateCost(tokens: { inputTokens: number; cachedTokens: number; outputTokens: number }): number {
  const uncached = Math.max(0, tokens.inputTokens - tokens.cachedTokens);
  return (uncached * FALLBACK_RATES.input + tokens.cachedTokens * FALLBACK_RATES.cached + tokens.outputTokens * FALLBACK_RATES.output) / 1_000_000;
}
export const usageCost = (u: UsageRecord): number => u.costUsd ?? estimateCost(u);

/** The Team ceiling is three times the original Single budget. Single itself has no multiplier. */
export function budgetCeiling(baseBudgetUsd: number, mode: Mode): number {
  return mode === 'single' ? baseBudgetUsd : baseBudgetUsd * TEAM_CAP_MULTIPLIER;
}

export function allocate(capUsd: number): Record<Stage, number> {
  return Object.fromEntries(STAGES.map((s) => [s, capUsd * PHASE_SHARE[s]])) as Record<Stage, number>;
}

export function budgetState(run: Run, attempts: readonly Attempt[]): BudgetState {
  const stageOf = new Map(attempts.map((a) => [a.id, a.stage]));
  const spent = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const u of run.usage) spent[stageOf.get(u.attemptId) ?? 'prepare'] += usageCost(u);
  const planned = allocate(run.budgetUsd);
  return {
    capUsd: run.budgetUsd,
    spentUsd: STAGES.reduce((sum, s) => sum + spent[s], 0),
    estimated: run.usage.some((u) => u.source !== 'reported'),
    phases: Object.fromEntries(STAGES.map((s) => [s, { allocatedUsd: planned[s], spentUsd: spent[s] }])) as BudgetState['phases'],
  };
}

/** A stage may use its own share plus whatever earlier stages left unused, never beyond the total cap. */
export function remainingFor(state: BudgetState, stage: Stage): number {
  let allocated = 0, spent = 0;
  for (const s of STAGES) {
    allocated += state.phases[s].allocatedUsd;
    spent += state.phases[s].spentUsd;
    if (s === stage) break;
  }
  return Math.max(0, Math.min(allocated - spent, state.capUsd - state.spentUsd));
}

/**
 * Compare splits implementation across two candidates instead of doubling the total.
 * The final-verify share is never available for opening a new candidate.
 */
export function candidateCap(state: BudgetState, candidates: number): number {
  const pool = state.phases.implement.allocatedUsd + state.phases.repair.allocatedUsd;
  return pool / Math.max(1, candidates);
}
export function candidateSpend(run: Run, attempts: readonly Attempt[], slot: Slot): number {
  const slotOf = new Map(attempts.map((a) => [a.id, a.slot]));
  return run.usage.filter((u) => slotOf.get(u.attemptId) === slot).reduce((sum, u) => sum + usageCost(u), 0);
}

export interface EscalationCheck { allowed: boolean; reason: string; newCapUsd: number }
/**
 * Escalation is only real if money exists to carry it out: either the current cap already covers
 * a fresh implementation share, or the user approves an increase that stays within the Team ceiling.
 */
export function checkEscalation(run: Run, spentUsd: number, to: Mode, approvedCapUsd?: number): EscalationCheck {
  const ceiling = budgetCeiling(run.baseBudgetUsd, to);
  const cap = approvedCapUsd ?? run.budgetUsd;
  if (cap > ceiling + 1e-9) return { allowed: false, reason: `Ngân sách ${cap.toFixed(2)} USD vượt trần ${ceiling.toFixed(2)} USD.`, newCapUsd: run.budgetUsd };
  const required = to === 'single' ? 0 : spentUsd + run.baseBudgetUsd * PHASE_SHARE.implement;
  if (cap < required) return { allowed: false, reason: 'Chưa có ngân sách dành riêng cho bước chuyển chế độ; cần người dùng duyệt phần tăng.', newCapUsd: run.budgetUsd };
  return { allowed: true, reason: 'Đủ ngân sách để thực hiện.', newCapUsd: cap };
}
