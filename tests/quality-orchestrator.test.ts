import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupV2 as setup, setupLegacy, green } from './helpers.js';
import { fence, plan, entries, currentPlan, qualityReply, qualityGreen, qualityReport } from './quality-fixtures.js';
import { hashContract, sha256 } from '../src/core/contract.js';
import { renderReportMarkdown } from '../src/core/report.js';
import { buildApp } from '../src/server/app.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { FakeRuntime } from '../src/runtime/fake.js';
import { recipeHash } from '../src/core/qualityevidence.js';
import type { MutationResult } from '../src/shared/quality.js';
import type { MutationExecution } from '../src/runtime/mutation.js';

const environment = (negative: Parameters<typeof qualityReport>[0] = 'passed') => setup({ files: e => e.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], reply: qualityReply, check: () => ({ ...qualityGreen, report: qualityReport(negative), exitCode: negative === 'failed' ? 1 : 0 }) });

describe('Verify quality policy v2', () => {
  it('plans before approval, locks the manifest before Developer, and reports exact cases with mutation limitations', async () => {
    const e = environment(), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    const d = e.orchestrator.detail(run.id);
    expect(d.run.qualityPolicyVersion).toBe(2);
    expect(d.attempts.map(a => `${a.role}:${a.stage}`)).toEqual(['planner:prepare', 'author:prepare', 'author:implement', 'developer:implement', 'verifier:verify']);
    expect(d.quality.cases.map(c => c.status)).toEqual(['passed', 'passed']);
    expect(d.run.status).toBe('awaiting_acceptance');
    const manifest = d.artifacts.find(a => a.title === 'Test manifest')!;
    expect(manifest.checkpoint).not.toBe(run.checkpoint);
    expect(d.checks[0]!.manifestHash).toBe(manifest.hash);
    const report = await e.orchestrator.report(run.id);
    expect(report.quality.cases[1]).toMatchObject({ caseId: 'C-2', status: 'passed', manifestHash: manifest.hash });
    expect(report.warnings.some(w => /Runtime này chưa cung cấp/.test(w.text))).toBe(true);
    expect(renderReportMarkdown(report)).toContain('C-2');
    expect(renderReportMarkdown(report)).toContain('không chứng minh mọi tình huống');
  });
  it.each(['missing', 'skipped', 'failed'] as const)('blocks a %s negative case even when happy case covers the same R-1', async status => {
    const e = environment(status), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    const d = e.orchestrator.detail(run.id);
    expect(d.completion.ready).toBe(false);
    expect(d.quality.cases[1]!.status).not.toBe('passed');
    await expect(e.orchestrator.acceptRun(run.id, { acknowledgeWarnings: true })).rejects.toThrow();
    expect(e.runtime.calls).not.toContain('deliver:A');
  });
  it('blocks an empty Author and does not invoke Author repeatedly on resume', async () => {
    const e = setup({ reply: qualityReply, files: x => x.role === 'author' ? [] : ['src/a.ts'], check: () => qualityGreen });
    const run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    expect(run.status).toBe('blocked');
    expect(run.blocker).toContain('Manifest Author');
    const count = e.runtime.calls.filter(c => c.startsWith('agent:')).length;
    e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    expect(e.runtime.calls.filter(c => c.startsWith('agent:')).length).toBe(count);
    expect(e.runtime.calls).not.toContain('agent:developer:A');
  });
  it('warns about an untested supplementary case without blocking the required happy case', async () => {
    const optional = plan(); optional.cases[1]!.required = false; optional.cases[1]!.priority = 'normal';
    const e = setup({ files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], reply: x => x.prompt.includes('Author lập kế hoạch') ? fence(currentPlan(optional, x.run.contract)) : qualityReply(x), check: () => ({ ...qualityGreen, report: qualityReport('missing') }) });
    const run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    expect(run.status).toBe('awaiting_acceptance');
    expect((await e.orchestrator.report(run.id)).warnings.some(w => /C-2: ca bổ sung/.test(w.text))).toBe(true);
  });
  it('locks observed test identities in Single even when no new test files were authored', async () => {
    let missing = false;
    const e = setup({ check: () => missing ? { ...qualityGreen, report: { testResults: [{ assertionResults: [{ title: '[R-1] different', status: 'passed' }] }] } } : { ...qualityGreen, report: { testResults: [{ assertionResults: [{ title: '[R-1] observed', status: 'passed' }] }] } } });
    const run = await e.drive(e.create());
    expect(e.orchestrator.detail(run.id).artifacts.some(a => a.title === 'Test manifest')).toBe(true);
    missing = true;
    e.orchestrator.recheck(run.id, false); await e.orchestrator.idle();
    expect(e.orchestrator.detail(run.id).completion.ready).toBe(false);
    expect(e.orchestrator.detail(run.id).checks.at(-1)!.missingTestIds).toContain('[R-1] observed');
  });
  it('uses reporter identities from JUnit without requiring Java/Python names to contain brackets', async () => {
    const p = plan(), manifest = entries().map(e => ({ ...e, testId: `orders::test_R_1_${e.caseId.replace('-', '_')}` }));
    const e = setup({ files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], reply: x => x.prompt.includes('Author lập kế hoạch') ? fence(currentPlan(p, x.run.contract)) : x.role === 'author' ? fence({ entries: manifest.map(m => ({ ...m, identity: { kind: 'junit', className: 'orders', name: m.testId.split('::')[1] } })) }) : undefined,
      check: () => ({ ...qualityGreen, report: `<testsuite>${manifest.map(m => `<testcase classname="orders" name="${m.testId.split('::')[1]}"/>`).join('')}</testsuite>` }) });
    const run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    expect(e.orchestrator.detail(run.id).quality.cases.map(c => c.status)).toEqual(['passed', 'passed']);
  });
  it('marks the planning call read-only and carries its approved plan into all implementing and checking prompts', async () => {
    const calls: { role: string; prompt: string; readOnly?: boolean; skills?: unknown }[] = [];
    const e = setup({ files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], reply: x => { calls.push(x); return qualityReply(x); }, check: () => qualityGreen });
    await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    const planning = calls.find(c => c.prompt.includes('Author lập kế hoạch'))!;
    expect(planning.readOnly).toBe(true);
    expect(planning.prompt).not.toContain('Diff:');
    for (const call of calls.filter(c => c.role === 'developer' || c.role === 'verifier' || (c.role === 'author' && !c.readOnly))) expect(call.prompt).toContain('Retry tạo đơn trùng');
  });
  it('does not loop on invalid planning output or exceed the existing budget', async () => {
    const e = setup({ reply: x => x.role === 'author' ? 'not json' : undefined });
    const run = e.create({ mode: 'verify' }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    // Unreadable Author output no longer dead-ends: the contract gets a minimal plan and waits for approval.
    expect(e.orchestrator.detail(run.id).run.status).toBe('awaiting_approval');
    expect(e.orchestrator.detail(run.id).contractReview.problems).toEqual([]);
    const count = e.runtime.calls.filter(c => c.startsWith('agent:')).length;
    const stored = e.store.runs.get(run.id)!; stored.status = 'paused'; e.store.runs.put(stored);
    e.orchestrator.resumeRun(run.id); await e.orchestrator.idle();
    expect(e.runtime.calls.filter(c => c.startsWith('agent:')).length).toBe(count);
    const tiny = environment(), r = tiny.create({ mode: 'verify', budgetUsd: 0.001 });
    tiny.orchestrator.startRun(r.id); await tiny.orchestrator.idle();
    expect(tiny.orchestrator.detail(r.id).run.status).toBe('blocked');
    expect(tiny.orchestrator.detail(r.id).run.budgetUsd).toBe(r.budgetUsd);
  });
  it('edits invalidate approval and stale hash while the API cannot bypass required case evidence', async () => {
    const e = environment('missing'), run = e.create({ mode: 'verify', budgetUsd: 10 });
    e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    const before = e.orchestrator.detail(run.id);
    const c = structuredClone(before.run.contract); c.testPlan!.cases[1]!.expected += '; tồn kho không đổi';
    e.orchestrator.reviseContract(run.id, c);
    const app = await buildApp({ store: e.store, orchestrator: e.orchestrator, dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-quality-api-')), port: 14322 });
    try {
      const headers = { host: '127.0.0.1:14322', 'x-csrf-token': (await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:14322' } })).json().token };
      const approve = (hash: string) => app.inject({ method: 'POST', url: `/api/runs/${run.id}/approve-contract`, headers, payload: { contractHash: hash, acknowledgeWarnings: true } });
      expect((await approve(before.contractReview.contractHash)).statusCode).toBe(409);
      const after = e.orchestrator.detail(run.id);
      expect(after.run.contractReviewReceipt).toBeUndefined();
      expect((await approve(after.contractReview.contractHash)).statusCode).toBe(200); await e.orchestrator.idle();
      const accept = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/accept`, headers, payload: { acknowledgeWarnings: true } });
      expect(accept.statusCode).toBe(409);
    } finally { await app.close(); }
  });
  it('rechecks without any AI and invalidates evidence when the recipe changes', async () => {
    let missing = true;
    const e = setup({ reply: qualityReply, files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/a.ts'], check: () => ({ ...qualityGreen, report: qualityReport(missing ? 'missing' : 'passed') }) });
    const run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 })), count = e.runtime.calls.filter(c => c.startsWith('agent:')).length;
    missing = false;
    e.orchestrator.recheck(run.id, false); await e.orchestrator.idle();
    expect(e.runtime.calls.filter(c => c.startsWith('agent:')).length).toBe(count);
    expect(e.orchestrator.detail(run.id).quality.cases.every(c => c.status === 'passed')).toBe(true);
    const stored = e.store.runs.get(run.id)!; stored.configSnapshot.checks[0]!.command.push('--other'); e.store.runs.put(stored);
    expect(e.orchestrator.detail(run.id).quality.cases.every(c => c.status === 'missing')).toBe(true);
  });
  it('keeps old Verify runs on their old policy without extra planning calls', async () => {
    const e = setupLegacy({ check: () => green }), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    expect(run.qualityPolicyVersion).toBeUndefined();
    expect(e.orchestrator.detail(run.id).quality.enabled).toBe(false);
    expect(e.orchestrator.detail(run.id).attempts.map(a => a.role)).toEqual(['planner', 'author', 'developer', 'verifier']);
  });
  it('persists mutation before Verifier, reuses it on resume, and only reruns tools on explicit recheck', async () => {
    const e = environment();
    const capability = { status: 'available' as const, adapter: 'stryker-vitest' as const, reason: 'fixture', root: '.' };
    Object.assign(e.runtime, { detectMutation: async () => capability, runMutation: async ({ run, slot }: MutationExecution): Promise<MutationResult> => {
      e.runtime.calls.push(`mutation:${slot}`);
      return { schemaVersion: 1, source: 'stryker-vitest', status: 'completed', slot, checkpoint: run.checkpoint!, contractVersion: run.contract.version, configHash: recipeHash(run), capability,
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 12, baseline: 'passed', counts: { killed: 2, survived: 1, no_coverage: 0, timeout: 1, errors: 0, pending: 0 },
        mutants: [{ file: 'src/order.ts', line: 1, status: 'Survived', mutator: 'Conditional' }], files: ['src/order.ts'], message: 'fixture result' };
    } });
    const run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    expect(e.runtime.calls.indexOf('mutation:A')).toBeLessThan(e.runtime.calls.indexOf('agent:verifier:A'));
    expect(e.orchestrator.detail(run.id).quality.mutation?.counts).toMatchObject({ survived: 1, timeout: 1 });
    const report = await e.orchestrator.report(run.id);
    expect(report.warnings.some(w => /sống sót/.test(w.text))).toBe(true);
    expect(renderReportMarkdown(report)).toContain('timeout: 1');
    const stored = e.store.runs.get(run.id)!; stored.status = 'paused'; e.store.runs.put(stored);
    e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    expect(e.runtime.calls.filter(c => c === 'mutation:A')).toHaveLength(1);
    const agents = e.runtime.calls.filter(c => c.startsWith('agent:')).length;
    e.orchestrator.recheck(run.id, false); await e.orchestrator.idle();
    expect(e.runtime.calls.filter(c => c === 'mutation:A')).toHaveLength(2);
    expect(e.runtime.calls.filter(c => c.startsWith('agent:')).length).toBe(agents);
  });
  it('stores an incomplete mutation when its executor throws, and stopping prevents a later Verifier call', async () => {
    const e = environment(); let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    Object.assign(e.runtime, { detectMutation: async () => ({ status: 'available', reason: 'fixture' }), runMutation: async ({ signal }: MutationExecution) => {
      started(); return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('interrupted fixture')), { once: true }));
    } });
    const run = e.create({ mode: 'verify', budgetUsd: 10 }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    e.orchestrator.approveContract(run.id, { contractHash: e.orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true });
    await ready; e.orchestrator.stopRun(run.id); await e.orchestrator.idle();
    expect(e.orchestrator.detail(run.id).run.status).toBe('paused');
    expect(e.orchestrator.detail(run.id).quality.mutation?.status).toBe('incomplete');
    expect(e.runtime.calls).not.toContain('agent:verifier:A');
  });
  it('never recovers an interrupted mutation as a completed result', async () => {
    const e = environment(), run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
    const content = JSON.stringify({ schemaVersion: 1, status: 'in_progress', configHash: recipeHash(run), slot: 'A', checkpoint: run.checkpoint, contractVersion: run.contract.version, capability: { status: 'available' } });
    e.store.artifacts.put({ id: 'interrupted', runId: run.id, kind: 'report', title: 'Mutation result', content, hash: sha256(content), checkpoint: run.checkpoint, contractVersion: run.contract.version, valid: true, createdAt: new Date().toISOString() });
    const restarted = new Orchestrator(e.store, () => new FakeRuntime()); await restarted.recover();
    expect(JSON.parse(e.store.artifacts.get('interrupted')!.content).status).toBe('incomplete');
    expect(e.store.artifacts.get('interrupted')!.hash).toBe(sha256(e.store.artifacts.get('interrupted')!.content));
  });
});
