import { rm } from 'node:fs/promises';
import { detectMutation } from './mutationdetect.js';
import { probeEnvironment } from './preflight.js';
import { mutationDependencies, runMutation, type MutationExecution } from './mutation.js';
import path from 'node:path';
import type { Role, Run, Slot } from '../shared/types.js';
import { isSafeRelative } from '../core/scope.js';
import { notAnalyzed, type AnalysisTool, type ToolReport } from '../core/tools.js';
import { GitWorkspaces } from './gitworkspace.js';
import { assertProcessSucceeded, assertSetupSucceeded, executeFile, redactSecrets, type ProcessResult } from './process.js';
import { buildCliCommand, JsonlCollector, type CliProvider } from './providers.js';
import {
  RuntimeBlockedError,
  type AgentExecution, type AgentResult, type ChangeSet, type CheckExecution, type PrepareResult,
  type Runtime, type RuntimeAttestation, type RuntimeCheckResult, type RuntimeEvent,
} from './types.js';
import { clearReport, readReport } from './report.js';
import { streamStderr, streamTo } from './streaming.js';

const DEFAULT_AGENT_MS = 30 * 60_000;
const DEFAULT_SETUP_MS = 20 * 60_000;

export interface DockerRuntimeOptions { dataDir: string; attestation: RuntimeAttestation }

/**
 * Docker-backed runtime. Agents see a Linux container with one bind-mounted workspace clone and the
 * adapter's auth volume; the original checkout, host home, SSH keys and the Docker socket never mount.
 * Check runners get no auth volume and no network. `assertAttested` gates every use.
 *
 * Known limit: Codex's own bubblewrap sandbox cannot create namespaces inside this hardened container, so
 * shell tool calls fail. Use the local runtime for Codex, or run a CLI that needs no nested sandbox.
 */
export class DockerRuntime implements Runtime {
  readonly name = 'docker';
  private readonly ws: GitWorkspaces;
  constructor(private readonly options: DockerRuntimeOptions) { this.ws = new GitWorkspaces(options.dataDir); }

  private container = (attemptId: string) => `aidept-${attemptId}`;

  private async assertAttested(run: Run, needSingleAgent: boolean): Promise<void> {
    const a = this.options.attestation;
    if (a.projectId !== run.projectId) throw new RuntimeBlockedError('Attestation không thuộc project này.');
    if (Date.parse(a.expiresAt) < Date.now()) throw new RuntimeBlockedError('Attestation runtime đã hết hạn; cần xác nhận lại.');
    if (!a.providerEgressVerified || !a.nativeToolSurfaceVerified) throw new RuntimeBlockedError('Mạng agent hoặc bề mặt tool native chưa được kiểm chứng.');
    if (needSingleAgent && !a.singleAgentEnforcementVerified) throw new RuntimeBlockedError('Chưa kiểm chứng được cưỡng chế single-agent; không thể gọi run này là Single.');
    const image = await executeFile('docker', ['image', 'inspect', '--format', '{{.Id}}', run.configSnapshot.runnerImage], { timeoutMs: 30_000 });
    assertProcessSucceeded(image, 'docker image inspect');
    if (image.stdout.trim() !== a.imageId) throw new RuntimeBlockedError('Runner image khác với image đã được attest.');
  }

  private hardening(name: string, network: string): string[] {
    return ['run', '--rm', '-i', '--name', name, '--network', network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '512', '--memory', '4g', '--read-only', '--tmpfs', '/tmp:rw,exec,size=1g', '--user', '1000:1000', '-w', '/workspace'];
  }

