// Phone shell smoke (spec「测试」: 壳页面在 Electron 里打开界面 iframe), as a real run: the built shell (web/dist-shell),
// served at the root of a local static server, in a real Chromium (Electron: a real RTCPeerConnection, a real service
// worker), pairs with a throwaway server (temp HOME, remote access on a random port, a local test broker and no STUN
// server as its lists) through the QR link and runs the app in its frame:
//   · the link names the PC's own lists (not the defaults): the shell pairs and dials over them, with no override of
//     its own; the device record keeps them, and the reconnects after a reload use them (F2);
//   · paired and opened over a direct link: the app frame loads through the service worker;
//   · the app's WebSocket goes through the tunnel: sessions.list answers (the seeded conversation is in the store);
//   · an image (app/api/file) loads through the service worker and the link;
//   · opened again with ICE made to fail (a preload gives the page's RTCPeerConnection a relay-only policy and no TURN
//     server: no candidate at all), the shell falls back to the slow relay: the app opens from its cached files,
//     sessions.list answers, and the image's api/file is refused — the shell's bar shows the PC's 413 sentence;
//   · offline, the shell opens from its precache (each file checked against the sha256 table in sw.js); a shell file
//     rewritten in Cache Storage (what a tampered PC's app could do on this origin) is not served: the real one comes
//     from the network and the copy is dropped (F3);
//   · the localStorage override (cw.shell.brokers / cw.shell.stun) is said in the console, as an info line;
//   · any console error or warning in the shell page, the app frame or the service worker fails the run;
//   · nothing goes out: Electron's proxy and the server's are a recorder that must see no request, and every
//     RTCPeerConnection the page made had no ICE server.
// The shipped CSP only connects to wss: brokers; the static server adds ws://127.0.0.1:* for the test broker, and
// serves sw.js with the widened page's sha256 in place of the built one (the built files are not changed).
//
//   npm run build:all && node scripts/shell-smoke.cjs [--out <dir>] [--show] [--keep]
//
// Plain `node` runs the orchestration half, then Electron runs this same file (options in env vars, a result JSON
// file back: Electron prints nothing to a bash pipe on Windows), as scripts/ui-smoke.cjs does.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const SHELL_DIR = path.join(ROOT, 'web', 'dist-shell');
const RELAY_REFUSED = '慢速转发时不能预览 / 上传文件';
const RELAY_BAR = '直连没打通，已改用慢速转发';
const isElectronMain = !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE;
if (isElectronMain) driver();
else runner().catch((e) => { console.error(e.stack || e); process.exit(2); });

/* ------------------------------------------------------------------ orchestration (plain node) */

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 100) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };

