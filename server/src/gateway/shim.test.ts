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
  const r = await fetch(`${base}/gateway/~p/${pid}/k/${sid}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gw.shim.keyFor(pid)}`, 'content-type': 'application/json', 'x-stainless-lang': 'js', 'user-agent': 'OpenAI/JS 5.0', ...headers }, body });
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
  for (const id of ['ds', 'gpt', 'grok']) { const p = meta.provider(id)!; delete p.noPromptCacheKey; delete p.noResponsesApi; delete p.responsesApi; delete p.noCacheRetention; }
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
    expect(h.headers).toMatchObject({ session_id: 'cw:sess-1', 'x-session-affinity': 'cw:sess-1', 'x-stainless-lang': 'js', 'user-agent': 'OpenAI/JS 5.0' });
    expect(h.headers['x-client-request-id']).toBeUndefined();
    expect(h.headers['x-grok-conv-id']).toBeUndefined();
    expect(JSON.stringify(h.rawHeaders)).not.toContain(gw.shim.keyFor('ds'));
    // every byte of the stream as sent, except the usage line which gains prompt_tokens_details.cached_tokens
    const usageLine = DS_STREAM.split('\n').find((l) => l.includes('"usage"'))!;
    const fixed = JSON.parse(usageLine.slice(6));
    fixed.usage.prompt_tokens_details = { cached_tokens: 15_000 };
    expect(r.text).toBe(DS_STREAM.replace(usageLine, `data: ${JSON.stringify(fixed)}`));
    expect(ledger[0]).toMatchObject({ kind: 'gateway', sessionId: 'sess-1', providerId: 'ds', model: 'deepseek-v4', ok: true, input: 5_000, cacheRead: 15_000, output: 5, costUsd: 0, costUnknown: true, gateway: { via: 'shim', member: 'P-ds', outbound: 'openai', stream: true } });
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
  it('a 400 that does not name prompt_cache_key: this request is retried without it, nothing is remembered', async () => {
    U.handler.fn = (_q, res, body) => {
      if (JSON.parse(body).prompt_cache_key) { res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"bad request, try again"}}'); return; }
      dsStream(_q, res, body);
    };
    const r = await post('ds', 'sess-2b', chatBody('deepseek-v4'));
    expect(r.status).toBe(200);
    expect(U.hits).toHaveLength(2);
    expect(meta.provider('ds')!.noPromptCacheKey).toBeUndefined();
  });
  it('streaming is decided by the request, not the content-type (a relay that streams SSE as text/plain still gets the usage fix)', async () => {
    U.handler.fn = (_q, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(DS_STREAM); };
    const r = await post('ds', 'sess-ct', chatBody('deepseek-v4'));
    expect(r.text).toContain('"prompt_tokens_details":{"cached_tokens":15000}');
    expect(r.text.trim().endsWith('data: [DONE]')).toBe(true);
    expect(ledger[0]).toMatchObject({ ok: true, cacheRead: 15_000 });
  });
  it('a forked session: cache key from the parent (k), ledger rows under the fork\'s own id (s)', async () => {
    await post('ds', 'parent-1/s/fork-1', chatBody('deepseek-v4'));
    expect(U.hits[0].body.startsWith('{"prompt_cache_key":"cw:parent-1",')).toBe(true);
    expect(ledger[0]).toMatchObject({ sessionId: 'fork-1' });
  });
  it('errors pass through with their status; non-JSON / other paths are forwarded untouched', async () => {
    U.handler.fn = (_q, res) => res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '9' }).end('{"error":{"message":"slow"}}');
    const r = await post('ds', 'sess-3', chatBody('deepseek-v4'));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('9');
    expect(JSON.parse(r.text).error.message).toBe('slow');
    expect(ledger[0]).toMatchObject({ ok: false, gateway: { upstreamStatus: 429 } });
    U.handler.fn = (_q, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[{"id":"deepseek-v4"}]}');
    const m = await fetch(`${root}/gateway/~p/ds/k/sess-3/v1/models`, { headers: { authorization: `Bearer ${gw.shim.keyFor('ds')}` } });
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
    expect(up).toMatchObject({ model: 'gpt-5.6', store: false, stream: true, prompt_cache_key: 'cw:sess-5', prompt_cache_retention: '24h', instructions: 'You are Claude Code.', max_output_tokens: 64000 });
    expect(up.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
    expect(U.hits[0].headers).toMatchObject({ session_id: 'cw:sess-5', authorization: 'Bearer sk-gpt' });
    const chunks = r.text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
    expect(chunks.at(-1)).toBe('[DONE]');
    const parsed = chunks.slice(0, -1).map((c) => JSON.parse(c));
    expect(parsed.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('via responses');
    expect(parsed.at(-1).usage).toEqual({ prompt_tokens: 30_000, completion_tokens: 7, total_tokens: 30_007, prompt_tokens_details: { cached_tokens: 27_000 } });
    expect(ledger[0]).toMatchObject({ ok: true, input: 3_000, cacheRead: 27_000, output: 7, gateway: { via: 'shim', outbound: 'responses' } });
  });
  it('an endpoint without /v1/responses (404): this request goes to chat/completions, and only because chat worked is it remembered; the profile switch turns it off', async () => {
    let chatOk = false;
    U.handler.fn = (q, res, body) => {
      if (q.url?.includes('/responses')) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"Invalid URL (POST /v1/responses)"}}'); return; }
      if (!chatOk) { res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":{"message":"busy"}}'); return; }
      dsStream(q, res, body);
    };
    const failed = await post('gpt', 'sess-6', chatBody('gpt-5.6'));
    expect(failed.status).toBe(503); // chat's own answer
    expect(meta.provider('gpt')!.noResponsesApi).toBeUndefined(); // chat did not work: nothing proven
    chatOk = true;
    U.hits.length = 0;
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
  it('404 model_not_found on /v1/responses: chat/completions this once, nothing remembered (the endpoint exists)', async () => {
    U.handler.fn = (q, res) => {
      if (q.url?.includes('/responses')) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"The model `gpt-typo` does not exist","code":"model_not_found"}}'); return; }
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"model not found"}}');
    };
    const r = await post('gpt', 'sess-9', chatBody('gpt-typo'));
    expect(r.status).toBe(404);
    // both failed: the client sees what /v1/responses said (the model), not the fallback's error
    expect(r.text).toContain('gpt-typo');
    expect(U.hits.map((h) => h.url)).toEqual(['/v1/responses', '/v1/chat/completions']);
    expect(meta.provider('gpt')!.noResponsesApi).toBeUndefined();
    // … and even when chat then works, a model error is no proof the Responses API is missing
    U.handler.fn = (q, res, body) => { if (q.url?.includes('/responses')) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":"model_not_found","message":"no such model"}}'); return; } dsStream(q, res, body); };
    expect((await post('gpt', 'sess-9', chatBody('gpt-typo'))).status).toBe(200);
    expect(meta.provider('gpt')!.noResponsesApi).toBeUndefined();
  });
  it('400 / 5xx from /v1/responses: chat/completions this once, not remembered; 429 is passed back as is', async () => {
    for (const status of [400, 500, 502]) {
      U.hits.length = 0;
      U.handler.fn = (q, res, body) => { if (q.url?.includes('/responses')) { res.writeHead(status, { 'content-type': 'application/json' }).end('{"error":{"message":"nope"}}'); return; } dsStream(q, res, body); };
      const r = await post('gpt', 'sess-10', chatBody('gpt-5.6'));
      expect(r.status).toBe(200);
      expect(U.hits.map((h) => h.url).at(-1)).toBe('/v1/chat/completions');
      expect(meta.provider('gpt')!.noResponsesApi).toBeUndefined();
    }
    U.hits.length = 0;
    U.handler.fn = (_q, res) => res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' }).end('{"error":{"message":"slow"}}');
    const rl = await post('gpt', 'sess-10', chatBody('gpt-5.6'));
    expect(rl.status).toBe(429);
    expect(U.hits.map((h) => h.url)).toEqual(['/v1/responses']);
  });
  it('prompt_cache_retention rejected by name: retried without it, only that is remembered', async () => {
    U.handler.fn = (_q, res, body) => {
      if (JSON.parse(body).prompt_cache_retention) { res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"Unknown parameter: \'prompt_cache_retention\'."}}'); return; }
      responsesStream(_q, res, body);
    };
    const r = await post('gpt', 'sess-11', chatBody('gpt-5.6'));
    expect(r.status).toBe(200);
    expect(U.hits).toHaveLength(2);
    expect(JSON.parse(U.hits[1].body).prompt_cache_retention).toBeUndefined();
    expect(meta.provider('gpt')!.noCacheRetention).toBe(true);
    expect(meta.provider('gpt')!.noPromptCacheKey).toBeUndefined();
    U.hits.length = 0;
    await post('gpt', 'sess-11', chatBody('gpt-5.6'));
    expect(U.hits).toHaveLength(1);
    expect(JSON.parse(U.hits[0].body)).toMatchObject({ prompt_cache_key: 'cw:sess-11' });
    expect(JSON.parse(U.hits[0].body).prompt_cache_retention).toBeUndefined();
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
  it('the key is per profile: one session\'s key does not open another profile', async () => {
    expect(gw.shim.keyFor('ds')).not.toBe(gw.shim.keyFor('gpt'));
    expect(gw.shim.keyFor('ds')).toBe(gw.shim.keyFor('ds'));
    expect((await post('ds', 's', chatBody('x'), { authorization: `Bearer ${gw.shim.keyFor('gpt')}` })).status).toBe(401);
    expect(U.hits).toHaveLength(0);
  });
  it('only the model list (GET) and chat/completions (POST) are forwarded', async () => {
    U.handler.fn = (_q, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
    const call = (method: string, p: string, body?: string) => fetch(`${root}/gateway/~p/ds/k/s${p}`, { method, headers: { authorization: `Bearer ${gw.shim.keyFor('ds')}`, 'content-type': 'application/json' }, body }).then((r) => r.status);
    expect(await call('GET', '/v1/models')).toBe(200);
    expect(await call('GET', '/v1/models/deepseek-v4')).toBe(200);
    expect(await call('POST', '/v1/embeddings', '{"input":"x"}')).toBe(404);
    expect(await call('DELETE', '/v1/models/x')).toBe(404);
    expect(await call('GET', '/v1/files')).toBe(404);
    expect(await call('POST', '/v1/models', '{}')).toBe(404);
    expect(U.hits.map((h) => `${h.method} ${h.url}`)).toEqual(['GET /v1/models', 'GET /v1/models/deepseek-v4']);
  });
});

