import { identityId } from '../src/core/testids.js';
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupV2 as setup, green, report, profile } from './helpers.js';
import { entries, fence, qualityReply, qualityGreen, qualityReport } from './quality-fixtures.js';
import { summarizeCheck } from '../src/core/checks.js';
import { buildApp } from '../src/server/app.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { emptyMutationCounts, type MutationExecution } from '../src/runtime/mutation.js';
import { recipeHash } from '../src/core/qualityevidence.js';

const diagnosis = (decision = 'test_setup') => fence({ decision, reason: 'Setup creates two jobs but the third claim needs a third job.', evidence: 'Two concurrent claims consume both enqueued jobs. No third job is ready.', caseIds: ['C-2'] });
function testRepairEnvironment(options: { decision?: string; wrongFile?: boolean; after?: 'missing' | 'skipped' } = {}) {
  let applied = () => false;
  const e = setup({
    reply: x => x.prompt.includes('Author chẩn đoán') ? diagnosis(options.decision) : qualityReply(x),
    files: x => x.role === 'author' ? (options.wrongFile && x.prompt.includes('Author chẩn đoán') ? ['src/order.ts'] : ['tests/order.test.ts']) : ['src/order.ts'],
    check: () => ({ ...qualityGreen, exitCode: applied() ? 0 : 1, report: qualityReport(applied() ? options.after ?? 'passed' : 'failed') }),
  });
  applied = () => e.runtime.calls.includes('applyPatch:A');
  return e;
}

describe('check failure classification', () => {
  it('keeps failed assertions repairable; only absent/skipped locked identities are missing', () => {
    const result = summarizeCheck({ runId: 'r', id: 'c', checkpoint: 'cp', contractVersion: 1, recipe: profile().checks[0]!, lockedTestIds: ['suite.test.ts::[R-1] fail', 'suite.test.ts::skip', 'suite.test.ts::absent'] }, [{ exitCode: 1, incomplete: false, durationMs: 1, checkpoint: 'cp', log: '', report: { testResults: [{ name: 'suite.test.ts', assertionResults: [{ fullName: '[R-1] fail', status: 'failed' }, { fullName: 'skip', status: 'pending' }] }] } }]);
    expect(result.status).toBe('failed');
    expect(result.missingTestIds).toEqual(['suite.test.ts::skip', 'suite.test.ts::absent']);
    expect(result.testIds).toEqual([]); expect(result.requirementIds).toEqual([]);
    expect(result.outcomes?.[0]?.status).toBe('failed');
  });
  it('also distinguishes failed JUnit tests from missing tests', () => {
    const result = summarizeCheck({ runId: 'r', id: 'c', checkpoint: 'cp', contractVersion: 1, recipe: profile().checks[0]!, lockedTestIds: ['orders::test_R_1'] }, [{ exitCode: 1, incomplete: false, durationMs: 1, checkpoint: 'cp', log: '', report: '<testsuite><testcase classname="orders" name="test_R_1"><failure message="bad"/></testcase></testsuite>' }]);
    expect(result.missingTestIds).toEqual([]); expect(result.status).toBe('failed');
  });
  it('does not call a report with failed assertions passed just because the command exited zero', () => {
    const result = summarizeCheck({ runId: 'r', id: 'c', checkpoint: 'cp', contractVersion: 1, recipe: profile().checks[0]! }, [{ exitCode: 0, incomplete: false, durationMs: 1, checkpoint: 'cp', log: '', report: qualityReport('failed') }]);
    expect(result.status).toBe('failed'); expect(result.counts?.failed).toBe(1);
  });
});

