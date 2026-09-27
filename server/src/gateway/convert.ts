// Routing table between inbound protocols and member (outbound) protocols: passthrough vs. translation,
// the six supported translation directions, and one entry point per codec step.
import type { ProviderType } from '../protocol.js';
import type { GatewayProtocol } from './types.js';
import type { IrRequest, IrResponse, StreamParser, StreamRenderer } from './ir.js';
import * as A from './anthropic.js';
import * as C from './openai-chat.js';
import * as R from './openai-responses.js';
import * as G from './gemini.js';

export type Outbound = 'anthropic' | 'openai' | 'gemini';

export const DEFAULT_BASE: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com',
  grok: 'https://api.x.ai',
  gateway: '',
};

/** Wire protocol a provider profile speaks (grok is OpenAI-compatible). Gateway profiles cannot be members. */
export function outboundOf(type: ProviderType): Outbound | null {
  return type === 'anthropic' ? 'anthropic' : type === 'openai' || type === 'grok' ? 'openai' : type === 'gemini' ? 'gemini' : null;
}

/** Same protocol on both sides → bytes pass through (Responses rides on an OpenAI member). */
export const isPassthrough = (inbound: GatewayProtocol, outbound: Outbound) => inbound === outbound || (inbound === 'responses' && outbound === 'openai');

/** The translation directions the spec asks for; everything else is rejected with a clear 400. */
export const TRANSLATIONS = new Set(['anthropic>openai', 'anthropic>gemini', 'openai>anthropic', 'responses>anthropic', 'gemini>anthropic', 'openai>gemini']);
export const supported = (inbound: GatewayProtocol, outbound: Outbound) => isPassthrough(inbound, outbound) || TRANSLATIONS.has(`${inbound}>${outbound}`);

export const PROTOCOL_LABEL: Record<GatewayProtocol, string> = { anthropic: 'Anthropic Messages', openai: 'OpenAI Chat Completions', responses: 'OpenAI Responses', gemini: 'Gemini' };

/**
 * Join a provider base URL with an API path. When the base already ends in a version segment
 * (`…/v1`, `…/api/paas/v4`, `…/v1beta`), the path's own leading version segment is dropped —
 * the usual OpenAI-compatible convention.
 */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const ver = /\/v\d+[a-z0-9]*$/i.test(b);
  const p = ver ? path.replace(/^\/v\d+[a-z0-9]*(?=\/|$|\?)/i, '') : path;
  return b + (p.startsWith('/') || p.startsWith('?') || !p ? p : `/${p}`);
}

export interface InboundCtx { stream: boolean; model?: string } // model: Gemini carries it in the URL

export function parseInbound(inbound: GatewayProtocol, body: any, ctx: InboundCtx): IrRequest {
  if (inbound === 'anthropic') return A.parseRequest(body);
  if (inbound === 'openai') return C.parseRequest(body);
  if (inbound === 'responses') return R.parseRequest(body);
  return G.parseRequest(body, ctx.model ?? '', ctx.stream);
}

/** Outbound request path (relative to the member base) + JSON body. */
export function buildOutbound(outbound: Outbound, r: IrRequest): { path: string; body: any } {
  if (outbound === 'anthropic') return { path: '/v1/messages', body: A.renderRequest(r) };
  if (outbound === 'openai') return { path: '/v1/chat/completions', body: C.renderRequest(r) };
  return { path: G.upstreamPath(r.model, r.stream), body: G.renderRequest(r) };
}

export function parseOutboundResponse(outbound: Outbound, j: any, model: string): IrResponse {
  return outbound === 'anthropic' ? A.parseResponse(j) : outbound === 'openai' ? C.parseResponse(j) : G.parseResponse(j, model);
}

export function renderInboundResponse(inbound: GatewayProtocol, r: IrResponse, model: string, customTools: Set<string>): any {
  if (inbound === 'anthropic') return A.renderResponse(r, model);
  if (inbound === 'openai') return C.renderResponse(r, model);
  if (inbound === 'responses') return R.renderResponse(r, model, customTools);
  return G.renderResponse(r, model);
}

export function outboundStreamParser(outbound: Outbound, model: string): StreamParser {
  return outbound === 'anthropic' ? new A.AnthropicStreamParser() : outbound === 'openai' ? new C.ChatStreamParser() : new G.GeminiStreamParser(model);
}

export function inboundStreamRenderer(inbound: GatewayProtocol, model: string, opts: { includeUsage: boolean; customTools: Set<string> }): StreamRenderer {
  if (inbound === 'anthropic') return new A.AnthropicStreamRenderer(model);
  if (inbound === 'openai') return new C.ChatStreamRenderer(model, opts.includeUsage);
  if (inbound === 'responses') return new R.ResponsesStreamRenderer(model, opts.customTools);
  return new G.GeminiStreamRenderer(model);
}

export function renderInboundError(inbound: GatewayProtocol, status: number, message: string): any {
  return inbound === 'anthropic' ? A.renderError(status, message) : inbound === 'gemini' ? G.renderError(status, message) : C.renderError(status, message);
}

/** Best-effort human message out of an upstream error body (any of the three shapes, or plain text). */
export function upstreamErrorMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error : j?.error;
    const msg = typeof e === 'string' ? e : e?.message ?? j?.message;
    if (msg) return String(msg);
  } catch { /* not json */ }
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Usage carried by one passthrough JSON body / SSE event, in the protocol both sides speak (for the ledger). */
export function sniffUsage(p: GatewayProtocol, j: any): Partial<IrResponse['usage']> | null {
  if (!j || typeof j !== 'object') return null;
  if (p === 'anthropic') { const u = j.message?.usage ?? j.usage; return u ? A.usageIn(u) : null; }
  if (p === 'gemini') return j.usageMetadata ? G.usageIn(j.usageMetadata) : null;
  const u = p === 'responses' ? j.response?.usage ?? j.usage : j.usage;
  return u ? C.usageIn(u) : null;
}
