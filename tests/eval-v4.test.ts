import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRuntime } from '../src/runtime/local.js';
import type { AgentExecution } from '../src/runtime/types.js';
import { RISK_GROUPS } from '../src/shared/quality.js';
import { identityId } from '../src/core/testids.js';
import { fence } from './quality-fixtures.js';
// The runner is plain ESM next to the CLI; the test drives it with scripted agents and a decision callback.
// @ts-expect-error no type declarations for the .mjs helpers
import { loadTask } from '../scripts/lib/evaltask.mjs';
// @ts-expect-error no type declarations for the .mjs helpers
import { renderReport, runAssignment, summarizeRows } from '../scripts/lib/evalv4.mjs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

/** The ledgerhold pack with a Developer that first writes the pack's `hold-ignores-held` mutant and, once asked to, its reference. */
async function scripted(buggy: boolean) {
  const task = await loadTask('ledgerhold');
  const reference = readFileSync(path.join(task.dir, 'reference/src/ledger.js'), 'utf8');
  const mutant = JSON.parse(readFileSync(path.join(task.dir, 'mutants/hold-ignores-held.json'), 'utf8')) as { edits: { find: string; replace: string }[] };
  const buggySource = mutant.edits.reduce((s, e) => s.replace(e.find, e.replace), reference);
  const quote = "If `available < amount` it fails with `INSUFFICIENT_FUNDS` (an amount equal to `available` is allowed).";
  const plan = () => ({ schemaVersion: 2, reasoningVersion: 1, statefulModelVersion: 1,
    cases: [{ id: 'C-1', requirementIds: ['R-1'], group: 'state', risk: 'A hold is refused or granted wrongly', priority: 'high', preconditions: 'An account with funds', actions: 'Deposit, then hold', expected: 'The hold is granted', method: 'automated', required: true,
      oracle: { references: [{ requirementId: 'R-1', quote }], explanation: 'The SPEC says when a hold is allowed.' }, invariants: ['held never exceeds total'],
      steps: [{ id: 'S-1', before: 'empty account', after: 'account holds 1000', requirementIds: ['R-1'], action: 'deposit 1000', expected: 'total 1000, available 1000' },
        { id: 'S-2', before: 'account holds 1000', after: 'a hold of 400 exists', requirementIds: ['R-1'], action: 'hold 400', expected: 'the first hold is h1' }] }],
    notApplicable: RISK_GROUPS.filter((g) => g !== 'state').map((group) => ({ group, reason: 'Covered by the other cases of this fixture.' })), questions: [] });
  const testSource = "import {it,expect} from 'vitest';\nimport {createLedger} from '../src/ledger.js';\nit('[R-1][C-1] deposit then hold',()=>{\n const l=createLedger();\n l.open('a');\n expect(l.deposit('a',1000,'d1')).toEqual({total:1000,held:0,available:1000});\n expect(l.hold('a',400,'h1').holdId).toBe('h1');\n});\n";
  const identity = { kind: 'json' as const, file: 'tests/ledger.test.js', titles: ['[R-1][C-1] deposit then hold'] };
  const entries = [{ caseId: 'C-1', requirementIds: ['R-1'], recipeId: 'test', path: 'tests/ledger.test.js', identity, testId: identityId(identity), assertions: [
    { stepId: 'S-1', expected: 'total 1000, available 1000', expression: "expect(l.deposit('a',1000,'d1')).toEqual({total:1000,held:0,available:1000})" },
    { stepId: 'S-2', expected: 'the first hold is h1', expression: "expect(l.hold('a',400,'h1').holdId).toBe('h1')" }] }];
  const scenario = { schemaVersion: 1, adapter: 'node-api', module: 'src/ledger.js', factory: 'createLedger', args: [], oracle: { references: [{ requirementId: 'R-1', quote }], explanation: 'After 800 of 1000 is held, 800 more is not available.' },
    steps: [{ id: 'S-1', method: 'open', args: ['a'] }, { id: 'S-2', method: 'deposit', args: ['a', 1000, 'd1'] }, { id: 'S-3', method: 'hold', args: ['a', 800, 'k1'] }, { id: 'S-4', method: 'hold', args: ['a', 800, 'k2'], expect: { path: [], throwsCode: 'INSUFFICIENT_FUNDS' } }] };
  const calls: string[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-evalv4-data-'));
  dirs.push(dataDir);
  class Scripted extends LocalRuntime {
    override async runAgent(x: AgentExecution) {
      const dir = this.workspacePath(x.run, 'A');
      const tag = x.prompt.includes('Author lập kế hoạch') ? 'author:plan' : x.role;
      calls.push(tag);
      let output = '';
      if (x.role === 'planner') output = fence({ requirements: [{ id: 'R-1', text: task.spec.trim(), required: true, manual: false }], acceptanceExamples: ['deposit 1000, hold 800, a second hold of 800 fails'], interfaces: ['createLedger'], assumptions: [], scope: [] });
      else if (tag === 'author:plan') output = fence(plan());
      else if (x.role === 'author') { mkdirSync(path.join(dir, 'tests'), { recursive: true }); writeFileSync(path.join(dir, 'tests/ledger.test.js'), testSource); output = fence({ entries }); }
      else if (x.role === 'developer') { writeFileSync(path.join(dir, 'src/ledger.js'), buggy && !x.prompt.includes('AVAILABLE_FIX') ? buggySource : reference); output = fence({ reuse: [] }); }
      else if (x.role === 'verifier') {
        const fixed = readFileSync(path.join(dir, 'src/ledger.js'), 'utf8').includes('view(name).available < amount');
        output = fixed ? fence({ decision: 'pass', findings: [] }) : fence({ decision: 'block', findings: [{ category: 'behavior', severity: 'major', title: 'A hold can exceed the available funds', location: 'src/ledger.js', evidence: 'Hold 800 twice with 1000 in the account: the second hold is granted.', suggestion: 'AVAILABLE_FIX: compare the amount with available, not with total.', reproduction: scenario }] });
      }
      return { output, usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costUsd: 0.001 } };
    }
  }
  return { task, dataDir, calls, runtime: new Scripted({ dataDir }) };
}

