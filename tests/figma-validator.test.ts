import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ExportValidator, type ValidatorInput } from '../src/core/figmavalidate.js';
import { canonicalJson, nodeRecordCore, type DependencyRecord, type FieldValue, type FinishBody, type InventoryRecord, type NodeRecord } from '../src/shared/figma.js';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const ok = (v: unknown): FieldValue => ({ s: 'read', v: v as never });

/** A node record with a correct hash. `over` replaces parts of it before hashing. */
function rec(id: string, type: string, parentId: string | null, childIds: string[], index = 0, over: Partial<Omit<NodeRecord, 'hash'>> = {}): NodeRecord {
  const core = {
    k: 'node' as const, id, type, name: id, pageId: 'P', parentId, index, depth: 0, childIds,
    groups: type === 'PAGE' ? { common: 'read' as const } : { common: 'read' as const, layout: 'read' as const, paint: 'read' as const, style: 'read' as const, prototype: 'read' as const, ...(type === 'TEXT' ? { text: 'read' as const } : {}) },
    fields: { 'common.name': ok(id), ...(type === 'PAGE' ? {} : { 'layout.x': ok(0), 'paint.fills': ok([]), 'style.styleIds': ok({}), 'prototype.reactions': ok([]) }), ...(type === 'TEXT' ? { 'text.characters': ok('t') } : {}) },
    ...over,
  };
  return { ...core, hash: sha(canonicalJson(nodeRecordCore(core as NodeRecord))) };
}
const inv = (r: NodeRecord): InventoryRecord => ({ k: 'inv', id: r.id, type: r.type, pageId: r.pageId, parentId: r.parentId, index: r.index, childIds: r.childIds });

const streams = (): ValidatorInput['measured'] => Object.fromEntries(['inventory', 'nodes', 'dependencies', 'verification'].map((k) => [k, { bytes: 1, sha256: 'a', records: 1 }])) as never;
const finish = (over: Partial<FinishBody> = {}): FinishBody => ({
  protocolVersion: 1, jobId: 'j', sourceSession: 's', scopeHash: 'h', lastSeq: 0, streams: streams() as never, assets: [], totals: { nodes: 0, pages: 0, dependencies: 0, assets: 0 },
  verification: { passes: 2, sourceChanged: false, changedIds: [], documentChanges: 0, watchedDocumentChanges: true }, stats: { peakUnackedChunks: 1, durationMs: 1, restoredSkipInvisible: true }, errors: [], ...over,
});

interface Case { nodes?: NodeRecord[]; inventory?: NodeRecord[]; again?: InventoryRecord[]; deps?: DependencyRecord[]; input?: Partial<ValidatorInput>; finish?: Partial<FinishBody> }
function run(c: Case) {
  const nodes = c.nodes ?? [rec('1:1', 'FRAME', null, ['1:2'], 0), rec('1:2', 'TEXT', '1:1', [], 0)];
  const v = new ExportValidator({ rootIds: ['1:1'], pageIds: [], scope: 'selection', sourceIdentity: 'verified', finish: finish(c.finish), measured: streams(), storedAssets: new Map(), ...c.input });
  const inventory = c.inventory ?? nodes;
  for (const r of inventory) v.addInventory(inv(r), 1);
  for (const r of c.again ?? inventory.map(inv)) v.addInventory(r, 2);
  for (const r of nodes) v.addNode(r);
  for (const d of c.deps ?? []) v.addDependency(d);
  return v.finish();
}
const codes = (r: ReturnType<typeof run>, severity?: string) => r.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

describe('a consistent export has nothing to report', () => {
  it('passes a small tree whose records, inventory and second look agree', () => {
    const r = run({});
    expect(codes(r, 'blocker')).toEqual([]);
    expect(r.structureComplete).toBe(true);
    expect(r.coverage.consistency).toBe('unchanged_across_passes');
    expect(r.coverage.fieldCoverage.all.read).toBeGreaterThan(0);
    expect(r.counts.nodes).toBe(2);
  });
});

