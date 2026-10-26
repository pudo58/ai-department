import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalRuntime } from '../src/runtime/local.js';
import { Store } from '../src/server/store.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { buildApp } from '../src/server/app.js';
import type { AgentExecution } from '../src/runtime/types.js';
import type { ProjectProfile, Run } from '../src/shared/types.js';
import type { TaskContract } from '../src/shared/types.js';
import { RISK_GROUPS, type TestPlan } from '../src/shared/quality.js';
import type { FindingReproduction } from '../src/shared/reproduction.js';
import { identityId } from '../src/core/testids.js';
import { profile } from './helpers.js';
import { fence } from './quality-fixtures.js';

export const REQUIREMENT = 'blockedBy identifies the first unsuccessful dependency in dependsOn order.';
export const TITLE = 'blockedBy names the wrong dependency after two cancellations';

/** The scheduler with the PulseGraph defect (a blocked job is never revisited) and the corrected one. */
export const schedulerSource = (fixed: boolean): string =>
  `export function createScheduler(){const jobs=new Map();return {submit(x){jobs.set(x.id,{...x,status:'ready'});return {token:1}},cancel(id){jobs.get(id).status='cancelled';for(const j of jobs.values()){${fixed ? "if(j.status==='cancelled')continue;" : "if(j.status==='blocked'||j.status==='cancelled')continue;"}const bad=(j.dependsOn??[]).find(d=>jobs.get(d).status==='cancelled');if(bad){j.status='blocked';j.blockedBy=bad}}},get(id){return structuredClone(jobs.get(id))}}}`;

export const scenario = (): FindingReproduction => ({
  schemaVersion: 1, adapter: 'node-api', module: 'src/scheduler.js', factory: 'createScheduler', args: [],
  oracle: { references: [{ requirementId: 'R-1', quote: REQUIREMENT }], explanation: 'After B and then A are cancelled, A is the first unsuccessful dependency of C in dependsOn order.' },
  steps: [
    { id: 'S-1', method: 'submit', args: [{ id: 'A' }] }, { id: 'S-2', method: 'submit', args: [{ id: 'B' }] },
    { id: 'S-3', method: 'submit', args: [{ id: 'C', dependsOn: ['A', 'B'] }] },
    { id: 'S-4', method: 'cancel', args: ['B'] }, { id: 'S-5', method: 'cancel', args: ['A'] },
    { id: 'S-6', method: 'get', args: ['C'], expect: { path: ['blockedBy'], equals: 'A' } },
  ],
});

export const plan = (): TestPlan => ({
  schemaVersion: 2, reasoningVersion: 1, statefulModelVersion: 1,
  cases: [{
    id: 'C-1', requirementIds: ['R-1'], group: 'state', risk: 'blockedBy names the wrong dependency', priority: 'high', preconditions: 'Jobs A, B and C (dependsOn A, B) are submitted', actions: 'Cancel B', expected: 'C is blocked by B', method: 'automated', required: true,
    oracle: { references: [{ requirementId: 'R-1', quote: REQUIREMENT }], explanation: 'The requirement says which dependency blockedBy names.' },
    invariants: ['blockedBy always names a cancelled dependency of the job'],
    steps: [
      { id: 'S-1', before: 'nothing submitted', after: 'A, B and C ready', requirementIds: ['R-1'], action: 'submit A, B and C', expected: 'C is ready' },
      { id: 'S-2', before: 'A, B and C ready', after: 'B cancelled and C blocked', requirementIds: ['R-1'], action: 'cancel B', expected: 'C is blocked by B' },
    ],
  }],
  notApplicable: RISK_GROUPS.filter(g => g !== 'state').map(group => ({ group, reason: 'The fixture exercises one scheduler transition only.' })), questions: [],
});

