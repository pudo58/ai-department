import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInside } from '../core/stackdetect.js';
import { resolveHostCommand } from '../runtime/hostcommand.js';
import { redactSecrets, scrubbedEnv } from '../runtime/process.js';

export interface PreviewState { runId: string; url: string; port: number; command: string[]; startedAt: string; stopsAt: string; log: string }

/** Next to the source (src/server → tools), or in the packaged build the tools folder it names in AIDEPT_TOOLS_DIR. */
const STATIC_SERVER = [
  ...(process.env.AIDEPT_TOOLS_DIR ? [path.join(process.env.AIDEPT_TOOLS_DIR, 'preview', 'static-server.mjs')] : []),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/preview/static-server.mjs'),
].find((p) => existsSync(p)) ?? path.resolve('tools/preview/static-server.mjs');
const DEFAULT_LIFETIME_MS = 30 * 60_000;
const START_TIMEOUT_MS = 60_000;

/**
 * What to run to try a project by hand, guessed from its files (read-only): a dev/start script, a server file, or
 * the bundled static server for plain HTML. The project's own `previewCommand` always wins over the guess.
 */
export async function guessPreviewCommand(dir: string): Promise<string[] | undefined> {
  const pkgText = await readInside(path.resolve(dir), 'package.json');
  if (pkgText) {
    try {
      const scripts = (JSON.parse(pkgText) as { scripts?: Record<string, unknown> }).scripts ?? {};
      if (typeof scripts.dev === 'string') return ['npm', 'run', 'dev'];
      if (typeof scripts.start === 'string') return ['npm', 'start'];
    } catch { /* not JSON: fall through */ }
  }
  for (const f of ['server.mjs', 'server.js', 'index.mjs']) if (existsSync(path.join(dir, f))) return ['node', f];
  if (existsSync(path.join(dir, 'index.html'))) return ['node', STATIC_SERVER];
  return undefined;
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address() as { port: number }; srv.close(() => resolve(port)); });
});

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  else child.kill();
}

/**
 * Runs a task's result so a person can try it before accepting: the app starts in the run's working copy on a free
 * loopback port (PORT/HOST env), one preview per run, stopped automatically after 30 minutes, when the run is
 * resumed or accepted, or when the server shuts down. It executes the repository's own code, like a check does.
 */
export class PreviewManager {
  private readonly running = new Map<string, { child: ChildProcess; state: PreviewState; timer: NodeJS.Timeout }>();
  constructor(private readonly lifetimeMs = DEFAULT_LIFETIME_MS) {}

  get(runId: string): PreviewState | undefined {
    const entry = this.running.get(runId);
    return entry ? { ...entry.state } : undefined;
  }

  async start(runId: string, cwd: string, command: string[]): Promise<PreviewState> {
    this.stop(runId);
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const [cmd, ...args] = command[0] === 'node' ? [process.execPath, ...command.slice(1)] : resolveHostCommand(command);
    const child = spawn(cmd!, args, { cwd, env: { ...scrubbedEnv('all'), PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const now = Date.now();
    const state: PreviewState = { runId, url, port, command, startedAt: new Date(now).toISOString(), stopsAt: new Date(now + this.lifetimeMs).toISOString(), log: '' };
    const append = (d: Buffer) => { state.log = redactSecrets(`${state.log}${d.toString('utf8')}`).slice(-4000); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let exited: number | null | undefined;
    child.on('exit', (code) => { exited = code; this.running.delete(runId); });
    child.on('error', (error) => { exited = -1; state.log += `\n${error.message}`; });
    const timer = setTimeout(() => this.stop(runId), this.lifetimeMs);
    timer.unref();
    this.running.set(runId, { child, state, timer });

    const deadline = now + START_TIMEOUT_MS;
    for (;;) {
      if (exited !== undefined) { this.stop(runId); throw new Error(`App dừng ngay khi khởi động (mã ${exited}). Output:\n${state.log.slice(-1500) || '(trống)'}`); }
      try { const res = await fetch(url, { signal: AbortSignal.timeout(2000) }); await res.arrayBuffer(); break; } catch { /* not up yet */ }
      if (Date.now() > deadline) { this.stop(runId); throw new Error(`App không trả lời ở cổng ${port} sau ${START_TIMEOUT_MS / 1000} giây. Lệnh có đọc cổng từ biến PORT không? Output:\n${state.log.slice(-1500) || '(trống)'}`); }
      await new Promise((r) => setTimeout(r, 300));
    }
    return { ...state };
  }

  stop(runId: string): boolean {
    const entry = this.running.get(runId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    killTree(entry.child);
    this.running.delete(runId);
    return true;
  }

  list(): PreviewState[] { return [...this.running.values()].map((e) => ({ ...e.state })); }

  stopAll(): void { for (const id of [...this.running.keys()]) this.stop(id); }
}
