import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFixtures, v4Fixture } from './v4-fixtures.js';

afterEach(cleanupFixtures);

const authors = (calls: string[]) => calls.filter(c => c === 'author').length;
const SAID = 'Không thể tạo test nghiệm thu: hợp đồng chưa có ví dụ cho blockedBy.\nCần bổ sung ví dụ rồi cập nhật kế hoạch ca đã duyệt.';

describe('a plan with no automated case gives the Author nothing to write', () => {
  it('does not ask the Author, records an empty manifest that says why, and goes on to the Developer', async () => {
    const f = await v4Fixture({ manualOnly: true });
    expect(f.orch.detail(f.run.id).run.contract.testPlan!.cases).toHaveLength(0);
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    expect(authors(f.calls)).toBe(0);
    expect(f.calls).toContain('developer');
    expect(d.events.some(e => e.type === 'author.skipped')).toBe(true);
    const manifest = JSON.parse(d.artifacts.filter(a => a.title === 'Test manifest').at(-1)!.content);
    expect(manifest).toMatchObject({ source: 'author', slot: 'A', entries: [] });
    expect(manifest.advisories.join(' ')).toMatch(/không có ca tự động/);
    expect(d.authorDraft).toBeUndefined();
  }, 60000);
});

describe('an Author that writes no test file leaves a draft with nothing to repair', () => {
  it('says what the Author said and what to change, instead of offering a repair that cannot work', async () => {
    const f = await v4Fixture({ authorReply: () => SAID });
    await f.approve(f.run.id);
    const d = f.orch.detail(f.run.id);
    expect(d.run.status).toBe('blocked');
    expect(authors(f.calls)).toBe(1);
    expect(d.run.blocker).toContain('Author không tạo file test nào');
    expect(d.run.blocker).toContain('chưa có ví dụ cho blockedBy');
    expect(d.run.blocker).toMatch(/hợp đồng hoặc kế hoạch ca/);
    expect(d.run.blocker).not.toMatch(/runtime chưa hỗ trợ/);
    expect(d.authorDraft).toMatchObject({ empty: true });
    expect(d.authorDraft!.repairAvailable).not.toBe(true);
  }, 60000);

  it('does not buy another Author turn when the person keeps going, and says the same thing again', async () => {
    const f = await v4Fixture({ authorReply: () => SAID });
    await f.approve(f.run.id);
    const first = f.orch.detail(f.run.id).run.blocker;
    f.orch.resumeRun(f.run.id); await f.orch.idle();
    const again = f.orch.detail(f.run.id);
    expect(authors(f.calls)).toBe(1);
    expect(again.run.status).toBe('blocked');
    expect(again.run.blocker).toBe(first);
  }, 60000);
});
