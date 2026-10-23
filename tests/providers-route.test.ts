import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeRuntime } from '../src/runtime/fake.js';
import { forgetCliStatus } from '../src/runtime/agentclis.js';
import { buildApp } from '../src/server/app.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; delete process.env.AIDEPT_CLAUDE_ENTRY; delete process.env.FAKE_CLAUDE_LOGGED_OUT; forgetCliStatus(); });

async function boot() {
  const store = new Store(':memory:');
  app = await buildApp({ store, orchestrator: new Orchestrator(store, () => new FakeRuntime()), dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-')), port: 4310 });
  const host = { host: '127.0.0.1:4310' };
  const get = (url: string) => app!.inject({ method: 'GET', url, headers: host });
  return { get };
}

describe('per-CLI status route (the connect page asks for each CLI on its own)', () => {
  it('returns one CLI status with the models it offers, and refuses an unknown CLI', async () => {
    process.env.AIDEPT_CLAUDE_ENTRY = path.resolve('tests/fixtures/fake-claude.mjs');
    const { get } = await boot();
    const claude = (await get('/api/providers/claude')).json<{ id: string; installed: boolean; loggedIn: boolean; modelOptions: { id: string }[] }>();
    expect(claude).toMatchObject({ id: 'claude', installed: true, loggedIn: true });
    expect(claude.modelOptions.map((m) => m.id)).toEqual(expect.arrayContaining(['fable', 'opus', 'sonnet']));
    expect((await get('/api/providers/gemini')).statusCode).toBe(400);
  });

  it('?refresh=1 forgets only that CLI, so a login done meanwhile shows up at once', async () => {
    process.env.AIDEPT_CLAUDE_ENTRY = path.resolve('tests/fixtures/fake-claude.mjs');
    process.env.FAKE_CLAUDE_LOGGED_OUT = '1';
    const { get } = await boot();
    expect((await get('/api/providers/claude')).json<{ loggedIn: boolean }>().loggedIn).toBe(false);
    delete process.env.FAKE_CLAUDE_LOGGED_OUT;
    expect((await get('/api/providers/claude')).json<{ loggedIn: boolean }>().loggedIn).toBe(false); // still the cached answer
    expect((await get('/api/providers/claude?refresh=1')).json<{ loggedIn: boolean }>().loggedIn).toBe(true);
  });
});
