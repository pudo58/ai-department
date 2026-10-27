// The v4 check: Department (Verify, policy v4) against Single on task packs with hidden graders, twelve live runs in total.
// One assignment = one run of one arm. A person-or-AI orchestrator decides what the product asks a person to decide (contract
// approval, test-correction proposals, finding confirmation) through `decide`; everything else is the product on its own.
// Nothing here retries a model run, edits a candidate or writes a test for the model.
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Store } from '../../src/server/store.ts';
import { Orchestrator } from '../../src/server/orchestrator.ts';
import { createRuntimeResolver } from '../../src/server/environment.ts';
import { DEFAULT_PROTECTED } from '../../src/core/scope.ts';
import { degradedOf } from '../../src/core/report.ts';
import { readRegressionManifest } from '../../src/core/regression.ts';
import { gradeSource, repoRoot } from './evaltask.mjs';

export const LIMITS = { effectiveCapUsd: 10.8, automaticMs: 30 * 60_000, maxDecisionRounds: 8, maxRepairRounds: 2 };
const GUIDANCE = 'SPEC.md is authoritative. Do not read sibling projects or controller data. Use only the public API. Do not add behavior outside the contract or change dependencies, configuration, SPEC, or the scaffold test.';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (text, n) => (typeof text === 'string' && text.length > n ? `${text.slice(0, n)}…` : text);

