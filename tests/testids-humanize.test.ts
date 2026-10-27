import { describe, expect, it } from 'vitest';
import { describeTest, humanizeTestIds, testTitle } from '../src/core/testids.js';

const manual = '@json:["src/lib/acceptance-v2.test.ts",["Contract v2 manual report acceptance","[R-1] review source revision/workspace, environment, actual fresh commands and pass/fail/not-run outcomes; record blockers verbatim"]]';
const e2e = '@junit:["e2e\\\\expense-ambiguity.spec.ts","[R-7] reject an ambiguous sentence with a second bare VND amount without saving it"]';

describe('test ids in text a person reads', () => {
  it('turns a structured id into the test name and its file', () => {
    expect(describeTest(manual)).toBe('“Contract v2 manual report acceptance › [R-1] review source revision/workspace, environment, actual fresh commands and pass/fail/not-run outcomes; record blockers verbatim” (src/lib/acceptance-v2.test.ts)');
    expect(describeTest(e2e)).toBe('“[R-7] reject an ambiguous sentence with a second bare VND amount without saving it” (e2e/expense-ambiguity.spec.ts)');
  });

  it('rewrites every id in a blocker, including names that contain brackets, and leaves the rest of the sentence alone', () => {
    const blocker = `${manual}: skipped ${e2e}: failed Check "e2e" fail (mã thoát 1).`;
    const shown = humanizeTestIds(blocker);
    expect(shown).not.toContain('@json:');
    expect(shown).not.toContain('@junit:');
    expect(shown).toContain('(src/lib/acceptance-v2.test.ts): skipped “[R-7] reject an ambiguous sentence');
    expect(shown).toMatch(/\(e2e\/expense-ambiguity\.spec\.ts\): failed Check "e2e" fail \(mã thoát 1\)\.$/);
  });

  it('keeps the ids themselves untouched, because a diagnosis has to quote them exactly', () => {
    expect(testTitle(manual)).toBe('Contract v2 manual report acceptance [R-1] review source revision/workspace, environment, actual fresh commands and pass/fail/not-run outcomes; record blockers verbatim');
    expect(manual.startsWith('@json:["src/lib/')).toBe(true);
  });

  it('returns text without ids, and ids it cannot read, as they were', () => {
    expect(humanizeTestIds('Hết ngân sách; không có test nào.')).toBe('Hết ngân sách; không có test nào.');
    expect(describeTest('src/a.test.ts::works')).toBe('src/a.test.ts::works');
    expect(describeTest('@json:[not json')).toBe('@json:[not json');
    expect(humanizeTestIds('lỗi @json:[1,2')).toBe('lỗi @json:[1,2');
  });
});
