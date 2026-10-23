import { randomUUID } from 'node:crypto';
import type { Finding, Independence } from '../../shared/types.js';
import { budgetState, remainingFor } from '../../core/budget.js';
import { gateFinding } from '../../core/findings.js';
import { FindingsSchema, parseOutput } from '../../core/outputs.js';
import { PROMPTS } from '../../core/prompts.js';
import { readVerdict, type VerifierVerdict } from '../../core/report.js';
import { evaluateChanges } from '../../core/scope.js';
import { reviewDiff } from '../../core/reviewdiff.js';
import { Blocked, verifierNarrative } from './support.js';
import type { RunServices } from './services.js';
import type { ScopePolicy } from './scope.js';
import type { RunOutcome } from './outcome.js';
import type { CheckRunner } from './checks.js';

/** Final verification: the independent Verifier, its stored verdict, and the repair round for confirmed findings. */
export class Verification {
  constructor(private readonly s: RunServices, private readonly scope: ScopePolicy, private readonly outcome: RunOutcome, private readonly checks: CheckRunner) {}

  async verifyPhase(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.s.run(runId);
    this.s.mutate(runId, (r) => { r.stage = 'verify'; });
    if (run.mode === 'verify' || run.mode === 'compare') await this.independentVerifier(runId, signal);
    this.outcome.finish(runId);
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
    const { output, attempt } = await this.s.attempt(runId, { role: 'verifier', stage: 'verify', slot: run.selectedSlot, prompt: PROMPTS.verifier(run, diff), independence, signal });
    await this.s.discardStrayEdits(runId, run.selectedSlot, 'Verifier');
    try {
      const parsed = parseOutput(FindingsSchema, output);
      for (const raw of parsed.findings) {
        const gated = gateFinding(raw);
        const finding: Finding = {
          id: `fnd_${randomUUID().slice(0, 8)}`, runId, category: gated.category, severity: gated.severity, code: gated.code, title: gated.title,
          location: gated.location, rule: gated.rule, precedent: gated.precedent, evidence: gated.evidence, suggestion: gated.suggestion,
          status: 'open', confirmed: false, checkpoint: run.checkpoint, contractVersion: run.contract.version, createdAt: this.s.stamp(),
          dispute: gated.downgradedBecause,
        };
        this.s.store.findings.put(finding);
      }
      this.s.log(runId, 'verify', `Verifier (${parsed.decision}): ${parsed.findings.length} finding, chờ runner hoặc người xác nhận trước khi chặn.`, { attempt: attempt.id });
      this.recordVerdict(runId, { decision: parsed.decision, summary: verifierNarrative(output), findingCount: parsed.findings.length });
    } catch (error) {
      this.s.log(runId, 'verify.parse_failed', `Output Verifier không hợp lệ; coi như chưa kiểm tra: ${(error as Error).message}`);
      this.recordVerdict(runId, { decision: 'unparsed', summary: verifierNarrative(output), findingCount: 0 });
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
    const attempt = this.s.store.attempts.list(runId).filter((a) => a.role === 'verifier' && a.status === 'completed').at(-1);
    const raw = attempt && artifacts.filter((a) => a.kind === 'raw' && a.attemptId === attempt.id).at(-1)?.content;
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
      this.recordVerdict(runId, { decision: parsed.decision, summary: verifierNarrative(text), findingCount: parsed.findings.length });
    } catch { this.recordVerdict(runId, { decision: 'unparsed', summary: verifierNarrative(text), findingCount: 0 }); }
  }

  /**
   * The reviewer's decision and its own words are kept, not just its findings: "abstain" and "not enough evidence"
   * are exactly what a person deciding on acceptance must be able to see.
   */
  private recordVerdict(runId: string, verdict: VerifierVerdict): void {
    this.s.artifact(runId, { kind: 'report', title: 'Verifier verdict', content: JSON.stringify(verdict), checkpoint: this.s.run(runId).checkpoint });
  }

  /** One repair round on confirmed findings, then fresh checks on the new checkpoint. */
  async repairPhase(runId: string, signal: AbortSignal): Promise<void> {
    let run = this.s.run(runId);
    const runtime = this.s.runtimeFor(run);
    const slot = run.selectedSlot;
    this.s.mutate(runId, (r) => { r.stage = 'verify'; });
    const targets = this.s.store.findings.list(runId).filter((f) => f.confirmed && f.status === 'open' && f.contractVersion === run.contract.version);
    const problems = targets.map((f) => `${f.title} (${f.location}): ${f.evidence}. Gợi ý: ${f.suggestion}`);
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
    if (outcome.problems.length) { this.outcome.park(runId, 'blocked', outcome.problems.join(' ')); return; }
    for (const f of targets) { f.status = 'resolved'; this.s.store.findings.put(f); }
    this.s.log(runId, 'repair.done', `Đã sửa ${targets.length} finding đã xác nhận; check pass trên checkpoint mới.`);
    if (run.mode === 'verify' || run.mode === 'compare') await this.independentVerifier(runId, signal);
    this.outcome.finish(runId);
  }
}
