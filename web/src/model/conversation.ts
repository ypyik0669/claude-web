// Pure reducer: SDK messages (live or from transcript) -> renderable conversation tree.
// Kept framework-free so it can be unit tested against captured message streams.

export interface TextBlock { type: 'text'; text: string }
export interface ThinkingBlock { type: 'thinking'; thinking: string }
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputJson?: string; // partial json while streaming
  result?: { content: string; isError: boolean; raw?: unknown; structured?: unknown; ts?: string };
  children: Item[]; // subagent messages (parent_tool_use_id === id)
  progress?: { elapsed: number; summary?: string; lastTool?: string };
  status: 'streaming' | 'pending' | 'running' | 'done' | 'error';
}
export type Block = TextBlock | ThinkingBlock | ToolUseBlock;

export interface UserItem { kind: 'user'; id: string; ts?: string; text: string; images: string[]; meta?: boolean; raw?: unknown }
export interface AssistantItem {
  kind: 'assistant';
  id: string; // API message id when known, else uuid
  ts?: string;
  model?: string;
  blocks: Block[];
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  streaming: boolean;
  parentToolUseId: string | null;
  error?: string;
}
export interface SystemItem { kind: 'system'; id: string; ts?: string; subtype: string; text: string; data?: unknown }
export interface ResultItem { kind: 'result'; id: string; ts?: string; subtype: string; durationMs: number; apiMs: number; costUsd: number; numTurns: number; isError: boolean; text?: string; usage?: unknown }
export type Item = UserItem | AssistantItem | SystemItem | ResultItem;

export interface TaskInfo {
  id: string;
  toolUseId?: string;
  description: string;
  type?: string;
  subagentType?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  endedAt?: number;
  summary?: string;
  lastTool?: string;
  usage?: unknown;
  outputFile?: string;
  backgrounded?: boolean;
}

export interface Conversation {
  items: Item[]; // top-level (parent_tool_use_id === null)
  toolIndex: Map<string, ToolUseBlock>; // tool_use id -> block (any depth)
  tasks: Map<string, TaskInfo>;
  streaming: Map<string, AssistantItem>; // parentToolUseId ('' for top) -> item receiving deltas
  lastResult?: ResultItem;
}

export function createConversation(): Conversation {
  return { items: [], toolIndex: new Map(), tasks: new Map(), streaming: new Map() };
}

const key = (p: string | null | undefined) => p ?? '';

function containerFor(c: Conversation, parent: string | null | undefined): Item[] {
  if (!parent) return c.items;
  const t = c.toolIndex.get(parent);
  if (t) return t.children;
  // parent unknown yet (subagent transcript before its tool_use) — attach at top level
  return c.items;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b: any) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).join('');
  return '';
}

function findItem(c: Conversation, parent: string | null | undefined, pred: (i: Item) => boolean): Item | undefined {
  const arr = containerFor(c, parent);
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
  return undefined;
}

/** Mutates `c` in place; caller is responsible for triggering re-render (we bump a version). */
export function applyMessage(c: Conversation, m: any): void {
  switch (m.type) {
    case 'stream_event':
      return applyStream(c, m);
    case 'assistant':
      return applyAssistant(c, m);
    case 'user':
      return applyUser(c, m);
    case 'result':
      return applyResult(c, m);
    case 'system':
      return applySystem(c, m);
    case 'tool_progress': {
      const t = c.toolIndex.get(m.tool_use_id);
      if (t) t.progress = { ...(t.progress ?? {}), elapsed: m.elapsed_time_seconds };
      return;
    }
    default:
      return;
  }
}

function applyStream(c: Conversation, m: any) {
  const ev = m.event;
  const k = key(m.parent_tool_use_id);
  let cur = c.streaming.get(k);
  if (ev.type === 'message_start') {
    cur = { kind: 'assistant', id: ev.message?.id ?? m.uuid, ts: new Date().toISOString(), model: ev.message?.model, blocks: [], streaming: true, parentToolUseId: m.parent_tool_use_id ?? null };
    c.streaming.set(k, cur);
    containerFor(c, m.parent_tool_use_id).push(cur);
    return;
  }
  if (!cur) return;
  if (ev.type === 'content_block_start') {
    const b = ev.content_block;
    if (b.type === 'text') cur.blocks[ev.index] = { type: 'text', text: b.text ?? '' };
    else if (b.type === 'thinking') cur.blocks[ev.index] = { type: 'thinking', thinking: b.thinking ?? '' };
    else if (b.type === 'tool_use') {
      const tb: ToolUseBlock = { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {}, inputJson: '', children: [], status: 'streaming' };
      cur.blocks[ev.index] = tb;
      c.toolIndex.set(b.id, tb);
    }
  } else if (ev.type === 'content_block_delta') {
    const b = cur.blocks[ev.index];
    const d = ev.delta;
    if (!b) return;
    if (d.type === 'text_delta' && b.type === 'text') b.text += d.text;
    else if (d.type === 'thinking_delta' && b.type === 'thinking') b.thinking += d.thinking;
    else if (d.type === 'input_json_delta' && b.type === 'tool_use') {
      b.inputJson = (b.inputJson ?? '') + d.partial_json;
      try {
        b.input = JSON.parse(b.inputJson);
      } catch {
        /* partial */
      }
    }
  } else if (ev.type === 'content_block_stop') {
    const b = cur.blocks[ev.index];
    if (b?.type === 'tool_use') {
      if (b.inputJson) {
        try {
          b.input = JSON.parse(b.inputJson);
        } catch {
          /* keep */
        }
      }
      b.status = 'pending';
    }
  } else if (ev.type === 'message_delta') {
    if (ev.usage) cur.usage = toUsage(ev.usage);
  } else if (ev.type === 'message_stop') {
    cur.streaming = false;
    c.streaming.delete(k);
  }
}

