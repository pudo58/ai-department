import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {LocalRuntime} from '../src/runtime/local.js';
import {Store} from '../src/server/store.js';
import {Orchestrator} from '../src/server/orchestrator.js';
import {buildApp} from '../src/server/app.js';
import type {AgentExecution} from '../src/runtime/types.js';
import {profile} from './helpers.js';
import {fence} from './quality-fixtures.js';
import {reasoningPlan,reasoningEntries} from './reasoning-fixtures.js';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
async function fixture(correctOnSecond=true,fault:'test'|'implementation'='test'){
 const source=mkdtempSync(path.join(tmpdir(),'aidept-v3-src-')),dataDir=mkdtempSync(path.join(tmpdir(),'aidept-v3-data-'));dirs.push(source,dataDir);
 mkdirSync(path.join(source,'src'));writeFileSync(path.join(source,'package.json'),'{"type":"module"}');writeFileSync(path.join(source,'src/queue.js'),'export function createQueue(){throw Error("stub")}');writeFileSync(path.join(source,'vitest.config.mjs'),'export default {test:{include:["tests/**/*.test.js"],maxWorkers:1,fileParallelism:false}};');
 const requirement='Claim each ready job once.',implementation="export function createQueue(){const jobs=['A','B','C'];return {claim(){return jobs.shift()??null}}}";
 const testSource=(correct:boolean)=>`import {it,expect} from ${JSON.stringify(pathToFileURL(path.resolve('node_modules/vitest/dist/index.js')).href)};\nimport {createQueue} from '../src/queue.js';\nit('[R-1][C-1] all jobs',()=>{\n const q=createQueue();\n expect(q.claim()).toBe('A');\n expect(q.claim()).toBe('B');\n ${correct?"expect(q.claim()).toBe('C')":"expect(q.claim()).toBeNull()"};\n});\n`;
 const calls:string[]=[];let diagnostics=0;
 class Scripted extends LocalRuntime{
  override async runAgent(x:AgentExecution){
   calls.push(`${x.role}:${x.attempt.stage}`);const dir=this.workspacePath(x.run,'A');let output='';
   if(x.role==='planner')output=fence({requirements:[{id:'R-1',text:requirement,required:true,manual:false}],acceptanceExamples:['A then B then C'],interfaces:[],assumptions:[],scope:[]});
   else if(x.prompt.includes('Author lập kế hoạch'))output=fence(reasoningPlan(x.run.contract));
   else if(x.prompt.includes('Author chẩn đoán')){
    diagnostics++;const entries=reasoningEntries(x.run.contract.testPlan!),correct=correctOnSecond&&diagnostics===2;
    if(fault==='implementation')return {output:fence({decision:'implementation',reason:'The third ready job is dropped in source',evidence:'Runner expected C and received null',caseIds:['C-1'],assessment:{target:'source',testConformsToContract:true,expected:'C',actual:'null',location:'src/queue.js:1',failingTestIds:[entries[0]!.testId],oracle:x.run.contract.testPlan!.cases[0]!.oracle},assertionChanges:[]}),usage:{inputTokens:1,cachedTokens:0,outputTokens:1,costUsd:0.001}};
    if(correct)writeFileSync(path.join(dir,'tests/queue.test.js'),testSource(true));
    output=fence({decision:correct?'test_assertion':'implementation',reason:'The assertion is contrary to the contract; C remains ready.',evidence:'The third claim receives C but test incorrectly expects null.',caseIds:['C-1'],assessment:{target:'test',testConformsToContract:false,expected:'Third claim returns C',actual:'Test asserts null but runner receives C',location:'tests/queue.test.js:7',failingTestIds:[entries[0]!.testId],oracle:x.run.contract.testPlan!.cases[0]!.oracle},assertionChanges:correct?[{caseId:'C-1',before:'expect(q.claim()).toBeNull()',after:"expect(q.claim()).toBe('C')",oracle:x.run.contract.testPlan!.cases[0]!.oracle}]:[]});
   }else if(x.role==='author'){
    mkdirSync(path.join(dir,'tests'),{recursive:true});writeFileSync(path.join(dir,'tests/queue.test.js'),testSource(fault==='implementation'));const entries=reasoningEntries(x.run.contract.testPlan!);if(fault==='test')entries[0]!.assertions![2]!.expression='expect(q.claim()).toBeNull()';output=fence({entries});
   }else if(x.role==='developer'){writeFileSync(path.join(dir,'src/queue.js'),fault==='implementation'&&calls.filter(c=>c.startsWith('developer')).length===1?implementation.replace('jobs.shift()??null','jobs.length===1?null:(jobs.shift()??null)'):implementation);output=fence({reuse:[]});}
   else output=fence({decision:'pass',findings:[]});
   return {output,usage:{inputTokens:1,cachedTokens:0,outputTokens:1,costUsd:0.001}};
  }
 }
 const store=new Store(':memory:'),runtime=new Scripted({dataDir});store.projects.put(profile({repository:source,executionMode:'local',checks:[{id:'test',command:[process.execPath,path.resolve('node_modules/vitest/vitest.mjs'),'run','--configLoader','runner','--reporter=json','--outputFile=.aidept-report.json'],required:true,reportPath:'.aidept-report.json',timeoutMs:30000}]}));
 const orch=new Orchestrator(store,()=>runtime),run=orch.createRun({projectId:'prj_test',title:'PulseGraph C5 fixture',originalRequirement:requirement,mode:'verify',provider:'codex',budgetUsd:10,signals:[]});
 orch.startRun(run.id);await orch.idle();orch.approveContract(run.id,{contractHash:orch.detail(run.id).contractReview.contractHash,acknowledgeWarnings:true});await orch.idle();
 return {store,runtime,orch,run,source,dataDir,calls,testSource,implementation};
}
it('corrects a contradictory diagnosis once before Developer, then requires exact API approval of the real Vitest assertion diff',async()=>{
 const f=await fixture(),d=f.orch.detail(f.run.id),p=d.testRepair!;
 expect(d.run.qualityPolicyVersion).toBe(3);expect(d.run.status,d.run.blocker??'').toBe('blocked');expect(d.checks[0]!.counts).toEqual({passed:0,failed:1,skipped:0});
 expect(f.calls.filter(c=>c.startsWith('developer'))).toHaveLength(1);expect(f.calls.filter(c=>c==='author:repair')).toHaveLength(2);expect(d.artifacts.filter(a=>a.title==='Author diagnosis correction attempt')).toHaveLength(1);
 expect(p).toMatchObject({kind:'assertion',assessment:{target:'test',testConformsToContract:false}});expect(readFileSync(path.join(f.runtime.workspacePath(d.run,'A'),'tests/queue.test.js'),'utf8')).toBe(f.testSource(false));
 const app=await buildApp({store:f.store,orchestrator:f.orch,dataDir:f.dataDir,port:14352}),session=await app.inject({url:'/api/session',headers:{host:'127.0.0.1:14352'}}),headers={host:'127.0.0.1:14352','x-csrf-token':session.json().token};
 const invalid=await app.inject({method:'POST',url:`/api/runs/${d.run.id}/approve-test-repair`,headers,payload:{proposalId:p.id,proposalHash:'0'.repeat(64)}});expect(invalid.statusCode).toBe(409);
 const approved=await app.inject({method:'POST',url:`/api/runs/${d.run.id}/approve-test-repair`,headers,payload:{proposalId:p.id,proposalHash:p.hash}});expect(approved.statusCode).toBe(200);await f.orch.idle();
 const after=f.orch.detail(d.run.id);expect(after.run.status,after.run.blocker??'').toBe('awaiting_acceptance');expect(after.checks.at(-1)!.counts).toEqual({passed:1,failed:0,skipped:0});expect(after.quality.cases[0]!.status).toBe('passed');expect(f.calls.filter(c=>c.startsWith('developer'))).toHaveLength(1);
 const manifest=JSON.parse(after.artifacts.filter(a=>a.title==='Test manifest').at(-1)!.content);expect(manifest.entries[0].assertions[2].expression).toBe("expect(q.claim()).toBe('C')");expect(manifest.assertionAudit[0].status).toBe('checked');expect(readFileSync(path.join(f.source,'src/queue.js'),'utf8')).toContain('stub');await app.close();f.store.close();
},60000);
it('routes a genuine implementation defect into source repair and preserves the Author tests',async()=>{
 const f=await fixture(true,'implementation'),d=f.orch.detail(f.run.id);expect(d.run.status,d.run.blocker??'').toBe('awaiting_acceptance');expect(f.calls.filter(c=>c.startsWith('developer'))).toHaveLength(2);expect(f.calls.filter(c=>c==='author:repair')).toHaveLength(1);expect(d.testRepair).toBeUndefined();expect(readFileSync(path.join(f.runtime.workspacePath(d.run,'A'),'tests/queue.test.js'),'utf8')).toBe(f.testSource(true));f.store.close();
},60000);
it('stops after the bounded correction; restart/resume cannot buy another diagnosis or call Developer on the contradiction',async()=>{
 const f=await fixture(false),d=f.orch.detail(f.run.id);expect(d.run.status).toBe('blocked');expect(d.run.blocker).toContain('mâu thuẫn');expect(d.testRepair).toBeUndefined();const count=f.calls.length;
 const restarted=new Orchestrator(f.store,()=>f.runtime);await restarted.recover();restarted.resumeRun(d.run.id);await restarted.idle();expect(f.calls).toHaveLength(count);expect(restarted.detail(d.run.id).completion.ready).toBe(false);f.store.close();
},60000);
