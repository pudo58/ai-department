// Orchestrator helper: builds a `revise` decision from the run's stored contract plus a small, explicit edit list.
//   node node_modules/tsx/dist/cli.mjs benchmarks/eval/v4-check/tools/revise.mjs <assignment-id> <round> <edits.json>
// edits: { manual: ["R-14"], dropCases: ["C-12"], clearQuestions: true, addAssumptions: ["…"], note: "why" }
// Only form-level edits are supported on purpose: no expected result can be added or changed from here.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../../../../src/server/store.ts';

const [assignment, round, editsFile] = process.argv.slice(2);
const safe = (id) => id.replace(/[^A-Za-z0-9_-]+/g, '__');
const root = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const store = new Store(path.join(root, '.data', `eval-v4check-${safe(assignment)}`, 'ai-department.sqlite'));
const run = store.runs.list().at(-1);
const edits = JSON.parse(await readFile(editsFile, 'utf8'));
const c = structuredClone(run.contract);
const requirements = c.requirements.map((r) => (edits.manual?.includes(r.id) ? { ...r, manual: true } : r));
const testPlan = structuredClone(c.testPlan);
if (edits.dropCases) testPlan.cases = testPlan.cases.filter((k) => !edits.dropCases.includes(k.id));
if (edits.clearQuestions) testPlan.questions = [];
const decision = {
  action: 'revise', note: edits.note ?? 'form-only revision',
  contract: { requirements, testPlan, assumptions: [...c.assumptions, ...(edits.addAssumptions ?? [])], acceptanceExamples: c.acceptanceExamples, interfaces: c.interfaces, scope: c.scope },
};
const out = path.join(root, 'benchmarks', 'eval', 'v4-check', 'decisions', `${safe(assignment)}.${round}.decision.json`);
await writeFile(out, JSON.stringify(decision, null, 2));
console.log(JSON.stringify({ out, requirementsManual: requirements.filter((r) => r.manual).map((r) => r.id), cases: testPlan.cases.map((k) => k.id), questions: testPlan.questions.length }));
store.close();
