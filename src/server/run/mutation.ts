import type { MutationResult } from '../../shared/quality.js';
import { deepQuality, qualityDetail, readMutation, recipeHash } from '../../core/qualityevidence.js';
import { emptyMutationCounts } from '../../runtime/mutation.js';
import { Stopped } from './support.js';
import type { RunServices } from './services.js';

/** Diagnostic quality evidence; never turns tool errors or surviving mutants into a fabricated pass. */
export class MutationChecks {
  constructor(private readonly s: RunServices) {}
  async run(runId: string, signal: AbortSignal, force = false): Promise<void> {
    const run = this.s.run(runId);
    if (!deepQuality(run) || !run.checkpoint) return;
    const artifacts = this.s.store.artifacts.list(runId), checks = this.s.store.checks.list(runId);
    const quality = qualityDetail(run, checks, artifacts);
    if (quality.manifestProblems.length || quality.cases.some(c => c.required && c.method === 'automated' && c.status !== 'passed')) return;
    if (!force && readMutation(run, artifacts)) return;
    const runtime = this.s.runtimeFor(run);
    const capability = runtime.detectMutation ? await runtime.detectMutation(run, run.selectedSlot) : { status: 'unsupported' as const, reason: 'Runtime này chưa cung cấp adapter mutation.' };
    this.s.artifact(runId, { kind: 'report', title: 'Mutation capability', content: JSON.stringify({ schemaVersion: 1, source: 'detector', configHash: recipeHash(run), capability }), checkpoint: run.checkpoint });
    if (capability.status !== 'available' || !runtime.runMutation) { this.s.log(runId, 'mutation.unavailable', capability.reason); return; }
    const initial: MutationResult = { schemaVersion: 1, source: 'stryker-vitest', status: 'in_progress', checkpoint: run.checkpoint, contractVersion: run.contract.version, slot: run.selectedSlot,
      configHash: recipeHash(run), capability, startedAt: this.s.stamp(), durationMs: 0, baseline: 'unknown', counts: emptyMutationCounts(), mutants: [], files: [], message: 'Đang chạy mutation trong bản sao riêng.' };
    const artifact = this.s.artifact(runId, { kind: 'report', title: 'Mutation result', content: JSON.stringify(initial), checkpoint: run.checkpoint });
    let result: MutationResult;
    try {
      result = await this.s.withHeartbeat(runId, 'mutation', 'Kiểm tra khả năng bắt lỗi của test (tối đa 5 phút)', () => runtime.runMutation!({ run, slot: run.selectedSlot, capability, signal, onEvent: this.s.runtimeLog(runId, 'mutation') }));
    } catch (error) { result = { ...initial, status: 'incomplete', endedAt: this.s.stamp(), message: (error as Error).message }; }
    this.s.store.artifacts.put({ ...this.s.baseArtifact(runId, { kind: 'report', title: 'Mutation result', content: JSON.stringify(result), checkpoint: run.checkpoint }), id: artifact.id });
    this.s.log(runId, 'mutation.done', `${result.status}: killed ${result.counts.killed}, survived ${result.counts.survived}, no coverage ${result.counts.no_coverage}; ${result.message}`);
    if (signal.aborted) throw new Stopped();
  }
}
