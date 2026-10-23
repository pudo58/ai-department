import type { Independence, Slot, Stage } from '../../shared/types.js';
import { budgetState, candidateCap, candidateSpend, MAX_REPAIRS_PER_CANDIDATE } from '../../core/budget.js';
import { isTestPath } from '../../core/testpath.js';
import { parseOutput, ReuseAssessmentSchema } from '../../core/outputs.js';
import { PROMPTS } from '../../core/prompts.js';
import { evaluateChanges } from '../../core/scope.js';
import type { CandidateEval } from '../../core/selection.js';
import { ANALYSIS_TOOLS, toolDelta } from '../../core/tools.js';
import { Blocked, type CandidateRecord } from './support.js';
import type { RunServices } from './services.js';
import type { ScopePolicy } from './scope.js';
import type { CheckRunner } from './checks.js';

/** Produces a candidate solution: the Developer loop (implement, scope check, commit, checks, repairs) and the Author's locked acceptance tests. */
export class CandidateBuilder {
  constructor(private readonly s: RunServices, private readonly scope: ScopePolicy, private readonly checks: CheckRunner) {}

  async implementCandidate(runId: string, slot: Slot, signal: AbortSignal): Promise<CandidateRecord> {
    let run = this.s.run(runId);
    const runtime = this.s.runtimeFor(run);
    const record: CandidateRecord = { slot, checkpoint: null, success: false, problems: [], fatal: false, changedFiles: [], testFiles: [], newToolIssues: 0, flakyChecks: 0, summary: '' };
    let problems: string[] = [];
    const primary = slot === 'B' ? this.candidateRecord(runId, 'A') : undefined;

    for (let round = 0; round <= MAX_REPAIRS_PER_CANDIDATE; round++) {
      run = this.s.run(runId);
      const stage: Stage = round === 0 ? 'implement' : 'repair';
      if (slot === 'B') {
        const cap = candidateCap(budgetState(run, this.s.store.attempts.list(runId)), 2);
        if (candidateSpend(run, this.s.store.attempts.list(runId), 'B') >= cap) { record.problems = ['Phương án B đã dùng hết phần ngân sách của nó.']; break; }
      }
      const resume = round > 0 ? this.s.sessions.get(`${runId}:${slot}`) : undefined;
      const prompt = round === 0
        ? (slot === 'B' ? PROMPTS.alternative(run, primary?.summary || 'Không có tóm tắt.') : PROMPTS.developer(run, this.scope.hasAuthorTests(runId) ? 'Test nghiệm thu do Author viết đã bị khóa; làm cho chúng pass mà không sửa chúng.' : ''))
        : resume ? PROMPTS.repairFollowUp(problems) : PROMPTS.repair(run, problems);
      const { output } = await this.s.attempt(runId, { role: 'developer', stage, slot, prompt, signal, resumeSession: resume });
      this.recordReuse(runId, output);
      record.summary = output.slice(0, 1500);
      if (round > 0) this.s.mutate(runId, (r) => { r.repairCount += 1; });

      const changes = await runtime.changes(run, slot);
      if (!changes.files.length) {
        // An empty patch proves nothing; committing it and running checks would only burn a round on the old code.
        problems = ['Developer không thay đổi file nào. Hãy thực sự sửa mã và thêm test gắn thẻ [R-x]; nếu không thể thực thi lệnh hoặc ghi file, hãy nói rõ lý do.'];
        record.problems = problems;
        this.s.log(runId, 'patch.empty', `Round ${round}: không có thay đổi nào.`);
        continue;
      }
      const scope = evaluateChanges(changes.files, this.scope.scopeFor(runId));
      if (!scope.accepted) {
        this.s.artifact(runId, { kind: 'diff', title: `Patch bị từ chối (${slot})`, content: changes.patch, checkpoint: null, valid: false });
        await runtime.revert(run, slot);
        problems = [
          ...scope.protected.map((f) => `${f}: file được bảo vệ, không được sửa.`),
          ...scope.needsApproval.map((f) => `${f}: nằm ngoài module cho phép, cần người dùng duyệt.`),
        ];
        this.s.log(runId, 'scope.rejected', `Patch bị từ chối: ${problems.join(' ')}`);
        record.problems = problems;
        continue;
      }
      const checkpoint = await runtime.commit(run, slot, `${run.title} (${slot}${round ? ` r${round}` : ''})`);
      record.checkpoint = checkpoint;
      record.changedFiles = [...new Set([...record.changedFiles, ...changes.files])];
      record.testFiles = [...new Set([...record.testFiles, ...changes.files.filter((f) => isTestPath(f))])];
      this.s.artifact(runId, { kind: 'diff', title: `Diff ${slot} @ ${checkpoint.slice(0, 8)}`, content: changes.patch, checkpoint });
      if (slot === 'A') this.s.mutate(runId, (r) => { r.checkpoint = checkpoint; });

      const outcome = await this.checks.runChecks(runId, slot, checkpoint, record.testFiles, signal);
      record.flakyChecks = outcome.flaky;
      problems = outcome.problems;
      record.problems = problems;
      if (outcome.fatal.length) { record.fatal = true; record.problems = outcome.fatal; break; }
      if (!problems.length) { record.success = true; record.problems = []; break; }
      if (!outcome.repairable) break;
    }
    if (record.checkpoint) await this.analyzeTools(runId, slot, record);
    this.s.store.artifacts.put({ ...this.s.baseArtifact(runId, { kind: 'checkpoint', title: `Candidate ${slot}`, content: JSON.stringify(record), checkpoint: record.checkpoint }), id: `cand-${runId}-${slot}` });
    return record;
  }

