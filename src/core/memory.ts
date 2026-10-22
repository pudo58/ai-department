import type { MemoryItem, MemoryKind, MemoryStatus, RepoMap } from '../shared/types.js';
import { redactSecrets } from '../runtime/process.js';

export const MEMORY_MAX_TEXT = 500;
export const MEMORY_MAX_ACTIVE = 50;
export const MEMORY_MAX_TOTAL = 200;
export const MEMORY_MAX_AGE_DAYS = 90;
export const MEMORY_KINDS: MemoryKind[] = ['convention', 'command', 'pitfall', 'decision', 'architecture'];

/** Same hygiene as guidance: one line ending style, no control characters, secrets masked, capped. */
export function cleanMemoryText(text: string): string {
  return redactSecrets(text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()).slice(0, MEMORY_MAX_TEXT);
}

const normalizePath = (p: string) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '');

export function newMemoryItem(input: { id: string; projectId: string; kind: MemoryKind; text: string; paths?: string[]; pinned?: boolean; status: MemoryStatus; source: MemoryItem['source'] }, now: string): MemoryItem {
  const text = cleanMemoryText(input.text);
  return {
    id: input.id, projectId: input.projectId, kind: input.kind, text, paths: [...new Set((input.paths ?? []).map(normalizePath).filter(Boolean))],
    status: input.status, pinned: input.pinned ?? false, source: input.source,
    createdAt: now, updatedAt: now, confirmedAt: input.status === 'active' ? now : undefined, usedCount: 0,
    history: [{ at: now, text, status: input.status }],
  };
}

/** Applies a person's edit. Activating (approve or re-confirm) stamps confirmedAt and clears any stale reason. */
export function updateMemoryItem(item: MemoryItem, patch: { text?: string; kind?: MemoryKind; paths?: string[]; pinned?: boolean; status?: 'active' | 'archived' }, now: string): MemoryItem {
  const next: MemoryItem = { ...item, updatedAt: now };
  if (patch.text !== undefined) next.text = cleanMemoryText(patch.text);
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.paths !== undefined) next.paths = [...new Set(patch.paths.map(normalizePath).filter(Boolean))];
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.status === 'active' || (next.status === 'active' && (patch.text !== undefined || patch.paths !== undefined))) { next.confirmedAt = now; delete next.staleReason; }
  next.history = [...item.history, { at: now, text: next.text, status: next.status }].slice(-20);
  return next;
}

/**
 * Checks an active item against the repository as it is now. A fact anchored to a path that no longer exists, a
 * command naming an npm script that is gone, or anything not re-confirmed for 90 days is not sent to agents.
 */
export function staleReason(item: MemoryItem, map: RepoMap | undefined, now: number): string | undefined {
  const confirmed = Date.parse(item.confirmedAt ?? item.createdAt);
  if (Number.isFinite(confirmed) && now - confirmed > MEMORY_MAX_AGE_DAYS * 86_400_000) return `Quá ${MEMORY_MAX_AGE_DAYS} ngày chưa xác nhận lại.`;
  if (!map || !map.paths.length) return undefined;
  const exists = (p: string) => map.paths.some((x) => x === p || x === `${p.replace(/\/+$/, '')}/` || x.startsWith(`${p.replace(/\/+$/, '')}/`));
  const missing = item.paths.filter((p) => !exists(p));
  if (missing.length) return `Đường dẫn không còn trong repo: ${missing.join(', ')}.`;
  if (item.kind === 'command') {
    const scripts = [...item.text.matchAll(/npm run ([\w:.-]+)/g)].map((m) => m[1]!);
    if (/\bnpm (?:test|t)\b/.test(item.text)) scripts.push('test');
    const gone = scripts.filter((s) => !map.scriptNames.includes(s));
    if (gone.length) return `Script không có trong package.json: ${gone.join(', ')}.`;
  }
  return undefined;
}
