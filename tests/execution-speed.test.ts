import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { intervalMs, executionMetrics } from '../src/core/execution.js';
import { probeEnvironment, environmentHash } from '../src/runtime/preflight.js';
import { LocalRuntime } from '../src/runtime/local.js';
import { setupV2 as setup, profile } from './helpers.js';
import { fence, qualityReply, qualityGreen, qualityReport, structuredEntries } from './quality-fixtures.js';
import * as outputs from '../src/core/outputs.js';
import { StructuredManifestSchema } from '../src/core/testplan.js';
import { normalizeVerifierScope } from '../src/core/verifierscope.js';
import { hashContract, sha256 } from '../src/core/contract.js';
import { AUTHOR_DRAFT_TITLE } from '../src/core/authordraft.js';
import { testRepairConfigHash } from '../src/core/recovery.js';
import { buildApp } from '../src/server/app.js';
import type { ExecutionSpan } from '../src/shared/execution.js';
import type { ProcessResult } from '../src/runtime/process.js';
import { PROMPTS } from '../src/core/prompts.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { readEnvironment } from '../src/core/environment.js';

const dirs:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const temp=()=>{const d=mkdtempSync(path.join(tmpdir(),'aidept-speed-'));dirs.push(d);return d;};
const result=(overrides:Partial<ProcessResult>={}):ProcessResult=>({exitCode:0,stdout:'3.2.4',stderr:'',timedOut:false,durationMs:1,...overrides});
const files=(x:{role:string})=>x.role==='author'?['tests/order.test.ts']:['src/order.ts'];

describe('execution measurements',()=>{
  it('unions nested/overlapping intervals and keeps legacy missing data unknown',()=>{
    const span=(a:number,b:number):ExecutionSpan=>({id:String(a),kind:'check',label:'check',startedAt:new Date(a).toISOString(),endedAt:new Date(b).toISOString(),status:'completed'});
    expect(intervalMs([span(100,300),span(200,400),span(500,600)],900)).toBe(400);
    expect(intervalMs([span(-10,-5)],900)).toBe(5);
    const e=setup(),run=e.create();delete run.executionSpans;
    expect(executionMetrics(run,[])).toMatchObject({available:false,automaticMs:null,waitingMs:null});
  });
  it('records prompt receipts and interrupts unfinished work on restart',async()=>{
    const e=setup({check:()=>qualityGreen,files,reply:qualityReply});
    const run=await e.drive(e.create({mode:'verify'}));
    const d=e.orchestrator.detail(run.id);expect(d.execution?.attemptsByRole.developer).toBe(1);
    expect(d.artifacts.filter(a=>a.title==='Agent input receipt')).toHaveLength(d.attempts.length);
    e.store.runs.put({...run,executionSpans:[...(run.executionSpans??[]),{id:'unfinished',kind:'mutation',label:'unfinished',startedAt:new Date().toISOString(),status:'running'}]});
    await e.orchestrator.recover();expect(e.orchestrator.detail(run.id).execution?.spans.find(s=>s.id==='unfinished')?.status).toBe('interrupted');
  });
  it('retains the input receipt when a provider fails before returning usage',async()=>{
    const e=setup({throwOnAgent:()=>new Error('Provider quota fixture')});
    const run=e.create();e.orchestrator.startRun(run.id);await e.orchestrator.idle();
    const detail=e.orchestrator.detail(run.id);
    expect(detail.attempts[0]?.status).toBe('failed');
    expect(detail.artifacts.filter(a=>a.title==='Agent input receipt')).toHaveLength(1);
    expect(JSON.parse(detail.artifacts.find(a=>a.title==='Agent input receipt')!.content).promptChars).toBeGreaterThan(0);
    expect(detail.run.usage).toHaveLength(0);
  });
});

