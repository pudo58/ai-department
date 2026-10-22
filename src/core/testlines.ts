export interface LiveTally { passed: number; failed: number; skipped: number; finished: boolean }

const PASS = /^\s*(?:✔|✓|√|ok \d+\b|PASS\b)/;
const FAIL = /^\s*(?:✖|✕|×|not ok \d+\b|FAIL\b)/;
const SKIP = /^\s*(?:﹣|○|↓|ok \d+ .*# (?:SKIP|todo)|SKIP\b)/i;
/** Footer lines runners print once everything is done; after them the same names are listed again, so counting stops. */
const SUMMARY = /^\s*(?:ℹ\s+tests\s+\d+|# tests\s+\d+|Tests:\s+\d+|Test Files\s+\d+)/;

/**
 * Counts finished tests from a runner's console output while it is still running. It understands the node:test
 * spec/TAP reporters and the common Jest/Vitest tick marks. It is a live indicator only: the authoritative result
 * is the report file read when the run ends.
 */
export function countTestLines(lines: readonly string[]): LiveTally {
  const tally: LiveTally = { passed: 0, failed: 0, skipped: 0, finished: false };
  for (const line of lines) {
    if (SUMMARY.test(line)) { tally.finished = true; break; }
    if (SKIP.test(line)) tally.skipped++;
    else if (FAIL.test(line)) tally.failed++;
    else if (PASS.test(line)) tally.passed++;
  }
  return tally;
}
