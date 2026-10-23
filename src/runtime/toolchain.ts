import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { jdkToInstall, javaMajor, type EnvNeeds } from '../core/envplan.js';
import { executeFile, type ProcessResult } from './process.js';

/**
 * Installs the build tools a project needs (JDK, Maven, Gradle) into a private folder under the data dir, so a task
 * on a repository that expects them just works without the person installing anything or any system setting changing.
 * Every download comes over HTTPS from the tool's own distributor and is checked against the checksum that
 * distributor publishes; a file that does not match is deleted and never extracted.
 */

export const MAVEN_VERSION = '3.9.9';
export const GRADLE_VERSION = '8.10.2';
const MAX_DOWNLOAD_BYTES = 700 * 1024 * 1024;
const MARKER = '.aidept-installed';

export interface Endpoints { adoptium: string; maven: string; gradle: string }
export const DEFAULT_ENDPOINTS: Endpoints = {
  adoptium: 'https://api.adoptium.net',
  maven: 'https://archive.apache.org/dist/maven/maven-3',
  gradle: 'https://services.gradle.org/distributions',
};

export type ToolLog = (message: string, level?: 'info' | 'warn') => void;
type Run = (exe: string, args: string[], timeoutMs?: number) => Promise<ProcessResult>;

export interface ToolchainOptions {
  dataDir: string;
  endpoints?: Endpoints;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Runs a host command; tests replace it. */
  run?: Run;
  /** Where `mvn`/`gradle` are looked for; this process's PATH by default. */
  pathVar?: string;
}

export interface ToolHomes { javaHome?: string; mavenHome?: string; gradleHome?: string }

const mb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Only HTTPS, except loopback so a test can serve a fake distributor. */
function assertDownloadUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'))) throw new Error(`Chỉ tải qua HTTPS, không tải từ ${u.protocol}//${u.host}.`);
}

export class Toolchains {
  private readonly endpoints: Endpoints;
  private readonly fetchFn: typeof fetch;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly run: Run;
  private readonly inflight = new Map<string, Promise<string>>();
  constructor(private readonly options: ToolchainOptions) {
    this.endpoints = options.endpoints ?? DEFAULT_ENDPOINTS;
    this.fetchFn = options.fetchImpl ?? fetch;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.run = options.run ?? ((exe, args, timeoutMs = 30_000) => executeFile(exe, args, { timeoutMs }));
  }

  get root(): string { return path.join(this.options.dataDir, 'tools'); }

  private bin(home: string, name: string): string { return path.join(home, 'bin', this.platform === 'win32' ? `${name}.${name === 'java' || name === 'javac' ? 'exe' : 'cmd'}` : name); }

  /** The folder to use as JAVA_HOME for an installed JDK (macOS archives nest it under Contents/Home). */
  private jdkHome(dir: string): string { return existsSync(path.join(dir, 'Contents', 'Home', 'bin')) ? path.join(dir, 'Contents', 'Home') : dir; }

  /** Major version of the `javac` this machine would use for a build, or undefined when there is none. */
  async systemJavac(): Promise<number | undefined> {
    const home = process.env.JAVA_HOME;
    const exe = home ? this.bin(home, 'javac') : 'javac';
    try {
      const r = await this.run(exe, ['-version']);
      return r.exitCode === 0 ? javaMajor(/javac\s+([\d._]+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1]) : undefined;
    } catch { return undefined; }
  }

  /** True when `name` (mvn, gradle) can be found on PATH. */
  onPath(name: string, pathVar = this.options.pathVar ?? process.env.PATH ?? process.env.Path ?? ''): boolean {
    const exts = this.platform === 'win32' ? ['.cmd', '.bat', '.exe'] : [''];
    return pathVar.split(path.delimiter).filter(Boolean).some((dir) => exts.some((ext) => existsSync(path.join(dir, `${name}${ext}`))));
  }

