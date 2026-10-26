import { detectMutation } from './mutationdetect.js';
import { probeEnvironment } from './preflight.js';
import { runMutation, type MutationExecution } from './mutation.js';
import { replayFinding, recoverReplays, type ReproductionExecution } from './reproduction.js';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Role, Run, Slot } from '../shared/types.js';
import { READ_ONLY_ROLES } from '../shared/providers.js';
import { isSafeRelative } from '../core/scope.js';
import { ENV_PROBLEM_PREFIX, parseNodeVersion, planNodeTest } from '../core/nodever.js';
import { hostNodeVersion } from './nodever.js';
import { javaVersionOf, planEnvironment, type EnvNeeds } from '../core/envplan.js';
import { Toolchains, type ToolHomes, type ToolLog } from './toolchain.js';
import { bootstrapPython } from './pythonenv.js';
import { claudeSkillPlugin, codexWorkspaceSkills } from './skillmount.js';
import { notAnalyzed, type AnalysisTool, type ToolReport } from '../core/tools.js';
import { GitWorkspaces } from './gitworkspace.js';
import { resolveCodexCommand, resolveHostCommand } from './hostcommand.js';
import { assertProcessSucceeded, executeFile, redactSecrets } from './process.js';
import { resolveCodexModel } from './codexmodel.js';
import { cachedCliStatus, resolveAgyCommand, resolveClaudeCommand } from './agentclis.js';
import { createAgyHome, hashFiles, userAgyFiles } from './agyhome.js';
import { agyInput, agyWritePreamble, buildCliCommand, JsonlCollector } from './providers.js';
import {
  RuntimeBlockedError,
  type AgentExecution, type AgentResult, type ChangeSet, type CheckExecution, type PrepareResult, type Runtime, type RuntimeCheckResult, type RuntimeEvent,
} from './types.js';
import { clearReport, readReport } from './report.js';
import { streamStderr, streamTo } from './streaming.js';

const DEFAULT_AGENT_MS = 30 * 60_000;
const DEFAULT_SETUP_MS = 20 * 60_000;

export interface LocalRuntimeOptions { dataDir: string; /** Installs JDK/Maven/Gradle on demand; tests pass one that points at a fake distributor. */ toolchains?: Toolchains; codexCommand?: string[]; claudeCommand?: string[]; agyCommand?: string[];
  /** Whose agy permission files the Antigravity tripwire watches; the signed-in person by default (tests point it elsewhere). */
  agyUserHome?: string }

/** `.git/config` and every file under `.git/hooks`, keyed by path inside `.git`. */
async function gitMeta(cwd: string): Promise<Map<string, Buffer>> {
  const gitDir = path.join(cwd, '.git');
  const files = new Map<string, Buffer>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.set(path.relative(gitDir, full).replaceAll('\\', '/'), await readFile(full).catch(() => Buffer.from('<unreadable>')));
    }
  };
  await walk(path.join(gitDir, 'hooks'));
  const config = await readFile(path.join(gitDir, 'config')).catch(() => undefined);
  if (config) files.set('config', config);
  return files;
}

/**
 * Puts `.git/hooks` and `.git/config` back as they were before an agent turn and names what had changed. A hook, or a
 * config key such as a filter driver, would run code at the next git command in the copy.
 */
async function restoreGitMeta(cwd: string, before: Map<string, Buffer>): Promise<string[]> {
  const after = await gitMeta(cwd);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((file) => !before.get(file)?.equals(after.get(file) ?? Buffer.alloc(0)) || !after.has(file));
  if (!changed.length) return [];
  const gitDir = path.join(cwd, '.git');
  await rm(path.join(gitDir, 'hooks'), { recursive: true, force: true });
  if (!before.has('config')) await rm(path.join(gitDir, 'config'), { force: true });
  for (const [file, data] of before) {
    await mkdir(path.dirname(path.join(gitDir, file)), { recursive: true });
    await writeFile(path.join(gitDir, file), data);
  }
  return changed.map((file) => `.git/${file}`);
}

/**
 * Runs the agent and the project's checks directly on this machine, in a git clone under the data dir.
 *
 * There is NO container isolation: the agent can do whatever your user account can, limited only by the
 * agent CLI's own sandbox, and checks execute the repository's own commands with network access. The original
 * checkout is not touched until a result is accepted, and then only a new branch ref is added to it.
 */
