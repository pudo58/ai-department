import { normalizeTestId, extractCaseIds, identityId, testTitle } from './testids.js';
export { normalizeTestId, extractCaseIds } from './testids.js';
import { z } from 'zod';
import type { Artifact, TaskContract } from '../shared/types.js';
import { RISK_GROUPS, RISK_LABELS, TEST_PRIORITIES, type ManifestEntry, type Oracle, type TestPlan, type TestPlanReview } from '../shared/quality.js';
import { isSafeRelative } from './scope.js';
import { isTestPath } from './testpath.js';
import { snapQuote } from './quote.js';

const text = z.string().trim().min(1).max(8000);
const literalText = z.string().min(1).max(8000).refine(s => !!s.trim(), 'Không được trống.');
const ids = z.array(z.string().regex(/^R-[A-Za-z0-9_-]+$/)).min(1).max(50);
export const OracleSchema = z.object({ references: z.array(z.object({ requirementId: text, quote: literalText })).min(1).max(50), explanation: text });
export const IdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('json'), file: literalText, titles: z.array(literalText).min(1).max(50) }),
  z.object({ kind: z.literal('junit'), className: z.string().max(8000), name: literalText }),
]);
export const TestPlanSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), statefulModelVersion: z.literal(1).optional(), reasoningVersion: z.literal(1).optional(),
  cases: z.array(z.object({ id: z.string().regex(/^C-[A-Za-z0-9_-]+$/), requirementIds: ids, group: z.enum(RISK_GROUPS), risk: text,
    priority: z.enum(TEST_PRIORITIES), preconditions: text, actions: text, expected: text, oracle: OracleSchema.optional(),
    steps: z.array(z.object({ id: z.string().max(8000).optional(), before: z.string().max(8000).optional(), after: z.string().max(8000).optional(), requirementIds: z.array(z.string()).max(50).optional(), action: text, expected: text })).min(1).max(30).optional(),
    invariants: z.array(text).min(1).max(30).optional(),
    method: z.enum(['automated', 'manual']), required: z.boolean() })).max(200),
  notApplicable: z.array(z.object({ group: z.enum(RISK_GROUPS), reason: text })).max(7), questions: z.array(text).max(50),
});
/** Author output only: v2 may declare links once, in oracle.references. Stored contracts still require requirementIds. */
export const AuthorTestPlanSchema = TestPlanSchema.extend({
  cases: z.array(TestPlanSchema.shape.cases.element.extend({ requirementIds: ids.optional() })).max(200),
}).superRefine((plan, ctx) => {
  plan.cases.forEach((c, i) => {
    if (!c.requirementIds && (plan.schemaVersion !== 2 || !c.oracle)) ctx.addIssue({ code: 'custom', path: ['cases', i, 'requirementIds'], message: 'Cần mã yêu cầu hoặc căn cứ v2 để xác định liên kết.' });
  });
}).transform((plan): TestPlan => ({ ...plan, cases: plan.cases.map(c => ({ ...c,
  requirementIds: c.requirementIds ?? [...new Set(c.oracle!.references.map(r => r.requirementId))],
})) }));

export const UNRESOLVED_PLAN_QUESTIONS = 'Kế hoạch còn câu hỏi chưa giải quyết; hãy trả lời vào hợp đồng hoặc ghi giả định đã xác nhận rồi xóa câu hỏi.';

