// The site's theme showcase recordings (docs/superpowers/specs/2026-10-21-website-design.md §5.2): the real app, one
// clip per built-in character theme with the same scripted actions (12 s), and one "describe a new theme" (15 s),
// in English and Chinese. Nothing real is spent: a throwaway HOME, the demo repo and a fake upstream that replays the
// same turn every time (scripts/lib/demo.cjs). Electron renders offscreen at 1280×800 ×2; every painted frame is kept
// with its time, and ffmpeg resamples them to a constant 30 fps, so frame n is the same moment in every clip.
//   env -u ELECTRON_RUN_AS_NODE -u CLAUDE_WEB_DIST node scripts/record-themes.cjs [--lang en|zh] [--only phosphor,describe] [--out <dir>] [--keep-frames]
// Before recording, the connectors the app reports and the
// page's text are checked: only the app's own servers, none failing, nothing of this machine (home folder, user name).
// Manual (not in CI). It never touches web/dist: the web app is built into a temp folder and the server runs from source.
// Debugging the timing: CW_DEMO_UPSTREAM_LOG=1 prints when each scripted step was asked for (the describe clip also logs
// when Enter was pressed); REC_WAIT=<ms> waits longer than 14 s for the apply card; --keep-frames keeps the frames, also
// when the script fails.
// Then: node scripts/upload-site-media.cjs --dir <out> (only when the person in charge says so).
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const demo = require('./lib/demo.cjs');

const THEMES = ['phosphor', 'abyss', 'koi', 'moon', 'dither', 'orb', 'garden', 'paper', 'letters', 'ink'];
const CLIPS = [...THEMES.map((id) => ({ id, theme: id, seconds: 12 })), { id: 'describe', theme: 'phosphor', seconds: 15 }];
const W = 1280;
const H = 800;
const FPS = 30;
const arg = (name, def) => { const i = process.argv.indexOf(name); if (i < 0) return def; const v = process.argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };

