import { z } from 'zod';
import { type AgentCli, cachedCliStatus, forgetCliStatus, installCodex, startLogin, testCli } from '../../runtime/agentclis.js';
import type { RouteContext } from './context.js';

/** Connecting the agent CLIs: status, a one-request test, installing Codex locally, starting the browser login. */
export function registerProviderRoutes({ app, dataDir }: RouteContext): void {
  const Cli = z.object({ id: z.enum(['codex', 'claude', 'antigravity']) });
  app.get('/api/providers', async (request) => {
    if (z.object({ refresh: z.string().max(5).optional() }).parse(request.query).refresh === '1') forgetCliStatus();
    return Promise.all((['codex', 'claude', 'antigravity'] as AgentCli[]).map((id) => cachedCliStatus(id)));
  });
  /**
   * One CLI's status. The page asks for the three separately so each card appears as soon as its own check finishes;
   * Antigravity's `agy models` takes seconds and must not hold up Codex and Claude.
   */
  app.get('/api/providers/:id', async (request) => {
    const { id } = Cli.parse(request.params);
    if (z.object({ refresh: z.string().max(5).optional() }).parse(request.query).refresh === '1') forgetCliStatus(id);
    return cachedCliStatus(id);
  });
  app.post('/api/providers/:id/test', async (request) => testCli(Cli.parse(request.params).id, dataDir));
  app.post('/api/providers/:id/login', async (request) => startLogin(Cli.parse(request.params).id));
  app.post('/api/providers/codex/install', async () => installCodex());
}
