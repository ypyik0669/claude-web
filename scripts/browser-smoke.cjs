// Built-in browser smoke (spec docs/superpowers/specs/2026-10-10-ui-structure/design.md §4–5), as a real run: the
// built app in a real Electron window with the <webview> tag (what the desktop app has), a throwaway server (temp
// HOME) and a little web site on this machine. Checks:
//   · the right panel's 浏览器: a new tab's page, typing an address loads it in a real page, the tab takes its title,
//     the site lands in 最近打开;
//   · an Agent's operations carried out in the page (features/browser/host.ts, called directly): open → the text and
//     the things to act on; type into a field and a <select>; click a button whose handler is script; a key; type +
//     submit sends the form and the answer is the next page; back; a long page that loads more when scrolled; find;
//     a screenshot; a ref that is gone is said in words; each conversation's Agent has its own tab, marked as such;
//   · the page keeps working while another tab of the right panel is in front, and a hidden right panel is brought
//     back for an operation that needs the page on screen;
//   · web search the way it is done in the desktop app: a search engine's result page loaded in a hidden page of the
//     browser and read there (features/browser/search-page.ts) — a list, a list a script draws late, a page whose
//     pictures never arrive, a challenge page, a page that cannot be loaded, five at once;
//   · browser_computer, the mouse and keyboard by position: a picture with its size, click / double click / right
//     click / a held modifier, typing into what has the focus, a shortcut, a drag, the wheel both ways;
//   · the whole loop the way an agent drives it: the `web` MCP process (server/dist/web/mcp.js, JSON-RPC over stdio)
//     → POST /api/web/tool → the server → this window (browser.command) → the page → browser.result → the tool's
//     result — for a page, for a search (the engines are this script's own site: CW_DDG_URL / CW_BING_URL) and for a
//     click by position. No model, no token; nothing leaves the machine.
//   · any console error or warning of the app fails the run.
//
//   npm run build:all && node scripts/browser-smoke.cjs [--out <dir>] [--show] [--keep] [--real]
//
// --real: the search engines are the real ones (this does leave the machine): three searches over MCP through the
// whole chain, each printed with the engine that answered and its first results.
//
// Plain `node` runs the orchestration half, then Electron runs this same file (options in env vars, a result JSON
// file back), as scripts/ui-smoke.cjs does. The window is a real one (a <webview> does not draw in an offscreen
// window); without --show it is opened without taking the focus.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const isElectronMain = !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE;
if (isElectronMain) driver();
else runner().catch((e) => { console.error(e.stack || e); process.exit(2); });

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ orchestration (plain node) */

