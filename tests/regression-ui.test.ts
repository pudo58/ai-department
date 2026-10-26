// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FindingActions, FindingProofList } from '../src/client/FindingEvidence.js';
import type { Finding, RunDetail } from '../src/shared/types.js';
import type { FindingProof, PendingRegression } from '../src/shared/regression.js';

vi.mock('../src/client/Monitor', () => ({ LogConsole: () => null, useNow: () => Date.now() }));
vi.mock('../src/client/Preview', () => ({ PreviewButton: () => null }));

// jsdom has no <dialog> behaviour; the modal only needs it to open and close.
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.removeAttribute('open'); };

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); });

const oracle = { references: [{ requirementId: 'R-1', quote: 'blockedBy identifies the first unsuccessful dependency in dependsOn order.' }], explanation: 'After B then A are cancelled, A comes first in dependsOn.' };
const finding = (over: Partial<Finding> = {}): Finding => ({ id: 'fnd_1', runId: 'run', category: 'behavior', severity: 'major', title: 'blockedBy names the wrong dependency', location: 'src/scheduler.js:1', evidence: 'Cancel B then A', suggestion: 'Recompute', status: 'open', confirmed: false, checkpoint: 'cp', contractVersion: 1, createdAt: 'now', ...over });
const proposal = (over: Partial<PendingRegression> = {}): PendingRegression => ({
  schemaVersion: 1, id: 'p1', hash: 'a'.repeat(64), findingId: 'fnd_1', scenarioHash: 's', checkpoint: 'cp', contractVersion: 1, contractHash: 'c', configHash: 'k', slot: 'A', oracle,
  replay: { status: 'reproduced', checkpoint: 'cp', message: 'Sai khác tại S-6; đối chiếu oracle trước khi xác nhận finding.', observations: [] },
  recipeId: 'test', path: 'tests/aidept-regressions/scheduler-fnd_1.test.js', patch: 'diff --git a/x b/x\nnew file mode 100644\n+++ b/tests/aidept-regressions/scheduler-fnd_1.test.js\n+expect(observed).toStrictEqual("A");', testHash: 't', testId: 'id', title: '[REG-fnd_1] x',
  trial: { status: 'failed_as_expected', checkpoint: 'cp', message: 'Thất bại đúng ở S-6', durationMs: 5 }, ...over,
});
const detailOf = (p?: PendingRegression, status: string = 'blocked'): RunDetail => ({ run: { qualityPolicyVersion: 4, status, checkpoint: 'cp' }, regressionProposals: p ? [p] : [] } as unknown as RunDetail);