  /**
   * Makes sure the tools `needs` asks for exist, installing what is missing, and returns where they live. Safe to call
   * for every task: anything already installed (or already usable on this machine) is left alone and costs a few ms.
   */
  async provide(needs: EnvNeeds, log?: ToolLog): Promise<ToolHomes> {
    const homes: ToolHomes = {};
    if (needs.java) {
      const have = await this.systemJavac();
      if (have === undefined || have < (needs.jdkRequired ?? 8)) {
        const wanted = jdkToInstall(needs.jdkRequired);
        log?.(have === undefined ? `Máy chưa có JDK; dùng JDK ${wanted} tự cài của AI Department.` : `JDK trên máy là ${have}, project cần ${needs.jdkRequired}; dùng JDK ${wanted} tự cài của AI Department.`);
        homes.javaHome = await this.ensureJdk(wanted, log);
      }
    }
    if (needs.maven && !this.onPath('mvn')) homes.mavenHome = await this.ensureMaven(log);
    if (needs.gradle && !this.onPath('gradle')) homes.gradleHome = await this.ensureGradle(log);
    return homes;
  }

  /** Environment additions that put the installed tools (and the workspace's Python venv, if any) first on PATH. */
  env(cwd: string, homes: ToolHomes = {}): Record<string, string> {
    const front: string[] = [];
    const env: Record<string, string> = {};
    const venv = path.join(cwd, '.venv');
    if (existsSync(venv)) { front.push(path.join(venv, this.platform === 'win32' ? 'Scripts' : 'bin')); env.VIRTUAL_ENV = venv; }
    if (homes.javaHome) { front.push(path.join(homes.javaHome, 'bin')); env.JAVA_HOME = homes.javaHome; }
    if (homes.mavenHome) front.push(path.join(homes.mavenHome, 'bin'));
    if (homes.gradleHome) front.push(path.join(homes.gradleHome, 'bin'));
    if (front.length) {
      // On Windows the variable is usually spelled "Path"; setting "PATH" next to it would leave the child with two.
      const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      env[key] = [...front, process.env[key] ?? ''].filter(Boolean).join(path.delimiter);
    }
    return env;
  }

  // --- installers ---------------------------------------------------------------------------------------------------

  ensureJdk(major: number, log?: ToolLog): Promise<string> {
    return this.once(`jdk-${major}`, async () => {
      const dir = path.join(this.root, `jdk-${major}`);
      if (existsSync(path.join(dir, MARKER))) return this.jdkHome(dir);
      const os = this.platform === 'win32' ? 'windows' : this.platform === 'darwin' ? 'mac' : 'linux';
      const arch = this.arch === 'arm64' ? 'aarch64' : 'x64';
      const meta = `${this.endpoints.adoptium}/v3/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jdk&os=${os}`;
      assertDownloadUrl(meta);
      const res = await this.fetchFn(meta);
      if (!res.ok) throw new Error(`Không lấy được thông tin JDK ${major} (${res.status}).`);
      const assets = await res.json() as { binary?: { package?: { link?: string; name?: string; checksum?: string; size?: number } } }[];
      const pkg = assets.map((a) => a.binary?.package).find((p) => p?.link && p.name && p.checksum && /\.(zip|tar\.gz)$/.test(p.name));
      if (!pkg) throw new Error(`Không có bản JDK ${major} cho ${os}/${arch}.`);
      log?.(`Tải JDK ${major} (Eclipse Temurin, ${pkg.size ? mb(pkg.size) : 'vài trăm MB'})…`);
      await this.install(`jdk-${major}`, dir, pkg.link!, pkg.name!, { algo: 'sha256', hex: pkg.checksum! }, log);
      return this.jdkHome(dir);
    });
  }

  ensureMaven(log?: ToolLog): Promise<string> {
    return this.once('maven', async () => {
      const dir = path.join(this.root, `maven-${MAVEN_VERSION}`);
      if (existsSync(path.join(dir, MARKER))) return dir;
      const name = this.platform === 'win32' ? `apache-maven-${MAVEN_VERSION}-bin.zip` : `apache-maven-${MAVEN_VERSION}-bin.tar.gz`;
      const link = `${this.endpoints.maven}/${MAVEN_VERSION}/binaries/${name}`;
      log?.(`Tải Apache Maven ${MAVEN_VERSION} (~9 MB)…`);
      await this.install('maven', dir, link, name, { algo: 'sha512', hex: await this.publishedChecksum(`${link}.sha512`) }, log);
      return dir;
    });
  }

