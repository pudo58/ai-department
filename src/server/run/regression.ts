import type { Artifact, Finding, Run } from '../../shared/types.js';
import type { FindingReplay } from '../../shared/reproduction.js';
import type { FindingResolution, PendingRegression, RegressionManifest, RegressionProposal, RegressionReceipt, RegressionTrial } from '../../shared/regression.js';
import { hashContract } from '../../core/contract.js';
import { parseTestReport, summarizeFailures } from '../../core/checks.js';
import { identityId } from '../../core/testids.js';
import { latestChecks } from '../../core/qualityevidence.js';
import { policyOf } from '../../core/policy.js';
import { replayConfigHash, scenarioHash } from '../../core/reproduction.js';
import {
  REGRESSION_FAILURE_TAG, REGRESSION_MANIFEST_TITLE, REGRESSION_PROPOSAL_TITLE, REGRESSION_RECEIPT_TITLE, firstMismatch, generateRegression, readRegressionManifest,
  readAppliedReceipt, readRegressionProposals, readRegressionReceipt, regressionDirOf, regressionFor, regressionReady, regressionRecipe,
} from '../../core/regression.js';
import { Blocked, HttpError } from './support.js';
import type { RunServices } from './services.js';
import type { ScopePolicy } from './scope.js';

const failureText = (report: unknown, title: string): string | undefined => {
  const root = (report && typeof report === 'object' ? report : {}) as { testResults?: { assertionResults?: { title?: string; failureMessages?: unknown }[] }[] };
  for (const suite of root.testResults ?? []) for (const a of suite.assertionResults ?? []) if (a.title === title && Array.isArray(a.failureMessages)) return a.failureMessages.map(String).join('\n');
};

/**
 * The regression side of a confirmed finding: the test that is generated from its counterexample and tried once on a clone before
 * anyone is asked, the receipt of the person who read it, the application and locking of the test before the Developer starts, and
 * the proof that the same scenario failed before the repair and passes after it. No model is involved anywhere in here.
 */
export class Regressions {
  constructor(private readonly s: RunServices, private readonly scope: ScopePolicy) {}

  /** A proposal for one reproduced finding, with the trial of its test, or the stated reason none can be made. */
  async propose(runId: string, finding: Finding, replay: FindingReplay, signal: AbortSignal): Promise<PendingRegression | undefined> {
    const run = this.s.run(runId);
    if (!policyOf(run).regression || !finding.reproduction || replay.status !== 'reproduced' || replay.checkpoint !== run.checkpoint) return;
    const scenario = finding.reproduction;
    const base: RegressionProposal = {
      schemaVersion: 1, findingId: finding.id, scenarioHash: scenarioHash(scenario), checkpoint: run.checkpoint!, contractVersion: run.contract.version, contractHash: hashContract(run.contract),
      configHash: replayConfigHash(run), slot: run.selectedSlot, oracle: scenario.oracle, replay: { status: replay.status, checkpoint: replay.checkpoint, message: replay.message, observations: replay.observations },
    };
    const store = (p: RegressionProposal): PendingRegression => {
      const a = this.s.artifact(runId, { kind: 'report', title: REGRESSION_PROPOSAL_TITLE, content: JSON.stringify(p), checkpoint: run.checkpoint });
      return { ...p, id: a.id, hash: a.hash };
    };
    const chosen = regressionRecipe(run.configSnapshot);
    const runtime = this.s.runtimeFor(run);
    if ('unsupported' in chosen || !runtime.runTrialChecks) {
      const reason = 'unsupported' in chosen ? chosen.unsupported : 'Runtime này không tạo được bản sao riêng của checkpoint nên chưa thử được test regression.';
      this.s.log(runId, 'regression.unsupported', `${finding.title}: ${reason}`);
      return store({ ...base, unsupported: `${reason} Finding cần review thủ công; hệ thống không báo là đã tạo regression.` });
    }
    const generated = generateRegression({ finding, scenario, recipeId: chosen.recipe.id, dir: regressionDirOf(run.configSnapshot) });
    const trial = await this.trial(runId, generated, chosen.recipe, firstMismatch(replay), signal);
    this.s.log(runId, 'regression.trial', `${finding.title}: test regression ${trial.status}. ${trial.message}`);
    return store({ ...base, recipeId: chosen.recipe.id, path: generated.path, patch: generated.patch, testHash: generated.testHash, testId: generated.testId, identity: generated.identity, title: generated.title, trial });
  }

