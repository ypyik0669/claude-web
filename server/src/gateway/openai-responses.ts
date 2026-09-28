// OpenAI Responses API (what Codex speaks) → IR on the way in, IR → Responses objects / events on the
// way out. The gateway only has the inbound side (an OpenAI member gets Responses requests passed through
// untouched); the outbound side (IR → request, response / stream → IR) is for the cache shim, which turns
// ccb's gpt-* chat/completions into /v1/responses (shim.ts).
// Shapes per platform.openai.com (responses, streaming events `response.*`).
import { newId, safeJson, type IrEvent, type IrMessage, type IrPart, type IrRequest, type IrResponse, type IrStop, type IrTool, type IrUsage, type StreamParser, type StreamRenderer } from './ir.js';
import { dataUrlImage, usageIn, wantsCompletionTokens } from './openai-chat.js';
import { sse } from './sse.js';
import { CACHE_KEY_MAX } from './cache.js';

function inputParts(c: unknown): IrPart[] {
  if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : [];
  if (!Array.isArray(c)) return [];
  const out: IrPart[] = [];
  for (const p of c as any[]) {
    if ((p?.type === 'input_text' || p?.type === 'output_text' || p?.type === 'text') && p.text) out.push({ type: 'text', text: p.text });
    else if (p?.type === 'refusal' && p.refusal) out.push({ type: 'text', text: p.refusal });
    else if (p?.type === 'input_image' && p.image_url) out.push(dataUrlImage(p.image_url));
  }
  return out;
}

const outputText = (o: unknown): string | IrPart[] => typeof o === 'string' ? o : Array.isArray(o) ? inputParts(o) : o == null ? '' : JSON.stringify(o);

/** Freeform (`custom`) tools take one raw string; elsewhere they become a function with a single `input` field. */
const CUSTOM_SCHEMA = { type: 'object', properties: { input: { type: 'string', description: 'The raw tool input.' } }, required: ['input'] };

export function parseRequest(body: any): IrRequest {
  const system: string[] = [];
  if (typeof body.instructions === 'string' && body.instructions) system.push(body.instructions);
  const messages: IrMessage[] = [];
  const push = (role: 'user' | 'assistant', parts: IrPart[]) => { if (parts.length) messages.push({ role, parts }); };
  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input : [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const type = it.type ?? (it.role ? 'message' : '');
    if (type === 'message') {
      if (it.role === 'system' || it.role === 'developer') { const t = inputParts(it.content).map((p) => (p.type === 'text' ? p.text : '')).join('\n'); if (t) system.push(t); }
      else push(it.role === 'assistant' ? 'assistant' : 'user', inputParts(it.content));
    } else if (type === 'function_call') push('assistant', [{ type: 'tool_call', id: String(it.call_id ?? it.id), name: it.name, args: safeJson(it.arguments) }]);
    else if (type === 'custom_tool_call') push('assistant', [{ type: 'tool_call', id: String(it.call_id ?? it.id), name: it.name, args: { input: String(it.input ?? '') } }]);
    else if (type === 'function_call_output' || type === 'custom_tool_call_output') push('user', [{ type: 'tool_result', id: String(it.call_id), content: outputText(it.output) }]);
    // reasoning items (encrypted_content), web_search_call, local_shell_call…: provider-bound, dropped
  }
  const tools: IrTool[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (t?.type === 'function' && t.name) tools.push({ name: t.name, description: t.description, schema: t.parameters ?? { type: 'object', properties: {} } });
    else if (t?.type === 'custom' && t.name) {
      const fmt = t.format?.definition ? `\n\nInput format (${t.format.syntax ?? 'grammar'}):\n${t.format.definition}` : '';
      tools.push({ name: t.name, description: `${t.description ?? ''}${fmt}`.trim() || undefined, schema: CUSTOM_SCHEMA, custom: true });
    }
  }
  const tc = body.tool_choice;
  return {
    model: String(body.model ?? ''),
    system: system.join('\n\n') || undefined,
    messages,
    tools: tools.length ? tools : undefined,
    toolChoice: tc === 'none' ? { type: 'none' } : tc === 'required' ? { type: 'any' } : tc?.type === 'function' && tc.name ? { type: 'tool', name: tc.name } : tc === 'auto' ? { type: 'auto' } : undefined,
    maxTokens: body.max_output_tokens ?? undefined,
    temperature: body.temperature ?? undefined,
    topP: body.top_p ?? undefined,
    stream: !!body.stream,
  };
}

