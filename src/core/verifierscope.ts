import type { VerifierScope } from '../shared/execution.js';
import type { CheckResult, Run } from '../shared/types.js';
import { latestChecks } from './qualityevidence.js';

/** `visualReportId` is the harness image comparison that is current for this checkpoint: the Verifier is handed it next to the runner checks, so citing it is citing evidence it was given. */
export function normalizeVerifierScope(run:Run,checks:readonly CheckResult[],scope:VerifierScope|undefined,raw:string,visualReportId?:string):VerifierScope|undefined {
  const observed:VerifierScope['additionalChecks']=[];
  for(const line of raw.split('\n'))try{
    const e=JSON.parse(line);const item=e.item;
    if(e.type==='item.completed' && item?.type==='command_execution' && typeof item.command==='string' && /\b(vitest|jest|pytest|test|typecheck|tsc|build)\b/i.test(item.command))observed.push({command:item.command,status:item.exit_code===0?'passed':typeof item.exit_code==='number'?'failed':'incomplete',detail:String(item.aggregated_output??'').slice(-1500)});
    if(e.type==='user' && Array.isArray(e.message?.content))for(const c of e.message.content)if(c.type==='tool_result' && c.is_error)observed.push({command:'Verifier tool',status:'failed',detail:typeof c.content==='string'?c.content.slice(-1500):'Provider báo lỗi công cụ.'});
  }catch{/* Unsupported raw events never prove command success. */}
  if(!scope && !observed.length)return;
  const normalized:VerifierScope=scope?structuredClone(scope):{reviewed:[],checkIds:[],limitations:['Verifier chưa khai báo đầy đủ phạm vi review.'],additionalChecks:[]};
  const current=new Set(latestChecks(run,checks).map(c=>c.id));
  if(visualReportId)current.add(visualReportId);
  if(normalized.checkIds.some(id=>!current.has(id)))throw new Error('Verifier tham chiếu check không còn hiệu lực trên checkpoint/cấu hình hiện tại.');
  normalized.additionalChecks=normalized.additionalChecks.map(c=>observed.some(o=>o.command===c.command && o.status===c.status)?c:{...c,status:'incomplete',detail:`Chưa có bằng chứng thực thi xác nhận khai báo. ${c.detail}`});
  for(const o of observed)if(!normalized.additionalChecks.some(c=>c.command===o.command && c.status===o.status))normalized.additionalChecks.push(o);
  if(!normalized.reviewed.length)normalized.limitations.push('Chưa ghi nhận phần code/điều khoản đã review.');
  return normalized;
}
