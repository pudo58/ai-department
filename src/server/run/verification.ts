import { MutationChecks } from './mutation.js';
import { randomUUID } from 'node:crypto';
import type { Finding, Independence, Slot } from '../../shared/types.js';
import { budgetState, remainingFor } from '../../core/budget.js';
import { gateFinding, needsAutoRepair } from '../../core/findings.js';
import { FindingsSchema, parseOutput } from '../../core/outputs.js';
import { PROMPTS } from '../../core/prompts.js';
import { readVerdict, type VerifierVerdict } from '../../core/report.js';
import { evaluateChanges } from '../../core/scope.js';
import { reviewDiff } from '../../core/reviewdiff.js';
import { Blocked, verifierNarrative, type CandidateRecord } from './support.js';
import { isTestPath } from '../../core/testpath.js';
import type { RunServices } from './services.js';
import type { ScopePolicy } from './scope.js';
import type { RunOutcome } from './outcome.js';
import type { CheckRunner } from './checks.js';
import { latestChecks } from '../../core/qualityevidence.js';
import { normalizeVerifierScope } from '../../core/verifierscope.js';
import {ReproductionSchema,reproductionProblems,reproductionGuide,readFindingReplays,scenarioHash} from '../../core/reproduction.js';
import {FindingReplays} from './reproduction.js';
import {Regressions} from './regression.js';
import {policyOf} from '../../core/policy.js';
import { readVisualReport, VISUAL_REPORT_TITLE } from '../../core/visualevidence.js';

/** Final verification: the independent Verifier, its stored verdict, and the repair round for confirmed findings. */
export class Verification {
  readonly regressions: Regressions;
  constructor(private readonly s: RunServices, private readonly scope: ScopePolicy, private readonly outcome: RunOutcome, private readonly checks: CheckRunner) { this.regressions = new Regressions(s, scope); }

  async verifyPhase(runId: string, signal: AbortSignal, checksOnly = false): Promise<void> {
    const run = this.s.run(runId);
    this.s.mutate(runId, (r) => { r.stage = 'verify'; });
    if (run.contract.design && run.configSnapshot.visualCheck && this.s.visualCheck && !readVisualReport(run, this.s.store.artifacts.list(runId))) {
      const report = await this.s.withHeartbeat(runId, 'visual', 'Đối chiếu ảnh ứng dụng với Figma', () => this.s.visualCheck!(run, signal));
      if (report) this.s.artifact(runId, { kind: 'report', title: VISUAL_REPORT_TITLE, content: JSON.stringify(report), checkpoint: run.checkpoint });
    }
    await new MutationChecks(this.s).run(runId, signal, checksOnly);
    const verifies = run.mode === 'verify' || run.mode === 'compare';
    if (!checksOnly && verifies && !readVerdict(this.s.store.artifacts.list(runId), run)) await this.independentVerifier(runId, signal);
    // Nobody is present to confirm a finding the Verifier could not reproduce: give the Developer one round on it, then let it go.
    // v4 keeps an unproven doubt as a blocker for a person to settle; only older policies give it one automatic repair round.
    if (!checksOnly && verifies && !policyOf(run).strict && await this.autoRepairUnconfirmed(runId, signal)) return;
    this.outcome.finish(runId);
  }

  /**
   * One repair round, once per contract version, for blocker/major findings that have no runnable counterexample. Afterwards those
   * findings (and any the re-verification raises without a counterexample) are warnings, not blockers. Returns true when the repair
   * round ran and finished the run itself.
   */
  private async autoRepairUnconfirmed(runId: string, signal: AbortSignal): Promise<boolean> {
    const run = this.s.run(runId);
    const targets = this.s.store.findings.list(runId).filter((f) => needsAutoRepair(f, run.contract.version)).map((f) => ({ ...f, attempted: true }));
    if (!targets.length) return false;
    const marker = 'Unconfirmed finding repair';
    const already = this.s.store.artifacts.list(runId).some((a) => a.title === marker && a.valid && a.contractVersion === run.contract.version);
    for (const f of targets) this.s.store.findings.put(f);
    const budget = remainingFor(budgetState(run, this.s.store.attempts.list(runId)), 'verify');
    if (already || budget <= 0) {
      this.s.fallback(runId, 'Finding của Verifier', `${targets.length} finding chưa có phản ví dụ chạy được ${already ? 'xuất hiện sau vòng sửa tự động' : 'và hết ngân sách để sửa'}; giữ làm cảnh báo, không chặn: ${targets.map((f) => f.title).join('; ').slice(0, 300)}`);
      return false;
    }
    this.s.artifact(runId, { kind: 'report', title: marker, content: JSON.stringify({ findingIds: targets.map((f) => f.id) }), checkpoint: run.checkpoint });
    this.s.log(runId, 'verify.auto_repair', `${targets.length} finding chưa có phản ví dụ chạy được: Developer có một vòng sửa trước khi chúng thành cảnh báo.`);
    await this.repairPhase(runId, signal, targets);
    return true;
  }

