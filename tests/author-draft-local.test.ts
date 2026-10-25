import { expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalRuntime } from '../src/runtime/local.js';
import { Toolchains } from '../src/runtime/toolchain.js';
import type { AgentExecution, AgentResult } from '../src/runtime/types.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import { StructuredManifestSchema } from '../src/core/testplan.js';
import * as outputs from '../src/core/outputs.js';
import { fence, currentPlan, plan } from './quality-fixtures.js';
import { profile } from './helpers.js';

it('recovers an Author draft at the base Git HEAD before the first checkpoint, then runs real Vitest', async () => {
  const source = mkdtempSync(path.join(tmpdir(), 'aidept-draft-source-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-draft-data-'));
  const store = new Store(':memory:');
  mkdirSync(path.join(source, 'src'));
  writeFileSync(path.join(source, 'src/order.mjs'), 'export const value = 0;\n');
  writeFileSync(path.join(source, 'package.json'), '{"name":"draft-recovery-fixture","type":"module"}');
  writeFileSync(path.join(source, 'vitest.config.mjs'), 'export default {test:{include:["tests/**/*.test.mjs"],maxWorkers:1,fileParallelism:false}};');
  const file = 'tests/order.test.mjs';
  const testSource = `import {test,expect} from ${JSON.stringify(pathToFileURL(path.resolve('node_modules/vitest/dist/index.js')).href)};\nimport {value} from '../src/order.mjs';\ntest('[R-1][C-1] create',()=>expect(value).toBe(1));\ntest('[R-1][C-2] retry',()=>expect(value).toBe(1));\n`;
  const calls: string[] = [];
  class ScriptedRuntime extends LocalRuntime {
    override async runAgent(x: AgentExecution): Promise<AgentResult> {
      calls.push(`${x.role}:${x.attempt.stage}`);
      const cwd = this.workspacePath(x.run, 'A');
      let output = '';
      if (x.role === 'planner') output = fence({requirements:[{id:'R-1',text:'The exported value is 1 for both reads.',required:true,manual:false}],acceptanceExamples:['Two reads return 1.'],interfaces:[],assumptions:[],scope:[]});
      else if (x.prompt.includes('Author lập kế hoạch')) output = fence(currentPlan(plan(), x.run.contract));
      else if (x.role === 'author') {
        mkdirSync(path.join(cwd, 'tests'));
        writeFileSync(path.join(cwd, file), testSource);
        output = JSON.stringify({entries:['C-1','C-2'].map((caseId,i)=>({caseId,requirementIds:['R-1'],recipeId:'test',path:file,identity:{kind:'json',file,titles:[`[R-1][${caseId}] ${i?'retry':'create'}`]}}))});
      } else if (x.role === 'developer') {
        writeFileSync(path.join(cwd, 'src/order.mjs'), 'export const value = 1;\n');
        output = fence({reuse:[]});
      } else if (x.role === 'verifier') output = fence({decision:'pass',findings:[],scope:{reviewed:['src/order.mjs'],checkIds:store.checks.list(x.run.id).filter(c=>c.checkpoint===x.run.checkpoint).map(c=>c.id),limitations:[],additionalChecks:[]}});
      return {output,usage:{inputTokens:1,cachedTokens:0,outputTokens:1,costUsd:0.001}};
    }
  }
  const runtime = new ScriptedRuntime({dataDir});
  store.projects.put(profile({repository:source,executionMode:'local',modules:['src','tests'],checks:[{id:'test',command:[process.execPath,path.resolve('node_modules/vitest/vitest.mjs'),'run','--configLoader','runner','--reporter=json','--outputFile=.aidept-report.json'],reportPath:'.aidept-report.json',required:true,timeoutMs:30_000}]}));
  const orchestrator = new Orchestrator(store,()=>runtime);
  const run = orchestrator.createRun({projectId:'prj_test',title:'Recover base draft',originalRequirement:'The exported value is 1 for both reads.',provider:'codex',mode:'verify',budgetUsd:10,signals:[],taskKind:'feature'});
  run.qualityPolicyVersion=2;store.runs.put(run); // Persisted v2 draft protocol.
  const parse = outputs.parseOutput;
  let reject = true;
  const spy = vi.spyOn(outputs,'parseOutput').mockImplementation((schema,output)=>{
    if(schema===StructuredManifestSchema && reject){reject=false;throw new Error('Old parser rejects raw JSON fixture');}
    return parse(schema,output);
  });
  try {
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id,{contractHash:orchestrator.detail(run.id).contractReview.contractHash,acknowledgeWarnings:true}); await orchestrator.idle();
    const before = orchestrator.detail(run.id), draft = before.authorDraft!;
    expect(before.run.status,before.run.blocker??'').toBe('blocked');
    expect(before.run.checkpoint).toBeNull();
    expect(draft.checkpoint).toBe(before.run.baseSha);
    expect(existsSync(path.join(runtime.workspacePath(before.run,'A'),file))).toBe(false);
    const agentCount = calls.length;
    const tools = new Toolchains({dataDir});
    const installer = vi.spyOn(tools,'provide').mockRejectedValue(new Error('A probe must not install toolchains'));
    const restartedRuntime = new LocalRuntime({dataDir,toolchains:tools});
    expect((await restartedRuntime.preflight(before.run,'A')).status).toBe('passed');
    expect(installer).not.toHaveBeenCalled();installer.mockRestore();
    orchestrator.revalidateAuthorDraft(run.id,draft.attemptId,draft.draftHash); await orchestrator.idle();
    const after = orchestrator.detail(run.id);
    expect(after.run.status,after.run.blocker??'').toBe('paused');
    expect(after.run.checkpoint).toBeTruthy();
    expect(after.quality.manifestHash).toBeTruthy();
    expect(readFileSync(path.join(runtime.workspacePath(after.run,'A'),file),'utf8')).toBe(testSource);
    expect(calls).toHaveLength(agentCount);
    expect(readFileSync(path.join(source,'src/order.mjs'),'utf8')).toContain('value = 0');
    orchestrator.resumeRun(run.id); await orchestrator.idle();
    const ready = orchestrator.detail(run.id);
    expect(ready.run.status,ready.run.blocker??'').toBe('awaiting_acceptance');
    expect(ready.checks.at(-1)?.counts).toEqual({passed:2,failed:0,skipped:0});
    expect(calls.filter(x=>x==='author:implement')).toHaveLength(1);
  } finally {
    spy.mockRestore(); store.close();
    rmSync(source,{recursive:true,force:true}); rmSync(dataDir,{recursive:true,force:true});
  }
},45_000);
