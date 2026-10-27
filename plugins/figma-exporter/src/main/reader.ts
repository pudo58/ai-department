import { APPLICABLE_GROUPS, isKnownNodeType, type FieldGroup, type FieldValue, type GroupStatus, type Json } from '../../../../src/shared/figma.js';
import { fieldError, fieldMixed, fieldNA, fieldRead, fieldUnavailable, toJson } from './serialize.js';

/** What a node refers to outside itself, collected while its fields are read and resolved afterwards. */
export class References {
  readonly styles = new Map<string, Set<string>>();
  readonly variables = new Map<string, Set<string>>();
  readonly components = new Map<string, Set<string>>();
  readonly images = new Map<string, { nodeId: string; field: string }[]>();
  style(id: unknown, by: string): void { if (typeof id === 'string' && id) (this.styles.get(id) ?? this.styles.set(id, new Set()).get(id)!).add(by); }
  variable(id: unknown, by: string): void { if (typeof id === 'string' && id) (this.variables.get(id) ?? this.variables.set(id, new Set()).get(id)!).add(by); }
  component(id: unknown, by: string): void { if (typeof id === 'string' && id) (this.components.get(id) ?? this.components.set(id, new Set()).get(id)!).add(by); }
  image(hash: unknown, nodeId: string, field: string): void { if (typeof hash === 'string' && hash) (this.images.get(hash) ?? this.images.set(hash, []).get(hash)!).push({ nodeId, field }); }
}

export interface ReaderContext { mixed: unknown; refs: References }
export interface NodeFields { fields: Record<string, FieldValue>; groups: Partial<Record<FieldGroup, GroupStatus>> }

// The properties each group reads. A property the node does not have is `not_applicable`, never a guessed default.
const COMMON = ['name', 'visible', 'locked', 'opacity', 'blendMode', 'isMask', 'maskType', 'rotation', 'x', 'y', 'width', 'height', 'relativeTransform', 'absoluteTransform', 'absoluteBoundingBox', 'absoluteRenderBounds', 'clipsContent', 'exportSettings', 'description', 'flowStartingPoints'];
const LAYOUT = ['layoutMode', 'layoutWrap', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'counterAxisAlignContent', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'itemSpacing', 'counterAxisSpacing', 'itemReverseZIndex', 'strokesIncludedInLayout', 'layoutPositioning', 'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutGrow', 'layoutAlign', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'constraints', 'layoutGrids', 'gridRowCount', 'gridColumnCount', 'gridRowGap', 'gridColumnGap'];
const PAINT = ['fills', 'strokes', 'strokeWeight', 'strokeAlign', 'strokeCap', 'strokeJoin', 'strokeMiterLimit', 'dashPattern', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'cornerRadius', 'cornerSmoothing', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'effects'];
const TEXT = ['characters', 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'textTruncation', 'maxLines', 'paragraphSpacing', 'paragraphIndent', 'leadingTrim', 'hasMissingFont', 'fontName', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'textStyleId', 'listSpacing', 'hangingPunctuation', 'hangingList'];
const TEXT_SEGMENT_FIELDS = ['fontName', 'fontSize', 'fontWeight', 'textDecoration', 'textCase', 'lineHeight', 'letterSpacing', 'fills', 'textStyleId', 'fillStyleId', 'listOptions', 'indentation', 'hyperlink', 'boundVariables'];
const COMPONENT = ['key', 'description', 'descriptionMarkdown', 'documentationLinks', 'componentPropertyDefinitions', 'variantProperties', 'remote'];
const INSTANCE = ['componentProperties', 'overrides', 'isExposedInstance', 'exposedInstances', 'scaleFactor'];
const VECTOR = ['vectorPaths', 'vectorNetwork', 'fillGeometry', 'strokeGeometry', 'booleanOperation', 'arcData', 'pointCount', 'innerRadius'];
const PROTOTYPE = ['reactions', 'overflowDirection', 'numberOfFixedChildren', 'overlayPositionType', 'overlayBackground', 'overlayBackgroundInteraction'];
const STYLE_IDS = ['fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId', 'gridStyleId', 'backgroundStyleId'];

const has = (node: object, name: string): boolean => { try { return name in node; } catch { return false; } };

/**
 * Reads one node, group by group. Each property is its own try/catch: a getter that throws becomes an `error` field with the reason and
 * the rest of the node is still read. Nothing is replaced by `null` to look successful.
 */
