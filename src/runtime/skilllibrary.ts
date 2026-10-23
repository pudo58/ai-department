import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SkillCandidate, SkillRecord, SkillStatus } from '../shared/types.js';
import { checkSkillFiles, isScript, parseSkillMd, skillHash, SKILL_LIMITS } from '../core/skills.js';
import type { ResolvedSkill } from './types.js';
import { readZip } from './unzip.js';

/** Files of one skill held in memory between reading a source and installing it. */
export interface SkillBundle { origin: string; files: { path: string; data: Buffer; symlink?: boolean }[] }

interface SkillStore { get(id: string): SkillRecord | undefined; put(r: SkillRecord): SkillRecord; list(): SkillRecord[]; delete(id: string): void }

/** Folders inside a skill that are never part of it (caches, VCS, editor junk). */
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.DS_Store', 'Thumbs.db']);
const MAX_DOWNLOAD = 50 * 1024 * 1024;

function candidateOf(bundle: SkillBundle, installed?: SkillRecord): SkillCandidate {
  const problems = checkSkillFiles(bundle.files.map((f) => ({ path: f.path, size: f.data.length, symlink: f.symlink })));
  const md = bundle.files.find((f) => f.path === 'SKILL.md');
  let name = path.posix.basename(bundle.origin.replace(/\\/g, '/')) || 'skill', description = '';
  if (md) {
    try { ({ name, description } = parseSkillMd(md.data.toString('utf8')).meta); }
    catch (error) { problems.push((error as Error).message); }
  }
  const files = bundle.files.map((f) => ({ path: f.path, size: f.data.length, script: isScript(f.path, f.data.subarray(0, 2).toString('latin1')) }));
  const hash = skillHash(bundle.files);
  return {
    name, description, origin: bundle.origin, files, sizeBytes: files.reduce((n, f) => n + f.size, 0), hasScripts: files.some((f) => f.script), problems,
    ...(installed ? { installed: installed.status, sameAsInstalled: installed.hash === hash } : {}),
  };
}

/** Every skill folder (one holding SKILL.md) inside a set of zip entries; nested skills are not split further. */
function bundlesFromEntries(entries: { path: string; data: Buffer; directory: boolean; symlink: boolean }[], origin: string): SkillBundle[] {
  const roots = entries.filter((e) => !e.directory && /(^|\/)SKILL\.md$/.test(e.path)).map((e) => e.path.slice(0, -'SKILL.md'.length))
    .sort((a, b) => a.length - b.length)
    .filter((root, i, all) => !all.slice(0, i).some((outer) => root.startsWith(outer) && root !== outer));
  return roots.map((root) => ({
    origin: root ? `${origin}/${root.replace(/\/$/, '')}` : origin,
    files: entries.filter((e) => !e.directory && e.path.startsWith(root)).map((e) => ({ path: e.path.slice(root.length), data: e.data, symlink: e.symlink }))
      .filter((f) => !f.path.split('/').some((seg) => SKIP.has(seg))),
  }));
}

/** owner/repo/ref/subpath from a GitHub folder link; the ref is taken as one path segment (a branch, tag or commit). */
export function parseGitHubUrl(url: string): { owner: string; repo: string; ref?: string; subpath: string } {
  let u: URL;
  try { u = new URL(url.trim()); } catch { throw new Error('Link GitHub không hợp lệ.'); }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new Error('Chỉ nhận link https://github.com/<chủ>/<repo>/tree/<nhánh>/<thư mục skill>.');
  const [owner, repo, kind, ref, ...rest] = u.pathname.split('/').filter(Boolean);
  if (!owner || !repo) throw new Error('Link GitHub thiếu tên chủ hoặc repo.');
  if (kind && kind !== 'tree' && kind !== 'blob') throw new Error('Link GitHub phải trỏ tới một thư mục (…/tree/<nhánh>/…).');
  let subpath = rest.join('/');
  if (kind === 'blob' && subpath.endsWith('SKILL.md')) subpath = subpath.slice(0, -'SKILL.md'.length).replace(/\/$/, '');
  return { owner, repo: repo.replace(/\.git$/, ''), ref, subpath };
}

/**
 * The skill library: folders under <data>/skills/<name>, their records in the store, and every way of getting a skill
 * in (a folder on this machine, a .zip, a GitHub path). Nothing installed here is usable until a person approves it.
 */
export class SkillLibrary {
  readonly root: string;
  constructor(private readonly dataDir: string, private readonly records: SkillStore, private readonly fetchImpl: typeof fetch = fetch) {
    this.root = path.join(dataDir, 'skills');
  }