/** A formatting repair cannot make ambiguity or mandatory coverage disappear. All plans still require human approval. */
export function planRepairProblems(before: TestPlan | undefined, questions: readonly string[], after: TestPlan, validRequirementIds?: readonly string[], repairedCases: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  const used = new Set<TestPlan['cases'][number]>();
  for (const q of questions) if (!after.questions.includes(q)) problems.push(`Không được tự bỏ câu hỏi chưa giải quyết: ${q}`);
  for (const old of before?.cases ?? []) {
    const duplicated = before!.cases.filter(c => c.id === old.id).length > 1;
    // Duplicate IDs can be renamed only with a one-to-one match to the original scenario, never by merging cases.
    const next = after.cases.find(c => !used.has(c) && (duplicated
      ? c.preconditions === old.preconditions && c.actions === old.actions && c.expected === old.expected
        && (!old.steps || JSON.stringify(c.steps) === JSON.stringify(old.steps))
        && (!old.invariants || old.invariants.every(i => c.invariants?.includes(i)))
        && old.requirementIds.filter(id => !validRequirementIds || validRequirementIds.includes(id)).every(id => c.requirementIds.includes(id))
      : c.id === old.id));
    if (!next) { problems.push(`Không được xóa/đổi mã ca ${old.id} trong lượt sửa kế hoạch.`); continue; }
    used.add(next);
    if (old.required && !next.required) problems.push(`${old.id}: không được hạ ca bắt buộc thành bổ sung.`);
    if (old.priority === 'high' && next.priority !== 'high') problems.push(`${old.id}: không được hạ mức rủi ro cao.`);
    if (old.method === 'automated' && next.method !== 'automated') problems.push(`${old.id}: không được chuyển ca tự động sang thủ công.`);
    for (const id of old.requirementIds) if ((!validRequirementIds || validRequirementIds.includes(id)) && !next.requirementIds.includes(id)) problems.push(`${old.id}: không được bỏ liên kết ${id} trong lượt sửa kế hoạch.`);
    if(before?.reasoningVersion===1){
      if(after.reasoningVersion!==1)problems.push(`${old.id}: không được bỏ reasoningVersion trong lượt sửa.`);
      for(const step of old.steps??[]){
        const nextStep=step.id?next.steps?.find(s=>s.id===step.id):next.steps?.find(s=>s.action===step.action&&s.expected===step.expected);
        if(!nextStep)problems.push(`${old.id}.${step.id??'?'}: không được bỏ bước đã khai báo trong lượt sửa.`);
        // The case the validator named is the one the Author was asked to rework, so its step wording may change (and is reported); any other case may not.
        else if((nextStep.action!==step.action||nextStep.expected!==step.expected)&&!repairedCases.has(old.id))problems.push(`${old.id}.${step.id??'?'}: không được thay kỳ vọng nghiệp vụ trong lượt sửa định dạng.`);
      }
      for(const invariant of old.invariants??[])if(!next.invariants?.includes(invariant))problems.push(`${old.id}: không được bỏ bất biến trong lượt sửa.`);
    }
  }
  return problems;
}

/** Which cases a list of validator problems names ("C-15: …", "C-15.steps.0: …"). */
export const casesNamedBy = (problems: readonly string[]): Set<string> => new Set(problems.flatMap(p => /^(C-[A-Za-z0-9_-]+?)[.:]/.exec(p)?.[1] ?? []));

/** Step wording a repair rewrote in a case it was asked to rework: allowed, but shown to the person approving the plan. */
export function planRepairNotes(before: TestPlan | undefined, after: TestPlan, repairedCases: ReadonlySet<string>): string[] {
  const clip = (t: string) => (t.length > 140 ? `${t.slice(0, 140)}…` : t);
  return (before?.cases ?? []).filter(c => repairedCases.has(c.id)).flatMap(old => {
    const next = after.cases.find(c => c.id === old.id);
    return (old.steps ?? []).flatMap(step => {
      const now = next?.steps?.find(s => s.id === step.id);
      return now && now.expected !== step.expected ? [`${old.id}.${step.id}: Author viết lại kỳ vọng khi sửa ca này. Trước: "${clip(step.expected)}" → Sau: "${clip(now.expected)}".`] : [];
    });
  });
}

/** Metadata is descriptive only; it never grants approval or upgrades an old contract. */
const TestPlanReviewSchema = z.object({ schemaVersion: z.literal(1), source: z.literal('server'), contractHash: text, contractVersion: z.number().int(),
  attemptIds: z.array(text), firstPassValid: z.boolean(), repairAttempted: z.boolean(), repairAccepted: z.boolean(),
  outcome: z.enum(['valid', 'needs_review', 'invalid_output']), reason: z.enum(['questions_only', 'budget_exhausted', 'repair_rejected']).optional(),
  initialProblems: z.array(z.string()), remainingProblems: z.array(z.string()),
  remainingAdvisories: z.array(z.string()).optional(), normalizations: z.array(z.string()).optional() });
