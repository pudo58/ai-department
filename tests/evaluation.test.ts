import { describe, expect, it } from 'vitest';
import { createAssignments, manifestHash, matchesRegistration, register, reviewerModel, validateM0a, validateM0b } from '../src/evaluation/manifest.js';
import { evaluateGroup, parseReviewResponse, pilotVerdict, runM0a, toReviewInput } from '../src/evaluation/m0a.js';
import { analyzeM0b, operatingMinutes } from '../src/evaluation/m0b.js';
import { mulberry32, requiredTasks, shuffled, wilson } from '../src/evaluation/stats.js';
import type { Assignment, EvaluationTask, FindingAdjudication, HumanMinutes, M0aManifest, M0bManifest, ReviewCase, ReviewRecord, Reviewer, TaskRecord } from '../src/evaluation/types.js';

const models: [string, string] = ['model-a', 'model-b'];
const zero: HumanMinutes = { clarification: 0, approval: 0, review: 0, quota: 0, acceptance: 0, rework: 0, onboarding: 0, research: 0 };

function m0aManifest(): M0aManifest {
  const kinds = [...Array(12).fill('clean'), ...Array(6).fill('behavior'), ...Array(6).fill('design')] as ('clean' | 'behavior' | 'design')[];
  const cases: ReviewCase[] = kinds.map((kind, i) => ({
    caseId: `c${i}`, requirement: 'req', policy: [], base: [{ path: 'a.ts', content: 'a' }], candidate: [{ path: 'a.ts', content: 'b' }],
    authorModel: models[i % 2]!,
    truth: { kind, findings: kind === 'clean' ? [] : [{ id: `g${i}`, category: kind, location: 'a.ts', rationale: 'r' }] },
  }));
  return { schemaVersion: 1, id: 'm0a', kind: 'm0a', provenance: 'synthetic', description: 'd', seed: 1, protocol: { version: '1', rubric: 'r', lockedAt: 't' }, repetitions: 2, models, variants: ['same-model-new-session', 'cross-model-new-session'], cases };
}

