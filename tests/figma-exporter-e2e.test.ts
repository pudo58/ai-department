import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { rig, waitFor } from './figma/harness.js';

let current: Awaited<ReturnType<typeof rig>> | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

const start = async (options: Parameters<typeof rig>[0] = {}) => { current = await rig(options); await current.pairNow(); return current; };

describe('a selection is exported from a fake Figma document into a snapshot', () => {
  it('pairs, exports one frame and its tree, and ends ready for review with every group of every node answered', async () => {
    const r = await start();
    const frame = r.doc.frame;
    const job = await r.exportAs({ scope: 'selection', rootIds: [frame.id] });
    const done = await r.finished(job.id);
    expect(done.status, JSON.stringify(done.issues.filter((i) => i.severity === 'blocker').concat(done.error ? [{ id: 'e', code: '', severity: 'blocker', message: done.error.message } as never] : []))).toBe('review_ready');
    expect(done.source.identity).toBe('verified');
    expect(done.coverage!.structureComplete).toBe(true);
    expect(done.coverage!.consistency).toBe('unchanged_across_passes');
    const snapshot = r.service.snapshots.get(done.snapshotId!)!;
    expect(snapshot.counts.nodes).toBe(6);
    const reader = r.service.snapshots.reader(snapshot.id);
    // The hidden, locked layer and the instance's own child are in the data: nothing was skipped.
    expect(reader.has('1:6')).toBe(true);
    expect(reader.has('1:7')).toBe(true);
    const text = reader.node('1:3')!;
    expect(text.fields['text.characters']).toMatchObject({ s: 'read', v: 'Xin chào Figma' });
    expect(text.fields['text.fontName']!.s).toBe('mixed');
    expect(text.fields['text.segments']!.s).toBe('read');
    expect((text.fields['text.segments']!.v as unknown[]).length).toBe(2);
    expect(reader.node('1:6')!.fields['common.visible']).toMatchObject({ s: 'read', v: false });
    expect(reader.node('1:4')!.fields['instance.mainComponentId']).toMatchObject({ s: 'read', v: '2:1' });
    // The plugin put the setting back.
    expect(r.figma.skipInvisibleInstanceChildren).toBe(true);
    // Nothing is published until a person does it.
    expect(snapshot.status).toBe('draft');
  }, 60000);
});

describe('the files that make a snapshot', () => {
  it('writes pages, components, tokens, assets and a manifest that every file hash agrees with', async () => {
    const r = await start();
    const done = await r.finished((await r.exportAs({ scope: 'file' })).id);
    expect(done.status, JSON.stringify(done.error ?? done.issues.filter((i) => i.severity === 'blocker'))).toBe('review_ready');
    const snapshot = r.service.snapshots.get(done.snapshotId!)!;
    expect(snapshot.counts).toMatchObject({ pages: 3, components: 1, styles: 2, variables: 2, collections: 1 });
    const dir = r.service.snapshots.dir(snapshot.id);
    for (const rel of ['manifest.json', 'index.json', 'review.json', 'tokens/index.md', 'source/node-table.ndjson']) expect(existsSync(path.join(dir, rel)), rel).toBe(true);
    expect(r.service.snapshots.verify(snapshot.id)).toEqual({ ok: true, problems: [] });
    const kinds = new Set(snapshot.files.map((f) => f.kind));
    for (const k of ['source', 'page', 'component', 'tokens', 'asset', 'review', 'index']) expect(kinds.has(k as never), k).toBe(true);
    // Names that are not safe on Windows or in Markdown never become a path: files are named by hash.
    expect(snapshot.files.every((f) => /^[A-Za-z0-9_./-]+$/.test(f.path))).toBe(true);
    const pageMd = snapshot.files.filter((f) => f.kind === 'page' && f.path.endsWith('index.md')).map((f) => readFileSync(path.join(dir, f.path), 'utf8')).join('\n');
    expect(pageMd).not.toContain('<b>');
    expect(pageMd).toContain('&lt;');
    // Images and vectors: original bytes by content hash, a vector export, and a preview, each told apart.
    const assets = [...r.service.snapshots.reader(snapshot.id).dependencies()].filter((d) => d.k === 'asset');
    expect(new Set(assets.map((a) => (a as { assetKind: string }).assetKind))).toEqual(new Set(['original_image', 'vector_export', 'preview']));
    await waitFor(() => true);
  }, 60000);
});
