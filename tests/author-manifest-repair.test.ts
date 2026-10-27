import {expect,it} from 'vitest';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {LocalRuntime} from '../src/runtime/local.js';import type {AgentExecution,AgentResult} from '../src/runtime/types.js';
import {Orchestrator} from '../src/server/orchestrator.js';import {Store} from '../src/server/store.js';
import {initialContract,hashContract} from '../src/core/contract.js';
import {parseAuthorManifest,authorManifestScaffold,AUTHOR_MANIFEST_REPAIR_TITLE} from '../src/core/authormanifest.js';
import {authorRepairSourceProblems,assertionInventory,sameMembers} from '../src/core/authoring.js';
import {validateManifest} from '../src/core/testplan.js';
import {compileSourceBindings} from '../src/core/sourcebindings.js';
import {reasoningPlan,reasoningEntries} from './reasoning-fixtures.js';import {profile,pinV3} from './helpers.js';import {fence} from './quality-fixtures.js';

it('resolves only explicit current-contract references and preserves legacy manifests and takes the approved text over a copied expected value',()=>{
 const contract={...initialContract('Claim each ready job once.'),testPlan:reasoningPlan(initialContract('Claim each ready job once.'))};
 const old=reasoningEntries(contract.testPlan),raw=JSON.stringify({entries:old}),before=JSON.stringify(contract);
 expect(parseAuthorManifest(contract,raw,true)).toEqual(old);
 const output={bindingProtocol:1,contractHash:hashContract(contract),entries:old.map(e=>({...e,assertions:e.assertions!.map(({expected,...a})=>a)}))};
 expect(parseAuthorManifest(contract,fence(output),true)).toEqual(old);
 const parsed=parseAuthorManifest(contract,JSON.stringify({...output,entries:old.map(e=>({...e,assertions:e.assertions!.map(a=>({...a,expected:'wrong'}))}))}),true);
 expect(parsed).toEqual(old);expect(validateManifest(contract,parsed,[{id:'test',reportPath:'r.json'}],[old[0]!.path])).toEqual([]);
 expect(()=>parseAuthorManifest(contract,JSON.stringify({...output,contractHash:'0'.repeat(64)}),true)).toThrow(/hợp đồng/);
 expect(()=>parseAuthorManifest(contract,JSON.stringify({...output,entries:output.entries.map(e=>({...e,assertions:[{stepId:'S-99',expression:'expect(true).toBe(true)'}]}))}),true)).toThrow(/không có bước/);
 expect(()=>parseAuthorManifest(contract,JSON.stringify({...output,bindingProtocol:2}),true)).toThrow();
 expect(()=>parseAuthorManifest(contract,JSON.stringify({entries:output.entries}),true)).toThrow();
 expect(JSON.stringify(contract)).toBe(before);
 expect(JSON.parse(authorManifestScaffold(contract,['test'])).entries[0].steps).toHaveLength(3);
});
it('retains actual assertions, setup and identity; only permits extra assertion observations during correction',()=>{
 const before="test('id',()=>{const q=createQueue();expect(q.claim()).toBe('A');expect(q.claim()).toBe('B');});";
 expect(authorRepairSourceProblems('tests/q.js',before,before.replace("toBe('B');","toBe('B');expect(q.claim()).toBe('C');"))).toEqual([]);
 for(const after of [before.replace("toBe('B')","toBe('X')"),before.replace("expect(q.claim()).toBe('B');",''),before.replace("test('id'","test.skip('id'"),before.replace('createQueue()','fakeQueue()'),before.replace("toBe('A')","toEqual('A')")])expect(authorRepairSourceProblems('tests/q.js',before,after).length).toBeGreaterThan(0);
 const inventory=assertionInventory('tests/q.js',"expect(x).toBe(1);\nexpect(x).toBe(1);\n// expect(x).toBe(0);");
 expect(inventory.map(a=>a.line)).toEqual([1,2]);
});

