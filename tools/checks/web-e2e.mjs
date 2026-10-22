#!/usr/bin/env node
/**
 * Check runner for browser tests that need the app running: starts the project's server on a free port, waits until it
 * answers, runs Playwright with a JUnit report, then stops the server and exits with Playwright's exit code.
 *
 * Used as a project check (argv, no shell), run from the working copy:
 *   node <ai_department>/tools/checks/web-e2e.mjs --server node server.mjs --url-env EXPENSE_APP_URL -- e2e
 * Options:
 *   --server <cmd ...>   command that starts the app; it receives the port in PORT ("node" means this Node)
 *   --url-env <NAME>     env var the tests read for the app URL (default BASE_URL)
 *   --report <path>      JUnit report path (default .aidept-report.xml)
 *   --wait <ms>          how long to wait for the server (default 30000)
 *   -- <args ...>        passed to `playwright test` (files, --workers, ...)
 * It never installs anything: Playwright must already be in node_modules (the project's setup command does that).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const opts = { server: [], urlEnv: 'BASE_URL', report: '.aidept-report.xml', wait: 30_000, rest: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { opts.rest = argv.slice(i + 1); break; }
  if (a === '--url-env') opts.urlEnv = argv[++i];
  else if (a === '--report') opts.report = argv[++i];
  else if (a === '--wait') opts.wait = Number(argv[++i]);
  else if (a === '--server') { while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts.server.push(argv[++i]); }
  else { console.error(`web-e2e: tùy chọn không hợp lệ: ${a}`); process.exit(2); }
}
const fail = (message) => { console.error(`web-e2e: ${message}`); process.exit(2); };
if (!opts.server.length) fail('thiếu --server <lệnh chạy app>.');
const cli = path.resolve('node_modules', 'playwright', 'cli.js');
if (!existsSync(cli)) fail(`không tìm thấy ${cli}. Cài Playwright bằng lệnh cài đặt của project, ví dụ ["npm","install","--no-save","@playwright/test"].`);

const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const [cmd, ...args] = opts.server;
const server = spawn(cmd === 'node' ? process.execPath : cmd, args, { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let serverExit = null;
server.on('exit', (code) => { serverExit = code; });
const stop = () => { if (serverExit === null) server.kill(); };
process.on('exit', stop);

const deadline = Date.now() + opts.wait;
for (;;) {
  if (serverExit !== null) fail(`server dừng ngay (mã ${serverExit}):\n${serverLog.slice(-2000)}`);
  try { const res = await fetch(url); await res.arrayBuffer(); break; } catch { /* not up yet */ }
  if (Date.now() > deadline) { stop(); fail(`server không trả lời ở ${url} sau ${opts.wait} ms:\n${serverLog.slice(-2000)}`); }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`web-e2e: app chạy ở ${url}; chạy Playwright…`);

// Test output (screenshots, traces, browser profiles) goes outside the working copy so it never reaches a commit.
const output = mkdtempSync(path.join(tmpdir(), 'aidept-e2e-'));
const test = spawn(process.execPath, [cli, 'test', '--reporter=list,junit', '--output', output, ...opts.rest], {
  env: { ...process.env, [opts.urlEnv]: url, PLAYWRIGHT_JUNIT_OUTPUT_NAME: path.resolve(opts.report), CI: '1' },
  stdio: 'inherit', windowsHide: true,
});
const code = await new Promise((resolve) => test.on('exit', (c) => resolve(c ?? 1)));
stop();
rmSync(output, { recursive: true, force: true });
process.exit(code);