  private async independentVerifier(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.s.run(runId);
    const state = budgetState(run, this.s.store.attempts.list(runId));
    if (remainingFor(state, 'verify') <= 0) {
      this.s.log(runId, 'verify.skipped', 'Hết ngân sách kiểm chứng cuối; không chạy Verifier.');
      this.recordVerdict(runId, { decision: 'skipped', summary: '', findingCount: 0 });
      return;
    }
    const diff = reviewDiff(await this.changesSinceBase(runId));
    const independence: Independence = { independent: true, reason: 'Phiên mới; lập checklist từ hợp đồng trước khi đọc diff, không nhận giải thích của Developer.' };
    const checkEvidence=latestChecks(run,this.s.store.checks.list(runId)).map(c=>({id:c.id,recipeId:c.recipeId,checkpoint:c.checkpoint,contractVersion:c.contractVersion,status:c.status,counts:c.counts,issues:c.issues}));
    const visual = readVisualReport(run, this.s.store.artifacts.list(runId));
    const { output, attempt } = await this.s.attempt(runId, { role: 'verifier', stage: 'verify', slot: run.selectedSlot, prompt: `${PROMPTS.verifier(run, diff)}\nBằng chứng runner hiện hành: ${JSON.stringify(checkEvidence)}\nĐối chiếu hình thức từ harness: ${visual ? JSON.stringify(visual) : 'Chưa có report hình ảnh; không suy ra hình thức đạt từ test DOM.'}\n${reproductionGuide}\n${policyOf(run).strict?'Với finding hành vi (behavior), trả kịch bản tái hiện chạy được trong trường reproduction. Không cần tạo finding cho đủ số lượng; nếu chưa viết được kịch bản, ghi reproductionLimitation cụ thể (vì sao không tái hiện được qua public API Node ESM) và không bịa kết quả. Finding blocker/major không có phản ví dụ vẫn chặn nghiệm thu cho tới khi người dùng xử lý có lý do.\n':''}Bổ sung scope={reviewed:["file/điều khoản đã thực sự review"],checkIds:["ID check hiện hành đã dùng"],limitations:["phần chưa xác nhận"],additionalChecks:[{command:"lệnh chính xác",status:"passed|failed|incomplete",detail:"kết quả"}] vào JSON cuối. Không coi pass là đã tự chạy test. Lệnh lỗi môi trường phải ghi incomplete/failed và giới hạn.`, independence, signal });
    await this.s.discardStrayEdits(runId, run.selectedSlot, 'Verifier');
    const created:Finding[]=[];
    const afterAutoRound = !policyOf(run).strict && this.s.store.artifacts.list(runId).some((a) => a.title === 'Unconfirmed finding repair' && a.valid && a.contractVersion === run.contract.version);
    try {
      const parsed = parseOutput(FindingsSchema, output);
      const raw=this.s.store.artifacts.list(runId).find(a=>a.kind==='raw' && a.attemptId===attempt.id)?.content??'';
      const scope=normalizeVerifierScope(run,this.s.store.checks.list(runId),parsed.scope,raw);
      for (const raw of parsed.findings) {
        const gated = gateFinding(raw);
        const scenario=raw.reproduction===undefined?undefined:ReproductionSchema.safeParse(raw.reproduction);
        const reproProblems=scenario?.success?reproductionProblems(run,scenario.data):scenario?['Kịch bản phản ví dụ sai schema.']:[];
        const finding: Finding = {
          id: `fnd_${randomUUID().slice(0, 8)}`, runId, category: gated.category, severity: gated.severity, code: gated.code, title: gated.title,
          location: gated.location, rule: gated.rule, precedent: gated.precedent, evidence: gated.evidence, suggestion: gated.suggestion,
          status: 'open', confirmed: false, checkpoint: run.checkpoint, contractVersion: run.contract.version, createdAt: this.s.stamp(),
          dispute: gated.downgradedBecause,
          // After the automatic round, a doubt without a runnable counterexample is only a warning from the start.
          ...(afterAutoRound && (gated.severity === 'blocker' || gated.severity === 'major') && !(scenario?.success && !reproProblems.length) ? { attempted: true } : {}),
          ...(scenario?.success&&!reproProblems.length?{reproduction:scenario.data}:{}),
          ...(raw.reproductionLimitation||reproProblems.length||(!scenario&&raw.category==='behavior')?{reproductionLimitation:raw.reproductionLimitation||reproProblems.join(' ')||'Verifier chưa cung cấp phản ví dụ có thể chạy.'}:{}),
        };
        this.s.store.findings.put(finding);
        created.push(finding);
      }
      const doubts = created.filter((f) => f.attempted);
      if (doubts.length) this.s.fallback(runId, 'Finding của Verifier', `${doubts.length} finding chưa có phản ví dụ chạy được xuất hiện sau vòng sửa tự động; giữ làm cảnh báo, không chặn: ${doubts.map((f) => f.title).join('; ').slice(0, 300)}`);
      this.s.log(runId, 'verify', `Verifier (${parsed.decision}): ${parsed.findings.length} finding, chờ runner hoặc người xác nhận trước khi chặn.`, { attempt: attempt.id });
      this.recordVerdict(runId, { decision: parsed.decision, summary: verifierNarrative(output), findingCount: parsed.findings.length,scope });
    } catch (error) {
      this.s.log(runId, 'verify.parse_failed', `Output Verifier không hợp lệ; coi như chưa kiểm tra: ${(error as Error).message}`);
      this.recordVerdict(runId, { decision: 'unparsed', summary: verifierNarrative(output), findingCount: 0 });
    }
    const replays=await new FindingReplays(this.s).runBatch(runId,created,signal);
    if(policyOf(run).regression)for(const f of created){
      const replay=f.reproduction?replays.find(r=>r.findingId===f.id&&r.checkpoint===run.checkpoint&&r.scenarioHash===scenarioHash(f.reproduction!)):undefined;
      if(replay?.status==='reproduced')await this.regressions.propose(runId,f,replay,signal);
    }
  }

