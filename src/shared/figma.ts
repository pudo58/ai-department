/**
 * What the AI Department Exporter (a Figma plugin) and the server say to each other. This file is bundled into the plugin and read by the
 * server, so it imports nothing from Node or from `figma`, and holds no behaviour beyond small pure helpers.
 */
export const PROTOCOL_VERSION = 1;
export const READER_VERSION = 1;
export const SCHEMA_VERSION = 1;
export const PLUGIN_VERSION = '1.1.1';
/** Everything the plugin may do on the server lives under this prefix; nothing else is reachable with a plugin session. */
export const PLUGIN_API_PREFIX = '/api/figma-exporter';

const MiB = 1024 * 1024;
export interface ExportLimits { jobMs: number; maxNodes: number; maxBytes: number; maxAssetBytes: number }
export const DEFAULT_LIMITS: ExportLimits = { jobMs: 10 * 60_000, maxNodes: 20_000, maxBytes: 200 * MiB, maxAssetBytes: 25 * MiB };
export const MAX_LIMITS: ExportLimits = { jobMs: 60 * 60_000, maxNodes: 200_000, maxBytes: 2048 * MiB, maxAssetBytes: 100 * MiB };

export const CHUNK_MAX_BYTES = 256 * 1024;
export const REQUEST_MAX_BYTES = 512 * 1024;
export const MAX_UNACKED_CHUNKS = 2;
export const MAX_CHUNK_RETRIES = 2;
export const NODES_PER_SLICE = 100;
export const SLICE_MS = 8;
export const POLL_TIMEOUT_MS = 25_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEARTBEAT_MS = 10_000;
export const LOST_CONTACT_MS = 30_000;
export const PREVIEW_MAX_EDGE = 2048;
export const SCREEN_PREVIEW_MAX_EDGE = 8192;
export const PREVIEW_MAX_PIXELS = 16 * 1024 * 1024;
export interface PreviewInfo { role: 'overview' | 'screen'; name: string; nodeType: string; scale: number }

export type ExportScopeKind = 'selection' | 'pages' | 'file';

/** How the plugin reports one field. Zero, false and a legitimate null are `read`; nothing is guessed to fill a gap. */
export type FieldStatus = 'read' | 'mixed' | 'not_applicable' | 'unsupported' | 'unavailable' | 'error';
export const FIELD_STATUSES: readonly FieldStatus[] = ['read', 'mixed', 'not_applicable', 'unsupported', 'unavailable', 'error'];
/** Short keys on purpose: a record is written once per node and a file can hold hundreds of thousands. */
export interface FieldValue { s: FieldStatus; v?: Json; r?: string; a?: string }
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type FieldGroup = 'common' | 'layout' | 'paint' | 'text' | 'component' | 'instance' | 'style' | 'vector' | 'prototype';
export const FIELD_GROUPS: readonly FieldGroup[] = ['common', 'layout', 'paint', 'text', 'component', 'instance', 'style', 'vector', 'prototype'];
/** `partial`: some field of the group is unavailable, unsupported or failed; `unsupported`: the group has no reader for this node. */
export type GroupStatus = 'read' | 'partial' | 'unsupported' | 'not_applicable';

const SHAPES = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'VECTOR', 'BOOLEAN_OPERATION'] as const;
const CONTAINERS = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'] as const;
/**
 * The groups a reader must answer for, by node type. A node whose type is not here still gets its common record and an
 * `unsupported_node_type` issue, so a new Figma node type can never be mistaken for a fully read one.
 */
export const APPLICABLE_GROUPS: Readonly<Record<string, readonly FieldGroup[]>> = Object.freeze({
  PAGE: ['common'],
  SECTION: ['common', 'layout', 'paint', 'style', 'prototype'],
  GROUP: ['common', 'layout', 'style', 'prototype'],
  FRAME: ['common', 'layout', 'paint', 'style', 'prototype'],
  COMPONENT: ['common', 'layout', 'paint', 'style', 'component', 'prototype'],
  COMPONENT_SET: ['common', 'layout', 'paint', 'style', 'component', 'prototype'],
  INSTANCE: ['common', 'layout', 'paint', 'style', 'instance', 'prototype'],
  TEXT: ['common', 'layout', 'paint', 'style', 'text', 'prototype'],
  ...Object.fromEntries(SHAPES.map((t) => [t, ['common', 'layout', 'paint', 'style', 'vector', 'prototype'] as const])),
  SLICE: ['common'],
});
export const CONTAINER_TYPES: readonly string[] = CONTAINERS;
export const isKnownNodeType = (type: string): boolean => Object.prototype.hasOwnProperty.call(APPLICABLE_GROUPS, type);