export class LocalRuntime implements Runtime {
  readonly name = 'local';
  private readonly ws: GitWorkspaces;
  private readonly toolchains: Toolchains;
  /** Which tools each workspace uses, resolved once: installing is slow, looking them up again is not. */
  private readonly toolHomes = new Map<string, Promise<{ needs: EnvNeeds; homes: ToolHomes }>>();
  constructor(private readonly options: LocalRuntimeOptions) {
    this.ws = new GitWorkspaces(options.dataDir);
    this.toolchains = options.toolchains ?? new Toolchains({ dataDir: options.dataDir });
  }

  /** What the project's commands need and where those tools are, installing a missing JDK, Maven or Gradle first. */
  private resolveTools(run: Run, cwd: string, log?: ToolLog): Promise<{ needs: EnvNeeds; homes: ToolHomes }> {
    let p = this.toolHomes.get(cwd);
    if (!p) {
      p = (async () => {
        const texts = await Promise.all(['pom.xml', 'build.gradle.kts', 'build.gradle'].map((f) => readFile(path.join(cwd, f), 'utf8').catch(() => '')));
        const needs = planEnvironment([run.configSnapshot.setupCommand, ...run.configSnapshot.checks.map((c) => c.command)].filter((c) => c.length), javaVersionOf(texts.join(' ')));
        try { return { needs, homes: await this.toolchains.provide(needs, log) }; }
        catch (error) { throw new RuntimeBlockedError(`Không chuẩn bị được môi trường build: ${(error as Error).message}`); }
      })();
      // A failed install must be retried by the next task, not remembered.
      p.catch(() => this.toolHomes.delete(cwd));
      this.toolHomes.set(cwd, p);
    }
    return p;
  }

  /** Environment for a command in a workspace: installed build tools and the project's virtualenv first on PATH. */
  private async envFor(run: Run, cwd: string): Promise<Record<string, string>> {
    return this.toolchains.env(cwd, (await this.resolveTools(run, cwd)).homes);
  }

  async prepare(run: Run, slot: Slot, onEvent?: (event: RuntimeEvent) => void): Promise<PrepareResult> {
    onEvent?.({ type: 'log', message: 'git clone (snapshot)…', data: { source: 'setup' } });
    const { ws, ...result } = await this.ws.clone(run, slot);
    // Build tools and the Python virtualenv first, so the project's own setup command already runs with them.
    const log: ToolLog = (message, level = 'info') => onEvent?.({ type: 'log', message, data: { source: 'setup', level } });
    const { needs, homes } = await this.resolveTools(run, ws, log);
    if (needs.python) {
      await bootstrapPython(ws, (exe, args, timeoutMs) => executeFile(exe, args, { cwd: ws, timeoutMs, env: this.toolchains.env(ws, homes), scrubSecrets: 'provider', ...streamTo(onEvent, 'setup') }), log);
    }
    const setup = run.configSnapshot.setupCommand;
    if (setup.length) {
      const [cmd, ...args] = resolveHostCommand(setup);
      const out = await executeFile(cmd!, args, { cwd: ws, timeoutMs: run.configSnapshot.limits?.setupMs ?? DEFAULT_SETUP_MS, env: this.toolchains.env(ws, homes), scrubSecrets: 'provider', ...streamTo(onEvent, 'setup') });
      assertProcessSucceeded(out, 'setup command');
      await this.ws.assertCleanAfterSetup(ws);
    }
    return result;
  }

  async preflight(run: Run, slot: Slot, signal?: AbortSignal) {
    const cwd=this.ws.dir(run,slot);
    // A probe may reuse prepared tools, but must never install tools when a server was restarted.
    const prepared=await this.toolHomes.get(cwd);
    const env=this.toolchains.env(cwd,prepared?.homes);
    return probeEnvironment(run,cwd,this.name,async(command,timeoutMs)=>{
      const [exe,...args]=resolveHostCommand(command);
      return executeFile(exe!,args,{cwd,env,signal,timeoutMs,scrubSecrets:'all'});
    },signal);
  }

  async runAgent(exec: AgentExecution): Promise<AgentResult> {
    const { run, attempt, role } = exec;
    const config = run.configSnapshot.roles[role as Role];
    const cwd = this.ws.dir(run, attempt.slot);
    if (config.provider === 'claude') return this.guardGitMeta(exec, cwd, 'Claude Code', () => this.runClaude(exec, cwd));
    if (config.provider === 'antigravity') return this.runAntigravity(exec, cwd);
    if (config.provider !== 'codex') throw new RuntimeBlockedError(`Provider ${config.provider} chưa hỗ trợ chạy local.`);
    return this.guardGitMeta(exec, cwd, 'Codex', () => this.runCodex(exec, cwd));
  }

