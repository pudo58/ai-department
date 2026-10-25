import { RISK_GROUPS } from '../shared/quality.js';
import type { DeliveryResult, DeliveryTarget, Run, Slot } from '../shared/types.js';
import { notAnalyzed, type AnalysisTool, type ToolReport } from '../core/tools.js';
import type { AgentExecution, AgentResult, CheckExecution, ChangeSet, PrepareResult, Runtime, RuntimeCheckResult } from './types.js';

export interface FakeOptions {
  /** Files the developer (and author) "modifies". Default: one file inside src; a test file inside src for the author. */
  files?: string[] | ((execution: AgentExecution) => string[]);
  /** Overrides the canned reply for a role. */
  reply?: (execution: AgentExecution) => string | undefined;
  /** Scripts check results; by default every check is incomplete because nothing real ran. */
  check?: (execution: CheckExecution, call: number) => Partial<RuntimeCheckResult> | undefined;
  tool?: (tool: AnalysisTool, ref: 'base' | 'candidate') => ToolReport | undefined;
  /** Files any role leaves behind in the working copy (e.g. a reviewer's test output). */
  strayFiles?: (execution: AgentExecution) => string[] | undefined;
  /** Files the simulated base snapshot contains (for scaffolding rules). */
  baseFiles?: string[];
  delayMs?: number;
  /** Makes each check take this long, so a test can observe it while it is "running". */
  checkDelayMs?: number;
  throwOnAgent?: (execution: AgentExecution) => Error | undefined;
}

const fence = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/**
 * Deterministic stand-in for the Docker runtime. It exercises the workflow only: it never edits a
 * repository and, unless a test scripts it, never produces passing evidence.
 */
export class FakeRuntime implements Runtime {
  readonly name = 'fake';
  readonly calls: string[] = [];
  private dirty = new Map<string, string[]>();
  private commits = 0;
  private checkCalls = 0;
  private aborts = new Map<string, AbortController>();
  constructor(private readonly options: FakeOptions = {}) {}

