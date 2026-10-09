// Per-profile prompt-cache shim: `/gateway/~p/<providerId>/k/<cacheKey>[/s/<sessionId>]/v1/…` on the main server.
//
// ccb's OpenAI / Grok clients cannot be configured to send a cache key or extra headers (no defaultHeaders; ccb
// only sets prompt_cache_key for api.openai.com), and relays route requests without one to random channels.
// So an openai / grok profile's Claude session points OPENAI_BASE_URL / GROK_BASE_URL here (providerEnv), and
// the shim, per request:
//   · inserts `prompt_cache_key: "cw:<cacheKey>"` when missing (no other byte of the body changes); an upstream
//     that 400s gets this request again without it, and the profile only remembers (`noPromptCacheKey`) when
//     the error named the field;
//   · adds session-affinity headers (session_id / x-session-affinity; grok: x-grok-conv-id);
//   · rewrites the one usage chunk whose hit count sits only at the top level (DeepSeek prompt_cache_hit_tokens,
//     Kimi cached_tokens) into prompt_tokens_details.cached_tokens — the field ccb reads; the rest passes as is;
//   · for gpt-* on openai profiles (switch `responsesApi`, default on) speaks /v1/responses upstream
//     (store:false + prompt_cache_key + prompt_cache_retention 24h — new-api's default Codex affinity rule
//     routes on the key) and streams the answer back as chat.completion.chunk. A 404 / 405 / 501 / 400 / 5xx
//     there sends this request to chat/completions instead; only "no such endpoint" (404 / 405 / 501, not a
//     model error) followed by a working chat call is remembered (`noResponsesApi`);
//   · a forced tool call (tool_choice naming a tool / "required" — 自动判断's safety check) that a thinking model
//     refuses (official DeepSeek: 400 「Thinking mode does not support this tool_choice」) goes again with
//     `thinking: {type: "disabled"}`; from then on that profile's forced calls go that way (in memory);
//   · logs every call in the ledger (kind 'gateway', via 'shim', under the session's own id `/s/…`).
//   · Codex on an openai profile (providers.agentLaunch) speaks /v1/responses: forwarded as it is, except to a
//     relay without that endpoint (404 / 405 / 501 not about the model — most relays and Chinese vendors): there
//     it goes as chat/completions and comes back as `response.*` events (remembered, like `noResponsesApi` above).
// Forwards only what these need: POST /v1/chat/completions, POST /v1/responses (openai), GET /v1/models[/<id>].
// Independent of the gateway's on/off switch, but like it: loopback only (GatewayService.handle), and the key
// is per profile — HMAC(per-process secret, providerId): minted per process, never stored, one profile's
// session cannot use another profile's credentials through it.
import crypto from 'node:crypto';
import http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import type { MetaStore } from '../meta/store.js';
import type { LedgerEntry, Provider } from '../protocol.js';
import { openaiBase } from '../providers/service.js';
import * as C from './openai-chat.js';
import * as R from './openai-responses.js';
import { DEFAULT_BASE, joinUrl, upstreamErrorMessage } from './convert.js';
import { SseParser } from './sse.js';
import type { IrEvent, IrUsage } from './ir.js';
import { CACHE_KEY_MAX, SseLines, addMissing, affinityHeaders, dropEmptyReasoning, fixChatUsage, forcesTool, insertTopLevelField, isParamRejection, mentionsCacheKey, refusesForcedTool, thinkingOff } from './cache.js';
import { UpstreamError, decoded, errorHeaders, passthroughHeaders, readText, responseHeaders, sendUpstream, waitDrain, withTimeout, type UpstreamResponse } from './upstream.js';

export const SHIM_PREFIX = '/gateway/~p/';
const TIMEOUT_MS = 10 * 60_000; // one upstream, no failover to hurry for: the client's own timeout decides
const IDLE_MS = 5 * 60_000;
const BODY_LIMIT = 64 * 1024 * 1024;
/** Models the shim sends to /v1/responses (profile switch `responsesApi`). */
export const wantsResponses = (model: string) => /^gpt-/i.test(model);
/** Responses retention for the long-retention (openai-type) profiles the shim serves. */
const RETENTION = '24h';
const mentionsRetention = (text: string) => /prompt_cache_retention/i.test(text);
/** /v1/responses statuses that send this one request to chat/completions instead. */
const fallsBack = (s: number) => s === 404 || s === 405 || s === 501 || s === 400 || s === 422 || s >= 500;
/** …and the ones that may mean "this endpoint has no Responses API" (remembered only once chat then works). */
const endpointMissing = (s: number, text: string) => (s === 404 || s === 405 || s === 501) && !/model/i.test(text);

