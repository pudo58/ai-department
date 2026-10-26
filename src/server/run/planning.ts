import { deepQuality } from '../../core/qualityevidence.js';
import { planRepairProblems, planRepairNotes, casesNamedBy, UNRESOLVED_PLAN_QUESTIONS, testPlanFindings } from '../../core/testplan.js';
import { parseTestPlanOutput } from '../../core/planfix.js';
import { canonicalJson, hashContract } from '../../core/contract.js';
import { budgetState, remainingFor } from '../../core/budget.js';
import { Blocked } from './support.js';
import { randomUUID } from 'node:crypto';
import type { Independence, Interpretation, Role } from '../../shared/types.js';
import type { TestPlan, TestPlanReview } from '../../shared/quality.js';
import { reviseContract, sha256 } from '../../core/contract.js';
import { ContractProposalSchema, extractJsonBlock, InterpretationSchema, parseOutput } from '../../core/outputs.js';
import { PROMPTS } from '../../core/prompts.js';
import { redactSecrets } from '../../runtime/process.js';
import { Stopped } from './support.js';
import type { RunServices } from './services.js';
import { EnvironmentChecks } from './environment.js';

/** The first stage: workspace snapshot, optional independent interpretations, and the Planner's contract proposal. */
export class Planning {
  constructor(private readonly s: RunServices) {}

  async planPhase(runId: string, signal: AbortSignal): Promise<void> {
    let run = this.s.run(runId);
    if (deepQuality(run)) {
      // A stored draft belongs to the person reviewing it. Resume cannot reopen Planner/Author or reset the repair limit.
      if (run.contract.testPlan) {
        this.s.mutate(runId, r => { r.status = 'awaiting_approval'; r.blocker = null; });
        this.s.log(runId, 'awaiting_approval', 'Kế hoạch ca đã lưu; xem và sửa trong Hợp đồng trước khi duyệt.');
        return;
      }
      const blocked = this.s.store.artifacts.list(runId).some(a => a.title === 'Test plan attempt' && a.valid && a.contractVersion === run.contract.version && a.content === hashContract(run.contract));
      if (blocked) throw new Blocked('Lượt lập kế hoạch ca trước chưa hoàn tất. Sửa kế hoạch trong Hợp đồng; không tự gọi lại AI.');
    }
    this.s.mutate(runId, (r) => { r.stage = 'prepare'; });
    const runtime = this.s.runtimeFor(run);
    if (!run.baseSha) {
      const setup = run.configSnapshot.setupCommand;
      this.s.log(runId, 'prepare.start', `Đang tạo bản sao làm việc${setup.length ? ` và chạy "${setup.join(' ')}" (có thể mất vài phút, tối đa ${Math.round((run.configSnapshot.limits?.setupMs ?? 20 * 60_000) / 60_000)} phút)` : ''}…`);
      const prepared = await this.s.withHeartbeat(runId, 'setup', 'Chuẩn bị bản sao/cài dependency', () => runtime.prepare(run, 'A', this.s.runtimeLog(runId, 'setup')));
      this.s.mutate(runId, (r) => { r.baseSha = prepared.baseSha; r.branch = prepared.branch; });
      for (const warning of prepared.warnings) this.s.log(runId, 'prepare.warning', warning);
      this.s.log(runId, 'prepare', `Snapshot tại ${prepared.baseSha}.`);
      run = this.s.run(runId);
    }
    await new EnvironmentChecks(this.s).run(runId,signal);
    await this.s.ensureContext(runId);
    await this.s.loadBaseFiles(runId);
    run = this.s.run(runId);
    if (run.mode === 'clarify') await this.interpretIndependently(runId, signal);
    run = this.s.run(runId);
    const prompt = run.mode === 'clarify' && run.interpretations.length ? PROMPTS.synthesize(run) : PROMPTS.planner(run);
    const { output } = await this.s.attempt(runId, { role: 'planner', stage: 'prepare', slot: 'A', prompt, signal });
    await this.s.discardStrayEdits(runId, 'A', 'Planner');
    try {
      const proposal = parseOutput(ContractProposalSchema, output);
      const current = this.s.run(runId).contract;
      const next = reviseContract(current, { ...proposal });
      this.s.mutate(runId, (r) => { r.contract = next; });
      if (next !== current) this.s.log(runId, 'contract.proposed', `Planner đề xuất hợp đồng v${next.version}.`);
    } catch (error) {
      this.s.log(runId, 'contract.parse_failed', `Giữ hợp đồng nháp: ${(error as Error).message}`);
    }
    run = this.s.run(runId);
    if (deepQuality(run)) await this.testPlan(runId, signal);
    this.s.mutate(runId, (r) => { r.status = 'awaiting_approval'; r.blocker = null; });
    this.s.log(runId, 'awaiting_approval', 'Chờ người dùng duyệt hợp đồng.');
  }

