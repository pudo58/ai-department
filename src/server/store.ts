import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../runtime/process.js';
import type { LogLevel } from '../runtime/describe.js';
import { usageCost } from '../core/budget.js';
import type { DesignSnapshot, FigmaExportJob, InstallJob } from '../shared/design.js';
import type { Artifact, Attempt, CheckResult, Finding, MemoryItem, SkillRecord, ProjectProfile, ProviderName, Run, RunSummary, TraceEvent, UsageRecord } from '../shared/types.js';

export type { LogLevel };
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MONTH_MS = 30 * 86_400_000;
type SummaryRow = Omit<RunSummary, 'contractApproved' | 'developer' | 'costUsd' | 'monthCostUsd'> & { contractApproved: number; devProvider: ProviderName; devModel: string | null; usage: string | null };
export interface LogEntry { id: number; ts: string; runId: string | null; attemptId?: string; source: string; level: LogLevel; message: string }
export interface LogQuery { after?: number; runId?: string; source?: string; minLevel?: LogLevel; q?: string; limit?: number }

/** SQL list of the level names at or above `min`; built from a closed set, never from user text. */
const levelsFrom = (min: LogLevel): string => (Object.keys(LEVEL_RANK) as LogLevel[]).filter((l) => LEVEL_RANK[l] >= LEVEL_RANK[min]).map((l) => `'${l}'`).join(',');

/** Does an entry pass a query's filters? Shared by the SQL path and the live stream. */
export function matchesLog(e: LogEntry, q: LogQuery): boolean {
  return (!q.runId || e.runId === q.runId) && (!q.source || e.source === q.source || e.source.startsWith(`${q.source}:`))
    && (!q.minLevel || LEVEL_RANK[e.level] >= LEVEL_RANK[q.minLevel]) && (!q.q || e.message.toLowerCase().includes(q.q.toLowerCase()));
}

/** Append-only console log: persisted so it survives restarts, and fanned out to live subscribers. */
class LogStore {
  private listeners = new Set<(e: LogEntry) => void>();
  private inserts = 0;
  constructor(private readonly db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, run_id TEXT, attempt_id TEXT, source TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL); CREATE INDEX IF NOT EXISTS logs_run ON logs(run_id, id);');
  }
  append(entry: { runId: string | null; source: string; level: LogLevel; message: string; attemptId?: string; ts?: string }): LogEntry {
    const ts = entry.ts ?? new Date().toISOString();
    const message = redactSecrets(entry.message).slice(0, 4000);
    const result = this.db.prepare('INSERT INTO logs(ts, run_id, attempt_id, source, level, message) VALUES(?, ?, ?, ?, ?, ?)').run(ts, entry.runId, entry.attemptId ?? null, entry.source, entry.level, message);
    const saved: LogEntry = { id: Number(result.lastInsertRowid), ts, runId: entry.runId, attemptId: entry.attemptId, source: entry.source, level: entry.level, message };
    if (++this.inserts % 2000 === 0) this.prune();
    for (const listener of this.listeners) { try { listener(saved); } catch { /* a broken subscriber must not break logging */ } }
    return saved;
  }
  /** Without `after` returns the newest `limit` entries; with it, the entries that follow, oldest first. */
  list(q: LogQuery = {}): LogEntry[] {
    const where: string[] = [], args: (string | number)[] = [];
    if (q.after !== undefined) { where.push('id > ?'); args.push(q.after); }
    if (q.runId) { where.push('run_id = ?'); args.push(q.runId); }
    if (q.source) { where.push('(source = ? OR source LIKE ?)'); args.push(q.source, `${q.source}:%`); }
    if (q.minLevel) where.push(`level IN (${levelsFrom(q.minLevel)})`);
    if (q.q) { where.push("message LIKE ? ESCAPE '\\'"); args.push(`%${q.q.replace(/[\\%_]/g, '\\$&')}%`); }
    const limit = Math.min(Math.max(q.limit ?? 300, 1), 2000);
    const sql = `SELECT id, ts, run_id, attempt_id, source, level, message FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ${q.after !== undefined ? 'ASC' : 'DESC'} LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(...args) as { id: number; ts: string; run_id: string | null; attempt_id: string | null; source: string; level: LogLevel; message: string }[];
    const mapped = rows.map((r) => ({ id: r.id, ts: r.ts, runId: r.run_id, attemptId: r.attempt_id ?? undefined, source: r.source, level: r.level, message: r.message }));
    return q.after !== undefined ? mapped : mapped.reverse();
  }
  countSince(sinceIso: string, minLevel: LogLevel): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM logs WHERE ts >= ? AND level IN (${levelsFrom(minLevel)})`).get(sinceIso) as { n: number }).n);
  }
  subscribe(listener: (e: LogEntry) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Keeps the table bounded: past 200k rows the oldest 50k go. */
  private prune(): void {
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM logs').get() as { n: number }).n);
    if (n > 200_000) this.db.exec('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id LIMIT 50000)');
  }
}

