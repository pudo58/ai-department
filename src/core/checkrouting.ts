import type { Artifact, CheckResult, Run } from '../shared/types.js';
import { latestChecks, readManifest } from './qualityevidence.js';

export interface CheckRoute {
  kind: 'blocked' | 'assertion' | 'implementation' | 'passed';
  reasons: string[];
}

/** The same evidence gates apply before a repair and before a resumed Developer attempt. */
export function routeCheckFailure(run: Run, checks: readonly CheckResult[], artifacts: readonly Artifact[]): CheckRoute {
  const recipes = run.configSnapshot.checks.filter(r => r.required);
  const current = latestChecks(run, checks).filter(c => c.required && recipes.some(r => r.id === c.recipeId));
  const manifest = readManifest(run, artifacts);
  const reasons: string[] = [];
  let assertion = false, implementation = false;
  for (const check of current) {
    const recipe = recipes.find(r => r.id === check.recipeId)!;
    reasons.push(...(check.issues ?? []).filter(i => i.kind !== 'assertion_failed').map(i => i.message));
    if (check.missingTestIds.length) reasons.push(`${check.recipeId}: thiếu hoặc bỏ qua test đã khóa.`);
    if (check.status === 'incomplete' || check.status === 'flaky') reasons.push(`${check.recipeId}: check chưa hoàn tất hoặc flaky.`);
    if (recipe.reportPath && (!manifest || check.manifestHash !== manifest.hash)) reasons.push(`${check.recipeId}: report không khớp manifest hiện tại.`);
    if (check.status === 'failed') {
      if (!recipe.reportPath) implementation = true;
      else if (check.outcomes?.some(o => o.status === 'failed')) assertion = true;
      else reasons.push(`${check.recipeId}: chưa có assertion thất bại đã nhận diện đúng.`);
    }
  }
  // A compiler failure explains why dependent test recipes did not run yet.
  if (!implementation) for (const recipe of recipes) {
    if (!current.some(c => c.recipeId === recipe.id)) reasons.push(`${recipe.id}: thiếu kết quả trên checkpoint/cấu hình hiện tại.`);
  }
  if (reasons.length) return { kind: 'blocked', reasons: [...new Set(reasons)] };
  return { kind: assertion ? 'assertion' : implementation ? 'implementation' : 'passed', reasons: [] };
}