  /**
   * One run of the generated test on a throwaway clone of the checkpoint, never on the candidate: nothing the trial writes can reach a later
   * check. Only "it failed on the assertion the replay saw differ" is good enough to ask a person, and only if every other required check
   * that passes on the checkpoint (a typecheck, a lint) still passes with the test added, because nobody may edit the file once it is locked.
   */
  private async trial(runId: string, generated: ReturnType<typeof generateRegression>, recipe: import('../../shared/types.js').Recipe, mismatchStep: string | undefined, signal: AbortSignal): Promise<RegressionTrial> {
    const run = this.s.run(runId), runtime = this.s.runtimeFor(run), started = Date.now();
    const checkpoint = run.checkpoint!;
    const done = (status: RegressionTrial['status'], message: string, extra: Partial<RegressionTrial> = {}): RegressionTrial => ({ status, checkpoint, message, durationMs: Date.now() - started, ...extra });
    const passing = new Set(latestChecks(run, this.s.store.checks.list(runId)).filter(c => c.status === 'passed').map(c => c.recipeId));
    const others = run.configSnapshot.checks.filter(c => c.required && !c.reportPath && c.id !== recipe.id && passing.has(c.id));
    try {
      const [result, ...rest] = await this.s.withHeartbeat(runId, `check:regression`, 'Thử test regression trên bản sao của checkpoint', () => runtime.runTrialChecks!({
        run, slot: run.selectedSlot, patch: generated.patch, signal, onEvent: this.s.runtimeLog(runId, 'check:regression'),
        recipes: [{ ...recipe, command: [...recipe.command, generated.path], required: false, timeoutMs: Math.min(recipe.timeoutMs, 120_000) }, ...others],
      }));
      if (signal.aborted || !result) return done('interrupted', 'Đã hủy lượt thử test regression.');
      const parsed = parseTestReport(result.report);
      const test = parsed.tests.find(t => t.identity && identityId(t.identity, result.reportRoot) === generated.testId);
      if (!parsed.valid || parsed.collectionErrors || !test) {
        const why = summarizeFailures(result.report, 2).join(' ') || (result.incomplete ? 'check chưa hoàn tất (timeout hoặc thiếu report)' : 'runner không tìm thấy test mới');
        return done(result.incomplete && result.durationMs > recipe.timeoutMs ? 'timeout' : 'discovery_error', `Test regression chưa chạy được (${why.slice(0, 400)}). Đây là lỗi nhận file/import của cấu hình test, không phải bằng chứng về finding; đặt regressionDir vào thư mục mà Vitest đã nhận, rồi chạy lại phản ví dụ.`);
      }
      if (test.status === 'passed') return done('passed_unexpectedly', 'Test regression đạt trên checkpoint đang có lỗi, nên nó chưa tái hiện được sai khác mà replay thấy.', { testId: generated.testId });
      if (test.status === 'skipped') return done('discovery_error', 'Test regression bị bỏ qua.', { testId: generated.testId });
      const failure = failureText(result.report, generated.title)?.split('\n').find(l => l.trim())?.slice(0, 400);
      if (mismatchStep && !failureText(result.report, generated.title)?.includes(`${REGRESSION_FAILURE_TAG}:${mismatchStep}`)) {
        return done('wrong_failure', `Test regression thất bại nhưng không phải ở bước ${mismatchStep} mà replay thấy khác (${failure ?? 'không có thông báo'}).`, { testId: generated.testId, failure });
      }
      if (rest.length < others.length) return done('interrupted', 'Đã hủy lượt thử trước khi chạy xong các check bắt buộc khác.', { testId: generated.testId, failure });
      const broken = others.filter((_, i) => rest[i]!.exitCode !== 0 || rest[i]!.incomplete);
      if (broken.length) {
        const tail = broken.map(c => `${c.id}: ${rest[others.indexOf(c)]!.log.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`).join(' | ');
        return done('breaks_checks', `Test regression thất bại đúng ở bước ${mismatchStep ?? '?'}, nhưng thêm nó vào làm check bắt buộc ${broken.map(c => `“${c.id}”`).join(', ')} (đang đạt trên checkpoint) không đạt nữa (${tail}). Không đề xuất test này: file sẽ bị khóa và không ai được sửa nó để chữa build.`, { testId: generated.testId, failure });
      }
      return done('failed_as_expected', `Test regression thất bại đúng ở assertion của bước ${mismatchStep ?? '?'}: ${failure ?? ''}`.trim(), { testId: generated.testId, failure });
    } catch (error) {
      return done(signal.aborted ? 'interrupted' : 'error', `Không thử được test regression: ${(error as Error).message.slice(0, 300)}`);
    }
  }

