// Records what the Figma Exporter did against the fake Figma document: pass counts of its test files, and the size, time and
// buffering of a few exports. It is evidence about the code, not about Figma: the live parts are listed as unconfirmed.
//
//   node node_modules/tsx/dist/cli.mjs scripts/figma-exporter-evidence.mjs      writes docs/figma-exporter-evidence.{json,md}
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { rig, waitFor } = await import('../tests/figma/harness.ts');
const { golden } = await import('../tests/figma/fakefigma.ts');

async function measure(name, options, body) {
  const r = await rig({ doc: golden(options) });
  try {
    await r.pairNow();
    const started = Date.now();
    const job = await r.exportAs(body);
    const done = await r.finished(job.id, 120_000);
    const snap = r.service.snapshots.get(done.snapshotId);
    const sizes = r.fetches.filter((f) => f.path.endsWith('/chunk')).length;
    return {
      name, scope: body.scope, status: done.status, durationMs: Date.now() - started, nodes: done.counts.nodes, pages: done.counts.pages, bytes: done.counts.bytes, chunks: done.nextSeq, chunkRequests: sizes,
      peakUnackedChunks: done.stats?.peakUnackedChunks ?? null, blockers: done.issues.filter((i) => i.severity === 'blocker').map((i) => i.code), limits: done.issues.filter((i) => i.severity === 'limit').map((i) => i.code),
      coverage: done.coverage, files: snap?.files.length ?? 0, snapshotHash: snap?.snapshotHash.slice(0, 12), consistency: done.coverage?.consistency,
    };
  } finally { await r.dispose(); }
}

const exports = [
  await measure('một frame (selection)', {}, { scope: 'selection', rootIds: ['1:2'] }),
  await measure('toàn bộ file (golden, 3 trang)', {}, { scope: 'file' }),
  await measure('frame lớn (1.800 node thêm)', { extraNodes: 1800 }, { scope: 'selection', rootIds: ['1:2'] }),
];

const out = mkdtempSync(path.join(tmpdir(), 'aidept-evidence-'));
const file = path.join(out, 'vitest.json');
const run = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...['core', 'validator', 'transport', 'installer', 'snapshots', 'exporter-e2e', 'exporter-edges', 'design-run', 'ui'].map((n) => `tests/figma-${n}.test.ts`), '--reporter=json', `--outputFile=${file}`], { cwd: root, encoding: 'utf8' });
const result = JSON.parse(readFileSync(file, 'utf8'));
rmSync(out, { recursive: true, force: true });
const suites = result.testResults.map((s) => ({ file: path.basename(s.name), passed: s.assertionResults.filter((t) => t.status === 'passed').length, failed: s.assertionResults.filter((t) => t.status === 'failed').length, skipped: s.assertionResults.filter((t) => t.status !== 'passed' && t.status !== 'failed').length, ms: Math.round(s.endTime - s.startTime) }));

const evidence = {
  generatedAt: new Date().toISOString(), commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  tests: { total: result.numTotalTests, passed: result.numPassedTests, failed: result.numFailedTests, suites, exitCode: run.status },
  exports,
  live: { figmaDesktop: 'chưa xác nhận', installerUserScope: 'chưa xác nhận', qualificationFile: 'chưa xác nhận', ci: 'chưa chạy trên GitHub Windows/Linux' },
};
writeFileSync(path.join(root, 'docs', 'figma-exporter-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

const pct = (n) => (n === null || n === undefined ? '—' : String(n));
const md = [
  '# Bằng chứng: Figma Exporter (fixture)', '',
  `Sinh lúc ${evidence.generatedAt} trên nền commit \`${evidence.commit}\` (cộng thay đổi chưa commit lúc chạy) bằng \`scripts/figma-exporter-evidence.mjs\`. Đây là bằng chứng về **code** chạy với Figma giả mô phỏng API (bundle plugin thật, UI thật trong jsdom, server thật). **Không** phải kết quả trên Figma Desktop thật.`, '',
  '## Test', '', `${evidence.tests.passed}/${evidence.tests.total} đạt, ${evidence.tests.failed} lỗi.`, '', '| File | Đạt | Lỗi | Bỏ qua | ms |', '|---|---|---|---|---|',
  ...suites.map((s) => `| ${s.file} | ${s.passed} | ${s.failed} | ${s.skipped} | ${s.ms} |`), '',
  '## Export mẫu', '', '| Export | Trạng thái | Node | Trang | Byte | Chunk | Đỉnh chưa ACK | ms | Nhất quán |', '|---|---|---|---|---|---|---|---|---|',
  ...exports.map((e) => `| ${e.name} | ${e.status} | ${e.nodes} | ${e.pages} | ${e.bytes} | ${e.chunks} | ${pct(e.peakUnackedChunks)} | ${e.durationMs} | ${e.consistency} |`), '',
  'Chỉ số độc lập, không gộp (ví dụ export toàn file):', '', '```json', JSON.stringify({ ...exports[1].coverage, fieldCoverage: exports[1].coverage.fieldCoverage.all }, null, 2), '```', '',
  '## Chưa xác nhận', '', ...Object.entries(evidence.live).map(([k, v]) => `- ${k}: ${v}`), '', 'Chi tiết các mục chưa xác nhận: cuối `docs/figma-exporter.md`.', '',
];
writeFileSync(path.join(root, 'docs', 'figma-exporter-evidence.md'), md.join('\n'));
console.log(`✓ ${evidence.tests.passed}/${evidence.tests.total} test đạt; ghi docs/figma-exporter-evidence.{json,md}`);
void waitFor;