  /**
   * `.git/config` and `.git/hooks` must be exactly as they were before the turn, whichever agent ran. A hook runs at the
   * next git command and a config key such as diff.external or a filter driver runs code when the harness diffs or stages,
   * so a turn that touched either is void: both are restored and the uncommitted changes of the turn are rolled back.
   * (Antigravity does the same inside its own turn, together with its permission files.)
   */
  private async guardGitMeta<T>(exec: AgentExecution, cwd: string, who: string, turn: () => Promise<T>): Promise<T> {
    const before = await gitMeta(cwd);
    let result: T | undefined, failure: unknown, failed = false;
    try { result = await turn(); } catch (error) { failure = error; failed = true; }
    // Checked even when the agent failed or was stopped: a hook left behind would outlive the attempt.
    const tampered = await restoreGitMeta(cwd, before);
    if (tampered.length) {
      await this.ws.revert(exec.run, exec.attempt.slot);
      throw new Error(`Lượt ${who} đã sửa ${tampered.join(', ')} trong bản sao làm việc; đã khôi phục. Lượt này bị huỷ và các thay đổi chưa commit đã được hoàn tác.`);
    }
    if (failed) throw failure;
    return result as T;
  }

  private async runCodex(exec: AgentExecution, cwd: string): Promise<AgentResult> {
    const { run, attempt, role } = exec;
    const config = run.configSnapshot.roles[role as Role];
    const collector = new JsonlCollector({ provider: 'codex', previousCumulativeUsage: exec.previousUsage, onEvent: exec.onEvent });
    // buildCliCommand starts with the bare "codex"; the resolved prefix replaces it.
    const cmd = buildCliCommand({ provider: 'codex', model: config.model, effort: config.effort, sessionId: exec.sessionId, singleAgent: run.mode === 'single', readOnly: exec.readOnly, workdir: cwd,
      // --ignore-user-config drops the user's [windows] sandbox setting and Codex falls back to read-only, so the first turn
      // could not write anything. The elevated sandbox is the one Codex's own Windows setup installs.
      extraConfig: process.platform === 'win32' ? ['windows.sandbox="elevated"'] : [] });
    const [exe, ...prefixArgs] = this.options.codexCommand ?? resolveCodexCommand();
    const mounted = exec.skills?.length ? await codexWorkspaceSkills(cwd, exec.skills, exec.onEvent) : undefined;
    const result = await executeFile(exe!, [...prefixArgs, ...cmd.slice(1)], {
      cwd, input: exec.prompt, signal: exec.signal, env: await this.envFor(run, cwd), onStdout: (chunk) => collector.push(chunk), ...streamStderr(exec.onEvent),
      timeoutMs: run.configSnapshot.limits?.agentMs ?? DEFAULT_AGENT_MS, maxOutputBytes: 64 * 1024 * 1024,
    }).finally(() => mounted?.dispose());
    collector.finish();
    if (result.timedOut) throw new Error('Agent hết thời gian cho phép.');
    if (collector.failure) throw new Error(redactSecrets(collector.failure));
    if (result.exitCode !== 0 && !collector.completed) throw new Error(`Agent thoát với mã ${result.exitCode}: ${redactSecrets(result.stderr.slice(0, 1000))}`);
    // With no model configured Codex picks its default; its session log says which one it was.
    const model = !config.model && collector.sessionId ? await resolveCodexModel(collector.sessionId, attempt.startedAt).catch(() => undefined) : undefined;
    return { output: collector.output, sessionId: collector.sessionId, usage: collector.usage, cumulativeUsage: collector.cumulativeUsage, model };
  }

