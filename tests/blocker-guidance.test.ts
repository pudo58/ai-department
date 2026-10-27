import { describe, expect, it } from 'vitest';
import { budgetCeiling, offeredBudget } from '../src/core/budget.js';
import { evaluateCompletion } from '../src/core/completion.js';
import { initialContract, reviewContract } from '../src/core/contract.js';
import { evidenceBlockers } from '../src/core/findingproof.js';
import type { BudgetState, Finding } from '../src/shared/types.js';
import { reasoningPlan } from './reasoning-fixtures.js';
import { setup } from './helpers.js';
import { manualOnlyPlan, v4Fixture, cleanupFixtures } from './v4-fixtures.js';

const finding = (contractVersion: number): Finding => ({ id: 'f', runId: 'r', category: 'behavior', severity: 'major', title: 'Không xử lý đoạn văn nhiều câu', location: 'src/lib/parser.ts', evidence: 'e', suggestion: 's', status: 'open', confirmed: true, checkpoint: 'c', contractVersion, createdAt: '' });
const budget = { spentUsd: 0, capUsd: 10 } as BudgetState;

describe('what a person is told to do when a run is held back', () => {
  it('names both ways out of a Verifier that would not conclude, because resuming cannot change it', () => {
    const run = setup().create({ mode: 'verify' });
    const reasons = evidenceBlockers(run, { verdict: { decision: 'abstain' }, findings: [], artifacts: [], regressions: [], checks: [] });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('từ chối kết luận');
    expect(reasons[0]).toContain('Sửa hợp đồng');
    expect(reasons[0]).toContain('Ví dụ đúng/sai');
    expect(reasons[0]).toContain('Chuyển chế độ');
  });

  it('says how an open finding is closed under the v4 policy, and leaves the older wording alone', () => {
    const run = setup().create({ mode: 'verify' });
    const open = evaluateCompletion(run, [], [finding(run.contract.version)], budget).reasons.find(r => r.includes('finding blocker/major'))!;
    expect(open).toContain('Đóng bằng review thủ công');
    expect(open).toContain('Sửa');
    const older = { ...run, qualityPolicyVersion: 3 as const };
    expect(evaluateCompletion(older, [], [finding(run.contract.version)], budget).reasons.find(r => r.includes('finding blocker/major'))).toBe('1 finding blocker/major chưa xử lý.');
  });
});

describe('what the contract says early about what Verify cannot do', () => {
  const codes = (contract: ReturnType<typeof initialContract>) => reviewContract(contract).warnings.map(w => w.code);

  it('warns, while it costs nothing, when no case of the plan is automated', () => {
    const base = initialContract('Phân biệt các câu phức tạp.');
    expect(codes({ ...base, testPlan: manualOnlyPlan() })).toContain('no_automated_case');
    expect(codes({ ...base, testPlan: reasoningPlan(base) })).not.toContain('no_automated_case');
    expect(codes(base)).not.toContain('no_automated_case');
  });

  it('shows on a real run waiting for approval, where it has to be read and acknowledged like every other warning', async () => {
    const f = await v4Fixture({ manualOnly: true });
    const review = f.orch.detail(f.run.id).contractReview;
    expect(review.warnings.map(w => w.code)).toContain('no_automated_case');
    expect(() => f.orch.approveContract(f.run.id, { contractHash: review.contractHash })).toThrow(/cảnh báo/);
    cleanupFixtures();
  }, 60000);
});

describe('the budget a mode switch starts from', () => {
  it('never offers more than the new mode allows, so the default is one the server accepts', () => {
    const run = { budgetUsd: 180, baseBudgetUsd: 100 };
    expect(budgetCeiling(100, 'single')).toBe(100);
    expect(offeredBudget(run, 'single')).toBe(100);
    expect(offeredBudget(run, 'verify')).toBe(180);
    expect(offeredBudget(run, 'compare')).toBe(180);
  });

  it('keeps a smaller budget as it is', () => {
    expect(offeredBudget({ budgetUsd: 40, baseBudgetUsd: 100 }, 'single')).toBe(40);
    expect(offeredBudget({ budgetUsd: 400, baseBudgetUsd: 100 }, 'verify')).toBe(300);
  });
});
