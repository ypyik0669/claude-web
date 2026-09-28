import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { MetaStore } from '../meta/store.js';
import { GatewayService } from './service.js';
import { providerEnv, ProviderService } from '../providers/service.js';
import type { LedgerEntry, Provider } from '../protocol.js';

interface Hit { rawHeaders: string[]; headers: http.IncomingHttpHeaders; body: string; url: string; method: string }
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function fake(): Promise<{ url: string; hits: Hit[]; handler: { fn: Handler }; close(): Promise<void> }> {
  const hits: Hit[] = [];
  const handler: { fn: Handler } = { fn: (_q, res) => res.writeHead(500).end() };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { hits.push({ rawHeaders: req.rawHeaders, headers: req.headers, body, url: req.url ?? '', method: req.method ?? '' }); handler.fn(req, res, body); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}`, hits, handler, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

// what DeepSeek streams: the hit only at the top level of the usage chunk
const chunk = (o: any) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4', ...o })}\n\n`;
const DS_STREAM = chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  + chunk({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] })
  + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  + chunk({ choices: [], usage: { prompt_tokens: 20_000, completion_tokens: 5, total_tokens: 20_005, prompt_cache_hit_tokens: 15_000, prompt_cache_miss_tokens: 5_000 } })
  + 'data: [DONE]\n\n';
const dsStream: Handler = (_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(DS_STREAM); };
const rsse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const responsesStream: Handler = (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([
    rsse({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.6', status: 'in_progress' } }),
    rsse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } }),
    rsse({ type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'via responses' }),
    rsse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'via responses' }] } }),
    rsse({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 30_000, input_tokens_details: { cached_tokens: 27_000 }, output_tokens: 7 } } }),
  ].join(''));
};

let U: Awaited<ReturnType<typeof fake>>;
let srv: http.Server;
let remoteSrv: http.Server;
let gw: GatewayService;
let meta: MetaStore;
let root: string;
let remoteRoot: string;
const ledger: LedgerEntry[] = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-shim-'));

const chatBody = (model: string, extra: Record<string, unknown> = {}) => `{"model":"${model}","messages":[{"role":"system","content":"You are Claude Code."},{"role":"user","content":"hi"}],"max_tokens":64000,"tools":[{"type":"function","function":{"name":"Bash","parameters":{"type":"object"}}}],"stream":true,"stream_options":{"include_usage":true}${Object.entries(extra).map(([k, v]) => `,"${k}":${JSON.stringify(v)}`).join('')}}`;
async function post(pid: string, sid: string, body: string, headers: Record<string, string> = {}, base = root) {
  const r = await fetch(`${base}/gateway/~p/${pid}/k/${sid}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gw.shim.key}`, 'content-type': 'application/json', 'x-stainless-lang': 'js', 'user-agent': 'OpenAI/JS 5.0', ...headers }, body });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

