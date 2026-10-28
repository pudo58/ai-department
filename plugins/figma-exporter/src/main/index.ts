import { MAX_UNACKED_CHUNKS } from '../../../../src/shared/figma.js';
import { UI_TO_MAIN, type BridgeMessage, type MainToUi, type UiToMain } from '../messages.js';
import { Exporter, type Host } from './exporter.js';

declare const __html__: string;

/**
 * Plugin entry. This code can read the document and nothing else: it has no network and no DOM. It shows the UI, which does the talking
 * to AI Department, and answers only the fixed messages in `messages.ts`.
 */
const aborted = new Error('aborted');
let bridgeId: string | undefined;

function createHost(): Host & { ack(id: number): void; yieldAck(): void; abort(): void; reset(): void } {
  let nextId = 1, peak = 0, closed = false;
  const waiting = new Map<number, () => void>();
  const slots: (() => void)[] = [];
  const drained: (() => void)[] = [];
  let yielding: (() => void) | undefined;
  const wake = () => { while (slots.length && waiting.size < MAX_UNACKED_CHUNKS) slots.shift()!(); if (!waiting.size) for (const d of drained.splice(0)) d(); };
  const send = (message: MainToUi) => { if (bridgeId) figma.ui.postMessage({ ...message, bridgeId } satisfies BridgeMessage<MainToUi>); };
  return {
    send,
    now: () => Date.now(),
    peakUnacked: () => peak,
    yieldToUi: () => new Promise<void>((resolve, reject) => { if (closed) { reject(aborted); return; } yielding = resolve; send({ type: 'YIELD' }); }),
    async data(message) {
      while (waiting.size >= MAX_UNACKED_CHUNKS) { if (closed) throw aborted; await new Promise<void>((resolve) => slots.push(resolve)); }
      if (closed) throw aborted;
      const id = nextId++;
      waiting.set(id, () => undefined);
      peak = Math.max(peak, waiting.size);
      send({ type: 'DATA', id, ...message });
    },
    drain: () => new Promise<void>((resolve, reject) => { if (closed) { reject(aborted); return; } if (!waiting.size) resolve(); else drained.push(resolve); }),
    ack(id) { waiting.delete(id); wake(); },
    yieldAck() { const r = yielding; yielding = undefined; r?.(); },
    reset() { closed = false; waiting.clear(); slots.splice(0); drained.splice(0); yielding = undefined; peak = 0; },
    abort() { closed = true; waiting.clear(); wake(); for (const s of slots.splice(0)) s(); yielding?.(); yielding = undefined; },
  };
}

const host = createHost();
const exporter = new Exporter(figma, host);
figma.showUI(__html__, { width: 380, height: 560, title: 'AI Department Exporter', themeColors: true });

const isMessage = (m: unknown): m is BridgeMessage<UiToMain> => !!m && typeof m === 'object'
  && typeof (m as { bridgeId?: unknown }).bridgeId === 'string' && /^[a-f0-9]{32}$/.test((m as { bridgeId: string }).bridgeId)
  && typeof (m as { type?: unknown }).type === 'string' && (UI_TO_MAIN as readonly string[]).includes((m as { type: string }).type);

figma.ui.onmessage = (message: unknown) => {
  if (!isMessage(message)) return;
  // Bind only at the first handshake, then ignore messages from another UI instance.
  if (!bridgeId) { if (message.type !== 'HELLO') return; bridgeId = message.bridgeId; }
  if (message.bridgeId !== bridgeId) return;
  const fail = (reqId: number, error: unknown) => host.send({ type: 'REQUEST_ERROR', reqId, code: String((error as { code?: unknown })?.code ?? 'internal'), message: String((error as Error)?.message ?? error).slice(0, 300) });
  switch (message.type) {
    case 'HELLO': exporter.hello().then((hello) => host.send({ type: 'HELLO_RESULT', reqId: message.reqId, hello }), (e) => fail(message.reqId, e)); break;
    case 'LIST_PAGES': try { host.send({ type: 'PAGES_RESULT', reqId: message.reqId, pages: exporter.pages() }); } catch (e) { fail(message.reqId, e); } break;
    case 'LIST_ROOTS': exporter.roots(message.pageId).then((roots) => host.send({ type: 'ROOTS_RESULT', reqId: message.reqId, pageId: message.pageId, roots }), (e) => fail(message.reqId, e)); break;
    case 'START_EXPORT': host.reset(); void exporter.run(message.command); break;
    case 'ACK': host.ack(message.id); break;
    case 'YIELD_ACK': host.yieldAck(); break;
    case 'CANCEL': exporter.cancel(); break;
    case 'DISCONNECT': exporter.cancel(); host.abort(); break;
  }
};

// A closed UI cannot acknowledge anything: stop reading rather than wait for it.
figma.on('close', () => { exporter.cancel(); host.abort(); });
