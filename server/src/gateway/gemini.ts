// Gemini generateContent / streamGenerateContent ⇄ IR. Shapes per ai.google.dev (v1beta, camelCase JSON).
import { newId, linkToolNames, mergeAlternating, resultText, type IrEvent, type IrMessage, type IrPart, type IrRequest, type IrResponse, type IrStop, type IrTool, type IrUsage, type StreamParser, type StreamRenderer } from './ir.js';
import { sse } from './sse.js';

/**
 * Gemini 3 rejects history function calls that carry no thought signature. Calls that did not come from
 * Gemini (translated from another provider) get the documented placeholder that skips the check.
 */
export const DUMMY_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/** Lower-case `type` values (the genai SDK sends `OBJECT` / `STRING`) so the schema is plain JSON Schema. */
function normalizeSchema(s: any): any {
  if (Array.isArray(s)) return s.map(normalizeSchema);
  if (!s || typeof s !== 'object') return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) out[k] = k === 'type' && typeof v === 'string' ? v.toLowerCase() : normalizeSchema(v);
  return out;
}

const SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'propertyOrdering', 'title', 'minLength', 'maxLength', 'pattern', 'minProperties', 'maxProperties']);
/** JSON Schema → the OpenAPI subset `functionDeclarations[].parameters` accepts (no $schema / additionalProperties / const…). */
export function sanitizeSchema(s: any): any {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === 'type' && Array.isArray(v)) {
      const t = v.filter((x) => x !== 'null');
      out.type = t[0] ?? 'string';
      if (t.length < v.length) out.nullable = true;
    } else if (k === 'properties' && v && typeof v === 'object') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, sanitizeSchema(pv)]));
    else if (k === 'items') out.items = sanitizeSchema(v);
    else if (k === 'anyOf' && Array.isArray(v)) out.anyOf = v.map(sanitizeSchema);
    else if (k === 'format') { if (v === 'enum' || v === 'date-time') out.format = v; }
    else if (k === 'enum' && Array.isArray(v)) out.enum = v.map(String);
    else out[k] = v;
  }
  if ('const' in s && !out.enum) { out.enum = [String((s as any).const)]; out.type ??= 'string'; }
  return out;
}

export function parseRequest(body: any, model: string, stream: boolean): IrRequest {
  const sys = body.systemInstruction ?? body.system_instruction;
  const system = typeof sys === 'string' ? sys : (sys?.parts ?? []).map((p: any) => p?.text ?? '').filter(Boolean).join('\n');
  const messages: IrMessage[] = [];
  // Gemini ids are optional: calls get ids in order, responses match by id or else the oldest open call of that name
  const open: { id: string; name: string }[] = [];
  for (const c of Array.isArray(body.contents) ? body.contents : []) {
    const role = c?.role === 'model' ? 'assistant' : 'user';
    const parts: IrPart[] = [];
    for (const p of c?.parts ?? []) {
      if (!p || p.thought) continue;
      if (typeof p.text === 'string') { if (p.text) parts.push({ type: 'text', text: p.text }); }
      else if (p.inlineData ?? p.inline_data) {
        const d = p.inlineData ?? p.inline_data;
        const mime = d.mimeType ?? d.mime_type ?? '';
        parts.push(mime.startsWith('image/') ? { type: 'image', mediaType: mime, data: d.data } : { type: 'text', text: `[${mime || 'binary'} attachment]` });
      } else if (p.fileData ?? p.file_data) {
        const d = p.fileData ?? p.file_data;
        parts.push({ type: 'image', mediaType: d.mimeType ?? d.mime_type ?? 'image/*', url: d.fileUri ?? d.file_uri });
      } else if (p.functionCall ?? p.function_call) {
        const f = p.functionCall ?? p.function_call;
        const id = f.id ?? newId('toolu_');
        open.push({ id, name: f.name });
        parts.push({ type: 'tool_call', id, name: f.name, args: f.args ?? {} });
      } else if (p.functionResponse ?? p.function_response) {
        const f = p.functionResponse ?? p.function_response;
        let i = f.id ? open.findIndex((o) => o.id === f.id) : -1;
        if (i < 0) i = open.findIndex((o) => o.name === f.name);
        const id = i >= 0 ? open.splice(i, 1)[0].id : f.id ?? newId('toolu_');
        const r = f.response;
        const content = typeof r?.output === 'string' ? r.output : typeof r?.content === 'string' ? r.content : JSON.stringify(r ?? {});
        parts.push({ type: 'tool_result', id, name: f.name, content, isError: !!r?.error && r?.output === undefined });
      }
    }
    messages.push({ role, parts });
  }
  const tools: IrTool[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) for (const f of t?.functionDeclarations ?? t?.function_declarations ?? []) {
    if (!f?.name) continue;
    tools.push({ name: f.name, description: f.description, schema: normalizeSchema(f.parametersJsonSchema ?? f.parameters_json_schema ?? f.parameters ?? { type: 'object', properties: {} }) });
  }
  const fc = (body.toolConfig ?? body.tool_config)?.functionCallingConfig ?? (body.toolConfig ?? body.tool_config)?.function_calling_config;
  const allowed: string[] = fc?.allowedFunctionNames ?? fc?.allowed_function_names ?? [];
  const mode = String(fc?.mode ?? '').toUpperCase();
  const g = body.generationConfig ?? body.generation_config ?? {};
  return {
    model,
    system: system || undefined,
    messages,
    tools: tools.length ? tools : undefined,
    toolChoice: mode === 'NONE' ? { type: 'none' } : mode === 'ANY' ? (allowed.length === 1 ? { type: 'tool', name: allowed[0] } : { type: 'any' }) : mode === 'AUTO' ? { type: 'auto' } : undefined,
    maxTokens: g.maxOutputTokens ?? g.max_output_tokens,
    temperature: g.temperature,
    topP: g.topP ?? g.top_p,
    topK: g.topK ?? g.top_k,
    stop: g.stopSequences ?? g.stop_sequences,
    stream,
  };
}

