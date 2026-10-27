import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cleanupFixtures, v4Fixture, scenario, TITLE } from './v4-fixtures.js';

afterEach(cleanupFixtures);
import { renderReportMarkdown } from '../src/core/report.js';
import { evidenceBlockers } from '../src/core/findingproof.js';
import { generateRegression, parseRegressionFile } from '../src/core/regression.js';
import { passed, regressionRun } from './v4-fixtures.js';

const readdirWorkspace = (workspace: string): boolean => existsSync(path.join(workspace, 'tests/aidept-regressions')) && readdirSync(path.join(workspace, 'tests/aidept-regressions')).length > 0;

async function blocked(options: Parameters<typeof v4Fixture>[0] = {}) {
  const f = await v4Fixture(options);
  await f.approve(f.run.id);
  return { ...f, detail: () => f.orch.detail(f.run.id) };
}
const confirmWithHash = async (f: Awaited<ReturnType<typeof blocked>>, api: Awaited<ReturnType<Awaited<ReturnType<typeof blocked>>['app']>>) => {
  const d = f.detail(), finding = d.findings[0]!, proposal = d.regressionProposals![0]!;
  const r = await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/confirm`, { proposalHash: proposal.hash });
  expect(r.statusCode, r.body).toBe(200);
  return { finding, proposal };
};

describe('a repair is only "fixed" when the runner shows it', () => {
  it('keeps the finding open and acceptance blocked when the Developer leaves the defect and the regression still fails', async () => {
    const f = await blocked({ fix: false });
    const api = await f.app(), { finding } = await confirmWithHash(f, api);
    await api.post(`/api/runs/${f.run.id}/repair`); await f.orch.idle();
    const d = f.detail();
    expect(d.run.status).toBe('blocked');
    expect(d.findings.find(x => x.id === finding.id)).toMatchObject({ status: 'open', confirmed: true });
    expect(d.findings[0]!.resolution).toBeUndefined();
    expect(d.completion.ready).toBe(false);
    // The locked regression was in the checkpoint and failed there: that is what stopped the run, not a green suite.
    expect(d.checks.at(-1)!.status).toBe('failed');
    expect(d.checks.at(-1)!.outcomes!.some(o => o.status === 'failed' && o.id.includes('aidept-regressions'))).toBe(true);
    expect(d.findingProofs![0]!.level).not.toBe('proven_fixed');
    await api.close(); f.store.close();
  }, 180000);

  it('re-running a counterexample uses the queue and no agent, and makes an earlier confirmation stale', async () => {
    const f = await blocked();
    const api = await f.app(), { finding, proposal } = await confirmWithHash(f, api);
    const agents = f.calls.length;
    const wrong = await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/replay`, { proposalHash: '1'.repeat(64) });
    expect(wrong.statusCode).toBe(409);
    const replay = await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/replay`, { proposalHash: proposal.hash });
    expect(replay.statusCode, replay.body).toBe(200);
    await f.orch.idle();
    expect(f.calls.length).toBe(agents);
    const d = f.detail();
    expect(d.findingReplays!.filter(r => r.status === 'reproduced').length).toBeGreaterThanOrEqual(1);
    const fresh = d.regressionProposals![0]!;
    expect(fresh.id).not.toBe(proposal.id);
    // The person confirmed the old proposal; the new one has not been read, so repair is refused until it is confirmed again.
    const refused = await api.post(`/api/runs/${f.run.id}/repair`);
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('không còn khớp');
    expect(f.calls.length).toBe(agents);
    if (fresh.hash !== proposal.hash) {
      expect((await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/confirm`, { proposalHash: proposal.hash })).statusCode).toBe(409);
      expect((await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/confirm`, { proposalHash: fresh.hash })).statusCode).toBe(200);
    }
    await api.close(); f.store.close();
  }, 180000);

  it('does not confirm, close or repair on a bare finding id: a reason or a hash is required', async () => {
    const f = await blocked();
    const api = await f.app(), id = f.detail().findings[0]!.id;
    expect((await api.post(`/api/runs/${f.run.id}/findings/${id}/resolve`, {})).statusCode).toBe(400);
    expect((await api.post(`/api/runs/${f.run.id}/findings/${id}/resolve`, { reason: 'ok' })).statusCode).toBe(400);
    expect((await api.post(`/api/runs/${f.run.id}/findings/${id}/confirm`, { manualReason: 'x' })).statusCode).toBe(400);
    expect((await api.post(`/api/runs/${f.run.id}/repair`)).statusCode).toBe(409);
    expect((await api.post(`/api/runs/${f.run.id}/findings/${id}/confirm`, { proposalHash: 'not-a-hash' })).statusCode).toBe(400);
    expect(f.detail().findings[0]).toMatchObject({ confirmed: false, status: 'open' });
    await api.close(); f.store.close();
  }, 120000);
});

describe('findings with no automatic regression are reviewed by a person, with the limit stated', () => {
  it('project that cannot host a generated test: no regression is claimed; manual confirmation needs a reason; the replay still proves the repair', async () => {
    const f = await blocked({ project: { regressionRecipe: 'nope' } });
    const d = f.detail(), proposal = d.regressionProposals![0]!, id = d.findings[0]!.id, api = await f.app();
    expect(proposal.unsupported).toContain('nope');
    expect(proposal.patch).toBeUndefined();
    const hashOnly = await api.post(`/api/runs/${f.run.id}/findings/${id}/confirm`, { proposalHash: proposal.hash });
    expect(hashOnly.statusCode).toBe(400);
    expect(hashOnly.body).toContain('review thủ công');
    const manual = await api.post(`/api/runs/${f.run.id}/findings/${id}/confirm`, { manualReason: 'Đã chạy tay kịch bản S-1…S-6 và thấy blockedBy là B.' });
    expect(manual.statusCode, manual.body).toBe(200);
    expect(f.detail().findings[0]!.confirmation).toMatchObject({ kind: 'manual' });
    await api.post(`/api/runs/${f.run.id}/repair`); await f.orch.idle();
    const after = f.detail();
    expect(after.findings[0]!.resolution).toMatchObject({ kind: 'verified_fix', regression: 'unsupported' });
    expect(after.regressionFiles ?? []).toHaveLength(0);
    const report = await f.orch.report(f.run.id);
    expect(report.warnings.some(w => /chưa có test regression|Chưa có test regression/.test(w.text))).toBe(true);
    await api.close(); f.store.close();
  }, 180000);

  it('a finding without a runnable counterexample keeps blocking; a manual close is recorded as such, never as "fixed"', async () => {
    const f = await blocked({ finding: 'prose' });
    const d = f.detail(), finding = d.findings[0]!, api = await f.app();
    expect(finding.reproduction).toBeUndefined();
    expect(finding.reproductionLimitation).toBeTruthy();
    expect(d.run.status).toBe('blocked');
    expect(d.completion.reasons.join(' ')).toContain('finding blocker/major');
    expect(d.regressionProposals ?? []).toHaveLength(0);
    // One repair round used on a doubt does not turn it into a warning (the older policies did).
    expect((await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/confirm`, { manualReason: 'Đọc code: cancel bỏ qua job đã blocked.' })).statusCode).toBe(200);
    await api.post(`/api/runs/${f.run.id}/repair`); await f.orch.idle();
    const mid = f.detail();
    expect(mid.findings[0]).toMatchObject({ status: 'open' });
    expect(mid.completion.ready).toBe(false);
    const closed = await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/resolve`, { reason: 'Đã đọc diff và chạy lại kịch bản S-1…S-6 bằng tay, blockedBy là A.' });
    expect(closed.statusCode, closed.body).toBe(200);
    const done = f.detail();
    expect(done.findings[0]!.resolution).toMatchObject({ kind: 'manual_review' });
    expect(done.findingProofs![0]!.level).toBe('manual_decision');
    expect(done.run.status).toBe('awaiting_acceptance');
    const report = await f.orch.report(f.run.id);
    expect(report.warnings.some(w => w.level === 'warn' && w.text.includes('review thủ công'))).toBe(true);
    expect(renderReportMarkdown(report)).not.toContain('| ĐÃ CHỨNG MINH SỬA XONG |');
    await api.close(); f.store.close();
  }, 180000);
});

describe('where the regression goes and when it cannot be tried', () => {
  it('uses the folder the project configures, and does not claim a regression the runner cannot find there', async () => {
    const custom = await blocked({ project: { regressionDir: 'tests/guards' } });
    const proposal = custom.detail().regressionProposals![0]!;
    expect(proposal.path).toMatch(/^tests\/guards\/scheduler-fnd_[0-9a-f]{8}\.test\.js$/);
    expect(proposal.trial?.status, proposal.trial?.message).toBe('failed_as_expected');
    custom.store.close();
    const outside = await blocked({ project: { regressionDir: 'guards' } });
    // Vitest only includes tests/**: the file is never collected, which the trial reports as a setup problem.
    expect(outside.detail().regressionProposals![0]!.trial?.status).toBe('discovery_error');
    outside.store.close();
  }, 120000);

  it('does not offer a regression the runner could not discover: a configuration that skips the folder is a setup error, not evidence', async () => {
    const f = await blocked({ project: { regressionDir: 'tests/guards' }, include: 'tests/*.test.js' });
    const d = f.detail(), proposal = d.regressionProposals![0]!, api = await f.app();
    expect(proposal.trial?.status).toBe('discovery_error');
    expect(proposal.trial?.message).toContain('không phải bằng chứng về finding');
    const refused = await api.post(`/api/runs/${f.run.id}/findings/${d.findings[0]!.id}/confirm`, { proposalHash: proposal.hash });
    expect(refused.statusCode).toBe(400);
    expect(f.detail().findings[0]!.confirmed).toBe(false);
    await api.close(); f.store.close();
  }, 120000);

  it('records a trial that was cancelled as interrupted, and an interrupted trial cannot be confirmed', async () => {
    const f = await blocked();
    const d = f.detail(), finding = d.findings[0]!, replay = d.findingReplays![0]!;
    const regressions = (f.orch as unknown as { verification: { regressions: { propose(id: string, f: unknown, r: unknown, s: AbortSignal): Promise<{ trial?: { status: string }; hash: string } | undefined> } } }).verification.regressions;
    const controller = new AbortController(); controller.abort();
    const cancelled = await regressions.propose(f.run.id, finding, replay, controller.signal);
    expect(cancelled!.trial!.status).toBe('interrupted');
    const api = await f.app();
    expect((await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/confirm`, { proposalHash: cancelled!.hash })).statusCode).toBe(400);
    expect(readdirWorkspace(f.workspace())).toBe(false);
    await api.close(); f.store.close();
  }, 120000);

  it('a changed project configuration voids a confirmation that was given before the change', async () => {
    const f = await blocked();
    const api = await f.app(), { finding } = await confirmWithHash(f, api);
    const run = f.store.runs.get(f.run.id)!;
    run.configSnapshot = { ...run.configSnapshot, policyRules: [...run.configSnapshot.policyRules, 'a rule added after the proposal was read'] };
    f.store.runs.put(run);
    const refused = await api.post(`/api/runs/${f.run.id}/repair`);
    expect(refused.statusCode).toBe(409);
    expect(f.orch.detail(f.run.id).findings.find(x => x.id === finding.id)!.status).toBe('open');
    await api.close(); f.store.close();
  }, 120000);

  it('re-checking runs the regression on the live checkpoint and calls no agent', async () => {
    const f = await blocked();
    const api = await f.app(), { proposal } = await confirmWithHash(f, api);
    await api.post(`/api/runs/${f.run.id}/repair`); await f.orch.idle();
    const agents = f.calls.length;
    f.orch.recheck(f.run.id, false); await f.orch.idle();
    const d = f.detail();
    expect(f.calls.length).toBe(agents);
    expect(d.checks.at(-1)!.outcomes!.find(o => o.id === proposal.testId)?.status).toBe('passed');
    expect(d.run.status, d.run.blocker ?? '').toBe('awaiting_acceptance');
    await api.close(); f.store.close();
  }, 180000);
});

