import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { EGO_TOOLS, TOOLS, callServer, callTimeoutOf, instructionsFor, toolsFor } from './mcp.js';
import { SITE_ASK_TIMEOUT_MS } from './site-gate.js';
import { webMcpEntry } from './launcher.js';
import { formatSnapshot } from './format.js';

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
  it('handshakes, lists the thirty-three tools (twenty-one of 联网, five of 网吧, seven of 字符画主题), and carries each call to the server with the secret and the conversation id', async () => {
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
      expect(tools.map((t: any) => t.name)).toEqual(['web_search', 'browser_open', 'browser_read', 'browser_find', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_back', 'browser_screenshot', 'browser_computer', 'browser_console', 'browser_network', 'browser_snapshot', 'browser_wait', 'browser_tabs', 'browser_viewport', 'browser_hover', 'browser_drag', 'browser_select', 'browser_eval', 'character_guide', 'character_draft', 'character_save', 'character_assign', 'character_list', 'theme_guide', 'theme_draft', 'theme_get', 'theme_save', 'theme_apply', 'theme_list', 'theme_delete']);
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

describe('a cancelled call', () => {
  it('closes its request to the server at once, so the work there stops too', async () => {
    let closed = false;
    const srv = http.createServer((q) => { q.on('close', () => { closed = true; }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const ac = new AbortController();
    const t0 = Date.now();
    const p = callServer('ego_browser', { script: 'x' }, { CW_WEB_URL: `http://127.0.0.1:${port}`, CW_WEB_TOKEN: 't', CW_SESSION_ID: 's' }, 60_000, ac.signal);
    setTimeout(() => ac.abort(), 300);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await new Promise((res) => setTimeout(res, 200));
    expect(closed).toBe(true);
    srv.close();
  });
});

describe('the tool list', () => {
  it('ego lite: its tools are listed only with CW_WEB_BROWSER=ego, and then the browser_* tools defer to it', () => {
    const names = (env: NodeJS.ProcessEnv) => toolsFor(env).map((t) => t.name);
    expect(names({})).not.toContain('ego_browser');
    expect(names({ CW_WEB_BROWSER: 'ego' })).toEqual([...TOOLS.map((t) => t.name), 'ego_browser_guide', 'ego_browser']);
    const open = (env: NodeJS.ProcessEnv) => toolsFor(env).find((t) => t.name === 'browser_open')!.description;
    expect(open({})).not.toMatch(/ego_browser/);
    expect(open({ CW_WEB_BROWSER: 'ego' })).toMatch(/use it instead for web tasks/);
    expect(toolsFor({ CW_WEB_BROWSER: 'ego' }).find((t) => t.name === 'web_search')!.description).not.toMatch(/ego_browser/);
    expect(instructionsFor({ CW_WEB_BROWSER: 'ego' })).toMatch(/ego_browser .* first/);
    expect(instructionsFor({})).not.toMatch(/ego/);
    for (const t of EGO_TOOLS) { expect(t.description.length, t.name).toBeGreaterThan(60); expect(t._meta['anthropic/alwaysLoad'], t.name).toBe(true); }
    // the script's own limit plus room for the permission card
    expect(callTimeoutOf('ego_browser', {})).toBe(240_000);
    expect(callTimeoutOf('ego_browser', { timeout_ms: 10 ** 9 })).toBe(720_000);
  });

  it('the tools that can answer with a picture, and web_search, are not deferred on our engine (alwaysLoad); no other tool is', () => {
    // ccb hides MCP tools behind ExecuteExtraTool, whose result is one JSON string: a picture would reach the model as
    // base64 text. alwaysLoad keeps a tool in the model's own list — only for these, so the list stays short.
    const IMAGE_TOOLS = ['browser_screenshot', 'browser_computer', 'character_draft', 'theme_draft', 'ego_browser'];
    const loadedIn = (env: NodeJS.ProcessEnv) => toolsFor(env).filter((t) => (t as { _meta?: Record<string, unknown> })._meta?.['anthropic/alwaysLoad'] === true).map((t) => t.name).sort();
    // ego_browser_guide came with ego_browser (read once before it), not for a picture
    expect(loadedIn({ CW_WEB_BROWSER: 'ego' })).toEqual([...IMAGE_TOOLS, 'ego_browser_guide', 'web_search'].sort());
    // web_search: the first tool research reaches for (sub-agents spent turns finding it, 2026-11-02)
    expect(loadedIn({})).toEqual(['browser_computer', 'browser_screenshot', 'character_draft', 'theme_draft', 'web_search']);
    for (const name of ['browser_open', 'browser_read', 'browser_click', 'browser_eval', 'character_list', 'theme_list']) {
      expect((toolsFor({}).find((t) => t.name === name) as { _meta?: unknown })._meta, name).toBeUndefined();
    }
  });

  it('every tool has a description the model can act on, a schema, and an honest read-only hint', () => {
    for (const t of TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(60);
      expect(t.inputSchema.type, t.name).toBe('object');
      for (const req of (t.inputSchema as { required?: string[] }).required ?? []) expect(Object.keys(t.inputSchema.properties), t.name).toContain(req);
    }
    const readOnly = TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    // reading what is already open, and searching; opening an address or acting on a page is not read-only
    expect(readOnly).toEqual(['web_search', 'browser_read', 'browser_find', 'browser_screenshot', 'browser_console', 'browser_network', 'browser_snapshot', 'browser_wait', 'character_guide', 'character_list', 'theme_guide', 'theme_get', 'theme_list']);
  });

  it('the console / network / structure / wait / tabs / viewport tools take what the contract says', () => {
    const schema = (name: string) => TOOLS.find((t) => t.name === name)!.inputSchema as { properties: Record<string, any>; required?: string[] };
    expect(Object.keys(schema('browser_console').properties)).toEqual(['errors_only']);
    expect(Object.keys(schema('browser_network').properties)).toEqual(['failed_only']);
    expect(schema('browser_snapshot').properties).toEqual({});
    // browser_wait: text or a ref, at most 20 seconds
    const wait = schema('browser_wait');
    expect(Object.keys(wait.properties)).toEqual(['text', 'ref', 'timeoutMs']);
    expect(wait.properties.timeoutMs).toMatchObject({ type: 'number', maximum: 20000 });
    expect(wait.required ?? []).toEqual([]);
    const tabs = schema('browser_tabs');
    expect(tabs.properties.action.enum).toEqual(['list', 'switch', 'new', 'close']);
    expect(Object.keys(tabs.properties)).toEqual(['action', 'id', 'url']);
    expect(tabs.required).toEqual(['action']);
    expect(schema('browser_viewport').properties.preset.enum).toEqual(['auto', 'phone', 'tablet', 'desktop']);
    expect(schema('browser_viewport').required).toEqual(['preset']);
    for (const n of ['browser_console', 'browser_network', 'browser_snapshot', 'browser_wait', 'browser_tabs', 'browser_viewport']) expect(TOOLS.find((t) => t.name === n)!.description, n).toMatch(/desktop app/);
    // stage B fix wave (A8): a ref from browser_snapshot works for every tool that takes one
    const refDesc = (TOOLS.find((t) => t.name === 'browser_click')!.inputSchema as any).properties.ref.description;
    expect(refDesc).toMatch(/browser_snapshot/);
    expect(TOOLS.find((t) => t.name === 'browser_snapshot')!.description).toMatch(/browser_click.*browser_type.*browser_hover.*browser_drag.*browser_select.*browser_wait/);
    const snap = formatSnapshot({ url: 'https://a.example/', title: 'A', text: 'button "Go" [k1]' });
    for (const tool of ['browser_click', 'browser_type', 'browser_hover', 'browser_drag', 'browser_select', 'browser_wait']) expect(snap, tool).toContain(tool);
  });

  it('hover / drag / select / eval take what the contract says, and say who is asked', () => {
    const schema = (name: string) => TOOLS.find((t) => t.name === name)!.inputSchema as { properties: Record<string, any>; required?: string[] };
    expect(Object.keys(schema('browser_hover').properties)).toEqual(['ref']);
    expect(schema('browser_hover').required).toEqual(['ref']);
    expect(Object.keys(schema('browser_drag').properties)).toEqual(['from', 'to']);
    expect(schema('browser_drag').required).toEqual(['from', 'to']);
    expect(Object.keys(schema('browser_select').properties)).toEqual(['ref', 'value']);
    expect(schema('browser_select').required).toEqual(['ref', 'value']);
    expect(Object.keys(schema('browser_eval').properties)).toEqual(['script']);
    expect(schema('browser_eval').required).toEqual(['script']);
    expect(schema('browser_eval').properties.script.maxLength).toBe(20000);
    for (const n of ['browser_hover', 'browser_drag', 'browser_select', 'browser_eval']) {
      const t = TOOLS.find((x) => x.name === n)!;
      expect(t.description, n).toMatch(/desktop app/);
      expect(t.annotations.readOnlyHint, n).toBe(false);
    }
    // the gate is in the description: a new site asks once, a script asks every time
    expect(TOOLS.find((t) => t.name === 'browser_click')!.description).toMatch(/new site/);
    expect(TOOLS.find((t) => t.name === 'browser_eval')!.description).toMatch(/every time/);
  });

  it('a call that may wait for the user (a page-changing tool) gets a longer timeout than a read', () => {
    expect(callTimeoutOf('browser_click')).toBeGreaterThan(SITE_ASK_TIMEOUT_MS);
    expect(callTimeoutOf('browser_eval')).toBeGreaterThan(SITE_ASK_TIMEOUT_MS);
    // opening a site not on the list waits on its card too
    expect(callTimeoutOf('browser_open')).toBeGreaterThan(SITE_ASK_TIMEOUT_MS);
    expect(callTimeoutOf('browser_tabs')).toBeGreaterThan(SITE_ASK_TIMEOUT_MS);
    expect(TOOLS.find((t) => t.name === 'browser_open')!.description).toMatch(/not on the user's allowed sites/);
    expect(callTimeoutOf('browser_read')).toBe(90_000);
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
