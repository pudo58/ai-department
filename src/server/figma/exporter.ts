import { createHash, randomBytes, randomInt, timingSafeEqual, type Hash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  CHUNK_MAX_BYTES, DEFAULT_LIMITS, HEARTBEAT_MS, LOST_CONTACT_MS, MAX_LIMITS, PAIRING_CODE_RE, PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS, PROTOCOL_VERSION, POLL_TIMEOUT_MS, TEXT_STREAMS,
  type ChunkEnvelope, type DependencyRecord, type ExportLimits, type ExportPhase, type ExportScopeKind, type FinishBody, type HelloInfo, type InventoryRecord, type NodeRecord,
  type CommandInput, type PluginCommand, type PluginEvent, type StreamSummary,
} from '../../shared/figma.js';
import { decodeBase64 } from '../../shared/base64.js';
import { EXPORT_ACTIVE, type ConnectionState, type FigmaExportJob, type DesignSnapshot } from '../../shared/design.js';
import { parseFigmaUrl, scopeHash } from '../../core/design.js';
import { ExportValidator } from '../../core/figmavalidate.js';
import { HttpError } from '../run/support.js';
import type { Store } from '../store.js';
import { SnapshotStore, records, type StagingFiles } from './snapshots.js';

const EXPECTED_PHASES: readonly string[] = ['queued', 'preparing', 'inventory', 'reading', 'dependencies', 'assets', 'verifying', 'assembling', 'review_ready'];
const PHASE_RANK = new Map(EXPECTED_PHASES.map((p, i) => [p, i]));

export interface PluginSession {
  id: string; tokenHash: Buffer; hello: HelloInfo; instanceName: string;
  connectedAt: string; lastContactAt: number;
  queue: PluginCommand[]; delivered: Set<string>;
  waiters: (() => void)[];
  jobId?: string;
}

interface Waiting { resolve: (event: PluginEvent) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface AssetUpload { hash: Hash; bytes: number; part: string; done: boolean }
interface JobRuntime {
  streams: Record<string, { hash: Hash; bytes: number; records: number }>;
  seqs: Map<number, string>;
  assets: Map<string, AssetUpload>;
  totalBytes: number;
  peakUnacked: number;
  limitReached?: 'time' | 'nodes' | 'bytes' | 'asset';
}

export interface HubOptions {
  dataDir: string; store: Store; snapshots: SnapshotStore;
  now?: () => number; instanceName?: string;
  /** How long a poll waits for a command (default 25 s); tests make it short. */
  pollMs?: number;
}

export interface CreateExportInput {
  scope: ExportScopeKind; rootIds?: string[]; pageIds?: string[];
  limits?: Partial<ExportLimits>;
  /** What the person typed to say which file this is. */
  declaredUrl?: string;
  /** Required when the plugin cannot report a file key: the person confirms the file by name and pages. */
  attestSource?: boolean;
  previousSnapshotId?: string;
}

const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

/**
 * The server's side of the Exporter: pairing, the command queue, the chunked upload with its acknowledgements, and what happens when an
 * export ends. Everything the plugin can reach is a method here that checks the session, the job and the source before it does anything.
 */
export class ExporterHub {
  private session: PluginSession | undefined;
  private pairing: { code: string; expiresAt: number; attempts: number } | undefined;
  private readonly attempts: number[] = [];
  private readonly waiting = new Map<string, Waiting>();
  private readonly runtime = new Map<string, JobRuntime>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private activeJobId: string | undefined;
  /**
   * A cancelled export whose plugin has not yet said it stopped. The server has already refused its data, but the plugin may still be
   * winding down, so the next export (or a browse) waits for its acknowledgement, for at most a short grace period.
   */
  private stopping: { jobId: string; until: number } | undefined;
  private lastSession: { instanceName: string; hello: HelloInfo; connectedAt: string; lastContactAt: number } | undefined;
  private timer: NodeJS.Timeout | undefined;
  readonly now: () => number;
  readonly instanceName: string;

  constructor(private readonly o: HubOptions) {
    this.now = o.now ?? (() => Date.now());
    this.instanceName = o.instanceName ?? 'AI Department';
  }

  stagingDir(jobId: string): string {
    if (!/^fej_[a-f0-9]{8,}$/.test(jobId)) throw new HttpError(400, 'Mã job không hợp lệ.');
    return path.join(this.o.dataDir, 'design-staging', jobId);
  }
  private files(jobId: string): StagingFiles {
    const dir = this.stagingDir(jobId);
    return { dir, inventory: path.join(dir, 'inventory.ndjson'), nodes: path.join(dir, 'nodes.ndjson'), dependencies: path.join(dir, 'dependencies.ndjson'), verification: path.join(dir, 'verification.ndjson'), assetsDir: path.join(dir, 'assets') };
  }

