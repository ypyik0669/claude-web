// OpenAI Responses API (what Codex speaks) → IR on the way in, IR → Responses objects / events on the
// way out. Only the inbound side exists: an OpenAI member gets Responses requests passed through untouched.
// Shapes per platform.openai.com (responses, streaming events `response.*`).
import { newId, safeJson, type IrEvent, type IrMessage, type IrPart, type IrRequest, type IrResponse, type IrTool, type IrUsage, type StreamRenderer } from './ir.js';
import { dataUrlImage } from './openai-chat.js';
import { sse } from './sse.js';

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

const usageOut = (u: IrUsage) => {
  const input = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return { input_tokens: input, input_tokens_details: { cached_tokens: u.cacheRead ?? 0 }, output_tokens: u.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + u.output };
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
