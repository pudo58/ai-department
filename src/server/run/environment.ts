import type { EnvironmentProbe } from '../../shared/execution.js';
import { environmentHash } from '../../runtime/preflight.js';
import type { RunServices } from './services.js';
import { Blocked, Stopped } from './support.js';
import { sha256 } from '../../core/contract.js';
import { redactSecrets } from '../../runtime/process.js';
import { latestChecks } from '../../core/qualityevidence.js';
export class EnvironmentChecks {
  constructor(private readonly s:RunServices){}
  async run(runId:string,signal:AbortSignal,force=false):Promise<EnvironmentProbe>{
    const run=this.s.run(runId),runtime=this.s.runtimeFor(run);
    const artifact=this.s.store.artifacts.list(runId).filter(a=>a.title==='Environment preflight' && a.valid).at(-1);
    let previous:EnvironmentProbe|undefined;try{previous=artifact && sha256(artifact.content)===artifact.hash ? JSON.parse(artifact.content):undefined;}catch{}
    const recentEnvironmentFailure=latestChecks(run,this.s.store.checks.list(runId)).some(c=>c.issues?.some(i=>i.kind==='environment') && (!previous || Date.parse(c.createdAt)>=Date.parse(previous.endedAt)));
    if(!force && !recentEnvironmentFailure && previous && previous.configHash===environmentHash(run) && previous.status!=='blocked')return previous;
    if(force || previous?.status==='blocked')this.s.retry(runId,'environment','Kiểm tra lại môi trường, không gọi AI.');
    const startedAt=this.s.stamp(),bounded=AbortSignal.any([signal,AbortSignal.timeout(60000)]);
    let result:EnvironmentProbe;
    try{result=await this.s.withHeartbeat(runId,'preflight','Kiểm tra môi trường (tối đa 60 giây)',async()=>runtime.preflight?runtime.preflight(run,run.selectedSlot,bounded):({schemaVersion:1,status:'unsupported',runtime:runtime.name,workspace:runtime.workspacePath?.(run,run.selectedSlot)??'',configHash:environmentHash(run),checkpoint:run.checkpoint,startedAt,endedAt:this.s.stamp(),checks:[],limitation:'Runtime chưa có adapter kiểm tra sớm; checks thông thường vẫn bắt buộc.'} as EnvironmentProbe));}
    catch(error){if(signal.aborted)throw new Stopped();result={schemaVersion:1,status:'blocked',runtime:runtime.name,workspace:runtime.workspacePath?.(run,run.selectedSlot)??'',configHash:environmentHash(run),checkpoint:run.checkpoint,startedAt,endedAt:this.s.stamp(),checks:[{recipeId:'environment',status:'blocked',message:bounded.aborted?'Kiểm tra môi trường hết giới hạn 60 giây.':redactSecrets((error as Error).message)}],limitation:'Chưa có bằng chứng runner khởi động được; không xác nhận sandbox agent.'};}
    this.s.artifact(runId,{kind:'report',title:'Environment preflight',content:JSON.stringify(result),checkpoint:run.checkpoint});
    if(signal.aborted)throw new Stopped();
    if(result.status==='blocked')throw new Blocked(`Môi trường chưa chạy được: ${result.checks.filter(c=>c.status==='blocked').map(c=>`${c.recipeId}: ${c.message}`).join('; ')}. Dùng Kiểm tra lại môi trường sau khi sửa cấu hình/dependency.`);
    return result;
  }
}
