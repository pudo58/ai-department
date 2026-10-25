import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { estimateCost } from '../src/core/budget.js';
import { pipelineStep } from '../src/client/labels.js';
import type { Run, RunSummary, UsageRecord } from '../src/shared/types.js';
import { green, setup } from './helpers.js';

const PORT = 4310;
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function boot() {
  const env = setup({ check: () => green });
  env.store.projects.list().forEach((p) => env.store.projects.delete(p.id));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-'));
  app = await buildApp({ ...env, dataDir, port: PORT });
  const host = { host: `127.0.0.1:${PORT}` };
  const session = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json<{ token: string }>();
  const post = (url: string, payload: unknown, extra: Record<string, string> = {}) =>
    app!.inject({ method: 'POST', url, payload: payload as object, headers: { ...host, 'x-csrf-token': session.token, ...extra } });
  return { ...env, dataDir, host, token: session.token, post };
}

const repo = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidept-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(path.join(dir, 'a.txt'), 'x');
  return dir;
};
const roles = Object.fromEntries(['planner', 'author', 'developer', 'verifier', 'investigator'].map((r) => [r, { provider: 'codex', model: '', effort: 'medium', skills: [] }]));
const projectBody = (repository: string) => ({
  name: 'Demo', repository, modules: ['src'], checks: [{ id: 'test', command: ['npm', 'test'], reportPath: '.aidept-report.json' }],
  singleBudgetUsd: 5, roles, runnerImage: 'node:24-bookworm-slim',
});

describe('loopback protections', () => {
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const { host: _h } = await boot();
    const res = await app!.inject({ method: 'GET', url: '/api/projects', headers: { host: 'evil.example.com' } });
    expect(res.statusCode).toBe(403);
  });
  it('rejects writes without the CSRF token or with a foreign Origin', async () => {
    const { host, token, post } = await boot();
    expect((await app!.inject({ method: 'POST', url: '/api/runs', payload: {}, headers: host })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'POST', url: '/api/runs', payload: {}, headers: { ...host, 'x-csrf-token': 'wrong' } })).statusCode).toBe(403);
    expect((await post('/api/runs', {}, { origin: 'http://evil.example.com' })).statusCode).toBe(403);
    expect((await post('/api/runs', {}, { origin: `http://127.0.0.1:${PORT}` })).statusCode).toBe(400);
    expect(token).toHaveLength(48);
  });
  it('sends hardening headers', async () => {
    const { host } = await boot();
    const res = await app!.inject({ method: 'GET', url: '/api/session', headers: host });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    // The bundled fonts and the select arrow are data: URIs; without these directives the browser blocks them.
    expect(res.headers['content-security-policy']).toMatch(/font-src 'self' data:.*img-src 'self' data:/);
  });
});

describe('API flow', () => {
  it('creates a project from a real git repo, rejects a non-repo, and runs a task end to end', async () => {
    const { post, host } = await boot();
    expect((await post('/api/projects', projectBody(path.join(tmpdir(), 'aidept-no-such-folder-xyz')))).statusCode).toBe(400);
    expect((await post('/api/projects', projectBody(path.parse(tmpdir()).root))).statusCode).toBe(400); // drive root is too broad
    expect((await post('/api/projects', projectBody(mkdtempSync(path.join(tmpdir(), 'aidept-plain-'))))).statusCode).toBe(201); // git is optional
    const created = await post('/api/projects', projectBody(repo()));
    expect(created.statusCode).toBe(201);
    const project = created.json<{ id: string; approved: boolean; protectedPaths: string[] }>();
    expect(project.approved).toBe(false);
    expect(project.protectedPaths).toContain('package.json');

    // Live providers are refused until the policy is approved; simulation is always allowed.
    const body = { projectId: project.id, title: 'Task', originalRequirement: 'Làm điều đó', budgetUsd: 5 };
    expect((await post('/api/runs', { ...body, provider: 'codex' })).statusCode).toBe(409);
    expect((await post(`/api/projects/${project.id}/approve`, {})).json<{ approved: boolean }>().approved).toBe(true);

    const run = (await post('/api/runs', { ...body, provider: 'codex', signals: ['concurrency'] })).json<{ id: string; recommendation: { mode: string } }>();
    expect(run.recommendation.mode).toBe('verify');
    await post(`/api/runs/${run.id}/start`, {});
    const detail = (await app!.inject({ method: 'GET', url: `/api/runs/${run.id}`, headers: host })).json<{ run: { status: string }; completion: object }>();
    expect(['queued', 'running', 'awaiting_approval']).toContain(detail.run.status);
    expect((await post(`/api/runs/${run.id}/accept`, {})).statusCode).toBe(409);
    expect((await app!.inject({ method: 'GET', url: '/api/runs/nope', headers: host })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'GET', url: '/api/metrics', headers: host })).json<unknown[]>().length).toBeGreaterThan(0);
  });
  it('validates input instead of trusting it', async () => {
    const { post } = await boot();
    const res = await post('/api/projects', { name: '', repository: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/name/);
  });
});

