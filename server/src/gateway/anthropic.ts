// Anthropic Messages API ⇄ IR. Shapes per docs.anthropic.com (Messages, streaming events).
import { newId, safeJson, mergeAlternating, type IrEvent, type IrMessage, type IrPart, type IrRequest, type IrResponse, type IrStop, type IrTool, type IrUsage, type StreamParser, type StreamRenderer } from './ir.js';
import { sse } from './sse.js';

const textOf = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === 'text' ? b.text ?? '' : '')).filter(Boolean).join('\n\n') : '';

function imagePart(b: any): IrPart | null {
  const s = b?.source;
  if (s?.type === 'base64') return { type: 'image', mediaType: s.media_type ?? 'image/png', data: s.data };
  if (s?.type === 'url') return { type: 'image', mediaType: 'image/*', url: s.url };
  return null;
}

function blocks(content: unknown): IrPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: IrPart[] = [];
  for (const b of content as any[]) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') { if (b.text) out.push({ type: 'text', text: b.text }); }
    else if (b.type === 'image') { const p = imagePart(b); if (p) out.push(p); }
    else if (b.type === 'tool_use') out.push({ type: 'tool_call', id: String(b.id), name: String(b.name), args: b.input && typeof b.input === 'object' ? b.input : {} });
    else if (b.type === 'tool_result') {
      const c = typeof b.content === 'string' ? b.content : blocks(b.content).filter((p) => p.type === 'text' || p.type === 'image');
      out.push({ type: 'tool_result', id: String(b.tool_use_id), content: c ?? '', isError: !!b.is_error });
    } else if (b.type === 'document') out.push({ type: 'text', text: b.source?.type === 'text' ? String(b.source.data ?? '') : '[document]' });
    // thinking / redacted_thinking / server tool blocks: provider-bound, dropped
  }
  return out;
}

export function parseRequest(body: any): IrRequest {
  const messages: IrMessage[] = (Array.isArray(body.messages) ? body.messages : []).map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', parts: blocks(m.content) }));
  const tools: IrTool[] = (Array.isArray(body.tools) ? body.tools : []).filter((t: any) => t && t.input_schema).map((t: any) => ({ name: t.name, description: t.description, schema: t.input_schema }));
  const tc = body.tool_choice;
  return {
    model: String(body.model ?? ''),
    system: textOf(body.system) || undefined,
    messages,
    tools: tools.length ? tools : undefined,
    toolChoice: !tc ? undefined : tc.type === 'tool' ? { type: 'tool', name: tc.name } : tc.type === 'any' ? { type: 'any' } : tc.type === 'none' ? { type: 'none' } : { type: 'auto' },
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    topK: body.top_k,
    stop: Array.isArray(body.stop_sequences) && body.stop_sequences.length ? body.stop_sequences : undefined,
    stream: !!body.stream,
  };
}

function renderPart(p: IrPart): any {
  if (p.type === 'text') return { type: 'text', text: p.text };
  if (p.type === 'image') return p.data ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } } : { type: 'image', source: { type: 'url', url: p.url } };
  if (p.type === 'tool_call') return { type: 'tool_use', id: p.id, name: p.name, input: p.args };
  const content = typeof p.content === 'string' ? p.content : p.content.map(renderPart);
  return { type: 'tool_result', tool_use_id: p.id, content, ...(p.isError ? { is_error: true } : {}) };
}

export function renderRequest(r: IrRequest): any {
  const msgs = mergeAlternating(r.messages).map((m) => {
    // tool results must lead the user turn that answers a tool_use turn
    const parts = m.role === 'user' ? [...m.parts.filter((p) => p.type === 'tool_result'), ...m.parts.filter((p) => p.type !== 'tool_result')] : m.parts;
    return { role: m.role, content: parts.map(renderPart) };
  });
  if (msgs[0]?.role === 'assistant') msgs.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  const out: any = { model: r.model, max_tokens: r.maxTokens ?? 8192, messages: msgs };
  if (r.system) out.system = r.system;
  if (r.tools?.length) out.tools = r.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.schema }));
  if (r.toolChoice && r.tools?.length) out.tool_choice = r.toolChoice.type === 'tool' ? { type: 'tool', name: r.toolChoice.name } : { type: r.toolChoice.type };
  if (r.temperature !== undefined) out.temperature = r.temperature;
  if (r.topP !== undefined) out.top_p = r.topP;
  if (r.topK !== undefined) out.top_k = r.topK;
  if (r.stop?.length) out.stop_sequences = r.stop;
  if (r.stream) out.stream = true;
  return out;
}

const STOP_IN: Record<string, IrStop> = { end_turn: 'end', max_tokens: 'max_tokens', tool_use: 'tool_use', stop_sequence: 'stop_sequence', refusal: 'refusal', pause_turn: 'end' };
const STOP_OUT: Record<IrStop, string> = { end: 'end_turn', max_tokens: 'max_tokens', tool_use: 'tool_use', stop_sequence: 'stop_sequence', refusal: 'refusal' };

export function usageIn(u: any): Partial<IrUsage> {
  const out: Partial<IrUsage> = {};
  if (!u) return out;
  if (u.input_tokens != null) out.input = u.input_tokens;
  if (u.output_tokens != null) out.output = u.output_tokens;
  if (u.cache_read_input_tokens != null) out.cacheRead = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens != null) out.cacheWrite = u.cache_creation_input_tokens;
  return out;
}
const usageOut = (u: IrUsage) => ({ input_tokens: u.input, output_tokens: u.output, cache_creation_input_tokens: u.cacheWrite ?? 0, cache_read_input_tokens: u.cacheRead ?? 0 });