  /** One initial draft and at most one correction, both read-only and inside the existing prepare budget. */
  private async testPlan(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.s.run(runId), contractHash = hashContract(run.contract);
    this.s.artifact(runId, { kind: 'report', title: 'Test plan attempt', content: contractHash, checkpoint: null });
    let output = '', plan: TestPlan | undefined, original: TestPlan | undefined, questions: string[] = [];
    let initialProblems: string[] = [], problems: string[] = [], reason: TestPlanReview['reason'], normalizations: string[] = [], advisories: string[] = [];
    const attemptIds: string[] = [];
    let repairAttempted = false, selectedAttemptId: string | undefined;
    for (let round = 0; round < 2; round++) {
      let attemptId: string;
      try {
        const result = await this.s.attempt(runId, { role: 'author', stage: 'prepare', slot: 'A', noSkills: true, readOnly: true,
          prompt: round === 0 ? PROMPTS.testPlan(run) : PROMPTS.testPlanRepair(run, output, initialProblems, questions), signal,
          independence: { independent: true, reason: 'Yêu cầu gốc và hợp đồng trước Developer; chưa có patch hay giải thích triển khai.' } });
        output = result.output; attemptId = result.attempt.id; attemptIds.push(attemptId);
      } finally { await this.s.discardStrayEdits(runId, 'A', 'Author lập kế hoạch'); }
      if (round === 0) {
        // Even a schema-invalid JSON draft may contain a real unanswered question. A correction cannot silently drop it.
        try { const raw = extractJsonBlock(output) as { questions?: unknown }; questions = Array.isArray(raw?.questions) ? raw.questions.filter((q): q is string => typeof q === 'string' && !!q.trim()).map(q => q.trim()) : []; } catch { /* No parseable question list. */ }
      }
      let parsed: TestPlan | undefined, roundChanges: string[] = [], roundAdvisories: string[] = [];
      try {
        const read = parseTestPlanOutput(output, run.contract);
        parsed = read.plan; roundChanges = read.changes;
        const findings = testPlanFindings({ ...run.contract, testPlan: parsed }, true, run.qualityPolicyVersion === 3);
        problems = findings.blocking; roundAdvisories = findings.advisories;
        if ((run.qualityPolicyVersion??0) >= 2 && parsed.schemaVersion !== 2) problems.push('Chính sách v2+ cần kế hoạch ca có căn cứ v2.');
      } catch (error) { problems = [(error as Error).message]; }
      const safeguards = round === 1 && parsed ? planRepairProblems(original, questions, parsed, run.contract.requirements.map(r => r.id), casesNamedBy(initialProblems)) : [];
      if (round === 1 && (!parsed || safeguards.length)) {
        // Keep the original draft available to edit when the repair weakens it or cannot be parsed.
        problems = [...initialProblems, ...problems, ...safeguards]; reason = 'repair_rejected';
      } else { plan = parsed; selectedAttemptId = attemptId; normalizations = roundChanges; advisories = [...roundAdvisories, ...(round === 1 ? planRepairNotes(original, parsed!, casesNamedBy(initialProblems)) : [])]; }
      if (round === 0) { original = parsed; initialProblems = [...problems]; }
      if (!problems.length) break;
      this.s.artifact(runId, { kind: 'report', title: 'Test plan validation error', attemptId,
        content: JSON.stringify({ schemaVersion: 1, source: 'server', contractHash, round, output: redactSecrets(output), problems }), checkpoint: null });
      if (round === 1) break;
      if (problems.every(p => p === UNRESOLVED_PLAN_QUESTIONS)) { reason = 'questions_only'; break; }
      if (remainingFor(budgetState(this.s.run(runId), this.s.store.attempts.list(runId)), 'prepare') <= 0) { reason = 'budget_exhausted'; break; }
      // Persist before calling the model: interruption/restart cannot grant a fresh correction.
      this.s.artifact(runId, { kind: 'report', title: 'Test plan repair attempt', attemptId,
        content: JSON.stringify({ schemaVersion: 1, source: 'server', contractHash, configHash: sha256(canonicalJson(run.configSnapshot)), baseSha: run.baseSha, initialAttemptId: attemptId, draftHash: sha256(output), problems }), checkpoint: null });
      repairAttempted = true;
      this.s.retry(runId, 'invalid_output', `Author sửa kế hoạch ca một lần theo ${problems.length} lỗi kiểm tra; chưa duyệt hợp đồng.`);
    }
    if (plan) {
      const next = reviseContract(run.contract, { ...run.contract, testPlan: plan });
      this.s.mutate(runId, r => { r.contract = next; });
      this.s.artifact(runId, { kind: 'report', title: 'Test plan', attemptId: selectedAttemptId,
        content: JSON.stringify({ schemaVersion: 1, source: 'author', contractHash: hashContract(next), plan }), checkpoint: null });
    }
    const current = this.s.run(runId).contract;
    const review: TestPlanReview = { schemaVersion: 1, source: 'server', contractHash: hashContract(current), contractVersion: current.version,
      attemptIds, firstPassValid: !initialProblems.length, repairAttempted, repairAccepted: repairAttempted && !problems.length,
      outcome: !plan ? 'invalid_output' : problems.length ? 'needs_review' : 'valid', reason, initialProblems, remainingProblems: [...new Set(problems)], remainingAdvisories: [...new Set(advisories)], normalizations };
    this.s.artifact(runId, { kind: 'report', title: 'Test plan review', content: JSON.stringify(review), checkpoint: null });
    if (normalizations.length) this.s.log(runId, 'testplan.normalized', `Server chuẩn hoá ${normalizations.length} chỗ trong kế hoạch ca (không đổi nội dung nghiệp vụ): ${normalizations.slice(0, 6).join(' ')}${normalizations.length > 6 ? ' …' : ''}`);
    this.s.log(runId, 'testplan.review', problems.length ? `Kế hoạch ca cần người dùng xử lý: ${review.remainingProblems.join(' ')}` : 'Kế hoạch ca hợp lệ theo validator; chờ người dùng duyệt.', review);
    if (!plan) throw new Blocked(`Không đọc được kế hoạch ca: ${review.remainingProblems.join(' ')}. Sửa Hợp đồng trước khi duyệt; không tự cấp thêm lượt AI.`);
  }

