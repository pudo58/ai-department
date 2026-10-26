import { describe, expect, it } from 'vitest';
import { initialContract, reviewContract } from '../src/core/contract.js';
import { normalizeTestPlan, parseTestPlanOutput, snapQuote } from '../src/core/planfix.js';
import { testPlanFindings, validateTestPlan } from '../src/core/testplan.js';
import { setupV2 as setup } from './helpers.js';
import { currentPlan, fence, plan, qualityGreen, qualityReply } from './quality-fixtures.js';

const contract = () => initialContract('Không tạo đơn trùng khi client gửi lại cùng một khóa.');
const draft = () => JSON.parse(JSON.stringify(currentPlan(plan(), contract()))) as Record<string, any>;

describe('snapQuote', () => {
  const source = 'Không tạo đơn trùng khi client gửi lại cùng một khóa.';
  it('finds the exact clause text behind a quotation that differs only in form', () => {
    expect(snapQuote('Không tạo đơn trùng', source)).toBe('Không tạo đơn trùng');
    expect(snapQuote('KHÔNG  tạo đơn   trùng', source)).toBe('Không tạo đơn trùng');
    expect(snapQuote('"Không tạo đơn trùng khi client gửi lại cùng một khóa"', source)).toBe('Không tạo đơn trùng khi client gửi lại cùng một khóa');
    expect(snapQuote('Không tạo đơn trùng ... cùng một khóa.', source)).toBe(source);
  });
  it('leaves a quotation that is not in the clause alone', () => {
    expect(snapQuote('Hủy đơn phải ném lỗi', source)).toBeUndefined();
    expect(snapQuote('', source)).toBeUndefined();
  });
});

describe('normalizeTestPlan', () => {
  it('changes nothing in a plan that is already well formed', () => {
    const p = draft(), result = normalizeTestPlan(p, contract());
    expect(result.changes).toEqual([]);
    expect(result.value).toEqual(p);
  });

  it('maps spelling variants of enum values and reports each change', () => {
    const p = draft();
    p.cases[0].priority = 'Critical'; p.cases[0].group = 'edge-case'; p.cases[1].method = 'Auto'; p.cases[1].group = 'Happy Path';
    const { value, changes } = normalizeTestPlan(p, contract()) as { value: any; changes: string[] };
    expect(value.cases[0]).toMatchObject({ priority: 'high', group: 'boundary', required: true });
    expect(value.cases[1]).toMatchObject({ method: 'automated', group: 'happy' });
    expect(changes.join(' ')).toContain('C-1: priority "Critical" → "high"');
    expect(changes.join(' ')).toContain('C-1: nhóm "edge-case" → "boundary"');
  });

  it('never invents the meaning of a value it does not recognise', () => {
    const p = draft(); p.cases[0].priority = 'whenever'; p.cases[0].group = 'vibes';
    const { value, changes } = normalizeTestPlan(p, contract()) as { value: any; changes: string[] };
    expect(value.cases[0]).toMatchObject({ priority: 'whenever', group: 'vibes' });
    expect(changes).toEqual([]);
    expect(() => parseTestPlanOutput(fence(p), contract())).toThrow(/sai định dạng/);
  });

  it('turns question objects into strings without dropping any question', () => {
    const p = draft(); p.questions = ['Một câu hỏi', { question: 'Câu hỏi dạng object' }, { text: 'Câu hỏi khác' }];
    const { value } = normalizeTestPlan(p, contract()) as { value: any };
    expect(value.questions).toEqual(['Một câu hỏi', 'Câu hỏi dạng object', 'Câu hỏi khác']);
  });

  it('drops a "not applicable" line only for a group that already has a case, and repeated lines for one group', () => {
    const p = draft(); p.notApplicable.push({ group: 'happy', reason: 'mâu thuẫn' }, { ...p.notApplicable[0] });
    const { value, changes } = normalizeTestPlan(p, contract()) as { value: any; changes: string[] };
    expect(value.notApplicable.map((n: any) => n.group)).toEqual(plan().notApplicable.map(n => n.group));
    expect(changes.length).toBe(2);
    expect(testPlanFindings({ ...contract(), testPlan: parseTestPlanOutput(fence(p), contract()).plan }, true).advisories).toEqual([]);
  });

  it('snaps a quotation to the clause text but does not link a basis the Author put on another requirement', () => {
    const c = { ...contract(), requirements: [...contract().requirements, { id: 'R-2', text: 'Mọi đơn có mã duy nhất.', required: true, manual: false }] };
    const p = draft();
    p.cases[0].oracle.references = [{ requirementId: 'r-1', quote: 'không tạo đơn trùng' }, { requirementId: 'R-2', quote: 'Mọi đơn có mã duy nhất' }];
    const { value, changes } = normalizeTestPlan(p, c) as { value: any; changes: string[] };
    expect(value.cases[0].oracle.references[0]).toEqual({ requirementId: 'R-1', quote: 'Không tạo đơn trùng' });
    expect(value.cases[0].requirementIds).toEqual(['R-1']);
    expect(changes.join(' ')).not.toContain('thêm vào');
    expect(validateTestPlan({ ...c, testPlan: parseTestPlanOutput(fence(p), c).plan }, true)).toContain('C-1: Căn cứ R-2 không thuộc ca.');
  });

  it('keeps every business field exactly as the Author wrote it', () => {
    const p = draft(); p.cases[0].priority = 'critical';
    const { value } = normalizeTestPlan(p, contract()) as { value: any };
    for (const [i, c] of p.cases.entries()) for (const key of ['id', 'risk', 'preconditions', 'actions', 'expected', 'steps', 'invariants', 'requirementIds']) expect(value.cases[i][key]).toEqual(c[key]);
  });
});

