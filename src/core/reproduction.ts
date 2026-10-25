import {z} from 'zod';
import type {Artifact,Run} from '../shared/types.js';
import type {FindingReplay,FindingReproduction} from '../shared/reproduction.js';
import {OracleSchema,validateOracle} from './testplan.js';
import {canonicalJson,sha256} from './contract.js';
import {isSafeRelative} from './scope.js';

const name=z.string().regex(/^[A-Za-z_$][\w$-]*$/).refine(s=>!['__proto__','prototype','constructor'].includes(s));
const key=z.string().max(100).refine(s=>!['__proto__','prototype','constructor'].includes(s));
const args=z.array(z.json()).max(12);
export const ReproductionSchema=z.object({schemaVersion:z.literal(1),adapter:z.literal('node-api'),module:z.string().min(1).max(500),factory:name,args,
  steps:z.array(z.object({id:name,method:name,args,expect:z.object({path:z.array(key).max(20),equals:z.json().optional(),throwsCode:z.string().min(1).max(100).optional()}).refine(e=>Object.hasOwn(e,'equals')!==Object.hasOwn(e,'throwsCode'),'Cần duy nhất equals hoặc throwsCode.').optional()})).min(1).max(30),oracle:OracleSchema
}).refine(s=>JSON.stringify(s).length<=100_000,'Phản ví dụ quá lớn.');
export const scenarioHash=(s:FindingReproduction):string=>sha256(canonicalJson(s));
export const replayConfigHash=(run:Run):string=>sha256(canonicalJson({profile:run.configSnapshot,approvedPaths:run.approvedPaths??[]}));
export const REPLAY_TITLE='Finding replay';
export function reproductionProblems(run:Run,scenario:FindingReproduction):string[]{
 const errors=validateOracle(run.contract,run.contract.requirements.map(r=>r.id),scenario.oracle);
 if(!isSafeRelative(scenario.module)||!/\.(?:m?js|ts)$/.test(scenario.module))errors.push('Adapter node-api cần module .js/.mjs/.ts tương đối trong checkpoint.');
 if(!scenario.steps.some(s=>s.expect))errors.push('Phản ví dụ cần ít nhất một kết quả mong đợi.');
 const ids=new Set<string>();
 const references=(v:unknown):void=>{
   if(!v||typeof v!=='object')return;
   if(!Array.isArray(v)&&Object.hasOwn(v,'$ref')){
     const r=v as {$ref:unknown;path?:unknown};
     if(typeof r.$ref!=='string'||!ids.has(r.$ref)||!Array.isArray(r.path)||r.path.some(k=>typeof k!=='string'||!key.safeParse(k).success))errors.push('Tham chiếu kết quả phải dùng bước trước và path hợp lệ.');
   }else for(const value of Object.values(v))references(value);
 };
 scenario.args.forEach(references);
 for(const step of scenario.steps){if(ids.has(step.id))errors.push(`Mã bước ${step.id} trùng.`);step.args.forEach(references);ids.add(step.id);}
 return errors;
}
export function readFindingReplays(run:Run,artifacts:readonly Artifact[]):FindingReplay[]{
 const latest=new Map<string,FindingReplay>();
 for(const a of artifacts){
  if(a.title!==REPLAY_TITLE||!a.valid||a.contractVersion!==run.contract.version||a.hash!==sha256(a.content))continue;
  try{const r=JSON.parse(a.content) as FindingReplay;if(r.schemaVersion===1&&r.source==='runner'&&r.checkpoint===a.checkpoint&&r.contractVersion===run.contract.version&&r.slot===run.selectedSlot&&r.configHash===replayConfigHash(run)&&Array.isArray(r.observations)&&['in_progress','reproduced','not_reproduced','unsupported','error','timeout','interrupted'].includes(r.status))latest.set(`${r.findingId}:${r.checkpoint}:${r.scenarioHash}`,r);}catch{/* Unreadable evidence never confirms a finding. */}
 }
 return [...latest.values()];
}

export const reproductionGuide=`Có thể bổ sung reproduction cho finding behavior với public API thuần Node ESM: {schemaVersion:1,adapter:"node-api",module:"src/module.js",factory:"createAPI",args:[],steps:[{id:"S-1",method:"submit",args:[{id:"A"}]},{id:"S-2",method:"get",args:["A"],expect:{path:["status"],equals:"ready"}}],oracle:{references:[{requirementId:"R-1",quote:"trích nguyên văn hợp đồng"}],explanation:"vì sao expect đúng"}}. Các call theo thứ tự, await được; tham chiếu kết quả trước bằng {$ref:"S-1",path:["token"]}. Mỗi expect là equals hoặc throwsCode (đối với throwsCode dùng path:[]). Không đưa shell/script tùy ý. Chưa hỗ trợ stack/API này thì ghi reproductionLimitation cụ thể, không bịa kết quả chạy. Runner sẽ chạy bản sao đúng checkpoint; mismatch là bằng chứng để người dùng xem, chưa tự xác nhận ngữ nghĩa của oracle.`;
