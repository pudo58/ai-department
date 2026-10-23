import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTestReport, summarizeCheck } from '../src/core/checks.js';
import { detectStack } from '../src/core/stackdetect.js';
import { resolveHostCommand } from '../src/runtime/hostcommand.js';
import { executeFile } from '../src/runtime/process.js';
import { clearReport, readReport } from '../src/runtime/report.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPytest = spawnSync(python, ['-m', 'pytest', '--version'], { encoding: 'utf8' }).status === 0;

/** Runs the detector's own pytest suggestion against a real repository, so the JUnit report really comes from pytest. */
describe.skipIf(!hasPytest)('detected pytest check, run for real', () => {
  it('produces a report whose test names carry requirement ids, and a failing test is a failed check', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidept-pytest-'));
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    writeFileSync(path.join(dir, 'tests', 'test_orders.py'), 'def test_R_1_rejects_duplicate():\n    assert True\n\ndef test_R_2_total_is_kept():\n    assert 1 + 1 == 3\n');

    const detected = await detectStack(dir);
    const recipe = detected.checks.find((c) => c.id === 'test')!;
    expect(recipe.reportPath).toBe('.aidept-report.xml');

    await clearReport(dir, recipe.reportPath!);
    const [cmd, ...args] = resolveHostCommand(recipe.command);
    const result = await executeFile(cmd!, args, { cwd: dir, timeoutMs: 120_000 });
    expect(result.exitCode).toBe(1);
    const report = await readReport(dir, recipe.reportPath!);
    const parsed = parseTestReport(report);
    expect(parsed.valid).toBe(true);
    expect(parsed.tests.map((t) => `${t.status}:${t.id.split('::').pop()}`).sort()).toEqual(['failed:test_R_2_total_is_kept', 'passed:test_R_1_rejects_duplicate']);

    const check = summarizeCheck(
      { runId: 'r', id: 'c', recipe: { id: 'test', command: recipe.command, required: true, timeoutMs: 1000, reportPath: recipe.reportPath }, checkpoint: 'x', contractVersion: 1 },
      [{ exitCode: result.exitCode, log: result.stdout, durationMs: result.durationMs, checkpoint: 'x', report, incomplete: false }],
    );
    expect(check.status).toBe('failed');
    expect(check.requirementIds).toEqual(['R-1']);
  }, 150_000);
});
