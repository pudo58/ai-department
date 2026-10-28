import type { ExportIssue, ExportLimits, ExportPhase, ExportScopeKind, ExportTerminal, FieldGroup, HelloInfo, RootInfo } from './figma.js';

/** The design source a contract is bound to. The server writes it; a Planner's output can neither set nor drop it. */
export interface DesignBinding {
  snapshotId: string; snapshotHash: string;
  /** Node ids inside the snapshot the task is about. Empty means every root the snapshot holds. */
  targetIds: string[];
  /** The issues (by id) the person accepted when the snapshot was published or bound. */
  acknowledgedIssueIds: string[];
  designPolicyVersion: 1;
}
export const DESIGN_POLICY_VERSION = 1;

/** A field of a design node a requirement or a case depends on. It must exist in the snapshot and have been read. */
export interface DesignRef { nodeId: string; fieldPath: string }

export type ExportStatus = ExportPhase | ExportTerminal;
export const EXPORT_ACTIVE: readonly ExportStatus[] = ['queued', 'preparing', 'inventory', 'reading', 'dependencies', 'assets', 'verifying', 'assembling'];
export const EXPORT_TERMINAL: readonly ExportStatus[] = ['review_ready', 'partial', 'failed', 'cancelled', 'interrupted'];

export type SourceIdentity = 'verified' | 'user_attested';
export interface ExportSource {
  fileName: string; sourceSession: string;
  fileKey?: string;
  identity: SourceIdentity;
  /** What the person typed, kept as declared. Never used to build a path or a command. */
  declaredUrl?: string; declaredFileKey?: string; declaredNodeId?: string;
  attestedAt?: string;
  editorType: string; apiVersion: string; pluginVersion: string; bundleHash?: string;
}

export interface GroupCoverage { total: number; read: number; mixed: number; notApplicable: number; unsupported: number; unavailable: number; error: number }
/** Kept apart on purpose: no single number says "the design was understood". */
export interface ExportCoverage {
  structureComplete: boolean;
  fieldCoverage: { all: GroupCoverage; byGroup: Partial<Record<FieldGroup, GroupCoverage>> };
  dependencyCoverage: { total: number; resolved: number; dependencyOnly: number; unavailable: number };
  assetCoverage: { total: number; stored: number; missing: number; oversize: number; error: number; previewOnly: number };
  sourceIdentity: SourceIdentity;
  consistency: 'unchanged_across_passes' | 'source_changed' | 'not_checked';
}

export interface ExportCounts { pages: number; nodes: number; components: number; styles: number; variables: number; collections: number; assets: number; bytes: number }

export interface FigmaExportJob {
  id: string; connectionId: string;
  status: ExportStatus; phase?: string;
  scope: ExportScopeKind; rootIds: string[]; pageIds: string[]; scopeHash: string;
  source: ExportSource; limits: ExportLimits;
  counts: ExportCounts;
  /** Next sequence the server expects, and the highest one stored. */
  nextSeq: number;
  issues: ExportIssue[];
  coverage?: ExportCoverage;
  snapshotId?: string;
  /** The person asked to stop; chunks that arrive afterwards are refused. */
  cancelRequested?: boolean;
  error?: { code: string; message: string; hint?: string };
  /** Honest limits of what the run proved. */
  notes: string[];
  createdAt: string; startedAt?: string; endedAt?: string; deadline?: string; lastContactAt?: string;
  stats?: { peakUnackedChunks?: number; durationMs?: number };
}