// ---------------------------------------------------------------- outbound (cache shim)

export interface ResponsesRenderOpts {
  /** `prompt_cache_key` — with it new-api's default "codex cli trace" affinity pins the session to one channel */
  cacheKey?: string;
  /** `prompt_cache_retention` (OpenAI extended retention, e.g. '24h') */
  retention?: string;
  /** default false: stateless, the full history goes every time (like chat/completions) */
  store?: boolean;
}

const imageItem = (p: Extract<IrPart, { type: 'image' }>) => ({ type: 'input_image', image_url: p.data ? `data:${p.mediaType};base64,${p.data}` : p.url });

/** IR → Responses request. Deterministic (same history → same bytes), so the prefix caches like it would on chat. */
export function renderRequest(r: IrRequest, opts: ResponsesRenderOpts = {}): any {
  const input: any[] = [];
  for (const m of r.messages) {
    if (m.role === 'assistant') {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as any).text).join('');
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const p of m.parts) if (p.type === 'tool_call') input.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.args) });
      continue;
    }
    // tool outputs first (they answer the previous turn's calls); a tool's images ride in a user message after them
    const toolImages: any[] = [];
    for (const p of m.parts) if (p.type === 'tool_result') {
      const parts = typeof p.content === 'string' ? [{ type: 'text', text: p.content } as IrPart] : p.content;
      const text = parts.filter((x) => x.type === 'text').map((x) => (x as any).text).join('\n');
      const imgs = parts.filter((x): x is Extract<IrPart, { type: 'image' }> => x.type === 'image');
      input.push({ type: 'function_call_output', call_id: p.id, output: `${p.isError ? '[error] ' : ''}${text || (imgs.length ? '[image]' : '')}` });
      if (imgs.length) toolImages.push({ type: 'input_text', text: `[tool result image for ${p.id}]` }, ...imgs.map(imageItem));
    }
    if (toolImages.length) input.push({ type: 'message', role: 'user', content: toolImages });
    const rest = m.parts.filter((p) => p.type === 'text' || p.type === 'image');
    if (rest.length) input.push({ type: 'message', role: 'user', content: rest.map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text } : imageItem(p as Extract<IrPart, { type: 'image' }>))) });
  }
  const out: any = { model: r.model };
  if (r.system) out.instructions = r.system;
  out.input = input;
  if (r.tools?.length) {
    out.tools = r.tools.map((t) => ({ type: 'function', name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.schema, strict: false }));
    if (r.toolChoice) out.tool_choice = r.toolChoice.type === 'tool' ? { type: 'function', name: r.toolChoice.name } : r.toolChoice.type === 'any' ? 'required' : r.toolChoice.type;
    out.parallel_tool_calls = true;
  }
  if (r.maxTokens !== undefined) out.max_output_tokens = r.maxTokens;
  // reasoning models reject sampling parameters on Responses
  if (!wantsCompletionTokens(r.model)) {
    if (r.temperature !== undefined) out.temperature = r.temperature;
    if (r.topP !== undefined) out.top_p = r.topP;
  }
  out.store = opts.store ?? false;
  out.stream = r.stream;
  if (opts.cacheKey) out.prompt_cache_key = opts.cacheKey.slice(0, CACHE_KEY_MAX);
  if (opts.retention) out.prompt_cache_retention = opts.retention;
  return out;
}

