// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DesignSnapshot, IntegrationSummary, SnapshotPreview } from '../src/shared/design.js';
import type { ExportIssue, HelloInfo } from '../src/shared/figma.js';

// The API is a script: each path answers what the test says, and every call is written down.
const calls: { path: string; method: string; body?: unknown }[] = [];
const answers = new Map<string, unknown | ((body?: unknown) => unknown)>();
vi.mock('../src/client/api', () => ({
  api: async (path: string, method = 'GET', body?: unknown) => {
    calls.push({ path, method, body });
    // An answer may be for one method of a path ("POST /api/x"), which wins over one for the path alone.
    const key = [...answers.keys()].filter((k) => k === `${method} ${path}` || path === k || path.startsWith(`${k}?`)).sort((a, b) => b.length - a.length)[0];
    const hit = key !== undefined ? answers.get(key) : undefined;
    if (hit === undefined && !answers.has(key ?? '')) throw new Error(`không có câu trả lời cho ${method} ${path}`);
    const value = typeof hit === 'function' ? (hit as (b?: unknown) => unknown)(body) : hit;
    if (value instanceof Error) throw value;
    return value;
  },
}));
vi.mock('../src/client/Monitor', () => ({ LogConsole: () => null, useNow: () => Date.now() }));
vi.mock('../src/client/Preview', () => ({ PreviewButton: () => null }));

import { McpPage, SnapshotDialog } from '../src/client/McpPage.js';
import { DesignBindingView, DesignPicker, designField } from '../src/client/DesignBinding.js';

// jsdom has no <dialog> behaviour; the modal only needs it to open and close.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.removeAttribute('open'); };

let root: Root | undefined;
beforeEach(() => { calls.length = 0; answers.clear(); answers.set('/api/design-snapshots/dsn_aaaaaaaaaaaa/previews', { images: [], warnings: [] }); answers.set('/api/design-snapshots/dsn_aaaaaaaaaaaa/diagnostics', { groups: [] }); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.useRealTimers(); });

