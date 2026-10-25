import { z } from 'zod';
import type { Run } from '../shared/types.js';
import { OracleSchema, validateOracle } from './testplan.js';
import { isSafeRelative,classifyPath } from './scope.js';
import { isTestPath } from './testpath.js';

const text=z.string().trim().min(1).max(8000);
export const DiagnosisSchema=z.object({decision:z.enum(['implementation','test_setup','test_assertion','ambiguous']),reason:text,evidence:text,caseIds:z.array(text).max(100).default([]),
  assessment:z.object({target:z.enum(['source','test','unknown']),testConformsToContract:z.boolean().nullable(),expected:text,actual:text,location:text,failingTestIds:z.array(text).min(1).max(100),oracle:OracleSchema}).optional(),
  assertionChanges:z.array(z.object({caseId:text,before:text,after:text,oracle:OracleSchema})).max(100).optional()});
export type Diagnosis=z.infer<typeof DiagnosisSchema>;

/** Structural checks only: never infer a decision by looking for keywords in free text. */
export function diagnosisProblems(run:Run,d:Diagnosis,caseIds:readonly string[],failedTestIds:readonly string[],testPaths:readonly string[],changedPaths:readonly string[]):string[]{
  if(run.qualityPolicyVersion!==3)return [];
  const errors:string[]=[],a=d.assessment;
  if(!d.caseIds.length||d.caseIds.some(id=>!caseIds.includes(id)))errors.push('caseIds phải chỉ rõ các ca thực sự thất bại.');
  if(!a)return [...errors,'Thiếu assessment có expected/actual, điều khoản, test lỗi và đích sửa.'];
  if(a.expected===a.actual)errors.push('Expected và actual giống nhau; chưa chỉ ra sai khác.');
  if(a.failingTestIds.some(id=>!failedTestIds.includes(id)))errors.push('assessment tham chiếu test không thất bại trong report hiện hành.');
  const reqs=[...new Set(run.contract.testPlan?.cases.filter(c=>d.caseIds.includes(c.id)).flatMap(c=>c.requirementIds)??[])];
  errors.push(...validateOracle(run.contract,reqs,a.oracle));
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