async function mount(node: ReturnType<typeof createElement>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}
const type = async (el: HTMLTextAreaElement, value: string) => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!; await act(async () => { set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }); };
const button = (host: ParentNode, text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

it('shows the basis, what the runner saw, how the test behaved and the diff, and confirms only the proposal that was read', async () => {
  const onFinding = vi.fn(async () => {});
  const render = (p: PendingRegression) => createElement(FindingActions, { detail: detailOf(p), finding: finding(), busy: false, onFinding, onDispute: () => {} });
  const host = await mount(render(proposal()));
  expect(host.textContent).toContain('blockedBy identifies the first unsuccessful dependency');
  expect(host.textContent).toContain('After B then A are cancelled');
  expect(host.textContent).toContain('Sai khác tại S-6');
  expect(host.textContent).toContain('Thất bại đúng chỗ replay thấy sai khác');
  expect(host.textContent).toContain('tests/aidept-regressions/scheduler-fnd_1.test.js');
  expect(host.querySelector('details pre, details .diff, details')?.textContent).toContain('toStrictEqual');
  const confirm = () => button(host, 'Xác nhận finding và regression')!;
  expect(confirm().disabled).toBe(true);
  await act(async () => (host.querySelector('input[type=checkbox]') as HTMLElement).click());
  expect(confirm().disabled).toBe(false);
  await act(async () => confirm().click());
  expect(onFinding).toHaveBeenCalledWith('fnd_1', 'confirm', { proposalHash: 'a'.repeat(64) });
  // A different proposal is a different thing to read: the acknowledgement does not carry over.
  await act(async () => root!.render(render(proposal({ hash: 'b'.repeat(64) }))));
  expect((host.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(false);
  expect(confirm().disabled).toBe(true);
});

it('offers the replay with the proposal hash and never an agent', async () => {
  const onFinding = vi.fn(async () => {});
  const host = await mount(createElement(FindingActions, { detail: detailOf(proposal()), finding: finding({ reproduction: {} as never }), busy: false, onFinding, onDispute: () => {} }));
  await act(async () => button(host, 'Chạy lại phản ví dụ')!.click());
  expect(onFinding).toHaveBeenCalledWith('fnd_1', 'replay', { proposalHash: 'a'.repeat(64) });
});

it('without a usable regression, says why and asks for a reasoned manual review instead of a hash', async () => {
  const onFinding = vi.fn(async () => {});
  const unsupported = proposal({ unsupported: 'Project chưa có check Vitest nên chưa sinh được test regression tự động. Finding cần review thủ công.', patch: undefined, path: undefined, trial: undefined });
  const host = await mount(createElement(FindingActions, { detail: detailOf(unsupported), finding: finding(), busy: false, onFinding, onDispute: () => {} }));
  expect(host.textContent).toContain('Chưa tạo được test regression tự động');
  expect(host.textContent).toContain('Project chưa có check Vitest');
  expect(host.querySelector('input[type=checkbox]')).toBeNull();
  expect(button(host, 'Xác nhận finding và regression')).toBeUndefined();
  await act(async () => button(host, 'Xác nhận bằng review thủ công')!.click());
  await type(document.body.querySelector('textarea')!, 'Đã chạy tay kịch bản và thấy blockedBy là B.');
  await act(async () => (document.body.querySelector('dialog form button.primary') as HTMLElement).click());
  expect(onFinding).toHaveBeenCalledWith('fnd_1', 'confirm', { manualReason: 'Đã chạy tay kịch bản và thấy blockedBy là B.' });
});

it('closing a finding by hand asks for a reason and says it is not a runner-proven fix', async () => {
  const onFinding = vi.fn(async () => {});
  const host = await mount(createElement(FindingActions, { detail: detailOf(undefined), finding: finding(), busy: false, onFinding, onDispute: () => {} }));
  await act(async () => button(host, 'Đóng bằng review thủ công')!.click());
  expect(document.body.textContent).toContain('không phải bằng chứng đã sửa do runner xác minh');
  await type(document.body.querySelector('textarea')!, 'Đã đọc diff và chạy lại tay.');
  await act(async () => (document.body.querySelector('dialog form button.primary') as HTMLElement).click());
  expect(onFinding).toHaveBeenCalledWith('fnd_1', 'resolve', { reason: 'Đã đọc diff và chạy lại tay.' });
});

it('labels a finding closed by hand differently from one the runner proved fixed', async () => {
  const proofs: FindingProof[] = [
    { findingId: 'a', title: 'Proven one', severity: 'major', level: 'proven_fixed', replayBefore: 'reproduced', replayAfter: 'not_reproduced', regression: 'created', regressionBefore: 'failed_as_expected', regressionAfter: 'passed', regressionTestId: 'id-a', note: 'Phản ví dụ và test regression đều thất bại trước khi sửa và đạt sau khi sửa.' },
    { findingId: 'b', title: 'Manual one', severity: 'major', level: 'manual_decision', note: 'Đóng bằng quyết định review thủ công: đã đọc.' },
    { findingId: 'c', title: 'Doubt', severity: 'major', level: 'unverified', note: 'Chưa có phản ví dụ chạy được.' },
  ];
  const host = await mount(createElement(FindingProofList, { proofs }));
  const rows = [...host.querySelectorAll('tbody tr')].map(r => r.textContent ?? '');
  expect(rows[0]).toContain('Đã chứng minh sửa xong');
  expect(rows[0]).toContain('reproduced → not_reproduced');
  expect(rows[1]).toContain('Đóng bằng quyết định thủ công');
  expect(rows[1]).not.toContain('Đã chứng minh sửa xong');
  expect(rows[2]).toContain('Chưa kiểm chứng');
});
