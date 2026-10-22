import { existsSync } from 'node:fs';
import path from 'node:path';

export interface HostEnv { platform: NodeJS.Platform; nodeExec: string; exists: (p: string) => boolean }
const defaultEnv = (): HostEnv => ({ platform: process.platform, nodeExec: process.execPath, exists: existsSync });

/**
 * Commands run without a shell, and on Windows `npm`/`npx` are .cmd shims that cannot be spawned that way.
 * They are mapped to node + the npm CLI scripts that ship beside node; other shims fail with a clear message
 * instead of an opaque EINVAL.
 */
export function resolveHostCommand(argv: readonly string[], env: HostEnv = defaultEnv()): string[] {
  const [cmd, ...rest] = argv;
  if (!cmd) throw new Error('Lệnh rỗng.');
  if (env.platform !== 'win32') return [...argv];
  const base = path.win32.basename(cmd).toLowerCase().replace(/\.(cmd|bat|exe)$/, '');
  if (base === 'npm' || base === 'npx') {
    const script = path.win32.join(path.win32.dirname(env.nodeExec), 'node_modules', 'npm', 'bin', `${base}-cli.js`);
    if (!env.exists(script)) throw new Error(`Không tìm thấy ${script}; hãy dùng "node" với script cụ thể thay cho ${base}.`);
    return [env.nodeExec, script, ...rest];
  }
  if (/\.(cmd|bat)$/i.test(cmd) || ['pnpm', 'yarn', 'corepack', 'tsx', 'vitest'].includes(base)) {
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
