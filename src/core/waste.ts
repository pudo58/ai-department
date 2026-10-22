import type { Attempt, Run } from '../shared/types.js';
import { usageCost } from './budget.js';

export type WasteKind = 'repeat-review' | 'provider-error' | 'failed' | 'stuck';
export interface WasteItem { kind: WasteKind; runId: string; runTitle: string; count: number; costUsd: number; detail: string; at: string }
export interface WasteReport { items: WasteItem[]; costUsd: number }

/** Provider-side trouble (busy model, quota): nothing the task did wrong, but the attempt still cost time and maybe tokens. */
export const PROVIDER_ERROR = /at capacity|overloaded|\b503\b|quota|rate.?limit|usage limit|limit reached|hit your [\w -]*limit|resource.?exhausted|\b429\b/i;
const WAITING: readonly string[] = ['blocked', 'failed', 'paused', 'awaiting_approval', 'awaiting_acceptance'];
const STUCK_MS = 24 * 3_600_000;

/** Cost of each attempt over its whole life, from the usage records of every run. */
export function attemptCosts(runs: readonly Run[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const run of runs) for (const u of run.usage) out.set(u.attemptId, (out.get(u.attemptId) ?? 0) + usageCost(u));
  return out;
}

/**
 * Spending that bought nothing new, within the window starting at `start`:
 * - a reviewer run again on the same checkpoint and contract version (the code did not change, so neither can the verdict's basis);
 * - attempts that failed or were interrupted, with provider-side errors (busy model, quota) reported separately;
 * - tasks waiting on a person for over a day (no cost, but they hold budget and attention).
 * These are estimates to point at, not accounting.
 */
export function findWaste(runs: readonly Run[], attempts: readonly Attempt[], start: number, now: number): WasteReport {
  const cost = attemptCosts(runs);
  const title = new Map(runs.map((r) => [r.id, r.title]));
  const items: WasteItem[] = [];

  const reviews = new Map<string, Attempt[]>();
  for (const a of attempts) {
    if (a.role !== 'verifier' || !a.checkpoint) continue;
    const key = `${a.runId}|${a.checkpoint}|${a.contractVersion}`;
    reviews.set(key, [...(reviews.get(key) ?? []), a]);
  }
  for (const group of reviews.values()) {
    if (group.length < 2) continue;
    const extra = group.sort((x, y) => x.startedAt.localeCompare(y.startedAt)).slice(1).filter((a) => Date.parse(a.startedAt) >= start);
    if (!extra.length) continue;
    const first = group[0]!;
    items.push({
      kind: 'repeat-review', runId: first.runId, runTitle: title.get(first.runId) ?? first.runId, count: extra.length,
      costUsd: extra.reduce((s, a) => s + (cost.get(a.id) ?? 0), 0), at: extra.at(-1)!.startedAt,
      detail: `Verifier chạy ${group.length} lần trên cùng checkpoint ${first.checkpoint!.slice(0, 7)} mà code và hợp đồng không đổi.`,
    });
  }

  const failures = new Map<string, Attempt[]>();
  for (const a of attempts) {
    if ((a.status !== 'failed' && a.status !== 'interrupted') || Date.parse(a.startedAt) < start) continue;
    const kind: WasteKind = PROVIDER_ERROR.test(a.error ?? '') ? 'provider-error' : 'failed';
    const key = `${a.runId}|${kind}`;
    failures.set(key, [...(failures.get(key) ?? []), a]);
  }
  for (const [key, group] of failures) {
    const kind = key.split('|')[1] as WasteKind;
    const last = group.sort((x, y) => x.startedAt.localeCompare(y.startedAt)).at(-1)!;
    items.push({
      kind, runId: last.runId, runTitle: title.get(last.runId) ?? last.runId, count: group.length,
      costUsd: group.reduce((s, a) => s + (cost.get(a.id) ?? 0), 0), at: last.startedAt,
      detail: kind === 'provider-error' ? `${group.length} lượt lỗi phía provider (quá tải/quota): ${(last.error ?? '').slice(0, 120)}` : `${group.length} lượt agent lỗi hoặc bị ngắt: ${(last.error ?? 'không rõ lý do').slice(0, 120)}`,
    });
  }

  for (const run of runs) {
    if (!WAITING.includes(run.status) || now - Date.parse(run.updatedAt) < STUCK_MS) continue;
    const hours = Math.floor((now - Date.parse(run.updatedAt)) / 3_600_000);
    items.push({ kind: 'stuck', runId: run.id, runTitle: run.title, count: 1, costUsd: 0, at: run.updatedAt, detail: `Đứng ở trạng thái "${run.status}" ${hours >= 48 ? `${Math.floor(hours / 24)} ngày` : `${hours} giờ`} chờ bạn.` });
  }

  items.sort((a, b) => b.costUsd - a.costUsd || b.at.localeCompare(a.at));
  return { items, costUsd: items.reduce((s, i) => s + i.costUsd, 0) };
}
