import type { TaskContract } from '../shared/types.js';
import { RISK_GROUPS, TEST_PRIORITIES } from '../shared/quality.js';
import { extractJsonBlock } from './outputs.js';
import { AuthorTestPlanSchema } from './testplan.js';
import { snapQuote } from './quote.js';
export { snapQuote } from './quote.js';
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

export interface CompletionOptions { schema2: boolean; reasoning: boolean }
const clip = (text: string, max = 8000): string => (text.length > max ? text.slice(0, max) : text);

/**
 * Closes the gaps that would otherwise stop a run for something the person approving the plan cannot fix by editing JSON:
 * unknown requirement ids, duplicate case or step ids, an automatic case without steps, a required requirement with no
 * automatic case. Each fix is mechanical (it restates what the contract or the Author's own case already says), none
 * weakens a case, and every one is returned so the approval screen can list it.
 */
export function completeTestPlan(input: TestPlan | undefined, contract: Pick<TaskContract, 'requirements'>, options: CompletionOptions): { plan: TestPlan; changes: string[]; assumptions: string[] } {
  const changes: string[] = [], assumptions: string[] = [];
  const plan: TestPlan = structuredClone(input ?? { schemaVersion: options.schema2 ? 2 : 1, statefulModelVersion: 1, cases: [], notApplicable: [], questions: [] });
  const known = new Map(contract.requirements.map(r => [r.id, r]));
  if (options.schema2 && plan.schemaVersion !== 2) { plan.schemaVersion = 2; changes.push('Kế hoạch được nâng lên căn cứ v2; căn cứ từng ca lấy từ điều khoản của ca.'); }
  if (options.reasoning && plan.reasoningVersion !== 1) { plan.reasoningVersion = 1; changes.push('Bật reasoningVersion=1 theo chính sách của run.'); }
  const oracleFor = (ids: string[], explanation = 'Căn cứ tự sinh: toàn văn điều khoản mà ca này kiểm tra.') =>
    ({ references: ids.map(id => ({ requirementId: id, quote: clip(known.get(id)!.text) })), explanation });
  const usedCaseIds = new Set<string>();
  const nextCaseId = (): string => { let n = 1; while (usedCaseIds.has(`C-${n}`) || plan.cases.some(c => c.id === `C-${n}`)) n++; return `C-${n}`; };

  const kept: TestPlan['cases'] = [];
  for (const original of plan.cases) {
    const c = original;
    const ids = [...new Set(c.requirementIds)].filter(id => known.has(id));
    if (ids.length !== new Set(c.requirementIds).size) changes.push(`${c.id}: bỏ mã yêu cầu không tồn tại trong hợp đồng.`);
    if (!ids.length) { changes.push(`${c.id}: không còn yêu cầu hợp lệ nào nên ca bị bỏ; yêu cầu liên quan sẽ được phủ bằng ca tự sinh.`); continue; }
    c.requirementIds = ids;
    if (usedCaseIds.has(c.id)) { const id = nextCaseId(); changes.push(`Mã ca ${c.id} bị trùng; ca sau được đổi thành ${id}.`); c.id = id; }
    usedCaseIds.add(c.id);
    if (c.method === 'manual' && ids.some(id => !known.get(id)!.manual)) { c.method = 'automated'; changes.push(`${c.id}: yêu cầu không đánh dấu thủ công nên ca được đặt là tự động.`); }
    if (options.schema2) {
      const own = c.oracle?.references.filter(r => ids.includes(r.requirementId)) ?? [];
      if (!c.oracle || !own.length) { c.oracle = oracleFor(ids, c.oracle?.explanation); changes.push(`${c.id}: thiếu căn cứ hợp lệ nên dùng toàn văn điều khoản của ca.`); }
      else if (own.length !== c.oracle.references.length) { c.oracle = { ...c.oracle, references: own }; changes.push(`${c.id}: bỏ căn cứ thuộc yêu cầu ngoài ca.`); }
    }
    if (options.reasoning && c.method === 'automated') {
      if (!c.steps?.length) {
        c.steps = [{ id: 'S-1', before: 'Trạng thái ban đầu của ca', after: 'Trạng thái sau thao tác của ca', requirementIds: ids, action: c.actions, expected: c.expected }];
        changes.push(`${c.id}: chưa có bước nên bước S-1 được lập từ thao tác và kết quả mong đợi của ca.`);
      }
      const valid = new Set<string>(), steps = c.steps;
      const bad = steps.some(s => !s.id || !/^S-[A-Za-z0-9_-]+$/.test(s.id) || valid.has(s.id) || !valid.add(s.id));
      if (bad) { steps.forEach((s, i) => { s.id = `S-${i + 1}`; }); changes.push(`${c.id}: mã bước thiếu hoặc trùng nên được đánh lại S-1…S-${steps.length}.`); }
    }
    if (c.priority === 'high' && !c.required) { c.required = true; changes.push(`${c.id}: ca rủi ro cao được đặt là bắt buộc.`); }
    kept.push(c);
  }
  plan.cases = kept;

  for (const req of contract.requirements.filter(r => r.required && !r.manual)) {
    if (plan.cases.some(c => c.required && c.method === 'automated' && c.requirementIds.includes(req.id))) continue;
    const id = nextCaseId(); usedCaseIds.add(id);
    plan.cases.push({
      id, requirementIds: [req.id], group: 'happy', risk: `Yêu cầu ${req.id} chưa có ca kiểm thử tự động bắt buộc`, priority: 'high', required: true, method: 'automated',
      preconditions: 'Theo mô tả của yêu cầu.', actions: 'Thực hiện hành vi mà yêu cầu mô tả.', expected: clip(req.text),
      ...(options.schema2 ? { oracle: oracleFor([req.id]) } : {}),
      ...(options.reasoning ? { steps: [{ id: 'S-1', before: 'Trạng thái ban đầu theo yêu cầu', after: 'Trạng thái sau thao tác theo yêu cầu', requirementIds: [req.id], action: 'Thực hiện hành vi mà yêu cầu mô tả.', expected: clip(req.text) }] } : {}),
    });
    changes.push(`${req.id}: chưa có ca tự động bắt buộc nên ca ${id} được tự sinh từ nguyên văn yêu cầu.`);
  }

  if (plan.questions.length) {
    assumptions.push(...plan.questions.map(q => `Câu hỏi Author chưa được trả lời (Author tự giả định, hãy xác nhận): ${q}`));
    changes.push(`${plan.questions.length} câu hỏi chưa giải quyết được chuyển thành giả định trong hợp đồng để bạn xác nhận.`);
    plan.questions = [];
  }
  return { plan, changes, assumptions };
}
