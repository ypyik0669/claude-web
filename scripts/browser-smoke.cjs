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
//   · the whole loop the way an agent drives it: the `web` MCP process (server/dist/web/mcp.js, JSON-RPC over stdio)
//     → POST /api/web/tool → the server → this window (browser.command) → the page → browser.result → the tool's
//     result. No model, no token; nothing leaves the machine.
//   · any console error or warning of the app fails the run.
//
//   npm run build:all && node scripts/browser-smoke.cjs [--out <dir>] [--show] [--keep]
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
    s.writeHead(404, { 'content-type': 'text/plain' });
    s.end('not here');
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function startServer(home, out) {
  const { spawn } = require('node:child_process');
  const token = require('node:crypto').randomBytes(12).toString('hex');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1' };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(k) || /^(no|http|https|all)_proxy$/i.test(k) || k === 'CW_WEB_TOKEN' || k === 'CW_WEB_TOKEN_FILE') delete env[k];
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
  const srv = await startServer(home, out);
  console.log(`server up (HOME=${home}), site ${site.url}`);
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
  }, 240_000);
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
  const hardStop = setTimeout(() => { check('driver finished in time', false, phase); finish(6); }, 200_000);

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
      call: async (name, args = {}) => { const r = await wait(send('tools/call', { name, arguments: args })); return r.result ?? { isError: true, content: [{ type: 'text', text: `rpc error: ${r.error?.message}` }] }; },
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
        check('the shell draws a page of this window as a JPEG', !!mine && mine.mime === 'image/jpeg' && mine.data.length > 2000 && Buffer.from(mine.data, 'base64').subarray(0, 2).toString('hex') === 'ffd8', mine ? `${mine.mime} ${mine.data.length}` : 'null');
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