  /**
   * Everything the run changed, from the base snapshot to its checkpoint: the Author's tests and every Developer round,
   * not only the last repair. Falls back to the stored per-round diffs when the runtime cannot compute it.
   */
  private async changesSinceBase(runId: string): Promise<string> {
    const run = this.s.run(runId);
    const runtime = this.s.runtimeFor(run);
    if (runtime.diffSinceBase) {
      try { return (await runtime.diffSinceBase(run, run.selectedSlot)).patch; }
      catch (error) { this.s.log(runId, 'verify.diff_fallback', `Không lấy được diff từ bản gốc, dùng diff từng vòng: ${(error as Error).message.slice(0, 200)}`); }
    }
    return this.s.store.artifacts.list(runId)
      .filter((a) => a.kind === 'diff' && a.valid && a.checkpoint && a.contractVersion === run.contract.version && (a.title.startsWith(`Diff ${run.selectedSlot} `) || a.title.startsWith('Diff Author') || a.title.startsWith('Diff sửa finding')))
      .map((a) => a.content).join('\n');
  }

  /**
   * Runs reviewed before verdicts were stored still have the reviewer's raw output. Rebuild the verdict from it so the
   * report never claims "the Verifier did not run" about a review that actually happened.
   */
  recoverVerdict(runId: string): void {
    const run = this.s.run(runId);
    if (run.mode !== 'verify' && run.mode !== 'compare') return;
    const artifacts = this.s.store.artifacts.list(runId);
    if (readVerdict(artifacts, run)) return;
    if (!run.checkpoint) return;
    const attempt = this.s.store.attempts.list(runId).filter((a) => a.role === 'verifier' && a.status === 'completed'
      && a.checkpoint === run.checkpoint && a.contractVersion === run.contract.version && a.slot === run.selectedSlot).at(-1);
    const raw = attempt && artifacts.filter((a) => a.kind === 'raw' && a.attemptId === attempt.id && a.valid
      && a.checkpoint === run.checkpoint && a.contractVersion === run.contract.version).at(-1)?.content;
    if (!raw) return;
    let text = '';
    for (const line of raw.split('\n')) {
      try {
        const event = JSON.parse(line) as { type?: string; result?: unknown; item?: { type?: string; text?: unknown } };
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
        else if (event.type === 'result' && typeof event.result === 'string') text = event.result;
      } catch { /* not a JSON line */ }
    }
    if (!text) return;
    try {
      const parsed = parseOutput(FindingsSchema, text);
      this.recordVerdict(runId, { decision: parsed.decision, summary: verifierNarrative(text), findingCount: parsed.findings.length,scope:normalizeVerifierScope(run,this.s.store.checks.list(runId),parsed.scope,raw) });
    } catch { this.recordVerdict(runId, { decision: 'unparsed', summary: verifierNarrative(text), findingCount: 0 }); }
  }