function partOut(p: IrPart): any {
  if (p.type === 'text') return { text: p.text };
  if (p.type === 'image') return p.data ? { inlineData: { mimeType: p.mediaType, data: p.data } } : { text: `[image: ${p.url}]` };
  if (p.type === 'tool_call') return { functionCall: { name: p.name, args: p.args }, thoughtSignature: DUMMY_THOUGHT_SIGNATURE };
  const text = resultText(p.content);
  return { functionResponse: { name: p.name ?? 'tool', response: p.isError ? { error: text } : { output: text } } };
}

export function renderRequest(r: IrRequest): any {
  const contents = mergeAlternating(linkToolNames(r.messages)).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: m.parts.map(partOut) }));
  const out: any = { contents };
  if (r.system) out.systemInstruction = { parts: [{ text: r.system }] };
  if (r.tools?.length) {
    out.tools = [{ functionDeclarations: r.tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), parameters: sanitizeSchema(t.schema) })) }];
    if (r.toolChoice) out.toolConfig = { functionCallingConfig: r.toolChoice.type === 'tool' ? { mode: 'ANY', allowedFunctionNames: [r.toolChoice.name] } : { mode: r.toolChoice.type === 'any' ? 'ANY' : r.toolChoice.type === 'none' ? 'NONE' : 'AUTO' } };
  }
  const g: any = {};
  if (r.maxTokens !== undefined) g.maxOutputTokens = r.maxTokens;
  if (r.temperature !== undefined) g.temperature = r.temperature;
  if (r.topP !== undefined) g.topP = r.topP;
  if (r.topK !== undefined) g.topK = r.topK;
  if (r.stop?.length) g.stopSequences = r.stop;
  if (Object.keys(g).length) out.generationConfig = g;
  return out;
}

