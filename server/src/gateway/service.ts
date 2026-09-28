// Model gateway: /gateway/<groupId>/… on the main HTTP server (loopback only). Speaks Anthropic, OpenAI
// (Chat Completions + Responses) and Gemini to agents, routes each request through a failover group of
// provider profiles, passes same-protocol traffic through byte for byte, and translates across protocols.
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { MetaStore } from '../meta/store.js';
import type { SecretService } from '../secrets/service.js';
import type { LedgerEntry, Provider } from '../protocol.js';
import type { GatewayGroup, GatewayMember, GatewayMemberState, GatewayProtocol, GatewayStatus, GatewayTestResult } from './types.js';
import { MemberStates, classify, mapModel } from './failover.js';
import { estimateTokens, type IrEvent, type IrRequest, type IrUsage } from './ir.js';
import { SseParser } from './sse.js';
import {
  DEFAULT_BASE, PROTOCOL_LABEL, buildOutbound, inboundStreamRenderer, isPassthrough, joinUrl, outboundOf, outboundStreamParser, parseInbound,
  parseOutboundResponse, renderInboundError, renderInboundResponse, sniffUsage, supported, upstreamErrorMessage, type Outbound, type OutboundOpts,
} from './convert.js';
import { CACHE_KEY_MAX, addMissing, affinityHeaders, cacheKeyOf, isParamRejection, mentionsCacheKey } from './cache.js';
import { CacheShim, SHIM_PREFIX } from './shim.js';
import { UpstreamError, decoded, decoder, errorHeaders, passthroughHeaders, readText, replaceTopLevelString, responseHeaders, sendUpstream, translatedHeaders, waitDrain, withTimeout, type UpstreamResponse } from './upstream.js';

/** Streaming: time from sending a request to the first body byte before the member counts as failed. */
export const FIRST_BYTE_MS = 60_000;
/** Non-streaming: the whole answer comes at once, so a long generation legitimately takes minutes. */
export const NONSTREAM_MS = 10 * 60_000;
/** After the response started: silence this long ends the stream with an error. */
const IDLE_MS = 5 * 60_000;
const BODY_LIMIT = 64 * 1024 * 1024;

export interface GatewayDeps {
  meta: MetaStore;
  secrets?: SecretService;
  /** Provider profile with its plaintext key (null when missing / undecryptable). */
  member(providerId: string): Provider | null;
  ledger?: { record(e: LedgerEntry): void };
  firstByteMs?: number; // tests
  nonStreamMs?: number; // tests
}

type Op = 'generate' | 'count' | 'models';
interface Route { inbound: GatewayProtocol; op: Op; stream: boolean; model?: string; action?: string }

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  group: GatewayGroup;
  route: Route;
  path: string; // normalized path below the group (`/v1/messages`)
  search: string; // query string without our `key`
  raw: Buffer;
  json: any;
  ir?: IrRequest; // lazily parsed for translation
  model: string; // what the client asked for
  signal: AbortSignal;
  t0: number;
  customTools: Set<string>;
}

type Attempt =
  | { kind: 'done'; status: number; usage: IrUsage | null; firstByteMs: number; model: string }
  | { kind: 'final'; status: number; text: string; headers: http.IncomingHttpHeaders; passthrough: boolean; model: string }
  | { kind: 'switch'; status: number; message: string; text?: string; headers?: http.IncomingHttpHeaders; passthrough: boolean; model: string }
  | { kind: 'broken'; status: number; message: string; firstByteMs: number; model: string } // failed after committing
  | { kind: 'aborted'; status: 499; message: string; firstByteMs?: number; model: string }; // the client went away

const isLoopback = (a: string | undefined) => !!a && (a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.'));
const newKey = () => `cwg-${crypto.randomBytes(24).toString('hex')}`;
export const maskGatewayKey = (k: string) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '');

/** Recognize the inbound API from the path below the group. */
export function routeOf(method: string, path: string, headers: http.IncomingHttpHeaders): Route | null {
  const m = method.toUpperCase();
  if (m === 'POST' && path === '/v1/messages') return { inbound: 'anthropic', op: 'generate', stream: false };
  if (m === 'POST' && path === '/v1/messages/count_tokens') return { inbound: 'anthropic', op: 'count', stream: false };
  if (m === 'POST' && path === '/v1/chat/completions') return { inbound: 'openai', op: 'generate', stream: false };
  if (m === 'POST' && path === '/v1/responses') return { inbound: 'responses', op: 'generate', stream: false };
  if (m === 'GET' && path === '/v1/models') return { inbound: headers['anthropic-version'] ? 'anthropic' : 'openai', op: 'models', stream: false };
  if (m === 'GET' && path === '/v1beta/models') return { inbound: 'gemini', op: 'models', stream: false };
  const g = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/.exec(path);
  if (g && m === 'POST') {
    const model = decodeURIComponent(g[1]);
    if (g[2] === 'countTokens') return { inbound: 'gemini', op: 'count', stream: false, model, action: g[2] };
    return { inbound: 'gemini', op: 'generate', stream: g[2] === 'streamGenerateContent', model, action: g[2] };
  }
  return null;
}

