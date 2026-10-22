import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { ProjectProfile } from '../shared/types.js';
import { buildMonitor, PERIODS } from '../core/monitor.js';
import { renderReportMarkdown } from '../core/report.js';
import { describeProviderLine } from '../runtime/describe.js';
import { summarizeContext, summarizeRuns } from '../core/metrics.js';
import { DEFAULT_PROTECTED, isSafeRelative } from '../core/scope.js';
import { DEFAULT_CONTEXT_BUDGET, selectContext } from '../core/context.js';
import { MEMORY_KINDS, MEMORY_MAX_ACTIVE, MEMORY_MAX_TEXT, MEMORY_MAX_TOTAL, newMemoryItem, staleReason, updateMemoryItem } from '../core/memory.js';
import { buildRepoMap } from '../core/repomap.js';
import { guessPreviewCommand, PreviewManager } from './preview.js';
import type { ContextRole, MemoryKind, Run } from '../shared/types.js';
import { detectStack } from '../core/stackdetect.js';
import { GUIDANCE_MAX_CHARS, normalizeGuidance } from '../shared/guidance.js';
import { checkHealth } from './environment.js';
import { cachedCliStatus, forgetCliStatus, installCodex, startLogin, testCli, type AgentCli } from '../runtime/agentclis.js';
import { diskSpace, removability, StorageMonitor } from './storage.js';
import { listFolders } from './folders.js';
import { findWaste } from '../core/waste.js';
import { GitWorkspaces } from '../runtime/gitworkspace.js';
import { HttpError, type Orchestrator } from './orchestrator.js';
import { matchesLog, type LogEntry, type LogQuery, type Store } from './store.js';

const ROLES = ['planner', 'author', 'developer', 'verifier', 'investigator'] as const;
const RoleConfig = z.object({ provider: z.enum(['codex', 'claude', 'antigravity']), model: z.string().max(100).default(''), effort: z.enum(['low', 'medium', 'high']).default('medium'), skills: z.array(z.string().max(500)).max(20).default([]) });
const Recipe = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), command: z.array(z.string().max(1000)).min(1).max(50), required: z.boolean().default(true), timeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000), reportPath: z.string().max(300).optional() });
const Budget = z.number().int().min(0).max(20_000);
const MemoryPath = z.string().trim().min(1).max(300).refine((p) => isSafeRelative(p), 'Đường dẫn phải là đường dẫn tương đối trong repo.');
const MemoryBody = z.object({
  kind: z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]), text: z.string().trim().min(3).max(MEMORY_MAX_TEXT),
  paths: z.array(MemoryPath).max(10).default([]), pinned: z.boolean().default(false),
});
const ProjectBody = z.object({
  name: z.string().trim().min(1).max(120), repository: z.string().trim().min(1).max(500),
  modules: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
  checks: z.array(Recipe).min(1).max(20).refine((list) => new Set(list.map((c) => c.id)).size === list.length, 'Mỗi check cần một id riêng.'),
  guidance: z.string().max(GUIDANCE_MAX_CHARS, `Hướng dẫn tối đa ${GUIDANCE_MAX_CHARS} ký tự.`).transform(normalizeGuidance).default(''),
  singleBudgetUsd: z.number().positive().max(1000), roles: z.object(Object.fromEntries(ROLES.map((r) => [r, RoleConfig])) as Record<typeof ROLES[number], typeof RoleConfig>),
  runnerImage: z.string().trim().min(1).max(300), setupCommand: z.array(z.string().max(1000)).max(50).default([]),
  agentNetwork: z.string().max(100).default('aidept-agent'),
  executionMode: z.enum(['docker', 'local']).default('local'),
  contextEnabled: z.boolean().default(false),
  allowScaffold: z.boolean().default(false),
  previewCommand: z.array(z.string().min(1).max(1000)).max(50).default([]),
  contextBudget: z.object({ planner: Budget, developer: Budget, author: Budget, verifier: Budget }).partial().default({}),
});
const RunBody = z.object({
  projectId: z.string(), title: z.string().trim().min(1).max(180), originalRequirement: z.string().trim().min(1).max(20000),
  mode: z.enum(['single', 'clarify', 'verify', 'compare']).default('single'), provider: z.enum(['fake', 'codex', 'claude']).default('fake'),
  budgetUsd: z.number().positive().max(1000), signals: z.array(z.string().max(40)).max(10).default([]),
  taskKind: z.enum(['bugfix', 'feature', 'refactor']).optional(),
});
const ContractBody = z.object({
  requirements: z.array(z.object({ id: z.string(), text: z.string().max(8000), required: z.boolean(), manual: z.boolean() })).min(1).max(50),
  acceptanceExamples: z.array(z.string().max(4000)).max(100), interfaces: z.array(z.string().max(4000)).max(100),
  assumptions: z.array(z.string().max(4000)).max(100), scope: z.array(z.string().max(500)).max(100),
});
const Category = z.enum(['clarification', 'approval', 'review', 'quota', 'acceptance', 'rework', 'onboarding', 'research']);

