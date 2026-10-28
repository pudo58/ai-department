import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { CHUNK_MAX_BYTES, REQUEST_MAX_BYTES, TEXT_STREAMS, type ChunkEnvelope, type FinishBody, type HelloInfo, type PluginEvent } from '../../shared/figma.js';
import { HttpError } from '../orchestrator.js';
import type { RouteContext } from './context.js';
import type { FigmaService } from '../figma/service.js';
import type { PluginSession } from '../figma/exporter.js';

const str = (max: number) => z.string().max(max);
const Page = z.object({ id: str(200), name: str(500), childCount: z.number().int() });
const Root = z.object({ id: str(200), name: str(500), type: str(60), pageId: str(200), pageName: str(500).optional() });
const Hello = z.object({
  protocolVersion: z.number().int(), readerVersion: z.number().int(), pluginVersion: str(40), bundleHash: str(80).optional(), editorType: str(40), apiVersion: str(40), fileName: str(500),
  fileKey: str(80).optional(), pages: z.array(Page).max(2000), selection: z.array(Root).max(500), currentPageId: str(200), sourceSession: str(80), hasMissingFonts: z.boolean().optional(),
});
const Phase = z.enum(['queued', 'preparing', 'inventory', 'reading', 'dependencies', 'assets', 'verifying', 'assembling', 'review_ready', 'loading_pages']);
const Event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), commandId: str(40).optional(), hello: Hello }),
  z.object({ type: z.literal('pages'), commandId: str(40), pages: z.array(Page).max(2000) }),
  z.object({ type: z.literal('roots'), commandId: str(40), pageId: str(200), roots: z.array(Root).max(5000) }),
  z.object({ type: z.literal('phase'), jobId: str(40), phase: Phase, nodes: z.number().optional(), bytes: z.number().optional(), note: str(300).optional() }),
  z.object({ type: z.literal('progress'), jobId: str(40), nodes: z.number(), total: z.number().optional(), bytes: z.number(), unacked: z.number() }),
  z.object({ type: z.literal('error'), jobId: str(40).optional(), commandId: str(40).optional(), code: str(60), message: str(1000) }),
  z.object({ type: z.literal('cancelled'), jobId: str(40) }),
]);
const Chunk = z.object({
  protocolVersion: z.number().int(), jobId: str(40), sourceSession: str(80), scopeHash: str(80), seq: z.number().int().min(0), kind: z.enum(['inventory', 'nodes', 'dependencies', 'verification', 'asset']),
  assetId: str(80).optional(), offset: z.number().int().min(0).optional(), final: z.boolean().optional(), byteLength: z.number().int().min(0).max(CHUNK_MAX_BYTES), sha256: str(80), payload: str(Math.ceil(CHUNK_MAX_BYTES * 1.4) + 8),
});
const Stream = z.object({ bytes: z.number().int().min(0), sha256: str(80), records: z.number().int().min(0) });
const Finish = z.object({
  protocolVersion: z.number().int(), jobId: str(40), sourceSession: str(80), scopeHash: str(80), lastSeq: z.number().int(),
  streams: z.object(Object.fromEntries(TEXT_STREAMS.map((s) => [s, Stream])) as Record<(typeof TEXT_STREAMS)[number], typeof Stream>),
  assets: z.array(z.object({ id: str(80), bytes: z.number().int(), sha256: str(80) })).max(100_000),
  totals: z.object({ nodes: z.number(), pages: z.number(), dependencies: z.number(), assets: z.number() }),
  verification: z.object({ passes: z.number().int(), sourceChanged: z.boolean(), changedIds: z.array(str(200)).max(100), documentChanges: z.number().int(), watchedDocumentChanges: z.boolean() }),
  stats: z.object({ peakUnackedChunks: z.number(), durationMs: z.number(), restoredSkipInvisible: z.boolean() }),
  limitReached: z.enum(['time', 'nodes', 'bytes', 'asset']).nullable().optional(),
  errors: z.array(z.object({ code: str(60), message: str(1000) })).max(100),
});
const Limits = z.object({ jobMs: z.number().optional(), maxNodes: z.number().optional(), maxBytes: z.number().optional(), maxAssetBytes: z.number().optional() });
const CreateExport = z.object({
  scope: z.enum(['selection', 'pages', 'file']), rootIds: z.array(str(200)).max(200).optional(), pageIds: z.array(str(200)).max(500).optional(), limits: Limits.optional(),
  declaredUrl: str(500).optional(), attestSource: z.boolean().optional(), previousSnapshotId: str(40).optional(),
});
const Publish = z.object({ snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), acknowledgedIssueIds: z.array(str(400)).max(2000).default([]) });
const IdParam = z.object({ id: str(60) });

/** Mime types shown inline. Everything else, and SVG in particular (it can carry script), is only ever offered as a download. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/json']);

/**
 * Two groups of routes. The ones for the person using the page (integrations, exports, snapshots) go through the app's Host, Origin and
 * CSRF checks. The plugin's (`/api/figma-exporter/…`) have their own authentication, and a plugin session reaches nothing else.
 */
