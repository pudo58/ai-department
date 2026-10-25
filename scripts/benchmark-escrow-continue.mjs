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
await mkdir(out,{recursive:true});if(await lstat(path.join(out,'started.json')).catch(()=>null))throw new Error('Continuation already started; use existing server/state, do not blindly restart');
const store=new Store(path.join(data,'ai-department.sqlite')),orch=new Orchestrator(store,createRuntimeResolver(data));
await orch.recover();const before=orch.detail(id);
if(before.run.status!=='awaiting_approval'||before.attempts.some(a=>a.role==='developer'))throw new Error('Unexpected starting state');
const protocol=JSON.parse(await readFile(path.join(original,'protocol.json'),'utf8'));
const sha=x=>createHash('sha256').update(x).digest('hex');
if(sha(await readFile(path.join(original,'grade.mjs')))!==protocol.graderHash)throw new Error('Grader changed');
const next=structuredClone(before.run.contract),c=n=>next.testPlan.cases.find(c=>c.id===`C-${n}`),r=n=>next.requirements.find(r=>r.id===`R-${n}`);
for(const n of [7,18])for(const ref of c(n).oracle.references)if(ref.requirementId==='R-6')ref.quote=r(6).text;
c(10).requirementIds.push('R-2');c(18).requirementIds.push('R-6');
c(21).oracle.references=c(21).oracle.references.filter(ref=>ref.requirementId!=='R-12');
c(19).group='concurrency';
c(20).preconditions='Tạo request object req có batch hợp lệ gồm ít nhất hai operation khác nhau theo đúng thứ tự; lưu bản ops chuẩn theo giá trị trước apply.';
c(20).steps=[
 {action:'Apply req thành công; giữ kết quả và sửa req.ops do caller sở hữu sau apply.',expected:'Chỉ request object caller sở hữu thay đổi; ledger và lịch sử replay giữ ops ban đầu.'},
 {action:'Replay cùng ID với bản ops chuẩn, giữ nguyên thứ tự array nhưng đảo thứ tự key object và dùng expectedRevision cũ.',expected:'Trả revision gốc, không tạo thêm hiệu ứng và không đổi state ledger.'},
 {action:'Dùng lại cùng ID nhưng đảo thứ tự hai operation khác nhau trong array.',expected:'Thất bại IDEMPOTENCY_CONFLICT; state ledger không đổi.'},
];
c(20).invariants=['Mutation vào request caller sở hữu không đổi ledger hoặc fingerprint replay.','Replay đúng giữ nguyên state và revision hiện tại; khác thứ tự array không phải replay tương đương.'];
const problems=validateTestPlan(next,true);if(problems.length)throw new Error(problems.join('\n'));
const start={startedAt:new Date().toISOString(),runId:id,model:protocol.model,effort:protocol.effort,budgetUsd:before.run.budgetUsd,priorSpentUsd:before.budget.spentUsd,baselineContractHash:hashContract(before.run.contract),originalBenchmarkPreserved:true,assistance:'Operator repaired test-plan metadata/steps from original SPEC; no candidate source/test edits and no hidden-grader or Single-code details passed to agents.',changes:['C-7/C-18: exact existing R-6 text selected for quote','C-10: add referenced R-2 to requirementIds','C-18: add referenced R-6 to requirementIds','C-21: remove invalid English R-12 quote; existing valid R-5 oracle retained','C-19: classify existing repeated-request scenario as concurrency/repetition','C-20: make already-declared mutation/replay/array-order sequence and invariants explicit'],limitMs:1800000};
await writeFile(path.join(out,'before.json'),JSON.stringify(before,null,2));
await writeFile(path.join(out,'plan-repair.json'),JSON.stringify({before:before.run.contract,after:next,receipt:start},null,2));
await writeFile(path.join(out,'started.json'),JSON.stringify(start,null,2));
orch.reviseContract(id,next);const reviewed=orch.detail(id);
if(reviewed.contractReview.problems.length)throw new Error(reviewed.contractReview.problems.join('\n'));
await writeFile(path.join(out,'approval.json'),JSON.stringify({at:new Date().toISOString(),contractHash:reviewed.contractReview.contractHash,contractVersion:reviewed.run.contract.version,warnings:reviewed.contractReview.warnings,approve:true,reason:'Original requirements and all 24 cases retained; seven plan validation defects repaired without changing business assertions or using candidate/grader feedback.'},null,2));
const app=await buildApp({store,orchestrator:orch,dataDir:data,port:14340,staticDir:path.join(root,'dist/client')});await app.listen({host:'127.0.0.1',port:14340});
orch.approveContract(id,{contractHash:reviewed.contractReview.contractHash,acknowledgeWarnings:true});
console.log(JSON.stringify({event:'continued',runId:id,url:`http://127.0.0.1:14340/#/run/${id}`,hash:reviewed.contractReview.contractHash}));
let last=Date.now(),activeMs=0,lastNotice=0;
for(;;){
 await new Promise(r=>setTimeout(r,1000));const d=orch.detail(id),now=Date.now();if(['running','queued'].includes(d.run.status))activeMs+=now-last;last=now;
 if(now-lastNotice>20000){console.log(JSON.stringify({event:'progress',status:d.run.status,stage:d.run.stage,attempts:d.attempts.map(a=>({role:a.role,status:a.status})),activeMs}));lastNotice=now;}
 if(activeMs>start.limitMs){orch.stopRun(id);await orch.idle();break;}
 if(['running','queued'].includes(d.run.status))continue;
 await writeFile(path.join(out,'detail.json'),JSON.stringify(d,null,2));
 if(d.testRepair){
   const decisionFile=path.join(out,`repair-${d.testRepair.id}-decision.json`);console.log(JSON.stringify({event:'needs_test_repair_review',decisionFile,hash:d.testRepair.hash}));let decision;
   while(!decision){await new Promise(r=>setTimeout(r,1000));try{decision=JSON.parse(await readFile(decisionFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
   if(decision.proposalHash!==d.testRepair.hash)throw new Error('Stale repair decision');last=Date.now();
   if(decision.approve){orch.approveTestRepair(id,d.testRepair.id,d.testRepair.hash);continue;}orch.rejectTestRepair(id,d.testRepair.id,d.testRepair.hash);
 }
 break;
}
await orch.idle();const detail=orch.detail(id);await writeFile(path.join(out,'detail.json'),JSON.stringify(detail,null,2));
const workspace=path.join(data,'workspaces',`${id}-A`),result={runId:id,endedAt:new Date().toISOString(),status:detail.run.status,blocker:detail.run.blocker,addedAutomaticMs:activeMs,checkpoint:detail.run.checkpoint,workspace,assisted:true};
if(detail.attempts.some(a=>a.role==='developer')){
 try{execFileSync(process.execPath,[path.join(original,'grade.mjs'),workspace,path.join(out,'grade.json')],{windowsHide:true,timeout:60000,stdio:'pipe'});}catch(e){if(e.status!==1)result.gradingError=String(e);}
 try{const g=JSON.parse(await readFile(path.join(out,'grade.json'),'utf8'));result.grade={passed:g.passed,total:g.total,score:g.score};}catch{}
}
await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({event:'finished',...result}));await app.close();store.close();
