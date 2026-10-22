// Host-side stand-in for `codex exec --json`: edits files in its cwd and emits Codex-style JSONL.
import { readFileSync, writeFileSync } from 'node:fs';

const prompt = readFileSync(0, 'utf8');
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const fence = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

let reply;
if (prompt.includes('Bạn là Planner')) {
  reply = fence({ requirements: [{ id: 'R-1', text: 'sumTo(n) cộng cả n.', required: true, manual: false }], acceptanceExamples: [{ input: 3, output: 6 }], interfaces: [], assumptions: [], scope: ['src'] });
} else {
  writeFileSync('src/sum.mjs', 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i <= n; i++) total += i;\n  return total;\n}\n');
  reply = fence({ reuse: [{ path: 'src/sum.mjs', fit: 'high', decision: 'extend', reason: 'sửa hàm hiện có' }] });
}
emit({ type: 'thread.started', thread_id: 'fake-local' });
emit({ type: 'turn.started' });
emit({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: reply } });
emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
