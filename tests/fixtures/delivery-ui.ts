/** Browser QA only. No real providers, no original project writes, isolated temporary data. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { green, setupLegacy as setup } from '../helpers.js';

const env = setup({ check: () => green, files: (e) => e.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'] });
const run = await env.drive(env.create({ title: 'Fixture: giao lỗi và thử lại', mode: 'verify', budgetUsd: 10 }));
for (const artifact of env.store.artifacts.list(run.id).filter((a) => a.title === 'Verifier verdict' || a.kind === 'raw')) {
  env.store.artifacts.put({ ...artifact, checkpoint: 'old-checkpoint' });
}
const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-delivery-ui-'));
env.runtime.deliveryTarget = () => ({ kind: 'files', target: path.join(dataDir, 'fixture-project') });
let deliveries = 0;
env.runtime.deliver = async () => {
  deliveries++;
  if (deliveries === 1) throw new Error('Fixture: đích nhận tạm thời không ghi được. TOKEN=fixture-sensitive-value');
  await new Promise((r) => setTimeout(r, 1800));
  return { kind: 'files', target: path.join(dataDir, 'fixture-project'), summary: 'đã ghi 2 file vào fixture-project' };
};
const legacy = await env.drive(env.create({ title: 'Fixture: lịch sử nghiệm thu chưa xác nhận giao' }));
env.store.runs.put({ ...legacy, status: 'completed', acceptedAt: '2020-01-01T00:00:00Z', followupUntil: '2020-01-08T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' });
const port = Number(process.env.AIDEPT_FIXTURE_PORT ?? 14310);
const app = await buildApp({ ...env, dataDir, port, staticDir: path.resolve('dist/client') });
app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/api/health') return reply.send({ node: process.version, docker: false, dockerMessage: 'fixture', codex: false, claude: false, localCodex: false, fake: true, liveReady: false, limitations: ['Fixture UI: không gọi model thật.'] });
});
await app.listen({ host: '127.0.0.1', port });
const info = { url: `http://127.0.0.1:${port}/#/run/${run.id}`, legacyUrl: `http://127.0.0.1:${port}/#/run/${legacy.id}`, runId: run.id, legacyId: legacy.id, dataDir, pid: process.pid };
if (process.env.AIDEPT_FIXTURE_INFO) writeFileSync(process.env.AIDEPT_FIXTURE_INFO, JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
const shutdown = async () => { await app.close(); env.store.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
