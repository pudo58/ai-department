import { afterEach, describe, expect, it } from 'vitest';
import { rig, waitFor } from './figma/harness.js';

let current: Awaited<ReturnType<typeof rig>> | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

describe('Figma UI bridge', () => {
  it.each(['null', 'self'] as const)('pairs when the Figma relay reports event.source as %s', async (uiMessageSource) => {
    current = await rig({ uiMessageSource });
    await current.pairNow();
    expect(current.service.hub.connectionState().state).toBe('connected');
    expect(current.fetches).toContainEqual({ path: '/api/figma-exporter/pair', status: 200 });
  }, 20000);

  it('ignores messages without this UI nonce, even when their source matches parent', async () => {
    current = await rig();
    await current.pairNow();
    await waitFor(() => current!.ui.view() === 'connected');
    const status = current.ui.status();
    const reply = current.figma.posted.find((m) => (m as { type: string }).type === 'HELLO_RESULT') as { bridgeId: string };
    for (const bridgeId of [undefined, '0'.repeat(32)]) {
      current.dom.window.dispatchEvent(new current.dom.window.MessageEvent('message', {
        data: { pluginMessage: { type: 'EVENT', bridgeId, event: { type: 'phase', note: 'forged' } } },
        source: current.dom.window.parent,
      }));
      expect(current.ui.status()).toBe(status);
    }
    // A response on the bound channel still works after unrelated messages.
    current.figma.outbound?.({ type: 'EVENT', bridgeId: reply.bridgeId, event: { type: 'phase', phase: 'reading', note: 'verified channel' } });
    await waitFor(() => current!.ui.status() === 'verified channel');
  }, 20000);

  it('keeps main bound to the original UI and rejects missing or different nonces', async () => {
    current = await rig({ uiMessageSource: 'null' });
    await current.pairNow();
    const reply = current.figma.posted.find((m) => (m as { type: string }).type === 'HELLO_RESULT') as { bridgeId: string };
    current.figma.ui.onmessage?.({ type: 'LIST_PAGES', reqId: 701 });
    current.figma.ui.onmessage?.({ type: 'HELLO', reqId: 702, bridgeId: '0'.repeat(32) });
    current.figma.ui.onmessage?.({ type: 'LIST_PAGES', reqId: 703, bridgeId: reply.bridgeId });
    await waitFor(() => current!.figma.posted.some((m) => (m as { reqId?: number }).reqId === 703));
    expect(current.figma.posted.some((m) => [701, 702].includes((m as { reqId: number }).reqId))).toBe(false);
  }, 20000);

  it('shows a document read error from main instead of losing the reply and timing out', async () => {
    current = await rig({ uiMessageSource: 'null' });
    current.figma.currentPage.failing.set('selection', new Error('Không đọc được trang thử nghiệm.'));
    const response = await current.admin.post('/api/integrations/figma/pairing');
    current.ui.type(response.json().code);
    current.ui.click('pair');
    await waitFor(() => current!.ui.status() === 'Không ghép đôi được.');
    expect(current.ui.detail()).toBe('Không đọc được trang thử nghiệm.');
    expect(current.fetches.some((f) => f.path.endsWith('/pair'))).toBe(false);
  }, 20000);
});