export class GatewayService extends EventEmitter {
  /** Main server port; set once listening (desktop mode picks a new one every start). */
  port = 0;
  readonly states = new MemberStates();
  /** openai / grok profiles' prompt-cache shim (/gateway/~p/…): works whether or not the gateway is enabled */
  readonly shim: CacheShim;
  private key = '';
  private firstByteMs: number;
  private nonStreamMs: number;

  constructor(private deps: GatewayDeps) {
    super();
    this.firstByteMs = deps.firstByteMs ?? FIRST_BYTE_MS;
    this.nonStreamMs = deps.nonStreamMs ?? NONSTREAM_MS;
    this.shim = new CacheShim({ meta: deps.meta, member: deps.member, ledger: deps.ledger });
  }

  /** Decrypt the stored key (startup). */
  async init() {
    const c = this.deps.meta.gatewayConfig();
    if (!c.key) return;
    try { this.key = this.deps.secrets ? await this.deps.secrets.reveal(c.key) : c.key; } catch (e) { console.error('[gateway] cannot decrypt key:', (e as Error).message); }
  }

  enabled() { return !!this.deps.meta.gatewayConfig().enabled && !!this.key; }
  baseUrl() { return `http://127.0.0.1:${this.port}/gateway`; }
  groups() { return this.deps.meta.gatewayGroups(); }
  group(id: string) { return this.groups().find((g) => g.id === id); }

  /** Endpoint + credential a gateway provider profile resolves to, or null (disabled / unknown group). */
  endpoint(groupId: string): { baseUrl: string; key: string; runtime?: 'claude' } | null {
    const g = this.group(groupId);
    if (!this.enabled() || !this.port || !g) return null;
    return { baseUrl: `${this.baseUrl()}/${groupId}`, key: this.key, runtime: this.needsOfficialClient(g) ? 'claude' : undefined };
  }

  /** The cache shim's base for a profile (the session appends `/k/<key>[/s/<id>]/v1`) + its per-profile key; null before listening. */
  shimEndpoint(providerId: string): { base: string; key: string } | null {
    return this.port ? { base: `${this.baseUrl()}/~p/${encodeURIComponent(providerId)}`, key: this.shim.keyFor(providerId) } : null;
  }

  /**
   * A group that passes Claude Code through to a relay which only accepts the official client (an
   * Anthropic member marked runtime:'claude') must be fed by the official binary too — ccb's request
   * shape is rejected by that relay's fingerprint check just the same through the gateway.
   */
  needsOfficialClient(g: GatewayGroup): boolean {
    return g.members.some((m) => { const p = this.deps.meta.provider(m.providerId); return p?.type === 'anthropic' && p.runtime === 'claude'; });
  }

  status(): GatewayStatus {
    const states: Record<string, GatewayMemberState[]> = {};
    const now = Date.now();
    for (const g of this.groups()) {
      states[g.id] = g.members.map((m) => {
        const p = this.deps.meta.provider(m.providerId);
        const s = this.states.peek(g.id, m.providerId);
        const health = !p ? 'disabled' : s?.disabled ? 'disabled' : s && s.cooldownUntil > now ? 'cooling' : s?.lastOkAt ? 'ok' : 'unknown';
        return { providerId: m.providerId, name: p?.name ?? '(已删除的供应商)', type: p?.type ?? '', health, cooldownUntil: s && s.cooldownUntil > now ? s.cooldownUntil : undefined, strikes: s?.strikes ?? 0, lastError: !p ? '供应商不存在' : s?.lastError, lastStatus: s?.lastStatus, lastOkAt: s?.lastOkAt, lastUsedAt: s?.lastUsedAt };
      });
    }
    return { enabled: this.enabled(), baseUrl: this.baseUrl(), keyMasked: maskGatewayKey(this.key), groups: this.groups(), states };
  }

  private async storeKey(k: string) {
    this.key = k;
    this.deps.meta.gatewayConfig().key = this.deps.secrets ? await this.deps.secrets.protect(k, 'gateway') : k;
  }

  async setEnabled(on: boolean) {
    if (on && !this.key) await this.storeKey(newKey()); // generated on first enable
    this.deps.meta.gatewayConfig().enabled = on;
    await this.deps.meta.saveGateway();
    this.emit('changed');
  }
  async regenerateKey() {
    await this.storeKey(newKey());
    await this.deps.meta.saveGateway();
    this.emit('changed');
  }
  revealKey() { return this.key; }