/** The tree and field data of one node. `hash` covers everything else in the record. */
export interface NodeRecord {
  k: 'node';
  id: string; type: string; name: string; pageId: string; parentId: string | null; index: number; depth: number;
  childIds: string[];
  groups: Partial<Record<FieldGroup, GroupStatus>>;
  /** Keyed `<group>.<field>`. */
  fields: Record<string, FieldValue>;
  hash: string;
}
/** One line of the inventory pass; the same shape is sent again by the verification pass. */
export interface InventoryRecord { k: 'inv'; id: string; type: string; pageId: string; parentId: string | null; index: number; childIds: string[] }

export type DependencyRecord =
  | { k: 'style'; id: string; styleType: string; name: string; key?: string; description?: string; remote: boolean; fields: Record<string, FieldValue>; usedBy?: string[] }
  | { k: 'collection'; id: string; name: string; key?: string; remote: boolean; modes: { modeId: string; name: string }[]; defaultModeId?: string; variableIds: string[]; usedBy?: string[] }
  | { k: 'variable'; id: string; name: string; key?: string; collectionId: string; resolvedType: string; remote: boolean; description?: string; scopes?: string[];
      valuesByMode: Record<string, FieldValue>; aliasIssues?: string[]; usedBy?: string[] }
  | { k: 'component'; id: string; key?: string; name: string; remote: boolean; description?: string; componentSetId?: string | null;
      scope: 'in_scope' | 'dependency_only' | 'unavailable'; reason?: string; usedBy?: string[] }
  | { k: 'imageRef'; hash: string; refs: { nodeId: string; field: string }[]; status: 'bytes' | 'missing' | 'oversize' | 'error'; reason?: string; assetId?: string }
  | { k: 'asset'; id: string; assetKind: AssetKind; mime: string; bytes: number; sha256: string; source: { nodeId?: string; imageHash?: string }; status: 'stored' | 'missing' | 'oversize' | 'error'; reason?: string; width?: number; height?: number; preview?: PreviewInfo };
export type AssetKind = 'original_image' | 'vector_export' | 'preview';

export type ChunkKind = 'inventory' | 'nodes' | 'dependencies' | 'verification' | 'asset';
export const TEXT_STREAMS: readonly ChunkKind[] = ['inventory', 'nodes', 'dependencies', 'verification'];

export interface ChunkEnvelope {
  protocolVersion: number; jobId: string; sourceSession: string; scopeHash: string;
  seq: number; kind: ChunkKind;
  /** For `asset` chunks: the content hash the whole asset will have, and this chunk's position in it. */
  assetId?: string; offset?: number; final?: boolean;
  byteLength: number; sha256: string;
  /** Base64 of the decoded bytes. */
  payload: string;
}

export interface StreamSummary { bytes: number; sha256: string; records: number }
export interface FinishBody {
  protocolVersion: number; jobId: string; sourceSession: string; scopeHash: string;
  lastSeq: number;
  streams: Record<(typeof TEXT_STREAMS)[number], StreamSummary>;
  assets: { id: string; bytes: number; sha256: string }[];
  totals: { nodes: number; pages: number; dependencies: number; assets: number };
  verification: { passes: number; sourceChanged: boolean; changedIds: string[]; documentChanges: number; watchedDocumentChanges: boolean };
  stats: { peakUnackedChunks: number; durationMs: number; restoredSkipInvisible: boolean };
  limitReached?: 'time' | 'nodes' | 'bytes' | 'asset' | null;
  errors: { code: string; message: string }[];
}

