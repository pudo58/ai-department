import { z } from 'zod';
import { summarizeContext, summarizeRuns } from '../../core/metrics.js';
import { checkHealth } from '../environment.js';
import { removability } from '../storage.js';
import { listFolders } from '../folders.js';
import { findWaste } from '../../core/waste.js';
import { GitWorkspaces } from '../../runtime/gitworkspace.js';
import type { RouteContext } from './context.js';

/** Health, folders, storage and clean-up, and the metrics that compare modes. */
export function registerSystemRoutes({ app, store, dataDir, previews, storage }: RouteContext): void {
  app.get('/api/health', async () => checkHealth(dataDir));
  /** Folder picker for the project form: sub-folder names of one folder (home when none is given), read only. */
  app.get('/api/system/folders', async (request) => listFolders(z.object({ path: z.string().max(1000).optional() }).parse(request.query).path));
  app.get('/api/system/storage', async (request) => storage.get(z.object({ refresh: z.string().max(5).optional() }).parse(request.query).refresh === '1'));
  /**
   * Deletes the working copies of the given runs (never the original project). Only runs that are accepted, idle for
   * over a week, or no longer exist qualify; afterwards those runs cannot re-run checks or be tried by hand.
   */
  app.post('/api/system/cleanup', async (request) => {
    const { runIds } = z.object({ runIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,60}$/)).min(1).max(200) }).parse(request.body);
    const workspaces = new GitWorkspaces(dataDir);
    const removed: string[] = [], refused: { runId: string; reason: string }[] = [];
    for (const runId of runIds) {
      const run = store.runs.get(runId);
      const verdict = removability(run, Date.now());
      if (!verdict.removable) { refused.push({ runId, reason: verdict.reason }); continue; }
      previews.stop(runId);
      await workspaces.dispose({ id: runId } as Parameters<GitWorkspaces['dispose']>[0]);
      removed.push(runId);
    }
    storage.invalidate();
    return { removed, refused };
  });
  app.get('/api/metrics', async () => {
    const runs = store.runs.list();
    // Spending that bought nothing new, per task, so modes can be compared on waste as well as cost.
    const waste = new Map<string, number>();
    for (const w of findWaste(runs, store.attempts.list(), 0, Date.now()).items) waste.set(w.runId, (waste.get(w.runId) ?? 0) + w.costUsd);
    return summarizeRuns(runs).map((row) => ({ ...row, wastePerRun: runs.filter((r) => r.initialMode === row.mode).reduce((s, r) => s + (waste.get(r.id) ?? 0), 0) / Math.max(1, row.runs) }));
  });
  app.get('/api/metrics/context', async () => summarizeContext(store.runs.list()));
}
