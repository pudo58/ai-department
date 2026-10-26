import {expect,it} from 'vitest';
import {z} from 'zod';
import {extractJsonBlock,parseOutput} from '../src/core/outputs.js';
import {authorTestProblems,planningScaffold} from '../src/core/authoring.js';
import {initialContract} from '../src/core/contract.js';
import {renderReportMarkdown} from '../src/core/report.js';
import {setupV2 as setup} from './helpers.js';
import {qualityReply,qualityGreen,qualityReport} from './quality-fixtures.js';

it('reads complete final JSON without repairing syntax or accepting trailing prose',()=>{
 expect(extractJsonBlock('Explanation before result.\n{"decision":"implementation"}')).toEqual({decision:'implementation'});
 expect(extractJsonBlock('Explanation\n{\n "nested": {"x":"braces } in text"}\n}')).toEqual({nested:{x:'braces } in text'}});
 expect(()=>extractJsonBlock('Explanation\n{"x":1}\nnot the final result')).toThrow();
 expect(()=>extractJsonBlock('Explanation\n{"x":')).toThrow();
 expect(()=>parseOutput(z.object({decision:z.literal('implementation')}),'Intro\n{"decision":"made_up"}')).toThrow(/sai định dạng/);
 expect(()=>extractJsonBlock('```json\n{"x":\n```\n{"x":1}')).toThrow();
});
it('flags eager rejection calls but allows deferred calls, strings and comments',()=>{
 expect(authorTestProblems('tests/a.test.js',`expect(ledger.apply(req)).rejects.toThrow()`)).toHaveLength(1);
 expect(authorTestProblems('tests/a.test.js',`expect(Promise.resolve().then(() => ledger.apply(req))).rejects.toThrow()`)).toEqual([]);
 expect(authorTestProblems('tests/a.test.js',`// expect(ledger.apply(req)).rejects\nconst text='expect(call()).rejects';`)).toEqual([]);
 expect(authorTestProblems('tests/a.py','expect(call()).rejects')).toEqual([]);
});
it('generates authoritative quotes and all risk groups without changing the contract',()=>{
 const c=initialContract('Exact quote.');const original=JSON.stringify(c),s=JSON.parse(planningScaffold(c));
 expect(s.requirements[0].quote).toBe(c.requirements[0]!.text);expect(s.groups).toHaveLength(7);
 expect(s.statefulCaseFields.steps).toHaveLength(2);expect(JSON.stringify(c)).toBe(original);
});
it('does not stop on an unusable diagnosis or buy another one: locked tests stay and the Developer goes on',async()=>{
 let developers=0,diagnoses=0;
 const e=setup({reply:x=>{if(x.role==='developer')developers++;if(x.prompt.includes('Author chẩn đoán')){diagnoses++;return 'Incomplete old output';}return qualityReply(x);},files:x=>x.role==='author'?['tests/order.test.ts']:['src/order.ts'],check:()=>({...qualityGreen,exitCode:developers>1?0:1,report:qualityReport(developers>1?'passed':'failed')})});
 const run=await e.drive(e.create({mode:'verify',budgetUsd:10}));
 expect(diagnoses).toBe(1);expect(developers).toBe(2);expect(run.status).toBe('awaiting_acceptance');
 const d=e.orchestrator.detail(run.id);
 expect(d.artifacts.filter(a=>a.title==='Pipeline fallback').map(a=>a.content).join(' ')).toContain('Giữ nguyên bộ test đã khóa');
 expect(d.attempts.filter(a=>a.role==='author'&&a.stage==='repair')).toHaveLength(1);
 expect(d.degraded).toEqual({stages:['Chẩn đoán test'],items:1});
 const report=await e.orchestrator.report(run.id);
 expect(report.degraded).toEqual(d.degraded);expect(renderReportMarkdown(report)).toContain('chạy suy giảm');
 expect(report.warnings.some(w=>w.level==='warn'&&/Tự xử lý ở bước "Chẩn đoán test"/.test(w.text))).toBe(true);
});
it.each([false,true])('retries a protected smoke-test edit once without changing scope; repeated violation=%s',async repeat=>{
 let authorCalls=0;
 const e=setup({reply:x=>qualityReply(x),files:x=>x.role==='author'?(++authorCalls===1||repeat?['tests/scaffold.test.js']:['tests/order.test.ts']):['src/order.ts'],check:()=>qualityGreen});
 const p=e.store.projects.get('prj-demo')??e.store.projects.list()[0]!;
 e.store.projects.put({...p,protectedPaths:[...p.protectedPaths,'tests/scaffold.test.js']});
 const run=await e.drive(e.create({mode:'verify',budgetUsd:10}));
 expect(authorCalls).toBe(2);
 expect(run.configSnapshot.protectedPaths).toContain('tests/scaffold.test.js');
 expect(run.status).toBe(repeat?'blocked':'awaiting_acceptance');
 if(repeat)expect(e.orchestrator.detail(run.id).attempts.some(a=>a.role==='developer')).toBe(false);
 expect(e.runtime.calls.filter(c=>c==='revert:A').length).toBeGreaterThan(0);
});
