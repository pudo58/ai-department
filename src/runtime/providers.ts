import type { RuntimeEvent, RuntimeUsage } from './types.js';

export type CliProvider = 'codex' | 'claude' | 'antigravity';
export interface UsageCheckpoint { inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number | null }
const zero = (): RuntimeUsage => ({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: null });
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};

export interface CollectorOptions {
  provider: CliProvider;
  previousCumulativeUsage?: UsageCheckpoint;
  onEvent?: (event: RuntimeEvent) => void;
}

/** Parses complete JSONL records only; malformed or truncated streams never become success. */
export class JsonlCollector {
  private buffer = '';
  private seenIds = new Set<string>();
  private messages = new Map<string, string>();
  private codexTurn = 0;
  private completedTurns = new Set<number>();
  private closed = false;
  output = '';
  sessionId: string | undefined;
  /** The model the provider reports (Claude's init event). */
  model: string | undefined;
  usage = zero();
  cumulativeUsage: UsageCheckpoint | undefined;
  completed = false;
  failure: string | undefined;
  /** Antigravity: the turn ended without an answer because headless mode refused these tools (`command`, `write_file`…). */
  denied: { action: string; name: string }[] = [];
  invalidLines: string[] = [];

  constructor(private readonly options: CollectorOptions) {}

  push(chunk: string): void {
    if (this.closed) throw new Error('Stream is already finalized');
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) { this.failure = 'JSONL record exceeds size limit'; this.buffer = ''; return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
    }
  }

  finish(): void {
    if (this.closed) return;
    if (this.buffer.trim()) this.line(this.buffer);
    this.buffer = ''; this.closed = true;
    if (this.invalidLines.length) this.failure ??= 'Provider emitted invalid JSONL';
    if (!this.completed && !this.failure) this.failure = 'Provider stream ended without a completion event';
  }

  private line(line: string): void {
    if (!line.trim()) return;
    // The host persists this event before parsing; callers must redact before writing a public log.
    this.options.onEvent?.({ type: 'provider.raw', message: line });
    let event: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); event = record(parsed); }
    catch { this.invalidLines.push(line.slice(0, 1000)); return; }
    const id = typeof event.uuid === 'string' ? event.uuid : typeof event.event_id === 'string' ? event.event_id : undefined;
    if (id) { if (this.seenIds.has(id)) return; this.seenIds.add(id); }
    if (this.options.provider === 'codex') this.codex(event); else if (this.options.provider === 'antigravity') this.antigravity(event); else this.claude(event);
  }

  /**
   * agy `--output-format stream-json`: `init` (conversation id, model), `step_update` (tool steps, `text_delta` chunks of
   * the answer, per-step usage) and one terminal `result` with the whole answer and the run's total usage. No cost is
   * reported. A turn that hits a tool headless mode cannot approve ends with an empty answer and `denied_actions`.
   */
  private antigravity(event: Record<string, unknown>): void {
    const kind = String(event.event ?? 'unknown');
    if (kind === 'init') {
      if (typeof event.conversation_id === 'string') this.sessionId = event.conversation_id;
      const init = record(event.init);
      if (typeof init.model === 'string') this.model = init.model;
    }
    if (kind === 'step_update') {
      const step = record(event.step_update);
      if (typeof step.text_delta === 'string') {
        const key = `step-${String(step.step_index ?? 0)}`;
        this.messages.set(key, (this.messages.get(key) ?? '') + step.text_delta);
        this.output = [...this.messages.values()].join('\n');
      } else if (step.step_type === 'tool' && step.state !== 'ACTIVE') this.options.onEvent?.({ type: 'provider.item', message: String(step.tool_name ?? 'tool'), data: step });
    }
    if (kind === 'result') {
      const result = record(event.result);
      const usage = record(result.usage);
      // Thinking tokens are billed as output, as Codex counts its reasoning.
      this.usage = { inputTokens: number(usage.input_tokens), cachedTokens: number(usage.cache_read_tokens), outputTokens: number(usage.output_tokens) + number(usage.thinking_tokens), costUsd: null };
      if (typeof result.response === 'string' && result.response.trim()) this.output = result.response;
      this.completed = true;
      const denied = Array.isArray(result.denied_actions) ? result.denied_actions.map(record).map((d) => ({ action: String(d.action ?? '?'), name: String(d.display_name ?? d.action ?? '?') })) : [];
      if (result.status !== 'SUCCESS') this.failure = String(result.error || `Antigravity báo trạng thái ${String(result.status ?? 'không rõ')}`);
      else if (!this.output.trim()) {
        this.denied = denied;
        this.failure = denied.length
          ? `Antigravity định dùng công cụ bị chặn ở chế độ chỉ đọc (${[...new Set(denied.map((d) => d.name))].join(', ')}) và dừng mà không trả lời.`
          : 'Antigravity kết thúc mà không trả lời.';
      }
    }
  }

  private codex(event: Record<string, unknown>): void {
    const type = String(event.type ?? 'unknown');
    if (type === 'thread.started') this.sessionId = String(event.thread_id ?? '');
    if (type === 'turn.started') this.codexTurn++;
    if (type === 'item.completed') {
      const item = record(event.item);
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        this.messages.set(String(item.id ?? `message-${this.messages.size}`), item.text);
        this.output = [...this.messages.values()].join('\n');
      }
      this.options.onEvent?.({ type: 'provider.item', message: String(item.type ?? 'item'), data: item });
    }
    if (type === 'turn.completed') {
      if (!this.completedTurns.has(this.codexTurn)) {
        const usage = record(event.usage);
        this.usage.inputTokens += number(usage.input_tokens);
        this.usage.cachedTokens += number(usage.cached_input_tokens);
        this.usage.outputTokens += number(usage.output_tokens);
        this.completedTurns.add(this.codexTurn);
      }
      this.completed = true;
    }
    if (type === 'turn.failed' || type === 'error') this.failure = String(record(event.error).message ?? event.message ?? 'Codex execution failed');
  }

  private claude(event: Record<string, unknown>): void {
    if (typeof event.session_id === 'string') this.sessionId = event.session_id;
    if (event.type === 'system' && typeof event.model === 'string') this.model = event.model;
    const type = String(event.type ?? 'unknown');
    if (type === 'assistant') {
      const message = record(event.message);
      const content = Array.isArray(message.content) ? message.content.map(record) : [];
      const value = content.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('\n');
      if (value) { this.messages.set(String(message.id ?? `message-${this.messages.size}`), value); this.output = [...this.messages.values()].join('\n'); }
      this.options.onEvent?.({ type: 'provider.item', message: 'assistant', data: message });
    }
    if (type === 'result') {
      if (typeof event.result === 'string') this.output = event.result;
      const raw = record(event.usage);
      // Claude result usage is cumulative for a resumed conversation. Message-level usage is ignored.
      const cumulative: UsageCheckpoint = {
        inputTokens: number(raw.input_tokens) + number(raw.cache_read_input_tokens) + number(raw.cache_creation_input_tokens),
        cachedTokens: number(raw.cache_read_input_tokens), outputTokens: number(raw.output_tokens),
        costUsd: typeof event.total_cost_usd === 'number' ? number(event.total_cost_usd) : null,
      };
      const prior = this.options.previousCumulativeUsage ?? zero();
      if (cumulative.inputTokens < prior.inputTokens || cumulative.outputTokens < prior.outputTokens || cumulative.cachedTokens < prior.cachedTokens) {
        this.failure = 'Cumulative usage decreased; refusing to silently double-count a resumed session';
      }
      this.usage = {
        inputTokens: Math.max(0, cumulative.inputTokens - prior.inputTokens),
        cachedTokens: Math.max(0, cumulative.cachedTokens - prior.cachedTokens),
        outputTokens: Math.max(0, cumulative.outputTokens - prior.outputTokens),
        costUsd: cumulative.costUsd === null ? null : Math.max(0, cumulative.costUsd - (prior.costUsd ?? 0)),
      };
      this.cumulativeUsage = cumulative;
      this.completed = true;
      if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')) {
        this.failure = Array.isArray(event.errors) ? event.errors.join('; ') : String(event.result ?? event.subtype ?? 'Claude execution failed');
      }
    }
    if (type === 'error') this.failure = String(record(event.error).message ?? event.message ?? 'Claude execution failed');
  }
}

