import type { Slot } from './types.js';

export const RISK_GROUPS = ['happy', 'boundary', 'authorization', 'concurrency', 'dependency', 'state', 'consistency'] as const;
export type RiskGroup = typeof RISK_GROUPS[number];
export const TEST_PRIORITIES = ['high', 'normal', 'low'] as const;
export interface Oracle { references: { requirementId: string; quote: string }[]; explanation: string }
export type TestIdentity = { kind: 'json'; file: string; titles: string[] } | { kind: 'junit'; className: string; name: string };
export const RISK_LABELS: Record<RiskGroup, string> = { happy: 'Ca thuận', boundary: 'Dữ liệu sai và biên', authorization: 'Quyền truy cập', concurrency: 'Lặp và đồng thời', dependency: 'Lỗi phụ thuộc', state: 'Chuyển trạng thái', consistency: 'Nhất quán dữ liệu' };
export interface TestCase {
  id: string; requirementIds: string[]; group: RiskGroup; risk: string; priority: 'high' | 'normal' | 'low';
  preconditions: string; actions: string; expected: string; method: 'automated' | 'manual'; required: boolean;
  /** Ordered transitions for stateful scenarios. Optional to preserve plans approved before schema v1. */
  steps?: { id?: string; before?: string; after?: string; requirementIds?: string[]; action: string; expected: string }[];
  /** Properties that must remain true after each transition in steps. */
  invariants?: string[];
  oracle?: Oracle;
  /** Design fields this case depends on; they do not replace the requirement clause that grounds the case. */
  designRefs?: import('./design.js').DesignRef[];
}
export interface TestPlan { schemaVersion: 1 | 2; statefulModelVersion?: 1; reasoningVersion?: 1; cases: TestCase[]; notApplicable: { group: RiskGroup; reason: string }[]; questions: string[] }
export interface TestPlanReview {
  schemaVersion: 1; source: 'server'; contractHash: string; contractVersion: number;
  attemptIds: string[]; firstPassValid: boolean; repairAttempted: boolean; repairAccepted: boolean;
  outcome: 'valid' | 'needs_review' | 'invalid_output';
  reason?: 'questions_only' | 'budget_exhausted' | 'repair_rejected';
  initialProblems: string[]; remainingProblems: string[];
  /** Form-only findings that do not block approval; shown with the contract warnings. */
  remainingAdvisories?: string[];
  /** Lossless spelling fixes the server applied to the Author's output before validating it. */
  normalizations?: string[];
}
export interface AssertionBinding { stepId: string; expected: string; expression: string; line?: number }
export interface AssertionAudit { path: string; status: 'checked' | 'unsupported'; assertions: number; message: string }
export interface ManifestEntry { caseId: string; requirementIds: string[]; recipeId: string; path: string; testId: string; identity?: TestIdentity; assertions?: AssertionBinding[] }
export interface TestManifest {
  schemaVersion: 1 | 2; source: 'author' | 'observed'; contractHash: string; contractVersion: number; slot: Slot;
  entries: ManifestEntry[]; observed?: { recipeId: string; testIds: string[] }[];
  revision?: { previousHash: string; proposalId: string };
  assertionAudit?: AssertionAudit[];
  /** Binding gaps that weaken the evidence without making the manifest unusable; acknowledged at acceptance. */
  advisories?: string[];
  /** Built from test titles because the Author's bindings could not be made valid; assertion links are not required of it. */
  derived?: boolean;
}
export interface CaseEvidence {
  caseId: string; requirementIds: string[]; required: boolean; method: TestCase['method'];
  status: 'passed' | 'failed' | 'missing' | 'manual_pending'; tests: string[]; reasons: string[];
  checkpoint: string | null; slot: Slot; contractVersion: number; manifestHash: string | null;
  /** How many of the approved steps of this case have an assertion bound to them in the locked manifest (a trace, not a proof that the assertion is right). */
  stepsLinked?: { linked: number; total: number };
}
export interface MutationCapability {
  status: 'available' | 'unsupported' | 'missing_tool' | 'ambiguous'; reason: string;
  adapter?: 'stryker-vitest'; root?: string; candidates?: string[]; install?: string;
  toolVersion?: string; vitestVersion?: string; configFile?: string;
}
export interface MutationResult {
  schemaVersion: 1; source: 'stryker-vitest'; status: 'in_progress' | 'completed' | 'incomplete' | 'error';
  checkpoint: string; slot: Slot; contractVersion: number; configHash: string; capability: MutationCapability;
  startedAt: string; endedAt?: string; durationMs: number; baseline: 'passed' | 'failed' | 'unknown';
  counts: { killed: number; survived: number; no_coverage: number; timeout: number; errors: number; pending: number };
  mutants: { file: string; line: number; status: string; mutator: string }[];
  pendingUnknown?: boolean;
  files: string[]; message: string; workspace?: string;
}
export interface QualityDetail {
  enabled: boolean; plan?: TestPlan; manifestHash: string | null; manifestProblems: string[]; manifestAdvisories?: string[]; planAdvisories?: string[]; cases: CaseEvidence[];
  capability: MutationCapability; mutation: MutationResult | null; testMs: number;
}
