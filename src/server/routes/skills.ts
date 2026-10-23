import path from 'node:path';
import { z } from 'zod';
import type { Role, RoleConfig, SkillCandidate } from '../../shared/types.js';
import type { SkillBundle } from '../../runtime/skilllibrary.js';
import { HttpError } from '../orchestrator.js';
import type { RouteContext } from './context.js';

const Name = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) });
/** `preview` lists what a source holds without installing; `pick` chooses which of several skills to install. */
const Choice = { preview: z.boolean().default(false), pick: z.array(z.string().max(64)).max(50).optional() };

/** Library skills: list, inspect, install from this machine / a .zip / GitHub, approve, disable, remove. */
export function registerSkillRoutes({ app, store, skills }: RouteContext): void {
  /** Where a skill is assigned, so a person sees what removing or disabling it affects. */
  const usedBy = (name: string) => store.projects.list().flatMap((p) => (Object.entries(p.roles) as [Role, RoleConfig][])
    .filter(([, c]) => (c.skills ?? []).includes(name)).map(([role]) => ({ projectId: p.id, project: p.name, role })));

  /** Library errors are the person's to fix (a bad SKILL.md, a too-large zip), so they come back as 400 with the reason. */
  const attempt = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try { return await fn(); } catch (error) { throw error instanceof HttpError ? error : new HttpError(400, (error as Error).message); }
  };

  const installAll = async (bundles: SkillBundle[], source: (b: SkillBundle) => Parameters<typeof skills.install>[1], body: { preview: boolean; pick?: string[] }): Promise<{ candidates: SkillCandidate[] } | { installed: string[] }> => {
    const candidates = skills.preview(bundles);
    if (body.preview) return { candidates };
    const chosen = bundles.filter((_, i) => (body.pick ? body.pick.includes(candidates[i]!.name) : bundles.length === 1));
    if (!chosen.length) throw new HttpError(400, bundles.length > 1 ? 'Nguồn này có nhiều skill; hãy chọn skill cần cài.' : 'Không có skill nào được chọn.');
    const installed: string[] = [];
    for (const b of chosen) installed.push((await skills.install(b, source(b))).name);
    return { installed };
  };

  app.get('/api/skills', async () => skills.list().map((s) => ({ ...s, usedBy: usedBy(s.name) })));
  app.get('/api/skills/local', async (request) => {
    const { path: extra } = z.object({ path: z.string().max(1000).optional() }).parse(request.query);
    return attempt(() => skills.discoverLocal(extra ? path.resolve(extra) : undefined));
  });
  app.get('/api/skills/:name', async (request) => {
    const { name } = Name.parse(request.params);
    const skill = skills.get(name);
    if (!skill) throw new HttpError(404, 'Skill không tồn tại.');
    return { skill, skillMd: await skills.readSkillMd(name).catch(() => ''), usedBy: usedBy(name) };
  });

  app.post('/api/skills/import', async (request) => {
    const body = z.object({ path: z.string().trim().min(1).max(1000), ...Choice }).parse(request.body);
    const dir = path.resolve(body.path);
    return attempt(async () => installAll([await skills.readFolder(dir)], () => ({ type: 'local', path: dir }), body));
  });
  app.post('/api/skills/upload', { bodyLimit: 30 * 1024 * 1024 }, async (request) => {
    const body = z.object({ fileName: z.string().trim().min(1).max(200), dataBase64: z.string().min(1).max(30 * 1024 * 1024), ...Choice }).parse(request.body);
    if (/\.rar$/i.test(body.fileName)) throw new HttpError(400, 'File .rar không được hỗ trợ; hãy nén lại thành .zip.');
    return attempt(() => installAll(skills.fromZip(Buffer.from(body.dataBase64, 'base64'), body.fileName), () => ({ type: 'zip', path: body.fileName }), body));
  });
  app.post('/api/skills/github', async (request) => {
    const body = z.object({ url: z.string().trim().min(1).max(500), ...Choice }).parse(request.body);
    return attempt(async () => installAll(await skills.fromGitHub(body.url), () => ({ type: 'github', url: body.url }), body));
  });

  app.post('/api/skills/:name/approve', async (request) => attempt(() => skills.setStatus(Name.parse(request.params).name, 'active')));
  app.patch('/api/skills/:name', async (request) => {
    const { status } = z.object({ status: z.enum(['active', 'disabled']) }).parse(request.body);
    return attempt(() => skills.setStatus(Name.parse(request.params).name, status));
  });
  app.delete('/api/skills/:name', async (request) => {
    const { name } = Name.parse(request.params);
    if (!skills.get(name)) throw new HttpError(404, 'Skill không tồn tại.');
    const users = usedBy(name);
    if (users.length) throw new HttpError(409, `Skill đang được gán cho ${users.map((u) => `${u.project} (${u.role})`).join(', ')}; bỏ gán trong Sửa project trước khi xoá.`);
    await skills.remove(name);
    return { deleted: name };
  });
}
