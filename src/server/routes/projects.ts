import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectProfile } from '../../shared/types.js';
import { DEFAULT_PROTECTED } from '../../core/scope.js';
import { detectStack } from '../../core/stackdetect.js';
import { hostNodeVersion } from '../../runtime/nodever.js';
import { HttpError } from '../orchestrator.js';
import { ProjectBody } from './schemas.js';
import type { RouteContext } from './context.js';

/** Projects: list, create, edit, approve, delete, and the read-only stack detection used by the forms. */
export function registerProjectRoutes({ app, store, orchestrator, idOf, assertProjectDir, disposeWorkspaces }: RouteContext): void {
  app.get('/api/projects', async () => store.projects.list());
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
    return detectStack(repository, await hostNodeVersion());
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
  app.post('/api/projects/:id/approve', async (request) => {
    const project = store.projects.get(idOf(request));
    if (!project) throw new HttpError(404, 'Project không tồn tại.');
    project.approved = true; project.version += 1;
    return store.projects.put(project);
  });
  app.delete('/api/projects/:id', async (request) => {
    const { project, runs } = orchestrator.deleteProject(idOf(request));
    disposeWorkspaces(runs);
    return { deleted: project.id, runs: runs.length };
  });
}