describe('environment probes',()=>{
  const fixture=()=>{const e=setup({},profile({checks:[{id:'test',command:['node','node_modules/vitest/vitest.mjs','run'],required:true,timeoutMs:1000,reportPath:'report.json'}]}));return {...e,run:e.create()};};
  it.each(['missing','config','timeout'] as const)('blocks %s infrastructure without invoking a model',async kind=>{
    const {run}=fixture();let calls=0;
    const p=await probeEnvironment(run,temp(),'local',async()=>{calls++;return kind==='missing'?result({exitCode:1,stderr:'Cannot find module node_modules/vitest'}):calls===1?result():kind==='timeout'?result({timedOut:true}):result({exitCode:1,stderr:'failed to load config: broken syntax'});});
    expect(p.status).toBe('blocked');expect(calls).toBe(kind==='missing'?1:2);
  });
  it('does not treat failing project collection as a definite infrastructure failure',async()=>{
    const {run}=fixture();let n=0;
    const p=await probeEnvironment(run,temp(),'local',async()=>++n===1?result():result({exitCode:1,stderr:'Error: NOT_IMPLEMENTED at src/order.ts'}));
    expect(p.status).toBe('unsupported');expect(p.limitation).toContain('sandbox');
  });
  it('keeps unsupported runner commands unexecuted',async()=>{
    const {run}=fixture();run.configSnapshot.checks[0]!.command=['custom-runner','--test'];
    const execute=vi.fn();expect((await probeEnvironment(run,temp(),'local',execute)).status).toBe('unsupported');expect(execute).not.toHaveBeenCalled();
  });
  it('finds an actual empty dependency directory before Planner, and re-probes with zero agent calls',async()=>{
    const {run,orchestrator,runtime,store}=fixture();let blocked=true;
    Object.assign(runtime,{preflight:async()=>({schemaVersion:1,status:blocked?'blocked':'passed',runtime:'fixture',workspace:'/fixture',configHash:environmentHash(store.runs.get(run.id)!),checkpoint:null,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),checks:[{recipeId:'test',status:blocked?'blocked':'passed',message:'dependency unavailable'}],limitation:'fixture'})});
    orchestrator.startRun(run.id);await orchestrator.idle();expect(runtime.calls.some(c=>c.startsWith('agent:'))).toBe(false);
    expect(orchestrator.detail(run.id).run.status).toBe('blocked');blocked=false;
    orchestrator.preflight(run.id);expect(()=>orchestrator.preflight(run.id)).toThrow();await orchestrator.idle();
    expect(orchestrator.detail(run.id).environment?.status).toBe('passed');expect(runtime.calls.some(c=>c.startsWith('agent:'))).toBe(false);
    const local=new LocalRuntime({dataDir:temp()});const cwd=temp();mkdirSync(path.join(cwd,'node_modules'));const actual={...run,configSnapshot:{...run.configSnapshot,checks:[{...run.configSnapshot.checks[0]!,command:['node',path.join(cwd,'node_modules/vitest/vitest.mjs'),'run']}]}};
    // Real executable, absent runner; execute adapter itself is covered by LocalRuntime fixtures.
    const p=await probeEnvironment(actual,cwd,'local',async(command,timeoutMs)=>{const {executeFile}=await import('../src/runtime/process.js');return executeFile(command[0]!,command.slice(1),{cwd,timeoutMs});});
    expect(p.status).toBe('blocked');void local;
  });
  it('loads real Vitest configuration and discovers a red baseline without executing its assertions',async()=>{
    const {run}=fixture(),cwd=temp();symlinkSync(path.resolve('node_modules'),path.join(cwd,'node_modules'),'junction');
    writeFileSync(path.join(cwd,'package.json'),'{"type":"module"}');writeFileSync(path.join(cwd,'vitest.config.js'),'export default {test:{include:["fixture.test.js"],maxWorkers:1}};');
    writeFileSync(path.join(cwd,'fixture.test.js'),'import {it} from "vitest";import {writeFileSync} from "node:fs";it("red baseline",()=>{writeFileSync("executed","yes");throw new Error("NOT_IMPLEMENTED")});');
    const execute=async(command:string[],timeoutMs:number)=>{const {executeFile}=await import('../src/runtime/process.js');return executeFile(command[0]!,command.slice(1),{cwd,timeoutMs});};
    const p=await probeEnvironment(run,cwd,'local',execute);expect(p.status).toBe('passed');expect(existsSync(path.join(cwd,'executed'))).toBe(false);
    writeFileSync(path.join(cwd,'vitest.config.js'),'throw new Error("broken config");');
    expect((await probeEnvironment(run,cwd,'local',execute)).status).toBe('blocked');
  });
  it('uses the Jest discovery adapter with its separate config arguments',async()=>{
    const {run}=fixture();run.configSnapshot.checks[0]!.command=['node','node_modules/jest/bin/jest.js','--config','custom.cjs'];const calls:string[][]=[];
    const p=await probeEnvironment(run,temp(),'local',async(command)=>{calls.push(command);return result();});expect(p.status).toBe('passed');expect(calls[1]).toContain('--listTests');expect(calls[1]).toContain('custom.cjs');
  });
  it('resolves installed runners without allowing npx to download tools and preserves package config arguments',async()=>{
    const {run}=fixture(),cwd=temp();
    writeFileSync(path.join(cwd,'package.json'),JSON.stringify({scripts:{test:'vitest run --configLoader runner'}}));
    const calls:string[][]=[];
    const execute=async(command:string[])=>{calls.push(command);return result();};
    run.configSnapshot.checks[0]!.command=['npm','test','--','--config','fixture.config.js'];
    expect((await probeEnvironment(run,cwd,'local',execute)).status).toBe('passed');
    expect(calls[1]).toEqual(expect.arrayContaining(['--configLoader','runner','--config','fixture.config.js']));
    calls.length=0;run.configSnapshot.checks[0]!.command=['npx','jest'];
    expect((await probeEnvironment(run,cwd,'local',execute)).status).toBe('passed');
    expect(calls.every(c=>c[0]==='node')).toBe(true);
    expect(calls[0]?.[1]).toContain('node_modules/jest/bin/jest.js');
    calls.length=0;run.configSnapshot.checks[0]!.command=['echo','vitest'];
    expect((await probeEnvironment(run,cwd,'local',execute)).status).toBe('unsupported');expect(calls).toHaveLength(0);
    writeFileSync(path.join(cwd,'package.json'),JSON.stringify({scripts:{test:'npm install && vitest'}}));
    run.configSnapshot.checks[0]!.command=['npm','test'];
    expect((await probeEnvironment(run,cwd,'local',execute)).status).toBe('unsupported');expect(calls).toHaveLength(0);
  });
  it('re-probes a successful environment after a later environment check failure, before any resumed agent',async()=>{
    const e=setup({reply:qualityReply,files,check:()=>qualityGreen});let probes=0;
    Object.assign(e.runtime,{preflight:async(run:Parameters<typeof environmentHash>[0])=>{probes++;return {schemaVersion:1,status:'passed',runtime:'fake',workspace:'fixture',configHash:environmentHash(run),checkpoint:run.checkpoint,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),checks:[],limitation:'fixture'};}});
    const run=await e.drive(e.create({mode:'verify'})),detail=e.orchestrator.detail(run.id),agents=detail.attempts.length;
    expect(probes).toBe(1);
    const check=detail.checks.at(-1)!;e.store.checks.put({...check,status:'incomplete',issues:[{kind:'environment',message:'Dependency removed after prior preflight'}],createdAt:new Date().toISOString()});
    e.store.runs.put({...e.store.runs.get(run.id)!,status:'failed'});e.orchestrator.resumeRun(run.id);await e.orchestrator.idle();
    expect(probes).toBe(2);expect(e.orchestrator.detail(run.id).attempts).toHaveLength(agents);
    const project=e.store.projects.get('prj_test')!;e.store.projects.put({...project,version:project.version+1,guidance:'Updated approved environment'});
    e.orchestrator.recheck(run.id);await e.orchestrator.idle();expect(probes).toBe(3);expect(e.orchestrator.detail(run.id).attempts).toHaveLength(agents);
  });
  it('keeps an existing contract approval gate when only the environment is rechecked',async()=>{
    const e=setup({reply:qualityReply,files,check:()=>qualityGreen});const run=e.create({mode:'verify'});
    e.orchestrator.startRun(run.id);await e.orchestrator.idle();
    const before=e.orchestrator.detail(run.id);expect(before.run.status).toBe('awaiting_approval');
    e.orchestrator.preflight(run.id);await e.orchestrator.idle();
    const after=e.orchestrator.detail(run.id);
    expect(after.run.status).toBe('awaiting_approval');expect(after.attempts).toHaveLength(before.attempts.length);
    expect(hashContract(after.run.contract)).toBe(hashContract(before.run.contract));
    e.orchestrator.approveContract(run.id,{contractHash:after.contractReview.contractHash,acknowledgeWarnings:true});await e.orchestrator.idle();
    expect(e.orchestrator.detail(run.id).run.status).toBe('awaiting_acceptance');
  });
  it('does not display an environment receipt after configuration changes or content tampering',()=>{
    const {run}=fixture(),p={schemaVersion:1,status:'passed',runtime:'local',workspace:'/fixture',configHash:environmentHash(run)};
    const content=JSON.stringify(p),a={id:'env',runId:run.id,kind:'report' as const,title:'Environment preflight',valid:true,checkpoint:null,contractVersion:1,createdAt:new Date().toISOString(),content,hash:sha256(content)};
    expect(readEnvironment(run,[a])?.status).toBe('passed');expect(readEnvironment(run,[{...a,hash:'bad'}])).toBeUndefined();run.configSnapshot.checks[0]!.timeoutMs++;expect(readEnvironment(run,[a])).toBeUndefined();
  });
});

