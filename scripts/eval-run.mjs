// node scripts/eval-run.mjs <taskId> <single|department> [--tag r1] [--model gpt-6-luna] [--effort medium]
// Runs one arm of one task through the real orchestrator (Codex), approves the contract unchanged, then grades the final
// workspace with the hidden grader from the task pack. Writes test-results/eval/<task>-<arm>-<tag>.json.
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Store } from '../src/server/store.ts';
import { Orchestrator } from '../src/server/orchestrator.ts';
import { createRuntimeResolver } from '../src/server/environment.ts';
import { DEFAULT_PROTECTED } from '../src/core/scope.ts';
import { degradedOf } from '../src/core/report.ts';
import { gradeSource, loadTask, repoRoot, taskHash } from './lib/evaltask.mjs';

const [taskId, arm, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
if (!taskId || !['single', 'department'].includes(arm)) { console.error('usage: node scripts/eval-run.mjs <taskId> <single|department> [--tag t] [--model m] [--effort e]'); process.exit(2); }
const tag = flag('tag', 'r1'), model = flag('model', 'gpt-6-luna'), effort = flag('effort', 'medium');
const task = await loadTask(taskId);
const name = `${taskId}-${arm}-${tag}`, out = path.join(repoRoot, 'test-results', 'eval'), data = path.join(repoRoot, '.data', `eval-${name}`);
await mkdir(out, { recursive: true });
const resultFile = path.join(out, `${name}.json`);
if (await readFile(resultFile, 'utf8').then(() => true, () => false)) throw new Error('Already run; pick a new --tag.');

// Workspace: scaffold + SPEC, committed once; node_modules is a junction so nothing is installed per run.
const base = path.join(data, 'base');
await cp(path.join(task.dir, 'scaffold'), base, { recursive: true });
await writeFile(path.join(base, 'SPEC.md'), task.spec);
await symlink(path.join(repoRoot, 'node_modules'), path.join(base, 'node_modules'), 'junction');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
git(base, ['init']); git(base, ['config', 'core.autocrlf', 'false']); git(base, ['config', 'user.name', 'Eval Scaffold']); git(base, ['config', 'user.email', 'eval@localhost']); git(base, ['add', '.']); git(base, ['commit', '-m', 'Scaffold']);
const setup = path.join(data, 'setup.mjs');
await writeFile(setup, `import {symlink,lstat,rmdir} from 'node:fs/promises';import path from 'node:path';const p=path.join(process.cwd(),'node_modules');const s=await lstat(p).catch(()=>null);if(s&&!s.isSymbolicLink())await rmdir(p);if(!s||!s.isSymbolicLink())await symlink(${JSON.stringify(path.join(repoRoot, 'node_modules'))},p,'junction');`);

const store = new Store(path.join(data, 'ai-department.sqlite')), orch = new Orchestrator(store, createRuntimeResolver(data));
const repo = path.join(data, 'work');
execFileSync('git', ['clone', '--no-hardlinks', base, repo], { stdio: 'ignore', windowsHide: true });
execFileSync('git', ['-C', repo, 'config', 'core.autocrlf', 'false'], { windowsHide: true });
const roles = Object.fromEntries(['planner', 'author', 'developer', 'verifier', 'investigator'].map((role) => [role, { provider: 'codex', model, effort, skills: [] }]));
const project = { id: `prj_${taskId}_${arm}_${tag}`.replace(/[^A-Za-z0-9_]/g, '_'), name: `${task.title} — ${arm}`, repository: repo, version: 1, approved: true, modules: task.modules, protectedPaths: [...DEFAULT_PROTECTED, ...task.protectedPaths],
  checks: [{ id: 'test', command: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json', '--outputFile=.aidept-report.json'], required: true, timeoutMs: 90000, reportPath: '.aidept-report.json' }],
  roles, runnerImage: 'unused-local', setupCommand: ['node', setup], executionMode: 'local', agentNetwork: 'none',
  guidance: 'SPEC.md is authoritative. Do not read sibling projects or controller data. No subagents. Use only the public API. Do not add behavior outside the contract or change dependencies, configuration, SPEC, or the scaffold test.',
  contextEnabled: false, allowScaffold: false, policyRules: ['Do not change locked tests, SPEC or verification configuration.'], singleBudgetUsd: 10.8, currency: 'USD', createdAt: new Date().toISOString() };
store.projects.put(project);
const run = orch.createRun({ projectId: project.id, title: `${task.title} / ${arm} / ${tag}`, originalRequirement: task.spec, mode: arm === 'department' ? 'verify' : 'single', provider: 'codex', budgetUsd: arm === 'department' ? task.budgetUsd : 10.8, taskKind: 'feature', signals: task.signals });
const row = { task: taskId, arm, tag, runId: run.id, model, effort, taskHash: await taskHash(task.dir), startedAt: new Date().toISOString(), interventions: [] };
await writeFile(resultFile, JSON.stringify(row, null, 2));
console.log(JSON.stringify({ event: 'started', ...row }));

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let last = Date.now(), automaticMs = 0, lastNotice = 0;
orch.startRun(run.id);
while (true) {
  await pause(1000);
  const detail = orch.detail(run.id), now = Date.now();
  if (['running', 'queued'].includes(detail.run.status)) automaticMs += now - last;
  last = now;
  if (now - lastNotice > 30000) { console.log(JSON.stringify({ event: 'progress', status: detail.run.status, stage: detail.run.stage, automaticMs })); lastNotice = now; }
  if (automaticMs >= 30 * 60_000) { orch.stopRun(run.id); await orch.idle(); row.limitReached = true; break; }
  if (['running', 'queued'].includes(detail.run.status)) continue;
  if (detail.run.status === 'awaiting_approval') {
    if (detail.contractReview.problems.length) { row.contractProblems = detail.contractReview.problems; break; }
    row.interventions.push({ type: 'contract_approved_unchanged', hash: detail.contractReview.contractHash, warnings: detail.contractReview.warnings.length, at: new Date().toISOString() });
    last = Date.now(); orch.approveContract(run.id, { contractHash: detail.contractReview.contractHash, acknowledgeWarnings: true }); continue;
  }
  if (detail.testRepair) { row.interventions.push({ type: 'test_repair_rejected', hash: detail.testRepair.hash, at: new Date().toISOString() }); orch.rejectTestRepair(run.id, detail.testRepair.id, detail.testRepair.hash); continue; }
  break;
}
await orch.idle();
const detail = orch.detail(run.id), workspace = path.join(data, 'workspaces', `${run.id}-A`);
const grade = await gradeSource(task, workspace);
const report = await orch.report(run.id).catch(() => undefined);
const ready = !!detail.completion.ready;
Object.assign(row, {
  endedAt: new Date().toISOString(), status: detail.run.status, blocker: detail.run.blocker, automaticMs,
  reachedDeveloper: detail.attempts.some((a) => a.role === 'developer'),
  readiness: report?.readiness ?? (ready ? 'ready' : 'not_ready'), degraded: degradedOf(detail.artifacts),
  grader: { passed: grade.passed, total: grade.total, failed: grade.failed.slice(0, 8), loadError: !!grade.loadError },
  graderPass: grade.total > 0 && grade.passed === grade.total,
  /** The system said it was ready but the hidden grader disagrees: the number the whole experiment is about. */
  falseReady: ready && !(grade.total > 0 && grade.passed === grade.total),
  costUsd: detail.budget.spentUsd, estimatedCost: detail.budget.estimated, attempts: detail.attempts.length,
  roles: detail.attempts.map((a) => `${a.role}:${a.stage}:${a.status}`), retries: detail.execution?.retries,
});
await writeFile(resultFile, JSON.stringify(row, null, 2));
console.log(JSON.stringify({ event: 'finished', ...Object.fromEntries(['task', 'arm', 'status', 'readiness', 'reachedDeveloper', 'graderPass', 'falseReady', 'costUsd', 'automaticMs'].map((k) => [k, row[k]])), grader: row.grader }));
store.close();
