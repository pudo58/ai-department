import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIGMA_CATALOG, FigmaInstaller, launchCommand, type Found, type InstallerDeps } from '../src/server/figma/installer.js';
import { Store } from '../src/server/store.js';
import { template, waitFor } from './figma/harness.js';

const dirs: string[] = [];
beforeAll(async () => { process.env.AIDEPT_EXPORTER_TEMPLATE = await template(); });
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const ORIGIN = 'http://127.0.0.1:4310';
const exe = 'C:\\Users\\u\\AppData\\Local\\Figma\\Figma.exe';

/** Every touch on the outside world is a fake that writes down what it was asked: no installer is ever downloaded or run here. */
function fixture(over: { found?: Found; platform?: { os: NodeJS.Platform; arch: string }; sha?: string; signature?: { valid: boolean; subject?: string; reason?: string }; exit?: number | null; timedOut?: boolean; appearsAfterInstall?: Found; gate?: Promise<void>; downloadFails?: string; cached?: boolean; origin?: string; dir?: string } = {}) {
  const dataDir = over.dir ?? mkdtempSync(path.join(tmpdir(), 'aidept-install-'));
  if (!over.dir) dirs.push(dataDir);
  const store = new Store(':memory:');
  const calls: string[] = [];
  const state = { found: over.found, running: false };
  const deps: InstallerDeps = {
    platform: over.platform ?? { os: 'win32', arch: 'x64' }, env: {}, now: () => Date.now(),
    find: async () => state.found,
    isRunning: async () => state.running,
    download: async (url, dest, signal) => { calls.push(`download ${url}`); if (over.downloadFails) throw new Error(over.downloadFails); await new Promise<void>((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); if (!over.gate) resolve(); else void over.gate.then(resolve); }); mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, 'MZ-fake-installer'); },
    sha256: async () => (over.sha ?? FIGMA_CATALOG.sha256),
    signature: async (file) => { calls.push(`signature ${path.basename(file)}`); return over.signature ?? { valid: true, subject: 'CN=Figma, Inc.' }; },
    run: async (file, args, timeoutMs) => { calls.push(`run ${path.basename(file)} ${args.join(' ')} timeout=${timeoutMs}`); if (over.appearsAfterInstall) state.found = over.appearsAfterInstall; return { exitCode: over.exit ?? 0, timedOut: over.timedOut ?? false, output: '' }; },
    launch: (file) => { calls.push(`launch ${file}`); },
    openFolder: (dir) => { calls.push(`folder ${dir}`); },
  };
  if (over.cached) { const f = path.join(dataDir, 'integrations', 'figma', 'downloads', `Figma-${FIGMA_CATALOG.version}.exe`); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, 'MZ-fake-installer'); }
  const installer = new FigmaInstaller({ dataDir, store, origin: over.origin ?? ORIGIN, deps });
  return { installer, store, calls, state, dataDir, deps };
}
const settled = async (installer: FigmaInstaller, id: string) => waitFor(() => { const j = installer.getJob(id); return j.status !== 'running' ? j : undefined; }, 10_000, 'job cài xong');
const step = (job: { steps: { id: string; status: string }[] }, id: string) => job.steps.find((s) => s.id === id)!.status;

