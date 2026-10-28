/** A project approves the route mapping once. Missing tolerance means measure only, never automatic acceptance. */
export interface VisualProfile {
  pathTemplate: string;
  readySelector?: string;
  maxDiffRatio?: number;
  pixelThreshold: number;
  /** Optional explicit scope and widget capture mappings; omitted means every screen in the design target. */
  screens?: { nodeId: string; selector?: string; viewport?: { width: number; height: number } }[];
}
export interface VisualScreenResult {
  nodeId: string; name: string; route: string; width: number; height: number;
  status: 'passed' | 'different' | 'needs_review' | 'unstable' | 'incomplete';
  changedRatio?: number; changedPixels?: number; totalPixels?: number;
  reference?: string; actual?: string; diff?: string; referenceHash?: string; actualHash?: string;
  repeats?: string[]; stabilityDiff?: string; stabilityRatio?: number;
  message: string;
}
export interface VisualReport {
  schemaVersion: 1; source: 'harness'; id: string; runId: string; checkpoint: string; slot: 'A' | 'B';
  contractVersion: number; snapshotId: string; snapshotHash: string; profileHash: string;
  status: 'passed' | 'needs_review' | 'incomplete';
  startedAt: string; endedAt: string; browser?: string; profile: VisualProfile;
  screens: VisualScreenResult[]; limitations: string[];
  artifactDir?: string;
}

/** Explicit node references only: a passing R-x test never implies full visual coverage. */
export function visualForRequirement(text: string, refs: readonly { nodeId: string }[] | undefined, report?: VisualReport) {
  const nodeIds = [...new Set([...(refs ?? []).map(r => r.nodeId), ...[...text.matchAll(/\b\d+:\d+\b/g)].map(m => m[0])])];
  const screens = report?.screens.filter(s => nodeIds.includes(s.nodeId)) ?? [];
  const covered = new Set(screens.map(s => s.nodeId));
  const status = !screens.length ? 'unverified' as const : report?.status === 'incomplete' || screens.some(s => s.status === 'incomplete' || s.status === 'unstable') ? 'incomplete' as const : screens.some(s => s.status === 'different') ? 'different' as const : screens.every(s => s.status === 'passed') && nodeIds.every(id => covered.has(id)) ? 'passed' as const : 'needs_review' as const;
  return { nodeIds, screens, status };
}
