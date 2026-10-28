/**
 * A stand-in for the Figma Plugin API that behaves like the real one where plain JSON would hide a bug: pages must be loaded before their
 * children can be read, getters can throw, `figma.mixed` is a symbol, node types differ in which properties exist, and image bytes arrive
 * asynchronously. It is a fixture for tests, never a claim about how a real Figma file behaves.
 */
import { PNG } from 'pngjs';
type Props = Record<string, unknown>;

export class FakeNode {
  readonly type: string;
  readonly id: string;
  name: string;
  parent: FakeNode | null = null;
  readonly props = new Map<string, unknown>();
  readonly failing = new Map<string, Error>();
  readonly exports: { format: string; constraint?: { type: string; value: number } }[] = [];
  kids: FakeNode[] | undefined;
  loaded = true;
  /** Called with the property name on every read, so a test can edit the document while an export is reading it. */
  onRead?: (name: string) => void;

  constructor(type: string, id: string, name: string, props: Props = {}, kids?: FakeNode[]) {
    this.type = type; this.id = id; this.name = name;
    for (const [k, v] of Object.entries(props)) this.props.set(k, v);
    if (kids) this.kids = kids;
    if (type === 'PAGE') this.loaded = false;
    const proxy = new Proxy(this, {
      has: (t, key) => typeof key === 'string' && (key === 'children' ? !!t.kids : key in t || t.props.has(key)),
      get: (t, key, receiver) => {
        if (typeof key !== 'string') return Reflect.get(t, key, receiver);
        t.onRead?.(key);
        if (t.failing.has(key)) throw t.failing.get(key);
        if (key === 'children') {
          if (t.type === 'PAGE' && !t.loaded) throw new Error(`Cannot read children of page ${t.id}: it is not loaded (documentAccess is dynamic-page)`);
          return t.kids;
        }
        if (t.props.has(key)) return t.props.get(key);
        const v = Reflect.get(t, key, receiver);
        return typeof v === 'function' ? v.bind(receiver) : v;
      },
      // A write to one of the fixture's own fields (loaded, name, parent) stays on the fixture; any other write is a Figma property.
      set: (t, key, value) => { if (typeof key === 'string' && !(key in t)) t.props.set(key, value); else Reflect.set(t, key, value); return true; },
    }) as this;
    // Parents are the proxies, as in Figma: a child asks its parent for `children`, which a bare fixture object would not answer.
    for (const k of kids ?? []) k.parent = proxy;
    return proxy;
  }

  async loadAsync(): Promise<void> { await Promise.resolve(); this.loaded = true; }

  async getMainComponentAsync(): Promise<FakeNode | null> { await FakeFigma.current?.gate; const id = this.props.get('mainComponentId'); return id ? FakeFigma.current?.byId.get(String(id)) ?? null : null; }

  getStyledTextSegments(fields: string[]): unknown[] {
    const segments = (this.props.get('segments') as Props[] | undefined) ?? [];
    return segments.map((s) => ({ characters: s.characters, start: s.start, end: s.end, ...Object.fromEntries(fields.filter((f) => f in s).map((f) => [f, s[f]])) }));
  }