const stopOf = (status: string | undefined, incompleteReason: string | undefined, sawTool: boolean): IrStop =>
  status === 'incomplete' ? (incompleteReason === 'max_output_tokens' ? 'max_tokens' : 'end') : sawTool ? 'tool_use' : 'end';

const messageText = (it: any) => (it?.content ?? []).map((c: any) => (c?.type === 'output_text' ? c.text ?? '' : c?.type === 'refusal' ? c.refusal ?? '' : '')).join('');

/** A whole Responses object → IR (non-stream answer). Reasoning items are dropped. */
export function parseResponse(j: any): IrResponse {
  const parts: IrPart[] = [];
  for (const it of j?.output ?? []) {
    if (it?.type === 'message') { const t = messageText(it); if (t) parts.push({ type: 'text', text: t }); }
    else if (it?.type === 'function_call') parts.push({ type: 'tool_call', id: String(it.call_id ?? it.id), name: it.name, args: safeJson(it.arguments) });
  }
  return { id: j?.id ?? newId('resp_'), model: j?.model ?? '', parts, stop: stopOf(j?.status, j?.incomplete_details?.reason, parts.some((p) => p.type === 'tool_call')), usage: { input: 0, output: 0, ...usageIn(j?.usage) } };
}

/**
 * Responses SSE (`response.*`) → IR. Items stream one after another; text / arguments come as deltas, and an
 * item whose deltas never came (some relays only send `.done`) is taken whole from its `done` event.
 */
export class ResponsesStreamParser implements StreamParser {
  private started = false;
  private done = false;
  private sawTool = false;
  private items = new Map<string, { args: boolean; text: boolean }>();

  feed(e: { event?: string; data: string }): IrEvent[] {
    if (this.done) return [];
    if (e.data.trim() === '[DONE]') return this.end();
    let j: any;
    try { j = JSON.parse(e.data); } catch { return []; }
    const out: IrEvent[] = [];
    const start = (resp?: any) => { if (!this.started) { this.started = true; out.push({ t: 'start', id: resp?.id ?? newId('resp_'), model: resp?.model ?? '' }); } };
    const type = j?.type ?? e.event;
    switch (type) {
      case 'response.created': case 'response.in_progress': start(j.response); break;
      case 'response.output_item.added': {
        const it = j.item ?? {};
        if (it.type === 'function_call') {
          start();
          this.sawTool = true;
          this.items.set(it.id, { args: !!it.arguments, text: false });
          out.push({ t: 'tool', id: String(it.call_id ?? it.id), name: it.name ?? '' });
          if (it.arguments) out.push({ t: 'args', json: it.arguments });
        } else if (it.type === 'message') this.items.set(it.id, { args: false, text: false });
        break;
      }
      case 'response.output_text.delta': case 'response.refusal.delta': {
        if (!j.delta) break;
        start();
        out.push({ t: 'text', text: j.delta });
        const s = this.items.get(j.item_id);
        if (s) s.text = true; else this.items.set(j.item_id, { args: false, text: true });
        break;
      }
      case 'response.function_call_arguments.delta': {
        if (!j.delta) break;
        out.push({ t: 'args', json: j.delta });
        const s = this.items.get(j.item_id);
        if (s) s.args = true;
        break;
      }
      case 'response.function_call_arguments.done': {
        const s = this.items.get(j.item_id);
        if (s && !s.args && j.arguments) { out.push({ t: 'args', json: j.arguments }); s.args = true; }
        break;
      }
      case 'response.output_item.done': {
        const it = j.item ?? {};
        const s = this.items.get(it.id);
        if (it.type === 'function_call') {
          if (!s) { start(); this.sawTool = true; out.push({ t: 'tool', id: String(it.call_id ?? it.id), name: it.name ?? '' }); }
          if ((!s || !s.args) && it.arguments) out.push({ t: 'args', json: it.arguments });
          this.items.set(it.id, { args: true, text: false });
        } else if (it.type === 'message' && !s?.text) {
          const t = messageText(it);
          if (t) { start(); out.push({ t: 'text', text: t }); }
        }
        break;
      }
      case 'response.completed': case 'response.incomplete': {
        start(j.response);
        const r = j.response ?? {};
        if (r.usage) out.push({ t: 'usage', usage: usageIn(r.usage) });
        this.done = true;
        out.push({ t: 'end', stop: stopOf(type === 'response.incomplete' ? 'incomplete' : r.status, r.incomplete_details?.reason, this.sawTool) });
        break;
      }
      case 'response.failed':
        this.done = true;
        out.push({ t: 'error', message: j.response?.error?.message ?? 'upstream response failed' });
        break;
      case 'error':
        this.done = true;
        out.push({ t: 'error', message: j.message ?? j.error?.message ?? 'upstream error' });
        break;
    }
    return out;
  }

