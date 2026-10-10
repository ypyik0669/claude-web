import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebService } from './service.js';
import { WEB_TOOL_PATH, handleWebTool } from './http.js';

let web: WebService;
let local: http.Server;
let remote: http.Server;
let localPort = 0;
let remotePort = 0;
const seen: { sessionId: string; tool: string; args: Record<string, unknown> }[] = [];

beforeAll(async () => {
  web = new WebService({ settings: () => ({}), setSetting: async () => {}, secrets: { protect: async (p) => p, reveal: async (v) => v ?? '' }, env: {} });
  // the endpoint is about who may call and what comes back; what a tool does is service.test.ts
  web.tool = async (sessionId, tool, args) => { seen.push({ sessionId, tool, args: args ?? {} }); return { content: [{ type: 'text', text: `ran ${tool}` }] }; };
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!handleWebTool(web, req, res, new URL(req.url ?? '/', 'http://x'))) { res.writeHead(418).end('not this endpoint'); }
  };
  local = http.createServer(handler);
  // the remote-access listener shares the handler; its sockets are marked (remote/service.ts)
  remote = http.createServer(handler);
  remote.on('connection', (s) => { (s as any).cwRemote = true; });
  await new Promise<void>((r) => local.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => remote.listen(0, '127.0.0.1', () => r()));
  localPort = (local.address() as AddressInfo).port;
  remotePort = (remote.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of [local, remote]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
});

const call = (port: number, o: { token?: string; body?: string; method?: string; path?: string; auth?: string } = {}) =>
  fetch(`http://127.0.0.1:${port}${o.path ?? WEB_TOOL_PATH}`, {
    method: o.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(o.auth !== undefined ? { authorization: o.auth } : o.token !== undefined ? { authorization: `Bearer ${o.token}` } : {}) },
    ...(o.method === 'GET' ? {} : { body: o.body ?? JSON.stringify({ sessionId: 's1', tool: 'web_search', args: { query: 'q' } }) }),
  });

describe('POST /api/web/tool', () => {
  it('runs a tool call for this start\'s secret and answers with MCP content', async () => {
    const res = await call(localPort, { token: web.token });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(await res.json()).toEqual({ content: [{ type: 'text', text: 'ran web_search' }] });
    expect(seen.pop()).toEqual({ sessionId: 's1', tool: 'web_search', args: { query: 'q' } });
    // the bearer scheme in any case; arguments that are not an object count as none
    const r2 = await call(localPort, { auth: `bearer ${web.token}`, body: JSON.stringify({ tool: 'browser_back', args: [1, 2] }) });
    expect(r2.status).toBe(200);
    expect(seen.pop()).toEqual({ sessionId: '', tool: 'browser_back', args: {} });
  });

  it('refuses a wrong, missing or differently presented secret — before running anything', async () => {
    for (const o of [{ token: 'wrong' }, { token: '' }, {}, { token: `${web.token}x` }, { auth: web.token }, { auth: `Basic ${web.token}` }]) {
      const res = await call(localPort, o);
      expect(res.status, JSON.stringify(o)).toBe(401);
    }
    // the secret in the URL is not a way in either
    expect((await call(localPort, { path: `${WEB_TOOL_PATH}?token=${web.token}` })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('does not exist on the remote-access listener, even with the right secret', async () => {
    const res = await call(remotePort, { token: web.token });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(seen).toHaveLength(0);
  });

  it('POST only, JSON only, small bodies only; other paths are not its business', async () => {
    expect((await call(localPort, { token: web.token, method: 'GET' })).status).toBe(405);
    expect((await call(localPort, { token: web.token, body: 'not json' })).status).toBe(400);
    expect((await call(localPort, { token: web.token, body: JSON.stringify({ args: {} }) })).status).toBe(400);
    expect((await call(localPort, { token: web.token, body: JSON.stringify({ tool: 'browser_type', args: { text: 'x'.repeat(300_000) } }) })).status).toBe(413);
    expect((await call(localPort, { token: web.token, path: '/api/web/tool/extra' })).status).toBe(418);
    expect((await call(localPort, { token: web.token, path: '/api/web' })).status).toBe(418);
    expect(seen).toHaveLength(0);
  });
});
