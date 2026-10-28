import { afterEach, describe, expect, it } from 'vitest';
import { rig } from './figma/harness.js';
import { FakeNode } from './figma/fakefigma.js';
import { hiddenNode } from '../src/shared/figma.js';
import type { SnapshotDiagnostics } from '../src/shared/design.js';

let current: Awaited<ReturnType<typeof rig>> | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

describe('visibility evidence', () => {
  it('finds an explicitly hidden node or ancestor', () => {
    const nodes = new Map([['a', { parentId: null, visible: false }], ['b', { parentId: 'a', visible: true }]]);
    expect(hiddenNode('a', nodes)).toBe('a');
    expect(hiddenNode('b', nodes)).toBe('a');
  });
  it('does not infer hidden state from unknown fields, missing ancestors, or cycles', () => {
    expect(hiddenNode('a', new Map([['a', { parentId: 'missing' }]]))).toBeUndefined();
    expect(hiddenNode('a', new Map([['a', { parentId: 'b', visible: true }], ['b', { parentId: 'a', visible: true }]]))).toBeUndefined();
  });
});

it('separates hidden SVGs from unexplained failures, shows main component references, and preserves acknowledgement requirements', async () => {
  current = await rig();
  const r = current;
  r.doc.instance.failing.set('componentProperties', new Error('in get_componentProperties: Component set for node has existing errors'));
  r.doc.vector.props.set('exportError', 'Failed to export node. This node may not have any visible layers.');
  const nested = new FakeNode('VECTOR', '8:2', 'Nested hidden icon', { visible: true, width: 16, height: 16, fills: [] });
  const parent = new FakeNode('GROUP', '8:1', 'Hidden toolbar', { visible: false }, [nested]);
  const own = new FakeNode('VECTOR', '8:3', 'Hidden icon', { visible: false, width: 16, height: 16, fills: [] });
  for (const node of [parent, own]) { r.doc.frame.kids!.push(node); node.parent = r.doc.frame; r.figma.register(node); }
  await r.pairNow();
  const job = await r.finished((await r.exportAs({ scope: 'selection', rootIds: [r.doc.frame.id] })).id);
  expect(job.status, JSON.stringify(job.error)).toBe('review_ready');
  expect(nested.exports).toEqual([]); expect(own.exports).toEqual([]);
  expect(r.doc.vector.exports.some((e) => e.format === 'SVG_STRING')).toBe(true);
  const hidden = job.issues.find((i) => i.code === 'vector_hidden')!;
  const failed = job.issues.find((i) => i.code === 'vector_export_failed')!;
  expect(hidden).toMatchObject({ severity: 'limit', occurrences: 2 });
  expect(hidden.examples).toContainEqual({ nodeId: nested.id, name: nested.name });
  expect(failed).toMatchObject({ severity: 'limit', occurrences: 1 });
  const snap = r.service.snapshots.get(job.snapshotId!)!;
  const before = { hash: snap.snapshotHash, issues: JSON.stringify(snap.issues) };
  const response = await r.admin.get(`/api/design-snapshots/${snap.id}/diagnostics`);
  expect(response.statusCode).toBe(200);
  const report = response.json() as SnapshotDiagnostics;
  const hiddenGroup = report.groups.find((g) => g.kind === 'hidden_vector')!;
  expect(hiddenGroup.items).toHaveLength(2);
  expect(hiddenGroup.items.find((i) => i.nodeId === nested.id)?.hiddenBy).toEqual({ nodeId: parent.id, name: parent.name });
  expect(report.groups.find((g) => g.kind === 'vector_failure')!.items.map((i) => i.nodeId)).toEqual([r.doc.vector.id]);
  expect(report.groups.find((g) => g.kind === 'component_properties')!.items[0]).toMatchObject({ nodeId: r.doc.instance.id, name: r.doc.instance.name, component: { nodeId: '2:1', name: 'Button, size=sm' } });
  expect(r.service.snapshots.get(snap.id)!.snapshotHash).toBe(before.hash);
  expect(JSON.stringify(r.service.snapshots.get(snap.id)!.issues)).toBe(before.issues);
  expect(r.service.snapshots.verify(snap.id).ok).toBe(true);
  const incomplete = await r.admin.post(`/api/design-snapshots/${snap.id}/publish`, { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: snap.issues.filter((i) => i.severity === 'limit' && i.id !== hidden.id).map((i) => i.id) });
  expect(incomplete.statusCode).toBe(409);
}, 60000);
