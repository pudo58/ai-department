import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { HttpError, type Orchestrator } from './orchestrator.js';
import type { Store } from './store.js';
import { createRouteContext } from './routes/context.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerMonitorRoutes } from './routes/monitor.js';
import { registerPreviewRoutes } from './routes/previews.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerFigmaRoutes } from './routes/figma.js';
import type { FigmaService } from './figma/service.js';
import type { SkillLibrary } from '../runtime/skilllibrary.js';
import { startAutoClean } from './autoclean.js';

const PLUGIN_PREFIX = '/api/figma-exporter/';

export interface AppOptions { store: Store; orchestrator: Orchestrator; dataDir: string; port: number; staticDir?: string; skills?: SkillLibrary; /** Only the real server turns this on; tests never delete folders in the background. */ autoClean?: boolean;
  /** The Figma integration (installer, exporter hub, snapshots). Without it the routes for it are not served. */ figma?: FigmaService }

/**
 * Loopback-only API. Defence in depth for a local tool a browser can reach: Host must be a loopback name
 * (blocks DNS rebinding), Origin must match on writes, and writes need the per-process CSRF token.
 */
export async function buildApp({ store, orchestrator, dataDir, port, staticDir, skills, autoClean, figma }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  const token = randomBytes(24).toString('hex');
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]'].flatMap((h) => [`${h}:${port}`, `${h}:5173`]));
  const origins = new Set([...hosts].map((h) => `http://${h}`));

  app.addHook('onRequest', async (request, reply) => {
    if (!hosts.has(String(request.headers.host ?? '').toLowerCase())) return reply.code(403).send({ error: 'Host không được phép.' });
    // The Exporter plugin has its own authentication (a pairing code, then a session token). Its iframe has an opaque origin (the string
    // "null"), so only that origin, or none at all, reaches this namespace, and nothing else is let through by this exception.
    if (request.url.startsWith(PLUGIN_PREFIX)) {
      const from = request.headers.origin;
      return from === undefined || from === 'null' ? undefined : reply.code(403).send({ error: 'Origin không được phép.' });
    }
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return reply.code(403).send({ error: 'Origin không được phép.' });
    const sent = Buffer.from(String(request.headers['x-csrf-token'] ?? ''));
    const expected = Buffer.from(token);
    if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) return reply.code(403).send({ error: 'Thiếu hoặc sai CSRF token.' });
  });
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith(PLUGIN_PREFIX) && request.headers.origin === 'null') reply.header('Access-Control-Allow-Origin', 'null').header('Vary', 'Origin');
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY')
      // A route may set a stricter policy of its own (a design file served as data); the page's default applies to everything else.
      .header('Content-Security-Policy', reply.getHeader('content-security-policy') ?? "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; frame-ancestors 'none'");
  });
  app.setErrorHandler((error: Error & { statusCode?: number; issues?: unknown }, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid', message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error instanceof HttpError) return reply.code(error.status).send({ error: 'request_failed', message: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'bad_request', message: error.message });
    return reply.code(500).send({ error: 'internal', message: 'Lỗi nội bộ của server.' });
  });

  app.get('/api/session', async () => ({ token }));

  const context = createRouteContext(app, store, orchestrator, dataDir, skills);
  registerSystemRoutes(context);
  registerProviderRoutes(context);
  registerProjectRoutes(context);
  registerMemoryRoutes(context);
  registerRunRoutes(context);
  registerPreviewRoutes(context);
  registerMonitorRoutes(context);
  registerSkillRoutes(context);
  if (figma) { registerFigmaRoutes(context, figma); app.addHook('onClose', async () => figma.stop()); }
  if (autoClean) {
    const stop = startAutoClean({ store, dataDir, stopPreview: (id) => context.previews.stop(id) });
    app.addHook('onClose', async () => stop());
  }

  if (staticDir && existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler((request, reply) => (request.method === 'GET' && !request.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'not_found' })));
  }
  return app;
}
