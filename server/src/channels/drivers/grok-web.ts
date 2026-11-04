// Grok web account as a source: a small OpenAI chat-completions endpoint on 127.0.0.1 that answers through
// grok.com with the user's own `sso` cookie (grok-web-core.ts has the protocol), plus one provider profile per
// account pointing at it — the gateway, failover groups and routing use it like any other OpenAI endpoint.
//
// The profile's key IS the credential (`grok1.<base64url JSON>`): the endpoint keeps nothing of its own, so one
// endpoint serves every account and a request only ever uses the cookie it was sent with. Tool calls are emulated
// in the prompt (grok.com has no function calling): with tools the answer is held back and returned whole.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tr } from '../../i18n/index.js';
import type { MetaStore } from '../../meta/store.js';
import type { CatalogEntry, SourceHealth, SourceSummary } from '../types.js';
import { projectProvider } from '../registry.js';
import {
  GROK_BASE, GROK_CATALOG_ID, GROK_MODELS, extractToolCalls, grokBody, grokFailure, grokHeaders, parseCredential, parseLine,
  type GrokCredential, type OaiRequest,
} from './grok-web-core.js';
import type { ProviderDeps } from './provider.js';
import type { AddInput, ChannelDriver, DriverContext } from './types.js';

export { GROK_CATALOG_ID } from './grok-web-core.js';

const KEY_PREFIX = 'grok1.';
export const encodeKey = (c: GrokCredential) => KEY_PREFIX + Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeKey(k: string): GrokCredential | null {
  const s = k.trim().replace(/^Bearer\s+/i, '');
  if (s.startsWith(KEY_PREFIX)) {
    try { const j = JSON.parse(Buffer.from(s.slice(KEY_PREFIX.length), 'base64url').toString('utf8')); return j?.sso ? j : null; } catch { return null; }
  }
  return parseCredential(s);
}

type Fetch = typeof fetch;
const MAX_BODY = 16 * 1024 * 1024;

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
const oaiError = (message: string, type = 'api_error') => ({ error: { message, type } });

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Ask grok.com whether the cookie works (its rate-limits endpoint: cheap, no chat made). Resolves to the reason it does not, or null. */
export async function probeGrok(c: GrokCredential, f: Fetch = fetch): Promise<string | null> {
  try {
    const r = await f(`${GROK_BASE}/rest/rate-limits`, { method: 'POST', headers: grokHeaders(c), body: JSON.stringify({ requestKind: 'DEFAULT', modelName: 'grok-3' }), signal: AbortSignal.timeout(15_000) });
    if (r.ok) return null;
    return grokFailure(r.status, await r.text().catch(() => '')).message;
  } catch (e: any) {
    return tr('连不上 grok.com：{why}', { why: String(e?.message ?? e) });
  }
}

export class GrokWebServer {
  private server: http.Server | null = null;
  constructor(private f: Fetch = fetch) {}

  get port(): number { return this.server ? (this.server.address() as AddressInfo).port : 0; }
  get listening(): boolean { return !!this.server?.listening; }

