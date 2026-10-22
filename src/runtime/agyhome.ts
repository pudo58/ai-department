import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Every drive root an absolute path could name on this machine (`/` outside Windows). */
export function driveRoots(): string[] {
  if (process.platform !== 'win32') return ['/'];
  return [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((letter) => existsSync(`${letter}:\\`)).map((letter) => `${letter}:/`);
}

/** agy compares paths in this form: absolute, forward slashes (`C:/Users/…`). */
const rulePath = (p: string) => path.resolve(p).replaceAll('\\', '/');

export interface AgySettings {
  trustedWorkspaces: string[];
  allowNonWorkspaceAccess: false;
  permissions: { allow: string[]; ask: string[]; deny: string[] };
}

/**
 * Permission rules for one turn. agy 1.4.5 reads rules only from `~/.gemini/antigravity-cli/settings.json`, and its
 * write_file tool takes any absolute path, inside the workspace or not. Measured on Windows 10 (2026-10-22): a rule covers
 * the path and everything below it, deny beats allow, allow beats ask, and headless mode refuses an ask (the turn then
 * stops with no answer). `allowNonWorkspaceAccess: false` alone did not stop a write outside the workspace.
 * - Read-only roles: every write is denied, the working copy included.
 * - Developer/Author: writes are allowed in the working copy and agy's own scratch folder, denied in `.git`, and
 *   anything else is an ask that headless mode refuses.
 */
export function agySettings(workdir: string, write: boolean, home: string, roots = driveRoots()): AgySettings {
  const everywhere = ['*', ...roots].map((root) => `write_file(${root})`);
  const ws = rulePath(workdir);
  return {
    trustedWorkspaces: [path.resolve(workdir)],
    allowNonWorkspaceAccess: false,
    permissions: write
      ? { allow: [`write_file(${ws})`, `write_file(${rulePath(path.join(home, '.gemini', 'antigravity-cli', 'brain'))})`], ask: everywhere, deny: [`write_file(${ws}/.git)`] }
      : { allow: [], ask: [], deny: everywhere },
  };
}

export interface AgyHome { dir: string; env: Record<string, string>; dispose: () => Promise<void> }

/**
 * A fresh home for one agy process, under AI Department's data dir: agy finds its settings through USERPROFILE/HOME, so it
 * loads the rules above and none of the person's own (their `~/.gemini` is never read or written). Sign-in still works:
 * agy keeps its token in the system keyring, not in the home folder.
 */
export async function createAgyHome(parent: string, workdir: string, write: boolean): Promise<AgyHome> {
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, 'home-'));
  const settings = path.join(dir, '.gemini', 'antigravity-cli', 'settings.json');
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(settings, `${JSON.stringify(agySettings(workdir, write, dir), null, 2)}\n`);
  const drive = path.parse(dir).root.replace(/[\\/]$/, '');
  const env: Record<string, string> = { USERPROFILE: dir, HOME: dir, ...(process.platform === 'win32' ? { HOMEDRIVE: drive, HOMEPATH: dir.slice(drive.length) } : {}) };
  // agy's language server can hold a file for a moment after exit; a leftover folder is harmless.
  return { dir, env, dispose: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined) };
}

/** The person's own agy permission files: a change there could grant agy commands in their next session. */
export const userAgyFiles = (home = os.homedir()): string[] => [
  path.join(home, '.gemini', 'config', 'config.json'),
  path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
];

/** Content hash per file, `missing` when absent, so a created file counts as a change too. */
export async function hashFiles(files: string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const file of files) hashes.set(file, await readFile(file).then((data) => createHash('sha256').update(data).digest('hex'), () => 'missing'));
  return hashes;
}
