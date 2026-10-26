import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanupFixtures, v4Fixture } from './v4-fixtures.js';

afterEach(cleanupFixtures);
import { renderReportMarkdown } from '../src/core/report.js';
import { readRegressionManifest } from '../src/core/regression.js';

async function blocked(options: Parameters<typeof v4Fixture>[0] = {}) {
  const f = await v4Fixture(options);
  await f.approve(f.run.id);
  return { ...f, detail: () => f.orch.detail(f.run.id) };
}

describe('counterexample → regression → repair → proof (policy v4)', () => {
  it('turns a reproduced finding into a failing, hash-bound regression proposal and keeps the finding blocking', async () => {
    const f = await blocked();
    const d = f.detail(), finding = d.findings[0]!;
    expect(d.run.qualityPolicyVersion).toBe(4);
    expect(d.run.status, d.run.blocker ?? '').toBe('blocked');
    expect(d.completion.ready).toBe(false);
    expect(d.findingReplays![0]!.status).toBe('reproduced');
    expect(finding).toMatchObject({ confirmed: false, status: 'open' });
    const proposal = d.regressionProposals![0]!;
    expect(proposal).toMatchObject({ findingId: finding.id, recipeId: 'test' });
    expect(proposal.trial?.status, proposal.trial?.message).toBe('failed_as_expected');
    expect(proposal.trial!.failure).toContain('AIDEPT-REG:S-6');
    expect(proposal.path).toMatch(/^tests\/aidept-regressions\/scheduler-fnd_[0-9a-f]{8}\.test\.js$/);
    expect(proposal.patch).toContain('new file mode');
    // Proposing changes nothing in the project: the file exists neither in the working copy nor in the original folder.
    expect(existsSync(path.join(f.workspace(), proposal.path!))).toBe(false);
    expect(existsSync(path.join(f.source, proposal.path!))).toBe(false);
    expect(d.findingProofs![0]).toMatchObject({ level: 'reproduced' });
    expect(f.calls.filter(c => c === 'developer')).toHaveLength(1);
    f.store.close();
  }, 120000);

  it('needs the exact proposal hash, applies and locks the test before the Developer, then proves the repair before and after', async () => {
    const f = await blocked();
    const before = f.detail(), finding = before.findings[0]!, proposal = before.regressionProposals![0]!, api = await f.app();
    const noHash = await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/confirm`, {});
    expect(noHash.statusCode).toBe(400);
    const stale = await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/confirm`, { proposalHash: '0'.repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect(f.orch.detail(f.run.id).findings[0]!.confirmed).toBe(false);
    const confirmed = await api.post(`/api/runs/${f.run.id}/findings/${finding.id}/confirm`, { proposalHash: proposal.hash });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(f.orch.detail(f.run.id).findings[0]!.confirmation).toMatchObject({ kind: 'regression', proposalHash: proposal.hash });
    // Confirming alone changes no code and calls no agent.
    expect(f.calls.filter(c => c === 'developer')).toHaveLength(1);

    const repair = await api.post(`/api/runs/${f.run.id}/repair`);
    expect(repair.statusCode, repair.body).toBe(200);
    await f.orch.idle();
    const after = f.detail();
    expect(after.run.status, after.run.blocker ?? '').toBe('awaiting_acceptance');
    expect(after.completion.ready, after.completion.reasons.join(' ')).toBe(true);
    expect(after.quality.cases[0]!.stepsLinked).toEqual({ linked: 2, total: 2 });
    const resolved = after.findings[0]!;
    expect(resolved).toMatchObject({ status: 'resolved', resolution: { kind: 'verified_fix', regression: 'created', regressionTestId: proposal.testId } });
    expect(resolved.resolution!.before).toMatchObject({ replay: 'reproduced', regression: 'failed_as_expected' });
    expect(resolved.resolution!.after).toMatchObject({ replay: 'not_reproduced', regression: 'passed' });
    expect(after.findingProofs![0]).toMatchObject({ level: 'proven_fixed', regression: 'created' });
    expect(after.findingReplays!.map(r => r.status)).toEqual(['reproduced', 'not_reproduced']);
    // The test is in the checkpoint, byte for byte what was shown, and was locked before the Developer ran.
    const file = path.join(f.workspace(), proposal.path!);
    expect(readFileSync(file, 'utf8')).toContain('aidept-regression');
    const manifest = readRegressionManifest(after.run, after.artifacts)!;
    expect(manifest.entries[0]).toMatchObject({ findingId: finding.id, path: proposal.path, testId: proposal.testId });
    expect(after.artifacts.some(a => a.title === 'Acceptance suite (Regression)')).toBe(true);
    const order = f.calls.filter(c => c === 'developer' || c === 'verifier');
    expect(order).toEqual(['developer', 'verifier', 'developer', 'verifier']);
    expect(after.checks.at(-1)!.outcomes!.find(o => o.id === proposal.testId)?.status).toBe('passed');
    const report = await f.orch.report(f.run.id);
    expect(report.findingProofs![0]!.level).toBe('proven_fixed');
    expect(renderReportMarkdown(report)).toContain('ĐÃ CHỨNG MINH SỬA XONG');
    expect(renderReportMarkdown(report)).toContain('Bước có assertion');
    await api.close(); f.store.close();
  }, 180000);
});
