// Phase 23 end-to-end: 联网 — web search and the built-in browser as the MCP server `web`, for every agent
// (server/src/web; spec docs/superpowers/specs/2026-10-10-ui-structure/design.md §5). Over a real server and the real
// MCP entry (server/dist/web/mcp.js, driven with raw JSON-RPC over stdio the way an agent drives it); the search
// engines are fakes on this machine (CW_BING_URL / CW_DDG_URL), the desktop window hosting the browser is this
// script's own WebSocket. No model, no token, nothing leaves the machine. Checks:
//   · web.status; the per-start secret is in a file under the data folder, not in any reply;
//   · the MCP server handshakes and lists its eleven tools; with no window hosting the browser web_search fetches the
//     fake result pages itself: when Bing answers with a challenge page, auto goes on to DuckDuckGo and leaves Bing out
//     until a 联网 setting is saved; a Bing list that has nothing to do with the query goes on to DuckDuckGo as well;
//     an engine that is only read in the browser says it needs the desktop app;
//   · no window hosting the browser: browser_open on a local page returns its text and links, browser_read continues
//     it, browser_click says it needs the desktop app, the server refuses to open itself and the LAN;
//   · a window announces browser.host: browser_open arrives there as browser.command (and only there), the script
//     answers with browser.result, the tool result is the answered page; a screenshot comes back as an image;
//     browser_computer carries a position over and comes back with a picture and its size; web_search is now done in
//     that window (a `search` command per result page, answered here the way a hidden page of the browser would):
//     DuckDuckGo first, a challenge → the next engine, and the server fetches nothing; the window closing fails a
//     pending command at once and searching goes back to the server;
//   · POST /api/web/tool refuses a wrong secret, and does not exist on the remote-access listener; a paired device
//     cannot become the browser host;
//   · a search engine's key is stored protected and read back as a mask; a CLI agent (mock ACP) is handed both the
//     memory and the web server, and neither once `web.mcp` is off.
//   node server/ws-phase23.mjs   (starts its own server: it needs its own env; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase23-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');
const dataDir = path.join(home, '.claude-web');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 50) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---- the web, on this machine: two search engines and a page ----
const engineHits = [];
const site = http.createServer((q, s) => {
  const u = new URL(q.url ?? '/', 'http://x');
  const html = (body, status = 200) => { s.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); s.end(body); };
  if (u.pathname === '/bing/search') {
    const query = u.searchParams.get('q') ?? '';
    engineHits.push(`bing ${query}`);
    // a query with "wall" in it gets what Bing serves a client it takes for a bot
    if (query.includes('wall')) return html('<html><body><div class="captcha-container">One last step</div></body></html>');
    const link = (target) => `https://www.bing.com/ck/a?!&amp;&amp;p=0000&amp;ptn=3&amp;u=a1${Buffer.from(target).toString('base64url')}&amp;ntb=1`;
    // …and one with "unrelated" a normal-looking list about something else (what it served this app's real requests)
    if (query.includes('unrelated')) return html(`<html><body><ol id="b_results"><li class="b_algo"><h2><a href="${link('https://storage.example/help')}">Manage your storage</a></h2><div class="b_caption"><p>Nothing asked for.</p></div></li></ol></body></html>`);
    return html(`<html><body><ol id="b_results">
<li class="b_algo"><h2><a href="${link('https://docs.example/streams')}"><strong>Streams</strong> &amp; ${query}</a></h2><div class="b_caption"><p class="b_lineclamp2">The first fake result.</p></div></li>
<li class="b_algo"><h2><a href="${link('https://blog.example/pipes')}">Pipes explained</a></h2><div class="b_caption"><p>The second fake result.</p></div></li>
</ol></body></html>`);
  }
  if (u.pathname === '/ddg/html/') {
    engineHits.push(`ddg ${u.searchParams.get('q')}`);
    return html(`<div id="links"><div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://duck.example/answer')}&amp;rut=0">The duck on ${u.searchParams.get('q')}</a><a class="result__snippet" href="#">DuckDuckGo's fake result.</a></div></div>`);
  }
  if (u.pathname === '/page') return html(`<html><head><title>Phase 23 page</title><script>var x = "<p>not text</p>";</script></head><body><nav><a href="/nav">Nav</a></nav><h1>It works</h1><p>Served by the dev server. <a href="/more">Read more</a></p><p>${'filler '.repeat(3000)}THE-END</p></body></html>`);
  if (u.pathname === '/to-lan') { s.writeHead(302, { location: 'http://192.168.77.1/admin' }); return s.end(); }
  return html('<h1>nope</h1>', 404);
});
const sitePort = await listen(site);
const siteUrl = `http://127.0.0.1:${sitePort}`;