const vitestUrl = (): string => pathToFileURL(path.resolve('node_modules/vitest/dist/index.js')).href;
export const authorTest = (wrong = false): string => `import {it,expect} from ${JSON.stringify(vitestUrl())};\nimport {createScheduler} from '../src/scheduler.js';\nit('[R-1][C-1] blocked metadata',()=>{\n const s=createScheduler();\n s.submit({id:'A'});\n s.submit({id:'B'});\n s.submit({id:'C',dependsOn:['A','B']});\n expect(s.get('C').status).toBe('ready');\n s.cancel('B');\n expect(s.get('C').blockedBy).toBe('${wrong ? 'A' : 'B'}');\n});\n`;
export const authorEntries = (p: TestPlan = plan(), wrong = false, file = 'tests/scheduler.test.js') => {
  const identity = { kind: 'json' as const, file, titles: ['[R-1][C-1] blocked metadata'] };
  const expressions: Record<string, string> = { 'S-1': "expect(s.get('C').status).toBe('ready')", 'S-2': `expect(s.get('C').blockedBy).toBe('${wrong ? 'A' : 'B'}')` };
  return p.cases.map(c => ({ caseId: c.id, requirementIds: c.requirementIds, recipeId: 'test', path: file, identity, testId: identityId(identity), assertions: c.steps!.map(s => ({ stepId: s.id!, expected: s.expected, expression: expressions[s.id!]! })) }));
};

export interface V4Options {
  /** Does the Verifier report the defect (with a runnable counterexample)? */
  finding?: 'reproducible' | 'none' | 'prose';
  /** Does the Developer repair the scheduler when asked? */
  fix?: boolean;
  project?: Partial<ProjectProfile>;
  /** Replace what the planning Author answers (for strictness tests). */
  planReply?: (contract: TaskContract) => string;
  /** Extra behaviour for the Author's diagnosis turn. */
  diagnosis?: (x: AgentExecution, dir: string, calls: string[]) => string | undefined;
  /** Command line left out of the project's checks so no Vitest recipe exists. */
  noVitest?: boolean;
  /** The Author's test asserts something the contract contradicts, so the first check fails on the test, not the code. */
  wrongAssertion?: boolean;
  /** What the Verifier's final answer looks like when it does not simply pass or block. */
  verdict?: 'abstain' | 'garbage';
  /** Extra edits the Developer makes in its working copy on every turn. */
  developerExtra?: (dir: string, repair: boolean) => void;
  /** Puts files into the project folder before the first run starts (for example a regression an earlier run delivered). */
  preinstall?: (source: string) => void;
  /** Which test files the project's Vitest picks up. */
  include?: string;
}

const dirs: string[] = [];
/** Test files register this with `afterEach`; the browser fixture, which runs outside Vitest, simply never calls it. */
export function cleanupFixtures(): void { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }

