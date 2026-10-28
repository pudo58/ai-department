// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewPanel } from '../src/client/ReviewPanel.js';
import { VisualReview } from '../src/client/VisualReview.js';
import { buildReport } from '../src/core/report.js';
import { summarizeCheck } from '../src/core/checks.js';
import { recipeHash } from '../src/core/qualityevidence.js';
import { setupLegacy, green } from './helpers.js';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/client/api', () => ({ api: mock.api }));
vi.mock('../src/client/Monitor', () => ({ LogConsole: () => null, useNow: () => Date.now() }));
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); mock.api.mockReset(); });
const mount = async (element: ReturnType<typeof createElement>) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(element)); return host;
};
function fixture() {
  const e = setupLegacy(), run = e.create(); run.status = 'awaiting_acceptance'; run.checkpoint = 'c'.repeat(40);
  run.contract.requirements[0]!.manual = true;
  run.contract.design = { snapshotId: 'dsn_aaaaaaaaaaaa', snapshotHash: 'a'.repeat(64), targetIds: ['1:2'], acknowledgedIssueIds: [], designPolicyVersion: 1 };
  e.store.runs.put(run);
  const check = summarizeCheck({ id: 'chk_test', runId: run.id, recipe: run.configSnapshot.checks[0]!, checkpoint: run.checkpoint, contractVersion: run.contract.version }, [{ exitCode: 0, durationMs: 1, checkpoint: run.checkpoint, incomplete: false, log: '', report: green.report }]);
  e.store.checks.put({ ...check, configHash: recipeHash(run), slot: 'A' });
  return e.orchestrator.detail(run.id);
}
describe('separate test and visual evidence', () => {
  it('shows passing tests on a manual requirement without upgrading the whole requirement to verified', async () => {
    const detail = fixture();
    const report = buildReport({ ...detail, changes: { available: false, files: [], patch: '' } });
    mock.api.mockResolvedValue(report);
    const host = await mount(createElement(ReviewPanel, { detail, busy: false, onAccept: vi.fn(), onReject: vi.fn() }));
    expect(host.textContent).toContain('1 test đạt');
    expect(host.textContent).toContain('Đã kiểm tra một phần');
    expect(host.textContent).toContain('Chưa có bằng chứng');
    expect(report.requirements[0]!.status).toBe('manual_pending');
    expect(detail.run.contract.requirements[0]!.manual).toBe(true);
  });
  it('submits an explicitly approved profile without inventing a tolerance or accepting the contract', async () => {
    const detail = fixture(), changed = vi.fn(); mock.api.mockResolvedValue({});
    const host = await mount(createElement(VisualReview, { detail, onChanged: changed }));
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'Duyệt profile và kiểm tra')!;
    await act(async () => button.click());
    expect(mock.api).toHaveBeenCalledWith(`/api/runs/${detail.run.id}/visual-check`, 'POST', { profile: { pathTemplate: '/', pixelThreshold: 0.1 } });
    expect(changed).toHaveBeenCalledOnce();
    expect(mock.api.mock.calls.some(([p]) => /accept|approve-contract/.test(p))).toBe(false);
  });
});
