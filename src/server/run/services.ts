import { randomUUID } from 'node:crypto';
import type { Artifact, Attempt, Independence, MemoryItem, Role, Run, RunningCheck, Slot, Stage, UsageRecord } from '../../shared/types.js';
import { budgetState, remainingFor } from '../../core/budget.js';
import { sha256 } from '../../core/contract.js';
import { contextRoleOf, selectContext } from '../../core/context.js';
import { staleReason } from '../../core/memory.js';
import { buildRepoMap } from '../../core/repomap.js';
import { redactSecrets } from '../../runtime/process.js';
import { describeProviderLine, type LogLevel } from '../../runtime/describe.js';
import type { Runtime, RuntimeEvent } from '../../runtime/types.js';
import { Semaphore } from '../scheduler.js';
import type { Store } from '../store.js';
import { RESUMES_SESSIONS } from '../../shared/providers.js';
import { skillPromptBlock } from '../../core/skills.js';
import type { ResolvedSkill } from '../../runtime/types.js';
import type { SkillLibrary } from '../../runtime/skilllibrary.js';
import { HttpError, Blocked, Stopped } from './support.js';

export type SkillDelivery = 'plugin' | 'workspace' | 'prompt';
export interface SkillUse { name: string; hash: string; delivery: SkillDelivery; hasScripts: boolean }
/** Only the local runtime (and the fake one standing in for it) can place skill folders where a CLI finds them. */
export const skillDelivery = (provider: Attempt['provider'], runtimeName: string): SkillDelivery =>
  runtimeName !== 'local' && runtimeName !== 'fake' ? 'prompt' : provider === 'claude' ? 'plugin' : provider === 'codex' ? 'workspace' : 'prompt';

/**
 * What every stage of a run needs: the store, the runtime, the clock, and the small helpers that read and change a run,
 * write its timeline and console, and run one agent attempt. It holds the in-memory state shared between stages.
 */
export class RunServices {
  readonly agents: Semaphore;
  /** The check that is executing right now, per run, so the UI can show the test program while it runs. */
  readonly runningChecks = new Map<string, RunningCheck>();
  readonly sessions = new Map<string, { sessionId: string; cumulative?: import('../../runtime/providers.js').UsageCheckpoint }>();
  readonly baseFileCache = new Map<string, ReadonlySet<string>>();

  constructor(readonly store: Store, readonly runtimeFor: (run: Run) => Runtime, readonly now: () => Date, agentSlots: number, private readonly heartbeatMs: number, readonly skills?: SkillLibrary) {
    this.agents = new Semaphore(agentSlots);
  }

  run(id: string): Run {
    const run = this.store.runs.get(id);
    if (!run) throw new HttpError(404, 'Run không tồn tại.');
    return run;
  }

  mutate(id: string, change: (r: Run) => void): Run {
    const run = this.run(id);
    change(run);
    run.updatedAt = this.stamp();
    return this.store.runs.put(run);
  }

  guard<T>(fn: () => T): T {
    try { return fn(); } catch (error) { throw new HttpError(400, (error as Error).message); }
  }

  log(runId: string, type: string, message: string, data?: unknown): void { this.store.addEvent(runId, type, message, data); }

  /** Console line that is not a timeline event (process output, agent activity, heartbeats). */
  emit(runId: string, source: string, level: LogLevel, message: string, attemptId?: string): void {
    this.store.logs.append({ runId, source, level, message, attemptId });
  }

  /** Adapts runtime `{type:'log'}` events (setup/check output, agent stderr) into console lines. */
  runtimeLog(runId: string, fallbackSource: string, attemptId?: string): (event: RuntimeEvent) => void {
    return (event) => {
      if (event.type !== 'log') return;
      const data = (event.data ?? {}) as { source?: string; level?: LogLevel };
      this.emit(runId, data.source ?? fallbackSource, data.level ?? 'info', event.message, attemptId);
    };
  }

