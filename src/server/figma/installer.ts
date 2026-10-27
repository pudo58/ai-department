import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { buildExporter, prepareBundle, verifyBundle, TEMPLATE_DIR } from '../../../plugins/figma-exporter/build.mjs';
import { PLUGIN_VERSION, PROTOCOL_VERSION } from '../../shared/figma.js';
import type { BundleState, DesktopState, InstallJob, InstallStep, InstallStepId } from '../../shared/design.js';
import { HttpError } from '../run/support.js';
import { executeFile } from '../../runtime/process.js';
import type { Store } from '../store.js';

/**
 * The installer Department offers, fixed in the release and reviewed when it changes. The checksum is not read from the response that
 * delivers the file, because a tampered download would then vouch for itself.
 */
export const FIGMA_CATALOG = Object.freeze({
  version: '126.9.16', platform: 'win32', arch: 'x64',
  url: 'https://desktop.figma.com/win/build/Figma-126.9.16.exe',
  sha256: '4E5A411C95105D9826D23533F9D18E89B2FCC10E878BB85DD46DFD6F616C3795'.toLowerCase(),
  silentArgs: ['--silent'], signerContains: 'Figma',
  source: 'https://github.com/microsoft/winget-pkgs/blob/master/manifests/f/Figma/Figma/126.9.16/Figma.Figma.installer.yaml',
});
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface Found { executable: string; version?: string; signed?: boolean }
/** What the installer touches in the outside world. The defaults are real; tests give fakes, so no installer is ever run by a test. */
export interface InstallerDeps {
  platform: { os: NodeJS.Platform; arch: string };
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Finds a Figma Desktop executable that is really there, and what it says about itself. */
  find(): Promise<Found | undefined>;
  isRunning(): Promise<boolean>;
  download(url: string, dest: string, signal: AbortSignal): Promise<void>;
  sha256(file: string): Promise<string>;
  /** Authenticode status of a file: valid or not, and who signed it. */
  signature(file: string): Promise<{ valid: boolean; subject?: string; reason?: string }>;
  run(file: string, args: string[], timeoutMs: number): Promise<{ exitCode: number | null; timedOut: boolean; output: string }>;
  launch(file: string): void;
  openFolder(dir: string): void;
}

const ps = (script: string): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> =>
  executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: 30_000 });

