import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fontFaceCss, fontUses, fontsourceId, isItalicStyle, styleWeight } from '../src/core/designfonts.js';
import { FontFetcher, FontStore, type FontFetch } from '../src/server/figma/fonts.js';
import type { FieldValue, NodeRecord } from '../src/shared/figma.js';
import type { AgentExecution } from '../src/runtime/types.js';
import type { Role } from '../src/shared/types.js';
import { profile } from './helpers.js';
import { rig } from './figma/harness.js';

const read = (v: unknown): FieldValue => ({ s: 'read', v: v as never });
const text = (id: string, fields: Record<string, FieldValue>): NodeRecord => ({ k: 'node', id, type: 'TEXT', name: id, pageId: '0:1', parentId: null, index: 0, depth: 0, childIds: [], groups: {}, fields, hash: '' });

describe('which fonts a design uses', () => {
  it('reads the family and weight of single-style text, and the segments of text whose style changes', () => {
    const uses = fontUses([
      text('1', { 'text.fontName': read({ family: 'Roboto', style: 'Regular' }) }),
      text('2', { 'text.fontName': read({ family: 'Roboto', style: 'Medium' }) }),
      text('3', { 'text.fontName': { s: 'mixed', v: null }, 'text.segments': read([{ fontName: { family: 'Inter', style: 'Regular' } }, { fontName: { family: 'Inter', style: 'Bold Italic' } }]) }),
      text('4', { 'text.fontName': { s: 'unavailable', r: 'x' } }),
      { ...text('5', { 'text.fontName': read({ family: 'Ignored', style: 'Regular' }) }), type: 'FRAME' },
    ]);
    expect(uses).toEqual([
      // The family with more text comes first.
      { family: 'Roboto', variants: [{ weight: 400, italic: false }, { weight: 500, italic: false }], nodes: 2 },
      { family: 'Inter', variants: [{ weight: 400, italic: false }, { weight: 700, italic: true }], nodes: 1 },
    ]);
  });
  it('names weights and italics from the style, and families the way the catalogue does', () => {
    expect([styleWeight('Thin'), styleWeight('Light'), styleWeight('Regular'), styleWeight('Medium'), styleWeight('SemiBold'), styleWeight('Bold'), styleWeight('ExtraBold'), styleWeight('Black'), styleWeight('Odd')]).toEqual([100, 300, 400, 500, 600, 700, 800, 900, undefined]);
    expect(isItalicStyle('Bold Italic')).toBe(true); expect(isItalicStyle('Bold')).toBe(false);
    expect([fontsourceId('Open Sans'), fontsourceId('Roboto'), fontsourceId('FS Magistral'), fontsourceId('  Noto Sans JP ')]).toEqual(['open-sans', 'roboto', 'fs-magistral', 'noto-sans-jp']);
  });
});

/** A catalogue and a CDN in memory: Roboto and Inter exist, FS Magistral does not. */
function network(options: { bad?: 'magic' | 'huge' | 'server' | 'mismatch' | 'redirect'; weights?: number[] } = {}) {
  const requests: string[] = [];
  const woff2 = (extra = 8) => Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(extra, 1)]);
  const fetchFn: FontFetch = async (url) => {
    requests.push(url);
    const u = new URL(url);
    if (u.hostname === 'api.fontsource.org') {
      const id = u.pathname.split('/').pop()!;
      if (!['roboto', 'inter'].includes(id)) return new Response('{}', { status: 404 });
      return Response.json({ id: options.bad === 'mismatch' ? 'other' : id, family: id, subsets: ['latin', 'latin-ext', 'vietnamese', 'cyrillic'], weights: options.weights ?? [300, 400, 500, 700], styles: ['normal', 'italic'], license: 'OFL-1.1', source: 'https://github.com/google/fonts', npmVersion: '5.3.0', unicodeRange: { latin: 'U+0000-00FF', vietnamese: 'U+0102-0103', cyrillic: 'U+0400-045F' } });
    }
    if (options.bad === 'server') return new Response('boom', { status: 500 });
    if (options.bad === 'magic') return new Response(Buffer.from('<html>not a font</html>'));
    if (options.bad === 'huge') return new Response(Buffer.alloc(10), { headers: { 'content-length': '5000000' } });
    if (u.pathname.includes('-latin-ext-700-italic')) return new Response('', { status: 404 });
    return new Response(woff2());
  };
  return { fetchFn, requests };
}
const snapshot = { id: 'dsn_aaaaaaaaaaaa', snapshotHash: 'a'.repeat(64) };
const roboto = { family: 'Roboto', variants: [{ weight: 400, italic: false }, { weight: 500, italic: false }], nodes: 3 };
const dirs: string[] = [];
const fixture = (options: Parameters<typeof network>[0] = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidept-fonts-')); dirs.push(dir);
  const store = new FontStore(dir), net = network(options);
  return { dir, store, net, fetcher: new FontFetcher(store, net.fetchFn) };
};
const signal = () => new AbortController().signal;