describe('task list', () => {
  it('serves summaries with costs priced on the server instead of whole runs', async () => {
    const { post, host, store } = await boot();
    const project = (await post('/api/projects', projectBody(repo()))).json<{ id: string }>();
    const [first, second] = await Promise.all(['Một', 'Hai'].map(async (title) => (await post('/api/runs', { projectId: project.id, title, originalRequirement: 'x', provider: 'fake', budgetUsd: 5 })).json<Run>()));
    const day = 86_400_000;
    const usage = (id: string, costUsd: number | null, ageMs: number): UsageRecord => ({ id, attemptId: 'att', inputTokens: 10_000, cachedTokens: 4_000, outputTokens: 2_000, costUsd, source: costUsd === null ? 'estimated' : 'reported', createdAt: new Date(Date.now() - ageMs).toISOString() });
    const full = store.runs.get(second!.id)!;
    full.usage = [usage('u1', 0.5, day), usage('u2', 2, 40 * day), usage('u3', null, 2 * day)];
    full.configSnapshot.roles.developer.model = 'gpt-5-codex';
    Object.assign(full, { status: 'blocked', stage: 'implement', blocker: 'Cần chú ý: thiếu quyền.', contract: { ...full.contract, approvedHash: 'h1' } });
    store.runs.put(full);

    const res = await app!.inject({ method: 'GET', url: '/api/runs', headers: host });
    const list = res.json<RunSummary[]>();
    expect(list.map((r) => r.id)).toEqual([first!.id, second!.id]); // oldest first, as before
    const summary = list[1]!;
    expect(Object.keys(summary).sort()).toEqual(['blocker', 'budgetUsd', 'contractApproved', 'costUsd', 'createdAt', 'deliveryStatus', 'developer', 'id', 'mode', 'monthCostUsd', 'projectId', 'provider', 'stage', 'status', 'title', 'updatedAt']);
    expect(summary.deliveryStatus).toBe('unconfirmed');
    expect(summary).toMatchObject({ projectId: project.id, title: 'Hai', status: 'blocked', mode: full.mode, provider: 'fake', stage: 'implement', contractApproved: true, budgetUsd: 5, blocker: 'Cần chú ý: thiếu quyền.', createdAt: full.createdAt, updatedAt: full.updatedAt, developer: { provider: 'codex', model: 'gpt-5-codex' } });
    const estimated = estimateCost({ inputTokens: 10_000, cachedTokens: 4_000, outputTokens: 2_000 });
    expect(summary.costUsd).toBeCloseTo(2.5 + estimated, 10);
    expect(summary.monthCostUsd).toBeCloseTo(0.5 + estimated, 10); // the 40-day-old record is left out
    expect(pipelineStep(summary)).toEqual(pipelineStep({ ...full, contractApproved: !!full.contract.approvedHash }));
    expect(list[0]).toMatchObject({ status: 'draft', contractApproved: false, costUsd: 0, monthCostUsd: 0, blocker: null });
    expect(res.body.length * 4).toBeLessThan(JSON.stringify(store.runs.list()).length);
  });
});

