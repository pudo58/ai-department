import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { checkSkillFiles, isScript, parseSkillMd, skillHash, skillPromptBlock } from '../src/core/skills.js';
import { buildCliCommand } from '../src/runtime/providers.js';
import { FakeRuntime, type FakeOptions } from '../src/runtime/fake.js';
import { parseGitHubUrl, SkillLibrary } from '../src/runtime/skilllibrary.js';
import { claudeSkillPlugin, codexWorkspaceSkills } from '../src/runtime/skillmount.js';
import type { AgentExecution } from '../src/runtime/types.js';
import { readZip } from '../src/runtime/unzip.js';
import { buildApp } from '../src/server/app.js';
import { Orchestrator } from '../src/server/orchestrator.js';
import { Store } from '../src/server/store.js';
import type { ProjectProfile, Role } from '../src/shared/types.js';
import { green, profile } from './helpers.js';

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `aidept-${p}-`));
const md = (name: string, description = `Skill ${name} để thử.`, body = `# ${name}\nLàm theo các bước.`) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
const folder = (files: Record<string, string>) => {
  const dir = tmp('skill');
  for (const [p, c] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); writeFileSync(path.join(dir, p), c); }
  return dir;
};

/** A minimal zip writer for the tests: stored or deflated entries, CRC left at 0 (the reader does not check it). */
function makeZip(files: Record<string, string | Buffer>, opts: { deflate?: boolean; encrypt?: string } = {}): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = opts.deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const flags = 0x800 | (opts.encrypt === name ? 1 : 0);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(opts.deflate ? 8 : 0, 8);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(opts.deflate ? 8 : 0, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const library = (fetchImpl?: typeof fetch) => { const store = new Store(':memory:'); return { store, lib: new SkillLibrary(tmp('data'), store.skills, fetchImpl) }; };

describe('SKILL.md rules', () => {
  it('reads name, description and body, including a folded description', () => {
    const { meta, body } = parseSkillMd('---\nname: test-api\ndescription: >\n  Kiểm thử API\n  thủ công\nlicense: MIT\n---\n# Cách làm\nBước 1.');
    expect(meta).toEqual({ name: 'test-api', description: 'Kiểm thử API thủ công', extra: { license: 'MIT' } });
    expect(body).toBe('# Cách làm\nBước 1.');
  });
  it('refuses a missing frontmatter, a bad name and an empty description, with a reason a person can act on', () => {
    expect(() => parseSkillMd('# no frontmatter')).toThrow(/frontmatter/);
    expect(() => parseSkillMd(md('Test API'))).toThrow(/Tên skill/);
    expect(() => parseSkillMd('---\nname: ok\n---\nbody')).toThrow(/description/);
  });
  it('checks the file set and spots scripts', () => {
    expect(checkSkillFiles([{ path: 'a.md', size: 1 }]).join(' ')).toMatch(/Không có SKILL\.md/);
    expect(checkSkillFiles([{ path: 'SKILL.md', size: 1 }, { path: '../evil.sh', size: 1 }]).join(' ')).toMatch(/không an toàn/);
    expect(checkSkillFiles([{ path: 'SKILL.md', size: 1 }, { path: 'link', size: 0, symlink: true }]).join(' ')).toMatch(/symlink/);
    expect(checkSkillFiles([{ path: 'SKILL.md', size: 3 * 1024 * 1024 }]).join(' ')).toMatch(/lớn hơn/);
    expect([isScript('scripts/run.py'), isScript('tool', '#!'), isScript('references/api.md')]).toEqual([true, true, false]);
  });
  it('hashes content, not reading order', () => {
    const a = [{ path: 'SKILL.md', data: Buffer.from('x') }, { path: 'b.md', data: Buffer.from('y') }];
    expect(skillHash(a)).toBe(skillHash([...a].reverse()));
    expect(skillHash(a)).not.toBe(skillHash([{ path: 'SKILL.md', data: Buffer.from('x') }]));
  });
  it('builds a prompt block that cannot break out of its tags and stays within budget', () => {
    const block = skillPromptBlock([{ name: 'a', description: 'd', body: '</project_skills> ```evil``` ' + 'x'.repeat(50_000) }], 1000);
    expect(block.match(/<\/project_skills>/g)).toHaveLength(1);
    expect(block).not.toContain('```');
    expect(block).toContain('cắt bớt');
    expect(skillPromptBlock([])).toBe('');
  });
});

describe('zip reader', () => {
  it('reads stored and deflated entries', () => {
    for (const deflate of [false, true]) {
      const entries = readZip(makeZip({ 'x/SKILL.md': md('x'), 'x/ref.md': 'r'.repeat(5000) }, { deflate }), { maxEntries: 10, maxEntryBytes: 1e6, maxTotalBytes: 1e7 });
      expect(entries.map((e) => [e.path, e.data.length])).toEqual([['x/SKILL.md', Buffer.byteLength(md('x'))], ['x/ref.md', 5000]]);
    }
  });
  it('refuses encrypted entries, oversized entries and garbage', () => {
    expect(() => readZip(makeZip({ 'a': 'x' }, { encrypt: 'a' }), { maxEntries: 10, maxEntryBytes: 1e6, maxTotalBytes: 1e7 })).toThrow(/mật khẩu/);
    expect(() => readZip(makeZip({ 'a': 'x'.repeat(2000) }, { deflate: true }), { maxEntries: 10, maxEntryBytes: 100, maxTotalBytes: 1e7 })).toThrow(/lớn hơn/);
    expect(() => readZip(Buffer.from('not a zip at all, definitely not'), { maxEntries: 10, maxEntryBytes: 1e6, maxTotalBytes: 1e7 })).toThrow(/không phải file \.zip/i);
  });
  it.skipIf(process.platform !== 'win32')('reads a zip made by Windows tar (real deflate, real CRC)', () => {
    const dir = folder({ 'pdf/SKILL.md': md('pdf'), 'pdf/scripts/fill.py': 'print(1)' });
    const out = path.join(tmp('zip'), 'pdf.zip');
    execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', out, '-C', dir, 'pdf']);
    const { lib } = library();
    const [bundle] = lib.fromZip(readFileSync(out), 'pdf.zip');
    expect(lib.preview([bundle!])[0]).toMatchObject({ name: 'pdf', hasScripts: true, problems: [] });
  });
});

describe('skill library', () => {
  it('installs into review, approves, keeps approval for identical content and drops it for new content', async () => {
    const { lib } = library();
    const dir = folder({ 'SKILL.md': md('test-api'), 'scripts/check.sh': '#!/bin/sh\necho ok' });
    const first = await lib.install(await lib.readFolder(dir), { type: 'local', path: dir });
    expect(first).toMatchObject({ name: 'test-api', status: 'review', hasScripts: true });
    expect(existsSync(path.join(lib.dir('test-api'), 'scripts', 'check.sh'))).toBe(true);
    lib.setStatus('test-api', 'active');
    expect((await lib.install(await lib.readFolder(dir), { type: 'local', path: dir })).status).toBe('active');
    writeFileSync(path.join(dir, 'SKILL.md'), md('test-api', 'Mô tả mới.'));
    expect((await lib.install(await lib.readFolder(dir), { type: 'local', path: dir })).status).toBe('review');
  });

  it('hands out only approved skills, and refuses one whose files changed on disk after approval', async () => {
    const { lib } = library();
    for (const name of ['a-skill', 'b-skill']) await lib.install(await lib.readFolder(folder({ 'SKILL.md': md(name) })), { type: 'local' });
    lib.setStatus('a-skill', 'active');
    let r = await lib.resolve(['a-skill', 'b-skill', 'missing']);
    expect(r.skills.map((s) => s.name)).toEqual(['a-skill']);
    expect(r.skills[0]!.body).toContain('# a-skill');
    expect(r.skipped.map((s) => `${s.name}:${s.reason}`)).toEqual(['b-skill:chưa được duyệt', 'missing:không có trong thư viện']);
    writeFileSync(path.join(lib.dir('a-skill'), 'SKILL.md'), md('a-skill', 'Bị sửa sau khi duyệt.'));
    r = await lib.resolve(['a-skill']);
    expect(r.skipped[0]!.reason).toMatch(/khác bản đã duyệt/);
  });

  it('finds skills already on this machine and says which are installed', async () => {
    const { lib } = library();
    const codex = folder({ 'test-api/SKILL.md': md('test-api'), 'notes/readme.md': 'not a skill', '.system/x/SKILL.md': md('x') });
    const claude = folder({ 'bad/SKILL.md': '# no frontmatter' });
    await lib.install(await lib.readFolder(path.join(codex, 'test-api')), { type: 'local' });
    const found = await lib.discoverLocal(undefined, [codex, claude]);
    expect(found.map((c) => [c.name, c.installed ?? '-', c.sameAsInstalled ?? '-', c.problems.length > 0])).toEqual([['test-api', 'review', true, false], ['bad', '-', '-', true]]);
  });

  it('splits a zip holding several skills, and flags a path escaping the skill folder', () => {
    const { lib } = library();
    const bundles = lib.fromZip(makeZip({ 'pack/one/SKILL.md': md('one'), 'pack/two/SKILL.md': md('two'), 'pack/two/ref/x.md': 'x', 'pack/README.md': 'r' }, { deflate: true }), 'pack.zip');
    expect(lib.preview(bundles).map((c) => [c.name, c.files.map((f) => f.path).sort()])).toEqual([['one', ['SKILL.md']], ['two', ['SKILL.md', 'ref/x.md']]]);
    const [evil] = lib.fromZip(makeZip({ 'SKILL.md': md('evil'), '../../outside.txt': 'x' }), 'evil.zip');
    expect(lib.preview([evil!])[0]!.problems.join(' ')).toMatch(/không an toàn/);
  });

  it('parses GitHub folder links and downloads only the linked folder', async () => {
    expect(parseGitHubUrl('https://github.com/anthropics/skills/tree/main/skills/pdf')).toEqual({ owner: 'anthropics', repo: 'skills', ref: 'main', subpath: 'skills/pdf' });
    expect(parseGitHubUrl('https://github.com/o/r/blob/v1/a/SKILL.md')).toMatchObject({ ref: 'v1', subpath: 'a' });
    expect(() => parseGitHubUrl('https://gitlab.com/o/r')).toThrow(/github\.com/);
    let asked = '';
    const zip = makeZip({ 'o-r-abc123/skills/pdf/SKILL.md': md('pdf'), 'o-r-abc123/skills/docx/SKILL.md': md('docx'), 'o-r-abc123/README.md': 'r' }, { deflate: true });
    const fake = (async (url: string) => { asked = url; return new Response(new Uint8Array(zip), { status: 200 }); }) as unknown as typeof fetch;
    const { lib } = library(fake);
    const bundles = await lib.fromGitHub('https://github.com/o/r/tree/main/skills/pdf');
    expect(asked).toBe('https://api.github.com/repos/o/r/zipball/main');
    expect(lib.preview(bundles).map((c) => c.name)).toEqual(['pdf']);
    const rateLimited = library((async () => new Response('', { status: 403 })) as unknown as typeof fetch).lib;
    await expect(rateLimited.fromGitHub('https://github.com/o/r')).rejects.toThrow(/rate limit/);
  });
});

describe('loading skills for an agent', () => {
  async function runWith(roles: Partial<Record<Role, Partial<ProjectProfile['roles'][Role]>>>, opts: { mode?: 'single' | 'clarify' | 'verify'; approve?: boolean } = {}) {
    const store = new Store(':memory:');
    const lib = new SkillLibrary(tmp('data'), store.skills);
    await lib.install(await lib.readFolder(folder({ 'SKILL.md': md('test-api', 'Kiểm thử API.'), 'run.py': 'print(1)' })), { type: 'local' });
    if (opts.approve !== false) lib.setStatus('test-api', 'active');
    const seen: AgentExecution[] = [];
    const fake: FakeOptions = { check: () => green, reply: (e) => { seen.push(e); return undefined; } };
    const runtime = new FakeRuntime(fake);
    const orchestrator = new Orchestrator(store, () => runtime, { skills: lib });
    const base = profile();
    store.projects.put(profile({ roles: Object.fromEntries(Object.entries(base.roles).map(([r, c]) => [r, { ...c, ...roles[r as Role] }])) as ProjectProfile['roles'] }));
    const run = orchestrator.createRun({ projectId: 'prj_test', title: 't', originalRequirement: 'r', mode: opts.mode ?? 'single', provider: 'codex', budgetUsd: 5, signals: [] });
    orchestrator.startRun(run.id); await orchestrator.idle();
    orchestrator.approveContract(run.id); await orchestrator.idle();
    return { seen, store, run, orchestrator };
  }

  it('gives the Developer its approved skills natively, and nothing to roles without skills', async () => {
    const { seen, store, run } = await runWith({ developer: { skills: ['test-api'] } });
    const dev = seen.find((e) => e.role === 'developer')!;
    expect(dev.skills?.map((s) => s.name)).toEqual(['test-api']);
    expect(dev.prompt).not.toContain('<project_skills>');
    expect(seen.find((e) => e.role === 'planner')!.skills ?? []).toEqual([]);
    const ctx = store.artifacts.list(run.id).filter((a) => a.kind === 'context' && a.attemptId === store.attempts.list(run.id).find((x) => x.role === 'developer')!.id);
    expect(JSON.parse(ctx[0]!.content).skills).toEqual([{ name: 'test-api', hash: expect.any(String), delivery: 'workspace', hasScripts: true }]);
  });

  it('puts skills into the prompt for Antigravity, which cannot load them itself', async () => {
    const { seen } = await runWith({ planner: { provider: 'antigravity', skills: ['test-api'] } });
    const planner = seen.find((e) => e.role === 'planner')!;
    expect(planner.skills).toBeUndefined();
    expect(planner.prompt).toContain('<project_skills>');
    expect(planner.prompt).toContain('Kiểm thử API.');
  });

  it('never gives skills to the independent interpreter, even when its roles have approved skills', async () => {
    const { seen } = await runWith({ author: { skills: ['test-api'] }, investigator: { skills: ['test-api'] } }, { mode: 'clarify' });
    const readings = seen.filter((e) => e.prompt.includes('diễn giải yêu cầu một cách độc lập'));
    expect(readings.length).toBe(2);
    expect(readings.every((e) => !e.skills?.length && !e.prompt.includes('<project_skills>'))).toBe(true);
  });

  it('warns in the console when an assigned skill is not approved', async () => {
    const { store, run } = await runWith({ developer: { skills: ['test-api'] } }, { approve: false });
    expect(store.logs.list({ runId: run.id }).some((l) => /Không nạp skill "test-api" cho developer: chưa được duyệt/.test(l.message))).toBe(true);
  });

  it('lists the skills in the acceptance report, with a note when one ships scripts', async () => {
    const { orchestrator, run } = await runWith({ developer: { skills: ['test-api'] } });
    const report = await orchestrator.report(run.id);
    expect(report.skills).toEqual([{ role: 'developer', name: 'test-api', delivery: 'workspace', hasScripts: true }]);
    expect(report.warnings.some((w) => w.level === 'info' && /kèm script \(test-api\)/.test(w.text))).toBe(true);
  });
});

describe('placing skills where the CLI finds them', () => {
  const skill = (name: string) => { const dir = folder({ 'SKILL.md': md(name) }); return { name, dir, hash: 'h', description: 'd', body: 'b', hasScripts: false }; };

  it('Claude: a plugin folder outside the working copy, removed afterwards', async () => {
    const data = tmp('data');
    const plugin = await claudeSkillPlugin(data, 'att_1', [skill('one'), skill('two')]);
    expect(JSON.parse(readFileSync(path.join(plugin.dir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('aidept-skills');
    expect(existsSync(path.join(plugin.dir, 'skills', 'two', 'SKILL.md'))).toBe(true);
    await plugin.dispose();
    expect(existsSync(plugin.dir)).toBe(false);
    const cmd = buildCliCommand({ provider: 'claude', model: '', singleAgent: true, local: true, pluginDirs: [plugin.dir], skillScripts: true });
    expect(cmd.slice(cmd.indexOf('--plugin-dir'), cmd.indexOf('--plugin-dir') + 2)).toEqual(['--plugin-dir', plugin.dir]);
    expect(cmd).toEqual(expect.arrayContaining(['Skill', 'Bash(python *)']));
    expect(buildCliCommand({ provider: 'claude', model: '', singleAgent: true, local: true })).not.toContain('Skill');
  });

  it('Codex: .agents/skills in the working copy, git-ignored, never over a skill the repo already has, cleaned up', async () => {
    const ws = tmp('ws');
    execFileSync('git', ['init', '-q'], { cwd: ws });
    mkdirSync(path.join(ws, '.agents', 'skills', 'two'), { recursive: true });
    writeFileSync(path.join(ws, '.agents', 'skills', 'two', 'SKILL.md'), 'repo own');
    execFileSync('git', ['add', '-A'], { cwd: ws });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], { cwd: ws });
    const warnings: string[] = [];
    const mounted = await codexWorkspaceSkills(ws, [skill('one'), skill('two')], (e) => warnings.push(e.message));
    expect(existsSync(path.join(ws, '.agents', 'skills', 'one', 'SKILL.md'))).toBe(true);
    expect(readFileSync(path.join(ws, '.agents', 'skills', 'two', 'SKILL.md'), 'utf8')).toBe('repo own');
    expect(warnings.join(' ')).toMatch(/Repo đã có skill "two"/);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8' })).toBe('');
    await mounted.dispose();
    expect(existsSync(path.join(ws, '.agents', 'skills', 'one'))).toBe(false);
    expect(existsSync(path.join(ws, '.agents', 'skills', 'two', 'SKILL.md'))).toBe(true);
  });
});

describe('skill API', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('previews and installs an uploaded zip, approves it, and refuses to delete a skill in use', async () => {
    const store = new Store(':memory:');
    const dataDir = tmp('data');
    const orchestrator = new Orchestrator(store, () => new FakeRuntime());
    app = await buildApp({ store, orchestrator, dataDir, port: 4310 });
    const host = { host: '127.0.0.1:4310' };
    const { token } = (await app.inject({ method: 'GET', url: '/api/session', headers: host })).json<{ token: string }>();
    const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app!.inject({ method, url, payload: payload as object, headers: { ...host, 'x-csrf-token': token } });
    const dataBase64 = makeZip({ 'test-api/SKILL.md': md('test-api') }, { deflate: true }).toString('base64');

    const preview = (await send('POST', '/api/skills/upload', { fileName: 'test-api.zip', dataBase64, preview: true })).json<{ candidates: { name: string }[] }>();
    expect(preview.candidates.map((c) => c.name)).toEqual(['test-api']);
    expect((await send('POST', '/api/skills/upload', { fileName: 'test-api.zip', dataBase64 })).json()).toEqual({ installed: ['test-api'] });
    expect((await send('POST', '/api/skills/upload', { fileName: 'x.rar', dataBase64 })).statusCode).toBe(400);
    expect((await send('POST', '/api/skills/test-api/approve', {})).json()).toMatchObject({ status: 'active' });

    store.projects.put(profile({ roles: { ...profile().roles, developer: { ...profile().roles.developer, skills: ['test-api'] } } }));
    const listed = (await app.inject({ method: 'GET', url: '/api/skills', headers: host })).json<{ name: string; usedBy: { role: string }[] }[]>();
    expect(listed[0]!.usedBy).toEqual([{ projectId: 'prj_test', project: 'Demo', role: 'developer' }]);
    const del = await send('DELETE', '/api/skills/test-api');
    expect(del.statusCode).toBe(409);
    expect(del.json().message).toMatch(/Demo \(developer\)/);
  });
});
