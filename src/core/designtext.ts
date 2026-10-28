import type { NodeRecord } from '../shared/figma.js';
import type { TextCheck, TextMismatch, VisualReport } from '../shared/visual.js';
import { styleWeight } from './designfonts.js';

/**
 * What the Figma text nodes of one screen say about their text, set against what the running page really renders.
 * A pixel ratio cannot tell "25 trường" from "8 trường" or a fallback font from Roboto: both are a few pixels. This can.
 */
export interface FigmaTextRun {
  nodeId: string; name: string; text: string;
  fontSize?: number; family?: string; weight?: number; lineHeightPx?: number; letterSpacingPx?: number;
  /** Tight bounds relative to the screen frame, when the snapshot has them. */
  box?: { x: number; y: number; width: number; height: number };
}
export interface DomTextRun {
  text: string; x: number; y: number; width: number; height: number;
  family: string; size: number; weight: number; lineHeight: number | null; letterSpacing: number;
  fontAvailable: boolean;
  /** Inputs and selects: the text box is a guess, so only the text and its typography are compared. */
  approx?: boolean;
}

const TOLERANCE = { fontSize: 0.5, lineHeight: 1, letterSpacing: 0.3, position: 4 };
const MAX_MISMATCHES = 24;
const MAX_PROBLEMS = 8;

const field = (node: NodeRecord, key: string): unknown => { const f = node.fields[key]; return f && f.s === 'read' ? f.v : undefined; };
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const box = (v: unknown): { x: number; y: number; width: number; height: number } | undefined => {
  const o = v as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
  return o && num(o.x) !== undefined && num(o.y) !== undefined && num(o.width) !== undefined && num(o.height) !== undefined ? { x: o.x as number, y: o.y as number, width: o.width as number, height: o.height as number } : undefined;
};
const weightOf = (node: NodeRecord, style: string | undefined): number | undefined => num(field(node, 'text.fontWeight')) ?? styleWeight(style);
const unitPx = (v: unknown, fontSize: number | undefined): number | undefined => {
  const o = v as { unit?: string; value?: unknown } | null, value = num(o?.value);
  if (!o || value === undefined) return undefined;
  if (o.unit === 'PIXELS') return value;
  if (o.unit === 'PERCENT' && fontSize !== undefined) return (value / 100) * fontSize;
  return undefined;
};

/** The visible text nodes under a screen, with the typography the plugin read. A mixed or unread field is left out, never guessed. */
export function figmaTextRuns(nodes: readonly NodeRecord[], screen: NodeRecord): FigmaTextRun[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hidden = (n: NodeRecord): boolean => { for (let at: NodeRecord | undefined = n; at; at = at.parentId ? byId.get(at.parentId) : undefined) if (field(at, 'common.visible') === false) return true; return false; };
  const origin = box(field(screen, 'common.absoluteBoundingBox'));
  const out: FigmaTextRun[] = [];
  for (const n of nodes) {
    if (n.type !== 'TEXT' || hidden(n)) continue;
    const text = field(n, 'text.characters');
    if (typeof text !== 'string' || !normalize(text)) continue;
    const fontSize = num(field(n, 'text.fontSize'));
    const font = field(n, 'text.fontName') as { family?: unknown; style?: unknown } | null;
    const family = typeof font?.family === 'string' ? font.family : undefined;
    const bounds = box(field(n, 'common.absoluteRenderBounds')) ?? box(field(n, 'common.absoluteBoundingBox'));
    out.push({
      nodeId: n.id, name: n.name, text, ...(fontSize !== undefined ? { fontSize } : {}), ...(family ? { family } : {}),
      ...(weightOf(n, typeof font?.style === 'string' ? font.style : undefined) !== undefined ? { weight: weightOf(n, typeof font?.style === 'string' ? font.style : undefined)! } : {}),
      ...(unitPx(field(n, 'text.lineHeight'), fontSize) !== undefined ? { lineHeightPx: unitPx(field(n, 'text.lineHeight'), fontSize)! } : {}),
      ...(unitPx(field(n, 'text.letterSpacing'), fontSize) !== undefined ? { letterSpacingPx: unitPx(field(n, 'text.letterSpacing'), fontSize)! } : {}),
      ...(bounds && origin ? { box: { x: bounds.x - origin.x, y: bounds.y - origin.y, width: bounds.width, height: bounds.height } } : {}),
    });
  }
  return out;
}

