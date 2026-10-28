// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { LiveTab, LIVE_FILTER_KEY } from '../src/client/MonitorLive.js';
import type { MonitorData, RequestRow } from '../src/core/monitor.js';

vi.mock('../src/client/Monitor', () => ({ LogConsole: ({ runId }: { runId?: string }) => createElement('div', { 'data-log-run': runId }, `Log riêng ${runId}`) }));
let root: Root | undefined;
let storageDom: JSDOM;
const now = Date.parse('2026-10-24T12:00:00Z');
const requests: string[] = [];
const request = (runId: string): RequestRow => ({ id: `att-${runId}`, runId, projectId: runId.startsWith('beta') ? 'b' : 'a', runTitle: runId, role: 'developer', slot: 'A', stage: 'implement', provider: 'codex', model: `long-model-name-for-${runId}`, status: 'completed', startedAt: new Date(now - 60_000).toISOString(), inputTokens: 100, cachedTokens: 0, outputTokens: 10, costUsd: 0.01 });
const data = (): MonitorData => ({
  now: new Date(now).toISOString(), period: 'today', unit: 'hour', projects: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }],
  totals: { requests: 0, failed: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, estimated: false }, previous: { requests: 0, failed: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, estimated: false },
  series: [], byModel: [], activeRuns: [], runningAttempts: [], recent: [request('alpha-history'), request('beta-history')], errorsLastHour: 0, activity: { providers: [], stages: { setup: false, check: false } }, tasks: [{ id: 'old-finished', title: 'Old completed task', mode: 'single', status: 'completed' }],
  cacheRate: 0, acceptedInPeriod: 0, costPerAccepted: null, byTask: [], byRole: [], byProject: [], waste: { items: [], costUsd: 0 }, alerts: [], live: [],
  waiting: [
    ...Array.from({ length: 8 }, (_, i) => ({ kind: 'accept' as const, runId: `alpha-${i}`, projectId: 'a', title: `Nghiệm thu Alpha ${i}`, detail: 'Ready for acceptance', updatedAt: new Date(now - i * 1000).toISOString() })),
    { kind: 'accept', runId: 'beta-accept', projectId: 'b', title: 'Nghiệm thu Beta', detail: 'Ready', updatedAt: new Date(now).toISOString() },
    { kind: 'approve-contract', runId: 'alpha-contract', projectId: 'a', title: 'Hợp đồng Alpha', detail: 'Approve contract', updatedAt: new Date(now).toISOString() },
    { kind: 'approve-policy', projectId: 'b', title: 'Beta', detail: 'Approve policy', updatedAt: new Date(now).toISOString() },
    { kind: 'failed', runId: 'alpha-failed', projectId: 'a', title: 'Lỗi Alpha', detail: 'Failed assertion', updatedAt: new Date(now).toISOString() },
  ],
});
beforeEach(() => {
  // Vitest 3 can inherit Node's unavailable Web Storage instead of jsdom's browser Storage.
  storageDom = new JSDOM('', { url: 'http://localhost/' });
  vi.stubGlobal('localStorage', storageDom.window.localStorage);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); requests.length = 0;
  vi.stubGlobal('fetch', async (url: string) => { requests.push(url); const runId = new URL(url, 'http://localhost').searchParams.get('run') ?? ''; return { ok: true, status: 200, text: async () => JSON.stringify([request(runId)]) }; });
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); storageDom.window.close(); });
async function render(value = data(), onOpen = vi.fn()) {
  if (!root) { const host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => root!.render(createElement(LiveTab, { data: value, now, onOpen })));
}
function button(label: string) { const b = [...document.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label); if (!b) throw Error(`Missing ${label}: ${document.body.textContent}`); return b; }
function scope(name: string) { return [...document.querySelectorAll('[aria-label="Lọc tình trạng theo dõi"] button')].find(b => b.textContent?.startsWith(name)) as HTMLButtonElement; }
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function input(value: string) { const element = document.querySelector('[aria-label="Tìm task theo dõi"]') as HTMLInputElement; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function project(value: string) { const element = document.querySelector('[aria-label="Lọc project theo dõi"]') as HTMLSelectElement; await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }); }
const focus = () => document.querySelector('[aria-label="Chi tiết task được chọn"]')!;