  dir(name: string): string { return path.join(this.root, name); }
  list(): SkillRecord[] { return this.records.list().sort((a, b) => a.name.localeCompare(b.name)); }
  get(name: string): SkillRecord | undefined { return this.records.get(name); }

  // ------------------------------------------------------------------------------------------- sources

  /** Reads one skill folder from disk; symlinks are recorded (and refused later), never followed. */
  async readFolder(dir: string): Promise<SkillBundle> {
    const files: SkillBundle['files'] = [];
    let total = 0;
    const walk = async (abs: string, rel: string): Promise<void> => {
      for (const e of await readdir(abs, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        const full = path.join(abs, e.name);
        if (files.length >= SKILL_LIMITS.maxFiles + 1) return;
        if (e.isSymbolicLink()) { files.push({ path: relPath, data: Buffer.alloc(0), symlink: true }); continue; }
        if (e.isDirectory()) { await walk(full, relPath); continue; }
        if (!e.isFile()) continue;
        const size = (await lstat(full)).size;
        total += size;
        // Oversized files are listed with their size so the check can name them, without reading them.
        files.push({ path: relPath, data: size > SKILL_LIMITS.maxFileBytes || total > SKILL_LIMITS.maxTotalBytes ? Buffer.alloc(size > SKILL_LIMITS.maxFileBytes ? SKILL_LIMITS.maxFileBytes + 1 : 0) : await readFile(full) });
      }
    };
    await walk(dir, '');
    return { origin: dir, files };
  }

  /** Skills already on this machine for Codex (`$CODEX_HOME/skills`) and Claude Code (`~/.claude/skills`), plus `extraDir`. */
  async discoverLocal(extraDir?: string, homes = [path.join(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'skills'), path.join(homedir(), '.claude', 'skills')]): Promise<SkillCandidate[]> {
    const dirs: string[] = [];
    for (const base of [...homes, ...(extraDir ? [extraDir] : [])]) {
      if (existsSync(path.join(base, 'SKILL.md'))) { dirs.push(base); continue; }
      const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && existsSync(path.join(base, e.name, 'SKILL.md'))) dirs.push(path.join(base, e.name));
    }
    const out: SkillCandidate[] = [];
    for (const dir of dirs) {
      try { const bundle = await this.readFolder(dir); const c = candidateOf(bundle); out.push({ ...c, ...this.installedInfo(c.name, bundle) }); }
      catch (error) { out.push({ name: path.basename(dir), description: '', origin: dir, files: [], sizeBytes: 0, hasScripts: false, problems: [(error as Error).message] }); }
    }
    return out;
  }

  /** Every skill in a .zip (a skill folder at the root, or several folders each with SKILL.md). */
  fromZip(zip: Buffer, origin: string): SkillBundle[] {
    const entries = readZip(zip, { maxEntries: 2000, maxEntryBytes: SKILL_LIMITS.maxFileBytes, maxTotalBytes: MAX_DOWNLOAD });
    const bundles = bundlesFromEntries(entries.map((e) => ({ ...e, path: e.path.replace(/^\/+/, '') })), origin);
    if (!bundles.length) throw new Error('Không tìm thấy SKILL.md nào trong file .zip.');
    return bundles;
  }