beforeAll(async () => {
  U = await fake();
  meta = new MetaStore(path.join(dir, 'meta.json'));
  const mk = async (id: string, patch: Partial<Provider>) => { const p = await meta.upsertProvider({ name: `P-${id}`, type: 'openai', baseUrl: `${U.url}/v1`, apiKey: `sk-${id}`, ...patch }); p.id = id; };
  await mk('ds', {});
  await mk('gpt', {});
  await mk('grok', { type: 'grok', baseUrl: U.url });
  await mk('ant', { type: 'anthropic', baseUrl: U.url });
  gw = new GatewayService({ meta, member: (id) => meta.provider(id) ?? null, ledger: { record: (e) => ledger.push(e) } });
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => { if (!gw.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))) res.writeHead(418).end(); };
  srv = http.createServer(handler);
  remoteSrv = http.createServer(handler);
  remoteSrv.on('connection', (s) => { (s as any).cwRemote = true; });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => remoteSrv.listen(0, '127.0.0.1', () => r()));
  gw.port = (srv.address() as any).port;
  root = `http://127.0.0.1:${gw.port}`;
  remoteRoot = `http://127.0.0.1:${(remoteSrv.address() as any).port}`;
  // the model gateway itself stays OFF: the shim must not depend on it
  expect(gw.enabled()).toBe(false);
});
afterAll(async () => {
  for (const s of [srv, remoteSrv]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  await U.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  U.hits.length = 0;
  ledger.length = 0;
  U.handler.fn = dsStream;
  for (const id of ['ds', 'gpt', 'grok']) { const p = meta.provider(id)!; delete p.noPromptCacheKey; delete p.noResponsesApi; delete p.responsesApi; }
});

describe('cache shim: chat/completions passthrough', () => {
  it('adds only prompt_cache_key to the body, real key + affinity headers upstream, fixes the usage chunk, logs the call', async () => {
    const body = chatBody('deepseek-v4');
    const r = await post('ds', 'sess-1', body);
    expect(r.status).toBe(200);
    const h = U.hits[0];
    expect(h.url).toBe('/v1/chat/completions');
    expect(h.body).toBe(body.replace('{', '{"prompt_cache_key":"cw:sess-1",'));
    expect(h.headers.authorization).toBe('Bearer sk-ds');
    expect(h.headers).toMatchObject({ session_id: 'cw:sess-1', 'x-session-affinity': 'cw:sess-1', 'x-client-request-id': 'cw:sess-1', 'x-stainless-lang': 'js', 'user-agent': 'OpenAI/JS 5.0' });
    expect(h.headers['x-grok-conv-id']).toBeUndefined();
    expect(JSON.stringify(h.rawHeaders)).not.toContain(gw.shim.key);
    // every byte of the stream as sent, except the usage line which gains prompt_tokens_details.cached_tokens
    const usageLine = DS_STREAM.split('\n').find((l) => l.includes('"usage"'))!;
    const fixed = JSON.parse(usageLine.slice(6));
    fixed.usage.prompt_tokens_details = { cached_tokens: 15_000 };
    expect(r.text).toBe(DS_STREAM.replace(usageLine, `data: ${JSON.stringify(fixed)}`));
    expect(ledger[0]).toMatchObject({ kind: 'gateway', sessionId: 'sess-1', providerId: 'ds', model: 'deepseek-v4', ok: true, input: 5_000, cacheRead: 15_000, output: 5, gateway: { via: 'shim', member: 'P-ds', outbound: 'openai', stream: true } });
  });
  it('a client that already sends prompt_cache_key keeps it; compressed upstream bodies are decoded for the rewrite', async () => {
    U.handler.fn = (_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync(DS_STREAM)); };
    const body = chatBody('deepseek-v4', { prompt_cache_key: 'mine' });
    const r = await post('ds', 'sess-1', body, { 'accept-encoding': 'gzip' });
    expect(U.hits[0].body).toBe(body);
    expect(r.headers.get('content-encoding')).toBeNull();
    expect(r.text).toContain('"prompt_tokens_details":{"cached_tokens":15000}');
  });
  it('an upstream that rejects prompt_cache_key: retried without it, then never sent again', async () => {
    U.handler.fn = (_q, res, body) => {
      if (JSON.parse(body).prompt_cache_key) { res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"Unknown parameter: prompt_cache_key"}}'); return; }
      dsStream(_q, res, body);
    };
    const r = await post('ds', 'sess-2', chatBody('deepseek-v4'));
    expect(r.status).toBe(200);
    expect(U.hits).toHaveLength(2);
    expect(U.hits[1].body).toBe(chatBody('deepseek-v4'));
    expect(meta.provider('ds')!.noPromptCacheKey).toBe(true);
    await post('ds', 'sess-2', chatBody('deepseek-v4'));
    expect(U.hits).toHaveLength(3);
    expect(U.hits[2].body).toBe(chatBody('deepseek-v4'));
  });
  it('errors pass through with their status; non-JSON / other paths are forwarded untouched', async () => {
    U.handler.fn = (_q, res) => res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '9' }).end('{"error":{"message":"slow"}}');
    const r = await post('ds', 'sess-3', chatBody('deepseek-v4'));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('9');
    expect(JSON.parse(r.text).error.message).toBe('slow');
    expect(ledger[0]).toMatchObject({ ok: false, gateway: { upstreamStatus: 429 } });
    U.handler.fn = (_q, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[{"id":"deepseek-v4"}]}');
    const m = await fetch(`${root}/gateway/~p/ds/k/sess-3/v1/models`, { headers: { authorization: `Bearer ${gw.shim.key}` } });
    expect((await m.json()).data[0].id).toBe('deepseek-v4');
    expect(U.hits.at(-1)).toMatchObject({ method: 'GET', url: '/v1/models' });
  });
  it('grok profiles also get x-grok-conv-id (base without /v1 still lands on /v1)', async () => {
    await post('grok', 'sess-4', chatBody('grok-4'));
    expect(U.hits[0].url).toBe('/v1/chat/completions');
    expect(U.hits[0].headers).toMatchObject({ 'x-grok-conv-id': 'cw:sess-4', authorization: 'Bearer sk-grok' });
  });
});