  private key = (run: Run, slot: Slot) => `${run.id}:${slot}`;
  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Execution interrupted'));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Execution interrupted')); }, { once: true });
    });
  }

  async prepare(run: Run, slot: Slot): Promise<PrepareResult> {
    this.calls.push(`prepare:${slot}`);
    return { baseSha: 'fake-base', branch: `aidept/${run.id}-${slot}`, warnings: [] };
  }

  async runAgent(exec: AgentExecution): Promise<AgentResult> {
    this.calls.push(`agent:${exec.role}:${exec.attempt.slot}`);
    const failure = this.options.throwOnAgent?.(exec);
    if (failure) throw failure;
    const controller = new AbortController();
    this.aborts.set(exec.attempt.id, controller);
    exec.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    try { await this.wait(this.options.delayMs ?? 0, controller.signal); } finally { this.aborts.delete(exec.attempt.id); }
    const writes = exec.role === 'developer' || (exec.role === 'author' && !exec.prompt.includes('Author lập kế hoạch ca kiểm thử CHỈ ĐỌC'));
    const files = writes ? (typeof this.options.files === 'function' ? this.options.files(exec) : this.options.files) : undefined;
    const output = this.options.reply?.(exec) ?? this.defaultReply(exec, files);
    exec.onEvent?.({ type: 'provider.raw', message: JSON.stringify({ type: 'fake', role: exec.role }) });
    // The final message in the same shape Codex emits, so code that reads raw provider output is exercised too.
    exec.onEvent?.({ type: 'provider.raw', message: JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: output } }) });
    if (exec.role === 'developer' || (exec.role === 'author' && !exec.prompt.includes('Author lập kế hoạch ca kiểm thử CHỈ ĐỌC'))) {
      // Verify mode lets the Author add test files only, so the simulated one writes a test beside the Developer's file.
      this.dirty.set(this.key(exec.run, exec.attempt.slot), files ?? [exec.role === 'author' ? 'src/simulated.test.ts' : 'src/simulated.ts']);
    }
    const stray = this.options.strayFiles?.(exec);
    if (stray?.length) this.dirty.set(this.key(exec.run, exec.attempt.slot), [...(this.dirty.get(this.key(exec.run, exec.attempt.slot)) ?? []), ...stray]);
    return { output, sessionId: `fake-session-${exec.attempt.id}`, usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 200, costUsd: 0.01 } };
  }

  private defaultReply(exec: AgentExecution, files?: string[]): string {
    const { run, role, prompt } = exec;
    if (prompt.includes('diễn giải yêu cầu một cách độc lập')) {
      return `Diễn giải mô phỏng.\n${fence({ interpretation: `Cách hiểu mô phỏng của ${role}.`, questions: [] })}`;
    }
    if (prompt.includes('Author lập kế hoạch ca kiểm thử CHỈ ĐỌC')) {
      const cases = run.contract.requirements.map((r, i) => ({ id: `C-${i + 1}`, requirementIds: [r.id], group: 'happy', risk: 'Mô phỏng rủi ro', priority: 'normal', preconditions: 'Fixture', actions: r.text, expected: 'Kết quả fixture', method: r.manual ? 'manual' : 'automated', required: r.required, ...((run.qualityPolicyVersion ?? 0) >= 2 ? { oracle: { references: [{ requirementId: r.id, quote: r.text }], explanation: 'Fixture mô phỏng, không xác nhận ngữ nghĩa.' } } : {}) }));
      return fence({ schemaVersion: (run.qualityPolicyVersion ?? 0) >= 2 ? 2 : 1, ...(run.qualityPolicyVersion===3?{reasoningVersion:1}:{}), cases:cases.map(c=>({...c,...(run.qualityPolicyVersion===3?{steps:[{id:'S-1',before:'Fixture before',after:'Fixture after',requirementIds:c.requirementIds,action:c.actions,expected:c.expected}]}:{})})), notApplicable: RISK_GROUPS.filter(g => g !== 'happy').map(group => ({ group, reason: 'Fixture mô phỏng; không kiểm chứng nghiệp vụ.' })), questions: [] });
    }
    if (role === 'author' && run.qualityPolicyVersion) {
      return fence({ entries: (run.contract.testPlan?.cases ?? []).filter(c => c.method === 'automated').map(c => ({ caseId: c.id, requirementIds: c.requirementIds, recipeId: run.configSnapshot.checks.find(r => r.reportPath)?.id ?? 'test', path: files?.[0] ?? 'src/simulated.test.ts', ...(run.qualityPolicyVersion===3?{assertions:(c.steps??[]).map(s=>({stepId:s.id!,expected:s.expected,expression:'expect(true).toBe(true)'}))}:{}), testId: `suite.test.ts::[${c.requirementIds[0]}][${c.id}] works`, ...((run.qualityPolicyVersion ?? 0) >= 2 ? { identity: { kind: 'json', file: files?.[0] ?? 'src/simulated.test.ts', titles: [`[${c.requirementIds[0]}][${c.id}] works`] } } : {}) })) });
    }
    if (role === 'planner') {
      return `Hợp đồng mô phỏng.\n${fence({ requirements: run.contract.requirements, acceptanceExamples: run.contract.acceptanceExamples, interfaces: [], assumptions: ['Mô phỏng: chưa có agent thật.'], scope: run.contract.scope })}`;
    }
    if (role === 'verifier') return `Không phát hiện lỗi (mô phỏng).\n${fence({ decision: 'pass', findings: [] })}`;
    return `Đã triển khai (mô phỏng).\n${fence({ reuse: [{ path: 'src/', fit: 'partial', decision: 'new', reason: 'Mô phỏng: không khảo sát repository.' }] })}`;
  }

  async changes(run: Run, slot: Slot): Promise<ChangeSet> {
    const files = this.dirty.get(this.key(run, slot)) ?? [];
    return { files, patch: files.map((f) => `--- a/${f}\n+++ b/${f}\n@@ simulated @@`).join('\n') };
  }
  async commit(run: Run, slot: Slot): Promise<string> {
    const files = this.dirty.get(this.key(run, slot)) ?? [];
    this.committed.set(this.key(run, slot), [...new Set([...(this.committed.get(this.key(run, slot)) ?? []), ...files])]);
    this.dirty.delete(this.key(run, slot));
    const checkpoint = `fake-${++this.commits}`;
    this.heads.set(this.key(run, slot), checkpoint);
    return checkpoint;
  }
  private heads = new Map<string, string>();
  private committed = new Map<string, string[]>();
  /** Every file ever committed in this slot, as one "added" line each: enough to exercise the acceptance report. */
  async diffSinceBase(run: Run, slot: Slot) {
    const files = (this.committed.get(this.key(run, slot)) ?? []).map((path) => ({ path, added: 1, removed: 0, status: 'added' as const }));
    return { files, patch: files.map((f) => `diff --git a/${f.path} b/${f.path}\n+++ b/${f.path}\n+simulated`).join('\n') };
  }
  async baseFiles(): Promise<string[]> { return this.options.baseFiles ?? []; }

  deliveryTarget = (run: Run, slot: Slot): DeliveryTarget => ({ kind: 'branch', target: `aidept/${run.id}-${slot}` });
  /** Scripted receipt only: a run whose provider is fake still cannot pass the acceptance gates. */
  async deliver(run: Run, slot: Slot): Promise<DeliveryResult> {
    this.calls.push(`deliver:${slot}`);
    const target = this.deliveryTarget(run, slot);
    return { ...target, summary: `Mô phỏng giao branch ${target.target}` };
  }

  async revert(run: Run, slot: Slot): Promise<void> {
    this.calls.push(`revert:${slot}`);
    this.dirty.delete(this.key(run, slot));
  }

  async applyPatch(run: Run, slot: Slot, patch: string): Promise<void> {
    this.calls.push(`applyPatch:${slot}`);
    this.dirty.set(this.key(run, slot), [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]!));
  }

  async runCheck(exec: CheckExecution): Promise<RuntimeCheckResult> {
    const call = ++this.checkCalls;
    this.calls.push(`check:${exec.recipe.id}:${exec.ref}`);
    if (this.options.checkDelayMs) {
      exec.onEvent?.({ type: 'log', message: '✔ [R-1] mô phỏng test đầu tiên (1ms)', data: { source: `check:${exec.recipe.id}`, level: 'info' } });
      await new Promise((resolve) => setTimeout(resolve, this.options.checkDelayMs));
    }
    const scripted = this.options.check?.(exec, call);
    const base: RuntimeCheckResult = { exitCode: 0, log: 'Mô phỏng: không chạy test thật.', durationMs: 1, checkpoint: this.heads.get(this.key(exec.run, exec.slot)) ?? exec.run.checkpoint ?? 'fake-base', incomplete: true };
    return { ...base, ...scripted };
  }

  async runTool(_run: Run, _slot: Slot, tool: AnalysisTool, ref: 'base' | 'candidate'): Promise<ToolReport> {
    return this.options.tool?.(tool, ref) ?? notAnalyzed(tool, 'Mô phỏng: công cụ phân tích không chạy.');
  }

  async stop(attemptId: string): Promise<void> { this.aborts.get(attemptId)?.abort(); }
  async dispose(): Promise<void> { /* nothing to clean */ }
}
