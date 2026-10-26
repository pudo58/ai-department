import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_CONTEXT_BUDGET, selectContext } from '../../core/context.js';
import { MEMORY_MAX_ACTIVE, MEMORY_MAX_TOTAL, newMemoryItem, staleReason, updateMemoryItem } from '../../core/memory.js';
import { buildRepoMap } from '../../core/repomap.js';
import type { ContextRole, Run } from '../../shared/types.js';
import { HttpError } from '../orchestrator.js';
import { MemoryBody } from './schemas.js';
import type { RouteContext } from './context.js';

/** Project context: approved memory, the repo map and a preview of what each role would receive. */
export function registerMemoryRoutes({ app, store, projectOf, assertProjectDir }: RouteContext): void {
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
}
