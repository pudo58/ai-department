import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { comparePng, readPng } from '../src/core/visual.js';
import { readVisualReport, visualBlockers, visualProfileHash, VISUAL_REPORT_TITLE } from '../src/core/visualevidence.js';
import { VisualProfileSchema } from '../src/core/visualprofile.js';
import { visualForRequirement, type VisualReport } from '../src/shared/visual.js';
import { sha256 } from '../src/core/contract.js';
import { PROMPTS } from '../src/core/prompts.js';
import { setupLegacy, green } from './helpers.js';
import type { Artifact, Run } from '../src/shared/types.js';
import { VisualComparator } from '../src/server/visualcompare.js';

const image = (rgba: number[], width = 2, height = 2) => {
  const png = new PNG({ width, height });
  for (let p = 0; p < width * height; p++) png.data.set(rgba, p * 4);
  return PNG.sync.write(png);
};
const fixture = () => {
  const e = setupLegacy({ check: () => green, files: e => e.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'] }, { visualCheck: { pathTemplate: '/?state={nodeId}', pixelThreshold: 0.1, maxDiffRatio: 0.01 }, executionMode: 'local' });
  const run = e.create({ mode: 'verify' }); run.checkpoint = 'c'.repeat(40);
  run.contract.design = { snapshotId: 'dsn_aaaaaaaaaaaa', snapshotHash: 'a'.repeat(64), targetIds: ['1:2'], acknowledgedIssueIds: [], designPolicyVersion: 1 };
  return { ...e, run };
};
const report = (run: Run): VisualReport => ({ schemaVersion: 1, source: 'harness', id: `vis_${'b'.repeat(32)}`, runId: run.id,
  slot: run.selectedSlot, checkpoint: run.checkpoint!, contractVersion: run.contract.version, snapshotId: run.contract.design!.snapshotId,
  snapshotHash: run.contract.design!.snapshotHash, profile: run.configSnapshot.visualCheck!, profileHash: visualProfileHash(run.configSnapshot.visualCheck!), status: 'passed', startedAt: '', endedAt: '', limitations: [],
  screens: [{ nodeId: '1:2', name: 'Màn hình', route: '/', width: 200, height: 200, status: 'passed', changedRatio: 0, message: 'Stable three captures' }] });
const artifact = (run: Run, r = report(run)): Artifact => { const content = JSON.stringify(r); return { id: 'art_visual', runId: run.id, title: VISUAL_REPORT_TITLE, kind: 'report', checkpoint: run.checkpoint, contractVersion: run.contract.version, content, hash: sha256(content), valid: true, createdAt: '' }; };

describe('visual measurements', () => {
  it('compares in an isolated worker, returns errors without losing the worker, and rejects work after shutdown', async () => {
    const worker = new VisualComparator();
    try {
      const png = image([255, 255, 255, 255]);
      expect((await worker.compare(png, png, 0.1)).changedPixels).toBe(0);
      await expect(worker.compare(png, Buffer.from('bad PNG'), 0.1)).rejects.toThrow();
      expect((await worker.compare(png, png, 0.1)).changedPixels).toBe(0);
    } finally { await worker.close(); }
    await expect(worker.compare(image([0, 0, 0, 255]), image([0, 0, 0, 255]), 0)).rejects.toThrow();
  });
  it('measures a changed pixel and writes a diff; matching images are zero, never a subjective score', () => {
    const a = image([255, 255, 255, 255]), png = readPng(a); png.data.set([0, 0, 0, 255], 4);
    const result = comparePng(a, PNG.sync.write(png), 0.1);
    expect(result.changedPixels).toBe(1); expect(result.changedRatio).toBe(0.25);
    expect(readPng(result.diff).data.slice(4, 8)).toEqual(Buffer.from([230, 0, 150, 255]));
    expect(comparePng(a, a, 0).changedRatio).toBe(0);
  });
  it('composites transparent pixels over white, rejects dimensions and bounds PNG allocation', () => {
    expect(comparePng(image([0, 0, 0, 0]), image([255, 255, 255, 255]), 0).changedPixels).toBe(0);
    expect(() => comparePng(image([0, 0, 0, 255], 2, 2), image([0, 0, 0, 255], 3, 2), 0)).toThrow('Kích thước');
    const bomb = image([0, 0, 0, 255]); bomb.writeUInt32BE(100000, 16); bomb.writeUInt32BE(100000, 20);
    expect(() => readPng(bomb)).toThrow('giới hạn');
    expect(() => readPng(Buffer.from('not a PNG'))).toThrow();
    expect(() => comparePng(image([0, 0, 0, 255]), image([0, 0, 0, 255]), NaN)).toThrow();
  });
  it('accepts only local route mappings, explicit tolerances and unique screen nodes', () => {
    expect(VisualProfileSchema.parse({ pathTemplate: '/?state={nodeId}' }).maxDiffRatio).toBeUndefined();
    for (const pathTemplate of ['https://example.com', '//example.com', '/\\example.com', '/\nredirect']) expect(VisualProfileSchema.safeParse({ pathTemplate }).success).toBe(false);
    expect(VisualProfileSchema.safeParse({ pathTemplate: '/', maxDiffRatio: 1 }).success).toBe(false);
    expect(VisualProfileSchema.safeParse({ pathTemplate: '/', screens: [{ nodeId: '1:2' }, { nodeId: '1:2' }] }).success).toBe(false);
  });
});

describe('visual evidence scope and honesty', () => {
  it('invalidates evidence on checkpoint, slot, contract, source, profile or artifact changes', () => {
    const { run } = fixture(), valid = artifact(run);
    expect(readVisualReport(run, [valid])?.status).toBe('passed');
    expect(readVisualReport(run, [{ ...valid, hash: 'bad' }])).toBeUndefined();
    expect(readVisualReport(run, [{ ...valid, valid: false }])).toBeUndefined();
    for (const change of [
      { ...run, checkpoint: 'd'.repeat(40) }, { ...run, selectedSlot: 'B' as const },
      { ...run, contract: { ...run.contract, version: 9 } },
      { ...run, contract: { ...run.contract, design: { ...run.contract.design!, snapshotHash: 'other' } } },
      { ...run, configSnapshot: { ...run.configSnapshot, visualCheck: { ...run.configSnapshot.visualCheck!, maxDiffRatio: 0.02 } } },
    ]) expect(readVisualReport(change, [valid])).toBeUndefined();
  });
  it('shows an incomplete report even if no browser started, and never accepts zero-screen success', () => {
    const { run } = fixture(), incomplete = { ...report(run), status: 'incomplete' as const, screens: [], limitations: ['missing browser'] };
    expect(readVisualReport(run, [artifact(run, incomplete)])?.limitations).toContain('missing browser');
    expect(visualBlockers(run, [artifact(run, incomplete)])).toHaveLength(1);
    expect(readVisualReport(run, [artifact(run, { ...report(run), screens: [] })])).toBeUndefined();
    const measureOnly = { ...run, configSnapshot: { ...run.configSnapshot, visualCheck: { pathTemplate: '/', pixelThreshold: 0.1 } } };
    expect(visualBlockers(measureOnly, [])).toEqual([]); // a measurement-only profile cannot add an unapproved acceptance gate
  });
  it('does not claim unseen references, an unknown tolerance or an unstable run are visually verified', () => {
    const { run } = fixture(), r = report(run);
    expect(visualForRequirement('node 1:2', [], r).status).toBe('passed');
    expect(visualForRequirement('nodes 1:2 and 1:3', [], r).status).toBe('needs_review');
    expect(visualForRequirement('section 1:999', [], r).status).toBe('unverified');
    expect(visualForRequirement('node 1:2', [], { ...r, status: 'incomplete' }).status).toBe('incomplete');
    expect(visualForRequirement('node 1:2', [], { ...r, status: 'needs_review', screens: [{ ...r.screens[0]!, status: 'needs_review' }] }).status).toBe('needs_review');
  });
  it('asks Planner to split testable UI behavior from unresolved visual acceptance in both planning paths', () => {
    const { run } = fixture();
    expect(PROMPTS.planner(run)).toContain('Không gộp hai loại');
    expect(PROMPTS.planner(run)).toContain('manual=false');
    expect(PROMPTS.synthesize(run)).toContain('Không gộp tất cả thành thủ công');
  });
  it('runs harness visual checks before the Verifier and records current evidence', async () => {
    const { orchestrator, store, run } = fixture();
    run.checkpoint = null;
    store.runs.put(run);
    let calls = 0;
    orchestrator.useVisualChecks(async current => { calls++; return report(current); });
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id, { contractHash: orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true }); await orchestrator.idle();
    const detail = orchestrator.detail(run.id);
    expect(calls, detail.run.blocker ?? detail.run.status).toBe(1); expect(detail.visual?.status).toBe('passed');
    expect(detail.artifacts.findIndex(a => a.title === VISUAL_REPORT_TITLE)).toBeLessThan(detail.artifacts.findIndex(a => a.title.startsWith('Raw verifier')));
    const acceptance = await orchestrator.report(run.id);
    expect(acceptance.visual?.checkpoint).toBe(detail.run.checkpoint);
  });
});
