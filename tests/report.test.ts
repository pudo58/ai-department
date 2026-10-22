import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildReport, needsAcknowledgement, renderReportMarkdown } from '../src/core/report.js';
import { summarizeCheck } from '../src/core/checks.js';
import { LocalRuntime } from '../src/runtime/local.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import { green, profile, report as jsonReport, setup } from './helpers.js';

const report = jsonReport;
/** A passing check whose runner also skipped one test, the exact situation that was nearly accepted unnoticed. */
const withSkip = { exitCode: 0, incomplete: false, log: 'ok', report: report([{ title: '[R-1] works' }, { title: '[R-1] live against the real service' }].map((t, i) => (i === 1 ? { ...t, status: 'skipped' as never } : t))) };

/** In Verify mode the Author may only add tests and the Developer only source, or the run is blocked before review. */
const authorTestsOnly = (e: { role: string }) => (e.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts']);

describe('check tallies', () => {
  const recipe = profile().checks[0]!;
  const attempt = (rep: unknown) => ({ exitCode: 0, log: '', durationMs: 5, checkpoint: 'c1', incomplete: false, report: rep });
  const input = { runId: 'r', id: 'c', recipe, checkpoint: 'c1', contractVersion: 1 };

  it('records pass/fail/skip counts and the names of skipped tests', () => {
    const r = summarizeCheck(input, [attempt(withSkip.report)]);
    expect(r.counts).toEqual({ passed: 1, failed: 0, skipped: 1 });
    expect(r.skippedTestIds).toEqual(['[R-1] live against the real service']);
    expect(r.status).toBe('passed'); // exit code 0: a skipped test never fails the run, which is why it needs its own warning
  });
  it('records no tallies when there is no readable report, rather than zeros', () => {
    expect(summarizeCheck(input, [attempt(undefined)]).counts).toBeUndefined();
  });
});

describe('acceptance report', () => {
  it('lists which passing tests back each requirement and gives a clean bill only when nothing needs a second look', async () => {
    const { orchestrator, create, drive } = setup({ check: () => green, files: ['src/a.ts', 'tests/a.test.ts'] });
    const run = await drive(create({ title: 'Ngăn đơn trùng' }));
    const r = await orchestrator.report(run.id);
    expect(r.readiness).toBe('ready');
    expect(r.requirements[0]).toMatchObject({ id: 'R-1', status: 'verified', tests: ['[R-1] works'] });
    expect(r.changes.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'tests/a.test.ts']);
    expect(r.changes.testFiles).toEqual(['tests/a.test.ts']);
    expect(r.checks[0]).toMatchObject({ id: 'test', status: 'passed', passed: 1, failed: 0, skipped: 0 });
    expect(r.delivery.branch).toBe(`aidept/${run.id}-A`);
    expect(r.delivery.commands.join('\n')).toContain('merge');
    expect(r.effort.attempts).toBe(2);
    // Single mode is a self-review: stated, but it does not demand an acknowledgement.
    expect(r.warnings.every((w) => w.level === 'info')).toBe(true);
    expect(needsAcknowledgement(r)).toBe(false);
  });

  it('warns about skipped tests and makes acceptance require an explicit acknowledgement, then keeps the record', async () => {
    const { orchestrator, create, drive, store } = setup({ check: () => withSkip });
    const run = await drive(create());
    const r = await orchestrator.report(run.id);
    expect(r.readiness).toBe('ready_with_warnings');
    expect(r.warnings.find((w) => w.level === 'warn')!.text).toMatch(/1 test bị bỏ qua.*live against the real service/);

    await expect(orchestrator.acceptRun(run.id)).rejects.toThrow(/cảnh báo cần đọc/);
    expect(store.runs.get(run.id)!.status).toBe('awaiting_acceptance');
    const done = await orchestrator.acceptRun(run.id, { acknowledgeWarnings: true });
    expect(done.status).toBe('completed');
    const saved = store.artifacts.list(run.id).find((a) => a.title === 'Báo cáo nghiệm thu')!;
    expect(JSON.parse(saved.content)).toMatchObject({ acknowledgedWarnings: true, report: { readiness: 'ready_with_warnings' } });
  });

  it('surfaces a Verifier that abstained or was never run, instead of hiding it behind "0 findings"', async () => {
    const abstain = '```json\n{"decision":"abstain","findings":[]}\n```';
    const { orchestrator, create, drive } = setup({
      check: () => green, files: authorTestsOnly,
      reply: (e) => (e.role === 'verifier' ? `Chưa đủ bằng chứng nghiệm thu toàn bộ hợp đồng: R-1 live bị bỏ qua.\n${abstain}` : undefined),
    });
    const run = await drive(create({ mode: 'verify', budgetUsd: 10 }));
    const r = await orchestrator.report(run.id);
    expect(r.verifier.verdict).toMatchObject({ decision: 'abstain' });
    expect(r.verifier.verdict!.summary).toContain('Chưa đủ bằng chứng');
    expect(r.verifier.verdict!.summary).not.toContain('```');
    expect(r.warnings.some((w) => w.level === 'warn' && /Verifier từ chối kết luận/.test(w.text))).toBe(true);
    expect(markdown(r)).toContain('Chưa đủ bằng chứng nghiệm thu');
    await expect(orchestrator.acceptRun(run.id)).rejects.toThrow(/cảnh báo/);
  });

  it('rebuilds the verdict from the raw review for a run that was reviewed before verdicts were stored', async () => {
    const abstain = '```json\n{"decision":"abstain","findings":[]}\n```';
    const { orchestrator, create, drive, store } = setup({
      check: () => green, files: authorTestsOnly,
      reply: (e) => (e.role === 'verifier' ? `R-1 live bị bỏ qua nên chưa đủ bằng chứng.\n${abstain}` : undefined),
    });
    const run = await drive(create({ mode: 'verify', budgetUsd: 10 }));
    // Simulate the older data: the review happened and its raw output exists, but no verdict artifact was saved.
    for (const a of store.artifacts.list(run.id).filter((x) => x.title === 'Verifier verdict')) store.artifacts.delete(a.id);
    expect(store.artifacts.list(run.id).some((a) => a.title === 'Verifier verdict')).toBe(false);
    const r = await orchestrator.report(run.id);
    expect(r.verifier.verdict).toMatchObject({ decision: 'abstain' });
    expect(r.verifier.verdict!.summary).toContain('chưa đủ bằng chứng');
    expect(r.warnings.some((w) => /Verifier chưa chạy/.test(w.text))).toBe(false);
  });

  it('reports a skipped Verifier (budget) and an unparsable one as missing independent verification', async () => {
    const tiny = setup({ check: () => green });
    const run = await tiny.drive(tiny.create({ mode: 'verify', budgetUsd: 0.05 }));
    // Whatever ended the run, the report must not claim an independent review that did not happen.
    const r = await tiny.orchestrator.report(run.id);
    if (r.verifier.verdict === null || r.verifier.verdict.decision === 'skipped') expect(r.warnings.some((w) => w.level === 'warn' && /Verifier/.test(w.text))).toBe(true);

    const garbled = setup({ check: () => green, files: authorTestsOnly, reply: (e) => (e.role === 'verifier' ? 'không có khối json' : undefined) });
    const run2 = await garbled.drive(garbled.create({ mode: 'verify', budgetUsd: 10 }));
    const r2 = await garbled.orchestrator.report(run2.id);
    expect(r2.verifier.verdict).toMatchObject({ decision: 'unparsed' });
    expect(r2.warnings.some((w) => /không đọc được/.test(w.text))).toBe(true);
  });

  it('flags manual requirements, approved out-of-scope paths and not-yet-run analysis tools', async () => {
    const { orchestrator, create, drive } = setup({ check: () => green, files: ['src/a.ts', 'worker/x.ts'] });
    let run = await drive(create());
    expect(run.status).toBe('blocked');
    orchestrator.approvePaths(run.id, ['worker'], true); await orchestrator.idle();
    run = orchestrator.detail(run.id).run;
    const r = await orchestrator.report(run.id);
    expect(r.scopeApprovals).toEqual(['worker']);
    expect(r.warnings.some((w) => /worker/.test(w.text))).toBe(true);
    expect(r.warnings.some((w) => /knip/.test(w.text))).toBe(true);
  });

  it('is not ready while conditions are missing, and says why', async () => {
    const { orchestrator, create, drive } = setup({ check: () => ({ ...green, exitCode: 1 }) });
    const run = await drive(create());
    const r = await orchestrator.report(run.id);
    expect(r.readiness).toBe('not_ready');
    expect(r.notReadyReasons.length).toBeGreaterThan(0);
  });

  it('renders a Markdown record with the decisions a person needs', async () => {
    const { orchestrator, create, drive } = setup({ check: () => withSkip, files: ['src/a.ts'] });
    const run = await drive(create({ title: 'Ngăn đơn trùng' }));
    const md = markdown(await orchestrator.report(run.id));
    for (const needle of ['# Báo cáo nghiệm thu: Ngăn đơn trùng', '## Cảnh báo', '## Yêu cầu và bằng chứng', '## Thay đổi so với bản gốc', '`src/a.ts`', '## Kết quả chạy test', '1 pass, 0 fail, 1 bỏ qua', '## Nhận kết quả', 'git -C']) expect(md).toContain(needle);
  });
});