it('lets a correction reformat what it kept, but still rejects a changed value, and says where',()=>{
 const before="test('id',()=>{const q=createQueue();expect(q.claim()).toBe('A');expect(q.claim()).toBe('B');});";
 const tidy=`test("id", () => {
  const q = createQueue()
  // @aidept-step S-1
  expect(q.claim()).toBe("A")
  expect(q.claim()).toBe(\`B\`);
  expect(q.claim(),).toBeNull();
});`;
 expect(authorRepairSourceProblems('tests/q.js',before,tidy)).toEqual([]);
 const changed=authorRepairSourceProblems('tests/q.js',before,before.replace('createQueue()','createQueue(1)'));
 expect(changed.join()).toContain('khác nhau ở');expect(changed.join()).toContain('createQueue');
 expect(authorRepairSourceProblems('tests/q.js',before,before.replace("toBe('A')","toBe('a')")).length).toBeGreaterThan(0);
 expect(sameMembers(['R-1','R-2'],['R-2','R-1'])).toBe(true);expect(sameMembers(['R-1'],['R-1','R-2'])).toBe(false);expect(sameMembers(['R-1','R-1'],['R-1','R-2'])).toBe(false);
});
it('compiles only explicit case/step annotations and exact static source identities, including shared helper assertions',()=>{
 const contract={...initialContract('Claim each ready job once.'),testPlan:reasoningPlan(initialContract('Claim each ready job once.'))};
 const source=`function check(){\n// @aidept-bind C-1/S-3\nexpect(q.claim()).toBe('C');\n}\ndescribe('suite > delimiter',()=>{\n// @aidept-case C-1\ntest('[R-1][C-1] all jobs',()=>{\n// @aidept-step S-1\nexpect(q.claim()).toBe('A');\n// @aidept-step S-2\nexpect(q.claim()).toBe('B');\ncheck();\n});\n});`;
 const entries=compileSourceBindings(contract,'tests/queue.test.js','test',source);
 expect(entries[0]!.identity).toEqual({kind:'json',file:'tests/queue.test.js',titles:['suite > delimiter','[R-1][C-1] all jobs']});
 expect(entries[0]!.assertions!.map(a=>a.expected).sort()).toEqual(['A','B','C']);
 expect(validateManifest(contract,entries,[{id:'test',reportPath:'r.json'}],['tests/queue.test.js'])).toEqual([]);
 for(const broken of [source.replace('@aidept-case C-1','missing case'),source.replace('@aidept-step S-1','missing step'),source.replace('C-1/S-3','C-99/S-3'),source.replace('@aidept-step S-2','@aidept-step S-99'),source.replace("test('[R-1]","test.skip('[R-1]")])expect(()=>compileSourceBindings(contract,'tests/queue.test.js','test',broken)).toThrow();
});

