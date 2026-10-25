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
const passDir=path.join(out,'scope-retry');await mkdir(passDir,{recursive:true});
if(await lstat(path.join(passDir,'started.json')).catch(()=>null))throw new Error('Scope retry already started');
const store=new Store(path.join(data,'ai-department.sqlite')),orch=new Orchestrator(store,createRuntimeResolver(data));await orch.recover();
const before=orch.detail(id);if(before.run.status!=='blocked'||!before.run.blocker?.includes('tests/scaffold.test.js')||before.run.checkpoint)throw new Error('Unexpected scope-retry state');
const profile=store.projects.get(before.run.projectId);
store.projects.put({...profile,version:profile.version+1,guidance:profile.guidance+' Preserve tests/scaffold.test.js exactly: it is a protected smoke test. Your previous output deleted it and the entire patch was reverted. Create NEW test files only, e.g. tests/ledger.test.js; do not rename, replace, remove or edit scaffold.test.js. Follow the approved plan and return the structured manifest. No source implementation edits.'});
const start={startedAt:new Date().toISOString(),runId:id,reason:'User authorized continuation after Author scope rejection; one explicit fresh Author attempt, protected smoke test remains protected.',beforeAttempts:before.attempts.length,limitMs:1800000};
await writeFile(path.join(passDir,'started.json'),JSON.stringify(start,null,2));
await writeFile(path.join(passDir,'before.json'),JSON.stringify(before,null,2));
const app=await buildApp({store,orchestrator:orch,dataDir:data,port:14340,staticDir:path.join(root,'dist/client')});await app.listen({host:'127.0.0.1',port:14340});
orch.resumeRun(id);console.log(JSON.stringify({event:'resumed',runId:id,url:'http://127.0.0.1:14340/#/run/'+id}));
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
const workspace=path.join(data,'workspaces',`${id}-A`),result={runId:id,endedAt:new Date().toISOString(),status:detail.run.status,blocker:detail.run.blocker,addedAutomaticMs:activeMs,checkpoint:detail.run.checkpoint,workspace,assisted:true};
if(detail.attempts.some(a=>a.role==='developer')){
 try{execFileSync(process.execPath,[path.join(original,'grade.mjs'),workspace,path.join(passDir,'grade.json')],{windowsHide:true,timeout:60000,stdio:'pipe'});}catch(e){if(e.status!==1)result.gradingError=String(e);}
 try{const g=JSON.parse(await readFile(path.join(passDir,'grade.json'),'utf8'));result.grade={passed:g.passed,total:g.total,score:g.score};}catch{}
}
await writeFile(path.join(passDir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({event:'finished',...result}));await app.close();store.close();