export function readTestPlanReview(contract: TaskContract, artifacts: readonly Artifact[], contractHash: string): TestPlanReview | undefined {
  const a = artifacts.filter(a => a.valid && a.title === 'Test plan review' && a.contractVersion === contract.version).at(-1);
  if (!a) return;
  try {
    const result = TestPlanReviewSchema.safeParse(JSON.parse(a.content));
    if (result.success && result.data.contractHash === contractHash && result.data.contractVersion === contract.version) return result.data;
  } catch { /* Historical metadata is optional. */ }
}
export const AssertionBindingSchema = z.object({ stepId: text, expected: text, expression: literalText, line: z.number().int().positive().optional() });
export const ManifestSchema = z.object({ entries: z.array(z.object({
  caseId: z.string().regex(/^C-[A-Za-z0-9_-]+$/), requirementIds: ids, recipeId: text, path: text, testId: literalText, identity: IdentitySchema.optional(), assertions: z.array(AssertionBindingSchema).min(1).max(200).optional(),
})).max(1000) });
/** Output v2 omits the computed testId; the server, not the Author, owns encoding. */
export const StructuredManifestSchema = z.object({ entries: z.array(z.object({ caseId: text, requirementIds: ids, recipeId: text, path: text, identity: IdentitySchema, assertions: z.array(AssertionBindingSchema).min(1).max(200).optional() })).max(1000) });
export const StoredManifestSchema = ManifestSchema.extend({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), source: z.enum(['author', 'observed']), contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  contractVersion: z.number().int().positive(), slot: z.enum(['A', 'B']),
  observed: z.array(z.object({ recipeId: text, testIds: z.array(text).max(10000) })).max(20).optional(),
  revision: z.object({ previousHash: z.string().regex(/^[a-f0-9]{64}$/), proposalId: text }).optional(),
  assertionAudit: z.array(z.object({ path: text, status: z.enum(['checked', 'unsupported']), assertions: z.number().int().nonnegative(), message: text })).optional(),
  advisories: z.array(z.string()).optional(),
});

export interface OracleOptions {
  /** Also accept a quotation found in the user's original requirement; the contract paraphrases it, so the words may only live there. */
  originalRequirement?: string;
  /** Accept a clause outside the case's own requirements as long as one reference is inside it (used for diagnoses). */
  anyClause?: boolean;
}
export function validateOracle(contract: TaskContract, requirementIds: readonly string[], oracle?: Oracle, options: OracleOptions = {}): string[] {
  if (!oracle || !OracleSchema.safeParse(oracle).success) return ['Thiếu căn cứ hợp đồng (oracle) hoặc phần giải thích.'];
  const quoted = (req: { text: string }, quote: string) => snapQuote(quote, req.text) !== undefined || (!!options.originalRequirement && snapQuote(quote, options.originalRequirement) !== undefined);
  const problems = oracle.references.flatMap(ref => {
    const req = contract.requirements.find(r => r.id === ref.requirementId);
    return !req || (!options.anyClause && !requirementIds.includes(ref.requirementId)) ? [`Căn cứ ${ref.requirementId} không thuộc ca.`]
      : !quoted(req, ref.quote) ? [`Trích dẫn ${ref.requirementId} không có trong điều khoản hiện tại.`] : [];
  });
  if (options.anyClause && !problems.length && !oracle.references.some(ref => requirementIds.includes(ref.requirementId))) problems.push('Căn cứ không gắn với yêu cầu của ca thất bại nào.');
  return problems;
}

/** Examples and enum guidance are generated from the same constants as validation. */
export function testPlanOutputGuide(version: 1 | 2, reasoning = false): string {
  return JSON.stringify({ schemaVersion: version, statefulModelVersion: 1, ...(reasoning ? {reasoningVersion: 1} : {}),
    cases: [{ id: 'C-1', ...(version === 1 ? { requirementIds: ['R-1'] } : {}), group: RISK_GROUPS[0], risk: '...', priority: TEST_PRIORITIES[0], preconditions: '...', actions: '...', expected: '...', steps: [{ ...(reasoning ? {id:'S-1',before:'trạng thái và đồng hồ trước bước',after:'trạng thái và đồng hồ sau bước',requirementIds:['R-1']} : {}), action: '...', expected: '...' }, { ...(reasoning ? {id:'S-2',before:'trạng thái sau S-1',after:'trạng thái sau S-2',requirementIds:['R-1']} : {}), action: '...', expected: '...' }], invariants: ['...'], method: 'automated', required: true,
      ...(version === 2 ? { oracle: { references: [{ requirementId: 'R-1', quote: 'trích nguyên văn điều khoản R-1' }], explanation: 'Giải thích căn cứ của expected, từng bước và invariant.' } } : {}) }], notApplicable: [], questions: [] });
}

export interface Findings { blocking: string[]; advisories: string[] }