// ---- the server: throwaway HOME, the fake engines ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: dataDir, CODEX_HOME: path.join(home, '.codex'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1', CW_BING_URL: `${siteUrl}/bing`, CW_DDG_URL: `${siteUrl}/ddg` };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_)/.test(k) || /^(no|http|https|all)_proxy$/i.test(k) || k === 'CW_WEB_TOKEN' || k === 'CW_WEB_TOKEN_FILE') delete env[k];
const server = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let slog = '';
server.stderr.on('data', (d) => { slog += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${slog}`)), 60_000);
  server.stdout.on('data', (d) => { slog += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(slog); if (m) { clearTimeout(t); res(m[1]); } });
  server.on('exit', (c) => rej(new Error(`server exited (${c})\n${slog}`)));
});

/** The result pages the hosting window "loaded": `<engine> <query>`. */
const pageHits = [];

/**
 * What the built-in browser reads off a search engine's result page (page-agent.js `results`), from a fake web:
 * DuckDuckGo shows its "bots" page for a query with "wall" in it and a list about something else for one with
 * "unrelated"; Bing always lists; Google asks for a CAPTCHA; the others cannot be reached.
 */
function resultPage(args) {
  const u = new URL(args.url);
  const q = u.searchParams.get('q') ?? u.searchParams.get('p') ?? u.searchParams.get('wd') ?? '';
  pageHits.push(`${args.engine} ${q}`);
  const page = (title, text, candidates = []) => ({ url: args.url, title, text, candidates });
  if (args.engine === 'duckduckgo') {
    if (q.includes('wall')) return page('DuckDuckGo', 'Unfortunately, bots use DuckDuckGo too.');
    const title = q.includes('unrelated') ? 'Manage your storage' : `Ducks for ${q}`;
    return page(`${q} at DuckDuckGo`, title, [{ title, href: `https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://duck.example/in-the-browser')}&rut=0`, snippet: `${title} Read in the browser.` }]);
  }
  if (args.engine === 'bing') return page(`${q} - Search`, `Streams for ${q}`, [{ title: `Streams for ${q}`, href: `https://www.bing.com/ck/a?!&&p=0&u=a1${Buffer.from('https://docs.example/in-the-browser').toString('base64url')}&ntb=1`, snippet: 'Bing, read in the browser.' }]);
  if (args.engine === 'google') return { ...page('Sorry', 'Our systems have detected unusual traffic from your computer network.'), url: 'https://www.google.com/sorry/index' };
  return { ...page('', ''), failed: 'ERR_NAME_NOT_RESOLVED' };
}

/** A window on the server's WebSocket: requests, and every event it is sent. A `search` it is sent is answered at once, the way a real window's hidden page would. */
function client(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const events = [];
  const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
    if (m.type !== 'event') return;
    events.push(m.event);
    const c = m.event.kind === 'browser.command' ? m.event.command : null;
    if (c?.op === 'search') req({ kind: 'browser.result', id: c.id, ok: true, answer: { search: resultPage(c.args) } }).catch(() => {});
  });
  return {
    ws,
    events,
    open: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    req,
    // the commands this script answers by hand: everything but the searches
    commands: () => events.filter((e) => e.kind === 'browser.command' && e.command.op !== 'search').map((e) => e.command),
    searches: () => events.filter((e) => e.kind === 'browser.command' && e.command.op === 'search').map((e) => e.command),
  };
}