export const realDeps = (): InstallerDeps => ({
  platform: { os: process.platform, arch: process.arch },
  env: process.env,
  now: () => Date.now(),
  async find() {
    if (process.platform !== 'win32') return undefined;
    const roots = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Figma'), process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Figma'), process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Figma')].filter((x): x is string => !!x);
    for (const root of roots) {
      const exe = path.join(root, 'Figma.exe');
      if (!existsSync(exe)) continue;
      // The launcher in the root is a stub; the version of the app lives in the newest app-<version> folder next to it.
      const apps = existsSync(root) ? readdirSync(root).filter((n) => /^app-\d/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
      const probe = apps.length ? path.join(root, apps.at(-1)!, 'Figma.exe') : exe;
      const info = await ps(`$f='${(existsSync(probe) ? probe : exe).replace(/'/g, "''")}'; $v=(Get-Item -LiteralPath $f).VersionInfo.ProductVersion; $s=(Get-AuthenticodeSignature -LiteralPath $f).Status; "$v|$s"`).catch(() => undefined);
      const [version, status] = (info?.stdout ?? '').trim().split('|');
      return { executable: exe, ...(version ? { version } : {}), signed: status === 'Valid' };
    }
    return undefined;
  },
  async isRunning() {
    if (process.platform !== 'win32') return false;
    const out = await executeFile('tasklist.exe', ['/FI', 'IMAGENAME eq Figma.exe', '/NH'], { timeoutMs: 10_000 }).catch(() => undefined);
    return !!out && /Figma\.exe/i.test(out.stdout);
  },
  async download(url, dest, signal) {
    const response = await fetch(url, { signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Tải installer thất bại (${response.status}).`);
    mkdirSync(path.dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest), { signal });
  },
  sha256: (file) => new Promise((resolve, reject) => { const h = createHash('sha256'); createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); }),
  async signature(file) {
    if (process.platform !== 'win32') return { valid: false, reason: 'Chỉ kiểm tra được Authenticode trên Windows.' };
    const out = await ps(`$s=Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`);
    const [status, subject] = out.stdout.trim().split('|');
    return { valid: status === 'Valid', subject, ...(status === 'Valid' ? {} : { reason: `Trạng thái chữ ký: ${status || 'không rõ'}` }) };
  },
  async run(file, args, timeoutMs) {
    const r = await executeFile(file, args, { timeoutMs });
    return { exitCode: r.exitCode, timedOut: r.timedOut, output: `${r.stdout}\n${r.stderr}`.slice(-4000) };
  },
  launch(file) { void import('node:child_process').then(({ spawn }) => spawn(file, [], { detached: true, stdio: 'ignore' }).unref()); },
  openFolder(dir) {
    void import('node:child_process').then(({ spawn }) => {
      const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
      spawn(cmd!, args as string[], { detached: true, stdio: 'ignore' }).unref();
    });
  },
});

const STEP_LABELS: Record<InstallStepId, string> = {
  detect: 'Tìm Figma Desktop', download: 'Tải installer chính thức', verify: 'Kiểm tra SHA-256 và chữ ký', install: 'Cài đặt (quyền người dùng, không cần admin)', confirm: 'Xác nhận ứng dụng sau khi cài', bundle: 'Chuẩn bị plugin Exporter',
};

export interface InstallerOptions { dataDir: string; store: Store; origin: string; deps?: InstallerDeps }

/** Installs Figma Desktop for the current user (when it is missing) and prepares the Exporter plugin folder. Never needs or asks for admin. */
export class FigmaInstaller {
  private readonly deps: InstallerDeps;
  private running: { id: string; abort: AbortController; cancelled: boolean } | undefined;
  constructor(private readonly o: InstallerOptions) { this.deps = o.deps ?? realDeps(); }

  get baseDir(): string { return path.join(this.o.dataDir, 'integrations', 'figma'); }
  get bundleDir(): string { return path.join(this.baseDir, 'exporter'); }
  private get downloadFile(): string { return path.join(this.baseDir, 'downloads', `Figma-${FIGMA_CATALOG.version}.exe`); }

  platformSupport(): { supported: boolean; reason?: string } {
    const { os, arch } = this.deps.platform;
    return os === 'win32' && arch === 'x64' ? { supported: true } : { supported: false, reason: `Tự cài Figma Desktop chỉ hỗ trợ Windows x64 (máy này: ${os} ${arch}). Bạn vẫn có thể cài Figma Desktop thủ công và dùng Exporter.` };
  }

  async desktopState(): Promise<DesktopState> {
    const job = this.activeJob();
    if (job?.status === 'running' && job.steps.some((s) => s.id === 'install' && s.status === 'running')) return { state: 'installing', catalogVersion: FIGMA_CATALOG.version };
    const found = await this.deps.find().catch(() => undefined);
    if (!found) return { state: 'not_installed', catalogVersion: FIGMA_CATALOG.version };
    const running = await this.deps.isRunning().catch(() => false);
    if (found.signed === false) return { state: 'unverified', executable: found.executable, ...(found.version ? { version: found.version } : {}), signed: false, running, catalogVersion: FIGMA_CATALOG.version, note: 'Không xác minh được chữ ký của file chạy; hệ thống không mở nó.' };
    return { state: 'installed', executable: found.executable, ...(found.version ? { version: found.version } : {}), signed: found.signed, running, catalogVersion: FIGMA_CATALOG.version, note: 'Figma tự cập nhật nên phiên bản có thể mới hơn bản installer của Department.' };
  }

  bundleState(): BundleState {
    const dir = this.bundleDir;
    if (!existsSync(path.join(dir, 'bundle-manifest.json'))) return { state: 'missing', note: 'Chưa chuẩn bị plugin Exporter. Bấm “Cài Figma Desktop & Exporter”.' };
    const v = verifyBundle(dir);
    if (!v.ok || !v.info) return { state: 'incompatible', dir, note: `Bộ plugin bị hỏng: ${v.problems.slice(0, 2).join('; ')}. Bấm cài lại để tạo bản mới.` };
    const base = { dir, pluginVersion: v.info.pluginVersion, protocolVersion: v.info.protocolVersion, origin: v.info.origin, bundleHash: v.info.bundleHash };
    if (v.info.protocolVersion !== PROTOCOL_VERSION || v.info.pluginVersion !== PLUGIN_VERSION) return { state: 'incompatible', ...base, note: 'Plugin cũ không khớp giao thức hiện tại. Tạo bản mới và import lại manifest.' };
    if (v.info.origin !== this.o.origin) return { state: 'stale', ...base, note: `Plugin này nối tới ${v.info.origin} nhưng AI Department đang chạy ở ${this.o.origin}. Tạo bản mới và import lại manifest.` };
    return { state: 'prepared', ...base, note: 'Import manifest.json trong Figma (Plugins → Development → Import plugin from manifest).' };
  }

  activeJob(): InstallJob | undefined { return this.running ? this.o.store.installJobs.get(this.running.id) : undefined; }
  listJobs(): InstallJob[] { return this.o.store.installJobs.list().slice(-20).reverse(); }
  getJob(id: string): InstallJob { const j = this.o.store.installJobs.get(id); if (!j) throw new HttpError(404, 'Job cài đặt không tồn tại.'); return j; }

  /** A restart leaves a job `running` that nothing is running; it is closed so the next install starts by looking at what is really there. */
  recover(): number {
    let n = 0;
    for (const j of this.o.store.installJobs.list()) if (j.status === 'running') { this.o.store.installJobs.put({ ...j, status: 'interrupted', endedAt: new Date(this.deps.now()).toISOString(), steps: j.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed', detail: 'Bị gián đoạn khi server khởi động lại; sẽ đối chiếu lại khi cài lại.' } : s)) }); n++; }
    return n;
  }

  /** Starts the install job and returns at once. The job records every step; running it again does only what is still missing. */
  start(): InstallJob {
    if (this.running) throw new HttpError(409, 'Đang có một job cài đặt chạy.');
    const job: InstallJob = { id: `ins_${randomBytes(5).toString('hex')}`, adapter: 'figma-direct', status: 'running', steps: (Object.keys(STEP_LABELS) as InstallStepId[]).map((id) => ({ id, label: STEP_LABELS[id], status: 'pending' as const })), log: [], createdAt: new Date(this.deps.now()).toISOString() };
    this.o.store.installJobs.put(job);
    this.running = { id: job.id, abort: new AbortController(), cancelled: false };
    void this.execute(job.id).finally(() => { this.running = undefined; });
    return job;
  }

  cancel(id: string): InstallJob {
    if (this.running?.id === id) { this.running.cancelled = true; this.running.abort.abort(); this.note(id, 'Đã yêu cầu hủy. Nếu installer đã chạy, nó không bị dừng giữa chừng; hệ thống sẽ đối chiếu ứng dụng sau khi nó kết thúc.'); }
    return this.getJob(id);
  }

  private note(id: string, line: string): void { const j = this.getJob(id); this.o.store.installJobs.put({ ...j, log: [...j.log, `${new Date(this.deps.now()).toISOString()} ${line}`].slice(-200) }); }
  private step(id: string, which: InstallStepId, patch: Partial<InstallStep>): void {
    const j = this.getJob(id), at = new Date(this.deps.now()).toISOString();
    this.o.store.installJobs.put({ ...j, steps: j.steps.map((s) => (s.id === which ? { ...s, ...patch, ...(patch.status === 'running' ? { startedAt: at } : {}), ...(patch.status && patch.status !== 'running' ? { endedAt: at } : {}) } : s)) });
  }
  private fail(id: string, step: InstallStepId, code: string, message: string, hint?: string): void {
    this.step(id, step, { status: 'failed', detail: message });
    this.o.store.installJobs.put({ ...this.getJob(id), status: 'failed', error: { code, message, ...(hint ? { hint } : {}) }, endedAt: new Date(this.deps.now()).toISOString() });
  }

  private async execute(id: string): Promise<void> {
    const state = this.running!;
    try {
      this.step(id, 'detect', { status: 'running' });
      let found = await this.deps.find();
      if (found && found.signed === false) { this.fail(id, 'detect', 'unverified_executable', `Tìm thấy ${found.executable} nhưng không xác minh được chữ ký.`, 'Gỡ hoặc cài lại Figma từ trang chính thức, rồi thử lại. Department không mở file không xác minh được.'); return; }
      this.step(id, 'detect', { status: 'done', detail: found ? `Đã có Figma Desktop${found.version ? ` ${found.version}` : ''}; giữ nguyên, không hạ phiên bản.` : 'Chưa có Figma Desktop.' });

      if (found) for (const s of ['download', 'verify', 'install'] as const) this.step(id, s, { status: 'skipped', detail: 'Đã có Figma Desktop dùng được.' });
      else {
        const support = this.platformSupport();
        if (!support.supported) { this.fail(id, 'download', 'unsupported_platform', support.reason!, 'Cài Figma Desktop thủ công từ trang chính thức, rồi bấm cài lại để chuẩn bị plugin.'); return; }
        if (!await this.download(id, state)) return;
        if (!await this.verify(id)) return;
        if (!await this.install(id, state)) return;
      }

      this.step(id, 'confirm', { status: 'running' });
      found = await this.deps.find();
      if (!found) { if (state.cancelled) { this.step(id, 'confirm', { status: 'failed', detail: 'Đã hủy; sau khi cài chưa thấy Figma Desktop.' }); this.o.store.installJobs.put({ ...this.getJob(id), status: 'failed', error: { code: 'cancelled', message: 'Đã hủy; chưa có Figma Desktop.' }, endedAt: new Date(this.deps.now()).toISOString() }); return; } this.fail(id, 'confirm', 'not_found_after_install', 'Installer kết thúc nhưng không tìm thấy Figma Desktop.', 'Chính sách máy có thể đã chặn installer. Cài Figma thủ công từ trang chính thức rồi bấm cài lại.'); return; }
      if (found.signed === false) { this.fail(id, 'confirm', 'unverified_executable', 'Figma sau khi cài không xác minh được chữ ký.', 'Gỡ và cài lại từ trang chính thức.'); return; }
      this.step(id, 'confirm', { status: 'done', detail: `Figma Desktop ${found.version ?? '(không rõ phiên bản)'} tại ${found.executable}.` });

      this.step(id, 'bundle', { status: 'running' });
      const prepared = await this.prepareBundle();
      this.step(id, 'bundle', { status: 'done', detail: `Plugin ${prepared.pluginVersion} cho ${prepared.origin} ở ${this.bundleDir}.` });
      this.o.store.installJobs.put({ ...this.getJob(id), status: 'completed', endedAt: new Date(this.deps.now()).toISOString() });
    } catch (error) {
      const j = this.getJob(id);
      const running = j.steps.find((s) => s.status === 'running');
      this.fail(id, running?.id ?? 'bundle', 'internal', (error as Error).message.slice(0, 400), 'Xem log của job; nếu lỗi lặp lại hãy cài Figma thủ công và chỉ chuẩn bị plugin.');
    }
  }

  private async download(id: string, state: { abort: AbortController; cancelled: boolean }): Promise<boolean> {
    this.step(id, 'download', { status: 'running' });
    const file = this.downloadFile;
    if (existsSync(file) && (await this.deps.sha256(file).catch(() => '')) === FIGMA_CATALOG.sha256) { this.step(id, 'download', { status: 'skipped', detail: 'Installer đã tải trước đó và đúng SHA-256.' }); return true; }
    rmSync(file, { force: true });
    try { await this.deps.download(FIGMA_CATALOG.url, `${file}.part`, state.abort.signal); }
    catch (error) {
      rmSync(`${file}.part`, { force: true });
      if (state.cancelled) { this.step(id, 'download', { status: 'failed', detail: 'Đã hủy khi đang tải.' }); this.o.store.installJobs.put({ ...this.getJob(id), status: 'failed', error: { code: 'cancelled', message: 'Đã hủy khi đang tải; chưa cài gì.' }, endedAt: new Date(this.deps.now()).toISOString() }); return false; }
      this.fail(id, 'download', 'download_failed', (error as Error).message.slice(0, 300), 'Kiểm tra mạng rồi thử lại, hoặc cài Figma thủ công từ trang chính thức.');
      return false;
    }
    const { renameSync } = await import('node:fs');
    renameSync(`${file}.part`, file);
    this.step(id, 'download', { status: 'done', detail: `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB` });
    return true;
  }

  private async verify(id: string): Promise<boolean> {
    this.step(id, 'verify', { status: 'running' });
    const file = this.downloadFile;
    const sha = await this.deps.sha256(file);
    if (sha !== FIGMA_CATALOG.sha256) { rmSync(file, { force: true }); this.fail(id, 'verify', 'checksum_mismatch', `SHA-256 của installer (${sha.slice(0, 12)}…) khác với catalog đã khóa; file đã bị xóa.`, 'Không cài. Thử tải lại; nếu vẫn lệch hãy báo để cập nhật catalog.'); return false; }
    const sig = await this.deps.signature(file);
    if (!sig.valid || !(sig.subject ?? '').includes(FIGMA_CATALOG.signerContains)) { rmSync(file, { force: true }); this.fail(id, 'verify', 'signature_invalid', `Chữ ký Authenticode không hợp lệ${sig.reason ? ` (${sig.reason})` : sig.subject ? ` (người ký: ${sig.subject})` : ''}; file đã bị xóa.`, 'Không cài file này.'); return false; }
    this.step(id, 'verify', { status: 'done', detail: `SHA-256 khớp catalog; chữ ký hợp lệ (${sig.subject}).` });
    return true;
  }

  private async install(id: string, state: { cancelled: boolean }): Promise<boolean> {
    this.step(id, 'install', { status: 'running' });
    // The installer runs as the current user, silently, with no elevation and no shell: nothing here can ask for admin.
    const result = await this.deps.run(this.downloadFile, [...FIGMA_CATALOG.silentArgs], INSTALL_TIMEOUT_MS);
    this.note(id, `Installer thoát ${result.timedOut ? '(quá thời gian)' : `mã ${result.exitCode}`}.${result.output.trim() ? ` ${result.output.trim().slice(-300)}` : ''}`);
    if (result.timedOut) { this.step(id, 'install', { status: 'failed', detail: 'Installer chạy quá 10 phút; sẽ đối chiếu xem ứng dụng đã có chưa.' }); return true; }
    if (result.exitCode !== 0 && !state.cancelled) { this.fail(id, 'install', 'installer_failed', `Installer thoát với mã ${result.exitCode}.`, 'Chính sách của máy có thể chặn cài đặt không cần admin. Department không né chính sách; cài Figma thủ công nếu được phép.'); return false; }
    this.step(id, 'install', { status: 'done', detail: `Installer thoát mã ${result.exitCode}.` });
    return true;
  }

  /** The importable folder for this instance's origin. Builds the template first when there is none (a source checkout). */
  async prepareBundle(): Promise<ReturnType<typeof prepareBundle>> {
    const template = process.env.AIDEPT_EXPORTER_TEMPLATE ?? TEMPLATE_DIR;
    if (!existsSync(path.join(template, 'code.js'))) {
      if (process.env.AIDEPT_EXPORTER_TEMPLATE) throw new HttpError(500, `Không thấy bộ plugin ở ${template}.`);
      try { await buildExporter({ outDir: template }); } catch (error) { throw new HttpError(500, `Chưa có bộ plugin đã build và không build được: ${(error as Error).message.slice(0, 200)}. Chạy "pnpm build" rồi thử lại.`); }
    }
    return prepareBundle({ templateDir: template, outDir: this.bundleDir, origin: this.o.origin });
  }

  async openDesktop(): Promise<{ executable: string }> {
    const state = await this.desktopState();
    if (state.state !== 'installed' || !state.executable) throw new HttpError(409, state.state === 'unverified' ? 'Không xác minh được file chạy Figma nên không mở.' : 'Chưa cài Figma Desktop. Bấm “Cài Figma Desktop & Exporter”.');
    this.deps.launch(state.executable);
    return { executable: state.executable };
  }

  openPluginFolder(): { dir: string } {
    const state = this.bundleState();
    if (state.state === 'missing' || !state.dir) throw new HttpError(409, 'Chưa chuẩn bị plugin Exporter.');
    this.deps.openFolder(state.dir);
    return { dir: state.dir };
  }
}
