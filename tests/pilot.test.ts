import { describe, expect, it } from 'vitest';
import { analyzeM0b } from '../src/evaluation/m0b.js';
import { manifestHash, validateM0b } from '../src/evaluation/manifest.js';
import { buildPilotManifest, outcomeOf, rollup, runPlan, taskRecordFrom, type PilotRow, type PilotTaskPack } from '../src/evaluation/pilot.js';
import { ARMS } from '../src/evaluation/types.js';

const pack = (id: string, stratum: 'easy' | 'hard'): PilotTaskPack => ({ id, stratum, signals: ['x'], initialTeamMode: 'verify', spec: `Spec of ${id}`, packHash: `hash-${id}` });
const packs = [...['a', 'b', 'c', 'd'].map((n) => pack(`easy-${n}`, 'easy')), ...['a', 'b', 'c', 'd'].map((n) => pack(`hard-${n}`, 'hard'))];
const options = { id: 'pilot-test', seed: 7, lockedAt: '2026-10-26T00:00:00Z', modelVersion: 'model', cliVersions: { codex: '1.0' } };

describe('buildPilotManifest', () => {
  it('produces a valid M0b manifest with every task, arm and repetition assigned', () => {
    const m = buildPilotManifest(packs, options);
    expect(validateM0b(m)).toEqual([]);
    expect(m.assignments).toHaveLength(8 * 3 * 2);
    expect(m.tasks.every((t) => t.taskPackHash?.startsWith('hash-'))).toBe(true);
    expect(m.arms).toEqual([...ARMS]);
  });
  it('is synthetic, because nobody independent attested the task packs', () => {
    expect(buildPilotManifest(packs, options).provenance).toBe('synthetic');
  });
  it('is deterministic for a seed, changes order for another, and its hash covers the task pack hashes', () => {
    const a = buildPilotManifest(packs, options), b = buildPilotManifest([...packs].reverse(), options), c = buildPilotManifest(packs, { ...options, seed: 8 });
    expect(manifestHash(a)).toBe(manifestHash(b));
    expect(a.assignments.map((x) => x.id)).not.toEqual(c.assignments.map((x) => x.id));
    const changed = buildPilotManifest(packs.map((p) => (p.id === 'easy-a' ? { ...p, packHash: 'other' } : p)), options);
    expect(manifestHash(changed)).not.toBe(manifestHash(a));
  });
  it('refuses a set that is not four easy and four hard', () => {
    expect(validateM0b(buildPilotManifest(packs.slice(1), options)).join(' ')).toContain('8 task');
  });
});

describe('runPlan', () => {
  it('maps arms to how they run', () => {
    expect(runPlan('native-full', { initialTeamMode: 'verify' })).toEqual({ kind: 'native' });
    expect(runPlan('harness-single', { initialTeamMode: 'verify' })).toEqual({ kind: 'harness', mode: 'single' });
    expect(runPlan('harness-team', { initialTeamMode: 'verify' })).toEqual({ kind: 'harness', mode: 'verify' });
  });
});

const row = (over: Partial<PilotRow> = {}): PilotRow => ({ assignmentId: 'easy-a:harness-team:1', arm: 'harness-team', status: 'awaiting_acceptance', graderPass: true, grader: { passed: 10, total: 10 }, costUsd: 1, automaticMs: 120_000, ...over });

describe('taskRecordFrom', () => {
  const m = buildPilotManifest(packs, options), assignment = m.assignments[0]!;
  it('accepts only a correct deliverable that came through the normal path', () => {
    expect(taskRecordFrom(row(), assignment, 'h')).toMatchObject({ outcome: 'completed', accepted: true, costUsd: 1, activeMinutes: 2 });
    expect(taskRecordFrom(row({ graderPass: false }), assignment, 'h')).toMatchObject({ outcome: 'completed', accepted: false });
    expect(taskRecordFrom(row({ status: 'blocked' }), assignment, 'h')).toMatchObject({ outcome: 'blocked', accepted: false });
    expect(taskRecordFrom(row({ status: 'failed' }), assignment, 'h')).toMatchObject({ outcome: 'failed', accepted: false });
    expect(taskRecordFrom(row({ status: 'finished', arm: 'native-full' }), assignment, 'h')).toMatchObject({ outcome: 'completed', accepted: true });
    expect(taskRecordFrom(row({ status: 'timeout', arm: 'native-full' }), assignment, 'h')).toMatchObject({ outcome: 'failed', accepted: false });
  });
  it('counts a runner or machine error as infrastructure', () => {
    expect(outcomeOf({ status: 'error', error: 'ENOSPC' })).toBe('infrastructure');
  });
  it('keeps deviations and flags in the record', () => {
    const r = taskRecordFrom(row({ deviations: ['contract_approved_unchanged'], falseReady: true, degraded: { stages: ['Chẩn đoán test'], items: 1 } }), assignment, 'h');
    expect(r.protocolDeviations).toEqual(['contract_approved_unchanged']);
    expect(r.evidence).toContain('FALSE-READY');
    expect(r.evidence).toContain('Chẩn đoán test');
  });
  it('feeds the M0b analysis without dropping assignments', () => {
    const records = m.assignments.map((a, i) => taskRecordFrom(row({ assignmentId: a.id, arm: a.arm, graderPass: i % 2 === 0 }), a, manifestHash(m)));
    const report = analyzeM0b(m, records);
    expect(report.arms.every((a) => a.missingRecords === 0)).toBe(true);
    expect(report.plannedTasks).toBe(8);
  });
});

describe('rollup', () => {
  it('counts correctness, the system verdict and the honesty of that verdict per arm', () => {
    const rows = [
      row({ arm: 'harness-single', falseReady: true, graderPass: false, costUsd: 2, automaticMs: 100_000 }),
      row({ arm: 'harness-single', costUsd: 4, automaticMs: 300_000 }),
      row({ arm: 'harness-team', degraded: { stages: ['x'], items: 1 } }),
      row({ arm: 'native-full', status: 'finished', falseReady: null, degraded: null, costUsd: null }),
    ];
    const byArm = Object.fromEntries(rollup(rows).map((r) => [r.arm, r]));
    expect(byArm['harness-single']).toMatchObject({ runs: 2, graderPass: 1, accepted: 1, falseReady: 1, meanCostUsd: 3, meanSeconds: 200 });
    expect(byArm['harness-team']).toMatchObject({ runs: 1, degraded: 1, accepted: 1 });
    expect(byArm['native-full']).toMatchObject({ runs: 1, meanCostUsd: null, falseReady: 0 });
  });
});
