import { describe, expect, it } from 'vitest';
import { countTestLines } from '../src/core/testlines.js';

describe('live test tally from runner output', () => {
  it('counts node:test spec lines and stops at the footer so the failing-test recap is not counted twice', () => {
    const lines = [
      '✔ [R-1] reads all pages (2.2ms)', '✔ [R-2] job runs on the hour (0.9ms)', '✖ [R-3] rejects a foreign shop (5.0ms)',
      '﹣ [R-1] live menu # BLOCKED: set SHOPEEFOOD_LIVE_SHOP_ID',
      'ℹ tests 4', 'ℹ pass 2', 'ℹ fail 1', '✖ failing tests:', '✖ [R-3] rejects a foreign shop (5.0ms)',
    ];
    expect(countTestLines(lines)).toEqual({ passed: 2, failed: 1, skipped: 1, finished: true });
  });

  it('reports a run in progress as not finished', () => {
    expect(countTestLines(['✔ one (1ms)', '✔ two (1ms)'])).toEqual({ passed: 2, failed: 0, skipped: 0, finished: false });
  });

  it('understands TAP and Jest/Vitest tick marks, and ignores unrelated lines', () => {
    expect(countTestLines(['TAP version 13', 'ok 1 - first', 'not ok 2 - second', 'ok 3 - third # SKIP', '  ✓ jest style (3 ms)', '  ✕ jest failing', 'npm warn deprecated glob']))
      .toEqual({ passed: 2, failed: 2, skipped: 1, finished: false });
    expect(countTestLines([])).toEqual({ passed: 0, failed: 0, skipped: 0, finished: false });
  });
});