  /**
   * A silent five-minute `npm ci` is indistinguishable from a hang. While a long step runs, say so periodically
   * with the elapsed time, and record how long it took when it ends.
   */
  async withHeartbeat<T>(runId: string, source: string, label: string, work: () => Promise<T>, attemptId?: string): Promise<T> {
    const started = Date.now();
    const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
    this.emit(runId, source, 'info', `${label}: bắt đầu`, attemptId);
    const timer = setInterval(() => this.emit(runId, source, 'info', `${label}: vẫn đang chạy (${elapsed()})`, attemptId), this.heartbeatMs);
    try {
      const result = await work();
      this.emit(runId, source, 'info', `${label}: xong sau ${elapsed()}`, attemptId);
      return result;
    } catch (error) {
      this.emit(runId, source, 'error', `${label}: dừng sau ${elapsed()} — ${(error as Error).message.slice(0, 300)}`, attemptId);
      throw error;
    } finally { clearInterval(timer); }
  }

  stamp(): string { return this.now().toISOString(); }

  baseArtifact(runId: string, a: { kind: Artifact['kind']; title: string; content: string; checkpoint: string | null; attemptId?: string; valid?: boolean }): Artifact {
    return {
      id: `art_${randomUUID().slice(0, 8)}`, runId, attemptId: a.attemptId, kind: a.kind, title: a.title, content: a.content, hash: sha256(a.content),
      checkpoint: a.checkpoint, contractVersion: this.run(runId).contract.version, valid: a.valid ?? true, createdAt: this.stamp(),
    };
  }

  artifact(runId: string, a: Parameters<RunServices['baseArtifact']>[1]): Artifact { return this.store.artifacts.put(this.baseArtifact(runId, a)); }