  ensureGradle(log?: ToolLog): Promise<string> {
    return this.once('gradle', async () => {
      const dir = path.join(this.root, `gradle-${GRADLE_VERSION}`);
      if (existsSync(path.join(dir, MARKER))) return dir;
      const name = `gradle-${GRADLE_VERSION}-bin.zip`;
      const link = `${this.endpoints.gradle}/${name}`;
      log?.(`Tải Gradle ${GRADLE_VERSION} (~130 MB)…`);
      await this.install('gradle', dir, link, name, { algo: 'sha256', hex: await this.publishedChecksum(`${link}.sha256`) }, log);
      return dir;
    });
  }

  /** The hex digest in a `.sha256`/`.sha512` file (which may also carry a file name). */
  private async publishedChecksum(url: string): Promise<string> {
    assertDownloadUrl(url);
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`Không lấy được checksum (${res.status}) từ ${new URL(url).host}.`);
    const hex = (await res.text()).trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{64,128}$/i.test(hex)) throw new Error('Checksum công bố không hợp lệ.');
    return hex;
  }

  /** Two tasks asking for the same tool at once share one download. */
  private once(key: string, fn: () => Promise<string>): Promise<string> {
    let p = this.inflight.get(key);
    if (!p) { p = fn().finally(() => this.inflight.delete(key)); this.inflight.set(key, p); }
    return p;
  }

  private async install(key: string, finalDir: string, url: string, fileName: string, expected: { algo: 'sha256' | 'sha512'; hex: string }, log?: ToolLog): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const tmp = path.join(this.root, `.tmp-${key}-${process.pid}-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    try {
      const archive = path.join(tmp, path.basename(fileName));
      await this.download(url, archive, expected, log);
      log?.('Giải nén…');
      const out = path.join(tmp, 'out');
      await mkdir(out);
      await this.extract(archive, out);
      const entries = await readdir(out);
      // Every one of these distributions has a single top-level folder.
      const top = entries.length === 1 ? path.join(out, entries[0]!) : out;
      await rm(finalDir, { recursive: true, force: true });
      await rename(top, finalDir);
      await writeFile(path.join(finalDir, MARKER), new Date().toISOString());
      log?.(`Đã cài ${key} vào ${finalDir}`);
    } finally { await rm(tmp, { recursive: true, force: true }).catch(() => undefined); }
  }

  private async download(url: string, dest: string, expected: { algo: 'sha256' | 'sha512'; hex: string }, log?: ToolLog): Promise<void> {
    assertDownloadUrl(url);
    const res = await this.fetchFn(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Tải thất bại (${res.status}) từ ${new URL(url).host}.`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error(`File quá lớn (${mb(total)}); không tải.`);
    const hash = createHash(expected.algo);
    let received = 0, nextReport = 0.25;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) return cb(new Error('File tải về lớn hơn giới hạn; dừng.'));
        hash.update(chunk);
        if (total && received / total >= nextReport) { log?.(`Đã tải ${Math.round((received / total) * 100)}% (${mb(received)} / ${mb(total)})`); nextReport += 0.25; }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as never), meter, createWriteStream(dest));
    if (hash.digest('hex').toLowerCase() !== expected.hex.toLowerCase()) {
      await rm(dest, { force: true });
      throw new Error(`Checksum ${expected.algo} của file tải về không khớp với checksum nhà phát hành công bố; đã xóa, không cài.`);
    }
  }

  /** Git for Windows puts a GNU tar first on PATH that reads a drive letter as a remote host; Windows' own bsdtar does not, and also reads zip. */
  private tarExecutable(): string {
    if (this.platform !== 'win32') return 'tar';
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    return existsSync(system) ? system : 'tar';
  }

  private async extract(archive: string, into: string): Promise<void> {
    let exe: string, args: string[];
    if (archive.endsWith('.zip')) {
      // bsdtar (Windows) reads zip; GNU tar elsewhere cannot, so unzip is used there.
      if (this.platform === 'win32') { exe = this.tarExecutable(); args = ['-xf', archive, '-C', into]; }
      else { exe = 'unzip'; args = ['-q', archive, '-d', into]; }
    } else { exe = this.tarExecutable(); args = ['-xzf', archive, '-C', into]; }
    const r = await this.run(exe, args, 10 * 60_000);
    if (r.exitCode !== 0) throw new Error(`Giải nén thất bại (${exe}, mã ${r.exitCode}): ${r.stderr.slice(0, 300)}`);
  }
}
