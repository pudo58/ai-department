import type { Artifact, Run } from '../shared/types.js';
import type { AuthorDraft, PendingAuthorDraft } from '../shared/execution.js';
import { hashContract, sha256 } from './contract.js';
import { testRepairConfigHash } from './recovery.js';
import { AUTHOR_MANIFEST_REPAIR_TITLE } from './authormanifest.js';
import { policyOf } from './policy.js';
export const AUTHOR_DRAFT_TITLE='Author output draft';
export function pendingAuthorDraft(run:Run,artifacts:readonly Artifact[]):PendingAuthorDraft|undefined {
  const a=artifacts.filter(a=>a.title===AUTHOR_DRAFT_TITLE && a.valid && a.contractVersion===run.contract.version).at(-1);
  if(!a || sha256(a.content)!==a.hash)return;
  try{const d=JSON.parse(a.content) as AuthorDraft;
    if(d.schemaVersion!==1 || !d.checkpoint || a.attemptId!==d.attemptId || d.checkpoint!==(run.checkpoint??run.baseSha) || d.contractHash!==hashContract(run.contract) || d.contractVersion!==run.contract.version || d.configHash!==testRepairConfigHash(run) || d.slot!=='A' || run.selectedSlot!==d.slot)return;
    return {...d,draftHash:a.hash,artifactId:a.id,...(policyOf(run).authorRepair?{repairAvailable:!artifacts.some(marker=>marker.title===AUTHOR_MANIFEST_REPAIR_TITLE&&marker.contractVersion===run.contract.version)}:{})};
  }catch{return;}
}