/** A document table: one JSON row per entity, grouped by an owner key (usually the run id). */
class Collection<T extends { id: string }> {
  constructor(private readonly db: DatabaseSync, private readonly table: string, private readonly groupOf: (item: T) => string | null) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, grp TEXT, json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_grp ON ${table}(grp);`);
  }
  put(item: T): T {
    this.db.prepare(`INSERT INTO ${this.table}(id, grp, json) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET grp = excluded.grp, json = excluded.json`)
      .run(item.id, this.groupOf(item), JSON.stringify(item));
    return item;
  }
  get(id: string): T | undefined {
    const row = this.db.prepare(`SELECT json FROM ${this.table} WHERE id = ?`).get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  list(group?: string): T[] {
    const rows = (group === undefined
      ? this.db.prepare(`SELECT json FROM ${this.table} ORDER BY rowid`).all()
      : this.db.prepare(`SELECT json FROM ${this.table} WHERE grp = ? ORDER BY rowid`).all(group)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as T);
  }
  delete(id: string): void { this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id); }
  deleteGroup(group: string): void { this.db.prepare(`DELETE FROM ${this.table} WHERE grp = ?`).run(group); }
}

export class Store {
  readonly db: DatabaseSync;
  readonly projects: Collection<ProjectProfile>;
  readonly runs: Collection<Run>;
  readonly attempts: Collection<Attempt>;
  readonly artifacts: Collection<Artifact>;
  readonly findings: Collection<Finding>;
  readonly checks: Collection<CheckResult>;
  readonly memories: Collection<MemoryItem>;
  readonly skills: Collection<SkillRecord>;
  readonly designSnapshots: Collection<DesignSnapshot>;
  readonly designJobs: Collection<FigmaExportJob>;
  readonly installJobs: Collection<InstallJob>;
  readonly logs: LogStore;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.projects = new Collection(this.db, 'projects', () => null);
    this.runs = new Collection(this.db, 'runs', (r) => r.projectId);
    this.attempts = new Collection(this.db, 'attempts', (a) => a.runId);
    this.artifacts = new Collection(this.db, 'artifacts', (a) => a.runId);
    this.findings = new Collection(this.db, 'findings', (f) => f.runId);
    this.checks = new Collection(this.db, 'checks', (c) => c.runId);
    this.memories = new Collection(this.db, 'memories', (m) => m.projectId);
    this.skills = new Collection(this.db, 'skills', () => null);
    this.designSnapshots = new Collection(this.db, 'design_snapshots', () => null);
    this.designJobs = new Collection(this.db, 'design_jobs', (j) => j.connectionId);
    this.installJobs = new Collection(this.db, 'install_jobs', (j) => j.adapter);
    this.logs = new LogStore(this.db);
    this.db.exec('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_run ON events(run_id);');
  }

  addEvent(runId: string, type: string, message: string, data?: unknown): TraceEvent {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(run_id, json) VALUES(?, ?)').run(runId, JSON.stringify({ type, message, data, createdAt }));
    // Timeline events double as console lines so one stream shows everything.
    this.logs.append({ runId, source: 'run', level: eventLevel(type), message, ts: createdAt });
    return { id: Number(result.lastInsertRowid), runId, type, message, data, createdAt };
  }

  /**
   * The task list, oldest first like runs.list(). SQLite picks out the few fields it shows, so the contract, config
   * snapshot and context are never parsed here or sent; only the usage records are, to price them with usageCost.
   */
  runSummaries(now = Date.now()): RunSummary[] {
    const rows = this.db.prepare(`SELECT id, json->>'$.projectId' AS projectId, json->>'$.title' AS title, json->>'$.status' AS status,
      json->>'$.mode' AS mode, json->>'$.provider' AS provider, json->>'$.stage' AS stage, json->>'$.contract.approvedHash' IS NOT NULL AS contractApproved,
      json->>'$.budgetUsd' AS budgetUsd, json->>'$.blocker' AS blocker, json->>'$.createdAt' AS createdAt, json->>'$.updatedAt' AS updatedAt,
      json->>'$.configSnapshot.roles.developer.provider' AS devProvider, json->>'$.configSnapshot.roles.developer.model' AS devModel,
      CASE WHEN json->>'$.checkpoint' IS NOT NULL AND json->>'$.delivery.checkpoint' = json->>'$.checkpoint'
        AND json->>'$.delivery.contractVersion' = json->>'$.contract.version' AND json->>'$.delivery.slot' = json->>'$.selectedSlot'
        THEN json->>'$.delivery.status' ELSE 'unconfirmed' END AS deliveryStatus,
      json->'$.usage' AS usage FROM runs ORDER BY rowid`).all() as SummaryRow[];
    const cost = (usage: UsageRecord[]) => usage.reduce((sum, u) => sum + usageCost(u), 0);
    return rows.map(({ contractApproved, devProvider, devModel, usage, ...run }) => {
      const records = JSON.parse(usage ?? '[]') as UsageRecord[];
      return {
        ...run, contractApproved: contractApproved === 1, developer: { provider: devProvider, model: devModel ?? '' },
        costUsd: cost(records), monthCostUsd: cost(records.filter((u) => now - Date.parse(u.createdAt) < MONTH_MS)),
      };
    });
  }

  events(runId: string, limit = 500): TraceEvent[] {
    const rows = this.db.prepare('SELECT id, json FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?').all(runId, limit) as { id: number; json: string }[];
    return rows.reverse().map((r) => ({ id: r.id, runId, ...JSON.parse(r.json) as Omit<TraceEvent, 'id' | 'runId'> }));
  }

  /** Removes a run and everything recorded under it (attempts, evidence, timeline, console lines) in one transaction. */
  purgeRun(runId: string): void { this.transaction(() => this.purgeRunRows(runId)); }

  /** Removes a project, all of its runs and its memory. The project's own folder on disk is never touched. */
  purgeProject(projectId: string): string[] {
    return this.transaction(() => {
      const runIds = this.runs.list(projectId).map((r) => r.id);
      for (const id of runIds) this.purgeRunRows(id);
      this.memories.deleteGroup(projectId);
      this.projects.delete(projectId);
      return runIds;
    });
  }

  private purgeRunRows(runId: string): void {
    for (const c of [this.attempts, this.artifacts, this.findings, this.checks]) c.deleteGroup(runId);
    this.db.prepare('DELETE FROM events WHERE run_id = ?').run(runId);
    this.db.prepare('DELETE FROM logs WHERE run_id = ?').run(runId);
    this.runs.delete(runId);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close(): void { this.db.close(); }
}

/** Timeline event types are free-form strings; map them to a console severity. */
export function eventLevel(type: string): LogLevel {
  if (/^scope\./.test(type)) return 'warn';
  if (/fail|blocked|rejected|error/.test(type)) return 'error';
  if (/warn|quota|missing|empty|parse_failed|stop|recovery|scope/.test(type)) return 'warn';
  return 'info';
}
