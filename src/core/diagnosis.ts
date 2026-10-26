import { z } from 'zod';
import type { Run } from '../shared/types.js';
import type { Oracle } from '../shared/quality.js';
import { OracleSchema, validateOracle } from './testplan.js';
import { isSafeRelative,classifyPath } from './scope.js';
import { isTestPath } from './testpath.js';
import { testTitle } from './testids.js';
import { snapQuote } from './quote.js';

const text=z.string().trim().min(1).max(8000);
export const DiagnosisSchema=z.object({decision:z.enum(['implementation','test_setup','test_assertion','ambiguous']),reason:text,evidence:text,caseIds:z.array(text).max(100).default([]),
  assessment:z.object({target:z.enum(['source','test','unknown']),testConformsToContract:z.boolean().nullable(),expected:text,actual:text,location:text,failingTestIds:z.array(text).min(1).max(100),oracle:OracleSchema}).optional(),
  assertionChanges:z.array(z.object({caseId:text,before:text,after:text,oracle:OracleSchema})).max(100).optional()});
export type Diagnosis=z.infer<typeof DiagnosisSchema>;

const fold = (v: string): string => v.replace(/\s+/g, ' ').trim();
/** A failing test may be named by its runner id or by the readable title the runner prints; both mean the same test. */
export function resolveFailingTest(given: string, failedTestIds: readonly string[]): string | undefined {
  if (failedTestIds.includes(given)) return given;
  const matches = failedTestIds.filter(id => fold(testTitle(id)) === fold(given));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Structural checks only: never infer a decision by looking for keywords in free text. */
export function diagnosisProblems(run:Run,d:Diagnosis,caseIds:readonly string[],failedTestIds:readonly string[],testPaths:readonly string[],changedPaths:readonly string[]):string[]{
  if(run.qualityPolicyVersion!==3)return [];
  const errors:string[]=[],a=d.assessment;
  if(!d.caseIds.length||d.caseIds.some(id=>!caseIds.includes(id)))errors.push('caseIds phải chỉ rõ các ca thực sự thất bại.');
  if(!a)return [...errors,'Thiếu assessment có expected/actual, điều khoản, test lỗi và đích sửa.'];
  if(a.expected===a.actual)errors.push('Expected và actual giống nhau; chưa chỉ ra sai khác.');
  if(a.failingTestIds.some(id=>resolveFailingTest(id,failedTestIds)===undefined))errors.push('assessment tham chiếu test không thất bại trong report hiện hành.');
  const reqs=[...new Set(run.contract.testPlan?.cases.filter(c=>d.caseIds.includes(c.id)).flatMap(c=>c.requirementIds)??[])];
  errors.push(...validateOracle(run.contract,reqs,a.oracle,{originalRequirement:run.originalRequirement,anyClause:true}));
  const location=a.location.replace(/:\d+(?:-\d+)?$/,'').replace(/\\/g,'/');
  if(!isSafeRelative(location))errors.push('location phải là đường dẫn tương đối, có thể kèm số dòng.');
  if(d.decision==='implementation'){
    if(a.target!=='source'||a.testConformsToContract!==true||isTestPath(location)||testPaths.includes(location))errors.push('Nhãn implementation mâu thuẫn với đích sửa hoặc việc test phù hợp hợp đồng.');
    if(classifyPath(location,{modules:[...run.configSnapshot.modules,...(run.approvedPaths??[])],protectedPaths:run.configSnapshot.protectedPaths,lockedPaths:[...testPaths]})!=='allowed')errors.push('location sửa source không nằm trong phạm vi được phép.');
    if(d.assertionChanges?.length||changedPaths.length)errors.push('Chẩn đoán implementation không được đề xuất/sửa test hoặc bất kỳ file nào.');
  }else if(d.decision==='test_assertion'||d.decision==='test_setup'){
    if(a.target!=='test'||a.testConformsToContract!==false||!testPaths.includes(location))errors.push('Chẩn đoán test cần chỉ ra file test của ca lỗi và testConformsToContract=false.');
    if(d.decision==='test_assertion'&&!d.assertionChanges?.length)errors.push('Thiếu assertionChanges cho bản sửa assertion.');
  }else if(a.target!=='unknown'||a.testConformsToContract!==null||changedPaths.length)errors.push('Chẩn đoán ambiguous phải giữ đích unknown, conformity=null và không sửa file.');
  return errors;
}

export const diagnosisOutputGuide=JSON.stringify({decision:'implementation|test_setup|test_assertion|ambiguous',reason:'kết luận phù hợp với assessment',evidence:'bằng chứng runner',caseIds:['C-1'],assessment:{target:'source|test|unknown',testConformsToContract:true,expected:'kết quả theo hợp đồng',actual:'kết quả trong report',location:'src/module.ts:10',failingTestIds:['ID chính xác trong runner'],oracle:{references:[{requirementId:'R-1',quote:'trích nguyên văn'}],explanation:'liên hệ điều khoản với sai khác'}},assertionChanges:[]});

const clip = (t: string): string => (t.length > 8000 ? t.slice(0, 8000) : t);

/**
 * A diagnosis that says "the test is wrong" is judged by its decision and by the diff it produced. The redundant fields
 * around it (target, conformity, location, failing-test list, a quotation that is not word for word in the clause) are
 * restated from those facts instead of being a reason to throw the diagnosis away: a wrong test the Developer cannot satisfy
 * is exactly the case the diagnosis exists for. Implementation and ambiguous diagnoses are left as they are. Every change is listed.
 */
export function normalizeDiagnosis(run: Run, d: Diagnosis, ctx: { failingCaseIds: readonly string[]; testPaths: readonly string[]; changedPaths: readonly string[]; failedTestIds: readonly string[] }): { diagnosis: Diagnosis; notes: string[] } {
  if (run.qualityPolicyVersion !== 3 || !d.assessment || (d.decision !== 'test_setup' && d.decision !== 'test_assertion')) return { diagnosis: d, notes: [] };
  const out: Diagnosis = structuredClone(d), a = out.assessment!, notes: string[] = [];
  const known = out.caseIds.filter(id => ctx.failingCaseIds.includes(id));
  if (known.length !== out.caseIds.length || !known.length) { out.caseIds = known.length ? known : [...ctx.failingCaseIds]; notes.push('caseIds được đưa về các ca thực sự thất bại.'); }
  if (a.target !== 'test' || a.testConformsToContract !== false) { a.target = 'test'; a.testConformsToContract = false; notes.push('target/testConformsToContract được đặt theo quyết định "test sai".'); }
  const line = /:\d+(?:-\d+)?$/.exec(a.location)?.[0] ?? '';
  const file = a.location.replace(/:\d+(?:-\d+)?$/, '').replace(/\\/g, '/');
  if (!ctx.testPaths.includes(file)) {
    const target = ctx.changedPaths.find(p => ctx.testPaths.includes(p)) ?? ctx.testPaths[0];
    if (target) { a.location = `${target}${line}`; notes.push(`location được đưa về file test của ca lỗi (${target}).`); }
  }
  if (a.failingTestIds.some(id => resolveFailingTest(id, ctx.failedTestIds) === undefined) && ctx.failedTestIds.length) { a.failingTestIds = [...ctx.failedTestIds]; notes.push('failingTestIds được lấy từ report của runner.'); }
  const caseReqs = [...new Set(run.contract.testPlan?.cases.filter(c => out.caseIds.includes(c.id)).flatMap(c => c.requirementIds) ?? [])];
  const ground = (oracle: Oracle): Oracle => {
    const references = oracle.references.flatMap(ref => {
      const req = run.contract.requirements.find(r => r.id === ref.requirementId);
      if (!req) return [];
      if (snapQuote(ref.quote, req.text) !== undefined || snapQuote(ref.quote, run.originalRequirement) !== undefined) return [ref];
      notes.push(`Trích dẫn ${ref.requirementId} không có trong điều khoản nên dùng nguyên văn điều khoản.`);
      return [{ requirementId: req.id, quote: clip(req.text) }];
    });
    const first = run.contract.requirements.find(r => r.id === caseReqs[0]);
    if (first && !references.some(r => caseReqs.includes(r.requirementId))) { references.push({ requirementId: first.id, quote: clip(first.text) }); notes.push(`Căn cứ chưa gắn với yêu cầu của ca lỗi nên thêm ${first.id}.`); }
    return { ...oracle, references: references.length ? references : oracle.references };
  };
  a.oracle = ground(a.oracle);
  if (out.assertionChanges) out.assertionChanges = out.assertionChanges.map(c => ({ ...c, oracle: ground(c.oracle) }));
  return { diagnosis: out, notes: [...new Set(notes)] };
}
