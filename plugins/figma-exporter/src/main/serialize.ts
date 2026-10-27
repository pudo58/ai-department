import type { FieldValue, Json } from '../../../../src/shared/figma.js';

/**
 * Turns what the Plugin API hands back into plain JSON without losing the difference between "this is 0" and "this could not be read".
 * `figma.mixed`, typed arrays, Maps and cyclic or very deep objects are not JSON; each gets an explicit marker instead of being dropped.
 */
export const MIXED_MARK = { $mixed: true } as const;
const MAX_DEPTH = 14;
const MAX_ITEMS = 5000;

export interface Serialized { value: Json; truncated: boolean; mixed: boolean }

export function toJson(value: unknown, mixedSymbol: unknown): Serialized {
  let truncated = false, mixed = false;
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): Json => {
    if (v === mixedSymbol && mixedSymbol !== undefined) { mixed = true; return { ...MIXED_MARK }; }
    if (v === null) return null;
    switch (typeof v) {
      case 'string': case 'boolean': return v;
      case 'number': return Number.isFinite(v) ? v : { $number: String(v) };
      case 'bigint': return { $bigint: v.toString() };
      case 'undefined': return null;
      case 'symbol': return { $symbol: String(v.description ?? '') };
      case 'function': return { $function: true };
      default: break;
    }
    const obj = v as object;
    if (seen.has(obj)) { truncated = true; return { $cycle: true }; }
    if (depth >= MAX_DEPTH) { truncated = true; return { $truncated: 'depth' }; }
    if (obj instanceof Uint8Array || ArrayBuffer.isView(obj)) return { $bytes: (obj as Uint8Array).byteLength };
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        if (obj.length > MAX_ITEMS) { truncated = true; return [...obj.slice(0, MAX_ITEMS).map((x) => walk(x, depth + 1)), { $truncated: `items>${MAX_ITEMS}` }]; }
        return obj.map((x) => walk(x, depth + 1));
      }
      if (obj instanceof Map) return { $map: [...obj.entries()].slice(0, MAX_ITEMS).map(([k, x]) => [walk(k, depth + 1), walk(x, depth + 1)]) } as Json;
      if (obj instanceof Set) return { $set: [...obj.values()].slice(0, MAX_ITEMS).map((x) => walk(x, depth + 1)) } as Json;
      const out: { [key: string]: Json } = {};
      for (const key of Object.keys(obj)) {
        let child: unknown;
        try { child = (obj as Record<string, unknown>)[key]; } catch (error) { out[key] = { $error: String((error as Error)?.message ?? error).slice(0, 200) }; truncated = true; continue; }
        if (typeof child === 'function') continue;
        out[key] = walk(child, depth + 1);
      }
      return out;
    } finally { seen.delete(obj); }
  };
  return { value: walk(value, 0), truncated, mixed };
}

const read = (v: Json, a?: string): FieldValue => ({ s: 'read', v, ...(a ? { a } : {}) });
export const fieldRead = read;
export const fieldMixed = (v: Json, a?: string): FieldValue => ({ s: 'mixed', v, ...(a ? { a } : {}) });
/** Most fields of most nodes do not exist for their type, so this is the shortest record there is: no reason, no API name (the key says which). */
export const fieldNA = (_reason?: string, _api?: string): FieldValue => ({ s: 'not_applicable' });
export const fieldUnavailable = (reason: string, a?: string): FieldValue => ({ s: 'unavailable', r: reason, ...(a ? { a } : {}) });
export const fieldUnsupported = (reason: string, a?: string): FieldValue => ({ s: 'unsupported', r: reason, ...(a ? { a } : {}) });
export const fieldError = (error: unknown, a?: string): FieldValue => ({ s: 'error', r: String((error as Error)?.message ?? error).slice(0, 300) || 'lỗi không rõ', ...(a ? { a } : {}) });
