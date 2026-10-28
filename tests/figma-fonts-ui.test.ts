// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DesignFonts } from '../src/client/DesignFonts.js';
import type { SnapshotFonts } from '../src/shared/fonts.js';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/client/api', () => ({ api: mock.api }));
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); mock.api.mockReset(); });
const mount = async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(DesignFonts, { snapshotId: 'dsn_aaaaaaaaaaaa' }))); return host;
};
const base: SnapshotFonts = { hosts: ['api.fontsource.org', 'cdn.jsdelivr.net'], uses: [
  { family: 'Roboto', variants: [{ weight: 400, italic: false }, { weight: 500, italic: false }], nodes: 40 },
  { family: 'FS Magistral', variants: [{ weight: 400, italic: false }], nodes: 1 },
] };
const fetched: SnapshotFonts = { ...base, set: { schemaVersion: 1, snapshotId: 'dsn_aaaaaaaaaaaa', snapshotHash: 'a'.repeat(64), fetchedAt: '2026-10-28T15:00:00Z', families: [
  { family: 'Roboto', status: 'ready', id: 'roboto', version: '5.3.0', license: 'OFL-1.1', files: new Array(6).fill(0).map((_, i) => ({ file: `x${i}`, name: `x${i}.woff2`, family: 'Roboto', weight: 400, italic: false, subset: 'latin', sha256: 'a', bytes: 1 })), notes: [] },
  { family: 'FS Magistral', status: 'not_open', files: [], notes: ['Không có trong kho font mã nguồn mở (fontsource). Có thể là font thương mại: cần bạn cung cấp file font hợp lệ.'] },
] } };

describe('the fonts of a snapshot', () => {
  it('lists what the text uses and fetches nothing until the button is pressed, naming the hosts it would use', async () => {
    mock.api.mockResolvedValue(base);
    const host = await mount();
    expect(host.textContent).toContain('Roboto'); expect(host.textContent).toContain('độ đậm 400, 500'); expect(host.textContent).toContain('chưa tải');
    expect(host.textContent).toContain('api.fontsource.org và cdn.jsdelivr.net');
    expect(mock.api.mock.calls.every(([, method]) => method === undefined)).toBe(true);
  });
  it('asks for the fetch with an explicit confirmation, then shows each family, what was kept and what is missing', async () => {
    mock.api.mockImplementation(async (_url: string, method?: string) => (method === 'POST' ? {} : mock.api.mock.calls.some(([, m]) => m === 'POST') ? fetched : base));
    const host = await mount();
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Tải font mở')!;
    await act(async () => button.click());
    expect(mock.api).toHaveBeenCalledWith('/api/design-snapshots/dsn_aaaaaaaaaaaa/fonts', 'POST', { confirm: true });
    const rows = [...host.querySelectorAll('[data-testid="font-row"]')].map((r) => r.textContent!);
    expect(rows[0]).toContain('Đã có file'); expect(rows[0]).toContain('6 file, OFL-1.1');
    expect(rows[1]).toContain('Không có trong kho mở'); expect(rows[1]).toContain('thương mại');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Tải lại font mở')).toBe(true);
  });
  it('says so when the fetch fails, and keeps the list', async () => {
    mock.api.mockImplementation(async (_url: string, method?: string) => { if (method === 'POST') throw new Error('Mạng không khả dụng'); return base; });
    const host = await mount();
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Tải font mở')!.click());
    expect(host.textContent).toContain('Mạng không khả dụng'); expect(host.textContent).toContain('Roboto');
  });
});
