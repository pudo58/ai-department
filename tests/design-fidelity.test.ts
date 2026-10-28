import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { changedInBox } from '../src/core/visual.js';
import { DOM_TEXT_SCRIPT, compareText, describeMismatch, fidelityProblems, figmaTextRuns, type DomTextRun, type FigmaTextRun } from '../src/core/designtext.js';
import { designBuildRules } from '../src/core/design.js';
import { visualProfileHash, visualProfileOf } from '../src/core/visualevidence.js';
import { DEFAULT_VISUAL_PROFILE, type VisualReport } from '../src/shared/visual.js';
import type { FieldValue, NodeRecord } from '../src/shared/figma.js';
import type { Run } from '../src/shared/types.js';
import { green, setupLegacy } from './helpers.js';

const read = (v: unknown): FieldValue => ({ s: 'read', v: v as never });
const node = (id: string, type: string, parentId: string | null, fields: Record<string, FieldValue>): NodeRecord => ({ k: 'node', id, type, name: `n${id}`, pageId: '0:1', parentId, index: 0, depth: 0, childIds: [], groups: {}, fields, hash: '' });
const text = (id: string, parentId: string, characters: string, extra: Record<string, FieldValue> = {}) => node(id, 'TEXT', parentId, {
  'text.characters': read(characters), 'text.fontSize': read(16), 'text.fontName': read({ family: 'Roboto', style: 'Regular' }),
  'text.lineHeight': read({ unit: 'PIXELS', value: 24 }), 'text.letterSpacing': read({ unit: 'PIXELS', value: 0 }),
  'common.absoluteBoundingBox': read({ x: 110, y: 220, width: 80, height: 24 }), ...extra,
});
const screen = node('1:2', 'FRAME', null, { 'common.absoluteBoundingBox': read({ x: 100, y: 200, width: 1920, height: 1080 }) });
const dom = (over: Partial<DomTextRun> = {}): DomTextRun => ({ text: 'Tìm kiếm', x: 10, y: 20, width: 80, height: 24, family: 'Roboto, sans-serif', size: 16, weight: 400, lineHeight: 24, letterSpacing: 0, fontAvailable: true, ...over });

describe('the text of a screen in Figma', () => {
  it('reads visible text nodes with their typography and positions relative to the screen, and never guesses a mixed field', () => {
    const runs = figmaTextRuns([
      screen,
      text('1:3', '1:2', 'Tìm kiếm', { 'text.lineHeight': read({ unit: 'PERCENT', value: 150 }), 'text.letterSpacing': read({ unit: 'PERCENT', value: 5 }) }),
      text('1:4', '1:2', 'Ẩn', { 'common.visible': read(false) }),
      text('1:5', '1:2', '   '),
      text('1:6', '1:2', 'Nhiều kiểu', { 'text.fontSize': { s: 'mixed', v: null } }),
      node('1:7', 'FRAME', '1:2', { 'common.visible': read(false) }), text('1:8', '1:7', 'Trong khung ẩn'),
    ], screen);
    expect(runs.map((r) => r.nodeId)).toEqual(['1:3', '1:6']);
    expect(runs[0]).toMatchObject({ text: 'Tìm kiếm', fontSize: 16, family: 'Roboto', weight: 400, lineHeightPx: 24, letterSpacingPx: 0.8, box: { x: 10, y: 20, width: 80, height: 24 } });
    expect(runs[1]!.fontSize).toBeUndefined();
  });
  it('reads a weight from the style name when the plugin gave none', () => {
    const [run] = figmaTextRuns([screen, text('1:3', '1:2', 'Đậm', { 'text.fontName': read({ family: 'Roboto', style: 'Medium' }) })], screen);
    expect(run!.weight).toBe(500);
  });
});