export async function readNodeFields(node: Record<string, any>, ctx: ReaderContext): Promise<NodeFields> {
  const fields: Record<string, FieldValue> = {};
  const id = String(node.id);
  const prop = (group: FieldGroup, name: string, key = name): unknown => {
    const full = `${group}.${key}`;
    if (!has(node, name)) { fields[full] = fieldNA(`${node.type} không có thuộc tính ${name}`, name); return undefined; }
    let raw: unknown;
    try { raw = node[name]; } catch (error) { fields[full] = fieldError(error, name); return undefined; }
    if (raw === undefined) { fields[full] = fieldUnavailable('API trả undefined cho thuộc tính này', name); return undefined; }
    const out = toJson(raw, ctx.mixed);
    if (out.truncated) fields[full] = { s: 'error', r: 'Giá trị quá sâu, quá lớn hoặc có vòng lặp; đã cắt, không đủ làm căn cứ.', a: name, v: out.value };
    // A plain property read does not repeat its own name; only derived values say which API they came from.
    else if (raw === ctx.mixed) fields[full] = fieldMixed({ $mixed: true });
    else fields[full] = fieldRead(out.value);
    return raw;
  };
  const set = (group: FieldGroup, name: string, run: () => unknown | Promise<unknown>, api: string, async = false): Promise<void> | void => {
    const full = `${group}.${name}`;
    const finish = (raw: unknown) => { const out = toJson(raw, ctx.mixed); fields[full] = out.truncated ? { s: 'error', r: 'Giá trị quá sâu hoặc có vòng lặp; đã cắt.', a: api, v: out.value } : out.mixed && raw === ctx.mixed ? fieldMixed({ $mixed: true }, api) : fieldRead(out.value, api); };
    if (!async) { try { finish(run()); } catch (error) { fields[full] = fieldError(error, api); } return; }
    return Promise.resolve().then(run).then(finish, (error) => { fields[full] = fieldError(error, api); });
  };

  const type = String(node.type);
  const known = isKnownNodeType(type);
  const groups: readonly FieldGroup[] = known ? APPLICABLE_GROUPS[type]! : ['common'];

  for (const name of COMMON) prop('common', name);
  if (groups.includes('layout')) for (const name of LAYOUT) prop('layout', name);
  if (groups.includes('paint')) {
    for (const name of PAINT) prop('paint', name);
    const hashes: Json[] = [];
    for (const field of ['fills', 'strokes'] as const) {
      const paints = fields[`paint.${field}`];
      if (paints?.s !== 'read' || !Array.isArray(paints.v)) continue;
      paints.v.forEach((p, i) => {
        if (p && typeof p === 'object' && !Array.isArray(p) && p.type === 'IMAGE' && typeof p.imageHash === 'string') {
          hashes.push({ hash: p.imageHash, field: `${field}[${i}]` });
          ctx.refs.image(p.imageHash, id, `${field}[${i}]`);
        }
      });
    }
    fields['paint.imageHashes'] = fieldRead(hashes, 'fills/strokes[].imageHash');
  }
  if (groups.includes('text')) await readText(node, ctx, prop, set, fields);
  if (groups.includes('component')) {
    for (const name of COMPONENT) prop('component', name, name === 'componentPropertyDefinitions' ? 'propertyDefinitions' : name);
    set('component', 'componentSetId', () => (node.parent && node.parent.type === 'COMPONENT_SET' ? node.parent.id : null), 'parent.id');
  }
  if (groups.includes('instance')) {
    for (const name of INSTANCE) prop('instance', name);
    await set('instance', 'mainComponentId', async () => { const main = await node.getMainComponentAsync(); if (main) ctx.refs.component(main.id, id); return main ? main.id : null; }, 'getMainComponentAsync().id', true);
  }
  if (groups.includes('style')) readStyle(node, ctx, prop, fields, id);
  if (groups.includes('vector')) for (const name of VECTOR) prop('vector', name);
  if (groups.includes('prototype')) for (const name of PROTOTYPE) prop('prototype', name);

  const status = {} as Partial<Record<FieldGroup, GroupStatus>>;
  for (const group of groups) {
    const own = Object.entries(fields).filter(([key]) => key.startsWith(`${group}.`)).map(([, v]) => v);
    status[group] = own.some((f) => f.s === 'error' || f.s === 'unavailable' || f.s === 'unsupported') ? 'partial' : own.length > 0 && own.every((f) => f.s === 'not_applicable') ? 'not_applicable' : 'read';
  }
  return { fields, groups: status };
}

