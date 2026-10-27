import type { Artifact, Run, Slot } from '../shared/types.js';
import { readManifest } from './qualityevidence.js';
import { canonicalJson, sha256, hashContract } from './contract.js';
import { validateOracle } from './testplan.js';
import type { Oracle } from '../shared/quality.js';

export const TEST_REPAIR_TITLE = 'Test repair proposal';
/** Written before the Author's one diagnosis of a locked suite, so neither a restart nor "Chạy tiếp" buys a second one. */
export const DIAGNOSIS_ATTEMPT_TITLE = 'Author test diagnosis attempt';
export interface TestRepairProposal {
  schemaVersion: 1; checkpoint: string; contractVersion: number; slot: Slot;
  configHash: string; manifestHash: string; paths: string[]; patch: string;
  caseIds: string[]; reason: string; evidence: string;
  kind?: 'setup' | 'assertion'; contractHash?: string;
  assertionChanges?: { caseId: string; before: string; after: string; oracle: Oracle }[];
  assessment?: import('./diagnosis.js').Diagnosis['assessment'];
}
export interface PendingTestRepair extends TestRepairProposal { id: string; hash: string }
export const testRepairConfigHash = (run: Run): string => sha256(canonicalJson({ profile: run.configSnapshot, approvedPaths: run.approvedPaths ?? [] }));
export function validAssertionChanges(run: Run, proposal: Pick<TestRepairProposal, 'kind' | 'assertionChanges' | 'caseIds'>): boolean {
  if (proposal.kind !== 'assertion') return proposal.kind === undefined || proposal.kind === 'setup';
  const changes = proposal.assertionChanges;
  return !!changes?.length && proposal.caseIds.length > 0 && proposal.caseIds.every(id => changes.some(c => c.caseId === id)) && changes.every(c => {
    const testCase = run.contract.testPlan?.cases.find(t => t.id === c.caseId);
    return proposal.caseIds.includes(c.caseId) && !!testCase && typeof c.before === 'string' && !!c.before.trim() && typeof c.after === 'string' && !!c.after.trim()
      && c.before !== c.after && !validateOracle(run.contract, testCase.requirementIds, c.oracle).length;
  });
}
export function unsafeTestPatch(patch: string): boolean {
  return /^(deleted file mode|new file mode|rename from|rename to)/m.test(patch)
    || /^\+(?!\+).*\b(?:(?:test|it|describe)\s*\.\s*(?:skip|todo|only)\s*\(|(?:pytest\.mark|unittest)\.skip|@(?:Disabled|Ignore)\b|#\[ignore\])/m.test(patch);
}

/** A proposal never carries authority across changes to code, contract, recipes or locked manifest. */
export function pendingTestRepair(run: Run, artifacts: readonly Artifact[]): PendingTestRepair | undefined {
  const manifest = readManifest(run, artifacts);
  const artifact = artifacts.filter(a => a.title === TEST_REPAIR_TITLE && a.valid && a.checkpoint === run.checkpoint && a.contractVersion === run.contract.version).at(-1);
  if (!artifact || !manifest || sha256(artifact.content) !== artifact.hash) return;
  try {
    const p = JSON.parse(artifact.content) as TestRepairProposal;
    if (p.schemaVersion !== 1 || p.checkpoint !== run.checkpoint || p.slot !== run.selectedSlot || p.contractVersion !== run.contract.version
      || p.configHash !== testRepairConfigHash(run) || p.manifestHash !== manifest.hash) return;
    if ((p.contractHash && p.contractHash !== hashContract(run.contract)) || !validAssertionChanges(run, p) || unsafeTestPatch(p.patch)) return;
    return { ...p, id: artifact.id, hash: artifact.hash };
  } catch { return; }
}
