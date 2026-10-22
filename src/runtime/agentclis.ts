import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createAgyHome } from './agyhome.js';
import { resolveCodexCommand, resolveHostCommand } from './hostcommand.js';
import { executeFile, redactSecrets } from './process.js';
import { agyInput, buildCliCommand, JsonlCollector } from './providers.js';

export type AgentCli = 'codex' | 'claude' | 'antigravity';
export interface CliStatus {
  id: AgentCli; name: string;
  installed: boolean; version?: string; command?: string;
  loggedIn: boolean;
  /** How the CLI pays: a ChatGPT / Claude / Google subscription, or an API key billed per token. */
  billing?: 'subscription' | 'api';
  /** Human-readable login detail: "ChatGPT", "claude.ai (pro)", "API key"… */
  account?: string;
  /** Model ids the CLI offers (Antigravity lists them once signed in). */
  models?: string[];
  detail?: string;
}

/**
 * Claude Code entry: AIDEPT_CLAUDE_ENTRY (a .js/.mjs script run with this Node, or an executable), else `claude` on PATH.
 * The override exists for tests and for setups where the CLI is not on PATH.
 */
export function resolveClaudeCommand(override = process.env.AIDEPT_CLAUDE_ENTRY): string[] {
  if (override) return /\.(c|m)?js$/i.test(override) ? [process.execPath, override] : [override];
  return ['claude'];
}

/**
 * Antigravity CLI entry: AIDEPT_AGY_ENTRY (as for Claude), else the official installer's `%LOCALAPPDATA%\agy\bin\agy.exe`
 * (a server started before the install does not see the PATH change), else `agy` on PATH.
 */
export function resolveAgyCommand(override = process.env.AIDEPT_AGY_ENTRY): string[] {
  if (override) return /\.(c|m)?js$/i.test(override) ? [process.execPath, override] : [override];
  const installed = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : '';
  return installed && existsSync(installed) ? [installed] : ['agy'];
}

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0]?.slice(0, 120);

async function run(argv: string[], timeoutMs = 20_000, input?: string, env?: Record<string, string>): Promise<{ code: number | null; out: string } | undefined> {
  try {
    const [cmd, ...args] = argv;
    const r = await executeFile(cmd!, args, { timeoutMs, input, env });
    return { code: r.timedOut ? null : r.exitCode, out: `${r.stdout}\n${r.stderr}` };
  } catch { return undefined; }
}

export async function codexStatus(): Promise<CliStatus> {
  const base: CliStatus = { id: 'codex', name: 'Codex CLI (OpenAI)', installed: false, loggedIn: false };
  let cmd: string[];
  try { cmd = resolveCodexCommand(); } catch (error) { return { ...base, detail: (error as Error).message }; }
  const version = await run([...cmd, '--version']);
  if (!version || version.code !== 0) return { ...base, detail: 'Chưa cài Codex CLI.' };
  const login = await run([...cmd, 'login', 'status']);
  const text = login?.out ?? '';
  const loggedIn = login?.code === 0 && /logged in/i.test(text);
  const viaKey = /api key/i.test(text);
  return {
    ...base, installed: true, version: firstLine(version.out), command: cmd.join(' '), loggedIn,
    ...(loggedIn ? { billing: viaKey ? 'api' as const : 'subscription' as const, account: viaKey ? 'API key' : 'ChatGPT' } : {}),
    detail: loggedIn ? undefined : 'Đã cài nhưng chưa đăng nhập.',
  };
}

export async function claudeStatus(): Promise<CliStatus> {
  const base: CliStatus = { id: 'claude', name: 'Claude Code (Anthropic)', installed: false, loggedIn: false };
  const cmd = resolveClaudeCommand();
  const version = await run([...cmd, '--version']);
  if (!version || version.code !== 0) return { ...base, detail: 'Chưa cài Claude Code, hoặc lệnh "claude" không có trong PATH.' };
  const status = await run([...cmd, 'auth', 'status']);
  let info: Record<string, unknown> = {};
  try { info = JSON.parse(/\{[\s\S]*\}/.exec(status?.out ?? '')?.[0] ?? '{}') as Record<string, unknown>; } catch { /* older CLI: no JSON */ }
  const loggedIn = info.loggedIn === true;
  const method = String(info.authMethod ?? '');
  const subscription = method === 'claude.ai';
  const plan = typeof info.subscriptionType === 'string' ? info.subscriptionType : undefined;
  return {
    ...base, installed: true, version: firstLine(version.out), command: cmd.join(' '), loggedIn,
    ...(loggedIn ? { billing: subscription ? 'subscription' as const : 'api' as const, account: subscription ? `claude.ai${plan ? ` (${plan})` : ''}` : method || 'API' } : {}),
    detail: loggedIn ? undefined : 'Đã cài nhưng chưa đăng nhập.',
  };
}

