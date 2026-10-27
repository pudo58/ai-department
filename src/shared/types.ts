import type { TestPlan, TestPlanReview, QualityDetail, MutationCapability } from './quality.js';
import type { EvidencePolicy } from './regression.js';
export type Mode = 'single' | 'clarify' | 'verify' | 'compare';
export type ProviderName = 'codex' | 'claude' | 'antigravity' | 'fake';
export type Role = 'planner' | 'author' | 'developer' | 'verifier' | 'investigator';
export type Stage = 'prepare' | 'implement' | 'repair' | 'verify';
export type RunStatus = 'draft' | 'awaiting_approval' | 'queued' | 'running' | 'paused' | 'blocked' | 'awaiting_acceptance' | 'completed' | 'failed';
export type Slot = 'A' | 'B';
export type TaskKind = 'bugfix' | 'feature' | 'refactor';
export type CheckStatus = 'passed' | 'failed' | 'flaky' | 'incomplete';
/** `skills` are names of skills in the AI Department library, loaded for this role when they are approved. */
export interface RoleConfig { provider: ProviderName; model: string; effort: string; skills: string[] }
export type SkillStatus = 'review' | 'active' | 'disabled';
export interface SkillFile { path: string; size: number; script: boolean }
/** A skill in the library: a copy of its folder under <data>/skills/<name>, usable only once a person approved it. */
export interface SkillRecord {
  id: string; name: string; description: string;
  source: { type: 'local' | 'zip' | 'github'; path?: string; url?: string };
  hash: string; files: SkillFile[]; sizeBytes: number; hasScripts: boolean;
  status: SkillStatus; installedAt: string; updatedAt: string; reviewedAt?: string;
}
/** A skill found in a source (a folder on this machine, a .zip, a GitHub path) before it is installed. */
export interface SkillCandidate {
  name: string; description: string; origin: string; files: SkillFile[]; sizeBytes: number; hasScripts: boolean;
  problems: string[]; installed?: SkillStatus; sameAsInstalled?: boolean;
}
export interface Recipe { id: string; command: string[]; required: boolean; timeoutMs: number; reportPath?: string }
export interface ProjectProfile {
  id: string; name: string; repository: string; version: number; approved: boolean;
  modules: string[]; protectedPaths: string[]; checks: Recipe[];
  roles: Record<Role, RoleConfig>; runnerImage: string; setupCommand: string[];
  agentNetwork: string; authVolume?: string; policyRules: string[];
  limits?: { agentMs?: number; setupMs?: number };
  /** Selected relative package directory when automatic mutation detection is ambiguous. */
  mutationRoot?: string;
  /** Folder (relative to the repository) where generated regression tests are written; defaults to tests/aidept-regressions. */
  regressionDir?: string;
  /** Id of the Vitest check that runs generated regression tests; needed only when the project has more than one Vitest check. */
  regressionRecipe?: string;
  /** 'local' runs the agent and checks directly on this machine (no isolation); missing means docker. */
  executionMode?: 'docker' | 'local';
  /** Project owner's notes on stack, conventions, commands and things to avoid. Text for the agents to read, never executed. */
  guidance?: string;
  /** Project context (repo map + approved memory) in agent prompts. Off unless set; off means today's prompts exactly. */
  contextEnabled?: boolean;
  /** New projects: the agent may create package.json, lockfiles, tsconfig and vite/vitest/jest/playwright config that do not exist yet. */
  allowScaffold?: boolean;
  /** How to start the app so a person can try a run's result (argv; the port comes in PORT). Empty means guess from the files. */
  previewCommand?: string[];
  /** Estimated-token budget per role for the context block (guidance not included). */
  contextBudget?: Partial<Record<ContextRole, number>>;
  singleBudgetUsd: number; currency: 'USD'; createdAt: string;
}
export interface Requirement { id: string; text: string; required: boolean; manual: boolean; kind?: 'expected' | 'forbidden' }
export interface TaskContract { version: number; requirements: Requirement[]; acceptanceExamples: string[]; interfaces: string[]; assumptions: string[]; scope: string[]; testPlan?: TestPlan; approvedHash?: string; approvedAt?: string }
export type ContractWarningCode = 'missing_expected' | 'missing_forbidden' | 'missing_examples' | 'assumptions_present' | 'plan_advisory';
export interface ContractReview {
  contractHash: string; contractVersion: number; problems: string[];
  warnings: { code: ContractWarningCode; message: string }[];
}
export interface ContractReviewReceipt {
  contractHash: string; contractVersion: number; reviewedAt: string; acknowledgedWarnings: ContractWarningCode[];
}
export interface ContractApprovalInput { contractHash: string; acknowledgeWarnings?: boolean }
export interface Interpretation { id: string; role: Role; text: string; questions: string[]; sourceHash: string; contractSeen: boolean; createdAt: string }
export interface UsageRecord { id: string; attemptId: string; sessionId?: string; inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number | null; source: 'reported' | 'estimated' | 'unknown'; billing?: 'subscription' | 'api'; notionalUsd?: number; createdAt: string }
export interface HumanTime { id: string; category: 'clarification' | 'approval' | 'review' | 'quota' | 'acceptance' | 'rework' | 'onboarding' | 'research'; startedAt: string; endedAt?: string; durationMs?: number; note: string }
export interface DeliveryTarget { kind: 'branch' | 'files'; target: string }
export interface DeliveryResult extends DeliveryTarget { summary: string }
/** A receipt for one exact version. An interrupted operation is never evidence of success. */
export interface Delivery extends DeliveryTarget {
  status: 'in_progress' | 'failed' | 'succeeded' | 'unknown';
  checkpoint: string; contractVersion: number; slot: Slot;
  startedAt: string; endedAt?: string; result?: string; error?: string;
}
export interface Run {
  executionSpans?: import('./execution.js').ExecutionSpan[];
  preflightRequest?: boolean;
  /**
   * What the next drive of this run must do instead of the default step: re-run the checks on the checkpoint, or repair
   * confirmed findings. Stored with the run, so a request made just before a restart is still carried out on resume;
   * cleared when that drive ends (finished, blocked or stopped by the person).
   */
  pendingAction?: 'recheck' | 'repair' | 'replay';
  /** The finding (and the regression proposal it was shown with) a queued `replay` action re-runs; no AI is involved. */
  pendingReplay?: { findingId: string; proposalHash?: string };
  preflightReturnStatus?: RunStatus;
  authorDraftRequest?: { attemptId: string; draftHash: string };
  id: string; projectId: string; title: string; originalRequirement: string; mode: Mode;
  initialMode: Mode; taskKind?: TaskKind; selectedSlot: Slot;
  /** Paths outside the project's modules that a person approved for this task only. */
  approvedPaths?: string[]; provider: ProviderName; status: RunStatus; stage: Stage;
  contract: TaskContract; interpretations: Interpretation[]; baseSha: string | null;
  checkpoint: string | null; branch: string | null; budgetUsd: number; baseBudgetUsd: number; configSnapshot: ProjectProfile;
  signals: string[]; recommendation: { mode: Mode; reasons: string[]; multiplier: number };
  escalations: { from: Mode; to: Mode; reason: string; at: string }[];
  usage: UsageRecord[]; humanTime: HumanTime[]; repairCount: number; blocker: string | null;
  createdAt: string; updatedAt: string; acceptedAt?: string; followupUntil?: string;
  delivery?: Delivery;
  contractReviewReceipt?: ContractReviewReceipt;
  qualityPolicyVersion?: 1 | 2 | 3 | 4;
  /** Evidence rules frozen when a v4 run was created; later environment or code changes cannot loosen them. */
  evidencePolicy?: EvidencePolicy;
  /** A human-approved test-only proposal; persisted before enqueue so restart cannot lose its intent. */
  testRepairApproval?: { artifactId: string; artifactHash: string; appliedCheckpoint?: string; /** Applied by the system after every check passed, not by a person. */ auto?: boolean };
  /** Project context frozen for this run on first use, so later memory edits cannot change a run in flight. */
  context?: RunContext;
}
/** One row of the task list: what GET /api/runs serves on every poll instead of the whole Run. */
export interface RunSummary {
  id: string; projectId: string; title: string; status: RunStatus; mode: Mode; provider: ProviderName;
  /** With status, all that pipelineStep needs to place the task. */
  stage: Stage; contractApproved: boolean;
  budgetUsd: number; blocker: string | null; createdAt: string; updatedAt: string;
  /** Who writes the code: the developer role of the run's configuration snapshot. */
  developer: { provider: ProviderName; model: string };
  /** Spent over the run's whole life, and in the last 30 days. */
  costUsd: number; monthCostUsd: number;
  deliveryStatus?: Delivery['status'] | 'unconfirmed';
}
export interface Independence { independent: boolean; reason: string }
export interface RunDetail {
  /** Set when automatic fallbacks weakened this run's evidence; see degradedOf in core/report.ts. */
  degraded?: import('../core/report.js').DegradedRun;
  findingReplays?: import('./reproduction.js').FindingReplay[];
  /** v4: the regression test proposed for each reproduced finding, and the ladder from "suspected" to "proven fixed". */
  regressionProposals?: import('./regression.js').PendingRegression[];
  findingProofs?: import('./regression.js').FindingProof[];
  regressionFiles?: import('./regression.js').RegressionRef[];
  execution?: import('./execution.js').ExecutionMetrics;
  environment?: import('./execution.js').EnvironmentProbe;
  authorDraft?: import('./execution.js').PendingAuthorDraft;
}
export interface Attempt { id: string; slot: Slot; independence?: Independence; runId: string; role: Role; stage: Stage; provider: ProviderName; model: string; sessionId?: string; status: 'running' | 'completed' | 'failed' | 'interrupted'; startedAt: string; endedAt?: string; containerId?: string; checkpoint: string | null; contractVersion: number; error?: string }
export interface Artifact { id: string; runId: string; attemptId?: string; kind: 'raw' | 'context' | 'reuse' | 'diff' | 'report' | 'acceptance' | 'interpretation' | 'tool' | 'checkpoint'; title: string; content: string; hash: string; checkpoint: string | null; contractVersion: number; valid: boolean; createdAt: string }
export interface Finding { id: string; runId: string; category: 'behavior' | 'design'; severity: 'blocker' | 'major' | 'minor'; code?: string; title: string; location: string; rule?: string; precedent?: string; evidence: string; suggestion: string; status: 'open' | 'disputed' | 'resolved'; confirmed: boolean; checkpoint: string | null; contractVersion: number; dispute?: string; createdAt: string; reproduction?: import('./reproduction.js').FindingReproduction; reproductionLimitation?: string; /** An automatic repair round already tried this unconfirmed finding; it stays visible but no longer blocks. */ attempted?: boolean;
  /** v4: how the person confirmed it: against the exact regression proposal they read, or by a reasoned manual review. */
  confirmation?: import('./regression.js').FindingConfirmation;
  /** v4: how it was closed. Only `verified_fix` means the runner proved the repair; `manual_review` is a person's recorded decision. */
  resolution?: import('./regression.js').FindingResolution }