  /** Downloads a public GitHub repository archive and keeps only the skills under the linked folder. */
  async fromGitHub(url: string): Promise<SkillBundle[]> {
    const { owner, repo, ref, subpath } = parseGitHubUrl(url);
    const api = `https://api.github.com/repos/${owner}/${repo}/zipball${ref ? `/${encodeURIComponent(ref)}` : ''}`;
    const res = await this.fetchImpl(api, { redirect: 'follow', headers: { 'User-Agent': 'ai-department', Accept: 'application/vnd.github+json' } });
    if (res.status === 404) throw new Error('Không tìm thấy repo hoặc nhánh trên GitHub (repo riêng tư không tải được).');
    if (res.status === 403 || res.status === 429) throw new Error('GitHub đang giới hạn số lần tải (rate limit); thử lại sau ít phút.');
    if (!res.ok || !res.body) throw new Error(`GitHub trả lỗi ${res.status}.`);
    const host = new URL(res.url || api).hostname;
    if (!['api.github.com', 'codeload.github.com', 'github.com', '127.0.0.1', 'localhost'].includes(host)) throw new Error(`GitHub chuyển hướng tới máy lạ (${host}); dừng.`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD) throw new Error('Repo quá lớn để tải (trên 50 MB).');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_DOWNLOAD) throw new Error('Repo quá lớn để tải (trên 50 MB).');
      chunks.push(Buffer.from(chunk));
    }
    const entries = readZip(Buffer.concat(chunks), { maxEntries: 20_000, maxEntryBytes: 20 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024 });
    // GitHub wraps everything in "<owner>-<repo>-<sha>/"; keep the linked folder only.
    const prefix = `${subpath.replace(/^\/|\/$/g, '')}${subpath ? '/' : ''}`;
    const inside = entries
      .map((e) => ({ ...e, path: e.path.split('/').slice(1).join('/') }))
      .filter((e) => e.path && e.path.startsWith(prefix))
      .map((e) => ({ ...e, path: e.path.slice(prefix.length) }))
      .filter((e) => e.path);
    const bundles = bundlesFromEntries(inside, `github.com/${owner}/${repo}${subpath ? `/${subpath}` : ''}`);
    if (!bundles.length) throw new Error('Thư mục GitHub này không có SKILL.md nào.');
    return bundles;
  }

  preview(bundles: SkillBundle[]): SkillCandidate[] {
    return bundles.map((b) => { const c = candidateOf(b); return { ...c, ...this.installedInfo(c.name, b) }; });
  }

  private installedInfo(name: string, bundle: SkillBundle): Partial<SkillCandidate> {
    const existing = this.records.get(name);
    return existing ? { installed: existing.status, sameAsInstalled: existing.hash === skillHash(bundle.files) } : {};
  }

  // --------------------------------------------------------------------------------------- install / review

  /**
   * Stores a skill. It starts in review; reinstalling the same content keeps its status, new content goes back to
   * review, since what was approved is no longer what would run.
   */
  async install(bundle: SkillBundle, source: SkillRecord['source'], now = new Date().toISOString()): Promise<SkillRecord> {
    const c = candidateOf(bundle);
    if (c.problems.length) throw new Error(c.problems.join(' '));
    const hash = skillHash(bundle.files);
    const target = this.dir(c.name);
    const staging = path.join(this.root, `.tmp-${c.name}-${process.pid}-${Date.now()}`);
    await mkdir(staging, { recursive: true });
    try {
      for (const f of bundle.files) {
        const out = path.join(staging, ...f.path.split('/'));
        if (!out.startsWith(staging + path.sep)) throw new Error(`Đường dẫn không an toàn: ${f.path}`);
        await mkdir(path.dirname(out), { recursive: true });
        await writeFile(out, f.data);
      }
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
    const existing = this.records.get(c.name);
    const unchanged = existing?.hash === hash;
    return this.records.put({
      id: c.name, name: c.name, description: c.description, source, hash, files: c.files, sizeBytes: c.sizeBytes, hasScripts: c.hasScripts,
      status: unchanged ? existing!.status : 'review', installedAt: existing?.installedAt ?? now, updatedAt: now,
      ...(unchanged && existing?.reviewedAt ? { reviewedAt: existing.reviewedAt } : {}),
    });
  }

  setStatus(name: string, status: SkillStatus, now = new Date().toISOString()): SkillRecord {
    const record = this.records.get(name);
    if (!record) throw new Error('Skill không tồn tại.');
    return this.records.put({ ...record, status, updatedAt: now, ...(status === 'active' ? { reviewedAt: now } : {}) });
  }

  async remove(name: string): Promise<void> {
    await rm(this.dir(name), { recursive: true, force: true });
    this.records.delete(name);
  }

  async readSkillMd(name: string): Promise<string> { return readFile(path.join(this.dir(name), 'SKILL.md'), 'utf8'); }

  /**
   * The approved skills among `names`, ready for an agent, and why the others were left out. A folder edited on disk
   * after approval no longer matches its hash and is refused, so only reviewed content ever reaches an agent.
   */
  async resolve(names: readonly string[]): Promise<{ skills: ResolvedSkill[]; skipped: { name: string; reason: string }[] }> {
    const skills: ResolvedSkill[] = [], skipped: { name: string; reason: string }[] = [];
    for (const name of [...new Set(names)]) {
      const record = this.records.get(name);
      if (!record) { skipped.push({ name, reason: 'không có trong thư viện' }); continue; }
      if (record.status !== 'active') { skipped.push({ name, reason: record.status === 'review' ? 'chưa được duyệt' : 'đang tắt' }); continue; }
      try {
        const bundle = await this.readFolder(this.dir(name));
        if (skillHash(bundle.files) !== record.hash) { skipped.push({ name, reason: 'nội dung trên đĩa khác bản đã duyệt' }); continue; }
        const { body } = parseSkillMd(bundle.files.find((f) => f.path === 'SKILL.md')!.data.toString('utf8'));
        skills.push({ name, dir: this.dir(name), hash: record.hash, description: record.description, body, hasScripts: record.hasScripts });
      } catch (error) { skipped.push({ name, reason: (error as Error).message }); }
    }
    return { skills, skipped };
  }
}
