import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { TOOLS, callServer } from './mcp.js';
import { webMcpEntry } from './launcher.js';

/** The claude-web server as the MCP process sees it: one endpoint, a bearer, MCP content back. */
interface Hit { method?: string; url?: string; auth?: string; body: any }
const hits: Hit[] = [];
const SECRET = 'unit-test-secret';
let endpoint: http.Server;
let url = '';
let dir = '';

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-webmcp-stdio-'));
  endpoint = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: any = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* kept null */ }
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}'); return; }
      const out = body?.tool === 'browser_screenshot'
        ? { content: [{ type: 'text', text: 'shot' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }] }
        : body?.tool === 'browser_click'
          ? { content: [{ type: 'text', text: '这个操作需要桌面版 Claude Web 的内置浏览器（现在没有桌面窗口连着）。' }], isError: true }
          : { content: [{ type: 'text', text: `${body?.tool} for ${body?.sessionId}: ${JSON.stringify(body?.args)}` }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => endpoint.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
});
afterAll(async () => {
  endpoint.closeAllConnections();
  await new Promise((r) => endpoint.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The MCP server as an agent starts it: a process, JSON-RPC lines over stdio. */
function start(env: Record<string, string>) {
  const entry = webMcpEntry();
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  // a ladder's proxy in the environment, and Node told to use it (NODE_USE_ENV_PROXY makes node:http's default
  // agent proxy everything): the call to this machine must still not go there
  const child: ChildProcess = spawn(process.execPath, entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry], { cwd: serverDir, env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NODE_USE_ENV_PROXY: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const got = new Map<number, any>();
  const waiters = new Map<number, (m: any) => void>();
  let buf = '';
  let stderr = '';
  child.stderr!.on('data', (d) => { stderr += String(d); });
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      got.set(m.id, m);
      waiters.get(m.id)?.(m);
    }
  });
  let seq = 0;
  const rpc = (method: string, params: unknown = {}) => {
    const id = ++seq;
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no answer to ${method} in 25s. stderr: ${stderr.slice(-400)}`)), 25_000);
      waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      if (got.has(id)) { clearTimeout(t); resolve(got.get(id)); }
    });
  };
  const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
  return { child, rpc, exited, notify: (method: string) => child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) };
}

describe('the web MCP server over stdio', () => {
  it('handshakes, lists the ten tools, and carries each call to the server with the secret and the conversation id', async () => {
    const tokenFile = path.join(dir, 'secret.token');
    fs.writeFileSync(tokenFile, `${SECRET}\n`);
    hits.length = 0;
    const m = start({ CW_WEB_URL: url, CW_WEB_TOKEN_FILE: tokenFile, CW_SESSION_ID: 'conv-42' });
    try {
      const init = (await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).result;
      expect(init.serverInfo.name).toBe('claude-web-web');
      expect(init.capabilities).toEqual({ tools: {} });
      expect(init.instructions).toContain('untrusted');
      m.notify('notifications/initialized');
      expect((await m.rpc('ping')).result).toEqual({});
      const tools = (await m.rpc('tools/list')).result.tools;
      expect(tools.map((t: any) => t.name)).toEqual(['web_search', 'browser_open', 'browser_read', 'browser_find', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_back', 'browser_screenshot']);
      expect(hits).toHaveLength(0); // nothing so far needed the server

      const search = (await m.rpc('tools/call', { name: 'web_search', arguments: { query: 'node streams', count: 3 } })).result;
      expect(search).toEqual({ content: [{ type: 'text', text: 'web_search for conv-42: {"query":"node streams","count":3}' }] });
      expect(hits[0]).toEqual({ method: 'POST', url: '/api/web/tool', auth: `Bearer ${SECRET}`, body: { sessionId: 'conv-42', tool: 'web_search', args: { query: 'node streams', count: 3 } } });
      // an image block and an error result pass through as they are
      const shot = (await m.rpc('tools/call', { name: 'browser_screenshot', arguments: {} })).result;
      expect(shot.content[1]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' });
      const click = (await m.rpc('tools/call', { name: 'browser_click', arguments: { ref: '3' } })).result;
      expect(click.isError).toBe(true);
      expect(click.content[0].text).toContain('需要桌面版');
      // no arguments at all is an empty object for the server
      await m.rpc('tools/call', { name: 'browser_back' });
      expect(hits[hits.length - 1].body).toEqual({ sessionId: 'conv-42', tool: 'browser_back', args: {} });
      // what it does not know is a protocol error, and the server is not asked
      const n = hits.length;
      expect((await m.rpc('tools/call', { name: 'rm_rf', arguments: {} })).error.message).toContain('unknown tool');
      expect((await m.rpc('resources/list')).error.code).toBe(-32601);
      expect(hits).toHaveLength(n);
    } finally {
      m.child.stdin!.end();
    }
    expect(await m.exited).toBe(0); // the agent closing stdin ends it
  }, 60_000);

  it('a wrong secret, or no server there: the model reads why, the process stays up', async () => {
    hits.length = 0;
    const m = start({ CW_WEB_URL: url, CW_WEB_TOKEN: 'not-the-secret', CW_SESSION_ID: 's' });
    try {
      const r = (await m.rpc('tools/call', { name: 'web_search', arguments: { query: 'q' } })).result;
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('连不上启动它的 Claude Web');
      expect(hits[0].auth).toBe('Bearer not-the-secret');
      expect((await m.rpc('ping')).result).toEqual({});
    } finally {
      m.child.stdin!.end();
    }
    await m.exited;
  }, 60_000);
});

describe('the tool list', () => {
  it('every tool has a description the model can act on, a schema, and an honest read-only hint', () => {
    for (const t of TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(60);
      expect(t.inputSchema.type, t.name).toBe('object');
      for (const req of (t.inputSchema as { required?: string[] }).required ?? []) expect(Object.keys(t.inputSchema.properties), t.name).toContain(req);
    }
    const readOnly = TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    // reading what is already open, and searching; opening an address or acting on a page is not read-only
    expect(readOnly).toEqual(['web_search', 'browser_read', 'browser_find', 'browser_screenshot']);
  });
});

describe('callServer', () => {
  it('reads the secret from the env or from the file, and never throws', async () => {
    hits.length = 0;
    expect((await callServer('web_search', { query: 'a' }, { CW_WEB_URL: url, CW_WEB_TOKEN: SECRET, CW_SESSION_ID: 'x' })).isError).toBeUndefined();
    const file = path.join(dir, 'other.token');
    fs.writeFileSync(file, SECRET);
    expect((await callServer('web_search', { query: 'a' }, { CW_WEB_URL: url, CW_WEB_TOKEN_FILE: file })).content).toEqual([{ type: 'text', text: 'web_search for : {"query":"a"}' }]);
    // a missing file is a missing secret: the server says no, the model is told to reopen
    const noFile = await callServer('web_search', {}, { CW_WEB_URL: url, CW_WEB_TOKEN_FILE: path.join(dir, 'gone') });
    expect(noFile.isError).toBe(true);
    expect(hits[hits.length - 1].auth).toBe('Bearer'); // nothing after the scheme
    // not configured, not http, nothing listening
    expect((await callServer('web_search', {}, {})).isError).toBe(true);
    expect((await callServer('web_search', {}, { CW_WEB_URL: 'https://example.com' })).isError).toBe(true);
    const dead = await callServer('web_search', {}, { CW_WEB_URL: 'http://127.0.0.1:9', CW_WEB_TOKEN: SECRET });
    expect(dead.isError).toBe(true);
    expect(JSON.stringify(dead.content)).toContain('连不上 Claude Web');
  });

  it('gives up on a server that never answers', async () => {
    const hang = http.createServer(() => { /* never answers */ });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    try {
      const r = await callServer('web_search', {}, { CW_WEB_URL: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`, CW_WEB_TOKEN: SECRET }, 150);
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain('超时');
    } finally {
      hang.closeAllConnections();
      await new Promise((r) => hang.close(r));
    }
  });
});
