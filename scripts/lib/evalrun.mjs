// Runs one arm of one task pack and grades the result with the hidden grader. Shared by eval-run.mjs and eval-pilot.mjs.
// Harness arms go through the real orchestrator (Codex); the native arm runs the Codex CLI on its own, with all its features.
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Store } from '../../src/server/store.ts';
import { Orchestrator } from '../../src/server/orchestrator.ts';
import { createRuntimeResolver } from '../../src/server/environment.ts';
import { DEFAULT_PROTECTED } from '../../src/core/scope.ts';
import { degradedOf } from '../../src/core/report.ts';
import { estimateCost } from '../../src/core/budget.ts';
import { JsonlCollector, buildCliCommand } from '../../src/runtime/providers.ts';
import { resolveCodexCommand } from '../../src/runtime/hostcommand.ts';
import { executeFile, scrubbedEnv } from '../../src/runtime/process.ts';
import { gradeSource, repoRoot, taskHash } from './evaltask.mjs';

const GUIDANCE = 'SPEC.md is authoritative. Do not read sibling projects or controller data. Use only the public API. Do not add behavior outside the contract or change dependencies, configuration, SPEC, or the scaffold test.';
const LIMIT_MS = 30 * 60_000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scaffold + SPEC committed once, with node_modules as a junction so nothing is installed per run. */
async function prepare(task, data) {
  const base = path.join(data, 'base');
  await cp(path.join(task.dir, 'scaffold'), base, { recursive: true });
  await writeFile(path.join(base, 'SPEC.md'), task.spec);
  await symlink(path.join(repoRoot, 'node_modules'), path.join(base, 'node_modules'), 'junction');
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
  git(base, ['init']); git(base, ['config', 'core.autocrlf', 'false']); git(base, ['config', 'user.name', 'Eval Scaffold']); git(base, ['config', 'user.email', 'eval@localhost']); git(base, ['add', '.']); git(base, ['commit', '-m', 'Scaffold']);
  const setup = path.join(data, 'setup.mjs');
  await writeFile(setup, `import {symlink,lstat,rmdir} from 'node:fs/promises';import path from 'node:path';const p=path.join(process.cwd(),'node_modules');const s=await lstat(p).catch(()=>null);if(s&&!s.isSymbolicLink())await rmdir(p);if(!s||!s.isSymbolicLink())await symlink(${JSON.stringify(path.join(repoRoot, 'node_modules'))},p,'junction');`);
  const work = path.join(data, 'work');
  execFileSync('git', ['clone', '--no-hardlinks', base, work], { stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['-C', work, 'config', 'core.autocrlf', 'false'], { windowsHide: true });
  return { work, setup };
}

export async function runHarness({ task, mode, name, model, effort, data }) {
  const { work, setup } = await prepare(task, data);
  const store = new Store(path.join(data, 'ai-department.sqlite')), orch = new Orchestrator(store, createRuntimeResolver(data));
  try {
    const roles = Object.fromEntries(['planner', 'author', 'developer', 'verifier', 'investigator'].map((role) => [role, { provider: 'codex', model, effort, skills: [] }]));
    const project = { id: `prj_${name}`.replace(/[^A-Za-z0-9_]/g, '_'), name: `${task.title} — ${mode}`, repository: work, version: 1, approved: true, modules: task.modules, protectedPaths: [...DEFAULT_PROTECTED, ...task.protectedPaths],
      checks: [{ id: 'test', command: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json', '--outputFile=.aidept-report.json'], required: true, timeoutMs: 90000, reportPath: '.aidept-report.json' }],
      roles, runnerImage: 'unused-local', setupCommand: ['node', setup], executionMode: 'local', agentNetwork: 'none', guidance: `${GUIDANCE} No subagents.`,
      contextEnabled: false, allowScaffold: false, policyRules: ['Do not change locked tests, SPEC or verification configuration.'], singleBudgetUsd: 10.8, currency: 'USD', createdAt: new Date().toISOString() };
    store.projects.put(project);
    // Single has no multiplier; the team modes multiply the base, so a base of 6 gives both arms the same $10.80 ceiling.
    const run = orch.createRun({ projectId: project.id, title: `${task.title} / ${mode} / ${name}`, originalRequirement: task.spec, mode, provider: 'codex', budgetUsd: mode === 'single' ? 10.8 : task.budgetUsd, taskKind: 'feature', signals: task.signals });
    const interventions = [];
    let last = Date.now(), automaticMs = 0, limitReached = false;
    orch.startRun(run.id);
    while (true) {
      await pause(1000);
      const detail = orch.detail(run.id), now = Date.now();
      if (['running', 'queued'].includes(detail.run.status)) automaticMs += now - last;
      last = now;
      if (automaticMs >= LIMIT_MS) { orch.stopRun(run.id); await orch.idle(); limitReached = true; break; }
      if (['running', 'queued'].includes(detail.run.status)) continue;
      if (detail.run.status === 'awaiting_approval') {
        if (detail.contractReview.problems.length) break;
        interventions.push('contract_approved_unchanged');
        last = Date.now(); orch.approveContract(run.id, { contractHash: detail.contractReview.contractHash, acknowledgeWarnings: true }); continue;
      }
      if (detail.testRepair) { interventions.push('test_repair_rejected'); orch.rejectTestRepair(run.id, detail.testRepair.id, detail.testRepair.hash); continue; }
      break;
    }
    await orch.idle();
    const detail = orch.detail(run.id), workspace = path.join(data, 'workspaces', `${run.id}-A`);
    const grade = await gradeSource(task, workspace);
    const report = await orch.report(run.id).catch(() => undefined);
    const ready = !!detail.completion.ready, graderPass = grade.total > 0 && grade.passed === grade.total, degraded = degradedOf(detail.artifacts);
    return {
      runId: run.id, mode, status: detail.run.status, blocker: detail.run.blocker, limitReached, automaticMs, reachedDeveloper: detail.attempts.some((a) => a.role === 'developer'),
      readiness: report?.readiness ?? (ready ? 'ready' : 'not_ready'), degraded, grader: { passed: grade.passed, total: grade.total, failed: grade.failed.slice(0, 8), loadError: !!grade.loadError },
      graderPass, falseReady: ready && !graderPass, costUsd: detail.budget.spentUsd, estimatedCost: detail.budget.estimated, attempts: detail.attempts.length,
      roles: detail.attempts.map((a) => `${a.role}:${a.stage}:${a.status}`), retries: detail.execution?.retries,
      deviations: [...new Set([...interventions, ...(degraded.stages.includes('Sửa test của Author') ? ['test_repair_auto_applied'] : [])])],
    };
  } finally { store.close(); }
}

/** Codex CLI by itself: same model, effort, sandbox and time limit, with its own features (including subagents) left on. */
export async function runNative({ task, name, model, effort, data }) {
  const { work, setup } = await prepare(task, data);
  execFileSync(process.execPath, [setup], { cwd: work, windowsHide: true });
  const prompt = [
    'You are working in a Git repository (the current directory). Read SPEC.md and implement it.',
    'Put the implementation where the SPEC says, write your own tests under tests/ with Vitest (run them with `node node_modules/vitest/vitest.mjs run`), and make them pass.',
    GUIDANCE, 'Finish with a short summary of what you did.',
  ].join('\n');
  const collector = new JsonlCollector({ provider: 'codex' });
  const cmd = buildCliCommand({ provider: 'codex', model, effort, singleAgent: false, readOnly: false, workdir: work, extraConfig: process.platform === 'win32' ? ['windows.sandbox="elevated"'] : [] });
  const [exe, ...prefix] = resolveCodexCommand();
  let seen = '';
  const started = Date.now();
  const result = await executeFile(exe, [...prefix, ...cmd.slice(1)], { cwd: work, input: prompt, env: scrubbedEnv('provider'), onStdout: (chunk) => { collector.push(chunk); if (seen.length < 4_000_000) seen += chunk; }, timeoutMs: LIMIT_MS, maxOutputBytes: 64 * 1024 * 1024 });
  collector.finish();
  const automaticMs = Date.now() - started;
  const finished = !result.timedOut && collector.completed && !collector.failure;
  const grade = await gradeSource(task, work);
  const graderPass = grade.total > 0 && grade.passed === grade.total;
  return {
    mode: 'native', status: result.timedOut ? 'timeout' : finished ? 'finished' : 'failed', blocker: collector.failure ?? (result.exitCode ? `exit ${result.exitCode}` : null), automaticMs,
    grader: { passed: grade.passed, total: grade.total, failed: grade.failed.slice(0, 8), loadError: !!grade.loadError }, graderPass, readiness: null, falseReady: null, degraded: null,
    costUsd: estimateCost(collector.usage), estimatedCost: true, tokens: collector.usage, subagentsUsed: /spawn_agent|collab_tool|"agent_spawn"/.test(seen), deviations: [],
  };
}

export async function runArm({ task, plan, name, model = 'gpt-6-luna', effort = 'medium', outDir }) {
  const data = path.join(repoRoot, '.data', `eval-${name}`);
  await mkdir(data, { recursive: true });
  const base = { taskHash: await taskHash(task.dir), model, effort, startedAt: new Date().toISOString() };
  try {
    const result = plan.kind === 'native' ? await runNative({ task, name, model, effort, data }) : await runHarness({ task, mode: plan.mode, name, model, effort, data });
    return { ...base, ...result, endedAt: new Date().toISOString() };
  } catch (error) {
    // The machine or the runner failed, not the arm: recorded as infrastructure so it can be rerun, never counted as a quiet loss.
    return { ...base, mode: plan.kind === 'native' ? 'native' : plan.mode, status: 'error', error: String(error?.stack ?? error).slice(0, 2000), graderPass: false, grader: { passed: 0, total: 0, failed: [], loadError: true }, costUsd: null, automaticMs: 0, deviations: [], endedAt: new Date().toISOString() };
  }
}