/**
 * An upstream error to the client. OpenAI's SDKs (ccb, Codex) read `error.message`: a relay that answers
 * `{"code":"INSUFFICIENT_BALANCE","message":"…"}` or plain text showed up as "403 status code (no body)" — that body is
 * wrapped as `{error:{message, code}}`; one that already has `error` goes out as it came.
 */
export function clientErrorBody(text: string): string | null {
  let j: any;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  const e = Array.isArray(j) ? j[0]?.error : j?.error;
  if (e && (typeof e === 'string' || e.message)) return null;
  const message = upstreamErrorMessage(text) || 'upstream error (empty body)';
  const code = j && typeof j === 'object' && !Array.isArray(j) && (typeof j.code === 'string' || typeof j.code === 'number') ? String(j.code) : undefined;
  return JSON.stringify({ error: { message, type: 'upstream_error', ...(code ? { code } : {}) } });
}

function sendError(ctx: Ctx, status: number, headers: UpstreamResponse['headers'], text: string) {
  if (ctx.res.headersSent) return;
  const wrapped = clientErrorBody(text);
  ctx.res.writeHead(status, { ...errorHeaders(headers), 'content-type': wrapped !== null ? 'application/json' : String(headers['content-type'] ?? 'application/json') }).end(wrapped ?? text);
}

export interface ShimDeps {
  meta: MetaStore;
  /** Provider profile with its plaintext key (null when missing / undecryptable). */
  member(providerId: string): Provider | null;
  ledger?: { record(e: LedgerEntry): void };
}

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  p: Provider;
  base: string; // upstream base with its version segment
  rest: string; // path below the profile (`/v1/chat/completions`)
  search: string;
  raw: Buffer;
  headers: Record<string, string>;
  /** the session the call belongs to (ledger); a fork's own id while its cache key is the parent's */
  sessionId: string;
  cacheKey?: string;
  signal: AbortSignal;
  t0: number;
  /** prompt_cache_key we put in (for the CW_SHIM_DEBUG line) */
  keyed?: boolean;
}

interface Outcome { ok: boolean; status: number; model: string; usage?: Partial<IrUsage> | null; error?: string; outbound: 'openai' | 'responses'; stream: boolean; firstByteMs?: number }

export class CacheShim {
  private secret = crypto.randomBytes(32);
  /** Profiles whose model refused a forced tool call while thinking: those requests now go with thinking off. */
  private forcedToolsNoThinking = new Set<string>();
  constructor(private deps: ShimDeps) {}

  /** The credential a session of this profile gets in OPENAI_API_KEY / GROK_API_KEY. */
  keyFor(providerId: string): string {
    return `cws-${crypto.createHmac('sha256', this.secret).update(providerId).digest('hex')}`;
  }

  private keyOk(req: http.IncomingMessage, providerId: string): boolean {
    const h = req.headers;
    const bearer = /^Bearer\s+(.+)$/i.exec(String(h.authorization ?? ''))?.[1];
    const want = Buffer.from(this.keyFor(providerId));
    return [bearer, h['x-api-key']].some((v) => { const b = Buffer.from(String(v ?? '').trim()); return b.length === want.length && crypto.timingSafeEqual(b, want); });
  }