// --------------------------------------------------------------------------------------------------------- driver
async function driver() {
  const { app, BrowserWindow } = require('electron');
  app.commandLine.appendSwitch('force-device-scale-factor', '2');  const E = process.env;
  const clip = JSON.parse(E.REC_CLIP);
  const frames = E.REC_FRAMES;
  const sleep = demo.sleep;
  fs.mkdirSync(frames, { recursive: true });
  await app.whenReady();
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: false, webPreferences: { offscreen: { deviceScaleFactor: 2 }, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
  win.setContentSize(W, H); // an offscreen window can come up at another size (960×540 seen on a 150 % display)
  const wc = win.webContents;
  wc.setFrameRate(FPS);
  const js = (code) => wc.executeJavaScript(code, true);
  const waitFor = async (code, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await js(code)) return true; } catch { /* not ready */ } await sleep(150); } return false; };
  const centreOf = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);

  // ---- set up (not recorded): the app on the demo project, this theme, a new conversation's welcome page
  await win.loadURL(E.REC_URL);
  await js(`localStorage.setItem('cw.lastCwd', ${JSON.stringify(E.REC_SHOP)})`);
  await win.loadURL(E.REC_URL);
  await waitFor('!!document.querySelector(".composer")', 30_000);
  await waitFor('window.__store && window.__store.getState().metaLoaded', 20_000);
  await js(`window.__store.getState().setSetting('ui.theme', ${JSON.stringify(`ascii:${clip.theme}`)})`);
  await js("window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })");
  // the sidebar's 新对话 (web/src/features/sidebar/Sidebar.tsx: `.nav[data-id="new"]`; the others are older names)
  const newChat = '(() => { const b = document.querySelector(\'.nav[data-id="new"], .nav[data-id="sb-new"], .sb-top .nav\'); if (b) b.click(); return !!b; })()';
  if (E.REC_SID) {
    // open the conversation once off the record: its first open shows 「Loading history…」 for ~1 s, the one at 3.35 s
    // should show the conversation at once
    await js(`(() => { const r = document.querySelector(${JSON.stringify(`[data-sid="${E.REC_SID}"]`)}); if (r) r.click(); return !!r; })()`);
    await sleep(3000);
  }
  // the welcome page, made sure of: a click that lands while that conversation is still loading can be undone by it
  const welcome = '(() => { const w = document.querySelector(".welcome-tile"); return !!w && w.getBoundingClientRect().width > 0 && !!w.querySelector(".composer textarea"); })()';
  for (let k = 0; k < 3; k++) { await js(newChat); await waitFor(welcome, 4000); await sleep(1000); if (await js(welcome)) break; }
  if (!(await js(welcome))) {
    fs.writeFileSync(path.join(frames, 'no-welcome.png'), (await wc.capturePage()).toPNG());
    const seen = await js('JSON.stringify({ tiles: [...document.querySelectorAll(".welcome-tile")].map((w) => [w.getBoundingClientRect().width, !!w.querySelector(".composer textarea")]), nav: !!document.querySelector(\'.nav[data-id="new"], .nav[data-id="sb-new"], .sb-top .nav\') })');
    throw new Error(`the welcome page did not come up: ${seen} (${path.join(frames, 'no-welcome.png')})`);
  }
  await sleep(4000); // the backdrop worker up and drawing

  // ---- what is on screen may be published: nothing of this machine (its home folder, its user name) and no
  // connector but the app's own, none failing (the runner checked the API already; this is what the page holds)
  const needles = JSON.parse(E.REC_PRIVATE || '[]');
  const allowed = JSON.parse(E.REC_CONNECTORS || '[]');
  const onScreen = async (when) => {
    const seen = JSON.parse(await js(`JSON.stringify({ text: document.body.innerText, title: document.title, servers: Object.values(window.__store.getState().open ?? {}).flatMap((o) => o?.info?.mcpServers ?? []).map((s) => ({ name: s.name, status: s.status })) })`));
    const text = `${seen.title}\n${seen.text}`.toLowerCase();
    const found = needles.filter((s) => text.includes(s.toLowerCase()));
    if (found.length) throw new Error(`${when}: this machine's ${found.map((s) => JSON.stringify(s)).join(', ')} is on screen`);
    const bad = seen.servers.filter((s) => !allowed.includes(s.name) || s.status === 'failed' || s.status === 'needs-auth');
    if (bad.length) throw new Error(`${when}: connectors on screen that may not be: ${bad.map((s) => `${s.name}=${s.status}`).join(' ')}`);
    return seen.servers;
  };
  await onScreen('the first frame');

  // ---- recording
  let t0 = 0;
  let n = 0;
  const shots = [];
  let size = null;
  // JPEG-encoding a 2560×1600 frame on this thread costs ~33 ms (18 fps), and an ffmpeg encoding alongside steals the
  // CPU the renderer needs (16 fps). So the raw pixels go to one file on disk (~16 MB a frame, ~6 GB a clip) and ffmpeg
  // turns them into f00000.jpg, f00001.jpg … after the recording.
  const PW = W * 2;
  const PH = H * 2;
  const rawFile = path.join(frames, 'frames.bgra');
  // one buffer per write, in order (a write stream batches the backlog into one writev, which fails past 2 GB)
  const rawFd = fs.openSync(rawFile, 'w');
  let rawChain = Promise.resolve();
  let rawError = null;
  const raw = {
    write: (buf) => { rawChain = rawChain.then(() => new Promise((res) => fs.write(rawFd, buf, 0, buf.length, null, (e) => { rawError = rawError ?? e; res(); }))); },
    end: async () => { await rawChain; fs.closeSync(rawFd); if (rawError) throw rawError; },
  };
  let skipped = 0;
  wc.on('paint', (_e, _dirty, image) => {
    if (!t0) return;
    const at = performance.now() - t0;
    size = image.getSize();
    if (size.width !== PW || size.height !== PH) { skipped++; return; }
    const name = `f${String(n++).padStart(5, '0')}.jpg`;
    raw.write(image.toBitmap());
    shots.push({ name, at });
  });
  let mouse = { x: 180, y: 260 };
  const move = (x, y) => { mouse = { x: Math.round(x), y: Math.round(y) }; wc.sendInputEvent({ type: 'mouseMove', x: mouse.x, y: mouse.y }); };
  const clickAt = (p) => { move(p.x, p.y); wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 }); };
  const at = async (ms) => { const d = t0 + ms - performance.now(); if (d > 0) await sleep(d); };
  const glide = async (to, ms0, ms1, bow = 0) => {
    const from = { ...mouse };
    for (let t = ms0; t <= ms1; t += 1000 / FPS) {
      await at(t);
      const k = (t - ms0) / Math.max(1, ms1 - ms0);
      const e = k * k * (3 - 2 * k);
      move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e + Math.sin(k * Math.PI) * bow);
    }
  };
  // A busy renderer takes ~100 ms per insertText, and insertText and sendInputEvent travel separately (the Enter can
  // overtake the last characters). So each insert is awaited and carries every character due by now — the typing
  // keeps to its schedule however slow the renderer is — and the Enter waits until the box holds the whole text.
  const typeText = async (text, ms0, ms1) => {
    const cps = Array.from(text);
    let done = 0;
    await at(ms0);
    while (done < cps.length) {
      const due = Math.min(cps.length, Math.max(done + 1, Math.floor(((performance.now() - t0 - ms0) / Math.max(1, ms1 - ms0)) * cps.length) + 1));
      await wc.insertText(cps.slice(done, due).join(''));
      done = due;
      if (done < cps.length) await at(ms0 + ((ms1 - ms0) * done) / cps.length);
    }
    if (!(await waitFor(`(document.querySelector('.composer textarea')?.value ?? '').includes(${JSON.stringify(text)})`, 3000))) throw new Error('the composer never held the whole text');
  };
  const enter = () => { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); };
  const log = [];

  move(mouse.x, mouse.y);
  t0 = performance.now();
  wc.invalidate(); // a first frame at 0 even when nothing moves
  let failed = null; // the frames are still written when the script fails: they show what went wrong
  try {
    await act();
    const servers = await onScreen('the last frame');
    log.push(`connectors at the end: ${[...new Set(servers.map((s) => `${s.name}=${s.status}`))].join(' ') || 'none'}`);
  } catch (e) { failed = e; log.push(`FAILED: ${e.message}`); }
  t0 = 0;
  await raw.end();
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${PW}x${PH}`, '-i', rawFile, '-pix_fmt', 'yuvj420p', '-q:v', '2', '-start_number', '0', path.join(frames, 'f%05d.jpg')], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  fs.rmSync(rawFile, { force: true });
  if (skipped) log.push(`WARNING: ${skipped} frames at another size were dropped`);
  fs.writeFileSync(path.join(frames, 'shots.json'), JSON.stringify({ shots, size, log }));
  if (failed) throw failed;
  app.exit(0);

  async function act() {
    if (clip.id !== 'describe') {
      await glide({ x: 1120, y: 560 }, 0, 2700, -120);
      const row = await centreOf(`[data-sid="${E.REC_SID}"]`);
      if (!row) throw new Error(`the conversation ${E.REC_SID} is not in the sidebar`);
      await glide(row, 2750, 3300);
      await at(3350); clickAt(row);
      await at(4500);
      const box = await centreOf('.composer textarea');
      if (!box) throw new Error('no composer after opening the conversation');
      await glide(box, 4500, 4850);
      await at(4900); clickAt(box);
      await typeText(E.REC_ASK, 5000, 5700);
      await at(5800); enter();
      let cardAt = 0; // when the card first shows (the upstream's pacing is tuned so that it is 9–10 s)
      void (async () => { while (t0 && !cardAt) { if (await js('!!document.querySelector(".pdock, .pdock-out")').catch(() => false)) cardAt = performance.now() - t0; else await sleep(100); } })();
      await at(10_000);
      const card = await js('!!document.querySelector(".pdock, .pdock-out")');
      log.push(card ? 'permission card up at 10 s' : 'WARNING: no permission card at 10 s');
      await at(clip.seconds * 1000 + 100);
      log.push(cardAt ? `the card came at ${(cardAt / 1000).toFixed(1)} s` : 'WARNING: the card never came');
    } else {
      const box = await centreOf('.composer textarea');
      if (!box) throw new Error('no composer on the welcome page');
      await glide(box, 0, 500);
      await at(600); clickAt(box);
      await typeText(E.REC_THEME_ASK, 800, 2600);
      await at(2800); enter();
      log.push(`Enter at ${new Date().toISOString().slice(11, 23)} (compare CW_DEMO_UPSTREAM_LOG=1's times)`);
      const allowSel = '.pdock [data-act="allow"]';
      let allow = null;
      while (!allow && performance.now() - t0 < Number(E.REC_WAIT || 14_000)) { allow = await centreOf(allowSel); if (!allow) await sleep(100); }
      if (!allow) throw new Error('the theme_apply permission card never showed');
      const ready = performance.now() - t0;
      log.push(`apply card at ${(ready / 1000).toFixed(1)} s${ready > 12_000 ? ' (WARNING: later than 12 s, the 「换上新主题」 marker in site/src/showcase/clips.ts is early)' : ''}`);
      const go = Math.max(ready, 10_400);
      await glide(allow, go, go + 500);
      // the card slides in: where the button ends up is measured again just before the click, and a click the card
      // swallowed (still arriving, a busy renderer) is made again
      for (let k = 0; k < 3; k++) {
        await at(Math.max(go + 600, 11_000) + k * 1200);
        const now = await centreOf(allowSel);
        if (!now) break; // answered
        if (k) log.push(`WARNING: the allow click #${k} did not take, clicking again`);
        clickAt(now);
      }
      await at(clip.seconds * 1000 + 100);
      const applied = await js("document.documentElement.dataset.ascii === 'metro'");
      log.push(applied ? 'metro applied' : 'WARNING: metro is not applied at the end');
    }
  }
}

