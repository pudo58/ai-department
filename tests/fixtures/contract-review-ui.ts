/** Local UI fixture: isolated data, deterministic agents/checks, no model quota or original project writes. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { initialContract, approveContract } from '../../src/core/contract.js';
import { green, report, setup } from '../helpers.js';

const env = setup({ check: () => ({ ...green, report: report([{ title: '[R-1] works' }, { title: '[R-2] never duplicates' }]) }) });
const run = env.create({ title: 'Fixture: soát hợp đồng trước khi chạy' });
env.orchestrator.startRun(run.id); await env.orchestrator.idle();
const clean = env.create({ title: 'Fixture: hợp đồng đủ cấu trúc' });
env.orchestrator.startRun(clean.id); await env.orchestrator.idle();
env.orchestrator.reviseContract(clean.id, {
  requirements: [
    { id: 'R-1', text: 'Tạo đúng một đơn.', kind: 'expected', required: true, manual: false },
    { id: 'R-2', text: 'Không tạo đơn trùng khi retry cùng khóa.', kind: 'forbidden', required: true, manual: false },
  ], acceptanceExamples: ['Retry k1 hai lần trả cùng một đơn.'], assumptions: [], interfaces: [], scope: ['src', 'tests'],
});
const legacy = env.create({ title: 'Fixture: giữ lịch sử duyệt cũ' });
env.store.runs.put({ ...legacy, status: 'paused', contract: approveContract(initialContract('Giữ dữ liệu hiện có.'), new Date('2020-01-01T00:00:00Z')) });
const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-contract-ui-'));
const port = Number(process.env.AIDEPT_FIXTURE_PORT ?? 14320);
const app = await buildApp({ ...env, dataDir, port, staticDir: path.resolve('dist/client') });
app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/api/health') return reply.send({ node: process.version, docker: false, dockerMessage: 'fixture', codex: false, claude: false, localCodex: false, fake: true, liveReady: false, limitations: ['Fixture: không dùng model thật.'] });
});
// Reproduce another edit between the displayed review and approval submission, without timing-dependent sleeps.
let staleOnce = true;
app.addHook('preHandler', async (request) => {
  if (staleOnce && request.method === 'POST' && request.url === `/api/runs/${run.id}/approve-contract`) {
    staleOnce = false;
    const current = env.orchestrator.detail(run.id).run.contract;
    env.orchestrator.reviseContract(run.id, { ...current, assumptions: [...current.assumptions, 'Fixture: hợp đồng đổi ngay trước khi duyệt; cần đọc lại bản mới.'] });
  }
});
await app.listen({ host: '127.0.0.1', port });
const info = { url: `http://127.0.0.1:${port}/#/run/${run.id}`, cleanUrl: `http://127.0.0.1:${port}/#/run/${clean.id}`, legacyUrl: `http://127.0.0.1:${port}/#/run/${legacy.id}`, runId: run.id, cleanId: clean.id, dataDir, pid: process.pid };
if (process.env.AIDEPT_FIXTURE_INFO) writeFileSync(process.env.AIDEPT_FIXTURE_INFO, JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
const shutdown = async () => { await app.close(); env.store.close(); process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
