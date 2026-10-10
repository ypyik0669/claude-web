// 联网 end to end inside one process: a real server (startServer), two windows on its WebSocket, a paired device on the
// remote-access listener, fake search engines, and the `web` MCP server started exactly as an agent would start it
// (the launcher's command / args / env) — so the whole path is walked: agent → MCP process → POST /api/web/tool →
// WebService → the one window hosting the browser → back.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// before anything reads the home folder: the server's modules are imported below, after this
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-web-e2e-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.CLAUDE_WEB_DIR = path.join(home, '.claude-web');
process.env.CW_NO_MODEL_REFRESH = '1';
process.env.CW_NO_PUBLIC_BROKERS = '1';
delete process.env.CLAUDE_WEB_TOKEN;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | null | false, what: string, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

/** The result pages a hosting window "loaded": `<engine> <query>`. */
const pageHits: string[] = [];

/**
 * What the built-in browser would read off a search engine's result page (page-agent.js `results`), by a fake web:
 * DuckDuckGo shows its "bots" page for a query with "wall" in it and a list about something else for one with
 * "unrelated"; Bing always lists; Google asks for a CAPTCHA; the others cannot be reached.
 */
function resultPage(args: { engine: string; url: string }) {
  const u = new URL(args.url);
  const q = u.searchParams.get('q') ?? u.searchParams.get('p') ?? u.searchParams.get('wd') ?? '';
  pageHits.push(`${args.engine} ${q}`);
  const page = (title: string, text: string, candidates: unknown[] = []) => ({ url: args.url, title, text, candidates });
  if (args.engine === 'duckduckgo') {
    if (q.includes('wall')) return page('DuckDuckGo', 'Unfortunately, bots use DuckDuckGo too.');
    const title = q.includes('unrelated') ? 'Manage your storage' : `Ducks for ${q}`;
    return page(`${q} at DuckDuckGo`, title, [{ title, href: `https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://duck.example/answer')}`, snippet: `${title} Read in the browser.` }]);
  }
  if (args.engine === 'bing') return page(`${q} - Search`, `Streams for ${q}`, [{ title: `Streams for ${q}`, href: 'https://docs.example/streams', snippet: 'A fake result.' }]);
  if (args.engine === 'google') return { ...page('Sorry', 'Our systems have detected unusual traffic from your computer network.'), url: 'https://www.google.com/sorry/index' };
  return { ...page('', ''), failed: 'ERR_NAME_NOT_RESOLVED' };
}

/** A window: requests with replies, and every event it was sent. A `search` it is sent is answered at once, as a real window's hidden page would. */
function client(url: string) {
  const ws = new WebSocket(url);
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const events: any[] = [];
  let n = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'event') {
      events.push(m.event);
      const c = m.event.kind === 'browser.command' ? m.event.command : null;
      if (c?.op === 'search') void req('browser.result', { id: c.id, ok: true, answer: { search: resultPage(c.args) } }).catch(() => {});
      return;
    }
    const p = pending.get(m.reply.id);
    pending.delete(m.reply.id);
    if (m.reply.ok) p?.resolve(m.reply.data); else p?.reject(new Error(m.reply.error));
  });
  const open = new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const req = <T = any>(kind: string, extra: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
    const id = `r${++n}`;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'request', request: { id, req: { kind, ...extra } } }));
  });
  // the commands a test answers by hand: everything but the searches
  return { ws, open, req, events, commands: () => events.filter((e) => e.kind === 'browser.command' && e.command.op !== 'search').map((e) => e.command) };
}

let server: { port: number; close(): Promise<void> };
let site: http.Server;
let siteUrl = '';
let secret = '';
let a: ReturnType<typeof client>;
let b: ReturnType<typeof client>;
const engineHits: string[] = [];

