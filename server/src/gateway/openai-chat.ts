// OpenAI Chat Completions ⇄ IR. Shapes per platform.openai.com (chat/completions, chat.completion.chunk).
import { newId, safeJson, type IrEvent, type IrMessage, type IrPart, type IrRequest, type IrResponse, type IrStop, type IrTool, type IrUsage, type StreamParser, type StreamRenderer } from './ir.js';
import { sse } from './sse.js';
import { CACHE_KEY_MAX } from './cache.js';

function contentParts(c: unknown): IrPart[] {
  if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : [];
  if (!Array.isArray(c)) return [];
  const out: IrPart[] = [];
  for (const p of c as any[]) {
    if (p?.type === 'text' && p.text) out.push({ type: 'text', text: p.text });
    else if (p?.type === 'image_url') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      if (url) out.push(dataUrlImage(url));
    } else if (p?.type === 'refusal' && p.refusal) out.push({ type: 'text', text: p.refusal });
  }
  return out;
}

/** `data:<mime>;base64,<data>` → inline image; anything else stays a URL. */
export function dataUrlImage(url: string): IrPart {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { type: 'image', mediaType: m[1], data: m[2] } : { type: 'image', mediaType: 'image/*', url };
}
const textOnly = (c: unknown) => contentParts(c).filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n');

export function parseRequest(body: any): IrRequest {
  const system: string[] = [];
  const messages: IrMessage[] = [];
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') { const t = textOnly(m.content); if (t) system.push(t); continue; }
    if (m.role === 'tool') {
      messages.push({ role: 'user', parts: [{ type: 'tool_result', id: String(m.tool_call_id ?? ''), content: typeof m.content === 'string' ? m.content : contentParts(m.content) }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = contentParts(m.content);
      for (const tc of m.tool_calls ?? []) if (tc?.function) parts.push({ type: 'tool_call', id: String(tc.id ?? newId('call_')), name: tc.function.name, args: safeJson(tc.function.arguments) });
      messages.push({ role: 'assistant', parts });
      continue;
    }
    messages.push({ role: 'user', parts: contentParts(m.content) });
  }
  const tools: IrTool[] = (Array.isArray(body.tools) ? body.tools : []).filter((t: any) => t?.type === 'function' && t.function?.name).map((t: any) => ({ name: t.function.name, description: t.function.description, schema: t.function.parameters ?? { type: 'object', properties: {} } }));
  const tc = body.tool_choice;
  const stop = typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop) ? body.stop : undefined;
  return {
    model: String(body.model ?? ''),
    system: system.join('\n\n') || undefined,
    messages,
    tools: tools.length ? tools : undefined,
    toolChoice: tc === 'none' ? { type: 'none' } : tc === 'required' ? { type: 'any' } : tc?.type === 'function' ? { type: 'tool', name: tc.function?.name } : tc === 'auto' ? { type: 'auto' } : undefined,
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature ?? undefined,
    topP: body.top_p ?? undefined,
    stop: stop?.length ? stop : undefined,
    stream: !!body.stream,
  };
}

const partOut = (p: IrPart): any => p.type === 'text' ? { type: 'text', text: p.text } : p.type === 'image' ? { type: 'image_url', image_url: { url: p.data ? `data:${p.mediaType};base64,${p.data}` : p.url } } : null;

/** Reasoning-family models reject `max_tokens` and want `max_completion_tokens` (and no sampling knobs on Responses). */
export const wantsCompletionTokens = (model: string) => /^(o\d|gpt-5)/i.test(model);

export interface ChatRenderOpts {
  /** send `r.cacheKey` as `prompt_cache_key` (off once the member rejected the field) */
  promptCacheKey?: boolean;
  /** Anthropic-style `cache_control` markers (Bailian explicit cache, OpenRouter anthropic/*): profile `cacheControlFormat: 'anthropic'` */
  cacheControl?: boolean;
}

export function renderRequest(r: IrRequest, opts: ChatRenderOpts = {}): any {
  const messages: any[] = [];
  if (r.system) messages.push({ role: 'system', content: r.system });
  for (const m of r.messages) {
    if (m.role === 'assistant') {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as any).text).join('');
      const calls = m.parts.filter((p): p is Extract<IrPart, { type: 'tool_call' }> => p.type === 'tool_call');
      if (!text && !calls.length) continue;
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) });
      continue;
    }
    // tool results become their own `tool` messages, ahead of whatever the user said in the same turn.
    // A tool message's content is text only (string | text parts), so images a tool returned ride in a
    // user message right after the tool messages.
    const toolImages: any[] = [];
    for (const p of m.parts) if (p.type === 'tool_result') {
      const parts = typeof p.content === 'string' ? [{ type: 'text', text: p.content } as IrPart] : p.content;
      const text = parts.filter((x) => x.type === 'text').map((x) => (x as any).text).join('\n');
      const imgs = parts.filter((x) => x.type === 'image');
      messages.push({ role: 'tool', tool_call_id: p.id, content: `${p.isError ? '[error] ' : ''}${text || (imgs.length ? '[image]' : '')}` });
      if (imgs.length) toolImages.push({ type: 'text', text: `[tool result image for ${p.id}]` }, ...imgs.map(partOut));
    }
    if (toolImages.length) messages.push({ role: 'user', content: toolImages });
    const rest = m.parts.filter((p) => p.type === 'text' || p.type === 'image');
    if (!rest.length) continue;
    const content = rest.every((p) => p.type === 'text') ? rest.map((p) => (p as any).text).join('\n') : rest.map(partOut);
    messages.push({ role: 'user', content });
  }
  const out: any = { model: r.model, messages };
  if (r.maxTokens !== undefined) out[wantsCompletionTokens(r.model) ? 'max_completion_tokens' : 'max_tokens'] = r.maxTokens;
  if (r.temperature !== undefined) out.temperature = r.temperature;
  if (r.topP !== undefined) out.top_p = r.topP;
  if (r.stop?.length) out.stop = r.stop;
  if (r.tools?.length) {
    out.tools = r.tools.map((t) => ({ type: 'function', function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.schema } }));
    if (r.toolChoice) out.tool_choice = r.toolChoice.type === 'tool' ? { type: 'function', function: { name: r.toolChoice.name } } : r.toolChoice.type === 'any' ? 'required' : r.toolChoice.type;
  }
  if (r.stream) { out.stream = true; out.stream_options = { include_usage: true }; }
  if (opts.promptCacheKey && r.cacheKey) out.prompt_cache_key = r.cacheKey.slice(0, CACHE_KEY_MAX);
  if (opts.cacheControl) markCacheControl(out);
  return out;
}