describe('fetching open fonts', () => {
  it('fetches the Latin, Latin Extended and Vietnamese files of each weight, keeps a hash of each, and writes ready-made @font-face rules', async () => {
    const { fetcher, store, net } = fixture();
    const set = await fetcher.fetchFor(snapshot, [roboto], signal());
    const family = set.families[0]!;
    expect(family).toMatchObject({ family: 'Roboto', status: 'ready', id: 'roboto', version: '5.3.0', license: 'OFL-1.1' });
    expect(family.files.map((f) => f.name).sort()).toEqual(['roboto-latin-400-normal.woff2', 'roboto-latin-500-normal.woff2', 'roboto-latin-ext-400-normal.woff2', 'roboto-latin-ext-500-normal.woff2', 'roboto-vietnamese-400-normal.woff2', 'roboto-vietnamese-500-normal.woff2']);
    expect(family.files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256) && f.bytes > 4)).toBe(true);
    expect(existsSync(store.file(family.files[0]!.file))).toBe(true);
    expect(store.read(snapshot.id, snapshot.snapshotHash)?.families[0]?.files).toHaveLength(6);
    expect(store.read(snapshot.id, 'b'.repeat(64))).toBeUndefined();
    const css = fontFaceCss(set.families);
    expect(css).toContain("font-family: 'Roboto'"); expect(css).toContain("url('./roboto-vietnamese-500-normal.woff2')"); expect(css).toContain('unicode-range: U+0102-0103'); expect(css).toContain('OFL-1.1');
    expect(net.requests.every((u) => ['api.fontsource.org', 'cdn.jsdelivr.net'].includes(new URL(u).hostname) && u.startsWith('https://'))).toBe(true);
    expect(net.requests.filter((u) => u.includes('/files/')).every((u) => u.includes('@fontsource/roboto@5.3.0/'))).toBe(true);
  });
  it('reports a commercial font as missing instead of replacing it, and keeps the open ones next to it', async () => {
    const { fetcher } = fixture();
    const set = await fetcher.fetchFor(snapshot, [roboto, { family: 'FS Magistral', variants: [{ weight: 400, italic: false }], nodes: 1 }], signal());
    expect(set.families.map((f) => [f.family, f.status])).toEqual([['Roboto', 'ready'], ['FS Magistral', 'not_open']]);
    expect(set.families[1]!.files).toEqual([]); expect(set.families[1]!.notes[0]).toContain('thương mại');
  });
  it('uses the nearest weight the family has and says so; a missing file is a note, not a failure', async () => {
    const { fetcher } = fixture({ weights: [400, 700] });
    const set = await fetcher.fetchFor(snapshot, [{ family: 'Inter', variants: [{ weight: 500, italic: false }, { weight: 700, italic: true }], nodes: 2 }], signal());
    const inter = set.families[0]!;
    expect(inter.status).toBe('ready');
    expect(inter.notes.join(' ')).toContain('Độ đậm 500 không có; dùng 400.');
    expect(inter.notes.join(' ')).toContain('inter-latin-ext-700-italic.woff2');
    expect(inter.files.some((f) => f.weight === 700 && f.italic)).toBe(true);
  });
  it('fetches nothing twice: a stored file is reused', async () => {
    const { fetcher, net } = fixture();
    await fetcher.fetchFor(snapshot, [roboto], signal());
    const first = net.requests.filter((u) => u.includes('/files/')).length;
    await fetcher.fetchFor(snapshot, [roboto], signal());
    expect(first).toBe(6); expect(net.requests.filter((u) => u.includes('/files/')).length).toBe(6);
  });
  it.each([['magic', 'WOFF2'], ['huge', 'quá lớn'], ['server', 'HTTP 500']] as const)('does not keep a file that is %s', async (bad, why) => {
    const { fetcher, dir } = fixture({ bad });
    const set = await fetcher.fetchFor(snapshot, [roboto], signal());
    expect(set.families[0]!.status).toBe('failed');
    expect(set.families[0]!.notes.join(' ')).toContain(why);
    expect(existsSync(path.join(dir, 'design-fonts', 'files'))).toBe(false);
  });
  it('does not trust a catalogue answer for another family', async () => {
    const { fetcher } = fixture({ bad: 'mismatch' });
    const set = await fetcher.fetchFor(snapshot, [roboto], signal());
    expect(set.families[0]).toMatchObject({ status: 'failed' }); expect(set.families[0]!.notes[0]).toContain('không đúng định dạng');
  });
  it('turns a network failure into a note for that family, and never fetches from a host outside the list', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidept-fonts-')); dirs.push(dir);
    const urls: string[] = [];
    const fetcher = new FontFetcher(new FontStore(dir), async (url) => { urls.push(url); throw new Error('offline'); });
    const set = await fetcher.fetchFor(snapshot, [roboto], signal());
    expect(set.families[0]).toMatchObject({ status: 'failed' }); expect(set.families[0]!.notes[0]).toContain('offline');
    expect(urls).toEqual(['https://api.fontsource.org/v1/fonts/roboto']);
  });
  it('keeps a stored file inside its folder whatever a record says', () => {
    const { store } = fixture();
    expect(() => store.file('../../etc/passwd')).toThrow();
  });
});

