import { describe, expect, it } from 'vitest';
import { buildCliCommand, JsonlCollector } from '../src/runtime/providers.js';
import { executeFile, redactSecrets } from '../src/runtime/process.js';

const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

describe('JsonlCollector · codex', () => {
  it('collects output, session and usage from a complete stream', () => {
    const c = new JsonlCollector({ provider: 'codex' });
    c.push(lines({ type: 'thread.started', thread_id: 't1' }, { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'xong' } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } }));
    c.finish();
    expect(c).toMatchObject({ output: 'xong', sessionId: 't1', completed: true, failure: undefined });
    expect(c.usage).toMatchObject({ inputTokens: 100, cachedTokens: 40, outputTokens: 10 });
  });
  it('treats a stream that ends without completion as a failure', () => {
    const c = new JsonlCollector({ provider: 'codex' });
    c.push(lines({ type: 'thread.started', thread_id: 't1' }));
    c.finish();
    expect(c.failure).toMatch(/without a completion/);
  });
  it('handles records split across chunks and dedupes repeated event ids', () => {
    const c = new JsonlCollector({ provider: 'codex' });
    const done = JSON.stringify({ type: 'turn.completed', event_id: 'e1', usage: { input_tokens: 5, output_tokens: 1 } });
    c.push('{"type":"turn.started"}\n' + done.slice(0, 10));
    c.push(done.slice(10) + '\n' + done + '\n');
    c.finish();
    expect(c.usage.inputTokens).toBe(5);
  });
  it('malformed JSON can never become success', () => {
    const c = new JsonlCollector({ provider: 'codex' });
    c.push('not json\n' + lines({ type: 'turn.completed', usage: {} }));
    c.finish();
    expect(c.failure).toMatch(/invalid JSONL/);
  });
  it('surfaces provider errors', () => {
    const c = new JsonlCollector({ provider: 'codex' });
    c.push(lines({ type: 'turn.failed', error: { message: 'quota exceeded' } }));
    c.finish();
    expect(c.failure).toBe('quota exceeded');
  });
});

describe('JsonlCollector · claude', () => {
  const result = (usage: object, cost: number) => ({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: cost, usage, session_id: 's1' });
  it('reports usage as a delta over the previous cumulative checkpoint', () => {
    const c = new JsonlCollector({ provider: 'claude', previousCumulativeUsage: { inputTokens: 100, cachedTokens: 0, outputTokens: 20, costUsd: 0.5 } });
    c.push(lines(result({ input_tokens: 150, output_tokens: 50 }, 0.8)));
    c.finish();
    expect(c.usage).toMatchObject({ inputTokens: 50, outputTokens: 30 });
    expect(c.usage.costUsd).toBeCloseTo(0.3);
    expect(c.cumulativeUsage).toMatchObject({ inputTokens: 150 });
  });
  it('refuses to double count when cumulative usage goes backwards', () => {
    const c = new JsonlCollector({ provider: 'claude', previousCumulativeUsage: { inputTokens: 500, cachedTokens: 0, outputTokens: 0, costUsd: null } });
    c.push(lines(result({ input_tokens: 100, output_tokens: 1 }, 0.1)));
    c.finish();
    expect(c.failure).toMatch(/decreased/);
  });
  it('error results fail the stream', () => {
    const c = new JsonlCollector({ provider: 'claude' });
    c.push(lines({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'], usage: {} }));
    c.finish();
    expect(c.failure).toBe('too many turns');
  });
});

describe('CLI commands', () => {
  it('forces single-agent mode on both adapters when asked', () => {
    expect(buildCliCommand({ provider: 'codex', model: 'm', singleAgent: true })).toContain('features.multi_agent=false');
    const claude = buildCliCommand({ provider: 'claude', model: 'm', singleAgent: true });
    expect(claude.slice(claude.indexOf('--disallowedTools'))[1]).toBe('Agent,Task');
    expect(buildCliCommand({ provider: 'codex', model: 'm', singleAgent: false })).not.toContain('features.multi_agent=false');
  });
  it('never grants unattended codex more than workspace-write', () => {
    const cmd = buildCliCommand({ provider: 'codex', model: '', singleAgent: false }).join(' ');
    expect(cmd).toContain('sandbox_mode="workspace-write"');
    expect(cmd).not.toMatch(/danger|bypass/);
  });
  it('passes extra Codex overrides through as -c pairs', () => {
    const cmd = buildCliCommand({ provider: 'codex', model: '', singleAgent: false, extraConfig: ['windows.sandbox="elevated"'] });
    expect(cmd[cmd.indexOf('windows.sandbox="elevated"') - 1]).toBe('-c');
  });
  it('rejects effort values that could inject config', () => {
    expect(buildCliCommand({ provider: 'codex', model: '', effort: 'high"; evil="1', singleAgent: false }).join(' ')).not.toContain('evil');
  });
});

describe('process helpers', () => {
  it('redacts keys, bearer tokens and assignments', () => {
    const out = redactSecrets('key sk-ant-abcdefghijklmnopqrstuv Bearer abcdefghijklmnopqrstuvwxyz password=hunter2');
    expect(out).not.toMatch(/sk-ant|abcdefghijklmnop|hunter2/);
  });
  it('runs a fixed argv without a shell', async () => {
    const result = await executeFile(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(echo injected); echo x']);
    expect(result.stdout).toBe('$(echo injected); echo x');
  });
  it('reports timeouts and rejects NUL bytes', async () => {
    const result = await executeFile(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    await expect(executeFile(process.execPath, ['a\0b'])).rejects.toThrow(/NUL/);
  });
  it('abort rejects instead of returning a partial result', async () => {
    const controller = new AbortController();
    const pending = executeFile(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow(/interrupted/);
  });
});
