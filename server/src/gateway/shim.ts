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
//   · logs every call in the ledger (kind 'gateway', via 'shim', under the session's own id `/s/…`).
// Forwards only what ccb needs: POST /v1/chat/completions and GET /v1/models[/<id>].
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
import { CACHE_KEY_MAX, SseLines, addMissing, affinityHeaders, fixChatUsage, insertTopLevelField, isParamRejection, mentionsCacheKey } from './cache.js';
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
    if (!isChat && !(method === 'GET' && /^\/v1\/models(\/[^/]+)?$/.test(rest))) return this.fail(res, 404, `缓存垫片不转发这个接口：${method} ${rest}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > BODY_LIMIT) return this.fail(res, 413, '请求体过大');
      chunks.push(c as Buffer);
    }
    const key = cacheKey ? `cw:${cacheKey}`.slice(0, CACHE_KEY_MAX) : undefined;
    const headers = passthroughHeaders(req.rawHeaders, 'openai', p.apiKey);
    if (key) addMissing(headers, affinityHeaders(key, p.type === 'grok'));
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const ctx: Ctx = { req, res, p, base: openaiBase(p.baseUrl || DEFAULT_BASE[p.type]), rest, search: url.search, raw: Buffer.concat(chunks), headers, sessionId, cacheKey: key, signal: ac.signal, t0: Date.now() };
    let json: any;
    if (isChat) { try { json = JSON.parse(ctx.raw.toString('utf8')); } catch { /* not ours to fix */ } }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return this.forward(ctx);
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
      this.record(ctx, { ok: false, status, model: '', error: e?.message ?? String(e), outbound: url.endsWith('/responses') ? 'responses' : 'openai', stream });
      return null;
    }
  }

  private async remember(p: Provider, patch: Partial<Provider>) {
    await this.deps.meta.upsertProvider({ id: p.id, ...patch }, { mustExist: true }).catch(() => { /* next request tries again */ });
  }

  /** Upstream error: status, rate-limit headers and body back to the client (and a ledger line). */
  private async passError(ctx: Ctx, up: UpstreamResponse, model: string, outbound: Outcome['outbound'], stream: boolean) {
    let text = '';
    try { text = await readText(up.body, 4 * 1024 * 1024); } catch { /* keep empty */ }
    if (!ctx.res.headersSent) ctx.res.writeHead(up.status, { ...errorHeaders(up.headers), 'content-type': String(up.headers['content-type'] ?? 'application/json') }).end(text);
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
    const up = await this.send(ctx, joinUrl(ctx.base, '/v1/chat/completions') + ctx.search, body, bare, stream);
    if (!up) return;
    if ((up.status < 200 || up.status >= 300) && original) {
      up.body.resume();
      if (!ctx.res.headersSent) ctx.res.writeHead(original.status, { ...errorHeaders(original.headers), 'content-type': String(original.headers['content-type'] ?? 'application/json') }).end(original.text);
      return this.record(ctx, { ok: false, status: original.status, model, error: `HTTP ${original.status} ${upstreamErrorMessage(original.text)}（chat/completions 退回也失败：HTTP ${up.status}）`.slice(0, 240), outbound: 'responses', stream });
    }
    if (up.status < 200 || up.status >= 300) return this.passError(ctx, up, model, 'openai', stream);
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
        if (fixChatUsage(j?.usage)) text = JSON.stringify(j);
        usage = C.usageIn(j?.usage);
      } catch { /* not JSON: as is */ }
      res.end(text);
      return this.record(ctx, { ok: true, status: up.status, model, usage, outbound: 'openai', stream, firstByteMs });
    }
    const lines = new SseLines((j) => fixChatUsage(j?.usage));
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

  private brokenBeforeStart(ctx: Ctx, model: string, message: string, stream: boolean, firstByteMs: number) {
    this.fail(ctx.res, 502, message);
    this.record(ctx, { ok: false, status: 502, model, error: message, outbound: 'responses', stream, firstByteMs });
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
      gateway: { group: '缓存垫片', via: 'shim', inbound: 'openai', member: ctx.p.name, memberId: ctx.p.id, outbound: o.outbound, upstreamStatus: o.status, switches: 0, firstByteMs: o.firstByteMs, stream: o.stream },
    });
  }
}