  async prepare(run: Run, slot: Slot, onEvent?: (event: RuntimeEvent) => void): Promise<PrepareResult> {
    await this.assertAttested(run, false);
    onEvent?.({ type: 'log', message: 'git clone (snapshot)…', data: { source: 'setup' } });
    const { ws, ...result } = await this.ws.clone(run, slot);
    const setup = run.configSnapshot.setupCommand;
    if (setup.length) {
      const out = await this.inContainer(run, `setup-${run.id}-${slot}`, run.configSnapshot.agentNetwork, ws, setup, undefined, run.configSnapshot.limits?.setupMs ?? DEFAULT_SETUP_MS, undefined, undefined, streamTo(onEvent, 'setup'));
      assertSetupSucceeded(out);
      await this.ws.assertCleanAfterSetup(ws);
    }
    return result;
  }

  async preflight(run: Run, slot: Slot, signal?: AbortSignal) {
    await this.assertAttested(run,false);
    const ws=this.ws.dir(run,slot);
    return probeEnvironment(run,ws,this.name,(command,timeoutMs)=>this.inContainer(run,`preflight-${run.id}-${slot}`,'none',ws,command,undefined,timeoutMs,undefined,signal),signal);
  }

  private inContainer(run: Run, name: string, network: string, ws: string, cmd: string[], auth: { volume: string } | undefined, timeoutMs: number, input?: string, signal?: AbortSignal, stream: { onStdout?: (c: string) => void; onStderr?: (c: string) => void } = {}, readOnly = false): Promise<ProcessResult> {
    const args = [...this.hardening(name, network), '-v', `${ws}:/workspace${readOnly ? ':ro' : ''}`, ...(auth ? ['-v', `${auth.volume}:/auth`, '-e', 'HOME=/auth'] : ['-e', 'HOME=/tmp']), run.configSnapshot.runnerImage, ...cmd];
    return this.supervised(name, () => executeFile('docker', args, { timeoutMs, input, signal, ...stream, maxOutputBytes: 64 * 1024 * 1024 }));
  }