  async exportAsync(settings: { format: string; constraint?: { type: string; value: number } }): Promise<Uint8Array | string> {
    this.exports.push(settings);
    const fail = this.props.get('exportError');
    if (fail) throw new Error(String(fail));
    if (settings.format === 'SVG_STRING') return `<svg xmlns="http://www.w3.org/2000/svg" data-node="${this.id}"><path d="M0 0L10 10"/></svg>`;
    const scale = settings.constraint?.type === 'SCALE' ? settings.constraint.value : 1;
    const width = Math.max(1, Math.ceil(Number(this.props.get('width') ?? 16) * scale));
    const height = Math.max(1, Math.ceil(Number(this.props.get('height') ?? 16) * scale));
    const png = new PNG({ width, height });
    const color = [...this.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
    for (let i = 0; i < png.data.length; i += 4) { png.data[i] = color & 255; png.data[i + 1] = (color >>> 8) & 255; png.data[i + 2] = (color >>> 16) & 255; png.data[i + 3] = 255; }
    return PNG.sync.write(png);
  }
}

export interface FakeImage { hash: string; bytes: Uint8Array }

export class FakeFigma {
  static current: FakeFigma | undefined;
  readonly mixed = Symbol('figma.mixed');
  readonly root: FakeNode;
  currentPage: FakeNode;
  fileKey: string | undefined = 'FILEKEY1234567';
  editorType = 'figma';
  apiVersion = '1.0.0';
  skipInvisibleInstanceChildren = true;
  readonly byId = new Map<string, FakeNode>();
  readonly styles = new Map<string, Props & { id: string; type: string; name: string }>();
  readonly images = new Map<string, FakeImage>();
  readonly collections = new Map<string, Props & { id: string; variableIds: string[] }>();
  readonly variableMap = new Map<string, Props & { id: string }>();
  readonly listeners = new Map<string, Set<() => void>>();
  readonly posted: unknown[] = [];
  closeHandlers: (() => void)[] = [];
  uiHtml = '';
  /** Runs at every yield the plugin gives the UI; tests use it to edit the document or to count slices. */
  onTick?: () => void;
  /** While set, reading an instance waits for it: a test holds an export in the middle of reading, then lets it go. */
  gate: Promise<void> | undefined;

  constructor(name = 'Qualification', pages: FakeNode[] = []) {
    FakeFigma.current = this;
    this.root = new FakeNode('DOCUMENT', '0:0', name, {}, pages);
    this.currentPage = pages[0] ?? new FakeNode('PAGE', '0:1', 'Page 1', {}, []);
    this.register(this.root);
  }

  register(node: FakeNode): void {
    this.byId.set(node.id, node);
    for (const k of node.kids ?? []) this.register(k);
  }

  // --- the PluginAPI surface the exporter uses
  async loadAllPagesAsync(): Promise<void> { for (const p of this.root.kids ?? []) await p.loadAsync(); }
  async getNodeByIdAsync(id: string): Promise<FakeNode | null> { await Promise.resolve(); return this.byId.get(id) ?? null; }
  async getStyleByIdAsync(id: string): Promise<unknown> { await Promise.resolve(); return this.styles.get(id) ?? null; }
  async getLocalPaintStylesAsync(): Promise<unknown[]> { return [...this.styles.values()].filter((s) => s.type === 'PAINT'); }
  async getLocalTextStylesAsync(): Promise<unknown[]> { return [...this.styles.values()].filter((s) => s.type === 'TEXT'); }
  async getLocalEffectStylesAsync(): Promise<unknown[]> { return [...this.styles.values()].filter((s) => s.type === 'EFFECT'); }
  async getLocalGridStylesAsync(): Promise<unknown[]> { return [...this.styles.values()].filter((s) => s.type === 'GRID'); }
  getImageByHash(hash: string): { hash: string; getBytesAsync(): Promise<Uint8Array>; getSizeAsync(): Promise<{ width: number; height: number }> } | null {
    const img = this.images.get(hash);
    return img ? { hash, getBytesAsync: async () => img.bytes, getSizeAsync: async () => ({ width: 64, height: 32 }) } : null;
  }
  readonly variables = {
    getVariableByIdAsync: async (id: string) => this.variableMap.get(id) ?? null,
    getVariableCollectionByIdAsync: async (id: string) => this.collections.get(id) ?? null,
    getLocalVariableCollectionsAsync: async () => [...this.collections.values()],
  };
  on(type: string, fn: () => void): void { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn); if (type === 'close') this.closeHandlers.push(fn); }
  off(type: string, fn: () => void): void { this.listeners.get(type)?.delete(fn); }
  emit(type: string): void { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(); }
  showUI(html: string): void { this.uiHtml = html; }
  readonly ui: { postMessage: (m: unknown) => void; onmessage: ((m: unknown) => void) | undefined } = { postMessage: (m) => { this.posted.push(m); this.outbound?.(m); }, onmessage: undefined };
  outbound?: (message: unknown) => void;
}

