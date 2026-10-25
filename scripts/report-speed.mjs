import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve('.');
const directory = path.join(root, 'test-results/2026-10-24-speed');
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const hash = data => createHash('sha256').update(data).digest('hex');
const sum = (items, key) => items.reduce((total, item) => total + (item[key] ?? 0), 0);
const completed = run => ['awaiting_acceptance', 'completed'].includes(run.status);
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const seconds = value => value === null ? 'Không đủ dữ liệu' : `${(value / 1000).toFixed(1)} giây`;

const protocol = await readJson(path.join(directory, 'protocol.json'));
const reliability = await readJson(path.join(root, 'test-results/reliability/results.json'));
const build = await readJson(path.join(root, 'test-results/execution-speed/build-result.json'));
if (build.exitCode !== 0 || !reliability.success) throw new Error('Build/reliability chưa đạt; không xuất báo cáo hoàn tất.');
const arms = {};
for (const arm of ['baseline', 'optimized']) {
  const runs = await readJson(path.join(directory, `${arm}-runs.json`));
  if (runs.length !== 3 || runs.some(run => !run.endedAt)) throw new Error(`${arm}: run vẫn đang chạy; chưa xuất báo cáo cuối.`);
  for (const run of runs) {
    const detail = await readJson(path.join(directory, `${arm}-${run.index}-detail.json`));
    if (detail.run.id !== run.runId || detail.run.status !== run.status) throw new Error('Summary/detail không khớp.');
    if (hash(detail.run.originalRequirement) !== protocol.specHash || Math.abs(detail.run.budgetUsd - protocol.effectiveBudgetUsd) > 1e-9
      || Object.values(detail.run.configSnapshot.roles).some(role => role.model !== protocol.model || role.effort !== protocol.effort)) throw new Error('Run khác SPEC/model/effort/ngân sách đã khóa.');
    run.execution = detail.execution ?? null;
    run.contractProblems = detail.contractReview.problems;
    run.currentChecks = detail.checks.filter(check => check.valid && check.checkpoint === detail.run.checkpoint)
      .map(check => ({ id: check.id, status: check.status, counts: check.counts }));
    const verdict = detail.artifacts.filter(artifact => artifact.valid && artifact.title === 'Verifier verdict'
      && artifact.checkpoint === detail.run.checkpoint && artifact.contractVersion === detail.run.contract.version).at(-1);
    run.verifier = verdict ? JSON.parse(verdict.content) : null;
    run.promptChars = detail.artifacts.filter(artifact => artifact.title === 'Agent input receipt')
      .map(artifact => JSON.parse(artifact.content).promptChars).reduce((a, b) => a + b, 0) || null;
    run.roles = run.attempts.reduce((counts, attempt) => ({ ...counts, [attempt.role]: (counts[attempt.role] ?? 0) + 1 }), {});
    run.inputTokens = sum(run.usage, 'inputTokens');
    run.cachedTokens = sum(run.usage, 'cachedTokens');
    run.outputTokens = sum(run.usage, 'outputTokens');
    run.outcome = /usage limit|quota|rate.?limit/i.test(run.blocker ?? '') ? 'provider_blocked'
      : run.status === 'awaiting_approval' && run.contractProblems.length ? 'contract_needs_correction'
      : /Không đọc được kế hoạch ca/.test(run.blocker ?? '') ? 'invalid_plan'
      : completed(run) ? 'awaiting_acceptance' : 'stopped';
  }
  const successes = runs.filter(completed);
  arms[arm] = {
    runs, completed: successes.length, total: runs.length, candidates: runs.filter(run => run.grade).length,
    outcomes: runs.reduce((counts, run) => ({ ...counts, [run.outcome]: (counts[run.outcome] ?? 0) + 1 }), {}),
    medianAutomatedMsForCompleted: median(successes.map(run => run.automatedMs)),
    modelAttempts: runs.reduce((total, run) => total + run.attempts.length, 0),
    successfulAttempts: runs.reduce((total, run) => total + run.attempts.filter(attempt => attempt.status === 'completed').length, 0),
    inputTokens: sum(runs, 'inputTokens'), cachedTokens: sum(runs, 'cachedTokens'), outputTokens: sum(runs, 'outputTokens'),
  };
}

const baselineManifest = await readJson(path.join(root, '.data/speed-baseline/source-manifest.json'));
const optimizedManifest = await readJson(path.join(root, '.data/speed-optimized/source-manifest.json'));
if (hash(await readFile(path.join(root, '.data/speed-baseline/source-manifest.json'))) !== protocol.baselineSourceManifestHash) throw new Error('Baseline manifest khác protocol.');
const optimizedReceipt = await readJson(path.join(directory, 'optimized-source-receipt.json'));
if (hash(await readFile(path.join(root, '.data/speed-optimized/source-manifest.json'))) !== optimizedReceipt.sourceManifestHash) throw new Error('Optimized manifest khác receipt.');
const originalGrader = path.join(root, 'test-results/2026-10-24-outboxpilot/grade-audited.mjs');
if (hash(await readFile(originalGrader)) !== protocol.graderHash) throw new Error('Grader đã thay đổi.');

