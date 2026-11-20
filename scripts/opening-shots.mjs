// Screenshots of the desktop opening (人设版开场与背景, docs/notes/opening.md), from the real app built from source.
//   npm run build:all && node scripts/opening-shots.mjs <scenario> [outDir]
// Scenarios: full short skip reduced reducedApp light classic ignite igniteLight never sound phone settings, and the
// second batch's stars* ascii* cafe* web* cards* (list: no argument). The window is 1440 × 900.
// Every run gets its own temp HOME / CLAUDE_WEB_DIR / --user-data-dir: nothing of ~/.claude-web or the installed app is
// touched. Shot names: <scenario>-t<s>.png (seconds after the opening page appeared), <scenario>-app<N>.png (N s after
// the app page took over); <scenario>.log has the timings, main.log's opening lines, flags.json and console errors.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

/** t: seconds after the opening page appeared; 'app+N': N s after the app page took over */
const SCENARIOS = {
  full: { settings: {}, shots: [1.2, 3.5, 6.5, 9.0, 9.95, 10.4, 10.9, 11.6, 12.3, 13.0, 13.6, 14.2, 'app+0.3', 'app+3'] },
  short: { settings: { 'ui.opening.length': 'short' }, shots: [0.8, 2.0, 3.2, 3.7, 4.4, 5.4, 'app+0.3', 'app+3'] },
  skip: { settings: {}, clickAt: 3.0, shots: [2.6, 3.25, 3.6, 'app+0.3', 'app+3'] },
  reduced: { settings: {}, args: ['--force-prefers-reduced-motion'], shots: [0.5, 1.5, 'app+0.3', 'app+3'] },
  reducedApp: { settings: { 'ui.reduceMotion': true }, shots: [0.5, 'app+0.3', 'app+3'] },
  light: { settings: { 'ui.theme': 'light' }, shots: [3.0, 10.4, 11.2, 12.0, 12.4, 12.65, 12.9, 'app+0.3', 'app+3'] },
  classic: { settings: {}, flags: { openingDay: today }, shots: [0.25, 0.7, 1.3, 'app+3'] },
  ignite: { settings: { 'ui.opening.pack': 'ignite' }, shots: [0.5, 1.0, 1.6, 2.1, 2.6, 3.4, 'app+0.3', 'app+3'] },
  igniteLight: { settings: { 'ui.opening.pack': 'ignite', 'ui.theme': 'light' }, shots: [0.6, 1.7, 2.2, 3.4, 'app+3'] },
  never: { settings: { 'ui.opening.when': 'never' }, shots: [0.3, 'app+3'] },
  // the speaker (bottom-left) at 2 s: the app takes the setting over once it is in
  sound: { settings: {}, clickSoundAt: 2.0, clickAt: 4.0, shots: [2.4, 'app+3'], prefsCheck: true },
  // the app at phone width (device emulation + reload): the phone's opening (phone-opening.ts, 2.9 s after the settings)
  phone: { settings: {}, flags: { openingDay: today }, shots: ['app+2'], phone: [0.3, 0.9, 1.5, 2.1, 2.7, 3.2, 3.6] },
  // 设置 › 外观 › 开场和背景 (the cards load their posters from the server)
  settings: { settings: {}, flags: { openingDay: today }, shots: ['app+1'], open: { section: 'appearance', reveal: 'ui.opening.pack' } },
  // ---- 开场 第二批 (docs/notes/opening.md): 星图 / 字符雨 (drawn, like 点火) and what they leave behind (app+3)
  stars: { settings: { 'ui.opening.pack': 'stars', 'ui.theme': 'dark' }, shots: [0.3, 0.8, 1.3, 1.8, 2.3, 2.9, 3.5, 4.0, 'app+0.3', 'app+3'] },
  starsShort: { settings: { 'ui.opening.pack': 'stars', 'ui.opening.length': 'short', 'ui.theme': 'dark' }, shots: [0.3, 0.7, 1.1, 1.5, 1.9, 'app+0.3'] },
  starsLight: { settings: { 'ui.opening.pack': 'stars', 'ui.theme': 'light' }, shots: [0.8, 1.8, 2.9, 3.6, 'app+0.3', 'app+3'] },
  starsReduced: { settings: { 'ui.opening.pack': 'stars', 'ui.theme': 'dark' }, args: ['--force-prefers-reduced-motion'], shots: [0.5, 1.5, 'app+0.3'] },
  ascii: { settings: { 'ui.opening.pack': 'ascii', 'ui.theme': 'dark' }, shots: [0.3, 0.8, 1.3, 1.8, 2.3, 2.9, 3.5, 4.0, 'app+0.3', 'app+3'] },
  asciiShort: { settings: { 'ui.opening.pack': 'ascii', 'ui.opening.length': 'short', 'ui.theme': 'dark' }, shots: [0.3, 0.7, 1.1, 1.5, 1.9, 'app+0.3'] },
  asciiLight: { settings: { 'ui.opening.pack': 'ascii', 'ui.theme': 'light' }, shots: [0.8, 1.8, 2.9, 3.6, 'app+0.3', 'app+3'] },
  // 网吧开门: the 3D cafe (its script from the shell's own scheme); without WebGL it plays 点火
  cafe: { settings: { 'ui.opening.pack': 'cafe', 'ui.theme': 'dark' }, shots: [0.4, 0.9, 1.4, 1.9, 2.4, 3.0, 3.6, 4.2, 4.8, 'app+0.3', 'app+3'] },
  cafeShort: { settings: { 'ui.opening.pack': 'cafe', 'ui.opening.length': 'short', 'ui.theme': 'dark' }, shots: [0.4, 0.8, 1.2, 1.7, 2.2, 'app+0.3'] },
  cafeLight: { settings: { 'ui.opening.pack': 'cafe', 'ui.theme': 'light' }, shots: [1.4, 3.0, 4.2, 'app+0.3', 'app+3'] },
  // (--disable-webgl alone does not reach the renderer here; no GPU and no software rasterizer leaves no WebGL at all)
  cafeNoWebgl: { settings: { 'ui.opening.pack': 'cafe', 'ui.theme': 'dark' }, args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-webgl', '--disable-3d-apis'], shots: [0.4, 1.0, 1.8, 2.6, 'app+0.3'] },
  // a web pack: the opening-pack skill's example (萤火, says done), and one that never does (cut at its 3 s → 点火)
  web: { settings: { 'ui.opening.pack': 'glow', 'ui.theme': 'dark' }, packs: ['glow'], shots: [0.4, 1.0, 1.6, 2.4, 3.2, 4.0, 4.8, 5.6, 'app+0.3', 'app+3'] },
  webLight: { settings: { 'ui.opening.pack': 'glow', 'ui.theme': 'light' }, packs: ['glow'], shots: [1.0, 2.4, 4.0, 5.2, 'app+0.3'] },
  webCut: { settings: { 'ui.opening.pack': 'stuck', 'ui.theme': 'dark' }, packs: ['stuck'], shots: [1.0, 2.6, 3.2, 3.8, 4.6, 5.6, 'app+0.3'] },
  // the cards (dark / light), the pointer resting on a card (its little preview), and at phone width
  cardsDark: { settings: { 'ui.theme': 'dark' }, packs: ['glow'], flags: { openingDay: today }, shots: ['app+1'], open: { reveal: 'ui.opening.pack' }, hover: ['stars', 'ascii', 'cafe', 'glow'] },
  cardsLight: { settings: { 'ui.theme': 'light' }, packs: ['glow'], flags: { openingDay: today }, shots: ['app+1'], open: { reveal: 'ui.opening.pack' }, hover: ['stars', 'cafe'] },
  cardsPhone: { settings: { 'ui.theme': 'dark' }, packs: ['glow'], flags: { openingDay: today }, shots: ['app+1'], phoneOpen: { reveal: 'ui.opening.pack' } },
  cardsPhoneLight: { settings: { 'ui.theme': 'light' }, packs: ['glow'], flags: { openingDay: today }, shots: ['app+1'], phoneOpen: { reveal: 'ui.opening.pack' } },
};

/** Web packs put in the temp data dir's openings folder (as 从文件夹导入 leaves them). */
const PACKS = {
  glow: { json: { name: '萤火', kind: 'web', author: 'Claude Web', license: 'MIT', maxSeconds: 8 }, html: () => fs.readFileSync(path.join(ROOT, 'server/src/openings/example/index.html'), 'utf8') },
  // draws a slow gradient and never calls done(): cut at 3 s, then 点火
  stuck: {
    json: { name: '不会停的', kind: 'web', author: 'test', license: 'CC0-1.0', maxSeconds: 3 },
    html: () => '<!doctype html><canvas id="c"></canvas><script>const c=document.getElementById("c"),g=c.getContext("2d");function f(t){c.width=innerWidth;c.height=innerHeight;const h=(t/20)%360;g.fillStyle="hsl("+h+",60%,22%)";g.fillRect(0,0,c.width,c.height);g.fillStyle="#fff";g.font="28px sans-serif";g.fillText("never says done · "+(t/1000).toFixed(1)+" s",40,60);requestAnimationFrame(f)}requestAnimationFrame(f)</script>',
  },
};
/** The window's size (content): the redesign's screenshots are 1440 × 900. */
const W = 1440, H = 900;
const [scenario, outArg, portArg] = process.argv.slice(2);
const sc = SCENARIOS[scenario];
if (!sc) { console.error(`node scripts/opening-shots.mjs <${Object.keys(SCENARIOS).join('|')}> [outDir]`); process.exit(2); }
const outDir = path.resolve(outArg ?? path.join(os.tmpdir(), 'cw-opening-shots'));
const PORT = Number(portArg ?? 9400 + Math.floor(Math.random() * 400));

const base = fs.mkdtempSync(path.join(os.tmpdir(), `cw-op-${scenario}-`));
const home = path.join(base, 'home');
const data = path.join(base, 'data');
const ud = path.join(base, 'ud');
for (const d of [home, data, ud]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(data, 'meta.json'), JSON.stringify({ version: 1, settings: { onboarded: true, 'ui.language': 'zh', 'ui.opening.sound': false, ...sc.settings } }));
fs.writeFileSync(path.join(ud, 'window-state.json'), JSON.stringify({ v: 2, windows: { main: { x: 40, y: 30, width: W, height: H } } }));
for (const id of sc.packs ?? []) {
  const dir = path.join(data, 'openings', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opening.json'), JSON.stringify(PACKS[id].json, null, 2));
  fs.writeFileSync(path.join(dir, 'index.html'), PACKS[id].html());
}
if (sc.flags) fs.writeFileSync(path.join(ud, 'flags.json'), JSON.stringify(sc.flags));
fs.mkdirSync(outDir, { recursive: true });

// the dev shell's CLAUDE_* / ANTHROPIC_* / ELECTRON_RUN_AS_NODE would point the app at the installed one's files
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|ELECTRON_RUN_AS_NODE)/.test(k)));
Object.assign(env, { CLAUDE_WEB_DIR: data, USERPROFILE: home, HOME: home });
const t0 = Date.now();
const child = spawn(ELECTRON, [ROOT, `--user-data-dir=${ud}`, `--remote-debugging-port=${PORT}`, ...(sc.args ?? [])], { env, stdio: 'ignore', windowsHide: false });
const log = [];
const note = (s) => { const line = `${((Date.now() - t0) / 1000).toFixed(2)}s ${s}`; log.push(line); console.log(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 300; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && (t.url.startsWith('data:') || t.url.startsWith('http://127.0.0.1')));
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(50);
  }
  throw new Error('no page target');
}

