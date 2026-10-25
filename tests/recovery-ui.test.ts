// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TestRepairPanel } from '../src/client/TestRepair.js';
import type { PendingTestRepair } from '../src/core/recovery.js';
import { RunPage } from '../src/client/RunPage.js';
import { setupV2 as setup } from './helpers.js';
import { fence, qualityReply, qualityReport, qualityGreen } from './quality-fixtures.js';
import { buildApp } from '../src/server/app.js';
import { sha256 } from '../src/core/contract.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';

vi.mock('../src/client/Monitor', () => ({ LogConsole: () => null, useNow: () => Date.now() }));
vi.mock('../src/client/Preview', () => ({ PreviewButton: () => null }));

let root: Root | undefined;
let app: FastifyInstance | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); await app?.close(); root = undefined; app = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); });
it('requires reading acknowledgement for the exact proposal and resets it when the hash changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const proposal: PendingTestRepair = { schemaVersion: 1, id: 'p', hash: 'a'.repeat(64), checkpoint: 'cp', contractVersion: 1, slot: 'A', configHash: 'c', manifestHash: 'm', paths: ['tests/order.test.ts'], patch: '+ await enqueue("third");', caseIds: ['C-2'], reason: 'Two jobs are already claimed', evidence: 'The third claim returns empty' };
  const approve = vi.fn(async () => {}), host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = async (p = proposal) => { await act(async () => root!.render(createElement(TestRepairPanel, { proposal: p, busy: false, onApprove: approve }))); };
  await render();
  expect(host.textContent).toContain(proposal.reason); expect(host.textContent).toContain(proposal.patch);
  const button = () => host.querySelector('button')!;
  expect(button().disabled).toBe(true);
  await act(async () => host.querySelector('input')!.click()); expect(button().disabled).toBe(false);
  await act(async () => button().click()); expect(approve).toHaveBeenCalledTimes(1);
  await render({ ...proposal, hash: 'b'.repeat(64) }); expect(button().disabled).toBe(true);
  expect(host.querySelector('input')!.checked).toBe(false);
});

it('RunPage refreshes a stale setup proposal, resets acknowledgement and continues through the real API', async () => {
  const kind: string = 'setup';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let applied = () => false;
  const e = setup({ reply: x => x.prompt.includes('Author chẩn đoán') ? fence({ decision: kind === 'assertion' ? 'test_assertion' : 'test_setup', caseIds: ['C-2'], reason: 'The test contradicts the retry contract.', evidence: 'Repeated operations must preserve identity.', ...(kind === 'assertion' ? { assertionChanges: [{ caseId: 'C-2', before: 'throws ALREADY_TERMINAL', after: 'returns duplicate', oracle: { references: [{ requirementId: 'R-1', quote: x.run.contract.requirements[0]!.text }], explanation: 'Duplicate requests must not create a new order.' } }] } : {}) }) : qualityReply(x), files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], check: () => ({ ...qualityGreen, exitCode: applied() ? 0 : 1, report: qualityReport(applied() ? 'passed' : 'failed') }) });
  applied = () => e.runtime.calls.includes('applyPatch:A');
  const run = await e.drive(e.create({ mode: 'verify', budgetUsd: 10 }));
  app = await buildApp({ store: e.store, orchestrator: e.orchestrator, dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-recovery-ui-')), port: 14330 });
  let stale = true;
  vi.stubGlobal('fetch', async (input: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const url = String(input);
    if (stale && url.endsWith('/approve-test-repair')) {
      stale = false; const proposal = e.orchestrator.detail(run.id).testRepair!, artifact = e.store.artifacts.get(proposal.id)!;
      const data = JSON.parse(artifact.content); data.reason += ' Clarified setup evidence.'; const content = JSON.stringify(data);
      e.store.artifacts.put({ ...artifact, content, hash: sha256(content) });
    }
    const response = await app!.inject({ url, method: (options.method ?? 'GET') as 'GET' | 'POST', headers: { ...options.headers, host: '127.0.0.1:14330' }, ...(options.body ? { payload: options.body } : {}) });
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, text: async () => response.body };
  });
  const waitFor = async (condition: () => boolean) => { for (let i = 0; i < 500 && !condition(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); expect(condition(), document.body.textContent ?? '').toBe(true); };
  const button = () => [...document.querySelectorAll('button')].find(b => b.textContent === 'Duyệt bản sửa test và kiểm tra lại')!;
  const ack = () => [...document.querySelectorAll('label')].find(l => l.textContent?.includes('Tôi đã đọc diff'))!.querySelector('input')!;
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(RunPage, { id: run.id, onBack: () => {}, onDeleted: async () => {} })));
  await waitFor(() => !!button()); expect(button().disabled).toBe(true);
  if (kind === 'assertion') { expect(document.body.textContent).toContain('Trước: throws ALREADY_TERMINAL'); expect(document.body.textContent).toContain('Sau: returns duplicate'); expect(document.body.textContent).toContain('Không tạo đơn trùng khi retry.'); }
  await act(async () => { ack().click(); }); await act(async () => { button().click(); });
  await waitFor(() => document.body.textContent?.includes('đã cũ') ?? false);
  expect(ack().checked).toBe(false); expect(button().disabled).toBe(true);
  const output = path.resolve('test-results/recovery'); mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, `ui-stale-${kind}-proposal.html`), document.documentElement.outerHTML);
  await act(async () => { ack().click(); }); await act(async () => { button().click(); });
  await act(async () => { await e.orchestrator.idle(); });
  await waitFor(() => document.body.textContent?.includes('vẫn muốn nghiệm thu') ?? false);
  expect(e.orchestrator.detail(run.id).run.status).toBe('awaiting_acceptance');
  expect(document.body.textContent).toContain('diff người dùng duyệt');
  writeFileSync(path.join(output, `ui-after-${kind}-repair.html`), document.documentElement.outerHTML);
  const warning = [...document.querySelectorAll('label')].find(l => l.textContent?.includes('vẫn muốn nghiệm thu'))!.querySelector('input')!;
  await act(async () => warning.click());
  const accept = [...document.querySelectorAll('button')].find(b => b.textContent === 'Nghiệm thu')!;
  await act(async () => accept.click()); await waitFor(() => e.store.runs.get(run.id)?.status === 'completed');
});
