import { lockedIds, readManifest, recipeHash } from '../../core/qualityevidence.js';
import { randomUUID } from 'node:crypto';
import type { Slot } from '../../shared/types.js';
import { ENV_PROBLEM_PREFIX } from '../../core/nodever.js';
import { evaluateRedGreen, parseTestReport, ranNoTests, shouldRetry, summarizeCheck, summarizeFailures } from '../../core/checks.js';
import type { RuntimeCheckResult } from '../../runtime/types.js';
import { BUILD_RECIPES } from './support.js';
import type { RunServices } from './services.js';

/** Runs the project's check recipes on a checkpoint, with the single retry and red/green validation. */
export class CheckRunner {
  constructor(private readonly s: RunServices) {}

  /** Runs every required recipe with the single allowed retry, then red/green validation when the task kind calls for it. */
  async runChecks(runId: string, slot: Slot, checkpoint: string, testFiles: string[], signal: AbortSignal): Promise<{ problems: string[]; fatal: string[]; repairable: boolean; flaky: number }> {
    const run = this.s.run(runId);
    const runtime = this.s.runtimeFor(run);
    const problems: string[] = [], fatal: string[] = [];
    let repairable = true, flaky = 0, buildBroken = false;
    for (const recipe of run.configSnapshot.checks) {
      const onEvent = this.s.runtimeLog(runId, `check:${recipe.id}`);
      const runOnce = (ref: 'candidate' | 'base', keepPaths?: string[]) => {
        // The UI shows the test program while it runs, so what is running and since when must be known.
        this.s.runningChecks.set(runId, { recipeId: recipe.id, command: recipe.command.join(' '), ref, startedAt: this.s.stamp() });
        return this.s.withHeartbeat(runId, `check:${recipe.id}`, `Check "${recipe.id}" (${ref})`, () => runtime.runCheck({ run, recipe, slot, ref, keepPaths, signal, onEvent }))
          .finally(() => this.s.runningChecks.delete(runId));
      };
      // Tests cannot run on code that does not compile: say so once (the build problem is already listed) instead of
      // adding a second, misleading "incomplete" for every test check after it.
      if (buildBroken && recipe.reportPath) { this.s.emit(runId, `check:${recipe.id}`, 'warn', `Bỏ qua check "${recipe.id}": bước build đã fail, test chưa thể chạy.`); continue; }
      const attempts: RuntimeCheckResult[] = [await runOnce('candidate')];
      if (shouldRetry(attempts[0]!)) {
        this.s.retry(runId,attempts[0]!.incomplete?'environment':recipe.reportPath && !attempts[0]!.report?'missing_evidence':'check_failure',`Chạy lại check ${recipe.id} một lần để kiểm tra flaky; chưa quy lỗi cho source hay test.`);
        this.s.emit(runId, `check:${recipe.id}`, 'warn', 'Check fail; chạy lại một lần để phân biệt lỗi thật với flaky.');
        attempts.push(await runOnce('candidate'));
      }
      const pinned = attempts;
      const previous = this.s.store.checks.list(runId).filter((c) => c.recipeId === recipe.id && c.quarantined).pop();
      const artifacts = this.s.store.artifacts.list(runId);
      const manifest = readManifest(run, artifacts);
      const expected = lockedIds(run, artifacts, recipe.id, this.s.regressions.get(runId) ?? []);
      const workspace = runtime.workspacePath?.(run, slot);
      // Normalize the reporter namespace before comparing it with the locked manifest.
      const result = summarizeCheck({
        runId, id: `chk_${randomUUID().slice(0, 8)}`, recipe, checkpoint, contractVersion: run.contract.version,
        lockedTestIds: expected, reportRoot: workspace, structuredIds: manifest?.manifest.schemaVersion === 2,
        quarantined: previous ? { reason: previous.quarantineReason ?? 'Kế thừa quarantine trước đó.' } : undefined,
      }, pinned, this.s.now());
      result.slot = slot; result.configHash = recipeHash(run); result.manifestHash = manifest?.hash;
      this.s.store.checks.put(result);
      if(result.status==='failed')this.s.artifact(runId,{kind:'report',title:`Check failure digest ${result.id}`,content:JSON.stringify(summarizeFailures(attempts.at(-1)?.report)),checkpoint});
      const integrity = result.issues?.filter(i => i.kind !== 'assertion_failed' && i.kind !== 'test_skipped') ?? [];
      if (integrity.length) { repairable = false; problems.push(...integrity.map(i => i.message)); }
      if (result.missingTestIds.length) { problems.push(`Check "${recipe.id}" thiếu hoặc bỏ qua test đã khóa: ${result.missingTestIds.join(', ')}`); repairable = false; }
      this.s.log(runId, 'check', `${recipe.id}@${checkpoint.slice(0, 8)}: ${result.status}${attempts.length > 1 ? ' (có retry)' : ''}`);
      if (result.status === 'flaky') flaky++;
      if (!recipe.required) continue;
      if (result.status === 'failed') {
        if (!recipe.reportPath && BUILD_RECIPES.has(recipe.id)) buildBroken = true;
        const digest = summarizeFailures(attempts.at(-1)?.report);
        const noTests = recipe.reportPath && !parseTestReport(attempts.at(-1)?.report).tests.length && !digest.length ? ['Report không có test nào: cần thêm test gắn thẻ [R-x] trong thư mục tests.'] : [];
        // Checks without a report (typecheck, lint, build) have no digest; their compiler/linter output is the whole story.
        problems.push(`Check "${recipe.id}" fail (mã thoát ${result.attempts.at(-1)?.exitCode ?? '?'}):\n${[...digest, ...noTests].join('\n')}\n${(result.attempts.at(-1)?.log ?? '').slice(recipe.reportPath ? -1000 : -3000)}`);
      }
      else if (result.status === 'incomplete') {
        // A simulated run never executes a check, so it always ends here; resuming cannot change that.
        problems.push(run.provider === 'fake'
          ? `Check "${recipe.id}" không chạy thật vì đây là chạy mô phỏng: mô phỏng không chạy test nên task dừng ở đây. Muốn chạy thật, tạo task mới và chọn "Chạy thật · theo vai của project".`
          : attempts.at(-1)?.log.startsWith(ENV_PROBLEM_PREFIX) ? `Check "${recipe.id}": ${attempts.at(-1)!.log.slice(0, 600)} Sửa check hoặc Node rồi bấm Chạy lại check.`
          : ranNoTests(result) ? `Check "${recipe.id}" không chạy test nào (report có 0 test): lệnh check hoặc mẫu file không khớp test của repo. Sửa check của project rồi bấm Chạy lại check.` : `Check "${recipe.id}" chưa hoàn tất (timeout, thiếu report hoặc môi trường không chạy thật).`);
        repairable = false;
      }
      else if (result.status === 'flaky' && !result.quarantined) { problems.push(`Check "${recipe.id}" flaky: fail rồi pass khi retry. Cần sửa hoặc quarantine có lý do.`); repairable = false; }

      if (recipe.reportPath && result.status === 'passed' && run.taskKind && run.taskKind !== 'feature' && testFiles.length) {
        const baseRun = await runOnce('base', testFiles);
        const verdict = evaluateRedGreen(run.taskKind, parseTestReport(baseRun.report), parseTestReport(pinned.at(-1)!.report));
        this.s.artifact(runId, { kind: 'report', title: `Red/green ${recipe.id} (${run.taskKind})`, content: JSON.stringify(verdict), checkpoint });
        if (!verdict.valid) fatal.push(`Test không phải bằng chứng ${run.taskKind} hợp lệ: ${verdict.reasons.join(' ')}`);
      }
    }
    return { problems, fatal, repairable, flaky };
  }
}
