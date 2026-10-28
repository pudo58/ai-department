import { createReadStream } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { VisualProfileSchema } from '../../core/visualprofile.js';
import { readVisualReport } from '../../core/visualevidence.js';
import type { RouteContext } from './context.js';
import type { FigmaService } from '../figma/service.js';
import { VisualChecks } from '../visual.js';
import { HttpError } from '../orchestrator.js';

export function registerVisualRoutes(context: RouteContext, figma: FigmaService): void {
  const { app, store, orchestrator, dataDir, idOf } = context;
  const checks = new VisualChecks(dataDir, figma.snapshots);
  orchestrator.useVisualChecks((run, signal) => checks.run(run, signal));
  // Approves only the displayed visual profile, never a contract or unrelated pending policy edits.
  app.post('/api/runs/:id/visual-check', async request => {
    const body = z.object({ profile: VisualProfileSchema.optional() }).strict().parse(request.body ?? {});
    const id = idOf(request), run = store.runs.get(id);
    if (!run) throw new HttpError(404, 'Run không tồn tại.');
    orchestrator.assertNotDelivering(id);
    if (!['blocked', 'paused', 'failed', 'awaiting_acceptance'].includes(run.status) || !run.checkpoint || !run.contract.design || run.mode === 'compare') throw new HttpError(409, 'Cần run có checkpoint, nguồn Figma và đang chờ; Compare chưa hỗ trợ chạy riêng.');
    const project = store.projects.get(run.projectId);
    if (!project?.approved) throw new HttpError(409, 'Project có policy chưa duyệt. Xem và duyệt policy ở trang Dự án trước.');
    if (body.profile && JSON.stringify(project.visualCheck) !== JSON.stringify(body.profile)) store.projects.put({ ...project, visualCheck: body.profile, version: project.version + 1 });
    if (!body.profile && !project.visualCheck) throw new HttpError(400, 'Chưa có profile hình thức.');
    return orchestrator.recheck(id, true);
  });
  app.get('/api/runs/:id/visual-files/:reportId/:file', async (request, reply) => {
    const { id, reportId, file } = z.object({ id: z.string(), reportId: z.string().regex(/^vis_[a-f0-9]{32}$/), file: z.string().regex(/^screen-\d+-\d+-(?:reference|actual|diff|stability|repeat-[23])\.png$/) }).parse(request.params);
    const run = store.runs.get(id);
    if (!run) throw new HttpError(404, 'Run không tồn tại.');
    const report = readVisualReport(run, store.artifacts.list(id));
    if (!report || report.id !== reportId || !report.screens.some(s => [s.reference, s.actual, s.diff, s.stabilityDiff, ...(s.repeats ?? [])].includes(file))) throw new HttpError(404, 'Ảnh không thuộc report hiện hành.');
    return reply.type('image/png').header('Content-Security-Policy', "default-src 'none'; sandbox").send(createReadStream(path.join(dataDir, 'visual-checks', id, reportId, file)));
  });
}