export function registerFigmaRoutes({ app, store, orchestrator }: RouteContext, figma: FigmaService): void {
  const { hub, installer, snapshots } = figma;
  const session = (request: { headers: { authorization?: string } }): PluginSession => hub.authenticate(request.headers.authorization);

  // ---------------------------------------------------------------- the page: integrations

  app.get('/api/integrations', async () => [await figma.summary()]);
  app.post('/api/integrations/figma/install', async (_request, reply) => reply.code(202).send(installer.start()));
  app.get('/api/integrations/figma/install', async () => installer.listJobs());
  app.get('/api/integrations/figma/install/:id', async (request) => installer.getJob(IdParam.parse(request.params).id));
  app.post('/api/integrations/figma/install/:id/cancel', async (request) => installer.cancel(IdParam.parse(request.params).id));
  app.post('/api/integrations/figma/prepare-bundle', async () => { const info = await installer.prepareBundle(); return { ...info, state: installer.bundleState() }; });
  app.post('/api/integrations/figma/open-desktop', async () => installer.openDesktop());
  app.post('/api/integrations/figma/open-plugin-folder', async () => installer.openPluginFolder());
  app.post('/api/integrations/figma/pairing', async () => { if (installer.bundleState().state === 'missing') await installer.prepareBundle(); return hub.createPairingCode(); });
  app.post('/api/integrations/figma/disconnect', async () => { hub.disconnect(); return figma.summary(); });

  app.post('/api/integrations/figma/check', async () => {
    const answer = await hub.request({ type: 'HELLO' });
    if (answer.type !== 'hello') throw new HttpError(409, 'Exporter trả lời không đúng loại.');
    const pages = await hub.request({ type: 'LIST_PAGES' });
    const h = answer.hello;
    return {
      ok: pages.type === 'pages',
      checks: [
        { id: 'protocol', ok: true, detail: `Giao thức ${h.protocolVersion}, reader ${h.readerVersion}, plugin ${h.pluginVersion}.` },
        { id: 'editor', ok: h.editorType === 'figma', detail: `Editor ${h.editorType}${h.editorType === 'figma' ? '' : ' chưa được hỗ trợ (chỉ Figma Design).'}` },
        { id: 'metadata', ok: h.pages.length > 0, detail: `File “${h.fileName}”, ${h.pages.length} trang.` },
        { id: 'file_key', ok: !!h.fileKey, detail: h.fileKey ? 'Plugin trả được file key.' : 'Plugin không trả được file key; nguồn sẽ là “do người dùng xác nhận”.' },
        { id: 'read', ok: pages.type === 'pages' && pages.pages.length > 0, detail: 'Đọc được danh sách trang của file.' },
      ],
      hello: h,
    };
  });

  /** Lists pages and the current selection, or the top-level nodes of one page. Nothing is exported by looking. */
  app.post('/api/integrations/figma/browse', async (request) => {
    const body = z.object({ pageId: str(200).optional() }).parse(request.body ?? {});
    const answer = await hub.request({ type: 'HELLO' });
    if (answer.type !== 'hello') throw new HttpError(409, 'Exporter trả lời không đúng loại.');
    const roots = body.pageId ? await hub.request({ type: 'LIST_ROOTS', pageId: body.pageId }) : undefined;
    return { hello: answer.hello as HelloInfo, ...(roots && roots.type === 'roots' ? { pageId: roots.pageId, roots: roots.roots } : {}) };
  });

  // ---------------------------------------------------------------- the page: export jobs

  app.post('/api/design-exports', async (request, reply) => reply.code(202).send(hub.createExport(CreateExport.parse(request.body))));
  app.get('/api/design-exports', async () => hub.listJobs());
  app.get('/api/design-exports/:id', async (request) => hub.getJob(IdParam.parse(request.params).id));
  app.post('/api/design-exports/:id/cancel', async (request) => hub.cancel(IdParam.parse(request.params).id));
  app.delete('/api/design-exports/:id', async (request) => { hub.deleteJob(IdParam.parse(request.params).id); return { deleted: true }; });

  // ---------------------------------------------------------------- the page: snapshots

  app.get('/api/design-snapshots', async () => snapshots.list().map((s) => ({ ...s, references: figma.referencesOf(s.id) })).reverse());
  app.get('/api/design-snapshots/:id/previews', async (request) => snapshots.previews(IdParam.parse(request.params).id));
  app.get('/api/design-snapshots/:id/diagnostics', async (request) => snapshots.diagnostics(IdParam.parse(request.params).id));
  app.get('/api/design-snapshots/:id', async (request) => {
    const snapshot = snapshots.get(IdParam.parse(request.params).id);
    if (!snapshot) throw new HttpError(404, 'Snapshot không tồn tại.');
    return { ...snapshot, references: figma.referencesOf(snapshot.id), integrity: snapshots.verify(snapshot.id) };
  });
  app.get('/api/design-snapshots/:id/files/:fileId', async (request, reply) => {
    const { id, fileId } = z.object({ id: str(60), fileId: str(40) }).parse(request.params);
    const { full, file } = snapshots.file(id, fileId);
    const inline = INLINE.has(file.mime);
    reply.header('Content-Type', file.mime.startsWith('text/') || file.mime === 'application/x-ndjson' ? 'text/plain; charset=utf-8' : file.mime)
      .header('Content-Disposition', `${inline || file.mime.startsWith('text/') || file.mime === 'application/x-ndjson' ? 'inline' : 'attachment'}; filename="${file.id}${file.path.slice(file.path.lastIndexOf('.'))}"`)
      .header('Content-Security-Policy', "default-src 'none'; sandbox");
    return reply.send(createReadStream(full));
  });
  app.get('/api/design-snapshots/:id/nodes/:nodeId', async (request) => {
    const { id, nodeId } = z.object({ id: str(60), nodeId: str(200) }).parse(request.params);
    const record = snapshots.reader(id).node(nodeId);
    if (!record) throw new HttpError(404, 'Node không có trong snapshot.');
    return record;
  });
  app.get('/api/design-snapshots/:id/tree', async (request) => {
    const { id } = IdParam.parse(request.params);
    const { parent } = z.object({ parent: str(200).optional() }).parse(request.query);
    const reader = snapshots.reader(id);
    const rows = parent ? reader.childrenOf(parent) : reader.roots.map((r) => reader.row(r.id)).filter((r): r is NonNullable<typeof r> => !!r);
    return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, hasChildren: reader.childrenOf(r.id).length > 0 }));
  });
  app.get('/api/design-snapshots/:id/diff', async (request) => {
    const { id } = IdParam.parse(request.params);
    const { base } = z.object({ base: str(60) }).parse(request.query);
    return snapshots.diff(id, base);
  });
  app.post('/api/design-snapshots/:id/publish', async (request) => snapshots.publish(IdParam.parse(request.params).id, Publish.parse(request.body)));
  app.delete('/api/design-snapshots/:id', async (request) => { figma.deleteSnapshot(IdParam.parse(request.params).id); return { deleted: true }; });

  // ---------------------------------------------------------------- project and run

  app.post('/api/projects/:id/design-source', async (request) => {
    const body = z.object({ snapshotId: str(60).nullable() }).parse(request.body);
    const project = store.projects.get(IdParam.parse(request.params).id);
    if (!project) throw new HttpError(404, 'Project không tồn tại.');
    if (body.snapshotId) figma.bind({ snapshotId: body.snapshotId });
    const { designSource: _old, ...rest } = project;
    return store.projects.put({ ...rest, ...(body.snapshotId ? { designSource: { snapshotId: body.snapshotId } } : {}) });
  });

  /** Chooses another snapshot (or none) for a waiting task: a contract change, so the version rises and approval is asked again. */
  app.post('/api/runs/:id/design', async (request) => {
    const body = z.object({ snapshotId: str(60).nullable(), targetIds: z.array(str(200)).max(200).optional() }).parse(request.body);
    return orchestrator.setDesign(IdParam.parse(request.params).id, body);
  });

  // ---------------------------------------------------------------- the plugin

  const allowed = (request: { headers: { origin?: string } }) => request.headers.origin === 'null';
  // Preflight: the plugin's iframe has an opaque origin (the string "null"); only that origin is answered, never a wildcard.
  app.options('/api/figma-exporter/:action', async (request, reply) => {
    if (!allowed(request)) return reply.code(403).send({ error: 'cors', message: 'Origin không được phép.' });
    return reply.code(204).headers({
      'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600', Vary: 'Origin',
    }).send();
  });

  app.post('/api/figma-exporter/pair', { bodyLimit: 64 * 1024 }, async (request) => {
    const body = z.object({ code: str(20), hello: Hello }).parse(request.body);
    return hub.pair({ code: body.code, hello: body.hello as HelloInfo });
  });
  app.post('/api/figma-exporter/poll', { bodyLimit: 4 * 1024 }, async (request) => ({ commands: await hub.poll(session(request)) }));
  app.post('/api/figma-exporter/event', { bodyLimit: 256 * 1024 }, async (request) => {
    hub.event(session(request), z.object({ event: Event }).parse(request.body).event as PluginEvent);
    return { ok: true };
  });
  app.post('/api/figma-exporter/chunk', { bodyLimit: REQUEST_MAX_BYTES }, async (request) => hub.ingest(session(request), Chunk.parse(request.body) as ChunkEnvelope));
  app.post('/api/figma-exporter/finish', { bodyLimit: 1024 * 1024 }, async (request) => {
    const result = await hub.finish(session(request), Finish.parse(request.body) as FinishBody);
    return { job: { id: result.job.id, status: result.job.status }, ...(result.snapshot ? { snapshotId: result.snapshot.id } : {}) };
  });
  app.post('/api/figma-exporter/disconnect', { bodyLimit: 1024 }, async (request) => { session(request); hub.disconnect(); return { ok: true }; });
}
