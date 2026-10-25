import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitWorkspaces } from '../src/runtime/gitworkspace.js';
import type { Run } from '../src/shared/types.js';
import { setup } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function workspace(kind: 'git' | 'plain') {
  const source = mkdtempSync(path.join(tmpdir(), 'aidept-delivery-source-'));
  writeFileSync(path.join(source, 'a.txt'), 'base-a');
  writeFileSync(path.join(source, 'b.bin'), Buffer.from([0, 255, 128, 1]));
  writeFileSync(path.join(source, 'remove.txt'), 'base-remove');
  if (kind === 'git') {
    git(source, 'init', '-q'); git(source, 'add', '-A');
    git(source, '-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-qm', 'base');
  }
  const run = setup({}, { repository: source }).create();
  const ws = new GitWorkspaces(mkdtempSync(path.join(tmpdir(), 'aidept-delivery-data-')));
  const prepared = await ws.clone(run, 'A'); run.baseSha = prepared.baseSha; run.branch = prepared.branch;
  const dir = ws.dir(run, 'A');
  writeFileSync(path.join(dir, 'a.txt'), 'final-a');
  writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 254, 129, 2]));
  writeFileSync(path.join(dir, 'new.txt'), 'final-new');
  rmSync(path.join(dir, 'remove.txt'));
  run.checkpoint = await ws.commit(run, 'A', 'result');
  return { source, run, ws, dir };
}

describe('delivery of an immutable Git checkpoint', () => {
  it('delivers exactly the checkpoint and treats the same destination branch as a successful retry', async () => {
    const { source, run, ws, dir } = await workspace('git');
    const before = git(source, 'rev-parse', 'HEAD');
    // Subsequent edits and commits in the workspace must not change what was accepted.
    writeFileSync(path.join(dir, 'a.txt'), 'unreviewed'); await ws.commit(run, 'A', 'unreviewed commit');
    const reportDiff = await ws.diffSinceBase(run, 'A');
    expect(reportDiff.patch).toContain('+final-a');
    expect(reportDiff.patch).not.toContain('+unreviewed');
    const result = await ws.deliver(run, 'A');
    expect(result).toMatchObject({ kind: 'branch', target: run.branch });
    expect(git(source, 'rev-parse', run.branch!)).toBe(run.checkpoint);
    expect(git(source, 'show', `${run.branch}:a.txt`)).toBe('final-a');
    expect(await ws.deliver(run, 'A')).toEqual(result);
    expect(git(source, 'rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(path.join(source, 'a.txt'), 'utf8')).toBe('base-a');
  });

  it('does not fast-forward an existing destination branch even when it is an ancestor', async () => {
    const { source, run, ws } = await workspace('git');
    git(source, 'branch', run.branch!, run.baseSha!);
    await expect(ws.deliver(run, 'A')).rejects.toThrow(/checkpoint khác/);
    expect(git(source, 'rev-parse', run.branch!)).toBe(run.baseSha);
  });

  it('atomically refuses a branch created by someone else after the initial check', async () => {
    const { source, run, ws } = await workspace('git');
    const original = ws.git;
    vi.spyOn(ws, 'git').mockImplementation(async (cwd, args, signal) => {
      if (args[0] === 'update-ref') git(source, 'branch', run.branch!, run.baseSha!);
      return original(cwd, args, signal);
    });
    await expect(ws.deliver(run, 'A')).rejects.toThrow(/xung đột/);
    expect(git(source, 'rev-parse', run.branch!)).toBe(run.baseSha);
  });
});

describe('retryable direct file delivery', () => {
  it('checks the final content of a file that was skipped as already delivered', async () => {
    const { source, run, ws } = await workspace('plain');
    writeFileSync(path.join(source, 'b.bin'), Buffer.from([0, 254, 129, 2]));
    const original = ws.git;
    vi.spyOn(ws, 'git').mockImplementation(async (cwd, args, signal) => {
      const result = await original(cwd, args, signal);
      if (args[0] === 'ls-tree' && args.at(-1) === 'new.txt') writeFileSync(path.join(source, 'b.bin'), 'user edit during delivery');
      return result;
    });
    await expect(ws.deliver(run, 'A')).rejects.toThrow(/Nội dung cuối không khớp checkpoint: b.bin/);
    expect(readFileSync(path.join(source, 'b.bin'), 'utf8')).toBe('user edit during delivery');
  });
  it('continues a partial delivery of binary modifications, additions and deletions, using committed final bytes', async () => {
    const { source, run, ws, dir } = await workspace('plain');
    writeFileSync(path.join(source, 'b.bin'), Buffer.from([0, 254, 129, 2]));
    writeFileSync(path.join(source, 'new.txt'), 'final-new');
    rmSync(path.join(source, 'remove.txt'));
    writeFileSync(path.join(dir, 'a.txt'), 'unreviewed workspace edit');
    const result = await ws.deliver(run, 'A');
    expect(result).toMatchObject({ kind: 'files', target: source });
    expect(readFileSync(path.join(source, 'a.txt'), 'utf8')).toBe('final-a');
    expect(readFileSync(path.join(source, 'b.bin'))).toEqual(Buffer.from([0, 254, 129, 2]));
    expect(readFileSync(path.join(source, 'new.txt'), 'utf8')).toBe('final-new');
    expect(existsSync(path.join(source, 'remove.txt'))).toBe(false);
    expect(await ws.deliver(run, 'A')).toEqual(result);
    expect(existsSync(path.join(source, '.git'))).toBe(false);
  });

  it.each(['a.txt', 'new.txt', 'remove.txt'])('refuses user edits to %s before continuing a partial delivery', async (file) => {
    const { source, run, ws } = await workspace('plain');
    writeFileSync(path.join(source, 'b.bin'), Buffer.from([0, 254, 129, 2]));
    writeFileSync(path.join(source, file), 'user change');
    await expect(ws.deliver(run, 'A')).rejects.toThrow(/xung đột/);
    expect(readFileSync(path.join(source, file), 'utf8')).toBe('user change');
    if (file !== 'new.txt') expect(existsSync(path.join(source, 'new.txt'))).toBe(false);
    if (file !== 'a.txt') expect(readFileSync(path.join(source, 'a.txt'), 'utf8')).toBe('base-a');
  });

  it('detects an edit made between the preflight and writing the next file, then allows a safe retry', async () => {
    const { source, run, ws } = await workspace('plain');
    const original = ws.git;
    let edited = false;
    vi.spyOn(ws, 'git').mockImplementation(async (cwd, args, signal) => {
      const result = await original(cwd, args, signal);
      // Last ls-tree happens after a.txt was preflighted; simulate the person saving that file then.
      if (args[0] === 'ls-tree' && args.at(-1) === 'new.txt' && !edited) { edited = true; writeFileSync(path.join(source, 'a.txt'), 'concurrent user edit'); }
      return result;
    });
    await expect(ws.deliver(run, 'A')).rejects.toThrow(/File thay đổi khi giao/);
    expect(readFileSync(path.join(source, 'a.txt'), 'utf8')).toBe('concurrent user edit');
    writeFileSync(path.join(source, 'a.txt'), 'base-a');
    expect((await ws.deliver(run, 'A')).kind).toBe('files');
  });
});