// --- a document with enough variety to be worth reading

export interface Golden { figma: FakeFigma; frame: FakeNode; text: FakeNode; instance: FakeNode; vector: FakeNode; hidden: FakeNode; component: FakeNode; set: FakeNode; pages: FakeNode[]; pngHash: string }

const solid = (r: number, g: number, b: number) => ({ type: 'SOLID', color: { r, g, b }, opacity: 1, visible: true, blendMode: 'NORMAL' });

export function golden(opts: { extraNodes?: number } = {}): Golden {
  const pngHash = 'imghash0001';
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

  const text = new FakeNode('TEXT', '1:3', 'Tiêu đề <b>"đậm"</b> ```', {
    characters: 'Xin chào Figma', fontSize: 'MIXED', fontName: 'MIXED', textAlignHorizontal: 'LEFT', fills: [solid(0, 0, 0)], x: 8, y: 8, width: 120, height: 24, visible: true, locked: false, opacity: 1,
    segments: [
      { characters: 'Xin ', start: 0, end: 4, fontName: { family: 'Inter', style: 'Regular' }, fontSize: 14, fills: [solid(0, 0, 0)], textStyleId: '' },
      { characters: 'chào Figma', start: 4, end: 14, fontName: { family: 'Inter', style: 'Bold' }, fontSize: 18, fills: [solid(0.2, 0.2, 0.2)], textStyleId: 'S:2' },
    ],
  });
  const hidden = new FakeNode('RECTANGLE', '1:6', 'ẩn', { visible: false, locked: true, fills: [solid(1, 0, 0)], x: 0, y: 0, width: 10, height: 10, opacity: 1, cornerRadius: 0 });
  const vector = new FakeNode('VECTOR', '1:5', 'icon', { fills: [], strokes: [solid(0, 0, 0)], x: 1, y: 2, width: 16, height: 16, visible: true, locked: false, opacity: 1, vectorPaths: [{ windingRule: 'NONZERO', data: 'M0 0L10 10' }] });
  const variant1 = new FakeNode('COMPONENT', '2:1', 'Button, size=sm', { key: 'cmpkey1', description: 'nút nhỏ', variantProperties: { size: 'sm' }, fills: [], width: 80, height: 24, x: 0, y: 0, visible: true, opacity: 1 }, []);
  const variant2 = new FakeNode('COMPONENT', '2:2', 'Button, size=lg', { key: 'cmpkey2', description: '', variantProperties: { size: 'lg' }, fills: [], width: 120, height: 40, x: 100, y: 0, visible: true, opacity: 1 }, []);
  const set = new FakeNode('COMPONENT_SET', '2:0', 'Button', { key: 'setkey', description: 'bộ nút', componentPropertyDefinitions: { size: { type: 'VARIANT', defaultValue: 'sm', variantOptions: ['sm', 'lg'] } }, fills: [], width: 300, height: 100, x: 0, y: 0, visible: true, opacity: 1 }, [variant1, variant2]);
  const instance = new FakeNode('INSTANCE', '1:4', 'Button', { mainComponentId: '2:1', componentProperties: { size: { type: 'VARIANT', value: 'sm' } }, overrides: [{ id: '1:4', overriddenFields: ['name'] }], fills: [], x: 8, y: 40, width: 80, height: 24, visible: true, opacity: 1 }, [new FakeNode('TEXT', '1:7', 'nhãn', { characters: 'Gửi', fills: [], x: 0, y: 0, width: 40, height: 16, visible: true, opacity: 1, segments: [{ characters: 'Gửi', start: 0, end: 3, fontName: { family: 'Inter', style: 'Regular' }, fontSize: 12, fills: [], textStyleId: '' }] })]);
  const frame = new FakeNode('FRAME', '1:2', 'Màn hình <Đăng nhập>', {
    layoutMode: 'VERTICAL', itemSpacing: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16, primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'FIXED', minWidth: 0,
    fills: [solid(1, 1, 1), { type: 'IMAGE', imageHash: pngHash, scaleMode: 'FILL', visible: true, opacity: 1 }, { ...solid(0.5, 0.5, 0.5), boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' } } }],
    strokes: [], fillStyleId: 'S:1', cornerRadius: 12, x: 0, y: 0, width: 375, height: 812, visible: true, locked: false, opacity: 1, clipsContent: true,
    boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' } }, reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '3:1', navigation: 'NAVIGATE' }] }],
  }, [text, instance, vector, hidden]);
  for (let i = 0; i < (opts.extraNodes ?? 0); i++) frame.kids!.push(new FakeNode('RECTANGLE', `9:${i}`, `r${i}`, { visible: true, fills: [solid(i % 2, 0, 0)], x: i, y: 0, width: 4, height: 4, opacity: 1, cornerRadius: 0 }));
  for (const k of frame.kids!) k.parent = frame;
  const page1 = new FakeNode('PAGE', '0:1', 'Trang 1', { backgrounds: [solid(0.9, 0.9, 0.9)] }, [frame]);
  const page2 = new FakeNode('PAGE', '0:2', 'Thành phần', {}, [set]);
  const page3 = new FakeNode('PAGE', '0:3', 'Trống', {}, []);
  const pages = [page1, page2, page3];
  const figma = new FakeFigma('AI Department Exporter Qualification', pages);
  page1.loaded = true; figma.currentPage = page1;
  figma.images.set(pngHash, { hash: pngHash, bytes: png });
  figma.styles.set('S:1', { id: 'S:1', type: 'PAINT', name: 'Nền chính', key: 'stylekey1', description: '', remote: false, paints: [solid(1, 1, 1)] });
  figma.styles.set('S:2', { id: 'S:2', type: 'TEXT', name: 'Tiêu đề', key: 'stylekey2', description: '', remote: false, fontName: { family: 'Inter', style: 'Bold' }, fontSize: 18, letterSpacing: { value: 0, unit: 'PIXELS' }, lineHeight: { unit: 'AUTO' }, paragraphIndent: 0, paragraphSpacing: 0, textCase: 'ORIGINAL', textDecoration: 'NONE' });
  figma.collections.set('VariableCollectionId:1:0', { id: 'VariableCollectionId:1:0', name: 'Màu', key: 'colkey', remote: false, modes: [{ modeId: 'm:light', name: 'Sáng' }, { modeId: 'm:dark', name: 'Tối' }], defaultModeId: 'm:light', variableIds: ['VariableID:1:1', 'VariableID:1:2'] });
  figma.variableMap.set('VariableID:1:1', { id: 'VariableID:1:1', name: 'brand/primary', key: 'varkey1', variableCollectionId: 'VariableCollectionId:1:0', resolvedType: 'COLOR', remote: false, description: '', scopes: ['ALL_SCOPES'],
    valuesByMode: { 'm:light': { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' }, 'm:dark': { r: 0.1, g: 0.1, b: 0.9, a: 1 } } });
  figma.variableMap.set('VariableID:1:2', { id: 'VariableID:1:2', name: 'palette/blue', key: 'varkey2', variableCollectionId: 'VariableCollectionId:1:0', resolvedType: 'COLOR', remote: false, description: '', scopes: ['ALL_SCOPES'],
    valuesByMode: { 'm:light': { r: 0, g: 0.4, b: 1, a: 1 }, 'm:dark': { r: 0.4, g: 0.6, b: 1, a: 1 } } });
  figma.register(page1); figma.register(page2); figma.register(page3);
  // Figma reports `mixed` for properties that differ across a text range.
  text.props.set('fontSize', figma.mixed); text.props.set('fontName', figma.mixed);
  return { figma, frame, text, instance, vector, hidden, component: variant1, set, pages, pngHash };
}