describe('plan findings and contract review', () => {
  it('splits what blocks approval from what is only worth a warning', () => {
    const p = parseTestPlanOutput(fence(draft()), contract()).plan;
    p.notApplicable = [];
    p.cases[0]!.oracle!.references[0]!.quote = 'Câu không có trong điều khoản';
    const c = { ...contract(), testPlan: p }, found = testPlanFindings(c, true);
    expect(found.blocking).toEqual([]);
    expect(found.advisories.join(' ')).toContain('Chưa xét nhóm');
    expect(found.advisories.join(' ')).toContain('Trích dẫn R-1');
    expect(validateTestPlan(c, true)).toEqual([]);
    const review = reviewContract(c);
    expect(review.problems).toEqual([]);
    expect(review.warnings.filter(w => w.code === 'plan_advisory').length).toBe(found.advisories.length);
  });

  it('still blocks on an unanswered question and on a required requirement without an automatic case', () => {
    const p = parseTestPlanOutput(fence(draft()), contract()).plan;
    p.questions = ['Chưa rõ?']; p.cases = [];
    expect(testPlanFindings({ ...contract(), testPlan: p }, true).blocking.join(' ')).toMatch(/câu hỏi chưa giải quyết[\s\S]*thiếu ca tự động bắt buộc|thiếu ca tự động bắt buộc[\s\S]*câu hỏi chưa giải quyết/);
  });
});

describe('Author plan with form-only problems', () => {
  it('reaches approval without a correction round, is normalised, and needs the warnings acknowledged', async () => {
    const e = setup({ reply: x => {
      if (x.role === 'author' && x.readOnly) {
        const p = JSON.parse(JSON.stringify(currentPlan(plan(), x.run.contract))) as Record<string, any>;
        p.cases[0].priority = 'critical'; p.notApplicable.pop();
        p.questions = [];
        return fence(p);
      }
      return qualityReply(x);
    }, files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], check: () => qualityGreen });
    const run = e.create({ mode: 'verify', budgetUsd: 10 });
    e.orchestrator.startRun(run.id); await e.orchestrator.idle();
    const d = e.orchestrator.detail(run.id);
    expect(d.run.status).toBe('awaiting_approval');
    expect(d.attempts.filter(a => a.role === 'author')).toHaveLength(1);
    expect(d.contractReview.problems).toEqual([]);
    expect(d.planReview).toMatchObject({ outcome: 'valid', repairAttempted: false, remainingProblems: [] });
    expect(d.planReview?.normalizations?.join(' ')).toContain('priority "critical" → "high"');
    expect(d.planReview?.remainingAdvisories?.join(' ')).toContain('Chưa xét nhóm');
    expect(d.contractReview.warnings.some(w => w.code === 'plan_advisory')).toBe(true);
    expect(() => e.orchestrator.approveContract(run.id, { contractHash: d.contractReview.contractHash })).toThrow(/cảnh báo/);
    e.orchestrator.approveContract(run.id, { contractHash: d.contractReview.contractHash, acknowledgeWarnings: true });
    await e.orchestrator.idle();
    const after = e.orchestrator.detail(run.id);
    expect(after.run.contractReviewReceipt?.acknowledgedWarnings).toContain('plan_advisory');
    expect(after.quality.planAdvisories?.join(' ')).toContain('Chưa xét nhóm');
  });
});