describe('comparing it with the text the page renders', () => {
  const figma = (over: Partial<FigmaTextRun> = {}): FigmaTextRun => ({ nodeId: '1:3', name: 't', text: 'Tìm kiếm', fontSize: 16, family: 'Roboto', weight: 400, lineHeightPx: 24, letterSpacingPx: 0, box: { x: 10, y: 20, width: 80, height: 24 }, ...over });

  it('has nothing to say about a page that matches, whatever the case or the spacing of its text', () => {
    expect(compareText([figma()], [dom({ text: '  TÌM  KIẾM ' })])).toMatchObject({ figmaTexts: 1, matched: 1, mismatches: [], omitted: 0 });
  });
  it('finds the number a pixel ratio cannot: another count, another label, a missing line', () => {
    const check = compareText([figma({ text: '25 trường' }), figma({ nodeId: '1:4', text: 'xxx.xlsx' })], [dom({ text: '8 trường' })]);
    expect(check.mismatches.map((m) => [m.kind, m.text])).toEqual([['missing_text', '25 trường'], ['missing_text', 'xxx.xlsx']]);
  });
  it('finds a size, weight, line-height, letter-spacing and position that are off, and says both values', () => {
    const check = compareText([figma({ letterSpacingPx: 0.5 })], [dom({ size: 14, weight: 500, lineHeight: 20, letterSpacing: 0, x: 30, y: 40 })]);
    expect(check.mismatches.map((m) => m.kind)).toEqual(['font_size', 'font_weight', 'line_height', 'letter_spacing', 'position']);
    expect(describeMismatch(check.mismatches[0]!)).toContain('Figma 16px, trang 14px');
  });
  it('tolerates what rounding makes: half a pixel of size, a pixel of line-height, a few pixels of position', () => {
    expect(compareText([figma()], [dom({ size: 16.4, lineHeight: 24.8, x: 13, y: 22 })]).mismatches).toEqual([]);
  });
  it('tells a font that did not load from a font that is named wrongly, and a font that is named right', () => {
    expect(compareText([figma()], [dom({ fontAvailable: false })]).mismatches[0]).toMatchObject({ kind: 'font_unavailable', expected: 'Roboto' });
    expect(compareText([figma()], [dom({ family: '"Inter", sans-serif' })]).mismatches[0]).toMatchObject({ kind: 'font_family', actual: 'inter' });
    expect(compareText([figma()], [dom({ family: '"Roboto", sans-serif' })]).mismatches).toEqual([]);
  });
  it('does not compare the box of an input or of a widget capture, only its text', () => {
    expect(compareText([figma()], [dom({ approx: true, x: 500, y: 500 })]).mismatches).toEqual([]);
    expect(compareText([figma()], [dom({ x: 500, y: 500 })], { position: false }).mismatches).toEqual([]);
  });
  it('pairs each Figma text with its own copy on the page, so seven equal labels are seven checks', () => {
    const labels = [0, 1, 2].map((i) => figma({ nodeId: `1:${10 + i}`, text: 'STATUS', box: { x: 10, y: 20 + i * 56, width: 80, height: 24 } }));
    const page = [0, 1, 2].map((i) => dom({ text: 'STATUS', y: 20 + i * 56 }));
    expect(compareText(labels, page).mismatches).toEqual([]);
    expect(compareText(labels, page.slice(0, 2)).matched).toBe(3); // the last one is matched against a copy already used, not reported as missing
  });
  it('lists at most 24 and says how many it left out', () => {
    const many = Array.from({ length: 30 }, (_, i) => figma({ nodeId: `1:${i}`, text: `chữ ${i}` }));
    const check = compareText(many, []);
    expect(check.mismatches).toHaveLength(24); expect(check.omitted).toBe(6);
  });
  it('ships a script that is plain text for the page, not a function a bundler could change', () => {
    expect(typeof DOM_TEXT_SCRIPT).toBe('string');
    expect(() => new Function(`return ${DOM_TEXT_SCRIPT}`)).not.toThrow();
  });
});