describe('stats', () => {
  it('the seeded generator and shuffle are reproducible', () => {
    expect(shuffled([1, 2, 3, 4, 5, 6], mulberry32(7))).toEqual(shuffled([1, 2, 3, 4, 5, 6], mulberry32(7)));
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
  it('wilson stays inside [0,1] and is wide for tiny samples', () => {
    const w = wilson(3, 3);
    expect(w.high).toBeLessThanOrEqual(1);
    expect(w.low).toBeLessThan(0.5);
    expect(Number.isNaN(wilson(0, 0).estimate)).toBe(true);
  });
  it('paired sample size grows with repetition correlation and shrinks with delta', () => {
    const base = { delta: 0.15, discordant: 0.4, repetitions: 2, rho: 0.5 };
    expect(requiredTasks({ ...base, rho: 0.9 }).tasks).toBeGreaterThan(requiredTasks({ ...base, rho: 0 }).tasks);
    expect(requiredTasks({ ...base, delta: 0.3 }).tasks).toBeLessThan(requiredTasks(base).tasks);
    expect(requiredTasks(base).tasks).toBeGreaterThan(8);
    expect(() => requiredTasks({ ...base, delta: 0.5, discordant: 0.2 })).toThrow();
  });
});

describe('manifest', () => {
  it('registration locks the protocol: any later edit is detected', () => {
    const m = m0aManifest();
    const reg = register(m);
    expect(matchesRegistration(m, reg)).toBe(true);
    expect(matchesRegistration({ ...m, seed: 2 }, reg)).toBe(false);
    expect(manifestHash(m)).toBe(manifestHash(JSON.parse(JSON.stringify(m))));
  });
  it('validates the 24-case M0a shape and balanced candidate sources', () => {
    expect(validateM0a(m0aManifest())).toEqual([]);
    const m = m0aManifest();
    expect(validateM0a({ ...m, cases: m.cases.slice(1) }).join()).toMatch(/24 case/);
    expect(validateM0a({ ...m, cases: m.cases.map((c) => ({ ...c, authorModel: models[0] })) }).join()).toMatch(/cân bằng/);
    expect(validateM0a({ ...m, provenance: 'human-attested' }).join()).toMatch(/xác nhận nhãn/);
  });
  it('cross-model really uses the other model', () => {
    expect(reviewerModel('model-a', models, 'same-model-new-session')).toBe('model-a');
    expect(reviewerModel('model-a', models, 'cross-model-new-session')).toBe('model-b');
  });
  it('M0b assignments cover task × arm × repetition exactly once, deterministically', () => {
    const tasks: EvaluationTask[] = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, stratum: i < 4 ? 'easy' : 'hard', requirement: 'r', routingSignals: [], initialTeamMode: 'single' }));
    const arms = ['native-full', 'harness-single', 'harness-team'] as const;
    const a = createAssignments(tasks, arms, 2, 42);
    expect(a).toHaveLength(48);
    expect(new Set(a.map((x) => x.id)).size).toBe(48);
    expect(createAssignments(tasks, arms, 2, 42)).toEqual(a);
    expect(createAssignments(tasks, arms, 2, 43)).not.toEqual(a);
    const m: M0bManifest = { schemaVersion: 1, id: 'b', kind: 'm0b', provenance: 'synthetic', description: '', seed: 42, protocol: { version: '1', rubric: '', lockedAt: '' }, repetitions: 2, arms: [...arms], tasks, assignments: a,
      settings: { taskBudgetUsd: 5, modelVersion: 'x', cliVersions: {}, harnessSingleSubagents: false, nativeFeatures: 'all-supported', followupHours: 168, targetWeights: { easy: 0.5, hard: 0.5 }, bootstrapSamples: 200 } };
    expect(validateM0b(m)).toEqual([]);
    expect(validateM0b({ ...m, assignments: a.slice(1) }).join()).toMatch(/48 assignment/);
    expect(validateM0b({ ...m, settings: { ...m.settings, harnessSingleSubagents: true as unknown as false } }).join()).toMatch(/subagent/);
    expect(validateM0b({ ...m, settings: { ...m.settings, targetWeights: { easy: 0.9, hard: 0.5 } } }).join()).toMatch(/tổng/);
  });
});