describe('delivered regressions are protected and re-applied', () => {
  it('applying twice is a no-op, and a later run on the project keeps the test locked and running', async () => {
    const f = await blocked();
    const api = await f.app(), { proposal } = await confirmWithHash(f, api);
    await api.post(`/api/runs/${f.run.id}/repair`); await f.orch.idle();
    const done = f.detail(), checkpoint = done.run.checkpoint;
    const regressions = (f.orch as unknown as { verification: { regressions: { applyConfirmed(id: string, t: unknown[]): Promise<void> } } }).verification.regressions;
    await regressions.applyConfirmed(f.run.id, done.findings);
    expect(f.detail().run.checkpoint).toBe(checkpoint);
    // The project receives the test next to the fix when the person accepts.
    await f.orch.acceptRun(f.run.id, { acknowledgeWarnings: true });
    const delivered = path.join(f.source, proposal.path!);
    expect(existsSync(delivered)).toBe(true);
    const ref = parseRegressionFile(proposal.path!, readFileSync(delivered, 'utf8'))!;
    expect(ref).toMatchObject({ findingId: done.findings[0]!.id, recipeId: 'test', intact: true });
    // A later run that brings the defect back is caught by the test the project now holds.
    const second = f.create('Later change');
    f.orch.startRun(second.id); await f.orch.idle(); await f.approve(second.id);
    const later = f.orch.detail(second.id);
    expect(later.regressionFiles?.map(r => r.path), `${later.run.status}: ${later.run.blocker}`).toEqual([proposal.path]);
    expect(later.run.status).not.toBe('awaiting_acceptance');
    expect(later.checks.at(-1)?.outcomes?.some(o => o.id === proposal.testId && o.status === 'failed')).toBe(true);
    await api.close(); f.store.close();
  }, 240000);

  const delivered = generateRegression({ finding: { id: 'fnd_0a0a0a0a', title: TITLE }, scenario: scenario(), recipeId: 'test', dir: 'tests/aidept-regressions' });
  const install = (source: string) => { mkdirSync(path.join(source, 'tests/aidept-regressions'), { recursive: true }); writeFileSync(path.join(source, delivered.path), delivered.source); };
  it.each([['edits', (file: string) => appendFileSync(file, '// the agent weakened this\n')], ['deletes', (file: string) => rmSync(file)]] as const)('refuses a Developer patch that %s a delivered regression', async (_name, tamper) => {
    const f = await v4Fixture({ finding: 'none', preinstall: install, developerExtra: dir => { const file = path.join(dir, delivered.path); if (existsSync(file)) tamper(file); } });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    expect(d.regressionFiles?.map(r => r.path)).toEqual([delivered.path]);
    expect(['blocked', 'failed']).toContain(d.run.status);
    expect(d.run.blocker ?? '').toContain('được bảo vệ');
    expect(d.completion.ready).toBe(false);
    f.store.close();
  }, 120000);

  it('detects an edited delivered regression by the hash in its own header', () => {
    expect(parseRegressionFile(delivered.path, delivered.source)).toMatchObject({ intact: true, recipeId: 'test', findingId: 'fnd_0a0a0a0a' });
    expect(parseRegressionFile(delivered.path, delivered.source.replace('toStrictEqual', 'toBeDefined'))!.intact).toBe(false);
    expect(parseRegressionFile(delivered.path, '// ordinary test file\n')).toBeUndefined();
    // A checkout that converted the line endings is the same file, not an edit.
    expect(parseRegressionFile(delivered.path, delivered.source.replace(/\n/g, '\r\n'))).toMatchObject({ intact: true, findingId: 'fnd_0a0a0a0a' });
  });

  it('reports an edited regression as a blocker and an intact one that passed as nothing', () => {
    const run = regressionRun();
    const ref = { path: 'tests/aidept-regressions/x.test.js', recipeId: 'test', testId: 't', identity: { kind: 'json', file: 'x', titles: ['a'] }, findingId: 'f', scenarioHash: 'h', intact: true } as const;
    const input = (r: unknown) => ({ verdict: { decision: 'pass' }, findings: [], artifacts: [], regressions: [r] as never, checks: [passed(run, 'test', 't')] });
    expect(evidenceBlockers(run, input(ref))).toEqual([]);
    expect(evidenceBlockers(run, input({ ...ref, intact: false })).join(' ')).toContain('đã bị sửa');
  });
});

