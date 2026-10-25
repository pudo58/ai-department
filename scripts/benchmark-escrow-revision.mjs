// Explicitly operator-assisted continuation. Original blind benchmark evidence is never overwritten.
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {Store} from '../src/server/store.ts';
import {Orchestrator} from '../src/server/orchestrator.ts';
import {createRuntimeResolver} from '../src/server/environment.ts';
import {buildApp} from '../src/server/app.ts';
import {validateTestPlan} from '../src/core/testplan.ts';
import {hashContract} from '../src/core/contract.ts';

const root=path.resolve('.'),original=path.join(root,'test-results/2026-10-25-escrowbatch'),out=path.join(original,'department-assisted'),data=path.join(root,'.data/escrowbatch-20261025'),id='run_8cb7d7c4';
await mkdir(out,{recursive:true});
const passDir=path.join(out,'approved-revision-repair');await mkdir(passDir,{recursive:true});
if(await lstat(path.join(passDir,'started.json')).catch(()=>null))throw new Error('Already started');
const store=new Store(path.join(data,'ai-department.sqlite')),orch=new Orchestrator(store,createRuntimeResolver(data));await orch.recover();
const before=orch.detail(id);if(!['blocked','failed'].includes(before.run.status)||!before.run.checkpoint)throw new Error('Unexpected state');
const {readManifest}=await import('../src/core/qualityevidence.ts');
const {testRepairConfigHash}=await import('../src/core/recovery.ts');
const {randomUUID}=await import('node:crypto');
const manifest=readManifest(before.run,before.artifacts),workspace=path.join(data,'workspaces',id+'-A'),file='tests/ledger.test.js';
const source=await readFile(path.join(workspace,file),'utf8');
const fixed=source.replace("apply(ledger, 'closed', 3,", "apply(ledger, 'closed', 4,").replace("apply(ledger, 'expired', 3,", "apply(ledger, 'expired', 4,").replace("apply(ledger, 'unknown', 3,", "apply(ledger, 'unknown', 4,");
if(fixed===source)throw new Error('No setup repair');
let patch;try{await writeFile(path.join(workspace,file),fixed);patch=execFileSync('git',['-C',workspace,'diff','--',file],{encoding:'utf8',windowsHide:true});}finally{await writeFile(path.join(workspace,file),source);}
const sha=x=>createHash('sha256').update(x).digest('hex');
const proposal={schemaVersion:1,source:'operator_reviewed',kind:'setup',checkpoint:before.run.checkpoint,contractVersion:before.run.contract.version,contractHash:hashContract(before.run.contract),slot:'A',configHash:testRepairConfigHash(before.run),manifestHash:manifest.hash,paths:[file],patch,caseIds:before.checks.at(-1).outcomes.filter(o=>o.status==='failed').flatMap(o=>manifest.manifest.entries.filter(e=>e.testId===o.id).map(e=>e.caseId)),reason:'C-14 setup revision must be 4: three successful batches plus one expiry. Correct only request expectedRevision from 3 to 4; error assertions remain unchanged.',evidence:'SPEC advance increments revision once when a hold expires. C-14 had revision 3 after its third batch, then advance expires h2, giving revision 4. Three setup arguments changed; no assertion changes. Operator review authorized by user request to fix and continue.'};
const content=JSON.stringify(proposal),artifact={id:'art_'+randomUUID().slice(0,8),runId:id,kind:'report',title:'Test repair proposal',content,hash:sha(content),checkpoint:before.run.checkpoint,contractVersion:before.run.contract.version,valid:true,createdAt:new Date().toISOString()};
await writeFile(path.join(passDir,'proposal.json'),JSON.stringify(proposal,null,2));await writeFile(path.join(passDir,'review.diff'),patch);store.artifacts.put(artifact);
const start={startedAt:new Date().toISOString(),runId:id,reason:proposal.reason,source:'operator_reviewed',proposalHash:artifact.hash,beforeCheckpoint:before.run.checkpoint,beforeAttempts:before.attempts.length,limitMs:1800000};
await writeFile(path.join(passDir,'started.json'),JSON.stringify(start,null,2));await writeFile(path.join(passDir,'before.json'),JSON.stringify(before,null,2));
const app=await buildApp({store,orchestrator:orch,dataDir:data,port:14340,staticDir:path.join(root,'dist/client')});await app.listen({host:'127.0.0.1',port:14340});
orch.approveTestRepair(id,artifact.id,artifact.hash);console.log(JSON.stringify({event:'approved_setup_repair',runId:id,proposalHash:artifact.hash}));
let last=Date.now(),activeMs=0,lastNotice=0;
for(;;){
 await new Promise(r=>setTimeout(r,1000));const d=orch.detail(id),now=Date.now();if(['running','queued'].includes(d.run.status))activeMs+=now-last;last=now;
 if(now-lastNotice>20000){console.log(JSON.stringify({event:'progress',status:d.run.status,stage:d.run.stage,attempts:d.attempts.map(a=>({role:a.role,status:a.status})),activeMs}));lastNotice=now;}
 if(activeMs>start.limitMs){orch.stopRun(id);await orch.idle();break;}
 if(['running','queued'].includes(d.run.status))continue;
 await writeFile(path.join(passDir,'detail.json'),JSON.stringify(d,null,2));
 if(d.testRepair){
   const decisionFile=path.join(passDir,`repair-${d.testRepair.id}-decision.json`);console.log(JSON.stringify({event:'needs_test_repair_review',decisionFile,hash:d.testRepair.hash}));let decision;
   while(!decision){await new Promise(r=>setTimeout(r,1000));try{decision=JSON.parse(await readFile(decisionFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
   if(decision.proposalHash!==d.testRepair.hash)throw new Error('Stale repair decision');last=Date.now();
   if(decision.approve){orch.approveTestRepair(id,d.testRepair.id,d.testRepair.hash);continue;}orch.rejectTestRepair(id,d.testRepair.id,d.testRepair.hash);
 }
 break;
}
await orch.idle();const detail=orch.detail(id);await writeFile(path.join(passDir,'detail.json'),JSON.stringify(detail,null,2));
const result={runId:id,endedAt:new Date().toISOString(),status:detail.run.status,blocker:detail.run.blocker,addedAutomaticMs:activeMs,checkpoint:detail.run.checkpoint,workspace,assisted:true};
if(detail.attempts.some(a=>a.role==='developer')){
 try{execFileSync(process.execPath,[path.join(original,'grade.mjs'),workspace,path.join(passDir,'grade.json')],{windowsHide:true,timeout:60000,stdio:'pipe'});}catch(e){if(e.status!==1)result.gradingError=String(e);}
 try{const g=JSON.parse(await readFile(path.join(passDir,'grade.json'),'utf8'));result.grade={passed:g.passed,total:g.total,score:g.score};}catch{}
}
await writeFile(path.join(passDir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({event:'finished',...result}));await app.close();store.close();
