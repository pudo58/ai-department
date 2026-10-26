import { cp, lstat, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run, Slot } from '../shared/types.js';
import type { MutationCapability, MutationResult } from '../shared/quality.js';
import { recipeHash } from '../core/qualityevidence.js';
import { isSafeRelative, classifyPath } from '../core/scope.js';
import { isTestPath } from '../core/testpath.js';
import type { GitWorkspaces } from './gitworkspace.js';
import { assertProcessSucceeded, executeFile, redactSecrets, type ProcessResult } from './process.js';
import type { RuntimeEvent } from './types.js';

export interface MutationExecution { run: Run; slot: Slot; capability: MutationCapability; signal?: AbortSignal; onEvent?: (e: RuntimeEvent) => void; timeoutMs?: number }
export type MutationExecutor = (directory: string, argv: string[], timeoutMs: number, signal?: AbortSignal, onEvent?: (e: RuntimeEvent) => void) => Promise<ProcessResult>;
/** Match Node's dependency lookup at every ancestor inside the project, including intermediate hoists. */
export async function mutationDependencies(source: string, root = '.'): Promise<{ relative: string; directory: string }[]> {
  if (root !== '.' && !isSafeRelative(root)) throw new Error('Thư mục mutation không hợp lệ.');
  const parts = path.posix.normalize(root.replace(/\\/g, '/')).split('/').filter(p => p !== '.');
  const roots = ['.', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
  const dependencies: { relative: string; directory: string }[] = [];
  for (const relative of roots) {
    const directory = path.join(source, relative, 'node_modules');
    if (await stat(directory).then(s => s.isDirectory(), () => false)) dependencies.push({ relative, directory });
  }
  return dependencies;
}
export const emptyMutationCounts = () => ({ killed: 0, survived: 0, no_coverage: 0, timeout: 0, errors: 0, pending: 0 });
export function parseMutationReport(report: unknown): Pick<MutationResult, 'counts' | 'mutants'> {
  if (!report || typeof report !== 'object' || !('files' in report) || typeof report.files !== 'object' || !report.files) throw new Error('Thiếu report mutation hợp lệ.');
  const counts = emptyMutationCounts(), mutants: MutationResult['mutants'] = [];
  for (const [file, value] of Object.entries(report.files)) {
    if (!value || !Array.isArray(value.mutants)) throw new Error('Danh sách mutant không hợp lệ.');
    for (const m of value.mutants) {
      const status = String(m.status ?? 'Pending');
      const key = ({ Killed: 'killed', Survived: 'survived', NoCoverage: 'no_coverage', Timeout: 'timeout', CompileError: 'errors', RuntimeError: 'errors', Pending: 'pending', Ignored: 'pending' } as const)[status as 'Killed'];
      counts[key ?? 'pending']++;
      mutants.push({ file, line: Number(m.location?.start?.line ?? 0), status, mutator: String(m.mutatorName ?? '') });
    }
  }
  return { counts, mutants };
}
/** Exact checkpoint clone; mutations and generated config never touch the candidate or delivery. */
export async function runMutation(ws: GitWorkspaces, execution: MutationExecution, execute?: MutationExecutor): Promise<MutationResult> {
  const { run, slot, capability, signal: externalSignal, onEvent } = execution;
  if (!run.checkpoint || capability.status !== 'available') throw new Error('Mutation cần checkpoint và adapter khả dụng.');
  const source = ws.dir(run, slot), target = `${source}-mutation`, rel = capability.root ?? '.';
  if (rel !== '.' && !isSafeRelative(rel)) throw new Error('Thư mục mutation không hợp lệ.');
  if (path.dirname(path.resolve(target)) !== path.dirname(path.resolve(source))) throw new Error('Bản sao mutation phải nằm trong thư mục workspace.');
  const start = Date.now(), deadline = start + (execution.timeoutMs ?? 300_000);
  const timerController = new AbortController();
  const timer = setTimeout(() => timerController.abort(), Math.max(1, deadline - start));
  const signal = externalSignal ? AbortSignal.any([externalSignal, timerController.signal]) : timerController.signal;
  const result: MutationResult = { schemaVersion: 1, source: 'stryker-vitest', status: 'in_progress', checkpoint: run.checkpoint, slot, contractVersion: run.contract.version,
    configHash: recipeHash(run), capability, startedAt: new Date(start).toISOString(), durationMs: 0, baseline: 'unknown', counts: emptyMutationCounts(), mutants: [], files: [], message: '' };
  const node = path.join(target, rel);
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0) throw new Error('Mutation hết thời gian tổng.'); return ms; };
  const runCommand: MutationExecutor = execute ?? (async (cwd, argv, timeoutMs, abort, events) => executeFile(argv[0]!, argv.slice(1), { cwd, timeoutMs, signal: abort, scrubSecrets: 'all',
    onStdout: c => events?.({ type: 'log', message: redactSecrets(c), data: { source: 'mutation' } }), onStderr: c => events?.({ type: 'log', message: redactSecrets(c), data: { source: 'mutation' } }) }));
  try {
    await rm(target, { recursive: true, force: true });
    assertProcessSucceeded(await executeFile('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-hardlinks', '--no-checkout', '-c', 'core.autocrlf=false', source, target], { timeoutMs: remaining(), signal }), 'clone mutation');
    assertProcessSucceeded(await ws.git(target, ['checkout', '--detach', run.checkpoint], signal), 'checkout mutation');
    const changes = await ws.diffSinceBase(run, slot);
    const rootPrefix = rel === '.' ? '' : `${rel}/`;
    result.files = changes.files.filter(f => f.status !== 'deleted' && f.path.startsWith(rootPrefix) && isSafeRelative(f.path) && /\.[cm]?[jt]sx?$/.test(f.path)
      && !isTestPath(f.path) && classifyPath(f.path, { modules: ['**'], protectedPaths: run.configSnapshot.protectedPaths }) === 'allowed' && !/(^|\/)(node_modules|dist|build|coverage|generated|vendor|__generated__)(\/|$)|\.d\.ts$|\.generated\./i.test(f.path)).map(f => f.path);
    const realTarget = await realpath(target);
    for (const file of [...result.files]) {
      const name = path.join(target, file), info = await lstat(name), real = await realpath(name);
      if (!info.isFile() || info.isSymbolicLink() || !real.startsWith(realTarget + path.sep)) { result.files = result.files.filter(f => f !== file); result.pendingUnknown = true; }
    }
    if (!result.files.length) { result.status = 'incomplete'; result.message = 'Không có source JS/TS phù hợp trong diff để mutate.'; return result; }
    for (const { relative, directory: from } of await mutationDependencies(source, rel)) {
      const to = path.join(target, relative, 'node_modules');
      await mkdir(path.dirname(to), { recursive: true });
      // Only dependencies are shared. Source and config are committed copies.
      await symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir').catch(() => undefined);
    }
    const config = { mutate: result.files.map(f => f.slice(rootPrefix.length)), testRunner: 'vitest', plugins: ['@stryker-mutator/vitest-runner'],
      vitest: { related: false, ...(capability.configFile ? { configFile: capability.configFile } : {}) }, reporters: ['json', 'clear-text'],
      jsonReporter: { fileName: '.aidept-mutation.json' }, htmlReporter: { fileName: '.aidept-mutation.html' },
      concurrency: 2, timeoutMS: 5000, timeoutFactor: 1.5, thresholds: { high: 100, low: 0, break: 0 }, cleanTempDir: true, incremental: false };
    await writeFile(path.join(node, '.aidept-stryker.json'), JSON.stringify(config));
    await cp(fileURLToPath(new URL('./mutation-worker.cjs', import.meta.url)), path.join(node, '.aidept-mutation-worker.cjs'));
    const argv = [execute ? 'node' : process.execPath, '.aidept-mutation-worker.cjs', execute ? '0' : String(process.pid), execute ? 'node' : process.execPath, '--stryker-installed', 'run', '.aidept-stryker.json'];
    const baselineConfig = { ...config, dryRunOnly: true };
    await writeFile(path.join(node, '.aidept-stryker.json'), JSON.stringify(baselineConfig));
    const baseline = await runCommand(node, argv, remaining(), signal, onEvent);
    if (baseline.timedOut || baseline.exitCode !== 0) { result.status = baseline.timedOut ? 'incomplete' : 'error'; result.baseline = baseline.timedOut ? 'unknown' : 'failed'; result.pendingUnknown = true; result.message = `Baseline mutation ${baseline.timedOut ? 'hết thời gian' : 'không đạt'}: ${redactSecrets((baseline.stderr || baseline.stdout).slice(-2000))}`; return result; }
    result.baseline = 'passed';
    await rm(path.join(node, '.aidept-mutation.json'), { force: true });
    await writeFile(path.join(node, '.aidept-stryker.json'), JSON.stringify(config));
    const out = await runCommand(node, argv, remaining(), signal, onEvent);
    try { Object.assign(result, parseMutationReport(JSON.parse(await readFile(path.join(node, '.aidept-mutation.json'), 'utf8')))); }
    catch { result.pendingUnknown = true; }
    if (!result.mutants.length && !result.pendingUnknown) result.pendingUnknown = true;
    result.status = out.timedOut ? 'incomplete' : out.exitCode !== 0 ? 'error' : (result.counts.pending || result.pendingUnknown) ? 'incomplete' : 'completed';
    result.message = out.timedOut ? 'Mutation hết thời gian; phần chưa chạy không được tính là đạt.' : out.exitCode !== 0 ? `Lỗi công cụ mutation: ${redactSecrets((out.stderr || out.stdout).slice(-2000))}` : (result.counts.pending || result.pendingUnknown) ? 'Report chưa đầy đủ; số mutation chưa chạy chưa xác định.' : 'Đã kiểm tra các mutation trong phạm vi source đã chọn.';
  } catch (error) { result.status = signal.aborted ? 'incomplete' : 'error'; result.pendingUnknown = true; result.message = redactSecrets((error as Error).message); }
  finally {
    clearTimeout(timer);
    result.endedAt = new Date().toISOString(); result.durationMs = Date.now() - start;
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => { result.workspace = target; result.message += ' Chưa dọn được bản sao mutation.'; });
  }
  return result;
}