async function mount(node: ReturnType<typeof createElement>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(node));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}
const button = (host: ParentNode, text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined) => { expect(el, 'phải có nút').toBeDefined(); await act(async () => { (el as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }); };
const text = (host: ParentNode) => host.textContent ?? '';

const hello: HelloInfo = { protocolVersion: 1, readerVersion: 1, pluginVersion: '1.0.0', editorType: 'figma', apiVersion: '1.0.0', fileName: 'Thiết kế A', fileKey: 'KEY1234567890', pages: [{ id: '0:1', name: 'Trang 1', childCount: 2 }, { id: '0:2', name: 'Trang 2', childCount: -1 }], selection: [{ id: '1:2', name: 'Màn hình', type: 'FRAME', pageId: '0:1', pageName: 'Trang 1' }], currentPageId: '0:1', sourceSession: 'abcdefghijklmnop12345' };
const summary = (over: Partial<IntegrationSummary> = {}): IntegrationSummary => ({
  id: 'figma-desktop', label: 'Figma Desktop · Kết nối trực tiếp', adapter: 'figma-direct', badge: 'Desktop · Trực tiếp',
  desktop: { state: 'installed', executable: 'C:\\Figma.exe', version: '126.9.16', signed: true, running: true, catalogVersion: '126.9.16' },
  bundle: { state: 'prepared', dir: 'C:\\x', pluginVersion: '1.0.0', protocolVersion: 1, origin: 'http://127.0.0.1:4310', note: 'Import manifest.json trong Figma.' },
  connection: { state: 'unpaired' }, platform: { supported: true }, ...over,
});
const issue = (id: string, severity: ExportIssue['severity'], message: string): ExportIssue => ({ id, code: id.split('|')[0]!, severity, message });
const snapshot = (over: Partial<DesignSnapshot> = {}): DesignSnapshot & { references: { projects: string[]; runs: string[] }; integrity: { ok: boolean; problems: string[] } } => ({
  id: 'dsn_aaaaaaaaaaaa', schemaVersion: 1, jobId: 'fej_1', status: 'draft', limited: false, readerVersion: 1, protocolVersion: 1, pluginVersion: '1.0.0',
  source: { fileName: 'Thiết kế A', sourceSession: 's', identity: 'verified', fileKey: 'KEY', editorType: 'figma', apiVersion: '1', pluginVersion: '1.0.0' },
  scope: { kind: 'file', rootIds: [], pageIds: ['0:1'], hash: 'h' }, limits: { jobMs: 1, maxNodes: 1, maxBytes: 1, maxAssetBytes: 1 }, startedAt: '2026-10-28T01:00:00Z', endedAt: '2026-10-28T01:01:00Z',
  coverage: { structureComplete: true, fieldCoverage: { all: { total: 100, read: 90, mixed: 2, notApplicable: 5, unsupported: 1, unavailable: 1, error: 1 }, byGroup: {} }, dependencyCoverage: { total: 4, resolved: 3, dependencyOnly: 1, unavailable: 1 },
    assetCoverage: { total: 3, stored: 2, missing: 1, oversize: 0, error: 0, previewOnly: 1 }, sourceIdentity: 'verified', consistency: 'unchanged_across_passes' },
  issues: [], counts: { pages: 3, nodes: 120, components: 4, styles: 2, variables: 5, collections: 1, assets: 3, bytes: 1000 }, contentHash: 'c'.repeat(64), snapshotHash: 'a'.repeat(64), files: [], roots: [{ id: '1:2', name: 'Màn hình', type: 'FRAME', pageId: '0:1' }],
  createdAt: '2026-10-28T01:02:00Z', references: { projects: [], runs: [] }, integrity: { ok: true, problems: [] }, ...over,
});

it('shows Desktop, the plugin and the connection as three separate states, with the two buttons that were asked for', async () => {
  answers.set('/api/integrations', [summary({ connection: { state: 'connected', instanceName: 'AI Department', hello, connectedAt: '2026-10-28T01:00:00Z' } })]);
  answers.set('/api/design-exports', []); answers.set('/api/design-snapshots', []); answers.set('/api/integrations/figma/install', []);
  const host = await mount(createElement(McpPage));
  expect(text(host)).toContain('Figma Desktop · Kết nối trực tiếp');
  expect(host.querySelector('[data-testid="desktop-state"]')!.textContent).toContain('Đã cài · 126.9.16 · đang mở');
  expect(host.querySelector('[data-testid="bundle-state"]')!.textContent).toContain('cần import một lần');
  expect(host.querySelector('[data-testid="connection-state"]')!.textContent).toContain('Đã kết nối · Thiết kế A');
  // "Open" is not "connected" and "connected" is not "read": the page says so rather than showing one green light.
  expect(text(host)).toContain('Desktop đã mở chưa phải đã đọc đủ');
  for (const label of ['Cài Figma Desktop & Exporter', 'Mở Figma để đăng nhập', 'Mở thư mục Exporter', 'Ngắt kết nối', 'Kiểm tra kết nối', 'Chọn nguồn và phạm vi']) expect(button(host, label), label).toBeDefined();
  expect(text(host)).toContain('Chưa có trình nhập MCP tùy ý');
});

it('asks for a pairing code, shows it, and runs the check without suggesting any agent', async () => {
  answers.set('/api/integrations', [summary()]);
  answers.set('/api/design-exports', []); answers.set('/api/design-snapshots', []); answers.set('/api/integrations/figma/install', []);
  answers.set('/api/integrations/figma/pairing', { code: '12345678', expiresAt: '2026-10-28T01:05:00Z' });
  const host = await mount(createElement(McpPage));
  expect(button(host, 'Kiểm tra kết nối')!.disabled).toBe(true);
  expect(button(host, 'Chọn nguồn và phạm vi')!.disabled).toBe(true);
  answers.set('/api/integrations', [summary({ connection: { state: 'pairing', pairingCode: { code: '12345678', expiresAt: '2026-10-28T01:05:00Z' } } })]);
  await click(button(host, 'Ghép đôi'));
  expect(calls.some((c) => c.path === '/api/integrations/figma/pairing' && c.method === 'POST')).toBe(true);
  expect(host.querySelector('[data-testid="pairing-code"]')!.textContent).toBe('12345678');
  answers.set('/api/integrations', [summary({ connection: { state: 'connected', hello } })]);
  answers.set('/api/integrations/figma/check', { ok: true, checks: [{ id: 'protocol', ok: true, detail: 'Giao thức 1' }, { id: 'file_key', ok: false, detail: 'Plugin không trả được file key' }] });
  await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
  await click(button(host, 'Kiểm tra kết nối'));
  const list = host.querySelector('[aria-label="Kết quả kiểm tra"]')!;
  expect(list.textContent).toContain('Giao thức 1');
  expect(list.textContent).toContain('Lưu ý');
}, 20000);

it('displays a replacement pairing code when reconnecting an interrupted plugin', async () => {
  answers.set('/api/integrations', [summary({ connection: { state: 'interrupted', hello } })]);
  answers.set('/api/design-exports', []); answers.set('/api/design-snapshots', []); answers.set('/api/integrations/figma/install', []);
  const pairingCode = { code: '01234567', expiresAt: '2026-10-28T04:00:00Z' };
  answers.set('POST /api/integrations/figma/pairing', () => {
    answers.set('/api/integrations', [summary({ connection: { state: 'pairing', pairingCode } })]);
    return pairingCode;
  });
  const host = await mount(createElement(McpPage));
  expect(host.querySelector('[data-testid="connection-state"]')?.textContent).toContain('Gián đoạn');
  await click(button(host, 'Ghép đôi'));
  expect(host.querySelector('[data-testid="pairing-code"]')?.textContent).toBe('01234567');
  expect(host.querySelector('[data-testid="connection-state"]')?.textContent).toContain('Chờ nhập mã');
  expect(button(host, 'Chọn nguồn và phạm vi')!.disabled).toBe(true);
});

it('lists the install steps with the one thing to do when a step failed', async () => {
  answers.set('/api/integrations', [summary({ desktop: { state: 'not_installed', catalogVersion: '126.9.16' }, bundle: { state: 'missing', note: 'Chưa chuẩn bị plugin Exporter.' } })]);
  answers.set('/api/design-exports', []); answers.set('/api/design-snapshots', []);
  answers.set('/api/integrations/figma/install', [{ id: 'ins_1', adapter: 'figma-direct', status: 'failed', createdAt: 'x', log: [], error: { code: 'installer_failed', message: 'Installer thoát với mã 1.', hint: 'Chính sách của máy có thể chặn cài đặt.' },
    steps: [{ id: 'detect', label: 'Tìm Figma Desktop', status: 'done' }, { id: 'download', label: 'Tải installer chính thức', status: 'done' }, { id: 'install', label: 'Cài đặt (quyền người dùng, không cần admin)', status: 'failed', detail: 'mã 1' }] }]);
  const host = await mount(createElement(McpPage));
  expect(text(host)).toContain('Chưa cài');
  expect(text(host)).toContain('Cài đặt (quyền người dùng, không cần admin)');
  expect(text(host)).toContain('Installer thoát với mã 1.');
  expect(text(host)).toContain('Chính sách của máy có thể chặn');
  expect(button(host, 'Mở Figma để đăng nhập')!.disabled).toBe(true);
  expect(button(host, 'Mở thư mục Exporter')!.disabled).toBe(true);
});

const openExport = async (h: HelloInfo) => {
  answers.set('/api/integrations', [summary({ connection: { state: 'connected', hello: h } })]);
  answers.set('/api/design-exports', []); answers.set('/api/design-snapshots', []); answers.set('/api/integrations/figma/install', []);
  answers.set('/api/integrations/figma/browse', { hello: h });
  const host = await mount(createElement(McpPage));
  await click(button(host, 'Chọn nguồn và phạm vi'));
  return host;
};
const dialog = (host: ParentNode) => host.querySelector('dialog')!;
const radio = (host: ParentNode, label: string) => [...host.querySelectorAll('label')].find((l) => l.textContent?.includes(label))!.querySelector('input') as HTMLInputElement;

it('starts from the selection, makes whole-file an explicit choice, and sends exactly what was chosen', async () => {
  const host = await openExport(hello);
  expect(radio(dialog(host), 'Frame đang chọn').checked).toBe(true);
  expect(radio(dialog(host), 'Toàn bộ file').checked).toBe(false);
  answers.set('POST /api/design-exports', { id: 'fej_1' });
  await click(button(dialog(host), 'Bắt đầu export'));
  expect(calls.filter((c) => c.path === '/api/design-exports' && c.method === 'POST').at(-1)!.body).toMatchObject({ scope: 'selection', rootIds: ['1:2'] });
  expect((calls.filter((c) => c.path === '/api/design-exports' && c.method === 'POST').at(-1)!.body as { limits?: unknown }).limits).toBeUndefined();
});

it('does not start a whole-file export until it was chosen, and sends limits only when the advanced box is open', async () => {
  const host = await openExport({ ...hello, selection: [] });
  expect(button(dialog(host), 'Bắt đầu export')!.disabled).toBe(true);
  await click(radio(dialog(host), 'Toàn bộ file'));
  await click([...dialog(host).querySelectorAll('label')].find((l) => l.textContent?.includes('Giới hạn nâng cao'))!.querySelector('input')!);
  expect(button(dialog(host), 'Bắt đầu export')!.disabled).toBe(false);
  answers.set('POST /api/design-exports', { id: 'fej_2' });
  await click(button(dialog(host), 'Bắt đầu export'));
  const body = calls.filter((c) => c.path === '/api/design-exports' && c.method === 'POST').at(-1)!.body as { scope: string; limits: Record<string, number> };
  expect(body.scope).toBe('file');
  expect(body.limits).toEqual({ jobMs: 600_000, maxNodes: 20_000, maxBytes: 200 * 1048576, maxAssetBytes: 25 * 1048576 });
});

it('needs the person to vouch for the file when the plugin cannot give its key', async () => {
  const noKey = { ...hello }; delete noKey.fileKey;
  const host = await openExport(noKey);
  expect(text(dialog(host))).toContain('plugin không trả được file key');
  expect(button(dialog(host), 'Bắt đầu export')!.disabled).toBe(true);
  await click([...dialog(host).querySelectorAll('label')].find((l) => l.textContent?.includes('Tôi xác nhận đây đúng là file'))!.querySelector('input')!);
  expect(button(dialog(host), 'Bắt đầu export')!.disabled).toBe(false);
  answers.set('POST /api/design-exports', { id: 'fej_3' });
  await click(button(dialog(host), 'Bắt đầu export'));
  expect(calls.filter((c) => c.path === '/api/design-exports' && c.method === 'POST').at(-1)!.body).toMatchObject({ attestSource: true });
});

const reviewing = async (snap: ReturnType<typeof snapshot>) => {
  answers.set(`/api/design-snapshots/${snap.id}`, () => snap);
  const onChanged = vi.fn(async () => {});
  const host = await mount(createElement(SnapshotDialog, { id: snap.id, others: [], onClose: () => {}, onChanged }));
  return { host, onChanged };
};
const tab = (host: ParentNode, label: string) => [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.includes(label))!;

it('shows what was read as six separate facts and the one of two labels, never a percentage', async () => {
  const { host } = await reviewing(snapshot());
  const table = host.querySelector('[aria-label="Kiểm kê"]')!;
  for (const row of ['Cấu trúc', 'Trường dữ liệu', 'Phụ thuộc', 'Tài nguyên', 'Nguồn', 'Nhất quán']) expect(table.textContent, row).toContain(row);
  expect(table.textContent).toContain('90 đã đọc');
  expect(table.textContent).toContain('Không thấy thay đổi qua các lượt đối chiếu (Figma không khóa tài liệu)');
  expect(text(host)).toContain('Đã đọc đủ cấu trúc trong phạm vi');
  expect(text(host)).not.toMatch(/\d+\s?%/);
  expect(text(host)).not.toContain('100%');
});

it('asks for every limit one by one, and a blocker means no approval at all', async () => {
  const snap = snapshot({ limited: true, issues: [issue('field_error|x|text.characters', 'limit', 'Trường text.characters: lỗi khi đọc'), issue('source_user_attested||', 'limit', 'Nguồn do người dùng xác nhận')] });
  const { host, onChanged } = await reviewing(snap);
  expect(text(host)).toContain('Có giới hạn');
  expect(button(host, 'Duyệt snapshot')!.disabled).toBe(true);
  await click(tab(host, 'Giới hạn'));
  const boxes = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  expect(boxes).toHaveLength(2);
  await click(boxes[0]);
  expect(button(host, 'Duyệt snapshot')!.disabled).toBe(true);
  await click(boxes[1]);
  expect(button(host, 'Duyệt snapshot')!.disabled).toBe(false);
  answers.set(`/api/design-snapshots/${snap.id}/publish`, snapshot({ status: 'published' }));
  await click(button(host, 'Duyệt snapshot'));
  const post = calls.find((c) => c.path.endsWith('/publish'))!;
  expect(post.body).toEqual({ snapshotHash: 'a'.repeat(64), acknowledgedIssueIds: ['field_error|x|text.characters', 'source_user_attested||'] });
  expect(onChanged).toHaveBeenCalled();
});

it('shows named screens beyond the old six-image limit, filters by node, and opens a 1:1 image with detail regions', async () => {
  const images: SnapshotPreview[] = Array.from({ length: 13 }, (_, i) => ({ nodeId: `1:${i}`, name: `Screen ${i}`, nodeType: 'FRAME', role: 'screen', fileId: `file${i}`, path: `assets/${i}.png`, width: 375, height: 812 }));
  images.push({ ...images[0], role: 'overview', nodeType: 'SECTION', name: 'Section overview' }, { ...images[0], role: 'detail', region: { x: 0, y: 2048, width: 375, height: 812 } });
  answers.set('/api/design-snapshots/dsn_aaaaaaaaaaaa/previews', { images, warnings: [] });
  const { host } = await reviewing(snapshot());
  const gallery = host.querySelector('[aria-label="Ảnh thiết kế"]')!;
  expect(text(gallery)).toContain('Màn hình (13)');
  expect(gallery.querySelectorAll('.design-preview-card')).toHaveLength(12);
  await click(button(gallery, 'Sau'));
  expect(gallery.querySelectorAll('.design-preview-card')).toHaveLength(1);
  expect(text(gallery)).toContain('Screen 12');
  const search = gallery.querySelector('input') as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '1:9'); search.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(text(gallery)).toContain('Screen 9');
  await click(gallery.querySelector('.design-preview-card')!);
  expect(gallery.querySelector('[aria-label="Ảnh lớn Screen 9"] img')?.getAttribute('src')).toContain('/files/file9');
  await click(button(gallery, 'Xem 1:1'));
  expect(gallery.querySelector('.design-preview-canvas')?.classList.contains('actual-size')).toBe(true);
  await click(button(gallery, 'Đóng ảnh'));
  expect(gallery.querySelector('.design-preview-viewer')).toBeNull();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, ''); search.dispatchEvent(new Event('input', { bubbles: true })); });
  await click(button(gallery, 'Vùng chi tiết'));
  expect(text(gallery)).toContain('y=2048');
});

