import { appendFile, copyFile, lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Run, Slot } from '../shared/types.js';
import { isSafeRelative } from '../core/scope.js';
import { assertProcessSucceeded, executeFile } from './process.js';
import type { ChangeSet, PrepareResult } from './types.js';

/** Git runs on the host against an agent-written tree, so hooks and fsmonitor are always disabled. */
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=user'];

const SNAPSHOT_SKIP = new Set(['.git', 'node_modules', '.data']);
const SNAPSHOT_MAX_FILES = 20_000;
const SNAPSHOT_MAX_BYTES = 300 * 1024 * 1024;

/** Copies regular files only (symlinks are skipped), bounded so pointing a project at a huge folder fails fast. */
async function copyTree(from: string, to: string): Promise<void> {
  let files = 0, bytes = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(from, rel), { withFileTypes: true })) {
      if (SNAPSHOT_SKIP.has(entry.name) || entry.name.startsWith('.aidept-report.')) continue;
      const next = path.join(rel, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await mkdir(path.join(to, next), { recursive: true }); await walk(next); continue; }
      if (!entry.isFile()) continue;
      const size = (await lstat(path.join(from, next))).size;
      if (++files > SNAPSHOT_MAX_FILES || (bytes += size) > SNAPSHOT_MAX_BYTES) throw new Error(`Thư mục project quá lớn để chụp bản sao (quá ${SNAPSHOT_MAX_FILES} file hoặc ${SNAPSHOT_MAX_BYTES / 1024 / 1024} MB). Hãy trỏ project vào thư mục nhỏ hơn hoặc dùng git.`);
      await copyFile(path.join(from, next), path.join(to, next));
    }
  };
  await walk('');
}