describe('the test program while it runs', () => {
  it('exposes the running check (command, since when) and clears it when it ends, with live lines in the console', async () => {
    const { orchestrator, create, store } = setup({ check: () => green, checkDelayMs: 300 });
    const run = create();
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id);
    let seen: { recipeId: string; command: string; ref: string } | undefined;
    for (let i = 0; i < 40 && !seen; i++) { seen = orchestrator.detail(run.id).runningCheck; if (!seen) await new Promise((r) => setTimeout(r, 25)); }
    expect(seen).toMatchObject({ recipeId: 'test', command: 'npm test', ref: 'candidate' });
    await orchestrator.idle();
    expect(orchestrator.detail(run.id).runningCheck).toBeUndefined();
    expect(store.logs.list({ runId: run.id, source: 'check:test', limit: 50 }).some((l) => l.message.startsWith('✔ [R-1]'))).toBe(true);
  });
});

describe('what changed, measured against the base snapshot with real git', () => {
  it('reports per-file added/removed lines for the whole task, not just the last round', async () => {
    const source = mkdtempSync(path.join(tmpdir(), 'aidept-rep-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
    mkdirSync(path.join(source, 'src'));
    writeFileSync(path.join(source, 'src', 'sum.mjs'), 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n');
    writeFileSync(path.join(source, 'check.mjs'), "import { sumTo } from './src/sum.mjs';\nimport { writeFileSync } from 'node:fs';\nconst ok = sumTo(3) === 6;\nwriteFileSync('.aidept-report.json', JSON.stringify({ testResults: [{ name: 'c', status: ok ? 'passed' : 'failed', assertionResults: [{ fullName: '[R-1] sumTo includes n', status: ok ? 'passed' : 'failed' }] }] }));\nprocess.exit(ok ? 0 : 1);\n");
    git('init', '-q'); git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    const store = new Store(':memory:');
    store.projects.put(profile({ repository: source, executionMode: 'local', modules: ['src'], checks: [{ id: 'test', command: ['node', 'check.mjs'], required: true, timeoutMs: 60_000, reportPath: '.aidept-report.json' }] }));
    const runtime = new LocalRuntime({ dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-rep-data-')), codexCommand: [process.execPath, path.resolve('tests/fixtures/fake-codex.mjs')] });
    const orchestrator = new Orchestrator(store, () => runtime);
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 'Sửa sumTo', originalRequirement: 'sumTo bỏ sót n', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id); await orchestrator.idle();

    const r = await orchestrator.report(run.id);
    expect(r.changes.available).toBe(true);
    expect(r.changes.files).toEqual([{ path: 'src/sum.mjs', added: 1, removed: 1, status: 'modified' }]);
    expect(r.changes.patch).toContain('-  for (let i = 1; i < n; i++) total += i;');
    expect(r.changes.patch).toContain('+  for (let i = 1; i <= n; i++) total += i;');
    expect(r.readiness).toBe('ready');
    expect(markdown(r)).toContain('1 file, +1 −1');
  }, 120_000);
});

const markdown = renderReportMarkdown;
