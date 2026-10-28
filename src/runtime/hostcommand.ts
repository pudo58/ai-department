import { existsSync } from 'node:fs';
import path from 'node:path';

export interface HostEnv { platform: NodeJS.Platform; nodeExec: string; exists: (p: string) => boolean; searchPath?: string; npmExecPath?: string }
const defaultEnv = (): HostEnv => ({ platform: process.platform, nodeExec: process.execPath, exists: existsSync, searchPath: process.env.PATH, npmExecPath: process.env.npm_execpath });

/** A private Node installed from npm has no npm of its own. Locate the CLI without executing a .cmd shell. */
function windowsNpmScript(base: 'npm' | 'npx', command: string, env: HostEnv): string | undefined {
  const fromBin = (dir: string) => path.win32.join(dir, 'node_modules', 'npm', 'bin', `${base}-cli.js`);
  // An explicitly selected npm must never silently become a different installation from PATH.
  if (path.win32.isAbsolute(command)) {
    const script = fromBin(path.win32.dirname(command));
    return env.exists(script) ? script : undefined;
  }
  const candidates = [fromBin(path.win32.dirname(env.nodeExec))];
  if (env.npmExecPath && path.win32.isAbsolute(env.npmExecPath) && /^npm-cli\.js$/i.test(path.win32.basename(env.npmExecPath))) {
    candidates.push(path.win32.join(path.win32.dirname(env.npmExecPath), `${base}-cli.js`));
  }
  for (const entry of (env.searchPath ?? '').split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    // Ignore relative PATH entries: repository files must not supply the harness's package manager.
    if (path.win32.isAbsolute(dir)) candidates.push(fromBin(dir));
  }
  return [...new Set(candidates)].find(env.exists);
}

const BUILD_TOOLS = new Set(['mvn', 'mvnw', 'gradle', 'gradlew']);
const SAFE_CMD_ARG = /^[A-Za-z0-9_.,:=/\\@#+*\-]+$/;

/**
 * Commands run without a shell, and on Windows `npm`/`npx` are .cmd shims that cannot be spawned that way.
 * They are mapped to this Node + npm CLI scripts from its installation, the launcher or PATH; other shims fail with a clear message
 * instead of an opaque EINVAL.
 */
export function resolveHostCommand(argv: readonly string[], env: HostEnv = defaultEnv()): string[] {
  const [cmd, ...rest] = argv;
  if (!cmd) throw new Error('Lệnh rỗng.');
  if (env.platform !== 'win32') return [...argv];
  const base = path.win32.basename(cmd).toLowerCase().replace(/\.(cmd|bat|exe)$/, '');
  if (base === 'npm' || base === 'npx') {
    const script = windowsNpmScript(base, cmd, env);
    if (!script) throw new Error(`Không tìm thấy ${base} CLI trong bản Node đang chạy hoặc PATH. Cài Node.js kèm npm, mở lại AI Department rồi bấm Chạy tiếp.`);
    return [env.nodeExec, script, ...rest];
  }
  if (BUILD_TOOLS.has(base)) {
    // Maven and Gradle ship as .cmd/.bat on Windows, which need a shell. cmd.exe is used only for these, and only when
    // no argument contains a character cmd treats specially, so a project's check line can never smuggle in a second command.
    const unsafe = [cmd, ...rest].find((arg) => !SAFE_CMD_ARG.test(arg));
    if (unsafe !== undefined) throw new Error(`Đối số "${unsafe}" có ký tự mà cmd.exe hiểu đặc biệt; không chạy "${cmd}" với nó trên Windows. Bỏ khoảng trắng, dấu nháy và & | < > ^ %.`);
    return ['cmd.exe', '/d', '/s', '/c', cmd, ...rest];
  }
  if (/\.(cmd|bat)$/i.test(cmd) ||['pnpm', 'yarn', 'corepack', 'tsx', 'vitest'].includes(base)) {
    throw new Error(`Windows không chạy trực tiếp "${cmd}" (file .cmd). Dùng ["npx", "${base}", ...] hoặc ["node", "đường/dẫn/script.js", ...].`);
  }
  return [...argv];
}

/** Finds the Codex CLI entry: explicit env var, then the copy installed under .tools/codex, then PATH (non-Windows). */
export function resolveCodexCommand(cwd = process.cwd(), env: HostEnv = defaultEnv(), override = process.env.AIDEPT_CODEX_ENTRY): string[] {
  const candidates = [override, path.join(cwd, '.tools', 'codex', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')].filter((p): p is string => !!p);
  const entry = candidates.find((p) => env.exists(p));
  if (entry) return [env.nodeExec, entry];
  if (env.platform !== 'win32') return ['codex'];
  throw new Error('Không tìm thấy Codex CLI. Chạy: npm install --prefix .tools/codex @openai/codex (hoặc đặt AIDEPT_CODEX_ENTRY tới codex.js).');
}
