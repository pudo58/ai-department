import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/core/context.js';
import { PROMPTS } from '../src/core/prompts.js';
import { reviewDiff } from '../src/core/reviewdiff.js';
import { green, profile, red, setup } from './helpers.js';

const file = (path: string, lines: number, mark = '+x') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `${mark}${i}`).join('\n')}\n`;

describe('the diff a Verifier reads', () => {
  it('shows everything when it fits, code before tests, and hides lockfiles by name only', () => {
    const patch = file('tests/a.test.ts', 3) + file('package-lock.json', 500) + file('src/a.ts', 3);
    const out = reviewDiff(patch);
    expect(out.indexOf('src/a.ts')).toBeLessThan(out.indexOf('tests/a.test.ts'));
    expect(out).not.toContain('+x499');
    expect(out).toContain('File sinh tự động/lockfile không hiển thị: package-lock.json');
  });

  it('in Verify mode the reviewer sees the Author tests and the Developer code together, not only the last round', async () => {
    let verifierPrompt = '';
    const env = setup({
      check: () => green,
      files: (e) => (e.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts']),
      reply: (e) => { if (e.role === 'verifier') verifierPrompt = e.prompt; return undefined; },
    });
    await env.drive(env.create({ mode: 'verify' }));
    const diff = verifierPrompt.slice(verifierPrompt.indexOf('Diff:'));
    expect(diff).toContain('src/order.ts');
    expect(diff).toContain('tests/order.test.ts');
  });

  it('cuts a long file at a line boundary and names what it left out, instead of stopping mid-line', () => {
    const patch = file('src/big.ts', 4000, '+const value = 1; // ') + file('src/small.ts', 2) + file('tests/b.test.ts', 2);
    const out = reviewDiff(patch, 20_000);
    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(out).toMatch(/… \(cắt bớt \d+ dòng còn lại của src\/big\.ts\)/);
    expect(out).toContain('File bị cắt bớt vì diff quá dài: src/big.ts');
    // Every shown line is whole.
    for (const line of out.split('\n').filter((l) => l.startsWith('+const'))) expect(line).toMatch(/^\+const value = 1; \/\/ \d+$/);
  });
});

describe('repair prompts', () => {
  const run = (() => { const env = setup(); return env.create(); })();

  it('a fresh repair keeps the unchanging parts first and the problems last, so the prompt cache covers the start', () => {
    const p = PROMPTS.repair(run, ['Check "test" fail: expected 2']);
    expect(p.indexOf('Hợp đồng v')).toBeLessThan(p.indexOf('Check "test" fail'));
    expect(p.indexOf('Quy tắc chất lượng')).toBeLessThan(p.indexOf('Check "test" fail'));
    // Two rounds share their beginning up to the problems.
    const q = PROMPTS.repair(run, ['khác']);
    const shared = p.slice(0, p.indexOf('Vấn đề cần sửa'));
    expect(q.startsWith(shared)).toBe(true);
  });

  it('a repair in the resumed session sends only the problems', () => {
    const p = PROMPTS.repairFollowUp(['Check "test" fail']);
    expect(p).toContain('Check "test" fail');
    expect(p).not.toContain('Hợp đồng v');
    expect(p).not.toContain('Quy tắc chất lượng');
    expect(p.length).toBeLessThan(PROMPTS.repair(run, ['Check "test" fail']).length / 2);
  });

  it('the orchestrator sends the short follow-up only when the Developer session is really resumed', async () => {
    const prompts: { prompt: string; resumed: boolean }[] = [];
    const env = setup({
      check: (_e, call) => (call <= 2 ? red : green),
      reply: (e) => { if (e.role === 'developer') prompts.push({ prompt: e.prompt, resumed: !!e.sessionId }); return undefined; },
    });
    await env.drive(env.create());
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.resumed).toBe(true);
    expect(prompts[1]!.prompt).toContain('Tiếp tục phiên trước');
    expect(prompts[1]!.prompt).not.toContain('Hợp đồng v');
  });

  it('Antigravity cannot resume a session, so its repair gets the full prompt again', async () => {
    const prompts: { prompt: string; resumed: boolean }[] = [];
    const roles = { ...profile().roles, developer: { provider: 'antigravity' as const, model: '', effort: 'medium' as const, skills: [] } };
    const env = setup({
      check: (_e, call) => (call <= 2 ? red : green),
      reply: (e) => { if (e.role === 'developer') prompts.push({ prompt: e.prompt, resumed: !!e.sessionId }); return undefined; },
    }, { roles });
    await env.drive(env.create({ provider: 'codex' }));
    const repairs = prompts.slice(1);
    expect(repairs.length).toBeGreaterThan(0);
    expect(repairs.every((r) => !r.resumed && r.prompt.includes('Hợp đồng v'))).toBe(true);
  });
});

describe('token estimate', () => {
  it('counts Vietnamese with diacritics as heavier than plain ASCII of the same length', () => {
    const vi = 'Không tạo đơn trùng khi người dùng bấm lại nút thanh toán.';
    const ascii = 'Khong tao don trung khi nguoi dung bam lai nut thanh toan.';
    expect(vi.length).toBe(ascii.length);
    expect(estimateTokens(vi)).toBeGreaterThan(estimateTokens(ascii));
    // Roughly 3 characters per token for ordinary Vietnamese prose, not 3.5.
    expect(vi.length / estimateTokens(vi)).toBeLessThan(3.2);
  });
});
