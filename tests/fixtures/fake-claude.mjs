// Host-side stand-in for the Claude Code CLI: `--version`, `auth status` (a Claude Pro login) and
// `-p --output-format stream-json`. As Developer it fixes the bug and writes a node:test file; as Verifier it passes.
// It records the arguments it was called with, so tests can check the flags AI Department passes.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS_LOG) appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_OUT ? false : true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' }, null, 2));
  process.exit(0);
}

const prompt = readFileSync(0, 'utf8');
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
// The connection test asks for a single JSON result.
if (args[args.indexOf('--output-format') + 1] === 'json') {
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'OK', total_cost_usd: 0.001, modelUsage: { 'claude-fable-5-1': { inputTokens: 10, outputTokens: 1 } } });
  process.exit(0);
}
const fence = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
if (process.env.FAKE_CLAUDE_LIMIT) {
  emit({ type: 'system', subtype: 'init', session_id: 'claude-session-1', model: 'claude-fable-5-1' });
  emit({ type: 'result', subtype: 'success', is_error: true, session_id: 'claude-session-1', result: '5-hour limit reached ∙ resets 3pm', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
  process.exit(1);
}
let reply;
if (prompt.includes('Bạn là Planner')) {
  reply = fence({ requirements: [{ id: 'R-1', text: 'sumTo cộng cả n.', required: true, manual: false }], acceptanceExamples: [], interfaces: [], assumptions: [], scope: ['src'] });
} else if (prompt.includes('Bạn là Verifier')) {
  reply = fence({ decision: 'pass', findings: [] });
} else {
  writeFileSync('src/sum.mjs', 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i <= n; i++) total += i;\n  return total;\n}\n');
  mkdirSync('tests', { recursive: true });
  writeFileSync('tests/sum.test.mjs', "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sumTo } from '../src/sum.mjs';\n\ntest('[R-1] sumTo includes n', () => {\n  assert.equal(sumTo(3), 6);\n});\n");
  reply = fence({ reuse: [] });
}
emit({ type: 'system', subtype: 'init', session_id: 'claude-session-1', model: 'claude-fable-5-1' });
emit({ type: 'assistant', session_id: 'claude-session-1', message: { id: 'msg_1', content: [{ type: 'text', text: reply }] } });
emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session-1', result: reply, total_cost_usd: 0.42, usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 20 } });