it('lists warning groups with component context and opens the selected node without approving anything', async () => {
  const snap = snapshot({ limited: true, issues: [{ ...issue('asset_missing||asset', 'limit', 'Tài nguyên không lấy được'), field: 'asset' }] });
  answers.set(`/api/design-snapshots/${snap.id}/diagnostics`, { groups: [{ kind: 'component_properties', title: 'Component property không đọc được', explanation: 'Kiểm tra component gốc.', items: [{ nodeId: '1:4', name: 'Nút gửi', nodeType: 'INSTANCE', path: 'Login / Toolbar / Nút gửi', reason: 'Component set has existing errors', component: { nodeId: '2:1', name: 'Button, size=sm' } }] }] });
  answers.set(`/api/design-snapshots/${snap.id}/nodes/1%3A4`, { id: '1:4', name: 'Nút gửi', type: 'INSTANCE', fields: { 'instance.componentProperties': { s: 'error', r: 'Component set has existing errors' } }, groups: { instance: 'partial' } });
  answers.set(`/api/design-snapshots/${snap.id}/tree`, []);
  const { host } = await reviewing(snap);
  await click(tab(host, 'Giới hạn'));
  const details = host.querySelector('[aria-label="Chi tiết cảnh báo"]')!;
  expect(text(details)).toContain('Component property không đọc được (1)');
  expect(text(details)).toContain('Component gốc: Button, size=sm · 2:1');
  expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  expect(button(host, 'Duyệt snapshot')!.disabled).toBe(true);
  expect(text(host)).toContain('Thông báo gốc');
  await click(button(details, 'Nút gửi'));
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Node');
  expect(text(host)).toContain('Bản ghi 1:4 (INSTANCE)');
  expect(text(host)).toContain('Component set has existing errors');
});