// ------------------------------------------------------------------------------------------------------------ runner
// The recordings are published: the right panel's 连接器 may list only the app's own servers, connected. What else
// turned up under the throwaway HOME (2026-10-23): the memory server, which cannot start from the source tree in the demo
// project's folder (`--import tsx` is not found there); it is switched off with its own setting.
const CONNECTORS_ALLOWED = ['web', 'sessions', 'preview'];
const CONNECTORS_BAD = ['failed', 'needs-auth'];
/** the throwaway HOME's ~/.claude/settings.json: nothing of the user's own */
const ENGINE_SETTINGS = {};
/** what must never be on screen: this machine's home folder and user name */
function privateNeedles() {
  const home = os.homedir();
  const user = os.userInfo().username;
  return [...new Set([home, home.replace(/\\/g, '/'), user].filter((s) => s && s.length >= 3))];
}

/** what the app reports for this conversation's connectors, once none is still connecting; throws on any not allowed */
async function checkConnectors(c, sessionId, label) {
  let servers = [];
  const read = async () => { servers = (await c.req({ kind: 'session.info', sessionId }))?.info?.mcpServers ?? []; };
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    await read();
    if (servers.length && !servers.some((s) => s.status === 'pending')) break;
    await demo.sleep(500);
  }
  // The official binary reports its stdio servers as `pending` in system/init and the app keeps that snapshot (only a
  // connector switch asks again: SessionRunner.toggleMcp), so the panel says 连接中 for the whole conversation though
  // the server works. Switching it on again — what the + menu's 连接器 switch does — brings the real status.
  for (const s of servers.filter((x) => x.status === 'pending')) await c.req({ kind: 'session.toggleMcp', sessionId, name: s.name, enabled: true });
  if (servers.some((s) => s.status === 'pending')) await read();
  const shown = servers.map((s) => `${s.name}=${s.status}`).join(' ');
  const bad = servers.filter((s) => !CONNECTORS_ALLOWED.includes(s.name) || CONNECTORS_BAD.includes(s.status) || s.status === 'pending');
  if (!servers.length || bad.length) throw new Error(`${label}: the connectors would show ${shown || 'nothing (never reported)'}; only ${CONNECTORS_ALLOWED.join(' / ')}, connected, may be on screen`);
  console.log(`${label}: connectors ${shown}`);
}