describe('cache shim: gpt-* via /v1/responses', () => {
  it('chat/completions → Responses (store:false, prompt_cache_key), answered back as chat.completion.chunk', async () => {
    U.handler.fn = responsesStream;
    const r = await post('gpt', 'sess-5', chatBody('gpt-5.6'));
    expect(r.status).toBe(200);
    const up = JSON.parse(U.hits[0].body);
    expect(U.hits[0].url).toBe('/v1/responses');
    expect(up).toMatchObject({ model: 'gpt-5.6', store: false, stream: true, prompt_cache_key: 'cw:sess-5', instructions: 'You are Claude Code.', max_output_tokens: 64000 });
    expect(up.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
    expect(U.hits[0].headers).toMatchObject({ session_id: 'cw:sess-5', authorization: 'Bearer sk-gpt' });
    const chunks = r.text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    expect(chunks.at(-1)).toBe('[DONE]');
    const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c));
    expect(parsed.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('via responses');
    expect(parsed.at(-1).usage).toEqual({ prompt_tokens: 30_000, completion_tokens: 7, total_tokens: 30_007, prompt_tokens_details: { cached_tokens: 27_000 } });
    expect(ledger[0]).toMatchObject({ ok: true, input: 3_000, cacheRead: 27_000, output: 7, gateway: { via: 'shim', outbound: 'responses' } });
  });
  it('an endpoint without /v1/responses (404) → chat/completions, remembered; the profile switch turns it off', async () => {
    U.handler.fn = (q, res, body) => { if (q.url?.includes('/responses')) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"Invalid URL (POST /v1/responses)"}}'); return; } dsStream(q, res, body); };
    const r = await post('gpt', 'sess-6', chatBody('gpt-5.6'));
    expect(r.status).toBe(200);
    expect(U.hits.map((h) => h.url)).toEqual(['/v1/responses', '/v1/chat/completions']);
    expect(meta.provider('gpt')!.noResponsesApi).toBe(true);
    delete meta.provider('gpt')!.noResponsesApi;
    meta.provider('gpt')!.responsesApi = false;
    U.hits.length = 0;
    await post('gpt', 'sess-6', chatBody('gpt-5.6'));
    expect(U.hits.map((h) => h.url)).toEqual(['/v1/chat/completions']);
  });
  it('a Responses stream that fails mid-way reaches the client as an error chunk and a failed ledger line', async () => {
    U.handler.fn = (_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(rsse({ type: 'response.created', response: { id: 'r', model: 'gpt-5.6' } }) + rsse({ type: 'response.failed', response: { status: 'failed', error: { message: 'upstream exploded' } } })); };
    const r = await post('gpt', 'sess-8', chatBody('gpt-5.6'));
    expect(r.status).toBe(200);
    expect(r.text).toContain('upstream exploded');
    expect(ledger[0]).toMatchObject({ ok: false, error: 'upstream exploded', gateway: { outbound: 'responses' } });
  });
  it('non-gpt models never convert', async () => {
    await post('gpt', 'sess-7', chatBody('deepseek-v4'));
    expect(U.hits[0].url).toBe('/v1/chat/completions');
  });
});

describe('cache shim: access', () => {
  it('only the internal key, only loopback, only openai / grok profiles', async () => {
    expect((await post('ds', 's', chatBody('x'), { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post('ds', 's', chatBody('x'), {}, remoteRoot)).status).toBe(404);
    expect((await post('ant', 's', chatBody('x'))).status).toBe(404);
    expect((await post('missing', 's', chatBody('x'))).status).toBe(404);
    expect(U.hits).toHaveLength(0);
  });
});

describe('session wiring', () => {
  const svc = () => { const s = new ProviderService(meta); s.shimEndpoint = (id) => gw.shimEndpoint(id); return s; };
  it('openai / grok profiles point ccb at the shim (session key in the path, internal key instead of the real one)', () => {
    const p = svc().forSession('ds')!;
    const env = providerEnv(p, 'claude', { sessionKey: 'abc-123' });
    expect(env.OPENAI_BASE_URL).toBe(`${root}/gateway/~p/ds/k/abc-123/v1`);
    expect(env.OPENAI_API_KEY).toBe(gw.shim.key);
    expect(JSON.stringify(env)).not.toContain('sk-ds');
    const g = providerEnv(svc().forSession('grok')!, 'claude', { sessionKey: 'abc-123' });
    expect(g).toMatchObject({ GROK_BASE_URL: `${root}/gateway/~p/grok/k/abc-123/v1`, GROK_API_KEY: gw.shim.key, CLAUDE_CODE_USE_GROK: '1' });
  });
  it('switch off (cacheShim:false) = straight to the endpoint, as before', () => {
    meta.provider('ds')!.cacheShim = false;
    const env = providerEnv(svc().forSession('ds')!, 'claude', { sessionKey: 'abc' });
    expect(env).toMatchObject({ OPENAI_BASE_URL: `${U.url}/v1`, OPENAI_API_KEY: 'sk-ds' });
    delete meta.provider('ds')!.cacheShim;
  });
  it('an Anthropic profile\'s env is exactly what it was (the fingerprint path is not touched)', () => {
    const p = svc().forSession('ant')!;
    expect((p as any).shim).toBeUndefined();
    expect(providerEnv(p, 'claude', { sessionKey: 'abc' })).toEqual({ CLAUDE_WEB_PLAIN_UA: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_BASE_URL: U.url, ANTHROPIC_AUTH_TOKEN: 'sk-ant' });
  });
});