describe('what goes back to the Developer', () => {
  const report = (screens: VisualReport['screens']): VisualReport => ({ schemaVersion: 1, source: 'harness', id: `vis_${'a'.repeat(32)}`, runId: 'run_x', checkpoint: 'c'.repeat(40), slot: 'A', contractVersion: 1, snapshotId: 'dsn_aaaaaaaaaaaa', snapshotHash: 'a'.repeat(64), profileHash: 'h', profile: DEFAULT_VISUAL_PROFILE, status: 'needs_review', startedAt: '', endedAt: '', limitations: [], artifactDir: 'C:/v', screens });
  const s = (over: Partial<VisualReport['screens'][number]>): VisualReport['screens'][number] => ({ nodeId: '1:2', name: 'Import', route: '/?screen=1%3A2', width: 1920, height: 1080, status: 'passed', message: '', ...over });

  it('names a screen that differs, how much, and every text and font that does not match', () => {
    const [problem] = fidelityProblems(report([s({ status: 'different', changedRatio: 0.0731, diff: 'screen-1-2-diff.png', text: { figmaTexts: 20, matched: 19, omitted: 0, mismatches: [{ kind: 'missing_text', nodeId: '1:9', text: '25 trường', expected: '25 trường', actual: 'không thấy trên trang' }, { kind: 'font_unavailable', nodeId: '1:3', text: 'Import', expected: 'Roboto', actual: 'roboto không tải được' }] } })]));
    expect(problem).toContain('Import'); expect(problem).toContain('7.3%'); expect(problem).toContain('ngưỡng 5.0%');
    expect(problem).toContain('"25 trường"'); expect(problem).toContain('font không tải được'); expect(problem).toContain('2/20');
    expect(problem).toContain('C:/v/screen-1-2-diff.png');
  });
  it('asks for the route when a screen could not be opened, and for a still page when it moves', () => {
    const problems = fidelityProblems(report([s({ status: 'incomplete', message: 'Màn hình trả HTTP 404.' }), s({ nodeId: '1:3', status: 'unstable' })]));
    expect(problems[0]).toContain('HTTP 404'); expect(problems[0]).toContain('[data-design-ready="true"]');
    expect(problems[1]).toContain('ổn định');
  });
  it('says nothing about screens that pass or that only need a person to look', () => {
    expect(fidelityProblems(report([s({}), s({ nodeId: '1:3', status: 'needs_review' })]))).toEqual([]);
  });
});

describe('the profile a task is measured with', () => {
  const run = (over: Record<string, unknown> = {}, design = true, provider = 'codex') => {
    const e = setupLegacy({ check: () => green }, { executionMode: 'local', ...over });
    const r = e.create({ provider: provider as never }) as Run;
    if (design) r.contract.design = { snapshotId: 'dsn_aaaaaaaaaaaa', snapshotHash: 'a'.repeat(64), targetIds: [], acknowledgedIssueIds: [], designPolicyVersion: 1 };
    return r;
  };
  it('is the default for a design-bound task on a local runtime whose project set nothing', () => {
    expect(visualProfileOf(run())).toEqual(DEFAULT_VISUAL_PROFILE);
    expect(DEFAULT_VISUAL_PROFILE.maxDiffRatio).toBe(0.05);
  });
  it('is the project\'s own when it has one, and nothing when the project turned the check off', () => {
    const own = { pathTemplate: '/?state={nodeId}', pixelThreshold: 0.2 };
    expect(visualProfileOf(run({ visualCheck: own }))).toEqual(own);
    expect(visualProfileOf(run({ visualCheck: null }))).toBeUndefined();
  });
  it('is nothing without a design, on Docker, or for a simulated run', () => {
    expect(visualProfileOf(run({}, false))).toBeUndefined();
    expect(visualProfileOf(run({ executionMode: 'docker' }))).toBeUndefined();
    expect(visualProfileOf(run({}, true, 'fake'))).toBeUndefined();
  });
  it('hashes to something stable so a report made with the default is recognised on the next read', () => {
    expect(visualProfileHash(DEFAULT_VISUAL_PROFILE)).toBe(visualProfileHash({ ...DEFAULT_VISUAL_PROFILE }));
  });
});

describe('what the Developer is told about matching a design', () => {
  it('covers fonts, the exported icons, measured numbers, the text, a route per screen with its ready marker, and a self-check', () => {
    const rules = designBuildRules(DEFAULT_VISUAL_PROFILE);
    for (const part of ['@font-face', 'assets/', 'nodes.ndjson', 'placeholder', '`/?screen={nodeId}`', '`[data-design-ready="true"]`', 'Tự so trước khi bàn giao']) expect(rules).toContain(part);
  });
  it('asks for a route per screen even when no profile is set', () => {
    expect(designBuildRules()).toContain('route riêng');
  });
});

