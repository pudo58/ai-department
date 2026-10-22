export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Described { level: LogLevel; text: string }

const squash = (value: unknown, max: number): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

/**
 * Turns one raw provider JSONL record into a readable console line, or null for noise.
 * The raw record is always stored separately; this is only for people watching.
 */
export function describeProviderLine(line: string): Described | null {
  let event: Record<string, unknown>;
  try { event = rec(JSON.parse(line)); } catch { return { level: 'debug', text: squash(line, 300) }; }
  const type = String(event.type ?? '');
  // Antigravity (agy stream-json) uses `event` instead of `type`; text deltas are too small to show one by one.
  const agy = String(event.event ?? '');
  if (agy === 'init') return { level: 'info', text: `Phiên Antigravity bắt đầu (${squash(rec(event.init).model, 60)}, ${squash(event.conversation_id, 40)})` };
  if (agy === 'step_update') {
    const step = rec(event.step_update);
    if (step.step_type !== 'tool' || step.state === 'ACTIVE') return null;
    const params = rec(rec(step.tool_info).parameters);
    const target = params.Path ?? params.CommandLine ?? params.SearchPath ?? params.DirectoryPath ?? '';
    return { level: step.state === 'DONE' ? 'info' : 'warn', text: `Tool: ${squash(step.tool_name, 60)} ${squash(target, 200)}${step.state === 'DONE' ? '' : ` → ${squash(step.state, 20)}`}` };
  }
  if (agy === 'result') {
    const r = rec(event.result), u = rec(r.usage);
    const denied = Array.isArray(r.denied_actions) && r.denied_actions.length ? ` · bị chặn: ${r.denied_actions.map((d) => squash(rec(d).display_name, 40)).join(', ')}` : '';
    return { level: r.status === 'SUCCESS' ? 'info' : 'error', text: `Kết quả (${squash(r.status, 20)}): ${Number(u.input_tokens ?? 0)} token vào (${Number(u.cache_read_tokens ?? 0)} cache), ${Number(u.output_tokens ?? 0) + Number(u.thinking_tokens ?? 0)} token ra${denied}${r.error ? ` · ${squash(r.error, 300)}` : ''}` };
  }
  if (type === 'thread.started') return { level: 'info', text: `Phiên agent bắt đầu (${squash(event.thread_id, 40)})` };
  if (type === 'turn.completed') {
    const u = rec(event.usage);
    return { level: 'info', text: `Lượt hoàn tất: ${Number(u.input_tokens ?? 0)} token vào (${Number(u.cached_input_tokens ?? 0)} cache), ${Number(u.output_tokens ?? 0)} token ra` };
  }
  if (type === 'turn.failed' || type === 'error') return { level: 'error', text: squash(rec(event.error).message ?? event.message ?? 'Lỗi không rõ', 400) };
  if (type === 'result') return { level: event.is_error === true ? 'error' : 'info', text: `Kết quả: ${squash(event.result ?? event.subtype, 300)}` };
  if (type === 'assistant') {
    const content = rec(event.message).content;
    const blocks = Array.isArray(content) ? content.map(rec) : [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join(' ');
    const tools = blocks.filter((b) => b.type === 'tool_use').map((b) => `${String(b.name)} ${squash(JSON.stringify(b.input), 160)}`);
    const parts = [text && `Agent: ${squash(text, 500)}`, ...tools.map((t) => `Tool: ${t}`)].filter(Boolean) as string[];
    return parts.length ? { level: 'info', text: parts.join(' | ') } : null;
  }
  if (type === 'item.completed' || type === 'item.started') {
    const item = rec(event.item);
    const kind = String(item.type ?? '');
    if (kind === 'agent_message' && type === 'item.completed') return { level: 'info', text: `Agent: ${squash(item.text, 600)}` };
    if (kind === 'reasoning' && type === 'item.completed') return { level: 'debug', text: `Suy luận: ${squash(item.text, 300)}` };
    if (kind === 'command_execution') {
      const cmd = squash(item.command, 260);
      if (type === 'item.started') return { level: 'debug', text: `$ ${cmd}` };
      const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
      const out = squash(item.aggregated_output, 240);
      return { level: failed ? 'warn' : 'info', text: `$ ${cmd} → ${String(item.status ?? 'done')}${typeof item.exit_code === 'number' ? ` (exit ${item.exit_code})` : ''}${out ? ` | ${out}` : ''}` };
    }
    if (kind === 'file_change' && type === 'item.completed') {
      const changes = Array.isArray(item.changes) ? item.changes.map(rec).map((c) => `${String(c.kind ?? 'sửa')} ${String(c.path ?? '')}`) : [];
      return { level: 'info', text: `Sửa file: ${changes.join(', ') || squash(JSON.stringify(item), 200)}` };
    }
    if (kind === 'mcp_tool_call' && type === 'item.completed') return { level: 'info', text: `Tool MCP: ${squash(item.server, 40)}/${squash(item.tool, 60)} → ${String(item.status ?? '')}` };
    if (kind === 'error') return { level: 'error', text: squash(item.message, 400) };
  }
  return null;
}