describe('Author drafts and actions',()=>{
  async function draft(){
    let reject=true;const parse=outputs.parseOutput;
    vi.spyOn(outputs,'parseOutput').mockImplementation((schema,output)=>{if(schema===StructuredManifestSchema && reject){reject=false;throw new Error('Parser regression fixture');}return parse(schema,output);});
    const e=setup({reply:qualityReply,files,check:()=>qualityGreen});const run=await e.drive(e.create({mode:'verify'}));return {...e,run};
  }
  it('preserves rejected tests, reparses raw output and locks without calling another agent',async()=>{
    const e=await draft(),before=e.orchestrator.detail(e.run.id),d=before.authorDraft!;
    expect(d.output).toContain('entries');expect((await e.runtime.changes(e.run,'A')).files).toEqual([]);
    const agents=e.runtime.calls.filter(c=>c.startsWith('agent:')).length;
    expect(()=>e.orchestrator.revalidateAuthorDraft(e.run.id,d.attemptId,'0'.repeat(64))).toThrow();
    e.orchestrator.revalidateAuthorDraft(e.run.id,d.attemptId,d.draftHash);await e.orchestrator.idle();
    const after=e.orchestrator.detail(e.run.id);expect(after.authorDraft).toBeUndefined();expect(after.quality.manifestHash).toBeTruthy();expect(after.run.checkpoint).not.toBe(before.run.checkpoint);
    expect(e.runtime.calls.filter(c=>c.startsWith('agent:')).length).toBe(agents);
    e.orchestrator.resumeRun(e.run.id);await e.orchestrator.idle();expect(e.orchestrator.detail(e.run.id).run.status).toBe('awaiting_acceptance');
  });
  it.each(['contract','config','checkpoint','hash'] as const)('rejects draft stale through %s before touching workspace',async kind=>{
    const e=await draft(),d=e.orchestrator.detail(e.run.id).authorDraft!,calls=e.runtime.calls.length;
    const run=e.store.runs.get(e.run.id)!;
    if(kind==='contract')run.contract.version++;if(kind==='config')run.configSnapshot.guidance='changed';if(kind==='checkpoint')run.checkpoint='other';
    if(kind==='hash'){const a=e.store.artifacts.get(d.artifactId)!;e.store.artifacts.put({...a,content:a.content+' '});}e.store.runs.put(run);
    expect(()=>e.orchestrator.revalidateAuthorDraft(run.id,d.attemptId,d.draftHash)).toThrow();expect(e.runtime.calls.length).toBe(calls);
  });
  it('API validates payload, detects stale hashes and rejects actions while delivery is in progress',async()=>{
    const e=await draft(),d=e.orchestrator.detail(e.run.id).authorDraft!;
    const app=await buildApp({store:e.store,orchestrator:e.orchestrator,dataDir:temp(),port:14390});
    const session=await app.inject({url:'/api/session',headers:{host:'127.0.0.1:14390'}}),headers={'x-csrf-token':session.json().token,host:'127.0.0.1:14390'};
    const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers,payload:payload as Record<string,unknown>});
    expect((await post(`/api/runs/${e.run.id}/revalidate-author-output`,{})).statusCode).toBe(400);
    expect((await post(`/api/runs/${e.run.id}/revalidate-author-output`,{attemptId:d.attemptId,draftHash:'0'.repeat(64)})).statusCode).toBe(409);
    e.store.runs.put({...e.store.runs.get(e.run.id)!,delivery:{kind:'branch',target:'x',status:'in_progress',checkpoint:'cp',slot:'A',contractVersion:1,startedAt:new Date().toISOString()}});
    expect((await post(`/api/runs/${e.run.id}/preflight`,{})).statusCode).toBe(409);await app.close();
  });
  it('recovers a persisted draft intent exactly once after restart without another agent call',async()=>{
    const e=await draft(),d=e.orchestrator.detail(e.run.id).authorDraft!,agents=e.runtime.calls.filter(c=>c.startsWith('agent:')).length;
    e.store.runs.put({...e.store.runs.get(e.run.id)!,status:'paused',authorDraftRequest:{attemptId:d.attemptId,draftHash:d.draftHash}});
    const restarted=new Orchestrator(e.store,()=>e.runtime);await restarted.recover();restarted.resumeRun(e.run.id);await restarted.idle();
    expect(restarted.detail(e.run.id).authorDraft).toBeUndefined();expect(restarted.detail(e.run.id).run.authorDraftRequest).toBeUndefined();
    expect(e.runtime.calls.filter(c=>c==='applyPatch:A')).toHaveLength(1);expect(e.runtime.calls.filter(c=>c.startsWith('agent:'))).toHaveLength(agents);
    expect(()=>restarted.revalidateAuthorDraft(e.run.id,d.attemptId,d.draftHash)).toThrow();
  });
  it('prompt derives all requirement tags from the approved plan without inventing links',()=>{
    const e=setup(),run=e.create();run.contract.testPlan={schemaVersion:2,cases:[{id:'C-1',requirementIds:['R-1','R-8'],group:'happy',risk:'r',priority:'high',preconditions:'p',actions:'a',expected:'e',method:'automated',required:true}],notApplicable:[],questions:[]};
    expect(PROMPTS.author(run)).toContain('[R-1][R-8][C-1]');expect(PROMPTS.testPlan(run)).toContain('steps:[]');
  });
});