/** Breakpoints in Anthropic's format on an OpenAI body: system, last tool, last message's last part. */
function markCacheControl(body: any) {
  const cc = { type: 'ephemeral' };
  const mark = (m: any) => {
    if (!m) return;
    if (typeof m.content === 'string' && m.content) m.content = [{ type: 'text', text: m.content, cache_control: cc }];
    else if (Array.isArray(m.content) && m.content.length) m.content[m.content.length - 1] = { ...m.content[m.content.length - 1], cache_control: cc };
  };
  const msgs: any[] = body.messages;
  if (msgs[0]?.role === 'system') mark(msgs[0]);
  if (body.tools?.length) body.tools[body.tools.length - 1].cache_control = cc;
  if (msgs.length > 1 || msgs[0]?.role !== 'system') mark(msgs[msgs.length - 1]);
}

const STOP_IN: Record<string, IrStop> = { stop: 'end', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'refusal' };
const STOP_OUT: Record<IrStop, string> = { end: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop', refusal: 'content_filter' };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * OpenAI-compatible usage → IR. prompt_tokens (Responses: input_tokens) INCLUDES the cached / cache-write
 * part; the IR (like Anthropic) counts them apart. Where vendors put the hit count:
 *   OpenAI            prompt_tokens_details.cached_tokens (Responses: input_tokens_details.cached_tokens)
 *   DeepSeek          prompt_cache_hit_tokens (+ prompt_cache_miss_tokens)
 *   Kimi / Moonshot   top-level cached_tokens
 * and the write count: prompt_tokens_details.cache_write_tokens (OpenRouter) or cache_creation_input_tokens.
 * `??`, not `||`: an explicit 0 in the details is an answer, not a missing field.
 */
export function usageIn(u: any): Partial<IrUsage> {
  if (!u || typeof u !== 'object') return {};
  const d = u.prompt_tokens_details ?? u.input_tokens_details ?? {};
  const cached = num(d.cached_tokens) ?? num(u.prompt_cache_hit_tokens) ?? num(u.cached_tokens) ?? 0;
  const write = num(d.cache_write_tokens) ?? num(d.cache_creation_input_tokens) ?? num(u.cache_creation_input_tokens) ?? 0;
  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens) ?? 0;
  return { input: Math.max(0, prompt - cached - write), output: num(u.completion_tokens) ?? num(u.output_tokens) ?? 0, cacheRead: cached, ...(write ? { cacheWrite: write } : {}) };
}
export const usageOut = (u: IrUsage) => {
  const prompt = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return { prompt_tokens: prompt, completion_tokens: u.output, total_tokens: prompt + u.output, prompt_tokens_details: { cached_tokens: u.cacheRead ?? 0, ...(u.cacheWrite ? { cache_write_tokens: u.cacheWrite } : {}) } };
};