export interface PageInfo { id: string; name: string; childCount: number }
export interface RootInfo { id: string; name: string; type: string; pageId: string; pageName?: string }
export interface HelloInfo {
  protocolVersion: number; readerVersion: number; pluginVersion: string; bundleHash?: string;
  editorType: string; apiVersion: string; fileName: string;
  /** Only present where the Plugin API returns it; a name or a root id is never a stand-in. */
  fileKey?: string;
  pages: PageInfo[]; selection: RootInfo[]; currentPageId: string;
  /** New on every run of the plugin; ties pairing, commands and chunks to one live session of one file. */
  sourceSession: string;
  hasMissingFonts?: boolean;
}

/** What the server asks of the plugin. Closed list: there is no command that runs code, edits a node or opens a file. */
export type PluginCommand =
  | { id: string; type: 'HELLO' }
  | { id: string; type: 'LIST_PAGES' }
  | { id: string; type: 'LIST_ROOTS'; pageId: string }
  | { id: string; type: 'START_EXPORT'; jobId: string; scopeHash: string; scope: ExportScopeKind; rootIds: string[]; pageIds: string[]; limits: ExportLimits; chunkBytes: number }
  | { id: string; type: 'CANCEL'; jobId: string }
  | { id: string; type: 'DISCONNECT' };
/** A command before the server gives it an id. */
export type CommandInput = PluginCommand extends infer C ? (C extends { id: string } ? Omit<C, 'id'> : never) : never;
export const COMMAND_TYPES = ['HELLO', 'LIST_PAGES', 'LIST_ROOTS', 'START_EXPORT', 'CANCEL', 'DISCONNECT'] as const;

export type ExportPhase = 'queued' | 'preparing' | 'inventory' | 'reading' | 'dependencies' | 'assets' | 'verifying' | 'assembling' | 'review_ready';
export const EXPORT_PHASES: readonly ExportPhase[] = ['queued', 'preparing', 'inventory', 'reading', 'dependencies', 'assets', 'verifying', 'assembling', 'review_ready'];
export type ExportTerminal = 'partial' | 'failed' | 'cancelled' | 'interrupted';

/** What the plugin tells the server outside the chunk stream. */
export type PluginEvent =
  | { type: 'hello'; commandId?: string; hello: HelloInfo }
  | { type: 'pages'; commandId: string; pages: PageInfo[] }
  | { type: 'roots'; commandId: string; pageId: string; roots: RootInfo[] }
  | { type: 'phase'; jobId: string; phase: ExportPhase | 'loading_pages'; nodes?: number; bytes?: number; note?: string }
  | { type: 'progress'; jobId: string; nodes: number; total?: number; bytes: number; unacked: number }
  | { type: 'error'; jobId?: string; commandId?: string; code: string; message: string }
  | { type: 'cancelled'; jobId: string };

export const PLUGIN_ERROR_CODES = ['bad_command', 'source_mismatch', 'page_load_failed', 'root_missing', 'document_changed', 'limit_reached', 'upload_failed', 'internal'] as const;

/** Issue kinds the validator and the plugin can raise. `blocker` stops publishing; `limit` is a known gap a person can acknowledge. */
export type IssueSeverity = 'blocker' | 'limit' | 'info';
export interface ExportIssue { id: string; code: string; severity: IssueSeverity; message: string; nodeId?: string; field?: string; occurrences?: number; examples?: { nodeId: string; name?: string }[] }

export interface NodeVisibility { parentId: string | null; visible?: boolean }
/** Only an explicitly read false proves a hidden node; missing ancestors and unknown visibility do not. */
export function hiddenNode(id: string, nodes: ReadonlyMap<string, NodeVisibility>): string | undefined {
  const seen = new Set<string>();
  for (let at: string | null = id; at !== null && !seen.has(at);) {
    seen.add(at);
    const node = nodes.get(at);
    if (!node) return undefined;
    if (node.visible === false) return at;
    at = node.parentId;
  }
  return undefined;
}

export const issueId = (code: string, nodeId?: string, field?: string): string => `${code}|${nodeId ?? ''}|${field ?? ''}`;

/** Sorted-key JSON: the same value always gives the same text, so a hash of it means something. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The subset of a node record that `hash` covers. */
export const nodeRecordCore = (r: Omit<NodeRecord, 'hash'> & { hash?: string }): Omit<NodeRecord, 'hash'> => {
  const { hash: _hash, ...core } = r;
  return core;
};

/** Pairing codes are eight digits. */
export const PAIRING_CODE_RE = /^\d{8}$/;
export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;
