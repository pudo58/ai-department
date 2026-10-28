import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { rig } from './figma/harness.js';
import { FakeNode } from './figma/fakefigma.js';
import { profile } from './helpers.js';
import type { SnapshotPreviews } from '../src/shared/design.js';
import { buildPreviewCatalog } from '../src/server/figma/previews.js';
import { idHash, sha256Hex } from '../src/core/design.js';

let current: Awaited<ReturnType<typeof rig>> | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

async function sectionRig() {
  current = await rig();
  const r = current;
  r.doc.frame.props.set('height', 5000);
  const nested = new FakeNode('FRAME', '8:4', 'Layout inside screen', { width: 20, height: 20 }, []);
  r.doc.frame.kids!.push(nested); nested.parent = r.doc.frame;
  const other = new FakeNode('FRAME', '8:2', 'Settings', { width: 375, height: 812, visible: true }, []);
  const group = new FakeNode('GROUP', '8:3', 'Wrapper', {}, [other]);
  const section = new FakeNode('SECTION', '8:1', 'Application', { width: 5000, height: 5000 }, [r.doc.frame, group]);
  r.doc.pages[0].kids = [section]; section.parent = r.doc.pages[0]; r.figma.register(section);
  await r.pairNow();
  const job = await r.finished((await r.exportAs({ scope: 'selection', rootIds: [section.id] })).id);
  expect(job.status, JSON.stringify(job.error)).toBe('review_ready');
  const snap = r.service.snapshots.get(job.snapshotId!)!;
  return { r, section, other, nested, snap };
}

describe('section and screen reference images', () => {
  it('reports every preview omitted by the source-image limit instead of silently truncating the section', async () => {
    current = await rig();
    const r = current;
    const frames = Array.from({ length: 101 }, (_, i) => new FakeNode('FRAME', `8:${i + 10}`, `Screen ${i}`, { width: 16, height: 16, visible: true }, []));
    const section = new FakeNode('SECTION', '8:1', 'Many screens', { width: 16, height: 16 }, frames);
    r.doc.pages[0].kids = [section]; section.parent = r.doc.pages[0]; r.figma.register(section);
    await r.pairNow();
    const job = await r.finished((await r.exportAs({ scope: 'selection', rootIds: [section.id] })).id);
    expect(job.status).toBe('review_ready');
    const catalog = r.service.snapshots.previews(job.snapshotId!);
    expect(catalog.images.filter((p) => p.role !== 'detail')).toHaveLength(100);
    expect(catalog.warnings).toHaveLength(2);
    expect(catalog.warnings.every((w) => w.includes('Giới hạn 100'))).toBe(true);
    expect(job.issues.some((i) => i.code === 'asset_missing' && i.severity === 'limit')).toBe(true);
  }, 60000);

  it('exports a section overview, each first screen through groups, and detail crops, without treating nested layout frames as screens', async () => {
    const { r, section, other, nested, snap } = await sectionRig();
    const response = await r.admin.get(`/api/design-snapshots/${snap.id}/previews`);
    expect(response.statusCode).toBe(200);
    const catalog = response.json() as SnapshotPreviews;
    expect(catalog.warnings).toEqual([]);
    expect(catalog.images.filter((p) => p.role === 'overview').map((p) => p.nodeId)).toEqual([section.id]);
    expect(catalog.images.filter((p) => p.role === 'screen').map((p) => p.nodeId)).toEqual([r.doc.frame.id, other.id]);
    expect(nested.exports).toEqual([]);
    const details = catalog.images.filter((p) => p.role === 'detail');
    expect(details.map((p) => p.region?.y)).toEqual([0, 2048, 4096]);
    expect(details.map((p) => p.height)).toEqual([2048, 2048, 904]);
    const screen = catalog.images.find((p) => p.nodeId === r.doc.frame.id && p.role === 'screen')!;
    expect(screen).toMatchObject({ name: r.doc.frame.name, width: 375, height: 5000, scale: 1 });
    for (const p of catalog.images) expect(snap.files.some((f) => f.id === p.fileId)).toBe(true);
    expect(r.service.snapshots.verify(snap.id).ok).toBe(true);
  }, 60000);

  it('gives the agent images for its target and containing section, with matching paths, and excludes other screens', async () => {
    const { r, section, other, snap } = await sectionRig();
    r.store.projects.put(profile({ executionMode: 'local' }));
    const approved = await r.admin.post(`/api/design-snapshots/${snap.id}/publish`, { snapshotHash: snap.snapshotHash, acknowledgedIssueIds: snap.issues.filter((i) => i.severity === 'limit').map((i) => i.id) });
    expect(approved.statusCode, approved.body).toBe(200);
    const run = r.orchestrator.createRun({ projectId: 'prj_test', title: 'Screen', originalRequirement: 'Implement this screen', mode: 'single', provider: 'codex', budgetUsd: 5, signals: [], design: { snapshotId: snap.id, targetIds: [r.doc.text.id] } } as never);
    const input = await r.service.inputs.prepare(run, 'developer', 'att_previews');
    const index = JSON.parse(readFileSync(path.join(input!.exec.hostDir, 'index.json'), 'utf8'));
    const catalog = index.previews as SnapshotPreviews;
    expect(catalog.images.some((p) => p.nodeId === section.id && p.role === 'overview')).toBe(true);
    expect(catalog.images.some((p) => p.nodeId === r.doc.frame.id && p.role === 'detail')).toBe(true);
    expect(catalog.images.some((p) => p.nodeId === other.id)).toBe(false);
    for (const p of catalog.images) expect(readFileSync(path.join(input!.exec.hostDir, p.path)).length).toBeGreaterThan(0);
    expect(input!.block).toContain('Ảnh tham chiếu theo node');
    expect(input!.block).toContain('visual verification');
  }, 60000);

  it('exposes legacy preview assets with node names while keeping original PNG images out of the gallery', async () => {
    const { r, snap } = await sectionRig();
    // Removing the new catalog from a fixture's metadata simulates the old immutable schema.
    r.store.designSnapshots.put({ ...snap, files: snap.files.filter((f) => f.path !== 'previews.json') });
    const catalog = r.service.snapshots.previews(snap.id);
    expect(catalog.images.some((p) => p.nodeId === r.doc.frame.id && p.name === r.doc.frame.name)).toBe(true);
    expect(catalog.images.every((p) => p.role !== 'detail')).toBe(true);
    expect(catalog.images.length).toBe(3);
  }, 60000);
});