  /**
   * Killing the `docker` client on timeout or abort does not stop the container it started, so the
   * container is removed by name whenever the call did not finish normally.
   */
  private async supervised(name: string, start: () => Promise<ProcessResult>): Promise<ProcessResult> {
    let finished = false;
    try {
      const result = await start();
      finished = !result.timedOut;
      return result;
    } finally {
      if (!finished) await executeFile('docker', ['rm', '-f', name], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }

  async runAgent(exec: AgentExecution): Promise<AgentResult> {
    const { run, attempt, role } = exec;
    await this.assertAttested(run, run.mode === 'single');
    const config = run.configSnapshot.roles[role as Role];
    if (config.provider === 'fake') throw new RuntimeBlockedError('Role được cấu hình provider mô phỏng trong runtime thật.');
    if (config.provider === 'antigravity') throw new RuntimeBlockedError('Antigravity chỉ chạy local (executionMode "local"), chưa hỗ trợ trong Docker.');
    const provider = config.provider as Exclude<CliProvider, 'antigravity'>;
    const registered = this.options.attestation.providers[provider];
    if (!registered) throw new RuntimeBlockedError(`Provider ${provider} chưa được attest.`);
    const collector = new JsonlCollector({ provider, previousCumulativeUsage: exec.previousUsage, onEvent: exec.onEvent });
    const cmd = buildCliCommand({ provider, model: config.model, effort: config.effort, sessionId: exec.sessionId, singleAgent: run.mode === 'single', readOnly: exec.readOnly });
    const result = await this.inContainer(run, this.container(attempt.id), run.configSnapshot.agentNetwork, this.ws.dir(run, attempt.slot), cmd,
      { volume: registered.authVolume }, run.configSnapshot.limits?.agentMs ?? DEFAULT_AGENT_MS, exec.prompt, exec.signal, { onStdout: (chunk) => collector.push(chunk), ...streamStderr(exec.onEvent) }, exec.readOnly);
    collector.finish();
    if (result.timedOut) throw new Error('Agent hết thời gian cho phép.');
    if (collector.failure) throw new Error(redactSecrets(collector.failure));
    if (result.exitCode !== 0 && !collector.completed) throw new Error(`Agent thoát với mã ${result.exitCode}: ${redactSecrets(result.stderr.slice(0, 1000))}`);
    return { output: collector.output, sessionId: collector.sessionId, usage: collector.usage, cumulativeUsage: collector.cumulativeUsage };
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
    const wsDir = this.ws.dir(run, slot);
    const checkpoint = await this.ws.head(run, slot);
    const execute = async (): Promise<RuntimeCheckResult> => {
      // A report left by an earlier run must never be mistaken for this run's output.
      if (recipe.reportPath) {
        if (!isSafeRelative(recipe.reportPath)) throw new Error('reportPath không hợp lệ.');
        await clearReport(wsDir, recipe.reportPath);
      }
      const result = await this.inContainer(run, `check-${run.id}-${slot}-${recipe.id}`, 'none', wsDir, recipe.command, undefined, recipe.timeoutMs, undefined, exec.signal, streamTo(exec.onEvent, `check:${recipe.id}`));
      let report: unknown;
      if (recipe.reportPath) {
        report = await readReport(wsDir, recipe.reportPath);
      }
      return {
        exitCode: result.exitCode, durationMs: result.durationMs, checkpoint, report, reportRoot: '/workspace',
        incomplete: result.timedOut || (!!recipe.reportPath && report === undefined),
        log: redactSecrets(`${result.stdout}\n${result.stderr}`.slice(-200_000)),
      };
    };
    return exec.ref === 'base' ? this.ws.withBaseOverlay(run, slot, exec.keepPaths ?? [], execute) : execute();
  }

  detectMutation = (run: Run, slot: Slot) => detectMutation(this.ws.dir(run, slot), run.configSnapshot.mutationRoot);
  async runMutation(execution: MutationExecution) {
    await this.assertAttested(execution.run, false);
    const { run, slot } = execution;
    const name = `mutation-${run.id}-${slot}`;
    return runMutation(this.ws, execution, async (directory, argv, timeoutMs, signal, events) => {
      const temp = `${this.ws.dir(run, slot)}-mutation`, rel = path.relative(temp, directory).replace(/\\/g, '/');
      const deps = (await mutationDependencies(this.ws.dir(run, slot), execution.capability.root)).flatMap(({ relative, directory }) => ['-v', `${directory}:/workspace/${relative === '.' ? '' : `${relative}/`}node_modules:ro`]);
      const args = [...this.hardening(name, 'none'), '-v', `${temp}:/workspace`, ...deps, '-w', rel ? `/workspace/${rel}` : '/workspace', '-e', 'HOME=/tmp', run.configSnapshot.runnerImage, ...argv];
      return this.supervised(name, () => executeFile('docker', args, { timeoutMs, signal, onStdout: c => events?.({ type: 'log', message: redactSecrets(c), data: { source: 'mutation' } }), onStderr: c => events?.({ type: 'log', message: redactSecrets(c), data: { source: 'mutation' } }) }));
    });
  }
  async recoverMutation(run: Run) {
    for (const slot of ['A', 'B'] as Slot[]) {
      await executeFile('docker', ['rm', '-f', `mutation-${run.id}-${slot}`], { timeoutMs: 30_000 }).catch(() => undefined);
      await rm(`${this.ws.dir(run, slot)}-mutation`, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  async runTool(_run: Run, _slot: Slot, tool: AnalysisTool): Promise<ToolReport> {
    // Pinned tool versions and out-of-checkout configs are not wired yet; "not analyzed" is the honest result.
    return notAnalyzed(tool, 'Tool runner với phiên bản pin và config ngoài checkout chưa được cấu hình.');
  }

  async stop(attemptId: string): Promise<void> {
    await executeFile('docker', ['rm', '-f', this.container(attemptId)], { timeoutMs: 30_000 }).catch(() => undefined);
  }

  dispose = (run: Run): Promise<void> => this.ws.dispose(run);
}
