import type { ChunkKind, HelloInfo, PageInfo, PluginCommand, PluginEvent, RootInfo, FinishBody } from '../../../src/shared/figma.js';

/**
 * Between the plugin's main code (which can read the document) and its UI (which can reach the network). A closed list: nothing here
 * runs code, edits a node or opens anything. Every message carries only what its type needs.
 */
export type StartExport = Extract<PluginCommand, { type: 'START_EXPORT' }>;

export type UiToMain =
  | { type: 'HELLO'; reqId: number }
  | { type: 'LIST_PAGES'; reqId: number }
  | { type: 'LIST_ROOTS'; reqId: number; pageId: string }
  | { type: 'START_EXPORT'; command: StartExport }
  | { type: 'ACK'; id: number }
  | { type: 'YIELD_ACK' }
  | { type: 'CANCEL'; jobId: string }
  | { type: 'DISCONNECT' };
export const UI_TO_MAIN: readonly UiToMain['type'][] = ['HELLO', 'LIST_PAGES', 'LIST_ROOTS', 'START_EXPORT', 'ACK', 'YIELD_ACK', 'CANCEL', 'DISCONNECT'];

export interface FinishedSummary {
  jobId: string;
  totals: FinishBody['totals'];
  verification: FinishBody['verification'];
  stats: FinishBody['stats'];
  limitReached: FinishBody['limitReached'];
  errors: FinishBody['errors'];
}

export type MainToUi =
  | { type: 'HELLO_RESULT'; reqId: number; hello: HelloInfo }
  | { type: 'PAGES_RESULT'; reqId: number; pages: PageInfo[] }
  | { type: 'ROOTS_RESULT'; reqId: number; pageId: string; roots: RootInfo[] }
  | { type: 'REQUEST_ERROR'; reqId: number; code: string; message: string }
  /** One piece of what the UI must upload. The UI acknowledges it with `ACK` once the server has stored it. */
  | { type: 'DATA'; id: number; kind: ChunkKind; text?: string; bytes?: Uint8Array; assetId?: string; offset?: number; final?: boolean }
  | { type: 'YIELD' }
  | { type: 'EVENT'; event: PluginEvent }
  | { type: 'FINISHED'; summary: FinishedSummary };
