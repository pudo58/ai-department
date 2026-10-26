import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { autoCleanOnce } from '../src/server/autoclean.js';
import { diskNear, minFreeBytes } from '../src/server/storage.js';
import type { DiskSpace } from '../src/server/storage.js';
import { setup } from './helpers.js';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 3_600_000;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const env = setup(), dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-autoclean-')); dirs.push(dataDir);
  const make = (patch: object) => { const run = env.create(); env.store.runs.put({ ...run, ...patch } as typeof run); return run.id; };
  const delivered = make({ status: 'completed', checkpoint: 'cp1', updatedAt: new Date(NOW - DAY).toISOString(), delivery: { status: 'succeeded', checkpoint: 'cp1', contractVersion: 1, slot: 'A', kind: 'branch', target: 'aidept/x-A', startedAt: new Date(NOW).toISOString(), endedAt: new Date(NOW).toISOString() } });
  const idle = make({ status: 'blocked', updatedAt: new Date(NOW - 9 * DAY).toISOString() });
  const recent = make({ status: 'blocked', updatedAt: new Date(NOW - 1 * DAY).toISOString() });
  const waiting = make({ status: 'awaiting_acceptance', updatedAt: new Date(NOW - 30 * DAY).toISOString() });
  const ids = { delivered, idle, recent, waiting, orphan: 'run_orphan' };
  for (const id of Object.values(ids)) { mkdirSync(path.join(dataDir, 'workspaces', `${id}-A`), { recursive: true }); writeFileSync(path.join(dataDir, 'workspaces', `${id}-A`, 'f.txt'), 'x'); }
  const kept = (id: string) => existsSync(path.join(dataDir, 'workspaces', `${id}-A`));
  return { env, dataDir, ids, kept };
}
const disk = (level: DiskSpace['level']) => async (): Promise<DiskSpace> => ({ path: 'C:/', freeBytes: 1, totalBytes: 2, level });

describe('autoCleanOnce', () => {
  it('removes only copies nobody can use again while the drive has room', async () => {
    const f = fixture();
    const removed = await autoCleanOnce({ store: f.env.store, dataDir: f.dataDir, now: () => NOW, disk: disk('ok') });
    expect(removed.sort()).toEqual([f.ids.delivered, f.ids.orphan].sort());
    expect(f.kept(f.ids.idle) && f.kept(f.ids.recent) && f.kept(f.ids.waiting)).toBe(true);
  });

  it('also removes copies idle for a week when the drive is running low, but never a task awaiting acceptance', async () => {
    const f = fixture(), stopped: string[] = [];
    const removed = await autoCleanOnce({ store: f.env.store, dataDir: f.dataDir, now: () => NOW, disk: disk('warn'), stopPreview: (id) => stopped.push(id) });
    expect(removed.sort()).toEqual([f.ids.delivered, f.ids.idle, f.ids.orphan].sort());
    expect(stopped.sort()).toEqual(removed.sort());
    expect(f.kept(f.ids.recent) && f.kept(f.ids.waiting)).toBe(true);
  });

  it('does nothing when there are no working copies', async () => {
    const f = fixture();
    expect(await autoCleanOnce({ store: f.env.store, dataDir: path.join(f.dataDir, 'nowhere'), now: () => NOW, disk: disk('critical') })).toEqual([]);
  });
});

describe('disk preflight helpers', () => {
  it('finds the drive of a folder that does not exist yet', async () => {
    const found = await diskNear(path.join(tmpdir(), 'aidept-does-not-exist', 'a', 'b'));
    expect(found?.freeBytes).toBeGreaterThan(0);
    expect(minFreeBytes()).toBe(0);
  });
});
