import type { TaskContract, Run } from '../src/shared/types.js';
import { RISK_GROUPS, type TestPlan } from '../src/shared/quality.js';
import { initialContract } from '../src/core/contract.js';

export const fence = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
export const plan = (): TestPlan => ({ schemaVersion: 1, cases: [
  { id: 'C-1', requirementIds: ['R-1'], group: 'happy', risk: 'Dữ liệu hợp lệ bị từ chối', priority: 'normal', preconditions: 'Chưa có đơn', actions: 'Tạo đơn hợp lệ', expected: 'Có đúng một đơn', method: 'automated', required: true },
  { id: 'C-2', requirementIds: ['R-1'], group: 'boundary', risk: 'Retry tạo đơn trùng', priority: 'high', preconditions: 'Đã có đơn cùng khóa', actions: 'Retry cùng khóa', expected: 'Vẫn đúng một đơn và cùng mã', method: 'automated', required: true },
], notApplicable: RISK_GROUPS.filter(g => g !== 'happy' && g !== 'boundary').map(group => ({ group, reason: 'Không thuộc interface fixture này.' })), questions: [] });
export const contract = (): TaskContract => ({ ...initialContract('Không tạo đơn trùng'), testPlan: plan() });
export const entries = () => plan().cases.map(c => ({ caseId: c.id, requirementIds: c.requirementIds, recipeId: 'test', path: 'tests/order.test.ts', testId: `tests/order.test.ts::[R-1][${c.id}] ${c.id === 'C-1' ? 'create' : 'retry'}` }));
export const currentPlan = (p: TestPlan, contract: TaskContract): TestPlan => ({ ...p, schemaVersion: 2, cases: p.cases.map(c => ({ ...c, oracle: { references: c.requirementIds.map(requirementId => ({ requirementId, quote: contract.requirements.find(r => r.id === requirementId)!.text })), explanation: 'Fixture: the expected result, ordered steps and invariants exercise the quoted public requirement.' } })) });
export const structuredEntries = () => entries().map(e => ({ ...e, identity: { kind: 'json' as const, file: e.path, titles: [e.testId.split('::')[1]!] } }));
export const qualityReply = (exec: { role: string; prompt: string; run?: Run }) => exec.prompt.includes('Author lập kế hoạch ca kiểm thử CHỈ ĐỌC') ? fence(exec.run?.qualityPolicyVersion === 2 ? currentPlan(plan(), exec.run.contract) : plan()) : exec.role === 'author' ? fence({ entries: exec.run?.qualityPolicyVersion === 2 ? structuredEntries() : entries() }) : undefined;
export const qualityReport = (negative: 'passed' | 'failed' | 'skipped' | 'missing' = 'passed') => ({ testResults: [{ name: 'tests/order.test.ts', assertionResults: entries().filter(e => negative !== 'missing' || e.caseId !== 'C-2').map(e => ({ fullName: e.testId.split('::')[1], title: e.testId.split('::')[1], ancestorTitles: [], status: e.caseId === 'C-2' ? negative : 'passed' })) }] });
export const qualityGreen = { exitCode: 0, incomplete: false, log: 'fixture', report: qualityReport() };
