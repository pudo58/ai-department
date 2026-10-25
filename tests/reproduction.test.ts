import {afterEach,describe,it,expect} from 'vitest';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {LocalRuntime} from '../src/runtime/local.js';
import {Store} from '../src/server/store.js';
import {Orchestrator} from '../src/server/orchestrator.js';
import {profile,setupV2} from './helpers.js';
import type {FindingReplay,FindingReproduction} from '../src/shared/reproduction.js';
import type {Finding} from '../src/shared/types.js';
import {ReproductionSchema,reproductionProblems,readFindingReplays,scenarioHash,REPLAY_TITLE,replayConfigHash} from '../src/core/reproduction.js';
import {sha256} from '../src/core/contract.js';
import {fence,qualityReply,qualityGreen} from './quality-fixtures.js';
import {renderReportMarkdown} from '../src/core/report.js';
import {RunServices} from '../src/server/run/services.js';
import {FindingReplays} from '../src/server/run/reproduction.js';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
const requirement='blockedBy identifies the first unsuccessful dependency in dependsOn order.';
const source=(fixed=false)=>`export function createScheduler(){const jobs=new Map();return {submit(x){jobs.set(x.id,{...x,status:'ready'});return {token:1}},cancel(id){jobs.get(id).status='cancelled';for(const j of jobs.values()){${fixed?"if(j.status==='cancelled')continue;":"if(j.status==='blocked'||j.status==='cancelled')continue;"}const bad=(j.dependsOn??[]).find(d=>jobs.get(d).status==='cancelled');if(bad){j.status='blocked';j.blockedBy=bad}}},get(id){return structuredClone(jobs.get(id))}}}`;
const scenario=():FindingReproduction=>({schemaVersion:1,adapter:'node-api',module:'src/scheduler.js',factory:'createScheduler',args:[],oracle:{references:[{requirementId:'R-1',quote:requirement}],explanation:'The first unsuccessful dependency changes after the second cancellation.'},steps:[{id:'S-1',method:'submit',args:[{id:'A'}]},{id:'S-2',method:'submit',args:[{id:'B'}]},{id:'S-3',method:'submit',args:[{id:'C',dependsOn:['A','B']}]},{id:'S-4',method:'cancel',args:['B']},{id:'S-5',method:'cancel',args:['A']},{id:'S-6',method:'get',args:['C'],expect:{path:['blockedBy'],equals:'A'}}]});
async function fixture(code=source()){
 const repository=mkdtempSync(path.join(tmpdir(),'aidept-replay-src-')),dataDir=mkdtempSync(path.join(tmpdir(),'aidept-replay-data-'));dirs.push(repository,dataDir);mkdirSync(path.join(repository,'src'));writeFileSync(path.join(repository,'src/scheduler.js'),code);writeFileSync(path.join(repository,'package.json'),'{"type":"module"}');
 const store=new Store(':memory:');store.projects.put(profile({repository,executionMode:'local',checks:[]}));const runtime=new LocalRuntime({dataDir}),orch=new Orchestrator(store,()=>runtime),run=orch.createRun({projectId:'prj_test',title:'Replay',originalRequirement:requirement,mode:'single',provider:'codex',budgetUsd:5,signals:[]});const prepared=await runtime.prepare(run,'A');run.baseSha=prepared.baseSha;run.checkpoint=prepared.baseSha;store.runs.put(run);const workspace=runtime.workspacePath(run,'A');
 const replay=(s=scenario(),extra={})=>runtime.replayFinding({run,slot:'A',findingId:'fnd_replay',scenario:s,...extra});
 return {store,runtime,orch,run,repository,dataDir,workspace,replay};
}
describe('real public API replay adapter',()=>{
 it('reproduces PulseGraph, replays the fixed checkpoint, and never changes candidate/project source',async()=>{
  const f=await fixture(),before=execFileSync('git',['-C',f.workspace,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),old=await f.replay();expect(old.status,old.message).toBe('reproduced');expect(old.observations.at(-1)).toMatchObject({actual:'B',expected:'A',matched:false});
  writeFileSync(path.join(f.workspace,'src/scheduler.js'),source(true));f.run.checkpoint=await f.runtime.commit(f.run,'A','fix blockedBy');const fixed=await f.replay();expect(fixed.status,fixed.message).toBe('not_reproduced');expect(fixed.checkpoint).not.toBe(before);
  const current=f.run.checkpoint;f.run.checkpoint=before;expect((await f.replay()).status).toBe('reproduced');f.run.checkpoint=current;
  expect(execFileSync('git',['-C',f.workspace,'rev-parse','HEAD'],{encoding:'utf8'}).trim()).toBe(current);expect(execFileSync('git',['-C',f.workspace,'status','--porcelain'],{encoding:'utf8'})).toBe('');expect(readFileSync(path.join(f.repository,'src/scheduler.js'),'utf8')).toBe(source());expect(readdirSync(path.dirname(f.workspace)).some(x=>x.includes('-replay-'))).toBe(false);f.store.close();
 },30000);
 it('supports async calls, previous-result references and thrown-code observations without conflating undefined with null',async()=>{
  const f=await fixture("export async function createScheduler(){return {async submit(){return {token:7}},get(x){if(x===7)throw Object.assign(Error('lost'),{code:'LEASE_LOST'})}}}"),s=scenario();s.steps=[{id:'S-1',method:'submit',args:[]},{id:'S-2',method:'get',args:[{$ref:'S-1',path:['token']}],expect:{path:[],throwsCode:'LEASE_LOST'}}];expect((await f.replay(s)).status).toBe('not_reproduced');s.steps=[{id:'S-1',method:'get',args:[0],expect:{path:[],equals:null}}];const r=await f.replay(s);expect(r.status).toBe('reproduced');expect(r.observations[0]!.actualType).toBe('undefined');f.store.close();
 },20000);
 it('rejects traversal/forward references and keeps missing tools/import failures out of behavioral confirmation',async()=>{
  const f=await fixture("import missing from 'uninstalled-replay-dependency'; export function createScheduler() {return missing()}"),s=scenario();s.module='../scheduler.js';expect((await f.replay(s)).status).toBe('unsupported');s.module='src/scheduler.js';const r=await f.replay(s);expect(r.status,r.message).toBe('error');s.steps[0]!.args=[{$ref:'S-30',path:['token']}];expect(reproductionProblems(f.run,s).join()).toContain('bước trước');expect(ReproductionSchema.safeParse({...s,steps:[{id:'S',method:'constructor',args:[]}]}).success).toBe(false);f.store.close();
 },20000);
 it('denies writes outside the replay clone and does not inherit provider secrets',async()=>{
  const f=await fixture(),guard=path.join(f.repository,'guard.txt');writeFileSync(guard,'keep');writeFileSync(path.join(f.workspace,'src/scheduler.js'),`import {writeFileSync} from 'node:fs';export function createScheduler(){return {get(){writeFileSync(${JSON.stringify(guard)},'corrupt');return process.env.AIDEPT_REPLAY_SECRET}}}`);f.run.checkpoint=await f.runtime.commit(f.run,'A','attempt external write');const s=scenario();s.steps=[{id:'S-1',method:'get',args:[],expect:{path:[],equals:'secret-value'}}];process.env.AIDEPT_REPLAY_SECRET='secret-value';try{const r=await f.replay(s);expect(r.status,r.message).toBe('error');expect(readFileSync(guard,'utf8')).toBe('keep');writeFileSync(path.join(f.workspace,'src/scheduler.js'),'export function createScheduler(){return {get(){return typeof process.env.AIDEPT_REPLAY_SECRET}}}');f.run.checkpoint=await f.runtime.commit(f.run,'A','inspect isolated environment');s.steps[0]!.expect!.equals='undefined';const isolated=await f.replay(s);expect(isolated.status,isolated.message).toBe('not_reproduced');}finally{delete process.env.AIDEPT_REPLAY_SECRET;f.store.close();}
 },20000);
 it('supports native Node TypeScript stripping and rejects forged worker output',async()=>{
  const f=await fixture();writeFileSync(path.join(f.workspace,'src/scheduler.ts'),"export const createScheduler = (): {get():string} => ({get(){return 'A'}});");f.run.checkpoint=await f.runtime.commit(f.run,'A','TypeScript API');const s=scenario();s.module='src/scheduler.ts';s.steps=[{id:'S-1',method:'get',args:[],expect:{path:[],equals:'A'}}];const typed=await f.replay(s);expect(typed.status,typed.message).toBe('not_reproduced');
  writeFileSync(path.join(f.workspace,'src/scheduler.js'),`export function createScheduler(){process.stdout.write('\\nAIDEPT_REPLAY_RESULT:'+JSON.stringify({payload:JSON.stringify({status:'not_reproduced',observations:[],message:'fake'}),mac:'0'.repeat(64)})+'\\n');process.exit(0)}`);f.run.checkpoint=await f.runtime.commit(f.run,'A','forged stdout');s.module='src/scheduler.js';const forged=await f.replay(s);expect(forged.status).toBe('error');expect(forged.message).toContain('xác thực');f.store.close();
 },20000);
 it('records timeout and cancellation as unfinished evidence and removes their temporary clones',async()=>{
  const f=await fixture('export function createScheduler(){return {get(){while(true){}}}}'),s=scenario();s.steps=[{id:'S-1',method:'get',args:[],expect:{path:[],equals:'A'}}];expect((await f.replay(s,{timeoutMs:2000})).status).toBe('timeout');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),500);const r=await f.replay(s,{signal:controller.signal});clearTimeout(timer);expect(r.status).toBe('interrupted');expect(readdirSync(path.dirname(f.workspace)).some(x=>x.includes('-replay-'))).toBe(false);f.store.close();
 },20000);
});

