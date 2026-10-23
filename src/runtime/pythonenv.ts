import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProcessResult } from './process.js';
import { RuntimeBlockedError } from './types.js';

export type PythonRun = (exe: string, args: string[], timeoutMs: number) => Promise<ProcessResult>;

const SETUP_MS = 15 * 60_000;
const PIP = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input'];

/** The interpreter inside a workspace's virtualenv. */
export const venvPython = (ws: string, platform: NodeJS.Platform = process.platform): string =>
  path.join(ws, '.venv', platform === 'win32' ? 'Scripts' : 'bin', platform === 'win32' ? 'python.exe' : 'python');

/**
 * Gives a Python workspace its own virtualenv (`.venv`, ignored by git) with the project's dependencies and pytest, so
 * the check `python -m pytest` runs against the project's libraries without touching the machine's Python. Python itself
 * cannot be installed from here (its Windows installer needs a person), so a missing interpreter blocks with a clear message.
 */
export async function bootstrapPython(ws: string, run: PythonRun, log: (message: string, level?: 'info' | 'warn') => void, platform: NodeJS.Platform = process.platform): Promise<void> {
  const candidates: string[][] = platform === 'win32' ? [['python'], ['py', '-3']] : [['python3'], ['python']];
  let base: string[] | undefined;
  for (const c of candidates) {
    try { if ((await run(c[0]!, [...c.slice(1), '--version'], 20_000)).exitCode === 0) { base = c; break; } } catch { /* not installed under this name */ }
  }
  if (!base) throw new RuntimeBlockedError('Máy chưa có Python. Cài Python 3 từ python.org (tick "Add to PATH") rồi chạy lại task.');

  const python = venvPython(ws, platform);
  if (!existsSync(python)) {
    log('Tạo virtualenv .venv cho project…');
    const made = await run(base[0]!, [...base.slice(1), '-m', 'venv', path.join(ws, '.venv')], SETUP_MS);
    if (made.exitCode !== 0) throw new RuntimeBlockedError(`Không tạo được virtualenv: ${made.stderr.slice(0, 300)}`);
  }

  const has = (name: string) => existsSync(path.join(ws, name));
  if (has('requirements.txt')) {
    log('Cài thư viện từ requirements.txt…');
    const r = await run(python, [...PIP, '-r', 'requirements.txt'], SETUP_MS);
    if (r.exitCode !== 0) throw new RuntimeBlockedError(`pip install -r requirements.txt lỗi (mã ${r.exitCode}): ${r.stderr.slice(-400)}`);
  }
  // A package project (pyproject/setup.py): install it editable so tests import the code under test. Best effort, because
  // many repos use pyproject only for tool settings and are not installable.
  const pyproject = has('pyproject.toml') ? await readFile(path.join(ws, 'pyproject.toml'), 'utf8').catch(() => '') : '';
  if (has('setup.py') || /^\[build-system\]/m.test(pyproject)) {
    log('Cài project ở chế độ editable (pip install -e .)…');
    const r = await run(python, [...PIP, '-e', '.'], SETUP_MS);
    if (r.exitCode !== 0) log(`pip install -e . lỗi, bỏ qua (mã ${r.exitCode}): ${r.stderr.slice(-300)}`, 'warn');
  }
  const probe = await run(python, ['-c', 'import pytest'], 30_000);
  if (probe.exitCode !== 0) {
    log('Cài pytest…');
    const r = await run(python, [...PIP, 'pytest'], SETUP_MS);
    if (r.exitCode !== 0) throw new RuntimeBlockedError(`Không cài được pytest (mã ${r.exitCode}): ${r.stderr.slice(-400)}`);
  }
}
