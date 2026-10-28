#!/usr/bin/env node
// Entry point of the packaged AI Department (the `ai-department` command and start.cmd / start.sh).
// It keeps the person's data outside the package, so updating or reinstalling never touches it:
// ~/.ai-department by default, or the folder in AIDEPT_HOME (the portable zip sets it to its own folder).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

if (args.includes('--version') || args.includes('-v')) { console.log(version); process.exit(0); }
if (args.includes('--help') || args.includes('-h')) {
  console.log(`AI Department ${version}

  ai-department                 Chạy và mở trình duyệt (mặc định cổng 4310)
  ai-department --port 4320     Chạy ở cổng khác
  ai-department --no-open       Không tự mở trình duyệt
  ai-department attest ...      Tạo attestation cho chế độ Docker

  Dữ liệu: ${process.env.AIDEPT_HOME ?? path.join(homedir(), '.ai-department')} (đổi bằng biến AIDEPT_HOME)`);
  process.exit(0);
}

const home = path.resolve(process.env.AIDEPT_HOME ?? path.join(homedir(), '.ai-department'));
mkdirSync(home, { recursive: true });

// Always use the same complete distribution. Bootstrap downloads it without invoking the system npm.
let runtime;
try {
  const { ensureAppRuntime } = await import('./runtime-bootstrap.mjs');
  runtime = await ensureAppRuntime(home);
} catch (error) {
  console.error(`Không chuẩn bị được bộ Node/npm riêng: ${error.message}. Kiểm tra kết nối tới nodejs.org rồi chạy lại. Dữ liệu task được giữ nguyên.`);
  process.exit(1);
}
const runtimeEnv = { ...process.env, AIDEPT_NPM_CLI: runtime.npm, npm_execpath: runtime.npm, npm_node_execpath: runtime.node };
const pathKey = Object.keys(runtimeEnv).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
runtimeEnv[pathKey] = [runtime.bin, runtimeEnv[pathKey]].filter(Boolean).join(path.delimiter);
const sameExecutable = process.platform === 'win32'
  ? path.resolve(process.execPath).toLowerCase() === path.resolve(runtime.node).toLowerCase()
  : path.resolve(process.execPath) === path.resolve(runtime.node);
if (!sameExecutable) {
  // Ctrl+C reaches both processes; the child shuts the server down, this one only waits for it.
  process.on('SIGINT', () => undefined);
  const child = spawn(runtime.node, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit', env: runtimeEnv });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (error) => { console.error(`Không chạy được ${runtime.node}: ${error.message}`); process.exit(1); });
  await new Promise(() => undefined);
}

Object.assign(process.env, runtimeEnv);
console.log(`Runtime: Node ${process.version}, npm ${runtime.npmVersion} (riêng cho AI Department).`);

process.chdir(home);
process.env.AIDEPT_STATIC_DIR ??= path.join(pkgDir, 'dist', 'client');
process.env.AIDEPT_TOOLS_DIR ??= path.join(pkgDir, 'tools');
// The Figma Exporter plugin, already built: the server only writes the manifest and UI for its own port from it.
process.env.AIDEPT_EXPORTER_TEMPLATE ??= path.join(pkgDir, 'figma-exporter');
if (option('port')) process.env.AIDEPT_PORT = option('port');
const port = Number(process.env.AIDEPT_PORT ?? 4310);
const url = `http://127.0.0.1:${port}`;

// node:sqlite still prints an "experimental" warning on Node 24; it says nothing useful to the person running the app.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning))) return;
  return emitWarning.call(process, warning, ...rest);
};

if (args[0] === 'attest') { await import('./attest.mjs'); process.exit(0); }

const openBrowser = () => {
  if (args.includes('--no-open') || process.env.AIDEPT_NO_BROWSER) return;
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
};

try {
  await import('./server.mjs');
} catch (error) {
  if (error?.code !== 'EADDRINUSE') throw error;
  // Started twice: if the running one is AI Department, just open it.
  const running = await fetch(`${url}/api/health`).then((r) => r.ok).catch(() => false);
  if (running) { console.log(`AI Department đang chạy sẵn ở ${url}.`); openBrowser(); process.exit(0); }
  console.error(`Cổng ${port} đang bị chương trình khác dùng. Chạy với cổng khác, ví dụ: ai-department --port 4320`);
  process.exit(1);
}
console.log(`\nAI Department ${version} đang chạy ở ${url}`);
console.log(`Dữ liệu: ${home}`);
console.log('Đóng cửa sổ này (hoặc Ctrl+C) để tắt.\n');
openBrowser();