  /**
   * Claude Code with the person's own login. With a Claude subscription the reported dollar figure is a list-price
   * equivalent, not money spent, so it is kept as notionalUsd and the task budget is not charged for it.
   */
  private async runClaude(exec: AgentExecution, cwd: string): Promise<AgentResult> {
    const { run, role } = exec;
    const config = run.configSnapshot.roles[role as Role];
    const status = await cachedCliStatus('claude');
    if (!status.installed) throw new RuntimeBlockedError('Chưa cài Claude Code trên máy này. Xem trang Kết nối AI.');
    if (!status.loggedIn) throw new RuntimeBlockedError('Claude Code chưa đăng nhập. Xem trang Kết nối AI.');
    const collector = new JsonlCollector({ provider: 'claude', previousCumulativeUsage: exec.previousUsage, onEvent: exec.onEvent });
    const plugin = exec.skills?.length ? await claudeSkillPlugin(this.options.dataDir, exec.attempt.id, exec.skills) : undefined;
    const cmd = buildCliCommand({ provider: 'claude', model: config.model, sessionId: exec.sessionId, singleAgent: run.mode === 'single', readOnly: exec.readOnly, workdir: cwd, local: true,
      pluginDirs: plugin ? [plugin.dir] : [], skillScripts: !!exec.skills?.some((s) => s.hasScripts) });
    const [exe, ...prefixArgs] = this.options.claudeCommand ?? resolveClaudeCommand();
    const result = await executeFile(exe!, [...prefixArgs, ...cmd.slice(1)], {
      cwd, input: exec.prompt, signal: exec.signal, env: await this.envFor(run, cwd), onStdout: (chunk) => collector.push(chunk), ...streamStderr(exec.onEvent),
      timeoutMs: run.configSnapshot.limits?.agentMs ?? DEFAULT_AGENT_MS, maxOutputBytes: 64 * 1024 * 1024,
    }).finally(() => plugin?.dispose());
    collector.finish();
    if (result.timedOut) throw new Error('Agent hết thời gian cho phép.');
    if (collector.failure) throw new Error(redactSecrets(collector.failure));
    if (result.exitCode !== 0 && !collector.completed) throw new Error(`Agent thoát với mã ${result.exitCode}: ${redactSecrets(result.stderr.slice(0, 1000))}`);
    const usage = status.billing === 'subscription'
      ? { ...collector.usage, costUsd: 0, billing: 'subscription' as const, ...(collector.usage.costUsd !== null ? { notionalUsd: collector.usage.costUsd } : {}) }
      : { ...collector.usage, billing: 'api' as const };
    return { output: collector.output, sessionId: collector.sessionId, usage, cumulativeUsage: collector.cumulativeUsage, model: collector.model };
  }