describe('editing a project', () => {
  it('changes check/modules/setup, raises the policy version and demands re-approval, and validates input', async () => {
    const { post, host, token } = await boot();
    const created = (await post('/api/projects', projectBody(repo()))).json<{ id: string; version: number }>();
    await post(`/api/projects/${created.id}/approve`, {});
    const patch = (body: unknown) => app!.inject({ method: 'PATCH', url: `/api/projects/${created.id}`, payload: body as object, headers: { ...host, 'x-csrf-token': token } });

    const noop = (await patch({})).json<{ version: number; approved: boolean }>();
    expect(noop).toMatchObject({ version: 2, approved: true }); // approval raised v1 -> v2; an empty patch changes nothing

    const edited = (await patch({
      modules: ['src', 'worker'], setupCommand: ['npm', 'ci'],
      checks: [{ id: 'test', command: ['node', '--test', '--test-reporter=junit'], reportPath: '.aidept-report.xml' }],
    })).json<{ version: number; approved: boolean; modules: string[]; checks: { command: string[]; reportPath: string }[]; setupCommand: string[] }>();
    expect(edited).toMatchObject({ version: 3, approved: false, modules: ['src', 'worker'], setupCommand: ['npm', 'ci'] });
    expect(edited.checks[0]).toMatchObject({ command: ['node', '--test', '--test-reporter=junit'], reportPath: '.aidept-report.xml' });

    // Same values again are not a change, so approval is not thrown away for nothing.
    await post(`/api/projects/${created.id}/approve`, {});
    const same = (await patch({ modules: ['src', 'worker'] })).json<{ version: number; approved: boolean }>();
    expect(same).toMatchObject({ version: 4, approved: true });

    expect((await patch({ checks: [{ id: 'bad id!', command: ['x'] }] })).statusCode).toBe(400);
    expect((await patch({ modules: [] })).statusCode).toBe(400);
    expect((await patch({ repository: '/somewhere/else' })).statusCode).toBe(200); // unknown/immutable fields are ignored, never applied
    const after = (await app!.inject({ method: 'GET', url: '/api/projects', headers: host })).json<{ id: string; repository: string }[]>().find((p) => p.id === created.id)!;
    expect(after.repository).not.toBe('/somewhere/else');
    expect((await app!.inject({ method: 'PATCH', url: '/api/projects/nope', payload: {}, headers: { ...host, 'x-csrf-token': token } })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'PATCH', url: `/api/projects/${created.id}`, payload: {}, headers: host })).statusCode).toBe(403); // no CSRF token
  });
});

describe('project guidance and stack detection', () => {
  it('stores guidance on create, edits it through PATCH, caps it, treats a repeat as no change, and rejects duplicate check ids', async () => {
    const { post, host, token } = await boot();
    const created = (await post('/api/projects', { ...projectBody(repo()), guidance: '  Dùng vitest.  ' })).json<{ id: string; version: number; guidance: string }>();
    expect(created.guidance).toBe('Dùng vitest.');
    const patch = (body: unknown) => app!.inject({ method: 'PATCH', url: `/api/projects/${created.id}`, payload: body as object, headers: { ...host, 'x-csrf-token': token } });

    expect((await patch({ guidance: 'Dùng vitest.' })).json<{ version: number }>().version).toBe(1); // unchanged -> no version bump
    const edited = (await patch({ guidance: 'Stack: Fastify.\nTránh thêm dependency.' })).json<{ version: number; approved: boolean; guidance: string }>();
    expect(edited).toMatchObject({ version: 2, approved: false, guidance: 'Stack: Fastify.\nTránh thêm dependency.' });
    expect((await patch({ guidance: 'x'.repeat(4001) })).statusCode).toBe(400);
    expect((await patch({ guidance: '' })).json<{ guidance: string }>().guidance).toBe('');
    expect((await patch({ modules: ['src', 'lib'] })).json<{ guidance: string }>().guidance).toBe(''); // other edits never reset it

    const dup = [{ id: 'a', command: ['x'] }, { id: 'a', command: ['y'] }];
    expect((await patch({ checks: dup })).statusCode).toBe(400);
    const multi = (await patch({ checks: [{ id: 'test', command: ['npm', 'test'], reportPath: '.r.json' }, { id: 'typecheck', command: ['npx', 'tsc', '--noEmit'], required: false, timeoutMs: 30000 }] })).json<{ checks: { id: string; required: boolean; reportPath?: string }[] }>();
    expect(multi.checks.map((c) => c.id)).toEqual(['test', 'typecheck']);
    expect(multi.checks[1]).toMatchObject({ required: false });
    expect(multi.checks[1]!.reportPath).toBeUndefined();
  });

  it('/api/projects/detect reads a repository without storing anything, and refuses non-repos and unknown projects', async () => {
    const { post, store } = await boot();
    const dir = repo();
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' }, devDependencies: { vitest: '3', typescript: '5' } }));
    writeFileSync(path.join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }');
    const before = store.projects.list().length;
    const res = await post('/api/projects/detect', { repository: dir });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ testRunner: string; checks: { id: string }[]; guidance: string }>();
    expect(body.testRunner).toBe('Vitest');
    expect(body.checks.map((c) => c.id)).toEqual(['test', 'typecheck']);
    expect(body.guidance).toContain('Vitest');
    expect(store.projects.list()).toHaveLength(before);

    const created = (await post('/api/projects', projectBody(dir))).json<{ id: string }>();
    expect((await post('/api/projects/detect', { projectId: created.id })).json<{ testRunner: string }>().testRunner).toBe('Vitest');
    expect((await post('/api/projects/detect', { projectId: 'nope' })).statusCode).toBe(404);
    expect((await post('/api/projects/detect', { repository: path.join(tmpdir(), 'aidept-no-such-folder-xyz') })).statusCode).toBe(400);
    expect((await post('/api/projects/detect', {})).statusCode).toBe(400);
    expect((await app!.inject({ method: 'POST', url: '/api/projects/detect', payload: { repository: dir }, headers: { host: `127.0.0.1:${PORT}` } })).statusCode).toBe(403); // CSRF applies
  });
});

