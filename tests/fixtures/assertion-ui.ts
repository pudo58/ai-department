/** Interactive browser fixture. All model/check responses are scripted and use temporary data only. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { setupV2 as setup } from '../helpers.js';
import { fence, qualityReply, qualityGreen, qualityReport } from '../quality-fixtures.js';

let applied = () => false;
const env = setup({ reply: x => x.prompt.includes('Author chẩn đoán') ? fence({ decision: 'test_assertion', caseIds: ['C-2'], reason: 'Assertion đòi lỗi khi gọi cancel lặp, trái điều khoản trả duplicate.', evidence: 'Runner đã chạy test; lời gọi trả duplicate. Điều khoản hợp đồng quy định kết quả này.', assertionChanges: [{ caseId: 'C-2', before: 'rejects ALREADY_TERMINAL', after: 'status equals duplicate', oracle: { references: [{ requirementId: 'R-1', quote: x.run.contract.requirements[0]!.text }], explanation: 'Sửa kỳ vọng theo hợp đồng, giữ nguyên thao tác và mã ca.' } }] }) : qualityReply(x), files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], check: () => ({ ...qualityGreen, exitCode: applied() ? 0 : 1, report: qualityReport(applied() ? 'passed' : 'failed') }) });
applied = () => env.runtime.calls.includes('applyPatch:A');
const originalChanges = env.runtime.changes.bind(env.runtime);
env.runtime.changes = async (run, slot) => {
  const changes = await originalChanges(run, slot);
  return changes.files.includes('tests/order.test.ts') ? { ...changes, patch: "--- a/tests/order.test.ts\n+++ b/tests/order.test.ts\n@@ -5,1 +5,1 @@\n-await expect(cancel()).rejects.toMatchObject({code:'ALREADY_TERMINAL'});\n+expect((await cancel()).status).toBe('duplicate');\n" } : changes;
};
const run = env.create({ mode: 'verify', budgetUsd: 10, title: 'Fixture: duyệt sửa assertion có căn cứ', originalRequirement: 'Cancel lặp trả duplicate và không tạo thay đổi mới.' });
env.orchestrator.startRun(run.id); await env.orchestrator.idle();
const dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-assertion-browser-'));
const port = Number(process.env.AIDEPT_FIXTURE_PORT ?? 14338);
const app = await buildApp({ ...env, dataDir, port, staticDir: path.resolve('dist/client') });
app.addHook('onRequest', async (request, reply) => { if (request.url === '/api/health') return reply.send({ node: process.version, docker: false, dockerMessage: 'fixture', codex: false, claude: false, localCodex: false, fake: true, liveReady: false, limitations: ['Fixture: không dùng model thật.'] }); });
await app.listen({ host: '127.0.0.1', port });
const info = { url: `http://127.0.0.1:${port}/#/run/${run.id}`, runId: run.id, pid: process.pid, dataDir };
if (process.env.AIDEPT_FIXTURE_INFO) writeFileSync(process.env.AIDEPT_FIXTURE_INFO, JSON.stringify(info));
console.log(JSON.stringify(info));
process.on('SIGTERM', async () => { await app.close(); env.store.close(); process.exit(0); });
