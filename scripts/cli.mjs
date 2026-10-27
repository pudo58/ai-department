#!/usr/bin/env node
// Entry point of the packaged AI Department (the `ai-department` command and start.cmd / start.sh).
// It keeps the person's data outside the package, so updating or reinstalling never touches it:
// ~/.ai-department by default, or the folder in AIDEPT_HOME (the portable zip sets it to its own folder).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
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

// The app needs Node 24 (built-in SQLite). On an older Node, fetch a private Node 24 into <home>/runtime once, through
// the person's own npm (the `node` package on npm ships the binary), and run this same script with it. The machine's
// Node stays as it is, so other projects are not affected.
const RUNTIME_MAJOR = 24;
if (Number(process.versions.node.split('.')[0]) < RUNTIME_MAJOR) {
  const runtimeDir = path.join(home, 'runtime');
  const node = path.join(runtimeDir, 'node_modules', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  if (!existsSync(node)) {
    console.log(`Máy đang dùng Node ${process.version}; AI Department cần Node ${RUNTIME_MAJOR}.`);
    console.log(`Đang tải một bản Node ${RUNTIME_MAJOR} riêng cho AI Department (khoảng 30 MB, chỉ một lần) vào ${runtimeDir}\n`);
    mkdirSync(runtimeDir, { recursive: true });
    const ok = await npmInstall(runtimeDir, `node@${RUNTIME_MAJOR}`);
    if (!ok || !existsSync(node)) {
      console.error(`\nKhông tải được Node ${RUNTIME_MAJOR}. Kiểm tra kết nối mạng rồi chạy lại, hoặc cài Node.js ${RUNTIME_MAJOR} từ https://nodejs.org`);
      process.exit(1);
    }
  }
  // Ctrl+C reaches both processes; the child shuts the server down, this one only waits for it.
  process.on('SIGINT', () => undefined);
  const child = spawn(node, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (error) => { console.error(`Không chạy được ${node}: ${error.message}`); process.exit(1); });
  await new Promise(() => undefined);
}

/** `npm install --prefix <dir> <spec>` with the npm that came with this Node (npm-cli.js sits next to node), else npm on PATH. */
function npmInstall(dir, spec) {
  const args = ['install', '--prefix', dir, spec, '--no-audit', '--no-fund', '--loglevel', 'error'];
  const bin = path.dirname(process.execPath);
  const cli = [path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => existsSync(p));
  const child = cli ? spawn(process.execPath, [cli, ...args], { stdio: 'inherit' })
    : spawn(['npm', ...args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))].join(' '), { stdio: 'inherit', shell: true });
  return new Promise((resolve) => { child.on('exit', (code) => resolve(code === 0)); child.on('error', () => resolve(false)); });
}

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