it('shows a blocker, and offers no way to approve it', async () => {
  const { host } = await reviewing(snapshot({ issues: [issue('source_changed||', 'blocker', 'Nguồn đã thay đổi giữa hai lượt đọc')] }));
  await click(tab(host, 'Giới hạn'));
  expect(text(host)).toContain('Lỗi chặn (không thể duyệt)');
  expect(text(host)).toContain('Nguồn đã thay đổi giữa hai lượt đọc');
  expect(button(host, 'Duyệt snapshot')!.disabled).toBe(true);
});

it('forgets what was ticked as soon as the snapshot is a different one, so an old choice never approves new data', async () => {
  const limit = issue('field_error|x|y', 'limit', 'Trường y không đọc được');
  let current = snapshot({ limited: true, issues: [limit] });
  answers.set(`/api/design-snapshots/${current.id}`, () => current);
  const host = await mount(createElement(SnapshotDialog, { id: current.id, others: [], onClose: () => {}, onChanged: async () => {} }));
  await click(tab(host, 'Giới hạn'));
  await click(host.querySelector('input[type="checkbox"]')!);
  expect(button(host, 'Duyệt snapshot')!.disabled).toBe(false);
  // The server moves on (another hash) and refuses the old one: the page reloads, and the tick is gone with it.
  answers.set(`/api/design-snapshots/${current.id}/publish`, new Error('Hash snapshot đã đổi; tải lại, xem lại rồi duyệt đúng bản hiện tại.'));
  current = snapshot({ limited: true, issues: [limit], snapshotHash: 'b'.repeat(64) });
  await click(button(host, 'Duyệt snapshot'));
  expect(text(host)).toContain('Hash snapshot đã đổi');
  expect(button(host, 'Duyệt snapshot')!.disabled).toBe(true);
  expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
});