type Prop = (group: FieldGroup, name: string, key?: string) => unknown;
type Setter = (group: FieldGroup, name: string, run: () => unknown | Promise<unknown>, api: string, async?: boolean) => Promise<void> | void;

async function readText(node: Record<string, any>, ctx: ReaderContext, prop: Prop, set: Setter, fields: Record<string, FieldValue>): Promise<void> {
  for (const name of TEXT) prop('text', name);
  // A range-dependent value is `mixed`; the segments below are where the actual values per range are.
  const segmentFields = TEXT_SEGMENT_FIELDS.slice();
  let segments: unknown;
  let failure: unknown;
  while (segmentFields.length) {
    try { segments = node.getStyledTextSegments(segmentFields); failure = undefined; break; }
    catch (error) { failure = error; const bad = /"?(\w+)"?/.exec(String((error as Error)?.message ?? ''))?.[1]; const at = bad ? segmentFields.indexOf(bad) : -1; if (at < 0) break; segmentFields.splice(at, 1); }
  }
  if (failure !== undefined || segments === undefined) {
    fields['text.segments'] = failure !== undefined ? fieldError(failure, 'getStyledTextSegments') : fieldUnavailable('Node không có getStyledTextSegments', 'getStyledTextSegments');
    for (const [key, value] of Object.entries(fields)) if (key.startsWith('text.') && value.s === 'mixed') fields[key] = { s: 'unavailable', r: 'Giá trị thay đổi theo đoạn nhưng không đọc được các đoạn.', a: value.a };
    return;
  }
  set('text', 'segments', () => segments, `getStyledTextSegments(${segmentFields.join(',')})`);
  const list = fields['text.segments'];
  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith('text.') || value.s !== 'mixed') continue;
    fields[key] = { s: 'mixed', v: { $mixed: true, detail: { via: 'text.segments' } }, a: value.a };
  }
  if (list?.s === 'read' && Array.isArray(list.v)) {
    for (const seg of list.v) if (seg && typeof seg === 'object' && !Array.isArray(seg)) {
      const s = seg as { [k: string]: Json };
      if (typeof s.textStyleId === 'string') ctx.refs.style(s.textStyleId, String(node.id));
      if (typeof s.fillStyleId === 'string') ctx.refs.style(s.fillStyleId, String(node.id));
      collectBound(s.boundVariables, ctx, String(node.id));
    }
  }
}

function readStyle(node: Record<string, any>, ctx: ReaderContext, prop: Prop, fields: Record<string, FieldValue>, id: string): void {
  const ids: { [key: string]: Json } = {};
  let any = false, bad: FieldValue | undefined;
  for (const name of STYLE_IDS) {
    if (!has(node, name)) continue;
    any = true;
    try {
      const raw = node[name];
      if (raw === ctx.mixed) { ids[name] = { $mixed: true }; continue; }
      ids[name] = typeof raw === 'string' && raw ? raw : null;
      if (typeof raw === 'string' && raw) ctx.refs.style(raw, id);
    } catch (error) { bad = fieldError(error, name); }
  }
  fields['style.styleIds'] = bad ?? (any ? fieldRead(ids, STYLE_IDS.join(',')) : fieldNA(`${node.type} không có style id`, 'styleIds'));
  prop('style', 'boundVariables');
  const bound = fields['style.boundVariables'];
  if (bound?.s === 'read') collectBound(bound.v, ctx, id);
  // A variable bound to a field of a paint lives inside `fills`, so it is collected from there too.
  for (const key of ['paint.fills', 'paint.strokes', 'paint.effects']) { const f = fields[key]; if (f?.s === 'read') walkBound(f.v, ctx, id); }
  prop('style', 'resolvedVariableModes');
  prop('style', 'explicitVariableModes');
}

/** Normalises a `boundVariables` value into `{ field: [ids] }` and records each id as a reference. */
export function collectBound(value: Json | undefined, ctx: ReaderContext, by: string): void { if (value && typeof value === 'object') walkBound(value, ctx, by); }
function walkBound(value: Json | undefined, ctx: ReaderContext, by: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const x of value) walkBound(x, ctx, by); return; }
  if (value.type === 'VARIABLE_ALIAS' && typeof value.id === 'string') { ctx.refs.variable(value.id, by); return; }
  for (const v of Object.values(value)) walkBound(v, ctx, by);
}