  /** Watches for a plugin that went quiet and a job that ran out of time. Tests call `tick` themselves. */
  start(intervalMs = 5000): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  tick(): void {
    if (this.stopping && this.now() > this.stopping.until) this.stopping = undefined;
    const job = this.activeJobId ? this.o.store.designJobs.get(this.activeJobId) : undefined;
    if (!job) return;
    const now = this.now();
    if (job.deadline && now > Date.parse(job.deadline)) { this.endJob(job.id, 'failed', { code: 'timeout', message: 'Export vượt thời gian tối đa của job.', hint: 'Tạo lượt mới với giới hạn thời gian cao hơn (tối đa 60 phút) hoặc chọn phạm vi nhỏ hơn.' }); this.enqueue({ type: 'CANCEL', jobId: job.id }); return; }
    const last = this.session?.lastContactAt ?? 0;
    if (now - last > LOST_CONTACT_MS) this.endJob(job.id, 'interrupted', { code: 'lost_contact', message: 'Mất liên lạc với Exporter hơn 30 giây.', hint: 'Mở lại plugin trong Figma, ghép đôi lại rồi tạo lượt export mới. Export không tiếp tục giữa hai phiên.' });
  }

  // ------------------------------------------------------------ pairing and session

  createPairingCode(): { code: string; expiresAt: string } {
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    this.pairing = { code, expiresAt: this.now() + PAIRING_TTL_MS, attempts: 0 };
    return { code, expiresAt: new Date(this.pairing.expiresAt).toISOString() };
  }

  pair(input: { code: string; hello: HelloInfo }): { token: string; instanceName: string; sessionId: string } {
    const now = this.now();
    while (this.attempts.length && now - this.attempts[0]! > 60_000) this.attempts.shift();
    if (this.attempts.length >= 20) throw new HttpError(429, 'Quá nhiều lần ghép đôi trong một phút; đợi rồi thử lại.');
    this.attempts.push(now);
    if (!PAIRING_CODE_RE.test(input.code)) throw new HttpError(400, 'Mã ghép đôi gồm 8 chữ số.');
    const pairing = this.pairing;
    if (!pairing || now > pairing.expiresAt) { this.pairing = undefined; throw new HttpError(403, 'Mã ghép đôi hết hạn hoặc chưa được tạo. Bấm “Ghép đôi” trong AI Department để lấy mã mới.'); }
    const given = Buffer.from(input.code), wanted = Buffer.from(pairing.code);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      pairing.attempts++;
      if (pairing.attempts >= PAIRING_MAX_ATTEMPTS) { this.pairing = undefined; throw new HttpError(403, 'Nhập sai quá 5 lần; mã đã bị hủy. Tạo mã mới.'); }
      throw new HttpError(403, `Mã ghép đôi không đúng (còn ${PAIRING_MAX_ATTEMPTS - pairing.attempts} lần).`);
    }
    this.assertHello(input.hello);
    this.pairing = undefined;
    // One live session: a new pairing replaces the old one, and what the old one was doing stops.
    if (this.session) this.revoke('Đã ghép đôi lại.');
    const token = randomBytes(32).toString('hex');
    this.session = { id: `ses_${randomBytes(6).toString('hex')}`, tokenHash: hashToken(token), hello: input.hello, instanceName: this.instanceName, connectedAt: new Date(now).toISOString(), lastContactAt: now, queue: [], delivered: new Set(), waiters: [] };
    this.lastSession = { instanceName: this.instanceName, hello: input.hello, connectedAt: this.session.connectedAt, lastContactAt: now };
    return { token, instanceName: this.instanceName, sessionId: this.session.id };
  }

  private assertHello(hello: HelloInfo): void {
    if (!hello || typeof hello !== 'object' || hello.protocolVersion !== PROTOCOL_VERSION) throw new HttpError(409, `Exporter dùng giao thức ${hello?.protocolVersion ?? '?'} nhưng AI Department cần ${PROTOCOL_VERSION}. Bấm “Mở thư mục Exporter” và import lại manifest mới.`);
    if (typeof hello.sourceSession !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(hello.sourceSession)) throw new HttpError(400, 'Exporter không gửi mã phiên nguồn hợp lệ.');
    if (typeof hello.fileName !== 'string' || !Array.isArray(hello.pages)) throw new HttpError(400, 'Thông tin file từ Exporter không hợp lệ.');
  }

