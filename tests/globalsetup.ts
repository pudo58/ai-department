import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Most suites make folders under the OS temp folder and many never remove them (thousands piled up). Every test process
 * gets its own temp folder for this run, so whatever a suite leaves behind goes with it when the run ends, and folders left
 * by crashed or older runs are swept at the start.
 */
const STALE_MS = 6 * 3_600_000;

export default function setup(): () => void {
  const base = tmpdir();
  const now = Date.now();
  for (const name of readdirSync(base)) {
    if (!/^aidept-/.test(name)) continue;
    const full = path.join(base, name);
    try { if (now - statSync(full).mtimeMs > STALE_MS) rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* In use by something else; leave it. */ }
  }
  const mine = mkdtempSync(path.join(base, 'aidept-vitest-'));
  mkdirSync(mine, { recursive: true });
  // Workers are started after this, so they inherit the redirected folder; so do the Git/Node processes the suites spawn.
  process.env.TEMP = mine; process.env.TMP = mine; process.env.TMPDIR = mine;
  return () => {
    try { rmSync(mine, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows may still hold a handle; the next run sweeps it. */ }
  };
}