/**
 * Blocking findings are what a person cannot sensibly approve past: no usable plan, a requirement without an automatic
 * case, an unanswered question, a link to something that does not exist. Advisories describe form (a missing before/after
 * state, a group left unmentioned, an invariant not written down); they are shown at approval and must be acknowledged,
 * but they do not stop a plan whose business content is usable.
 */
export function testPlanFindings(contract: TaskContract, required = false, reasoningRequired = false): Findings {
  const blocking: string[] = [], advisories: string[] = [];
  if (!contract.testPlan) return { blocking: required ? ['Verify cần kế hoạch ca kiểm thử trước khi duyệt.'] : [], advisories };
  const parsed = TestPlanSchema.safeParse(contract.testPlan);
  if (!parsed.success) return { blocking: parsed.error.issues.map((i) => `Kế hoạch ca ${i.path.join('.')}: ${i.message}`), advisories };
  const p = parsed.data, seen = new Set<string>();
  if (reasoningRequired && p.reasoningVersion !== 1) blocking.push('Chính sách v3 cần reasoningVersion=1 và căn cứ từng bước.');
  for (const c of p.cases) {
    if (seen.has(c.id)) blocking.push(`Mã ca ${c.id} bị trùng.`);
    seen.add(c.id);
    if (p.reasoningVersion !== 1 && c.steps?.length === 1) advisories.push(`${c.id}: kế hoạch cũ có steps cần ít nhất hai bước.`);
    if (new Set(c.requirementIds).size !== c.requirementIds.length) advisories.push(`${c.id}: mã yêu cầu bị trùng.`);
    if (p.schemaVersion === 2) for (const problem of validateOracle(contract, c.requirementIds, c.oracle)) (/không có trong điều khoản/.test(problem) ? advisories : blocking).push(`${c.id}: ${problem}`);
    if (p.reasoningVersion === 1 && c.method === 'automated') {
      if (!c.steps?.length) blocking.push(`${c.id}: thiếu bước có trạng thái trước/sau.`);
      const stepIds = new Set<string>();
      for (const [index, step] of (c.steps ?? []).entries()) {
        const field = `${c.id}.steps.${index}`;
        if (!step.id || !/^S-[A-Za-z0-9_-]+$/.test(step.id) || stepIds.has(step.id)) blocking.push(`${field}: mã bước S-x thiếu hoặc trùng.`);
        if (step.id) stepIds.add(step.id);
        if (!step.before?.trim() || !step.after?.trim()) advisories.push(`${field}: thiếu trạng thái trước/sau.`);
        if (!step.requirementIds?.length || step.requirementIds.some(id => !c.requirementIds.includes(id) || !c.oracle?.references.some(r => r.requirementId === id))) advisories.push(`${field}: thiếu điều khoản trong căn cứ đã duyệt.`);
      }
    }
    for (const id of c.requirementIds) {
      const req = contract.requirements.find((r) => r.id === id);
      if (!req) blocking.push(`${c.id}: yêu cầu ${id} không tồn tại.`);
      else if (c.method === 'manual' && !req.manual) blocking.push(`${c.id}: chuyển ca sang thủ công cần đánh dấu yêu cầu ${id} là thủ công trong hợp đồng.`);
    }
    if (c.priority === 'high' && !c.required) blocking.push(`${c.id}: ca rủi ro cao phải bắt buộc.`);
    if ((p.schemaVersion === 2 || p.statefulModelVersion === 1) && c.required && c.method === 'automated' && ['state', 'concurrency', 'consistency'].includes(c.group)) {
      if (!c.steps || c.steps.length < 2) blocking.push(`${c.id}: ca ${RISK_LABELS[c.group]} bắt buộc phải mô tả chuỗi ít nhất hai bước.`);
      if (!c.invariants?.length) advisories.push(`${c.id}: ca ${RISK_LABELS[c.group]} bắt buộc phải nêu bất biến cần giữ sau từng bước.`);
    }
  }
  for (const req of contract.requirements.filter((r) => r.required && !r.manual)) {
    if (!p.cases.some((c) => c.required && c.method === 'automated' && c.requirementIds.includes(req.id))) blocking.push(`${req.id}: thiếu ca tự động bắt buộc.`);
  }
  for (const group of RISK_GROUPS) {
    const covered = p.cases.some((c) => c.group === group), na = p.notApplicable.filter((n) => n.group === group);
    if (!covered && !na.length) advisories.push(`Chưa xét nhóm ${RISK_LABELS[group]} hoặc nêu lý do không áp dụng.`);
    if (na.length > 1 || (covered && na.length)) advisories.push(`Nhóm ${RISK_LABELS[group]} khai báo mâu thuẫn hoặc trùng.`);
  }
  if (p.questions.length) blocking.push(UNRESOLVED_PLAN_QUESTIONS);
  return { blocking, advisories };
}