describe('execution mode of an existing project', () => {
  it('can be switched from docker to local through PATCH, which needs re-approval', async () => {
    const { post, host, token, store } = await boot();
    const created = (await post('/api/projects', { ...projectBody(repo()), executionMode: 'docker' })).json<{ id: string; executionMode: string }>();
    expect(created.executionMode).toBe('docker');
    await post(`/api/projects/${created.id}/approve`, {});
    const res = await app!.inject({ method: 'PATCH', url: `/api/projects/${created.id}`, payload: { executionMode: 'local' }, headers: { ...host, 'x-csrf-token': token } });
    expect(res.json<{ executionMode: string; approved: boolean }>()).toMatchObject({ executionMode: 'local', approved: false });
    expect(store.projects.get(created.id)!.executionMode).toBe('local');
  });
});

describe('project memory and context API', () => {
  it('adds, edits, archives and deletes memory, enforces limits and CSRF, and previews what a role would receive', async () => {
    const { post, host, token } = await boot();
    const dir = repo();
    mkdirSync(path.join(dir, 'worker'));
    writeFileSync(path.join(dir, 'worker', 'crawler.ts'), '');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'next build' } }));
    const project = (await post('/api/projects', projectBody(dir))).json<{ id: string; contextEnabled: boolean }>();
    expect(project.contextEnabled).toBe(false);
    const send = (method: 'PATCH' | 'DELETE' | 'GET', url: string, payload?: unknown) => app!.inject({ method, url, ...(payload ? { payload: payload as object } : {}), headers: { ...host, 'x-csrf-token': token } });

    const created = await post(`/api/projects/${project.id}/memory`, { kind: 'architecture', text: 'Code crawler nằm ở worker/', paths: ['worker'] });
    expect(created.statusCode).toBe(201);
    const item = created.json<{ id: string; status: string; source: { type: string } }>();
    expect(item).toMatchObject({ status: 'active', source: { type: 'human' } });
    expect((await post(`/api/projects/${project.id}/memory`, { kind: 'command', text: 'chạy npm run lint' })).statusCode).toBe(201);
    expect((await post(`/api/projects/${project.id}/memory`, { kind: 'nope', text: 'xxx' })).statusCode).toBe(400);
    expect((await post(`/api/projects/${project.id}/memory`, { kind: 'pitfall', text: 'x'.repeat(501) })).statusCode).toBe(400);
    expect((await post(`/api/projects/${project.id}/memory`, { kind: 'pitfall', text: 'abc', paths: ['../etc'] })).statusCode).toBe(400);
    expect((await post(`/api/projects/nope/memory`, { kind: 'pitfall', text: 'abc' })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'POST', url: `/api/projects/${project.id}/memory`, payload: { kind: 'pitfall', text: 'abc' }, headers: host })).statusCode).toBe(403);

    const preview = (await send('GET', `/api/projects/${project.id}/context?role=developer`)).json<{ enabled: boolean; selection: { sections: { name: string; included: boolean }[]; memoryIds: string[] }; skipped: { id: string; reason: string }[] }>();
    expect(preview.enabled).toBe(false); // preview works before enabling
    expect(preview.selection.memoryIds).toEqual([item.id]);
    expect(preview.skipped.map((s) => s.reason).join()).toMatch(/lint/); // npm run lint does not exist
    expect(preview.selection.sections.some((s) => s.name.startsWith('Bản đồ repo') && s.included)).toBe(true);
    const zero = (await send('GET', `/api/projects/${project.id}/context?role=developer&budget=0`)).json<{ selection: { sections: { included: boolean }[] } }>();
    expect(zero.selection.sections.every((s) => !s.included)).toBe(true);
    expect((await send('GET', `/api/projects/${project.id}/repomap`)).json<{ tree: string }>().tree).toContain('worker/');

    const edited = (await send('PATCH', `/api/projects/${project.id}/memory/${item.id}`, { text: 'Code crawler nằm ở worker/ (đã xác nhận)', pinned: true })).json<{ text: string; pinned: boolean; history: unknown[] }>();
    expect(edited).toMatchObject({ pinned: true });
    expect(edited.history).toHaveLength(2);
    expect((await send('PATCH', `/api/projects/${project.id}/memory/${item.id}`, { status: 'archived' })).json<{ status: string }>().status).toBe('archived');
    expect((await send('PATCH', `/api/projects/${project.id}/memory/mem_nope`, { pinned: true })).statusCode).toBe(404);
    expect((await send('DELETE', `/api/projects/${project.id}/memory/${item.id}`)).statusCode).toBe(200);
    expect((await send('GET', `/api/projects/${project.id}/memory`)).json<unknown[]>()).toHaveLength(1);

    // Turning context on is a policy change like any other.
    await post(`/api/projects/${project.id}/approve`, {});
    const on = (await send('PATCH', `/api/projects/${project.id}`, { contextEnabled: true, contextBudget: { developer: 2000, verifier: 0 } })).json<{ contextEnabled: boolean; approved: boolean; contextBudget: Record<string, number> }>();
    expect(on).toMatchObject({ contextEnabled: true, approved: false, contextBudget: { developer: 2000, verifier: 0 } });
    expect((await send('PATCH', `/api/projects/${project.id}`, { contextBudget: { developer: 99999 } })).statusCode).toBe(400);
  });

  it('caps active memory at 50 per project', async () => {
    const { post } = await boot();
    const project = (await post('/api/projects', projectBody(repo()))).json<{ id: string }>();
    for (let i = 0; i < 50; i++) expect((await post(`/api/projects/${project.id}/memory`, { kind: 'pitfall', text: `mục số ${i}` })).statusCode).toBe(201);
    expect((await post(`/api/projects/${project.id}/memory`, { kind: 'pitfall', text: 'mục 51' })).statusCode).toBe(409);
  });
});