  authenticate(authorization: string | undefined): PluginSession {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(String(authorization ?? ''))?.[1];
    const session = this.session;
    if (!token || !session) throw new HttpError(401, 'Phiên Exporter không hợp lệ hoặc đã bị thu hồi; ghép đôi lại.');
    const given = hashToken(token);
    if (given.length !== session.tokenHash.length || !timingSafeEqual(given, session.tokenHash)) throw new HttpError(401, 'Phiên Exporter không hợp lệ hoặc đã bị thu hồi; ghép đôi lại.');
    session.lastContactAt = this.now();
    if (this.lastSession) this.lastSession.lastContactAt = session.lastContactAt;
    return session;
  }

  /** Ends the live session. A job it was running stops, and a command it was waiting for fails. */
  revoke(reason: string): void {
    const session = this.session;
    this.session = undefined;
    if (session?.jobId) this.endJob(session.jobId, 'interrupted', { code: 'disconnected', message: reason });
    for (const [id, w] of this.waiting) { clearTimeout(w.timer); w.reject(new HttpError(409, reason)); this.waiting.delete(id); }
    for (const wake of session?.waiters.splice(0) ?? []) wake();
  }

  disconnect(): void { if (this.session) this.enqueue({ type: 'DISCONNECT' }); this.revoke('Đã ngắt kết nối.'); this.lastSession = undefined; this.pairing = undefined; }

  connectionState(): ConnectionState {
    const now = this.now();
    if (this.session) {
      const quiet = now - this.session.lastContactAt > LOST_CONTACT_MS + HEARTBEAT_MS;
      return { state: quiet ? 'interrupted' : 'connected', instanceName: this.session.instanceName, hello: this.session.hello, connectedAt: this.session.connectedAt, lastContactAt: new Date(this.session.lastContactAt).toISOString(), ...(this.activeJobId ? { activeJobId: this.activeJobId } : {}) };
    }
    if (this.pairing && now <= this.pairing.expiresAt) return { state: 'pairing', pairingCode: { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() } };
    if (this.lastSession) return { state: 'interrupted', instanceName: this.lastSession.instanceName, hello: this.lastSession.hello, connectedAt: this.lastSession.connectedAt, lastContactAt: new Date(this.lastSession.lastContactAt).toISOString() };
    return { state: 'unpaired' };
  }

  // ------------------------------------------------------------ commands

  private enqueue(command: CommandInput): PluginCommand {
    const session = this.session;
    if (!session) throw new HttpError(409, 'Chưa có Exporter nào được ghép đôi.');
    const full = { ...command, id: `cmd_${randomBytes(6).toString('hex')}` } as PluginCommand;
    session.queue.push(full);
    for (const wake of session.waiters.splice(0)) wake();
    return full;
  }