/**
 * agy has no `auth status`; `agy models` lists models only for a signed-in account (Google login, or GEMINI_API_KEY),
 * so a non-empty list doubles as the login check. It takes a few seconds, hence the cache below.
 */
export async function antigravityStatus(): Promise<CliStatus> {
  const base: CliStatus = { id: 'antigravity', name: 'Antigravity CLI (Google)', installed: false, loggedIn: false };
  const cmd = resolveAgyCommand();
  const version = await run([...cmd, '--version']);
  if (!version || version.code !== 0) return { ...base, detail: 'Chưa cài Antigravity CLI (agy).' };
  const listed = await run([...cmd, 'models'], 30_000);
  const models = [...(listed?.out ?? '').matchAll(/^([a-z0-9][\w.-]*)\t/gim)].map((m) => m[1]!);
  const loggedIn = listed?.code === 0 && models.length > 0;
  const viaKey = !!process.env.GEMINI_API_KEY;
  return {
    ...base, installed: true, version: firstLine(version.out), command: cmd.join(' '), loggedIn,
    ...(loggedIn ? { billing: viaKey ? 'api' as const : 'subscription' as const, account: viaKey ? 'GEMINI_API_KEY' : 'Google', models } : {}),
    detail: loggedIn ? undefined : 'Đã cài nhưng chưa đăng nhập.',
  };
}

export const cliStatus = (id: AgentCli): Promise<CliStatus> => (id === 'codex' ? codexStatus() : id === 'claude' ? claudeStatus() : antigravityStatus());

/** Cached for a short while: the status is asked on every page load and each probe spawns processes. */
const cache = new Map<AgentCli, { at: number; value: Promise<CliStatus> }>();
export function cachedCliStatus(id: AgentCli, maxAgeMs = 30_000): Promise<CliStatus> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;
  const value = cliStatus(id);
  cache.set(id, { at: Date.now(), value });
  return value;
}
export const forgetCliStatus = () => cache.clear();

/**
 * Sends one tiny prompt through the CLI exactly as runs will (non-interactive, no tools needed) and reports
 * whether an answer came back, how long it took and which model answered. Uses one request of the person's quota.
 * Antigravity's private home and empty probe workspace go under `dataDir`.
 */
