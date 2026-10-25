import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// One process runs one arm sequentially. Decisions and failed runs are retained; never retry a run.
const arm = process.argv[2];
if (!['baseline', 'optimized'].includes(arm)) throw new Error('Use baseline or optimized');
const root = path.resolve('.');
const evidence = path.join(root, 'test-results/2026-10-24-speed');
await mkdir(evidence, { recursive: true });
const source = path.join(root, `.data/speed-${arm}/source`);
const load = async file => import(pathToFileURL(path.join(source, file)).href);
const { Store } = await load('src/server/store.ts');
const { Orchestrator } = await load('src/server/orchestrator.ts');
const { createRuntimeResolver } = await load('src/server/environment.ts');
const state = JSON.parse(await readFile(path.join(root, 'test-results/2026-10-24-outboxpilot/state.json'), 'utf8'));
const original = JSON.parse(await readFile(path.join(root, 'test-results/2026-10-24-outboxpilot/protocol.json'), 'utf8'));
const hash = x => createHash('sha256').update(x).digest('hex');
const setup = path.join(evidence, 'setup-dependencies.mjs');
const setupText = `import {symlink,lstat,rmdir} from 'node:fs/promises';import path from 'node:path';const p=path.join(process.cwd(),'node_modules');const s=await lstat(p).catch(()=>null);if(s&&!s.isSymbolicLink())await rmdir(p);if(!s||!s.isSymbolicLink())await symlink(${JSON.stringify(path.join(root, 'node_modules'))},p,'junction');`;
const protocolFile = path.join(evidence, 'protocol.json');
const grader = path.join(root, 'test-results/2026-10-24-outboxpilot/grade-audited.mjs');
const guidance = 'SPEC.md is authoritative. No subagents or sibling-project access. Calls may be synchronous or asynchronous; await results. Do not require an unspecified error precedence, numeric-overflow behavior, or validation of reason/retryable types. Duplicate enqueue returns the current original job. Any unresolved business question remains unresolved; do not invent assertions.';
const protocol = { schemaVersion: 1, lockedAt: new Date().toISOString(), baseSha: original.baseSha, specHash: hash(state.specification), graderHash: hash(await readFile(grader)), baselineSourceManifestHash: hash(await readFile(path.join(root, '.data/speed-baseline/source-manifest.json'))), model: 'gpt-6-luna', effort: 'medium', repetitionsPerArm: 3, baseBudgetUsd: 6, effectiveBudgetUsd: 10.8, automatedLimitMs: 1800000, guidance, setupHash: hash(setupText), policy: 'Sequential runs, no source/test/schema rescue, no retry; valid contract approvals recorded; test repair needs a reviewed decision file. Grader stays outside workspace.' };
try { const old = JSON.parse(await readFile(protocolFile, 'utf8')); if(old.specHash !== protocol.specHash || old.graderHash !== protocol.graderHash || old.setupHash !== protocol.setupHash) throw new Error('Protocol changed'); } catch(e) { if(e.code !== 'ENOENT') throw e; await writeFile(protocolFile, JSON.stringify(protocol, null, 2)); await writeFile(setup, setupText); }
const outputFile = path.join(evidence, `${arm}-runs.json`);
await writeFile(path.join(evidence,`${arm}-source-receipt.json`),JSON.stringify({arm,source,sourceManifestHash:hash(await readFile(path.join(root,`.data/speed-${arm}/source-manifest.json`))),launchedAt:new Date().toISOString()},null,2));
try { await lstat(outputFile); throw new Error('Arm already started; do not rerun'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
await writeFile(outputFile, '[]');
const data = path.join(root, `.data/speed-${arm}`);
await mkdir(data, {recursive: true});
const store = new Store(path.join(data, 'ai-department.sqlite'));
const orch = new Orchestrator(store, createRuntimeResolver(data));
const { DEFAULT_PROTECTED } = await load('src/core/scope.ts');
const rows = [];
const save = async () => writeFile(outputFile, JSON.stringify(rows, null, 2));
for(let i=1; i<=3; i++) {
  const repo=path.join(data, `project-${i}`);
  execFileSync('git', ['clone','--no-hardlinks',path.join(state.root,'base'),repo], {stdio:'ignore',windowsHide:true});
  execFileSync('git', ['-C',repo,'config','core.autocrlf','false'], {windowsHide:true});
  const roles=Object.fromEntries(['planner','author','developer','verifier','investigator'].map(r=>[r,{provider:'codex',model:'gpt-6-luna',effort:'medium',skills:[]}]));
  const project={id:`prj_speed_${arm}_${i}`,name:`ReplayGate speed ${arm} ${i}`,repository:repo,version:1,approved:true,modules:['src/outbox.js','tests/**','README.md'],protectedPaths:DEFAULT_PROTECTED,checks:[{id:'test',command:['node','node_modules/vitest/vitest.mjs','run','--reporter=json','--outputFile=.aidept-report.json'],required:true,timeoutMs:90000,reportPath:'.aidept-report.json'}],roles,runnerImage:'unused-local',setupCommand:['node',setup],executionMode:'local',agentNetwork:'none',guidance,contextEnabled:false,allowScaffold:false,policyRules:['Do not modify locked tests or configuration.'],singleBudgetUsd:6,currency:'USD',createdAt:new Date().toISOString()};
  store.projects.put(project);
  const run=orch.createRun({projectId:project.id,title:`ReplayGate speed ${arm} ${i}`,originalRequirement:state.specification,mode:'verify',provider:'codex',budgetUsd:6,taskKind:'feature',signals:['concurrency','idempotency','state-transition','time-boundary']});
  const row={arm,index:i,runId:run.id,startedAt:new Date().toISOString(),interventions:[]};rows.push(row);await save();
  console.log(JSON.stringify({event:'started',arm,index:i,runId:run.id}));
  let activeMs=0, last=Date.now();
  orch.startRun(run.id);
  while(true){
    await new Promise(r=>setTimeout(r,1000));
    const detail=orch.detail(run.id), stamp=Date.now();
    if(['running','queued'].includes(detail.run.status))activeMs+=stamp-last;
    last=stamp;
    if(activeMs>1800000){ orch.stopRun(run.id); await orch.idle(); row.limitReached=true; break; }
    if(['running','queued'].includes(detail.run.status))continue;
    await writeFile(path.join(evidence,`${arm}-${i}-detail.json`),JSON.stringify(detail,null,2));
    if(detail.run.status==='awaiting_approval' && !detail.contractReview.problems.length){
      row.interventions.push({type:'contract_approval',at:new Date().toISOString(),hash:detail.contractReview.contractHash,warnings:detail.contractReview.warnings});
      orch.approveContract(run.id,{contractHash:detail.contractReview.contractHash,acknowledgeWarnings:true});await save();continue;
    }
    if(detail.testRepair){
      const decisionFile=path.join(evidence,`${arm}-${i}-decision.json`);
      console.log(JSON.stringify({event:'needs_test_repair_review',arm,index:i,proposalHash:detail.testRepair.hash,decisionFile}));
      let decision;
      while(!decision){await new Promise(r=>setTimeout(r,1000));try{decision=JSON.parse(await readFile(decisionFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
      if(decision.proposalHash!==detail.testRepair.hash)throw new Error('Stale decision');
      row.interventions.push({type:'reviewed_test_repair',...decision,at:new Date().toISOString()});await save();
      last=Date.now();
      if(decision.approve){orch.approveTestRepair(run.id,detail.testRepair.id,detail.testRepair.hash);continue;}
      orch.rejectTestRepair(run.id,detail.testRepair.id,detail.testRepair.hash);
    }
    break;
  }
  await orch.idle();
  const detail=orch.detail(run.id);Object.assign(row,{endedAt:new Date().toISOString(),status:detail.run.status,blocker:detail.run.blocker,checkpoint:detail.run.checkpoint,automatedMs:activeMs,attempts:detail.attempts.map(a=>({id:a.id,role:a.role,stage:a.stage,model:a.model,status:a.status,startedAt:a.startedAt,endedAt:a.endedAt})),usage:detail.run.usage,mutation:detail.quality?.mutation?{status:detail.quality.mutation.status,counts:detail.quality.mutation.counts,durationMs:detail.quality.mutation.durationMs}:null});
  await writeFile(path.join(evidence,`${arm}-${i}-detail.json`),JSON.stringify(detail,null,2));
  if(detail.run.checkpoint && detail.attempts.some(a=>a.role==='developer')){
    const workspace=path.join(data,'workspaces',`${run.id}-A`);const gradeFile=path.join(evidence,`${arm}-${i}-grade.json`);
    try{execFileSync(process.execPath,[grader,workspace,gradeFile],{windowsHide:true});}catch(e){if(![0,1].includes(e.status))row.gradingError=String(e);}
    try{const g=JSON.parse(await readFile(gradeFile,'utf8'));row.grade={passed:g.passed,total:g.total,score:g.score};}catch{}
  }else row.grade=null;
  await save(); console.log(JSON.stringify({event:'finished',...row,usage:undefined,attempts:row.attempts.length}));
}
store.close();