export interface AppOptions { store: Store; orchestrator: Orchestrator; dataDir: string; port: number; staticDir?: string }

/**
 * Loopback-only API. Defence in depth for a local tool a browser can reach: Host must be a loopback name
 * (blocks DNS rebinding), Origin must match on writes, and writes need the per-process CSRF token.
 */
export async function buildApp({ store, orchestrator, dataDir, port, staticDir }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const token = randomBytes(24).toString('hex');
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]'].flatMap((h) => [`${h}:${port}`, `${h}:5173`]));
  const origins = new Set([...hosts].map((h) => `http://${h}`));

  app.addHook('onRequest', async (request, reply) => {
    if (!hosts.has(String(request.headers.host ?? '').toLowerCase())) return reply.code(403).send({ error: 'Host không được phép.' });
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return reply.code(403).send({ error: 'Origin không được phép.' });
    const sent = Buffer.from(String(request.headers['x-csrf-token'] ?? ''));
    const expected = Buffer.from(token);
    if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) return reply.code(403).send({ error: 'Thiếu hoặc sai CSRF token.' });
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY')
      .header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  });
  app.setErrorHandler((error: Error & { statusCode?: number; issues?: unknown }, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid', message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error instanceof HttpError) return reply.code(error.status).send({ error: 'request_failed', message: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'bad_request', message: error.message });
    return reply.code(500).send({ error: 'internal', message: 'Lỗi nội bộ của server.' });
  });

  const idOf = (request: { params: unknown }) => (request.params as { id: string }).id;
  app.get('/api/session', async () => ({ token }));
  app.get('/api/health', async () => checkHealth(dataDir));

  // ---- connecting the agent CLIs: status, a one-request test, installing Codex locally, starting the browser login
  const Cli = z.object({ id: z.enum(['codex', 'claude', 'antigravity']) });
  app.get('/api/providers', async (request) => {
    if (z.object({ refresh: z.string().max(5).optional() }).parse(request.query).refresh === '1') forgetCliStatus();
    return Promise.all((['codex', 'claude', 'antigravity'] as AgentCli[]).map((id) => cachedCliStatus(id)));
  });
  app.post('/api/providers/:id/test', async (request) => testCli(Cli.parse(request.params).id, dataDir));
  app.post('/api/providers/:id/login', async (request) => startLogin(Cli.parse(request.params).id));
  app.post('/api/providers/codex/install', async () => installCodex());

  // ---- projects
  /** A project is any existing folder: git is optional. The filesystem root and the home folder are refused as too broad. */
  const assertProjectDir = async (repository: string) => {
    const info = await stat(repository).catch(() => undefined);
    if (!info?.isDirectory()) throw new HttpError(400, 'Đường dẫn không phải thư mục tồn tại.');
    if (path.parse(repository).root === repository || repository === path.resolve(homedir())) throw new HttpError(400, 'Thư mục quá rộng (ổ đĩa gốc hoặc thư mục home); hãy chọn thư mục của project.');
  };
  app.get('/api/projects', async () => store.projects.list());
  /** Folder picker for the project form: sub-folder names of one folder (home when none is given), read only. */
  app.get('/api/system/folders', async (request) => listFolders(z.object({ path: z.string().max(1000).optional() }).parse(request.query).path));
  /**
   * Read-only stack detection for the create/edit forms: reads a few manifest files in the repository and returns
   * suggested guidance and checks. Nothing is stored or executed; the person decides what to keep.
   */
  app.post('/api/projects/detect', async (request) => {
    const body = z.object({ repository: z.string().trim().min(1).max(500).optional(), projectId: z.string().max(60).optional() }).parse(request.body);
    const stored = body.projectId ? store.projects.get(body.projectId) : undefined;
    if (body.projectId && !stored) throw new HttpError(404, 'Project không tồn tại.');
    const repository = path.resolve(stored?.repository ?? body.repository ?? '');
    if (!stored && !body.repository) throw new HttpError(400, 'Cần repository hoặc projectId.');
    await assertProjectDir(repository);
    return detectStack(repository);
  });
  app.post('/api/projects', async (request, reply) => {
    const body = ProjectBody.parse(request.body);
    const repository = path.resolve(body.repository);
    await assertProjectDir(repository);
    const project: ProjectProfile = {
      id: `prj_${randomUUID().slice(0, 8)}`, name: body.name, repository, version: 1, approved: false,
      modules: body.modules, protectedPaths: DEFAULT_PROTECTED, checks: body.checks, roles: body.roles, runnerImage: body.runnerImage,
      setupCommand: body.setupCommand, agentNetwork: body.agentNetwork, executionMode: body.executionMode, guidance: body.guidance,
      contextEnabled: body.contextEnabled, contextBudget: body.contextBudget, previewCommand: body.previewCommand, allowScaffold: body.allowScaffold,
      policyRules: ['Chỉ sửa trong module cho phép.', 'Không sửa test đã khóa, config check hoặc lockfile.', 'Không thêm dependency khi chưa được duyệt.'],
      singleBudgetUsd: body.singleBudgetUsd, currency: 'USD', createdAt: new Date().toISOString(),
    };
    store.projects.put(project);
    return reply.code(201).send(project);
  });
  /**
   * Edits the parts of a project people legitimately need to fix after creating it. Any change counts as a policy
   * change: the version rises and the policy must be approved again. Existing runs keep their own snapshot until
   * someone re-runs their checks with the new configuration.
   */
  app.patch('/api/projects/:id', async (request) => {
    const project = store.projects.get(idOf(request));
    if (!project) throw new HttpError(404, 'Project không tồn tại.');
    const patch = ProjectBody.pick({ name: true, modules: true, checks: true, singleBudgetUsd: true, setupCommand: true, executionMode: true, guidance: true, contextEnabled: true, contextBudget: true, previewCommand: true, allowScaffold: true, roles: true }).partial().parse(request.body);
    // The schema fills defaults for fields the client did not send; only fields actually present may change anything,
    // or editing `modules` would silently reset `setupCommand` and `executionMode`.
    const sent = new Set(Object.keys((request.body ?? {}) as object));
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => sent.has(k) && patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(k === 'guidance' ? project.guidance ?? '' : k === 'contextEnabled' ? project.contextEnabled ?? false : k === 'allowScaffold' ? project.allowScaffold ?? false : k === 'contextBudget' ? project.contextBudget ?? {} : k === 'previewCommand' ? project.previewCommand ?? [] : project[k]));
    if (!changed.length) return project;
    Object.assign(project, Object.fromEntries(changed.map((k) => [k, patch[k]])));
    project.version += 1; project.approved = false;
    return store.projects.put(project);
  });
  app.post('/api/runs/:id/recheck', async (request) => {
    const body = z.object({ refreshConfig: z.boolean().default(true) }).parse(request.body ?? {});
    return orchestrator.recheck(idOf(request), body.refreshConfig);
  });
  // ---- project context: approved memory, repo map and a preview of what each role would receive
  const projectOf = (request: { params: unknown }) => {
    const project = store.projects.get(idOf(request));
    if (!project) throw new HttpError(404, 'Project không tồn tại.');
    return project;
  };
  const memoryOf = (request: { params: unknown }) => {
    const project = projectOf(request);
    const item = store.memories.get((request.params as { mid: string }).mid);
    if (!item || item.projectId !== project.id) throw new HttpError(404, 'Mục bộ nhớ không tồn tại.');
    return item;
  };
  const activeCount = (projectId: string, except?: string) => store.memories.list(projectId).filter((m) => m.status === 'active' && m.id !== except).length;
  app.get('/api/projects/:id/memory', async (request) => store.memories.list(projectOf(request).id));
  /** A person's own entry is active at once: writing it is the approval. */
  app.post('/api/projects/:id/memory', async (request, reply) => {
    const project = projectOf(request);
    const body = MemoryBody.parse(request.body);
    if (store.memories.list(project.id).length >= MEMORY_MAX_TOTAL) throw new HttpError(409, `Tối đa ${MEMORY_MAX_TOTAL} mục bộ nhớ mỗi project; hãy xóa bớt mục đã lưu trữ.`);
    if (activeCount(project.id) >= MEMORY_MAX_ACTIVE) throw new HttpError(409, `Tối đa ${MEMORY_MAX_ACTIVE} mục đang dùng; hãy lưu trữ bớt mục cũ.`);
    const item = newMemoryItem({ id: `mem_${randomUUID().slice(0, 8)}`, projectId: project.id, ...body, status: 'active', source: { type: 'human' } }, new Date().toISOString());
    return reply.code(201).send(store.memories.put(item));
  });
  app.patch('/api/projects/:id/memory/:mid', async (request) => {
    const item = memoryOf(request);
    const patch = MemoryBody.partial().extend({ status: z.enum(['active', 'archived']).optional() }).parse(request.body ?? {});
    if (patch.status === 'active' && item.status !== 'active' && activeCount(item.projectId, item.id) >= MEMORY_MAX_ACTIVE) throw new HttpError(409, `Tối đa ${MEMORY_MAX_ACTIVE} mục đang dùng.`);
    return store.memories.put(updateMemoryItem(item, patch, new Date().toISOString()));
  });
  app.delete('/api/projects/:id/memory/:mid', async (request) => { const item = memoryOf(request); store.memories.delete(item.id); return { deleted: item.id }; });
  app.get('/api/projects/:id/repomap', async (request) => {
    const project = projectOf(request);
    await assertProjectDir(project.repository);
    return buildRepoMap(project.repository);
  });
  /**
   * What a role would receive for a new task right now, with the project folder as it is. Nothing is stored; items
   * that would be skipped are listed with the reason. `budget` previews a different budget before saving it.
   */
  app.get('/api/projects/:id/context', async (request) => {
    const project = projectOf(request);
    const q = z.object({ role: z.enum(['planner', 'developer', 'author', 'verifier']).default('developer'), budget: z.coerce.number().int().min(0).max(20_000).optional() }).parse(request.query);
    const repoMap = await buildRepoMap(project.repository);
    const now = Date.now();
    const active = store.memories.list(project.id).filter((m) => m.status === 'active');
    const skipped = active.map((m) => ({ id: m.id, reason: staleReason(m, repoMap, now) })).filter((x): x is { id: string; reason: string } => !!x.reason);
    const memory = active.filter((m) => !skipped.some((s) => s.id === m.id));
    const role = q.role as ContextRole;
    const budgets = { ...project.contextBudget, ...(q.budget !== undefined ? { [role]: q.budget } : {}) };
    const draft = {
      originalRequirement: '(task mới)', contract: { version: 0, requirements: [], acceptanceExamples: [], interfaces: [], assumptions: [], scope: [] },
      configSnapshot: { ...project, contextBudget: budgets },
      context: { enabled: true, capturedAt: new Date(now).toISOString(), repoMap: { ...repoMap, paths: [] }, memory },
    } as unknown as Run;
    return { enabled: !!project.contextEnabled, defaults: DEFAULT_CONTEXT_BUDGET, selection: selectContext(draft, role), skipped };
  });

  app.post('/api/projects/:id/approve', async (request) => {
    const project = store.projects.get(idOf(request));
    if (!project) throw new HttpError(404, 'Project không tồn tại.');
    project.approved = true; project.version += 1;
    return store.projects.put(project);
  });

  // ---- runs
  // Polled every few seconds by the task list, so it serves summaries; the full run comes from /api/runs/:id.
  app.get('/api/runs', async () => store.runSummaries());
  app.post('/api/runs', async (request, reply) => reply.code(201).send(orchestrator.createRun(RunBody.parse(request.body))));
  app.get('/api/runs/:id', async (request) => orchestrator.detail(idOf(request)));
  // ---- trying a run's result by hand
  const previews = new PreviewManager();
  app.get('/api/system/previews', async () => previews.list());

  // ---- storage: working copies per run, and removing the ones nobody needs any more
  const storage = new StorageMonitor(dataDir, () => store.runs.list());
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

  /**
   * Deleting a run or a project removes its records at once; the working copies (which can hold node_modules) go in
   * the background. A copy that cannot be removed shows up under Hệ thống as left behind, to clean up there.
   */
  const disposeWorkspaces = (runs: Run[]) => {
    const workspaces = new GitWorkspaces(dataDir);
    for (const run of runs) previews.stop(run.id);
    void Promise.allSettled(runs.map((run) => workspaces.dispose(run))).then(() => storage.invalidate());
  };
  app.delete('/api/runs/:id', async (request) => {
    const run = orchestrator.deleteRun(idOf(request));
    disposeWorkspaces([run]);
    return { deleted: run.id };
  });
  app.delete('/api/projects/:id', async (request) => {
    const { project, runs } = orchestrator.deleteProject(idOf(request));
    disposeWorkspaces(runs);
    return { deleted: project.id, runs: runs.length };
  });
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
  app.post('/api/runs/:id/approve-contract', async (request) => orchestrator.approveContract(idOf(request)));
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

  // ---- human time
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

  app.get('/api/metrics', async () => {
    const runs = store.runs.list();
    // Spending that bought nothing new, per task, so modes can be compared on waste as well as cost.
    const waste = new Map<string, number>();
    for (const w of findWaste(runs, store.attempts.list(), 0, Date.now()).items) waste.set(w.runId, (waste.get(w.runId) ?? 0) + w.costUsd);
    return summarizeRuns(runs).map((row) => ({ ...row, wastePerRun: runs.filter((r) => r.initialMode === row.mode).reduce((s, r) => s + (waste.get(r.id) ?? 0), 0) / Math.max(1, row.runs) }));
  });
  app.get('/api/metrics/context', async () => summarizeContext(store.runs.list()));

  // ---- monitor: console log history, live stream, activity overview
  const LogFilter = z.object({
    after: z.coerce.number().int().min(0).optional(), run: z.string().max(60).optional(), source: z.string().max(60).optional(),
    level: z.enum(['debug', 'info', 'warn', 'error']).optional(), q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(2000).optional(),
  });
  const toQuery = (raw: unknown): LogQuery => {
    const f = LogFilter.parse(raw);
    return { after: f.after, runId: f.run, source: f.source, minLevel: f.level, q: f.q, limit: f.limit };
  };
  app.get('/api/logs', async (request) => store.logs.list(toQuery(request.query)));

  /**
   * Server-Sent Events. The client loads history from /api/logs, then connects here with `after` = its last id;
   * anything written in between is replayed from the database, so no line is missed or duplicated.
   */
  app.get('/api/logs/stream', (request, reply) => {
    const q = toQuery(request.query);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
    let last = q.after ?? store.logs.list({ limit: 1 }).at(-1)?.id ?? 0;
    const send = (e: LogEntry) => {
      if (e.id <= last) return;
      last = e.id;
      if (matchesLog(e, q)) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    for (const e of store.logs.list({ ...q, after: last, limit: 2000 })) send(e);
    const unsubscribe = store.logs.subscribe(send);
    const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => { clearInterval(beat); unsubscribe(); });
  });

  app.get('/api/monitor', async (request) => {
    const { period } = z.object({ period: z.enum(PERIODS).default('today') }).parse(request.query);
    const now = Date.now();
    const recentLogs = store.logs.list({ limit: 200 }).filter((e) => now - Date.parse(e.ts) < 15_000);
    const attempts = store.attempts.list();
    const runs = store.runs.list();
    const lastLogByRun: Record<string, string> = {};
    for (const r of runs.filter((x) => x.status === 'running' || x.status === 'queued')) {
      const line = store.logs.list({ runId: r.id, limit: 1, minLevel: 'info' }).at(-1);
      if (line) lastLogByRun[r.id] = line.message.slice(0, 240);
    }
    const alerts: { level: 'warn' | 'error'; text: string }[] = [];
    const disk = await diskSpace(dataDir);
    if (disk && disk.level !== 'ok') alerts.push({ level: disk.level === 'critical' ? 'error' : 'warn', text: `Ổ ${disk.path} chỉ còn ${(disk.freeBytes / 1024 ** 3).toFixed(1)} GB trống. Khi hết chỗ, npm, test và Codex sẽ lỗi; dọn bản sao làm việc ở tab Hệ thống.` });
    const provider = runs.filter((r) => r.status === 'blocked' && /quá tải|quota/i.test(r.blocker ?? ''));
    if (provider.length) alerts.push({ level: 'warn', text: `${provider.length} task bị chặn vì provider quá tải hoặc hết quota. Đợi vài phút rồi bấm Chạy tiếp.` });
    return buildMonitor({
      runs, attempts, now, period, projects: store.projects.list(), lastLogByRun, alerts,
      errorsLastHour: store.logs.countSince(new Date(now - 3_600_000).toISOString(), 'error'),
      activity: {
        providers: [...new Set(attempts.filter((a) => a.status === 'running').map((a) => a.provider))],
        stages: { setup: recentLogs.some((e) => e.source === 'setup'), check: recentLogs.some((e) => e.source.startsWith('check:')) },
      },
    });
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

  if (staticDir && existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler((request, reply) => (request.method === 'GET' && !request.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'not_found' })));
  }
  return app;
}