/** Scaffold + SPEC committed once, with node_modules as a junction so nothing is installed per run. */
async function prepare(task, data) {
  const base = path.join(data, 'base');
  await cp(path.join(task.dir, 'scaffold'), base, { recursive: true });
  await writeFile(path.join(base, 'SPEC.md'), task.spec);
  await symlink(path.join(repoRoot, 'node_modules'), path.join(base, 'node_modules'), 'junction');
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
  git(base, ['init']); git(base, ['config', 'core.autocrlf', 'false']); git(base, ['config', 'user.name', 'Eval Scaffold']); git(base, ['config', 'user.email', 'eval@localhost']); git(base, ['add', '.']); git(base, ['commit', '-m', 'Scaffold']);
  const setup = path.join(data, 'setup.mjs');
  await writeFile(setup, `import {symlink,lstat,rmdir} from 'node:fs/promises';import path from 'node:path';const p=path.join(process.cwd(),'node_modules');const s=await lstat(p).catch(()=>null);if(s&&!s.isSymbolicLink())await rmdir(p);if(!s||!s.isSymbolicLink())await symlink(${JSON.stringify(path.join(repoRoot, 'node_modules'))},p,'junction');\n`);
  const work = path.join(data, 'work');
  execFileSync('git', ['clone', '--no-hardlinks', base, work], { stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['-C', work, 'config', 'core.autocrlf', 'false'], { windowsHide: true });
  return { work, setup };
}

const contractView = (detail) => {
  const c = detail.run.contract;
  return {
    contractHash: detail.contractReview.contractHash, version: c.version,
    requirements: c.requirements.map((r) => ({ id: r.id, text: clip(r.text, 600), required: r.required, manual: r.manual, kind: r.kind })),
    acceptanceExamples: c.acceptanceExamples, interfaces: c.interfaces, assumptions: c.assumptions, scope: c.scope,
    problems: detail.contractReview.problems, warnings: detail.contractReview.warnings.map((w) => w.message),
    planReview: detail.planReview ? { outcome: detail.planReview.outcome, remaining: detail.planReview.remainingProblems, advisories: detail.planReview.remainingAdvisories, normalizations: detail.planReview.normalizations } : undefined,
    testPlan: c.testPlan ? {
      schemaVersion: c.testPlan.schemaVersion, questions: c.testPlan.questions, notApplicable: c.testPlan.notApplicable,
      cases: c.testPlan.cases.map((k) => ({ id: k.id, group: k.group, required: k.required, method: k.method, expected: clip(k.expected, 300), oracle: k.oracle && { references: k.oracle.references.map((x) => ({ requirementId: x.requirementId, quote: clip(x.quote, 200) })), explanation: clip(k.oracle.explanation, 300) }, invariants: k.invariants, steps: (k.steps ?? []).map((s) => ({ id: s.id, action: clip(s.action, 160), expected: clip(s.expected, 200) })) })),
    } : undefined,
  };
};
const findingView = (detail, f) => {
  const proposal = detail.regressionProposals?.find((p) => p.findingId === f.id);
  const replay = detail.findingReplays?.filter((r) => r.findingId === f.id).at(-1);
  return {
    id: f.id, severity: f.severity, category: f.category, title: f.title, location: f.location, evidence: clip(f.evidence, 800), suggestion: clip(f.suggestion, 500), status: f.status, confirmed: f.confirmed,
    reproductionLimitation: f.reproductionLimitation, scenario: f.reproduction && { oracle: f.reproduction.oracle, steps: f.reproduction.steps },
    replay: replay && { status: replay.status, message: replay.message, observations: replay.observations.filter((o) => o.matched !== undefined) },
    proposal: proposal && { hash: proposal.hash, path: proposal.path, unsupported: proposal.unsupported, trial: proposal.trial && { status: proposal.trial.status, message: clip(proposal.trial.message, 400) } },
  };
};
const openSerious = (detail) => detail.findings.filter((f) => f.contractVersion === detail.run.contract.version && (f.severity === 'blocker' || f.severity === 'major') && f.status !== 'resolved' && f.status !== 'disputed');

/** What, if anything, the product is waiting for a person to decide. */
export function pendingDecision(detail, state) {
  const run = detail.run;
  if (run.status === 'awaiting_approval') return { kind: 'contract', ...contractView(detail) };
  if (detail.testRepair && !run.testRepairApproval) {
    const p = detail.testRepair;
    return { kind: 'test_repair', proposalId: p.id, proposalHash: p.hash, repairKind: p.kind, caseIds: p.caseIds, reason: clip(p.reason, 800), evidence: clip(p.evidence, 800), assessment: p.assessment, assertionChanges: p.assertionChanges, patch: clip(p.patch, 4000) };
  }
  if (['blocked', 'awaiting_acceptance'].includes(run.status) && state.repairRounds < LIMITS.maxRepairRounds) {
    const open = openSerious(detail);
    if (open.length) return { kind: 'findings', findings: open.map((f) => findingView(detail, f)), blocker: run.blocker };
  }
  return undefined;
}

/** Applies one decision through the same public methods the page uses. Returns whether a run was queued. */
async function apply(orch, runId, request, decision, state) {
  if (request.kind === 'contract') {
    if (decision.action === 'approve') { orch.approveContract(runId, { contractHash: request.contractHash, acknowledgeWarnings: true }); return true; }
    if (decision.action === 'revise') {
      const run = orch.detail(runId).run, c = decision.contract;
      orch.reviseContract(runId, { requirements: c.requirements ?? run.contract.requirements, acceptanceExamples: c.acceptanceExamples ?? run.contract.acceptanceExamples, interfaces: c.interfaces ?? run.contract.interfaces,
        assumptions: c.assumptions ?? run.contract.assumptions, scope: c.scope ?? run.contract.scope, testPlan: c.testPlan ?? run.contract.testPlan });
      return false;
    }
    return undefined;
  }
  if (request.kind === 'test_repair') {
    if (decision.action === 'approve') { orch.approveTestRepair(runId, request.proposalId, request.proposalHash); return true; }
    orch.rejectTestRepair(runId, request.proposalId, request.proposalHash); return false;
  }
  if (request.kind === 'findings') {
    let confirmed = 0;
    for (const item of decision.findings ?? []) {
      if (item.action === 'confirm') { orch.confirmFinding(runId, item.id, item.proposalHash ? { proposalHash: item.proposalHash } : { manualReason: item.reason }); confirmed++; }
      else if (item.action === 'dispute') orch.disputeFinding(runId, item.id, item.reason);
      else if (item.action === 'resolve') orch.resolveFinding(runId, item.id, { reason: item.reason });
      else if (item.action === 'replay') { orch.replayFinding(runId, item.id, item.proposalHash); await orch.idle(); }
    }
    if (!confirmed) return undefined;
    state.repairRounds++;
    orch.repairFindings(runId);
    return true;
  }
  return undefined;
}

/**
 * Runs one assignment to the end and grades whatever the workspace holds, accepted or not. `decide(request)` answers what the product
 * asks a person; it is awaited without counting toward the automatic time limit. `runtimeFor` is only for tests with scripted agents.
 */
export async function runAssignment({ task, arm, name, model = 'gpt-6-luna', effort = 'medium', data, decide, runtimeFor, log = () => {} }) {
  await mkdir(data, { recursive: true });
  const { work, setup } = await prepare(task, data);
  const store = new Store(path.join(data, 'ai-department.sqlite')), orch = new Orchestrator(store, runtimeFor ?? createRuntimeResolver(data));
  const mode = arm === 'single' ? 'single' : 'verify';
  const interventions = [];
  const state = { repairRounds: 0 };
  try {
    const roles = Object.fromEntries(['planner', 'author', 'developer', 'verifier', 'investigator'].map((role) => [role, { provider: 'codex', model, effort, skills: [] }]));
    const project = { id: `prj_${name}`.replace(/[^A-Za-z0-9_]/g, '_'), name: `${task.title} — ${arm}`, repository: work, version: 1, approved: true, modules: task.modules, protectedPaths: [...DEFAULT_PROTECTED, ...task.protectedPaths],
      checks: [{ id: 'test', command: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json', '--outputFile=.aidept-report.json'], required: true, timeoutMs: 90000, reportPath: '.aidept-report.json' }],
      roles, runnerImage: 'unused-local', setupCommand: ['node', setup], executionMode: 'local', agentNetwork: 'none', guidance: `${GUIDANCE} No subagents.`,
      contextEnabled: false, allowScaffold: false, policyRules: ['Do not change locked tests, SPEC or verification configuration.'], singleBudgetUsd: LIMITS.effectiveCapUsd, currency: 'USD', createdAt: new Date().toISOString() };
    store.projects.put(project);
    const run = orch.createRun({ projectId: project.id, title: `${task.title} / ${arm} / ${name}`, originalRequirement: task.spec, mode, provider: 'codex', budgetUsd: mode === 'single' ? LIMITS.effectiveCapUsd : task.budgetUsd, taskKind: 'feature', signals: task.signals });
    if (Math.abs(run.budgetUsd - LIMITS.effectiveCapUsd) > 1e-8) throw new Error(`Unequal effective budget: ${run.budgetUsd}`);
    let last = Date.now(), automaticMs = 0, limitReached = false, rounds = 0, stoppedByOrchestrator = null;
    orch.startRun(run.id);
    while (true) {
      await pause(1000);
      const detail = orch.detail(run.id), now = Date.now();
      if (['running', 'queued'].includes(detail.run.status)) automaticMs += now - last;
      last = now;
      if (automaticMs >= LIMITS.automaticMs) { orch.stopRun(run.id); await orch.idle(); limitReached = true; break; }
      if (['running', 'queued'].includes(detail.run.status)) continue;
      const request = pendingDecision(detail, state);
      if (!request) break;
      if (rounds++ >= LIMITS.maxDecisionRounds) { stoppedByOrchestrator = 'decision rounds exhausted'; break; }
      log({ event: 'decision_needed', arm, name, kind: request.kind });
      const decision = await decide({ assignment: name, arm, task: task.id, round: rounds, ...request });
      interventions.push({ round: rounds, kind: request.kind, action: decision.action ?? (decision.findings ?? []).map((f) => f.action).join(','), note: decision.note ?? null, at: new Date().toISOString() });
      if (decision.action === 'stop') { stoppedByOrchestrator = decision.note ?? 'stopped by the orchestrator'; break; }
      const queued = await apply(orch, run.id, request, decision, state);
      last = Date.now();
      if (queued === undefined && request.kind !== 'contract') break;
      if (request.kind === 'contract' && decision.action === 'revise') await orch.idle();
    }
    await orch.idle();
    const detail = orch.detail(run.id), workspace = path.join(data, 'workspaces', `${run.id}-A`);
    const grade = await gradeSource(task, workspace);
    const report = await orch.report(run.id).catch(() => undefined);
    const ready = !!detail.completion.ready, graderPass = grade.total > 0 && grade.passed === grade.total, degraded = degradedOf(detail.artifacts);
    const regressionManifest = readRegressionManifest(detail.run, detail.artifacts);
    const replays = detail.findingReplays ?? [];
    const diagnoses = detail.artifacts.filter((a) => a.title === 'Author test diagnosis result').map((a) => { try { return JSON.parse(a.content).decision; } catch { return 'unreadable'; } });
    const evidenceComplete = detail.run.status === 'awaiting_acceptance' && ready && !degraded.items;
    return {
      arm, mode, runId: run.id, status: detail.run.status, blocker: detail.run.blocker, limitReached, stoppedByOrchestrator, automaticMs, reachedDeveloper: detail.attempts.some((a) => a.role === 'developer'),
      readiness: report?.readiness ?? (ready ? 'ready' : 'not_ready'), degraded, evidenceComplete, ready,
      grader: { passed: grade.passed, total: grade.total, failed: grade.failed, loadError: !!grade.loadError }, graderPass, falseReady: ready && !graderPass,
      costUsd: detail.budget.spentUsd, estimatedCost: detail.budget.estimated, attempts: detail.attempts.length, roles: detail.attempts.map((a) => `${a.role}:${a.stage}:${a.status}`), retries: detail.execution?.retries,
      findings: detail.findings.map((f) => ({ id: f.id, severity: f.severity, category: f.category, title: f.title, status: f.status, confirmed: f.confirmed, reproducible: !!f.reproduction, resolution: f.resolution?.kind ?? null })),
      findingsReproduced: new Set(replays.filter((r) => r.status === 'reproduced').map((r) => r.findingId)).size,
      regressionsProposed: new Set(detail.artifacts.filter((a) => a.title === 'Regression proposal').map((a) => { try { return JSON.parse(a.content); } catch { return {}; } }).filter((p) => !p.unsupported && p.trial?.status === 'failed_as_expected').map((p) => p.findingId)).size,
      regressionsCreated: regressionManifest?.entries.length ?? 0,
      authorTestsWrong: { diagnosedAsTestError: diagnoses.filter((d) => d === 'test_setup' || d === 'test_assertion').length, diagnoses: diagnoses.length, proposals: detail.artifacts.filter((a) => a.title === 'Test repair proposal').length, approved: detail.artifacts.filter((a) => a.title === 'Test repair receipt').length },
      interventions, repairRounds: state.repairRounds, completionReasons: detail.completion.reasons, usageTokens: detail.run.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0),
    };
  } finally { store.close(); }
}

/** Counts per arm that the report shows side by side; every denominator is the number of runs of that arm. */
export function summarizeRows(rows) {
  const arms = [...new Set(rows.map((r) => r.arm))];
  return arms.map((arm) => {
    const mine = rows.filter((r) => r.arm === arm), sum = (f) => mine.reduce((n, r) => n + (f(r) ?? 0), 0);
    return {
      arm, runs: mine.length, graderPass: mine.filter((r) => r.graderPass).length, evidenceComplete: mine.filter((r) => r.evidenceComplete).length, falseReady: mine.filter((r) => r.falseReady).length,
      findingsReproduced: sum((r) => r.findingsReproduced), regressionsCreated: sum((r) => r.regressionsCreated), authorTestsWrong: sum((r) => r.authorTestsWrong?.diagnosedAsTestError),
      interventions: sum((r) => r.interventions?.length), meanMinutes: mine.length ? sum((r) => r.automaticMs) / mine.length / 60000 : 0, meanCostUsd: mine.length ? sum((r) => r.costUsd) / mine.length : 0,
      blocked: mine.filter((r) => r.status === 'blocked').length, failed: mine.filter((r) => r.status === 'failed').length, scoreMean: mine.length ? sum((r) => (r.grader.total ? r.grader.passed / r.grader.total : 0)) / mine.length : 0,
    };
  });
}

export function renderReport(protocol, rows, adjudications = []) {
  const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1), pct = (n) => `${Math.round(n * 100)}%`;
  const out = [`# Kiểm tra ban đầu chính sách v4: Department và Single (${rows.length}/${protocol.assignments.length} lượt)`, '',
    `Khóa protocol: \`${protocol.protocolHash.slice(0, 12)}\` lúc ${protocol.lockedAt}. Model \`${protocol.model}\` (${protocol.effort}) cho mọi vai; trần hiệu lực $${protocol.effectiveCapUsd}/lượt; tối đa ${protocol.automaticLimitMinutes} phút tự động mỗi lượt.`,
    '**Dữ liệu tổng hợp do AI viết** (task, reference, grader, mutant) và các quyết định duyệt do AI điều phối đưa ra theo SPEC đã khóa. Đây là kiểm tra ban đầu với 12 lượt: chưa đủ kết luận ưu thế tổng quát, và kết quả không được chọn theo việc Department thắng hay thua.', '',
    '## Theo nhánh', '', '| Nhánh | Lượt | Đạt grader | Hoàn tất đủ bằng chứng | Lỗi lọt khi báo sẵn sàng | Finding tái hiện | Regression tạo | Test Author sai | Lượt can thiệp | Phút TB | Chi phí TB | Điểm grader TB |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const s of summarizeRows(rows)) out.push(`| ${s.arm} | ${s.runs} | ${s.graderPass}/${s.runs} | ${s.evidenceComplete}/${s.runs} | ${s.falseReady} | ${s.findingsReproduced} | ${s.regressionsCreated} | ${s.authorTestsWrong} | ${s.interventions} | ${f1(s.meanMinutes)} | $${s.meanCostUsd.toFixed(2)} | ${pct(s.scoreMean)} |`);
  out.push('', '## Từng lượt', '', '| Lượt | Nhánh | Trạng thái | Grader | Đủ bằng chứng | Báo sẵn sàng mà grader fail | Finding tái hiện | Regression | Test Author sai | Can thiệp | Phút | Chi phí |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) out.push(`| ${r.assignmentId} | ${r.arm} | ${r.status}${r.limitReached ? ' (hết 30 phút)' : ''}${r.stoppedByOrchestrator ? ' (điều phối dừng)' : ''} | ${r.grader.passed}/${r.grader.total} | ${r.evidenceComplete ? 'có' : 'không'} | ${r.falseReady ? '**có**' : 'không'} | ${r.findingsReproduced} | ${r.regressionsCreated} | ${r.authorTestsWrong?.diagnosedAsTestError ?? 0} | ${r.interventions?.length ?? 0} | ${f1(r.automaticMs / 60000)} | $${(r.costUsd ?? 0).toFixed(2)} |`);
  const failedGrader = rows.filter((r) => r.grader.failed?.length);
  if (failedGrader.length) { out.push('', '## Test grader không đạt (điểm gốc giữ nguyên)', ''); for (const r of failedGrader) out.push(`- ${r.assignmentId}: ${r.grader.failed.slice(0, 8).join('; ')}`); }
  if (adjudications.length) { out.push('', '## Thẩm định lỗi grader riêng (không đổi điểm gốc)', ''); for (const a of adjudications) out.push(`- ${a.assignmentId} — ${a.test}: ${a.verdict}. ${a.reason}`); }
  const notes = rows.filter((r) => r.interventions?.length);
  if (notes.length) { out.push('', '## Quyết định của người điều phối', ''); for (const r of notes) for (const i of r.interventions) out.push(`- ${r.assignmentId} #${i.round} ${i.kind}: ${i.action}${i.note ? ` — ${i.note}` : ''}`); }
  out.push('', '## Giới hạn', '', '- 3 task × 2 nhánh × 2 lần: khoảng tin cậy rất rộng; không dùng để kết luận chung.', '- Task, grader và quyết định duyệt đều do AI tạo ra; grader được audit theo SPEC và thử bằng lỗi cấy trước khi chạy nhưng chưa có người độc lập xác nhận.', '- Single có Planner và một vai viết code/test/tự review; không có Author hay Verifier độc lập và không có finding/regression, nên các cột đó chỉ có nghĩa với Department.');
  return out.join('\n');
}
