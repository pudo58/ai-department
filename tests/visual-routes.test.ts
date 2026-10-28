import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/server/app.js';
import { FigmaService } from '../src/server/figma/service.js';
import { VisualChecks } from '../src/server/visual.js';
import { setupLegacy, green } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance | undefined, dir = '';
afterEach(async () => { await app?.close(); app = undefined; vi.restoreAllMocks(); if (dir) rmSync(dir, { recursive: true, force: true }); });
const HOST = '127.0.0.1:14309';
async function fixture() {
  dir = mkdtempSync(path.join(tmpdir(), 'aidept-visual-api-'));
  const e = setupLegacy({ check: () => green }), run = e.create();
  run.status = 'awaiting_acceptance'; run.checkpoint = 'c'.repeat(40);
  run.contract.design = { snapshotId: 'dsn_aaaaaaaaaaaa', snapshotHash: 'a'.repeat(64), targetIds: ['1:2'], acknowledgedIssueIds: [], designPolicyVersion: 1 };
  e.store.runs.put(run);
  const figma = new FigmaService({ dataDir: dir, store: e.store, port: 14309 });
  app = await buildApp({ store: e.store, orchestrator: e.orchestrator, dataDir: dir, port: 14309, figma });
  const token = (await app.inject({ url: '/api/session', headers: { host: HOST } })).json().token;
  const post = (body: unknown, csrf = token) => app!.inject({ method: 'POST', url: `/api/runs/${run.id}/visual-check`, headers: { host: HOST, 'x-csrf-token': csrf }, payload: body as object });
  return { ...e, run, post };
}
describe('visual check approval boundary', () => {
  it('requires CSRF and rejects external mappings before changing a project or running anything', async () => {
    const e = await fixture(), before = e.store.projects.get(e.run.projectId)!;
    expect((await e.post({ profile: { pathTemplate: '/' } }, 'wrong')).statusCode).toBe(403);
    expect((await e.post({ profile: { pathTemplate: 'https://example.com' } })).statusCode).toBe(400);
    expect(e.store.projects.get(e.run.projectId)).toEqual(before);
    expect(e.runtime.calls).toHaveLength(0);
  });
  it('does not approve unrelated project policy or modify a run that is working', async () => {
    const e = await fixture(), project = e.store.projects.get(e.run.projectId)!;
    e.store.projects.put({ ...project, approved: false });
    expect((await e.post({ profile: { pathTemplate: '/' } })).statusCode).toBe(409);
    expect(e.store.projects.get(project.id)?.approved).toBe(false);
    e.store.projects.put(project); e.store.runs.put({ ...e.run, status: 'running' });
    expect((await e.post({ profile: { pathTemplate: '/' } })).statusCode).toBe(409);
    expect(e.store.projects.get(project.id)?.visualCheck).toBeUndefined();
  });
  it('saves only the displayed profile and rechecks without calling an agent or changing contract content', async () => {
    vi.spyOn(VisualChecks.prototype, 'run').mockResolvedValue(undefined);
    const e = await fixture(), before = JSON.stringify(e.run.contract), original = e.store.projects.get(e.run.projectId)!;
    expect((await e.post({ profile: { pathTemplate: '/?state={nodeId}' } })).statusCode).toBe(200);
    await e.orchestrator.idle();
    const project = e.store.projects.get(original.id)!;
    expect(project.visualCheck).toEqual({ pathTemplate: '/?state={nodeId}', pixelThreshold: 0.1 });
    expect(project.roles).toEqual(original.roles); expect(project.checks).toEqual(original.checks); expect(project.approved).toBe(true);
    expect(JSON.stringify(e.store.runs.get(e.run.id)!.contract)).toBe(before);
    expect(e.runtime.calls.some(c => c.startsWith('agent:'))).toBe(false);
  });
});
