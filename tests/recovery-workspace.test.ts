import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitWorkspaces } from '../src/runtime/gitworkspace.js';
import { setup } from './helpers.js';

it('applies the reviewed Git diff on the exact checkpoint and refuses dirty or stale workspaces', async () => {
  const source = mkdtempSync(path.join(tmpdir(), 'aidept-test-repair-source-'));
  mkdirSync(path.join(source, 'tests'));
  writeFileSync(path.join(source, 'tests/order.test.js'), 'const jobs = 2;\nassert(jobs === 3);\n');
  const run = setup({}, { repository: source }).create();
  const ws = new GitWorkspaces(mkdtempSync(path.join(tmpdir(), 'aidept-test-repair-data-')));
  const prepared = await ws.clone(run, 'A'); run.baseSha = prepared.baseSha; run.checkpoint = prepared.baseSha;
  const file = path.join(ws.dir(run, 'A'), 'tests/order.test.js');
  writeFileSync(file, 'const jobs = 3;\nassert(jobs === 3);\n');
  const patch = (await ws.changes(run, 'A')).patch;
  await expect(ws.applyPatch(run, 'A', patch)).rejects.toThrow('thay đổi dở dang');
  await ws.revert(run, 'A'); await ws.applyPatch(run, 'A', patch);
  expect(readFileSync(file, 'utf8')).toContain('const jobs = 3');
  expect(readFileSync(path.join(source, 'tests/order.test.js'), 'utf8')).toContain('const jobs = 2');
  const next = await ws.commit(run, 'A', 'reviewed setup correction');
  await expect(ws.applyPatch(run, 'A', patch)).rejects.toThrow('Checkpoint');
  run.checkpoint = next;
  await expect(ws.applyPatch(run, 'A', patch)).rejects.toThrow('git apply --check');
});
