/** Browser fixture with deterministic agents/checks. Recheck supplies the missing case, without AI. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { setupV2 as setup } from '../helpers.js';
import { qualityReply, qualityReport, qualityGreen } from '../quality-fixtures.js';

let includeNegative = false;
const env = setup({ reply: qualityReply, files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], check: () => ({ ...qualityGreen, report: qualityReport(includeNegative ? 'passed' : 'missing') }) });
const run = env.create({ mode: 'verify', budgetUsd: 10, title: 'Fixture: ca lỗi bắt buộc và mutation' });
env.orchestrator.startRun(run.id); await env.orchestrator.idle();
const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-quality-ui-'));
const port = Number(process.env.AIDEPT_FIXTURE_PORT ?? 14324);
const app = await buildApp({ ...env, dataDir, port, staticDir: path.resolve('dist/client') });
app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/api/health') return reply.send({ node: process.version, docker: false, dockerMessage: 'fixture', codex: false, claude: false, localCodex: false, fake: true, liveReady: false, limitations: ['Fixture: không dùng model thật.'] });
});
let staleOnce = true;
app.addHook('preHandler', async request => {
  if (staleOnce && request.method === 'POST' && request.url === `/api/runs/${run.id}/approve-contract`) {
    staleOnce = false;
    const contract = structuredClone(env.store.runs.get(run.id)!.contract);
    contract.testPlan!.cases[1]!.expected += '; dữ liệu đơn không thay đổi';
    env.orchestrator.reviseContract(run.id, contract);
  }
  if (request.method === 'POST' && request.url === `/api/runs/${run.id}/recheck`) includeNegative = true;
});
await app.listen({ host: '127.0.0.1', port });
const info = { url: `http://127.0.0.1:${port}/#/run/${run.id}`, runId: run.id, dataDir, pid: process.pid };
if (process.env.AIDEPT_FIXTURE_INFO) writeFileSync(process.env.AIDEPT_FIXTURE_INFO, JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
const shutdown = async () => { await app.close(); env.store.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