describe('the v4 check runner', () => {
  it('runs Department through a confirmed finding to a proven fix and grades the workspace with the hidden grader', async () => {
    const f = await scripted(true);
    const requests: { kind: string; findings?: { id: string; proposal?: { hash: string } }[] }[] = [];
    const row = await runAssignment({ task: f.task, arm: 'department', name: 'dry-department', data: f.dataDir, runtimeFor: () => f.runtime,
      decide: async (request: { kind: string; findings?: { id: string; proposal?: { hash: string } }[] }) => {
        requests.push(request);
        if (request.kind === 'contract') return { action: 'approve', note: 'Contract states the SPEC.' };
        if (request.kind === 'findings') return { findings: request.findings!.map((x) => ({ action: 'confirm', id: x.id, proposalHash: x.proposal!.hash })), note: 'Oracle quotes the hold rule.' };
        return { action: 'reject' };
      } });
    expect(requests.map((r) => r.kind)).toEqual(['contract', 'findings']);
    expect(row.status, JSON.stringify({ blocker: row.blocker, reasons: row.completionReasons, roles: row.roles })).toBe('awaiting_acceptance');
    expect(row).toMatchObject({ arm: 'department', mode: 'verify', status: 'awaiting_acceptance', ready: true, evidenceComplete: true, graderPass: true, falseReady: false, findingsReproduced: 1, regressionsProposed: 1, regressionsCreated: 1, repairRounds: 1 });
    expect(row.grader).toMatchObject({ passed: 32, total: 32 });
    expect(row.findings[0]).toMatchObject({ resolution: 'verified_fix', status: 'resolved' });
    expect(row.interventions.map((i: { kind: string; action: string }) => `${i.kind}:${i.action}`)).toEqual(['contract:approve', 'findings:confirm']);
    expect(Math.abs(row.costUsd)).toBeGreaterThan(0);
    expect(f.calls.filter((c) => c === 'developer')).toHaveLength(2);
  }, 240000);

  it('reports a Department run that its own checks called ready but the hidden grader fails as a false ready', async () => {
    const f = await scripted(true);
    // The Verifier passes the buggy code: nothing in the product's evidence catches it, only the hidden grader does.
    class Blind extends (f.runtime.constructor as typeof LocalRuntime) {
      override async runAgent(x: AgentExecution) { const r = await super.runAgent(x); return x.role === 'verifier' ? { ...r, output: fence({ decision: 'pass', findings: [] }) } : r; }
    }
    const runtime = new Blind({ dataDir: f.dataDir });
    const row = await runAssignment({ task: f.task, arm: 'department', name: 'dry-blind', data: f.dataDir, runtimeFor: () => runtime, decide: async () => ({ action: 'approve' }) });
    expect(row).toMatchObject({ status: 'awaiting_acceptance', ready: true, graderPass: false, falseReady: true, findingsReproduced: 0 });
    expect(row.grader.failed.length).toBeGreaterThan(0);
  }, 240000);

  it('runs Single with only a contract decision and the same effective budget', async () => {
    const f = await scripted(false);
    const kinds: string[] = [];
    const row = await runAssignment({ task: f.task, arm: 'single', name: 'dry-single', data: f.dataDir, runtimeFor: () => f.runtime, decide: async (r: { kind: string }) => { kinds.push(r.kind); return { action: 'approve' }; } });
    expect(kinds).toEqual(['contract']);
    expect(row).toMatchObject({ arm: 'single', mode: 'single', graderPass: true, findingsReproduced: 0, regressionsCreated: 0 });
    expect(f.calls).not.toContain('author');
    expect(f.calls).not.toContain('verifier');
  }, 240000);

  it('stops when the orchestrator stops the run and still grades what exists', async () => {
    const f = await scripted(false);
    const row = await runAssignment({ task: f.task, arm: 'department', name: 'dry-stop', data: f.dataDir, runtimeFor: () => f.runtime, decide: async () => ({ action: 'stop', note: 'Contract contradicts the SPEC.' }) });
    expect(row).toMatchObject({ stoppedByOrchestrator: 'Contract contradicts the SPEC.', reachedDeveloper: false, graderPass: false });
    expect(row.grader.passed).toBe(0);
  }, 120000);

  it('renders every column the check reports, per arm and per run', () => {
    const base = { grader: { passed: 32, total: 32, failed: [] }, automaticMs: 600000, costUsd: 1.5, interventions: [], authorTestsWrong: { diagnosedAsTestError: 0 }, evidenceComplete: true, falseReady: false, findingsReproduced: 1, regressionsCreated: 1, graderPass: true, status: 'awaiting_acceptance' };
    const rows = [{ ...base, assignmentId: 'a:department:1', arm: 'department' }, { ...base, assignmentId: 'a:single:1', arm: 'single', evidenceComplete: false, falseReady: true, graderPass: false, grader: { passed: 30, total: 32, failed: ['x'] } }];
    const protocol = { protocolHash: 'a'.repeat(64), lockedAt: 'now', model: 'gpt-6-luna', effort: 'medium', effectiveCapUsd: 10.8, automaticLimitMinutes: 30, assignments: rows };
    const text = renderReport(protocol, rows, [{ assignmentId: 'a:single:1', test: 'x', verdict: 'grader hợp lệ', reason: 'SPEC rule 4' }]);
    for (const heading of ['Đạt grader', 'Hoàn tất đủ bằng chứng', 'Lỗi lọt khi báo sẵn sàng', 'Finding tái hiện', 'Regression tạo', 'Test Author sai', 'Lượt can thiệp', 'Phút TB', 'Chi phí TB', 'chưa đủ kết luận']) expect(text).toContain(heading);
    expect(summarizeRows(rows).find((s: { arm: string }) => s.arm === 'single')).toMatchObject({ falseReady: 1, graderPass: 0, evidenceComplete: 0 });
  });
});
