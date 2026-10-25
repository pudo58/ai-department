// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunPage } from '../src/client/RunPage.js';
import { buildApp } from '../src/server/app.js';
import { setupV2 as setup } from './helpers.js';
import { qualityReply, qualityGreen, qualityReport } from './quality-fixtures.js';
import type { FastifyInstance } from 'fastify';

// Transport goes through the real Fastify routes; only SSE/preview rendering is outside this component test.
vi.mock('../src/client/Monitor', () => ({ LogConsole: () => null, useNow: () => Date.now() }));
vi.mock('../src/client/Preview', () => ({ PreviewButton: () => null }));
let root: Root | undefined, app: FastifyInstance | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); await app?.close(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

const button = (label: string | RegExp): HTMLButtonElement => {
  const element = [...document.querySelectorAll('button')].find(b => typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? ''));
  if (!element) throw new Error(`Không thấy nút ${label}: ${document.body.textContent}`);
  return element;
};
const checkbox = (label: string): HTMLInputElement => {
  const parent = [...document.querySelectorAll('label')].find(l => l.textContent?.includes(label));
  const input = parent?.querySelector('input'); if (!input) throw new Error(`Không thấy checkbox ${label}`); return input;
};
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 400; i++) { if (condition()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }
  expect(condition(), document.body.textContent ?? '').toBe(true);
}
function save(name: string) {
  const dir = path.resolve('test-results/2026-10-24-quality'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.html`), document.documentElement.outerHTML);
}

it('edits the approved plan, refreshes a stale hash, blocks a missing negative case, then accepts after checks and warning acknowledgement', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  let negative = false, stale = true;
  const e = setup({ reply: qualityReply, files: x => x.role === 'author' ? ['tests/order.test.ts'] : ['src/order.ts'], check: () => ({ ...qualityGreen, report: qualityReport(negative ? 'passed' : 'missing') }) });
  const run = e.create({ mode: 'verify', budgetUsd: 10 }); e.orchestrator.startRun(run.id); await e.orchestrator.idle();
  app = await buildApp({ ...e, dataDir: mkdtempSync(path.join(tmpdir(), 'aidept-quality-dom-')), port: 14326 });
  app.addHook('preHandler', async request => {
    if (stale && request.method === 'POST' && request.url.endsWith('/approve-contract')) {
      stale = false; const contract = structuredClone(e.store.runs.get(run.id)!.contract); contract.testPlan!.cases[1]!.expected += '; dữ liệu không đổi'; e.orchestrator.reviseContract(run.id, contract);
    }
    if (request.method === 'POST' && request.url.endsWith('/recheck')) negative = true;
  });
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    requests.push(`${options.method ?? 'GET'} ${url}`);
    const response = await app!.inject({ url, method: (options.method ?? 'GET') as 'GET' | 'POST', headers: { ...options.headers, host: '127.0.0.1:14326' }, ...(options.body ? { payload: options.body } : {}) });
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, text: async () => response.body };
  });
  const div = document.createElement('div'); document.body.appendChild(div); root = createRoot(div);
  await act(async () => { root!.render(createElement(RunPage, { id: run.id, onBack: () => {}, onDeleted: async () => {} })); });
  await waitFor(() => document.body.textContent?.includes('Kế hoạch ca kiểm thử') ?? false);
  expect(button(/^Duyệt hợp đồng v/).disabled).toBe(true);
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('Hợp đồng');
  await click(checkbox('Tôi đã đọc các cảnh báo'));
  expect(button(/^Duyệt hợp đồng v/).disabled).toBe(false);
  await click(button('Sửa hợp đồng'));
  const input = document.querySelector('textarea[aria-label="expected C-2"]') as HTMLTextAreaElement;
  expect(input.value).toContain('Vẫn đúng một đơn');
  const oracleInput = document.querySelector('textarea[aria-label="Giải thích căn cứ C-2"]') as HTMLTextAreaElement;
  expect(oracleInput.value).toContain('quoted public requirement');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(oracleInput, `${oracleInput.value} Verify retry explicitly.`); oracleInput.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, `${input.value}; không đổi tồn kho`); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await click(button('Lưu phiên bản mới'));
  await waitFor(() => !document.querySelector('dialog'));
  expect(e.store.runs.get(run.id)!.contract.testPlan!.cases[1]!.expected).toContain('không đổi tồn kho');
  expect(e.store.runs.get(run.id)!.contract.testPlan!.cases[1]!.oracle!.explanation).toContain('Verify retry explicitly.');
  expect(checkbox('Tôi đã đọc các cảnh báo').checked).toBe(false);
  expect(button(/^Duyệt hợp đồng v/).disabled).toBe(true);
  await click(checkbox('Tôi đã đọc các cảnh báo')); await click(button(/^Duyệt hợp đồng v/));
  await waitFor(() => document.body.textContent?.includes('Hợp đồng đã thay đổi') ?? false);
  expect(checkbox('Tôi đã đọc các cảnh báo').checked).toBe(false); save('ui-stale-hash');
  await click(checkbox('Tôi đã đọc các cảnh báo')); await click(button(/^Duyệt hợp đồng v/));
  await act(async () => { await e.orchestrator.idle(); });
  await waitFor(() => document.body.textContent?.includes('thiếu hoặc bỏ qua test đã khóa') ?? false);
  await click(button('Kiểm chứng'));
  expect(document.body.textContent).toContain('C-2'); expect(document.body.textContent).toContain('Thiếu bằng chứng');
  expect(e.orchestrator.detail(run.id).completion.ready).toBe(false); save('ui-required-case-blocked');
  const calls = e.runtime.calls.filter(c => c.startsWith('agent:')).length;
  await click(button('Chạy lại check')); await act(async () => { await e.orchestrator.idle(); });
  await waitFor(() => document.body.textContent?.includes('Tôi đã đọc') && document.body.textContent?.includes('vẫn muốn nghiệm thu') || false);
  expect(e.runtime.calls.filter(c => c.startsWith('agent:')).length).toBe(calls);
  expect(document.body.textContent).toContain('Các ca đã khai báo đạt'); expect(document.body.textContent).toContain('Runtime này chưa cung cấp adapter mutation');
  expect(button('Nghiệm thu').disabled).toBe(true);
  await click(checkbox('vẫn muốn nghiệm thu'));
  expect(button('Nghiệm thu').disabled).toBe(false); save('ui-cases-passed-warning');
  await click(button('Nghiệm thu'));
  await waitFor(() => e.store.runs.get(run.id)?.status === 'completed');
  expect(e.runtime.calls.filter(c => c.startsWith('agent:')).length).toBe(calls);
  expect(e.store.runs.get(run.id)!.delivery?.status).toBe('succeeded'); save('ui-accepted');
  expect(requests.some(r => r.endsWith('/accept'))).toBe(true);
}, 15_000);
