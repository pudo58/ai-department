import { z } from 'zod';
import { buildMonitor, monitorRequests, PERIODS } from '../../core/monitor.js';
import { diskSpace } from '../storage.js';
import { type LogEntry, type LogQuery, matchesLog } from '../store.js';
import type { RouteContext } from './context.js';

/** Monitor: console log history, the live stream and the activity overview. */
export function registerMonitorRoutes({ app, store, dataDir }: RouteContext): void {
  const LogFilter = z.object({
    after: z.coerce.number().int().min(0).optional(), run: z.string().max(60).optional(), source: z.string().max(60).optional(),
    level: z.enum(['debug', 'info', 'warn', 'error']).optional(), q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(2000).optional(),
  });
  const toQuery = (raw: unknown): LogQuery => {
    const f = LogFilter.parse(raw);
    return { after: f.after, runId: f.run, source: f.source, minLevel: f.level, q: f.q, limit: f.limit };
  };
  app.get('/api/logs', async (request) => store.logs.list(toQuery(request.query)));

  /**
   * Server-Sent Events. The client loads history from /api/logs, then connects here with `after` = its last id;
   * anything written in between is replayed from the database, so no line is missed or duplicated.
   */
  app.get('/api/logs/stream', (request, reply) => {
    const q = toQuery(request.query);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
    let last = q.after ?? store.logs.list({ limit: 1 }).at(-1)?.id ?? 0;
    const send = (e: LogEntry) => {
      if (e.id <= last) return;
      last = e.id;
      if (matchesLog(e, q)) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    for (const e of store.logs.list({ ...q, after: last, limit: 2000 })) send(e);
    const unsubscribe = store.logs.subscribe(send);
    const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => { clearInterval(beat); unsubscribe(); });
  });

  app.get('/api/monitor', async (request) => {
    const { period } = z.object({ period: z.enum(PERIODS).default('today') }).parse(request.query);
    const now = Date.now();
    const recentLogs = store.logs.list({ limit: 200 }).filter((e) => now - Date.parse(e.ts) < 15_000);
    const attempts = store.attempts.list();
    const runs = store.runs.list();
    const lastLogByRun: Record<string, string> = {};
    for (const r of runs.filter((x) => x.status === 'running' || x.status === 'queued')) {
      const line = store.logs.list({ runId: r.id, limit: 1, minLevel: 'info' }).at(-1);
      if (line) lastLogByRun[r.id] = line.message.slice(0, 240);
    }
    const alerts: { level: 'warn' | 'error'; text: string }[] = [];
    const disk = await diskSpace(dataDir);
    if (disk && disk.level !== 'ok') alerts.push({ level: disk.level === 'critical' ? 'error' : 'warn', text: `Ổ ${disk.path} chỉ còn ${(disk.freeBytes / 1024 ** 3).toFixed(1)} GB trống. Khi hết chỗ, npm, test và Codex sẽ lỗi; dọn bản sao làm việc ở tab Hệ thống.` });
    const provider = runs.filter((r) => r.status === 'blocked' && /quá tải|quota/i.test(r.blocker ?? ''));
    if (provider.length) alerts.push({ level: 'warn', text: `${provider.length} task bị chặn vì provider quá tải hoặc hết quota. Đợi vài phút rồi bấm Chạy tiếp.` });
    return buildMonitor({
      runs, attempts, now, period, projects: store.projects.list(), lastLogByRun, alerts,
      errorsLastHour: store.logs.countSince(new Date(now - 3_600_000).toISOString(), 'error'),
      activity: {
        providers: [...new Set(attempts.filter((a) => a.status === 'running').map((a) => a.provider))],
        stages: { setup: recentLogs.some((e) => e.source === 'setup'), check: recentLogs.some((e) => e.source.startsWith('check:')) },
      },
    });
  });

  app.get('/api/monitor/requests', async (request, reply) => {
    const { run: runId } = z.object({ run: z.string().min(1).max(60) }).parse(request.query);
    const run = store.runs.get(runId);
    if (!run) return reply.code(404).send({ error: 'Không tìm thấy task.' });
    return monitorRequests(run, store.attempts.list(runId));
  });
}
