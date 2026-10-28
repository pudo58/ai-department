import { describe, expect, it } from 'vitest';
import { visualProfileHash } from '../src/core/visualevidence.js';
import type { VisualReport } from '../src/shared/visual.js';
import type { Run } from '../src/shared/types.js';
import { green, setupLegacy } from './helpers.js';

const PROFILE = { pathTemplate: '/?screen={nodeId}', readySelector: '[data-design-ready="true"]', pixelThreshold: 0.1, maxDiffRatio: 0.05 };

function fixture() {
  const developerPrompts: string[] = [];
  const e = setupLegacy({ check: () => green, files: (x) => (x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts']), reply: (exec) => { if (exec.role === 'developer') developerPrompts.push(exec.prompt); return undefined; } }, { visualCheck: PROFILE, executionMode: 'local' });
  const run = e.create({ mode: 'verify' });
  run.contract.design = { snapshotId: 'dsn_aaaaaaaaaaaa', snapshotHash: 'a'.repeat(64), targetIds: ['1:2'], acknowledgedIssueIds: [], designPolicyVersion: 1 };
  run.checkpoint = null; e.store.runs.put(run);
  return { ...e, run, developerPrompts };
}
const report = (run: Run, matches: boolean): VisualReport => ({
  schemaVersion: 1, source: 'harness', id: `vis_${'c'.repeat(32)}`, runId: run.id, slot: run.selectedSlot, checkpoint: run.checkpoint!, contractVersion: run.contract.version,
  snapshotId: run.contract.design!.snapshotId, snapshotHash: run.contract.design!.snapshotHash, profile: PROFILE, profileHash: visualProfileHash(PROFILE),
  status: matches ? 'passed' : 'needs_review', startedAt: '', endedAt: '', limitations: [], artifactDir: 'C:/v',
  screens: [matches
    ? { nodeId: '1:2', name: 'Import dữ liệu', route: '/?screen=1%3A2', width: 1920, height: 1080, status: 'passed', changedRatio: 0.01, message: 'ok' }
    : { nodeId: '1:2', name: 'Import dữ liệu', route: '/?screen=1%3A2', width: 1920, height: 1080, status: 'different', changedRatio: 0.021, message: 'Pixel trong ngưỡng nhưng chữ hoặc kiểu chữ khác Figma.',
      text: { figmaTexts: 12, matched: 11, omitted: 0, mismatches: [{ kind: 'missing_text', nodeId: '1:9', text: '25 trường', expected: '25 trường', actual: 'không thấy trên trang' }] } }],
});
const go = async (e: ReturnType<typeof fixture>) => {
  e.orchestrator.startRun(e.run.id); await e.orchestrator.idle();
  e.orchestrator.approveContract(e.run.id, { contractHash: e.orchestrator.detail(e.run.id).contractReview.contractHash, acknowledgeWarnings: true }); await e.orchestrator.idle();
  return e.orchestrator.detail(e.run.id);
};

describe('a measured difference from the design goes back to the Developer', () => {
  it('asks for a fix with the text that does not match, measures again on the new checkpoint, and stops when it matches', async () => {
    const e = fixture();
    const seen: string[] = [];
    e.orchestrator.useVisualChecks(async (current) => { seen.push(current.checkpoint!); return report(current, seen.length > 1); });
    const detail = await go(e);
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
    const fix = e.developerPrompts.filter((p) => p.includes('[Hình thức]'));
    expect(fix).toHaveLength(1);
    expect(fix[0]).toContain('Import dữ liệu'); expect(fix[0]).toContain('"25 trường"'); expect(fix[0]).toContain('2.1%');
    expect(detail.artifacts.filter((a) => a.title === 'Design fidelity repair')).toHaveLength(1);
    expect(detail.events.some((x) => x.type === 'verify.fidelity_repair')).toBe(true);
    expect(detail.visual?.status, detail.run.blocker ?? detail.run.status).toBe('passed');
  }, 60000);

  it('gives up after two rounds, keeps what is still different in the report, and does not loop', async () => {
    const e = fixture();
    let calls = 0;
    e.orchestrator.useVisualChecks(async (current) => { calls++; return report(current, false); });
    const detail = await go(e);
    expect(calls).toBe(3);
    expect(e.developerPrompts.filter((p) => p.includes('[Hình thức]'))).toHaveLength(2);
    expect(detail.artifacts.filter((a) => a.title === 'Design fidelity repair')).toHaveLength(2);
    expect(detail.artifacts.some((a) => a.title === 'Pipeline fallback' && a.content.includes('Đối chiếu hình thức'))).toBe(true);
    expect(detail.visual?.screens[0]?.status).toBe('different');
  }, 60000);

  it('does not call the Developer when every screen is within the measure, or only needs a person to look', async () => {
    const e = fixture();
    e.orchestrator.useVisualChecks(async (current) => report(current, true));
    await go(e);
    expect(e.developerPrompts.filter((p) => p.includes('[Hình thức]'))).toHaveLength(0);
  }, 60000);
});