/** Upstream path for a model (`models/x` or bare `x`). */
export const upstreamPath = (model: string, stream: boolean) => `/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ''))}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;

const STOP_IN: Record<string, IrStop> = { STOP: 'end', MAX_TOKENS: 'max_tokens', SAFETY: 'refusal', RECITATION: 'refusal', BLOCKLIST: 'refusal', PROHIBITED_CONTENT: 'refusal', SPII: 'refusal', IMAGE_SAFETY: 'refusal' };
const STOP_OUT: Record<IrStop, string> = { end: 'STOP', tool_use: 'STOP', stop_sequence: 'STOP', max_tokens: 'MAX_TOKENS', refusal: 'SAFETY' };

export function usageIn(u: any): Partial<IrUsage> {
  if (!u) return {};
  const cached = u.cachedContentTokenCount ?? 0;
  return { input: Math.max(0, (u.promptTokenCount ?? 0) - cached), output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), cacheRead: cached };
}
const usageOut = (u: IrUsage) => {
  const prompt = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return { promptTokenCount: prompt, candidatesTokenCount: u.output, totalTokenCount: prompt + u.output, ...(u.cacheRead ? { cachedContentTokenCount: u.cacheRead } : {}) };
};

function candidateParts(j: any): IrPart[] {
  const out: IrPart[] = [];
  for (const p of j?.candidates?.[0]?.content?.parts ?? []) {
    if (p.thought) continue;
    if (typeof p.text === 'string' && p.text) out.push({ type: 'text', text: p.text });
    else if (p.functionCall) out.push({ type: 'tool_call', id: p.functionCall.id ?? newId('toolu_'), name: p.functionCall.name, args: p.functionCall.args ?? {} });
  }
  return out;
}

export function parseResponse(j: any, model: string): IrResponse {
  const parts = candidateParts(j);
  const fr = j?.candidates?.[0]?.finishReason;
  const stop: IrStop = parts.some((p) => p.type === 'tool_call') ? 'tool_use' : !j?.candidates?.length && j?.promptFeedback?.blockReason ? 'refusal' : STOP_IN[fr] ?? 'end';
  return { id: j?.responseId ?? newId('msg_'), model: j?.modelVersion ?? model, parts, stop, usage: { input: 0, output: 0, ...usageIn(j?.usageMetadata) } };
}

const toolPart = (p: Extract<IrPart, { type: 'tool_call' }>) => ({ functionCall: { id: p.id, name: p.name, args: p.args } });

export function renderResponse(r: IrResponse, model: string): any {
  const parts = r.parts.map((p) => (p.type === 'text' ? { text: p.text } : p.type === 'tool_call' ? toolPart(p) : null)).filter(Boolean);
  return { candidates: [{ content: { role: 'model', parts: parts.length ? parts : [{ text: '' }] }, finishReason: STOP_OUT[r.stop], index: 0 }], usageMetadata: usageOut(r.usage), modelVersion: model, responseId: r.id };
}

const STATUS = (s: number) => s === 400 ? 'INVALID_ARGUMENT' : s === 401 ? 'UNAUTHENTICATED' : s === 403 ? 'PERMISSION_DENIED' : s === 404 ? 'NOT_FOUND' : s === 429 ? 'RESOURCE_EXHAUSTED' : s === 503 || s === 529 ? 'UNAVAILABLE' : 'INTERNAL';
export function renderError(status: number, message: string): any {
  return { error: { code: status, message, status: STATUS(status) } };
}

/** Gemini upstream SSE (each event is a whole GenerateContentResponse chunk) → IR. */
export class GeminiStreamParser implements StreamParser {
  private started = false;
  private stop: IrStop | null = null;
  private sawTool = false;
  private done = false;
  constructor(private model: string) {}
  feed(e: { event?: string; data: string }): IrEvent[] {
    if (this.done) return [];
    let j: any;
    try { j = JSON.parse(e.data); } catch { return []; }
    if (j?.error) { this.done = true; return [{ t: 'error', message: j.error.message ?? 'upstream error', status: j.error.code }]; }
    const out: IrEvent[] = [];
    if (!this.started) { this.started = true; out.push({ t: 'start', id: j.responseId ?? newId('msg_'), model: j.modelVersion ?? this.model }); }
    for (const p of candidateParts(j)) {
      if (p.type === 'text') out.push({ t: 'text', text: p.text });
      else if (p.type === 'tool_call') { this.sawTool = true; out.push({ t: 'tool', id: p.id, name: p.name }, { t: 'args', json: JSON.stringify(p.args) }); }
    }
    const fr = j.candidates?.[0]?.finishReason;
    if (fr) this.stop = STOP_IN[fr] ?? 'end';
    if (j.usageMetadata) out.push({ t: 'usage', usage: usageIn(j.usageMetadata) });
    return out;
  }
  end(): IrEvent[] {
    if (this.done) return [];
    this.done = true;
    if (!this.started) return [{ t: 'error', message: '上游流意外结束' }];
    return [{ t: 'end', stop: this.sawTool && (this.stop ?? 'end') === 'end' ? 'tool_use' : this.stop ?? 'end' }];
  }
}

/** IR → Gemini SSE chunks for the client. Function calls are emitted whole (Gemini never streams args). */
export class GeminiStreamRenderer implements StreamRenderer {
  private id = newId('');
  private pending: { id: string; name: string; args: string } | null = null;
  private usage: IrUsage = { input: 0, output: 0 };
  private finished = false;
  constructor(private model: string) {}
  private chunk(parts: any[], extra: Record<string, unknown> = {}) {
    return sse({ candidates: [{ content: { role: 'model', parts }, index: 0, ...extra }], modelVersion: this.model, responseId: this.id });
  }
  private flush(): string {
    const p = this.pending;
    if (!p) return '';
    this.pending = null;
    let args: any = {};
    try { args = p.args ? JSON.parse(p.args) : {}; } catch { args = { _raw: p.args }; }
    return this.chunk([{ functionCall: { id: p.id, name: p.name, args } }]);
  }
  push(e: IrEvent): string {
    if (this.finished) return '';
    switch (e.t) {
      case 'start': return '';
      case 'usage': Object.assign(this.usage, e.usage); return '';
      case 'text': return this.flush() + (e.text ? this.chunk([{ text: e.text }]) : '');
      case 'tool': { const s = this.flush(); this.pending = { id: e.id, name: e.name, args: '' }; return s; }
      case 'args': if (this.pending) this.pending.args += e.json; return '';
      case 'end':
        this.finished = true;
        return this.flush() + sse({ candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: STOP_OUT[e.stop], index: 0 }], usageMetadata: usageOut(this.usage), modelVersion: this.model, responseId: this.id });
      case 'error':
        this.finished = true;
        return this.flush() + sse(renderError(e.status ?? 500, e.message));
    }
    return '';
  }
  end(): string {
    return this.finished ? '' : this.push({ t: 'error', message: '上游流意外结束' });
  }
}