  private async analyzeTools(runId: string, slot: Slot, record: CandidateRecord): Promise<void> {
    const run = this.s.run(runId);
    const runtime = this.s.runtimeFor(run);
    const deltas = [];
    for (const tool of ANALYSIS_TOOLS) {
      const [base, candidate] = [await runtime.runTool(run, slot, tool, 'base'), await runtime.runTool(run, slot, tool, 'candidate')];
      deltas.push(toolDelta(base, candidate));
    }
    record.newToolIssues = deltas.reduce((n, d) => n + d.newIssues.length, 0);
    this.s.artifact(runId, { kind: 'tool', title: `Phân tích công cụ (${slot})`, content: JSON.stringify(deltas), checkpoint: record.checkpoint });
  }

  candidateRecord(runId: string, slot: Slot): CandidateRecord | undefined {
    const run = this.s.run(runId);
    const artifact = this.s.store.artifacts.get(`cand-${runId}-${slot}`);
    if (!artifact || artifact.contractVersion !== run.contract.version || !artifact.valid) return undefined;
    return JSON.parse(artifact.content) as CandidateRecord;
  }

  evaluateCandidate(record: CandidateRecord): CandidateEval {
    return { slot: record.slot, eliminatedBecause: record.success ? null : record.problems.join(' ') || 'Không đạt check bắt buộc.', changedFiles: record.changedFiles.length, newToolIssues: record.newToolIssues, flakyChecks: record.flakyChecks };
  }

  testFilesFromDiffs(runId: string): string[] {
    const files = new Set<string>();
    for (const a of this.s.store.artifacts.list(runId).filter((x) => x.kind === 'diff' && x.valid)) {
      for (const m of a.content.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) if (isTestPath(m[2]!)) files.add(m[2]!);
    }
    return [...files];
  }

  /** Verify mode: an Author writes tests from the contract alone; they are locked before the Developer starts. */
  async authorAcceptanceTests(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.s.run(runId);
    const runtime = this.s.runtimeFor(run);
    const independence: Independence = { independent: true, reason: 'Author chỉ nhận hợp đồng; chưa có kế hoạch triển khai của Developer.' };
    // A non-test file inside the allowed modules (a .md note, a helper) is a slip the Author can fix, so it gets one retry
    // with the offending files named. Out-of-scope or protected paths need a person, so they block immediately.
    let extra = '';
    let changes: Awaited<ReturnType<typeof runtime.changes>>;
    for (let round = 0; ; round++) {
      await this.s.attempt(runId, { role: 'author', stage: 'implement', slot: 'A', prompt: PROMPTS.author(run, extra), independence, signal });
      changes = await runtime.changes(run, 'A');
      const stray = changes.files.filter((f) => !isTestPath(f));
      const scope = evaluateChanges(changes.files, this.scope.scopeFor(runId));
      if (!stray.length && scope.accepted) break;
      const strayOnly = scope.accepted && !scope.protected.length && !scope.needsApproval.length;
      // Recorded like a rejected Developer patch, so the run page can offer to approve the out-of-scope paths.
      this.s.artifact(runId, { kind: 'diff', title: 'Patch bị từ chối (Author)', content: changes.patch, checkpoint: null, valid: false });
      await runtime.revert(run, 'A');
      const violations = [...new Set([...stray, ...scope.protected, ...scope.needsApproval])];
      if (strayOnly && round === 0) {
        extra = `Lần trước bạn tạo file không phải test (${stray.join(', ')}) nên toàn bộ bị hoàn nguyên. Làm lại và CHỈ tạo file test.\n`;
        this.s.log(runId, 'author.retry', `Author tạo file không phải test (${stray.join(', ')}); hoàn nguyên và yêu cầu làm lại một lần.`);
        continue;
      }
      throw new Blocked(`Author chỉ được thêm file test (tests/, *.test.ts, *.spec.ts) trong module cho phép. Vi phạm: ${violations.join(', ')}`);
    }
    const checkpoint = await runtime.commit(run, 'A', `${run.title}: acceptance tests`);
    this.s.mutate(runId, (r) => { r.checkpoint = checkpoint; });
    this.s.artifact(runId, { kind: 'diff', title: 'Diff Author', content: changes.patch, checkpoint });
    // The artifact is also the marker that the Author step is done. Without it, an Author that wrote nothing would be
    // run again on every resume, spending tokens each time for the same empty result.
    if (!changes.files.length) this.s.log(runId, 'author.empty', 'Author không viết test nào; tiếp tục với Developer (yêu cầu sẽ chỉ được xác minh bằng test Developer viết).');
    this.scope.lockAcceptance(runId, changes.files, checkpoint, 'Acceptance suite (Author)', true);
  }

  private recordReuse(runId: string, output: string): void {
    try {
      const reuse = parseOutput(ReuseAssessmentSchema, output);
      this.s.artifact(runId, { kind: 'reuse', title: 'ReuseAssessment', content: JSON.stringify(reuse), checkpoint: this.s.run(runId).checkpoint });
    } catch { this.s.log(runId, 'reuse.missing', 'Developer không cung cấp ReuseAssessment hợp lệ.'); }
  }
}
