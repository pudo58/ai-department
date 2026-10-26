import type { TaskContract } from '../shared/types.js';
import { RISK_GROUPS, TEST_PRIORITIES } from '../shared/quality.js';
import { extractJsonBlock } from './outputs.js';
import { AuthorTestPlanSchema } from './testplan.js';
import type { TestPlan } from '../shared/quality.js';

/**
 * Lossless clean-up of an Author's test plan before it is validated. Everything here is a spelling difference between
 * what the model meant and what the schema accepts: a synonym of an enum value, a question written as an object, a
 * quotation whose spacing or punctuation differs from the contract's own text. Nothing that carries a business meaning
 * is chosen or changed (no expected result, no requirement link the Author did not declare, no case dropped or made
 * weaker); every change is returned so a person can read exactly what was done.
 */

const PRIORITY_ALIASES: Record<string, string> = {
  critical: 'high', highest: 'high', urgent: 'high', blocker: 'high', must: 'high', p0: 'high', p1: 'high', cao: 'high',
  medium: 'normal', mid: 'normal', med: 'normal', moderate: 'normal', standard: 'normal', default: 'normal', trungbinh: 'normal',
  minor: 'low', trivial: 'low', optional: 'low', p3: 'low', p4: 'low', thap: 'low',
};
const METHOD_ALIASES: Record<string, string> = { auto: 'automated', automatic: 'automated', tutdong: 'automated', code: 'automated', script: 'automated', human: 'manual', thucong: 'manual', byhand: 'manual' };
const GROUP_ALIASES: Record<string, string> = {
  happypath: 'happy', success: 'happy', normal: 'happy', nominal: 'happy',
  edge: 'boundary', edgecase: 'boundary', edgecases: 'boundary', boundaries: 'boundary', validation: 'boundary', invalidinput: 'boundary', input: 'boundary',
  auth: 'authorization', authz: 'authorization', permission: 'authorization', permissions: 'authorization', access: 'authorization', security: 'authorization',
  race: 'concurrency', racecondition: 'concurrency', concurrent: 'concurrency', idempotency: 'concurrency', idempotent: 'concurrency', retry: 'concurrency', replay: 'concurrency', repeat: 'concurrency',
  failure: 'dependency', failures: 'dependency', error: 'dependency', errors: 'dependency', errorhandling: 'dependency', external: 'dependency', dependencyfailure: 'dependency',
  statetransition: 'state', transition: 'state', transitions: 'state', lifecycle: 'state',
  dataconsistency: 'consistency', integrity: 'consistency', atomicity: 'consistency', invariant: 'consistency', invariants: 'consistency',
};

/** Lower-case letters only: "Happy-Path", "happy path" and "HAPPY_PATH" are one key. */
const keyOf = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]/g, '');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Folds typographic variants so a quotation can be matched by meaning-free differences only. */
function foldChar(c: string): string {
  return c.normalize('NFKC').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[‐-―]/g, '-').replace(/[​-‍﻿]/g, '');
}

/** `text` lower-cased with typographic variants folded and whitespace collapsed, and where each kept character came from. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    for (const ch of foldChar(text[i]!).toLowerCase()) {
      if (/\s/.test(ch)) { if (lastSpace) continue; lastSpace = true; folded += ' '; map.push(i); }
      else { lastSpace = false; folded += ch; map.push(i); }
    }
  }
  return { folded: folded.replace(/ $/, ''), map };
}

/**
 * The exact text of `source` that `quote` refers to, when `quote` differs from it only in case, spacing, dashes, quote
 * marks or elided middles ("... "). Undefined when the quotation is not in the source at all, which stays an error
 * for a person to look at.
 */