  async upsertGroup(patch: Partial<GatewayGroup> & { id?: string }): Promise<GatewayGroup> {
    const list = this.groups();
    let g = patch.id ? list.find((x) => x.id === patch.id) : undefined;
    if (!g) {
      g = { id: patch.id && /^[A-Za-z0-9_-]{1,40}$/.test(patch.id) ? patch.id : crypto.randomBytes(4).toString('hex'), name: '新组', members: [], strategy: 'failover' };
      list.push(g);
    }
    if (patch.name !== undefined) g.name = String(patch.name).trim() || g.name;
    if (patch.strategy) g.strategy = patch.strategy === 'round-robin' ? 'round-robin' : 'failover';
    if (patch.members) {
      const seen = new Set<string>();
      g.members = patch.members.filter((m) => m?.providerId && !seen.has(m.providerId) && seen.add(m.providerId)).map((m) => ({ providerId: m.providerId, ...(m.model?.trim() ? { model: m.model.trim() } : {}), ...(m.weight && m.weight !== 1 ? { weight: Math.max(1, Math.floor(m.weight)) } : {}) }));
    }
    if (patch.modelMap !== undefined) g.modelMap = Object.fromEntries(Object.entries(patch.modelMap ?? {}).map(([k, v]) => [k.trim(), String(v).trim()]).filter(([k, v]) => k && v));
    if (patch.cache1h !== undefined) { if (patch.cache1h) g.cache1h = true; else delete g.cache1h; }
    this.states.reset(g.id); // edited group: disabled members get another chance
    await this.deps.meta.saveGateway();
    this.emit('changed');
    return g;
  }
  async removeGroup(id: string) {
    const m = this.deps.meta;
    m.data.gatewayGroups = this.groups().filter((g) => g.id !== id);
    this.states.reset(id);
    await m.saveGateway();
    this.emit('changed');
  }
  reset(groupId: string, providerId?: string) {
    this.states.reset(groupId, providerId);
    this.emit('changed');
  }

  // ---------------------------------------------------------------- HTTP

  /** True when the request belongs to the gateway (it has then been answered). */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    if (url.pathname !== '/gateway' && !url.pathname.startsWith('/gateway/')) return false;
    // never reachable from the LAN listener (nor from anything that is not this machine)
    if ((req.socket as any).cwRemote || !isLoopback(req.socket.remoteAddress)) { res.writeHead(404).end(); return true; }
    if (url.pathname.startsWith(SHIM_PREFIX)) {
      void this.shim.serve(req, res, url).catch((e) => {
        console.error('[gateway shim]', e);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
        else res.destroy();
      });
      return true;
    }
    void this.serve(req, res, url).catch((e) => {
      console.error('[gateway]', e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
      else res.destroy();
    });
    return true;
  }

  /** Every credential the client presented (a client may send an empty / stale x-api-key next to a good Bearer). */
  private presentedKeys(req: http.IncomingMessage, url: URL): string[] {
    const h = req.headers;
    const bearer = /^Bearer\s+(.+)$/i.exec(String(h.authorization ?? ''))?.[1];
    return [h['x-api-key'], bearer, h['x-goog-api-key'], url.searchParams.get('key')].map((v) => String(v ?? '').trim()).filter(Boolean);
  }
  private keyOk(k: string): boolean {
    const a = Buffer.from(k);
    const b = Buffer.from(this.key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private sendError(res: http.ServerResponse, inbound: GatewayProtocol, status: number, message: string, extra: Record<string, string> = {}) {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(renderInboundError(inbound, status, message)));
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const m = /^\/gateway\/([^/]+)(\/.*)?$/.exec(url.pathname);
    let rest = m?.[2] ?? '/';
    if (!/^\/v1(beta)?\//.test(rest)) rest = `/v1${rest === '/' ? '' : rest}`; // base URL given without the version
    const route = routeOf(req.method ?? 'GET', rest, req.headers);
    const inbound = route?.inbound ?? (rest.startsWith('/v1beta') ? 'gemini' : req.headers['anthropic-version'] ? 'anthropic' : 'openai');
    if (!this.enabled()) return this.sendError(res, inbound, 503, '模型网关未启用（设置 → 模型网关）');
    const presented = this.presentedKeys(req, url);
    if (!presented.some((k) => this.keyOk(k))) {
      // an agent logged in with its own account (ChatGPT / Google / claude.ai) sends that token, not ours
      const foreign = presented.length > 0 && !presented.some((k) => k.startsWith('cwg-'));
      return this.sendError(res, inbound, 401, foreign ? '网关密钥无效：agent 没有用网关密钥（发来的不是 cwg- 开头的密钥），检查它的登录方式是否被账号登录覆盖了' : '网关密钥无效');
    }
    const group = m ? this.group(decodeURIComponent(m[1])) : undefined;
    if (!group) return this.sendError(res, inbound, 404, `没有这个网关组：${m?.[1] ?? ''}`);
    if (!route) return this.sendError(res, inbound, 404, `网关不支持这个接口：${req.method} ${rest}`);

    const params = new URLSearchParams(url.search);
    params.delete('key');
    const search = params.toString() ? `?${params}` : '';
    if (route.op === 'models') return this.serveModels(res, group, route.inbound);

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > BODY_LIMIT) return this.sendError(res, inbound, 413, '请求体过大');
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks);
    let json: any;
    try { json = JSON.parse(raw.toString('utf8') || '{}'); } catch { return this.sendError(res, inbound, 400, '请求体不是合法 JSON'); }
    const stream = route.inbound === 'gemini' ? route.stream : !!json?.stream;
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const ctx: Ctx = { req, res, group, route: { ...route, stream }, path: rest, search, raw, json, model: route.model ?? String(json?.model ?? ''), signal: ac.signal, t0: Date.now(), customTools: new Set() };
    return this.run(ctx);
  }