  /** The plugin asks for work. Each command is handed out once; after a reconnect an old one is never run again. */
  async poll(session: PluginSession, waitMs = this.o.pollMs ?? POLL_TIMEOUT_MS): Promise<PluginCommand[]> {
    if (session !== this.session) throw new HttpError(401, 'Phiên Exporter đã bị thay thế.');
    if (!session.queue.length && waitMs > 0) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, waitMs); t.unref?.(); session.waiters.push(() => { clearTimeout(t); resolve(); }); });
    }
    if (session !== this.session) throw new HttpError(401, 'Phiên Exporter đã bị thay thế.');
    session.lastContactAt = this.now();
    const out = session.queue.splice(0).filter((c) => !session.delivered.has(c.id));
    for (const c of out) session.delivered.add(c.id);
    return out;
  }

  /** True while a cancelled export has not yet been acknowledged by the plugin. */
  isStopping(): boolean { return !!this.stopping && this.now() <= this.stopping.until; }

  /** Asks the plugin something and waits for its answer. Browsing and checking use this; none of it changes the document. */
  request(command: CommandInput, timeoutMs = 15_000): Promise<PluginEvent> {
    if (this.isStopping()) throw new HttpError(409, 'Exporter đang dừng export vừa hủy; đợi vài giây rồi thử lại.');
    if (this.activeJobId) throw new HttpError(409, 'Đang có một export chạy; chờ xong hoặc hủy trước khi duyệt hay kiểm tra kết nối.');
    const full = this.enqueue(command);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(full.id); reject(new HttpError(504, 'Exporter không trả lời. Mở plugin “AI Department Exporter” trong Figma (file cần đọc) rồi thử lại.')); }, timeoutMs);
      this.waiting.set(full.id, { resolve, reject, timer });
    });
  }

  event(session: PluginSession, event: PluginEvent): void {
    if (session !== this.session) throw new HttpError(401, 'Phiên Exporter đã bị thay thế.');
    session.lastContactAt = this.now();
    if ('commandId' in event && event.commandId) {
      const w = this.waiting.get(event.commandId);
      if (w) {
        this.waiting.delete(event.commandId); clearTimeout(w.timer);
        if (event.type === 'error') w.reject(new HttpError(409, `Exporter báo lỗi ${event.code}: ${event.message}`));
        else { if (event.type === 'hello') { this.assertHello(event.hello); session.hello = event.hello; } w.resolve(event); }
        return;
      }
    }
    if (event.type === 'hello') { this.assertHello(event.hello); session.hello = event.hello; return; }
    if (!('jobId' in event) || !event.jobId) return;
    // The plugin confirming that it stopped (or failed while stopping) releases the next export.
    if (this.stopping?.jobId === event.jobId && (event.type === 'cancelled' || event.type === 'error')) this.stopping = undefined;
    const job = this.o.store.designJobs.get(event.jobId);
    if (!job || job.id !== this.activeJobId) return;
    if (event.type === 'phase') {
      const next = event.phase === 'loading_pages' ? 'preparing' : event.phase;
      if (PHASE_RANK.has(next) && (PHASE_RANK.get(next)! >= PHASE_RANK.get(job.status)!)) this.o.store.designJobs.put({ ...job, status: next as ExportPhase, phase: event.phase === 'loading_pages' ? 'Đang tải các trang của file' : event.note ?? next, lastContactAt: new Date(this.now()).toISOString(), startedAt: job.startedAt ?? new Date(this.now()).toISOString() });
    } else if (event.type === 'progress') {
      this.o.store.designJobs.put({ ...job, counts: { ...job.counts, nodes: event.nodes, bytes: event.bytes }, lastContactAt: new Date(this.now()).toISOString() });
      const rt = this.runtime.get(job.id);
      if (rt) rt.peakUnacked = Math.max(rt.peakUnacked, event.unacked);
    } else if (event.type === 'error') this.endJob(job.id, 'failed', { code: event.code, message: event.message });
    else if (event.type === 'cancelled') this.endJob(job.id, 'cancelled');
  }

  // ------------------------------------------------------------ export jobs

  createExport(input: CreateExportInput): FigmaExportJob {
    const session = this.session;
    if (!session) throw new HttpError(409, 'Chưa ghép đôi với Exporter. Bấm “Ghép đôi” và nhập mã trong plugin.');
    if (this.activeJobId) throw new HttpError(409, 'Đang có một export chạy; mỗi kết nối chỉ chạy một export.');
    if (this.isStopping()) throw new HttpError(409, 'Exporter đang dừng export vừa hủy; đợi vài giây rồi bắt đầu lại.');
    if (this.now() - session.lastContactAt > LOST_CONTACT_MS) throw new HttpError(409, 'Exporter không còn liên lạc. Mở lại plugin trong Figma.');
    const hello = session.hello;
    const limits: ExportLimits = { ...DEFAULT_LIMITS };
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof ExportLimits)[]) {
      const given = input.limits?.[key];
      if (given === undefined) continue;
      if (!Number.isFinite(given) || given <= 0 || given > MAX_LIMITS[key]) throw new HttpError(400, `Giới hạn ${key} phải từ 1 đến ${MAX_LIMITS[key]}.`);
      limits[key] = Math.floor(given);
    }
    const pageIds = new Set(hello.pages.map((p) => p.id));
    let rootIds = [...new Set(input.rootIds ?? [])], pages = [...new Set(input.pageIds ?? [])];
    if (input.scope === 'file') { rootIds = []; pages = hello.pages.map((p) => p.id); }
    else if (input.scope === 'pages') { rootIds = []; if (!pages.length) throw new HttpError(400, 'Chọn ít nhất một trang.'); if (pages.some((p) => !pageIds.has(p))) throw new HttpError(400, 'Có trang không thuộc file đang mở.'); }
    else { pages = []; if (!rootIds.length) throw new HttpError(400, 'Chọn ít nhất một frame, hoặc chọn phạm vi trang / toàn bộ file.'); }
    if (rootIds.length > 200 || pages.length > 500) throw new HttpError(400, 'Quá nhiều node gốc.');

    const declared = input.declaredUrl?.trim() ? parseFigmaUrl(input.declaredUrl) : null;
    if (input.declaredUrl?.trim() && !declared) throw new HttpError(400, 'URL Figma không hợp lệ (cần https://www.figma.com/design/<mã file>/…).');
    let identity: 'verified' | 'user_attested';
    if (hello.fileKey) {
      if (declared && declared.fileKey !== hello.fileKey && declared.branchKey !== hello.fileKey) throw new HttpError(400, `URL trỏ tới file ${declared.fileKey} nhưng Exporter đang mở file ${hello.fileKey}. Mở đúng file hoặc sửa URL.`);
      identity = 'verified';
    } else {
      if (!input.attestSource) throw new HttpError(400, `Plugin không trả được file key, nên cần bạn xác nhận nguồn: file “${hello.fileName}”, ${hello.pages.length} trang. Tick xác nhận rồi bắt đầu lại.`);
      identity = 'user_attested';
    }
    const previous = input.previousSnapshotId ? this.o.snapshots.get(input.previousSnapshotId) : undefined;
    if (input.previousSnapshotId && !previous) throw new HttpError(400, 'Snapshot trước đó không tồn tại.');

    const nowMs = this.now();
    const id = `fej_${randomBytes(6).toString('hex')}`;
    const hash = scopeHash({ scope: input.scope, rootIds, pageIds: pages, sourceSession: hello.sourceSession, limits });
    const job: FigmaExportJob = {
      id, connectionId: 'figma-desktop', status: 'queued', phase: 'Đang chờ Exporter nhận lệnh', scope: input.scope, rootIds, pageIds: pages, scopeHash: hash,
      source: { fileName: hello.fileName, sourceSession: hello.sourceSession, ...(hello.fileKey ? { fileKey: hello.fileKey } : {}), identity, ...(declared ? { declaredUrl: input.declaredUrl!.trim().slice(0, 500), declaredFileKey: declared.fileKey, ...(declared.nodeId ? { declaredNodeId: declared.nodeId } : {}) } : {}),
        ...(identity === 'user_attested' ? { attestedAt: new Date(nowMs).toISOString() } : {}), editorType: hello.editorType, apiVersion: hello.apiVersion, pluginVersion: hello.pluginVersion, ...(hello.bundleHash ? { bundleHash: hello.bundleHash } : {}) },
      limits, counts: { pages: 0, nodes: 0, components: 0, styles: 0, variables: 0, collections: 0, assets: 0, bytes: 0 }, nextSeq: 0, issues: [],
      notes: ['Plugin API không cấp snapshot nguyên tử: kết quả chỉ ghi “không thấy thay đổi qua các pass đối chiếu”, không phải khóa tài liệu.', 'Ảnh xem trước là raster riêng, không chứng minh khớp từng pixel với dữ liệu.'],
      createdAt: new Date(nowMs).toISOString(), deadline: new Date(nowMs + limits.jobMs).toISOString(), lastContactAt: new Date(nowMs).toISOString(),
    };
    const staging = this.files(id);
    mkdirSync(staging.assetsDir, { recursive: true });
    this.runtime.set(id, { streams: Object.fromEntries(TEXT_STREAMS.map((s) => [s, { hash: createHash('sha256'), bytes: 0, records: 0 }])), seqs: new Map(), assets: new Map(), totalBytes: 0, peakUnacked: 0 });
    this.previous.set(id, input.previousSnapshotId);
    this.activeJobId = id; session.jobId = id;
    this.o.store.designJobs.put(job);
    this.enqueue({ type: 'START_EXPORT', jobId: id, scopeHash: hash, scope: input.scope, rootIds, pageIds: pages, limits, chunkBytes: CHUNK_MAX_BYTES });
    return job;
  }
  private readonly previous = new Map<string, string | undefined>();

  getJob(id: string): FigmaExportJob {
    const job = this.o.store.designJobs.get(id);
    if (!job) throw new HttpError(404, 'Job export không tồn tại.');
    return job;
  }
  listJobs(): FigmaExportJob[] { return this.o.store.designJobs.list().slice(-50).reverse(); }

  cancel(jobId: string): FigmaExportJob {
    const job = this.getJob(jobId);
    if (!EXPORT_ACTIVE.includes(job.status)) return job;
    // Permission to write is withdrawn first; the plugin is told afterwards and whatever it still sends is refused.
    const ended = this.endJob(jobId, 'cancelled', undefined, true);
    this.stopping = { jobId, until: this.now() + 10_000 };
    try { this.enqueue({ type: 'CANCEL', jobId }); } catch { /* no live plugin to tell */ }
    return ended;
  }

  /** Terminal state, lock released. Idempotent: a job that already ended keeps the state it ended in. */
  private endJob(jobId: string, status: 'failed' | 'cancelled' | 'interrupted' | 'partial' | 'review_ready', error?: FigmaExportJob['error'], cancelRequested = false): FigmaExportJob {
    const job = this.getJob(jobId);
    if (!EXPORT_ACTIVE.includes(job.status)) return job;
    const ended: FigmaExportJob = { ...job, status, ...(error ? { error } : {}), ...(cancelRequested ? { cancelRequested: true } : {}), endedAt: new Date(this.now()).toISOString(), phase: undefined };
    this.o.store.designJobs.put(ended);
    if (this.activeJobId === jobId) this.activeJobId = undefined;
    if (this.session?.jobId === jobId) this.session.jobId = undefined;
    this.closeUploads(jobId);
    return ended;
  }

  private closeUploads(jobId: string): void { this.runtime.get(jobId)?.assets.forEach((a) => { a.done = true; }); }

  // ------------------------------------------------------------ chunks

  /** One chunk, stored before it is acknowledged. The same chunk again is a no-op; the same sequence with other bytes is a conflict. */
  async ingest(session: PluginSession, body: ChunkEnvelope): Promise<{ ack: number; duplicate: boolean }> {
    if (session !== this.session) throw new HttpError(401, 'Phiên Exporter đã bị thay thế.');
    const job = this.getJob(String(body?.jobId ?? ''));
    return this.serial(job.id, () => this.ingestNow(job.id, body));
  }

  private serial<T>(jobId: string, work: () => Promise<T> | T): Promise<T> {
    const run = (this.chains.get(jobId) ?? Promise.resolve()).then(work, work);
    this.chains.set(jobId, run.catch(() => undefined));
    return run;
  }

  private ingestNow(jobId: string, c: ChunkEnvelope): { ack: number; duplicate: boolean } {
    const job = this.getJob(jobId), rt = this.runtime.get(jobId);
    if (!rt) throw new HttpError(409, 'Job không còn nhận dữ liệu (server đã khởi động lại). Tạo lượt export mới.');
    if (job.id !== this.activeJobId || !EXPORT_ACTIVE.includes(job.status) || job.cancelRequested) throw new HttpError(409, `Job ${job.status === 'cancelled' ? 'đã bị hủy' : 'không còn nhận dữ liệu'}; chunk bị từ chối.`);
    if (c.protocolVersion !== PROTOCOL_VERSION) throw new HttpError(409, 'Sai phiên bản giao thức.');
    if (c.sourceSession !== job.source.sourceSession) throw new HttpError(409, 'Chunk đến từ phiên nguồn khác với job này.');
    if (c.scopeHash !== job.scopeHash) throw new HttpError(409, 'Phạm vi của chunk khác với phạm vi job đã khóa.');
    if (!Number.isInteger(c.seq) || c.seq < 0) throw new HttpError(400, 'Số thứ tự chunk không hợp lệ.');
    if (typeof c.payload !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(c.payload)) throw new HttpError(400, 'Dữ liệu chunk không phải base64.');
    if (!Number.isInteger(c.byteLength) || c.byteLength < 0 || c.byteLength > CHUNK_MAX_BYTES) throw new HttpError(413, `Chunk vượt ${CHUNK_MAX_BYTES} byte.`);
    const bytes = decodeBase64(c.payload);
    if (bytes.length !== c.byteLength) throw new HttpError(400, 'Độ dài chunk không khớp byteLength.');
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== c.sha256) throw new HttpError(400, 'Hash chunk không khớp nội dung.');
    const known = rt.seqs.get(c.seq);
    if (known !== undefined) {
      if (known === `${c.kind}:${sha}`) return { ack: c.seq, duplicate: true };
      throw new HttpError(409, `Chunk ${c.seq} đã nhận với nội dung khác.`);
    }
    if (c.seq !== job.nextSeq) throw new HttpError(409, `Thiếu chunk: server đang chờ ${job.nextSeq}, nhận ${c.seq}.`);
    if (rt.totalBytes + bytes.length > job.limits.maxBytes) {
      rt.limitReached = 'bytes';
      throw new HttpError(413, `Vượt giới hạn ${job.limits.maxBytes} byte của job; dữ liệu chưa đầy đủ.`);
    }
    const staging = this.files(jobId);
    const buffer = Buffer.from(bytes);
    if (c.kind === 'asset') this.appendAsset(rt, staging, job, c, buffer);
    else if ((TEXT_STREAMS as readonly string[]).includes(c.kind)) {
      appendFileSync(path.join(staging.dir, `${c.kind}.ndjson`), buffer);
      const s = rt.streams[c.kind]!;
      s.hash.update(buffer); s.bytes += buffer.length; s.records += countNewlines(buffer);
    } else throw new HttpError(400, 'Loại chunk không được hỗ trợ.');
    rt.seqs.set(c.seq, `${c.kind}:${sha}`);
    rt.totalBytes += bytes.length;
    this.o.store.designJobs.put({ ...job, nextSeq: c.seq + 1, counts: { ...job.counts, bytes: rt.totalBytes }, lastContactAt: new Date(this.now()).toISOString() });
    return { ack: c.seq, duplicate: false };
  }

  private appendAsset(rt: JobRuntime, staging: StagingFiles, job: FigmaExportJob, c: ChunkEnvelope, buffer: Buffer): void {
    if (!c.assetId || !/^[a-f0-9]{64}$/.test(c.assetId)) throw new HttpError(400, 'Chunk tài nguyên thiếu mã nội dung hợp lệ.');
    let up = rt.assets.get(c.assetId);
    if (!up) { up = { hash: createHash('sha256'), bytes: 0, part: path.join(staging.assetsDir, `${c.assetId}.part`), done: false }; rt.assets.set(c.assetId, up); }
    if (up.done) throw new HttpError(409, `Tài nguyên ${c.assetId} đã hoàn tất.`);
    if (c.offset !== up.bytes) throw new HttpError(409, `Tài nguyên ${c.assetId}: chờ offset ${up.bytes}, nhận ${c.offset}.`);
    if (up.bytes + buffer.length > job.limits.maxAssetBytes) { rt.limitReached = 'asset'; throw new HttpError(413, 'Tài nguyên vượt giới hạn dung lượng một tài nguyên.'); }
    appendFileSync(up.part, buffer);
    up.hash.update(buffer); up.bytes += buffer.length;
    if (c.final) {
      if (up.hash.copy().digest('hex') !== c.assetId) throw new HttpError(409, `Tài nguyên ${c.assetId}: hash nội dung không khớp mã.`);
      renameSync(up.part, path.join(staging.assetsDir, c.assetId));
      up.done = true;
    }
  }

  // ------------------------------------------------------------ finish

  async finish(session: PluginSession, body: FinishBody): Promise<{ job: FigmaExportJob; snapshot?: DesignSnapshot }> {
    if (session !== this.session) throw new HttpError(401, 'Phiên Exporter đã bị thay thế.');
    const job = this.getJob(String(body?.jobId ?? ''));
    return this.serial(job.id, () => this.finishNow(job.id, body));
  }

  private async finishNow(jobId: string, body: FinishBody): Promise<{ job: FigmaExportJob; snapshot?: DesignSnapshot }> {
    let job = this.getJob(jobId);
    const rt = this.runtime.get(jobId);
    if (!rt || job.id !== this.activeJobId || !EXPORT_ACTIVE.includes(job.status) || job.cancelRequested) throw new HttpError(409, 'Job không còn nhận kết thúc.');
    if (body.sourceSession !== job.source.sourceSession || body.scopeHash !== job.scopeHash || body.protocolVersion !== PROTOCOL_VERSION) throw new HttpError(409, 'Nguồn, phạm vi hoặc giao thức của finish không khớp job.');
    if (body.lastSeq !== job.nextSeq - 1) throw new HttpError(409, `Thiếu chunk: plugin báo chunk cuối ${body.lastSeq}, server đã lưu tới ${job.nextSeq - 1}.`);
    for (const [id, a] of rt.assets) if (!a.done) throw new HttpError(409, `Tài nguyên ${id} chưa nhận đủ.`);
    job = this.o.store.designJobs.put({ ...job, status: 'verifying', phase: 'Server đang kiểm chứng dữ liệu' });
    try {
      const staging = this.files(jobId);
      const measured = Object.fromEntries(TEXT_STREAMS.map((s) => { const r = rt.streams[s]!; return [s, { bytes: r.bytes, sha256: r.hash.copy().digest('hex'), records: r.records } satisfies StreamSummary]; })) as FinishBody['streams'];
      const storedAssets = new Map<string, { bytes: number; sha256: string }>();
      for (const name of existsSync(staging.assetsDir) ? readdirSync(staging.assetsDir) : []) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        const full = path.join(staging.assetsDir, name);
        storedAssets.set(name, { bytes: statSync(full).size, sha256: await fileSha(full) });
      }
      const validator = new ExportValidator({ rootIds: job.rootIds, pageIds: job.pageIds, scope: job.scope, sourceIdentity: job.source.identity, finish: { ...body, limitReached: body.limitReached ?? rt.limitReached ?? null }, measured, storedAssets });
      for await (const r of records<InventoryRecord>(staging.inventory)) validator.addInventory(r, 1);
      for await (const r of records<InventoryRecord>(staging.verification)) if (r.k === 'inv') validator.addInventory(r, 2);
      this.o.store.designJobs.put({ ...this.getJob(jobId), status: 'assembling', phase: 'Đang dựng snapshot' });
      for await (const r of records<NodeRecord>(staging.nodes)) validator.addNode(r);
      for await (const r of records<DependencyRecord>(staging.dependencies)) validator.addDependency(r);
      const result = validator.finish();
      const blockers = result.issues.filter((i) => i.severity === 'blocker');
      // Records that are not even the right shape cannot be written into a snapshot; the export ends here with the reasons, and no draft exists.
      if (result.issues.some((i) => MALFORMED.has(i.code))) {
        this.o.store.designJobs.put({ ...this.getJob(jobId), issues: result.issues, coverage: result.coverage, counts: { ...result.counts, bytes: rt.totalBytes } });
        const ended = this.endJob(jobId, 'failed', { code: 'invalid_records', message: 'Plugin gửi bản ghi sai định dạng nên không dựng được snapshot.', hint: 'Cập nhật plugin (import lại manifest mới) rồi export lại; dữ liệu staging được giữ để chẩn đoán.' });
        return { job: ended };
      }
      const draft: FigmaExportJob = { ...this.getJob(jobId), issues: result.issues, coverage: result.coverage, counts: { ...result.counts, bytes: rt.totalBytes }, stats: { peakUnackedChunks: Math.max(body.stats?.peakUnackedChunks ?? 0, rt.peakUnacked), durationMs: body.stats?.durationMs } };
      const snapshot = await this.o.snapshots.build({ ...draft, endedAt: new Date(this.now()).toISOString() }, staging, result, this.previousFor(job, this.previous.get(jobId)));
      this.o.store.designJobs.put({ ...draft, snapshotId: snapshot.id });
      this.endJob(jobId, blockers.length ? 'partial' : 'review_ready');
      if (!blockers.length) this.o.store.designJobs.put({ ...this.getJob(jobId), phase: 'Chờ bạn xem và duyệt' });
      return { job: this.getJob(jobId), snapshot };
    } catch (error) {
      this.endJob(jobId, 'failed', { code: 'finalize_failed', message: (error as Error).message.slice(0, 400), hint: 'Dữ liệu staging được giữ để chẩn đoán; tạo lượt export mới.' });
      throw error instanceof HttpError ? error : new HttpError(500, `Không dựng được snapshot: ${(error as Error).message}`);
    }
  }

  /** The earlier snapshot this one continues, only when the file identity makes that claim safe or the person confirmed it at export time. */
  private previousFor(job: FigmaExportJob, confirmed: string | undefined): string | undefined {
    if (confirmed) { const s = this.o.snapshots.get(confirmed); if (s && s.scope.kind === job.scope) return confirmed; }
    if (job.source.identity !== 'verified' || !job.source.fileKey) return undefined;
    return this.o.snapshots.list().filter((s) => s.source.identity === 'verified' && s.source.fileKey === job.source.fileKey && s.scope.kind === job.scope && s.status === 'published').at(-1)?.id;
  }

  // ------------------------------------------------------------ recovery and cleanup

  /** A restart cannot continue an export that was in flight: it is closed as interrupted, staging stays for diagnosis. */
  recover(): number {
    let n = 0;
    for (const job of this.o.store.designJobs.list()) {
      if (!EXPORT_ACTIVE.includes(job.status)) continue;
      this.o.store.designJobs.put({ ...job, status: 'interrupted', phase: undefined, endedAt: new Date(this.now()).toISOString(), error: { code: 'server_restarted', message: 'Server khởi động lại giữa lúc export.', hint: 'Ghép đôi lại và tạo lượt export mới; export không tiếp tục giữa hai phiên.' } });
      n++;
    }
    this.o.snapshots.recover();
    return n;
  }

  /** Staging of ended jobs older than `maxAgeMs`. A snapshot is never touched here. */
  cleanStaging(maxAgeMs = 7 * 86_400_000): string[] {
    const removed: string[] = [];
    for (const job of this.o.store.designJobs.list()) {
      if (EXPORT_ACTIVE.includes(job.status) || !job.endedAt || this.now() - Date.parse(job.endedAt) < maxAgeMs) continue;
      const dir = this.stagingDir(job.id);
      if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); removed.push(job.id); }
    }
    return removed;
  }

  deleteJob(jobId: string): void {
    const job = this.getJob(jobId);
    if (EXPORT_ACTIVE.includes(job.status)) throw new HttpError(409, 'Job đang chạy.');
    rmSync(this.stagingDir(jobId), { recursive: true, force: true });
    this.o.store.designJobs.delete(jobId);
  }
}

const MALFORMED = new Set(['node_malformed', 'inventory_malformed', 'dependency_malformed']);

function countNewlines(buffer: Buffer): number {
  let n = 0;
  for (let i = buffer.indexOf(10); i !== -1; i = buffer.indexOf(10, i + 1)) n++;
  return n;
}
function fileSha(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