export function parseResponse(j: any): IrResponse {
  const parts: IrPart[] = [];
  for (const b of j?.content ?? []) {
    if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') parts.push({ type: 'tool_call', id: b.id, name: b.name, args: b.input ?? {} });
  }
  return { id: j?.id ?? newId('msg_'), model: j?.model ?? '', parts, stop: STOP_IN[j?.stop_reason] ?? 'end', usage: { input: 0, output: 0, ...usageIn(j?.usage) } };
}

export function renderResponse(r: IrResponse, model: string): any {
  return {
    id: r.id.startsWith('msg_') ? r.id : `msg_${r.id.replace(/[^A-Za-z0-9_-]/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: r.parts.filter((p) => p.type === 'text' || p.type === 'tool_call').map(renderPart),
    stop_reason: STOP_OUT[r.stop],
    stop_sequence: null,
    usage: usageOut(r.usage),
  };
}

const ERR_TYPE = (status: number) => status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 404 ? 'not_found_error' : status === 413 ? 'request_too_large' : status === 429 ? 'rate_limit_error' : status === 529 ? 'overloaded_error' : 'api_error';
export function renderError(status: number, message: string): any {
  return { type: 'error', error: { type: ERR_TYPE(status), message } };
}
export function errorMessage(j: any): string | undefined {
  return j?.error?.message ?? (typeof j?.error === 'string' ? j.error : undefined) ?? j?.message;
}

/** Anthropic upstream SSE → IR. */
export class AnthropicStreamParser implements StreamParser {
  private skip = new Set<number>(); // thinking / server-tool blocks
  private stop: IrStop | null = null;
  private done = false;
  feed(e: { event?: string; data: string }): IrEvent[] {
    let j: any;
    try { j = JSON.parse(e.data); } catch { return []; }
    const type = j?.type ?? e.event;
    switch (type) {
      case 'message_start': {
        const m = j.message ?? {};
        return [{ t: 'start', id: m.id ?? newId('msg_'), model: m.model ?? '' }, { t: 'usage', usage: usageIn(m.usage) }];
      }
      case 'content_block_start': {
        const b = j.content_block ?? {};
        if (b.type === 'text') return b.text ? [{ t: 'text', text: b.text }] : [{ t: 'text', text: '' }];
        if (b.type === 'tool_use') return [{ t: 'tool', id: b.id, name: b.name }];
        this.skip.add(j.index);
        return [];
      }
      case 'content_block_delta': {
        if (this.skip.has(j.index)) return [];
        const d = j.delta ?? {};
        if (d.type === 'text_delta') return [{ t: 'text', text: d.text ?? '' }];
        if (d.type === 'input_json_delta') return d.partial_json ? [{ t: 'args', json: d.partial_json }] : [];
        return [];
      }
      case 'message_delta': {
        const out: IrEvent[] = [{ t: 'usage', usage: usageIn(j.usage) }];
        if (j.delta?.stop_reason) this.stop = STOP_IN[j.delta.stop_reason] ?? 'end';
        return out;
      }
      case 'message_stop':
        this.done = true;
        return [{ t: 'end', stop: this.stop ?? 'end' }];
      case 'error':
        this.done = true;
        return [{ t: 'error', message: errorMessage(j) ?? 'upstream error' }];
    }
    return [];
  }
  end(): IrEvent[] {
    if (this.done) return [];
    this.done = true;
    return this.stop ? [{ t: 'end', stop: this.stop }] : [{ t: 'error', message: '上游流意外结束' }];
  }
}

/** IR → Anthropic SSE for the client. */
export class AnthropicStreamRenderer implements StreamRenderer {
  private started = false;
  private index = -1;
  private open: 'text' | 'tool' | null = null;
  private usage: IrUsage = { input: 0, output: 0 };
  private finished = false;
  constructor(private model: string) {}

  private start(id = newId('msg_')): string {
    if (this.started) return '';
    this.started = true;
    return sse({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: usageOut(this.usage) } }, 'message_start');
  }
  private close(): string {
    if (!this.open) return '';
    this.open = null;
    return sse({ type: 'content_block_stop', index: this.index }, 'content_block_stop');
  }
  push(e: IrEvent): string {
    if (this.finished) return '';
    switch (e.t) {
      case 'start': return this.start(e.id.startsWith('msg_') ? e.id : `msg_${e.id.replace(/[^A-Za-z0-9_-]/g, '')}`);
      case 'usage': Object.assign(this.usage, e.usage); return '';
      case 'text': {
        let s = this.start();
        if (this.open !== 'text') {
          s += this.close();
          this.open = 'text';
          this.index++;
          s += sse({ type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } }, 'content_block_start');
        }
        if (e.text) s += sse({ type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text: e.text } }, 'content_block_delta');
        return s;
      }
      case 'tool': {
        let s = this.start() + this.close();
        this.open = 'tool';
        this.index++;
        s += sse({ type: 'content_block_start', index: this.index, content_block: { type: 'tool_use', id: e.id, name: e.name, input: {} } }, 'content_block_start');
        return s;
      }
      case 'args':
        if (this.open !== 'tool' || !e.json) return '';
        return sse({ type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: e.json } }, 'content_block_delta');
      case 'end': {
        this.finished = true;
        return this.start() + this.close()
          + sse({ type: 'message_delta', delta: { stop_reason: STOP_OUT[e.stop], stop_sequence: null }, usage: usageOut(this.usage) }, 'message_delta')
          + sse({ type: 'message_stop' }, 'message_stop');
      }
      case 'error':
        this.finished = true;
        return sse({ type: 'error', error: { type: ERR_TYPE(e.status ?? 500), message: e.message } }, 'error');
    }
    return '';
  }
  end(): string {
    return this.finished ? '' : this.push({ t: 'error', message: '上游流意外结束' });
  }
}