describe('M0a', () => {
  const goodReviewer: Reviewer = async (input, exec) => {
    const n = Number(input.caseId.slice(1));
    const bad = n >= 12;
    return { rawOutput: { decision: bad ? 'block' : 'pass', findings: bad ? [{ id: `f-${input.caseId}`, category: n < 18 ? 'behavior' : 'design', severity: 'major', title: 't', location: 'a.ts', evidence: 'e' }] : [] },
      model: exec.model, sessionId: `${exec.sessionId}-fresh`, durationMs: 5, costUsd: 0.01 };
  };

  it('never shows the reviewer ground truth, author model or provenance', () => {
    const input = toReviewInput(m0aManifest().cases[0]!);
    expect(Object.keys(input).sort()).toEqual(['base', 'candidate', 'caseId', 'policy', 'requirement']);
  });

  it('runs every case × variant × repetition and keeps broken answers in the sample', async () => {
    const m = m0aManifest();
    let n = 0;
    const flaky: Reviewer = async (i, e) => (++n % 5 === 0 ? { rawOutput: 'garbage', model: e.model, sessionId: 'x', durationMs: 1, costUsd: null } : goodReviewer(i, e));
    const records = await runM0a(m, 'abcdef123456', flaky);
    expect(records).toHaveLength(24 * 2 * 2);
    expect(records.some((r) => r.status === 'invalid')).toBe(true);
    expect(records.filter((r) => r.variant === 'cross-model-new-session').every((r) => r.requestedModel !== m.cases.find((c) => c.caseId === r.caseId)!.authorModel)).toBe(true);
  });

  it('flags a reviewer that silently used another model or reused the session', async () => {
    const wrongModel: Reviewer = async (i, e) => ({ ...(await goodReviewer(i, e)), model: 'something-else' });
    const reused: Reviewer = async (i, e) => ({ ...(await goodReviewer(i, e)), sessionId: 'one-long-session' });
    expect((await runM0a(m0aManifest(), 'h', wrongModel)).every((x) => x.status === 'invalid')).toBe(true);
    const reusedRecords = await runM0a(m0aManifest(), 'h', reused);
    expect(reusedRecords.filter((x) => x.status === 'completed')).toHaveLength(1);
    const crashing: Reviewer = async () => { throw new Error('quota'); };
    expect((await runM0a(m0aManifest(), 'h', crashing)).every((x) => x.status === 'error')).toBe(true);
  });

  it('computes case-level metrics and counts abstentions against the reviewer', async () => {
    const m = m0aManifest();
    const records = await runM0a(m, 'h', goodReviewer);
    const g = evaluateGroup(m, records, 'all');
    expect(g.confusion).toMatchObject({ tp: 48, fp: 0, fn: 0, tn: 48 });
    expect(g.casePrecision.estimate).toBe(1);

    const abstaining = records.map((r) => (r.caseId === 'c13' ? { ...r, response: { decision: 'abstain' as const, findings: [] } } : r));
    const g2 = evaluateGroup(m, abstaining, 'all');
    expect(g2.confusion.fn).toBe(4);
    expect(g2.confusion.abstained).toBe(4);
    expect(g2.caseRecall.estimate).toBeLessThan(1);
  });

  it('finding precision uses independent adjudication; unadjudicated findings do not count as supported', async () => {
    const m = m0aManifest();
    const records = (await runM0a(m, 'h', goodReviewer)).filter((r) => r.variant === 'same-model-new-session' && r.repetition === 1);
    const adjudicate = (r: ReviewRecord): FindingAdjudication[] => r.response!.findings.map((f) => ({ findingId: f.id, verdict: 'supported', adjudicator: 'human', independentOfReviewer: true, rationale: 'ok', goldId: `g${r.caseId.slice(1)}` }));
    const adjudicated = records.map((r) => ({ ...r, adjudications: adjudicate(r) }));
    const full = evaluateGroup(m, adjudicated, 'all');
    expect(full.findingPrecision.estimate).toBe(1);
    expect(full.recallByCategory.behavior.estimate).toBe(1);
    const none = evaluateGroup(m, records, 'all');
    expect(none.findingPrecision.estimate).toBe(0);
    expect(none.unadjudicated).toBe(12);
  });

  it('a pilot pass never grants automatic blocking; a miss downgrades to advisory', async () => {
    const m = m0aManifest();
    const records = await runM0a(m, 'h', goodReviewer);
    const pass = pilotVerdict(evaluateGroup(m, records, 'all'));
    expect(pass.meetsPilotTarget).toBe(true);
    expect(pass.mayBlockAutomatically).toBe(false);
    expect(pass.notes.join(' ')).toMatch(/không đại diện/);
    const silent = records.map((r) => ({ ...r, response: { decision: 'pass' as const, findings: [] } }));
    const miss = pilotVerdict(evaluateGroup(m, silent, 'all'));
    expect(miss.meetsPilotTarget).toBe(false);
    expect(miss.notes.join(' ')).toMatch(/tư vấn/);
  });

  it('parses reviewer output strictly', () => {
    expect(parseReviewResponse('{"decision":"pass","findings":[]}')).toEqual({ decision: 'pass', findings: [] });
    expect(parseReviewResponse({ decision: 'maybe', findings: [] })).toBeUndefined();
    expect(parseReviewResponse('{{')).toBeUndefined();
  });
});