it.each(['success','source','sourceRepair','invalid','weaken','interrupted'] as const)('bounded Author draft correction with real Git/Vitest: %s',async mode=>{
 const source=mkdtempSync(path.join(tmpdir(),'aidept-manifest-source-')),dataDir=mkdtempSync(path.join(tmpdir(),'aidept-manifest-data-')),store=new Store(':memory:');
 mkdirSync(path.join(source,'src'));writeFileSync(path.join(source,'src/queue.mjs'),"export function createQueue(){return {claim(){return null}}}\n");
 writeFileSync(path.join(source,'package.json'),'{"name":"manifest-fixture","type":"module"}');
 writeFileSync(path.join(source,'vitest.config.mjs'),'export default {test:{include:["tests/**/*.test.mjs"],maxWorkers:1,fileParallelism:false}};');
 const file='tests/queue.test.mjs',calls:string[]=[];let writes=0;
 class Runtime extends LocalRuntime{
  override async runAgent(x:AgentExecution):Promise<AgentResult>{
   calls.push(x.role+':'+x.attempt.stage);const cwd=this.workspacePath(x.run,'A');let output='';
   if(x.role==='planner')output=fence({requirements:[{id:'R-1',text:'Claim each ready job once.',required:true,manual:false}],acceptanceExamples:['A, B and C are each returned.'],interfaces:[],assumptions:[],scope:[]});
   else if(x.prompt.includes('Author lập kế hoạch'))output=fence(reasoningPlan(x.run.contract));
   else if(x.role==='author'){
    const correction=++writes===2;
    if(correction){expect(store.artifacts.list(x.run.id).filter(a=>a.title===AUTHOR_MANIFEST_REPAIR_TITLE)).toHaveLength(1);expect(x.prompt).toContain('Danh mục assertion thực');if(mode==='interrupted')throw Error('Simulated provider interruption after marker');}
    mkdirSync(path.join(cwd,'tests'),{recursive:true});
    const values=mode==='source'||correction&&(mode==='success'||mode==='sourceRepair')?['A','B','C']:correction&&mode==='weaken'?['A','X']:['A','B'];
    const annotated=mode==='source'||mode==='sourceRepair';
    const sourceText=`import {test,expect} from ${JSON.stringify(pathToFileURL(path.resolve('node_modules/vitest/dist/index.js')).href)};\nimport {createQueue} from '../src/queue.mjs';\n${annotated?'// @aidept-case C-1\n':''}test('[R-1][C-1] all jobs',()=>{const q=createQueue();\n${values.map((v,i)=>`${annotated?`// @aidept-step S-${i+1}\n`:''}expect(q.claim()).toBe('${v}');`).join('\n')}\n});\n`;
    writeFileSync(path.join(cwd,file),sourceText);
    const entries=reasoningEntries(x.run.contract.testPlan!,file);entries[0]!.assertions=values.map((v,i)=>({stepId:`S-${i+1}`,expected:x.run.contract.testPlan!.cases[0]!.steps![i]!.expected,expression:`expect(q.claim()).toBe('${v}')`,line:4+i}));
    output=annotated?fence({bindingProtocol:2,contractHash:hashContract(x.run.contract),files:[{path:file,recipeId:'test'}]}):correction?fence({bindingProtocol:1,contractHash:hashContract(x.run.contract),entries:entries.map(e=>({...e,assertions:e.assertions!.map(({expected,...a})=>a)}))}):fence({entries});
   }else if(x.role==='developer'){writeFileSync(path.join(cwd,'src/queue.mjs'),"export function createQueue(){const jobs=['A','B','C'];return {claim(){return jobs.shift()??null}}}\n");output=fence({reuse:[]});}
   else if(x.role==='verifier')output=fence({decision:'pass',findings:[],scope:{reviewed:['src/queue.mjs'],checkIds:store.checks.list(x.run.id).filter(c=>c.checkpoint===x.run.checkpoint).map(c=>c.id),limitations:[],additionalChecks:[]}});
   return {output,usage:{inputTokens:1,outputTokens:1,cachedTokens:0,costUsd:.001}};
  }
 }
 const runtime=new Runtime({dataDir});store.projects.put(profile({repository:source,executionMode:'local',modules:['src','tests'],checks:[{id:'test',command:[process.execPath,path.resolve('node_modules/vitest/vitest.mjs'),'run','--configLoader','runner','--reporter=json','--outputFile=.aidept-report.json'],reportPath:'.aidept-report.json',required:true,timeoutMs:30000}]}));
 const orch=new Orchestrator(store,()=>runtime),run=orch.createRun({projectId:'prj_test',title:'Author manifest correction',originalRequirement:'Claim each ready job once.',provider:'codex',mode:'verify',budgetUsd:10,signals:[],taskKind:'feature'});pinV3(store,run);
 try{
  orch.startRun(run.id);await orch.idle();const hash=orch.detail(run.id).contractReview.contractHash;orch.approveContract(run.id,{contractHash:hash,acknowledgeWarnings:true});await orch.idle();const d=orch.detail(run.id);
  expect(writes).toBe(mode==='source'?1:2);expect(hashContract(d.run.contract)).toBe(hash);expect(readFileSync(path.join(source,'src/queue.mjs'),'utf8')).toContain('return null');
  if(['success','source','sourceRepair','invalid'].includes(mode)){
   // A step still unbound after the one correction is a warning for the person at acceptance, not a reason to stop the run.
   if(mode==='invalid')expect(d.quality.manifestAdvisories?.join(' ')).toContain('C-1.S-3');else expect(d.quality.manifestAdvisories??[]).toEqual([]);
   expect(d.run.status,d.run.blocker??'').toBe('awaiting_acceptance');expect(d.quality.cases.every(c=>c.status==='passed')).toBe(true);expect(d.checks.at(-1)?.counts).toEqual({passed:1,failed:0,skipped:0});expect(d.artifacts.find(a=>a.title==='Test manifest')?.checkpoint).toBeTruthy();expect(calls.filter(c=>c==='developer:implement')).toHaveLength(1);
  }else{
   let after=d;
   if(mode==='interrupted'){
    // The provider died after the marker was written: no second correction is bought, and resume uses the first draft as it was written.
    expect(['blocked','failed']).toContain(d.run.status);expect(d.attempts.some(a=>a.role==='developer')).toBe(false);
    const restarted=new Orchestrator(store,()=>runtime);restarted.resumeRun(run.id);await restarted.idle();expect(writes).toBe(2);after=restarted.detail(run.id);
   }
   // A correction that cannot be accepted does not end the run: the tests as first written are locked from their titles, with the gap reported.
   expect(after.attempts.some(a=>a.role==='developer')).toBe(true);expect(after.quality.manifestHash).not.toBeNull();
   expect(after.quality.manifestAdvisories?.join(' ')).toContain('suy ra từ tên test');
   expect(readFileSync(path.join(runtime.workspacePath(after.run,'A'),file),'utf8')).not.toContain("toBe('X')");
   expect(after.artifacts.some(a=>a.title==='Pipeline fallback')).toBe(true);
  }
 }finally{store.close();rmSync(source,{recursive:true,force:true});rmSync(dataDir,{recursive:true,force:true});}
},45000);