/** the concat demuxer's list: every frame lasts until the next one, the last until the end of the clip */
function writeConcat(dir, shots, seconds) {
  const end = seconds * 1000;
  const kept = shots.filter((s) => s.at < end);
  if (!kept.length) throw new Error('no frames were painted');
  const lines = ['ffconcat version 1.0'];
  kept.forEach((s, i) => {
    const from = i === 0 ? 0 : s.at; // the first frame covers from 0
    const to = i + 1 < kept.length ? kept[i + 1].at : end;
    lines.push(`file '${s.name}'`, `duration ${Math.max(0.001, (to - from) / 1000).toFixed(4)}`);
  });
  lines.push(`file '${kept[kept.length - 1].name}'`); // the demuxer reads the last duration only with the file listed again
  const list = path.join(dir, 'frames.ffconcat');
  fs.writeFileSync(list, `${lines.join('\n')}\n`);
  return { list, count: kept.length };
}

function electronRun(env) {
  const electron = require(path.join(demo.ROOT, 'node_modules', 'electron'));
  const e = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  return new Promise((res) => {
    const p = spawn(electron, [__filename], { env: e, stdio: 'inherit', windowsHide: true });
    const t = setTimeout(() => { p.kill(); res(-1); }, 300_000);
    p.on('exit', (c) => { clearTimeout(t); res(c); });
  });
}