  async attempt(runId: string, input: {
    role: Role; stage: Stage; slot: Slot; prompt: string; signal: AbortSignal; independence?: Independence;
    resumeSession?: { sessionId: string; cumulative?: import('../../runtime/providers.js').UsageCheckpoint };
    /** The independent interpreter reads the requirement alone: no project skills, like no project context. */
    noSkills?: boolean;
  }): Promise<{ output: string; attempt: Attempt }> {
    const run = this.run(runId);
    if (input.signal.aborted) throw new Stopped();
    const state = budgetState(run, this.store.attempts.list(runId));
    if (remainingFor(state, input.stage) <= 0) throw new Blocked(`Hết ngân sách cho giai đoạn "${input.stage}" (${state.spentUsd.toFixed(2)}/${state.capUsd.toFixed(2)} USD). Chưa hoàn thành.`);
    const config = run.configSnapshot.roles[input.role];
    const attempt: Attempt = {
      id: `att_${randomUUID().slice(0, 8)}`, runId, slot: input.slot, independence: input.independence, role: input.role, stage: input.stage,
      provider: run.provider === 'fake' ? 'fake' : config.provider, model: config.model || 'default', status: 'running', startedAt: this.stamp(),
      checkpoint: run.checkpoint, contractVersion: run.contract.version,
    };
    this.store.attempts.put(attempt);
    this.mutate(runId, (r) => { r.stage = input.stage; });
    this.log(runId, 'attempt.start', `${input.role} (${input.slot}) bắt đầu ở giai đoạn ${input.stage}.`, { attempt: attempt.id, independence: input.independence });

    const raw: string[] = [];
    const runtime = this.runtimeFor(run);
    const loaded = await this.loadSkills(runId, input.noSkills ? [] : config.skills ?? [], input.role, attempt.provider, runtime.name);
    const prompt = loaded.delivery === 'prompt' ? `${input.prompt}${skillPromptBlock(loaded.skills)}` : input.prompt;
    try {
      const source = `agent:${input.role}`;
      const relay = this.runtimeLog(runId, source, attempt.id);
      const result = await this.withHeartbeat(runId, source, `${input.role} (${input.slot})`, () => this.agents.use(() => runtime.runAgent({
        run, attempt, role: input.role, prompt, signal: input.signal, skills: loaded.delivery === 'prompt' ? undefined : loaded.skills,
        sessionId: input.resumeSession?.sessionId, previousUsage: input.resumeSession?.cumulative,
        onEvent: (event) => {
          if (event.type === 'provider.raw') {
            raw.push(redactSecrets(event.message));
            const line = describeProviderLine(event.message);
            if (line) this.emit(runId, source, line.level, line.text, attempt.id);
          } else relay(event);
        },
      })), attempt.id);
      this.recordContext(runId, prompt, attempt.id, loaded.skills.map((s) => ({ name: s.name, hash: s.hash, delivery: loaded.delivery, hasScripts: s.hasScripts })));
      // Raw output is persisted before anything parses it.
      this.artifact(runId, { kind: 'raw', title: `Raw ${input.role} ${attempt.id}`, content: raw.join('\n') || redactSecrets(result.output), checkpoint: run.checkpoint, attemptId: attempt.id });
      // Only the Developer's session is ever resumed. Keeping another role's (a Claude Verifier, an Antigravity Planner)
      // would hand the next Developer repair a session id from a different CLI.
      if (result.sessionId && input.role === 'developer' && RESUMES_SESSIONS.includes(attempt.provider)) this.sessions.set(`${runId}:${input.slot}`, { sessionId: result.sessionId, cumulative: result.cumulativeUsage });
      const usage: UsageRecord = {
        id: `use_${randomUUID().slice(0, 8)}`, attemptId: attempt.id, sessionId: result.sessionId, ...result.usage,
        source: result.usage.costUsd !== null ? 'reported' : result.usage.inputTokens + result.usage.outputTokens > 0 ? 'estimated' : 'unknown', createdAt: this.stamp(),
      };
      this.mutate(runId, (r) => { r.usage.push(usage); });
      this.store.attempts.put({ ...attempt, status: 'completed', endedAt: this.stamp(), sessionId: result.sessionId, ...(result.model ? { model: result.model } : {}) });
      return { output: result.output, attempt };
    } catch (error) {
      if (raw.length) this.artifact(runId, { kind: 'raw', title: `Raw ${input.role} ${attempt.id} (lỗi)`, content: raw.join('\n'), checkpoint: run.checkpoint, attemptId: attempt.id });
      const interrupted = input.signal.aborted;
      this.store.attempts.put({ ...attempt, status: interrupted ? 'interrupted' : 'failed', endedAt: this.stamp(), error: redactSecrets(error instanceof Error ? error.message : String(error)) });
      if (interrupted) throw new Stopped();
      throw error;
    }
  }

  /**
   * The approved library skills a role should get, and how its CLI takes them: Claude Code as a plugin directory,
   * Codex from `.agents/skills` in the working copy, anything else (Antigravity, the Docker runtime) in the prompt.
   * Skills that are missing, disabled or not approved are left out with a console warning.
   */
  private async loadSkills(runId: string, names: readonly string[], role: Role, provider: Attempt['provider'], runtimeName: string): Promise<{ skills: ResolvedSkill[]; delivery: SkillDelivery }> {
    const delivery = skillDelivery(provider, runtimeName);
    if (!names.length) return { skills: [], delivery };
    if (!this.skills) { this.emit(runId, `agent:${role}`, 'warn', `Vai ${role} được gán skill (${names.join(', ')}) nhưng máy chủ không có thư viện skill; bỏ qua.`); return { skills: [], delivery }; }
    const { skills, skipped } = await this.skills.resolve(names);
    for (const s of skipped) this.emit(runId, `agent:${role}`, 'warn', `Không nạp skill "${s.name}" cho ${role}: ${s.reason}.`);
    if (skills.length) this.emit(runId, `agent:${role}`, 'info', `Nạp skill cho ${role} (${delivery === 'plugin' ? 'plugin Claude' : delivery === 'workspace' ? '.agents/skills' : 'trong prompt'}): ${skills.map((s) => s.name).join(', ')}`);
    return { skills, delivery };
  }

