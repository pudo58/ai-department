import type { MutationCapability, MutationResult } from '../shared/quality.js';
import type { MutationExecution } from './mutation.js';
import type { Attempt, DeliveryResult, DeliveryTarget, Recipe, Role, Run, Slot } from '../shared/types.js';
import type { AnalysisTool, ToolReport } from '../core/tools.js';
import type { UsageCheckpoint } from './providers.js';

export interface RuntimeEvent { type: string; message: string; data?: unknown }
export interface RuntimeUsage {
  inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number | null;
  /** Paid by a flat subscription (ChatGPT / Claude plan): costUsd is then 0 and the list-price equivalent is kept here. */
  billing?: 'subscription' | 'api'; notionalUsd?: number;
}
export interface AgentExecution {
  run: Run; attempt: Attempt; role: Role; prompt: string; readOnly?: boolean;
  /** Resume an earlier provider session; usage is then reported as a delta over `previousUsage`. */
  sessionId?: string; previousUsage?: UsageCheckpoint;
  onEvent?: (event: RuntimeEvent) => void; signal?: AbortSignal;
  /** Approved skills for this role that the runtime loads natively (Claude plugin dir, Codex `.agents/skills`). */
  skills?: ResolvedSkill[];
}
/** A library skill ready to hand to an agent: its folder on disk plus what a prompt fallback needs. */
export interface ResolvedSkill { name: string; dir: string; hash: string; description: string; body: string; hasScripts: boolean }
export interface AgentResult {
  output: string; sessionId?: string; usage: RuntimeUsage; cumulativeUsage?: UsageCheckpoint;
  /** The model that actually answered, when the provider tells us (e.g. read from the Codex session log). */
  model?: string;
}
export interface CheckExecution {
  run: Run; recipe: Recipe; slot: Slot;
  /** `base` runs the locked test paths against the base sources, used for red-phase validation. */
  ref: 'base' | 'candidate'; keepPaths?: string[];
  onEvent?: (event: RuntimeEvent) => void; signal?: AbortSignal;
}
export interface RuntimeCheckResult {
  /** Root as seen by the reporter, which can differ from the host workspace in Docker. */
  reportRoot?: string;
  exitCode: number | null; log: string; durationMs: number;
  report?: unknown; checkpoint: string; incomplete: boolean;
}
export interface ChangeSet { files: string[]; patch: string }
export interface PrepareResult { baseSha: string; branch: string; warnings: string[] }

/** Everything the orchestrator needs from an execution environment. Real runtimes isolate; the fake simulates. */
export interface Runtime {
  replayFinding?(execution: import('./reproduction.js').ReproductionExecution): Promise<import('../shared/reproduction.js').FindingReplay>;
  recoverReplays?(run:Run):Promise<void>;
  preflight?(run: Run, slot: Slot, signal?: AbortSignal): Promise<import('../shared/execution.js').EnvironmentProbe>;
  readonly name: string;
  /** `onEvent` receives `{type:'log'}` lines (setup output) so a person can watch long preparation steps. */
  prepare(run: Run, slot: Slot, onEvent?: (event: RuntimeEvent) => void): Promise<PrepareResult>;
  runAgent(execution: AgentExecution): Promise<AgentResult>;
  /** Uncommitted modifications relative to the last accepted checkpoint. */
  changes(run: Run, slot: Slot): Promise<ChangeSet>;
  /** Accepts the current workspace state as a checkpoint and returns its identifier. */
  commit(run: Run, slot: Slot, message: string): Promise<string>;
  /** Restores the workspace to the last accepted checkpoint (used for rejected patches and resume). */
  revert(run: Run, slot: Slot): Promise<void>;
  /** Applies an explicitly approved test repair to the exact checkpoint. Never used by Developer. */
  applyPatch?(run: Run, slot: Slot, patch: string): Promise<void>;
  runCheck(execution: CheckExecution): Promise<RuntimeCheckResult>;
  detectMutation?(run: Run, slot: Slot): Promise<MutationCapability>;
  runMutation?(execution: MutationExecution): Promise<MutationResult>;
  recoverMutation?(run: Run): Promise<void>;
  runTool(run: Run, slot: Slot, tool: AnalysisTool, ref: 'base' | 'candidate'): Promise<ToolReport>;
  /** Cumulative change of the checkpoint against the base snapshot, for the acceptance report. Optional: not every runtime can tell. */
  diffSinceBase?(run: Run, slot: Slot): Promise<{ files: { path: string; added: number; removed: number; status: 'added' | 'modified' | 'deleted' | 'renamed' }[]; patch: string }>;
  /** Where acceptance will deliver the exact checkpoint; no files are written by this method. */
  deliveryTarget?(run: Run, slot: Slot): DeliveryTarget;
  /** Idempotently delivers the exact checkpoint, or throws without claiming acceptance. */
  deliver?(run: Run, slot: Slot): Promise<DeliveryResult>;
  /** The working copy on this machine, for read-only inspection such as the repo map. Absent for simulations. */
  workspacePath?(run: Run, slot: Slot): string;
  /** Paths present in the run's base snapshot (to tell files the agent created from ones that already existed). */
  baseFiles?(run: Run, slot: Slot): Promise<string[]>;
  stop(attemptId: string): Promise<void>;
  dispose(run: Run): Promise<void>;
}

/** This records operator verification, not a claim that arbitrary native CLI tools are isolated. */
export interface RuntimeAttestation {
  version: 1; projectId: string; imageId: string; imageReference: string;
  approvedAt: string; expiresAt: string; network: string;
  providerEgressVerified: boolean;
  nativeToolSurfaceVerified: boolean;
  singleAgentEnforcementVerified: boolean;
  providers: Partial<Record<'codex' | 'claude', { version: string; authVolume: string }>>;
}

/** The project's own setup command (install dependencies) failed, so there is no working copy to work in; only the project's setup can fix it. */
export class SetupFailedError extends Error {
  readonly code = 'SETUP_FAILED';
  constructor(message: string) { super(message); this.name = 'SetupFailedError'; }
}

export class RuntimeBlockedError extends Error {
  readonly code = 'RUNTIME_BLOCKED';
  constructor(message: string) { super(message); this.name = 'RuntimeBlockedError'; }
}
