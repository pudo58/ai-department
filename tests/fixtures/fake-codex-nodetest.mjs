// Host-side stand-in for `codex exec --json` that behaves like the real agent did on a repo with no test runner:
// it fixes the bug and writes a node:test file whose title groups several requirement ids in one bracket.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const prompt = readFileSync(0, 'utf8');
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const fence = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

let reply;
if (prompt.includes('Bạn là Planner')) {
  reply = fence({ requirements: [{ id: 'R-1', text: 'sumTo cộng cả n.', required: true, manual: false }], acceptanceExamples: [], interfaces: [], assumptions: [], scope: ['src'] });
} else {
  writeFileSync('src/sum.mjs', 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i <= n; i++) total += i;\n  return total;\n}\n');
  mkdirSync('tests', { recursive: true });
  writeFileSync('tests/sum.test.mjs', "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sumTo } from '../src/sum.mjs';\n\ntest('[R-1, R-9] sumTo includes n', () => {\n  assert.equal(sumTo(3), 6);\n});\n");
  reply = fence({ reuse: [] });
}
emit({ type: 'thread.started', thread_id: 'fake-nodetest' });
emit({ type: 'turn.started' });
emit({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: reply } });
emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
