// Screenshots of the desktop opening (人设版开场与背景, docs/notes/opening.md), from the real app built from source.
//   npm run build:all && node scripts/opening-shots.mjs <scenario> [outDir]
// Scenarios: full short skip reduced reducedApp light classic ignite igniteLight never sound phone settings (list: no argument).
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
  // the app at phone width (device emulation + reload): the phone's start screen
  phone: { settings: {}, flags: { openingDay: today }, shots: ['app+2'], phone: [0.15, 0.5, 0.9, 1.3, 1.7] },
  // 设置 › 外观 › 开场和背景 (the cards load their posters from the server)
  settings: { settings: {}, flags: { openingDay: today }, shots: ['app+1'], open: { section: 'appearance', reveal: 'ui.opening.pack' } },
};
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
fs.writeFileSync(path.join(data, 'meta.json'), JSON.stringify({ version: 1, settings: { onboarded: true, 'ui.language': 'zh', ...sc.settings } }));
fs.writeFileSync(path.join(ud, 'window-state.json'), JSON.stringify({ v: 2, windows: { main: { x: 80, y: 60, width: 1280, height: 800 } } }));
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
  if (sc.clickAt !== undefined) timed.push({ at: sc.clickAt, act: async () => { await click(640, 450); note('click (skip)'); } });
  if (sc.clickSoundAt !== undefined) timed.push({ at: sc.clickSoundAt, act: async () => { await click(32, 768); note('click (sound)'); } });
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
    await send('Runtime.evaluate', { expression: `window.__store.getState().openSettings(${JSON.stringify(sc.open)})` });
    await sleep(2000);
    await shot('settings').catch((e) => note(`failed: ${e.message}`));
  }
  if (sc.prefsCheck) {
    await sleep(1500);
    const r = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__store.getState().settings["ui.opening.sound"])', returnByValue: true });
    note(`ui.opening.sound in the app = ${r.result.value}`);
  }
  const probe = await send('Runtime.evaluate', { expression: `JSON.stringify({ obd: document.documentElement.classList.contains('obd-on'), kind: document.querySelector('.obd')?.dataset.kind ?? null, side: getComputedStyle(document.documentElement).getPropertyValue('--obd-side'), video: (() => { const v = document.querySelector('.obd video'); return v ? { paused: v.paused, t: v.currentTime, rs: v.readyState } : null; })(), theme: document.documentElement.dataset.theme })`, returnByValue: true }).catch((e) => ({ result: { value: e.message } }));
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