  /** What context and skills an attempt actually received, recorded beside its raw output; counts each memory item's use. */
  recordContext(runId: string, prompt: string, attemptId: string, skills: SkillUse[] = []): void {
    const run = this.run(runId);
    if (!run.context && !skills.length) return;
    const role = contextRoleOf(prompt);
    const selection = run.context && role ? selectContext(run, role) : { role: null, enabled: run.context?.enabled ?? false, sections: [], memoryIds: [] as string[], usedTokens: 0 };
    this.artifact(runId, { kind: 'context', title: `Ngữ cảnh ${role ?? '(không có)'}`, content: JSON.stringify({ contextOn: run.context?.enabled ?? false, ...selection, skills }), checkpoint: run.checkpoint, attemptId });
    for (const id of selection.memoryIds) {
      const item = this.store.memories.get(id);
      if (item) this.store.memories.put({ ...item, usedCount: item.usedCount + 1 });
    }
  }

  /**
   * Freezes the project context for this run on first use: the repo map of the working copy and the approved memory
   * that still holds against it. Items that no longer hold are marked stale in the project, never sent.
   */
  async ensureContext(runId: string): Promise<void> {
    const run = this.run(runId);
    if (run.context) return;
    const capturedAt = this.stamp();
    if (!run.configSnapshot.contextEnabled) { this.mutate(runId, (r) => { r.context = { enabled: false, capturedAt, memory: [] }; }); return; }
    const runtime = this.runtimeFor(run);
    const repoMap = await buildRepoMap(runtime.workspacePath?.(run, 'A') ?? run.configSnapshot.repository);
    const now = this.now().getTime();
    const memory: MemoryItem[] = [];
    for (const item of this.store.memories.list(run.projectId).filter((m) => m.status === 'active')) {
      const reason = staleReason(item, repoMap, now);
      if (reason) { this.store.memories.put({ ...item, status: 'stale', staleReason: reason, updatedAt: capturedAt }); this.log(runId, 'memory.stale', `Bỏ qua mục bộ nhớ "${item.text.slice(0, 60)}": ${reason}`); continue; }
      memory.push(item);
    }
    // The full path list only serves the check above; the run keeps the readable parts.
    this.mutate(runId, (r) => { r.context = { enabled: true, capturedAt, repoMap: { ...repoMap, paths: [] }, memory }; });
    this.log(runId, 'context.captured', `Ngữ cảnh project: ${memory.length} mục bộ nhớ, bản đồ repo ${repoMap.tree ? 'có' : 'trống'}.`);
  }

  /** Base snapshot file list, needed only when the project lets the agent create setup files. */
  async loadBaseFiles(runId: string): Promise<void> {
    const run = this.run(runId);
    if (!run.configSnapshot.allowScaffold || this.baseFileCache.has(runId) || !run.baseSha) return;
    const files = await this.runtimeFor(run).baseFiles?.(run, 'A');
    if (files) this.baseFileCache.set(runId, new Set(files));
  }

  /**
   * Planner and Verifier only read. Anything they leave in the working copy (test output, browser profiles, scratch
   * notes) is discarded, or the next commit would carry it into the checkpoint and the delivery.
   */
  async discardStrayEdits(runId: string, slot: Slot, who: string): Promise<void> {
    const run = this.run(runId);
    const runtime = this.runtimeFor(run);
    const left = await runtime.changes(run, slot);
    if (!left.files.length) return;
    await runtime.revert(run, slot);
    this.log(runId, 'workspace.cleaned', `${who} để lại ${left.files.length} file trong bản sao làm việc (ví dụ ${left.files.slice(0, 3).join(', ')}); đã hoàn nguyên, không đưa vào checkpoint.`);
  }
}