/** A w×h PNG of one colour (the image the app frame loads through api/file). */
function png(w, h) {
  const zlib = require('node:zlib');
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [217, 119, 87]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** One finished Claude conversation in the temp HOME (Claude Code's transcript layout): sessions.list shows it. */
function seed(home, proj) {
  const sid = '5a0e0e0e-0000-4000-8000-0000000051e1';
  const dir = path.join(home, '.claude', 'projects', proj.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString();
  const base = { isSidechain: false, userType: 'external', cwd: proj, sessionId: sid, version: '2.1.281' };
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), [
    { ...base, parentUuid: null, type: 'user', message: { role: 'user', content: 'shell smoke: seeded conversation' }, uuid: '00000000-0000-4000-8000-0000000051e1', timestamp: t },
    { ...base, parentUuid: '00000000-0000-4000-8000-0000000051e1', type: 'assistant', message: { id: 'msg_shell', type: 'message', role: 'assistant', model: 'claude-smoke', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, uuid: '00000000-0000-4000-8000-0000000051e2', timestamp: t },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  return sid;
}

/**
 * dist-shell at the root of 127.0.0.1:<port>, its CSP widened for the ws:// test broker, and sw.js's hash of the page
 * swapped for the widened page's (else the worker would rightly refuse its cached copy); `/__smoke` is a blank page.
 */
async function shellServer() {
  const http = require('node:http');
  const { createHash } = require('node:crypto');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const index = fs.readFileSync(path.join(SHELL_DIR, 'index.html'), 'utf8');
  const CSP = "connect-src 'self' wss:;";
  if (!index.includes(CSP)) throw new Error(`web/dist-shell/index.html has no ${CSP} to widen (rebuild the shell?)`);
  const widened = index.replace(CSP, "connect-src 'self' wss: ws://127.0.0.1:*;");
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const swBuilt = fs.readFileSync(path.join(SHELL_DIR, 'sw.js'), 'utf8');
  if (!swBuilt.includes(sha(index))) throw new Error('web/dist-shell/sw.js has no sha256 of index.html (rebuild the shell?)');
  const swServed = swBuilt.split(sha(index)).join(sha(widened));
  const hits = [];
  const srv = http.createServer((q, s) => {
    const p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
    hits.push(p);
    if (p === '/__smoke') return void s.writeHead(200, { 'content-type': MIME['.html'] }).end('<!doctype html><title>shell smoke</title>');
    // what this server was asked for so far (the driver tells a load from the precache from one over the network)
    if (p === '/__hits') return void s.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(hits));
    if (p === '/' || p === '/index.html') return void s.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }).end(widened);
    if (p === '/sw.js') return void s.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' }).end(swServed);
    const f = path.join(SHELL_DIR, p);
    if (!f.startsWith(SHELL_DIR + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return void s.writeHead(404, { 'content-type': 'text/plain' }).end('not here');
    s.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(f).pipe(s);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}/`, hits };
}

async function runner() {
  const { spawn } = require('node:child_process');
  const http = require('node:http');
  const net = require('node:net');
  const { pathToFileURL } = require('node:url');
  const WebSocket = require('ws');
  if (!fs.existsSync(path.join(SHELL_DIR, 'sw.js'))) throw new Error('web/dist-shell is not built: npm run build:all');
  const out = path.resolve(String(arg('--out', path.join(os.tmpdir(), 'cw-shell-smoke'))));
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) if (/^(ux-.*\.png|shell-smoke\.json(\.log)?|server\.log)$/.test(f)) fs.rmSync(path.join(out, f), { force: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-shell-smoke-'));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  const sid = seed(home, proj);
  const image = path.join(root, 'smoke.png');
  fs.writeFileSync(image, png(3, 2));

  // the proxy of both the server and Electron: records anything that would go out, lets nothing through
  const outgoing = [];
  const recorder = http.createServer((q, s) => { outgoing.push(`${q.method} ${q.url}`); s.writeHead(502).end('shell smoke: nothing goes out'); });
  recorder.on('connect', (q, sock) => { outgoing.push(`CONNECT ${q.url}`); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  await new Promise((r) => recorder.listen(0, '127.0.0.1', r));
  const proxy = `127.0.0.1:${recorder.address().port}`;

  const { startBroker } = await import(pathToFileURL(path.join(ROOT, 'server', 'src', 'remote', 'anywhere', '__mocks__', 'mqtt-broker.mjs')).href);
  const broker = await startBroker();
  const brokers = [{ name: 'smoke', url: broker.url, relay: true }];
  const shell = await shellServer();

  const token = require('node:crypto').randomBytes(12).toString('hex');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1' };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_)/.test(k) || /^(no|http|https|all)_proxy$/i.test(k)) delete env[k];
  Object.assign(env, { HTTPS_PROXY: `http://${proxy}`, HTTP_PROXY: `http://${proxy}` });
  const logFile = path.join(out, 'server.log');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'dist', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let slog = '';
  const onData = (d) => { slog += d; fs.appendFileSync(logFile, d); };
  server.stderr.on('data', onData);
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${slog}`)), 60_000);
    server.stdout.on('data', (d) => { onData(d); const m = /listening on http:\/\/[^:]+:(\d+)/.exec(slog); if (m) { clearTimeout(t); res(m[1]); } });
    server.on('exit', (c) => rej(new Error(`server exited (${c})\n${slog}`)));
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type !== 'reply') return;
    const p = pending.get(m.reply.id);
    if (!p) return;
    pending.delete(m.reply.id);
    m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error));
  });
  const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  await req({ kind: 'settings.set', key: 'remote.anywhere.brokers', value: brokers });
  await req({ kind: 'settings.set', key: 'remote.anywhere.stun', value: [] });
  await req({ kind: 'remote.set', enabled: true, port: await freePort() });
  const on = await until(async () => { const a = (await req({ kind: 'remote.status' })).anywhere; return a?.on && a.brokers[0]?.ok ? a : null; }, 15_000);
  if (!on) throw new Error('在外面也能用 did not come up on the test broker');
  const pc = await req({ kind: 'remote.pairCode' });
  const hash = new URL(pc.anywhereUrl).hash;
  // the PC is not on the default lists: its link names them (the shell is given no override for the pairing)
  let qr = null;
  try { qr = JSON.parse(Buffer.from(hash.slice(3), 'base64url').toString('utf8')); } catch { /* checked below */ }
  const linkLists = { ok: JSON.stringify(qr?.b) === JSON.stringify(brokers) && JSON.stringify(qr?.st) === '[]', detail: JSON.stringify({ b: qr?.b, st: qr?.st }) };
  console.log(`server :${port}, broker ${broker.url}, shell ${shell.url} (HOME=${home})`);

  const result = path.join(out, 'shell-smoke.json');
  const code = await runElectron({
    SHELL_URL: shell.url,
    SHELL_PAIR: hash,
    SHELL_BROKERS: JSON.stringify(brokers),
    SHELL_IMAGE: image,
    SHELL_SID: sid,
    SHELL_PC: os.hostname(),
    SHELL_PROXY: proxy,
    SHELL_USERDATA: path.join(root, 'electron'),
    SHELL_OUT: out,
    SHELL_RESULT: result,
    SHELL_SHOW: arg('--show', false) ? '1' : '',
  }, 300_000);
  let r = null;
  try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { /* electron died */ }
  const checks = r ? r.checks : [];
  checks.unshift({ name: 'the QR link names the PC\'s own lists (its broker, no STUN server): they are not the defaults', ok: linkLists.ok, detail: linkLists.detail });
  // what the PC saw: one direct and one relay connection of the paired device
  const st = await req({ kind: 'remote.status' }).catch(() => null);
  const recent = st?.anywhere?.recent ?? [];
  const dev = st?.devices?.[0]?.id;
  const kinds = recent.filter((e) => e.ok && e.deviceId === dev).map((e) => e.kind);
  checks.push({ name: 'the PC saw the device come in directly and over the relay', ok: !!dev && kinds.some((k) => /^p2p-/.test(k)) && kinds.includes('relay'), detail: kinds.join(', ') });
  checks.push({ name: 'the shell came from the static server at its root (/, sw.js, assets)', ok: shell.hits.includes('/') && shell.hits.includes('/sw.js') && shell.hits.some((h) => h.startsWith('/assets/shell-')), detail: [...new Set(shell.hits)].slice(0, 8).join(' ') });
  checks.push({ name: 'nothing tried the public internet (the proxy of Electron and of the server saw no request)', ok: outgoing.length === 0, detail: outgoing.slice(0, 5).join(', ') });
  let failed = !r || code !== 0;
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    if (!c.ok) failed = true;
  }
  if (r) {
    const bad = r.console.filter((m) => !m.expected);
    console.log(`\nconsole errors/warnings: ${bad.length}${r.console.length !== bad.length ? ` (+${r.console.length - bad.length} expected: the refused image, the console probe)` : ''}`);
    for (const m of bad.slice(0, 40)) console.log(`  [${m.where}] ${m.level}: ${m.message}`);
    if (bad.length) failed = true;
    console.log(`screenshots: ${r.shots.length} in ${out} (driver: ${r.seconds} s)`);
  } else {
    console.log(`electron exited ${code} without a result (see ${result}.log)`);
  }
  if (failed) console.log(`\n--- server log (tail) ---\n${slog.split('\n').slice(-40).join('\n')}`);
  try { ws.close(); } catch { /* */ }
  server.kill();
  for (const s of [shell.srv, recorder]) { s.closeAllConnections?.(); s.close(); }
  await broker.close();
  await sleep(800);
  if (!arg('--keep', false)) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ } }
  console.log(failed ? '\nSHELL SMOKE FAILED' : '\nshell smoke passed');
  process.exit(failed ? 1 : 0);
}

function runElectron(env, timeoutMs) {
  const { spawn } = require('node:child_process');
  const electron = require(path.join(ROOT, 'node_modules', 'electron')); // the binary path when required from node
  const e = { ...process.env, ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  e.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'; // Electron's dev-only notices (contextIsolation off for the preload) are not the shell's
  return new Promise((res) => {
    const c = spawn(electron, [__filename], { env: e, stdio: 'ignore', windowsHide: false });
    const t = setTimeout(() => { c.kill(); res(-1); }, timeoutMs);
    c.on('exit', (code) => { clearTimeout(t); res(code); });
  });
}

/* ------------------------------------------------------------------ Electron half */

// Runs in the shell page before its scripts (contextIsolation off): records each RTCPeerConnection config, and with
// localStorage smoke.noDirect = 1 gives the page a relay-only policy with no TURN server, so ICE has no candidate.
const PRELOAD = `(() => {
  const Orig = window.RTCPeerConnection;
  if (typeof Orig !== 'function') return;
  const seen = (window.__smokeRtc = []);
  let noDirect = false;
  try { noDirect = localStorage.getItem('smoke.noDirect') === '1'; } catch { /* no storage here */ }
  window.__smokeNoDirect = noDirect;
  class Rtc extends Orig {
    constructor(cfg, ...rest) {
      seen.push(JSON.parse(JSON.stringify(cfg ?? null)));
      super(noDirect ? { ...(cfg || {}), iceTransportPolicy: 'relay' } : cfg, ...rest);
    }
  }
  window.RTCPeerConnection = Rtc;
})();
`;

function driver() {
  const { app, BrowserWindow, session } = require('electron');
  const E = process.env;
  app.setPath('userData', E.SHELL_USERDATA); // a fresh profile: service worker, caches, IndexedDB, localStorage
  // every request Chromium makes goes to the recorder, except loopback (Chromium's implicit bypass)
  app.commandLine.appendSwitch('proxy-server', `http://${E.SHELL_PROXY}`);
  const logFile = `${E.SHELL_RESULT}.log`;
  const log = (s) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`); } catch { /* ignore */ } };
  try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
  const res = { checks: [], console: [], infos: [], shots: [], startedAt: Date.now(), seconds: 0 };
  let expect413 = false;
  let expectProbe = false;
  const check = (name, ok, detail) => { res.checks.push({ name, ok: !!ok, detail: detail || undefined }); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`); };
  const finish = (code) => { res.seconds = Math.round((Date.now() - res.startedAt) / 1000); try { fs.writeFileSync(E.SHELL_RESULT, JSON.stringify(res, null, 2)); } catch { /* ignore */ } app.exit(code); };
  process.on('uncaughtException', (e) => { log(`uncaught ${e.stack || e}`); check('driver', false, String(e.message || e)); finish(3); });
  const hardStop = setTimeout(() => { check('driver finished in time', false); finish(6); }, 270_000);
  const record = (where, level, message) => {
    const m = String(message);
    const expected = (expect413 && /status of 413/.test(m)) || (expectProbe && m.includes('shell-smoke console probe'));
    res.console.push({ where, level: String(level), message: m.slice(0, 800), expected: expected || undefined });
    log(`console [${where}] ${level}: ${m.slice(0, 300)}`);
  };

  app.whenReady().then(async () => {
    const show = E.SHELL_SHOW === '1';
    const preload = path.join(E.SHELL_USERDATA, 'smoke-preload.js');
    fs.writeFileSync(preload, PRELOAD);
    session.defaultSession.serviceWorkers.on('console-message', (_e, d) => {
      if (Number(d.level) >= 2) record('service worker', d.level === 3 ? 'error' : 'warning', d.message);
    });
    // a phone's size: the shell and the app's mobile layout
    const win = new BrowserWindow({ width: 420, height: 860, show, webPreferences: { offscreen: !show, backgroundThrottling: false, preload, contextIsolation: false, sandbox: false } });
    if (show) win.showInactive();
    const wc = win.webContents;
    wc.on('console-message', (a, b, c) => {
      const level = typeof a === 'object' && a && 'level' in a ? a.level : b;
      const message = typeof a === 'object' && a && 'message' in a ? a.message : c;
      // a label only: Electron's event names the main frame for a same-origin child frame, the script URL tells them apart
      let url = '';
      try { url = (typeof a === 'object' && a && (a.sourceId || (a.frame && a.frame.url))) || ''; } catch { /* the frame is gone */ }
      const where = url.includes('/app/') ? 'app frame' : 'shell page';
      if (level === 'error' || level === 'warning' || Number(level) >= 2) record(where, level, message);
      else if (String(message).includes('[shell] ')) res.infos.push(String(message).slice(0, 300));
    });
    wc.on('render-process-gone', (_e, d) => check('renderer alive', false, d.reason));
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => { if (isMain) check('page load', false, `${code} ${desc} ${url}`); });
    const js = (code) => wc.executeJavaScript(code, true);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (code, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await js(code).catch(() => null); if (v) return v; await sleep(200); } return null; };
    const shot = async (name) => { try { const img = await wc.capturePage(); const f = path.join(E.SHELL_OUT, `ux-shell-${name}.png`); fs.writeFileSync(f, img.toPNG()); res.shots.push(f); } catch (e) { log(`shot ${name}: ${e.message}`); } };
    const S = JSON.stringify;
    const FRAME = `document.querySelector('iframe.frame')`;
    const appWin = `(${FRAME} && ${FRAME}.contentWindow)`;
    const barText = `(document.querySelector('.bar:not([hidden])')?.textContent ?? '')`;
    /** The app in the frame: its store, connected (its WebSocket open through the tunnel). */
    const appUp = `(() => { const w = ${appWin}; const s = w && w.__store && w.__store.getState(); return !!(s && s.connected); })()`;
    const hasSeeded = `(() => { const w = ${appWin}; const s = w && w.__store && w.__store.getState(); return !!(s && Array.isArray(s.sessions) && s.sessions.some((x) => x.sessionId === ${S(E.SHELL_SID)})); })()`;
    /** An <img> on api/file in the app frame, relative to app/index.html (as the app's appUrl() writes it): w×h, or the error. */
    const loadImage = `new Promise((res) => {
      const w = ${appWin};
      const img = w.document.createElement('img');
      img.onload = () => res({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => res({ ok: false });
      img.src = 'api/file?path=' + encodeURIComponent(${S(E.SHELL_IMAGE)});
      w.document.body.append(img);
      setTimeout(() => res({ ok: false, timeout: true }), 60000);
    })`;
    const rtcConfigs = `(window.__smokeRtc || []).map((c) => (c && c.iceServers ? c.iceServers.length : 0))`;

    try {
      // ---- pair through the QR link, open the app over a direct link: no override, the link's own lists only ----
      await win.loadURL(`${E.SHELL_URL}__smoke`);
      check('the shell origin starts with no localStorage override', await js(`localStorage.getItem('cw.shell.brokers') === null && localStorage.getItem('cw.shell.stun') === null`));
      await win.loadURL(`${E.SHELL_URL}${E.SHELL_PAIR}`);
      const opened = await waitFor(appUp, 90_000);
      check('the QR link pairs (over the brokers it names) and the app frame opens, its WebSocket open through the tunnel', opened, opened ? '' : await js(`document.querySelector('main.page')?.innerText ?? ''`).catch(() => ''));
      if (!opened) { await shot('pair-failed'); return finish(1); }
      check('the pairing link is cleared from the address', (await js('location.hash')) === '');
      check('no override was in use (no info line about one)', !res.infos.some((m) => m.includes('自定义列表')), res.infos.join(' | '));
      const rec = await js(`new Promise((res) => { const q = indexedDB.open('cw-shell'); q.onsuccess = () => { const g = q.result.transaction('devices').objectStore('devices').getAll(); g.onsuccess = () => res(g.result.map((d) => ({ brokers: d.brokers, stun: d.stun }))); g.onerror = () => res(null); }; q.onerror = () => res(null); })`);
      check('the device record keeps the PC\'s lists from the link', JSON.stringify(rec) === JSON.stringify([{ brokers: JSON.parse(E.SHELL_BROKERS), stun: [] }]), JSON.stringify(rec));
      const ctl = await js(`!!(${appWin}.navigator.serviceWorker && ${appWin}.navigator.serviceWorker.controller)`);
      check('the app frame is served by the shell\'s service worker', ctl);
      check('a direct link: no slow-relay bar', !(await js(barText)).includes(RELAY_BAR), await js(barText));
      // the app frame's console is watched too (a message logged there, by its own script, must reach the check)
      expectProbe = true;
      const appFrame = wc.mainFrame.frames.find((f) => f.url.includes('/app/'));
      await appFrame.executeJavaScript(`console.warn('shell-smoke console probe'); true`);
      await sleep(300);
      expectProbe = false;
      check('the app frame\'s console is watched (a warning logged by the frame itself is caught)', res.console.some((m) => m.message.includes('shell-smoke console probe')));
      check('sessions.list over the tunnel: the seeded conversation is in the app', await waitFor(hasSeeded, 20_000));
      const im = await js(loadImage);
      check('an image through app/api/file loads over the link (3×2)', im.ok && im.w === 3 && im.h === 2, JSON.stringify(im));
      const cfg1 = await js(rtcConfigs);
      check('the direct dial used no ICE server (the link\'s STUN list is empty)', cfg1.length >= 1 && cfg1.every((n) => n === 0), JSON.stringify(cfg1));
      await shot('direct');

      // ---- open it again with ICE failing: the slow relay ----
      await js(`localStorage.setItem('smoke.noDirect', '1'); true`);
      await win.loadURL(E.SHELL_URL);
      const listed = await waitFor(`[...document.querySelectorAll('button.device .pc')].map((e) => e.textContent).join('|') || null`, 15_000);
      check('the shell lists the paired PC', listed && listed.split('|').includes(E.SHELL_PC), String(listed));
      check('… and the page sees ICE made to fail', await js('window.__smokeNoDirect === true'));
      await js(`document.querySelector('button.device').click(); true`);
      const relayed = await waitFor(`${appUp} && ${barText}.includes(${S(RELAY_BAR)})`, 120_000);
      check('ICE fails, the shell falls back to the slow relay and opens the app (the bar says so)', relayed, await js(barText).catch(() => ''));
      if (!relayed) { await shot('relay-failed'); return finish(1); }
      check('sessions.list over the relay: the seeded conversation is in the app', await waitFor(hasSeeded, 30_000));
      expect413 = true;
      const im2 = await js(loadImage);
      const said = await waitFor(`${barText}.includes(${S(RELAY_REFUSED)}) && ${barText}`, 15_000);
      expect413 = false;
      check('over the relay the image is refused and the shell\'s bar shows the 413 sentence', !im2.ok && !!said, `${JSON.stringify(im2)} ${said || (await js(barText))}`);
      const cfg2 = await js(rtcConfigs);
      check('the relay dial\'s attempt used no ICE server either (the record\'s STUN list)', cfg2.every((n) => n === 0), JSON.stringify(cfg2));
      await shot('relay');

      // ---- offline: the shell from its precache, every file checked against the hashes in sw.js (F3) ----
      await js(`localStorage.removeItem('smoke.noDirect'); true`);
      const hitsNow = () => js(`fetch('/__hits', { cache: 'no-store' }).then((r) => r.json())`);
      const before = (await hitsNow()).length;
      wc.session.enableNetworkEmulation({ offline: true });
      await win.loadURL(E.SHELL_URL);
      const offline = await waitFor(`[...document.querySelectorAll('button.device .pc')].map((e) => e.textContent).join('|') || null`, 15_000);
      wc.session.disableNetworkEmulation();
      // nothing of that load reached the static server: the page and its files came from the cache, and they matched
      const during = (await hitsNow()).slice(before).filter((h) => h !== '/__hits');
      check('offline, the shell opens from its precache (its files match the sha256 table in sw.js), none of it from the server', offline && offline.split('|').includes(E.SHELL_PC) && during.length === 0, `${offline} · asked meanwhile: ${JSON.stringify(during)}`);
      const beforeTamper = (await hitsNow()).length;

      // ---- a shell file rewritten in Cache Storage (any script on this origin can): not served, dropped (F3) ----
      const tamper = await js(`(async () => {
        const name = (await caches.keys()).find((k) => k.startsWith('cw-shell-'));
        if (!name) return null;
        const c = await caches.open(name);
        const url = (await c.keys()).map((r) => r.url).find((u) => /\\/assets\\/shell-[^/]+\\.js$/.test(u));
        if (!url) return null;
        await c.put(url, new Response('window.__smokeTampered = true;', { headers: { 'content-type': 'text/javascript' } }));
        return { name, url };
      })()`);
      await win.loadURL(E.SHELL_URL);
      const listedAgain = await waitFor(`[...document.querySelectorAll('button.device .pc')].map((e) => e.textContent).join('|') || null`, 15_000);
      const ran = await js('window.__smokeTampered === true');
      const kept = tamper ? await js(`(async () => { const r = await (await caches.open(${S(tamper.name)})).match(${S(tamper.url)}); return r ? (await r.text()).includes('__smokeTampered') : false; })()`) : null;
      // …and the real one came from the network (the static server was asked for it)
      const refetched = tamper ? (await hitsNow()).slice(beforeTamper).includes(new URL(tamper.url).pathname) : false;
      check('a shell file rewritten in Cache Storage is not served: the page runs the real one from the network and the copy is dropped', !!tamper && !!listedAgain && !ran && kept === false && refetched, JSON.stringify({ tamper, listedAgain, ran, kept, refetched }));

      // ---- the localStorage override: said in the console as an info line (not a warning) ----
      await js(`localStorage.setItem('cw.shell.brokers', ${S(E.SHELL_BROKERS)}); localStorage.setItem('cw.shell.stun', '[]'); true`);
      await win.loadURL(E.SHELL_URL);
      await waitFor(`!!document.querySelector('button.device')`, 15_000);
      const OVERRIDE_INFO = '[shell] 使用 localStorage 里的自定义列表：cw.shell.brokers（1 个）、cw.shell.stun（0 个）';
      check('with an override set, the shell says so in its console (info, not a warning)', res.infos.includes(OVERRIDE_INFO), res.infos.join(' | ') || '(no info line)');
      clearTimeout(hardStop);
      finish(0);
    } catch (e) {
      log(`driver error ${e.stack || e}`);
      check('driver ran to the end', false, String(e.message || e));
      await shot('error');
      finish(4);
    }
  });
}
