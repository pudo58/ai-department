import { createAssignments } from './manifest.js';
import { ARMS, type Arm, type Assignment, type EvaluationTask, type M0bManifest, type Outcome, type Stratum, type TaskRecord } from './types.js';

/** What the pilot needs to know about one task pack on disk. */
export interface PilotTaskPack {
  id: string;
  stratum: Stratum;
  signals: string[];
  initialTeamMode: EvaluationTask['initialTeamMode'];
  spec: string;
  packHash: string;
}

export interface PilotOptions {
  id: string;
  seed: number;
  lockedAt: string;
  modelVersion: string;
  cliVersions: Record<string, string>;
  taskBudgetUsd?: number;
  bootstrapSamples?: number;
}

/** "Accepted" means a person would receive a correct deliverable through the normal path; see the rubric text below. */
export const PILOT_RUBRIC = [
  'Accepted = the hidden grader of the task pack passes every test AND the run finished through its normal path',
  '(harness arms: reached awaiting_acceptance; native-full: the agent finished within the time limit).',
  'A run that stops, fails or is blocked is not accepted, whatever its code scores. Grader-only results and false-ready counts are reported separately.',
  'Contracts are approved unchanged and a valid Author test correction is applied automatically; both are recorded as protocol deviations.',
].join(' ');

/** Eight tasks, four easy and four hard, every arm twice, in an order shuffled by the registered seed. */
export function buildPilotManifest(packs: readonly PilotTaskPack[], options: PilotOptions): M0bManifest {
  const tasks: EvaluationTask[] = [...packs].sort((a, b) => a.id.localeCompare(b.id)).map((p) => ({
    id: p.id, stratum: p.stratum, requirement: p.spec, routingSignals: p.signals, initialTeamMode: p.initialTeamMode, taskPackHash: p.packHash,
  }));
  return {
    schemaVersion: 1, kind: 'm0b', id: options.id,
    // The tasks, references, graders and mutants were written by the AI under test's own tooling, with no independent human attestation.
    provenance: 'synthetic',
    description: 'Pilot: harness-single vs harness-team (verify) vs native Codex on eight task packs with hidden graders.',
    seed: options.seed,
    protocol: { version: options.id, rubric: PILOT_RUBRIC, lockedAt: options.lockedAt },
    repetitions: 2, arms: [...ARMS], tasks,
    assignments: createAssignments(tasks, ARMS, 2, options.seed),
    settings: {
      taskBudgetUsd: options.taskBudgetUsd ?? 10.8, modelVersion: options.modelVersion, cliVersions: options.cliVersions,
      harnessSingleSubagents: false, nativeFeatures: 'all-supported', followupHours: 0,
      targetWeights: { easy: 0.5, hard: 0.5 }, bootstrapSamples: options.bootstrapSamples ?? 2000,
    },
  };
}

export type RunPlan = { kind: 'native' } | { kind: 'harness'; mode: EvaluationTask['initialTeamMode'] };
export function runPlan(arm: Arm, task: Pick<EvaluationTask, 'initialTeamMode'>): RunPlan {
  if (arm === 'native-full') return { kind: 'native' };
  return { kind: 'harness', mode: arm === 'harness-single' ? 'single' : task.initialTeamMode };
}

/** The raw result of one assignment, as written by the runner. */
export interface PilotRow {
  assignmentId: string;
  arm: Arm;
  /** Final run status (harness) or finished/timeout (native). */
  status: string;
  /** An exception in the runner or the machine, not a verdict on the arm. */
  error?: string;
  graderPass: boolean;
  grader?: { passed: number; total: number };
  /** Harness arms only. */
  readiness?: string;
  falseReady?: boolean | null;
  degraded?: { stages: string[]; items: number } | null;
  costUsd: number | null;
  automaticMs: number;
  subagentsUsed?: boolean;
  deviations?: string[];
}

export function outcomeOf(row: Pick<PilotRow, 'status' | 'error'>): Outcome {
  if (row.error) return 'infrastructure';
  if (row.status === 'awaiting_acceptance' || row.status === 'completed' || row.status === 'finished') return 'completed';
  if (row.status === 'blocked') return 'blocked';
  return 'failed';
}

export function taskRecordFrom(row: PilotRow, assignment: Assignment, manifestHash: string): TaskRecord {
  const outcome = outcomeOf(row);
  const minutes = row.automaticMs / 60_000;
  const grader = row.grader ? `grader ${row.grader.passed}/${row.grader.total}` : 'chưa chấm';
  return {
    assignmentId: assignment.id, manifestHash, outcome,
    accepted: outcome === 'completed' && row.graderPass,
    evidence: `${row.status}; ${grader}${row.readiness ? `; ${row.readiness}` : ''}${row.falseReady ? '; FALSE-READY' : ''}${row.degraded?.items ? `; suy giảm: ${row.degraded.stages.join(', ')}` : ''}`,
    costUsd: row.costUsd,
    humanMinutes: { clarification: 0, approval: 0, review: 0, quota: 0, acceptance: 0, rework: 0, onboarding: 0, research: 0 },
    activeMinutes: minutes, elapsedMinutes: minutes, quotaWaitMinutes: 0, escalations: [],
    protocolDeviations: row.deviations ?? [], subagentsUsed: !!row.subagentsUsed, nativeFeaturesSupported: true,
    independence: 'as-assigned', followupComplete: true,
  };
}

export interface ArmRollup { arm: Arm; runs: number; graderPass: number; accepted: number; falseReady: number; degraded: number; infrastructure: number; meanCostUsd: number | null; meanSeconds: number }
/** Counts the reader needs next to the M0b contrasts: correctness alone, the system's own verdict, and honesty of that verdict. */
export function rollup(rows: readonly PilotRow[]): ArmRollup[] {
  return ARMS.map((arm) => {
    const mine = rows.filter((r) => r.arm === arm);
    const costs = mine.map((r) => r.costUsd);
    return {
      arm, runs: mine.length, graderPass: mine.filter((r) => r.graderPass).length,
      accepted: mine.filter((r) => outcomeOf(r) === 'completed' && r.graderPass).length,
      falseReady: mine.filter((r) => r.falseReady).length, degraded: mine.filter((r) => r.degraded?.items).length,
      infrastructure: mine.filter((r) => r.error).length,
      meanCostUsd: costs.length && costs.every((c): c is number => c !== null) ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
      meanSeconds: mine.length ? mine.reduce((a, r) => a + r.automaticMs, 0) / mine.length / 1000 : 0,
    };
  });
}
