import type { ProjectProfile, Role, RoleConfig, Run } from '../src/shared/types.js';
import { FakeRuntime, type FakeOptions } from '../src/runtime/fake.js';
import type { RuntimeCheckResult } from '../src/runtime/types.js';
import { Orchestrator, type CreateRunInput } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import { DEFAULT_PROTECTED } from '../src/core/scope.js';

const roles = Object.fromEntries((['planner', 'author', 'developer', 'verifier', 'investigator'] as Role[])
  .map((r) => [r, { provider: 'codex', model: '', effort: 'medium', skills: [] } satisfies RoleConfig])) as unknown as Record<Role, RoleConfig>;

export const profile = (overrides: Partial<ProjectProfile> = {}): ProjectProfile => ({
  id: 'prj_test', name: 'Demo', repository: '/repo', version: 1, approved: true, modules: ['src', 'tests'], protectedPaths: DEFAULT_PROTECTED,
  checks: [{ id: 'test', command: ['npm', 'test'], required: true, timeoutMs: 60_000, reportPath: '.aidept-report.json' }],
  roles, runnerImage: 'node:24', setupCommand: [], agentNetwork: 'none', policyRules: [], singleBudgetUsd: 5, currency: 'USD', createdAt: new Date().toISOString(),
  ...overrides,
});

export const report = (tests: { title: string; status?: 'passed' | 'failed' }[]) => ({
  testResults: [{ name: 'suite.test.ts', status: tests.some((t) => t.status === 'failed') ? 'failed' : 'passed',
    assertionResults: tests.map((t) => ({ fullName: t.title, title: t.title, status: t.status ?? 'passed' })) }],
});
export const green: Partial<RuntimeCheckResult> = { exitCode: 0, incomplete: false, log: 'ok', report: report([{ title: '[R-1] works' }]) };
export const red: Partial<RuntimeCheckResult> = { exitCode: 1, incomplete: false, log: 'boom', report: report([{ title: '[R-1] works', status: 'failed' }]) };

export function setup(fake: FakeOptions = {}, project: Partial<ProjectProfile> = {}) {
  const store = new Store(':memory:');
  const runtime = new FakeRuntime(fake);
  const orchestrator = new Orchestrator(store, () => runtime);
  store.projects.put(profile(project));
  const create = (input: Partial<CreateRunInput> = {}): Run => orchestrator.createRun({
    projectId: 'prj_test', title: 'Ngăn đơn trùng', originalRequirement: 'Không tạo đơn trùng khi retry.', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [], ...input,
  });
  /** Drives a run from creation through contract approval until it next waits for a person. */
  const drive = async (run: Run): Promise<Run> => {
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id); await orchestrator.idle();
    return store.runs.get(run.id)!;
  };
  return { store, runtime, orchestrator, create, drive };
}