describe('trying a run by hand', () => {
  it('refuses to preview a run without real code, and stores the project preview command', async () => {
    const { post, host, token } = await boot();
    const created = (await post('/api/projects', { ...projectBody(repo()), previewCommand: ['node', 'server.mjs'] })).json<{ id: string; previewCommand: string[] }>();
    expect(created.previewCommand).toEqual(['node', 'server.mjs']);
    expect((await app!.inject({ method: 'PATCH', url: `/api/projects/${created.id}`, payload: { previewCommand: 'npm run dev' }, headers: { ...host, 'x-csrf-token': token } })).statusCode).toBe(400);
    const run = (await post('/api/runs', { projectId: created.id, title: 'Thử', originalRequirement: 'x', provider: 'fake', budgetUsd: 5 })).json<{ id: string }>();
    expect((await post(`/api/runs/${run.id}/preview/start`, {})).statusCode).toBe(409); // a simulation has no code to run
    expect((await post(`/api/runs/nope/preview/start`, {})).statusCode).toBe(404);
    expect((await app!.inject({ method: 'GET', url: `/api/runs/${run.id}/preview`, headers: host })).json()).toEqual({ preview: null });
    expect((await post(`/api/runs/${run.id}/preview/stop`, {})).json()).toEqual({ stopped: false });
  });
});

describe('folder picker', () => {
  it('lists sub-folder names only, marks git and Node projects, skips dot folders and node_modules, and refuses a missing folder', async () => {
    const { host } = await boot();
    const root = mkdtempSync(path.join(tmpdir(), 'aidept-pick-'));
    for (const d of ['b-app/.git', 'a-lib', '.hidden', 'node_modules/x', 'c-plain']) mkdirSync(path.join(root, d), { recursive: true });
    writeFileSync(path.join(root, 'a-lib', 'package.json'), '{}');
    writeFileSync(path.join(root, 'notes.txt'), 'x');
    const get = (q: string) => app!.inject({ method: 'GET', url: `/api/system/folders${q}`, headers: host });
    const listing = (await get(`?path=${encodeURIComponent(root)}`)).json<{ path: string; parent: string; folders: { name: string; git: boolean; node: boolean }[]; places: { path: string }[] }>();
    expect(listing.path).toBe(path.resolve(root));
    expect(listing.parent).toBe(path.dirname(path.resolve(root)));
    expect(listing.folders).toEqual([
      expect.objectContaining({ name: 'a-lib', git: false, node: true }),
      expect.objectContaining({ name: 'b-app', git: true, node: false }),
      expect.objectContaining({ name: 'c-plain', git: false, node: false }),
    ]);
    expect(listing.places.length).toBeGreaterThan(0);
    expect((await get('')).statusCode).toBe(200); // home folder by default
    const missing = await get(`?path=${encodeURIComponent(path.join(root, 'nope'))}`);
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ message: string }>().message).toMatch(/Không mở được/);
  });
});