export function snapQuote(quote: string, source: string): string | undefined {
  if (!quote.trim()) return undefined;
  if (source.includes(quote)) return quote;
  const parts = quote.split(/\s*(?:\.{3}|…)\s*/).map(p => foldWithMap(p.trim().replace(/^["'`]+|["'`]+$/g, '')).folded.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  const { folded, map } = foldWithMap(source);
  let from = 0, start = -1, end = -1;
  for (const part of parts) {
    const at = folded.indexOf(part, from);
    if (at < 0) return undefined;
    if (start < 0) start = at;
    end = at + part.length - 1;
    from = at + part.length;
  }
  return source.slice(map[start]!, map[end]! + 1);
}

const asText = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v;
  if (isRecord(v)) { for (const k of ['question', 'text', 'q', 'content', 'message']) if (typeof v[k] === 'string') return v[k] as string; }
  return undefined;
};

export function normalizeTestPlan(raw: unknown, contract: Pick<TaskContract, 'requirements'>): { value: unknown; changes: string[] } {
  const changes: string[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.cases)) return { value: raw, changes };
  const requirementText = new Map(contract.requirements.map(r => [r.id, r.text]));
  const requirementKeys = new Map(contract.requirements.map(r => [r.id.toLowerCase(), r.id]));
  const fixId = (id: unknown): unknown => (typeof id === 'string' && !requirementText.has(id) ? requirementKeys.get(id.trim().toLowerCase()) ?? id : id);
  const named = (value: string, aliases: Record<string, string>, allowed: readonly string[]): string | undefined => {
    if (allowed.includes(value)) return undefined;
    const mapped = allowed.find(a => a === value.trim().toLowerCase()) ?? aliases[keyOf(value)];
    return mapped && allowed.includes(mapped) ? mapped : undefined;
  };

  const cases = raw.cases.map((original): unknown => {
    if (!isRecord(original)) return original;
    const c: Record<string, unknown> = { ...original };
    const label = typeof c.id === 'string' ? c.id : '?';
    if (typeof c.priority === 'string') { const to = named(c.priority, PRIORITY_ALIASES, TEST_PRIORITIES); if (to) { changes.push(`${label}: priority "${c.priority}" → "${to}".`); c.priority = to; } }
    if (typeof c.group === 'string') { const to = named(c.group, GROUP_ALIASES, RISK_GROUPS); if (to) { changes.push(`${label}: nhóm "${c.group}" → "${to}".`); c.group = to; } }
    if (typeof c.method === 'string') { const to = named(c.method, METHOD_ALIASES, ['automated', 'manual']); if (to) { changes.push(`${label}: method "${c.method}" → "${to}".`); c.method = to; } }
    let ids = Array.isArray(c.requirementIds) ? c.requirementIds.map(fixId) : undefined;
    if (ids && ids.some((id, i) => id !== (c.requirementIds as unknown[])[i])) changes.push(`${label}: mã yêu cầu viết sai chữ hoa/thường đã được đưa về mã thật.`);
    if (ids) ids = [...new Set(ids)];
    if (isRecord(c.oracle) && Array.isArray(c.oracle.references)) {
      const references = c.oracle.references.map((ref): unknown => {
        if (!isRecord(ref)) return ref;
        const r: Record<string, unknown> = { ...ref, requirementId: fixId(ref.requirementId) };
        const text = typeof r.requirementId === 'string' ? requirementText.get(r.requirementId) : undefined;
        if (text !== undefined && typeof r.quote === 'string' && !text.includes(r.quote)) {
          const snapped = snapQuote(r.quote, text);
          if (snapped) { changes.push(`${label}: trích dẫn ${String(r.requirementId)} được căn lại đúng nguyên văn điều khoản.`); r.quote = snapped; }
        }
        return r;
      });
      // A basis cited outside the case's declared requirements is left alone: linking it would claim coverage the Author did not state.
      c.oracle = { ...c.oracle, references };
    }
    if (ids) c.requirementIds = ids;
    if (c.priority === 'high' && c.required === false) { c.required = true; changes.push(`${label}: ca rủi ro cao được đặt là bắt buộc.`); }
    return c;
  });

  const out: Record<string, unknown> = { ...raw, cases };
  if (Array.isArray(raw.questions)) {
    out.questions = raw.questions.flatMap((q): string[] => { const t = asText(q); if (t === undefined) return []; if (typeof q !== 'string') changes.push('Một câu hỏi dạng object được đổi thành chuỗi.'); return [t]; });
  }
  if (Array.isArray(raw.notApplicable)) {
    const covered = new Set(cases.filter(isRecord).map(c => c.group));
    const seen = new Set<unknown>();
    out.notApplicable = raw.notApplicable.flatMap((entry): unknown[] => {
      if (!isRecord(entry)) return [entry];
      const to = typeof entry.group === 'string' ? named(entry.group, GROUP_ALIASES, RISK_GROUPS) : undefined;
      const group = to ?? entry.group;
      if (to) changes.push(`Nhóm "${String(entry.group)}" trong phần không áp dụng → "${to}".`);
      // A group with a case in the plan has been considered; the contradicting "not applicable" line is the one that goes.
      if (covered.has(group)) { changes.push(`Nhóm ${String(group)} đã có ca nên dòng "không áp dụng" bị bỏ.`); return []; }
      if (seen.has(group)) { changes.push(`Nhóm ${String(group)} khai "không áp dụng" nhiều lần; giữ lần đầu.`); return []; }
      seen.add(group);
      return [{ ...entry, group }];
    });
  }
  return { value: out, changes };
}

/** Reads an Author's plan: the JSON, the clean-up above, then the schema. Throws the same error shape as parseOutput. */
export function parseTestPlanOutput(output: string, contract: Pick<TaskContract, 'requirements'>): { plan: TestPlan; changes: string[] } {
  const { value, changes } = normalizeTestPlan(extractJsonBlock(output), contract);
  const result = AuthorTestPlanSchema.safeParse(value);
  if (!result.success) throw new Error(`Phản hồi sai định dạng: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return { plan: result.data, changes };
}