let current: Awaited<ReturnType<typeof rig>> | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

describe('fonts in a task\'s design', () => {
  const seen: { role: Role; prompt: string; design: AgentExecution['design'] }[] = [];
  it('are fetched only when asked, are copied into the Developer\'s design folder with their rules, and reach the copy that was made before them', async () => {
    seen.length = 0;
    const net = network();
    current = await rig({ fake: { reply: (exec) => { seen.push({ role: exec.role, prompt: exec.prompt, design: exec.design }); return undefined; } }, fontFetch: net.fetchFn });
    const r = current;
    await r.pairNow();
    r.store.projects.put(profile({ contextEnabled: false }));
    const job = await r.finished((await r.exportAs({ scope: 'selection', rootIds: ['1:2'] })).id);
    const snap = r.service.snapshots.get(job.snapshotId!)!;
    expect((await r.admin.post(`/api/design-snapshots/${snap.id}/publish`, { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: snap.issues.filter((i) => i.severity === 'limit').map((i) => i.id) })).statusCode).toBe(200);

    const before = (await r.admin.get(`/api/design-snapshots/${snap.id}/fonts`)).json() as { uses: { family: string; variants: unknown[] }[]; set?: unknown; hosts: string[] };
    expect(before.uses.map((u) => u.family)).toEqual(['Inter']); expect(before.set).toBeUndefined(); expect(before.hosts).toEqual(['api.fontsource.org', 'cdn.jsdelivr.net']);
    expect(net.requests).toEqual([]);
    expect((await r.admin.post(`/api/design-snapshots/${snap.id}/fonts`, {})).statusCode).toBe(400);
    expect(net.requests).toEqual([]);

    const run = r.orchestrator.createRun({ projectId: 'prj_test', title: 'Màn', originalRequirement: 'Dựng màn.', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [], design: { snapshotId: snap.id, targetIds: ['1:2'] } } as never);
    r.orchestrator.startRun(run.id); await r.orchestrator.idle();
    const first = seen.find((s) => s.role === 'planner')!.design!.hostDir;
    expect(existsSync(path.join(first, 'fonts'))).toBe(false);

    const fetched = await r.admin.post(`/api/design-snapshots/${snap.id}/fonts`, { confirm: true });
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(net.requests.length).toBeGreaterThan(0);
    r.orchestrator.approveContract(run.id, { contractHash: r.orchestrator.detail(run.id).contractReview.contractHash, acknowledgeWarnings: true }); await r.orchestrator.idle();
    const dev = seen.find((s) => s.role === 'developer')!;
    const folder = path.join(dev.design!.hostDir, 'fonts');
    expect(readdirSync(folder)).toEqual(expect.arrayContaining(['fonts.css', 'fonts.json', 'inter-latin-400-normal.woff2', 'inter-vietnamese-700-normal.woff2']));
    expect(readFileSync(path.join(folder, 'fonts.css'), 'utf8')).toContain("font-family: 'Inter'");
    expect(dev.prompt).toContain('Font của thiết kế (1)'); expect(dev.prompt).toContain('đã có file trong'); expect(dev.prompt).toContain('fonts/fonts.css');
    expect(dev.prompt).toContain('Nếu thư mục thiết kế có fonts/');
    expect(JSON.parse(readFileSync(path.join(dev.design!.hostDir, 'index.json'), 'utf8')).fontsHash).toMatch(/^[a-f0-9]{64}$/);
    // The planner never needs them.
    expect(seen.find((s) => s.role === 'planner')!.prompt).not.toContain('Font của thiết kế');
  }, 120000);
});