/** Pure validation shared by contract approval and plan generation; never edits legacy contracts. Blocking findings only. */
export const validateTestPlan = (contract: TaskContract, required = false, reasoningRequired = false): string[] => testPlanFindings(contract, required, reasoningRequired).blocking;

export function manifestFindings(contract: TaskContract, entries: ManifestEntry[], recipes: readonly { id: string; reportPath?: string }[], files: readonly string[]): Findings {
  const problems: string[] = [], advisories: string[] = [], seen = new Set<string>();
  for (const e of entries) {
    const c = contract.testPlan?.cases.find((c) => c.id === e.caseId);
    if (!c || c.method !== 'automated') problems.push(`${e.caseId}: ca tự động không tồn tại.`);
    if (!isSafeRelative(e.path) || !isTestPath(e.path) || !files.includes(e.path)) problems.push(`${e.caseId}: file test không hợp lệ hoặc chưa được Author tạo: ${e.path}`);
    if (!recipes.some((r) => r.id === e.recipeId && r.reportPath)) problems.push(`${e.caseId}: recipe cần tồn tại và xuất report.`);
    if (e.identity && (identityId(e.identity) !== e.testId || (e.identity.kind === 'json' && (e.identity.file !== e.path || !isSafeRelative(e.identity.file))))) problems.push(`${e.caseId}: danh tính test không khớp đường dẫn/ID.`);
    if (!extractCaseIds(e.testId).includes(e.caseId)) problems.push(`${e.caseId}: tên test thiếu mã ca.`);
    if (contract.testPlan?.reasoningVersion === 1 && c) {
      if (!e.assertions?.length) problems.push(`${e.caseId}: thiếu liên kết assertion tới bước đã duyệt.`);
      for (const a of e.assertions ?? []) {
        const step = c.steps?.find(s => s.id === a.stepId);
        if (!step || a.expected !== step.expected) problems.push(`${e.caseId}.${a.stepId}: assertion không khớp kết quả của bước đã duyệt.`);
      }
    }
    if (new Set(e.requirementIds).size !== e.requirementIds.length || !c || [...e.requirementIds].sort().join(',') !== [...c.requirementIds].sort().join(',')) problems.push(`${e.caseId}: liên kết yêu cầu không khớp kế hoạch.`);
    for (const id of e.requirementIds) {
      const underscored = /^R-(\d+)$/.exec(id)?.[1];
      const title = testTitle(e.testId);
      const tags = [...title.matchAll(/\[([^\]]+)\]/g)].flatMap(m => m[1]!.split(/[\s,;]+/));
      if (!tags.includes(id) && !(underscored && new RegExp(`(?:^|[^A-Za-z0-9])R_${underscored}(?:$|[^A-Za-z0-9])`).test(title))) problems.push(`${e.caseId}: tên test thiếu ${id}.`);
    }
    const key = `${e.recipeId}:${normalizeTestId(e.testId)}`;
    if (seen.has(key)) problems.push(`Định danh test trùng trong recipe ${e.recipeId}: ${e.testId}`);
    seen.add(key);
  }
  for (const c of contract.testPlan?.cases ?? []) if (c.required && c.method === 'automated' && !entries.some((e) => e.caseId === c.id)) problems.push(`${c.id}: thiếu test dự kiến cho ca bắt buộc.`);
  if (contract.testPlan?.reasoningVersion === 1) for (const c of contract.testPlan.cases.filter(c=>c.required&&c.method==='automated')) for (const step of c.steps ?? []) if (!entries.some(e=>e.caseId===c.id&&e.assertions?.some(a=>a.stepId===step.id))) advisories.push(`${c.id}.${step.id}: bước bắt buộc chưa có assertion khai báo; kiểm tra bước này bằng tay hoặc bổ sung assertion.`);
  return { blocking: problems, advisories };
}

/** Blocking findings only; see manifestFindings for the advisories. */
export const validateManifest = (contract: TaskContract, entries: ManifestEntry[], recipes: readonly { id: string; reportPath?: string }[], files: readonly string[]): string[] => manifestFindings(contract, entries, recipes, files).blocking;
