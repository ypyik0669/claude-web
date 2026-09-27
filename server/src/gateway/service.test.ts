import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MetaStore } from '../meta/store.js';
import { GatewayService } from './service.js';
import type { LedgerEntry, Provider } from '../protocol.js';

interface Hit { rawHeaders: string[]; headers: http.IncomingHttpHeaders; body: string; url: string }
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

async function fake(): Promise<{ url: string; hits: Hit[]; handler: { fn: Handler }; close(): Promise<void> }> {
  const hits: Hit[] = [];
  const handler: { fn: Handler } = { fn: (_q, res) => res.writeHead(500).end() };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { hits.push({ rawHeaders: req.rawHeaders, headers: req.headers, body, url: req.url ?? '' }); handler.fn(req, res, body); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}`, hits, handler, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

const anthropicOk = (text = 'hello', usage = { input_tokens: 10, output_tokens: 2 }): Handler => (_q, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_1' }).end(JSON.stringify({ id: 'msg_up', type: 'message', role: 'assistant', model: 'up-model', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }));
};
const anthropicSse = (): Handler => (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  res.end([
    ev({ type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'up', content: [], usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 3 } } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streamed' } }),
    ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
    ev({ type: 'message_stop' }),
  ].join(''));
};

let A: Awaited<ReturnType<typeof fake>>;
let B: Awaited<ReturnType<typeof fake>>;
let O: Awaited<ReturnType<typeof fake>>;
let gwSrv: http.Server;
let remoteSrv: http.Server;
let gw: GatewayService;
let meta: MetaStore;
let base: string;
let remoteBase: string;
let key: string;
const ledger: LedgerEntry[] = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gw-'));

async function call(p: string, body: unknown, headers: Record<string, string> = {}, root = base) {
  const r = await fetch(`${root}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

beforeAll(async () => {
  [A, B, O] = await Promise.all([fake(), fake(), fake()]);
  meta = new MetaStore(path.join(dir, 'meta.json'));
  // upsertProvider mints its own ids; pin them to a / b / o so the assertions stay readable
  const mk = async (id: string, type: Provider['type'], baseUrl: string) => { const p = await meta.upsertProvider({ name: `P-${id}`, type, baseUrl, apiKey: `sk-${id}` }); p.id = id; };
  await mk('a', 'anthropic', A.url);
  await mk('b', 'anthropic', B.url);
  await mk('o', 'openai', `${O.url}/v1`);
  gw = new GatewayService({ meta, member: (id) => meta.provider(id) ?? null, ledger: { record: (e) => ledger.push(e) }, firstByteMs: 400 });
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => { if (!gw.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))) res.writeHead(418).end(); };
  gwSrv = http.createServer(handler);
  remoteSrv = http.createServer(handler);
  remoteSrv.on('connection', (s) => { (s as any).cwRemote = true; });
  await new Promise<void>((r) => gwSrv.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => remoteSrv.listen(0, '127.0.0.1', () => r()));
  gw.port = (gwSrv.address() as any).port;
  base = `http://127.0.0.1:${gw.port}/gateway`;
  remoteBase = `http://127.0.0.1:${(remoteSrv.address() as any).port}/gateway`;
  await gw.setEnabled(true);
  key = gw.revealKey();
  await gw.upsertGroup({ id: 'main', name: 'Main', strategy: 'failover', members: [{ providerId: 'a' }, { providerId: 'b' }] });
  await gw.upsertGroup({ id: 'mixed', name: 'Mixed', strategy: 'failover', members: [{ providerId: 'o', model: 'gpt-4.1' }] });
});
afterAll(async () => {
  for (const s of [gwSrv, remoteSrv]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  await Promise.all([A.close(), B.close(), O.close()]);
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  A.hits.length = 0; B.hits.length = 0; O.hits.length = 0; ledger.length = 0;
  gw.reset('main'); gw.reset('mixed');
  A.handler.fn = anthropicOk('from A');
  B.handler.fn = anthropicOk('from B');
});

const msg = { model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };

describe('auth and reachability', () => {
  it('rejects missing / wrong keys, unknown groups, and the LAN listener', async () => {
    expect((await call('/main/v1/messages', msg, { 'x-api-key': 'nope' })).status).toBe(401);
    const bad = await call('/nope/v1/messages', msg);
    expect(bad.status).toBe(404);
    expect(JSON.parse(bad.text).type).toBe('error');
    expect((await call('/main/v1/messages', msg, {}, remoteBase)).status).toBe(404);
    expect(A.hits).toHaveLength(0);
  });
  it('Bearer works too; the endpoint helper reflects enable state', async () => {
    const r = await call('/main/v1/messages', msg, { 'x-api-key': '', authorization: `Bearer ${key}` });
    expect(r.status).toBe(200);
    expect(gw.endpoint('main')).toEqual({ baseUrl: `${base}/main`, key });
    expect(gw.endpoint('missing')).toBeNull();
  });
});

describe('passthrough', () => {
  it('forwards body bytes and fingerprint headers unchanged, swaps only the credential', async () => {
    const raw = '{"model":"claude-sonnet-4-5",  "max_tokens":8,"messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"You are Claude Code"}]}';
    const r = await call('/main/v1/messages?beta=true', raw, { 'user-agent': 'claude-cli/2.1.300 (external, cli)', 'anthropic-beta': 'claude-code-20250219', 'x-app': 'cli' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).content[0].text).toBe('from A');
    expect(r.headers.get('request-id')).toBe('req_1');
    expect(decodeURIComponent(r.headers.get('x-cw-gateway-member')!)).toBe('P-a');
    const h = A.hits[0];
    expect(h.url).toBe('/v1/messages?beta=true');
    expect(h.body).toBe(raw);
    expect(h.headers['user-agent']).toBe('claude-cli/2.1.300 (external, cli)');
    expect(h.headers['anthropic-beta']).toBe('claude-code-20250219');
    expect(h.headers['anthropic-version']).toBe('2023-06-01');
    expect(h.headers['x-app']).toBe('cli');
    expect(h.headers['x-api-key']).toBe('sk-a');
    expect(JSON.stringify(h.rawHeaders)).not.toContain(key);
    expect(ledger[0]).toMatchObject({ kind: 'gateway', ok: true, providerId: 'a', input: 10, output: 2, gateway: { group: 'Main', inbound: 'anthropic', member: 'P-a', switches: 0, stream: false } });
  });
  it('streams SSE through and sniffs usage for the ledger', async () => {
    A.handler.fn = anthropicSse();
    const r = await call('/main/v1/messages', { ...msg, stream: true });
    expect(r.text).toContain('event: message_stop');
    expect(r.text).toContain('streamed');
    expect(ledger[0]).toMatchObject({ ok: true, input: 7, output: 4, cacheRead: 3, gateway: { stream: true } });
  });
  it('modelMap / member pin rewrite only the model field', async () => {
    await gw.upsertGroup({ id: 'main', members: [{ providerId: 'a', model: 'claude-opus-4-1' }, { providerId: 'b' }] });
    const raw = '{"model":"claude-sonnet-4-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}';
    await call('/main/v1/messages', raw);
    expect(A.hits[0].body).toBe(raw.replace('claude-sonnet-4-5', 'claude-opus-4-1'));
    await gw.upsertGroup({ id: 'main', members: [{ providerId: 'a' }, { providerId: 'b' }] });
  });
});

describe('failover', () => {
  it('500 → next member; the failed one cools down and is skipped next time', async () => {
    A.handler.fn = (_q, res) => res.writeHead(529, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    const r = await call('/main/v1/messages', msg);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).content[0].text).toBe('from B');
    expect(r.headers.get('x-cw-gateway-switches')).toBe('1');
    expect(ledger[0]).toMatchObject({ ok: true, providerId: 'b', gateway: { switches: 1 } });
    const st = gw.status().states.main;
    expect(st[0].health).toBe('cooling');
    expect(st[0].lastStatus).toBe(529);
    await call('/main/v1/messages', msg);
    expect(A.hits).toHaveLength(1); // skipped while cooling
    expect(B.hits).toHaveLength(2);
  });
  it('429 with retry-after cools the member until then', async () => {
    A.handler.fn = (_q, res) => res.writeHead(429, { 'retry-after': '120', 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
    const t = Date.now();
    await call('/main/v1/messages', msg);
    const s = gw.status().states.main[0];
    expect(s.health).toBe('cooling');
    expect(s.cooldownUntil! - t).toBeGreaterThanOrEqual(119_000);
    expect(s.cooldownUntil! - t).toBeLessThan(125_000);
  });
  it('401 disables the member until reset', async () => {
    A.handler.fn = (_q, res) => res.writeHead(401).end('{"error":{"message":"invalid x-api-key"}}');
    await call('/main/v1/messages', msg);
    expect(gw.status().states.main[0].health).toBe('disabled');
    gw.reset('main', 'a');
    expect(gw.status().states.main[0].health).not.toBe('disabled');
  });
  it('a 400 is the request\'s fault: returned as is, no switch', async () => {
    A.handler.fn = (_q, res) => res.writeHead(400, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}');
    const r = await call('/main/v1/messages', msg);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error.message).toBe('bad');
    expect(B.hits).toHaveLength(0);
  });
  it('first-byte timeout (headers then silence) switches', async () => {
    A.handler.fn = (_q, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); };
    B.handler.fn = anthropicSse();
    const r = await call('/main/v1/messages', { ...msg, stream: true });
    expect(r.text).toContain('streamed');
    expect(B.hits).toHaveLength(1);
  });
  it('once the stream has started, an upstream error is reported, never switched', async () => {
    A.handler.fn = (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', usage: {} } })}\n\n`);
      setTimeout(() => res.socket?.destroy(), 30);
    };
    const r = await fetch(`${base}/main/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ ...msg, stream: true }) });
    const text = await r.text().catch(() => '(cut)');
    expect(r.status).toBe(200);
    expect(text === '(cut)' || text.includes('message_start')).toBe(true);
    expect(B.hits).toHaveLength(0);
  });
  it('all members cooling → 429 with retry-after', async () => {
    const rl: Handler = (_q, res) => res.writeHead(429, { 'retry-after': '60' }).end('{}');
    A.handler.fn = rl;
    B.handler.fn = rl;
    const first = await call('/main/v1/messages', msg);
    expect(first.status).toBe(429);
    const second = await call('/main/v1/messages', msg);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(50);
    expect(A.hits.length + B.hits.length).toBe(2);
  });
});

describe('translation through the service', () => {
  it('anthropic in → openai member (mapped model), non-stream', async () => {
    O.handler.fn = (_q, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content: 'translated' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }));
    const r = await call('/mixed/v1/messages', msg);
    expect(r.status).toBe(200);
    const j = JSON.parse(r.text);
    expect(j).toMatchObject({ type: 'message', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'translated' }], stop_reason: 'end_turn' });
    const up = JSON.parse(O.hits[0].body);
    expect(O.hits[0].url).toBe('/v1/chat/completions');
    expect(O.hits[0].headers.authorization).toBe('Bearer sk-o');
    expect(up.model).toBe('gpt-4.1');
    expect(ledger[0]).toMatchObject({ ok: true, model: 'gpt-4.1', input: 4, output: 1, gateway: { inbound: 'anthropic', outbound: 'openai' } });
  });
  it('unsupported direction → 400 naming it', async () => {
    await gw.upsertGroup({ id: 'gem', name: 'Gem', members: [{ providerId: 'o' }] });
    const r = await fetch(`${base}/gem/v1beta/models/gemini-2.5-pro:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'x' }] }] }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error.status).toBe('INVALID_ARGUMENT');
  });
  it('count_tokens without an Anthropic member is estimated; /v1/models lists the group', async () => {
    const r = await call('/mixed/v1/messages/count_tokens', msg);
    expect(JSON.parse(r.text).input_tokens).toBeGreaterThan(0);
    const m = await fetch(`${base}/mixed/v1/models`, { headers: { authorization: `Bearer ${key}` } });
    expect((await m.json()).data.map((x: any) => x.id)).toContain('gpt-4.1');
  });
});