describe('bounded repair routing', () => {
  it('repairs a real implementation defect without unlocking Author tests', async () => {
    let developerCalls = 0, diagnoses = 0;
    const e = setup({
      reply: x => { if (x.role === 'developer') developerCalls++; if (x.prompt.includes('Author chẩn đoán')) { diagnoses++; return diagnosis('implementation'); } return qualityReply(x); },
      files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'],
      check: () => ({ ...qualityGreen, exitCode: developerCalls > 1 ? 0 : 1, report: qualityReport(developerCalls > 1 ? 'passed' : 'failed') }),
    });
    const run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    const d = e.orchestrator.detail(run.id);
    expect(run.status).toBe('awaiting_acceptance'); expect(developerCalls).toBe(2); expect(diagnoses).toBe(1);
    expect(d.checks[0]!.missingTestIds).toEqual([]); expect(d.testRepair).toBeUndefined();
    expect(d.artifacts.some(a => a.title === 'Acceptance suite (Author)' && a.valid)).toBe(true);
  });
  it.each(['missing', 'skipped'] as const)('does not diagnose away a %s locked case', async negative => {
    let diagnoses = 0;
    const e = setup({ reply: x => { if (x.prompt.includes('Author chẩn đoán')) diagnoses++; return qualityReply(x); }, files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], check: () => ({ ...qualityGreen, report: qualityReport(negative) }) });
    const run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    expect(run.status).toBe('blocked'); expect(diagnoses).toBe(0);
    expect(e.orchestrator.detail(run.id).checks[0]!.missingTestIds).toEqual([identityId({ kind: 'json', file: entries()[1]!.path, titles: [entries()[1]!.testId.split('::')[1]!] })]);
    await expect(e.orchestrator.acceptRun(run.id, { acknowledgeWarnings: true })).rejects.toThrow();
  });
  it('keeps the repair limit across interrupted resume (a separate explicit retry may authorize a new batch)', async () => {
    const e = setup({ reply: x => x.prompt.includes('Author chẩn đoán') ? diagnosis('implementation') : qualityReply(x), files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], check: () => ({ ...qualityGreen, exitCode: 1, report: qualityReport('failed') }) });
    // Legacy runs exercise the original full repair cap. V2 diagnosis now stops when its checkpoint becomes stale;
    // execution-speed.test.ts separately verifies that stronger bound and prevents additional AI calls.
    const input=e.create({mode:'verify',budgetUsd:10});delete input.qualityPolicyVersion;e.store.runs.put(input);
    const run = await e.drive(input);
    const calls = e.runtime.calls.filter(c => c === 'agent:developer:A').length;
    expect(calls).toBe(3); e.store.runs.put({ ...e.store.runs.get(run.id)!, status: 'paused' });
    e.orchestrator.resumeRun(run.id); await e.orchestrator.idle();
    expect(e.runtime.calls.filter(c => c === 'agent:developer:A').length).toBe(calls);
  });
  it('adds missing requirement evidence once, preserving observed test identities', async () => {
    let calls = 0;
    const e = setup({
      reply: x => { if (x.role === 'planner') return fence({ requirements: [{ id: 'R-1', text: 'Create an order', required: true, manual: false }, { id: 'R-2', text: 'Reject duplicate', required: true, manual: false }], acceptanceExamples: ['Retry is rejected'], interfaces: [], assumptions: [], scope: [] }); if (x.role === 'developer') { calls++; if (calls === 2) expect(x.prompt).toContain('R-2: Reject duplicate'); } return undefined; },
      files: ['src/order.ts', 'tests/order.test.ts'],
      check: () => ({ ...green, report: report([{ title: '[R-1] create' }, ...(calls > 1 ? [{ title: '[R-2] rejects duplicates' }] : [])]) }),
    });
    const run = await e.drive(e.create()); expect(run.status).toBe('awaiting_acceptance'); expect(calls).toBe(2);
    expect(e.orchestrator.detail(run.id).matrix.every(r => r.status === 'verified')).toBe(true);
    const manifest = e.orchestrator.detail(run.id).artifacts.filter(a => a.title === 'Test manifest' && a.valid).at(-1)!;
    expect(manifest.content).toContain('[R-2] rejects duplicates');
  });
  it('does not buy another evidence attempt on resume if the added tests still omit the requirement', async () => {
    let calls = 0;
    const e = setup({ reply: x => { if (x.role === 'planner') return fence({ requirements: [{ id: 'R-1', text: 'Create', required: true, manual: false }, { id: 'R-2', text: 'Reject', required: true, manual: false }], acceptanceExamples: [], interfaces: [], assumptions: [], scope: [] }); if (x.role === 'developer') calls++; }, files: ['src/order.ts'], check: () => green });
    const run = await e.drive(e.create()); expect(run.status).toBe('blocked'); expect(calls).toBe(2);
    e.orchestrator.resumeRun(run.id); await e.orchestrator.idle(); expect(calls).toBe(2);
  });
});

