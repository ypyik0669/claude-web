// The built site in a real Chromium (the repo's Electron, offscreen): the home pages load, the scene starts, nothing
// is logged as an error; screenshots for a person to look at.
//   npm run build --prefix site && env -u ELECTRON_RUN_AS_NODE node site/scripts/smoke.cjs [--out <dir>]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SITE = path.resolve(__dirname, '..');
const ROOT = path.resolve(SITE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function driver() {
  const { app, BrowserWindow } = require('electron');
  const E = process.env;
  await app.whenReady();
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { offscreen: true, contextIsolation: true } });
  win.webContents.setFrameRate(30);
  const errors = [];
  win.webContents.on('console-message', (e, level, message) => {
    const lvl = typeof e.level === 'string' ? e.level : level;
    if (lvl === 'error' || lvl === 3) errors.push(`${E.SMOKE_PAGE}: ${e.message ?? message}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitFor = async (code, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await js(code)) return true; } catch { /* loading */ } await sleep(150); } return false; };
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(E.SMOKE_OUT, `${name}.png`), img.toPNG()); };
  for (const [lang, page] of [['en', '/?lang=en'], ['zh', '/zh/']]) {
    E.SMOKE_PAGE = page;
    await win.loadURL(E.SMOKE_URL + page);
    const live = await waitFor('document.querySelector("#hero-scene")?.dataset.live === "1"', 20_000);
    if (!live) errors.push(`${page}: the scene did not start (tier ${await js('document.querySelector("#hero-scene")?.dataset.tier')})`);
    await sleep(1500);
    await shot(`hero-${lang}`);
    const ids = await js('[...document.querySelectorAll("section.chapter[data-chapter]")].map((s) => s.dataset.chapter)');
    if (ids.length !== 6) errors.push(`${page}: ${ids.length} chapters, want 6`);
    for (const id of ids) {
      await js(`document.getElementById("ch-${id}").scrollIntoView({ block: "center" })`);
      const ok = await waitFor(`document.querySelector("#hero-scene").dataset.chapter === "${id}"`, 4000);
      if (!ok) errors.push(`${page}: chapter ${id} did not take the stage`);
      await sleep(900);
      if (id !== 'agents') {
        const shown = await js(`(() => { const o = document.querySelector('[data-overlay="${id}"]'); return !!o && !o.hidden && o.getBoundingClientRect().width > 0; })()`);
        if (!shown && id !== 'permission') errors.push(`${page}: the ${id} card is not showing`);
      }
      if (['turns', 'permission', 'elsewhere'].includes(id)) await shot(`ch-${id}-${lang}`);
    }
    await js('window.scrollTo(0, document.body.scrollHeight)');
    await sleep(600);
    await shot(`install-${lang}`);
  }
  console.log(`screenshots: ${E.SMOKE_OUT}`);
  if (errors.length) { console.error(errors.join('\n')); app.exit(1); return; }
  console.log('smoke ok');
  app.exit(0);
}

async function launch() {
  const { serve } = require('./lib/serve.cjs');
  const { spawn } = require('node:child_process');
  const dist = path.join(SITE, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('build the site first: npm run build --prefix site'); process.exit(2); }
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? path.resolve(process.argv[i + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'site-smoke-'));
  fs.mkdirSync(out, { recursive: true });
  const srv = await serve(dist);
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const env = { ...process.env, SMOKE_URL: srv.url, SMOKE_OUT: out, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(electron, [__filename], { env, stdio: 'inherit', windowsHide: true });
  p.on('exit', (code) => { srv.close(); process.exit(code ?? 1); });
}

if (process.versions.electron) driver().catch((e) => { console.error(e); process.exit(2); });
else launch();
