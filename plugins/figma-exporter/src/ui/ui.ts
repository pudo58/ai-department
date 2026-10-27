import {
  CHUNK_MAX_BYTES, MAX_CHUNK_RETRIES, PLUGIN_API_PREFIX, PROTOCOL_VERSION, TEXT_STREAMS,
  type ChunkEnvelope, type FinishBody, type HelloInfo, type PluginCommand, type PluginEvent,
} from '../../../../src/shared/figma.js';
import { Sha256, sha256Bytes, utf8 } from '../../../../src/shared/sha256.js';
import type { FinishedSummary, MainToUi, StartExport, UiToMain } from '../messages.js';

interface Config { origin: string; bundleHash?: string; pluginVersion?: string }
declare global { interface Window { __AIDEPT__?: Config } }

/**
 * The plugin's UI: it pairs with AI Department, asks what to do, and uploads what the main code reads. It has the network but cannot see
 * the document; the main code can see the document but has no network. Nothing here is told to run code or to change anything.
 */
const config: Config = window.__AIDEPT__ ?? { origin: '' };
const API = `${config.origin}${PLUGIN_API_PREFIX}`;
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let token: string | undefined;
let hello: HelloInfo | undefined;
let polling = false;
let reqId = 0;
const pending = new Map<number, { resolve: (m: MainToUi) => void; reject: (e: Error) => void }>();

interface Upload { jobId: string; scopeHash: string; sourceSession: string; seq: number; failed: boolean; streams: Record<string, { hash: Sha256; bytes: number; records: number }>; assets: Map<string, { bytes: number; sha256: string }> }
let upload: Upload | undefined;
let finishing = false;
/** Chunks go to the server one after another, in the order main produced them: sequence numbers and stream order depend on it. */
let queue: Promise<void> = Promise.resolve();

const toMain = (message: UiToMain) => parent.postMessage({ pluginMessage: message }, '*');
const ask = (build: (id: number) => UiToMain): Promise<MainToUi> => new Promise((resolve, reject) => {
  const id = ++reqId;
  pending.set(id, { resolve, reject });
  toMain(build(id));
  setTimeout(() => { if (pending.delete(id)) reject(new Error('Plugin chính không trả lời.')); }, 60_000);
});

// ------------------------------------------------------------ display

type View = 'unpaired' | 'connected' | 'working' | 'done' | 'lost';
function show(view: View, text: string, detail = ''): void {
  el('view').dataset.view = view;
  el('status').textContent = text;
  el('detail').textContent = detail;
  el<HTMLButtonElement>('pair').hidden = view !== 'unpaired';
  el<HTMLInputElement>('code').hidden = view !== 'unpaired';
  el<HTMLButtonElement>('cancel').hidden = view !== 'working';
  el<HTMLButtonElement>('disconnect').hidden = view !== 'connected' && view !== 'done';
}
const setProgress = (done: number, total?: number) => { const bar = el<HTMLProgressElement>('bar'); bar.hidden = false; bar.max = total && total > 0 ? total : 100; bar.value = total && total > 0 ? Math.min(done, total) : 0; };

// ------------------------------------------------------------ talking to the server

class Rejected extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function call<T>(path: string, body: unknown, auth = true, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const text = await response.text();
  let json: { message?: string } & Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { throw new Rejected(response.status, `Server trả dữ liệu không hợp lệ (${response.status}).`); }
  if (!response.ok) throw new Rejected(response.status, json.message ?? `Server từ chối (${response.status}).`);
  return json as T;
}
const sendEvent = (event: PluginEvent) => call('/event', { event }).catch(() => undefined);

async function pair(): Promise<void> {
  const code = el<HTMLInputElement>('code').value.trim();
  if (!/^\d{8}$/.test(code)) { show('unpaired', 'Mã ghép đôi gồm 8 chữ số.', 'Lấy mã ở AI Department: MCP → Ghép đôi.'); return; }
  show('unpaired', 'Đang ghép đôi…');
  try {
    const answer = await ask((id) => ({ type: 'HELLO', reqId: id }));
    if (answer.type !== 'HELLO_RESULT') throw new Error(answer.type === 'REQUEST_ERROR' ? answer.message : 'Không đọc được thông tin file.');
    hello = { ...answer.hello, ...(config.bundleHash ? { bundleHash: config.bundleHash } : {}) };
    const result = await call<{ token: string; instanceName: string }>('/pair', { code, hello }, false);
    token = result.token;
    el<HTMLInputElement>('code').value = '';
    show('connected', `Đã kết nối với ${result.instanceName}`, `File “${hello.fileName}”. Chọn phạm vi và bấm Export trong AI Department.`);
    void pollLoop();
  } catch (error) { show('unpaired', 'Không ghép đôi được.', (error as Error).message); }
}