describe('the installer Department offers is pinned, and runs as the current user', () => {
  it('names an official https installer with a lowercase SHA-256 and only the silent flag', () => {
    expect(FIGMA_CATALOG.url).toMatch(/^https:\/\/desktop\.figma\.com\/win\/build\/Figma-126\.9\.16\.exe$/);
    expect(FIGMA_CATALOG.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(FIGMA_CATALOG.silentArgs).toEqual(['--silent']);
    expect(FIGMA_CATALOG).toMatchObject({ platform: 'win32', arch: 'x64', version: '126.9.16' });
  });
});

describe('how Figma Desktop is started', () => {
  it('is handed to the shell like a Start-menu launch, never run as a child of the server, with only the executable as argument', () => {
    expect(launchCommand(exe, 'win32')).toEqual({ cmd: 'explorer.exe', args: [exe] });
    expect(launchCommand('/Applications/Figma.app', 'darwin')).toEqual({ cmd: 'open', args: ['/Applications/Figma.app'] });
    expect(launchCommand('/opt/figma', 'linux')).toEqual({ cmd: '/opt/figma', args: [] });
  });
});

describe('installing Figma Desktop', () => {
  it('keeps the Figma that is there, does not download or run anything, and still prepares the plugin', async () => {
    const t = fixture({ found: { executable: exe, version: '130.0.1', signed: true } });
    const job = await settled(t.installer, t.installer.start().id);
    expect(job.status).toBe('completed');
    expect(['download', 'verify', 'install'].map((s) => step(job, s))).toEqual(['skipped', 'skipped', 'skipped']);
    expect(job.steps.find((s) => s.id === 'detect')!.detail).toContain('không hạ phiên bản');
    expect(t.calls).toEqual([]);
    expect(t.installer.bundleState().state).toBe('prepared');
    expect(await t.installer.desktopState()).toMatchObject({ state: 'installed', version: '130.0.1' });
  });

  it('downloads, checks the SHA-256 and the signature, runs the installer silently with no elevation, and confirms what it installed', async () => {
    const t = fixture({ appearsAfterInstall: { executable: exe, version: '126.9.16', signed: true } });
    const job = await settled(t.installer, t.installer.start().id);
    expect(job.status, JSON.stringify(job.error)).toBe('completed');
    expect(job.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(t.calls[0]).toBe(`download ${FIGMA_CATALOG.url}`);
    expect(t.calls[1]).toBe('signature Figma-126.9.16.exe');
    // The only command run is the installer itself, with exactly the silent flag, under the 10-minute limit.
    const runs = t.calls.filter((c) => c.startsWith('run '));
    expect(runs).toEqual(['run Figma-126.9.16.exe --silent timeout=600000']);
    expect(t.calls.join('\n')).not.toMatch(/runas|admin|powershell|cmd|msiexec|-Verb/i);
    expect(await t.installer.desktopState()).toMatchObject({ state: 'installed', version: '126.9.16' });
    expect(existsSync(path.join(t.dataDir, 'integrations', 'figma', 'exporter', 'manifest.json'))).toBe(true);
  });

  it('shows "installing" while the installer runs, not before and not after', async () => {
    let release!: () => void;
    const t = fixture({ appearsAfterInstall: { executable: exe, version: '126.9.16', signed: true } });
    const originalRun = t.deps.run;
    let started = false;
    t.deps.run = async (...a) => { started = true; await new Promise<void>((resolve) => { release = resolve; }); return originalRun(...a); };
    const id = t.installer.start().id;
    await waitFor(() => started, 5000, 'installer chạy');
    expect((await t.installer.desktopState()).state).toBe('installing');
    release();
    await settled(t.installer, id);
    expect((await t.installer.desktopState()).state).toBe('installed');
  });

  it('refuses a download whose SHA-256 is not the catalog\'s, deletes it, and never runs it', async () => {
    const t = fixture({ sha: 'f'.repeat(64) });
    const job = await settled(t.installer, t.installer.start().id);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'checksum_mismatch' } });
    expect(t.calls.some((c) => c.startsWith('run '))).toBe(false);
    expect(existsSync(path.join(t.dataDir, 'integrations', 'figma', 'downloads', `Figma-${FIGMA_CATALOG.version}.exe`))).toBe(false);
  });

  it.each([
    [{ valid: false, reason: 'Trạng thái chữ ký: NotSigned' }, 'signature_invalid'],
    [{ valid: true, subject: 'CN=Someone Else' }, 'signature_invalid'],
  ])('refuses an installer whose signature is %j, deletes it, and never runs it', async (signature, code) => {
    const t = fixture({ signature });
    const job = await settled(t.installer, t.installer.start().id);
    expect(job).toMatchObject({ status: 'failed', error: { code } });
    expect(t.calls.some((c) => c.startsWith('run '))).toBe(false);
  });

  it('reports a policy block with its reason and does not try again or ask for admin', async () => {
    const t = fixture({ exit: 1 });
    const job = await settled(t.installer, t.installer.start().id);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'installer_failed' } });
    expect(job.error!.hint).toContain('không né chính sách');
    expect(t.calls.filter((c) => c.startsWith('run '))).toHaveLength(1);
  });

  it('after a timeout looks at what is really installed: success if the app is there, a clear failure if not', async () => {
    const there = fixture({ timedOut: true, appearsAfterInstall: { executable: exe, version: '126.9.16', signed: true } });
    const ok = await settled(there.installer, there.installer.start().id);
    expect(ok.status).toBe('completed');
    expect(step(ok, 'install')).toBe('failed');
    const missing = fixture({ timedOut: true });
    const bad = await settled(missing.installer, missing.installer.start().id);
    expect(bad).toMatchObject({ status: 'failed', error: { code: 'not_found_after_install' } });
  });

  it('stops on a Figma it cannot verify rather than opening it, and tells the person what to do', async () => {
    const t = fixture({ found: { executable: exe, version: '1', signed: false } });
    const job = await settled(t.installer, t.installer.start().id);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'unverified_executable' } });
    expect(await t.installer.desktopState()).toMatchObject({ state: 'unverified', signed: false });
    await expect(t.installer.openDesktop()).rejects.toThrow(/xác minh/);
    expect(t.calls.some((c) => c.startsWith('launch'))).toBe(false);
  });

  it('says plainly that automatic install is Windows x64 only, yet still prepares the plugin when Figma is already there', async () => {
    const none = fixture({ platform: { os: 'darwin', arch: 'arm64' } });
    const job = await settled(none.installer, none.installer.start().id);
    expect(job).toMatchObject({ status: 'failed', error: { code: 'unsupported_platform' } });
    expect(none.installer.platformSupport()).toMatchObject({ supported: false });
    expect(none.calls).toEqual([]);
    const has = fixture({ platform: { os: 'darwin', arch: 'arm64' }, found: { executable: '/Applications/Figma.app', signed: true } });
    expect((await settled(has.installer, has.installer.start().id)).status).toBe('completed');
  });

  it('reuses an installer it already downloaded when the SHA-256 still matches', async () => {
    const t = fixture({ cached: true, appearsAfterInstall: { executable: exe, version: '126.9.16', signed: true } });
    const job = await settled(t.installer, t.installer.start().id);
    expect(job.status).toBe('completed');
    expect(step(job, 'download')).toBe('skipped');
    expect(t.calls.some((c) => c.startsWith('download'))).toBe(false);
  });

  it('cancelling during the download removes the partial file and installs nothing', async () => {
    let release!: () => void;
    const t = fixture({ gate: new Promise<void>((resolve) => { release = resolve; }) });
    const id = t.installer.start().id;
    await waitFor(() => t.calls.some((c) => c.startsWith('download')), 5000, 'đang tải');
    t.installer.cancel(id);
    const job = await settled(t.installer, id);
    release();
    expect(job).toMatchObject({ status: 'failed', error: { code: 'cancelled' } });
    expect(t.calls.some((c) => c.startsWith('run '))).toBe(false);
    expect(existsSync(path.join(t.dataDir, 'integrations', 'figma', 'downloads', `Figma-${FIGMA_CATALOG.version}.exe.part`))).toBe(false);
  });

  it('runs one job at a time, and a restart turns a job nothing is running into an interrupted one', async () => {
    let release!: () => void;
    const t = fixture({ gate: new Promise<void>((resolve) => { release = resolve; }) });
    const first = t.installer.start();
    expect(() => t.installer.start()).toThrow(/đang có một job/i);
    release();
    await settled(t.installer, first.id);
    t.store.installJobs.put({ ...t.installer.getJob(first.id), id: 'ins_0000000000', status: 'running', steps: t.installer.getJob(first.id).steps.map((s) => ({ ...s, status: s.id === 'install' ? 'running' as const : s.status })) });
    expect(t.installer.recover()).toBe(1);
    expect(t.installer.getJob('ins_0000000000')).toMatchObject({ status: 'interrupted' });
    expect(step(t.installer.getJob('ins_0000000000'), 'install')).toBe('failed');
  });
});

