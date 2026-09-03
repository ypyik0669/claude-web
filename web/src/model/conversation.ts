// Pure reducer: SDK messages (live or from transcript) -> renderable conversation tree.
// Kept framework-free so it can be unit tested against captured message streams (see __fixtures__).
import { classifyError, type ErrorKind } from './health';

export interface TextBlock { type: 'text'; text: string }
export interface ThinkingBlock { type: 'thinking'; thinking: string; redacted?: boolean }
export interface ToolResult {
  content: string;
  isError: boolean;
  raw?: unknown;
  /** SDK `tool_use_result`: the tool's full Output object (FileReadOutput, GrepOutput, BashOutput, ...). */
  structured?: unknown;
  /** data: URIs of image blocks inside the tool_result (Read of an image, MCP screenshots). */
  images?: string[];
  ts?: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputJson?: string; // partial json while streaming
  result?: ToolResult;
  children: Item[]; // subagent messages (parent_tool_use_id === id)
  progress?: { elapsed: number; summary?: string; lastTool?: string };
  status: 'streaming' | 'pending' | 'running' | 'done' | 'error';
  startedAt?: number;
}
export type Block = TextBlock | ThinkingBlock | ToolUseBlock;

export interface Attachment { kind: 'image' | 'text' | 'file' | 'folder'; name: string; size?: number; path?: string }

export interface UserItem {
  kind: 'user';
  id: string; // transcript uuid (client-minted on send, so local echo == transcript id)
  ts?: string;
  text: string;
  images: string[];
  attachments?: Attachment[];
  meta?: boolean;
  raw?: unknown;
}
export interface AssistantItem {
  kind: 'assistant';
  id: string; // API message id when known, else uuid
  uuid?: string; // last SDK wrapper uuid seen for this message (chain position, fork anchor)
  userMessageUuid?: string; // client uuid of the user message this turn answers (first frame only)
  ts?: string;
  model?: string;
  blocks: Block[];
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  streaming: boolean;
  parentToolUseId: string | null;
  error?: string;
  errorKind?: ErrorKind;
  aborted?: boolean;
}
export interface SystemItem { kind: 'system'; id: string; ts?: string; subtype: string; text: string; data?: unknown; level?: 'info' | 'warn' | 'error' }
export interface ResultItem {
  kind: 'result';
  id: string;
  ts?: string;
  subtype: string;
  durationMs: number;
  apiMs: number;
  costUsd: number;
  numTurns: number;
  isError: boolean;
  text?: string;
  usage?: unknown;
  errorKind?: ErrorKind;
  terminalReason?: string;
  apiStatus?: number | null;
  userMessageUuid?: string;
  queuedTurnCount?: number;
}
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

export interface ContextUsage { percentage: number; totalTokens: number; maxTokens: number; model?: string; overLimit?: { tokensOver: number; kind: string } }
export interface RateLimitState { status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number; type?: string; utilization?: number; errorCode?: string; at: number }

export interface Conversation {
  items: Item[]; // top-level (parent_tool_use_id === null)
  toolIndex: Map<string, ToolUseBlock>; // tool_use id -> block (any depth)
  tasks: Map<string, TaskInfo>;
  streaming: Map<string, AssistantItem>; // parentToolUseId ('' for top) -> item receiving deltas
  lastResult?: ResultItem;
  // health signals (client clock)
  lastEventAt?: number;
  lastModelCallAt?: number;
  runningTool?: { id: string; name: string; since: number; elapsed?: number } | null;
  /** client clock at the start of the turn in flight — what the composer's run card counts up from */
  turnStartedAt?: number;
  compacting: boolean;
  contextUsage?: ContextUsage;
  rateLimit?: RateLimitState;
  /** uuids retracted by refusal fallback / supersedes — kept so a late duplicate is ignored */
  retracted: Set<string>;
}

export function createConversation(): Conversation {
  return { items: [], toolIndex: new Map(), tasks: new Map(), streaming: new Map(), compacting: false, retracted: new Set() };
}