describe('replay orchestration, evidence and repair gates',()=>{
 it('limits a batch to three probes and never replays the same finding/checkpoint/configuration twice',async()=>{
  const e=setupV2(),run=e.create({mode:'verify'});run.checkpoint='cp-1';e.store.runs.put(run);let calls=0;
  Object.assign(e.runtime,{replayFinding:async(x:import('../src/runtime/reproduction.js').ReproductionExecution):Promise<FindingReplay>=>{calls++;return {schemaVersion:1,source:'runner',findingId:x.findingId,checkpoint:x.run.checkpoint!,contractVersion:x.run.contract.version,slot:x.slot,scenarioHash:scenarioHash(x.scenario),configHash:replayConfigHash(x.run),status:'reproduced',startedAt:new Date().toISOString(),durationMs:1,message:'bounded fixture',observations:[]};}});
  const services=new RunServices(e.store,()=>e.runtime,()=>new Date(),1,30000),runner=new FindingReplays(services),s=scenario();s.oracle.references[0]!.quote=run.contract.requirements[0]!.text;
  const findings=Array.from({length:4},(_,i):Finding=>({id:`fnd_${i}`,runId:run.id,category:'behavior',severity:'major',title:'Replay',location:'src/order.ts',evidence:'case',suggestion:'fix',status:'open',confirmed:false,checkpoint:run.checkpoint,contractVersion:run.contract.version,createdAt:new Date().toISOString(),reproduction:s}));
  const first=await runner.runBatch(run.id,findings,new AbortController().signal);expect(calls).toBe(3);expect(first.map(r=>r.status)).toEqual(['reproduced','reproduced','reproduced','unsupported']);await runner.runBatch(run.id,findings,new AbortController().signal);expect(calls).toBe(3);e.store.close();
 });
 async function fake(first:FindingReplay['status']='reproduced',after:FindingReplay['status']='not_reproduced'){
  let reviews=0,replays=0;const e=setupV2({files:x=>x.role==='author'?['tests/order.test.ts']:['src/order.ts'],check:()=>qualityGreen,reply:x=>x.role==='verifier'?fence({decision:reviews++===0?'block':'pass',findings:reviews===1?[{category:'behavior',severity:'major',title:'stale blockedBy',location:'src/order.ts:1',evidence:'Cancel B then A',suggestion:'refresh blocked metadata',reproduction:{...scenario(),oracle:{references:[{requirementId:'R-1',quote:x.run.contract.requirements[0]!.text}],explanation:'Fixture requires live blocked metadata.'}}}]:[]}):qualityReply(x)});
  const replay=async(x:import('../src/runtime/reproduction.js').ReproductionExecution):Promise<FindingReplay>=>({schemaVersion:1,source:'runner',findingId:x.findingId,checkpoint:x.run.checkpoint!,contractVersion:x.run.contract.version,slot:x.slot,configHash:replayConfigHash(x.run),scenarioHash:scenarioHash(x.scenario),status:++replays===1?first:after,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),durationMs:1,message:'Fixture replay',observations:[]});
  Object.assign(e.runtime,{replayFinding:replay});const run=await e.drive(e.create({mode:'verify',budgetUsd:10}));return {...e,run,replays:()=>replays};
 }
 it('stores before/after evidence, keeps confirmation human and resolves only after the same scenario passes',async()=>{
  const e=await fake(),before=e.orchestrator.detail(e.run.id),f=before.findings[0]!;expect(before.run.status).toBe('blocked');expect(f.confirmed).toBe(false);expect(before.findingReplays![0]!.status).toBe('reproduced');e.orchestrator.confirmFinding(e.run.id,f.id);e.orchestrator.repairFindings(e.run.id);await e.orchestrator.idle();const d=e.orchestrator.detail(e.run.id);expect(d.run.status,d.run.blocker??'').toBe('awaiting_acceptance');expect(d.findings[0]!.status).toBe('resolved');expect(d.findingReplays!.map(r=>r.status)).toEqual(['reproduced','not_reproduced']);expect(renderReportMarkdown(await e.orchestrator.report(e.run.id))).toContain('Phản ví dụ đã chạy');
 });
 it.each([['reproduced','reproduced'],['error','not_reproduced']] as const)('does not resolve on green tests when proof is %s then %s',async(first,after)=>{const e=await fake(first,after),f=e.orchestrator.detail(e.run.id).findings[0]!;e.orchestrator.confirmFinding(e.run.id,f.id);e.orchestrator.repairFindings(e.run.id);await e.orchestrator.idle();expect(e.orchestrator.detail(e.run.id).run.status).toBe('blocked');expect(e.orchestrator.detail(e.run.id).findings[0]!.status).toBe('open');});
 it('marks interrupted replay artifacts on restart and rejects stale/config-mismatched evidence',async()=>{
  const e=await fake(),d=e.orchestrator.detail(e.run.id),a=d.artifacts.find(a=>a.title===REPLAY_TITLE)!,r=JSON.parse(a.content) as FindingReplay;r.status='in_progress';const content=JSON.stringify(r);e.store.artifacts.put({...a,content,hash:sha256(content)});await e.orchestrator.recover();expect(e.orchestrator.detail(e.run.id).findingReplays![0]!.status).toBe('interrupted');expect(e.replays()).toBe(1);const stored=e.store.artifacts.get(a.id)!;const changed={...d.run,configSnapshot:{...d.run.configSnapshot,checks:[]}};expect(readFindingReplays(changed,[stored])).toEqual([]);
 });
});