  private serveModels(res: http.ServerResponse, g: GatewayGroup, inbound: GatewayProtocol) {
    const ids = new Set<string>();
    for (const k of Object.keys(g.modelMap ?? {})) if (!k.includes('*')) ids.add(k);
    for (const m of g.members) {
      if (m.model) ids.add(m.model);
      const p = this.deps.meta.provider(m.providerId);
      for (const x of p?.models ?? []) ids.add(x);
      if (p?.defaultModel) ids.add(p.defaultModel);
    }
    const list = [...ids].sort();
    res.writeHead(200, { 'content-type': 'application/json' });
    if (inbound === 'gemini') { res.end(JSON.stringify({ models: list.map((id) => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] })) })); return; }
    // one shape both SDKs accept: OpenAI's `object/list` plus Anthropic's `type/display_name/has_more`
    const created = Math.floor(Date.now() / 1000);
    const data = list.map((id) => ({ id, object: 'model', type: 'model', display_name: id, created, created_at: new Date(created * 1000).toISOString(), owned_by: 'claude-web-gateway' }));
    res.end(JSON.stringify({ object: 'list', data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null }));
  }

  private irOf(ctx: Ctx): IrRequest {
    if (!ctx.ir) {
      ctx.ir = parseInbound(ctx.route.inbound, ctx.json, { stream: ctx.route.stream, model: ctx.model });
      ctx.ir.cacheKey = cacheKeyOf(ctx.json, ctx.req.headers);
      for (const t of ctx.ir.tools ?? []) if (t.custom) ctx.customTools.add(t.name);
    }
    return ctx.ir;
  }

  /** Try the group's members in order until one answers (or the failure is the request's own fault). */
  private async run(ctx: Ctx) {
    const { group, route, res } = ctx;
    const inbound = route.inbound;
    const counting = route.op === 'count';
    const order = this.states.order(group);
    const unsupported: string[] = [];
    let tried = 0;
    let last: Attempt | null = null;
    let lastMember: { p: Provider; outbound: Outbound } | null = null;
    const estimate = () => {
      let n = 0;
      try { n = estimateTokens(this.irOf(ctx)); } catch { /* malformed: 0 */ }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(inbound === 'gemini' ? { totalTokens: n } : { input_tokens: n }));
    };
    for (const m of order) {
      const p = this.deps.member(m.providerId);
      if (!p) continue;
      const outbound = outboundOf(p.type);
      if (!outbound) continue;
      if (counting ? !isPassthrough(inbound, outbound) : !supported(inbound, outbound)) { unsupported.push(`${p.name}（${PROTOCOL_LABEL[outbound === 'openai' ? 'openai' : outbound]}）`); continue; }
      tried++;
      lastMember = { p, outbound };
      const a = await this.attempt(ctx, m, p, outbound, tried - 1);
      last = a;
      if (a.kind === 'switch') continue;
      if (!counting) this.record(ctx, p, outbound, a, tried - 1);
      if (a.kind === 'final') {
        if (a.passthrough) res.writeHead(a.status, { ...errorHeaders(a.headers), 'content-type': String(a.headers['content-type'] ?? 'application/json') }).end(a.text);
        else this.sendError(res, inbound, a.status, upstreamErrorMessage(a.text), errorHeaders(a.headers));
      }
      return;
    }
    // nobody in the group speaks the client's protocol, or every member failed: a pre-flight count
    // gets an estimate rather than an error (and never changes any member's state)
    if (counting) return estimate();
    if (!tried) {
      if (unsupported.length) return this.sendError(res, inbound, 400, `组「${group.name}」里没有能接 ${PROTOCOL_LABEL[inbound]} 入口的成员：${unsupported.join('、')} 需要的转换方向暂不支持`);
      const next = this.states.nextAvailable(group);
      const wait = next ? Math.max(1, Math.ceil((next.at - Date.now()) / 1000)) : 0;
      if (next && next.at > Date.now()) return this.sendError(res, inbound, next.rate ? 429 : 503, `组「${group.name}」的成员都在冷却中，约 ${wait}s 后恢复`, { 'retry-after': String(wait) });
      return this.sendError(res, inbound, 503, `组「${group.name}」没有可用成员（都已停用或档案缺失）`);
    }
    // every member failed with a switchable error: report the last one as is
    if (last?.kind === 'switch') {
      if (lastMember) this.record(ctx, lastMember.p, lastMember.outbound, last, tried - 1);
      if (last.text !== undefined && last.passthrough) res.writeHead(last.status, { ...errorHeaders(last.headers), 'content-type': String(last.headers?.['content-type'] ?? 'application/json') }).end(last.text);
      else this.sendError(res, inbound, last.status, `${tried > 1 ? `组内 ${tried} 个成员都失败了，最后一个：` : ''}${last.message}`, errorHeaders(last.headers));
    }
  }

  private record(ctx: Ctx, p: Provider, outbound: Outbound, a: Attempt, switches: number) {
    const usage = a.kind === 'done' ? a.usage : null;
    const fb = a.kind === 'done' || a.kind === 'broken' || a.kind === 'aborted' ? a.firstByteMs : undefined;
    this.deps.ledger?.record({
      ts: Date.now(),
      sessionId: String(ctx.req.headers['x-claude-code-session-id'] ?? ''),
      model: a.model,
      durationMs: Date.now() - ctx.t0,
      apiMs: fb,
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      costUsd: 0,
      costUnknown: true, // the gateway never knows a price
      ok: a.kind === 'done',
      error: a.kind === 'done' ? undefined : a.kind === 'final' ? `HTTP ${a.status} ${upstreamErrorMessage(a.text)}`.slice(0, 200) : a.message.slice(0, 200),
      providerId: p.id,
      kind: 'gateway',
      gateway: { group: ctx.group.name, inbound: ctx.route.inbound, member: p.name, memberId: p.id, outbound, upstreamStatus: a.status, switches, firstByteMs: fb, stream: ctx.route.stream },
    });
  }

  private async attempt(ctx: Ctx, m: GatewayMember, p: Provider, outbound: Outbound, switches: number): Promise<Attempt> {
    const { group, route } = ctx;
    // count_tokens is a side request: its failures say nothing about the member's ability to answer
    const track = route.op !== 'count';
    const pass = isPassthrough(route.inbound, outbound);
    const model = mapModel(group, m, ctx.model);
    const base = p.baseUrl?.trim() || DEFAULT_BASE[p.type];
    let path: string;
    let body: Buffer;
    let headers: Record<string, string>;
    // translated requests carry prompt caching the client could not have put there (cache.ts)
    let retryBody: Buffer | null = null; // the same request without prompt_cache_key, for an upstream that rejects it
    try {
      if (pass) {
        if (route.inbound === 'gemini') {
          path = `/v1beta/models/${encodeURIComponent(model)}:${route.action}${ctx.search}`;
          body = ctx.raw;
        } else {
          path = ctx.path + ctx.search;
          // only the top-level "model" bytes change; the rest is exactly what the client sent
          body = model === ctx.model ? ctx.raw : Buffer.from(replaceTopLevelString(ctx.raw.toString('utf8'), 'model', model) ?? JSON.stringify({ ...ctx.json, model }));
        }
        headers = passthroughHeaders(ctx.req.rawHeaders, outbound, p.apiKey);
      } else {
        const ir = { ...this.irOf(ctx), model, stream: route.stream };
        const opts: OutboundOpts = outbound === 'anthropic' ? { cacheTtl: group.cache1h || p.cache1h ? '1h' : undefined }
          : outbound === 'openai' ? { promptCacheKey: !p.noPromptCacheKey, cacheControl: p.cacheControlFormat === 'anthropic' } : {};
        const out = buildOutbound(outbound, ir, opts);
        path = out.path;
        body = Buffer.from(JSON.stringify(out.body));
        headers = translatedHeaders(outbound, p.apiKey, route.stream, String(ctx.req.headers['user-agent'] ?? ''));
        if (outbound === 'openai' && ir.cacheKey) {
          addMissing(headers, affinityHeaders(ir.cacheKey.slice(0, CACHE_KEY_MAX), p.type === 'grok'));
          if (out.body.prompt_cache_key) retryBody = Buffer.from(JSON.stringify(buildOutbound(outbound, ir, { ...opts, promptCacheKey: false }).body));
        }
      }
    } catch (e: any) {
      return { kind: 'final', status: 400, text: JSON.stringify(renderInboundError(route.inbound, 400, `请求转换失败：${e?.message ?? e}`)), headers: {}, passthrough: true, model };
    }
    const url = joinUrl(base, path);
    const sent = Date.now();
    // streaming: the first byte must come quickly; non-streaming: nothing arrives until the whole answer is done
    const waitMs = route.stream ? this.firstByteMs : this.nonStreamMs;
    const deadline = sent + waitMs;
    const aborted = (firstByteMs?: number): Attempt => ({ kind: 'aborted', status: 499, message: '客户端已断开', firstByteMs, model });
    const switchOn = (status: number, message: string): Attempt => {
      if (track) { this.states.fail(group.id, p.id, { action: 'switch', kind: 'transient' }, status, message, Date.now(), sent); this.emit('changed'); }
      return { kind: 'switch', status, message: `${p.name}：${message}`, passthrough: pass, model };
    };
    let up: UpstreamResponse;
    try {
      up = await sendUpstream(url, { method: 'POST', headers, body, signal: ctx.signal, headerTimeoutMs: waitMs });
      // an upstream that may not know prompt_cache_key: this request once more without it; the profile only
      // remembers when the error named the field (a retry that happens to work proves nothing about the key)
      if (retryBody && isParamRejection(up.status)) {
        let text = '';
        try { text = await readText(up.body, 1024 * 1024); } catch { /* keep empty */ }
        if (mentionsCacheKey(text)) void this.deps.meta.upsertProvider({ id: p.id, noPromptCacheKey: true }, { mustExist: true }).catch(() => { /* next request tries again */ });
        up = await sendUpstream(url, { method: 'POST', headers, body: retryBody, signal: ctx.signal, headerTimeoutMs: waitMs });
      }
    } catch (e: any) {
      if (ctx.signal.aborted) return aborted();
      return switchOn(e instanceof UpstreamError && e.timeout ? 504 : 502, e?.message ?? String(e));
    }
    if (up.status < 200 || up.status >= 300) {
      let text = '';
      try { text = await readText(up.body, 4 * 1024 * 1024); } catch { /* keep empty */ }
      if (ctx.signal.aborted) return aborted();
      const st = this.states.get(group.id, p.id);
      const v = classify(up.status, up.headers, text, st.strikes);
      const msg = `HTTP ${up.status} ${upstreamErrorMessage(text)}`.trim();
      if (track) {
        this.states.fail(group.id, p.id, v, up.status, v.action === 'switch' && v.kind === 'auth' ? `${msg}（鉴权失败，已停用，检查密钥后点「恢复」）` : msg, Date.now(), sent);
        this.emit('changed');
      }
      if (v.action === 'final') return { kind: 'final', status: up.status, text, headers: up.headers, passthrough: pass, model };
      return { kind: 'switch', status: up.status, message: `${p.name}：${msg}`, text, headers: up.headers, passthrough: pass, model };
    }

    // 2xx: hold the client until the first body byte arrives, so a member that stalls can still be skipped
    const src = pass ? up.body : decoded(up.body);
    const it = src[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let first: IteratorResult<Buffer>;
    try {
      first = await withTimeout(it.next(), deadline - Date.now());
    } catch (e: any) {
      up.body.destroy();
      if (ctx.signal.aborted) return aborted();
      return switchOn(504, e?.message === 'timeout' ? `${Math.round(waitMs / 1000)}s 内没有返回内容` : e?.message ?? String(e));
    }
    const firstByteMs = Date.now() - sent;
    if (track && this.states.ok(group.id, p.id, Date.now(), sent)) this.emit('changed'); // recovered / first success — not on every request

    const memberHeader = { 'x-cw-gateway-member': encodeURIComponent(p.name), 'x-cw-gateway-switches': String(switches) };
    try {
      if (pass) return await this.pipePassthrough(ctx, up, it, first, memberHeader, firstByteMs, model);
      return await this.pipeTranslated(ctx, up, it, first, outbound, memberHeader, firstByteMs, model);
    } catch (e: any) {
      up.body.destroy();
      // the client hanging up mid-answer is not the member's fault: no cooldown
      if (ctx.signal.aborted) return aborted(firstByteMs);
      if (!ctx.res.headersSent) return switchOn(502, e?.message ?? String(e));
      ctx.res.destroy();
      return { kind: 'broken', status: 502, message: e?.message ?? String(e), firstByteMs, model };
    }
  }

  /** Same protocol: status, headers and raw bytes straight through; usage is sniffed from a decoded copy. */
  private async pipePassthrough(ctx: Ctx, up: UpstreamResponse, it: AsyncIterator<Buffer>, first: IteratorResult<Buffer>, extra: Record<string, string>, firstByteMs: number, model: string): Promise<Attempt> {
    const { res } = ctx;
    const isSse = /event-stream/i.test(String(up.headers['content-type'] ?? ''));
    res.writeHead(up.status, { ...responseHeaders(up.headers), ...extra });
    const sniff = new UsageSniffer(ctx.route.inbound, isSse, String(up.headers['content-encoding'] ?? ''));
    let r = first;
    let broken = '';
    while (!r.done && !ctx.signal.aborted) {
      sniff.push(r.value);
      if (!res.write(r.value)) await waitDrain(res, ctx.signal);
      if (ctx.signal.aborted) break;
      try { r = await withTimeout(it.next(), IDLE_MS); } catch (e: any) { broken = e?.message === 'timeout' ? '上游超过 5 分钟没有数据' : e?.message ?? String(e); up.body.destroy(); break; }
    }
    if (ctx.signal.aborted) { up.body.destroy(); res.destroy(); sniff.abort(); return { kind: 'aborted', status: 499, message: '客户端已断开', firstByteMs, model }; }
    res.end();
    const usage = await sniff.end();
    if (broken) return { kind: 'broken', status: 502, message: broken, firstByteMs, model };
    return { kind: 'done', status: up.status, usage, firstByteMs, model };
  }

  /** Cross protocol: parse the member's response (or SSE) into IR and render it in the client's protocol. */
  private async pipeTranslated(ctx: Ctx, up: UpstreamResponse, it: AsyncIterator<Buffer>, first: IteratorResult<Buffer>, outbound: Outbound, extra: Record<string, string>, firstByteMs: number, model: string): Promise<Attempt> {
    const { res, route } = ctx;
    const clientModel = ctx.model || model;
    if (!route.stream) {
      const bufs: Buffer[] = [];
      let r = first;
      while (!r.done) { bufs.push(r.value); r = await withTimeout(it.next(), IDLE_MS); }
      const text = Buffer.concat(bufs).toString('utf8');
      let j: any;
      try { j = JSON.parse(text); } catch { throw new Error(`上游返回的不是 JSON：${text.slice(0, 120)}`); }
      const ir = parseOutboundResponse(outbound, j, model);
      if (ctx.signal.aborted) return { kind: 'aborted', status: 499, message: '客户端已断开', firstByteMs, model };
      res.writeHead(200, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(renderInboundResponse(route.inbound, ir, clientModel, ctx.customTools)));
      return { kind: 'done', status: up.status, usage: ir.usage, firstByteMs, model };
    }
    const parser = outboundStreamParser(outbound, model);
    const renderer = inboundStreamRenderer(route.inbound, clientModel, { includeUsage: !!ctx.json?.stream_options?.include_usage, customTools: ctx.customTools });
    const usage: IrUsage = { input: 0, output: 0 };
    const sse = new SseParser();
    const dec = new StringDecoder('utf8');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', ...extra });
    const emit = async (evs: IrEvent[]) => {
      if (ctx.signal.aborted) return; // nobody to write to: never wait for a drain that cannot come
      let out = '';
      for (const e of evs) { if (e.t === 'usage') Object.assign(usage, e.usage); out += renderer.push(e); }
      if (out && !res.write(out)) await waitDrain(res, ctx.signal);
    };
    let r = first;
    let broken = '';
    while (!r.done && !ctx.signal.aborted) {
      for (const ev of sse.feed(dec.write(r.value))) await emit(parser.feed(ev));
      if (ctx.signal.aborted) break;
      try { r = await withTimeout(it.next(), IDLE_MS); } catch (e: any) { broken = e?.message === 'timeout' ? '上游超过 5 分钟没有数据' : e?.message ?? String(e); up.body.destroy(); break; }
    }
    if (ctx.signal.aborted) { up.body.destroy(); res.destroy(); return { kind: 'aborted', status: 499, message: '客户端已断开', firstByteMs, model }; }
    if (broken) await emit([{ t: 'error', message: broken }]);
    else { for (const ev of sse.feed(dec.end())) await emit(parser.feed(ev)); for (const ev of sse.end()) await emit(parser.feed(ev)); await emit(parser.end()); }
    const tail = renderer.end();
    res.end(tail || undefined);
    if (broken) return { kind: 'broken', status: 502, message: broken, firstByteMs, model };
    return { kind: 'done', status: up.status, usage, firstByteMs, model };
  }

  /** Minimal request through our own endpoint, the way an agent would send it. */
  async test(groupId: string, protocol: GatewayProtocol = 'anthropic'): Promise<GatewayTestResult> {
    const g = this.group(groupId);
    if (!g) return { ok: false, status: 0, ms: 0, error: '组不存在' };
    if (!this.enabled()) return { ok: false, status: 0, ms: 0, error: '网关未启用' };
    const m0 = g.members[0];
    const p0 = m0 ? this.deps.meta.provider(m0.providerId) : undefined;
    const model = m0?.model || p0?.defaultModel || p0?.models?.find((x) => /haiku|mini|flash/i.test(x)) || p0?.models?.[0] || 'claude-haiku-4-5';
    const prompt = 'Reply with exactly: ok';
    const t0 = Date.now();
    const base = `http://127.0.0.1:${this.port}/gateway/${encodeURIComponent(groupId)}`;
    const reqs: Record<GatewayProtocol, { url: string; body: any; headers: Record<string, string> }> = {
      anthropic: { url: `${base}/v1/messages`, body: { model, max_tokens: 16, messages: [{ role: 'user', content: prompt }] }, headers: { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' } },
      openai: { url: `${base}/v1/chat/completions`, body: { model, max_tokens: 16, messages: [{ role: 'user', content: prompt }] }, headers: { authorization: `Bearer ${this.key}` } },
      responses: { url: `${base}/v1/responses`, body: { model, max_output_tokens: 16, input: prompt }, headers: { authorization: `Bearer ${this.key}` } },
      gemini: { url: `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, body: { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 16 } }, headers: { 'x-goog-api-key': this.key } },
    };
    const r0 = reqs[protocol];
    try {
      const r = await fetch(r0.url, { method: 'POST', headers: { 'content-type': 'application/json', ...r0.headers }, body: JSON.stringify(r0.body), signal: AbortSignal.timeout(FIRST_BYTE_MS * 2) });
      const text = await r.text();
      const member = r.headers.get('x-cw-gateway-member');
      const out: GatewayTestResult = { ok: r.ok, status: r.status, ms: Date.now() - t0, member: member ? decodeURIComponent(member) : undefined, switches: Number(r.headers.get('x-cw-gateway-switches') ?? 0) };
      if (g.members.some((m) => this.deps.meta.provider(m.providerId)?.type === 'anthropic')) out.note = '测试请求不带 Claude Code 指纹（系统提示 / UA），只认官方客户端的中转可能拒绝这条测试，但真实的 Claude 对话经网关透传能通过。';
      let j: any = null;
      try { j = JSON.parse(text); } catch { /* not json */ }
      if (r.ok) out.text = (j?.content?.[0]?.text ?? j?.choices?.[0]?.message?.content ?? j?.output?.[0]?.content?.[0]?.text ?? j?.candidates?.[0]?.content?.parts?.[0]?.text ?? text).toString().slice(0, 200);
      else out.error = upstreamErrorMessage(text);
      return out;
    } catch (e: any) {
      return { ok: false, status: 0, ms: Date.now() - t0, error: e?.message ?? String(e) };
    }
  }
}

/** Reads usage out of a passthrough body (SSE or JSON, possibly compressed) without delaying the bytes. */
class UsageSniffer {
  private usage: Partial<IrUsage> = {};
  private seen = false;
  private sse = new SseParser();
  private dec = new StringDecoder('utf8');
  private json = '';
  private z: import('node:stream').Transform | null = null;
  private zDone: Promise<void> | null = null;
  private off = false; // an encoding we cannot decode: no usage, bytes still pass through
  constructor(private protocol: GatewayProtocol, private isSse: boolean, encoding: string) {
    const enc = encoding.toLowerCase().trim();
    if (enc && enc !== 'identity') {
      this.z = decoder(enc);
      if (!this.z) this.off = true;
      else {
        this.z.on('data', (c: Buffer) => this.text(this.dec.write(c)));
        this.zDone = new Promise((r) => { this.z!.on('end', () => r()); this.z!.on('error', () => r()); });
      }
    }
  }
  push(b: Buffer) {
    if (this.off) return;
    if (this.z) this.z.write(b);
    else this.text(this.dec.write(b));
  }
  private text(s: string) {
    if (!s) return;
    if (this.isSse) for (const e of this.sse.feed(s)) this.event(e.data);
    else if (this.json.length < 8 * 1024 * 1024) this.json += s;
  }
  private event(data: string) {
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    const u = sniffUsage(this.protocol, j);
    if (u) { Object.assign(this.usage, Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined))); this.seen = true; }
  }
  /** Client went away: drop the decompressor without waiting for it. */
  abort() { this.off = true; this.z?.destroy(); }
  async end(): Promise<IrUsage | null> {
    if (this.off) return null;
    if (this.z) { this.z.end(); await this.zDone; }
    this.text(this.dec.end());
    if (this.isSse) for (const e of this.sse.end()) this.event(e.data);
    else if (this.json) this.event(this.json);
    return this.seen ? { input: 0, output: 0, ...this.usage } : null;
  }
}