describe('reviewed test setup repair', () => {
  it('reverts the proposal, requires exact approval, re-locks a new manifest and runs Verifier before delivery', async () => {
    const e = testRepairEnvironment(); let mutations = 0;
    const capability = { status: 'available' as const, reason: 'Fixture adapter', adapter: 'stryker-vitest' as const, root: '.' };
    Object.assign(e.runtime, { detectMutation: async () => capability, runMutation: async (x: MutationExecution) => {
      mutations++;
      return { schemaVersion: 1, source: 'stryker-vitest', status: 'completed', checkpoint: x.run.checkpoint!, contractVersion: x.run.contract.version, slot: x.slot, configHash: recipeHash(x.run), capability, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1, baseline: 'passed', counts: { ...emptyMutationCounts(), killed: 1 }, mutants: [], files: ['src/order.ts'], message: 'Fixture result; real adapter is covered by mutation.test.ts.' };
    } });
    const run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    const before = e.orchestrator.detail(run.id), proposal = before.testRepair!;
    expect(run.status).toBe('blocked'); expect(proposal.caseIds).toEqual(['C-2']);
    expect(e.runtime.calls).not.toContain('applyPatch:A'); expect((await e.runtime.changes(before.run, 'A')).files).toEqual([]);
    expect(() => e.orchestrator.resumeRun(run.id)).toThrow('đề xuất sửa test');
    expect(() => e.orchestrator.approveTestRepair(run.id, proposal.id, '0'.repeat(64))).toThrow('đã cũ');
    await expect(e.orchestrator.acceptRun(run.id, { acknowledgeWarnings: true })).rejects.toThrow();
    e.orchestrator.approveTestRepair(run.id, proposal.id, proposal.hash); await e.orchestrator.idle();
    const after = e.orchestrator.detail(run.id);
    expect(after.run.status).toBe('awaiting_acceptance'); expect(after.run.checkpoint).not.toBe(before.run.checkpoint);
    expect(after.quality.manifestHash).not.toBe(before.quality.manifestHash); expect(after.quality.cases.every(c => c.status === 'passed')).toBe(true);
    expect(after.attempts.filter(a => a.role === 'developer')).toHaveLength(1);
    expect(after.attempts.filter(a => a.role === 'verifier')).toHaveLength(1);
    expect(mutations).toBe(1); expect(after.quality.mutation?.status).toBe('completed');
    expect(after.artifacts.some(a => a.title === 'Mutation capability' && a.checkpoint === after.run.checkpoint)).toBe(true);
    expect(after.testRepair).toBeUndefined(); expect(after.run.testRepairApproval).toBeUndefined();
    await e.orchestrator.acceptRun(run.id, { acknowledgeWarnings: true });
    expect(e.store.runs.get(run.id)!.delivery?.status).toBe('succeeded'); expect(e.store.runs.get(run.id)!.status).toBe('completed');
  });
  it('recovers approved intent from persisted state without another diagnosis or Developer call', async () => {
    const e = testRepairEnvironment(), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 })), p = e.orchestrator.detail(run.id).testRepair!;
    e.store.runs.put({ ...e.store.runs.get(run.id)!, status: 'queued', testRepairApproval: { artifactId: p.id, artifactHash: p.hash } });
    const restarted = new Orchestrator(e.store, () => e.runtime); await restarted.recover();
    restarted.resumeRun(run.id); await restarted.idle();
    expect(restarted.detail(run.id).run.status).toBe('awaiting_acceptance');
    expect(e.runtime.calls.filter(c => c === 'agent:developer:A')).toHaveLength(1);
    expect(restarted.detail(run.id).artifacts.filter(a => a.title === 'Author test diagnosis attempt')).toHaveLength(1);
  });
  it('rejects a test diagnosis that writes source files', async () => {
    const e = testRepairEnvironment({ wrongFile: true }), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    expect(run.status).toBe('blocked'); expect(e.orchestrator.detail(run.id).testRepair).toBeUndefined(); expect(e.runtime.calls).not.toContain('applyPatch:A');
  });
  it('can reject the proposal without unlocking tests or calling another agent', async () => {
    const e = testRepairEnvironment(), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 })), p = e.orchestrator.detail(run.id).testRepair!;
    const calls = e.runtime.calls.filter(c => c.startsWith('agent:')).length;
    e.orchestrator.rejectTestRepair(run.id, p.id, p.hash);
    const d = e.orchestrator.detail(run.id); expect(d.testRepair).toBeUndefined();
    expect(d.artifacts.some(a => a.title === 'Acceptance suite (Author)' && a.valid)).toBe(true);
    expect(e.runtime.calls.filter(c => c.startsWith('agent:')).length).toBe(calls);
    expect(e.runtime.calls).not.toContain('applyPatch:A');
    expect(() => e.orchestrator.approveTestRepair(run.id, p.id, p.hash)).toThrow('đã cũ');
  });
  it.each(['missing', 'skipped'] as const)('even approval cannot make a %s case pass after a test repair', async after => {
    const e = testRepairEnvironment({ after }), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 })), p = e.orchestrator.detail(run.id).testRepair!;
    e.orchestrator.approveTestRepair(run.id, p.id, p.hash); await e.orchestrator.idle();
    expect(e.orchestrator.detail(run.id).completion.ready).toBe(false);
    expect(e.runtime.calls).not.toContain('agent:verifier:A');
    await expect(e.orchestrator.acceptRun(run.id, { acknowledgeWarnings: true })).rejects.toThrow();
  });
  it('invalidates a proposal if recipe, contract, checkpoint or manifest changes', async () => {
    const e = testRepairEnvironment(), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 })), p = e.orchestrator.detail(run.id).testRepair!;
    const saved = e.store.runs.get(run.id)!;
    for (const edit of [(r: typeof saved) => { r.checkpoint = 'other'; }, (r: typeof saved) => { r.contract.version++; }, (r: typeof saved) => { r.configSnapshot.checks[0]!.command.push('--other'); }, (r: typeof saved) => { r.configSnapshot.guidance = 'changed guidance'; }, (r: typeof saved) => { r.approvedPaths = ['extra']; }]) {
      const changed = structuredClone(saved); edit(changed); e.store.runs.put(changed);
      expect(() => e.orchestrator.approveTestRepair(run.id, p.id, p.hash)).toThrow('đã cũ');
    }
    e.store.runs.put(saved);
    const manifest = e.orchestrator.detail(run.id).artifacts.find(a => a.title === 'Test manifest' && a.valid)!;
    e.store.artifacts.put({ ...manifest, valid: false }); expect(() => e.orchestrator.approveTestRepair(run.id, p.id, p.hash)).toThrow('đã cũ');
  });
  it('API validates the receipt and cannot bypass the blocker before approval', async () => {
    const e = testRepairEnvironment(), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 })), p = e.orchestrator.detail(run.id).testRepair!;
    const app = await buildApp({ store: e.store, orchestrator: e.orchestrator, dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-recovery-api-')), port: 14327 });
    try {
      const host = '127.0.0.1:14327', headers = { host, 'x-csrf-token': (await app.inject({ url: '/api/session', headers: { host } })).json().token };
      const request = (payload: unknown) => app.inject({ method: 'POST', url: `/api/runs/${run.id}/approve-test-repair`, headers, payload: payload as Record<string, string> });
      expect((await request({ proposalId: p.id })).statusCode).toBe(400);
      expect((await request({ proposalId: p.id, proposalHash: '0'.repeat(64) })).statusCode).toBe(409);
      expect((await request({ proposalId: p.id, proposalHash: p.hash })).statusCode).toBe(200); await e.orchestrator.idle();
      expect(e.orchestrator.detail(run.id).run.status).toBe('awaiting_acceptance');
      expect((await request({ proposalId: p.id, proposalHash: p.hash })).statusCode).toBe(409);
    } finally { await app.close(); }
  });
});