  /**
   * The reviewer's decision and its own words are kept, not just its findings: "abstain" and "not enough evidence"
   * are exactly what a person deciding on acceptance must be able to see.
   */
  private recordVerdict(runId: string, verdict: VerifierVerdict): void {
    this.s.artifact(runId, { kind: 'report', title: 'Verifier verdict', content: JSON.stringify(verdict), checkpoint: this.s.run(runId).checkpoint });
  }

  /** A person asked for one finding's counterexample to be run again on the live checkpoint. No agent is called. */
  async replayPhase(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.s.run(runId), request = run.pendingReplay, finding = request ? this.s.store.findings.get(request.findingId) : undefined;
    if (!finding || finding.runId !== runId || !finding.reproduction) throw new Blocked('Finding không có kịch bản phản ví dụ để chạy lại.');
    this.s.mutate(runId, (r) => { r.stage = 'verify'; });
    const [replay] = await new FindingReplays(this.s).runBatch(runId, [finding], signal, { force: true });
    if (policyOf(run).regression && replay?.status === 'reproduced') await this.regressions.propose(runId, finding, replay, signal);
    this.outcome.finish(runId);
  }

  /**
   * The repair is a new commit and the head of the run. The stored candidate has to say so: "Chạy tiếp" and "Chạy lại check" take the
   * checkpoint from it, and one still pointing at the version before the repair moved the run back while the working copy stayed on the
   * repaired commit, so every report then belonged to another checkpoint.
   */
  private recordRepair(runId: string, slot: Slot, checkpoint: string, files: readonly string[], problems: readonly string[]): void {
    const stored = this.s.store.artifacts.get(`cand-${runId}-${slot}`);
    if (!stored || !stored.valid || stored.contractVersion !== this.s.run(runId).contract.version) return;
    const record = JSON.parse(stored.content) as CandidateRecord;
    record.checkpoint = checkpoint; record.success = problems.length === 0; record.fatal = false; record.problems = [...problems];
    record.changedFiles = [...new Set([...record.changedFiles, ...files])];
    record.testFiles = [...new Set([...record.testFiles, ...files.filter((f) => isTestPath(f))])];
    this.s.store.artifacts.put({ ...this.s.baseArtifact(runId, { kind: 'checkpoint', title: `Candidate ${slot}`, content: JSON.stringify(record), checkpoint }), id: `cand-${runId}-${slot}` });
  }

