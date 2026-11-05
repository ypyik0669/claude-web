// Protocol-neutral intermediate representation for cross-protocol translation.
// Inbound parsers produce IrRequest; outbound renderers consume it. Upstream responses come back as
// IrResponse (non-stream) or a sequence of IrEvent (stream) and are rendered in the inbound shape.
// Thinking / reasoning blocks in requests are dropped on purpose: signatures never survive a provider change (the
// requested strength does carry over: `IrRequest.effort`). Responses carry
// it one way (an OpenAI-format upstream's reasoning_content → an Anthropic-format client's thinking block, unsigned).
import crypto from 'node:crypto';

export type IrPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data?: string; url?: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name?: string; content: string | IrPart[]; isError?: boolean }
  /**
   * An OpenAI Responses reasoning item carried through an Anthropic client: its `encrypted_content` rides as the
   * thinking block's signature (signature.ts tells it apart as `gpt`), its summary as the thinking text. Only the
   * Responses renderer sends it (`buildOutbound` strips it for every other format) — without it a Codex model
   * reasons from nothing again after every tool call.
   */
  | { type: 'reasoning'; encrypted: string; summary?: string };

export interface IrMessage { role: 'user' | 'assistant'; parts: IrPart[] }

export interface IrTool {
  name: string;
  description?: string;
  schema: Record<string, unknown>;
  /** Responses API freeform ("custom") tool: one string input, wrapped as `{input}` elsewhere. */
  custom?: boolean;
}

export type IrToolChoice = { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };

export interface IrRequest {
  model: string;
  system?: string;
  messages: IrMessage[];
  tools?: IrTool[];
  toolChoice?: IrToolChoice;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stop?: string[];
  stream: boolean;
  /**
   * Thinking strength the client asked for, in whatever form its format has (Claude `output_config.effort` or a
   * thinking budget, `reasoning_effort`, Responses `reasoning.effort`, Gemini `thinkingConfig`). The service keeps it
   * only for a member model that takes it natively and snaps it to that model's levels before rendering.
   */
  effort?: IrEffort;
  /**
   * The client's session identity (cache.ts `cacheKeyOf`): Anthropic outbound sends it as
   * `metadata.user_id`, OpenAI outbound as `prompt_cache_key` — both are what relays route a cache on.
   */
  cacheKey?: string;
}

export type IrEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly IrEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The engine's budgets per level (effortPlan.ts); a budget in between maps to the level it reaches. */
export const EFFORT_BUDGET: Record<IrEffort, number> = { low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 63999 };
export const effortOf = (v: unknown): IrEffort | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase();
  return s === 'minimal' ? 'low' : (EFFORTS as readonly string[]).includes(s) ? (s as IrEffort) : undefined;
};
export const effortOfBudget = (n: unknown): IrEffort | undefined =>
  typeof n !== 'number' || !(n > 0) ? undefined : EFFORTS.find((l) => n <= EFFORT_BUDGET[l]) ?? 'max';

export type IrStop = 'end' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'refusal';

export interface IrUsage { input: number; output: number; cacheRead?: number; cacheWrite?: number }

export interface IrResponse {
  id: string;
  model: string;
  parts: IrPart[]; // text / tool_call only
  /** The model's reasoning (non-blank), shown as a thinking block where the client's format has one. */
  thinking?: string;
  /** the reasoning's signature in the client's format (a Responses `encrypted_content`) */
  signature?: string;
  stop: IrStop;
  usage: IrUsage;
}

/**
 * Streaming events. Blocks are sequential: `text` appends to the current text block (opening one when
 * the previous block was a tool call), `tool` opens a new tool-call block, `args` appends JSON to it, `thinking`
 * appends to the current thinking block (opening one). Parsers only emit `thinking` once the reasoning is non-blank.
 */
