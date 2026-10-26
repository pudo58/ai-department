import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { GitWorkspaces } from '../runtime/gitworkspace.js';
import type { Store } from './store.js';
import { diskSpace, removability, type DiskSpace } from './storage.js';

export interface AutoCleanOptions {
  store: Store;
  dataDir: string;
  /** Stops a running preview before its folder goes. */
  stopPreview?: (runId: string) => void;
  now?: () => number;
  disk?: (dir: string) => Promise<DiskSpace | null>;
}

/**
 * Deletes working copies nobody can use again: those of delivered tasks and of tasks that no longer exist. Copies of tasks
 * that merely sat idle for a week (failed, blocked, paused) are kept until the drive runs low, because that is the one case
 * where keeping them can stop the next run. Never touches the original project, and uses the same rules as the Hệ thống tab.
 */
export async function autoCleanOnce({ store, dataDir, stopPreview, now = Date.now, disk = diskSpace }: AutoCleanOptions): Promise<string[]> {
  let names: string[] = [];
  try { names = await readdir(path.join(dataDir, 'workspaces')); } catch { return []; }
  const runIds = new Set(names.flatMap((n) => /^(.+)-(?:A|B|base)(?:-mutation)?$/.exec(n)?.[1] ?? []));
  const level = (await disk(dataDir))?.level, pressure = level === 'warn' || level === 'critical';
  const workspaces = new GitWorkspaces(dataDir), removed: string[] = [];
  for (const runId of runIds) {
    const run = store.runs.get(runId), verdict = removability(run, now());
    if (!verdict.removable) continue;
    const redundant = !run || run.status === 'completed';
    if (!redundant && !pressure) continue;
    stopPreview?.(runId);
    await workspaces.dispose({ id: runId } as Parameters<GitWorkspaces['dispose']>[0]);
    removed.push(runId);
  }
  return removed;
}

/** Runs the clean-up now and then every few hours; returns the function that stops it. */
export function startAutoClean(options: AutoCleanOptions, everyMs = 6 * 3_600_000): () => void {
  const run = () => void autoCleanOnce(options).then((removed) => { if (removed.length) console.log(`Đã dọn bản sao làm việc của ${removed.length} task không còn dùng được.`); }).catch(() => undefined);
  const first = setTimeout(run, 60_000), timer = setInterval(run, everyMs);
  first.unref(); timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}