/** Tools Claude may use without asking when it runs locally: file work plus the commands a coding task needs. */
export const LOCAL_CLAUDE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm *)', 'Bash(npx *)', 'Bash(node *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)'];

/** Prepended to an Antigravity prompt for Planner, Verifier, Investigator; the per-turn permission rules (agyhome.ts) enforce it. */
export const AGY_READ_ONLY_PREAMBLE = 'Chế độ chỉ đọc: bạn chỉ được đọc, liệt kê và tìm trong file của workspace. Không chạy lệnh shell, không sửa hay tạo file, không lập kế hoạch thay đổi và không chờ duyệt. Trả lời trực tiếp và đầy đủ trong tin nhắn cuối.';
/**
 * Prepended for Developer and Author (experimental). agy cannot run commands here (headless mode refuses them and the turn
 * stops), so it is told up front that AI Department runs the checks itself. write_file takes absolute paths only.
 */
export const agyWritePreamble = (workdir: string): string => `Chế độ sửa file (thử nghiệm): bạn chỉ được đọc, tạo và sửa file bên trong workspace ${workdir}, luôn bằng đường dẫn tuyệt đối trong thư mục đó. Không ghi gì ra ngoài workspace hay vào thư mục .git. Không chạy bất kỳ lệnh shell nào, kể cả test, build, cài đặt hay git: mọi lệnh đều bị từ chối và lượt của bạn sẽ dừng ngay; AI Department tự chạy các bước kiểm tra sau lượt của bạn. Không lập kế hoạch chờ duyệt. Khi xong, tóm tắt thay đổi trong tin nhắn cuối.`;
/** One `--input-format stream-json` message: the prompt goes through stdin, so its length is not capped by the command line. */
export const agyInput = (prompt: string, preamble = AGY_READ_ONLY_PREAMBLE): string => `${JSON.stringify({ event: 'user', message: { role: 'user', content: `${preamble}\n\n${prompt}` } })}\n`;

