/** Evaluation data is deliberately separate from live task state and reviewer inputs. */
export const REVIEW_VARIANTS = ['same-model-new-session', 'cross-model-new-session'] as const;
export const ARMS = ['native-full', 'harness-single', 'harness-team'] as const;
export type ReviewVariant = typeof REVIEW_VARIANTS[number];
export type Arm = typeof ARMS[number];
export type Stratum = 'easy' | 'hard';
export type Provenance = 'synthetic' | 'human-attested';

export interface SourceFile { path: string; content: string }
export interface ReviewInput {
  caseId: string;
  requirement: string;
  policy: { id: string; text: string }[];
  base: SourceFile[];
  candidate: SourceFile[];
}
export interface Attestation {
  by: string;
  at: string;
  independentOfReviewer: true;
  evidence: string;
}
export interface ReviewCase extends ReviewInput {
  authorModel: string;
  truth: {
    kind: 'clean' | 'behavior' | 'design';
    findings: { id: string; category: 'behavior' | 'design'; location: string; rationale: string }[];
    attestation?: Attestation;
  };
  source?: { repository: string; baseSha: string; candidateSha: string; snapshotHash: string };
}
interface ManifestBase {
  schemaVersion: 1;
  id: string;
  provenance: Provenance;
  description: string;
  seed: number;
  protocol: { version: string; rubric: string; lockedAt: string };
}
export interface M0aManifest extends ManifestBase {
  kind: 'm0a';
  repetitions: 2;
  models: [string, string];
  variants: ReviewVariant[];
  cases: ReviewCase[];
}
export interface EvaluationTask {
  id: string;
  stratum: Stratum;
  requirement: string;
  routingSignals: string[];
  /** Fixed before execution; escalation is recorded separately. */
  initialTeamMode: 'single' | 'clarify' | 'verify' | 'compare';
  /** Hash of the whole task pack (spec, scaffold, reference, hidden grader, mutants), locked with the manifest. */
  taskPackHash?: string;
  source?: { repository: string; baseSha: string; evaluatorHash: string; attestation: Attestation };
}
export interface Assignment { id: string; taskId: string; arm: Arm; repetition: number }
export interface M0bManifest extends ManifestBase {
  kind: 'm0b';
  repetitions: 2;
  arms: Arm[];
  tasks: EvaluationTask[];
  assignments: Assignment[];
  settings: {
    taskBudgetUsd: number;
    modelVersion: string;
    cliVersions: Record<string, string>;
    harnessSingleSubagents: false;
    nativeFeatures: 'all-supported';
    followupHours: number;
    targetWeights: Record<Stratum, number>;
    bootstrapSamples: number;
  };
}
export type EvaluationManifest = M0aManifest | M0bManifest;
export interface Registration { algorithm: 'sha256'; manifestHash: string; registeredAt: string }
export interface ReportFinding {
  id: string;
  category: 'behavior' | 'design';
  severity: 'blocker' | 'major' | 'minor';
  title: string;
  location: string;
  evidence: string;
  rule?: string;
}
export interface ReviewResponse { decision: 'block' | 'pass' | 'abstain'; findings: ReportFinding[] }
export interface FindingAdjudication {
  findingId: string;
  verdict: 'supported' | 'unsupported' | 'unresolved';
  adjudicator: string;
  independentOfReviewer: true;
  rationale: string;
  goldId?: string;
}
export interface ReviewRecord {
  id: string;
  manifestHash: string;
  caseId: string;
  variant: ReviewVariant;
  repetition: number;
  status: 'completed' | 'invalid' | 'error';
  response?: ReviewResponse;
  rawOutput: unknown;
  error?: string;
  requestedModel: string;
  actualModel: string;
  sessionId: string;
  durationMs: number;
  costUsd: number | null;
  arbitrationMinutes?: number;
  adjudications: FindingAdjudication[];
}
export type Outcome = 'completed' | 'failed' | 'blocked' | 'quota' | 'infrastructure' | 'invalid';
export interface HumanMinutes {
  clarification: number;
  approval: number;
  review: number;
  quota: number;
  acceptance: number;
  rework: number;
  onboarding: number;
  research: number;
}
export interface TaskRecord {
  assignmentId: string;
  manifestHash: string;
  outcome: Outcome;
  accepted: boolean;
  evidence: string;
  costUsd: number | null;
  humanMinutes: HumanMinutes;
  activeMinutes: number;
  elapsedMinutes: number;
  quotaWaitMinutes: number;
  escalations: { from: string; to: string; reason: string; at: string }[];
  /** Deviations stay in intent-to-treat accounting, never silently disappear. */
  protocolDeviations: string[];
  subagentsUsed: boolean;
  nativeFeaturesSupported: boolean;
  independence: 'as-assigned' | 'reduced';
  followupComplete: boolean;
}
export interface EvaluationDataset {
  manifestHash: string;
  provenance: Provenance;
  records: ReviewRecord[] | TaskRecord[];
}
export interface ReviewerExecution { model: string; variant: ReviewVariant; sessionId: string; freshSession: true }
export type Reviewer = (input: Readonly<ReviewInput>, execution: Readonly<ReviewerExecution>) => Promise<{
  rawOutput: unknown; model: string; sessionId: string; durationMs: number; costUsd: number | null;
}>;