let ws, seq = 0;
const pending = new Map();
const events = [];
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} timed out`)); } }, 15000); });
}

let pageAt = 0, appAt = 0;
try {
  const t = await target();
  pageAt = Date.now();
  note(`page ${t.url.slice(0, 40)}`);
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); return; }
    // the same target goes on from the opening page to the app page
    if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) {
      const url = msg.params.frame.url;
      if (url.startsWith('http://127.0.0.1') && !appAt) { appAt = Date.now(); note(`app page ${url.replace(/token=[^&]+/, 'token=…')}`); }
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) events.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
    if (msg.method === 'Runtime.exceptionThrown') events.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`.slice(0, 400));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') events.push(`log.error: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`.slice(0, 300));
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  const shot = async (label) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(outDir, `${scenario}-${label}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    note(`shot ${path.basename(f)}`);
  };
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const timed = sc.shots.filter((s) => typeof s === 'number').map((s) => ({ at: s, act: () => shot(`t${s.toFixed(2)}`) }));
  if (sc.clickAt !== undefined) timed.push({ at: sc.clickAt, act: async () => { await click(W / 2, H / 2); note('click (skip)'); } });
  if (sc.clickSoundAt !== undefined) timed.push({ at: sc.clickSoundAt, act: async () => { await click(32, H - 32); note('click (sound)'); } });
  timed.sort((a, b) => a.at - b.at);
  for (const s of timed) {
    const wait = pageAt + s.at * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    if (appAt) note(`(app already in at ${s.at}s)`);
    await s.act().catch((e) => note(`failed: ${e.message}`));
  }
  for (let i = 0; i < 600 && !appAt; i++) await sleep(100);
  if (!appAt) note('app never came');
  for (const s of sc.shots.filter((x) => typeof x === 'string')) {
    const n = Number(s.slice(4));
    const wait = appAt + n * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    await shot(`app${n}`).catch((e) => note(`failed: ${e.message}`));
  }
  if (sc.phone) {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const at = Date.now();
    await send('Page.reload', { ignoreCache: false });
    note('reloaded at phone width');
    for (const s of sc.phone) {
      const wait = at + s * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      await shot(`phone-t${s.toFixed(2)}`).catch((e) => note(`failed: ${e.message}`));
    }
  }
  if (sc.open) {
    // (the window opens under the real pointer: move it off the page, and the first-run toasts away)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 6, y: H - 6 });
    await send('Runtime.evaluate', { expression: `window.__store.getState().openSettings(${JSON.stringify(sc.open)})` });
    await sleep(2000);
    await send('Runtime.evaluate', { expression: 'window.__store.setState({ toasts: [] })' });
    await sleep(300);
    await shot('settings').catch((e) => note(`failed: ${e.message}`));
  }
  // the pointer resting on a card: its little preview (CardPreview.tsx) after a moment
  for (const id of sc.hover ?? []) {
    const r = await send('Runtime.evaluate', { expression: `(() => { const e = document.querySelector('.op-cards [data-opening="${id}"]'); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 3) }); })()`, returnByValue: true });
    if (!r.result.value) { note(`no card ${id}`); continue; }
    const p = JSON.parse(r.result.value);
    await sleep(300);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await sleep(id === 'cafe' ? 2600 : 1600);
    await shot(`hover-${id}`).catch((e) => note(`failed: ${e.message}`));
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 6, y: H - 6 });
    await sleep(400);
  }
  // 设置 at phone width (device emulation + reload, then the page)
  if (sc.phoneOpen) {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Page.reload', { ignoreCache: false });
    note('reloaded at phone width');
    await sleep(3500);
    await send('Runtime.evaluate', { expression: `window.__store.getState().openSettings(${JSON.stringify(sc.phoneOpen)})` });
    await sleep(2200);
    await send('Runtime.evaluate', { expression: 'window.__store.setState({ toasts: [] })' });
    await sleep(300);
    await shot('phone-settings').catch((e) => note(`failed: ${e.message}`));
    await send('Runtime.evaluate', { expression: `document.querySelector('.opening-packs')?.scrollIntoView({ block: 'center' })` });
    await sleep(600);
    await shot('phone-settings-packs').catch((e) => note(`failed: ${e.message}`));
  }
  if (sc.prefsCheck) {
    await sleep(1500);
    const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__store.getState().settings["ui.opening.sound"])', returnByValue: true });
    note(`ui.opening.sound in the app = ${r.result.value}`);
  }
  const probe = await send('Runtime.evaluate', { expression: `JSON.stringify({ desktop: !!window.desktop, obd: document.documentElement.classList.contains('obd-on'), kind: document.querySelector('.obd')?.dataset.kind ?? null, side: getComputedStyle(document.documentElement).getPropertyValue('--obd-side'), video: (() => { const v = document.querySelector('.obd video'); return v ? { paused: v.paused, t: v.currentTime, rs: v.readyState } : null; })(), theme: document.documentElement.dataset.theme })`, returnByValue: true }).catch((e) => ({ result: { value: e.message } }));
  note(`app state ${probe.result.value}`);
} catch (e) {
  note(`error ${e.stack ?? e}`);
} finally {
  const mainLog = path.join(ud, 'main.log');
  if (fs.existsSync(mainLog)) note(`main.log: ${fs.readFileSync(mainLog, 'utf8').trim().split('\n').filter((l) => /opening|error|uncaught/i.test(l)).slice(-6).join(' | ')}`);
  const flags = path.join(ud, 'flags.json');
  if (fs.existsSync(flags)) note(`flags.json: ${fs.readFileSync(flags, 'utf8')}`);
  if (events.length) note(`console: ${events.length}\n  ${events.slice(0, 20).join('\n  ')}`);
  fs.writeFileSync(path.join(outDir, `${scenario}.log`), log.join('\n'));
  try { ws?.close(); } catch { /* */ }
  // the whole tree (the server is Electron's utility process): nothing of this run is left running
  if (process.platform === 'win32') await new Promise((r) => { const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); k.on('exit', r); k.on('error', r); });
  else child.kill('SIGKILL');
  await sleep(800);
  console.log(`shots in ${outDir} · temp dirs ${base}`);
  process.exit(0);
}