describe('the plugin folder', () => {
  it('is prepared for this instance, stale after a port change, hurt by an edit, and fine again once prepared anew', async () => {
    const t = fixture({ found: { executable: exe, version: '1', signed: true } });
    expect(t.installer.bundleState().state).toBe('missing');
    await t.installer.prepareBundle();
    expect(t.installer.bundleState()).toMatchObject({ state: 'prepared', origin: ORIGIN });
    const manifest = JSON.parse(readFileSync(path.join(t.installer.bundleDir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ editorType: ['figma'], documentAccess: 'dynamic-page', networkAccess: { allowedDomains: ['none'], devAllowedDomains: [ORIGIN] } });
    expect(manifest.id).toBeUndefined();
    const other = new FigmaInstaller({ dataDir: t.dataDir, store: t.store, origin: 'http://127.0.0.1:4999', deps: t.deps });
    expect(other.bundleState().state).toBe('stale');
    expect(other.bundleState().note).toContain('4999');
    writeFileSync(path.join(t.installer.bundleDir, 'code.js'), 'alert(1)');
    expect(t.installer.bundleState().state).toBe('incompatible');
    await t.installer.prepareBundle();
    expect(t.installer.bundleState().state).toBe('prepared');
    const info = JSON.parse(readFileSync(path.join(t.installer.bundleDir, 'bundle-manifest.json'), 'utf8'));
    writeFileSync(path.join(t.installer.bundleDir, 'bundle-manifest.json'), JSON.stringify({ ...info, protocolVersion: 99 }));
    expect(t.installer.bundleState().state).toBe('incompatible');
  });

  it('never lets the UI reach an origin other than this instance on loopback', async () => {
    const { prepareBundle } = await import('../plugins/figma-exporter/build.mjs');
    for (const bad of ['https://evil.example', 'http://0.0.0.0:4310', 'http://127.0.0.1', 'http://127.0.0.1:4310/x', '*']) {
      expect(() => prepareBundle({ templateDir: process.env.AIDEPT_EXPORTER_TEMPLATE, outDir: path.join(tmpdir(), 'aidept-never'), origin: bad }), bad).toThrow(/Origin/);
    }
    const out = mkdtempSync(path.join(tmpdir(), 'aidept-bundle-')); dirs.push(out);
    const info = prepareBundle({ templateDir: process.env.AIDEPT_EXPORTER_TEMPLATE, outDir: out, origin: ORIGIN });
    const ui = readFileSync(path.join(out, 'ui.html'), 'utf8');
    expect(ui).toContain(`"origin":"${ORIGIN}"`);
    expect(ui).toContain(info.bundleHash);
    expect(ui).not.toContain('__AIDEPT_CONFIG__');
    expect(readFileSync(path.join(out, 'code.js'), 'utf8')).not.toMatch(/\brequire\(|\bimport\s*\(/);
  });

  it('opens only the detected, verified executable and only this instance\'s plugin folder, with no arguments from anyone', async () => {
    const t = fixture({ found: { executable: exe, version: '1', signed: true } });
    expect(() => t.installer.openPluginFolder()).toThrow(/Chưa chuẩn bị/);
    await t.installer.prepareBundle();
    expect(await t.installer.openDesktop()).toEqual({ executable: exe });
    expect(t.installer.openPluginFolder()).toEqual({ dir: t.installer.bundleDir });
    expect(t.calls.filter((c) => c.startsWith('launch') || c.startsWith('folder'))).toEqual([`launch ${exe}`, `folder ${t.installer.bundleDir}`]);
    const none = fixture();
    await expect(none.installer.openDesktop()).rejects.toThrow(/Chưa cài/);
  });
});