describe('session wiring', () => {
  it('providerEnv maps a gateway profile to each agent\'s own variables', async () => {
    const { providerEnv } = await import('../providers/service.js');
    const p: Provider = { id: 'gw', name: 'GW', type: 'gateway', gatewayGroupId: 'main', baseUrl: `${base}/main`, apiKey: key, createdAt: 0 };
    expect(providerEnv(p)).toMatchObject({ ANTHROPIC_BASE_URL: `${base}/main`, ANTHROPIC_AUTH_TOKEN: key, CLAUDE_WEB_PLAIN_UA: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' });
    expect(providerEnv(p, 'codex')).toEqual({ OPENAI_BASE_URL: `${base}/main/v1`, OPENAI_API_KEY: key });
    expect(providerEnv(p, 'acp')).toMatchObject({ GOOGLE_GEMINI_BASE_URL: `${base}/main`, GEMINI_API_KEY: key, OPENAI_BASE_URL: `${base}/main/v1` });
  });
  it('translated stream end to end: openai in → anthropic member', async () => {
    await gw.upsertGroup({ id: 'main', members: [{ providerId: 'a' }] });
    A.handler.fn = anthropicSse();
    const r = await fetch(`${base}/main/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-x', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
    const text = await r.text();
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('"content":"streamed"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    expect(JSON.parse(A.hits[0].body)).toMatchObject({ model: 'claude-x', stream: true, max_tokens: 8192 });
    expect(ledger[0]).toMatchObject({ ok: true, input: 7, output: 4, gateway: { inbound: 'openai', outbound: 'anthropic', stream: true } });
    await gw.upsertGroup({ id: 'main', members: [{ providerId: 'a' }, { providerId: 'b' }] });
  });
});
