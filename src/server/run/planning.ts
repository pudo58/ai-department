import { randomUUID } from 'node:crypto';
import type { Independence, Interpretation, Role } from '../../shared/types.js';
import { reviseContract, sha256 } from '../../core/contract.js';
import { ContractProposalSchema, InterpretationSchema, parseOutput } from '../../core/outputs.js';
import { PROMPTS } from '../../core/prompts.js';
import { redactSecrets } from '../../runtime/process.js';
import { Stopped } from './support.js';
import type { RunServices } from './services.js';

/** The first stage: workspace snapshot, optional independent interpretations, and the Planner's contract proposal. */
export class Planning {
  constructor(private readonly s: RunServices) {}

  async planPhase(runId: string, signal: AbortSignal): Promise<void> {
    let run = this.s.run(runId);
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
    this.s.mutate(runId, (r) => { r.status = 'awaiting_approval'; r.blocker = null; });
    this.s.log(runId, 'awaiting_approval', 'Chờ người dùng duyệt hợp đồng.');
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
