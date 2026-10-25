import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const root=path.resolve('.'),out=path.join(root,'test-results/2026-10-25-pulsegraph'),ref=await readFile(path.join(out,'reference.mjs'),'utf8');
const run=(file,label)=>{const r=spawnSync(process.execPath,[path.join(out,'grade.mjs'),file,path.join(out,`${label}.json`)],{encoding:'utf8',windowsHide:true,timeout:60000});if(r.error)throw r.error;return JSON.parse(requireResult(path.join(out,`${label}.json`)));};
const requireResult=async file=>await readFile(file,'utf8');
await mkdir(path.join(out,'mutants'),{recursive:true});
const fixtures=[
  {name:'broken-expiry-boundary',old:'j.leaseUntil <= time',next:'j.leaseUntil < time',expected:'D21-boundary-expires-before-return'},
  {name:'broken-exponential-retry',old:'state.retryBase * (2 ** (job.attempt - 1))',next:'state.retryBase',expected:'D26-exponential-retry-delay'},
];
const audit=[];
for(const f of fixtures){const p=path.join(out,'mutants',`${f.name}.mjs`),n=ref.split(f.old).length-1;if(n!==1)throw new Error(`Expected one mutation target for ${f.name}, found ${n}`);await writeFile(p,ref.replace(f.old,f.next));const r=spawnSync(process.execPath,[path.join(out,'grade.mjs'),p,path.join(out,`${f.name}.json`)],{encoding:'utf8',windowsHide:true,timeout:60000});if(r.error)throw r.error;const result=JSON.parse(await requireResult(path.join(out,`${f.name}.json`)));const caught=result.failed>0&&result.results.some(x=>x.id===f.expected&&x.status==='FAILED');audit.push({name:f.name,expectedFailure:f.expected,caught,passed:result.passed,failed:result.failed,total:result.total});}
const scaffold=path.join(out,'mutants','scaffold.mjs');await writeFile(scaffold,"export function createScheduler(){throw new Error('Not implemented')} export function restoreScheduler(){throw new Error('Not implemented')}\n");
const sc=spawnSync(process.execPath,[path.join(out,'grade.mjs'),scaffold,path.join(out,'scaffold.json')],{encoding:'utf8',windowsHide:true,timeout:60000});if(sc.error)throw sc.error;const sr=JSON.parse(await requireResult(path.join(out,'scaffold.json')));
const report={schemaVersion:1,at:new Date().toISOString(),oracleSelfCheck:{passed:JSON.parse(await requireResult(path.join(out,'reference-selfcheck.json'))).passed,total:75},unimplementedScaffold:{passed:sr.passed,failed:sr.failed,total:sr.total},mutants:audit};
await writeFile(path.join(out,'grader-audit.json'),JSON.stringify(report,null,2));if(audit.some(x=>!x.caught)||sr.passed!==0)throw new Error('Grader failed audit');console.log(JSON.stringify(report));