const BROWSER = [chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
describe.skipIf(!BROWSER)('the script in a real browser', () => {
  it('reads sizes, weights and boxes, tells a font that is not there, joins inline pieces, and leaves hidden text out', async () => {
    const browser = await chromium.launch({ headless: true, executablePath: BROWSER, timeout: 30000 });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(`<body style="margin:0;font-family:Arial">
        <h1 style="margin:10px 20px;font:700 24px/32px Arial">Tiêu đề lớn</h1>
        <p style="position:absolute;left:100px;top:100px;margin:0;font:16px/24px 'NoSuchFontXYZ',serif">Chữ font lạ</p>
        <div style="position:absolute;left:50px;top:200px;font:14px/20px Arial">8 <b>trường</b></div>
        <input style="position:absolute;left:50px;top:250px" placeholder="Nhập tên cột"><select style="position:absolute;left:50px;top:330px"><option>STRING</option></select>
        <span style="display:none">ẩn</span><span style="visibility:hidden">tàng hình</span></body>`);
      const runs = await page.evaluate(DOM_TEXT_SCRIPT) as DomTextRun[];
      const by = (t: string) => runs.find((r) => r.text === t)!;
      expect(by('Tiêu đề lớn')).toMatchObject({ size: 24, weight: 700, lineHeight: 32, fontAvailable: true, x: 20 });
      expect(by('Chữ font lạ')).toMatchObject({ size: 16, fontAvailable: false });
      expect(by('8 trường')).toMatchObject({ x: 50, size: 14 });
      expect(by('Nhập tên cột').approx).toBe(true); expect(by('STRING').approx).toBe(true);
      expect(runs.some((r) => /ẩn|tàng/.test(r.text))).toBe(false);
      const figma: FigmaTextRun = { nodeId: '1:3', name: 'a', text: 'Chữ font lạ', fontSize: 16, family: 'Roboto', box: { x: 100, y: 100, width: 80, height: 24 } };
      expect(compareText([figma], runs).mismatches.map((m) => m.kind)).toEqual(['font_unavailable']);
      expect(compareText([{ ...figma, text: '8 trường', family: 'Arial', fontSize: 14, box: { x: 50, y: 200, width: 60, height: 20 } }], runs).mismatches).toEqual([]);
    } finally { await browser.close(); }
  }, 60000);
});

describe('text that looks the same in both images', () => {
  const figma = (id: string, x: number): FigmaTextRun => ({ nodeId: id, name: 't', text: 'Hành động', fontSize: 14, box: { x, y: 10, width: 60, height: 14 } });
  it('is left out of the comparison, and the result says how many were', () => {
    const covered = figma('1:1', 500), visible = figma('1:2', 10);
    const check = compareText([covered, visible], [dom({ text: 'Hành động', x: 10, y: 10, height: 14, size: 14 })], { differs: (f) => f.nodeId === '1:2' });
    expect(check).toMatchObject({ figmaTexts: 1, matched: 1, mismatches: [], unchanged: 1 });
    expect(compareText([covered, visible], [dom({ text: 'Hành động', x: 10, y: 10, height: 14, size: 14 })]).mismatches.length).toBeGreaterThan(0);
  });
  it('is measured in the diff image: the share of pixels marked changed inside the box, at the capture scale', () => {
    const diff = new PNG({ width: 20, height: 10 });
    for (let i = 0; i < 20 * 10; i++) diff.data.set([10, 10, 10, 100], i * 4);
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) diff.data.set([230, 0, 150, 255], (y * 20 + x) * 4);
    expect(changedInBox(diff, { x: 0, y: 0, width: 10, height: 10 }, 1)).toBe(1);
    expect(changedInBox(diff, { x: 10, y: 0, width: 10, height: 10 }, 1)).toBe(0);
    expect(changedInBox(diff, { x: 0, y: 0, width: 20, height: 10 }, 1)).toBe(0.5);
    expect(changedInBox(diff, { x: 0, y: 0, width: 5, height: 5 }, 2)).toBe(1);
    expect(changedInBox(diff, { x: 100, y: 100, width: 5, height: 5 }, 1)).toBe(0);
  });
});