export async function v4Fixture(options: V4Options = {}) {
  const source = mkdtempSync(path.join(tmpdir(), 'aidept-v4-src-')), dataDir = mkdtempSync(path.join(tmpdir(), 'aidept-v4-data-'));
  dirs.push(source, dataDir);
  mkdirSync(path.join(source, 'src')); mkdirSync(path.join(source, 'tests'));
  writeFileSync(path.join(source, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(source, 'src/scheduler.js'), 'export function createScheduler(){throw Error("stub")}');
  writeFileSync(path.join(source, 'vitest.config.mjs'), `export default {test:{include:[${JSON.stringify(options.include ?? 'tests/**/*.test.js')}],maxWorkers:1,fileParallelism:false}};`);
  options.preinstall?.(source);
  const calls: string[] = [];
  const finding = options.finding ?? 'reproducible';
  const vitestCommand = [process.execPath, path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--configLoader', 'runner', '--reporter=json', '--outputFile=.aidept-report.json'];
  class Scripted extends LocalRuntime {
    override async prepare(run: Run, slot: 'A' | 'B', onEvent?: Parameters<LocalRuntime['prepare']>[2]) {
      const prepared = await super.prepare(run, slot, onEvent);
      // The generated tests import "vitest" like any project test does; the fixture project has no install, so point it at this repository's.
      const link = path.join(this.workspacePath(run, slot), 'node_modules', 'vitest');
      if (!existsSync(link)) symlinkSync(path.resolve('node_modules/vitest'), link, 'junction');
      return prepared;
    }
    override async runAgent(x: AgentExecution) {
      const dir = this.workspacePath(x.run, 'A');
      let output = '';
      const tag = x.prompt.includes('Author lập kế hoạch') ? 'author:plan' : x.prompt.includes('Author chẩn đoán') ? 'author:diagnose' : `${x.role}`;
      calls.push(tag);
      if (x.role === 'planner') output = fence({ requirements: [{ id: 'R-1', text: REQUIREMENT, required: true, manual: false }], acceptanceExamples: ['cancel B then A: blockedBy is A'], interfaces: ['createScheduler()'], assumptions: [], scope: [] });
      else if (tag === 'author:plan') output = options.planReply ? options.planReply(x.run.contract) : fence(plan());
      else if (tag === 'author:diagnose') output = options.diagnosis?.(x, dir, calls) ?? fence({ decision: 'implementation', reason: 'x', evidence: 'x', caseIds: ['C-1'] });
      else if (x.role === 'author') {
        // A later run on the same project writes its own test file; the first run's test was delivered with its fix.
        const file = x.run.title === 'Scheduler blockedBy' ? 'tests/scheduler.test.js' : 'tests/scheduler-later.test.js';
        mkdirSync(path.join(dir, 'tests'), { recursive: true }); writeFileSync(path.join(dir, file), authorTest(options.wrongAssertion));
        output = fence({ entries: authorEntries(x.run.contract.testPlan ?? plan(), options.wrongAssertion, file) });
      } else if (x.role === 'developer') {
        const repair = options.fix !== false && x.prompt.includes('Recompute blockedBy');
        mkdirSync(path.join(dir, 'src'), { recursive: true }); writeFileSync(path.join(dir, 'src/scheduler.js'), schedulerSource(repair));
        options.developerExtra?.(dir, repair);
        output = fence({ reuse: [] });
      } else if (x.role === 'verifier') {
        const fixed = readFileSync(path.join(dir, 'src/scheduler.js'), 'utf8').includes("if(j.status==='cancelled')continue;");
        if (options.verdict === 'garbage') output = 'không có khối json';
        else if (options.verdict === 'abstain') output = fence({ decision: 'abstain', findings: [] });
        else if (fixed || finding === 'none') output = fence({ decision: 'pass', findings: [] });
        else output = fence({ decision: 'block', findings: [{ category: 'behavior', severity: 'major', title: TITLE, location: 'src/scheduler.js:1', evidence: 'Cancel B then A: C stays blocked by B.', suggestion: 'Recompute blockedBy for every non-cancelled job on each cancellation.',
          ...(finding === 'reproducible' ? { reproduction: scenario() } : { reproductionLimitation: 'Chưa viết được kịch bản chạy được.' }) }] });
      }
      return { output, usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costUsd: 0.001 } };
    }
  }
  const store = new Store(':memory:'), runtime = new Scripted({ dataDir });
  store.projects.put(profile({
    repository: source, executionMode: 'local',
    checks: [{ id: 'test', command: options.noVitest ? [process.execPath, '-e', 'process.exit(0)'] : vitestCommand, required: true, reportPath: '.aidept-report.json', timeoutMs: 60000 }],
    ...options.project,
  }));
  const orch = new Orchestrator(store, () => runtime);
  const create = (title = 'Scheduler blockedBy') => orch.createRun({ projectId: 'prj_test', title, originalRequirement: REQUIREMENT, mode: 'verify', provider: 'codex', budgetUsd: 20, signals: [] });
  const approve = async (id: string) => { orch.approveContract(id, { contractHash: orch.detail(id).contractReview.contractHash, acknowledgeWarnings: true }); await orch.idle(); };
  const run = create();
  orch.startRun(run.id); await orch.idle();
  const app = async () => {
    const built = await buildApp({ store, orchestrator: orch, dataDir, port: 14361 });
    const session = await built.inject({ url: '/api/session', headers: { host: '127.0.0.1:14361' } });
    const headers = { host: '127.0.0.1:14361', 'x-csrf-token': session.json().token };
    const post = (url: string, payload: unknown = {}) => built.inject({ method: 'POST', url, headers, payload: payload as object });
    return { built, post, close: () => built.close() };
  };
  return { store, runtime, orch, run, source, dataDir, calls, create, approve, app, workspace: () => runtime.workspacePath(orch.detail(run.id).run, 'A') };
}
