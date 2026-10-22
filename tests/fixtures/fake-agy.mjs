// Host-side stand-in for the Antigravity CLI (agy 1.4.5), shaped on captured real output: `--version`, `models`
// (tab-separated, only when signed in) and print mode with `--input-format stream-json --output-format stream-json`.
// It records its arguments, stdin, home folder and the settings.json found there, so tests can check what AI Department sends.
// Its writes go through those permission rules as agy 1.4.5 applied them (measured 2026-10-22): a rule covers its path
// and everything below it, deny beats allow, allow beats ask; a deny is a tool error the model reads and carries on, an ask
// ends the turn (headless mode cannot prompt), and a path no rule names is written wherever it is.
// As Developer it fixes the bug and writes a node:test file (absolute paths, as agy's write_file requires).
// FAKE_AGY_LOGGED_OUT: `models` fails. FAKE_AGY_WRITE: a file appears in the workspace past the rules (as a bug would).
// FAKE_AGY_HOOK: a .git/hooks/post-commit appears past the rules. FAKE_AGY_USER_FILE=<path>: that file changes past the rules.
// FAKE_AGY_ESCAPE=<path>: the agent tries write_file at that absolute path, after its own edits.
// FAKE_AGY_DENY: the agent then tries a shell command; headless mode refuses it and the turn ends with no answer.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const log = (entry) => { if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(entry)}\n`); };
if (args[0] === '--version') { console.log('1.4.5'); process.exit(0); }
if (args[0] === 'models') {
  process.stderr.write('Fetching available models...\n');
  if (process.env.FAKE_AGY_LOGGED_OUT) { process.stderr.write('Error: not signed in\n'); process.exit(1); }
  console.log('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)');
  process.exit(0);
}

const home = process.env.USERPROFILE ?? '';
const settingsFile = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : null;
const stdin = readFileSync(0, 'utf8');
log({ args, stdin, home, settings });
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const id = 'agy-conv-1';
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'gemini-3.8-flash-medium';
if (args.at(-1) !== '--print=' || !args.includes('--input-format')) { process.stderr.write('Error: empty prompt\n'); process.exit(1); }
const message = JSON.parse(stdin.trim().split('\n')[0]);
if (message.event !== 'user' || !message.message) {
  emit({ event: 'result', result: { conversation_id: id, status: 'ERROR', response: '', error: 'stream input message is missing the "event" field', usage: {} } });
  process.exit(1);
}
const prompt = String(message.message.content);
const mode = args[args.indexOf('--mode') + 1];
emit({ event: 'init', conversation_id: id, init: { model, cwd: process.cwd(), tools: ['read_file', 'run_command', 'write_to_file'], permission_mode: 'request-review' } });
emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'user_input' } });
emit({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: `${process.cwd()}\\src\\sum.mjs` }, output: '5 lines' } } });
const usage = { input_tokens: 15000, output_tokens: 200, thinking_tokens: 50, cache_read_tokens: 4000, total_tokens: 15250 };
let step = 2;

const stopDenied = (action, name, tool) => {
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: step++, state: 'ERROR', step_type: 'tool', tool_name: tool.name, tool_info: tool } });
  emit({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '', num_turns: 1, usage, denied_actions: [{ action, display_name: name }] } });
  process.stderr.write(`jetski: no output produced — a tool required the "${action}" permission that headless mode cannot prompt for, so it was auto-denied.\n`);
  process.exit(0);
};
const rules = (kind) => (settings?.permissions?.[kind] ?? []).map((rule) => /^write_file\((.*)\)$/.exec(rule)?.[1]).filter(Boolean);
const covers = (rule, target) => rule === '*' || target === rule.replace(/\/$/, '') || target.startsWith(rule.endsWith('/') ? rule : `${rule}/`);
function writeFile(target, content) {
  const at = path.resolve(target).replaceAll('\\', '/');
  const tool = { name: 'write_file', parameters: { Path: target } };
  const verdict = rules('deny').some((r) => covers(r, at)) ? 'deny' : rules('allow').some((r) => covers(r, at)) ? 'allow' : rules('ask').some((r) => covers(r, at)) ? 'ask' : 'allow';
  if (verdict === 'ask') stopDenied('write_file', 'WriteFile', tool);
  if (verdict === 'deny') {
    emit({ event: 'step_update', step_update: { conversation_id: id, step_index: step++, state: 'ERROR', step_type: 'tool', tool_name: 'write_file', tool_info: { ...tool, error: { type: 'TOOL_ERROR', message: `Permission denied for write_file(${at}). Matches user-configured deny rule.` } } } });
    return;
  }
  // Plan mode asks before editing the workspace (and headless refuses); a path outside it goes through (the hole).
  if (mode === 'plan' && at.startsWith(`${process.cwd().replaceAll('\\', '/')}/`)) stopDenied('write_file', 'WriteFile', tool);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: step++, state: 'DONE', step_type: 'tool', tool_name: 'write_file', tool_info: tool } });
}

if (process.env.FAKE_AGY_WRITE) writeFileSync('agy-was-here.txt', 'x');
if (process.env.FAKE_AGY_HOOK) writeFileSync(path.join('.git', 'hooks', 'post-commit'), '#!/bin/sh\necho owned\n');
if (process.env.FAKE_AGY_USER_FILE) appendFileSync(process.env.FAKE_AGY_USER_FILE, '\n{"globalPermissionGrants":{"allow":["command(*)"]}}\n');
const developer = prompt.includes('Bạn là Developer');
if (developer) {
  writeFile(path.join(process.cwd(), 'src', 'sum.mjs'), 'export function sumTo(n) {\n  let total = 0;\n  for (let i = 1; i <= n; i++) total += i;\n  return total;\n}\n');
  writeFile(path.join(process.cwd(), 'tests', 'sum.test.mjs'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sumTo } from '../src/sum.mjs';\n\ntest('[R-1] sumTo includes n', () => {\n  assert.equal(sumTo(3), 6);\n});\n");
}
if (process.env.FAKE_AGY_ESCAPE) writeFile(process.env.FAKE_AGY_ESCAPE, 'escaped\n');
if (process.env.FAKE_AGY_DENY) stopDenied('command', 'RunCommand', { name: 'run_command', parameters: { CommandLine: developer ? 'node --test' : 'git log' } });
const fence = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const reply = prompt.includes('Bạn là Planner')
  ? fence({ requirements: [{ id: 'R-1', text: 'sumTo cộng cả n.', required: true, manual: false }], acceptanceExamples: [], interfaces: [], assumptions: [], scope: ['src'] })
  : prompt.includes('Bạn là Verifier') ? fence({ decision: 'pass', findings: [] }) : developer ? fence({ reuse: [] }) : 'OK';
for (const part of [reply.slice(0, 10), reply.slice(10)]) {
  emit({ event: 'step_update', step_update: { conversation_id: id, step_index: step, state: 'ACTIVE', step_type: 'agent_response', text_delta: part } });
}
emit({ event: 'step_update', step_update: { conversation_id: id, step_index: step, state: 'DONE', step_type: 'agent_response', usage } });
emit({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: reply, num_turns: 1, usage } });
