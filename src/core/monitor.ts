import type { Attempt, ProjectProfile, Run } from '../shared/types.js';
import { budgetState, usageCost } from './budget.js';
import { findWaste, type WasteReport } from './waste.js';

export const PERIODS = ['today', '24h', '7d', '30d', '60d'] as const;
export type Period = typeof PERIODS[number];

export interface Totals { requests: number; failed: number; inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number; estimated: boolean }
export interface Bucket { t: string; requests: number; inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number; /** Cost split by agent role, for the stacked cost chart. */ costByRole: Record<string, number> }
/** One line of "where the money went": a task, a role or a project. */
export interface CostRow { key: string; label: string; runId?: string; projectId?: string; status?: string; requests: number; inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number; repairs?: number; accepted?: boolean }
export type WaitingKind = 'approve-contract' | 'accept' | 'blocked' | 'failed' | 'paused' | 'approve-policy';
/** Something only a person can move forward. */
export interface WaitingItem { kind: WaitingKind; runId?: string; projectId?: string; title: string; detail: string; updatedAt: string }
export interface LiveRun { id: string; title: string; stage: string; mode: string; role?: string; attemptStartedAt?: string; spentUsd: number; capUsd: number; budgetPct: number; lastLog?: string }
export interface Alert { level: 'warn' | 'error'; text: string }
export interface ModelRow { provider: string; model: string; requests: number; failed: number; inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number }
export interface RequestRow {
  id: string; runId: string; runTitle: string; role: string; slot: string; stage: string; provider: string; model: string; status: string;
  startedAt: string; endedAt?: string; error?: string; inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number;
}
export interface Activity {
  /** Providers with an agent running right now. */
  providers: string[];
  /** Pipeline stages that produced console output in the last few seconds. */
  stages: { setup: boolean; check: boolean };
}
export interface MonitorData {
  now: string; period: Period; unit: 'hour' | 'day';
  totals: Totals; series: Bucket[]; byModel: ModelRow[];
  activeRuns: { id: string; title: string; status: string; stage: string; mode: string; updatedAt: string }[];
  runningAttempts: RequestRow[]; recent: RequestRow[]; errorsLastHour: number; activity: Activity;
  /** Tasks shown as nodes in the topology graph: newest first. */
  tasks: { id: string; title: string; status: string; mode: string }[];
  /** The same span one period earlier (today vs yesterday up to the same hour, 7D vs the 7 days before…). */
  previous: Totals;
  cacheRate: number; acceptedInPeriod: number; costPerAccepted: number | null;
  byTask: CostRow[]; byRole: CostRow[]; byProject: CostRow[];
  waste: WasteReport; waiting: WaitingItem[]; live: LiveRun[]; alerts: Alert[];
}

const HOUR = 3_600_000;

