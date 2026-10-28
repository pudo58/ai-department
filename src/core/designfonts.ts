import type { FieldValue, NodeRecord } from '../shared/figma.js';
import type { FontFamilyResult, FontUse, FontVariant } from '../shared/fonts.js';

const STYLE_WEIGHTS: [RegExp, number][] = [[/thin|hairline/i, 100], [/extra ?light|ultra ?light/i, 200], [/light/i, 300], [/medium/i, 500], [/semi ?bold|demi ?bold/i, 600], [/extra ?bold|ultra ?bold/i, 800], [/black|heavy/i, 900], [/bold/i, 700], [/regular|normal|book/i, 400]];
/** Figma names a weight by its style ("SemiBold Italic"); CSS wants a number. */
export const styleWeight = (style: string | undefined): number | undefined => (style ? STYLE_WEIGHTS.find(([re]) => re.test(style))?.[1] : undefined);
export const isItalicStyle = (style: string | undefined): boolean => /italic|oblique/i.test(style ?? '');

/** The catalogue's id for a family: "Open Sans" is `open-sans`. */
export const fontsourceId = (family: string): string => family.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const read = (f: FieldValue | undefined): unknown => (f && (f.s === 'read' || f.s === 'mixed') ? f.v : undefined);
const fontOf = (v: unknown): { family: string; style: string } | undefined => {
  const o = v as { family?: unknown; style?: unknown } | null;
  return o && typeof o.family === 'string' && o.family.trim() ? { family: o.family.trim(), style: typeof o.style === 'string' ? o.style : '' } : undefined;
};

/**
 * The families, weights and italics the text nodes use. A node with one style gives its `text.fontName`; a node whose style changes inside
 * the text (mixed) gives its segments. A node whose font was not read contributes nothing rather than a guess.
 */
export function fontUses(nodes: Iterable<NodeRecord>): FontUse[] {
  const byFamily = new Map<string, { variants: Map<string, FontVariant>; nodes: number }>();
  const add = (font: { family: string; style: string }, weight: number | undefined) => {
    const entry = byFamily.get(font.family) ?? byFamily.set(font.family, { variants: new Map(), nodes: 0 }).get(font.family)!;
    const variant = { weight: weight ?? styleWeight(font.style) ?? 400, italic: isItalicStyle(font.style) };
    entry.variants.set(`${variant.weight}${variant.italic ? 'i' : ''}`, variant);
  };
  for (const n of nodes) {
    if (n.type !== 'TEXT') continue;
    const single = fontOf(read(n.fields['text.fontName'])), weight = n.fields['text.fontWeight'];
    const segments = read(n.fields['text.segments']);
    const seen = new Set<string>();
    if (single && n.fields['text.fontName']?.s === 'read') {
      add(single, weight?.s === 'read' && typeof weight.v === 'number' ? weight.v : undefined); seen.add(single.family);
    } else if (Array.isArray(segments)) {
      for (const s of segments) {
        const seg = s as { fontName?: unknown; fontWeight?: unknown } | null, font = fontOf(seg?.fontName);
        if (font) { add(font, typeof seg?.fontWeight === 'number' ? seg.fontWeight : undefined); seen.add(font.family); }
      }
    }
    for (const family of seen) byFamily.get(family)!.nodes++;
  }
  return [...byFamily].map(([family, e]) => ({ family, variants: [...e.variants.values()].sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic)), nodes: e.nodes })).sort((a, b) => b.nodes - a.nodes || (a.family < b.family ? -1 : 1));
}

/** Ready-made @font-face rules for the files that were fetched: the Developer copies the folder and links this file, nothing to work out. */
export function fontFaceCss(families: readonly FontFamilyResult[]): string {
  const out: string[] = ['/* Font mở lấy từ kho fontsource (qua jsDelivr). Giấy phép ghi bên dưới từng họ font; giữ nguyên khi đưa vào dự án. */'];
  for (const f of families) {
    if (f.status !== 'ready') continue;
    out.push(`\n/* ${f.family} · ${f.license ?? 'giấy phép không rõ'} · @fontsource/${f.id}@${f.version} */`);
    for (const file of [...f.files].sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic) || (a.subset < b.subset ? -1 : 1))) {
      const range = f.unicodeRange?.[file.subset];
      out.push(`@font-face {\n  font-family: '${f.family.replace(/'/g, '')}';\n  font-style: ${file.italic ? 'italic' : 'normal'};\n  font-weight: ${file.weight};\n  font-display: swap;\n  src: url('./${file.name}') format('woff2');${range ? `\n  unicode-range: ${range};` : ''}\n}`);
    }
  }
  return `${out.join('\n')}\n`;
}
