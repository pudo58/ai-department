import { describe, it, expect } from 'vitest';
import { hashContract, initialContract, reviseContract, sha256 } from '../src/core/contract.js';
import { normalizeTestId, validateTestPlan, validateManifest, extractCaseIds } from '../src/core/testplan.js';
import { latestChecks, qualityDetail, recipeHash } from '../src/core/qualityevidence.js';
import { buildMatrix } from '../src/core/completion.js';
import { summarizeCheck } from '../src/core/checks.js';
import { buildCliCommand } from '../src/runtime/providers.js';
import { setupV2 as setup, green } from './helpers.js';
import { contract, entries, qualityGreen, qualityReport } from './quality-fixtures.js';
import type { Artifact, CheckResult } from '../src/shared/types.js';

describe('risk plan contract validation', () => {
  it('requests a read-only sandbox/tool surface for planning without changing normal Author commands', () => {
    expect(buildCliCommand({ provider: 'codex', model: '', singleAgent: false, readOnly: true })).toContain('sandbox_mode="read-only"');
    expect(buildCliCommand({ provider: 'codex', model: '', singleAgent: false })).toContain('sandbox_mode="workspace-write"');
    const claude = buildCliCommand({ provider: 'claude', model: '', singleAgent: false, local: true, readOnly: true });
    expect(claude).toContain('Write,Edit,NotebookEdit,Bash,Agent,Task'); expect(claude).not.toContain('Bash(npm *)');
  });
  it('preserves legacy content/hash and requires a plan only under the new policy', () => {
    const c = initialContract('retry'), before = JSON.stringify(c), hash = hashContract(c);
    expect(validateTestPlan(c)).toEqual([]); expect(validateTestPlan(c, true)).not.toEqual([]);
    expect(JSON.stringify(c)).toBe(before); expect(hashContract(c)).toBe(hash);
    expect(validateTestPlan(contract(), true)).toEqual([]);
    expect(reviseContract(c, { ...c, testPlan: contract().testPlan }).version).toBe(2);
  });
  it.each(['duplicate', 'unknown', 'optionalHigh', 'manual', 'missingRequired', 'missingGroup', 'duplicateNA', 'conflictingNA', 'question', 'badShape', 'duplicateR'] as const)('rejects %s plans', kind => {
    const c = contract(), p = c.testPlan!;
    if (kind === 'duplicate') p.cases[1]!.id = 'C-1';
    if (kind === 'unknown') p.cases[0]!.requirementIds = ['R-9'];
    if (kind === 'optionalHigh') p.cases[1]!.required = false;
    if (kind === 'manual') p.cases[0]!.method = 'manual';
    if (kind === 'missingRequired') p.cases = [];
    if (kind === 'missingGroup') p.notApplicable = [];
    if (kind === 'duplicateNA') p.notApplicable.push(p.notApplicable[0]!);
    if (kind === 'conflictingNA') p.notApplicable.push({ group: 'happy', reason: 'contradiction' });
    if (kind === 'question') p.questions = ['Quy tắc nào?'];
    if (kind === 'badShape') p.cases[0]!.expected = '';
    if (kind === 'duplicateR') p.cases[0]!.requirementIds = ['R-1', 'R-1'];
    expect(validateTestPlan(c, true).length).toBeGreaterThan(0);
  });
  it('allows explicit manual cases only for manual requirements', () => {
    const c = contract(); c.requirements[0]!.manual = true; c.testPlan!.cases.forEach(c => { c.method = 'manual'; });
    expect(validateTestPlan(c)).toEqual([]);
  });
  it('requires ordered observations and per-step invariants for required stateful cases in newly modeled plans', () => {
    const c = contract(), plan = c.testPlan!;
    plan.statefulModelVersion = 1;
    plan.cases[1]!.group = 'state';
    plan.notApplicable = plan.notApplicable.filter(n => n.group !== 'state');
    plan.notApplicable.push({ group: 'boundary', reason: 'Fixture focuses its required case on state transitions.' });
    expect(validateTestPlan(c, true).join(' ')).toContain('chuỗi ít nhất hai bước');
    plan.cases[1]!.steps = [
      { action: 'claim job', expected: 'one lease is returned' },
      { action: 'reopen queue and claim again', expected: 'the same job is unavailable while its lease is valid' },
    ];
    expect(validateTestPlan(c, true).join(' ')).toContain('bất biến cần giữ');
    plan.cases[1]!.invariants = ['at most one active lease exists for this job'];
    expect(validateTestPlan(c, true)).toEqual([]);
  });
  it('keeps old plans without a stateful model marker valid and hash-compatible', () => {
    const c = contract(), before = JSON.stringify(c.testPlan);
    expect(validateTestPlan(c, true)).toEqual([]);
    expect(JSON.stringify(c.testPlan)).toBe(before);
    expect(c.testPlan!.statefulModelVersion).toBeUndefined();
  });
});