describe('the graph is checked on its own, not on the plugin\'s word', () => {
  it('blocks a duplicated id, a record with no inventory entry, an inventory entry with no record, and a record that disagrees with the inventory', () => {
    const dup = rec('1:2', 'TEXT', '1:1', [], 0);
    expect(codes(run({ nodes: [rec('1:1', 'FRAME', null, ['1:2'], 0), dup, dup] }), 'blocker')).toContain('duplicate_id');
    expect(codes(run({ nodes: [rec('1:1', 'FRAME', null, ['1:2'], 0), rec('1:2', 'TEXT', '1:1', [], 0), rec('1:3', 'TEXT', '1:1', [], 1)], inventory: [rec('1:1', 'FRAME', null, ['1:2'], 0), rec('1:2', 'TEXT', '1:1', [], 0)] }), 'blocker')).toContain('unknown_node_record');
    const r = run({ nodes: [rec('1:1', 'FRAME', null, ['1:2'], 0)], inventory: [rec('1:1', 'FRAME', null, ['1:2'], 0), rec('1:2', 'TEXT', '1:1', [], 0)] });
    expect(codes(r, 'blocker')).toContain('missing_node_record');
    expect(r.structureComplete).toBe(false);
    expect(codes(run({ nodes: [rec('1:1', 'FRAME', null, ['1:2'], 0), rec('1:2', 'TEXT', '1:1', [], 0)], inventory: [rec('1:1', 'FRAME', null, ['1:2'], 0), rec('1:2', 'TEXT', '1:1', [], 5)] }), 'blocker')).toContain('record_inventory_mismatch');
  });

  it('blocks a record whose hash does not match its content, a child that is not in the inventory, and a child listed in the wrong place', () => {
    const tampered = { ...rec('1:2', 'TEXT', '1:1', [], 0), name: 'đã bị sửa' };
    expect(codes(run({ nodes: [rec('1:1', 'FRAME', null, ['1:2'], 0), tampered] }), 'blocker')).toContain('node_hash_mismatch');
    expect(codes(run({ nodes: [rec('1:1', 'FRAME', null, ['1:2', '1:9'], 0), rec('1:2', 'TEXT', '1:1', [], 0)] }), 'blocker')).toContain('child_missing');
    expect(codes(run({ nodes: [rec('1:1', 'FRAME', null, ['1:3', '1:2'], 0), rec('1:2', 'TEXT', '1:1', [], 0), rec('1:3', 'TEXT', '1:1', [], 1)] }), 'blocker')).toContain('child_order_mismatch');
  });

  it('blocks a cycle, a parent that does not exist, and a requested root that is missing', () => {
    expect(codes(run({ nodes: [rec('1:1', 'FRAME', '1:2', ['1:2'], 0), rec('1:2', 'FRAME', '1:1', ['1:1'], 0)], input: { rootIds: ['1:1'] } }), 'blocker')).toContain('graph_cycle');
    expect(codes(run({ nodes: [rec('1:1', 'FRAME', null, ['1:2'], 0), rec('1:2', 'TEXT', '7:7', [], 0)] }), 'blocker')).toContain('parent_missing');
    expect(codes(run({ input: { rootIds: ['1:1', '5:5'] } }), 'blocker')).toContain('root_missing');
  });

  it('blocks when the second look differs, or was never made', () => {
    expect(codes(run({ again: [inv(rec('1:1', 'FRAME', null, ['1:2'], 0))] }), 'blocker')).toContain('source_changed');
    expect(codes(run({ again: [inv(rec('1:1', 'FRAME', null, ['1:2', '1:3'], 0)), inv(rec('1:2', 'TEXT', '1:1', [], 0))] }), 'blocker')).toContain('source_changed');
    const none = run({ again: [] });
    expect(codes(none, 'blocker')).toContain('verification_missing');
    expect(codes(run({ finish: { verification: { passes: 2, sourceChanged: true, changedIds: ['1:2'], documentChanges: 0, watchedDocumentChanges: true } } }), 'blocker')).toContain('source_changed');
    expect(codes(run({ finish: { verification: { passes: 2, sourceChanged: false, changedIds: [], documentChanges: 3, watchedDocumentChanges: true } } }), 'blocker')).toContain('source_changed');
    expect(run({ finish: { verification: { passes: 2, sourceChanged: false, changedIds: [], documentChanges: 3, watchedDocumentChanges: false } } }).coverage.consistency).toBe('unchanged_across_passes');
  });

  it('blocks a stream whose bytes, records or hash differ from what the plugin said it sent', () => {
    const lie = { ...streams(), nodes: { bytes: 99, sha256: 'b', records: 7 } };
    expect(codes(run({ input: { measured: lie as never } }), 'blocker')).toContain('stream_mismatch');
  });
});