it('says a published snapshot is approved, with its limits, and that an edited one is no longer trustworthy', async () => {
  const limit = issue('field_error|x|y', 'limit', 'Trường y không đọc được');
  const pub = snapshot({ status: 'published', limited: true, issues: [limit], publish: { snapshotHash: 'a'.repeat(64), acknowledgedIssueIds: [limit.id], limited: true, publishedAt: '2026-10-28T02:00:00Z' } });
  const { host } = await reviewing({ ...pub, integrity: { ok: false, problems: ['File index.json đã bị sửa.'] } });
  expect(text(host)).toContain('Đã duyệt');
  expect(text(host)).toContain('Dữ liệu snapshot không còn khớp bản đã lưu');
  expect(button(host, 'Duyệt snapshot')).toBeUndefined();
});

it('lists only approved snapshots to choose from, and builds the request the server expects', async () => {
  answers.set('/api/design-snapshots', [snapshot({ id: 'dsn_pub', status: 'published', limited: true }), snapshot({ id: 'dsn_draft', status: 'draft' })]);
  let choice: Parameters<typeof designField>[0] = { kind: 'default' };
  const render = () => createElement(DesignPicker, { value: choice, onChange: (v) => { choice = v; } });
  const host = await mount(render());
  const options = [...host.querySelectorAll('option')].map((o) => o.textContent);
  expect(options.some((o) => o?.includes('Theo mặc định'))).toBe(true);
  expect(options.some((o) => o?.includes('Không dùng'))).toBe(true);
  expect(options.filter((o) => o?.includes('Thiết kế A'))).toHaveLength(1);
  expect(designField({ kind: 'default' })).toEqual({});
  expect(designField({ kind: 'none' })).toEqual({ design: { snapshotId: null } });
  expect(designField({ kind: 'snapshot', id: 'dsn_pub', targetIds: ['1:2'] })).toEqual({ design: { snapshotId: 'dsn_pub', targetIds: ['1:2'] } });
});

