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
    // An Author that answered but wrote no test file leaves nothing to correct; offering a repair for it could only fail.
    const empty=!d.patch||!d.paths?.length;
    return {...d,draftHash:a.hash,artifactId:a.id,...(empty?{empty:true}:{}),...(policyOf(run).authorRepair&&!empty?{repairAvailable:!artifacts.some(marker=>marker.title===AUTHOR_MANIFEST_REPAIR_TITLE&&marker.contractVersion===run.contract.version)}:{})};
  }catch{return;}
}
/** Why a draft with no test file cannot be repaired: what the Author said, and the one thing that changes the outcome. */
export function emptyDraftBlock(output:string):string{
  const said=output.replace(/\s+/g,' ').trim().slice(-400);
  return `Author không tạo file test nào nên không có draft để sửa${said?`. Author nói: “${said}”`:''}. Chạy tiếp sẽ không đổi kết quả; hãy bổ sung ví dụ hoặc tiêu chí vào hợp đồng hoặc kế hoạch ca (lên phiên bản mới) để Author làm lại.`;
}
