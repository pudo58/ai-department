import {readFile,writeFile,mkdir,lstat,cp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {Store} from '../src/server/store.ts';
import {Orchestrator} from '../src/server/orchestrator.ts';
import {createRuntimeResolver} from '../src/server/environment.ts';
import {buildApp} from '../src/server/app.ts';
import {DEFAULT_PROTECTED} from '../src/core/scope.ts';

const root=path.resolve('.'),out=path.join(root,'test-results/2026-10-25-pulsegraph'),data=path.join(root,'.data/pulsegraph-20261025');
const protocol=JSON.parse(await readFile(path.join(out,'protocol.json'),'utf8')),hash=x=>createHash('sha256').update(x).digest('hex');
if(hash(await readFile(path.join(out,'SPEC.md')))!==protocol.specHash||hash(await readFile(path.join(out,'grade.mjs')))!==protocol.graderHash||hash(await readFile(path.join(out,'reference.mjs')))!==protocol.referenceHash||hash(await readFile(path.join(out,'grader-audit.json')))!==protocol.auditHash||hash(await readFile(path.join(out,'setup.mjs')))!==protocol.setupHash)throw new Error('Frozen protocol hash mismatch');
if(hash(await readFile(path.join(out,'source-manifest.json')))!==protocol.sourceManifestHash)throw new Error('Source manifest hash mismatch');
for(const f of JSON.parse(await readFile(path.join(out,'source-manifest.json'),'utf8')))if(hash(await readFile(path.join(root,f.path)))!==f.sha256)throw new Error(`Product/source changed after protocol lock: ${f.path}`);
const resultFile=path.join(out,'runs.json');if(await lstat(resultFile).catch(()=>null))throw new Error('Benchmark already launched; no model retry.');
const store=new Store(path.join(data,'ai-department.sqlite')),orch=new Orchestrator(store,createRuntimeResolver(data));
const app=await buildApp({store,orchestrator:orch,dataDir:data,port:14342,staticDir:path.join(root,'dist/client')});await app.listen({host:'127.0.0.1',port:14342});
const rows=[];await writeFile(resultFile,'[]');const save=()=>writeFile(resultFile,JSON.stringify(rows,null,2)),pause=ms=>new Promise(r=>setTimeout(r,ms));
for(const arm of protocol.arms){
  const repo=path.join(data,arm);execFileSync('git',['clone','--no-hardlinks',protocol.base,repo],{stdio:'ignore',windowsHide:true});execFileSync('git',['-C',repo,'config','core.autocrlf','false'],{windowsHide:true});
  const roles=Object.fromEntries(['planner','author','developer','verifier','investigator'].map(role=>[role,{provider:'codex',model:protocol.model,effort:protocol.effort,skills:[]}]));
  const project={id:`prj_pulsegraph_${arm}`,name:`PulseGraph — ${arm}`,repository:repo,version:1,approved:true,modules:['src/**','tests/**','README.md'],protectedPaths:[...DEFAULT_PROTECTED,'SPEC.md','tests/scaffold.test.js'],checks:[{id:'test',command:['node','node_modules/vitest/vitest.mjs','run','--reporter=json','--outputFile=.aidept-report.json'],required:true,timeoutMs:90000,reportPath:'.aidept-report.json'}],roles,runnerImage:'unused-local',setupCommand:['node',path.join(out,'setup.mjs')],executionMode:'local',agentNetwork:'none',guidance:'SPEC.md is authoritative. Do not read sibling projects, controller data or the external grader. No subagents. Use only the public API. Do not add behavior outside the contract or change dependencies, configuration, SPEC, grader, or scaffold test.',contextEnabled:false,allowScaffold:false,policyRules:['Do not change locked tests, SPEC or verification configuration.'],singleBudgetUsd:10.8,currency:'USD',createdAt:new Date().toISOString()};
  store.projects.put(project);
  const run=orch.createRun({projectId:project.id,title:`PulseGraph / ${arm} / GPT-6 Luna medium`,originalRequirement:await readFile(path.join(out,'SPEC.md'),'utf8'),mode:arm==='department'?'verify':'single',provider:'codex',budgetUsd:protocol.baseBudget[arm],taskKind:'feature',signals:['dependency-graph','lease-fencing','retry','time-boundary','snapshot']});
  if(Math.abs(run.budgetUsd-protocol.effectiveCapUsd)>1e-8)throw new Error('Unequal effective budgets');
  const row={arm,runId:run.id,startedAt:new Date().toISOString(),effectiveBudgetUsd:run.budgetUsd,interventions:[],url:`http://127.0.0.1:14342/#/run/${run.id}`};rows.push(row);await save();console.log(JSON.stringify({event:'started',...row}));
  let last=Date.now(),automaticMs=0,lastNotice=0;orch.startRun(run.id);
  while(true){
    await pause(1000);const detail=orch.detail(run.id),stamp=Date.now();if(['running','queued'].includes(detail.run.status))automaticMs+=stamp-last;last=stamp;
    if(stamp-lastNotice>20000){console.log(JSON.stringify({event:'progress',arm,status:detail.run.status,stage:detail.run.stage,attempts:detail.attempts.map(a=>({role:a.role,status:a.status})),automaticMs}));lastNotice=stamp;}
    if(automaticMs>=protocol.automatedLimitMs){orch.stopRun(run.id);await orch.idle();row.limitReached=true;break;}
    if(['running','queued'].includes(detail.run.status))continue;
    await writeFile(path.join(out,`${arm}-detail.json`),JSON.stringify(detail,null,2));
    if(detail.run.status==='awaiting_approval'){
      if(detail.contractReview.problems.length){row.contractProblems=detail.contractReview.problems;break;}
      const decisionFile=path.join(out,`${arm}-contract-decision.json`);console.log(JSON.stringify({event:'needs_contract_review',arm,decisionFile,contractHash:detail.contractReview.contractHash}));let decision;
      while(!decision){await pause(1000);try{decision=JSON.parse(await readFile(decisionFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
      if(decision.contractHash!==detail.contractReview.contractHash)throw new Error('Stale contract decision');row.interventions.push({type:'contract_review',...decision,at:new Date().toISOString()});await save();last=Date.now();
      if(!decision.approve){row.reviewRejected=true;break;}orch.approveContract(run.id,{contractHash:decision.contractHash,acknowledgeWarnings:true});continue;
    }
    if(detail.testRepair){
      const decisionFile=path.join(out,`${arm}-repair-decision.json`);console.log(JSON.stringify({event:'needs_test_repair_review',arm,decisionFile,proposalHash:detail.testRepair.hash}));let decision;
      while(!decision){await pause(1000);try{decision=JSON.parse(await readFile(decisionFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
      if(decision.proposalHash!==detail.testRepair.hash)throw new Error('Stale repair decision');row.interventions.push({type:'test_repair_review',...decision,at:new Date().toISOString()});await save();last=Date.now();
      if(decision.approve){orch.approveTestRepair(run.id,detail.testRepair.id,detail.testRepair.hash);continue;}orch.rejectTestRepair(run.id,detail.testRepair.id,detail.testRepair.hash);
    }
    break;
  }
  await orch.idle();const detail=orch.detail(run.id),workspace=path.join(data,'workspaces',`${run.id}-A`);
  Object.assign(row,{endedAt:new Date().toISOString(),status:detail.run.status,blocker:detail.run.blocker,checkpoint:detail.run.checkpoint,automaticMs,execution:detail.execution,attempts:detail.attempts,usage:detail.run.usage,mutation:detail.quality?.mutation??null,workspace});
  await writeFile(path.join(out,`${arm}-detail.json`),JSON.stringify(detail,null,2));
  if(detail.attempts.some(a=>a.role==='developer')){
    const gradeFile=path.join(out,`${arm}-grade.json`);try{execFileSync(process.execPath,[path.join(out,'grade.mjs'),workspace,gradeFile],{windowsHide:true,timeout:60000,stdio:'pipe'});}catch(e){if(e.status!==1)row.gradingError=String(e);}
    try{const g=JSON.parse(await readFile(gradeFile,'utf8'));row.grade={passed:g.passed,total:g.total,score:g.total?g.passed/g.total*100:0};}catch{}
    await writeFile(path.join(out,`${arm}-candidate-diff.patch`),execFileSync('git',['-C',workspace,'diff',`${detail.run.baseSha}`,'--','src','tests','README.md'],{windowsHide:true,encoding:'utf8'}));
    row.candidate=`candidate-${arm}`;await cp(workspace,path.join(out,row.candidate),{recursive:true,filter:source=>!source.split(/[\\/]/).some(s=>s==='node_modules'||s==='.git'||s==='.aidept-report.json')});
  }else row.grade=null;
  await save();console.log(JSON.stringify({event:'finished',arm,status:row.status,blocker:row.blocker,grade:row.grade,attempts:row.attempts.length,automaticMs}));
}
await app.close();store.close();console.log('PulseGraph benchmark finished; no acceptance or delivery.');