const tool = async (port: number, body: unknown, token = secret) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/web/tool`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: res.status, json: res.status === 200 ? ((await res.json()) as { content: any[]; isError?: boolean }) : null };
};
const textOf = (r: { json: { content: any[] } | null }) => (r.json?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

beforeAll(async () => {
  // the search engines and a page to open, all on this machine
  site = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const q = u.searchParams.get('q') ?? '';
    if (u.pathname === '/search') {
      engineHits.push(`bing ${q}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      // "wall": what Bing serves a client it takes for a bot; "unrelated": a normal-looking list about something else
      if (q.includes('wall')) { res.end('<html><body><div class="captcha-container">One last step</div></body></html>'); return; }
      const title = q.includes('unrelated') ? 'Manage your storage' : `Streams for ${q}`;
      res.end(`<html><body><ol id="b_results"><li class="b_algo"><h2><a href="https://docs.example/streams">${title}</a></h2><div class="b_caption"><p class="b_lineclamp2">A fake result.</p></div></li></ol></body></html>`);
      return;
    }
    // DuckDuckGo answers only a query with "duck" in it: every other search in this file is Bing's alone
    if (u.pathname === '/nothing-here/html/' && q.includes('duck')) {
      engineHits.push(`ddg ${q}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<div id="links"><div class="result"><a class="result__a" href="https://duck.example/answer">From the duck</a></div></div>');
      return;
    }
    if (u.pathname === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Local page</title><h1>It works</h1><p>Served by the dev server. <a href="/more">More</a></p>'); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  siteUrl = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
  process.env.CW_BING_URL = siteUrl;
  process.env.CW_DDG_URL = `${siteUrl}/nothing-here`;

  const { startServer } = await import('../index.js');
  server = await startServer({ port: 0, host: '127.0.0.1', distDir: fs.mkdtempSync(path.join(home, 'dist-')), version: '0.0.0-test' });
  a = client(`ws://127.0.0.1:${server.port}/ws`);
  b = client(`ws://127.0.0.1:${server.port}/ws`);
  await Promise.all([a.open, b.open]);
}, 60_000);

afterAll(async () => {
  a?.ws.terminate();
  b?.ws.terminate();
  await server?.close();
  site?.closeAllConnections();
  await new Promise((r) => site.close(r));
  delete process.env.CW_BING_URL;
  delete process.env.CW_DDG_URL;
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); } catch { /* memory.db stays open after close(): the OS temp cleanup takes it */ }
}, 60_000);

