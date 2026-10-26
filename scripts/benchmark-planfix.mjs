// Department (Verify) arm only, to measure whether the pipeline now reaches the Developer. There is no hidden grader on this
// machine, so nothing here scores correctness. The contract is approved unchanged (warnings acknowledged) and recorded.
import {readFile,writeFile,mkdir,lstat,symlink,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {Store} from '../src/server/store.ts';
import {Orchestrator} from '../src/server/orchestrator.ts';
import {createRuntimeResolver} from '../src/server/environment.ts';
import {DEFAULT_PROTECTED} from '../src/core/scope.ts';

const task=process.argv[2];
const TASKS={
  pulsegraph:{name:'PulseGraph',archive:'2026-10-25-pulsegraph',file:'scheduler',exports:['createScheduler','restoreScheduler'],signals:['dependency-graph','lease-fencing','retry','time-boundary','snapshot']},
  escrowbatch:{name:'EscrowBatch',archive:'2026-10-25-escrowbatch',file:'ledger',exports:['createLedger','restoreLedger'],signals:['atomicity','idempotency','state-transition','time-boundary']},
}[task];
if(!TASKS)throw new Error('usage: node scripts/benchmark-planfix.mjs pulsegraph|escrowbatch');
const root=path.resolve('.'),stamp='2026-10-26',tag=process.argv[3]?`-${process.argv[3]}`:'',out=path.join(root,`test-results/${stamp}-planfix-${task}${tag}`),data=path.join(root,`.data/${task}-${stamp}-planfix${tag}`),base=path.join(data,'base');
const hash=x=>createHash('sha256').update(x).digest('hex'),archive=path.join(root,'benchmarks/results',TASKS.archive);
const protocol=JSON.parse(await readFile(path.join(archive,'protocol.json'),'utf8')),spec=await readFile(path.join(archive,'SPEC.md'),'utf8');
if(hash(spec)!==protocol.specHash)throw new Error('Archived SPEC does not match the original protocol hash');
if(await lstat(out).catch(()=>null))throw new Error('Already run; do not reuse the output directory.');
await mkdir(out,{recursive:true});await mkdir(path.join(base,'src'),{recursive:true});await mkdir(path.join(base,'tests'),{recursive:true});
const [create,restore]=TASKS.exports;
const files={
  'SPEC.md':spec,
  [`src/${TASKS.file}.js`]:`export function ${create}() { throw new Error('Not implemented'); }\nexport function ${restore}() { throw new Error('Not implemented'); }\n`,
  'tests/scaffold.test.js':`import {it,expect} from 'vitest';\nimport {${create},${restore}} from '../src/${TASKS.file}.js';\nit('public exports exist',()=>{expect(typeof ${create}).toBe('function');expect(typeof ${restore}).toBe('function');});\n`,
  'package.json':JSON.stringify({name:`${task}-benchmark`,private:true,type:'module',scripts:{test:'vitest run'},devDependencies:{vitest:'3.2.4'}},null,2)+'\n',
  'vitest.config.js':`export default {test:{include:['tests/**/*.test.js'],maxWorkers:1}};\n`,
  '.gitignore':'node_modules/\n.aidept*\ncoverage/\n',
  'README.md':`# ${TASKS.name}\nImplement what SPEC.md describes.\n`,
};
for(const [file,content] of Object.entries(files))await writeFile(path.join(base,file),content);
await symlink(path.join(root,'node_modules'),path.join(base,'node_modules'),'junction');
const git=(cwd,args)=>execFileSync('git',['-C',cwd,...args],{windowsHide:true,encoding:'utf8'}).trim();
git(base,['init']);git(base,['config','core.autocrlf','false']);git(base,['config','user.name','Benchmark Scaffold']);git(base,['config','user.email','benchmark@localhost']);git(base,['add','.']);git(base,['commit','-m','Scaffold']);
const setupPath=path.join(out,'setup.mjs');
await writeFile(setupPath,`import {symlink,lstat,rmdir} from 'node:fs/promises';import path from 'node:path';const p=path.join(process.cwd(),'node_modules');const s=await lstat(p).catch(()=>null);if(s&&!s.isSymbolicLink())await rmdir(p);if(!s||!s.isSymbolicLink())await symlink(${JSON.stringify(path.join(root,'node_modules'))},p,'junction');`);

const store=new Store(path.join(data,'ai-department.sqlite')),orch=new Orchestrator(store,createRuntimeResolver(data));
const repo=path.join(data,'department');execFileSync('git',['clone','--no-hardlinks',base,repo],{stdio:'ignore',windowsHide:true});execFileSync('git',['-C',repo,'config','core.autocrlf','false'],{windowsHide:true});
const roles=Object.fromEntries(['planner','author','developer','verifier','investigator'].map(role=>[role,{provider:'codex',model:protocol.model,effort:protocol.effort,skills:[]}]));
const project={id:`prj_${task}_planfix${tag.replace('-','_')}`,name:`${TASKS.name} — planfix`,repository:repo,version:1,approved:true,modules:['src/**','tests/**','README.md'],protectedPaths:[...DEFAULT_PROTECTED,'SPEC.md','tests/scaffold.test.js'],checks:[{id:'test',command:['node','node_modules/vitest/vitest.mjs','run','--reporter=json','--outputFile=.aidept-report.json'],required:true,timeoutMs:90000,reportPath:'.aidept-report.json'}],roles,runnerImage:'unused-local',setupCommand:['node',setupPath],executionMode:'local',agentNetwork:'none',guidance:'SPEC.md is authoritative. Do not read sibling projects or controller data. No subagents. Use only the public API. Do not add behavior outside the contract or change dependencies, configuration, SPEC, or the scaffold test.',contextEnabled:false,allowScaffold:false,policyRules:['Do not change locked tests, SPEC or verification configuration.'],singleBudgetUsd:10.8,currency:'USD',createdAt:new Date().toISOString()};
store.projects.put(project);
const run=orch.createRun({projectId:project.id,title:`${TASKS.name} / department / planfix`,originalRequirement:spec,mode:'verify',provider:'codex',budgetUsd:protocol.baseBudget.department,taskKind:'feature',signals:TASKS.signals});
const row={task,runId:run.id,model:protocol.model,effort:protocol.effort,startedAt:new Date().toISOString(),interventions:[]};
const save=()=>writeFile(path.join(out,'run.json'),JSON.stringify(row,null,2)),pause=ms=>new Promise(r=>setTimeout(r,ms));
await save();console.log(JSON.stringify({event:'started',task,runId:run.id}));
let last=Date.now(),automaticMs=0,lastNotice=0;orch.startRun(run.id);
while(true){
  await pause(1000);const detail=orch.detail(run.id),now=Date.now();if(['running','queued'].includes(detail.run.status))automaticMs+=now-last;last=now;
  if(now-lastNotice>30000){console.log(JSON.stringify({event:'progress',status:detail.run.status,stage:detail.run.stage,attempts:detail.attempts.map(a=>`${a.role}:${a.status}`).join(','),automaticMs}));lastNotice=now;}
  if(automaticMs>=protocol.automatedLimitMs){orch.stopRun(run.id);await orch.idle();row.limitReached=true;break;}
  if(['running','queued'].includes(detail.run.status))continue;
  if(detail.run.status==='awaiting_approval'){
    await writeFile(path.join(out,'contract-detail.json'),JSON.stringify(detail,null,2));
    if(detail.contractReview.problems.length){row.contractProblems=detail.contractReview.problems;break;}
    row.interventions.push({type:'contract_approved_unchanged',contractHash:detail.contractReview.contractHash,warnings:detail.contractReview.warnings,planReview:detail.planReview??null,at:new Date().toISOString()});await save();
    last=Date.now();orch.approveContract(run.id,{contractHash:detail.contractReview.contractHash,acknowledgeWarnings:true});continue;
  }
  if(detail.testRepair){row.interventions.push({type:'test_repair_requested_and_rejected',hash:detail.testRepair.hash,at:new Date().toISOString()});await save();orch.rejectTestRepair(run.id,detail.testRepair.id,detail.testRepair.hash);continue;}
  break;
}
await orch.idle();const detail=orch.detail(run.id);
Object.assign(row,{endedAt:new Date().toISOString(),status:detail.run.status,blocker:detail.run.blocker,automaticMs,reachedDeveloper:detail.attempts.some(a=>a.role==='developer'),degraded:detail.degraded??null,roles:detail.attempts.map(a=>`${a.role}:${a.stage}:${a.status}`),usage:detail.run.usage,planReview:detail.planReview??null,manifestProblems:detail.quality?.manifestProblems,manifestAdvisories:detail.quality?.manifestAdvisories,planAdvisories:detail.quality?.planAdvisories,completion:detail.completion,retries:detail.execution?.retries});
await writeFile(path.join(out,'detail.json'),JSON.stringify(detail,null,2));await save();
console.log(JSON.stringify({event:'finished',task,status:row.status,blocker:row.blocker,reachedDeveloper:row.reachedDeveloper,roles:row.roles,usage:row.usage,automaticMs}));
store.close();
