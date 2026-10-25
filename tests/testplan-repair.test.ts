import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthorTestPlanSchema, TestPlanSchema, planRepairProblems, testPlanOutputGuide, validateTestPlan } from '../src/core/testplan.js';
import { hashContract, initialContract } from '../src/core/contract.js';
import { parseOutput } from '../src/core/outputs.js';
import { renderReportMarkdown } from '../src/core/report.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { ContractPanel } from '../src/client/RunPanels.js';
import type { TestPlan } from '../src/shared/quality.js';
import { setupV2 as setup } from './helpers.js';
import { currentPlan, fence, plan, qualityGreen, qualityReply } from './quality-fixtures.js';

const linkedOnce = (p: TestPlan) => ({ ...p, cases: p.cases.map(({ requirementIds: _ids, ...c }) => c) });
const badLink = (p: TestPlan) => { p.cases[0]!.oracle!.references[0]!.requirementId = 'R-99'; return p; };

describe('Author plan correction', () => {
  it('derives new v2 output links from oracle once; never normalizes legacy stored content', () => {
    const contract = initialContract('Exact requirement.'), p = currentPlan(plan(), contract);
    const oldHash = hashContract({ ...contract, testPlan: p });
    const input = linkedOnce(p), normalized = parseOutput(AuthorTestPlanSchema, fence(input));
    expect(normalized.cases[0]!.requirementIds).toEqual(['R-1']);
    expect(validateTestPlan({ ...contract, testPlan: normalized }, true)).toEqual([]);
    expect(TestPlanSchema.safeParse(input).success).toBe(false);
    const legacy = badLink(structuredClone(p));
    expect(parseOutput(AuthorTestPlanSchema, fence(legacy)).cases[0]!.requirementIds).toEqual(['R-1']);
    expect(validateTestPlan({ ...contract, testPlan: legacy })).toContain('C-1: Căn cứ R-99 không thuộc ca.');
    expect(hashContract({ ...contract, testPlan: p })).toBe(oldHash);
    expect(JSON.parse(testPlanOutputGuide(2)).cases[0].requirementIds).toBeUndefined();
    expect(JSON.parse(testPlanOutputGuide(1)).cases[0].requirementIds).toEqual(['R-1']);
    expect(AuthorTestPlanSchema.safeParse({ ...input, schemaVersion: 1 }).success).toBe(false);
  });

  it('repairs bad links once, records both drafts and requires explicit approval before Developer', async () => {
    const prompts: string[] = [];
    const e = setup({ reply: x => {
      if (x.role === 'author' && x.readOnly) {
        prompts.push(x.prompt);
        const p = currentPlan(plan(), x.run.contract);
        return fence(prompts.length === 1 ? badLink(p) : linkedOnce(p));
      }
      return qualityReply(x);
    }, files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], check: () => qualityGreen });
    const run = e.create({ mode: 'verify', budgetUsd: 10 });
    e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    const d = e.orchestrator.detail(run.id);
    expect(d.run.status).toBe('awaiting_approval');
    expect(d.contractReview.problems).toEqual([]);
    expect(d.run.contract.approvedHash).toBeUndefined();
    expect(d.attempts.map(a => a.role)).toEqual(['planner', 'author', 'author']);
    expect(prompts[1]).toContain('C-1: Căn cứ R-99 không thuộc ca.');
    expect(prompts[1]).toContain('LƯỢT SỬA KẾ HOẠCH DUY NHẤT');
    expect(d.planReview).toMatchObject({ firstPassValid: false, repairAttempted: true, repairAccepted: true, outcome: 'valid', remainingProblems: [] });
    expect(d.artifacts.filter(a => a.title === 'Test plan repair attempt')).toHaveLength(1);
    expect(d.execution?.retries).toContainEqual({ reason: 'invalid_output', count: 1 });
    expect(renderToStaticMarkup(createElement(ContractPanel, { detail: d }))).toContain('Author đã sửa kế hoạch hợp lệ');
    const report = await e.orchestrator.report(run.id);
    expect(report.planReview).toEqual(d.planReview);
    expect(renderReportMarkdown(report)).toContain('sửa hợp lệ: có');
    e.orchestrator.approveContract(run.id, { contractHash: d.contractReview.contractHash, acknowledgeWarnings: true });
    await e.orchestrator.idle();
    expect(e.orchestrator.detail(run.id).run.status).toBe('awaiting_acceptance');
  });

  it('does not spend a correction on a valid first draft', async () => {
    const e = setup({ reply: qualityReply });
    const run = e.create({ mode: 'verify', budgetUsd: 10 });
    e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    expect(e.orchestrator.detail(run.id).planReview).toMatchObject({ firstPassValid: true, repairAttempted: false, outcome: 'valid' });
    expect(e.orchestrator.detail(run.id).attempts.filter(a => a.role === 'author')).toHaveLength(1);
  });

  it('reports all mechanical errors together, adds missing coverage, and preserves unresolved questions', async () => {
    let calls = 0, repairPrompt = '';
    const e = setup({ reply: x => {
      if (x.role === 'author' && x.readOnly) {
        const p = currentPlan(plan(), x.run.contract);
        p.questions = ['What outcome applies to the unspecified operation?'];
        if (++calls === 1) { p.cases[0]!.oracle!.references.push({ requirementId: 'R-17', quote: 'Additional mandatory requirement.' }); return fence(p); }
        repairPrompt = x.prompt;
        p.cases.push({ ...structuredClone(p.cases[0]!), id: 'C-3', requirementIds: ['R-17'], oracle: { references: [{ requirementId: 'R-17', quote: 'Additional mandatory requirement.' }], explanation: 'New case exercises this exact clause.' } });
        return fence(linkedOnce(p));
      }
      return qualityReply(x);
    } });
    const run = e.create({ mode: 'verify', budgetUsd: 10 });
    run.contract.requirements.push({ id: 'R-17', text: 'Additional mandatory requirement.', required: true, manual: false });
    e.store.runs.put(run); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    const d = e.orchestrator.detail(run.id);
    expect(calls).toBe(2);
    expect(repairPrompt).toContain('C-1: Căn cứ R-17 không thuộc ca.');
    expect(repairPrompt).toContain('R-17: thiếu ca tự động bắt buộc.');
    expect(d.contractReview.problems).toHaveLength(1);
    expect(d.contractReview.problems[0]).toContain('câu hỏi chưa giải quyết');
    expect(d.run.contract.testPlan!.questions).toEqual(['What outcome applies to the unspecified operation?']);
    expect(() => e.orchestrator.approveContract(run.id, { contractHash: d.contractReview.contractHash, acknowledgeWarnings: true })).toThrow(/câu hỏi/);
    expect(renderToStaticMarkup(createElement(ContractPanel, { detail: d }))).toContain('Kế hoạch cần bạn xem và sửa');
    expect(d.attempts.some(a => a.role === 'developer')).toBe(false);
  });

  it('sends a genuine question directly to review without asking Author to invent an answer', async () => {
    const e = setup({ reply: x => {
      if (x.role === 'author' && x.readOnly) return fence({ ...currentPlan(plan(), x.run.contract), questions: ['Required outcome is not specified.'] });
      return qualityReply(x);
    } });
    const run = e.create({ mode: 'verify', budgetUsd: 10 }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    const d = e.orchestrator.detail(run.id);
    expect(d.planReview).toMatchObject({ reason: 'questions_only', repairAttempted: false });
    expect(d.attempts.map(a => a.role)).toEqual(['planner', 'author']);
    const stored = e.store.runs.get(run.id)!; stored.status = 'paused'; e.store.runs.put(stored);
    const restarted = new Orchestrator(e.store, () => e.runtime); await restarted.recover(); restarted.startRun(run.id); await restarted.idle();
    expect(restarted.detail(run.id).attempts).toHaveLength(2);
    expect(restarted.detail(run.id).contractReview.problems[0]).toContain('câu hỏi');
  });

  it.each(['drop_question', 'drop_case', 'downgrade', 'manual', 'drop_link'] as const)('rejects a correction that weakens the plan: %s', async change => {
    let calls = 0;
    const e = setup({ reply: x => {
      if (x.role === 'author' && x.readOnly) {
        const p = currentPlan(plan(), x.run.contract); p.questions = ['Still unresolved.'];
        if (++calls === 1) return fence(badLink(p));
        if (change === 'drop_question') p.questions = [];
        if (change === 'drop_case') p.cases.pop();
        if (change === 'downgrade') { p.cases[1]!.required = false; p.cases[1]!.priority = 'normal'; }
        if (change === 'manual') p.cases[1]!.method = 'manual';
        if (change === 'drop_link') { p.cases[0]!.requirementIds = ['R-99']; p.cases[0]!.oracle!.references[0]!.requirementId = 'R-99'; }
        return fence(p);
      }
      return qualityReply(x);
    } });
    const run = e.create({ mode: 'verify', budgetUsd: 10 }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    const d = e.orchestrator.detail(run.id);
    expect(calls).toBe(2);
    expect(d.planReview).toMatchObject({ reason: 'repair_rejected', repairAccepted: false, outcome: 'needs_review' });
    expect(d.run.contract.testPlan!.cases).toHaveLength(2);
    expect(d.run.contract.testPlan!.cases[1]).toMatchObject({ method: 'automated', required: true, priority: 'high' });
    expect(d.run.contract.testPlan!.questions).toEqual(['Still unresolved.']);
    expect(d.planReview!.remainingProblems.some(p => /Không được|không được/.test(p))).toBe(true);
  });

  it.each([false, true])('bounds schema-invalid output and does not grant more calls after restart; repair succeeds=%s', async succeeds => {
    let calls = 0;
    const e = setup({ reply: x => {
      if (x.role === 'author' && x.readOnly) return ++calls === 1 || !succeeds ? 'not JSON' : fence(linkedOnce(currentPlan(plan(), x.run.contract)));
      return qualityReply(x);
    } });
    const run = e.create({ mode: 'verify', budgetUsd: 10 }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    expect(calls).toBe(2);
    expect(e.orchestrator.detail(run.id).run.status).toBe(succeeds ? 'awaiting_approval' : 'blocked');
    if (!succeeds) {
      const restarted = new Orchestrator(e.store, () => e.runtime); await restarted.recover(); restarted.startRun(run.id); await restarted.idle();
      expect(calls).toBe(2);
    }
  });

  it('keeps questions found in a schema-invalid draft when the correction tries to drop them', async () => {
    let calls = 0;
    const e = setup({ reply: x => {
      if (x.role === 'author' && x.readOnly) return ++calls === 1 ? fence({ questions: ['Real unresolved question.'] }) : fence(linkedOnce(currentPlan(plan(), x.run.contract)));
      return qualityReply(x);
    } });
    const run = e.create({ mode: 'verify', budgetUsd: 10 }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    expect(e.orchestrator.detail(run.id).run.status).toBe('blocked');
    expect(e.orchestrator.detail(run.id).planReview!.remainingProblems.join(' ')).toContain('Không được tự bỏ câu hỏi');
  });

  it('does not expand the prepare budget for a correction and keeps the first draft editable', async () => {
    const e = setup({ reply: x => {
      if (x.role === 'author' && x.readOnly) {
        e.store.runs.put({ ...e.store.runs.get(x.run.id)!, budgetUsd: 0.099 });
        return fence(badLink(currentPlan(plan(), x.run.contract)));
      }
      return qualityReply(x);
    } });
    const run = e.create({ mode: 'verify', budgetUsd: 10 }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    const d = e.orchestrator.detail(run.id);
    expect(d.attempts.filter(a => a.role === 'author')).toHaveLength(1);
    expect(d.planReview).toMatchObject({ repairAttempted: false, reason: 'budget_exhausted' });
    expect(d.run.budgetUsd).toBe(0.099);
    expect(d.run.contract.testPlan).toBeDefined();
  });

  it('keeps the original editable plan after two invalid drafts and resume does not reopen planning', async () => {
    let calls = 0;
    const e = setup({ reply: x => x.role === 'author' && x.readOnly ? (++calls, fence(badLink(currentPlan(plan(), x.run.contract)))) : qualityReply(x) });
    const run = e.create({ mode: 'verify', budgetUsd: 10 }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    expect(calls).toBe(2);
    const stored = e.store.runs.get(run.id)!; stored.status = 'paused'; e.store.runs.put(stored);
    e.orchestrator.resumeRun(run.id); await e.orchestrator.idle();
    expect(calls).toBe(2);
    const d = e.orchestrator.detail(run.id);
    expect(d.run.status).toBe('awaiting_approval');
    expect(d.contractReview.problems.join(' ')).toContain('R-99');
    expect(d.attempts.some(a => a.role === 'developer')).toBe(false);
  });

  it('reverts stray source edits from both read-only planning calls before presenting the repaired draft', async () => {
    let calls = 0;
    const e = setup({ strayFiles: x => x.role === 'author' && x.readOnly ? ['src/accidental.ts'] : [],
      reply: x => x.role === 'author' && x.readOnly ? fence(++calls === 1 ? badLink(currentPlan(plan(), x.run.contract)) : currentPlan(plan(), x.run.contract)) : qualityReply(x) });
    const run = e.create({ mode: 'verify', budgetUsd: 10 }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    expect(e.orchestrator.detail(run.id).planReview!.repairAccepted).toBe(true);
    expect((await e.runtime.changes(e.store.runs.get(run.id)!, 'A')).files).toEqual([]);
    expect(e.runtime.calls.filter(c => c === 'revert:A').length).toBeGreaterThanOrEqual(2);
  });

  it('marks a correction before calling Author and consumes it across interruption/restart', async () => {
    let calls = 0;
    const e = setup({ throwOnAgent: x => x.role === 'author' && x.readOnly && ++calls === 2 ? new Error('Interrupted correction fixture') : undefined,
      reply: x => x.role === 'author' && x.readOnly ? fence(badLink(currentPlan(plan(), x.run.contract))) : qualityReply(x) });
    const run = e.create({ mode: 'verify', budgetUsd: 10 }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    expect(e.orchestrator.detail(run.id).artifacts.filter(a => a.title === 'Test plan repair attempt')).toHaveLength(1);
    const restarted = new Orchestrator(e.store, () => e.runtime); await restarted.recover(); restarted.startRun(run.id); await restarted.idle();
    expect(calls).toBe(2);
    expect(restarted.detail(run.id).run.blocker).toContain('không tự gọi lại AI');
  });

  it('invalidates descriptive review metadata when the user edits the contract; old hash cannot approve', async () => {
    const e = setup({ reply: qualityReply }); const run = e.create({ mode: 'verify', budgetUsd: 10 });
    e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    const d = e.orchestrator.detail(run.id), changed = structuredClone(d.run.contract);
    changed.testPlan!.cases[0]!.expected += '; reviewed extra observation';
    e.orchestrator.reviseContract(run.id, changed);
    expect(e.orchestrator.detail(run.id).planReview).toBeUndefined();
    expect(() => e.orchestrator.approveContract(run.id, { contractHash: d.contractReview.contractHash, acknowledgeWarnings: true })).toThrow(/thay đổi/);
  });

  it.each([false, true])('renames duplicate IDs only while retaining every scenario; merged=%s', async merged => {
    let calls = 0;
    const e = setup({ reply: x => {
      if (x.role === 'author' && x.readOnly) {
        const p = currentPlan(plan(), x.run.contract);
        if (++calls === 1) p.cases[1]!.id = 'C-1';
        else if (merged) p.cases.pop();
        return fence(p);
      }
      return qualityReply(x);
    } });
    const run = e.create({ mode: 'verify', budgetUsd: 10 }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    const d = e.orchestrator.detail(run.id);
    expect(calls).toBe(2);
    expect(d.planReview!.repairAccepted).toBe(!merged);
    expect(d.run.contract.testPlan!.cases).toHaveLength(2);
    if (merged) expect(d.planReview!.remainingProblems.join(' ')).toContain('Không được xóa');
    else expect(d.contractReview.problems).toEqual([]);
  });

  it('protects the same constraints outside orchestration', () => {
    const p = plan(), next = structuredClone(p); next.cases[0]!.requirementIds = ['R-2'];
    expect(planRepairProblems(p, [], next)).toContain('C-1: không được bỏ liên kết R-1 trong lượt sửa kế hoạch.');
    const wrong = structuredClone(p); wrong.cases[0]!.requirementIds = ['R-99'];
    expect(planRepairProblems(wrong, [], p, ['R-1'])).toEqual([]);
  });
});