it('prioritizes waiting work when idle, bounds each group, and loads only the selected task', async () => {
  await render();
  expect(scope('Chờ bạn').getAttribute('aria-pressed')).toBe('true'); expect(scope('Chờ bạn').textContent).toContain('12');
  expect(document.querySelector('[aria-label="Nghiệm thu"]')!.querySelectorAll('.monitor-task')).toHaveLength(5);
  expect(document.querySelector('.topology')).not.toBeNull(); expect(document.querySelector('.topology')?.textContent).not.toContain('Old completed task'); expect(focus().textContent).toContain('Nghiệm thu Alpha 0');
  expect(requests).toEqual(['/api/monitor/requests?run=alpha-0']);
  expect(focus().textContent).toContain('long-model-name-for-alpha-0'); expect(focus().textContent).not.toContain('beta-history');
  await click(button('Xem thêm 4 việc')); expect(document.querySelector('[aria-label="Nghiệm thu"]')!.querySelectorAll('.monitor-task')).toHaveLength(9);
  await click(button('Thu gọn nghiệm thu')); expect(document.querySelector('[aria-label="Nghiệm thu"]')!.querySelectorAll('.monitor-task')).toHaveLength(5);
});

it('filters by project and accent-insensitive query, then keeps filters and selection across navigation', async () => {
  await render(); await project('b'); expect(scope('Chờ bạn').textContent).toContain('2');
  expect(document.querySelectorAll('.monitor-task')).toHaveLength(2);
  await input('nghiem thu'); expect(document.querySelectorAll('.monitor-task')).toHaveLength(1);
  await click(button('Xem hoạt động: Nghiệm thu Beta')); expect(focus().textContent).toContain('long-model-name-for-beta-accept');
  await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = '';
  await render(); expect((document.querySelector('[aria-label="Lọc project theo dõi"]') as HTMLSelectElement).value).toBe('b');
  expect((document.querySelector('[aria-label="Tìm task theo dõi"]') as HTMLInputElement).value).toBe('nghiem thu');
  expect(focus().textContent).toContain('Nghiệm thu Beta'); expect(JSON.parse(localStorage.getItem(LIVE_FILTER_KEY)!).selected).toBe('run:beta-accept');
});

it('keeps a selected task pinned across polling and scopes the log to it', async () => {
  const value = data(); await render(value); await click(button('Xem hoạt động: Nghiệm thu Alpha 2'));
  const updated = structuredClone(value); updated.now = new Date(now + 2000).toISOString(); updated.waiting.unshift({ ...updated.waiting[0]!, runId: 'new-first', title: 'New first task' });
  await render(updated); expect(focus().textContent).toContain('Nghiệm thu Alpha 2'); expect(focus().textContent).not.toContain('long-model-name-for-new-first');
  await click(button('Log task')); expect(document.querySelector('[data-log-run]')?.getAttribute('data-log-run')).toBe('alpha-2');
  await click(button('Xem hoạt động: Nghiệm thu Alpha 1')); expect(document.querySelector('[data-log-run]')).toBeNull();
  expect(focus().textContent).toContain('long-model-name-for-alpha-1');
});

it('shows only errors on the error filter and leaves project approvals without a fake task console', async () => {
  await render(); await click(scope('Lỗi / bị chặn')); expect(document.querySelectorAll('.monitor-task')).toHaveLength(1); expect(focus().textContent).toContain('Lỗi Alpha');
  await click(scope('Chờ bạn')); await click(button('Xem hoạt động: Beta'));
  expect(focus().textContent).toContain('không có log task riêng'); expect([...focus().querySelectorAll('button')].some(b => b.textContent === 'Log task')).toBe(false);
  expect(requests.some(url => url.endsWith('run=undefined'))).toBe(false);
});

