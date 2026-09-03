import { randomUUID } from 'node:crypto';

/**
 * Builds Claude Agent SDK-shaped messages for foreign agents so the web reducer, tool cards, health
 * signals and transcripts work unchanged. One synthesizer per session.
 */
export class MessageSynth {
  private turnMsgId: string | null = null;
  private blockIndex = 0;
  private openBlock: { index: number; type: 'text' | 'thinking' } | null = null;
  private turnText = '';
  private turnThinking = '';
  private turnStart = 0;
  private toolsInTurn = 0;
  private started = false;
  constructor(public sessionId: string, private model: string) {}

  setModel(m: string) { this.model = m; }

  init(extra: Record<string, unknown> = {}) {
    return { type: 'system', subtype: 'init', session_id: this.sessionId, uuid: randomUUID(), cwd: extra.cwd, model: this.model, tools: [], mcp_servers: [], slash_commands: [], skills: [], agents: [], permissionMode: extra.permissionMode ?? 'default', apiKeySource: 'none', claude_code_version: extra.version ?? '', output_style: 'default', ...extra };
  }

  /** Echo of the user's prompt (the SDK does not echo; the web client pushes locally — we still persist one for transcripts). */
  user(text: string, uuid: string = randomUUID(), images?: { mediaType: string; data: string }[]) {
    const content: any[] = [{ type: 'text', text }];
    for (const im of images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } });
    return { type: 'user', uuid, session_id: this.sessionId, message: { role: 'user', content }, parent_tool_use_id: null, timestamp: new Date().toISOString() };
  }

  beginTurn() {
    this.turnMsgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    this.blockIndex = 0;
    this.openBlock = null;
    this.turnText = '';
    this.turnThinking = '';
    this.toolsInTurn = 0;
    this.turnStart = Date.now();
    this.started = false;
  }

  private stream(event: any) {
    return { type: 'stream_event', event, session_id: this.sessionId, uuid: randomUUID(), parent_tool_use_id: null };
  }

  /** Streaming text / thinking delta → the sequence of stream_events that produce it. */
  delta(kind: 'text' | 'thinking', chunk: string): any[] {
    const out: any[] = [];
    if (!this.turnMsgId) this.beginTurn();
    if (!this.started) { this.started = true; out.push(this.stream({ type: 'message_start', message: { id: this.turnMsgId, model: this.model, role: 'assistant', content: [] } })); }
    if (this.openBlock && this.openBlock.type !== kind) { out.push(this.stream({ type: 'content_block_stop', index: this.openBlock.index })); this.openBlock = null; }
    if (!this.openBlock) {
      this.openBlock = { index: this.blockIndex++, type: kind };
      out.push(this.stream({ type: 'content_block_start', index: this.openBlock.index, content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } }));
    }
    out.push(this.stream({ type: 'content_block_delta', index: this.openBlock.index, delta: kind === 'text' ? { type: 'text_delta', text: chunk } : { type: 'thinking_delta', thinking: chunk } }));
    if (kind === 'text') this.turnText += chunk; else this.turnThinking += chunk;
    return out;
  }

  private closeOpenBlock(out: any[]) {
    if (this.openBlock) { out.push(this.stream({ type: 'content_block_stop', index: this.openBlock.index })); this.openBlock = null; }
  }

  /** A tool call begins: assistant message carrying the tool_use block (final form, no streaming). */
  toolUse(id: string, name: string, input: Record<string, unknown>): any[] {
    if (!this.turnMsgId) this.beginTurn();
    const out: any[] = [];
    this.closeOpenBlock(out);
    this.toolsInTurn++;
    out.push({ type: 'assistant', uuid: randomUUID(), session_id: this.sessionId, parent_tool_use_id: null, message: { id: this.turnMsgId, role: 'assistant', model: this.model, content: [{ type: 'tool_use', id, name, input }] } });
    return out;
  }

  /** Tool finished: user message with tool_result (+ optional structured output for the cards). */
  toolResult(toolUseId: string, content: string, isError = false, structured?: unknown, images?: string[]): any {
    const parts: any[] = [{ type: 'text', text: content }];
    for (const src of images ?? []) { const m = /^data:([^;]+);base64,(.+)$/.exec(src); if (m) parts.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }); }
    return { type: 'user', uuid: randomUUID(), session_id: this.sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: parts, is_error: isError }] }, ...(structured !== undefined ? { tool_use_result: structured } : {}) };
  }

  /** Assistant text that arrived whole (non-streaming) — emitted as deltas + final so both paths look the same. */
  text(t: string): any[] { return this.delta('text', t); }

  /** End of turn: close the streamed message, then the result. */
  endTurn(o: { ok?: boolean; error?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; costUsd?: number; stopReason?: string } = {}): any[] {
    const out: any[] = [];
    if (this.turnMsgId && this.started) {
      this.closeOpenBlock(out);
      out.push(this.stream({ type: 'message_delta', delta: { stop_reason: o.stopReason ?? 'end_turn' }, usage: { output_tokens: o.usage?.output ?? 0 } }));
      out.push(this.stream({ type: 'message_stop' }));
      const content: any[] = [];
      if (this.turnThinking) content.push({ type: 'thinking', thinking: this.turnThinking });
      if (this.turnText) content.push({ type: 'text', text: this.turnText });
      if (content.length) out.push({ type: 'assistant', uuid: randomUUID(), session_id: this.sessionId, parent_tool_use_id: null, message: { id: this.turnMsgId, role: 'assistant', model: this.model, content, usage: o.usage ? { input_tokens: o.usage.input ?? 0, output_tokens: o.usage.output ?? 0, cache_read_input_tokens: o.usage.cacheRead ?? 0, cache_creation_input_tokens: o.usage.cacheWrite ?? 0 } : undefined } });
    }
    const ok = o.ok !== false;
    out.push({
      type: 'result',
      subtype: ok ? 'success' : 'error_during_execution',
      uuid: randomUUID(),
      session_id: this.sessionId,
      is_error: !ok,
      result: ok ? this.turnText : o.error ?? '',
      duration_ms: Date.now() - this.turnStart,
      duration_api_ms: Date.now() - this.turnStart,
      num_turns: 1 + this.toolsInTurn,
      total_cost_usd: o.costUsd ?? 0,
      usage: { input_tokens: o.usage?.input ?? 0, output_tokens: o.usage?.output ?? 0, cache_read_input_tokens: o.usage?.cacheRead ?? 0, cache_creation_input_tokens: o.usage?.cacheWrite ?? 0 },
      modelUsage: this.model ? { [this.model]: { inputTokens: o.usage?.input ?? 0, outputTokens: o.usage?.output ?? 0, costUSD: o.costUsd ?? 0 } } : {},
      terminal_reason: ok ? 'completed' : 'api_error',
      permission_denials: [],
    });
    this.turnMsgId = null;
    return out;
  }

  systemNote(text: string, level: 'info' | 'warning' | 'error' = 'info') {
    return { type: 'system', subtype: 'status', session_id: this.sessionId, uuid: randomUUID(), status: null, note: text, level };
  }
}

/** ACP / codex tool kinds → the closest Claude tool name so the registry picks a fitting card. */
export function mapToolName(kind: string | undefined, title: string | undefined, raw?: any): string {
  const t = `${kind ?? ''} ${title ?? ''}`.toLowerCase();
  if (kind === 'read' || /\bread\b/.test(t)) return 'Read';
  if (kind === 'edit' || /\b(edit|write|patch|apply_patch|create file)\b/.test(t)) return raw?.content?.some?.((c: any) => c.type === 'diff') ? 'Edit' : /write|create/.test(t) ? 'Write' : 'Edit';
  if (kind === 'delete') return 'Bash';
  if (kind === 'move') return 'Bash';
  if (kind === 'search' || /\b(grep|search|glob|find)\b/.test(t)) return /glob|find file/.test(t) ? 'Glob' : 'Grep';
  if (kind === 'execute' || /\b(bash|shell|command|exec|run)\b/.test(t)) return 'Bash';
  if (kind === 'fetch' || /\b(fetch|http|web)\b/.test(t)) return 'WebFetch';
  if (kind === 'think') return 'Thinking';
  return title?.replace(/\s+/g, '_') || 'Tool';
}