async function recordOne(clip, lang, out, dist, opts) {
  const media = require('./lib/media-encode.cjs');
  const T = demo.TEXT[lang];
  // not under %TEMP%: that is inside this machine's home folder (C:\Users\<name>\AppData\Local\Temp), and a path in the
  // throwaway HOME can be on screen (the describe clip's theme cards: the guard caught it, 2026-10-23)
  let home = null;
  if (process.platform === 'win32') {
    try { fs.mkdirSync('C:/work', { recursive: true }); home = fs.mkdtempSync(`C:/work/.rec-${clip.id}-${lang}-`); } catch { /* no write access to C:\ */ }
  }
  if (!home) home = demo.tmpHome(`cw-rec-${clip.id}-${lang}-`);
  const seed = demo.seedDemo(home, lang, { clean: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(ENGINE_SETTINGS, null, 2));
  const up = await demo.startUpstream(lang, { shop: seed.shop });
  const srv = await demo.startServer(home, { lang, shop: seed.shop, theme: `ascii:${clip.theme}`, dist, fromSource: true, settings: { 'ui.defaultMode': 'acceptEdits', 'ui.promptSuggestions': false, 'memory.mcp': false } });
  const c = demo.client(srv.port, srv.token);
  const frames = path.join(out, '.frames', `${clip.id}.${lang}`);
  try {
    await c.ready;
    await c.req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
    const prov = await c.req({ kind: 'providers.upsert', provider: { name: lang === 'zh' ? '中转' : 'Relay', type: 'anthropic', baseUrl: up.url, apiKey: 'sk-demo-not-real', defaultModel: 'claude-sonnet-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] } });
    await c.req({ kind: 'settings.set', key: 'defaultProviderId', value: prov.id });
    await c.req({ kind: 'workspaces.add', path: seed.shop });
    // the conversation the theme clips open at 3 s: live, edits allowed, one short exchange already in it. The describe
    // clip has it too (the same sidebar), and there it warms the runtime up: the first conversation the official
    // binary runs on a cold start takes ~6 s to send anything, the next one far less.
    const o = await c.req({ kind: 'session.open', params: { cwd: seed.shop, providerId: prov.id, model: 'claude-sonnet-5-5', permissionMode: 'acceptEdits' } });
    await c.req({ kind: 'session.send', params: { sessionId: o.sessionId, text: T.recIntro, uuid: crypto.randomUUID() } });
    const sid = clip.id === 'describe' ? '' : o.sessionId;
    await demo.sleep(clip.id === 'describe' ? 10_000 : 6000);
    await checkConnectors(c, o.sessionId, `${clip.id}.${lang}`); // the same runtime as the clip's own conversation
    fs.rmSync(frames, { recursive: true, force: true });
    const code = await electronRun({ REC_URL: srv.url, REC_SHOP: seed.shop, REC_SID: sid, REC_CLIP: JSON.stringify(clip), REC_FRAMES: frames, REC_ASK: T.rec, REC_THEME_ASK: T.themeAsk, REC_PRIVATE: JSON.stringify(privateNeedles()), REC_CONNECTORS: JSON.stringify(CONNECTORS_ALLOWED) });
    const shotsFile = path.join(frames, 'shots.json');
    const { shots, size, log } = fs.existsSync(shotsFile) ? JSON.parse(fs.readFileSync(shotsFile, 'utf8')) : { shots: [], size: null, log: [] };
    for (const l of log) console.log(`${clip.id}.${lang}: ${l}`);
    if (code !== 0) throw new Error(`${clip.id}.${lang}: electron exited ${code} (the frames so far: ${frames})\n${srv.log().slice(-2000)}`);
    const { list, count } = writeConcat(frames, shots, clip.seconds);
    const fps = count / clip.seconds;
    console.log(`${clip.id}.${lang}: ${count} frames painted (${fps.toFixed(1)} fps) at ${size.width}×${size.height}${fps < 24 ? '  WARNING: under 24 fps, motion will stutter' : ''}${size.width < W * 2 ? '  WARNING: not ×2' : ''}`);
    const master = path.join(frames, 'master.mp4');
    media.ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},format=yuv420p`, '-t', String(clip.seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', master]);
    media.report(media.encodeClip(master, out, clip.id, lang));
  } finally {
    c.ws.close();
    srv.server.kill();
    up.server.close();
    seed.cleanup();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* a handle may still be held */ }
    if (!opts.keepFrames) fs.rmSync(frames, { recursive: true, force: true });
  }
}

async function runner() {
  const langs = arg('--lang', null) ? [String(arg('--lang'))] : ['en', 'zh'];
  if (langs.some((l) => !['en', 'zh'].includes(l))) throw new Error('--lang en|zh');
  const only = arg('--only', null) ? String(arg('--only')).split(',') : null;
  const clips = CLIPS.filter((c) => !only || only.includes(c.id));
  if (!clips.length) throw new Error(`--only names none of: ${CLIPS.map((c) => c.id).join(' ')}`);
  const out = path.resolve(String(arg('--out', path.join(demo.ROOT, 'site', '.media-local'))));
  const opts = { keepFrames: !!arg('--keep-frames', false) };
  require('./lib/media-encode.cjs').webmEncoder(); // fail early on an ffmpeg without the encoders
  fs.mkdirSync(out, { recursive: true });
  // the web app, built where nothing else looks (a running dev app serves web/dist: never rebuild that)
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-rec-web-'));
  console.log(`building the web app into ${dist} …`);
  execFileSync(process.execPath, [path.join(demo.ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', path.join(demo.ROOT, 'web'), '--outDir', dist, '--emptyOutDir'], { cwd: demo.ROOT, stdio: 'inherit', windowsHide: true });
  try {
    for (const lang of langs) for (const clip of clips) {
      console.log(`--- ${clip.id}.${lang}`);
      await recordOne(clip, lang, out, dist, opts);
    }
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
  console.log(`done: ${out}`);
}

if (process.versions.electron) driver().catch((e) => { console.error(e); process.exit(2); });
else runner().catch((e) => { console.error(e); process.exit(1); });
