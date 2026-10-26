import { hashContract } from '../../core/contract.js';
import { deepQuality, latestChecks, readManifest } from '../../core/qualityevidence.js';
import type { TestManifest } from '../../shared/quality.js';
import type { Artifact } from '../../shared/types.js';
import { classifyPath, type ScopeInput } from '../../core/scope.js';
import type { CandidateRecord } from './support.js';
import type { RunServices } from './services.js';

/** What a run may touch: allowed modules, approved paths, protected and locked files, and the acceptance suite lock. */
export class ScopePolicy {
  constructor(private readonly s: RunServices) {}

  scopeFor(runId: string): ScopeInput {
    const run = this.s.run(runId);
    // Regression tests already in the project (shipped by an earlier run or added by this one) are as locked as the Author's tests.
    const lockedPaths = [...this.lockedArtifacts(runId).flatMap((a) => (JSON.parse(a.content) as { paths: string[] }).paths), ...(this.s.regressions.get(runId) ?? []).map(r => r.path)];
    // Without a known base file list nothing may be scaffolded: the safe default is the plain protected set.
    const baseFiles = run.configSnapshot.allowScaffold ? this.s.baseFileCache.get(runId) : undefined;
    return { modules: [...run.configSnapshot.modules, ...(run.approvedPaths ?? [])], protectedPaths: run.configSnapshot.protectedPaths, lockedPaths, ...(baseFiles ? { scaffold: { baseFiles } } : {}) };
  }

  private lockedArtifacts(runId: string): Artifact[] {
    const run = this.s.run(runId);
    return this.s.store.artifacts.list(runId).filter((a) => a.kind === 'acceptance' && a.title !== 'Test manifest' && a.valid && a.contractVersion === run.contract.version);
  }

  lockAcceptance(runId: string, files: string[], checkpoint: string, title = 'Acceptance suite', force = false): void {
    if (files.length || force) {
      const content = JSON.stringify({ paths: [...new Set(files)].sort() });
      this.s.artifact(runId, { kind: 'acceptance', title, content, checkpoint });
    }
    const run = this.s.run(runId);
    const artifacts = this.s.store.artifacts.list(runId);
    const previous = readManifest(run, artifacts);
    if (!deepQuality(run) && (!previous || previous.manifest.source === 'observed')) {
      const byRecipe = new Map((previous?.manifest.observed ?? []).map(r => [r.recipeId, r.testIds]));
      for (const c of latestChecks(run, this.s.store.checks.list(runId)).filter(c => c.status === 'passed' && !c.quarantined)) byRecipe.set(c.recipeId, [...new Set([...(byRecipe.get(c.recipeId) ?? []), ...c.testIds])]);
      const observed = [...byRecipe].map(([recipeId, testIds]) => ({ recipeId, testIds }));
      if (observed.some(r => r.testIds.length)) {
        const manifest: TestManifest = { schemaVersion: 1, source: 'observed', slot: run.selectedSlot, contractHash: hashContract(run.contract), contractVersion: run.contract.version, entries: [], observed };
        const content = JSON.stringify(manifest);
        if (!previous || JSON.stringify(previous.manifest) !== content) {
          for (const a of artifacts.filter(a => a.title === 'Test manifest' && a.valid && a.contractVersion === run.contract.version)) this.s.store.artifacts.put({ ...a, valid: false });
          this.s.artifact(runId, { kind: 'acceptance', title: 'Test manifest', content, checkpoint });
        }
      }
    }
    this.s.log(runId, 'acceptance.locked', `Khóa ${files.length} file test nghiệm thu.`);
  }

  hasAuthorTests(runId: string): boolean {
    return this.lockedArtifacts(runId).some((a) => a.title === 'Acceptance suite (Author)');
  }

  /** Files from the newest rejected patch that still need approval, so the UI can ask exactly about them. */
  pendingPaths(runId: string): string[] {
    const run = this.s.run(runId);
    if (!['blocked', 'paused', 'failed'].includes(run.status)) return [];
    const rejected = this.s.store.artifacts.list(runId).filter((a) => a.kind === 'diff' && !a.valid && a.title.startsWith('Patch') && a.contractVersion === run.contract.version).at(-1);
    if (!rejected) return [];
    const files = new Set<string>();
    for (const m of rejected.content.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) files.add(m[2]!);
    for (const m of rejected.content.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]!);
    const scope = this.scopeFor(runId);
    return [...files].filter((f) => classifyPath(f, scope) === 'needs_approval');
  }

  discardFailedCandidates(runId: string): void {
    for (const slot of ['A', 'B'] as const) {
      const artifact = this.s.store.artifacts.get(`cand-${runId}-${slot}`);
      if (artifact && !(JSON.parse(artifact.content) as CandidateRecord).success) this.s.store.artifacts.delete(artifact.id);
    }
  }
}