/** The web, on this machine: a home page, a form, the page the form leads to, a long page that grows when scrolled. */
function startSite() {
  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const srv = http.createServer((q, s) => {
    const u = new URL(q.url || '/', 'http://x');
    const html = (body) => { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); s.end(body); };
    if (u.pathname === '/') return html(page('Smoke Home', '<h1>Smoke Home</h1><p>The first page of the smoke site.</p><p><a href="/form">Go to the form</a></p><p><a href="/long" target="_blank">The long page</a></p><p style="display:none">HIDDEN-TEXT <a href="/secret">hidden link</a></p>'));
    if (u.pathname === '/form') {
      return html(page('Smoke Form', `<h1>Sign up</h1>
<form action="/done" method="get">
  <label>Your name <input name="who" placeholder="Name"></label>
  <select name="color" aria-label="Colour"><option>Red</option><option>Green</option><option>Blue</option></select>
  <label><input type="checkbox" name="agree"> I agree</label>
  <button type="submit">Send it</button>
</form>
<p><button type="button" id="count">Count</button> <span id="n">count: 0</span></p>
<p id="keys">keys:</p>
<script>
  let n = 0;
  document.getElementById('count').addEventListener('click', () => { n += 1; document.getElementById('n').textContent = 'count: ' + n; });
  document.addEventListener('keydown', (e) => { document.getElementById('keys').textContent += ' ' + e.key; });
</script>`));
    }
    if (u.pathname === '/done') return html(page('Smoke Done', `<h1>Thanks, ${esc(u.searchParams.get('who') || '?')} (${esc(u.searchParams.get('color') || '?')})</h1><p>agree=${esc(u.searchParams.get('agree') || 'no')}</p><p><a href="/">Home</a></p>`));
    if (u.pathname === '/long') {
      const lines = Array.from({ length: 220 }, (_, i) => `<p>line ${i + 1} of the long page</p>`).join('');
      return html(page('Smoke Long', `<h1>Long</h1>${lines}<div id="more"></div>
<script>
  let done = false;
  addEventListener('scroll', () => {
    if (done || scrollY < 400) return;
    done = true;
    document.getElementById('more').innerHTML = '<p>LAZY-LOADED part of the long page</p>';
  });
</script>`));
    }
    // a search engine's result page (this site plays DuckDuckGo at /ddg and Bing at /bing): links that are headings,
    // each with a line about it. Words in the query pick what kind of page it is.
    if (u.pathname === '/results' || u.pathname === '/ddg/html/' || u.pathname === '/bing/search') {
      const q = u.searchParams.get('q') || '';
      const has = (w) => new RegExp(`\\b${w}\\b`).test(q);
      const item = (i) => `<div class="result"><h2><a href="https://r${i}.example/${encodeURIComponent(q)}">${esc(q)} — result ${i}</a></h2><p>About ${esc(q)}, number ${i}.</p></div>`;
      const items = Array.from({ length: 4 }, (_, i) => item(i + 1)).join('');
      const title = `${esc(q)} at Smoke Search`;
      // "DuckDuckGo" asks for a check when the query has "wall" in it; "Bing" always lists
      if (has('wall') && u.pathname !== '/bing/search') return html(page('Smoke Search', '<h1>Unfortunately, bots use Smoke Search too.</h1><p>Please complete the following challenge.</p>'));
      if (has('late')) return html(page(title, `<div id="links"></div><script>setTimeout(() => { document.getElementById('links').innerHTML = ${JSON.stringify(items)}; }, 900);</script>`));
      if (has('slowimg')) return html(page(title, `<div id="links">${items}</div><img src="/never.png" alt="">`));
      return html(page(title, `<div id="links">${items}</div><p><a href="/results?q=more">More results</a></p>`));
    }
    if (u.pathname === '/never.png') return; // never answered: a page whose load does not finish
    // a page to work on by position: everything at a known place, everything that happens to it written down
    if (u.pathname === '/pad') {
      return html(`<!doctype html><html><head><meta charset="utf-8"><title>Smoke Pad</title><style>
  body { margin: 0; font: 15px sans-serif; }
  #btn { position: absolute; left: 40px; top: 40px; width: 160px; height: 60px; }
  #field { position: absolute; left: 40px; top: 130px; width: 260px; height: 30px; box-sizing: border-box; }
  #box { position: absolute; left: 40px; top: 200px; width: 320px; height: 120px; background: #e4e4e4; user-select: none; }
  #tall { position: absolute; left: 0; top: 400px; width: 10px; height: 3000px; }
</style></head><body>
<button id="btn" type="button">Pad button</button>
<input id="field" aria-label="Pad field">
<div id="box">drag here</div>
<div id="tall"></div>
<script>
  const st = { clicks: 0, dbl: 0, ctx: 0, shift: false, down: null, up: null, moves: 0, wheel: [], keys: [] };
  window.__pad = st;
  const btn = document.getElementById('btn');
  const box = document.getElementById('box');
  btn.addEventListener('click', (e) => { st.clicks += 1; st.shift = e.shiftKey; });
  btn.addEventListener('dblclick', () => { st.dbl += 1; });
  box.addEventListener('contextmenu', (e) => { st.ctx += 1; e.preventDefault(); });
  box.addEventListener('mousedown', (e) => { if (e.button === 0) st.down = [e.clientX, e.clientY]; });
  addEventListener('mousemove', (e) => { if (e.buttons & 1) st.moves += 1; });
  addEventListener('mouseup', (e) => { if (e.button === 0) st.up = [e.clientX, e.clientY]; });
  addEventListener('wheel', (e) => { st.wheel.push([Math.round(e.deltaX), Math.round(e.deltaY)]); }, { passive: true });
  addEventListener('keydown', (e) => { st.keys.push((e.ctrlKey ? 'C-' : '') + e.key); });
</script></body></html>`);
    }
    s.writeHead(404, { 'content-type': 'text/plain' });
    s.end('not here');
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function startServer(home, out, more = {}) {
  const { spawn } = require('node:child_process');
  const token = require('node:crypto').randomBytes(12).toString('hex');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1', ...more };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(k) || (!more.KEEP_PROXY && /^(no|http|https|all)_proxy$/i.test(k)) || k === 'CW_WEB_TOKEN' || k === 'CW_WEB_TOKEN_FILE') delete env[k];
  const logFile = path.join(out, 'server.log');
  fs.writeFileSync(logFile, '');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'dist', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  const onData = (d) => { log += d; fs.appendFileSync(logFile, d); };
  server.stderr.on('data', onData);
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${log}`)), 60_000);
    server.stdout.on('data', (d) => {
      onData(d);
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(log);
      if (m) { clearTimeout(t); res(m[1]); }
    });
    server.on('exit', (c) => rej(new Error(`server exited (${c})\n${log}`)));
  });
  return { server, origin: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/?token=${token}`, log: () => log };
}

function runElectron(env, timeoutMs) {
  const { spawn } = require('node:child_process');
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const e = { ...process.env, ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  e.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  return new Promise((res) => {
    const c = spawn(electron, [__filename], { env: e, stdio: 'ignore', windowsHide: false });
    const t = setTimeout(() => { c.kill(); res(-1); }, timeoutMs);
    c.on('exit', (code) => { clearTimeout(t); res(code); });
  });
}

async function runner() {
  const out = path.resolve(String(arg('--out', path.join(os.tmpdir(), 'cw-browser-smoke'))));
  fs.mkdirSync(out, { recursive: true });
  if (!fs.existsSync(path.join(ROOT, 'server', 'dist', 'web', 'mcp.js')) || !fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) {
    console.error('build first: npm run build:all');
    process.exit(2);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-bsmoke-'));
  const site = await startSite();
  const real = !!arg('--real', false);
  // the search engines are this script's site — unless the real ones are asked for (then the user's proxy is kept too)
  const srv = await startServer(home, out, real ? { KEEP_PROXY: '1' } : { CW_DDG_URL: `${site.url}/ddg`, CW_BING_URL: `${site.url}/bing` });
  console.log(`server up (HOME=${home}), site ${site.url}${real ? ', REAL search engines' : ''}`);
  const result = path.join(out, 'browser-smoke.json');
  fs.rmSync(result, { force: true });
  const code = await runElectron({
    SMOKE_URL: srv.url,
    SMOKE_ORIGIN: srv.origin,
    SMOKE_SITE: site.url,
    SMOKE_OUT: out,
    SMOKE_RESULT: result,
    SMOKE_DATA: path.join(home, '.claude-web'),
    SMOKE_NODE: process.execPath,
    SMOKE_SHOW: arg('--show', false) ? '1' : '',
    SMOKE_REAL: real ? '1' : '',
  }, 420_000);
  let r = null;
  try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { /* electron died */ }
  let failed = !r || code !== 0;
  if (r) {
    for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    console.log(`\nconsole errors/warnings: ${r.console.length}`);
    for (const m of r.console.slice(0, 30)) console.log(`  [${m.phase}] ${m.level}: ${m.message}`);
    if (r.console.length || r.checks.some((c) => !c.ok)) failed = true;
    console.log(`${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks, ${r.seconds} s`);
  } else {
    console.log(`electron exited ${code} without a result (see ${result}.log)`);
  }
  srv.server.kill();
  site.srv.closeAllConnections?.(); // (a picture this site never finishes sending)
  site.srv.close();
  await sleep(800);
  if (!arg('--keep', false)) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ } }
  console.log(failed ? '\nBROWSER SMOKE FAILED' : '\nbrowser smoke passed');
  process.exit(failed ? 1 : 0);
}

/* ------------------------------------------------------------------ Electron half */

function driver() {
  const { app, BrowserWindow } = require('electron');
  const { spawn } = require('node:child_process');
  const E = process.env;
  const SITE = E.SMOKE_SITE;
  const logFile = `${E.SMOKE_RESULT}.log`;
  const log = (s) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`); } catch { /* ignore */ } };
  try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
  const res = { checks: [], console: [], startedAt: Date.now(), seconds: 0 };
  let phase = 'load';
  const check = (name, ok, detail) => { res.checks.push({ name, ok: !!ok, detail: detail ? String(detail).slice(0, 400) : undefined }); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`); };
  const finish = (code) => { res.seconds = Math.round((Date.now() - res.startedAt) / 1000); try { fs.writeFileSync(E.SMOKE_RESULT, JSON.stringify(res, null, 2)); } catch { /* ignore */ } app.exit(code); };
  process.on('uncaughtException', (e) => { log(`uncaught ${e.stack || e}`); check('driver', false, String(e.message || e)); finish(3); });
  const hardStop = setTimeout(() => { check('driver finished in time', false, phase); finish(6); }, 380_000);

  /** The `web` MCP server as an agent starts it: a process, JSON-RPC lines over stdio. */
  function startMcp(env) {
    const p = spawn(E.SMOKE_NODE, [path.join(ROOT, 'server', 'dist', 'web', 'mcp.js')], { cwd: os.tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    const wait = async (id, ms = 40_000) => { const end = Date.now() + ms; for (;;) { const r = replies.get(id); if (r) return r; if (Date.now() > end) return { error: { message: `no answer in ${ms} ms. stderr: ${stderr.slice(-300)}` } }; await sleep(50); } };
    return {
      rpc: (method, params) => wait(send(method, params)),
      call: async (name, args = {}, ms) => { const r = await wait(send('tools/call', { name, arguments: args }), ms); return r.result ?? { isError: true, content: [{ type: 'text', text: `rpc error: ${r.error?.message}` }] }; },
      stop: () => { try { p.stdin.end(); } catch { /* gone */ } setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500); },
    };
  }

  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1320, height: 860, show: false, webPreferences: { webviewTag: true, backgroundThrottling: false } });
    win.showInactive();
    const wc = win.webContents;
    // as the desktop shell does: a page of the browser gets no preload of ours, and opens no window of its own
    wc.on('will-attach-webview', (_e, prefs) => { delete prefs.preload; prefs.nodeIntegration = false; prefs.contextIsolation = true; });
    wc.on('did-attach-webview', (_e, guest) => { guest.setWindowOpenHandler(() => ({ action: 'deny' })); });
    wc.on('console-message', (a, b, c) => {
      const level = typeof a === 'object' && a && 'level' in a ? a.level : b;
      const message = typeof a === 'object' && a && 'message' in a ? a.message : c;
      if (level === 'error' || level === 'warning' || Number(level) >= 2) res.console.push({ phase, level: String(level), message: String(message).slice(0, 600) });
    });
    wc.on('render-process-gone', (_e, d) => check('renderer alive', false, d.reason));
    const js = (code) => wc.executeJavaScript(code, true);
    const waitFor = async (code, ms = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(code).catch(() => false)) return true; await sleep(120); } return false; };
    /** One operation as the server would send it, answered as { ok, a | error }. */
    let seq = 0;
    const op = (sessionId, o, args = {}) => js(`window.__cwBrowser.carryOut(${JSON.stringify({ id: `s${++seq}`, sessionId, op: o, args })}).then((a) => ({ ok: true, a }), (e) => ({ ok: false, error: String(e && e.message || e) }))`);
    const refOf = (a, re) => (a?.page?.elements ?? a?.elements ?? []).find((e) => re.test(`${e.role} ${e.name}`))?.ref;
    const tabs = () => js(`window.__cwBrowser.state.getState().tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, agent: t.agent || null, src: t.src }))`);

    try {
      await wc.loadURL(E.SMOKE_URL);
      const up = await waitFor(`!!window.__store && window.__store.getState().connected && !!window.__cwBrowser && window.__cwBrowser.canHost()`, 30_000);
      check('the app is up and this window can host the browser (a <webview> tag is there)', up, up ? '' : await js(`JSON.stringify({ store: !!window.__store, host: !!window.__cwBrowser, can: !!window.__cwBrowser && window.__cwBrowser.canHost() })`).catch(String));
      if (!up) return finish(1);
      await js(`(() => { const st = window.__store.getState(); st.setSetting('onboarded', true); st.setSetting('ui.workbench', false); })()`);
      await sleep(600);

      // ---- the user's own browsing
      phase = 'user';
      await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'browser' })`);
      const panel = await waitFor(`!!document.querySelector('.dock .tab.active[data-panel="browser"]') && !!document.querySelector('.dock-panel[data-panel="browser"] .bw .bw-newtab .bw-search input')`, 8000);
      check('浏览器 is a tab of the right panel; a new tab shows its own page with the search box', panel);
      check('one tab only: no tab row', await js(`!document.querySelector('.bw .bw-tabs') && window.__cwBrowser.state.getState().tabs.length === 1`));
      await js(`(() => { const i = document.querySelector('.bw .bw-addr input'); i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(SITE.replace('http://', ''))}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      await wc.sendInputEvent({ type: 'char', keyCode: '\r' });
      await wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      const loaded = await waitFor(`(() => { const t = window.__cwBrowser.state.getState().tabs[0]; return !!t && t.title === 'Smoke Home' && !t.loading && !!document.querySelector('.bw webview'); })()`, 15_000);
      const t0 = (await tabs())[0];
      check('an address typed without http:// loads in a real page; the tab takes the page\'s title', loaded && t0.url === `${SITE}/`, JSON.stringify(t0));
      check('the address field shows where the page is', await js(`document.querySelector('.bw .bw-addr input').value`) === `${SITE}/`);
      const recent = await waitFor(`(() => { const r = window.__store.getState().settings['ui.browser.recent']; return Array.isArray(r) && r[0] && r[0].title === 'Smoke Home'; })()`, 5000);
      check('the site is in 最近打开 (meta.json ui.browser.recent)', recent, JSON.stringify(await js(`window.__store.getState().settings['ui.browser.recent']`)));

      // ---- an Agent's operations, in a tab of its own
      phase = 'agent';
      const S = 'smoke-conv';
      const refused = await op(S, 'read');
      check('before its first open an Agent has no page: said in words', !refused.ok && /browser_open/.test(refused.error), JSON.stringify(refused));
      const opened = await op(S, 'open', { url: `${SITE}/form` });
      const els = opened.a?.page?.elements ?? [];
      check('open: the page\'s title, its text, and the things to act on', opened.ok && opened.a.page.title === 'Smoke Form' && /Sign up/.test(opened.a.page.text) && els.length >= 5, opened.ok ? JSON.stringify(els) : opened.error);
      const two = await tabs();
      check('the Agent works in a tab of its own (the user\'s page is untouched)', two.length === 2 && two[0].url === `${SITE}/` && two[1].agent === S && two[1].url === `${SITE}/form`, JSON.stringify(two));
      check('…the tab row appears, the Agent\'s tab is marked and says whose it is', await js(`document.querySelectorAll('.bw .bw-tabs .bw-tab').length === 2 && !!document.querySelector('.bw .bw-tabs .bw-tab.agent.on') && !!document.querySelector('.bw [data-id="agent-strip"]')`));
      const who = refOf(opened.a, /input.*Your name|input.*Name/);
      const color = refOf(opened.a, /Colour/);
      const count = refOf(opened.a, /button Count/);
      const sendIt = refOf(opened.a, /button Send it/);
      check('the field, the select and the buttons each have a ref', !!who && !!color && !!count && !!sendIt, JSON.stringify({ who, color, count, sendIt }));

      const typed = await op(S, 'type', { ref: who, text: 'Ada' });
      check('type: answered at once, in this side\'s own words (the ref, no page text)', typed.ok && typed.a.note === `已在 [${who}] 里输入。` && !typed.a.page, JSON.stringify(typed));
      const picked = await op(S, 'type', { ref: color, text: 'green' });
      check('type on a <select> picks the option', picked.ok, JSON.stringify(picked));
      const c1 = await op(S, 'click', { ref: count });
      const c2 = await op(S, 'click', { ref: `[${count}]` });
      check('click runs the page\'s own handler, and the answer is the page afterwards', c1.ok && c2.ok && /count: 2/.test(c2.a.page.text) && c2.a.note === `已点击 [${count}]。`, c2.ok ? c2.a.note + ' / ' + (/count: \d/.exec(c2.a.page.text) || [''])[0] : c2.error);
      const seen = await op(S, 'read', { offset: 0, maxChars: 4000 });
      const whoNow = (seen.a?.page?.elements ?? []).find((e) => e.ref === who);
      const colorNow = (seen.a?.page?.elements ?? []).find((e) => e.ref === color);
      check('read: the same refs, now with what was typed and picked', seen.ok && whoNow?.value === 'Ada' && colorNow?.value === 'Green', JSON.stringify({ whoNow, colorNow }));
      const key = await op(S, 'key', { key: 'ArrowDown' });
      check('key: the page sees the key press', key.ok && /keys:.*ArrowDown/.test(key.a.page.text), key.ok ? (/keys:[^\n]*/.exec(key.a.page.text) || [''])[0] : key.error);
      const found = await op(S, 'find', { query: 'send' });
      check('find: the matching things, with their refs', found.ok && (found.a.elements ?? []).some((e) => e.ref === sendIt), JSON.stringify(found.a?.elements ?? found.error));
      const sent = await op(S, 'type', { ref: who, text: 'Ada L', submit: true });
      check('type + submit sends the form: the answer is the next page', sent.ok && /Thanks, Ada L \(Green\)/.test(sent.a.page.text) && sent.a.page.title === 'Smoke Done', sent.ok ? sent.a.page.text.slice(0, 80) : sent.error);
      const stale = await op(S, 'click', { ref: who });
      check('a ref of the page before is gone: said in words, not a crash', !stale.ok && /不在页面上了/.test(stale.error), JSON.stringify(stale));
      const back = await op(S, 'back');
      check('back: the form again', back.ok && back.a.page.title === 'Smoke Form' && back.a.note === '已返回上一页。', back.ok ? back.a.page.title : back.error);

      const long = await op(S, 'open', { url: `${SITE}/long` });
      check('open in the same tab: the Agent keeps its one tab', long.ok && long.a.page.title === 'Smoke Long' && (await tabs()).length === 2, long.ok ? '' : long.error);
      const hidden = await op(S, 'open', { url: `${SITE}/` });
      check('text that is not shown on the page is not read, nor its links listed', hidden.ok && !/HIDDEN-TEXT/.test(hidden.a.page.text) && !(hidden.a.page.elements ?? []).some((e) => /hidden link/.test(e.name)), hidden.ok ? hidden.a.page.text.slice(0, 120) : hidden.error);
      const blankTarget = refOf(hidden.a, /link The long page/);
      const viaLink = await op(S, 'click', { ref: blankTarget });
      check('a link that wants a new window opens in the Agent\'s own tab instead', viaLink.ok && viaLink.a.page.title === 'Smoke Long' && /页面换了地址/.test(viaLink.a.note) && (await tabs()).length === 2, viaLink.ok ? viaLink.a.note : viaLink.error);
      const part = await op(S, 'read', { offset: 0, maxChars: 600 });
      check('read gives a window of the text and where the rest begins', part.ok && part.a.page.text.length === 600 && part.a.page.truncated === true && part.a.page.nextOffset === 600, part.ok ? JSON.stringify({ n: part.a.page.text.length, next: part.a.page.nextOffset }) : part.error);
      const scrolled = await op(S, 'scroll', { direction: 'down', amount: 2 });
      check('scroll: a page that grows says where the new text starts', scrolled.ok && /已向下滚动/.test(scrolled.a.note) && /browser_read \{"offset": \d+\}/.test(scrolled.a.note), scrolled.ok ? scrolled.a.note : scrolled.error);
      const at = Number((/"offset": (\d+)/.exec(scrolled.a?.note ?? '') || [])[1]);
      const more = await op(S, 'read', { offset: at, maxChars: 2000 });
      check('…and reading from there gives the part that was loaded', more.ok && /LAZY-LOADED/.test(more.a.page.text), more.ok ? more.a.page.text.slice(0, 80) : more.error);
      const shotA = await op(S, 'screenshot');
      check('screenshot: a picture of the page', shotA.ok && /^image\/(png|jpeg)$/.test(shotA.a.image?.mime ?? '') && (shotA.a.image?.data?.length ?? 0) > 2000 && shotA.a.page.url === `${SITE}/long`, shotA.ok ? `${shotA.a.image?.mime} ${shotA.a.image?.data?.length}` : shotA.error);
      const bad = await op(S, 'open', { url: 'javascript:alert(1)' });
      check('only web addresses are opened', !bad.ok && /http/.test(bad.error), JSON.stringify(bad));

      // ---- another conversation's Agent: its own tab; the first one's page is where it was
      const other = await op('smoke-other', 'open', { url: `${SITE}/form` });
      const three = await tabs();
      check('each conversation\'s Agent has its own tab', other.ok && three.length === 3 && three[2].agent === 'smoke-other' && three[1].url === `${SITE}/long`, JSON.stringify(three.map((t) => [t.agent, t.url])));
      const behind = await op(S, 'read', { offset: 0, maxChars: 300 });
      check('a tab that is not in front still answers (it keeps its size)', behind.ok && behind.a.page.title === 'Smoke Long' && await js(`[...document.querySelectorAll('.bw webview')].every((w) => w.offsetWidth > 0 && w.offsetHeight > 0)`), behind.ok ? '' : behind.error);

      // ---- with another tab of the right panel in front, and with the right panel put away
      phase = 'hidden';
      await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'files' })`);
      await waitFor(`!!document.querySelector('.dock .tab.active[data-panel="files"]')`, 5000);
      const kept = await js(`(() => { const p = document.querySelector('.dock-panel[data-panel="browser"]'); const w = p.querySelector('webview'); return { hidden: p.hidden, vis: getComputedStyle(p).visibility, w: w.offsetWidth, h: w.offsetHeight }; })()`);
      check('behind 审阅 the browser\'s pages keep their size, unseen', kept.hidden && kept.vis === 'hidden' && kept.w > 0 && kept.h > 0, JSON.stringify(kept));
      const quiet = await op(S, 'click', { ref: refOf((await op(S, 'find', { query: 'line 1 ' })).a, /./) ?? 'none' });
      const stillReview = await js(`!!document.querySelector('.dock .tab.active[data-panel="files"]')`);
      check('…an operation there works and does not take the right panel away from what the user is looking at', stillReview && (quiet.ok || /不在页面上了/.test(quiet.error)), JSON.stringify({ stillReview, ok: quiet.ok, e: quiet.error }));
      const readBehind = await op(S, 'read', { offset: 0, maxChars: 200 });
      check('…reading too', readBehind.ok && readBehind.a.page.title === 'Smoke Long' && stillReview, readBehind.ok ? '' : readBehind.error);
      await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
      await waitFor(`document.querySelector('.rpanel').offsetWidth === 0`, 4000);
      const reopened = await op(S, 'read', { offset: 0, maxChars: 200 });
      const front = await waitFor(`!!document.querySelector('.dock .tab.active[data-panel="browser"]') && document.querySelector('.rpanel').offsetWidth > 0`, 4000);
      check('with the right panel put away, an operation brings the browser back (a page with no size cannot be worked in)', reopened.ok && front, reopened.ok ? '' : reopened.error);

      // ---- web search: a result page loaded in a page of its own, off screen, and read there
      phase = 'search';
      {
        const tabsBefore = (await tabs()).length;
        const search = (url) => op('', 'search', { engine: 'duckduckgo', url });
        const hiddenPages = () => js(`document.querySelectorAll('webview[data-cw-search]').length`);
        const first = await search(`${SITE}/results?q=alpha+beta`);
        const list = first.ok ? first.a.search.candidates : [];
        check('search: a result page is read in a page of the browser — its links that are headings, with the text around them',
          first.ok && list.length === 4 && list[0].title === 'alpha beta — result 1' && list[0].href === 'https://r1.example/alpha%20beta' && /About alpha beta, number 1\./.test(list[0].snippet || '') && first.a.search.url === `${SITE}/results?q=alpha+beta` && first.a.search.title === 'alpha beta at Smoke Search',
          first.ok ? JSON.stringify({ url: first.a.search.url, title: first.a.search.title, first: list[0], n: list.length }) : first.error);
        const where = await js(`(() => { const w = [...document.querySelectorAll('webview[data-cw-search]')]; return { n: w.length, left: w[0] ? w[0].getBoundingClientRect().left : null, width: w[0] ? w[0].offsetWidth : 0, vis: w[0] ? getComputedStyle(w[0]).visibility : '', inBrowser: !!document.querySelector('.bw webview[data-cw-search]') }; })()`);
        check('…in a page of its own: no tab appears, the page is off screen and never drawn', (await tabs()).length === tabsBefore && where.n === 1 && where.left < -1000 && where.width >= 1000 && where.vis === 'hidden' && !where.inBrowser, JSON.stringify(where));
        const second = await search(`${SITE}/results?q=gamma`);
        check('the next search uses that page again and reads the NEW list, not the one before', second.ok && second.a.search.candidates.length === 4 && second.a.search.candidates.every((c) => /^gamma — result/.test(c.title)) && (await hiddenPages()) === 1, second.ok ? second.a.search.candidates.map((c) => c.title).join(' | ') : second.error);
        const tLate = Date.now();
        const late = await search(`${SITE}/results?q=late+list`);
        check('a list a script draws after the load is waited for', late.ok && late.a.search.candidates.length === 4 && late.a.search.candidates[0].title === 'late list — result 1', `${Date.now() - tLate} ms ${late.ok ? late.a.search.candidates.length : late.error}`);
        const tSlow = Date.now();
        const slow = await search(`${SITE}/results?q=slowimg`);
        check('a list that is there is read without waiting for the page\'s pictures', slow.ok && slow.a.search.candidates.length === 4 && Date.now() - tSlow < 6000, `${Date.now() - tSlow} ms ${slow.ok ? slow.a.search.candidates.length : slow.error}`);
        const tWall = Date.now();
        const wall = await search(`${SITE}/results?q=wall`);
        check('a challenge in place of results comes back as what the page says, with nothing listed', wall.ok && wall.a.search.candidates.length === 0 && /bots use Smoke Search too/.test(wall.a.search.text) && !wall.a.search.failed && Date.now() - tWall < 12_000, `${Date.now() - tWall} ms ${wall.ok ? JSON.stringify(wall.a.search).slice(0, 200) : wall.error}`);
        const down = await search('http://127.0.0.1:1/html/?q=x');
        check('a page that cannot be loaded says why — the engine is out of reach, not an error of the window', down.ok && /ERR_/.test(down.a.search.failed || '') && down.a.search.candidates.length === 0, JSON.stringify(down.ok ? down.a.search : down.error));
        const again = await search(`${SITE}/results?q=after+failing`);
        check('…and the page works for the next search', again.ok && again.a.search.candidates.length === 4 && /^after failing/.test(again.a.search.candidates[0].title), again.ok ? again.a.search.candidates[0].title : again.error);
        const words = ['one', 'two', 'three', 'four', 'five'];
        const many = await Promise.all(words.map((w) => search(`${SITE}/results?q=many+${w}`)));
        const pagesNow = await hiddenPages();
        check('five searches at once: each gets its own list, on at most three pages', many.every((m, i) => m.ok && m.a.search.candidates.length === 4 && m.a.search.candidates[0].title === `many ${words[i]} — result 1`) && pagesNow >= 2 && pagesNow <= 3, `pages=${pagesNow} ${many.map((m) => (m.ok ? m.a.search.candidates[0]?.title : m.error)).join(' | ')}`);
        const notWeb = await search('javascript:alert(1)');
        check('only web addresses are loaded for a search', !notWeb.ok && /不是能打开的地址/.test(notWeb.error), JSON.stringify(notWeb));
        check('…and through all of it the tabs are as they were', (await tabs()).length === tabsBefore);
      }

      // ---- browser_computer: the mouse and keyboard by position, in the Agent's tab
      phase = 'computer';
      {
        const pad = await op(S, 'open', { url: `${SITE}/pad` });
        const tabId = (await tabs()).find((t) => t.agent === S).id;
        const guest = (code) => js(`document.querySelector('.bw-view[data-tab="${tabId}"] webview').executeJavaScript(${JSON.stringify(code)})`);
        const padNow = () => guest(`(() => Object.assign({}, window.__pad, { value: document.getElementById('field').value, y: Math.round(scrollY), iw: innerWidth, ih: innerHeight }))()`);
        const act = (args) => op(S, 'computer', args);
        const near = (a, b) => Array.isArray(a) && Math.abs(a[0] - b[0]) <= 3 && Math.abs(a[1] - b[1]) <= 3;
        const shot = await act({ action: 'screenshot' });
        const pic = shot.ok ? shot.a.image : null;
        const p0 = await padNow();
        check('computer: a picture of the page that says how large it is', pad.ok && !!pic && pic.width > 100 && pic.height > 100 && pic.data.length > 2000 && shot.a.page.url === `${SITE}/pad`, shot.ok ? `${pic.mime} ${pic.width}x${pic.height} of a page ${p0.iw}x${p0.ih}` : shot.error);
        if (pic) {
          /** A place of the page (its own pixels) as a position in the picture — what a model reads off the picture. */
          const P = (x, y) => [Math.round((x * pic.width) / p0.iw), Math.round((y * pic.height) / p0.ih)];
          const clicked = await act({ action: 'left_click', coordinate: P(120, 70) });
          const p1 = await padNow();
          check('left_click at a position presses what is there, and answers with a fresh picture', clicked.ok && p1.clicks === 1 && clicked.a.note === '已点击。' && (clicked.a.image?.data?.length ?? 0) > 2000 && clicked.a.image.width === pic.width, clicked.ok ? JSON.stringify({ clicks: p1.clicks, note: clicked.a.note }) : clicked.error);
          const twice = await act({ action: 'double_click', coordinate: P(120, 70) });
          const p2 = await padNow();
          check('double_click is a double click to the page', twice.ok && p2.dbl === 1 && p2.clicks === 3, JSON.stringify({ dbl: p2.dbl, clicks: p2.clicks, e: twice.error }));
          await act({ action: 'left_click', coordinate: P(120, 70), modifiers: 'shift' });
          check('a held modifier reaches the page', (await padNow()).shift === true);
          const right = await act({ action: 'right_click', coordinate: P(200, 260) });
          check('right_click is the context-menu click of what is there', right.ok && (await padNow()).ctx === 1, right.ok ? '' : right.error);
          await act({ action: 'left_click', coordinate: P(170, 145) });
          const typedAt = await act({ action: 'type', text: 'héllo 世界' });
          const p3 = await padNow();
          check('type goes into what was clicked, as the keyboard would put it there', typedAt.ok && p3.value === 'héllo 世界' && typedAt.a.note === '已输入。', typedAt.ok ? p3.value : typedAt.error);
          const all = await act({ action: 'key', text: 'ctrl+a' });
          await act({ action: 'type', text: 'x' });
          const p4 = await padNow();
          check('key takes a shortcut: select all, and typing replaces what was there', all.ok && p4.value === 'x' && p4.keys.includes('C-a'), JSON.stringify({ value: p4.value, keys: p4.keys, e: all.error }));
          const dragged = await act({ action: 'left_click_drag', start: P(60, 220), coordinate: P(300, 280) });
          const p5 = await padNow();
          check('left_click_drag: pressed at the start, moved with the button held, released at the end', dragged.ok && near(p5.down, [60, 220]) && near(p5.up, [300, 280]) && p5.moves >= 4, JSON.stringify({ down: p5.down, up: p5.up, moves: p5.moves, e: dragged.error }));
          const wheelDown = await act({ action: 'scroll', coordinate: P(200, 300), direction: 'down', amount: 3 });
          await sleep(500);
          const p6 = await padNow();
          check('scroll down moves the page down (the wheel at that position)', wheelDown.ok && p6.y > 100, `scrollY ${p6.y}, the page saw wheel ${JSON.stringify(p6.wheel.slice(-1))}`);
          await act({ action: 'scroll', coordinate: P(200, 300), direction: 'up', amount: 10 });
          await sleep(500);
          const p7 = await padNow();
          check('…and up brings it back', p7.y === 0, `scrollY ${p7.y}`);
          const outside = await act({ action: 'left_click', coordinate: [pic.width + 40, 10] });
          const p8 = await padNow();
          check('a position outside the picture is said in words, and nothing is clicked', !outside.ok && /在截图/.test(outside.error) && p8.clicks === p7.clicks, JSON.stringify(outside).slice(0, 200));
          const unknown = await act({ action: 'key', text: 'NoSuchKey' });
          check('a key nobody knows is said, not pressed', !unknown.ok && /不认识的按键/.test(unknown.error), JSON.stringify(unknown).slice(0, 200));
          // with another tab of the browser in front: what goes by the picture brings its tab to the front first
          await js(`(() => { const s = window.__cwBrowser.state.getState(); const other = s.tabs.find((t) => !t.agent); document.querySelector('.bw .bw-tab[data-tab="' + other.id + '"]').click(); })()`);
          await sleep(300);
          const behindClick = await act({ action: 'left_click', coordinate: P(120, 70) });
          const frontNow = await js(`(() => { const s = window.__cwBrowser.state.getState(); return s.tabs.find((x) => x.id === s.active)?.agent || null; })()`);
          check('an action by position brings the Agent\'s tab to the front first (it goes by what is drawn)', behindClick.ok && frontNow === S && (await padNow()).clicks === p8.clicks + 1, JSON.stringify({ ok: behindClick.ok, frontNow, e: behindClick.error }));
        }
        // a page that never finishes loading (a picture that does not arrive) is read as it is, not waited for until the server gives up
        const tStuck = Date.now();
        const stuck = await op(S, 'open', { url: `${SITE}/results?q=slowimg` });
        check('a page that never stops loading is still read, once it has had its time', stuck.ok && /slowimg — result 1/.test(stuck.a.page.text) && /还在加载/.test(stuck.a.note || '') && Date.now() - tStuck < 28_000, `${Date.now() - tStuck} ms ${stuck.ok ? stuck.a.note : stuck.error}`);
        // back where the later checks expect this conversation's tab
        await op(S, 'open', { url: `${SITE}/long` });
      }

      // ---- the whole loop, the way an agent drives it
      phase = 'mcp';
      const dir = path.join(E.SMOKE_DATA, 'runtime', 'web-mcp');
      const tokenFile = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /\.token$/.test(n)).map((n) => path.join(dir, n))[0] : undefined;
      check('the server wrote the MCP processes\' secret file', !!tokenFile, dir);
      if (tokenFile) {
        const mcp = startMcp({ CW_WEB_URL: E.SMOKE_ORIGIN, CW_WEB_TOKEN_FILE: tokenFile, CW_SESSION_ID: 'smoke-mcp' });
        const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-smoke', version: '0' } });
        check('the web MCP server handshakes', init.result?.serverInfo?.name === 'claude-web-web', JSON.stringify(init.result?.serverInfo ?? init.error));
        const text = (r) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        const o = await mcp.call('browser_open', { url: `${SITE}/` });
        const ot = text(o);
        check('browser_open over MCP is carried out in this window\'s browser: the source, the text between the markers, the links', !o.isError && ot.includes(`来源：${SITE}/`) && /<<<WEB_CONTENT/.test(ot) && /Smoke Home/.test(ot) && /\[[a-z]{3}\d+\] link "Go to the form"/.test(ot), ot.slice(0, 300));
        const mine = (await tabs()).find((t) => t.agent === 'smoke-mcp');
        check('…in a tab of that conversation\'s Agent', !!mine && mine.url === `${SITE}/`, JSON.stringify(mine));
        const link = (/\[([a-z]{3}\d+)\] link "Go to the form"/.exec(ot) || [])[1];
        const c = await mcp.call('browser_click', { ref: link });
        const ct = text(c);
        check('browser_click over MCP follows the link and returns the form', !c.isError && /Sign up/.test(ct) && /已点击 \[[a-z]{3}\d+\]。页面换了地址/.test(ct) && ct.includes(`来源：${SITE}/form`), ct.slice(0, 300));
        const s = await mcp.call('browser_screenshot', {});
        const img = (s.content ?? []).find((x) => x.type === 'image');
        check('browser_screenshot over MCP returns an image block', !s.isError && !!img && /^image\//.test(img.mimeType) && img.data.length > 2000, s.isError ? text(s) : `${img?.mimeType} ${img?.data?.length}`);
        const gone = await mcp.call('browser_click', { ref: 'zzz9999' });
        check('a failure in the page is what the model reads', gone.isError === true && /不在页面上了/.test(text(gone)), text(gone).slice(0, 200));
        // a click by position, the way a model does it: a picture, a position read off it, the click
        const padOpen = await mcp.call('browser_open', { url: `${SITE}/pad` });
        const cs = await mcp.call('browser_computer', { action: 'screenshot' });
        const cimg = (cs.content ?? []).find((x) => x.type === 'image');
        const size = /截图是 (\d+)×(\d+) 像素/.exec(text(cs));
        check('browser_computer over MCP: a picture, and its size in words (positions go by it)', !padOpen.isError && !cs.isError && !!cimg && cimg.data.length > 2000 && !!size, text(cs).slice(0, 200));
        if (size) {
          const mcpTab = (await tabs()).find((t) => t.agent === 'smoke-mcp').id;
          const inPad = (code) => js(`document.querySelector('.bw-view[data-tab="${mcpTab}"] webview').executeJavaScript(${JSON.stringify(code)})`);
          const view = await inPad(`({ iw: innerWidth, ih: innerHeight })`);
          const at = [Math.round((120 * Number(size[1])) / view.iw), Math.round((70 * Number(size[2])) / view.ih)];
          const cc = await mcp.call('browser_computer', { action: 'left_click', coordinate: at });
          const clicks = await inPad(`window.__pad.clicks`);
          check('…and a left_click at a position read off that picture presses the button there', !cc.isError && clicks === 1 && /已点击。截图是 \d+×\d+ 像素/.test(text(cc)) && (cc.content ?? []).some((x) => x.type === 'image'), `${clicks} click(s) — ${text(cc).slice(0, 160)}`);
          const nowhere = await mcp.call('browser_computer', { action: 'left_click' });
          check('…a click with no position is refused before it reaches the page', nowhere.isError === true && /coordinate/.test(text(nowhere)) && (await inPad(`window.__pad.clicks`)) === 1, text(nowhere).slice(0, 160));
        }
        // a search, the whole way: MCP → the server → this window → a hidden page loads the engine's result page
        if (!E.SMOKE_REAL) {
          const ws1 = await mcp.call('web_search', { query: 'smoke chain' });
          check('web_search over MCP is done in this window\'s browser: the engine\'s result page is loaded in a hidden page and its list is the tool\'s result',
            !ws1.isError && text(ws1).includes('用 DuckDuckGo 搜索「smoke chain」') && text(ws1).includes('1. smoke chain — result 1\n   https://r1.example/smoke%20chain\n   About smoke chain, number 1.') && /<<<WEB_CONTENT search>>>/.test(text(ws1)), text(ws1).slice(0, 320));
          const ws2 = await mcp.call('web_search', { query: 'the wall' });
          check('…a challenge on the first engine: the next engine\'s page is read instead', !ws2.isError && text(ws2).includes('用 Bing 搜索「the wall」') && text(ws2).includes('1. the wall — result 1'), text(ws2).slice(0, 240));
          const three = await Promise.all(['pipes', 'streams', 'buffers'].map((q) => mcp.call('web_search', { query: `smoke ${q}`, count: 2 })));
          check('…three searches in one turn come back each with its own results', three.every((r, i) => !r.isError && text(r).includes(`1. smoke ${['pipes', 'streams', 'buffers'][i]} — result 1`) && !text(r).includes('3. ')), three.map((r) => text(r).slice(0, 60)).join(' | '));
          check('…and still no tab was opened for any search', (await tabs()).every((t) => !/results|ddg|bing/.test(t.url)), JSON.stringify((await tabs()).map((t) => t.url)));
        } else {
          for (const q of ['node.js stream backpressure', 'rust tokio select macro', '提示缓存 怎么用']) {
            const t0 = Date.now();
            const r = await mcp.call('web_search', { query: q, count: 5 }, 150_000);
            check(`REAL search engines, the whole chain: 「${q}」 has results`, !r.isError && /^用 .+ 搜索/.test(text(r)) && /\n1\. /.test(text(r)), `${Date.now() - t0} ms — ${text(r).replace(/\n/g, ' ⏎ ').slice(0, 380)}`);
          }
        }
        mcp.stop();
      }
      // the shell's own picture of a page (desktop/src/browser-capture.ts — what `desktop.captureGuest` runs): scaled, JPEG,
      // and only for a page this window hosts
      phase = 'capture';
      {
        const { webContents } = require('electron');
        const { captureGuest } = require(path.join(ROOT, 'desktop', 'dist', 'browser-capture.js'));
        // (the first conversation's tab is behind the MCP one by now: its picture brings it to the front)
        const behindShot = await op(S, 'screenshot');
        const frontNow = await js(`(() => { const s = window.__cwBrowser.state.getState(); return s.tabs.find((x) => x.id === s.active)?.agent; })()`);
        check('a picture of a tab that is not in front brings it to the front first (only what is drawn can be pictured)', behindShot.ok && (behindShot.a.image?.data?.length ?? 0) > 2000 && frontNow === S, behindShot.ok ? `${behindShot.a.image?.mime} front=${frontNow}` : behindShot.error);
        const gid = await js(`(() => { const s = window.__cwBrowser.state.getState(); const t = s.tabs.find((x) => x.agent === 'smoke-conv'); return document.querySelector('.bw-view[data-tab="' + t.id + '"] webview').getWebContentsId(); })()`);
        const mine = await captureGuest(wc, gid);
        check('the shell draws a page of this window as a JPEG, and says how large the picture is', !!mine && mine.mime === 'image/jpeg' && mine.data.length > 2000 && Buffer.from(mine.data, 'base64').subarray(0, 2).toString('hex') === 'ffd8' && mine.width > 100 && mine.width <= 1280 && mine.height > 100, mine ? `${mine.mime} ${mine.data.length} ${mine.width}x${mine.height}` : 'null');
        const stranger = new BrowserWindow({ show: false });
        check('…and refuses a page that the asking window does not host, or that does not exist', (await captureGuest(stranger.webContents, gid)) === null && (await captureGuest(wc, 999999)) === null && (await captureGuest(wc, 'x')) === null && !!webContents.fromId(gid));
        stranger.destroy();
      }
      // closing the Agent's tab: its next operation says there is no page
      phase = 'close';
      await js(`(() => { const s = window.__cwBrowser.state.getState(); const t = s.tabs.find((x) => x.agent === 'smoke-other'); const el = document.querySelector('.bw .bw-tab[data-tab="' + t.id + '"] .x'); el.click(); })()`);
      const closed = await op('smoke-other', 'read');
      check('a closed Agent tab is gone: its next read asks for browser_open', !closed.ok && /browser_open/.test(closed.error) && (await tabs()).every((t) => t.agent !== 'smoke-other'), JSON.stringify(closed));
    } catch (e) {
      check(`driver (${phase})`, false, String(e && e.stack || e));
    }
    clearTimeout(hardStop);
    finish(res.checks.every((c) => c.ok) && !res.console.length ? 0 : 1);
  });
}
