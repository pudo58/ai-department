import { appendFile, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { DeliveryResult, DeliveryTarget, Run, Slot } from '../shared/types.js';
import { isSafeRelative } from '../core/scope.js';
import { assertProcessSucceeded, executeFile } from './process.js';
import type { ChangeSet, PrepareResult } from './types.js';

/** Git runs on the host against an agent-written tree, so hooks and fsmonitor are always disabled. */
const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=user'];

const SNAPSHOT_SKIP = new Set(['.git', 'node_modules', '.data', '.venv', '__pycache__', '.pytest_cache', '.gradle']);
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
    // Build tools and the Python virtualenv write into the workspace too (.venv, Maven's target/, Gradle's build/ and .gradle/).
    const mavenOut = existsSync(path.join(ws, 'pom.xml')) ? 'target/\n' : '';
    const gradleOut = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some((f) => existsSync(path.join(ws, f))) ? 'build/\n.gradle/\n' : '';
    await appendFile(path.join(ws, '.git', 'info', 'exclude'), `\nnode_modules/\n.aidept-report.*\ntest-results/\nplaywright-report/\ncoverage/\n.agents/skills/\n.venv/\n__pycache__/\n*.pyc\n.pytest_cache/\n${mavenOut}${gradleOut}`);
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

  async applyPatch(run: Run, slot: Slot, patch: string): Promise<void> {
    const ws = this.dir(run, slot);
    const head = await this.git(ws, ['rev-parse', 'HEAD']);
    assertProcessSucceeded(head, 'git rev-parse (test repair)');
    if (head.stdout.trim() !== run.checkpoint) throw new Error('Checkpoint workspace đã đổi; không áp dụng bản sửa test cũ.');
    const status = await this.git(ws, ['status', '--porcelain']);
    assertProcessSucceeded(status, 'git status (test repair)');
    if (status.stdout.trim()) throw new Error('Workspace còn thay đổi dở dang; không áp dụng bản sửa test.');
    const apply = (check: boolean) => executeFile('git', [...SAFE_GIT, '-C', ws, 'apply', ...(check ? ['--check'] : []), '--whitespace=nowarn', '-'], { input: patch, timeoutMs: 30_000 });
    assertProcessSucceeded(await apply(true), 'git apply --check (test repair)');
    assertProcessSucceeded(await apply(false), 'git apply (test repair)');
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

  /** Trial clones are siblings of the workspace with this suffix and 8 hex digits, so cleanup never looks anywhere else. */
  private trialPrefix = (run: Run, slot: Slot) => `${path.basename(this.dir(run, slot))}-regtrial-`;

  /**
   * A throwaway clone of the exact checkpoint with `patch` applied, for trying a generated regression test before anyone is asked.
   * The candidate is never touched, so nothing the trial writes (reports, caches, files a test config creates) can reach a later
   * check; the clone is deleted when `fn` ends, however it ends.
   */
  async withTrialClone<T>(run: Run, slot: Slot, patch: string, fn: (dir: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!run.checkpoint) throw new Error('Thiếu checkpoint để thử test regression.');
    const source = this.dir(run, slot), target = path.join(path.dirname(source), `${this.trialPrefix(run, slot)}${randomUUID().replace(/-/g, '').slice(0, 8)}`);
    try {
      assertProcessSucceeded(await executeFile('git', [...SAFE_GIT, 'clone', '--no-hardlinks', '--no-checkout', '-c', 'core.autocrlf=false', source, target], { timeoutMs: 120_000, signal }), 'git clone (thử regression)');
      assertProcessSucceeded(await this.git(target, ['checkout', '--detach', run.checkpoint], signal), 'git checkout (thử regression)');
      if (patch.trim()) assertProcessSucceeded(await executeFile('git', [...SAFE_GIT, '-C', target, 'apply', '--whitespace=nowarn', '-'], { input: patch, timeoutMs: 30_000, signal }), 'git apply (thử regression)');
      return await fn(target);
    } finally {
      await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  /**
   * Gives a trial clone the candidate's installed dependencies without letting it write into them: the clone gets a node_modules folder
   * of its own in which every installed entry is a link, so whatever a tool adds there (a cache, a marker) lands in the clone. Tool
   * caches are not linked at all. A test that writes inside an installed package would still reach the shared copy.
   */
  async linkDependencies(run: Run, slot: Slot, target: string): Promise<void> {
    const from = path.join(this.dir(run, slot), 'node_modules'), to = path.join(target, 'node_modules');
    let entries;
    try { entries = await readdir(from, { withFileTypes: true }); } catch { return; }
    await mkdir(to, { recursive: true });
    for (const entry of entries) {
      if (/^\.(cache|vite|vitest|vite-temp|tmp)$/.test(entry.name)) continue;
      const source = path.join(from, entry.name), dest = path.join(to, entry.name);
      const isDir = entry.isDirectory() || (entry.isSymbolicLink() && await stat(source).then(s => s.isDirectory(), () => false));
      if (isDir) await symlink(source, dest, process.platform === 'win32' ? 'junction' : 'dir');
      else if (entry.isFile() || entry.isSymbolicLink()) await copyFile(source, dest).catch(() => undefined);
    }
  }

  async recoverTrials(run: Run): Promise<void> {
    for (const slot of ['A', 'B'] as const) {
      const parent = path.dirname(this.dir(run, slot)), prefix = this.trialPrefix(run, slot);
      for (const name of await readdir(parent).catch(() => [] as string[])) {
        if (name.startsWith(prefix) && /^[a-f0-9]{8}$/.test(name.slice(prefix.length))) await rm(path.join(parent, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }

  /** Everything the task changed relative to the base snapshot (not just the last round): per-file stats and the patch. */
  async diffSinceBase(run: Run, slot: Slot): Promise<{ files: { path: string; added: number; removed: number; status: 'added' | 'modified' | 'deleted' | 'renamed' }[]; patch: string }> {
    const ws = this.dir(run, slot);
    if (!run.baseSha) return { files: [], patch: '' };
    const head = run.checkpoint ?? await this.head(run, slot);
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

  deliveryTarget(run: Run, slot: Slot): DeliveryTarget {
    return existsSync(path.join(this.snapshotDir(run), '.git'))
      ? { kind: 'files', target: run.configSnapshot.repository }
      : { kind: 'branch', target: this.branchName(run, slot) };
  }

  /** Creates a ref only if absent. Even an existing ancestor must never be moved by delivery. */
  async deliver(run: Run, slot: Slot): Promise<DeliveryResult> {
    if (!run.checkpoint) throw new Error('Chưa có checkpoint để giao kết quả.');
    const source = run.configSnapshot.repository;
    if (existsSync(path.join(this.snapshotDir(run), '.git'))) return this.deliverFiles(run, slot, source);
    const branch = this.branchName(run, slot);
    const ref = `refs/heads/${branch}`;
    const result: DeliveryResult = { kind: 'branch', target: branch, summary: `Đã tạo branch ${branch} trong repository gốc` };
    const exists = await this.git(source, ['rev-parse', '--verify', '--quiet', ref]);
    if (exists.exitCode === 0) {
      if (exists.stdout.trim() === run.checkpoint) return result;
      throw new Error(`Branch ${branch} đã tồn tại và trỏ tới checkpoint khác; không ghi đè.`);
    }
    // Fetch the immutable object, then atomically create a previously absent ref (empty old value).
    assertProcessSucceeded(await this.git(source, ['fetch', '--no-tags', this.dir(run, slot), run.checkpoint]), 'git fetch (giao checkpoint)');
    const created = await this.git(source, ['update-ref', ref, run.checkpoint, '']);
    if (created.exitCode !== 0) {
      const raced = await this.git(source, ['rev-parse', '--verify', '--quiet', ref]);
      if (raced.exitCode !== 0 || raced.stdout.trim() !== run.checkpoint) throw new Error(`Branch ${branch} xung đột khi giao; không ghi đè.`);
    }
    return result;
  }

  /**
   * Delivery for a project without commits: writes the files the task changed into the project folder. Nothing is
   * written unless every file still matches the snapshot the task started from, so a person's own edits are never
   * overwritten; any conflict aborts with the list.
   */
  private async deliverFiles(run: Run, slot: Slot, source: string): Promise<DeliveryResult> {
    const ws = this.dir(run, slot), snap = this.snapshotDir(run);
    const root = await realpath(source);
    const base = run.baseSha ?? (await this.git(snap, ['rev-parse', 'HEAD'])).stdout.trim();
    const head = run.checkpoint!;
    const listed = await this.git(ws, ['diff', '--name-status', '-z', '--no-renames', base, head]);
    assertProcessSucceeded(listed, 'git diff --name-status');
    const parts = listed.stdout.split('\0').filter(Boolean);
    const plan: { status: string; file: string; target: string; current?: Buffer; final?: Buffer }[] = [];
    const expected: { file: string; target: string; final?: Buffer }[] = [];
    const conflicts: string[] = [];
    const read = async (p: string) => {
      try { const info = await lstat(p); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Không ghi đè đường dẫn không phải file thường: ${p}`); return await readFile(p); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]![0]!, file = parts[i + 1]!;
      const target = path.resolve(root, file);
      if (!isSafeRelative(file) || !target.startsWith(root + path.sep) || !(await insideRoot(root, target))) { conflicts.push(`${file} (đường dẫn không an toàn)`); continue; }
      const current = await read(target);
      const original = await read(path.join(snap, file));
      const mode = status === 'D' ? '' : (await this.git(ws, ['ls-tree', head, '--', file])).stdout;
      if (status !== 'D' && !/^100(644|755) blob /.test(mode)) { conflicts.push(`${file} (không phải file thường)`); continue; }
      const final = status === 'D' ? undefined : await this.readBlob(ws, head, file);
      expected.push({ file, target, final });
      // A previous delivery may have stopped after any one of these files, including a binary modification.
      if ((final !== undefined && current?.equals(final)) || (!current && status === 'D')) continue;
      // A copy of one of this task's own intermediate versions (e.g. copied out of the workspace to try it) is not a
      // person's edit, so it may be overwritten with the final version.
      const ownVersion = async () => !!current && (await this.versionsInRun(ws, base, head, file)).some((v) => v.equals(current));
      if (status === 'A') {
        if (current && !(await ownVersion())) conflicts.push(`${file} (đã có file này trong project)`);
      } else if (current && (!original || !current.equals(original)) && !(await ownVersion())) conflicts.push(`${file} (đã bị sửa sau khi task bắt đầu)`);
      else if (!current && status === 'M') conflicts.push(`${file} (đã bị xóa khỏi project)`);
      plan.push({ status, file, target, current, final });
    }
    if (conflicts.length) throw new Error(`Không ghi vào thư mục project vì ${conflicts.length} file xung đột: ${conflicts.slice(0, 10).join('; ')}. Kết quả vẫn nằm trong bản sao làm việc.`);
    for (const { status, file, target, current, final } of plan) {
      if (!(await insideRoot(root, target))) throw new Error(`Đường dẫn thay đổi khi giao: ${file}`);
      const latest = await read(target);
      if (latest ? !current || !latest.equals(current) : !!current) throw new Error(`File thay đổi khi giao: ${file}. Hãy thử giao lại sau khi xử lý xung đột.`);
      if (status === 'D') await rm(target, { force: true });
      else {
        await mkdir(path.dirname(target), { recursive: true });
        const temp = path.join(path.dirname(target), `.aidept-delivery-${randomUUID()}.tmp`);
        try { await writeFile(temp, final!, { flag: 'wx' }); await rename(temp, target); }
        finally { await rm(temp, { force: true }); }
      }
    }
    // Include files skipped as already delivered: they can also be edited while other files are being copied.
    for (const { file, target, final } of expected) {
      if (!(await insideRoot(root, target))) throw new Error(`Đường dẫn thay đổi khi giao: ${file}`);
      const actual = await read(target);
      if (final ? !actual?.equals(final) : actual !== undefined) throw new Error(`Nội dung cuối không khớp checkpoint: ${file}. Kết quả chưa được xác nhận giao thành công.`);
    }
    return { kind: 'files', target: source, summary: `đã ghi ${parts.length / 2} file vào ${source}` };
  }

  /** Read committed bytes, never the possibly edited working tree or a lossy UTF-8 conversion. */
  private async readBlob(ws: string, sha: string, file: string): Promise<Buffer> {
    const { stdout } = await promisify(execFile)('git', [...SAFE_GIT, '-C', ws, 'show', `${sha}:${file}`],
      { encoding: 'buffer', maxBuffer: SNAPSHOT_MAX_BYTES, timeout: 120_000, windowsHide: true });
    return stdout;
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