  end(): IrEvent[] {
    if (this.done) return [];
    this.done = true;
    return [{ t: 'error', message: '上游流意外结束' }];
  }
}

/** A whole answer as the event sequence a stream would have produced (upstream answered JSON to a stream request). */
export function irEvents(r: IrResponse): IrEvent[] {
  const out: IrEvent[] = [{ t: 'start', id: r.id, model: r.model }];
  for (const p of r.parts) {
    if (p.type === 'text') out.push({ t: 'text', text: p.text });
    else if (p.type === 'tool_call') out.push({ t: 'tool', id: p.id, name: p.name }, { t: 'args', json: JSON.stringify(p.args) });
  }
  out.push({ t: 'usage', usage: r.usage }, { t: 'end', stop: r.stop });
  return out;
}

const usageOut = (u: IrUsage) => {
  const input = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return { input_tokens: input, input_tokens_details: { cached_tokens: u.cacheRead ?? 0, ...(u.cacheWrite ? { cache_write_tokens: u.cacheWrite } : {}) }, output_tokens: u.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + u.output };
};

function toolItem(p: Extract<IrPart, { type: 'tool_call' }>, custom: Set<string>, status = 'completed') {
  return custom.has(p.name)
    ? { type: 'custom_tool_call', id: newId('ctc_'), call_id: p.id, name: p.name, input: String((p.args as any).input ?? ''), status }
    : { type: 'function_call', id: newId('fc_'), call_id: p.id, name: p.name, arguments: JSON.stringify(p.args), status };
}
const messageItem = (text: string, id = newId('msg_'), status = 'completed') => ({ type: 'message', id, status, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });

function responseObject(id: string, model: string, status: string, output: unknown[], usage: IrUsage | null, extra: Record<string, unknown> = {}) {
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, error: null, incomplete_details: null, model, output, parallel_tool_calls: true, tool_choice: 'auto', tools: [], usage: usage ? usageOut(usage) : null, ...extra };
}

export function renderResponse(r: IrResponse, model: string, customTools: Set<string>): any {
  const output = r.parts.map((p) => (p.type === 'text' ? messageItem(p.text) : p.type === 'tool_call' ? toolItem(p, customTools) : null)).filter(Boolean);
  const incomplete = r.stop === 'max_tokens';
  return responseObject(newId('resp_'), model, incomplete ? 'incomplete' : 'completed', output, r.usage, incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {});
}

/** IR → Responses streaming events (`event: response.x` + `data: {type, sequence_number, …}`). */
export class ResponsesStreamRenderer implements StreamRenderer {
  private id = newId('resp_');
  private seq = 0;
  private started = false;
  private output: any[] = [];
  private cur: { kind: 'text'; item: any; text: string } | { kind: 'tool'; item: any; args: string; custom: boolean } | null = null;
  private usage: IrUsage = { input: 0, output: 0 };
  private finished = false;
  constructor(private model: string, private customTools: Set<string>) {}

