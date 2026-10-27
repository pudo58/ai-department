import { spawn, type ChildProcess } from 'node:child_process';
import { SetupFailedError } from './types.js';

/** On Windows `kill()` only ends the direct child; agents and test runners leave workers behind, so end the whole tree. */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else { try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { child.kill(); } }
}

/**
 * Names that carry a credential: API keys, tokens, secrets, passwords, private keys, SSH agent sockets. Matched as whole
 * words between underscores, so TOKENIZERS_PARALLELISM and KEYBOARD are left alone while NPM_TOKEN, AWS_SECRET_ACCESS_KEY
 * and SSH_AUTH_SOCK are not.
 */
const SECRET_NAME = /(^|_)(API_?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|AUTH|AUTH_?TOKEN)(_|$)/i;
/** The agent providers' own credentials and settings: only the agent CLIs themselves need these. */
const PROVIDER_NAME = /^(ANTHROPIC|OPENAI|CODEX|CLAUDE|CLAUDE_CODE|GEMINI|GOOGLE_(GENERATIVE_AI|API)|AZURE_OPENAI|OPENROUTER|MISTRAL|COHERE|GROQ|AGY|ANTIGRAVITY)(_|$)/i;

/**
 * This process's environment without credentials, for running a repository's own commands. Checks, previews and
 * probes execute code an agent wrote (a test can print or send any variable), so they must not inherit the keys of
 * the agents or the person's tokens. `provider` removes only the agent providers' variables (a setup command may
 * legitimately need NPM_TOKEN for a private registry); `all` removes everything that looks like a credential.
 * AIDEPT_PASS_ENV="NAME1,NAME2" lets named variables through when a project's checks really need them.
 */
export function scrubbedEnv(mode: 'all' | 'provider', base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const pass = new Set((base.AIDEPT_PASS_ENV ?? '').split(/[,\s]+/).filter(Boolean).map((n) => n.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const secret = PROVIDER_NAME.test(name) || (mode === 'all' && SECRET_NAME.test(name));
    if (secret && !pass.has(name.toUpperCase())) continue;
    out[name] = value;
  }
  return out;
}

export interface ProcessResult { exitCode: number | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean }
export interface ProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  maxOutputBytes?: number;
  /** Variables set on top of this process environment (Antigravity gets its own private home this way). */
  env?: Record<string, string>;
  /** Use only env rather than inheriting provider credentials or NODE_OPTIONS. */
  replaceEnv?: boolean;
  /** Inherit this process's environment minus credentials (see scrubbedEnv). Use it for any command that runs repository code. */
  scrubSecrets?: 'all' | 'provider';
}

/** Host callers pass a fixed executable and argv. Repository commands belong in Docker. */
export async function executeFile(executable: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  if (args.some((arg) => arg.includes('\0')) || executable.includes('\0')) throw new Error('NUL in process argument');
  if (options.signal?.aborted) throw new Error('Execution interrupted');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false, windowsHide: true, detached: process.platform !== 'win32', cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(options.replaceEnv ? {} : options.scrubSecrets ? scrubbedEnv(options.scrubSecrets) : process.env), ...options.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, overflow = false;
    const limit = options.maxOutputBytes ?? 16 * 1024 * 1024;
    const collect = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > limit) { overflow = true; killTree(child); return; }
      const value = chunk.toString('utf8');
      if (target === 'stdout') { stdout += value; options.onStdout?.(value); }
      else { stderr += value; options.onStderr?.(value); }
    };
    const abort = () => { killTree(child); };
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, options.timeoutMs ?? 30_000);
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', (exitCode) => {
      cleanup();
      if (options.signal?.aborted) return reject(new Error('Execution interrupted'));
      if (overflow) return reject(new Error('Output exceeds capture limit; result is incomplete'));
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
    child.stdin.on('error', () => { /* Early CLI failures can close stdin before the prompt is written. */ });
    child.stdin.end(options.input);
  });
}

export function assertProcessSucceeded(result: ProcessResult, operation: string): void {
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`${operation} ${result.timedOut ? 'timed out' : `failed (${result.exitCode ?? 'no exit code'})`}: ${result.stderr.slice(0, 2000)}`);
  }
}

/** The same check for the project's setup command, failing with an error the run can tell apart from every other one. */
export function assertSetupSucceeded(result: ProcessResult): void {
  try { assertProcessSucceeded(result, 'setup command'); } catch (error) { throw new SetupFailedError((error as Error).message); }
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9_.~+/-]{16,}/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|authorization|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

/** Buffers stream chunks and hands out complete lines; call `flush()` when the stream ends. */
export function lineSplitter(onLine: (line: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        if (line.trim()) onLine(line);
      }
      // A runaway line without a newline must not grow without bound.
      if (buffer.length > 16_384) { onLine(buffer); buffer = ''; }
    },
    flush() { if (buffer.trim()) onLine(buffer.replace(/\r$/, '')); buffer = ''; },
  };
}