it('shows the design a contract is locked to, offers a change only while it can change, and says there is no visual check', async () => {
  const snap = snapshot({ status: 'published', limited: true, issues: [issue('field_error|x|y', 'limit', 'Trường y không đọc được')] });
  answers.set(`/api/design-snapshots/${snap.id}`, snap);
  const run = { id: 'run_1', status: 'awaiting_approval', contract: { version: 2, requirements: [], acceptanceExamples: [], interfaces: [], assumptions: [], scope: [], design: { snapshotId: snap.id, snapshotHash: 'a'.repeat(64), targetIds: ['1:2'], acknowledgedIssueIds: ['x'], designPolicyVersion: 1 } } } as never;
  const host = await mount(createElement(DesignBindingView, { run, canChange: true }));
  expect(text(host)).toContain('Thiết kế A');
  expect(text(host)).toContain('Có giới hạn');
  expect(text(host)).toContain('aaaaaaaaaaaa');
  expect(text(host)).toContain('1 target: 1:2');
  expect(text(host)).toContain('visual verification');
  expect(button(host, 'Đổi nguồn thiết kế')).toBeDefined();
  await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = '';
  const locked = await mount(createElement(DesignBindingView, { run, canChange: false }));
  expect(button(locked, 'Đổi nguồn thiết kế')).toBeUndefined();
  await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = '';
  const none = await mount(createElement(DesignBindingView, { run: { ...(run as object), contract: { ...(run as { contract: object }).contract, design: undefined } } as never, canChange: true }));
  expect(text(none)).toContain('Task này không dùng nguồn thiết kế');
  expect(button(none, 'Gắn nguồn thiết kế')).toBeDefined();
});

it('shows a snapshot that changed since the contract locked it, as an error the person can see', async () => {
  const snap = snapshot({ status: 'published', snapshotHash: 'b'.repeat(64) });
  answers.set(`/api/design-snapshots/${snap.id}`, snap);
  const run = { id: 'run_1', status: 'blocked', contract: { version: 1, requirements: [], acceptanceExamples: [], interfaces: [], assumptions: [], scope: [], design: { snapshotId: snap.id, snapshotHash: 'a'.repeat(64), targetIds: [], acknowledgedIssueIds: [], designPolicyVersion: 1 } } } as never;
  const host = await mount(createElement(DesignBindingView, { run, canChange: false }));
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('khác bản mà hợp đồng đã khóa');
});