  /** Independent readings: each sees only the original requirement and snapshot, never the contract or another reading. */
  private async interpretIndependently(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.s.run(runId);
    const roles: Role[] = ['investigator', 'author'];
    const independence: Independence = { independent: true, reason: 'Chỉ nhận yêu cầu gốc và snapshot; chưa thấy hợp đồng hay kết luận khác.' };
    const results = await Promise.allSettled(roles.map((role) => this.s.attempt(runId, { role, stage: 'prepare', slot: 'A', prompt: PROMPTS.interpreter(run), independence, signal, noSkills: true })));
    await this.s.runtimeFor(run).revert(run, 'A');
    const found: Interpretation[] = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        if (signal.aborted) return;
        this.s.log(runId, 'interpretation.failed', `${roles[index]}: ${redactSecrets(String(result.reason))}`);
        return;
      }
      try {
        const parsed = parseOutput(InterpretationSchema, result.value.output);
        found.push({ id: `int_${randomUUID().slice(0, 8)}`, role: roles[index]!, text: parsed.interpretation, questions: parsed.questions, sourceHash: sha256(run.originalRequirement + (run.baseSha ?? '')), contractSeen: false, createdAt: this.s.stamp() });
      } catch (error) { this.s.log(runId, 'interpretation.parse_failed', (error as Error).message); }
    });
    if (signal.aborted) throw new Stopped();
    this.s.mutate(runId, (r) => { r.interpretations = found; });
  }
}