  /** One repair round on confirmed findings, then fresh checks on the new checkpoint. */
  async repairPhase(runId: string, signal: AbortSignal, extraTargets: Finding[] = []): Promise<void> {
    let run = this.s.run(runId);
    const runtime = this.s.runtimeFor(run);
    const slot = run.selectedSlot;
    this.s.mutate(runId, (r) => { r.stage = 'verify'; });
    const policy = policyOf(run);
    const confirmed = this.s.store.findings.list(runId).filter((f) => f.confirmed && f.status === 'open' && f.contractVersion === run.contract.version);
    if (policy.strict) {
      // A confirmation names the exact proposal a person read; one that no longer matches the checkpoint, contract or configuration is not a go-ahead.
      const artifacts = this.s.store.artifacts.list(runId), stale = confirmed.filter(f => !this.regressions.confirmationValid(run, f, artifacts));
      if (stale.length) throw new Blocked(`Xác nhận của ${stale.map(f => `"${f.title}"`).join(', ')} không còn khớp đề xuất hiện tại (checkpoint, hợp đồng, cấu hình hoặc test đã đổi). Chạy lại phản ví dụ rồi xác nhận lại đề xuất mới.`);
    }
    const targets = [...confirmed, ...extraTargets.filter((f) => !f.confirmed)];
    // The regression tests go in and are locked before the Developer is called, so the unrepaired code is already failing them.
    if (policy.strict) { await this.regressions.applyConfirmed(runId, targets); run = this.s.run(runId); }
    const noted = this.s.store.artifacts.list(runId);
    const problems = targets.map((f) => `${f.title} (${f.location}): ${f.evidence}. Gợi ý: ${f.suggestion}.${this.regressions.note(run, f, noted)}`);
    const resume = this.s.sessions.get(`${runId}:${slot}`);
    await this.s.attempt(runId, { role: 'developer', stage: 'verify', slot, prompt: resume ? PROMPTS.repairFollowUp(problems) : PROMPTS.repair(run, problems), signal, resumeSession: resume });
    run = this.s.run(runId);
    const changes = await runtime.changes(run, slot);
    const scope = evaluateChanges(changes.files, this.scope.scopeFor(runId));
    if (!scope.accepted) {
      await runtime.revert(run, slot);
      this.s.artifact(runId, { kind: 'diff', title: `Patch sửa finding bị từ chối (${slot})`, content: changes.patch, checkpoint: null, valid: false });
      throw new Blocked(`Patch sửa finding vượt phạm vi: ${[...scope.protected, ...scope.needsApproval].join(', ')}`);
    }
    const checkpoint = await runtime.commit(run, slot, `${run.title}: sửa finding đã xác nhận`);
    this.s.mutate(runId, (r) => { r.checkpoint = checkpoint; r.repairCount += 1; });
    this.s.artifact(runId, { kind: 'diff', title: `Diff sửa finding @ ${checkpoint.slice(0, 8)}`, content: changes.patch, checkpoint });
    const outcome = await this.checks.runChecks(runId, slot, checkpoint, [], signal);
    this.recordRepair(runId, slot, checkpoint, changes.files, outcome.problems);
    if (outcome.problems.length) { this.outcome.park(runId, 'blocked', outcome.problems.join(' ')); return; }
    const priorReplays=readFindingReplays(run,this.s.store.artifacts.list(runId));
    const afterReplays=await new FindingReplays(this.s).runBatch(runId,targets,signal);
    if (policy.strict) this.regressions.settle(runId, targets, priorReplays, afterReplays, checkpoint);
    else for (const f of targets) {
      if(f.reproduction){
        const hash=scenarioHash(f.reproduction),before=priorReplays.some(r=>r.findingId===f.id&&r.checkpoint===f.checkpoint&&r.scenarioHash===hash&&r.status==='reproduced');
        const after=afterReplays.find(r=>r.findingId===f.id&&r.checkpoint===checkpoint&&r.scenarioHash===hash);
        if(!before||after?.status!=='not_reproduced')continue;
      }
      f.status = 'resolved'; this.s.store.findings.put(f);
    }
    const proven=targets.filter(f=>f.status==='resolved').length;
    this.s.log(runId, 'repair.done', `Checks đạt trên checkpoint mới; ${proven}/${targets.length} finding đã xác nhận có đủ căn cứ đánh dấu xử lý.${proven<targets.length?' Finding chưa có phản ví dụ chạy được để chứng minh nên vẫn mở: hãy tự thử bản sửa rồi bấm “Đóng bằng review thủ công…” ở tab Kiểm chứng.':''}`);
    await new MutationChecks(this.s).run(runId, signal);
    if (run.mode === 'verify' || run.mode === 'compare') await this.independentVerifier(runId, signal);
    this.outcome.finish(runId);
  }
}