describe('M0b', () => {
  const tasks: EvaluationTask[] = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, stratum: i < 4 ? 'easy' : 'hard', requirement: 'r', routingSignals: [], initialTeamMode: 'single' }));
  const arms = ['native-full', 'harness-single', 'harness-team'] as const;
  const manifest = (): M0bManifest => ({
    schemaVersion: 1, id: 'b', kind: 'm0b', provenance: 'synthetic', description: '', seed: 5, protocol: { version: '1', rubric: '', lockedAt: '' }, repetitions: 2, arms: [...arms], tasks,
    assignments: createAssignments(tasks, arms, 2, 5),
    settings: { taskBudgetUsd: 5, modelVersion: 'x', cliVersions: {}, harnessSingleSubagents: false, nativeFeatures: 'all-supported', followupHours: 168, targetWeights: { easy: 0.5, hard: 0.5 }, bootstrapSamples: 400 },
  });
  const record = (a: Assignment, over: Partial<TaskRecord> = {}): TaskRecord => ({
    assignmentId: a.id, manifestHash: 'h', outcome: 'completed', accepted: true, evidence: '', costUsd: 1, humanMinutes: { ...zero, review: 10 }, activeMinutes: 10, elapsedMinutes: 30,
    quotaWaitMinutes: 0, escalations: [], protocolDeviations: [], subagentsUsed: false, nativeFeaturesSupported: true, independence: 'as-assigned', followupComplete: true, ...over,
  });

  it('keeps unfinished and missing runs in the denominator (intent to treat)', () => {
    const m = manifest();
    const rows = m.assignments.map((a) => record(a, a.arm === 'harness-team' ? { accepted: false, outcome: 'quota' } : {}));
    const missing = rows.filter((r) => !r.assignmentId.includes(':native-full:1'));
    const report = analyzeM0b(m, missing);
    const native = report.arms.find((a) => a.arm === 'native-full')!;
    expect(native.missingRecords).toBe(8);
    expect(native.acceptedRate).toBeCloseTo(0.5);
    expect(report.arms.find((a) => a.arm === 'harness-team')!.acceptedRate).toBe(0);
  });

  it('a run only counts as accepted when the follow-up window closed cleanly', () => {
    const m = manifest();
    const report = analyzeM0b(m, m.assignments.map((a) => record(a, { followupComplete: false })));
    expect(report.arms.every((a) => a.acceptedRate === 0)).toBe(true);
  });

  it('reports "not enough evidence" when the interval spans zero, and does not overclaim', () => {
    const m = manifest();
    const rows = m.assignments.map((a) => record(a, { accepted: a.arm !== 'harness-team' || a.repetition === 1 }));
    const report = analyzeM0b(m, rows);
    const text = report.conclusion.join('\n');
    expect(text).toMatch(/chưa đủ bằng chứng/);
    expect(text).toMatch(/pilot, không chạy thêm/);
    expect(report.tasksNeededForDelta!.tasks).toBeGreaterThan(8);
  });

  it('the bootstrap is reproducible from the registered seed and excludes research overhead from effort', () => {
    const m = manifest();
    const rows = m.assignments.map((a) => record(a, { humanMinutes: { ...zero, review: 5, onboarding: 100, research: 100 } }));
    expect(analyzeM0b(m, rows)).toEqual(analyzeM0b(m, rows));
    expect(operatingMinutes(rows[0]!.humanMinutes)).toBe(5);
  });

  it('detects a real difference when one arm is clearly better', () => {
    const m = manifest();
    const rows = m.assignments.map((a) => record(a, { accepted: a.arm === 'harness-single' }));
    const c = analyzeM0b(m, rows).contrasts.find((x) => x.a === 'harness-single' && x.b === 'native-full' && x.metric === 'acceptedRate')!;
    expect(c.estimate).toBe(1);
    expect(c.low).toBeGreaterThan(0);
  });
});