describe('session wiring', () => {
  const svc = () => { const s = new ProviderService(meta); s.shimEndpoint = (id) => gw.shimEndpoint(id); return s; };
  it('openai / grok profiles point ccb at the shim (session key in the path, internal key instead of the real one)', () => {
    const p = svc().forSession('ds')!;
    const env = providerEnv(p, 'claude', { sessionKey: 'abc-123' });
    expect(env.OPENAI_BASE_URL).toBe(`${root}/gateway/~p/ds/k/abc-123/v1`);
    expect(env.OPENAI_API_KEY).toBe(gw.shim.keyFor('ds'));
    expect(JSON.stringify(env)).not.toContain('sk-ds');
    const g = providerEnv(svc().forSession('grok')!, 'claude', { sessionKey: 'abc-123' });
    expect(g).toMatchObject({ GROK_BASE_URL: `${root}/gateway/~p/grok/k/abc-123/v1`, GROK_API_KEY: gw.shim.keyFor('grok'), CLAUDE_CODE_USE_GROK: '1' });
    // a fork: parent's key for the cache route, its own id for the ledger
    expect(providerEnv(p, 'claude', { sessionKey: 'parent', sessionId: 'fork' }).OPENAI_BASE_URL).toBe(`${root}/gateway/~p/ds/k/parent/s/fork/v1`);
    expect(providerEnv(p, 'claude', { sessionKey: 'same', sessionId: 'same' }).OPENAI_BASE_URL).toBe(`${root}/gateway/~p/ds/k/same/v1`);
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

describe('cache shim: Codex (/v1/responses in) on an openai profile', () => {
  // what Codex sends (shape per codex-rs): instructions, developer + user items, a function tool and the freeform apply_patch
  const codexBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
    model: 'deepseek-chat',
    instructions: 'You are Codex.',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>…</permissions>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":["ls"]}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.ts' },
    ],
    tools: [
      { type: 'function', name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } } }, strict: false },
      { type: 'custom', name: 'apply_patch', description: 'Edit files', format: { type: 'grammar', syntax: 'lark', definition: 'start: patch' } },
    ],
    tool_choice: 'auto', parallel_tool_calls: false, reasoning: { effort: 'medium' }, store: false, stream: true,
    include: ['reasoning.encrypted_content'], prompt_cache_key: 'thread-1', ...extra,
  });
  const postR = (pid: string, body: string, sid = 'cx-sess') => fetch(`${root}/gateway/~p/${pid}/k/${sid}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${gw.shim.keyFor(pid)}`, 'content-type': 'application/json' }, body }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const events = (text: string) => text.split('\n\n').filter((b) => b.includes('data: ')).map((b) => JSON.parse(b.slice(b.indexOf('data: ') + 6)));
  const noResponses: Handler = (q, res, body) => {
    if (q.url?.includes('/responses')) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"Invalid URL (POST /v1/responses)"}}'); return; }
    dsStream(q, res, body);
  };

  it('a relay with the Responses API: forwarded as it is (Codex keeps its own prompt_cache_key), the stream passes through, usage in the ledger', async () => {
    U.handler.fn = responsesStream;
    const r = await postR('ds', codexBody());
    expect(r.status).toBe(200);
    expect(U.hits.map((h) => h.url)).toEqual(['/v1/responses']);
    expect(U.hits[0].body).toBe(codexBody()); // byte for byte
    expect(U.hits[0].headers.authorization).toBe('Bearer sk-ds');
    expect(events(r.text).at(-1)).toMatchObject({ type: 'response.completed' });
    expect(ledger.at(-1)).toMatchObject({ ok: true, input: 3_000, cacheRead: 27_000, output: 7, sessionId: 'cx-sess', gateway: { via: 'shim', inbound: 'responses', outbound: 'responses' } });
    expect(meta.provider('ds')!.noResponsesApi).toBeUndefined();
  });

  it('a chat-only relay (404 on /v1/responses): translated to chat/completions, answered as Responses events; remembered, the next request goes straight to chat', async () => {
    U.handler.fn = noResponses;
    const r = await postR('ds', codexBody());
    expect(r.status).toBe(200);
    expect(U.hits.map((h) => h.url)).toEqual(['/v1/responses', '/v1/chat/completions']);
    const chat = JSON.parse(U.hits[1].body);
    expect(chat).toMatchObject({ model: 'deepseek-chat', stream: true, stream_options: { include_usage: true }, prompt_cache_key: 'thread-1' });
    expect(chat.reasoning_effort).toBeUndefined(); // not an o-series / gpt-5 model: chat relays may reject it
    expect(chat.messages).toEqual([
      { role: 'system', content: 'You are Codex.\n\n<permissions>…</permissions>' },
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":["ls"]}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'a.ts' },
    ]);
    expect(chat.tools.map((t: any) => t.function.name)).toEqual(['shell', 'apply_patch']);
    expect(chat.tools[1].function.parameters).toMatchObject({ properties: { input: { type: 'string' } } });
    const ev = events(r.text);
    expect(ev[0].type).toBe('response.created');
    expect(ev.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('')).toBe('done');
    expect(ev.at(-1)).toMatchObject({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 20_000, input_tokens_details: { cached_tokens: 15_000 }, output_tokens: 5 } } });
    expect(ledger.at(-1)).toMatchObject({ ok: true, cacheRead: 15_000, gateway: { inbound: 'responses', outbound: 'openai' } });
    expect(meta.provider('ds')!.noResponsesApi).toBe(true);
    U.hits.length = 0;
    expect((await postR('ds', codexBody())).status).toBe(200);
    expect(U.hits.map((h) => h.url)).toEqual(['/v1/chat/completions']);
  });

  it('tool calls come back as Codex items: a function as function_call, the freeform apply_patch as custom_tool_call with its raw input', async () => {
    meta.provider('ds')!.noResponsesApi = true;
    const patch = '*** Begin Patch\n*** End Patch';
    U.handler.fn = (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'shell', arguments: '{"command":' } }] }, finish_reason: null }] })
        + chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '["pwd"]}' } }] }, finish_reason: null }] })
        + chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ input: patch }) } }] }, finish_reason: null }] })
        + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        + 'data: [DONE]\n\n');
    };
    const r = await postR('ds', codexBody());
    const items = events(r.text).filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
    expect(items).toEqual([
      expect.objectContaining({ type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"command":["pwd"]}' }),
      expect.objectContaining({ type: 'custom_tool_call', call_id: 'call_b', name: 'apply_patch', input: patch }),
    ]);
  });

  it('gpt-5 on a chat-only relay keeps the effort Codex asked for; both endpoints failing shows the Responses error', async () => {
    meta.provider('ds')!.noResponsesApi = true;
    await postR('ds', codexBody({ model: 'gpt-5.2' }));
    expect(JSON.parse(U.hits[0].body)).toMatchObject({ model: 'gpt-5.2', reasoning_effort: 'medium' });
    delete meta.provider('ds')!.noResponsesApi;
    U.hits.length = 0;
    U.handler.fn = (q, res) => {
      if (q.url?.includes('/responses')) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"Invalid URL (POST /v1/responses)"}}'); return; }
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"bad key"}}');
    };
    const r = await postR('ds', codexBody());
    expect(r.status).toBe(404);
    expect(meta.provider('ds')!.noResponsesApi).toBeUndefined(); // chat did not work: nothing proven
  });

  it('errors from a relay that has the Responses API pass back as they are (429 with its headers)', async () => {
    U.handler.fn = (_q, res) => res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' }).end('{"error":{"message":"slow down"}}');
    const r = await fetch(`${root}/gateway/~p/ds/k/s/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${gw.shim.keyFor('ds')}` }, body: codexBody() });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('7');
    expect(U.hits.map((h) => h.url)).toEqual(['/v1/responses']);
  });

  it('only openai profiles take /v1/responses (grok: 404, nothing sent)', async () => {
    expect((await postR('grok', codexBody())).status).toBe(404);
    expect(U.hits).toHaveLength(0);
  });

  it('agentLaunch: Codex on an openai profile goes through the shim (its key, never the real one); cacheShim:false = straight to the relay', () => {
    const s = new ProviderService(meta);
    s.shimEndpoint = (id) => gw.shimEndpoint(id);
    const l = s.agentLaunch('ds', 'codex', 'codex', 'sess-x');
    const base = `${root}/gateway/~p/ds/k/sess-x/v1`;
    expect(l.env).toEqual({ OPENAI_BASE_URL: base, OPENAI_API_KEY: gw.shim.keyFor('ds'), CW_GATEWAY_KEY: gw.shim.keyFor('ds') });
    expect(l.args).toContain(`model_providers.cwgw.base_url=${JSON.stringify(base)}`);
    expect(JSON.stringify(l)).not.toContain('sk-ds');
    meta.provider('ds')!.cacheShim = false;
    expect(s.agentLaunch('ds', 'codex', 'codex', 'sess-x').env).toMatchObject({ OPENAI_BASE_URL: `${U.url}/v1`, CW_GATEWAY_KEY: 'sk-ds' });
    delete meta.provider('ds')!.cacheShim;
  });
});

describe('clientErrorBody: an upstream error the OpenAI SDKs can read', () => {
  it('wraps a {code, message} body and plain text; leaves an {error} body alone', async () => {
    const { clientErrorBody } = await import('./shim.js');
    expect(JSON.parse(clientErrorBody('{"code":"INSUFFICIENT_BALANCE","message":"Insufficient account balance"}')!)).toEqual({ error: { message: 'Insufficient account balance', type: 'upstream_error', code: 'INSUFFICIENT_BALANCE' } });
    expect(JSON.parse(clientErrorBody('Bad Gateway')!).error.message).toBe('Bad Gateway');
    expect(JSON.parse(clientErrorBody('')!).error.message).toMatch(/empty body/);
    expect(clientErrorBody('{"error":{"message":"model not found","type":"invalid_request_error"}}')).toBeNull();
    expect(clientErrorBody('{"error":"nope"}')).toBeNull();
  });
});
