import {cp,readdir,rm,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import type {Run,Slot} from '../shared/types.js';
import type {FindingReplay,FindingReproduction} from '../shared/reproduction.js';
import type {RuntimeEvent} from './types.js';
import type {GitWorkspaces} from './gitworkspace.js';
import {executeFile,assertProcessSucceeded,redactSecrets} from './process.js';
import {ReproductionSchema,reproductionProblems,scenarioHash,replayConfigHash} from '../core/reproduction.js';

export interface ReproductionExecution {run:Run;slot:Slot;findingId:string;scenario:FindingReproduction;signal?:AbortSignal;onEvent?:(event:RuntimeEvent)=>void;timeoutMs?:number}
/** Fresh clone without shared writable dependencies. Node permissions restrict writes to the clone and deny child processes. */
export async function replayFinding(ws:GitWorkspaces,x:ReproductionExecution):Promise<FindingReplay>{
 const start=Date.now(),{run,slot,scenario}=x;
 const result:FindingReplay={schemaVersion:1,source:'runner',findingId:x.findingId,checkpoint:run.checkpoint!,contractVersion:run.contract.version,slot,configHash:replayConfigHash(run),scenarioHash:scenarioHash(scenario),status:'error',startedAt:new Date(start).toISOString(),durationMs:0,message:'',observations:[]};
 const source=ws.dir(run,slot),target=`${source}-replay-${randomUUID().slice(0,8)}`;
 const remaining=()=>Math.max(1,Math.min(x.timeoutMs??30000,30000)-(Date.now()-start));
 if(path.dirname(path.resolve(target))!==path.dirname(path.resolve(source)))throw Error('Unsafe replay workspace');
 try{
  const parsed=ReproductionSchema.safeParse(scenario),problems=parsed.success?reproductionProblems(run,parsed.data):parsed.error.issues.map(i=>i.message);
  if(!run.checkpoint||problems.length){result.status='unsupported';result.message=problems.join(' ')||'Thiếu checkpoint.';return result;}
  const clone=await executeFile('git',['clone','--no-hardlinks','--no-checkout',source,target],{timeoutMs:Math.min(10000,remaining()),signal:x.signal});assertProcessSucceeded(clone,'clone replay');
  const checkout=await executeFile('git',['-C',target,'-c','core.autocrlf=false','checkout','--detach',run.checkpoint],{timeoutMs:Math.min(10000,remaining()),signal:x.signal});assertProcessSucceeded(checkout,'checkout replay');
  // Reject committed symlinks: no project path can redirect a write outside the clone.
  const links=await executeFile('git',['-C',target,'ls-files','--stage','-z'],{timeoutMs:Math.min(5000,remaining()),signal:x.signal});assertProcessSucceeded(links,'inspect replay');
  if(links.stdout.split('\0').some(line=>line.startsWith('120000 '))){result.status='unsupported';result.message='Replay chưa hỗ trợ checkpoint có symlink.';return result;}
  const module=path.join(target,scenario.module),info=await lstat(module),resolved=await realpath(module);
  if(!info.isFile()||!resolved.startsWith(await realpath(target)+path.sep))throw Error('Module outside replay checkpoint');
  await cp(fileURLToPath(new URL('./reproduction-worker.cjs',import.meta.url)),path.join(target,'.aidept-replay-worker.cjs'));
  await cp(fileURLToPath(new URL('./mutation-worker.cjs',import.meta.url)),path.join(target,'.aidept-replay-watchdog.cjs'));
  const secret=randomBytes(32).toString('hex');
  const environment=Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]!]));
  const execution=await executeFile(process.execPath,[path.join(target,'.aidept-replay-watchdog.cjs'),String(process.pid),process.execPath,'--permission',`--allow-fs-read=${target}`,`--allow-fs-write=${target}`,path.join(target,'.aidept-replay-worker.cjs')],{cwd:target,env:environment,replaceEnv:true,input:JSON.stringify({root:target,scenario,secret}),timeoutMs:remaining(),signal:x.signal,maxOutputBytes:256*1024});
  if(x.signal?.aborted){result.status='interrupted';result.message='Đã hủy lượt tái hiện.';return result;}
  if(execution.timedOut){result.status='timeout';result.message='Hết thời gian tái hiện; không tính là đã xác nhận lỗi.';return result;}
  const line=execution.stdout.split(/\r?\n/).filter(line=>line.startsWith('AIDEPT_REPLAY_RESULT:')).at(-1);
  if(!line||execution.exitCode!==0){result.message=redactSecrets((execution.stderr||execution.stdout||'Không có kết quả worker.').slice(-2000));return result;}
  const envelope=JSON.parse(line.slice('AIDEPT_REPLAY_RESULT:'.length));
  if(typeof envelope.payload!=='string'||!/^([a-f0-9]{64})$/.test(envelope.mac)||!timingSafeEqual(Buffer.from(envelope.mac,'hex'),createHmac('sha256',secret).update(envelope.payload).digest()))throw Error('Không có kết quả xác thực từ replay worker.');
  const observed=JSON.parse(envelope.payload);
  if(!['reproduced','not_reproduced','error'].includes(observed.status)||!Array.isArray(observed.observations))throw Error('Invalid replay worker result');
  result.status=observed.status;result.observations=observed.observations;result.message=redactSecrets(String(observed.message));
 }catch(error){result.status=x.signal?.aborted?'interrupted':'error';result.message=redactSecrets((error as Error).message);}
 finally{result.durationMs=Date.now()-start;result.endedAt=new Date().toISOString();await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(error=>{result.message+=` Chưa dọn được bản sao: ${redactSecrets(error.message)}`;});}
 return result;
}

export async function recoverReplays(ws:GitWorkspaces,run:Run):Promise<void>{
 for(const slot of ['A','B'] as const){
  const source=ws.dir(run,slot),parent=path.dirname(source),prefix=path.basename(source)+'-replay-';
  for(const name of await readdir(parent).catch(()=>[]))if(name.startsWith(prefix)&&/^[a-f0-9]{8}$/.test(name.slice(prefix.length))){
   const target=path.resolve(parent,name);if(path.dirname(target)!==path.resolve(parent))throw Error('Unsafe replay cleanup');
   await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
 }
}