describe('locked test manifest', () => {
  const recipes = [{ id: 'test', reportPath: 'report.json' }], files = ['tests/order.test.ts'];
  it('needs the negative case even when another test covers the same requirement', () => {
    expect(validateManifest(contract(), entries(), recipes, files)).toEqual([]);
    expect(validateManifest(contract(), entries().slice(0, 1), recipes, files).join(' ')).toContain('C-2');
  });
  it.each(['unknownCase', 'path', 'absentFile', 'recipe', 'duplicate', 'missingTag', 'wrongR'] as const)('rejects %s manifest', kind => {
    const e = entries();
    if (kind === 'unknownCase') e[0]!.caseId = 'C-99';
    if (kind === 'path') e[0]!.path = '../outside.test.ts';
    if (kind === 'absentFile') e[0]!.path = 'tests/absent.test.ts';
    if (kind === 'recipe') e[0]!.recipeId = 'build';
    if (kind === 'duplicate') e.push(e[0]!);
    if (kind === 'missingTag') e[0]!.testId = 'only happy';
    if (kind === 'wrongR') e[0]!.requirementIds = ['R-9'];
    expect(validateManifest(contract(), e, recipes, files).length).toBeGreaterThan(0);
  });
  it('keeps namespaces separate between recipes and normalizes paths without suffix guessing', () => {
    expect(normalizeTestId('C:\\work\\tests\\a.ts::suite case', 'c:/work')).toBe('tests/a.ts::suite case');
    expect(normalizeTestId('pkg/tests/a.ts::case')).not.toBe(normalizeTestId('tests/a.ts::case'));
    expect(extractCaseIds('test_R_1_C_2_retry')).toEqual(['C-2']);
    expect(extractCaseIds('[C-1, C-2]')).toEqual(['C-1', 'C-2']);
    const e = entries(); e.push({ ...e[0]!, recipeId: 'other' });
    expect(validateManifest(contract(), e, [...recipes, { id: 'other', reportPath: 'x.xml' }], files)).toEqual([]);
  });
});

describe('latest exact case evidence', () => {
  function fixture() {
    const env = setup(), run = env.create({ mode: 'verify' }); run.qualityPolicyVersion = 1; run.contract = contract(); run.checkpoint = 'cp';
    const content = JSON.stringify({ schemaVersion: 1, source: 'author', contractHash: hashContract(run.contract), contractVersion: run.contract.version, slot: 'A', entries: entries() });
    const artifact: Artifact = { id: 'manifest', runId: run.id, kind: 'acceptance', title: 'Test manifest', content, hash: sha256(content), checkpoint: 'author', contractVersion: run.contract.version, valid: true, createdAt: 'now' };
    const make = (negative: Parameters<typeof qualityReport>[0] = 'passed'): CheckResult => ({ ...summarizeCheck({ runId: run.id, id: `check-${negative}`, recipe: run.configSnapshot.checks[0]!, checkpoint: 'cp', contractVersion: run.contract.version }, [{ ...qualityGreen, durationMs: 1, checkpoint: 'cp', report: qualityReport(negative), exitCode: negative === 'failed' ? 1 : 0 }]), slot: 'A', configHash: recipeHash(run), manifestHash: artifact.hash });
    return { ...env, run, artifact, make };
  }
  it.each(['failed', 'skipped', 'missing'] as const)('a later %s outcome cannot be hidden by an older pass', outcome => {
    const { run, artifact, make } = fixture(), old = make(), latest = make(outcome);
    expect(latestChecks(run, [old, latest])).toEqual([latest]);
    expect(qualityDetail(run, [old, latest], [artifact]).cases[1]!.status).not.toBe('passed');
    if (outcome === 'failed') expect(buildMatrix(run, [old, latest])[0]!.status).toBe('failed');
  });
  it.each(['checkpoint', 'contractVersion', 'slot', 'configHash', 'manifestHash', 'quarantined', 'valid'] as const)('rejects evidence with wrong %s', field => {
    const { run, artifact, make } = fixture(), c = make();
    if (field === 'checkpoint') c.checkpoint = 'other';
    if (field === 'contractVersion') c.contractVersion++;
    if (field === 'slot') c.slot = 'B';
    if (field === 'configHash') c.configHash = 'old';
    if (field === 'manifestHash') c.manifestHash = 'old';
    if (field === 'quarantined') c.quarantined = true;
    if (field === 'valid') c.valid = false;
    expect(qualityDetail(run, [c], [artifact]).cases.every(c => c.status !== 'passed')).toBe(true);
  });
  it('accepts the current manifest and explicit parameterized ids, while malformed manifests prove nothing', () => {
    const { run, artifact, make } = fixture();
    expect(qualityDetail(run, [make()], [artifact]).cases.every(c => c.status === 'passed')).toBe(true);
    expect(qualityDetail(run, [make()], [{ ...artifact, content: 'broken' }]).manifestProblems.length).toBeGreaterThan(0);
  });
  it('treats duplicate reporter identities as incomplete rather than trusting a matching name', () => {
    const { run, make } = fixture(), result = summarizeCheck({ runId: run.id, id: 'duplicate', recipe: run.configSnapshot.checks[0]!, checkpoint: 'cp', contractVersion: 1 }, [{ ...green, exitCode: 0, log: 'ok', incomplete: false, durationMs: 1, checkpoint: 'cp', report: { testResults: [{ assertionResults: [{ title: 'same', status: 'passed' }, { title: 'same', status: 'passed' }] }] } }]);
    expect(result.status).toBe('incomplete'); void make;
  });
});