/** Start of the window. "today" is local midnight, so it matches the user's own sense of the day. */
export function periodStart(period: Period, now: number): number {
  const d = new Date(now);
  if (period === 'today') { d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (period === '24h') return now - 24 * HOUR;
  return now - ({ '7d': 7, '30d': 30, '60d': 60 }[period]) * 24 * HOUR;
}

const floorTo = (ts: number, unit: 'hour' | 'day'): number => {
  const d = new Date(ts);
  if (unit === 'hour') d.setMinutes(0, 0, 0); else d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const nextBucket = (ts: number, unit: 'hour' | 'day'): number => {
  const d = new Date(ts);
  if (unit === 'hour') d.setHours(d.getHours() + 1); else d.setDate(d.getDate() + 1); // setDate keeps local midnight across DST
  return d.getTime();
};

export interface MonitorInput {
  runs: readonly Run[]; attempts: readonly Attempt[]; now: number; period: Period; errorsLastHour: number; activity: Activity;
  projects?: readonly ProjectProfile[];
  /** Latest console line of each running task. */
  lastLogByRun?: Readonly<Record<string, string>>;
  /** Conditions found outside the run data (provider errors, low disk). */
  alerts?: readonly Alert[];
}

const PERIOD_MS: Record<Period, number> = { today: 24 * HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR, '60d': 60 * 24 * HOUR };
const ROLE_LABEL: Record<string, string> = { planner: 'Planner', author: 'Author', developer: 'Developer', verifier: 'Verifier', investigator: 'Investigator' };
const WAIT_KIND: Record<string, WaitingKind> = { awaiting_approval: 'approve-contract', awaiting_acceptance: 'accept', blocked: 'blocked', failed: 'failed', paused: 'paused' };

export function buildMonitor({ runs, attempts, now, period, errorsLastHour, activity, projects = [], lastLogByRun = {}, alerts = [] }: MonitorInput): MonitorData {
  const start = periodStart(period, now);
  const unit: 'hour' | 'day' = period === 'today' || period === '24h' ? 'hour' : 'day';
  const title = new Map(runs.map((r) => [r.id, r.title]));

  const empty = () => ({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 });
  const perAttempt = new Map<string, ReturnType<typeof empty>>();
  const buckets = new Map<number, Bucket>();
  for (let t = floorTo(start, unit); t <= now; t = nextBucket(t, unit)) buckets.set(t, { t: new Date(t).toISOString(), requests: 0, ...empty(), costByRole: {} });
  const roleOf = new Map(attempts.map((a) => [a.id, a.role]));
  const totals: Totals = { requests: 0, failed: 0, ...empty(), estimated: false };

  for (const run of runs) for (const u of run.usage) {
    const cost = usageCost(u);
    // Per-attempt figures cover the whole attempt (used by the request rows); window figures only count the window.
    const row = perAttempt.get(u.attemptId) ?? empty();
    row.inputTokens += u.inputTokens; row.cachedTokens += u.cachedTokens; row.outputTokens += u.outputTokens; row.costUsd += cost;
    perAttempt.set(u.attemptId, row);
    const at = Date.parse(u.createdAt);
    if (at < start) continue;
    totals.inputTokens += u.inputTokens; totals.cachedTokens += u.cachedTokens; totals.outputTokens += u.outputTokens; totals.costUsd += cost;
    totals.estimated ||= u.source !== 'reported';
    const bucket = buckets.get(floorTo(at, unit));
    if (bucket) {
      bucket.inputTokens += u.inputTokens; bucket.cachedTokens += u.cachedTokens; bucket.outputTokens += u.outputTokens; bucket.costUsd += cost;
      const role = roleOf.get(u.attemptId) ?? 'khác';
      bucket.costByRole[role] = (bucket.costByRole[role] ?? 0) + cost;
    }
  }

  const models = new Map<string, ModelRow>();
  const toRow = (a: Attempt): RequestRow => ({
    id: a.id, runId: a.runId, runTitle: title.get(a.runId) ?? a.runId, role: a.role, slot: a.slot, stage: a.stage, provider: a.provider, model: a.model,
    status: a.status, startedAt: a.startedAt, endedAt: a.endedAt, error: a.error, ...(perAttempt.get(a.id) ?? empty()),
  });
  for (const a of attempts) {
    const at = Date.parse(a.startedAt);
    if (at < start) continue;
    const failed = a.status === 'failed' || a.status === 'interrupted';
    totals.requests++; if (failed) totals.failed++;
    const bucket = buckets.get(floorTo(at, unit)); if (bucket) bucket.requests++;
    const key = `${a.provider}/${a.model}`;
    const m = models.get(key) ?? { provider: a.provider, model: a.model, requests: 0, failed: 0, ...empty() };
    const usage = perAttempt.get(a.id) ?? empty();
    m.requests++; if (failed) m.failed++;
    m.inputTokens += usage.inputTokens; m.cachedTokens += usage.cachedTokens; m.outputTokens += usage.outputTokens; m.costUsd += usage.costUsd;
    models.set(key, m);
  }

  // ---- the same span one period earlier
  const shift = PERIOD_MS[period];
  const previous: Totals = { requests: 0, failed: 0, ...empty(), estimated: false };
  for (const run of runs) for (const u of run.usage) {
    const at = Date.parse(u.createdAt);
    if (at < start - shift || at >= now - shift) continue;
    previous.inputTokens += u.inputTokens; previous.cachedTokens += u.cachedTokens; previous.outputTokens += u.outputTokens; previous.costUsd += usageCost(u);
    previous.estimated ||= u.source !== 'reported';
  }
  for (const a of attempts) {
    const at = Date.parse(a.startedAt);
    if (at < start - shift || at >= now - shift) continue;
    previous.requests++; if (a.status === 'failed' || a.status === 'interrupted') previous.failed++;
  }

  // ---- where the money went in the window: by task, role and project
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const runById = new Map(runs.map((r) => [r.id, r]));
  type Head = Omit<CostRow, 'requests' | 'inputTokens' | 'cachedTokens' | 'outputTokens' | 'costUsd'>;
  const group = (rows: Map<string, CostRow>, key: string, init: () => Head): CostRow => {
    let row = rows.get(key);
    if (!row) { row = { ...init(), requests: 0, ...empty() }; rows.set(key, row); }
    return row;
  };
  const tasks = new Map<string, CostRow>(), roles = new Map<string, CostRow>(), projectRows = new Map<string, CostRow>();
  const taskRow = (run: Run) => group(tasks, run.id, () => ({ key: run.id, label: run.title, runId: run.id, projectId: run.projectId, status: run.status, repairs: run.repairCount, accepted: run.status === 'completed' }));
  const projectRow = (run: Run) => group(projectRows, run.projectId, () => ({ key: run.projectId, label: projectName.get(run.projectId) ?? run.projectId, projectId: run.projectId }));
  const roleRow = (role: string) => group(roles, role, () => ({ key: role, label: ROLE_LABEL[role] ?? role }));
  for (const run of runs) for (const u of run.usage) {
    if (Date.parse(u.createdAt) < start) continue;
    const cost = usageCost(u);
    for (const row of [taskRow(run), projectRow(run), roleRow(roleOf.get(u.attemptId) ?? 'khác')]) {
      row.inputTokens += u.inputTokens; row.cachedTokens += u.cachedTokens; row.outputTokens += u.outputTokens; row.costUsd += cost;
    }
  }
  for (const a of attempts) {
    const run = runById.get(a.runId);
    if (!run || Date.parse(a.startedAt) < start) continue;
    taskRow(run).requests++; projectRow(run).requests++; roleRow(a.role).requests++;
  }
  const byCost = (rows: Map<string, CostRow>) => [...rows.values()].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);

  // ---- accepted in the window, and what each cost over its whole life
  const accepted = runs.filter((r) => r.acceptedAt && Date.parse(r.acceptedAt) >= start);
  const lifeCost = (r: Run) => r.usage.reduce((sum, u) => sum + usageCost(u), 0);

  // ---- what only a person can move forward
  const waiting: WaitingItem[] = [
    ...runs.filter((r) => WAIT_KIND[r.status]).map((r): WaitingItem => ({
      kind: WAIT_KIND[r.status]!, runId: r.id, projectId: r.projectId, title: r.title, updatedAt: r.updatedAt,
      detail: r.status === 'awaiting_approval' ? `Hợp đồng v${r.contract.version} chờ duyệt` : r.status === 'awaiting_acceptance' ? 'Đủ bằng chứng, chờ bạn xem và nghiệm thu' : (r.blocker ?? '').slice(0, 220),
    })),
    ...projects.filter((p) => !p.approved).map((p): WaitingItem => ({ kind: 'approve-policy', projectId: p.id, title: p.name, detail: `Policy v${p.version} chờ duyệt; task chạy thật bị chặn tới khi duyệt`, updatedAt: p.createdAt })),
  ];
  const order: Record<WaitingKind, number> = { accept: 0, 'approve-contract': 1, 'approve-policy': 2, blocked: 3, failed: 4, paused: 5 };
  waiting.sort((a, b) => order[a.kind] - order[b.kind] || b.updatedAt.localeCompare(a.updatedAt));

  // ---- running tasks with their budget and latest console line
  const live: LiveRun[] = runs.filter((r) => r.status === 'queued' || r.status === 'running').map((r) => {
    const mine = attempts.filter((a) => a.runId === r.id);
    const running = mine.find((a) => a.status === 'running');
    const budget = budgetState(r, mine);
    return { id: r.id, title: r.title, stage: r.stage, mode: r.mode, role: running?.role, attemptStartedAt: running?.startedAt, spentUsd: budget.spentUsd, capUsd: budget.capUsd, budgetPct: budget.capUsd > 0 ? budget.spentUsd / budget.capUsd : 0, lastLog: lastLogByRun[r.id] };
  });

  return {
    now: new Date(now).toISOString(), period, unit, totals,
    previous, cacheRate: totals.inputTokens > 0 ? totals.cachedTokens / totals.inputTokens : 0,
    acceptedInPeriod: accepted.length, costPerAccepted: accepted.length ? accepted.reduce((sum, r) => sum + lifeCost(r), 0) / accepted.length : null,
    byTask: byCost(tasks).slice(0, 50), byRole: byCost(roles), byProject: byCost(projectRows),
    waste: findWaste(runs, attempts, start, now), waiting: waiting.slice(0, 30), live, alerts: [...alerts],
    series: [...buckets.values()],
    byModel: [...models.values()].sort((a, b) => b.requests - a.requests),
    activeRuns: runs.filter((r) => r.status === 'queued' || r.status === 'running').map((r) => ({ id: r.id, title: r.title, status: r.status, stage: r.stage, mode: r.mode, updatedAt: r.updatedAt })),
    runningAttempts: attempts.filter((a) => a.status === 'running').map(toRow),
    recent: [...attempts].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 80).map(toRow),
    errorsLastHour, activity,
    tasks: [...runs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8).map((r) => ({ id: r.id, title: r.title, status: r.status, mode: r.mode })),
  };
}