export interface SnapshotFile { id: string; path: string; kind: 'manifest' | 'index' | 'source' | 'page' | 'component' | 'tokens' | 'asset' | 'review' | 'summary'; bytes: number; sha256: string; mime: string }
/** A reference image and the design node it depicts. Detail regions use the node's original coordinate units. */
export interface SnapshotPreview {
  nodeId: string; name: string; nodeType: string; role: 'overview' | 'screen' | 'detail';
  fileId: string; path: string; width?: number; height?: number; scale?: number;
  region?: { x: number; y: number; width: number; height: number };
}
export interface SnapshotPreviews { images: SnapshotPreview[]; warnings: string[] }
export interface SnapshotDiagnosticItem {
  nodeId: string; name: string; nodeType: string; path: string; reason: string;
  hiddenBy?: { nodeId: string; name: string };
  component?: { nodeId: string; name: string };
}
export interface SnapshotDiagnostics {
  groups: { kind: 'component_properties' | 'hidden_vector' | 'vector_no_paint' | 'vector_failure'; title: string; explanation: string; items: SnapshotDiagnosticItem[] }[];
}
export interface DesignSnapshot {
  id: string; schemaVersion: 1; jobId: string;
  status: 'draft' | 'published';
  /** True when it was published with acknowledged limits. */
  limited: boolean;
  readerVersion: number; protocolVersion: number; pluginVersion: string; bundleHash?: string;
  source: ExportSource; scope: { kind: ExportScopeKind; rootIds: string[]; pageIds: string[]; hash: string }; limits: ExportLimits;
  startedAt: string; endedAt: string;
  coverage: ExportCoverage; issues: ExportIssue[];
  counts: ExportCounts;
  /** Of the design data and assets only: for comparing contents between exports. */
  contentHash: string;
  /** Of the manifest, with provenance and file hashes: for approving, and for contracts. */
  snapshotHash: string;
  files: SnapshotFile[];
  roots: RootInfo[];
  /** Same file and scope as an earlier snapshot, when the source identity let us say so. */
  previousId?: string;
  createdAt: string;
  publish?: DesignPublishReceipt;
}
export interface DesignPublishReceipt { snapshotHash: string; acknowledgedIssueIds: string[]; limited: boolean; publishedAt: string }

/** What an agent turn was given. It proves what was offered, not that the model read it. */
export interface DesignInputReceipt {
  schemaVersion: 1; attemptId: string; role: string; runId: string;
  snapshotId: string; snapshotHash: string; targetIds: string[]; summaryHash: string;
  files: { path: string; sha256: string }[]; mount: string; mountKind: 'docker_ro' | 'local_copy';
  hashBefore: string; hashAfter?: string; at: string;
}

export interface DiffEntry { id: string; name?: string; type?: string; change: 'added' | 'removed' | 'changed'; fields?: string[] }
export interface SnapshotDiff {
  comparable: boolean; reason?: string; baseId: string; headId: string;
  nodes: DiffEntry[]; components: DiffEntry[]; tokens: DiffEntry[]; assets: DiffEntry[];
  newIssues: ExportIssue[]; summary: { added: number; removed: number; changed: number };
}

/** What the acceptance report says about a task's design source. Read from the snapshot and the run's receipts; never a claim of visual match. */
export interface DesignReportFacts {
  snapshotId: string; snapshotHash: string; fileName: string; identity: SourceIdentity; label: string; limited: boolean;
  acknowledged: { id: string; message: string }[]; targetIds: string[];
  counts: { nodes: number; pages: number; components: number; styles: number; variables: number; assets: number };
  /** False when the snapshot is gone, unpublished, edited, or not the one the contract locked. */
  usable: boolean; problems: string[];
  inputs: { role: string; attempts: number }[];
  /** Attempts after which the folder an agent could read no longer matched what it was given. */
  changedByAgent: number;
}

// --- Integrations ---

export type InstallStepId = 'detect' | 'download' | 'verify' | 'install' | 'confirm' | 'bundle';
export type InstallStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export interface InstallStep { id: InstallStepId; label: string; status: InstallStepStatus; detail?: string; startedAt?: string; endedAt?: string }
export interface InstallJob {
  id: string; adapter: 'figma-direct';
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  steps: InstallStep[];
  error?: { code: string; message: string; hint?: string };
  log: string[];
  createdAt: string; endedAt?: string;
}

export interface DesktopState {
  state: 'not_installed' | 'installing' | 'installed' | 'unverified';
  executable?: string; version?: string; signed?: boolean; running?: boolean;
  catalogVersion: string; note?: string;
}
export interface BundleState {
  state: 'missing' | 'prepared' | 'stale' | 'incompatible';
  dir?: string; pluginVersion?: string; protocolVersion?: number; origin?: string; bundleHash?: string; note?: string;
}
export interface ConnectionState {
  state: 'unpaired' | 'pairing' | 'connected' | 'interrupted';
  pairingCode?: { code: string; expiresAt: string };
  instanceName?: string; hello?: HelloInfo; connectedAt?: string; lastContactAt?: string;
  activeJobId?: string;
}
export interface IntegrationSummary {
  id: 'figma-desktop'; label: string; adapter: 'figma-direct'; badge: string;
  desktop: DesktopState; bundle: BundleState; connection: ConnectionState;
  activeInstallJobId?: string; activeExportJobId?: string;
  platform: { supported: boolean; reason?: string };
}