export type IrEvent =
  | { t: 'start'; id: string; model: string }
  | { t: 'text'; text: string }
  | { t: 'thinking'; text: string }
  /** closes the current thinking block with this signature (opening an empty one if none is open) */
  | { t: 'signature'; sig: string }
  | { t: 'tool'; id: string; name: string }
  | { t: 'args'; json: string }
  | { t: 'usage'; usage: Partial<IrUsage> }
  | { t: 'end'; stop: IrStop }
  | { t: 'error'; message: string; status?: number };

export const newId = (prefix: string) => `${prefix}${crypto.randomBytes(12).toString('hex')}`;

export function safeJson(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { _raw: s };
  }
}

/** Plain text of a tool result (images dropped, noted). */
export function resultText(c: string | IrPart[]): string {
  if (typeof c === 'string') return c;
  return c.map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

/** Fill in tool_result names from the tool_call that produced them (Gemini needs the function name). */
export function linkToolNames(messages: IrMessage[]): IrMessage[] {
  const names = new Map<string, string>();
  for (const m of messages) for (const p of m.parts) {
    if (p.type === 'tool_call') names.set(p.id, p.name);
    else if (p.type === 'tool_result' && !p.name) p.name = names.get(p.id);
  }
  return messages;
}

/** Merge consecutive same-role messages (Anthropic and Gemini require alternation). */
export function mergeAlternating(messages: IrMessage[]): IrMessage[] {
  const out: IrMessage[] = [];
  for (const m of messages) {
    if (!m.parts.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.parts.push(...m.parts);
    else out.push({ role: m.role, parts: [...m.parts] });
  }
  return out;
}

/** Collect a stream of IrEvents into a response (used by tests and for ledger usage). */
export function collect(events: IrEvent[]): IrResponse {
  const r: IrResponse = { id: '', model: '', parts: [], stop: 'end', usage: { input: 0, output: 0 } };
  let cur: IrPart | null = null;
  let args = '';
  const closeTool = () => { if (cur?.type === 'tool_call') cur.args = safeJson(args); args = ''; };
  for (const e of events) {
    if (e.t === 'start') { r.id = e.id; r.model = e.model; }
    else if (e.t === 'text') {
      if (cur?.type !== 'text') { closeTool(); cur = { type: 'text', text: '' }; r.parts.push(cur); }
      cur.text += e.text;
    } else if (e.t === 'tool') { closeTool(); cur = { type: 'tool_call', id: e.id, name: e.name, args: {} }; r.parts.push(cur); }
    else if (e.t === 'args') args += e.json;
    else if (e.t === 'thinking') r.thinking = (r.thinking ?? '') + e.text;
    else if (e.t === 'signature') r.signature = e.sig;
    else if (e.t === 'usage') Object.assign(r.usage, e.usage);
    else if (e.t === 'end') r.stop = e.stop;
  }
  closeTool();
  return r;
}

/** Rough token estimate (≈ 4 chars per token) when count_tokens cannot be forwarded. */
export function estimateTokens(r: IrRequest): number {
  let n = (r.system ?? '').length;
  for (const m of r.messages) for (const p of m.parts) {
    if (p.type === 'text') n += p.text.length;
    else if (p.type === 'tool_call') n += JSON.stringify(p.args).length + p.name.length;
    else if (p.type === 'tool_result') n += resultText(p.content).length;
    else if (p.type === 'image') n += 1600 * 4;
  }
  for (const t of r.tools ?? []) n += t.name.length + (t.description ?? '').length + JSON.stringify(t.schema).length;
  return Math.max(1, Math.ceil(n / 4));
}

/** Upstream SSE → IrEvents (one per outbound protocol). `end()` flushes at upstream EOF. */
export interface StreamParser {
  feed(e: { event?: string; data: string }): IrEvent[];
  end(): IrEvent[];
}

/** IrEvents → client SSE text (one per inbound protocol). `end()` closes a stream the upstream cut short. */
export interface StreamRenderer {
  push(e: IrEvent): string;
  end(): string;
}