  async start(port = 0): Promise<number> {
    if (this.server) return this.port;
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = 0;
    const listen = (p: number) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(p, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    await listen(port).catch(async (e) => { if (port === 0) throw e; await listen(0); });
    this.server = server;
    return this.port;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
        sendJson(res, 200, { object: 'list', data: GROK_MODELS.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'xai' })) });
        return;
      }
      if (req.method !== 'POST' || (url !== '/v1/chat/completions' && url !== '/chat/completions')) throw new HttpError(404, 'not found');
      const cred = decodeKey(String(req.headers.authorization ?? req.headers['x-api-key'] ?? ''));
      if (!cred) throw new HttpError(401, 'no grok.com sso cookie in the Authorization header');
      let body: OaiRequest;
      try { body = JSON.parse(await readBody(req)); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'body is not JSON'); }
      await this.chat(cred, body, req, res);
    } catch (e: any) {
      sendJson(res, e instanceof HttpError ? e.status : 500, oaiError(String(e?.message ?? e)));
    }
  }

  private async chat(cred: GrokCredential, body: OaiRequest, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const model = String(body.model || GROK_MODELS[0].id);
    const r = await this.f(`${GROK_BASE}/rest/app-chat/conversations/new`, { method: 'POST', headers: grokHeaders(cred), body: JSON.stringify(grokBody(body)), signal: ac.signal });
    if (!r.ok || !r.body) {
      const f = grokFailure(r.status, await r.text().catch(() => ''));
      throw new HttpError(f.status, f.message);
    }
    const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const holdText = !!body.tools?.length && body.tool_choice !== 'none';
    const stream = !!body.stream;
    let started = false;
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
      if (!started) { started = true; res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    };
    let text = '';
    let thinking = '';
    let failure: { message: string; status?: number } | null = null;
    const decoder = new TextDecoder();
    let buf = '';
    const take = (line: string) => {
      for (const d of parseLine(line)) {
        if (d.kind === 'error') { failure = d; continue; }
        if (d.kind === 'thinking') { thinking += d.text; if (stream) chunk({ reasoning_content: d.text }); continue; }
        text += d.text;
        if (stream && !holdText) chunk({ content: d.text });
      }
    };
    try {
      for await (const part of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(part, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      if (buf.trim()) take(buf);
    } catch (e: any) {
      if (ac.signal.aborted) return;
      failure = { message: `grok.com stream broke: ${String(e?.message ?? e)}` };
    }
    const fail = failure as { message: string; status?: number } | null;
    if (fail && !text) {
      if (started) { res.write(`data: ${JSON.stringify(oaiError(fail.message))}\n\n`); res.end(); return; }
      throw new HttpError(fail.status && fail.status >= 400 ? fail.status : 502, fail.message);
    }
    const { content, calls } = holdText ? extractToolCalls(text) : { content: text, calls: [] };
    const toolCalls = calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
    const finish = toolCalls.length ? 'tool_calls' : 'stop';
    const usage = { prompt_tokens: Math.ceil(String(grokBody(body).message).length / 4), completion_tokens: Math.ceil((text.length + thinking.length) / 4) };
    const usageAll = { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens };
    if (stream) {
      if (holdText && content) chunk({ content });
      if (toolCalls.length) chunk({ tool_calls: toolCalls });
      chunk({}, finish);
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageAll })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    sendJson(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: content || null, ...(thinking ? { reasoning_content: thinking } : {}), ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index: _i, ...t }) => t) } : {}) } }],
      usage: usageAll,
    });
    void req;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The source

const ENGINE_TAG = 'grok-web';
const SOURCE_PREFIX = 'grok-web:';

export interface GrokWebDeps {
  providers: ProviderDeps;
  meta?: MetaStore;
  server?: () => GrokWebServer;
  probe?: (c: GrokCredential) => Promise<string | null>;
  /** a profile's key in plain text (ProviderService.forSession); list() masks it */
  plainKey?: (providerId: string) => string;
}

export class GrokWebDriver implements ChannelDriver {
  readonly id = 'grok-web' as const;
  readonly kind = 'provider' as const;
  readonly needs = 'key' as const;
  private server: GrokWebServer | null = null;
  private errors = new Map<string, string>();
  private starting: Promise<number> | null = null;

  constructor(private deps: GrokWebDeps) {
    if (deps.meta && this.providerIds().length) setImmediate(() => { void this.resume(); });
  }

  owns(sourceId: string) { return sourceId.startsWith(SOURCE_PREFIX); }

  private providerIds(): string[] {
    const links = this.deps.meta?.channelLinks() ?? {};
    return Object.keys(links).filter((id) => links[id]?.engine === ENGINE_TAG);
  }

  private probe(c: GrokCredential) { return (this.deps.probe ?? probeGrok)(c); }