export interface CliCommandOptions { provider: CliProvider; model: string; effort?: string; sessionId?: string; singleAgent: boolean; readOnly?: boolean; workdir?: string;
  /** Antigravity as Developer or Author: accept-edits instead of plan mode (its permission rules still keep writes in the copy). */
  write?: boolean;
  /** Claude on this machine: use the person's own login (subscription) instead of --bare's API-key-only mode. */
  local?: boolean;
  /** Extra `-c key=value` Codex overrides, e.g. the Windows sandbox mode that `--ignore-user-config` would otherwise drop. */
  extraConfig?: string[];
  /** Claude: plugin folders for this session only, holding the role's approved skills. */
  pluginDirs?: string[];
  /** Claude: at least one loaded skill ships scripts, so the interpreters they need are allowed too. */
  skillScripts?: boolean }

/** Interpreters an approved skill's scripts may need; allowed only when such a skill is loaded. */
export const SKILL_SCRIPT_TOOLS = ['Bash(python *)', 'Bash(python3 *)', 'Bash(bash *)', 'Bash(sh *)'];
export function buildCliCommand(options: CliCommandOptions): string[] {
  if (options.provider === 'antigravity') {
    // What agy may write is decided by the permission rules in its private per-turn home (agyhome.ts), not by these flags:
    // plan mode does not stop write_file to an absolute path outside the workspace. Without --dangerously-skip-permissions
    // headless mode refuses every shell command. agy warns that --mode plan "has no effect" next to
    // --disable-slash-commands, yet its log shows plan mode applied. Never resumed: each call is fresh.
    // Model ids such as gemini-3.8-flash-high carry their thinking level, so --effort is only sent without a model.
    const args = ['agy', '--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', options.write ? 'accept-edits' : 'plan', '--disable-slash-commands', `--add-dir=${options.workdir ?? '.'}`];
    if (options.model) args.push('--model', options.model);
    else if (options.effort && /^[a-z]+$/.test(options.effort)) args.push('--effort', options.effort);
    // The prompt arrives on stdin; `--print=` (empty) switches on print mode and must come last.
    args.push('--print=');
    return args;
  }
  if (options.provider === 'codex') {
    const common = ['--json', '-c', 'approval_policy="never"', '-c', options.readOnly ? 'sandbox_mode="read-only"' : 'sandbox_mode="workspace-write"'];
    if (options.singleAgent) common.push('-c', 'features.multi_agent=false');
    for (const override of options.extraConfig ?? []) common.push('-c', override);
    if (options.effort && /^[a-z]+$/.test(options.effort)) common.push('-c', `model_reasoning_effort="${options.effort}"`);
    if (options.model) common.push('--model', options.model);
    return options.sessionId
      ? ['codex', 'exec', 'resume', ...common, options.sessionId, '-']
      : ['codex', 'exec', '--ignore-user-config', '-C', options.workdir ?? '/workspace', ...common, '-'];
  }
  if (options.local) {
    // No --bare: it accepts only ANTHROPIC_API_KEY, so a Claude Pro/Max login would be ignored. Isolation comes from
    // loading project settings only (no personal hooks or plugins) and no MCP servers. Edits are allowed inside the
    // working copy; shell access is limited to the tools a coding task needs, anything else is refused (headless).
    const skills = options.pluginDirs?.length ? ['Skill', ...(options.skillScripts ? SKILL_SCRIPT_TOOLS : [])] : [];
    const args = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project,local', '--strict-mcp-config',
      '--permission-mode', options.readOnly ? 'dontAsk' : 'acceptEdits', '--allowedTools', ...(options.readOnly ? ['Read', 'Glob', 'Grep'] : [...LOCAL_CLAUDE_TOOLS, ...skills])];
    for (const dir of options.pluginDirs ?? []) args.push('--plugin-dir', dir);
    if (options.model) args.push('--model', options.model);
    if (options.sessionId) args.push('--resume', options.sessionId);
    if (options.readOnly) args.push('--disallowedTools', 'Write,Edit,NotebookEdit,Bash,Agent,Task');
    else if (options.singleAgent) args.push('--disallowedTools', 'Agent,Task');
    return args;
  }
  const args = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--bare'];
  if (options.model) args.push('--model', options.model);
  if (options.sessionId) args.push('--resume', options.sessionId);
  if (options.readOnly) args.push('--disallowedTools', 'Write,Edit,NotebookEdit,Bash,Agent,Task');
  else if (options.singleAgent) args.push('--disallowedTools', 'Agent,Task');
  return args;
}