async function pollLoop(): Promise<void> {
  if (polling) return;
  polling = true;
  let failures = 0;
  while (token) {
    try {
      const { commands } = await call<{ commands: PluginCommand[] }>('/poll', {});
      failures = 0;
      for (const command of commands) void handle(command);
    } catch (error) {
      if (error instanceof Rejected && (error.status === 401 || error.status === 403)) { token = undefined; show('unpaired', 'Phiên đã bị thu hồi.', 'Ghép đôi lại bằng mã mới.'); break; }
      failures++;
      show('lost', 'Mất liên lạc với AI Department.', failures >= 10 ? 'Đóng plugin và mở lại sau khi AI Department chạy.' : 'Đang thử lại…');
      if (failures >= 10) { token = undefined; break; }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  polling = false;
}

async function handle(command: PluginCommand): Promise<void> {
  try {
    switch (command.type) {
      case 'HELLO': { const m = await ask((id) => ({ type: 'HELLO', reqId: id })); if (m.type === 'HELLO_RESULT') { hello = { ...m.hello, ...(config.bundleHash ? { bundleHash: config.bundleHash } : {}) }; await sendEvent({ type: 'hello', commandId: command.id, hello }); } else throw new Error('hello'); break; }
      case 'LIST_PAGES': { const m = await ask((id) => ({ type: 'LIST_PAGES', reqId: id })); if (m.type === 'PAGES_RESULT') await sendEvent({ type: 'pages', commandId: command.id, pages: m.pages }); else throw new Error('pages'); break; }
      case 'LIST_ROOTS': { const m = await ask((id) => ({ type: 'LIST_ROOTS', reqId: id, pageId: command.pageId })); if (m.type === 'ROOTS_RESULT') await sendEvent({ type: 'roots', commandId: command.id, pageId: m.pageId, roots: m.roots }); else throw new Error('roots'); break; }
      case 'START_EXPORT': startExport(command); break;
      case 'CANCEL': toMain({ type: 'CANCEL', jobId: command.jobId }); break;
      case 'DISCONNECT': token = undefined; toMain({ type: 'DISCONNECT' }); show('unpaired', 'Đã ngắt kết nối.'); break;
    }
  } catch (error) {
    await sendEvent({ type: 'error', commandId: command.id, code: 'internal', message: (error as Error).message });
  }
}

function startExport(command: StartExport): void {
  if (upload || !hello) { void sendEvent({ type: 'error', jobId: command.jobId, code: 'bad_command', message: 'Exporter đang bận hoặc chưa có thông tin file.' }); return; }
  upload = { jobId: command.jobId, scopeHash: command.scopeHash, sourceSession: hello.sourceSession, seq: 0, failed: false, streams: Object.fromEntries(TEXT_STREAMS.map((k) => [k, { hash: new Sha256(), bytes: 0, records: 0 }])), assets: new Map() };
  finishing = false;
  show('working', 'Đang export…', 'Giữ file này mở và đừng sửa nó cho tới khi xong.');
  setProgress(0);
  toMain({ type: 'START_EXPORT', command });
}

// ------------------------------------------------------------ uploading what main reads

async function postChunk(envelope: ChunkEnvelope): Promise<void> {
  let attempt = 0;
  for (;;) {
    try { await call('/chunk', envelope); return; }
    catch (error) {
      // A refusal is final; only a lost answer (the network) is tried again, at most twice, with the same bytes.
      if (error instanceof Rejected || attempt >= MAX_CHUNK_RETRIES) throw error;
      attempt++;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function uploadData(m: Extract<MainToUi, { type: 'DATA' }>): Promise<void> {
  const up = upload;
  if (!up || up.failed) return;
  const bytes = m.text !== undefined ? utf8(m.text) : m.bytes ?? new Uint8Array();
  const pieces = Math.max(1, Math.ceil(bytes.length / CHUNK_MAX_BYTES));
  for (let i = 0; i < pieces; i++) {
    const part = bytes.subarray(i * CHUNK_MAX_BYTES, (i + 1) * CHUNK_MAX_BYTES);
    const envelope: ChunkEnvelope = {
      protocolVersion: PROTOCOL_VERSION, jobId: up.jobId, sourceSession: up.sourceSession, scopeHash: up.scopeHash, seq: up.seq, kind: m.kind,
      ...(m.kind === 'asset' ? { assetId: m.assetId, offset: (m.offset ?? 0) + i * CHUNK_MAX_BYTES, final: !!m.final && i === pieces - 1 } : {}),
      byteLength: part.length, sha256: sha256Bytes(part), payload: base64(part),
    };
    await postChunk(envelope);
    up.seq++;
    if (m.kind === 'asset') { const a = up.assets.get(m.assetId!) ?? { bytes: 0, sha256: m.assetId! }; a.bytes += part.length; up.assets.set(m.assetId!, a); }
    else { const s = up.streams[m.kind]!; s.hash.update(part); s.bytes += part.length; for (let k = 0; k < part.length; k++) if (part[k] === 10) s.records++; }
  }
}

function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function finish(summary: FinishedSummary): Promise<void> {
  const up = upload;
  if (!up || finishing) return;
  finishing = true;
  try {
    const body: FinishBody = {
      protocolVersion: PROTOCOL_VERSION, jobId: up.jobId, sourceSession: up.sourceSession, scopeHash: up.scopeHash, lastSeq: up.seq - 1,
      streams: Object.fromEntries(TEXT_STREAMS.map((k) => [k, { bytes: up.streams[k]!.bytes, sha256: up.streams[k]!.hash.hex(), records: up.streams[k]!.records }])) as FinishBody['streams'],
      assets: [...up.assets].map(([id, a]) => ({ id, bytes: a.bytes, sha256: a.sha256 })),
      totals: summary.totals, verification: summary.verification, stats: summary.stats, limitReached: summary.limitReached, errors: summary.errors,
    };
    const result = await call<{ job: { status: string }; snapshotId?: string }>('/finish', body);
    show('done', result.job.status === 'review_ready' ? 'Export xong, chờ bạn duyệt.' : 'Export xong nhưng chưa thể duyệt.', 'Mở AI Department → MCP để xem kiểm kê, giới hạn và duyệt snapshot.');
  } catch (error) {
    show('done', 'Server không nhận kết quả.', (error as Error).message);
  } finally { upload = undefined; el<HTMLProgressElement>('bar').hidden = true; }
}

function failUpload(code: string, message: string): void {
  if (!upload) return;
  upload.failed = true;
  const jobId = upload.jobId;
  upload = undefined;
  toMain({ type: 'CANCEL', jobId });
  void sendEvent({ type: 'error', jobId, code, message });
  show('done', 'Export dừng.', message);
  el<HTMLProgressElement>('bar').hidden = true;
}

window.addEventListener('message', (event: MessageEvent) => {
  // Only the parent (the plugin's main code) speaks to this UI.
  if (event.source !== parent) return;
  const m = (event.data as { pluginMessage?: MainToUi } | undefined)?.pluginMessage;
  if (!m || typeof m !== 'object' || typeof (m as { type?: unknown }).type !== 'string') return;
  switch (m.type) {
    case 'HELLO_RESULT': case 'PAGES_RESULT': case 'ROOTS_RESULT': case 'REQUEST_ERROR': {
      const p = pending.get(m.reqId);
      if (p) { pending.delete(m.reqId); if (m.type === 'REQUEST_ERROR') p.reject(new Error(m.message)); else p.resolve(m); }
      break;
    }
    case 'YIELD': setTimeout(() => toMain({ type: 'YIELD_ACK' }), 0); break;
    case 'DATA': queue = queue.then(() => uploadData(m)).then(() => toMain({ type: 'ACK', id: m.id }), (error: Error) => failUpload('upload_failed', error.message)); break;
    case 'EVENT': {
      const e: PluginEvent = m.event;
      if (e.type === 'progress') { setProgress(e.nodes, e.total); el('detail').textContent = `${e.nodes} node, ${(e.bytes / 1024).toFixed(0)} KB đã gửi`; }
      if (e.type === 'phase') el('status').textContent = e.note ?? `Giai đoạn: ${e.phase}`;
      if (e.type === 'cancelled') { upload = undefined; show('done', 'Export đã hủy.'); el<HTMLProgressElement>('bar').hidden = true; }
      if (e.type === 'error' && e.jobId) { upload = undefined; show('done', 'Export lỗi.', e.message); el<HTMLProgressElement>('bar').hidden = true; }
      void sendEvent(e);
      break;
    }
    case 'FINISHED': void finish(m.summary); break;
  }
});

el('pair').addEventListener('click', () => void pair());
el('code').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void pair(); });
el('cancel').addEventListener('click', () => { if (upload) { toMain({ type: 'CANCEL', jobId: upload.jobId }); } });
el('disconnect').addEventListener('click', () => { void call('/disconnect', {}).catch(() => undefined); token = undefined; toMain({ type: 'DISCONNECT' }); show('unpaired', 'Đã ngắt kết nối.'); });
show('unpaired', 'Chưa ghép đôi.', 'Nhập mã 8 chữ số từ AI Department (MCP → Ghép đôi).');