describe('联网 through a running server', () => {
  it('the secret is in a file only this server\'s MCP processes are pointed at; the status starts with no window', async () => {
    const file = path.join(process.env.CLAUDE_WEB_DIR!, 'runtime', 'web-mcp', `${process.pid}.token`);
    secret = fs.readFileSync(file, 'utf8');
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const st = await a.req('web.status');
    expect(st).toMatchObject({ enabled: true, engine: 'auto', host: false, isolated: false });
    expect(st.engines.map((e: any) => e.id)).toEqual(['auto', 'duckduckgo', 'bing', 'google', 'yahoo', 'baidu', 'brave']);
    expect(JSON.stringify(st)).not.toContain(secret);
    // nothing a window can ask for gives the secret away
    expect(JSON.stringify(await a.req('settings.get'))).not.toContain(secret);
  });

  it('with no window hosting the browser, web.search (the settings page\'s try-it) and the tool endpoint fetch the result page themselves', async () => {
    expect(await a.req('web.search', { query: 'backpressure', count: 3 })).toEqual({ engine: 'bing', results: [{ title: 'Streams for backpressure', url: 'https://docs.example/streams', snippet: 'A fake result.' }] });
    const r = await tool(server.port, { sessionId: 's1', tool: 'web_search', args: { query: 'pipes' } });
    expect(r.status).toBe(200);
    expect(textOf(r)).toContain('1. Streams for pipes\n   https://docs.example/streams\n   A fake result.');
    expect(engineHits).toEqual(['bing backpressure', 'bing pipes']);
    // an engine that is only read in the browser says what it needs
    await a.req('settings.set', { key: 'web.search.engine', value: 'baidu' });
    await expect(a.req('web.search', { query: 'q' })).rejects.toThrow('百度：要用桌面版 Claude Web 的内置浏览器来搜');
    await a.req('settings.set', { key: 'web.search.engine', value: 'auto' });
    expect(pageHits).toEqual([]);
    expect(engineHits).toHaveLength(2);
  });

  it('the endpoint is for this start\'s secret only', async () => {
    expect((await tool(server.port, { tool: 'web_search', args: { query: 'x' } }, 'not-the-secret')).status).toBe(401);
    expect((await tool(server.port, { tool: 'web_search', args: { query: 'x' } }, '')).status).toBe(401);
    expect(engineHits).toHaveLength(2);
  });

  it('with no window hosting the browser: pages are read by the server, actions say they need the desktop app, the server never opens itself', async () => {
    const opened = await tool(server.port, { sessionId: 's1', tool: 'browser_open', args: { url: `${siteUrl}/page` } });
    expect(opened.json?.isError).toBeUndefined();
    expect(textOf(opened)).toContain(`来源：${siteUrl}/page\n标题：Local page`);
    expect(textOf(opened)).toContain('# It works\n\nServed by the dev server. More');
    expect(textOf(opened)).toContain(`[1] link "More" → ${siteUrl}/more`);
    const click = await tool(server.port, { sessionId: 's1', tool: 'browser_click', args: { ref: '1' } });
    expect(click.json?.isError).toBe(true);
    expect(textOf(click)).toContain('这个操作需要桌面版 Claude Web 的内置浏览器（现在没有桌面窗口连着）。');
    // in browser mode without a token this server trusts loopback: a model must not read files through it
    const self = await tool(server.port, { sessionId: 's1', tool: 'browser_open', args: { url: `http://127.0.0.1:${server.port}/api/file?path=${encodeURIComponent(path.join(home, 'x'))}` } });
    expect(self.json?.isError).toBe(true);
    expect(textOf(self)).toContain('Claude Web 自己');
  });

  it('a window announces the browser: commands go to it alone, its answer is the tool\'s result', async () => {
    const before = a.events.length;
    expect(await a.req('browser.host', { on: true })).toMatchObject({ host: true });
    // every window hears that the status changed (the settings page shows it)
    await until(() => b.events.some((e) => e.kind === 'web.changed'), 'web.changed at the other window');
    expect((await b.req('web.status')).host).toBe(true);

    const pending = tool(server.port, { sessionId: 'conv-7', tool: 'browser_open', args: { url: 'https://app.example/login' } });
    const cmd = await until(() => a.commands()[0], 'the command at the hosting window');
    expect(cmd).toMatchObject({ sessionId: 'conv-7', op: 'open', args: { url: 'https://app.example/login' } });
    expect(b.commands()).toHaveLength(0);
    // the other window cannot answer for it
    expect(await b.req('browser.result', { id: cmd.id, ok: true, answer: { note: 'not mine' } })).toEqual({ taken: false });
    expect(await a.req('browser.result', { id: cmd.id, ok: true, answer: { page: { url: 'https://app.example/login', title: 'Sign in', text: 'Welcome. Please sign in.', elements: [{ ref: 'e1', role: 'textbox', name: 'Email' }, { ref: 'e2', role: 'button', name: 'Continue' }] } } })).toEqual({ taken: true });
    const r = await pending;
    expect(r.json?.isError).toBeUndefined();
    expect(textOf(r)).toContain('来源：https://app.example/login\n标题：Sign in');
    expect(textOf(r)).toContain('Welcome. Please sign in.');
    expect(textOf(r)).toContain('[e2] button "Continue"');
    expect(await a.req('browser.result', { id: cmd.id, ok: true })).toEqual({ taken: false }); // answered once

    // the window's own failure is what the model reads; a screenshot comes back as an image
    const failing = tool(server.port, { sessionId: 'conv-7', tool: 'browser_click', args: { ref: 'e9' } });
    const c2 = await until(() => a.commands()[1], 'the click');
    expect(c2).toMatchObject({ op: 'click', args: { ref: 'e9' } });
    await a.req('browser.result', { id: c2.id, ok: false, error: '页面上没有 e9 这个元素' });
    expect((await failing).json).toEqual({ content: [{ type: 'text', text: '页面上没有 e9 这个元素' }], isError: true });
    const shot = tool(server.port, { sessionId: 'conv-7', tool: 'browser_screenshot', args: {} });
    const c3 = await until(() => a.commands()[2], 'the screenshot');
    await a.req('browser.result', { id: c3.id, ok: true, answer: { image: { mime: 'image/png', data: 'iVBORw0KGgo=' } } });
    expect((await shot).json?.content[1]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
    expect(a.events.length).toBeGreaterThan(before);

    // searching is now done in that window's browser: the result page is loaded and read there, nothing is fetched here
    const fetched = engineHits.length;
    expect(await b.req('web.search', { query: 'backpressure', count: 3 })).toEqual({ engine: 'duckduckgo', results: [{ title: 'Ducks for backpressure', url: 'https://duck.example/answer', snippet: 'Read in the browser.' }] });
    expect(pageHits).toEqual(['duckduckgo backpressure']);
    const sent = a.events.filter((e) => e.kind === 'browser.command' && e.command.op === 'search').map((e) => e.command);
    expect(sent).toHaveLength(1);
    // (this file points the engines at its own site: the page a window is asked to load is there too)
    expect(sent[0]).toMatchObject({ sessionId: '', args: { engine: 'duckduckgo', url: `${siteUrl}/nothing-here/html/?q=backpressure` } });
    expect(b.events.some((e) => e.kind === 'browser.command')).toBe(false);
    expect(engineHits).toHaveLength(fetched);
  });

  it('the MCP server, started as the launcher tells an agent to start it, reaches the hosting window', async () => {
    const { webAcpMcpServers } = await import('./launcher.js');
    const [spec] = webAcpMcpServers({ sessionId: 'conv-mcp' });
    expect(spec.name).toBe('web');
    const env = Object.fromEntries(spec.env.map((e) => [e.name, e.value]));
    expect(env.CW_WEB_URL).toBe(`http://127.0.0.1:${server.port}`);
    expect(JSON.stringify(spec)).not.toContain(secret);
    const { ELECTRON_RUN_AS_NODE: _unused, ...mcpEnv } = env; // this test's node is not Electron
    // in a folder that has nothing to do with this repository, as an agent starts it (the project's folder)
    const child = spawn(spec.command, spec.args, { cwd: home, env: { ...process.env, ...mcpEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const replies = new Map<number, any>();
    let buf = '';
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { const m = JSON.parse(line); replies.set(m.id, m); } }
    });
    const send = (id: number, method: string, params: unknown = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    try {
      send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '0' } });
      send(2, 'tools/call', { name: 'web_search', arguments: { query: 'from the agent' } });
      const searched = await until(() => replies.get(2), `the search through the MCP process (stderr: ${stderr.slice(-300)})`, 30_000);
      expect(searched.result.content[0].text).toContain('用 DuckDuckGo 搜索「from the agent」');
      expect(searched.result.content[0].text).toContain('1. Ducks for from the agent\n   https://duck.example/answer');
      const n = a.commands().length;
      send(3, 'tools/call', { name: 'browser_read', arguments: { offset: 40 } });
      const cmd = await until(() => a.commands()[n], 'the read at the hosting window');
      expect(cmd).toMatchObject({ sessionId: 'conv-mcp', op: 'read', args: { offset: 40, maxChars: 12_000 } });
      await a.req('browser.result', { id: cmd.id, ok: true, answer: { page: { url: 'https://app.example/', title: 'App', text: 'the rest of the page' } } });
      const read = await until(() => replies.get(3), 'the read through the MCP process');
      expect(read.result.isError).toBeUndefined();
      expect(read.result.content[0].text).toContain('the rest of the page');
    } finally {
      child.stdin.end();
      await new Promise((r) => child.once('exit', r));
    }
  }, 60_000);

  it('a phone (the remote-access listener, a paired device) cannot host the browser, and the endpoint is not there for it', async () => {
    const st = await a.req('remote.set', { enabled: true, port: await freePort(), anywhere: false });
    expect(st.running).toBe(true);
    const pair = await a.req('remote.pairCode');
    const redeemed = (await (await fetch(`http://127.0.0.1:${st.port}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.code, name: 'test phone' }) })).json()) as { token: string };
    expect(redeemed.token).toBeTruthy();
    const phone = client(`ws://127.0.0.1:${st.port}/ws?token=${redeemed.token}`);
    await phone.open;
    try {
      // it may look and search like any window…
      expect((await phone.req('web.status')).host).toBe(true);
      // …but not be the browser, nor answer for it
      await expect(phone.req('browser.host', { on: true })).rejects.toThrow('只有本机的桌面窗口才能提供内置浏览器');
      await expect(phone.req('browser.result', { id: 'x', ok: true })).rejects.toThrow('只有本机的桌面窗口');
      // the same device's token on the main listener is still a device, not a window of this machine
      const viaMain = client(`ws://127.0.0.1:${server.port}/ws?token=${redeemed.token}`);
      await viaMain.open;
      await expect(viaMain.req('browser.host', { on: true })).rejects.toThrow('只有本机的桌面窗口');
      viaMain.ws.terminate();
      // the tool endpoint: 404 on that listener, whatever is presented
      expect((await tool(st.port, { tool: 'web_search', args: { query: 'x' } })).status).toBe(404);
      const n = a.commands().length;
      void tool(server.port, { sessionId: 's', tool: 'browser_back', args: {} });
      await until(() => a.commands()[n], 'the command still going to the desktop window');
      expect(phone.commands()).toHaveLength(0);
      await a.req('browser.result', { id: a.commands()[n].id, ok: true, answer: {} });
    } finally {
      phone.ws.terminate();
      await a.req('remote.set', { enabled: false });
    }
  }, 30_000);

  it('a search engine\'s key: stored protected, a mask on the wire, in no status and no reply', async () => {
    await a.req('settings.set', { key: 'web.search.braveKey', value: 'brave-unit-test-key' });
    const settings = await a.req('settings.get');
    expect(settings['web.search.braveKey']).toBe('••••••');
    expect((await a.req('web.status')).engines.find((e: any) => e.id === 'brave')).toEqual({ id: 'brave', label: 'Brave Search（API，要密钥）', needsKey: true, hasKey: true });
    const onDisk = await until(() => { try { const t = fs.readFileSync(path.join(process.env.CLAUDE_WEB_DIR!, 'meta.json'), 'utf8'); return t.includes('web.search.braveKey') ? t : null; } catch { return null; } }, 'the key in meta.json');
    expect(onDisk).not.toContain('brave-unit-test-key');
    expect(JSON.parse(onDisk).settings['web.search.braveKey']).toMatch(/^enc:/);
    // the mask coming back from a settings page keeps it; '' removes it
    await a.req('settings.set', { key: 'web.search.braveKey', value: '••••••' });
    expect((await a.req('web.status')).engines.find((e: any) => e.id === 'brave').hasKey).toBe(true);
    await a.req('settings.set', { key: 'web.search.braveKey', value: '' });
    expect((await a.req('web.status')).engines.find((e: any) => e.id === 'brave').hasKey).toBe(false);
    expect((await a.req('settings.get'))['web.search.braveKey']).toBeUndefined();
  }, 60_000);

  it('the settings are followed: the engine, the isolated-browser flag, and the switch that stops handing the server out', async () => {
    const { webClaudeMcpServer, webAllowedTools } = await import('./launcher.js');
    await a.req('settings.set', { key: 'web.search.engine', value: 'google' });
    await expect(a.req('web.search', { query: 'q' })).rejects.toThrow(/Google：要求验证，或者没有给出结果页。可以用 browser_open 打开 https:\/\/www\.google\.com\/search\?q=q&hl=en/);
    expect(pageHits[pageHits.length - 1]).toBe('google q');
    await a.req('settings.set', { key: 'web.search.engine', value: 'auto' });
    await a.req('settings.set', { key: 'web.browser.isolated', value: true });
    expect(await a.req('web.status')).toMatchObject({ engine: 'auto', isolated: true, enabled: true });
    expect(Object.keys(webClaudeMcpServer({ sessionId: 's' }))).toEqual(['web']);
    const n = b.events.filter((e) => e.kind === 'web.changed').length;
    await a.req('settings.set', { key: 'web.mcp', value: false });
    expect((await a.req('web.status')).enabled).toBe(false);
    expect(webClaudeMcpServer({ sessionId: 's' })).toEqual({});
    expect(webAllowedTools()).toEqual([]);
    await until(() => b.events.filter((e) => e.kind === 'web.changed').length > n, 'web.changed after the switch');
    await a.req('settings.set', { key: 'web.mcp', value: true });
    expect(webAllowedTools()).toEqual(['mcp__web__web_search']);
  });

  it('an engine that challenged is left out of the next searches until a 联网 setting is saved; a list about something else is not handed on', async () => {
    const from = pageHits.length;
    const fetched = engineHits.length;
    // DuckDuckGo shows its "bots" page: Bing's result page is read…
    expect(await a.req('web.search', { query: 'wall one' })).toEqual({ engine: 'bing', results: [{ title: 'Streams for wall one', url: 'https://docs.example/streams', snippet: 'A fake result.' }] });
    // …and DuckDuckGo not again for the next search (a model searches several times in a row)
    expect((await a.req('web.search', { query: 'again' })).engine).toBe('bing');
    expect(pageHits.slice(from)).toEqual(['duckduckgo wall one', 'bing wall one', 'bing again']);
    await a.req('settings.set', { key: 'web.search.engine', value: 'auto' });
    expect((await a.req('web.search', { query: 'again' })).engine).toBe('duckduckgo');
    // a normal-looking list, about nothing that was asked: the model gets the next engine's results
    const r = await tool(server.port, { sessionId: 's1', tool: 'web_search', args: { query: 'unrelated topic' } });
    expect(textOf(r)).toContain('用 Bing 搜索「unrelated topic」');
    expect(textOf(r)).not.toContain('Manage your storage');
    expect(pageHits.slice(from + 3)).toEqual(['duckduckgo again', 'duckduckgo unrelated topic', 'bing unrelated topic']);
    // that was about one query, not about DuckDuckGo: it is asked for the next
    expect((await a.req('web.search', { query: 'pipes' })).engine).toBe('duckduckgo');
    expect(engineHits).toHaveLength(fetched);
  });

  it('the hosting window closing fails what it was asked at once, and reading falls back to the server', async () => {
    const n = a.commands().length;
    const hanging = tool(server.port, { sessionId: 's1', tool: 'browser_click', args: { ref: 'e1' } });
    await until(() => a.commands()[n], 'the click at the window');
    const t0 = Date.now();
    a.ws.close();
    const r = await hanging;
    expect(Date.now() - t0).toBeLessThan(5000); // not the 30 s a silent window gets
    expect(r.json?.isError).toBe(true);
    expect(textOf(r)).toContain('断开');
    await until(() => b.events.filter((e) => e.kind === 'web.changed').length >= 1, 'web.changed');
    expect((await b.req('web.status')).host).toBe(false);
    expect(textOf(await tool(server.port, { sessionId: 's1', tool: 'browser_read', args: {} }))).toContain('# It works'); // the page s1 opened through the server
    // and searching goes back to this server fetching the page
    const pages = pageHits.length;
    expect((await b.req('web.search', { query: 'after the window' })).engine).toBe('bing');
    expect(engineHits[engineHits.length - 1]).toBe('bing after the window');
    expect(pageHits).toHaveLength(pages);
  });
});
