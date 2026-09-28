// Screenshot the web UI through Electron (electron.exe is a GUI app on Windows: it prints nothing to a bash pipe,
// so this writes <out>.log next to the image):
//   node_modules/electron/dist/electron.exe "<abs path>\scripts\shot.cjs" <url> <out.png> [jsBeforeShot] [delayMs] [width] [height]
//   (SHOT_JS_FILE=<file.js> instead of jsBeforeShot for a multi-line script; SHOT_URL for the full URL)
const fs = require('node:fs');
// NOTE: a bare http(s) URL in argv makes Electron's default app treat the launch as "open URL" and exit 127,
// so the URL is passed as `host:port/path` (scheme added here) or via env SHOT_URL.
const [rawUrl, out, argJs = '', delay = '2500', w = '1360', h = '860'] = process.argv.slice(2);
// SHOT_JS_FILE: the page script from a file — any number of lines, colons and quotes (argv carries only one line and
// a token with ':' makes Electron exit); it wins over the argv script
const js = process.env.SHOT_JS_FILE ? fs.readFileSync(process.env.SHOT_JS_FILE, 'utf8') : argJs;
const url = process.env.SHOT_URL ?? (/^https?:/.test(rawUrl) ? rawUrl : `http://${rawUrl}`);
const log = (s) => { try { fs.appendFileSync(`${out}.log`, `${new Date().toISOString()} ${s}\n`); } catch { /* ignore */ } };
try { fs.writeFileSync(`${out}.log`, ''); } catch { /* ignore */ }
log(`argv ${JSON.stringify(process.argv)}`);
process.on('uncaughtException', (e) => { log(`uncaught ${e.stack ?? e}`); process.exit(3); });
let electron;
try { electron = require('electron'); } catch (e) { log(`require electron failed ${e.message}`); process.exit(4); }
if (typeof electron === 'string') { log('electron module is a path string — running under ELECTRON_RUN_AS_NODE?'); process.exit(5); }
const { app, BrowserWindow } = electron;
setTimeout(() => { log('timeout'); app.exit(6); }, 60_000);
app.whenReady().then(async () => {
  try {
    log('ready');
    // SHOT_OFFSCREEN=1: render offscreen (works with the display off / locked, when capturePage otherwise throws UnknownVizError)
    const offscreen = process.env.SHOT_OFFSCREEN === '1';
    const win = new BrowserWindow({ width: Number(w), height: Number(h), show: !offscreen, webPreferences: { offscreen } });
    if (!offscreen) win.showInactive();
    // Electron ≥ 36 passes one event object; older versions pass (event, level, message)
    win.webContents.on('console-message', (a, b, c) => {
      const level = typeof a === 'object' && a && 'level' in a ? a.level : b;
      const message = typeof a === 'object' && a && 'message' in a ? a.message : c;
      const bad = level === 'error' || level === 'warning' || Number(level) >= 2;
      if (bad) log(`console[${level}] ${String(message).slice(0, 500)}`);
    });
    await win.loadURL(url);
    log('loaded');
    await new Promise((r) => setTimeout(r, 1500));
    if (js) {
      try { await win.webContents.executeJavaScript(js, true); log('js ok'); } catch (e) { log(`js failed: ${e.message}`); }
    }
    await new Promise((r) => setTimeout(r, Number(delay)));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(out, img.toPNG());
    log(`wrote ${out} ${JSON.stringify(img.getSize())}`);
  } catch (e) {
    log(`error ${e.stack ?? e}`);
  }
  app.exit(0);
});