export interface CheckResult { issues?: CheckIssue[]; aliases?: Record<string, string[]>; slot?: Slot; configHash?: string; manifestHash?: string; outcomes?: { id: string; status: 'passed' | 'failed' | 'skipped' }[]; id: string; runId: string; recipeId: string; checkpoint: string; contractVersion: number; status: CheckStatus; attempts: { exitCode: number | null; log: string; durationMs: number }[]; testIds: string[]; missingTestIds: string[]; required: boolean; requirementIds: string[]; quarantined: boolean; quarantineReason?: string; valid: boolean; createdAt: string; /** Test tallies read from the report, when the runner produced one. */ counts?: { passed: number; failed: number; skipped: number }; skippedTestIds?: string[] }
export interface CheckIssue { kind: 'assertion_failed' | 'test_missing' | 'test_skipped' | 'report_error' | 'identity_ambiguous' | 'collection_error' | 'environment' | 'checkpoint_mismatch'; message: string; testId?: string }
export interface TraceEvent { id: number; runId: string; type: string; message: string; data?: unknown; createdAt: string }
export interface MatrixRow { requirementId: string; text: string; required: boolean; manual: boolean; kind?: Requirement['kind']; status: 'verified' | 'unverified' | 'manual_pending' | 'failed'; evidence: string[] }
export interface CompletionState { ready: boolean; reasons: string[] }
export interface PhaseBudget { allocatedUsd: number; spentUsd: number }
export interface BudgetState { capUsd: number; spentUsd: number; estimated: boolean; phases: Record<Stage, PhaseBudget> }
/** A check the system is running right now, so the UI can show the test program live. */
export interface RunningCheck { recipeId: string; command: string; ref: 'base' | 'candidate'; startedAt: string }
export interface RunDetail { planReview?: TestPlanReview; quality: QualityDetail; contractReview: ContractReview; testRepair?: import('../core/recovery.js').PendingTestRepair; runningCheck?: RunningCheck; /** Files the agent tried to change outside the allowed modules, awaiting a person's decision. */ pendingPaths: string[]; matrix: MatrixRow[]; completion: CompletionState; budget: BudgetState; run: Run; attempts: Attempt[]; artifacts: Artifact[]; findings: Finding[]; checks: CheckResult[]; events: TraceEvent[] }
export interface Health { node: string; docker: boolean; dockerMessage: string; codex: boolean; claude: boolean; localCodex: boolean; fake: boolean; liveReady: boolean; limitations: string[]; codexVersion?: string; /** Claude Code installed and signed in on this machine. */ localClaude?: boolean; disk?: { path: string; freeBytes: number; totalBytes: number; level: 'ok' | 'warn' | 'critical' } }
export interface SuggestedCheck {
  id: string; label: string; command: string[]; required: boolean; timeoutMs: number; reportPath?: string;
  /** Pre-selected in the UI. Slow or opinionated checks (build) start unselected. */
  recommended: boolean; reason: string;
}
/** Result of the read-only stack detector: suggestions only, a person confirms before anything is saved. */
export interface StackDetection {
  mutation?: MutationCapability;
  /** Node package manager, or the build tool of a Java/Python/Go/Rust project. */
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'maven' | 'gradle' | 'pip' | 'go' | 'cargo' | null;
  languages: string[]; frameworks: string[]; testRunner: string | null; linters: string[];
  guidance: string; checks: SuggestedCheck[]; setupCommand: string[]; notes: string[];
}