  /** The person read the oracle and the diff of exactly this proposal: bind that to the finding, or say why it cannot. */
  confirm(runId: string, finding: Finding, input: { proposalHash?: string; manualReason?: string }): Finding {
    const run = this.s.run(runId), artifacts = this.s.store.artifacts.list(runId);
    const proposal = regressionFor(readRegressionProposals(run, artifacts), finding);
    const reason = input.manualReason?.trim();
    if (proposal && regressionReady(proposal)) {
      if (!input.proposalHash) throw new HttpError(400, 'Cần gửi hash của đề xuất regression hiện tại sau khi đã đọc căn cứ và diff.');
      if (input.proposalHash !== proposal.hash) throw new HttpError(409, 'Đề xuất regression đã đổi; tải lại, đọc căn cứ và diff hiện tại rồi xác nhận.');
      const receipt: RegressionReceipt = {
        schemaVersion: 1, findingId: finding.id, proposalId: proposal.id, proposalHash: proposal.hash, scenarioHash: proposal.scenarioHash, checkpoint: proposal.checkpoint, contractVersion: proposal.contractVersion,
        contractHash: proposal.contractHash, configHash: proposal.configHash, slot: proposal.slot, testHash: proposal.testHash!, path: proposal.path!, testId: proposal.testId!, confirmedAt: this.s.stamp(),
      };
      const artifact = this.s.artifact(runId, { kind: 'report', title: REGRESSION_RECEIPT_TITLE, content: JSON.stringify(receipt), checkpoint: run.checkpoint });
      return { ...finding, confirmed: true, status: 'open', confirmation: { kind: 'regression', at: receipt.confirmedAt, proposalHash: proposal.hash, receiptHash: artifact.hash } };
    }
    if (input.proposalHash && proposal && input.proposalHash !== proposal.hash) throw new HttpError(409, 'Đề xuất regression đã đổi; tải lại trước khi xác nhận.');
    if (!reason || reason.length < 10) {
      const limit = proposal?.unsupported ?? (proposal?.trial ? `Test regression chưa đạt thử nghiệm (${proposal.trial.status}): ${proposal.trial.message}` : finding.reproductionLimitation ?? 'Finding chưa có kịch bản tái hiện chạy được.');
      throw new HttpError(400, `Chưa có regression tự động để xác nhận (${limit}). Xác nhận bằng review thủ công cần ghi lý do và bằng chứng bạn đã kiểm tra (ít nhất 10 ký tự).`);
    }
    return { ...finding, confirmed: true, status: 'open', confirmation: { kind: 'manual', at: this.s.stamp(), reason } };
  }