  /** The shared endpoint, started once (on the old port when it is free). */
  private up(port = 0): Promise<number> {
    if (this.server?.listening) return Promise.resolve(this.server.port);
    this.starting ??= (async () => {
      const s = this.deps.server?.() ?? new GrokWebServer();
      const p = await s.start(port);
      this.server = s;
      return p;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  list(ctx: DriverContext): SourceSummary[] {
    const out: SourceSummary[] = [];
    for (const id of Object.keys(ctx.links).filter((k) => ctx.links[k]?.engine === ENGINE_TAG)) {
      const p = ctx.providers.find((x) => x.id === id);
      if (!p) continue;
      const err = this.errors.get(id);
      const health: SourceHealth = !this.server?.listening ? 'disabled' : err ? 'attention' : 'ready';
      out.push({
        ...projectProvider(p),
        id: SOURCE_PREFIX + id,
        category: 'subscription',
        health,
        detail: err || tr('旧的接法（grok.com 网页，模型较旧）：删掉它，在「Grok」卡片里重新登录，就能用 Grok 4.7 等最新模型'),
        catalogId: GROK_CATALOG_ID,
        needs: 'key',
        actions: { canAddAccount: false, canEditProvider: true, canManageEngine: false, canRemove: true },
      });
    }
    return out;
  }

  async add(_entry: CatalogEntry, input: AddInput): Promise<string> {
    const cred = parseCredential(input.key ?? '');
    if (!cred) throw new Error(tr('没认出 sso cookie：粘贴 grok.com 的 sso 值，或整段 Cookie'));
    const why = await this.probe(cred);
    if (why && /\b401\b|expired|signed out|rejected the sso/i.test(why)) throw new Error(why);
    const port = await this.up();
    const n = this.providerIds().length;
    const saved = await this.deps.providers.upsert({
      name: input.name?.trim() || (n ? tr('Grok 网页 {n}', { n: n + 1 }) : tr('Grok 网页')),
      type: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: encodeKey(cred), authStyle: 'bearer',
      models: GROK_MODELS.map((m) => m.id), modelsAt: Date.now(),
    } as any);
    if (this.deps.meta) {
      this.deps.meta.channelLinks()[saved.id] = { catalogId: GROK_CATALOG_ID, engine: ENGINE_TAG };
      await this.deps.meta.saveChannels();
    }
    if (why) this.errors.set(saved.id, why); else this.errors.delete(saved.id);
    return SOURCE_PREFIX + saved.id;
  }

  /** After a restart: bring the endpoint up and point every Grok profile at it. */
  async resume(): Promise<void> {
    const ids = this.providerIds();
    if (!ids.length) return;
    const profiles = this.deps.providers.list().filter((p) => ids.includes(p.id));
    const old = Number(/:(\d+)\/v1\/?$/.exec(profiles[0]?.baseUrl ?? '')?.[1] ?? 0);
    try {
      const port = await this.up(old);
      for (const p of profiles) if (p.baseUrl !== `http://127.0.0.1:${port}/v1`) await this.deps.providers.upsert({ id: p.id, baseUrl: `http://127.0.0.1:${port}/v1` } as any);
    } catch (e: any) {
      for (const id of ids) this.errors.set(id, String(e?.message ?? e));
    }
  }

  async refresh(sourceId: string): Promise<void> {
    await this.resume();
    const id = sourceId.slice(SOURCE_PREFIX.length);
    const cred = decodeKey(this.deps.plainKey?.(id) ?? '');
    if (!cred) { this.errors.set(id, tr('这个账号没有可用的 cookie，删掉重新添加')); throw new Error(this.errors.get(id)); }
    const why = await this.probe(cred);
    if (why) { this.errors.set(id, why); throw new Error(why); }
    this.errors.delete(id);
  }

  async remove(sourceId: string): Promise<void> {
    const id = sourceId.slice(SOURCE_PREFIX.length);
    await this.deps.providers.remove(id);
    this.errors.delete(id);
    if (this.deps.meta) {
      delete this.deps.meta.channelLinks()[id];
      await this.deps.meta.saveChannels();
    }
    if (!this.providerIds().length) { await this.server?.stop(); this.server = null; }
  }

  async stop(): Promise<void> { await this.server?.stop(); this.server = null; }
}