it('groups recent calls by task and opens the existing request detail callback', async () => {
  const open = vi.fn(); await render(data(), open); await click(scope('Gần đây'));
  expect(document.querySelectorAll('.monitor-task')).toHaveLength(2);
  await click(button('Xem hoạt động: beta-history')); expect(focus().textContent).toContain('long-model-name-for-beta-history');
  await click(focus().querySelector('.call-row')! as HTMLButtonElement); expect(open).toHaveBeenCalledWith(expect.objectContaining({ runId: 'beta-history' }));
});

it('always shows the flow and only includes running tasks, excluding queued/waiting/completed tasks', async () => {
  const value = data(); value.live = [{ id: 'live', projectId: 'a', title: 'Active task', mode: 'verify', stage: 'implement', role: 'developer', attemptStartedAt: new Date(now - 5000).toISOString(), budgetPct: .2, capUsd: 1, spentUsd: .2 }];
  value.activeRuns = [{ id: 'live', title: 'Active task', mode: 'verify', stage: 'implement', status: 'running', updatedAt: value.now }];
  value.live.push({ ...value.live[0]!, id: 'queued', title: 'Queued task' });
  value.activeRuns.push({ ...value.activeRuns[0]!, id: 'queued', title: 'Queued task', status: 'queued' });
  localStorage.setItem(LIVE_FILTER_KEY, JSON.stringify({ map: false }));
  await render(value); expect(scope('Đang chạy').getAttribute('aria-pressed')).toBe('true'); expect(document.querySelector('.topology')?.textContent).toContain('Active task');
  expect(document.querySelector('.topology > svg')?.getAttribute('viewBox')).toBe('0 0 880 480');
  expect(document.querySelector('.topology')?.textContent).not.toContain('Old completed task');
  expect(document.querySelector('.topology')?.textContent).not.toContain('Queued task');
  expect(document.querySelector('.topology')?.textContent).not.toContain('Nghiệm thu Alpha');
  await render(data()); expect(document.querySelector('.topology')).not.toBeNull(); expect(document.querySelector('.topology')?.textContent).not.toContain('Active task');
  expect(document.querySelector('.topology > svg')?.getAttribute('viewBox')).toBe('0 0 880 300');
  expect(document.querySelector('.topology')?.textContent).toContain('Luồng hoạt động sẽ hiện khi task bắt đầu.');
});

it('handles invalid storage, empty filters, and per-task request failures without leaking another task', async () => {
  localStorage.setItem(LIVE_FILTER_KEY, 'invalid JSON'); await render(); await input('does not exist');
  expect(document.body.textContent).toContain('Không có việc khớp bộ lọc'); expect(document.querySelector('[aria-label="Chi tiết task được chọn"]')).toBeNull();
  await click(button('Xóa bộ lọc'));
  vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'Fixture history unavailable' }) }));
  await click(button('Xem hoạt động: Nghiệm thu Alpha 1')); expect(focus().textContent).toContain('Fixture history unavailable'); expect(focus().textContent).not.toContain('long-model-name-for-alpha-0');
});

it('does not let a delayed response for a previous selection replace the current task', async () => {
  let resolveOld: ((value: unknown) => void) | undefined;
  vi.stubGlobal('fetch', async (url: string) => url.endsWith('run=alpha-0') ? new Promise(resolve => { resolveOld = resolve; }) : { ok: true, status: 200, text: async () => JSON.stringify([request('alpha-1')]) });
  await render(); await click(button('Xem hoạt động: Nghiệm thu Alpha 1'));
  await act(async () => resolveOld!({ ok: true, status: 200, text: async () => JSON.stringify([request('alpha-0')]) }));
  expect(focus().textContent).toContain('long-model-name-for-alpha-1'); expect(focus().textContent).not.toContain('long-model-name-for-alpha-0');
  const output = path.resolve('test-results/monitor-live'); mkdirSync(output, { recursive: true }); writeFileSync(path.join(output, 'selected-task.html'), document.documentElement.outerHTML);
});
