import type {Finding} from '../../shared/types.js';
import type {FindingReplay} from '../../shared/reproduction.js';
import {ReproductionSchema,reproductionProblems,scenarioHash,readFindingReplays,REPLAY_TITLE,replayConfigHash} from '../../core/reproduction.js';
import {Stopped} from './support.js';
import {policyOf} from '../../core/policy.js';
import type {RunServices} from './services.js';

/** A probe is evidence for a human decision, never authority to rewrite tests or auto-confirm an oracle. */
export class FindingReplays {
 constructor(private readonly s:RunServices){}
 async runBatch(runId:string,findings:Finding[],signal:AbortSignal,options:{force?:boolean}={}):Promise<FindingReplay[]>{
  const limits=policyOf(this.s.run(runId)).replay,deadline=Date.now()+limits.batchMs,results:FindingReplay[]=[];
  for(const [index,finding] of findings.filter(f=>f.reproduction).entries()){
   const run=this.s.run(runId),scenario=finding.reproduction!;
   const cached=readFindingReplays(run,this.s.store.artifacts.list(runId)).find(r=>r.findingId===finding.id&&r.checkpoint===run.checkpoint&&r.scenarioHash===scenarioHash(scenario));
   if(cached&&!options.force){results.push(cached);continue;}
   if(signal.aborted)throw new Stopped();
   const initial:FindingReplay={schemaVersion:1,source:'runner',findingId:finding.id,checkpoint:run.checkpoint!,contractVersion:run.contract.version,slot:run.selectedSlot,configHash:replayConfigHash(run),scenarioHash:scenarioHash(scenario),status:'in_progress',startedAt:this.s.stamp(),durationMs:0,message:'Đang tái hiện trong bản sao checkpoint.',observations:[]};
   const artifact=this.s.artifact(runId,{kind:'report',title:REPLAY_TITLE,content:JSON.stringify(initial),checkpoint:run.checkpoint});
   let result=initial;
   try{
    const parsed=ReproductionSchema.safeParse(scenario),problems=parsed.success?reproductionProblems(run,parsed.data):['Kịch bản phản ví dụ không hợp lệ.'];
    const runtime=this.s.runtimeFor(run);
    if(problems.length||!runtime.replayFinding||index>=limits.maxProbes||Date.now()>=deadline)result={...initial,status:'unsupported',endedAt:this.s.stamp(),message:problems.join(' ')||(!runtime.replayFinding?'Runtime chưa hỗ trợ adapter phản ví dụ.':'Hết giới hạn 3 probe / 60 giây trong lượt kiểm chứng này.')};
    else result=await this.s.withHeartbeat(runId,'check:replay','Tái hiện phản ví dụ trên bản sao checkpoint',()=>runtime.replayFinding!({run,slot:run.selectedSlot,findingId:finding.id,scenario,signal,timeoutMs:Math.min(limits.probeMs,deadline-Date.now()),onEvent:this.s.runtimeLog(runId,'replay')}));
   }catch(error){result={...initial,status:signal.aborted?'interrupted':'error',endedAt:this.s.stamp(),message:(error as Error).message};}
   if(result.findingId!==initial.findingId||result.checkpoint!==initial.checkpoint||result.contractVersion!==initial.contractVersion||result.slot!==initial.slot||result.configHash!==initial.configHash||result.scenarioHash!==initial.scenarioHash)result={...initial,status:'error',endedAt:this.s.stamp(),message:'Runtime trả bằng chứng không khớp checkpoint/cấu hình/kịch bản.'};
   result.oracle=scenario.oracle;
   this.s.store.artifacts.put({...this.s.baseArtifact(runId,{kind:'report',title:REPLAY_TITLE,content:JSON.stringify(result),checkpoint:run.checkpoint}),id:artifact.id});
   this.s.log(runId,'finding.replay',`${finding.title}: ${result.status}. ${result.message}`);
   results.push(result);if(signal.aborted)throw new Stopped();
  }
  return results;
 }
}