export async function testCli(id: AgentCli, dataDir: string): Promise<{ ok: boolean; ms: number; model?: string; reply?: string; error?: string }> {
  const started = Date.now();
  const prompt = 'Trả lời đúng một từ: OK';
  if (id === 'antigravity') {
    // The same invocation a read-only turn uses (plan mode, prompt on stdin, a private home that denies every write), so
    // the test proves that path, sign-in included, works. Its workspace is an empty folder.
    const parent = path.join(dataDir, 'agy');
    await mkdir(parent, { recursive: true });
    const workdir = await mkdtemp(path.join(parent, 'probe-'));
    const home = await createAgyHome(parent, workdir, false);
    const [, ...flags] = buildCliCommand({ provider: 'antigravity', model: '', singleAgent: true, workdir });
    const r = await run([...resolveAgyCommand(), ...flags], 120_000, agyInput(prompt), home.env).finally(async () => {
      await home.dispose();
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    });
    const ms = Date.now() - started;
    if (!r) return { ok: false, ms, error: 'Không chạy được lệnh.' };
    const c = new JsonlCollector({ provider: 'antigravity' });
    c.push(r.out.split(/\r?\n/).filter((l) => l.startsWith('{')).join('\n') + '\n');
    c.finish();
    if (c.failure || r.code !== 0) return { ok: false, ms, model: c.model, error: redactSecrets((c.failure ?? r.out.trim()).slice(-600)) };
    return { ok: true, ms, model: c.model, reply: c.output.slice(0, 200) };
  }
  const argv = id === 'codex'
    ? [...resolveCodexCommand(), 'exec', '--json', '--skip-git-repo-check', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"', '-']
    : [...resolveClaudeCommand(), '-p', '--output-format', 'json', '--setting-sources', 'project,local', '--strict-mcp-config', '--max-turns', '1'];
  const r = await run(argv, 120_000, prompt);
  const ms = Date.now() - started;
  if (!r) return { ok: false, ms, error: 'Không chạy được lệnh.' };
  if (r.code !== 0) return { ok: false, ms, error: redactSecrets(r.out.trim().slice(-600)) };
  if (id === 'claude') {
    try {
      const j = JSON.parse(/\{[\s\S]*\}/.exec(r.out)?.[0] ?? '{}') as Record<string, unknown>;
      const model = Object.keys((j.modelUsage as Record<string, unknown> | undefined) ?? {})[0];
      return { ok: j.is_error !== true, ms, model, reply: String(j.result ?? '').slice(0, 200), ...(j.is_error === true ? { error: String(j.result ?? 'Claude báo lỗi') } : {}) };
    } catch { return { ok: false, ms, error: 'Output của Claude không đọc được.' }; }
  }
  const reply = [...r.out.matchAll(/"text"\s*:\s*"([^"]{0,200})"/g)].map((m) => m[1]).at(-1);
  return { ok: /turn\.completed/.test(r.out), ms, reply, ...(/turn\.completed/.test(r.out) ? {} : { error: redactSecrets(r.out.trim().slice(-600)) }) };
}

/**
 * Installs the Codex CLI into AI Department's own `.tools/codex` (not global), the location resolveCodexCommand uses.
 * Claude Code is installed by its own installer; the page shows the command instead of running a global install.
 */
export async function installCodex(cwd = process.cwd()): Promise<{ ok: boolean; log: string }> {
  const [cmd, ...args] = resolveHostCommand(['npm', 'install', '--prefix', path.join(cwd, '.tools', 'codex'), '@openai/codex']);
  try {
    const r = await executeFile(cmd!, args, { cwd, timeoutMs: 10 * 60_000 });
    forgetCliStatus();
    return { ok: r.exitCode === 0 && existsSync(path.join(cwd, '.tools', 'codex', 'node_modules', '@openai', 'codex')), log: redactSecrets(`${r.stdout}\n${r.stderr}`.slice(-3000)) };
  } catch (error) { return { ok: false, log: (error as Error).message }; }
}

/**
 * Starts the CLI's own browser login (Codex: ChatGPT; Claude: claude.ai subscription) and returns the sign-in URL it
 * prints, if any. Credentials never pass through AI Department: the person signs in on the provider's page and the CLI
 * stores its own token. The process is left running until the login finishes or 10 minutes pass.
 */
export function startLogin(id: AgentCli): Promise<{ started: boolean; url?: string; output: string }> {
  // agy signs in only from its interactive terminal UI; there is no login command to drive from here.
  if (id === 'antigravity') return Promise.resolve({ started: false, output: 'Antigravity CLI chỉ đăng nhập trong terminal: mở PowerShell, chạy agy, đăng nhập Google trên trang vừa mở, rồi gõ /exit.' });
  let argv: string[];
  try { argv = id === 'codex' ? [...resolveCodexCommand(), 'login'] : [...resolveClaudeCommand(), 'auth', 'login', '--claudeai']; } catch (error) { return Promise.resolve({ started: false, output: (error as Error).message }); }
  return new Promise((resolve) => {
    let output = '', done = false;
    const finish = (started: boolean) => {
      if (done) return; done = true;
      const url = /https:\/\/[^\s"'<>]+/.exec(output)?.[0];
      resolve({ started, url, output: redactSecrets(output.slice(-1500)) });
    };
    let child;
    try { child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: false }); } catch (error) { output = (error as Error).message; finish(false); return; }
    const kill = setTimeout(() => child.kill(), 10 * 60_000);
    kill.unref();
    child.stdout?.on('data', (d: Buffer) => { output += d.toString('utf8'); if (/https:\/\//.test(output)) setTimeout(() => finish(true), 300); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString('utf8'); if (/https:\/\//.test(output)) setTimeout(() => finish(true), 300); });
    child.on('error', (error) => { output += error.message; finish(false); });
    child.on('exit', (code) => { clearTimeout(kill); forgetCliStatus(); finish(code === 0); });
    setTimeout(() => finish(true), 8000);
  });
}
