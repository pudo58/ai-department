// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {act,createElement,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {TestPlanEditor,TestPlanView} from '../src/client/Quality.js';
import {FindingReplayResults} from '../src/client/FindingReplays.js';
import {ContractPanel} from '../src/client/RunPanels.js';
import {initialContract,hashContract} from '../src/core/contract.js';
import type {TestPlan} from '../src/shared/quality.js';
import type {FindingReplay} from '../src/shared/reproduction.js';
import {reasoningPlan} from './reasoning-fixtures.js';
import {setup} from './helpers.js';
let root:Root|undefined;afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=undefined;document.body.innerHTML='';vi.unstubAllGlobals();});
const mount=()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);return root=createRoot(host);};
it('edits per-step reasoning without discarding links and shows the current/historical replay observations',async()=>{
 const c=initialContract('Claim each ready job once.');let current:TestPlan=reasoningPlan(c);const oldHash=hashContract({...c,testPlan:current});
 function Editor(){const [p,set]=useState(current);return createElement(TestPlanEditor,{plan:p,onChange:next=>{current=next;set(next);}});}
 const r=mount();await act(async()=>r.render(createElement(Editor)));const textarea=document.querySelector('textarea[aria-label="after C-1 1"]') as HTMLTextAreaElement;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'A leased; clock still 0');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
 expect(current.cases[0]!.steps![0]).toMatchObject({id:'S-1',before:'A B C ready',after:'A leased; clock still 0',requirementIds:['R-1']});expect(hashContract({...c,testPlan:current})).not.toBe(oldHash);
 await act(async()=>r.render(createElement(TestPlanView,{plan:current})));expect(document.body.textContent).toContain('A leased; clock still 0');
 const sample:FindingReplay={schemaVersion:1,source:'runner',findingId:'fnd_1',checkpoint:'old',contractVersion:1,slot:'A',configHash:'hash',scenarioHash:'scenario',status:'reproduced',startedAt:new Date().toISOString(),durationMs:5,message:'Mismatch',observations:[{stepId:'S-6',expected:'A',actual:'B',matched:false}]};
 await act(async()=>r.render(createElement(FindingReplayResults,{checkpoint:'new',replays:[sample,{...sample,checkpoint:'new',status:'not_reproduced',observations:[{stepId:'S-6',expected:'A',actual:'A',matched:true}]}]})));expect(document.body.textContent).toContain('Lịch sử');expect(document.body.textContent).toContain('Bản hiện tại');expect(document.body.textContent).toContain('Đã tái hiện sai khác');expect(document.body.textContent).toContain('Kết quả của ca này đều khớp');
 const out=path.resolve('test-results/reasoning-v3');mkdirSync(out,{recursive:true});writeFileSync(path.join(out,'ui-replay.html'),document.documentElement.outerHTML);
});
it('resets contract warning acknowledgement when a step state changes under v3',async()=>{
 const e=setup(),run=e.create({mode:'verify'});e.orchestrator.startRun(run.id);await e.orchestrator.idle();const before=e.orchestrator.detail(run.id);expect(before.contractReview.problems).toEqual([]);const r=mount(),render=async()=>act(async()=>r.render(createElement(ContractPanel,{detail:e.orchestrator.detail(run.id),onApprove:async()=>{}})));
 await render();const button=()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.startsWith('Duyệt hợp đồng'))!;expect(button().disabled).toBe(true);const ack=document.querySelector('input[type="checkbox"]') as HTMLInputElement;await act(async()=>ack.click());expect(button().disabled).toBe(false);
 const contract=structuredClone(before.run.contract);contract.testPlan!.cases[0]!.steps![0]!.before+='; revised input';e.orchestrator.reviseContract(run.id,contract);await render();expect(button().disabled).toBe(true);expect((document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);expect(()=>e.orchestrator.approveContract(run.id,{contractHash:before.contractReview.contractHash,acknowledgeWarnings:true})).toThrow('đã thay đổi');e.store.close();
});
