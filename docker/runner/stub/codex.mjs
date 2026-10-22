#!/usr/bin/env node
// Scripted stand-in for `codex exec --json`. Reads the prompt on stdin, edits /workspace, emits Codex-style JSONL.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const prompt = readFileSync(0, 'utf8');
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const fence = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

let reply;
if (prompt.includes('Bạn là Planner')) {
  reply = `Hợp đồng đề xuất.\n${fence({
    requirements: [{ id: 'R-1', text: 'sumTo(n) trả về tổng các số nguyên từ 1 đến n, bao gồm n.', required: true, manual: false }],
    acceptanceExamples: ['sumTo(3) === 6', 'sumTo(0) === 0'], interfaces: ['sumTo(n: number): number'], assumptions: [], scope: ['src'],
  })}`;
} else if (prompt.includes('Bạn là Developer')) {
  // The "fix": correct the off-by-one and add a tagged regression test.
  writeFileSync('/workspace/src/sum.ts', 'export function sumTo(n: number): number {\n  let total = 0;\n  for (let i = 1; i <= n; i++) total += i;\n  return total;\n}\n');
  mkdirSync('/workspace/tests', { recursive: true });
  writeFileSync('/workspace/tests/sum.test.ts', "import { expect, it } from 'vitest';\nimport { sumTo } from '../src/sum';\n\nit('[R-1] includes n in the sum', () => {\n  expect(sumTo(3)).toBe(6);\n  expect(sumTo(0)).toBe(0);\n});\n");
  reply = `Đã sửa off-by-one.\n${fence({ reuse: [{ path: 'src/sum.ts', fit: 'high', decision: 'extend', reason: 'Sửa trực tiếp hàm hiện có.' }] })}`;
} else {
  reply = `Không có việc cho vai này.\n${fence({ reuse: [] })}`;
}

emit({ type: 'thread.started', thread_id: 'stub-thread' });
emit({ type: 'turn.started' });
emit({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: reply } });
emit({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300 } });