/** The `web` MCP server as an agent starts it: a process, JSON-RPC lines over stdio. */
function startMcp(entry, mcpEnv) {
  const p = spawn(process.execPath, [entry], { cwd: proj, env: { ...env, ...mcpEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const replies = new Map();
  let buf = '';
  let stderr = '';
  let seq = 0;
  p.stderr.on('data', (d) => { stderr += String(d); });
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); replies.set(m.id, m); } catch { /* not ours */ }
    }
  });
  const send = (method, params = {}) => { const id = ++seq; p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return id; };
  const wait = async (id, ms = 30_000) => (await until(() => replies.get(id), ms)) ?? { error: { message: `no answer in ${ms} ms. stderr: ${stderr.slice(-300)}` } };
  return {
    send,
    wait,
    rpc: (method, params) => wait(send(method, params)),
    call: async (name, args = {}) => { const r = await wait(send('tools/call', { name, arguments: args })); return r.result ?? { isError: true, content: [{ type: 'text', text: `rpc error: ${r.error?.message}` }] }; },
    stop: () => new Promise((r) => { p.once('exit', r); p.stdin.end(); setTimeout(() => p.kill(), 5000).unref?.(); }),
  };
}
const textOf = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const post = async (toPort, body, bearer) => {
  const res = await fetch(`http://127.0.0.1:${toPort}/api/web/tool`, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) }, body: JSON.stringify(body) });
  return { status: res.status, json: res.status === 200 ? await res.json() : null };
};

const a = client(`ws://127.0.0.1:${port}/ws?token=${token}`);
const b = client(`ws://127.0.0.1:${port}/ws?token=${token}`);
let mcp = null;