  /**
   * Antigravity (agy). Plan mode does not stop agy's write_file at an absolute path outside the workspace, so every turn
   * runs with a private home whose permission rules (agyhome.ts) decide what it may write:
   * - Planner, Verifier, Investigator: nothing at all; the working copy must also be byte-for-byte unchanged afterwards,
   *   and a change voids the attempt (rolled back when the copy was clean before).
   * - Developer, Author (experimental): accept-edits inside the working copy only, never `.git`. Without
   *   --dangerously-skip-permissions headless mode refuses every shell command; the checks run afterwards instead.
   * On every turn `.git/hooks`, `.git/config` and the person's own agy permission files must be unchanged too.
   */
  private async runAntigravity(exec: AgentExecution, cwd: string): Promise<AgentResult> {
    const { run, role, attempt } = exec;
    const config = run.configSnapshot.roles[role as Role];
    const write = !exec.readOnly && !READ_ONLY_ROLES.includes(role as Role);
    // The rules name drive roots; they were only measured on Windows.
    if (write && process.platform !== 'win32') throw new RuntimeBlockedError(`Antigravity làm ${role} (thử nghiệm) mới được kiểm chứng trên Windows. Trên máy này hãy giao vai đó cho Codex hoặc Claude.`);
    const status = await cachedCliStatus('antigravity');
    if (!status.installed) throw new RuntimeBlockedError('Chưa cài Antigravity CLI (agy) trên máy này. Xem trang Kết nối AI.');
    if (!status.loggedIn) throw new RuntimeBlockedError('Antigravity CLI chưa đăng nhập. Xem trang Kết nối AI.');
    const before = write ? undefined : await this.fingerprint(cwd);
    const gitBefore = await gitMeta(cwd);
    const userFiles = userAgyFiles(this.options.agyUserHome);
    const userBefore = await hashFiles(userFiles);
    const home = await createAgyHome(path.join(this.options.dataDir, 'agy'), cwd, write);
    const collector = new JsonlCollector({ provider: 'antigravity', onEvent: exec.onEvent });
    const cmd = buildCliCommand({ provider: 'antigravity', model: config.model, effort: config.effort, singleAgent: run.mode === 'single', readOnly: exec.readOnly, workdir: cwd, write });
    const [exe, ...prefixArgs] = this.options.agyCommand ?? resolveAgyCommand();
    const result = await executeFile(exe!, [...prefixArgs, ...cmd.slice(1)], {
      cwd, env: home.env, input: agyInput(exec.prompt, write ? agyWritePreamble(cwd) : undefined), signal: exec.signal,
      onStdout: (chunk) => collector.push(chunk), ...streamStderr(exec.onEvent),
      timeoutMs: run.configSnapshot.limits?.agentMs ?? DEFAULT_AGENT_MS, maxOutputBytes: 64 * 1024 * 1024,
    }).finally(async () => {
      await home.dispose();
      // Checked even when agy failed or was stopped: a hook left behind would outlive the attempt.
      const tampered = await restoreGitMeta(cwd, gitBefore);
      const userChanged = [...await hashFiles(userFiles)].filter(([file, hash]) => userBefore.get(file) !== hash).map(([file]) => file);
      if (tampered.length || userChanged.length) {
        const revert = write || !!before?.clean;
        if (revert) await this.ws.revert(run, attempt.slot);
        throw new Error([
          tampered.length ? `Lượt Antigravity đã sửa ${tampered.join(', ')} trong bản sao làm việc; đã khôi phục.` : '',
          userChanged.length ? `File cấu hình Antigravity của bạn bị thay đổi trong lượt này: ${userChanged.join(', ')}. Hãy mở và kiểm tra (agy có thể tự cấp quyền chạy lệnh ở đó); nếu vừa tự dùng agy thì có thể đó là thay đổi của bạn.` : '',
          `Lượt này bị huỷ${revert ? ' và các thay đổi chưa commit đã được hoàn tác' : ''}.`,
        ].filter(Boolean).join(' '));
      }
    });
    collector.finish();
    if (before && (await this.fingerprint(cwd)).hash !== before.hash) {
      if (before.clean) await this.ws.revert(run, attempt.slot);
      // Clarify runs the Investigator beside the Author on the same copy, so the change may be the other agent's; either way
      // this read-only attempt cannot be trusted, and that copy is reset right after the readings anyway.
      throw new Error(`Bản sao làm việc bị thay đổi trong lượt Antigravity (chế độ chỉ đọc); lượt này bị huỷ${before.clean ? ' và thay đổi đã được hoàn tác' : ''}.`);
    }
    if (result.timedOut) throw new Error('Agent hết thời gian cho phép.');
    // agy prints `AGY_ERROR: {...}` on stderr and exits 3 when the model or API fails (quota, overload…).
    const agyError = /AGY_ERROR:\s*(.+)/.exec(result.stderr)?.[1];
    let output = collector.output;
    if (write && collector.denied.length) {
      const names = [...new Set(collector.denied.map((d) => d.name))].join(', ');
      if (collector.denied.some((d) => d.action !== 'command')) {
        // Only a write outside the working copy is an ask that headless mode refuses; its edits so far cannot be trusted.
        await this.ws.revert(run, attempt.slot);
        throw new Error(`Antigravity định ghi ra ngoài bản sao làm việc (${names}), bị từ chối và dừng mà không trả lời. Lượt này bị huỷ và các file nó đã sửa được hoàn tác.`);
      }
      // A refused command ends the turn, usually right after the edits; the checks will judge them.
      output = `Antigravity đã dừng khi định chạy lệnh (${names}): AI Department không cho agy chạy lệnh và sẽ tự chạy các bước kiểm tra trên những gì nó đã sửa.`;
    } else if (collector.failure) throw new Error(redactSecrets(agyError ? `${collector.failure} (${agyError.slice(0, 400)})` : collector.failure));
    if (result.exitCode !== 0) throw new Error(`Antigravity thoát với mã ${result.exitCode}: ${redactSecrets((agyError ?? result.stderr).slice(0, 1000))}`);
    // A Google-account login draws on that account's quota: nothing is charged to the task budget, and agy reports no price.
    const usage = status.billing === 'subscription' ? { ...collector.usage, costUsd: 0, billing: 'subscription' as const } : { ...collector.usage, billing: 'api' as const };
    return { output, sessionId: collector.sessionId, usage, model: collector.model };
  }

  /** Tracked edits plus untracked files of a working copy, hashed; read-only (unlike `changes`, it never touches the index). */
  private async fingerprint(cwd: string): Promise<{ hash: string; clean: boolean }> {
    const status = await this.ws.git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const diff = await this.ws.git(cwd, ['diff', '--no-color', '--binary', 'HEAD']);
    assertProcessSucceeded(status, 'git status'); assertProcessSucceeded(diff, 'git diff');
    return { hash: createHash('sha256').update(status.stdout).update('\0').update(diff.stdout).digest('hex'), clean: !status.stdout };
  }

