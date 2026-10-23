import { existsSync } from 'node:fs';
import { guessPreviewCommand } from '../preview.js';
import { HttpError } from '../orchestrator.js';
import type { RouteContext } from './context.js';

/** Trying a run's result by hand: start, stop and list the preview processes. */
export function registerPreviewRoutes({ app, store, orchestrator, previews, idOf }: RouteContext): void {
  app.get('/api/system/previews', async () => previews.list());
  app.addHook('onClose', async () => previews.stopAll());
  // Anything that hands the working copy back to an agent, or delivers it, stops the preview first.
  app.addHook('preHandler', async (request) => {
    const m = /^\/api\/runs\/([^/]+)\/(start|resume|recheck|repair|accept|escalate|approve-contract|approve-paths|contract)$/.exec(request.url.split('?')[0] ?? '');
    if (request.method === 'POST' && m) previews.stop(m[1]!);
  });
  app.get('/api/runs/:id/preview', async (request) => ({ preview: previews.get(idOf(request)) ?? null }));
  app.post('/api/runs/:id/preview/start', async (request) => {
    const id = idOf(request);
    const run = store.runs.get(id);
    if (!run) throw new HttpError(404, 'Run không tồn tại.');
    if (['running', 'queued'].includes(run.status)) throw new HttpError(409, 'Run đang chạy; chờ nó dừng rồi hãy chạy thử.');
    const cwd = orchestrator.workspaceOf(id);
    if (!cwd || !existsSync(cwd)) throw new HttpError(409, 'Run chưa có bản code để chạy thử (chưa có checkpoint, là mô phỏng, hoặc bản sao làm việc đã bị xóa).');
    const project = store.projects.get(run.projectId);
    const command = project?.previewCommand?.length ? project.previewCommand : await guessPreviewCommand(cwd);
    if (!command) throw new HttpError(400, 'Không đoán được cách chạy app. Đặt "Lệnh chạy thử" trong Sửa project, ví dụ ["npm","run","dev"].');
    try { return { preview: await previews.start(id, cwd, command) }; } catch (error) { throw new HttpError(422, (error as Error).message); }
  });
  app.post('/api/runs/:id/preview/stop', async (request) => ({ stopped: previews.stop(idOf(request)) }));
}