  private fail(res: http.ServerResponse, status: number, message: string, extra: Record<string, string> = {}) {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(C.renderError(status, message)));
  }

  async serve(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const m = /^\/gateway\/~p\/([^/]+)(?:\/k\/([^/]*))?(?:\/s\/([^/]*))?(\/.*)?$/.exec(url.pathname);
    if (!m) return this.fail(res, 404, '缓存垫片地址不对');
    let providerId: string, cacheKey: string, sessionId: string;
    try { providerId = decodeURIComponent(m[1]); cacheKey = decodeURIComponent(m[2] ?? ''); sessionId = decodeURIComponent(m[3] ?? '') || cacheKey; } catch { return this.fail(res, 400, '地址编码错误'); }
    if (!this.keyOk(req, providerId)) return this.fail(res, 401, '缓存垫片密钥无效（只接受本进程发给这个供应商的对话的内部密钥）');
    const p = this.deps.member(providerId);
    if (!p || (p.type !== 'openai' && p.type !== 'grok')) return this.fail(res, 404, `没有这个 OpenAI / Grok 型档案：${providerId}`);
    let rest = m[4] ?? '/';
    if (!/^\/v\d/.test(rest)) rest = `/v1${rest === '/' ? '' : rest}`;
    const method = (req.method ?? 'GET').toUpperCase();
    const isChat = method === 'POST' && rest === '/v1/chat/completions';
    // Codex on an openai profile speaks the Responses API (wire_api "responses")
    const isResponses = method === 'POST' && rest === '/v1/responses' && p.type === 'openai';
    if (!isChat && !isResponses && !(method === 'GET' && /^\/v1\/models(\/[^/]+)?$/.test(rest))) return this.fail(res, 404, `缓存垫片不转发这个接口：${method} ${rest}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > BODY_LIMIT) return this.fail(res, 413, '请求体过大');
      chunks.push(c as Buffer);
    }
    const key = cacheKey ? `cw:${cacheKey}`.slice(0, CACHE_KEY_MAX) : undefined;
    const raw = Buffer.concat(chunks);
    let json: any;
    if (isChat || isResponses) { try { json = JSON.parse(raw.toString('utf8')); } catch { /* not ours to fix */ } }
    // the affinity headers name the conversation the way its body does: Codex sends its own prompt_cache_key (the
    // thread id), and a relay should not get two ids for one conversation
    const own = typeof json?.prompt_cache_key === 'string' && json.prompt_cache_key ? json.prompt_cache_key.slice(0, CACHE_KEY_MAX) : undefined;
    const headers = passthroughHeaders(req.rawHeaders, 'openai', p.apiKey);
    if (own ?? key) addMissing(headers, affinityHeaders((own ?? key)!, p.type === 'grok'));
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const ctx: Ctx = { req, res, p, base: openaiBase(p.baseUrl || DEFAULT_BASE[p.type]), rest, search: url.search, raw, headers, sessionId, cacheKey: key, signal: ac.signal, t0: Date.now() };
    if (!json || typeof json !== 'object' || Array.isArray(json)) return this.forward(ctx);
    if (isResponses) return p.noResponsesApi ? this.responsesViaChat(ctx, json) : this.responses(ctx, json);
    if (p.type === 'openai' && p.responsesApi !== false && !p.noResponsesApi && wantsResponses(String(json.model ?? ''))) return this.viaResponses(ctx, json);
    return this.chat(ctx, json);
  }

  /** The model list (or a chat body we cannot parse): bytes both ways, credential swapped. */
  private async forward(ctx: Ctx) {
    let up: UpstreamResponse;
    try {
      up = await sendUpstream(joinUrl(ctx.base, ctx.rest) + ctx.search, { method: ctx.req.method ?? 'GET', headers: ctx.headers, body: ctx.raw.length ? ctx.raw : undefined, signal: ctx.signal, headerTimeoutMs: TIMEOUT_MS });
    } catch (e: any) {
      if (!ctx.signal.aborted) this.fail(ctx.res, e instanceof UpstreamError && e.timeout ? 504 : 502, e?.message ?? String(e));
      return;
    }
    ctx.res.writeHead(up.status, responseHeaders(up.headers));
    up.body.pipe(ctx.res);
  }

  /**
   * One upstream request. A body we decorated (prompt_cache_key / prompt_cache_retention) that the upstream
   * refuses with 400 / 422 is sent once more undecorated; the profile stops getting a field only when the
   * error named it — a retry that happens to work proves nothing (the 400 may have been about anything).
   */
  private async send(ctx: Ctx, url: string, body: Buffer, bare: Buffer | null, stream: boolean): Promise<UpstreamResponse | null> {
    try {
      let up = await sendUpstream(url, { method: 'POST', headers: ctx.headers, body, signal: ctx.signal, headerTimeoutMs: TIMEOUT_MS });
      if (bare && isParamRejection(up.status)) {
        let text = '';
        try { text = await readText(up.body, 1024 * 1024); } catch { /* keep empty */ }
        const learned: Partial<Provider> = {};
        if (mentionsCacheKey(text)) learned.noPromptCacheKey = true;
        if (mentionsRetention(text)) learned.noCacheRetention = true;
        if (Object.keys(learned).length) await this.remember(ctx.p, learned);
        up = await sendUpstream(url, { method: 'POST', headers: ctx.headers, body: bare, signal: ctx.signal, headerTimeoutMs: TIMEOUT_MS });
      }
      return up;
    } catch (e: any) {
      if (ctx.signal.aborted) return null;
      const status = e instanceof UpstreamError && e.timeout ? 504 : 502;
      this.fail(ctx.res, status, e?.message ?? String(e));
      let model = ''; // the ledger row names the model like every other row (only parsed on this path)
      try { model = String(JSON.parse(body.toString('utf8'))?.model ?? ''); } catch { /* not JSON */ }
      this.record(ctx, { ok: false, status, model, error: e?.message ?? String(e), outbound: url.endsWith('/responses') ? 'responses' : 'openai', stream });
      return null;
    }
  }

  private async remember(p: Provider, patch: Partial<Provider>) {
    await this.deps.meta.upsertProvider({ id: p.id, ...patch }, { mustExist: true }).catch(() => { /* next request tries again */ });
  }

  /** Upstream error: status, rate-limit headers and body back to the client (and a ledger line). `read`: the body, already read. */
  private async passError(ctx: Ctx, up: UpstreamResponse, model: string, outbound: Outcome['outbound'], stream: boolean, read?: string) {
    let text = read ?? '';
    if (read === undefined) { try { text = await readText(up.body, 4 * 1024 * 1024); } catch { /* keep empty */ } }
    sendError(ctx, up.status, up.headers, text);
    this.record(ctx, { ok: false, status: up.status, model, error: `HTTP ${up.status} ${upstreamErrorMessage(text)}`.slice(0, 200), outbound, stream });
  }

  /**
   * chat/completions as the client sent it (+ prompt_cache_key); only the usage chunk may change on the way back.
   * Streaming or not is what the REQUEST asked for (relays mislabel SSE as text/plain or JSON). `onOk`: runs once
   * the upstream answered 2xx (the Responses fallback remembers a missing endpoint only then). `original`: the
   * Responses error this fallback is for — when chat fails too, that is the error the client sees (a model error
   * from /v1/responses says more than "no such route" from chat/completions).
   */
  private async chat(ctx: Ctx, json: any, onOk?: () => Promise<void>, original?: { status: number; headers: http.IncomingHttpHeaders; text: string }) {
    const model = String(json.model ?? '');
    const stream = !!json.stream;
    let body = ctx.raw;
    let bare: Buffer | null = null;
    ctx.keyed = false;
    if (ctx.cacheKey && !ctx.p.noPromptCacheKey && json.prompt_cache_key === undefined) {
      const s = insertTopLevelField(ctx.raw.toString('utf8'), 'prompt_cache_key', ctx.cacheKey);
      if (s) { bare = ctx.raw; body = Buffer.from(s); ctx.keyed = true; }
    }
    // a forced tool call (自动判断's safety check) to a model that only takes one with thinking off
    const forced = forcesTool(json) && json.thinking?.type !== 'disabled';
    const off = (b: Buffer) => { const s = thinkingOff(b.toString('utf8')); return s ? Buffer.from(s) : b; };
    if (forced && this.forcedToolsNoThinking.has(ctx.p.id)) { body = off(body); if (bare) bare = off(bare); }
    const url = joinUrl(ctx.base, '/v1/chat/completions') + ctx.search;
    let up = await this.send(ctx, url, body, bare, stream);
    if (!up) return;
    let read: string | undefined;
    if (forced && !this.forcedToolsNoThinking.has(ctx.p.id) && isParamRejection(up.status)) {
      read = '';
      try { read = await readText(up.body, 1024 * 1024); } catch { /* keep empty */ }
      if (refusesForcedTool(read)) {
        this.forcedToolsNoThinking.add(ctx.p.id);
        read = undefined;
        up = await this.send(ctx, url, off(body), bare && off(bare), stream);
        if (!up) return;
      }
    }
    if ((up.status < 200 || up.status >= 300) && original) {
      up.body.resume();
      sendError(ctx, original.status, original.headers, original.text);
      return this.record(ctx, { ok: false, status: original.status, model, error: `HTTP ${original.status} ${upstreamErrorMessage(original.text)}（chat/completions 退回也失败：HTTP ${up.status}）`.slice(0, 240), outbound: 'responses', stream });
    }
    if (up.status < 200 || up.status >= 300) return this.passError(ctx, up, model, 'openai', stream, read);
    await onOk?.();
    const firstByteMs = Date.now() - ctx.t0;
    const { res } = ctx;
    // decoded on our side: the one line we may rewrite has to be readable (the local hop is uncompressed)
    const headers = responseHeaders(up.headers);
    delete headers['content-encoding'];
    delete headers['content-length'];
    res.writeHead(up.status, headers);
    const src = decoded(up.body);
    let usage: Partial<IrUsage> | null = null;
    if (!stream) {
      let text = '';
      try {
        const bufs: Buffer[] = [];
        for await (const c of src) bufs.push(c as Buffer);
        text = Buffer.concat(bufs).toString('utf8');
        const j = JSON.parse(text);
        if (Number(fixChatUsage(j?.usage)) | Number(dropEmptyReasoning(j))) text = JSON.stringify(j);
        usage = C.usageIn(j?.usage);
      } catch { /* not JSON: as is */ }
      res.end(text);
      return this.record(ctx, { ok: true, status: up.status, model, usage, outbound: 'openai', stream, firstByteMs });
    }
    const lines = new SseLines((j) => (Number(fixChatUsage(j?.usage)) | Number(dropEmptyReasoning(j))) !== 0);
    const sniff = new SseParser();
    const dec = new StringDecoder('utf8');
    const take = (text: string) => { for (const e of sniff.feed(text)) if (e.data.includes('"usage"')) { try { const j = JSON.parse(e.data); if (j?.usage) usage = C.usageIn(j.usage); } catch { /* skip */ } } };
    const it = src[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let broken = '';
    for (;;) {
      if (ctx.signal.aborted) break;
      let r: IteratorResult<Buffer>;
      try { r = await withTimeout(it.next(), IDLE_MS); } catch (e: any) { broken = e?.message === 'timeout' ? '上游超过 5 分钟没有数据' : e?.message ?? String(e); up.body.destroy(); break; }
      if (r.done) break;
      const out = lines.push(dec.write(r.value));
      if (!out) continue;
      take(out);
      if (!res.write(out)) await waitDrain(res, ctx.signal);
    }
    if (ctx.signal.aborted) { up.body.destroy(); res.destroy(); return this.record(ctx, { ok: false, status: 499, model, usage, error: '客户端已断开', outbound: 'openai', stream, firstByteMs }); }
    const tail = lines.push(dec.end()) + lines.end();
    take(tail);
    for (const e of sniff.end()) if (e.data.includes('"usage"')) { try { usage = C.usageIn(JSON.parse(e.data).usage); } catch { /* skip */ } }
    if (broken) { res.destroy(); return this.record(ctx, { ok: false, status: 502, model, usage, error: broken, outbound: 'openai', stream, firstByteMs }); }
    res.end(tail || undefined);
    this.record(ctx, { ok: true, status: up.status, model, usage, outbound: 'openai', stream, firstByteMs });
  }

  /** gpt-*: the same conversation as a Responses request; the answer streamed back in chat.completion.chunk shape. */
  private async viaResponses(ctx: Ctx, json: any) {
    const model = String(json.model ?? '');
    const stream = !!json.stream;
    const ir = { ...C.parseRequest(json), model, stream };
    const key = ctx.p.noPromptCacheKey ? undefined : ctx.cacheKey;
    const retention = ctx.p.noCacheRetention ? undefined : RETENTION;
    const build = (decorate: boolean) => {
      const b = R.renderRequest(ir, decorate ? { cacheKey: key, retention, store: false } : { store: false });
      if (typeof json.reasoning_effort === 'string') b.reasoning = { effort: json.reasoning_effort };
      return Buffer.from(JSON.stringify(b));
    };
    ctx.keyed = !!key;
    const up = await this.send(ctx, joinUrl(ctx.base, '/v1/responses') + ctx.search, build(true), key || retention ? build(false) : null, stream);
    if (!up) return;
    if (fallsBack(up.status)) {
      // this one request goes to chat/completions; "no such endpoint" is remembered only if chat then works
      let text = '';
      try { text = await readText(up.body, 1024 * 1024); } catch { /* keep empty */ }
      const missing = endpointMissing(up.status, text);
      if (missing) return this.chat(ctx, json, () => this.remember(ctx.p, { noResponsesApi: true }));
      return this.chat(ctx, json, undefined, { status: up.status, headers: up.headers, text });
    }
    if (up.status < 200 || up.status >= 300) return this.passError(ctx, up, model, 'responses', stream);
    const firstByteMs = Date.now() - ctx.t0;
    const { res } = ctx;
    const usage: Partial<IrUsage> = {};
    let failed = ''; // an error event inside a 200 stream (response.failed)
    // the request decides; a relay that answers a stream request with one JSON object is replayed as a stream
    if (!stream || /application\/json/i.test(String(up.headers['content-type'] ?? ''))) {
      let text = '';
      try { text = await readText(up.body); } catch (e: any) { return this.brokenBeforeStart(ctx, model, e?.message ?? String(e), stream, firstByteMs); }
      let resp;
      try { resp = R.parseResponse(JSON.parse(text)); } catch { return this.brokenBeforeStart(ctx, model, `上游返回的不是 JSON：${text.slice(0, 120)}`, stream, firstByteMs); }
      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(C.renderResponse(resp, model)));
      } else {
        const renderer = new C.ChatStreamRenderer(model, !!json.stream_options?.include_usage);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(R.irEvents(resp).map((e) => renderer.push(e)).join('') + renderer.end());
      }
      return this.record(ctx, { ok: true, status: up.status, model, usage: resp.usage, outbound: 'responses', stream, firstByteMs });
    }
    const parser = new R.ResponsesStreamParser();
    const renderer = new C.ChatStreamRenderer(model, !!json.stream_options?.include_usage);
    const sse = new SseParser();
    const dec = new StringDecoder('utf8');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const emit = async (evs: IrEvent[]) => {
      if (ctx.signal.aborted) return;
      let out = '';
      for (const e of evs) {
        if (e.t === 'usage') Object.assign(usage, e.usage);
        else if (e.t === 'error') failed ||= e.message;
        out += renderer.push(e);
      }
      if (out && !res.write(out)) await waitDrain(res, ctx.signal);
    };
    const it = decoded(up.body)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let broken = '';
    for (;;) {
      if (ctx.signal.aborted) break;
      let r: IteratorResult<Buffer>;
      try { r = await withTimeout(it.next(), IDLE_MS); } catch (e: any) { broken = e?.message === 'timeout' ? '上游超过 5 分钟没有数据' : e?.message ?? String(e); up.body.destroy(); break; }
      if (r.done) break;
      for (const ev of sse.feed(dec.write(r.value))) await emit(parser.feed(ev));
    }
    if (ctx.signal.aborted) { up.body.destroy(); res.destroy(); return this.record(ctx, { ok: false, status: 499, model, usage, error: '客户端已断开', outbound: 'responses', stream, firstByteMs }); }
    if (broken) await emit([{ t: 'error', message: broken }]);
    else { for (const ev of sse.feed(dec.end())) await emit(parser.feed(ev)); for (const ev of sse.end()) await emit(parser.feed(ev)); await emit(parser.end()); }
    res.end(renderer.end() || undefined);
    this.record(ctx, { ok: !broken && !failed, status: broken ? 502 : up.status, model, usage, error: broken || failed || undefined, outbound: 'responses', stream, firstByteMs });
  }

  /**
   * Codex's /v1/responses, forwarded as it is (+ prompt_cache_key when it sent none). A relay without the Responses
   * API (404 / 405 / 501 that is not about the model — most Chinese relays and vendors only have chat/completions)
   * gets this request as chat/completions instead, and once that works the profile remembers it (`noResponsesApi`):
   * later requests are translated straight away.
   */
  private async responses(ctx: Ctx, json: any) {
    const model = String(json.model ?? '');
    const stream = !!json.stream;
    let body = ctx.raw;
    let bare: Buffer | null = null;
    ctx.keyed = false;
    if (ctx.cacheKey && !ctx.p.noPromptCacheKey && json.prompt_cache_key === undefined) {
      const s = insertTopLevelField(ctx.raw.toString('utf8'), 'prompt_cache_key', ctx.cacheKey);
      if (s) { bare = ctx.raw; body = Buffer.from(s); ctx.keyed = true; }
    } else ctx.keyed = json.prompt_cache_key !== undefined;
    const up = await this.send(ctx, joinUrl(ctx.base, '/v1/responses') + ctx.search, body, bare, stream);
    if (!up) return;
    if (up.status < 200 || up.status >= 300) {
      let text = '';
      try { text = await readText(up.body, 4 * 1024 * 1024); } catch { /* keep empty */ }
      if (endpointMissing(up.status, text)) return this.responsesViaChat(ctx, json, () => this.remember(ctx.p, { noResponsesApi: true }), { status: up.status, headers: up.headers, text });
      sendError(ctx, up.status, up.headers, text);
      return this.record(ctx, { ok: false, status: up.status, model, error: `HTTP ${up.status} ${upstreamErrorMessage(text)}`.slice(0, 200), outbound: 'responses', stream });
    }
    const firstByteMs = Date.now() - ctx.t0;
    const { res } = ctx;
    const headers = responseHeaders(up.headers);
    delete headers['content-encoding'];
    delete headers['content-length'];
    res.writeHead(up.status, headers);
    const src = decoded(up.body);
    let usage: Partial<IrUsage> | null = null;
    // the usage for the ledger: the `response` of response.completed (stream) or the object itself
    const usageOf = (r: any) => { if (r?.usage) usage = C.usageIn(r.usage); };
    const sniff = new SseParser();
    const dec = new StringDecoder('utf8');
    const it = src[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let whole = '';
    let broken = '';
    // Codex hangs up once it has response.completed; a relay that keeps the stream open a moment longer must not
    // turn that answered call into a 499 in the ledger
    let answered = false;
    for (;;) {
      if (ctx.signal.aborted) break;
      let r: IteratorResult<Buffer>;
      try { r = await withTimeout(it.next(), IDLE_MS); } catch (e: any) { broken = e?.message === 'timeout' ? '上游超过 5 分钟没有数据' : e?.message ?? String(e); up.body.destroy(); break; }
      if (r.done) break;
      if (stream) {
        for (const e of sniff.feed(dec.write(r.value))) {
          if (/"type"\s*:\s*"response\.(completed|incomplete)"/.test(e.data)) answered = true;
          if (e.data.includes('"usage"')) { try { usageOf(JSON.parse(e.data)?.response); } catch { /* skip */ } }
        }
      } else if (whole.length < 8 * 1024 * 1024) whole += dec.write(r.value);
      if (!res.write(r.value)) await waitDrain(res, ctx.signal);
    }
    if (ctx.signal.aborted) {
      up.body.destroy(); res.destroy();
      return this.record(ctx, answered ? { ok: true, status: up.status, model, usage, outbound: 'responses', stream, firstByteMs } : { ok: false, status: 499, model, usage, error: '客户端已断开', outbound: 'responses', stream, firstByteMs });
    }
    if (!stream) { try { usageOf(JSON.parse(whole + dec.end())); } catch { /* not JSON */ } }
    if (broken) { res.destroy(); return this.record(ctx, { ok: false, status: 502, model, usage, error: broken, outbound: 'responses', stream, firstByteMs }); }
    res.end();
    this.record(ctx, { ok: true, status: up.status, model, usage, outbound: 'responses', stream, firstByteMs });
  }

  /**
   * A Responses request (Codex) as chat/completions for a relay that only has that, the answer back in Responses
   * shape — streamed as `response.*` events. Reasoning items (encrypted, provider-bound) are dropped; Codex's
   * freeform tools (apply_patch) go as a function with one `input` string and come back as custom_tool_call.
   * `onOk` runs once chat answered 2xx; `original`: the Responses error this is a fallback for — when chat fails
   * too, that is what Codex sees.
   */
  private async responsesViaChat(ctx: Ctx, json: any, onOk?: () => Promise<void>, original?: { status: number; headers: http.IncomingHttpHeaders; text: string }) {
    const model = String(json.model ?? '');
    const stream = !!json.stream;
    const ir = R.parseRequest(json);
    const customTools = new Set((ir.tools ?? []).filter((t) => t.custom).map((t) => t.name));
    const key = typeof json.prompt_cache_key === 'string' && json.prompt_cache_key ? json.prompt_cache_key : ctx.cacheKey;
    const build = (decorate: boolean) => {
      const b = C.renderRequest({ ...ir, model, stream, cacheKey: key }, { promptCacheKey: decorate && !!key });
      // o-series / gpt-5 on a chat-only relay: the effort Codex asked for, in chat's field
      const effort = json.reasoning?.effort;
      if (typeof effort === 'string' && C.wantsCompletionTokens(model)) b.reasoning_effort = effort;
      return Buffer.from(JSON.stringify(b));
    };
    ctx.keyed = !!key && !ctx.p.noPromptCacheKey;
    const up = await this.send(ctx, joinUrl(ctx.base, '/v1/chat/completions') + ctx.search, build(ctx.keyed), ctx.keyed ? build(false) : null, stream);
    if (!up) return;
    if (up.status < 200 || up.status >= 300) {
      if (original) {
        up.body.resume();
        sendError(ctx, original.status, original.headers, original.text);
        return this.record(ctx, { ok: false, status: original.status, model, error: `HTTP ${original.status} ${upstreamErrorMessage(original.text)}（chat/completions 退回也失败：HTTP ${up.status}）`.slice(0, 240), outbound: 'openai', stream });
      }
      return this.passError(ctx, up, model, 'openai', stream);
    }
    await onOk?.();
    const firstByteMs = Date.now() - ctx.t0;
    const { res } = ctx;
    const renderer = new R.ResponsesStreamRenderer(model, customTools);
    // the request decides; a relay answering a stream request with one JSON object is replayed as a stream
    if (!stream || /application\/json/i.test(String(up.headers['content-type'] ?? ''))) {
      let text = '';
      try { text = await readText(up.body); } catch (e: any) { return this.brokenBeforeStart(ctx, model, e?.message ?? String(e), stream, firstByteMs, 'openai'); }
      let resp;
      try { resp = C.parseResponse(JSON.parse(text)); } catch { return this.brokenBeforeStart(ctx, model, `上游返回的不是 JSON：${text.slice(0, 120)}`, stream, firstByteMs, 'openai'); }
      if (!stream) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(R.renderResponse(resp, model, customTools)));
      else {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(R.irEvents(resp).map((e) => renderer.push(e)).join('') + renderer.end());
      }
      return this.record(ctx, { ok: true, status: up.status, model, usage: resp.usage, outbound: 'openai', stream, firstByteMs });
    }
    const parser = new C.ChatStreamParser();
    const sse = new SseParser();
    const dec = new StringDecoder('utf8');
    const usage: Partial<IrUsage> = {};
    let failed = '';
    // response.completed went out (on the chat stream's end); Codex hanging up after it is not a 499
    let answered = false;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const emit = async (evs: IrEvent[]) => {
      if (ctx.signal.aborted) return;
      let out = '';
      for (const e of evs) {
        if (e.t === 'usage') Object.assign(usage, e.usage);
        else if (e.t === 'error') failed ||= e.message;
        else if (e.t === 'end') answered = true;
        out += renderer.push(e);
      }
      if (out && !res.write(out)) await waitDrain(res, ctx.signal);
    };
    const it = decoded(up.body)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let broken = '';
    for (;;) {
      if (ctx.signal.aborted) break;
      let r: IteratorResult<Buffer>;
      try { r = await withTimeout(it.next(), IDLE_MS); } catch (e: any) { broken = e?.message === 'timeout' ? '上游超过 5 分钟没有数据' : e?.message ?? String(e); up.body.destroy(); break; }
      if (r.done) break;
      for (const ev of sse.feed(dec.write(r.value))) await emit(parser.feed(ev));
    }
    if (ctx.signal.aborted) {
      up.body.destroy(); res.destroy();
      return this.record(ctx, answered && !failed ? { ok: true, status: up.status, model, usage, outbound: 'openai', stream, firstByteMs } : { ok: false, status: 499, model, usage, error: '客户端已断开', outbound: 'openai', stream, firstByteMs });
    }
    if (broken) await emit([{ t: 'error', message: broken }]);
    else { for (const ev of sse.feed(dec.end())) await emit(parser.feed(ev)); for (const ev of sse.end()) await emit(parser.feed(ev)); await emit(parser.end()); }
    res.end(renderer.end() || undefined);
    this.record(ctx, { ok: !broken && !failed, status: broken ? 502 : up.status, model, usage, error: broken || failed || undefined, outbound: 'openai', stream, firstByteMs });
  }

  private brokenBeforeStart(ctx: Ctx, model: string, message: string, stream: boolean, firstByteMs: number, outbound: Outcome['outbound'] = 'responses') {
    this.fail(ctx.res, 502, message);
    this.record(ctx, { ok: false, status: 502, model, error: message, outbound, stream, firstByteMs });
  }

  private record(ctx: Ctx, o: Outcome) {
    const u = o.usage ?? {};
    // one line per call for checking a real relay (no secrets: profile name, key presence, status, token counts)
    if (process.env.CW_SHIM_DEBUG) {
      const all = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      console.error(`[shim] ${ctx.p.name} ${o.outbound} ${o.model} status=${o.status} key=${ctx.keyed ? (ctx.cacheKey ?? '') : '-'} in=${u.input ?? 0} read=${u.cacheRead ?? 0} write=${u.cacheWrite ?? 0} hit=${all ? Math.round(((u.cacheRead ?? 0) / all) * 100) : 0}%${o.error ? ` err=${o.error.slice(0, 120)}` : ''}`);
    }
    this.deps.ledger?.record({
      ts: Date.now(),
      sessionId: ctx.sessionId,
      model: o.model,
      durationMs: Date.now() - ctx.t0,
      apiMs: o.firstByteMs,
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      costUsd: 0,
      costUnknown: true,
      ok: o.ok,
      error: o.error,
      providerId: ctx.p.id,
      kind: 'gateway',
      gateway: { group: '缓存垫片', via: 'shim', inbound: ctx.rest === '/v1/responses' ? 'responses' : 'openai', member: ctx.p.name, memberId: ctx.p.id, outbound: o.outbound, upstreamStatus: o.status, switches: 0, firstByteMs: o.firstByteMs, stream: o.stream },
    });
  }
}