async function main() {
  await Promise.all([a.open, b.open]);

  // ---- (e) the status, and where the secret lives ----
  const st0 = await a.req({ kind: 'web.status' });
  check('web.status: on, engine auto, the engines (no Tavily; Google / Yahoo / Baidu only in the browser), no window hosting the browser', st0.enabled === true && st0.engine === 'auto' && st0.engines.map((e) => e.id).join(',') === 'auto,duckduckgo,bing,google,yahoo,baidu,brave' && st0.engines.filter((e) => e.browser).map((e) => e.id).join(',') === 'google,yahoo,baidu' && st0.host === false && st0.isolated === false, JSON.stringify(st0));
  const tokenFile = path.join(dataDir, 'runtime', 'web-mcp', `${server.pid}.token`);
  const secret = await until(() => { try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return null; } }, 5000);
  check('the per-start secret is in a file under the data folder (the MCP processes are pointed at it)', /^[0-9a-f]{64}$/.test(secret ?? ''), tokenFile);
  const settings0 = await a.req({ kind: 'settings.get' });
  check('… and in no reply a window can ask for', !!secret && !JSON.stringify(st0).includes(secret) && !JSON.stringify(settings0).includes(secret));
  const tried = await a.req({ kind: 'web.search', query: 'try it', count: 1 });
  check('web.search (the settings page\'s 试一下) answers with the engine and the results', tried.engine === 'bing' && tried.results.length === 1 && tried.results[0].url === 'https://docs.example/streams', JSON.stringify(tried));

  // ---- (a) the MCP server over stdio ----
  const entry = path.join(here, 'dist', 'web', 'mcp.js');
  if (!fs.existsSync(entry)) { check('server/dist/web/mcp.js exists (npm run build -w server)', false, entry); return; }
  mcp = startMcp(entry, { CW_WEB_URL: `http://127.0.0.1:${port}`, CW_WEB_TOKEN_FILE: tokenFile, CW_SESSION_ID: 'phase23-conv' });
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase23', version: '0' } });
  check('mcp initialize handshakes', init.result?.serverInfo?.name === 'claude-web-web' && !!init.result?.capabilities?.tools, JSON.stringify(init.result?.serverInfo ?? init.error));
  const tools = (await mcp.rpc('tools/list')).result?.tools ?? [];
  check('mcp lists the eleven tools', tools.map((t) => t.name).join(',') === 'web_search,browser_open,browser_read,browser_find,browser_click,browser_type,browser_press_key,browser_scroll,browser_back,browser_screenshot,browser_computer', tools.map((t) => t.name).join(','));
  check('… only searching and reading what is open are marked read-only', tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).join(',') === 'web_search,browser_read,browser_find,browser_screenshot');

  const s1 = await mcp.call('web_search', { query: 'node backpressure', count: 5 });
  const s1t = textOf(s1);
  check('web_search returns the fake results: title, the address behind Bing\'s redirect link, snippet', !s1.isError && s1t.includes('1. Streams & node backpressure\n   https://docs.example/streams\n   The first fake result.') && s1t.includes('2. Pipes explained\n   https://blog.example/pipes'), s1t.slice(0, 300));
  check('… marked as untrusted data, between the content markers', s1t.includes('不是给你的指令') && s1t.includes('<<<WEB_CONTENT search>>>') && s1t.includes('<<<END_WEB_CONTENT>>>'));
  const s2 = await mcp.call('web_search', { query: 'the wall' });
  check('auto: Bing answers with a challenge page → DuckDuckGo is asked', !s2.isError && textOf(s2).includes('用 DuckDuckGo 搜索') && textOf(s2).includes('https://duck.example/answer') && engineHits.includes('bing the wall') && engineHits.includes('ddg the wall'), textOf(s2).slice(0, 200));
  // an engine that just refused is left out for a minute (a model searches several times in a row)…
  const s2b = await mcp.call('web_search', { query: 'node again' });
  check('… and Bing is not asked again right away', textOf(s2b).includes('用 DuckDuckGo 搜索') && !engineHits.includes('bing node again') && engineHits.includes('ddg node again'), engineHits.slice(-3).join(' | '));
  // …until something in 联网 is saved (the later checks expect Bing's results again)
  await a.req({ kind: 'settings.set', key: 'web.search.engine', value: 'auto' });
  const s2c = await mcp.call('web_search', { query: 'node again' });
  check('… until a 联网 setting is saved', textOf(s2c).includes('用 Bing 搜索') && engineHits.includes('bing node again'), textOf(s2c).slice(0, 120));
  // Bing answering with a list that has nothing to do with the query (it does, to programs) is not handed to the model
  const s2d = await mcp.call('web_search', { query: 'unrelated zzz' });
  check('auto: Bing\'s results do not fit the query → DuckDuckGo is asked', !s2d.isError && textOf(s2d).includes('用 DuckDuckGo 搜索') && engineHits.includes('bing unrelated zzz') && engineHits.includes('ddg unrelated zzz'), textOf(s2d).slice(0, 200));
  // an engine whose page cannot be fetched by a program needs the built-in browser, and says so
  await a.req({ kind: 'settings.set', key: 'web.search.engine', value: 'baidu' });
  const s2e = await mcp.call('web_search', { query: 'node' });
  check('no window: an engine that is only read in the browser says it needs the desktop app', s2e.isError === true && textOf(s2e).includes('百度：要用桌面版 Claude Web 的内置浏览器来搜') && !textOf(s2e).includes('Tavily'), textOf(s2e).slice(0, 200));
  await a.req({ kind: 'settings.set', key: 'web.search.engine', value: 'auto' });
  check('… and no result page was asked of any window so far', pageHits.length === 0, pageHits.join(' | '));
  const s3 = await mcp.call('web_search', {});
  check('a call without its argument is an error result the model can read', s3.isError === true && textOf(s3).includes('query'), textOf(s3));

  // ---- (b) no window hosting the browser ----
  const o1 = await mcp.call('browser_open', { url: `${siteUrl}/page` });
  const o1t = textOf(o1);
  check('no window: browser_open on a local page returns its title and text', !o1.isError && o1t.includes(`来源：${siteUrl}/page`) && o1t.includes('标题：Phase 23 page') && o1t.includes('# It works') && o1t.includes('Served by the dev server. Read more'), o1t.slice(0, 260));
  check('… without scripts and navigation, with its links as elements', !o1t.includes('not text') && !o1t.includes('Nav') && o1t.includes(`[1] link "Read more" → ${siteUrl}/more`));
  const next = /browser_read \{"offset": (\d+)\}/.exec(o1t)?.[1];
  check('… cut at 12 000 characters with the offset to go on from', next === '12000', `next=${next}`);
  const r1 = await mcp.call('browser_read', { offset: Number(next), max_chars: 60000 });
  check('browser_read continues from there to the end of the page', !r1.isError && textOf(r1).includes('THE-END') && textOf(r1).includes('正文到这里结束'), textOf(r1).slice(-160));
  const f1 = await mcp.call('browser_find', { query: 'read more' });
  check('browser_find finds the link', !f1.isError && textOf(f1).includes('[1] link "Read more"'), textOf(f1).slice(0, 200));
  const c1 = await mcp.call('browser_click', { ref: '1' });
  check('browser_click says it needs the desktop app', c1.isError === true && textOf(c1).includes('这个操作需要桌面版 Claude Web 的内置浏览器（现在没有桌面窗口连着）。'), textOf(c1));
  const shot0 = await mcp.call('browser_screenshot');
  check('… and so does browser_screenshot', shot0.isError === true && textOf(shot0).includes('需要桌面版'), textOf(shot0));
  const cu0 = await mcp.call('browser_computer', { action: 'left_click', coordinate: [10, 10] });
  check('… and browser_computer', cu0.isError === true && textOf(cu0).includes('需要桌面版') && textOf(cu0).includes('browser_computer'), textOf(cu0));
  const self = await mcp.call('browser_open', { url: `http://127.0.0.1:${port}/api/health` });
  check('the server does not open itself', self.isError === true && textOf(self).includes('Claude Web 自己'), textOf(self));
  const lan = await mcp.call('browser_open', { url: `${siteUrl}/to-lan` });
  check('… nor follow a redirect into the LAN', lan.isError === true && textOf(lan).includes('内网') && textOf(lan).includes('192.168.77.1'), textOf(lan));
  const file = await mcp.call('browser_open', { url: 'file:///etc/passwd' });
  check('… nor anything that is not http(s)', file.isError === true && textOf(file).includes('http / https'), textOf(file));

  // ---- (c) a window announces the browser ----
  const hosted = await a.req({ kind: 'browser.host', on: true });
  check('browser.host: the window is the host now', hosted.host === true, JSON.stringify(hosted));
  const told = await until(() => b.events.some((e) => e.kind === 'web.changed'), 5000);
  check('… and the other window is told the status changed', !!told && (await b.req({ kind: 'web.status' })).host === true);
  const openId = mcp.send('tools/call', { name: 'browser_open', arguments: { url: 'https://app.example/login' } });
  const cmd = await until(() => a.commands()[0], 10_000);
  check('browser_open arrives at the hosting window as browser.command', cmd?.op === 'open' && cmd?.sessionId === 'phase23-conv' && cmd?.args?.url === 'https://app.example/login' && typeof cmd?.id === 'string', JSON.stringify(cmd));
  check('… and at no other window', b.commands().length === 0);
  const notMine = await b.req({ kind: 'browser.result', id: cmd?.id, ok: true, answer: { note: 'not mine' } });
  check('another window cannot answer for it', notMine?.taken === false, JSON.stringify(notMine));
  const taken = await a.req({ kind: 'browser.result', id: cmd?.id, ok: true, answer: { page: { url: 'https://app.example/login', title: 'Sign in', text: 'Welcome back. Please sign in.', elements: [{ ref: 'e1', role: 'textbox', name: 'Email' }, { ref: 'e2', role: 'button', name: 'Continue' }] } } });
  const opened = (await mcp.wait(openId)).result;
  check('the answer sent with browser.result is the tool\'s result', taken?.taken === true && !opened?.isError && textOf(opened).includes('来源：https://app.example/login') && textOf(opened).includes('Welcome back. Please sign in.') && textOf(opened).includes('[e2] button "Continue"'), textOf(opened).slice(0, 300));

  const typeId = mcp.send('tools/call', { name: 'browser_type', arguments: { ref: 'e1', text: 'me@example.com', submit: true } });
  const cmd2 = await until(() => a.commands()[1], 10_000);
  check('browser_type carries ref / text / submit', cmd2?.op === 'type' && cmd2?.args?.ref === 'e1' && cmd2?.args?.text === 'me@example.com' && cmd2?.args?.submit === true, JSON.stringify(cmd2));
  await a.req({ kind: 'browser.result', id: cmd2?.id, ok: false, error: '页面上没有 e1 这个元素' });
  const typed = (await mcp.wait(typeId)).result;
  check('the window\'s failure is what the model reads', typed?.isError === true && textOf(typed) === '页面上没有 e1 这个元素', textOf(typed));

  const shotId = mcp.send('tools/call', { name: 'browser_screenshot', arguments: {} });
  const cmd3 = await until(() => a.commands()[2], 10_000);
  await a.req({ kind: 'browser.result', id: cmd3?.id, ok: true, answer: { image: { mime: 'image/png', data: 'iVBORw0KGgo=' }, page: { url: 'https://app.example/login', title: 'Sign in', text: '' } } });
  const shot = (await mcp.wait(shotId)).result;
  check('a screenshot comes back as an image block', cmd3?.op === 'screenshot' && shot?.content?.some((c) => c.type === 'image' && c.data === 'iVBORw0KGgo=' && c.mimeType === 'image/png'), JSON.stringify(shot?.content?.map((c) => c.type)));

  // the mouse by position: the checked arguments go over, a fresh picture with its size comes back
  const cuId = mcp.send('tools/call', { name: 'browser_computer', arguments: { action: 'left_click', coordinate: [640, 300], text: 'shift' } });
  const cmd4 = await until(() => a.commands()[3], 10_000);
  check('browser_computer arrives as a `computer` command with the action and the position', cmd4?.op === 'computer' && cmd4?.sessionId === 'phase23-conv' && JSON.stringify(cmd4?.args) === JSON.stringify({ action: 'left_click', coordinate: [640, 300], modifiers: 'shift' }), JSON.stringify(cmd4));
  await a.req({ kind: 'browser.result', id: cmd4?.id, ok: true, answer: { note: '已点击。', image: { mime: 'image/jpeg', data: '/9j/4AAQ', width: 1280, height: 843 } } });
  const cu = (await mcp.wait(cuId)).result;
  check('… and comes back with the picture and its size', !cu?.isError && textOf(cu).includes('已点击。') && textOf(cu).includes('截图是 1280×843 像素') && cu?.content?.some((c) => c.type === 'image' && c.data === '/9j/4AAQ' && c.mimeType === 'image/jpeg'), textOf(cu));
  const cuBad = await mcp.call('browser_computer', { action: 'left_click' });
  check('… a click without a position never reaches the window', cuBad.isError === true && textOf(cuBad).includes('coordinate') && a.commands().length === 4, textOf(cuBad));

  // searching is done in the window's browser now: a result page per engine, read there; the server fetches nothing
  const fetchedBefore = engineHits.length;
  const b1 = await mcp.call('web_search', { query: 'node in the browser' });
  const sent = a.searches();
  check('with a window: web_search loads DuckDuckGo\'s result page in the built-in browser', !b1.isError && textOf(b1).includes('用 DuckDuckGo 搜索「node in the browser」') && textOf(b1).includes('1. Ducks for node in the browser\n   https://duck.example/in-the-browser\n   Read in the browser.'), textOf(b1).slice(0, 260));
  check('… as one `search` command to the hosting window, in no conversation\'s tab', sent.length === 1 && sent[0].sessionId === '' && sent[0].args?.engine === 'duckduckgo' && sent[0].args?.url === `${siteUrl}/ddg/html/?q=node%20in%20the%20browser` && b.searches().length === 0, JSON.stringify(sent));
  const b2 = await mcp.call('web_search', { query: 'the wall again' });
  check('… a challenge page there → the next engine\'s page is read (the link behind Bing\'s redirect)', !b2.isError && textOf(b2).includes('用 Bing 搜索') && textOf(b2).includes('https://docs.example/in-the-browser') && pageHits.slice(-2).join(' | ') === 'duckduckgo the wall again | bing the wall again', `${pageHits.slice(-2).join(' | ')} — ${textOf(b2).slice(0, 160)}`);
  const b3 = await mcp.call('web_search', { query: 'node once more' });
  check('… and the engine that challenged is left out of the next search', textOf(b3).includes('用 Bing 搜索') && pageHits[pageHits.length - 1] === 'bing node once more', pageHits.slice(-2).join(' | '));
  await a.req({ kind: 'settings.set', key: 'web.search.engine', value: 'google' });
  const b4 = await mcp.call('web_search', { query: 'node' });
  check('… an engine asking for verification: the model is told to open its page so the user can do it', b4.isError === true && textOf(b4).includes('Google：要求验证') && textOf(b4).includes('browser_open 打开 https://www.google.com/search?q=node&hl=en') && textOf(b4).includes('在右侧面板的浏览器里打开它'), textOf(b4).slice(0, 300));
  await a.req({ kind: 'settings.set', key: 'web.search.engine', value: 'auto' });
  const b5 = await mcp.call('web_search', { query: 'unrelated zzz' });
  check('… a list about something else is not handed on from the browser either', !b5.isError && textOf(b5).includes('用 Bing 搜索') && !textOf(b5).includes('Manage your storage'), textOf(b5).slice(0, 200));
  check('… and through all of it the server fetched no result page itself', engineHits.length === fetchedBefore, engineHits.slice(fetchedBefore).join(' | '));

  // ---- (d) who may call the endpoint, who may host ----
  const wrong = await post(port, { sessionId: 's', tool: 'web_search', args: { query: 'x' } }, 'not-the-secret');
  const none = await post(port, { sessionId: 's', tool: 'web_search', args: { query: 'x' } });
  const appToken = await post(port, { sessionId: 's', tool: 'web_search', args: { query: 'x' } }, token);
  check('the endpoint refuses a wrong secret, no secret, and the app\'s own token', wrong.status === 401 && none.status === 401 && appToken.status === 401, `${wrong.status} ${none.status} ${appToken.status}`);
  const right = await post(port, { sessionId: 's', tool: 'web_search', args: { query: 'direct' } }, secret);
  check('… and runs for the secret', right.status === 200 && textOf(right.json).includes('https://duck.example/in-the-browser'), `${right.status} ${textOf(right.json).slice(0, 160)}`);

  const rst = await a.req({ kind: 'remote.set', enabled: true, port: await freePort(), anywhere: false });
  check('remote access is on (the phone\'s listener)', rst.running === true, rst.error);
  const viaRemote = await post(rst.port, { sessionId: 's', tool: 'web_search', args: { query: 'x' } }, secret);
  check('the endpoint does not exist on the remote-access listener, even with the secret', viaRemote.status === 404, String(viaRemote.status));
  const pair = await a.req({ kind: 'remote.pairCode' });
  const dev = await (await fetch(`http://127.0.0.1:${rst.port}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.code, name: 'phase23 phone' }) })).json();
  const phone = client(`ws://127.0.0.1:${rst.port}/ws?token=${dev.token}`);
  await phone.open;
  const phoneHost = await phone.req({ kind: 'browser.host', on: true }).then(() => null, (e) => e.message);
  const phoneAnswer = await phone.req({ kind: 'browser.result', id: 'x', ok: true }).then(() => null, (e) => e.message);
  check('a paired device (a phone) cannot become the browser host, nor answer for it', /只有本机的桌面窗口/.test(phoneHost ?? '') && /只有本机的桌面窗口/.test(phoneAnswer ?? ''), `${phoneHost} | ${phoneAnswer}`);
  check('… but it can read the status', (await phone.req({ kind: 'web.status' })).host === true);
  phone.ws.terminate();
  await a.req({ kind: 'remote.set', enabled: false });

  // ---- settings: a key, the switch, what a CLI agent is handed ----
  await a.req({ kind: 'settings.set', key: 'web.search.braveKey', value: 'phase23-not-a-real-key' });
  const settings1 = await a.req({ kind: 'settings.get' });
  const st1 = await a.req({ kind: 'web.status' });
  const meta = await until(() => { try { const t = fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8'); return t.includes('web.search.braveKey') ? t : null; } catch { return null; } }, 10_000);
  check('a search engine\'s key reads back as a mask, shows as "has key", and is not in meta.json as written', settings1['web.search.braveKey'] === '••••••' && st1.engines.find((e) => e.id === 'brave')?.hasKey === true && !!meta && !meta.includes('phase23-not-a-real-key'), `${settings1['web.search.braveKey']} ${JSON.stringify(st1.engines.find((e) => e.id === 'brave'))}`);
  await a.req({ kind: 'settings.set', key: 'web.search.braveKey', value: '' });
  check('… and \'\' removes it', (await a.req({ kind: 'web.status' })).engines.find((e) => e.id === 'brave')?.hasKey === false);

  const mock = path.join(here, 'src', 'agents', '__mocks__', 'acp-agent.mjs');
  await a.req({ kind: 'agents.set', agent: 'acp:p23', patch: { name: 'P23 Mock', command: process.execPath, args: [mock], protocol: 'acp', label: 'p23' } });
  /** The MCP servers a new conversation of the mock agent was handed (it echoes them back). */
  const handed = async () => {
    const o = await a.req({ kind: 'session.open', params: { cwd: proj, agent: 'acp:p23', permissionMode: 'default' } });
    await until(() => a.events.some((e) => e.kind === 'session.state' && e.sessionId === o.sessionId && (e.state === 'idle' || e.state === 'error')), 60_000);
    const from = a.events.length;
    await a.req({ kind: 'session.send', params: { sessionId: o.sessionId, text: '列一下 mcp' } });
    const echoed = await until(() => a.events.slice(from).find((e) => e.kind === 'session.event' && e.sessionId === o.sessionId && e.message.type === 'stream_event' && e.message.event?.delta?.text?.includes('[mcp:')), 30_000);
    await until(() => a.events.slice(from).some((e) => e.kind === 'session.event' && e.sessionId === o.sessionId && e.message.type === 'result'), 30_000);
    await a.req({ kind: 'session.close', sessionId: o.sessionId }).catch(() => {});
    await a.req({ kind: 'session.delete', sessionId: o.sessionId }).catch(() => {});
    return echoed?.message?.event?.delta?.text?.trim() ?? '(nothing echoed)';
  };
  const withWeb = await handed();
  check('a CLI agent is handed the web server next to the shared memory', withWeb === '[mcp: memory,web]', withWeb);
  await a.req({ kind: 'settings.set', key: 'web.mcp', value: false });
  const withoutWeb = await handed();
  check('with web.mcp off a new conversation is not told about it', withoutWeb === '[mcp: memory]' && (await a.req({ kind: 'web.status' })).enabled === false, withoutWeb);
  await a.req({ kind: 'settings.set', key: 'web.mcp', value: true });
  await a.req({ kind: 'agents.set', agent: 'acp:p23', patch: null });

  // ---- the hosting window goes away ----
  const hangId = mcp.send('tools/call', { name: 'browser_click', arguments: { ref: 'e2' } });
  const n = a.commands().length;
  await until(() => a.commands().length > n, 10_000);
  const t0 = Date.now();
  a.ws.close();
  const hung = (await mcp.wait(hangId)).result;
  check('the hosting window closing fails what it was asked at once (not after 30 s)', hung?.isError === true && textOf(hung).includes('断开') && Date.now() - t0 < 5000, `${Date.now() - t0} ms — ${textOf(hung)}`);
  const st2 = await until(async () => { const s = await b.req({ kind: 'web.status' }); return s.host === false ? s : null; }, 5000);
  check('… and the status says no window hosts the browser', !!st2);
  const back = await mcp.call('browser_read', {});
  check('reading falls back to the server: the page this conversation opened there is still its page', !back.isError && textOf(back).includes('# It works'), textOf(back).slice(0, 160));
  const pagesBefore = pageHits.length;
  const after = await mcp.call('web_search', { query: 'node after' });
  check('… and so does searching: the server fetches the result page itself again', !after.isError && textOf(after).includes('用 Bing 搜索') && engineHits[engineHits.length - 1] === 'bing node after' && pageHits.length === pagesBefore, `${engineHits[engineHits.length - 1]} — ${textOf(after).slice(0, 120)}`);
}

main().catch((e) => { check('phase23 ran to the end', false, e.stack || e.message); }).finally(async () => {
  try { await mcp?.stop(); } catch { /* */ }
  for (const c of [a, b]) { try { c.ws.terminate(); } catch { /* */ } }
  server.kill();
  site.closeAllConnections?.();
  site.close();
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
  const bad = results.filter(([, ok]) => !ok);
  if (bad.length) console.log(`\n--- server log (tail) ---\n${slog.split('\n').slice(-60).join('\n')}\n--- engine hits ---\n${engineHits.join('\n')}`);
  console.log(`\nphase23: ${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
});
