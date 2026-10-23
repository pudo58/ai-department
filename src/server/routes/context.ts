import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Run } from '../../shared/types.js';
import { GitWorkspaces } from '../../runtime/gitworkspace.js';
import { SkillLibrary } from '../../runtime/skilllibrary.js';
import { HttpError, type Orchestrator } from '../orchestrator.js';
import { PreviewManager } from '../preview.js';
import { StorageMonitor } from '../storage.js';
import type { Store } from '../store.js';

/** What every route module needs: the app, the data it serves, and the few helpers more than one module uses. */
export interface RouteContext {
  app: FastifyInstance;
  store: Store;
  orchestrator: Orchestrator;
  dataDir: string;
  previews: PreviewManager;
  storage: StorageMonitor;
  skills: SkillLibrary;
  idOf: (request: { params: unknown }) => string;
  projectOf: (request: { params: unknown }) => ReturnType<Store['projects']['get']> & object;
  assertProjectDir: (repository: string) => Promise<void>;
  disposeWorkspaces: (runs: Run[]) => void;
}

export function createRouteContext(app: FastifyInstance, store: Store, orchestrator: Orchestrator, dataDir: string, skills = new SkillLibrary(dataDir, store.skills)): RouteContext {
  const previews = new PreviewManager();
  const storage = new StorageMonitor(dataDir, () => store.runs.list());
  const idOf = (request: { params: unknown }) => (request.params as { id: string }).id;
  const projectOf = (request: { params: unknown }) => {
    const project = store.projects.get(idOf(request));
    if (!project) throw new HttpError(404, 'Project không tồn tại.');
    return project;
  };
  /** A project is any existing folder: git is optional. The filesystem root and the home folder are refused as too broad. */
  const assertProjectDir = async (repository: string) => {
    const info = await stat(repository).catch(() => undefined);
    if (!info?.isDirectory()) throw new HttpError(400, 'Đường dẫn không phải thư mục tồn tại.');
    if (path.parse(repository).root === repository || repository === path.resolve(homedir())) throw new HttpError(400, 'Thư mục quá rộng (ổ đĩa gốc hoặc thư mục home); hãy chọn thư mục của project.');
  };
  /**
   * Deleting a run or a project removes its records at once; the working copies (which can hold node_modules) go in
   * the background. A copy that cannot be removed shows up under Hệ thống as left behind, to clean up there.
   */
  const disposeWorkspaces = (runs: Run[]) => {
    const workspaces = new GitWorkspaces(dataDir);
    for (const run of runs) previews.stop(run.id);
    void Promise.allSettled(runs.map((run) => workspaces.dispose(run))).then(() => storage.invalidate());
  };
  return { app, store, orchestrator, dataDir, previews, storage, skills, idOf, projectOf, assertProjectDir, disposeWorkspaces };
}