const key = (p: string | null | undefined) => p ?? '';
let clock: () => number = () => Date.now();
/** Test hook: inject a fake clock. */
export function setConversationClock(fn: () => number) {
  clock = fn;
}

function containerFor(c: Conversation, parent: string | null | undefined): Item[] {
  if (!parent) return c.items;
  const t = c.toolIndex.get(parent);
  if (t) return t.children;
  // parent unknown yet (subagent transcript before its tool_use) — attach at top level
  return c.items;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
  return '';
}

function contentImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content as any[]) {
    if (b?.type !== 'image') continue;
    const s = b.source ?? {};
    if (s.type === 'base64' && s.data) out.push(`data:${s.media_type ?? 'image/png'};base64,${s.data}`);
    else if (s.type === 'url' && s.url) out.push(s.url);
  }
  return out;
}

function findItem(c: Conversation, parent: string | null | undefined, pred: (i: Item) => boolean): Item | undefined {
  const arr = containerFor(c, parent);
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
  return undefined;
}

/** Mutates `c` in place; caller is responsible for triggering re-render (we bump a version). */
export function applyMessage(c: Conversation, m: any): void {
  if (m && m.type !== 'stream_event') c.lastEventAt = clock();
  else if (m?.type === 'stream_event') c.lastEventAt = clock();
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
      if (t) {
        t.progress = { ...(t.progress ?? {}), elapsed: m.elapsed_time_seconds };
        if (t.status === 'pending') t.status = 'running';
      }
      if (!m.parent_tool_use_id) c.runningTool = { id: m.tool_use_id, name: m.tool_name, since: clock() - (m.elapsed_time_seconds ?? 0) * 1000, elapsed: m.elapsed_time_seconds };
      return;
    }
    case 'rate_limit_event': {
      const i = m.rate_limit_info ?? {};
      c.rateLimit = { status: i.status ?? 'allowed', resetsAt: i.resetsAt, type: i.rateLimitType, utilization: i.utilization, errorCode: i.errorCode, at: clock() };
      if (i.status === 'rejected') c.items.push({ kind: 'system', id: m.uuid ?? `rl-${clock()}`, subtype: 'rate_limit', level: 'warn', text: `额度已用尽（${labelLimit(i.rateLimitType)}）${i.resetsAt ? ` · ${resetText(i.resetsAt)}` : ''}`, data: i });
      return;
    }
    case 'conversation_reset':
      c.items = [];
      c.toolIndex.clear();
      c.streaming.clear();
      c.tasks.clear();
      c.items.push({ kind: 'system', id: m.uuid ?? `reset-${clock()}`, subtype: 'reset', text: '对话已重置（/clear）', data: m.new_conversation_id });
      return;
    default:
      return;
  }
}