export function parseResponse(j: any): IrResponse {
  const ch = j?.choices?.[0] ?? {};
  const msg = ch.message ?? {};
  const parts: IrPart[] = contentParts(msg.content).filter((p) => p.type === 'text');
  for (const tc of msg.tool_calls ?? []) if (tc?.function) parts.push({ type: 'tool_call', id: tc.id ?? newId('call_'), name: tc.function.name, args: safeJson(tc.function.arguments) });
  return { id: j?.id ?? newId('chatcmpl-'), model: j?.model ?? '', parts, stop: STOP_IN[ch.finish_reason] ?? (parts.some((p) => p.type === 'tool_call') ? 'tool_use' : 'end'), usage: { input: 0, output: 0, ...usageIn(j?.usage) } };
}

export function renderResponse(r: IrResponse, model: string): any {
  const text = r.parts.filter((p) => p.type === 'text').map((p) => (p as any).text).join('');
  const calls = r.parts.filter((p): p is Extract<IrPart, { type: 'tool_call' }> => p.type === 'tool_call');
  return {
    id: r.id.startsWith('chatcmpl') ? r.id : `chatcmpl-${r.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) }, finish_reason: STOP_OUT[r.stop], logprobs: null }],
    usage: usageOut(r.usage),
  };
}

const ERR_TYPE = (status: number) => status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'server_error';
export function renderError(status: number, message: string): any {
  return { error: { message, type: ERR_TYPE(status), code: status } };
}

/** Chat Completions upstream SSE → IR. Tool calls are assumed sequential by index (as OpenAI streams them). */
export class ChatStreamParser implements StreamParser {
  private started = false;
  private toolIndex = -1;
  private stop: IrStop | null = null;
  private sawTool = false;
  private done = false;
  feed(e: { event?: string; data: string }): IrEvent[] {
    if (this.done) return [];
    if (e.data.trim() === '[DONE]') return this.finish();
    let j: any;
    try { j = JSON.parse(e.data); } catch { return []; }
    if (j?.error) { this.done = true; return [{ t: 'error', message: j.error.message ?? String(j.error) }]; }
    const out: IrEvent[] = [];
    if (!this.started) { this.started = true; out.push({ t: 'start', id: j.id ?? newId('chatcmpl-'), model: j.model ?? '' }); }
    const ch = j.choices?.[0];
    const d = ch?.delta ?? {};
    if (typeof d.content === 'string' && d.content) out.push({ t: 'text', text: d.content });
    for (const tc of d.tool_calls ?? []) {
      const idx = typeof tc.index === 'number' ? tc.index : tc.id ? this.toolIndex + 1 : this.toolIndex;
      if (idx !== this.toolIndex) { this.toolIndex = idx; this.sawTool = true; out.push({ t: 'tool', id: tc.id ?? newId('call_'), name: tc.function?.name ?? '' }); }
      if (tc.function?.arguments) out.push({ t: 'args', json: tc.function.arguments });
    }
    if (ch?.finish_reason) this.stop = STOP_IN[ch.finish_reason] ?? 'end';
    if (j.usage) out.push({ t: 'usage', usage: usageIn(j.usage) });
    return out;
  }
  private finish(): IrEvent[] {
    this.done = true;
    return [{ t: 'end', stop: this.stop ?? (this.sawTool ? 'tool_use' : 'end') }];
  }
  end(): IrEvent[] {
    if (this.done) return [];
    return this.started ? this.finish() : [{ t: 'error', message: '上游流意外结束' }];
  }
}

/** IR → chat.completion.chunk SSE for the client. */
export class ChatStreamRenderer implements StreamRenderer {
  private id = newId('chatcmpl-');
  private created = Math.floor(Date.now() / 1000);
  private started = false;
  private toolIndex = -1;
  private usage: IrUsage = { input: 0, output: 0 };
  private finished = false;
  constructor(private model: string, private includeUsage: boolean) {}
  private chunk(delta: any, finish: string | null = null) {
    return sse({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] });
  }
  private start(): string {
    if (this.started) return '';
    this.started = true;
    return this.chunk({ role: 'assistant', content: '' });
  }
  push(e: IrEvent): string {
    if (this.finished) return '';
    switch (e.t) {
      case 'start': return this.start();
      case 'usage': Object.assign(this.usage, e.usage); return '';
      case 'text': return e.text ? this.start() + this.chunk({ content: e.text }) : this.start();
      case 'tool':
        this.toolIndex++;
        return this.start() + this.chunk({ tool_calls: [{ index: this.toolIndex, id: e.id, type: 'function', function: { name: e.name, arguments: '' } }] });
      case 'args':
        return this.toolIndex < 0 || !e.json ? '' : this.chunk({ tool_calls: [{ index: this.toolIndex, function: { arguments: e.json } }] });
      case 'end': {
        this.finished = true;
        let s = this.start() + this.chunk({}, STOP_OUT[e.stop]);
        if (this.includeUsage) s += sse({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: usageOut(this.usage) });
        return s + sse('[DONE]');
      }
      case 'error':
        this.finished = true;
        return sse(renderError(e.status ?? 500, e.message)) + sse('[DONE]');
    }
    return '';
  }
  end(): string {
    return this.finished ? '' : this.push({ t: 'error', message: '上游流意外结束' });
  }
}
