// node scripts/eval-run.mjs <taskId> <single|department|native> [--tag r1] [--model gpt-6-luna] [--effort medium]
// Runs one arm of one task and grades the final workspace with the hidden grader. Writes test-results/eval/<task>-<arm>-<tag>.json.
// (The registered pilot uses scripts/eval-pilot.mjs; this is for single runs and calibration.)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runArm } from './lib/evalrun.mjs';
import { loadTask, repoRoot } from './lib/evaltask.mjs';

const [taskId, arm, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
const PLANS = { single: { kind: 'harness', mode: 'single' }, department: { kind: 'harness', mode: 'verify' }, native: { kind: 'native' } };
if (!taskId || !PLANS[arm]) { console.error('usage: node scripts/eval-run.mjs <taskId> <single|department|native> [--tag t] [--model m] [--effort e]'); process.exit(2); }
const tag = flag('tag', 'r1'), name = `${taskId}-${arm}-${tag}`;
const out = path.join(repoRoot, 'test-results', 'eval'), resultFile = path.join(out, `${name}.json`);
await mkdir(out, { recursive: true });
if (await readFile(resultFile, 'utf8').then(() => true, () => false)) throw new Error('Already run; pick a new --tag.');
const task = await loadTask(taskId);
console.log(JSON.stringify({ event: 'started', name }));
const row = await runArm({ task, plan: PLANS[arm], name, model: flag('model', 'gpt-6-luna'), effort: flag('effort', 'medium'), outDir: out });
await writeFile(resultFile, JSON.stringify({ task: taskId, arm, tag, ...row }, null, 2));
console.log(JSON.stringify({ event: 'finished', name, status: row.status, graderPass: row.graderPass, falseReady: row.falseReady, costUsd: row.costUsd, automaticMs: row.automaticMs, error: row.error?.slice(0, 200) }));