describe('every field of every group has a status that tells the truth', () => {
  it('blocks a node that skipped a group it must answer for, and a group that says "read" over a failed field', () => {
    const missing = rec('1:2', 'TEXT', '1:1', [], 0, { groups: { common: 'read', layout: 'read', paint: 'read', style: 'read', prototype: 'read' } });
    expect(codes(run({ nodes: [rec('1:1', 'FRAME', null, ['1:2'], 0), missing] }), 'blocker')).toContain('missing_group_status');
    const lying = rec('1:2', 'TEXT', '1:1', [], 0, { fields: { 'common.name': ok('x'), 'layout.x': ok(0), 'paint.fills': { s: 'error', r: 'boom' }, 'style.styleIds': ok({}), 'prototype.reactions': ok([]), 'text.characters': ok('t') } });
    expect(codes(run({ nodes: [rec('1:1', 'FRAME', null, ['1:2'], 0), lying] }), 'blocker')).toContain('group_inconsistent');
    const idle = rec('1:2', 'TEXT', '1:1', [], 0, { groups: { common: 'read', layout: 'partial', paint: 'read', style: 'read', prototype: 'read', text: 'read' } });
    expect(codes(run({ nodes: [rec('1:1', 'FRAME', null, ['1:2'], 0), idle] }), 'blocker')).toContain('group_inconsistent');
  });

  it('blocks a "read" field with no value and a failure with no reason, but accepts zero, false and null as values', () => {
    const bad = rec('1:2', 'TEXT', '1:1', [], 0, { fields: { 'common.name': { s: 'read' } as FieldValue, 'layout.x': { s: 'unavailable' } as FieldValue, 'paint.fills': ok(null), 'style.styleIds': ok(false), 'prototype.reactions': ok(0), 'text.characters': ok('') } });
    const r = run({ nodes: [rec('1:1', 'FRAME', null, ['1:2'], 0), bad] });
    expect(r.issues.filter((i) => i.code === 'field_malformed').map((i) => i.field).sort()).toEqual(['common.name', 'layout.x']);
  });

  it('turns failed, unavailable and unsupported fields into ONE limit each, naming how many and which nodes', () => {
    const failing = (id: string, parent: string, index: number) => rec(id, 'TEXT', parent, [], index, { groups: { common: 'read', layout: 'read', paint: 'partial', style: 'read', prototype: 'read', text: 'read' },
      fields: { 'common.name': ok(id), 'layout.x': ok(0), 'paint.fills': { s: 'error', r: 'boom' }, 'style.styleIds': ok({}), 'prototype.reactions': ok([]), 'text.characters': ok('t') } });
    const r = run({ nodes: [rec('1:1', 'FRAME', null, ['1:2', '1:3', '1:4'], 0), failing('1:2', '1:1', 0), failing('1:3', '1:1', 1), failing('1:4', '1:1', 2)] });
    const issues = r.issues.filter((i) => i.code === 'field_error');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('limit');
    expect(issues[0]!.message).toContain('3 chỗ');
    expect(issues[0]!.message).toContain('1:2');
    expect(r.coverage.fieldCoverage.byGroup.paint!.error).toBe(3);
  });

  it('keeps a node type it does not know as a limit, reading only what is common to every node', () => {
    const odd = rec('1:2', 'STICKY', '1:1', [], 0, { groups: { common: 'read' }, fields: { 'common.name': ok('s') } });
    const r = run({ nodes: [rec('1:1', 'FRAME', null, ['1:2'], 0), odd] });
    expect(codes(r, 'blocker')).toEqual([]);
    expect(codes(r, 'limit')).toContain('unsupported_node_type');
    expect(r.unsupportedTypes).toEqual(['STICKY']);
  });
});