const optimizedHashes = new Map(optimizedManifest.map(file => [file.path, file.sha256]));
const currentPaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true })
  .trim().split(/\r?\n/).filter(file => file && !/(^|\/)\.env($|\.)/.test(file));
const finalFiles = [];
for (const file of [...new Set(currentPaths)].sort()) {
  try { finalFiles.push({ path: file, sha256: hash(await readFile(path.join(root, file))) }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const finalReceipt = {
  recordedAt: new Date().toISOString(), files: finalFiles,
  changedSinceMeasuredOptimizedSnapshot: finalFiles.filter(file => optimizedHashes.has(file.path) && optimizedHashes.get(file.path) !== file.sha256).map(file => file.path),
  addedSinceMeasuredOptimizedSnapshot: finalFiles.filter(file => !optimizedHashes.has(file.path)).map(file => file.path),
  removedBaselineFiles: baselineManifest.filter(file => !finalFiles.some(current => current.path === file.path)).map(file => file.path),
  interpretation: 'Final handoff includes regression-driven hardening after the six frozen runs. These changes were not measured by live model reruns.',
};
await writeFile(path.join(directory, 'final-source-receipt.json'), JSON.stringify(finalReceipt, null, 2));

const { baseline, optimized } = arms;
const speedComparable = baseline.completed === 3 && optimized.completed === 3;
const priorRegression = await readJson(path.join(root,'test-results/execution-speed/reliability-timeout-before-reproduction.json'));
const result = {
  schemaVersion: 2, generatedAt: new Date().toISOString(), protocol, arms, speedComparable,
  medianSpeedupPercent: speedComparable ? 100 * (1 - optimized.medianAutomatedMsForCompleted / baseline.medianAutomatedMsForCompleted) : null,
  interpretation: 'Cả hai nhóm chưa có run tới chờ nghiệm thu; không có candidate mới và không đủ cơ sở chấm chất lượng code hoặc tính phần trăm tăng tốc.',
  finalHandoffMatchesMeasuredSnapshot: !finalReceipt.changedSinceMeasuredOptimizedSnapshot.length && !finalReceipt.addedSinceMeasuredOptimizedSnapshot.length,
  postBenchmarkHardening: [
    'Real Git/Vitest regression exposed initial draft recovery at null run.checkpoint; patch now binds to its saved base checkpoint.',
    'Preflight resolves installed tools without npx downloads, preserves config arguments and invalidates a prior receipt after environment failure.',
    'One repair routing helper rejects stale manifest/check evidence before Developer, including resumed runs.',
    'A standalone environment action preserves a pending contract approval gate; failed provider attempts retain prompt receipts.',
    'Priority enum and exact oracle references are explicit in the final prompt; no frozen run was retried to measure this update.',
  ],
  validation: { build: 'passed_local', buildEvidence: '../execution-speed/build-result.json', testFiles: reliability.testResults.length, tests: reliability.numTotalTests,
    passed: reliability.numPassedTests, failed: reliability.numFailedTests, skipped: reliability.numPendingTests,
    success: reliability.success, realModelCallsInFixtures: 0, outerWorkers: 2,
    priorRegression: { tests: priorRegression.numTotalTests, failed: priorRegression.numFailedTests,
      evidence: '../execution-speed/reliability-timeout-before-reproduction.json',
      cause: 'Mutation monorepo fixture hit its fixed 27-second total limit under parallel load; isolated reproduction passed without changing timeout/assertions. Outer suite concurrency reduced from 4 to 2.',
      classification: 'TIMEOUT; load contention suspected, medium confidence' } },
  originalBaselineFilesRemoved: finalReceipt.removedBaselineFiles,
  localOnly: true, githubCi: 'not_run',
  limitations: [
    'Three attempts per arm on one task do not establish average reliability or production defect rates.',
    'The optimized quota failure is included as provider_blocked; it is not evidence of faster execution or a code defect.',
    'The awaiting_approval run has unresolved contract/oracle problems; its short runtime is not a successful completion.',
    'Historical 43/43 ReplayGate candidates do not stand in for candidates missing from this six-run comparison.',
    'No failed run was retried and no candidate source/test/schema was repaired by the benchmark controller.',
    'Runs were sequential in baseline-then-optimized order; provider variability and cache effects were not randomized.',
    'Token totals are observed CLI traffic, not billed cost; one failed attempt returned no usage.',
    'Final handoff code contains post-benchmark hardening verified with fixtures, not new live comparisons.',
  ],
};
await writeFile(path.join(directory, 'comparison.json'), JSON.stringify(result, null, 2));

const text = [
  '# Đối chứng tăng tốc AI Department — ReplayGate', '',
  '**Chưa chứng minh được tăng tốc hoặc chất lượng code tốt hơn.** Sáu run đã được ghi nhận đầy đủ nhưng chưa run nào tạo candidate mới.', '',
  'Cùng GPT-6 Luna medium cho mọi vai, cùng SPEC/scaffold/grader và trần ngân sách hiệu lực $10,80/run. Mỗi nhóm ba run, chạy tuần tự trên snapshot và data directory riêng. Không retry run lỗi, không sửa source/test/schema thay model.', '',
  '| Chỉ số | Baseline | Snapshot tối ưu |', '|---|---:|---:|',
  `| Tới chờ nghiệm thu | ${baseline.completed}/3 | ${optimized.completed}/3 |`,
  `| Candidate để chấm | ${baseline.candidates}/3 | ${optimized.candidates}/3 |`,
  `| Tổng lượt model (gồm thất bại) | ${baseline.modelAttempts} | ${optimized.modelAttempts} |`,
  `| Lượt model hoàn tất | ${baseline.successfulAttempts} | ${optimized.successfulAttempts} |`,
  `| Input token quan sát (gồm cache) | ${baseline.inputTokens} | ${optimized.inputTokens} |`,
  `| Output token quan sát | ${baseline.outputTokens} | ${optimized.outputTokens} |`,
  '| Trung vị thời gian đến hoàn tất | Chưa đo được | Chưa đo được |', '',
  'Baseline: ba kế hoạch Author sai schema. Snapshot tối ưu: một kế hoạch sai priority enum; một kế hoạch parse được nhưng sai liên kết/trích dẫn oracle, thiếu ca và còn câu hỏi; một run dừng do quota trước khi Planner trả kết quả. Các cổng kiểm tra đã giữ lại output không hợp lệ. Các số thời gian tới khi dừng bên dưới không được dùng làm tỷ lệ tăng tốc.', '',
];
for (const arm of ['baseline', 'optimized']) {
  text.push(`## ${arm}`, '');
  for (const run of arms[arm].runs) {
    text.push(`- Run ${run.index}: \`${run.runId}\`; **${run.status} / ${run.outcome}**; ${seconds(run.automatedMs)} thời gian tự động quan sát; ${run.attempts.length} lượt model; điểm code: ${run.grade ? `${run.grade.passed}/${run.grade.total}` : 'không có candidate'}.`);
    if (run.blocker) text.push(`  Lý do: ${run.blocker.replace(/\n/g, ' ').slice(0,2300)}`);
    if (run.contractProblems.length) text.push(`  Vấn đề hợp đồng: ${run.contractProblems.join('; ')}`);
    text.push(`  Can thiệp ghi nhận: ${run.interventions.length}. Mutation/Verifier: ${run.mutation || run.verifier ? 'xem JSON' : 'chưa tới bước này'}.`);
  }
  text.push('');
}
text.push('## Bản bàn giao sau kiểm tra', '',
  'Bản tối ưu được đo là snapshot khóa trước ba run. Bản code bàn giao có thêm sửa lỗi phát hiện bằng regression sau đó; chưa gọi model thật để đo lại các sửa này.', '',
  ...result.postBenchmarkHardening.map(item => `- ${item}`), '',
  `Build local đạt. Reliability: **${reliability.testResults.length} file / ${reliability.numTotalTests} test; ${reliability.numFailedTests} fail, ${reliability.numPendingTests} bỏ qua**.`,
  `Vòng regression trước có ${priorRegression.numFailedTests}/${priorRegression.numTotalTests} lỗi: fixture mutation monorepo hết deadline 27 giây khi chạy chung. Chạy riêng cùng assertion/deadline đã đạt. Nhóm reliability giảm worker ngoài từ 4 xuống 2 để hạn chế tranh tài nguyên với worker của Stryker; giữ nguyên toàn bộ ca và timeout. Kết quả lỗi ban đầu được giữ ở ../execution-speed/reliability-timeout-before-reproduction.json.`,
  'Regression gồm Git/Vitest thật cho draft đầu tiên, discovery baseline đỏ không chạy assertion, lỗi môi trường/config, stale hash/manifest, restart/resume, khóa test, delivery, báo cáo và API/UI. Fixture dùng agent giả, không dùng quota model thật.',
  'UI trình duyệt đã xác nhận kiểm tra lại môi trường không gọi agent; phục hồi draft giữ số lượt Author; tiếp tục tới chờ nghiệm thu và hiển thị giới hạn Verifier. Screenshot và HTML ở `../execution-speed/`.',
  'Hướng dẫn cấu hình/thao tác: `../../docs/execution-speed.md`. GitHub CI Windows/Linux chưa chạy trong lượt local này.', '',
  '## Giới hạn', '', ...result.limitations.map(item => `- ${item}`), '',
  'Hồ sơ: `protocol.json`, `<arm>-runs.json`, `<arm>-<n>-detail.json`, `optimized-source-receipt.json`, `final-source-receipt.json` và `comparison.json`. Grader gốc được giữ nguyên hash; không có file grade mới vì không có candidate.', '');
await writeFile(path.join(directory, 'report.md'), text.join('\n'));
console.log(JSON.stringify({ baseline: baseline.outcomes, optimized: optimized.outcomes, speedComparable,
  validation: result.validation, removedBaselineFiles: finalReceipt.removedBaselineFiles,
  report: path.join(directory, 'report.md') }));
