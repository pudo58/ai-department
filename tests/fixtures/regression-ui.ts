/**
 * Interactive browser fixture for the v4 loop: a real Git/Vitest project, scripted agents, no model quota.
 * It stops where a person has to act: a finding with its basis, the replay result and the regression diff on the page.
 * Run `pnpm build`, then `pnpm exec tsx tests/fixtures/regression-ui.ts` and open the printed URL. Read the oracle and the diff,
 * tick the box and confirm, press "Sửa 1 finding đã xác nhận", then read the acceptance report: the finding is "đã chứng minh sửa xong"
 * only because the same scenario failed before and passes after, with the locked regression test beside it.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { v4Fixture } from '../v4-fixtures.js';

const f = await v4Fixture({ project: { name: 'Fixture v4: counterexample → regression' } });
await f.approve(f.run.id);
const port = Number(process.env.AIDEPT_FIXTURE_PORT ?? 14339);
const app = await buildApp({ store: f.store, orchestrator: f.orch, dataDir: f.dataDir, port, staticDir: path.resolve('dist/client') });
app.addHook('onRequest', async (request, reply) => { if (request.url === '/api/health') return reply.send({ node: process.version, docker: false, dockerMessage: 'fixture', codex: false, claude: false, localCodex: false, fake: true, liveReady: false, limitations: ['Fixture: không dùng model thật.'] }); });
await app.listen({ host: '127.0.0.1', port });
const info = { url: `http://127.0.0.1:${port}/#/run/${f.run.id}`, runId: f.run.id, pid: process.pid, dataDir: f.dataDir };
if (process.env.AIDEPT_FIXTURE_INFO) writeFileSync(process.env.AIDEPT_FIXTURE_INFO, JSON.stringify(info));
console.log(JSON.stringify(info));
process.on('SIGTERM', async () => { await app.close(); f.store.close(); process.exit(0); });