  /**
   * Whether the confirmation on a finding still refers to the proposal, scenario, checkpoint, contract and configuration that exist now, or
   * to the regression this run applied for it on exactly that basis, with nothing committed since and the test file untouched.
   */
  confirmationValid(run: Run, finding: Finding, artifacts: readonly Artifact[]): boolean {
    const c = finding.confirmation;
    if (!c) return false;
    if (c.kind === 'manual') return !!c.reason;
    const applied = readAppliedReceipt(run, finding, artifacts);
    if (applied) return (this.s.regressions.get(run.id) ?? []).some(r => r.path === applied.path && r.intact);
    const proposal = regressionFor(readRegressionProposals(run, artifacts), finding);
    return !!proposal && regressionReady(proposal) && !!readRegressionReceipt(run, finding, proposal, artifacts);
  }

  /**
   * Before the Developer is called: put the confirmed tests into the workspace, commit them, lock them and write the manifest.
   * The checkpoint moves forward by exactly those files, so the next check sees the regression failing on the unrepaired code.
   */
  async applyConfirmed(runId: string, targets: readonly Finding[]): Promise<void> {
    let run = this.s.run(runId);
    const runtime = this.s.runtimeFor(run), appliedFrom = run.checkpoint!;
    const artifacts = this.s.store.artifacts.list(runId);
    const existing = readRegressionManifest(run, artifacts);
    const staged: { finding: Finding; proposal: PendingRegression; receiptHash: string }[] = [];
    for (const finding of targets) {
      if (finding.confirmation?.kind !== 'regression' || existing?.entries.some(e => e.findingId === finding.id && e.scenarioHash === (finding.reproduction ? scenarioHash(finding.reproduction) : ''))) continue;
      const proposal = regressionFor(readRegressionProposals(run, artifacts), finding);
      const receipt = proposal && regressionReady(proposal) ? readRegressionReceipt(run, finding, proposal, artifacts) : undefined;
      if (!proposal || !receipt) throw new Blocked(`Xác nhận regression của "${finding.title}" không còn khớp checkpoint, hợp đồng, cấu hình hoặc test; xác nhận lại đề xuất hiện tại.`);
      staged.push({ finding, proposal, receiptHash: receipt.hash });
    }
    if (!staged.length) return;
    if (!runtime.applyPatch) throw new Blocked('Runtime chưa hỗ trợ áp dụng test regression đã duyệt.');
    await runtime.revert(run, run.selectedSlot);
    // Checked again here: a file may have appeared at the same path since the proposal was made.
    for (const { proposal } of staged) await runtime.applyPatch(run, run.selectedSlot, proposal.patch!);
    const changes = await runtime.changes(run, run.selectedSlot);
    const expected = staged.map(x => x.proposal.path!);
    if (changes.files.length !== expected.length || changes.files.some(f => !expected.includes(f))) {
      await runtime.revert(run, run.selectedSlot);
      throw new Blocked('Diff áp dụng không khớp đúng các file regression đã duyệt; không commit.');
    }
    const checkpoint = await runtime.commit(run, run.selectedSlot, `${run.title}: regression tests for confirmed findings`);
    this.s.mutate(runId, r => { r.checkpoint = checkpoint; });
    run = this.s.run(runId);
    this.scope.lockAcceptance(runId, expected, checkpoint, 'Acceptance suite (Regression)', true);
    const manifest: RegressionManifest = {
      schemaVersion: 1, contractVersion: run.contract.version, contractHash: hashContract(run.contract), slot: run.selectedSlot, checkpoint, createdAt: this.s.stamp(),
      entries: [...(existing?.entries ?? []), ...staged.map(x => ({ findingId: x.finding.id, scenarioHash: x.proposal.scenarioHash, recipeId: x.proposal.recipeId!, path: x.proposal.path!, testId: x.proposal.testId!, identity: x.proposal.identity!, fileHash: x.proposal.testHash!, proposalHash: x.proposal.hash, receiptHash: x.receiptHash, appliedFrom, appliedCheckpoint: checkpoint }))],
    };
    for (const a of artifacts.filter(a => a.title === REGRESSION_MANIFEST_TITLE && a.valid && a.contractVersion === run.contract.version)) this.s.store.artifacts.put({ ...a, valid: false });
    this.s.artifact(runId, { kind: 'report', title: REGRESSION_MANIFEST_TITLE, content: JSON.stringify(manifest), checkpoint });
    this.s.artifact(runId, { kind: 'diff', title: `Diff regression @ ${checkpoint.slice(0, 8)}`, content: changes.patch, checkpoint });
    await this.s.refreshRegressions(runId);
    this.s.log(runId, 'regression.applied', `Đã khóa ${staged.length} test regression trước khi Developer sửa: ${expected.join(', ')}.`, { checkpoint });
  }