function toUsage(u: any) {
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
}

function applyAssistant(c: Conversation, m: any) {
  const msg = m.message ?? {};
  const parent = m.parent_tool_use_id ?? null;
  const k = key(parent);
  const content: any[] = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
  // Find the item this belongs to: streaming item, or an earlier final item with the same API id.
  let item = c.streaming.get(k);
  if (item && msg.id && item.id !== msg.id) item = undefined;
  if (!item && msg.id) item = findItem(c, parent, (i) => i.kind === 'assistant' && i.id === msg.id) as AssistantItem | undefined;
  if (!item) {
    item = { kind: 'assistant', id: msg.id ?? m.uuid, ts: m.timestamp ?? new Date().toISOString(), model: msg.model, blocks: [], streaming: false, parentToolUseId: parent };
    containerFor(c, parent).push(item);
  }
  item.model = msg.model ?? item.model;
  if (msg.usage) item.usage = toUsage(msg.usage);
  if (m.error) item.error = typeof m.error === 'string' ? m.error : JSON.stringify(m.error);
  // Merge blocks: the CLI emits one assistant message per content block (same message id) — append blocks we do not have.
  for (const b of content) {
    if (b.type === 'tool_use') {
      const existing = c.toolIndex.get(b.id);
      if (existing) {
        existing.input = b.input ?? existing.input;
        existing.inputJson = undefined;
        if (existing.status === 'streaming') existing.status = 'pending';
        if (!item.blocks.includes(existing)) item.blocks.push(existing);
        continue;
      }
      const tb: ToolUseBlock = { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {}, children: [], status: 'pending' };
      c.toolIndex.set(b.id, tb);
      item.blocks.push(tb);
    } else if (b.type === 'text') {
      const last = item.blocks[item.blocks.length - 1];
      // a streamed text block will already exist with identical text
      if (last?.type === 'text' && (last.text === b.text || item.streaming)) last.text = b.text;
      else if (!item.blocks.some((x) => x.type === 'text' && x.text === b.text)) item.blocks.push({ type: 'text', text: b.text });
    } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      const t = b.thinking ?? '[redacted thinking]';
      if (!item.blocks.some((x) => x.type === 'thinking' && x.thinking === t)) {
        const last = item.blocks[item.blocks.length - 1];
        if (last?.type === 'thinking' && item.streaming) last.thinking = t;
        else item.blocks.push({ type: 'thinking', thinking: t });
      }
    }
  }
  // compact holes left by streaming index gaps
  item.blocks = item.blocks.filter(Boolean);
  if (!content.some((b) => b.type === 'tool_use') || msg.stop_reason) {
    // keep streaming flag until message_stop arrives; final assistant message w/o stream implies done
    if (!c.streaming.has(k)) item.streaming = false;
  }
}

function applyUser(c: Conversation, m: any) {
  const msg = m.message ?? {};
  const parent = m.parent_tool_use_id ?? null;
  const content: any[] = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
  const results = content.filter((b) => b.type === 'tool_result');
  if (results.length) {
    for (const r of results) {
      const t = c.toolIndex.get(r.tool_use_id);
      if (!t) continue;
      t.result = { content: contentText(r.content), isError: !!r.is_error, raw: r.content, structured: m.tool_use_result, ts: m.timestamp };
      t.status = r.is_error ? 'error' : 'done';
    }
    if (results.length === content.length) return;
  }
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = content.filter((b) => b.type === 'image').map((b) => (b.source?.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : ''));
  if (!text && !images.length) return;
  const isMeta = m.isMeta || m.isSynthetic || /^<(command-name|local-command|system-reminder|task-notification)/.test(text.trim());
  containerFor(c, parent).push({ kind: 'user', id: m.uuid ?? String(Math.random()), ts: m.timestamp, text, images, meta: isMeta, raw: m });
}