/** The target's nearest existing ancestor must resolve inside the root, so a symlinked folder cannot redirect a write. */
async function insideRoot(root: string, target: string): Promise<boolean> {
  let dir = path.dirname(target);
  for (;;) {
    try { const real = await realpath(dir); return real === root || real.startsWith(root + path.sep); } catch { /* not created yet */ }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Per-run workspace clones and their git bookkeeping, shared by the Docker and local runtimes.
 * The agent only ever edits a clone under the data dir; the original checkout is read for the snapshot
 * and written once, on acceptance, to add a new branch ref (never its working tree or current branch).
 */
export class GitWorkspaces {
  constructor(private readonly dataDir: string) {}

  dir = (run: Run, slot: Slot) => path.join(this.dataDir, 'workspaces', `${run.id}-${slot}`);
  git = (cwd: string, args: string[], signal?: AbortSignal) => executeFile('git', [...SAFE_GIT, '-C', cwd, ...args], { timeoutMs: 120_000, signal });
  branchName = (run: Run, slot: Slot) => `aidept/${run.id}-${slot}`;

  private snapshotDir = (run: Run) => path.join(this.dataDir, 'workspaces', `${run.id}-base`);

  /** A repository with at least one commit is cloned as is; anything else (no git, or git without commits) is snapshotted. */
  async sourceKind(source: string): Promise<'git' | 'plain'> {
    const inside = await this.git(source, ['rev-parse', '--is-inside-work-tree']).catch(() => undefined);
    if (!inside || inside.exitCode !== 0) return 'plain';
    const head = await this.git(source, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return head.exitCode === 0 ? 'git' : 'plain';
  }

  /**
   * Copies the project folder (minus .git, node_modules and our own data) into a private git repository that serves
   * as the base for every clone of this run. It is made once per run, so edits a person makes to the folder later
   * cannot shift the base, and the original folder is only read here.
   */
  private async ensureSnapshot(run: Run, source: string): Promise<string> {
    const snap = this.snapshotDir(run);
    if (existsSync(path.join(snap, '.git')) && (await this.git(snap, ['rev-parse', '--verify', '--quiet', 'HEAD'])).exitCode === 0) return snap;
    await rm(snap, { recursive: true, force: true });
    await mkdir(snap, { recursive: true });
    await copyTree(source, snap);
    assertProcessSucceeded(await this.git(snap, ['init', '-q']), 'git init (snapshot)');
    // Byte-exact copies: no line-ending conversion, so what is delivered back matches what the person had.
    assertProcessSucceeded(await this.git(snap, ['config', 'core.autocrlf', 'false']), 'git config (snapshot)');
    assertProcessSucceeded(await this.git(snap, ['add', '-A']), 'git add (snapshot)');
    assertProcessSucceeded(await this.git(snap, ['-c', 'user.name=AI Department', '-c', 'user.email=ai-department@localhost', 'commit', '--allow-empty', '--no-verify', '-q', '-m', 'snapshot']), 'git commit (snapshot)');
    return snap;
  }

  async clone(run: Run, slot: Slot): Promise<PrepareResult & { ws: string }> {
    let source = run.configSnapshot.repository;
    const warnings: string[] = [];
    const plain = await this.sourceKind(source) === 'plain';
    if (plain) {
      source = await this.ensureSnapshot(run, source);
      warnings.push('Project chưa có commit nào hoặc không dùng git: agent làm việc trên bản chụp toàn bộ file hiện tại (trừ .git, node_modules). Khi nghiệm thu, các file đã đổi được ghi thẳng vào thư mục project (không tạo branch).');
    }
    const status = await this.git(source, ['status', '--porcelain']);
    assertProcessSucceeded(status, 'git status');
    if (status.stdout.trim()) warnings.push('Checkout gốc có thay đổi chưa commit; snapshot chỉ gồm commit HEAD, các thay đổi đó sẽ không được agent thấy.');
    const head = await this.git(source, ['rev-parse', 'HEAD']);
    assertProcessSucceeded(head, 'git rev-parse');
    const baseSha = run.baseSha ?? head.stdout.trim();
    const ws = this.dir(run, slot);
    await rm(ws, { recursive: true, force: true });
    await mkdir(path.dirname(ws), { recursive: true });
    assertProcessSucceeded(await executeFile('git', [...SAFE_GIT, 'clone', '--no-hardlinks', '--no-checkout', ...(plain ? ['-c', 'core.autocrlf=false'] : []), source, ws], { timeoutMs: 300_000 }), 'git clone');
    const branch = this.branchName(run, slot);
    assertProcessSucceeded(await this.git(ws, ['checkout', '-b', branch, baseSha]), 'git checkout');
    // Setup output (dependencies, reports) must never appear in the agent's diff.
    await appendFile(path.join(ws, '.git', 'info', 'exclude'), '\nnode_modules/\n.aidept-report.*\ntest-results/\nplaywright-report/\ncoverage/\n');
    // npm and npx treat the nearest folder with package.json OR node_modules as the project. Workspaces live under the
    // data dir, inside AI Department's own folder, so a project without package.json would otherwise install into, and
    // run tools from, AI Department itself. An (ignored) node_modules folder makes the workspace its own npm root.
    await mkdir(path.join(ws, 'node_modules'), { recursive: true });
    return { baseSha, branch, warnings, ws };
  }

  /** After setup, nothing tracked may have changed: a lockfile rewrite would leak into the agent's diff. */
  async assertCleanAfterSetup(ws: string): Promise<void> {
    const dirty = await this.git(ws, ['status', '--porcelain']);
    if (dirty.stdout.trim()) throw new Error(`Setup command thay đổi file được theo dõi bởi git (cần commit lockfile trước): ${dirty.stdout.slice(0, 300)}`);
  }

  async changes(run: Run, slot: Slot): Promise<ChangeSet> {
    const ws = this.dir(run, slot);
    // Intent-to-add makes untracked files appear in `git diff`.
    await this.git(ws, ['add', '-N', '.']);
    const names = await this.git(ws, ['diff', '--name-only', '-z', 'HEAD']);
    assertProcessSucceeded(names, 'git diff --name-only');
    const patch = await this.git(ws, ['diff', '--no-color', 'HEAD']);
    assertProcessSucceeded(patch, 'git diff');
    return { files: names.stdout.split('\0').filter(Boolean), patch: patch.stdout };
  }

  async commit(run: Run, slot: Slot, message: string): Promise<string> {
    const ws = this.dir(run, slot);
    assertProcessSucceeded(await this.git(ws, ['add', '-A']), 'git add');
    assertProcessSucceeded(await this.git(ws, ['-c', 'user.name=AI Department', '-c', 'user.email=ai-department@localhost', 'commit', '--allow-empty', '--no-verify', '-m', message]), 'git commit');
    const head = await this.git(ws, ['rev-parse', 'HEAD']);
    assertProcessSucceeded(head, 'git rev-parse');
    return head.stdout.trim();
  }

  async revert(run: Run, slot: Slot): Promise<void> {
    const ws = this.dir(run, slot);
    assertProcessSucceeded(await this.git(ws, ['reset', '--hard', 'HEAD']), 'git reset');
    assertProcessSucceeded(await this.git(ws, ['clean', '-fd']), 'git clean');
  }

  async baseFiles(run: Run, slot: Slot): Promise<string[]> {
    if (!run.baseSha) return [];
    const listed = await this.git(this.dir(run, slot), ['ls-tree', '-r', '--name-only', '-z', run.baseSha]);
    assertProcessSucceeded(listed, 'git ls-tree');
    return listed.stdout.split(' ').filter(Boolean);
  }

  async head(run: Run, slot: Slot): Promise<string> {
    const head = await this.git(this.dir(run, slot), ['rev-parse', 'HEAD']);
    assertProcessSucceeded(head, 'git rev-parse');
    return head.stdout.trim();
  }

  /**
   * Candidate tests over base sources: restores every non-test file from the base commit in place, runs `fn`,
   * and always returns the workspace to the committed checkpoint. node_modules is untracked and ignored, so it
   * survives both ways (copying it breaks on bind-mount symlinks).
   */
  async withBaseOverlay<T>(run: Run, slot: Slot, keepPaths: readonly string[], fn: () => Promise<T>): Promise<T> {
    const ws = this.dir(run, slot);
    const keep = new Set(keepPaths);
    const changed = await this.git(ws, ['diff', '--name-status', '-z', run.baseSha ?? 'HEAD~1', 'HEAD']);
    assertProcessSucceeded(changed, 'git diff --name-status');
    const parts = changed.stdout.split('\0').filter(Boolean);
    try {
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const status = parts[i]!, file = parts[i + 1]!;
        if (keep.has(file) || !isSafeRelative(file)) continue;
        const step = status.startsWith('A') ? await this.git(ws, ['rm', '-f', '--', file]) : await this.git(ws, ['checkout', run.baseSha!, '--', file]);
        assertProcessSucceeded(step, 'restore base file');
      }
      return await fn();
    } finally {
      await this.revert(run, slot);
    }
  }

  /** Everything the task changed relative to the base snapshot (not just the last round): per-file stats and the patch. */
  async diffSinceBase(run: Run, slot: Slot): Promise<{ files: { path: string; added: number; removed: number; status: 'added' | 'modified' | 'deleted' | 'renamed' }[]; patch: string }> {
    const ws = this.dir(run, slot);
    if (!run.baseSha) return { files: [], patch: '' };
    const head = await this.head(run, slot);
    const names = await this.git(ws, ['diff', '--name-status', '-z', '-M', run.baseSha, head]);
    assertProcessSucceeded(names, 'git diff --name-status');
    const stats = await this.git(ws, ['diff', '--numstat', '-z', '-M', run.baseSha, head]);
    assertProcessSucceeded(stats, 'git diff --numstat');
    const statusOf = (code: string) => (code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : code.startsWith('R') ? 'renamed' : 'modified') as 'added' | 'deleted' | 'renamed' | 'modified';
    const parts = names.stdout.split('\0').filter(Boolean);
    const kinds = new Map<string, 'added' | 'modified' | 'deleted' | 'renamed'>();
    for (let i = 0; i < parts.length;) {
      const code = parts[i]!;
      if (code.startsWith('R') || code.startsWith('C')) { kinds.set(parts[i + 2]!, statusOf(code)); i += 3; } else { kinds.set(parts[i + 1]!, statusOf(code)); i += 2; }
    }
    // numstat -z: "added\tremoved\tpath\0" or, for renames, "added\tremoved\t\0old\0new\0".
    const counts = new Map<string, { added: number; removed: number }>();
    const fields = stats.stdout.split('\0');
    for (let i = 0; i < fields.length; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i]!);
      if (!m) continue;
      const path = m[3] || fields[i + 2] || '';
      if (!m[3]) i += 2;
      counts.set(path, { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) });
    }
    const files = [...kinds].map(([path, status]) => ({ path, status, ...(counts.get(path) ?? { added: 0, removed: 0 }) }));
    const patch = await this.git(ws, ['diff', '--no-color', '-M', run.baseSha, head]);
    assertProcessSucceeded(patch, 'git diff');
    return { files, patch: patch.stdout };
  }

  /** Adds the result as a new local branch in the original repository. Existing branches are never overwritten. */
  async deliver(run: Run, slot: Slot): Promise<string> {
    const source = run.configSnapshot.repository;
    if (existsSync(path.join(this.snapshotDir(run), '.git'))) return this.deliverFiles(run, slot, source);
    const branch = this.branchName(run, slot);
    const exists = await this.git(source, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (exists.exitCode === 0) throw new Error(`Branch ${branch} đã tồn tại trong repository gốc.`);
    // No leading `+`: a fetch that is not a pure creation must fail rather than move a ref.
    assertProcessSucceeded(await this.git(source, ['fetch', '--no-tags', this.dir(run, slot), `refs/heads/${branch}:refs/heads/${branch}`]), 'git fetch (giao branch)');
    return branch;
  }

  /**
   * Delivery for a project without commits: writes the files the task changed into the project folder. Nothing is
   * written unless every file still matches the snapshot the task started from, so a person's own edits are never
   * overwritten; any conflict aborts with the list.
   */
  private async deliverFiles(run: Run, slot: Slot, source: string): Promise<string> {
    const ws = this.dir(run, slot), snap = this.snapshotDir(run);
    const root = await realpath(source);
    const base = run.baseSha ?? (await this.git(snap, ['rev-parse', 'HEAD'])).stdout.trim();
    const head = await this.head(run, slot);
    const listed = await this.git(ws, ['diff', '--name-status', '-z', '--no-renames', base, head]);
    assertProcessSucceeded(listed, 'git diff --name-status');
    const parts = listed.stdout.split('\0').filter(Boolean);
    const plan: { status: string; file: string; target: string }[] = [];
    const conflicts: string[] = [];
    const read = async (p: string) => readFile(p).catch(() => undefined);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]![0]!, file = parts[i + 1]!;
      const target = path.resolve(root, file);
      if (!isSafeRelative(file) || !target.startsWith(root + path.sep) || !(await insideRoot(root, target))) { conflicts.push(`${file} (đường dẫn không an toàn)`); continue; }
      const current = await read(target);
      const original = await read(path.join(snap, file));
      // A copy of one of this task's own intermediate versions (e.g. copied out of the workspace to try it) is not a
      // person's edit, so it may be overwritten with the final version.
      const ownVersion = async () => !!current && (await this.versionsInRun(ws, base, head, file)).some((v) => v.equals(current));
      if (status === 'A') {
        const added = await read(path.join(ws, file));
        if (current && !(added && current.equals(added)) && !(await ownVersion())) conflicts.push(`${file} (đã có file này trong project)`);
      } else if (current && (!original || !current.equals(original)) && !(await ownVersion())) conflicts.push(`${file} (đã bị sửa sau khi task bắt đầu)`);
      else if (!current && status === 'M') conflicts.push(`${file} (đã bị xóa khỏi project)`);
      plan.push({ status, file, target });
    }
    if (conflicts.length) throw new Error(`Không ghi vào thư mục project vì ${conflicts.length} file xung đột: ${conflicts.slice(0, 10).join('; ')}. Kết quả vẫn nằm trong bản sao làm việc.`);
    for (const { status, file, target } of plan) {
      if (status === 'D') await rm(target, { force: true });
      else { await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(ws, file), target); }
    }
    return `đã ghi ${plan.length} file vào ${source}`;
  }

  /** Every committed version of a file between the base and the checkpoint (newest first, at most 20). */
  private async versionsInRun(ws: string, base: string, head: string, file: string): Promise<Buffer[]> {
    const log = await this.git(ws, ['log', '--format=%H', '-n', '20', `${base}..${head}`, '--', file]);
    if (log.exitCode !== 0) return [];
    const out: Buffer[] = [];
    for (const sha of log.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const shown = await this.git(ws, ['show', `${sha}:${file}`]);
      // Text round-trips through utf8 exactly; a binary file may not, which only errs on the side of a conflict.
      if (shown.exitCode === 0) out.push(Buffer.from(shown.stdout, 'utf8'));
    }
    return out;
  }

  async dispose(run: Run): Promise<void> {
    const dir = path.join(this.dataDir, 'workspaces');
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir)) if (entry.startsWith(`${run.id}-`)) await rm(path.join(dir, entry), { recursive: true, force: true });
  }
}