describe('detail raster crops', () => {
  it('does not decode a PNG whose declared dimensions exceed the raster memory bound', async () => {
    const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(8192, 16); bytes.writeUInt32BE(8192, 20);
    const id = sha256Hex(bytes), assetPath = `assets/${id}.png`;
    const catalog = await buildPreviewCatalog([{ id: idHash(assetPath), path: assetPath, kind: 'asset', mime: 'image/png', bytes: bytes.length, sha256: id }],
      [{ k: 'asset', id, assetKind: 'preview', mime: 'image/png', bytes: bytes.length, sha256: id, source: { nodeId: '1:1' }, status: 'stored' }],
      () => ({ id: '1:1', type: 'FRAME', name: 'Huge' }), () => bytes, () => { throw new Error('Must not generate a crop'); });
    expect(catalog.images).toHaveLength(1);
    expect(catalog.warnings[0]).toContain('vượt giới hạn');
  });

  it('preserves pixels and records regions in the original node coordinates', async () => {
    const png = new PNG({ width: 4, height: 2100 });
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) { const i = (y * png.width + x) * 4; png.data[i] = y % 256; png.data[i + 1] = x; png.data[i + 3] = 255; }
    const bytes = PNG.sync.write(png), id = sha256Hex(bytes), assetPath = `assets/${id}.png`;
    const written = new Map<string, Buffer>();
    const catalog = await buildPreviewCatalog([{ id: idHash(assetPath), path: assetPath, kind: 'asset', mime: 'image/png', bytes: bytes.length, sha256: id }],
      [{ k: 'asset', id, assetKind: 'preview', mime: 'image/png', bytes: bytes.length, sha256: id, source: { nodeId: '1:1' }, status: 'stored', preview: { role: 'screen', name: 'Long', nodeType: 'FRAME', scale: 0.5 } }],
      () => ({ id: '1:1', type: 'FRAME', name: 'Long' }), () => bytes, (p, b) => written.set(p, b));
    expect(catalog.warnings).toEqual([]);
    const bottom = catalog.images.filter((p) => p.role === 'detail')[1];
    expect(bottom.region).toEqual({ x: 0, y: 4096, width: 8, height: 104 });
    const cropped = PNG.sync.read(written.get(bottom.path)!);
    expect(cropped.height).toBe(52);
    expect([...cropped.data.subarray(0, 4)]).toEqual([...png.data.subarray(2048 * 4 * 4, 2048 * 4 * 4 + 4)]);
  });
});