function applyResult(c: Conversation, m: any) {
  const r: ResultItem = { kind: 'result', id: m.uuid, ts: new Date().toISOString(), subtype: m.subtype, durationMs: m.duration_ms, apiMs: m.duration_api_ms, costUsd: m.total_cost_usd, numTurns: m.num_turns, isError: m.is_error, text: m.is_error ? (m.result ?? (m.errors ?? []).join('; ')) : undefined, usage: m.usage };
  c.items.push(r);
  c.lastResult = r;
  // any tool still pending at end of turn is finished
  for (const t of c.toolIndex.values()) if (t.status === 'pending' || t.status === 'running' || t.status === 'streaming') t.status = 'done';
  for (const s of c.streaming.values()) s.streaming = false;
  c.streaming.clear();
}

function applySystem(c: Conversation, m: any) {
  switch (m.subtype) {
    case 'init':
      return;
    case 'compact_boundary':
      c.items.push({ kind: 'system', id: m.uuid, subtype: 'compact', text: `上下文已压缩（${m.compact_metadata?.trigger ?? ''} · ${m.compact_metadata?.pre_tokens ?? '?'} tok）`, data: m.compact_metadata });
      return;
    case 'task_started': {
      c.tasks.set(m.task_id, { id: m.task_id, toolUseId: m.tool_use_id, description: m.description, type: m.task_type, subagentType: m.subagent_type, status: 'running', startedAt: Date.now(), backgrounded: m.is_backgrounded });
      const t = m.tool_use_id && c.toolIndex.get(m.tool_use_id);
      if (t) t.status = 'running';
      return;
    }
    case 'task_progress': {
      const t = c.tasks.get(m.task_id);
      if (t) {
        t.summary = m.summary ?? t.summary;
        t.lastTool = m.last_tool_name ?? t.lastTool;
        t.usage = m.usage ?? t.usage;
      }
      const tb = m.tool_use_id && c.toolIndex.get(m.tool_use_id);
      if (tb) tb.progress = { ...(tb.progress ?? { elapsed: 0 }), summary: m.summary, lastTool: m.last_tool_name };
      return;
    }
    case 'task_updated': {
      const t = c.tasks.get(m.task_id);
      if (t && m.patch) Object.assign(t, { description: m.patch.description ?? t.description, backgrounded: m.patch.is_backgrounded ?? t.backgrounded });
      return;
    }
    case 'task_notification': {
      const t: TaskInfo = c.tasks.get(m.task_id) ?? { id: m.task_id, toolUseId: m.tool_use_id, description: m.summary, status: 'completed', startedAt: Date.now() };
      t.status = m.status;
      t.endedAt = Date.now();
      t.summary = m.summary;
      t.outputFile = m.output_file;
      t.usage = m.usage ?? t.usage;
      c.tasks.set(m.task_id, t);
      return;
    }
    case 'background_tasks_changed': {
      for (const bt of m.tasks ?? []) {
        const t = c.tasks.get(bt.task_id ?? bt.id);
        if (t) t.status = bt.status ?? t.status;
        else c.tasks.set(bt.task_id ?? bt.id, { id: bt.task_id ?? bt.id, description: bt.description ?? '', status: bt.status ?? 'running', startedAt: Date.now(), backgrounded: true, type: bt.type });
      }
      return;
    }
    case 'local_command_output':
      c.items.push({ kind: 'system', id: m.uuid, subtype: 'command', text: m.content ?? m.output ?? '' });
      return;
    case 'api_retry':
      c.items.push({ kind: 'system', id: m.uuid, subtype: 'retry', text: `API 重试 ${m.attempt ?? ''}/${m.max_retries ?? ''}: ${m.error ?? ''}` });
      return;
    case 'informational':
    case 'notification':
      c.items.push({ kind: 'system', id: m.uuid, subtype: m.subtype, text: m.message ?? m.content ?? JSON.stringify(m) });
      return;
    case 'permission_denied':
      c.items.push({ kind: 'system', id: m.uuid, subtype: 'denied', text: `权限拒绝: ${m.tool_name ?? ''} ${m.reason ?? ''}` });
      return;
    default:
      return;
  }
}

/** Historical transcript messages have the same shape (type/message/parent_tool_use_id). */
export function applyTranscript(c: Conversation, msgs: any[]) {
  for (const m of msgs) applyMessage(c, m);
  for (const t of c.toolIndex.values()) if (t.status !== 'done' && t.status !== 'error') t.status = 'done';
}

export function* walkTools(items: Item[]): Generator<{ tool: ToolUseBlock; depth: number; item: AssistantItem }> {
  const rec = function* (arr: Item[], depth: number): Generator<{ tool: ToolUseBlock; depth: number; item: AssistantItem }> {
    for (const it of arr) {
      if (it.kind !== 'assistant') continue;
      for (const b of it.blocks) {
        if (b.type !== 'tool_use') continue;
        yield { tool: b, depth, item: it };
        yield* rec(b.children, depth + 1);
      }
    }
  };
  yield* rec(items, 0);
}