const normalize = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const fmt = (n: number): string => `${Math.round(n * 100) / 100}`;
const firstFamily = (css: string): string => (css.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();

/** Compare the two sides. `position` is skipped when the page was captured as a widget, where the frame origin is not the viewport. */
export function compareText(all: readonly FigmaTextRun[], dom: readonly DomTextRun[], options: { position?: boolean; differs?: (f: FigmaTextRun) => boolean } = {}): TextCheck {
  // A text that looks the same in both images is not a finding: Figma lists text that another layer covers, and the page need not draw it.
  const figma = options.differs ? all.filter((f) => options.differs!(f)) : all;
  const found: TextMismatch[] = [], used = new Set<DomTextRun>();
  let matched = 0;
  for (const f of figma) {
    const want = normalize(f.text);
    const exact = dom.filter((d) => normalize(d.text) === want);
    const pool = exact.filter((d) => !used.has(d));
    const near = (list: DomTextRun[]) => (f.box ? [...list].sort((a, b) => dist(a, f) - dist(b, f))[0] : list[0]);
    const d = near(pool.length ? pool : exact);
    if (!d) {
      if (want.length >= 3 && dom.some((x) => normalize(x.text).includes(want))) { matched++; continue; }
      found.push({ kind: 'missing_text', nodeId: f.nodeId, text: f.text, expected: f.text, actual: 'không thấy trên trang' });
      continue;
    }
    used.add(d); matched++;
    const add = (kind: TextMismatch['kind'], expected: string, actual: string) => found.push({ kind, nodeId: f.nodeId, text: f.text, expected, actual });
    if (f.family && !d.fontAvailable) add('font_unavailable', f.family, `${firstFamily(d.family) || d.family} không tải được, trình duyệt dùng font thay thế`);
    else if (f.family && firstFamily(d.family) !== f.family.toLowerCase()) add('font_family', f.family, firstFamily(d.family) || d.family);
    if (f.fontSize !== undefined && Math.abs(d.size - f.fontSize) > TOLERANCE.fontSize) add('font_size', `${fmt(f.fontSize)}px`, `${fmt(d.size)}px`);
    if (f.weight !== undefined && Math.abs(d.weight - f.weight) >= 100) add('font_weight', `${f.weight}`, `${d.weight}`);
    if (f.lineHeightPx !== undefined && (d.lineHeight === null || Math.abs(d.lineHeight - f.lineHeightPx) > TOLERANCE.lineHeight)) add('line_height', `${fmt(f.lineHeightPx)}px`, d.lineHeight === null ? 'normal' : `${fmt(d.lineHeight)}px`);
    if (f.letterSpacingPx !== undefined && Math.abs(d.letterSpacing - f.letterSpacingPx) > TOLERANCE.letterSpacing) add('letter_spacing', `${fmt(f.letterSpacingPx)}px`, `${fmt(d.letterSpacing)}px`);
    if (options.position !== false && f.box && !d.approx) {
      const dx = d.x - f.box.x, dy = d.y + d.height / 2 - (f.box.y + f.box.height / 2);
      if (Math.abs(dx) > TOLERANCE.position || Math.abs(dy) > TOLERANCE.position) add('position', `x=${fmt(f.box.x)}, giữa dòng y=${fmt(f.box.y + f.box.height / 2)}`, `x=${fmt(d.x)}, giữa dòng y=${fmt(d.y + d.height / 2)}`);
    }
  }
  return { figmaTexts: figma.length, matched, mismatches: found.slice(0, MAX_MISMATCHES), omitted: Math.max(0, found.length - MAX_MISMATCHES), ...(figma.length < all.length ? { unchanged: all.length - figma.length } : {}) };
}
const dist = (d: DomTextRun, f: FigmaTextRun): number => (f.box ? Math.hypot(d.x - f.box.x, d.y + d.height / 2 - (f.box.y + f.box.height / 2)) : 0);

const LABEL: Record<TextMismatch['kind'], string> = {
  missing_text: 'thiếu/sai chữ', font_unavailable: 'font không tải được', font_family: 'sai font', font_size: 'sai cỡ chữ', font_weight: 'sai độ đậm',
  line_height: 'sai line-height', letter_spacing: 'sai letter-spacing', position: 'lệch vị trí',
};
export const describeMismatch = (m: TextMismatch): string => `"${m.text.replace(/\s+/g, ' ').slice(0, 40)}" (node ${m.nodeId}): ${LABEL[m.kind]}, Figma ${m.expected}, trang ${m.actual}`;

/**
 * What a Developer can act on after a visual report. Only screens the harness measured and found different, could not open, or found
 * unstable count; a missing browser or a missing start command is the environment's problem and is not put on the Developer.
 */
export function fidelityProblems(report: VisualReport): string[] {
  const max = report.profile.maxDiffRatio, out: string[] = [];
  for (const s of report.screens) {
    const where = `Màn "${s.name}" (node ${s.nodeId}, route ${s.route})`;
    if (s.status === 'incomplete') out.push(`${where} chưa chụp hoặc đo được: ${s.message} Ứng dụng phải mở được route này${report.profile.readySelector ? ` và đặt ${report.profile.readySelector} khi đã sẵn sàng` : ''}.`);
    else if (s.status === 'unstable') out.push(`${where}: ba lần tải cho ảnh khác nhau (animation, dữ liệu ngẫu nhiên hoặc ảnh chưa tải xong). Làm màn hình ổn định để so được.`);
    else if (s.status === 'different') {
      const parts = [`${where} khác thiết kế.`];
      if (s.changedRatio !== undefined) parts.push(`Lệch ${(s.changedRatio * 100).toFixed(1)}% pixel${max !== undefined ? ` (ngưỡng ${(max * 100).toFixed(1)}%)` : ''}.`);
      if (s.status === 'different' && s.changedRatio === undefined) parts.push(s.message);
      const list = (s.text?.mismatches ?? []).slice(0, 8).map((m) => `- ${describeMismatch(m)}`);
      if (list.length) parts.push(`Chữ và kiểu chữ không khớp ${s.text!.mismatches.length + s.text!.omitted}/${s.text!.figmaTexts} đoạn:\n${list.join('\n')}`);
      if (s.diff && report.artifactDir) parts.push(`Ảnh so sánh nếu đọc được: ${report.artifactDir}/${s.diff}`);
      out.push(parts.join(' '));
    }
  }
  return out.length > MAX_PROBLEMS ? [...out.slice(0, MAX_PROBLEMS), `… còn ${out.length - MAX_PROBLEMS} màn khác cũng chưa khớp; xem report hình ảnh của run.`] : out;
}

/**
 * Evaluated in the page. A string, not a function: a bundler's helpers must not be injected into code that runs in the browser.
 * Text nodes become runs; an input or select contributes its value or placeholder with a guessed box.
 */
export const DOM_TEXT_SCRIPT = `(() => {
  const out = [];
  const GENERIC = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace'];
  const cache = new Map();
  const ctx = document.createElement('canvas').getContext('2d');
  const probe = 'mmmmmmmmmmlliWW 0123';
  const width = (font) => { ctx.font = '72px ' + font; return ctx.measureText(probe).width; };
  const available = (family) => {
    if (!family || GENERIC.includes(family.toLowerCase())) return true;
    if (cache.has(family)) return cache.get(family);
    const quoted = '"' + family.replace(/"/g, '') + '"';
    const ok = width(quoted + ', monospace') !== width('monospace') || width(quoted + ', serif') !== width('serif');
    cache.set(family, ok); return ok;
  };
  const describe = (el, text, rect, approx) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;
    if (rect.width <= 0 || rect.height <= 0) return;
    const family = (cs.fontFamily.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
    const lh = parseFloat(cs.lineHeight);
    const ls = parseFloat(cs.letterSpacing);
    out.push({ text, x: rect.left, y: rect.top, width: rect.width, height: rect.height, family: cs.fontFamily, size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400, lineHeight: Number.isFinite(lh) ? lh : null, letterSpacing: Number.isFinite(ls) ? ls : 0, fontAvailable: available(family), ...(approx ? { approx: true } : {}) });
  };
  for (const el of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName)) continue;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.type === 'hidden') continue;
      const text = el.value || el.placeholder || '';
      if (text.trim()) describe(el, text, el.getBoundingClientRect(), true);
      continue;
    }
    if (el.tagName === 'SELECT') {
      const text = el.selectedOptions[0] ? el.selectedOptions[0].textContent || '' : '';
      if (text.trim()) describe(el, text, el.getBoundingClientRect(), true);
      continue;
    }
    const nodes = [...el.childNodes].filter((n) => n.nodeType === 3 && n.data.trim());
    if (!nodes.length) continue;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const n of nodes) {
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) { if (r.width <= 0 || r.height <= 0) continue; left = Math.min(left, r.left); top = Math.min(top, r.top); right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom); }
    }
    if (left === Infinity) continue;
    describe(el, nodes.map((n) => n.data).join(' '), { left, top, width: right - left, height: bottom - top }, false);
    // "8 <b>trường</b>" is one text node in Figma: the whole element is a run as well, next to its pieces.
    if ([...el.children].some((c) => getComputedStyle(c).display.startsWith('inline'))) {
      const all = document.createRange(); all.selectNodeContents(el);
      let l = Infinity, t = Infinity, rr = -Infinity, bb = -Infinity;
      for (const r of all.getClientRects()) { if (r.width <= 0 || r.height <= 0) continue; l = Math.min(l, r.left); t = Math.min(t, r.top); rr = Math.max(rr, r.right); bb = Math.max(bb, r.bottom); }
      const whole = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (l !== Infinity && whole) describe(el, whole, { left: l, top: t, width: rr - l, height: bb - t }, false);
    }
  }
  return out;
})()`;