/** Roles that can receive project context. The independent interpreter never does. */
export type ContextRole = 'planner' | 'developer' | 'author' | 'verifier';
export type MemoryKind = 'convention' | 'command' | 'pitfall' | 'decision' | 'architecture';
export type MemoryStatus = 'proposed' | 'active' | 'stale' | 'archived';
/** One verifiable fact about a project, written or approved by a person. Reference text for agents, never executed. */
export interface MemoryItem {
  id: string; projectId: string; kind: MemoryKind; text: string;
  /** Files or folders the fact is about; used to detect when it may no longer hold. */
  paths: string[];
  status: MemoryStatus; pinned?: boolean; staleReason?: string;
  source: { type: 'human' | 'agent' | 'system'; runId?: string; detail?: string };
  createdAt: string; confirmedAt?: string; updatedAt: string; usedCount: number;
  history: { at: string; text: string; status: MemoryStatus }[];
}
export interface RunContext { enabled: boolean; capturedAt: string; repoMap?: RepoMap; memory: MemoryItem[] }
export interface RepoMap { tree: string; scripts: string; entries: string; tests: string; docs: string; scriptNames: string[]; paths: string[] }
export interface ContextSection { name: string; text: string; tokens: number; included: boolean; reason?: string; memoryId?: string }
export interface ContextSelection { role: ContextRole; enabled: boolean; budget: number; usedTokens: number; guidanceTokens: number; sections: ContextSection[]; memoryIds: string[] }