function labelLimit(t?: string) {
  return t === 'five_hour' ? '5 小时窗口' : t === 'seven_day' ? '7 天窗口' : t === 'seven_day_opus' ? '7 天 Opus' : t === 'seven_day_sonnet' ? '7 天 Sonnet' : t === 'overage' ? '超额' : t ?? '';
}
function resetText(resetsAt: number) {
  const ms = resetsAt * (resetsAt < 1e12 ? 1000 : 1) - clock();
  if (ms <= 0) return '即将重置';
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} 分钟后重置` : `${Math.floor(m / 60)} 小时 ${m % 60} 分后重置`;
}

function applyStream(c: Conversation, m: any) {
  const ev = m.event;
  const k = key(m.parent_tool_use_id);
  let cur = c.streaming.get(k);
  if (ev.type === 'message_start') {
    cur = { kind: 'assistant', id: ev.message?.id ?? m.uuid, uuid: m.uuid, ts: new Date(clock()).toISOString(), model: ev.message?.model, blocks: [], streaming: true, parentToolUseId: m.parent_tool_use_id ?? null };
    if (m.user_message_uuid) cur.userMessageUuid = m.user_message_uuid;
    c.streaming.set(k, cur);
    containerFor(c, m.parent_tool_use_id).push(cur);
    if (!m.parent_tool_use_id) { c.lastModelCallAt = clock(); c.runningTool = null; }
    return;
  }
  if (!cur) return;
  if (m.user_message_uuid && !cur.userMessageUuid) cur.userMessageUuid = m.user_message_uuid;
  if (ev.type === 'content_block_start') {
    const b = ev.content_block;
    if (b.type === 'text') cur.blocks[ev.index] = { type: 'text', text: b.text ?? '' };
    else if (b.type === 'thinking') cur.blocks[ev.index] = { type: 'thinking', thinking: b.thinking ?? '' };
    else if (b.type === 'redacted_thinking') cur.blocks[ev.index] = { type: 'thinking', thinking: '', redacted: true };
    else if (b.type === 'tool_use') {
      const tb: ToolUseBlock = { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {}, inputJson: '', children: [], status: 'streaming', startedAt: clock() };
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
      if (!m.parent_tool_use_id) c.runningTool = { id: b.id, name: b.name, since: clock() };
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

function evict(c: Conversation, uuids: string[] | undefined) {
  if (!uuids?.length) return;
  const set = new Set(uuids);
  for (const u of uuids) c.retracted.add(u);
  const prune = (arr: Item[]) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i];
      const id = it.kind === 'assistant' ? it.uuid ?? it.id : it.id;
      if (set.has(id)) {
        if (it.kind === 'assistant') for (const b of it.blocks) if (b.type === 'tool_use') c.toolIndex.delete(b.id);
        arr.splice(i, 1);
        continue;
      }
      if (it.kind === 'assistant') for (const b of it.blocks) if (b.type === 'tool_use') prune(b.children);
    }
  };
  prune(c.items);
}

function applyAssistant(c: Conversation, m: any) {
  if (m.uuid && c.retracted.has(m.uuid)) return;
  evict(c, m.supersedes);
  const msg = m.message ?? {};
  const parent = m.parent_tool_use_id ?? null;
  const k = key(parent);
  const content: any[] = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
  // Find the item this belongs to: streaming item, or an earlier final item with the same API id.
  let item = c.streaming.get(k);
  if (item && msg.id && item.id !== msg.id) item = undefined;
  if (!item && msg.id) item = findItem(c, parent, (i) => i.kind === 'assistant' && i.id === msg.id) as AssistantItem | undefined;
  if (!item) {
    item = { kind: 'assistant', id: msg.id ?? m.uuid, ts: m.timestamp ?? new Date(clock()).toISOString(), model: msg.model, blocks: [], streaming: false, parentToolUseId: parent };
    containerFor(c, parent).push(item);
    if (!parent) c.lastModelCallAt = clock();
  }
  if (m.uuid) item.uuid = m.uuid;
  if (m.user_message_uuid) item.userMessageUuid = m.user_message_uuid;
  if (m.aborted) item.aborted = true;
  item.model = msg.model ?? item.model;
  if (msg.usage) item.usage = toUsage(msg.usage);
  if (m.error) {
    item.error = typeof m.error === 'string' ? m.error : JSON.stringify(m.error);
    item.errorKind = classifyError({ error: typeof m.error === 'string' ? m.error : undefined, text: contentText(msg.content) });
  }
  if (m.context_usage) c.contextUsage = toContextUsage(m.context_usage);
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
      const tb: ToolUseBlock = { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {}, children: [], status: 'pending', startedAt: clock() };
      c.toolIndex.set(b.id, tb);
      item.blocks.push(tb);
      if (!parent && !c.runningTool) c.runningTool = { id: b.id, name: b.name, since: clock() };
    } else if (b.type === 'text') {
      const last = item.blocks[item.blocks.length - 1];
      // a streamed text block will already exist with identical text
      if (last?.type === 'text' && (last.text === b.text || item.streaming)) last.text = b.text;
      else if (!item.blocks.some((x) => x.type === 'text' && x.text === b.text)) item.blocks.push({ type: 'text', text: b.text });
    } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      const redacted = b.type === 'redacted_thinking';
      const t = redacted ? '' : b.thinking ?? '';
      if (!item.blocks.some((x) => x.type === 'thinking' && x.thinking === t && !!x.redacted === redacted)) {
        const last = item.blocks[item.blocks.length - 1];
        if (last?.type === 'thinking' && item.streaming) { last.thinking = t; last.redacted = redacted || undefined; }
        else item.blocks.push({ type: 'thinking', thinking: t, redacted: redacted || undefined });
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

function toContextUsage(u: any): ContextUsage {
  return { percentage: u.percentage ?? Math.round(((u.total_tokens ?? 0) / Math.max(1, u.raw_max_tokens ?? 1)) * 100), totalTokens: u.total_tokens ?? 0, maxTokens: u.raw_max_tokens ?? 0, model: u.model, overLimit: u.over_limit ? { tokensOver: u.over_limit.tokens_over, kind: u.over_limit.kind } : undefined };
}

/** `<attached kind="file" name="a.txt" path="C:\x\a.txt" size="123">` markers appended by the composer; decoded for display. */
export const ATTACH_RE = /\n*<attached\s+kind="(image|text|file|folder)"\s+name="([^"]*)"(?:\s+path="([^"]*)")?(?:\s+size="(\d+)")?\s*\/?>(?:[\s\S]*?<\/attached>)?/g;

export function decodeAttachments(text: string): { text: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const clean = text.replace(ATTACH_RE, (_m, kind, name, path, size) => {
    attachments.push({ kind, name, path: path || undefined, size: size ? Number(size) : undefined });
    return '';
  });
  return { text: clean.replace(/\n{3,}$/, '\n\n').trimEnd(), attachments };
}

function applyUser(c: Conversation, m: any) {
  if (m.uuid && c.retracted.has(m.uuid)) return;
  const msg = m.message ?? {};
  const parent = m.parent_tool_use_id ?? null;
  const content: any[] = Array.isArray(msg.content) ? msg.content : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
  const results = content.filter((b) => b.type === 'tool_result');
  if (results.length) {
    for (const r of results) {
      const t = c.toolIndex.get(r.tool_use_id);
      if (!t) continue;
      const structured = m.tool_use_result;
      const images = contentImages(r.content);
      // Read of an image: the structured output carries the base64 too
      if (!images.length && structured && typeof structured === 'object' && (structured as any).type === 'image' && (structured as any).file?.base64) {
        const f = (structured as any).file;
        images.push(`data:${f.type ?? 'image/png'};base64,${f.base64}`);
      }
      t.result = { content: contentText(r.content), isError: !!r.is_error, raw: r.content, structured, images: images.length ? images : undefined, ts: m.timestamp };
      t.status = r.is_error ? 'error' : 'done';
      if (c.runningTool?.id === r.tool_use_id) c.runningTool = null;
    }
    if (results.length === content.length) return;
  }
  const rawText = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = contentImages(content);
  if (!rawText && !images.length) return;
  const isMeta = m.isMeta || m.isSynthetic || /^<(command-name|local-command|system-reminder|task-notification)/.test(rawText.trim());
  const { text, attachments } = decodeAttachments(rawText);
  containerFor(c, parent).push({ kind: 'user', id: m.uuid ?? String(Math.random()), ts: m.timestamp, text, images, attachments: attachments.length ? attachments : undefined, meta: isMeta, raw: m });
  if (!parent && !isMeta) c.turnStartedAt = clock();
}

function applyResult(c: Conversation, m: any) {
  const errText = m.is_error ? m.result ?? (m.errors ?? []).join('; ') : undefined;
  const r: ResultItem = {
    kind: 'result',
    id: m.uuid,
    ts: new Date(clock()).toISOString(),
    subtype: m.subtype,
    durationMs: m.duration_ms,
    apiMs: m.duration_api_ms,
    costUsd: m.total_cost_usd,
    numTurns: m.num_turns,
    isError: !!m.is_error,
    text: errText,
    usage: m.usage,
    terminalReason: m.terminal_reason,
    apiStatus: m.api_error_status,
    userMessageUuid: m.user_message_uuid,
    queuedTurnCount: m.queued_turn_count,
  };
  if (r.isError || (m.terminal_reason && !['completed', 'max_turns', 'tool_deferred', 'background_requested'].includes(m.terminal_reason))) {
    r.errorKind = classifyError({ status: m.api_error_status, terminalReason: m.terminal_reason, text: errText ?? m.result, rateLimitStatus: c.rateLimit?.status, rateLimitErrorCode: c.rateLimit?.errorCode });
  }
  c.items.push(r);
  c.lastResult = r;
  // any tool still pending at end of turn is finished
  for (const t of c.toolIndex.values()) if (t.status === 'pending' || t.status === 'running' || t.status === 'streaming') t.status = 'done';
  for (const s of c.streaming.values()) s.streaming = false;
  c.streaming.clear();
  c.runningTool = null;
  c.turnStartedAt = undefined;
  c.compacting = false;
}

function applySystem(c: Conversation, m: any) {
  switch (m.subtype) {
    case 'init':
      return;
    case 'status': {
      if (m.status === 'compacting') c.compacting = true;
      else if (c.compacting && m.status !== 'compacting') c.compacting = false;
      if (m.compact_result === 'failed') c.items.push({ kind: 'system', id: m.uuid ?? `cf-${clock()}`, subtype: 'compact_failed', level: 'error', text: `上下文压缩失败${m.compact_error ? `：${m.compact_error}` : ''}` });
      return;
    }
    case 'compact_boundary': {
      c.compacting = false;
      const meta = m.compact_metadata ?? {};
      const pre = meta.pre_tokens ?? 0, post = meta.post_tokens;
      const pct = pre && post !== undefined && post <= pre ? Math.round(((pre - post) / pre) * 100) : undefined;
      const head = meta.trigger === 'auto' ? '上下文已自动压缩' : '上下文已压缩';
      c.items.push({ kind: 'system', id: m.uuid, subtype: 'compact', text: pct !== undefined ? `${head} · 释放 ${pct}%` : `${head}${pre ? `（${Math.round(pre / 1000)}K tok）` : ''}`, data: meta });
      return;
    }
    case 'task_started': {
      c.tasks.set(m.task_id, { id: m.task_id, toolUseId: m.tool_use_id, description: m.description, type: m.task_type, subagentType: m.subagent_type, status: 'running', startedAt: clock(), backgrounded: m.is_backgrounded });
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
      const t: TaskInfo = c.tasks.get(m.task_id) ?? { id: m.task_id, toolUseId: m.tool_use_id, description: m.summary, status: 'completed', startedAt: clock() };
      t.status = m.status;
      t.endedAt = clock();
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
        else c.tasks.set(bt.task_id ?? bt.id, { id: bt.task_id ?? bt.id, description: bt.description ?? '', status: bt.status ?? 'running', startedAt: clock(), backgrounded: true, type: bt.type });
      }
      return;
    }
    case 'local_command_output':
      c.items.push({ kind: 'system', id: m.uuid, subtype: 'command', text: m.content ?? m.output ?? '' });
      return;
    case 'api_retry': {
      const kind = classifyError({ error: m.error, status: m.error_status });
      c.items.push({ kind: 'system', id: m.uuid, subtype: 'retry', level: 'warn', text: `API 重试 ${m.attempt ?? ''}/${m.max_retries ?? ''}（${m.error ?? ''}${m.error_status ? ` HTTP ${m.error_status}` : ''}）${m.retry_delay_ms ? ` · ${Math.round(m.retry_delay_ms / 1000)}s 后` : ''}`, data: { kind, error: m.error, status: m.error_status, delayMs: m.retry_delay_ms } });
      return;
    }
    case 'model_refusal_fallback':
      evict(c, m.retracted_message_uuids);
      c.items.push({ kind: 'system', id: m.uuid, subtype: 'refusal', level: 'warn', text: `模型拒答，已用 ${m.fallback_model ?? '备用模型'} 重试${m.api_refusal_category ? `（${m.api_refusal_category}）` : ''}`, data: m });
      return;
    case 'model_refusal_no_fallback':
      c.items.push({ kind: 'system', id: m.uuid, subtype: 'refusal', level: 'error', text: `模型拒答${m.api_refusal_category ? `（${m.api_refusal_category}）` : ''}${m.api_refusal_explanation ? `：${m.api_refusal_explanation}` : ''}`, data: m });
      return;
    case 'informational':
    case 'notification':
      c.items.push({ kind: 'system', id: m.uuid, subtype: m.subtype, text: m.message ?? m.content ?? JSON.stringify(m) });
      return;
    case 'permission_denied':
      c.items.push({ kind: 'system', id: m.uuid, subtype: 'denied', level: 'warn', text: `权限拒绝: ${m.tool_name ?? ''} ${m.reason ?? ''}` });
      return;
    default:
      return;
  }
}

/**
 * Historical transcript messages have the same shape (type/message/parent_tool_use_id).
 *
 * `live` = a runner is still mid-turn on this session (you clicked a running session in the sidebar).
 * Then the trailing tool really is running and must keep saying so — sweeping it to `done` is how a
 * running command ends up wearing a green check.
 */
export function applyTranscript(c: Conversation, msgs: any[], opts?: { live?: boolean }) {
  for (const m of msgs) applyMessage(c, m);
  if (opts?.live) {
    // the replay stamped turnStartedAt with the replay clock; the transcript knows better
    for (let i = c.items.length - 1; i >= 0; i--) {
      const it = c.items[i];
      if (it.kind !== 'user' || it.meta) continue;
      const t = it.ts ? Date.parse(it.ts) : NaN;
      if (!Number.isNaN(t)) c.turnStartedAt = t;
      break;
    }
    return;
  }
  for (const t of c.toolIndex.values()) if (t.status !== 'done' && t.status !== 'error') t.status = 'done';
  c.runningTool = null;
  c.turnStartedAt = undefined;
  c.compacting = false;
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

/**
 * Transcript uuid that precedes `itemId` in the main chain — the anchor for forkSession({upToMessageId}) when
 * editing / re-running that user message. Returns null for the first message (= start a fresh session).
 */
export function findChainUuidBefore(c: Conversation, itemId: string): string | null | undefined {
  const idx = c.items.findIndex((i) => i.id === itemId);
  if (idx < 0) return undefined;
  for (let i = idx - 1; i >= 0; i--) {
    const it = c.items[i];
    if (it.kind === 'user') return it.id;
    if (it.kind === 'assistant' && it.uuid) return it.uuid;
  }
  return null;
}

/** The user item that started the turn containing `item` (walks back to the nearest non-meta user message). */
export function turnStart(c: Conversation, itemId: string): UserItem | undefined {
  const idx = c.items.findIndex((i) => i.id === itemId);
  for (let i = idx; i >= 0; i--) {
    const it = c.items[i];
    if (it.kind === 'user' && !it.meta) return it;
  }
  return undefined;
}

/** Items of one turn: from the given user item up to (excluding) the next non-meta user item. */
export function turnItems(c: Conversation, userItemId: string): Item[] {
  const idx = c.items.findIndex((i) => i.id === userItemId);
  if (idx < 0) return [];
  const out: Item[] = [c.items[idx]];
  for (let i = idx + 1; i < c.items.length; i++) {
    const it = c.items[i];
    if (it.kind === 'user' && !it.meta) break;
    out.push(it);
  }
  return out;
}
