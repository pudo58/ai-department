import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { LocalRuntime } from '../src/runtime/local.js';
import type { AgentExecution, AgentResult } from '../src/runtime/types.js';
import { Store } from '../src/server/store.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { profile } from './helpers.js';
import { fence, currentPlan, plan } from './quality-fixtures.js';

it('runs real Vitest on a broken Author setup, approves a real Git diff, re-verifies, and delivers only the repaired checkpoint', async () => {
  const source = mkdtempSync(path.join(tmpdir(), 'aidept-recovery-local-source-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-recovery-local-data-'));
  mkdirSync(path.join(source, 'src'));
  writeFileSync(path.join(source, 'src/queue.mjs'), 'export const createQueue = () => { throw Error("not implemented"); };\n');
  writeFileSync(path.join(source, 'package.json'), '{"name":"recovery-fixture","type":"module"}');
  writeFileSync(path.join(source, 'vitest.config.mjs'), 'export default {test:{include:["tests/**/*.test.mjs"],maxWorkers:1,fileParallelism:false}};\n');
  const implementation = 'export function createQueue(){const jobs=[];return {enqueue:id=>jobs.push({id}),claim:()=>jobs.shift()};}\n';
  const testSource = (corrected: boolean) => `import {test,expect} from ${JSON.stringify(pathToFileURL(path.resolve('node_modules/vitest/dist/index.js')).href)};
import {createQueue} from '../src/queue.mjs';
test('[R-1][C-1] create',()=>{const q=createQueue();q.enqueue('one');expect(q.claim().id).toBe('one');});
test('[R-1][C-2] retry',()=>{const q=createQueue();q.enqueue('one');q.enqueue('two');${corrected ? "q.enqueue('third');" : ''}q.claim();q.claim();expect(q.claim().id).toBe('third');});\n`;
  const manifest = ['C-1', 'C-2'].map((caseId, i) => ({ caseId, requirementIds: ['R-1'], recipeId: 'test', path: 'tests/order.test.mjs', testId: `tests/order.test.mjs::[R-1][${caseId}] ${i ? 'retry' : 'create'}` }));
  const calls: string[] = [];
  class ScriptedRuntime extends LocalRuntime {
    override async runAgent(x: AgentExecution): Promise<AgentResult> {
      calls.push(`${x.role}:${x.attempt.stage}`);
      const dir = this.workspacePath(x.run, 'A');
      let output = '';
      if (x.role === 'planner') output = fence({ requirements: [{ id: 'R-1', text: 'Claims return all enqueued jobs exactly once, including a third job after two claims.', required: true, manual: false }], acceptanceExamples: ['Enqueue one, two and third; claim returns all three in order.'], interfaces: [], assumptions: [], scope: [] });
      else if (x.prompt.includes('Author lập kế hoạch')) {
        const cases = plan();
        Object.assign(cases.cases[0]!, { risk: 'A queued job could be lost.', preconditions: 'Empty queue', actions: 'Enqueue one job and claim it', expected: 'The claimed id is one.' });
        Object.assign(cases.cases[1]!, { risk: 'A later claim could lose an already enqueued job.', preconditions: 'Three jobs one, two and third have been enqueued', actions: 'Claim two jobs, then claim once more', expected: 'The third claim returns the job with id third.' });
        output = fence(currentPlan(cases, x.run.contract));
      }
      else if (x.prompt.includes('Author chẩn đoán')) { writeFileSync(path.join(dir, 'tests/order.test.mjs'), testSource(true)); output = fence({ decision: 'test_setup', caseIds: ['C-2'], reason: 'The third expected job was never enqueued.', evidence: 'The fixture enqueued only one and two, consumed both, then dereferenced an empty claim.' }); }
      else if (x.role === 'author') { mkdirSync(path.join(dir, 'tests')); writeFileSync(path.join(dir, 'tests/order.test.mjs'), testSource(false)); output = fence({ entries: manifest.map(m => ({ ...m, identity: { kind: 'json', file: m.path, titles: [m.testId.split('::')[1]] } })) }); }
      else if (x.role === 'developer') { writeFileSync(path.join(dir, 'src/queue.mjs'), implementation); output = fence({ reuse: [] }); }
      else if (x.role === 'verifier') output = fence({ decision: 'pass', findings: [] });
      return { output, usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costUsd: 0.001 } };
    }
  }
  const runtime = new ScriptedRuntime({ dataDir }); const store = new Store(':memory:');
  store.projects.put(profile({ repository: source, executionMode: 'local', modules: ['src', 'tests'], checks: [{ id: 'test', command: [process.execPath, path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'runner', '--reporter=json', '--outputFile=.aidept-report.json'], reportPath: '.aidept-report.json', required: true, timeoutMs: 30_000 }] }));
  const orchestrator = new Orchestrator(store, () => runtime);
  const run = orchestrator.createRun({ projectId: 'prj_test', title: 'Recover invalid test fixture', originalRequirement: 'Claims must return each enqueued job once, including the third after consuming two jobs.', provider: 'codex', mode: 'verify', budgetUsd: 10, signals: [], taskKind: 'feature' });
  run.qualityPolicyVersion=2;store.runs.put(run); // Persisted v2 setup-repair protocol.
  orchestrator.startRun(run.id); await orchestrator.idle();
  orchestrator.approveContract(run.id, { contractHash: orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true }); await orchestrator.idle();
  const failed = orchestrator.detail(run.id);
  expect(failed.run.status, failed.run.blocker ?? '').toBe('blocked');
  expect(failed.checks[0]!.counts).toEqual({ passed: 1, failed: 1, skipped: 0 });
  expect(failed.checks[0]!.missingTestIds).toEqual([]); const p = failed.testRepair!;
  expect(p.patch).toContain("q.enqueue('third')");
  expect(readFileSync(path.join(runtime.workspacePath(failed.run, 'A'), 'tests/order.test.mjs'), 'utf8')).toBe(testSource(false));
  expect(readFileSync(path.join(source, 'src/queue.mjs'), 'utf8')).toContain('not implemented');
  orchestrator.approveTestRepair(run.id, p.id, p.hash); await orchestrator.idle();
  const ready = orchestrator.detail(run.id);
  expect(ready.run.status, ready.run.blocker ?? '').toBe('awaiting_acceptance');
  expect(ready.checks.at(-1)!.counts).toEqual({ passed: 2, failed: 0, skipped: 0 });
  expect(calls.filter(x => x.startsWith('developer:'))).toHaveLength(1); expect(calls).toContain('verifier:verify');
  expect((await orchestrator.report(run.id)).warnings.some(w => w.text.includes('diff người dùng duyệt'))).toBe(true);
  await orchestrator.acceptRun(run.id, { acknowledgeWarnings: true });
  expect(store.runs.get(run.id)!.status).toBe('completed'); expect(store.runs.get(run.id)!.delivery?.kind).toBe('files');
  expect(readFileSync(path.join(source, 'src/queue.mjs'), 'utf8')).toBe(implementation);
  expect(readFileSync(path.join(source, 'tests/order.test.mjs'), 'utf8')).toBe(testSource(true));
}, 45_000);
