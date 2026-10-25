import { z } from 'zod';
import { renderReportMarkdown } from '../../core/report.js';
import { describeProviderLine } from '../../runtime/describe.js';
import { HttpError } from '../orchestrator.js';
import { RunBody, ContractBody, Category } from './schemas.js';
import type { RouteContext } from './context.js';

/** Runs: list, create, detail and every action a person takes on one (start, accept, escalate, findings, human time...). */
export function registerRunRoutes({ app, store, orchestrator, idOf, disposeWorkspaces }: RouteContext): void {
  app.post('/api/runs/:id/preflight',async request=>{z.object({}).strict().parse(request.body??{});return orchestrator.preflight(idOf(request));});
  app.post('/api/runs/:id/revalidate-author-output',async request=>{const body=z.object({attemptId:z.string().min(1),draftHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(request.body);return orchestrator.revalidateAuthorDraft(idOf(request),body.attemptId,body.draftHash);});
  app.post('/api/runs/:id/recheck', async (request) => {
    const body = z.object({ refreshConfig: z.boolean().default(true) }).parse(request.body ?? {});
    return orchestrator.recheck(idOf(request), body.refreshConfig);
  });
  // Polled every few seconds by the task list, so it serves summaries; the full run comes from /api/runs/:id.
  app.get('/api/runs', async () => store.runSummaries());
  app.post('/api/runs', async (request, reply) => reply.code(201).send(orchestrator.createRun(RunBody.parse(request.body))));
  app.get('/api/runs/:id', async (request) => orchestrator.detail(idOf(request)));
  app.delete('/api/runs/:id', async (request) => {
    const run = orchestrator.deleteRun(idOf(request));
    disposeWorkspaces([run]);
    return { deleted: run.id };
  });
  app.post('/api/runs/:id/start', async (request) => orchestrator.startRun(idOf(request)));
  app.post('/api/runs/:id/resume', async (request) => orchestrator.resumeRun(idOf(request)));
  app.post('/api/runs/:id/stop', async (request) => orchestrator.stopRun(idOf(request)));
  app.get('/api/runs/:id/report', async (request) => orchestrator.report(idOf(request)));
  app.get('/api/runs/:id/report.md', async (request, reply) => {
    const markdown = renderReportMarkdown(await orchestrator.report(idOf(request)));
    return reply.header('Content-Type', 'text/markdown; charset=utf-8').header('Content-Disposition', `attachment; filename="bao-cao-${idOf(request)}.md"`).send(markdown);
  });
  app.post('/api/runs/:id/accept', async (request) => {
    const body = z.object({ acknowledgeWarnings: z.boolean().default(false) }).parse(request.body ?? {});
    return orchestrator.acceptRun(idOf(request), { acknowledgeWarnings: body.acknowledgeWarnings });
  });
  app.post('/api/runs/:id/contract', async (request) => orchestrator.reviseContract(idOf(request), ContractBody.parse(request.body)));
  app.post('/api/runs/:id/approve-test-repair', async (request) => {
    const body = z.object({ proposalId: z.string().min(1), proposalHash: z.string().regex(/^[0-9a-f]{64}$/) }).parse(request.body);
    return orchestrator.approveTestRepair(idOf(request), body.proposalId, body.proposalHash);
  });
  app.post('/api/runs/:id/reject-test-repair', async (request) => {
    const body = z.object({ proposalId: z.string().min(1), proposalHash: z.string().regex(/^[0-9a-f]{64}$/) }).parse(request.body);
    return orchestrator.rejectTestRepair(idOf(request), body.proposalId, body.proposalHash);
  });
  app.post('/api/runs/:id/approve-contract', async (request) => {
    const body = z.object({ contractHash: z.string().regex(/^[0-9a-f]{64}$/), acknowledgeWarnings: z.boolean().default(false) }).parse(request.body);
    return orchestrator.approveContract(idOf(request), body);
  });
  app.post('/api/runs/:id/reject', async (request) => orchestrator.rejectAcceptance(idOf(request), z.object({ reason: z.string().min(3).max(2000) }).parse(request.body).reason));
  app.post('/api/runs/:id/repair', async (request) => orchestrator.repairFindings(idOf(request)));
  app.post('/api/runs/:id/approve-paths', async (request) => {
    const body = z.object({ paths: z.array(z.string().min(1).max(300)).min(1).max(50), resume: z.boolean().default(false) }).parse(request.body);
    return orchestrator.approvePaths(idOf(request), body.paths, body.resume);
  });
  app.post('/api/runs/:id/escalate', async (request) => {
    const body = z.object({ mode: z.enum(['single', 'clarify', 'verify', 'compare']), reason: z.string().min(3).max(2000), budgetUsd: z.number().positive().max(3000).optional() }).parse(request.body);
    return orchestrator.escalate(idOf(request), body.mode, body.reason, body.budgetUsd);
  });
  app.post('/api/runs/:id/findings/:fid/:action', async (request) => {
    const { id, fid, action } = request.params as { id: string; fid: string; action: string };
    if (action === 'confirm') return orchestrator.confirmFinding(id, fid);
    if (action === 'resolve') return orchestrator.resolveFinding(id, fid);
    if (action === 'dispute') return orchestrator.disputeFinding(id, fid, z.object({ reason: z.string().min(3).max(2000) }).parse(request.body).reason);
    throw new HttpError(404, 'Hành động không tồn tại.');
  });
  app.post('/api/runs/:id/checks/:cid/quarantine', async (request) => {
    const { id, cid } = request.params as { id: string; cid: string };
    return orchestrator.quarantineCheck(id, cid, z.object({ reason: z.string().min(3).max(2000) }).parse(request.body).reason);
  });

  app.post('/api/runs/:id/time/start', async (request) => {
    const body = z.object({ category: Category, note: z.string().max(500).default('') }).parse(request.body);
    return orchestrator.startTimer(idOf(request), body.category, body.note);
  });
  app.post('/api/runs/:id/time/:tid/stop', async (request) => {
    const { id, tid } = request.params as { id: string; tid: string };
    return orchestrator.stopTimer(id, tid);
  });
  app.post('/api/runs/:id/time/manual', async (request) => {
    const body = z.object({ category: Category, minutes: z.number().min(0).max(1440), note: z.string().max(500).default('') }).parse(request.body);
    return orchestrator.addHumanMinutes(idOf(request), body.category, body.minutes, body.note);
  });
  /** Raw provider output of one attempt, with a readable rendering next to it. */
  app.get('/api/runs/:id/attempts/:aid/raw', async (request) => {
    const { id, aid } = request.params as { id: string; aid: string };
    const artifacts = store.artifacts.list(id).filter((a) => a.kind === 'raw' && a.attemptId === aid);
    if (!artifacts.length) throw new HttpError(404, 'Attempt chưa có log thô.');
    const raw = artifacts.map((a) => a.content).join('\n');
    const lines = raw.split('\n').map(describeProviderLine).filter((l): l is NonNullable<typeof l> => l !== null);
    return { lines, raw: raw.length > 200_000 ? `${raw.slice(0, 200_000)}\n… (cắt bớt)` : raw };
  });
}