describe('deleting runs and projects', () => {
  it('deletes a waiting run with its records, refuses one that is working, and needs the CSRF token', async () => {
    const { post, host, token, store } = await boot();
    const del = (url: string, headers: Record<string, string> = { ...host, 'x-csrf-token': token }) => app!.inject({ method: 'DELETE', url, headers });
    const project = (await post('/api/projects', projectBody(repo()))).json<{ id: string }>();
    const run = (await post('/api/runs', { projectId: project.id, title: 'Xoá', originalRequirement: 'x', provider: 'fake', budgetUsd: 5 })).json<{ id: string }>();
    const keep = (await post('/api/runs', { projectId: project.id, title: 'Giữ', originalRequirement: 'y', provider: 'fake', budgetUsd: 5 })).json<{ id: string }>();
    store.addEvent(run.id, 'note', 'một dòng');

    store.runs.put({ ...store.runs.get(run.id)!, status: 'queued' });
    expect((await del(`/api/runs/${run.id}`)).statusCode).toBe(409);
    store.runs.put({ ...store.runs.get(run.id)!, status: 'paused' });
    expect((await del(`/api/runs/${run.id}`, host)).statusCode).toBe(403);

    expect((await del(`/api/runs/${run.id}`)).json()).toEqual({ deleted: run.id });
    expect(store.runs.get(run.id)).toBeUndefined();
    expect(store.events(run.id)).toHaveLength(0);
    expect(store.logs.list({ runId: run.id })).toHaveLength(0);
    expect(store.runs.get(keep.id)).toBeDefined();
    expect(store.events(keep.id).length).toBeGreaterThan(0);
    expect((await del(`/api/runs/${run.id}`)).statusCode).toBe(404);
  });

  it('deletes a project with its runs, memory and working copies, but never its folder', async () => {
    const { post, host, token, store, dataDir } = await boot();
    const del = (url: string) => app!.inject({ method: 'DELETE', url, headers: { ...host, 'x-csrf-token': token } });
    const folder = repo();
    const project = (await post('/api/projects', projectBody(folder))).json<{ id: string }>();
    const other = (await post('/api/projects', projectBody(repo()))).json<{ id: string }>();
    const runs = await Promise.all(['Một', 'Hai'].map(async (title) => (await post('/api/runs', { projectId: project.id, title, originalRequirement: 'x', provider: 'fake', budgetUsd: 5 })).json<{ id: string }>()));
    const otherRun = (await post('/api/runs', { projectId: other.id, title: 'Khác', originalRequirement: 'x', provider: 'fake', budgetUsd: 5 })).json<{ id: string }>();
    await post(`/api/projects/${project.id}/memory`, { kind: 'pitfall', text: 'ghi nhớ một điều' });
    const workspace = path.join(dataDir, 'workspaces', `${runs[0]!.id}-A`);
    mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    writeFileSync(path.join(workspace, 'node_modules', 'x.js'), '1');

    store.runs.put({ ...store.runs.get(runs[1]!.id)!, status: 'running' });
    expect((await del(`/api/projects/${project.id}`)).statusCode).toBe(409);
    expect(store.projects.get(project.id)).toBeDefined();
    store.runs.put({ ...store.runs.get(runs[1]!.id)!, status: 'paused' });

    expect((await del(`/api/projects/${project.id}`)).json()).toEqual({ deleted: project.id, runs: 2 });
    expect(store.projects.get(project.id)).toBeUndefined();
    expect(store.runs.list(project.id)).toHaveLength(0);
    expect(store.memories.list(project.id)).toHaveLength(0);
    expect(existsSync(path.join(folder, 'a.txt'))).toBe(true);
    await vi.waitFor(() => expect(existsSync(workspace)).toBe(false));
    expect(store.projects.get(other.id)).toBeDefined();
    expect(store.runs.get(otherRun.id)).toBeDefined();
    expect((await del(`/api/projects/${project.id}`)).statusCode).toBe(404);
  });
});
