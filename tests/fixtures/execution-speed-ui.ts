/** Temporary UI fixture: all agents and project checks are simulated; zero live model calls. */
import { mkdtempSync,writeFileSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupV2 as setup } from '../helpers.js';
import { fence,qualityReply,qualityGreen,structuredEntries } from '../quality-fixtures.js';
import { buildApp } from '../../src/server/app.js';
import { environmentHash } from '../../src/runtime/preflight.js';
import { sha256 } from '../../src/core/contract.js';

const env=setup({reply:x=>x.role==='author' && x.attempt.stage==='implement'?'Malformed manifest fixture':qualityReply(x),files:x=>x.role==='author'?['tests/order.test.ts']:['src/order.ts'],check:()=>qualityGreen});
let probes=0;
Object.assign(env.runtime,{preflight:async(run:Parameters<typeof environmentHash>[0])=>{const blocked=run.title.includes('môi trường') && probes++===0;return {schemaVersion:1,status:blocked?'blocked':'passed',runtime:'fake',workspace:'temporary fixture',configHash:environmentHash(run),checkpoint:run.checkpoint,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),checks:[{recipeId:'test',status:blocked?'blocked':'passed',message:blocked?'Fixture: node_modules rỗng, Vitest chưa có.':'Fixture: môi trường đã được sửa, không gọi AI.'}],limitation:'Mô phỏng UI; không xác nhận quyền trong sandbox agent.'};}});
const a=env.create({title:'Fixture: kiểm tra lại môi trường',mode:'verify'});env.orchestrator.startRun(a.id);await env.orchestrator.idle();
const b=await env.drive(env.create({title:'Fixture: phục hồi draft Author',mode:'verify'}));
const draft=env.orchestrator.detail(b.id).authorDraft!;const artifact=env.store.artifacts.get(draft.artifactId)!;
const payload=JSON.parse(artifact.content);payload.output=fence({entries:structuredEntries()});payload.problems=['Fixture: parser cũ chưa đọc được JSON; kiểm tra lại bằng parser hiện tại.'];const content=JSON.stringify(payload);env.store.artifacts.put({...artifact,content,hash:sha256(content)});
const dataDir=mkdtempSync(path.join(tmpdir(),'aidept-speed-ui-')),port=14339;
const app=await buildApp({...env,dataDir,port,staticDir:path.resolve('dist/client')});await app.listen({host:'127.0.0.1',port});
const info={environmentUrl:`http://127.0.0.1:${port}/#/run/${a.id}`,draftUrl:`http://127.0.0.1:${port}/#/run/${b.id}`,environmentRunId:a.id,draftRunId:b.id,port,realModelCalls:0};
const output=path.resolve('test-results/execution-speed');mkdirSync(output,{recursive:true});writeFileSync(path.join(output,'browser-fixture.json'),JSON.stringify(info,null,2));console.log(JSON.stringify(info));