describe('what a node depends on is resolved or named', () => {
  const withRefs = (fields: Record<string, FieldValue>) => rec('1:2', 'TEXT', '1:1', [], 0, { fields: { 'common.name': ok('x'), 'layout.x': ok(0), 'paint.fills': ok([]), 'style.styleIds': ok({}), 'prototype.reactions': ok([]), 'text.characters': ok('t'), ...fields } });
  const tree = (n: NodeRecord) => [rec('1:1', 'FRAME', null, ['1:2'], 0), n];

  it('limits a style, a variable and a main component that were referenced but not read, and counts the rest as resolved', () => {
    const n = withRefs({ 'style.styleIds': ok({ fillStyleId: 'S:1' }), 'style.boundVariables': ok({ fills: [{ type: 'VARIABLE_ALIAS', id: 'V:1' }] }), 'paint.fills': ok([{ type: 'SOLID', boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:2' } } }]) });
    const r = run({ nodes: tree(n), deps: [{ k: 'style', id: 'S:1', styleType: 'PAINT', name: 's', remote: false, fields: {} }, { k: 'variable', id: 'V:1', name: 'v', collectionId: 'C:1', resolvedType: 'COLOR', remote: false, valuesByMode: {} }, { k: 'collection', id: 'C:1', name: 'c', remote: false, modes: [], variableIds: ['V:1'] }] });
    expect(codes(r, 'limit')).toContain('dependency_unresolved');
    expect(r.coverage.dependencyCoverage).toMatchObject({ total: 3, resolved: 2, unavailable: 1 });
  });

  it('limits an alias that points nowhere and an alias chain that loops, once each', () => {
    const v = (id: string, alias: string): DependencyRecord => ({ k: 'variable', id, name: id, collectionId: 'C:1', resolvedType: 'COLOR', remote: false, valuesByMode: { m: ok({ alias }) } });
    const r = run({ deps: [v('V:1', 'V:2'), v('V:2', 'V:1'), v('V:3', 'V:404'), { k: 'collection', id: 'C:1', name: 'c', remote: false, modes: [], variableIds: [] }] });
    expect(codes(r, 'limit')).toEqual(expect.arrayContaining(['alias_cycle', 'alias_missing']));
  });

  it('says an image with no original bytes is not complete, and a preview does not stand in for it', () => {
    const n = withRefs({ 'paint.imageHashes': ok([{ hash: 'imgA', field: 'fills[0]' }, { hash: 'imgB', field: 'fills[1]' }]) });
    const r = run({ nodes: tree(n), deps: [
      { k: 'imageRef', hash: 'imgA', refs: [{ nodeId: '1:2', field: 'fills[0]' }], status: 'missing', reason: 'x' },
      { k: 'imageRef', hash: 'imgB', refs: [{ nodeId: '1:2', field: 'fills[1]' }], status: 'oversize' },
      { k: 'asset', id: 'p'.repeat(64), assetKind: 'preview', mime: 'image/png', bytes: 5, sha256: 'p'.repeat(64), source: { nodeId: '1:1' }, status: 'stored' },
    ], input: { storedAssets: new Map([['p'.repeat(64), { bytes: 5, sha256: 'p'.repeat(64) }]]) }, finish: { assets: [{ id: 'p'.repeat(64), bytes: 5, sha256: 'p'.repeat(64) }] } });
    expect(codes(r, 'limit')).toEqual(expect.arrayContaining(['asset_missing', 'asset_oversize']));
    expect(r.coverage.assetCoverage).toMatchObject({ stored: 1, previewOnly: 1 });
    expect(r.coverage.dependencyCoverage.unavailable).toBe(2);
  });

  it('blocks an asset whose bytes are missing or differ from the record, and bytes with no record', () => {
    const id = 'a'.repeat(64);
    const asset: DependencyRecord = { k: 'asset', id, assetKind: 'original_image', mime: 'image/png', bytes: 5, sha256: id, source: { imageHash: 'x' }, status: 'stored' };
    expect(codes(run({ deps: [asset] }), 'blocker')).toContain('asset_bytes_missing');
    expect(codes(run({ deps: [asset], input: { storedAssets: new Map([[id, { bytes: 6, sha256: id }]]) }, finish: { assets: [{ id, bytes: 6, sha256: id }] } }), 'blocker')).toContain('asset_hash_mismatch');
    expect(codes(run({ input: { storedAssets: new Map([[id, { bytes: 5, sha256: id }]]) }, finish: { assets: [{ id, bytes: 5, sha256: id }] } }), 'blocker')).toContain('asset_unrecorded');
  });
});

describe('limits, source and plugin errors', () => {
  it('blocks an export that stopped at a limit, and a plugin that reported an error, and asks the person to vouch for an unverified source', () => {
    expect(codes(run({ finish: { limitReached: 'nodes' } }), 'blocker')).toContain('limit_reached');
    expect(codes(run({ finish: { errors: [{ code: 'internal', message: 'node 1:2: boom' }] } }), 'blocker')).toContain('plugin_internal');
    const attested = run({ input: { sourceIdentity: 'user_attested' } });
    expect(codes(attested, 'limit')).toContain('source_user_attested');
    expect(attested.coverage.sourceIdentity).toBe('user_attested');
  });

  it('gives the same issue the same id every time, so an acknowledgement means something', () => {
    const a = run({ input: { sourceIdentity: 'user_attested' } }).issues.find((i) => i.code === 'source_user_attested')!.id;
    const b = run({ input: { sourceIdentity: 'user_attested' } }).issues.find((i) => i.code === 'source_user_attested')!.id;
    expect(a).toBe(b);
  });
});
