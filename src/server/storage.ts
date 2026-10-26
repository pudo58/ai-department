import { lstat, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import type { Run } from '../shared/types.js';
import { delivered } from '../core/delivery.js';

export interface DiskSpace { path: string; freeBytes: number; totalBytes: number; level: 'ok' | 'warn' | 'critical' }
export interface WorkspaceUsage {
  runId: string; title: string | null; status: string | null; projectId: string | null; updatedAt: string | null;
  folders: string[]; sizeBytes: number; files: number; truncated: boolean;
  /** Safe to delete: accepted, waiting for over a week, or left behind by a run that no longer exists. */
  removable: boolean; reason: string;
}
export interface StorageReport { computedAt: string | null; computing: boolean; disk: DiskSpace | null; workspaces: WorkspaceUsage[]; totalBytes: number }

const GB = 1024 ** 3;
/** Below this a new run is not started: copying the project and installing dependencies would fail halfway. */
export const MIN_FREE_BYTES = 512 * 1024 ** 2;

/** Free space on the drive that holds `target`, using the nearest folder that already exists. */
export async function diskNear(target: string): Promise<DiskSpace | null> {
  let dir = path.resolve(target);
  for (let i = 0; i < 5; i++) {
    const found = await diskSpace(dir);
    if (found) return found;
    dir = path.dirname(dir);
  }
  return null;
}
const STALE_MS = 7 * 24 * 3_600_000;
const MAX_FILES_PER_RUN = 200_000;

/** Free space on the drive holding `dir`; warn under 5 GB, critical under 2 GB (npm and tests fail when it runs out). */
export async function diskSpace(dir: string): Promise<DiskSpace | null> {
  try {
    const s = await statfs(dir);
    const freeBytes = Number(s.bavail) * Number(s.bsize), totalBytes = Number(s.blocks) * Number(s.bsize);
    return { path: path.parse(path.resolve(dir)).root, freeBytes, totalBytes, level: freeBytes < 2 * GB ? 'critical' : freeBytes < 5 * GB ? 'warn' : 'ok' };
  } catch { return null; }
}

async function folderSize(dir: string, budget: { files: number }): Promise<{ bytes: number; files: number; truncated: boolean }> {
  let bytes = 0, files = 0, truncated = false;
  const walk = async (d: string): Promise<void> => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget.files <= 0) { truncated = true; return; }
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      try { bytes += (await lstat(p)).size; files++; budget.files--; } catch { /* vanished */ }
    }
  };
  await walk(dir);
  return { bytes, files, truncated };
}

/** Why a workspace may (or may not) be deleted. Running or reviewable work is always kept. */
export function removability(run: Run | undefined, now: number): { removable: boolean; reason: string } {
  if (!run) return { removable: true, reason: 'Không còn task nào dùng bản sao này.' };
  if (run.delivery && !delivered(run)) return { removable: false, reason: 'Chưa xác nhận giao thành công đúng checkpoint và hợp đồng; cần giữ workspace để thử giao lại.' };
  if (run.status === 'completed') return delivered(run)
    ? { removable: true, reason: 'Task đã nghiệm thu; kết quả đã giao về project.' }
    : { removable: false, reason: 'Task cũ chưa có bằng chứng giao kết quả; cần giữ workspace.' };
  if (['running', 'queued'].includes(run.status)) return { removable: false, reason: 'Task đang chạy.' };
  const idle = now - Date.parse(run.updatedAt);
  if (['failed', 'blocked', 'paused'].includes(run.status) && idle > STALE_MS) return { removable: true, reason: `Task "${run.status}" không động tới hơn 7 ngày.` };
  return { removable: false, reason: run.status === 'awaiting_acceptance' ? 'Đang chờ nghiệm thu: cần bản sao để chạy thử và giao kết quả.' : 'Task còn có thể chạy tiếp hoặc chạy lại check.' };
}

/**
 * Sizes of the per-run working copies under `<dataDir>/workspaces`. Walking node_modules is slow, so the report is
 * computed in the background and cached; callers get the last result immediately with `computing` set while it refreshes.
 */
export class StorageMonitor {
  private report: StorageReport = { computedAt: null, computing: false, disk: null, workspaces: [], totalBytes: 0 };
  private pending: Promise<void> | null = null;
  constructor(private readonly dataDir: string, private readonly runs: () => readonly Run[], private readonly ttlMs = 5 * 60_000) {}

  async get(force = false): Promise<StorageReport> {
    const disk = await diskSpace(this.dataDir);
    const stale = !this.report.computedAt || Date.now() - Date.parse(this.report.computedAt) > this.ttlMs;
    if ((stale || force) && !this.pending) this.pending = this.compute().finally(() => { this.pending = null; });
    return { ...this.report, disk, computing: !!this.pending };
  }

  /** For tests and callers that need the fresh numbers. */
  async settle(): Promise<StorageReport> { if (this.pending) await this.pending; return this.get(); }

  invalidate(): void { this.report = { ...this.report, computedAt: null }; }

  private async compute(): Promise<void> {
    const root = path.join(this.dataDir, 'workspaces');
    let names: string[] = [];
    try { names = await readdir(root); } catch { /* none yet */ }
    const byRun = new Map<string, string[]>();
    for (const n of names) {
      const m = /^(.+)-(A|B|base)(?:-mutation)?$/.exec(n);
      if (m) byRun.set(m[1]!, [...(byRun.get(m[1]!) ?? []), n]);
    }
    const runs = new Map(this.runs().map((r) => [r.id, r]));
    const now = Date.now();
    const workspaces: WorkspaceUsage[] = [];
    for (const [runId, folders] of byRun) {
      const budget = { files: MAX_FILES_PER_RUN };
      let sizeBytes = 0, files = 0, truncated = false;
      for (const f of folders) { const s = await folderSize(path.join(root, f), budget); sizeBytes += s.bytes; files += s.files; truncated ||= s.truncated; }
      const run = runs.get(runId);
      workspaces.push({ runId, title: run?.title ?? null, status: run?.status ?? null, projectId: run?.projectId ?? null, updatedAt: run?.updatedAt ?? null, folders, sizeBytes, files, truncated, ...removability(run, now) });
    }
    workspaces.sort((a, b) => b.sizeBytes - a.sizeBytes);
    this.report = { computedAt: new Date().toISOString(), computing: false, disk: null, workspaces, totalBytes: workspaces.reduce((s, w) => s + w.sizeBytes, 0) };
  }
}