describe('resume diagnosis and Verifier boundaries',()=>{
  async function failedCheck(kind='assertion_failed'){
    const e=setup({reply:x=>x.prompt.includes('Author chẩn đoán')?fence({decision:'ambiguous',reason:'Contract timing is unclear.',evidence:'Do not infer timing.',caseIds:['C-2']}):qualityReply(x),files,check:()=>qualityGreen});
    const run=await e.drive(e.create({mode:'verify'}));const d=e.orchestrator.detail(run.id),check=d.checks.at(-1)!;
    e.store.checks.put({...check,status:'failed',issues:[{kind:kind as 'assertion_failed',message:'fixture',testId:check.outcomes?.[1]?.id}],outcomes:check.outcomes?.map((o,i)=>({...o,status:i===1?'failed':'passed'}))});
    e.store.artifacts.delete(`cand-${run.id}-A`);e.store.runs.put({...e.store.runs.get(run.id)!,status:'failed'});return {...e,run};
  }
  it('diagnoses existing assertions before Developer even when retry resets the round counter',async()=>{
    const e=await failedCheck(),before=e.runtime.calls.filter(c=>c==='agent:developer:A').length;
    e.orchestrator.resumeRun(e.run.id);await e.orchestrator.idle();
    // An unsure Author does not stop the run: the locked tests stay authoritative and the Developer goes on, with the doubt in the report.
    expect(e.runtime.calls.filter(c=>c==='agent:developer:A').length).toBeGreaterThan(before);
    expect(e.store.artifacts.list(e.run.id).filter(a=>a.title==='Pipeline fallback').map(a=>a.content).join(' ')).toContain('chưa chắc');
    expect(e.store.artifacts.list(e.run.id).filter(a=>a.title==='Author test diagnosis attempt')).toHaveLength(1);
  });
  it.each(['environment','report_error','test_missing','test_skipped','identity_ambiguous'])('does not call agents to conceal %s evidence errors',async kind=>{
    const e=await failedCheck(kind),before=e.runtime.calls.filter(c=>c.startsWith('agent:')).length;
    e.orchestrator.resumeRun(e.run.id);await e.orchestrator.idle();expect(e.runtime.calls.filter(c=>c.startsWith('agent:')).length).toBe(before);
  });
  it.each(['manifest','checkpoint','config','missing_recipe'] as const)('does not repair source using %s-stale evidence',async kind=>{
    const e=await failedCheck(),before=e.runtime.calls.filter(c=>c.startsWith('agent:')).length;
    const check=e.orchestrator.detail(e.run.id).checks.at(-1)!;
    if(kind==='manifest')e.store.checks.put({...check,manifestHash:'other'});
    if(kind==='checkpoint')e.store.checks.put({...check,checkpoint:'other'});
    if(kind==='config')e.store.checks.put({...check,configHash:'other'});
    if(kind==='missing_recipe')e.store.checks.delete(check.id);
    e.orchestrator.resumeRun(e.run.id);await e.orchestrator.idle();
    expect(e.runtime.calls.filter(c=>c.startsWith('agent:')).length).toBe(before);
    expect(e.orchestrator.detail(e.run.id).run.status).toBe('blocked');
  });
  it('rejects stale Verifier check references and exposes observed command failures',()=>{
    const e=setup(),run=e.create();const scope={reviewed:['src/order.ts'],checkIds:['old'],limitations:[],additionalChecks:[]};
    expect(()=>normalizeVerifierScope(run,[],scope,'')).toThrow('không còn hiệu lực');
    const raw=JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'node vitest run',exit_code:1,aggregated_output:'Access is denied'}});
    expect(normalizeVerifierScope(run,[],{...scope,checkIds:[]},raw)?.additionalChecks).toContainEqual({command:'node vitest run',status:'failed',detail:'Access is denied'});
    expect(normalizeVerifierScope(run,[],{...scope,checkIds:[],additionalChecks:[{command:'invented test',status:'passed',detail:'claim'}]},'')?.additionalChecks[0]?.status).toBe('incomplete');
  });
});
