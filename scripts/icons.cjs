// Render web/public/icon.svg to PNG icons for the PWA manifest with Electron (no native image deps needed):
//   node_modules/electron/dist/electron.exe scripts/icons.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'web/public/icon.svg'), 'utf8');
const log = (s) => fs.appendFileSync(path.join(root, 'web/public/icons.log'), `${s}\n`);
app.whenReady().then(async () => {
  try {
    fs.rmSync(path.join(root, 'web/public/icons.log'), { force: true });
    const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
    for (const size of [192, 512]) {
      const html = path.join(os.tmpdir(), `cw-icon-${size}.html`);
      fs.writeFileSync(html, `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`);
      win.setSize(size, size);
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await win.loadFile(html); break; } catch (e) { log(`load ${size} attempt ${attempt}: ${e.message}`); await new Promise((r) => setTimeout(r, 300)); }
      }
      await new Promise((r) => setTimeout(r, 500));
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
      fs.writeFileSync(path.join(root, `web/public/icon-${size}.png`), img.toPNG());
      fs.rmSync(html, { force: true });
    }
    win.destroy();
    app.exit(0);
  } catch (e) { log(String(e.stack ?? e)); app.exit(1); }
});