  /** What the Developer is told about the test that is locked for a finding. */
  note(run: Run, finding: Finding, artifacts: readonly Artifact[]): string {
    if (finding.confirmation?.kind !== 'regression') return '';
    const stored = artifacts.find(a => a.title === REGRESSION_PROPOSAL_TITLE && a.hash === finding.confirmation!.proposalHash);
    try { const p = JSON.parse(stored!.content) as RegressionProposal; return ` Test regression đã khóa: ${p.path} (${p.title}); nó thất bại trên checkpoint hiện tại và phải đạt sau khi sửa implementation. Không sửa file test này.`; } catch { return ''; }
  }

  /** Findings whose repair the runner has now demonstrated are closed; anything else stays open. */
  settle(runId: string, targets: readonly Finding[], before: readonly FindingReplay[], after: readonly FindingReplay[], checkpoint: string): void {
    const run = this.s.run(runId), artifacts = this.s.store.artifacts.list(runId), checks = latestChecks(run, this.s.store.checks.list(runId));
    for (const finding of targets) {
      if (!finding.reproduction) continue;
      const hash = scenarioHash(finding.reproduction);
      const replayBefore = before.find(r => r.findingId === finding.id && r.checkpoint === finding.checkpoint && r.scenarioHash === hash && r.status === 'reproduced');
      const replayAfter = after.find(r => r.findingId === finding.id && r.checkpoint === checkpoint && r.scenarioHash === hash);
      if (!replayBefore || replayAfter?.status !== 'not_reproduced') continue;
      let regression: FindingResolution['regression'] = 'unsupported', regressionTestId: string | undefined, trial: RegressionTrial | undefined, regressionAfter: 'passed' | 'failed' | 'missing' = 'missing';
      if (finding.confirmation?.kind === 'regression') {
        const proposal = artifacts.find(a => a.title === REGRESSION_PROPOSAL_TITLE && a.hash === finding.confirmation!.proposalHash);
        const parsed = proposal ? JSON.parse(proposal.content) as RegressionProposal : undefined;
        regression = 'created'; regressionTestId = parsed?.testId; trial = parsed?.trial;
        const outcome = checks.find(c => c.recipeId === parsed?.recipeId)?.outcomes?.find(o => o.id === parsed?.testId);
        regressionAfter = outcome?.status === 'passed' ? 'passed' : outcome?.status === 'failed' ? 'failed' : 'missing';
        // A regression test that was confirmed but did not fail before, or does not pass now, is not a demonstrated repair.
        if (trial?.status !== 'failed_as_expected' || regressionAfter !== 'passed') continue;
      }
      finding.status = 'resolved';
      finding.resolution = {
        kind: 'verified_fix', at: this.s.stamp(), checkpoint, regression, regressionTestId,
        before: { replay: replayBefore.status, checkpoint: replayBefore.checkpoint, ...(trial ? { regression: trial.status } : {}) },
        after: { replay: replayAfter.status, checkpoint, ...(regression === 'created' ? { regression: regressionAfter } : {}) },
      };
      this.s.store.findings.put(finding);
    }
  }
}