  changes = (run: Run, slot: Slot): Promise<ChangeSet> => this.ws.changes(run, slot);
  commit = (run: Run, slot: Slot, message: string): Promise<string> => this.ws.commit(run, slot, message);
  revert = (run: Run, slot: Slot): Promise<void> => this.ws.revert(run, slot);
  deliveryTarget = (run: Run, slot: Slot) => this.ws.deliveryTarget(run, slot);
  deliver = (run: Run, slot: Slot) => this.ws.deliver(run, slot);
  workspacePath = (run: Run, slot: Slot): string => this.ws.dir(run, slot);
  applyPatch = (run: Run, slot: Slot, patch: string): Promise<void> => this.ws.applyPatch(run, slot, patch);
  baseFiles = (run: Run, slot: Slot): Promise<string[]> => this.ws.baseFiles(run, slot);
  diffSinceBase = (run: Run, slot: Slot) => this.ws.diffSinceBase(run, slot);

  async runCheck(exec: CheckExecution): Promise<RuntimeCheckResult> {
    const { run, recipe, slot } = exec;
    const cwd = this.ws.dir(run, slot);
    const checkpoint = await this.ws.head(run, slot);
    const execute = async (): Promise<RuntimeCheckResult> => {
      // A report left by an earlier run must never be mistaken for this run's output.
      if (recipe.reportPath) {
        if (!isSafeRelative(recipe.reportPath)) throw new Error('reportPath không hợp lệ.');
        await clearReport(cwd, recipe.reportPath);
      }
      const plan = planNodeTest(recipe.command, await hostNodeVersion(), parseNodeVersion(process.version), process.execPath);
      const source = `check:${recipe.id}`;
      if (plan.problem) {
        // Never start a command that cannot work here: the person gets the reason instead of a bare "chưa hoàn tất".
        exec.onEvent?.({ type: 'log', message: plan.problem, data: { source, level: 'error' } });
        return { exitCode: null, durationMs: 0, checkpoint, incomplete: true, log: `${ENV_PROBLEM_PREFIX}${plan.problem}` };
      }
      if (plan.note) exec.onEvent?.({ type: 'log', message: plan.note, data: { source, level: 'warn' } });
      const [cmd, ...args] = resolveHostCommand(plan.command);
      const result = await executeFile(cmd!, args, { cwd, timeoutMs: recipe.timeoutMs, signal: exec.signal, maxOutputBytes: 64 * 1024 * 1024, env: await this.envFor(run, cwd), scrubSecrets: 'all', ...streamTo(exec.onEvent, source) });
      let report: unknown;
      if (recipe.reportPath) {
        report = await readReport(cwd, recipe.reportPath);
      }
      return {
          exitCode: result.exitCode, durationMs: result.durationMs, checkpoint, report, reportRoot: cwd,
        incomplete: result.timedOut || (!!recipe.reportPath && report === undefined),
        log: redactSecrets(`${result.stdout}\n${result.stderr}`.slice(-200_000)),
      };
    };
    return exec.ref === 'base' ? this.ws.withBaseOverlay(run, slot, exec.keepPaths ?? [], execute) : execute();
  }

  detectMutation = (run: Run, slot: Slot) => detectMutation(this.ws.dir(run, slot), run.configSnapshot.mutationRoot);
  runMutation = (execution: MutationExecution) => runMutation(this.ws, execution);
  replayFinding = (execution: ReproductionExecution) => replayFinding(this.ws, execution);
  recoverReplays = (run:Run) => recoverReplays(this.ws,run);
  recoverMutation = async (run: Run) => { for (const slot of ['A', 'B'] as Slot[]) await rm(`${this.ws.dir(run, slot)}-mutation`, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };

  async runTool(_run: Run, _slot: Slot, tool: AnalysisTool): Promise<ToolReport> {
    return notAnalyzed(tool, 'Tool runner với phiên bản pin và config ngoài checkout chưa được cấu hình.');
  }

  /** Agents stop through the AbortSignal the orchestrator passes to runAgent (the process tree is killed). */
  async stop(): Promise<void> { /* nothing to do */ }
  dispose = (run: Run): Promise<void> => this.ws.dispose(run);
}