  private ev(type: string, body: Record<string, unknown>) { return sse({ type, sequence_number: this.seq++, ...body }, type); }
  private start(): string {
    if (this.started) return '';
    this.started = true;
    const r = responseObject(this.id, this.model, 'in_progress', [], null);
    return this.ev('response.created', { response: r }) + this.ev('response.in_progress', { response: r });
  }
  private close(): string {
    const c = this.cur;
    if (!c) return '';
    this.cur = null;
    const output_index = this.output.length;
    let s = '';
    if (c.kind === 'text') {
      const part = { type: 'output_text', text: c.text, annotations: [] };
      const item = { ...c.item, status: 'completed', content: [part] };
      s += this.ev('response.output_text.done', { item_id: item.id, output_index, content_index: 0, text: c.text });
      s += this.ev('response.content_part.done', { item_id: item.id, output_index, content_index: 0, part });
      s += this.ev('response.output_item.done', { output_index, item });
      this.output.push(item);
    } else if (c.custom) {
      const item = { ...c.item, status: 'completed', input: String((safeJson(c.args) as any).input ?? '') };
      s += this.ev('response.output_item.done', { output_index, item });
      this.output.push(item);
    } else {
      const item = { ...c.item, status: 'completed', arguments: c.args || '{}' };
      s += this.ev('response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments });
      s += this.ev('response.output_item.done', { output_index, item });
      this.output.push(item);
    }
    return s;
  }
  push(e: IrEvent): string {
    if (this.finished) return '';
    switch (e.t) {
      case 'start': return this.start();
      case 'usage': Object.assign(this.usage, e.usage); return '';
      case 'text': {
        let s = this.start();
        if (this.cur?.kind !== 'text') {
          s += this.close();
          const item = { type: 'message', id: newId('msg_'), status: 'in_progress', role: 'assistant', content: [] };
          this.cur = { kind: 'text', item, text: '' };
          const output_index = this.output.length;
          s += this.ev('response.output_item.added', { output_index, item });
          s += this.ev('response.content_part.added', { item_id: item.id, output_index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        if (e.text) {
          this.cur.text += e.text;
          s += this.ev('response.output_text.delta', { item_id: this.cur.item.id, output_index: this.output.length, content_index: 0, delta: e.text });
        }
        return s;
      }
      case 'tool': {
        let s = this.start() + this.close();
        const custom = this.customTools.has(e.name);
        const item = custom ? { type: 'custom_tool_call', id: newId('ctc_'), call_id: e.id, name: e.name, input: '', status: 'in_progress' } : { type: 'function_call', id: newId('fc_'), call_id: e.id, name: e.name, arguments: '', status: 'in_progress' };
        this.cur = { kind: 'tool', item, args: '', custom };
        s += this.ev('response.output_item.added', { output_index: this.output.length, item });
        return s;
      }
      case 'args': {
        if (this.cur?.kind !== 'tool' || !e.json) return '';
        this.cur.args += e.json;
        // a custom tool's input is the `input` field of the JSON — only known once complete
        return this.cur.custom ? '' : this.ev('response.function_call_arguments.delta', { item_id: this.cur.item.id, output_index: this.output.length, delta: e.json });
      }
      case 'end': {
        this.finished = true;
        const s = this.start() + this.close();
        const incomplete = e.stop === 'max_tokens';
        const r = responseObject(this.id, this.model, incomplete ? 'incomplete' : 'completed', this.output, this.usage, incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {});
        return s + this.ev(incomplete ? 'response.incomplete' : 'response.completed', { response: r });
      }
      case 'error': {
        this.finished = true;
        const r = responseObject(this.id, this.model, 'failed', this.output, this.usage, { error: { code: 'server_error', message: e.message } });
        return this.start() + this.ev('response.failed', { response: r });
      }
    }
    return '';
  }
  end(): string {
    return this.finished ? '' : this.push({ t: 'error', message: '上游流意外结束' });
  }
}
