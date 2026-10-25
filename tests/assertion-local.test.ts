import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalRuntime } from '../src/runtime/local.js';
import type { AgentExecution, AgentResult } from '../src/runtime/types.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import { buildApp } from '../src/server/app.js';
import { profile } from './helpers.js';
import { fence, currentPlan, plan } from './quality-fixtures.js';

it('reproduces QuotaVault C-13/C-17 with real Vitest, requires API approval and re-verifies corrected assertions', async () => {
  const source = mkdtempSync(path.join(tmpdir(), 'aidept-assertion-source-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-assertion-data-'));
  mkdirSync(path.join(source, 'src'));
  writeFileSync(path.join(source, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(source, 'src/quota.mjs'), 'export const vault=()=>{throw Error("not implemented")};\n');
  writeFileSync(path.join(source, 'vitest.config.mjs'), 'export default {test:{include:["tests/**/*.test.mjs"],maxWorkers:1,fileParallelism:false}};\n');
  const requirement = 'Committing releases reserved capacity; repeated cancel returns duplicate.';
  const implementation = `export function vault(){let reserved=0,used=0,state='empty';return {
    async reserve(){reserved=2;state='pending';return {status:'reserved',usage:{reserved,used}}},
    async commit(){used=1;reserved=0;state='committed';return {status:'committed',usage:{reserved,used}}},
    async cancel(){const status=state==='cancelled'?'duplicate':'cancelled';reserved=0;state='cancelled';return {status}},
    async usage(){return {reserved,used}}
  }}\n`;
  const testSource = (correct: boolean) => `import {describe,test,expect} from ${JSON.stringify(pathToFileURL(path.resolve('node_modules/vitest/dist/index.js')).href)};
import {vault} from '../src/quota.mjs';
describe('QuotaVault public acceptance contract',()=>{
test('[R-1][C-13] detached accounting',async()=>{const v=vault();const r=await v.reserve();expect(r.usage.reserved).toBe(2);await v.commit();r.usage.reserved=99;const usage=await v.usage();expect(usage.used).toBe(1);expect(usage.reserved).toBe(${correct ? 0 : 2});});
test('[R-1][C-17] repeated cancel',async()=>{const v=vault();await v.reserve();expect((await v.cancel()).status).toBe('cancelled');${correct ? "expect((await v.cancel()).status).toBe('duplicate');" : "await expect(v.cancel()).rejects.toMatchObject({code:'ALREADY_TERMINAL'});"}});
});\n`;
  const ids = ['C-13', 'C-17'], names = ['detached accounting', 'repeated cancel'];
  const calls: string[] = [];
  class ScriptedRuntime extends LocalRuntime {
    override async runAgent(x: AgentExecution): Promise<AgentResult> {
      calls.push(`${x.role}:${x.attempt.stage}`);
      const dir = this.workspacePath(x.run, 'A'); let output = '';
      if (x.role === 'planner') output = fence({ requirements: [{ id: 'R-1', text: requirement, required: true, manual: false }], acceptanceExamples: ['Commit releases reservation; repeating cancel returns duplicate.'], interfaces: [], assumptions: [], scope: [] });
      else if (x.prompt.includes('Author lập kế hoạch')) {
        const p = currentPlan(plan(), x.run.contract);
        p.cases.forEach((c, i) => { c.id = ids[i]!; c.expected = i ? 'Second cancel returns duplicate.' : 'After commit and detached-result mutation, reserved=0 and used=1.'; });
        output = fence(p);
      } else if (x.prompt.includes('Author chẩn đoán')) {
        writeFileSync(path.join(dir, 'tests/quota.test.mjs'), testSource(true));
        output = fence({ decision: 'test_assertion', caseIds: ids, reason: 'Two assertions contradict the explicit quota contract.', evidence: 'C-13 asserts a reservation remains after commit; C-17 expects non-idempotent cancel.', assertionChanges: ids.map((caseId, i) => ({ caseId, before: i ? 'rejects ALREADY_TERMINAL' : 'reserved=2 after commit', after: i ? 'status=duplicate' : 'reserved=0 after commit', oracle: { references: [{ requirementId: 'R-1', quote: requirement }], explanation: 'The correction follows the public requirement, without changing implementation or case identities.' } })) });
      } else if (x.role === 'author') {
        mkdirSync(path.join(dir, 'tests')); writeFileSync(path.join(dir, 'tests/quota.test.mjs'), testSource(false));
        output = fence({ entries: ids.map((caseId, i) => ({ caseId, requirementIds: ['R-1'], recipeId: 'test', path: 'tests/quota.test.mjs', identity: { kind: 'json', file: 'tests/quota.test.mjs', titles: ['QuotaVault public acceptance contract', `[R-1][${caseId}] ${names[i]}`] } })) });
      } else if (x.role === 'developer') { writeFileSync(path.join(dir, 'src/quota.mjs'), implementation); output = fence({ reuse: [] }); }
      else if (x.role === 'verifier') output = fence({ decision: 'pass', findings: [] });
      return { output, usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costUsd: 0.001 } };
    }
  }
  const runtime = new ScriptedRuntime({ dataDir }), store = new Store(':memory:');
  store.projects.put(profile({ repository: source, executionMode: 'local', checks: [{ id: 'test', command: [process.execPath, path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'runner', '--reporter=json', '--outputFile=.aidept-report.json'], reportPath: '.aidept-report.json', required: true, timeoutMs: 30_000 }] }));
  const orchestrator = new Orchestrator(store, () => runtime);
  const run = orchestrator.createRun({ projectId: 'prj_test', title: 'QuotaVault assertion recovery', originalRequirement: requirement, provider: 'codex', mode: 'verify', budgetUsd: 10, signals: [], taskKind: 'feature' });
  run.qualityPolicyVersion=2;store.runs.put(run); // Persisted v2 protocol fixture; v3 has separate real-runner coverage.
  const app = await buildApp({ store, orchestrator, dataDir, port: 14332 });
  try {
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id, { contractHash: orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true }); await orchestrator.idle();
    const before = orchestrator.detail(run.id), p = before.testRepair!;
    expect(before.run.status, before.run.blocker ?? '').toBe('blocked'); expect(p.kind).toBe('assertion');
    expect(before.checks[0]!.counts).toEqual({ passed: 0, failed: 2, skipped: 0 }); expect(before.checks[0]!.missingTestIds).toEqual([]);
    const dir = runtime.workspacePath(before.run, 'A');
    expect(readFileSync(path.join(dir, 'tests/quota.test.mjs'), 'utf8')).toBe(testSource(false));
    expect(readFileSync(path.join(dir, 'src/quota.mjs'), 'utf8')).toBe(implementation);
    await expect(orchestrator.acceptRun(run.id, { acknowledgeWarnings: true })).rejects.toThrow();
    const host = '127.0.0.1:14332', headers = { host, 'x-csrf-token': (await app.inject({ url: '/api/session', headers: { host } })).json().token };
    const approve = (hash: string) => app.inject({ method: 'POST', url: `/api/runs/${run.id}/approve-test-repair`, headers, payload: { proposalId: p.id, proposalHash: hash } });
    expect((await approve('0'.repeat(64))).statusCode).toBe(409);
    expect((await approve(p.hash)).statusCode).toBe(200); await orchestrator.idle();
    const ready = orchestrator.detail(run.id);
    expect(ready.run.status, ready.run.blocker ?? '').toBe('awaiting_acceptance');
    expect(ready.checks.at(-1)!.counts).toEqual({ passed: 2, failed: 0, skipped: 0 });
    expect(ready.run.checkpoint).not.toBe(before.run.checkpoint); expect(ready.quality.manifestHash).not.toBe(before.quality.manifestHash);
    expect(readFileSync(path.join(dir, 'src/quota.mjs'), 'utf8')).toBe(implementation);
    expect(calls).toEqual(['planner:prepare', 'author:prepare', 'author:implement', 'developer:implement', 'author:repair', 'verifier:verify']);
    const receipt = JSON.parse(ready.artifacts.find(a => a.title === 'Test repair receipt')!.content);
    expect(receipt.kind).toBe('assertion'); expect(receipt.assertionChanges).toHaveLength(2);
    expect((await orchestrator.report(run.id)).warnings.some(w => w.text.includes('sửa assertion theo diff'))).toBe(true);
    const output = path.resolve('test-results/reliability-v2'); mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, 'local-assertion.json'), JSON.stringify({ runId: run.id, before: { status: before.run.status, checkpoint: before.run.checkpoint, manifestHash: before.quality.manifestHash, checks: before.checks }, after: { status: ready.run.status, checkpoint: ready.run.checkpoint, manifestHash: ready.quality.manifestHash, checks: ready.checks }, calls, realModelCalls: 0, assertionCorrections: p.assertionChanges }, null, 2));
    writeFileSync(path.join(output, 'local-assertion-report.json'), JSON.stringify(await orchestrator.report(run.id), null, 2));
  } finally { await app.close(); store.close(); }
}, 60_000);
