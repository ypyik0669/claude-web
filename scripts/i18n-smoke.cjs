// English interface smoke: starts a throwaway server in English (the demo of scripts/lib/demo.cjs), walks the app
// in a real Chromium (Electron) — the welcome page and every menu of its composer, a conversation with its side-panel
// views, every settings page and tab, the automation / extensions / background / mission pages, the command palette,
// a conversation waiting for a permission, the phone layout — and FAILS when any text a user can see (text, tooltips,
// accessible names, placeholders) still has Chinese in it, or the console has an error.
//   node scripts/i18n-smoke.cjs [--out <dir>] [--shots]     (--shots keeps a screenshot of every step in <out>)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const demo = require('./lib/demo.cjs');

const arg = (name, def) => { const i = process.argv.indexOf(name); if (i < 0) return def; const v = process.argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };

/** Settings pages (and their tabs) and dock panels, read from the sources like ui-smoke does. */
function inventory() {
  const cat = fs.readFileSync(path.join(demo.ROOT, 'web/src/features/settings/catalog.ts'), 'utf8');
  const list = cat.slice(cat.indexOf('export const SETTINGS_SECTIONS'), cat.indexOf('export const VISIBLE_SECTIONS'));
  const sections = [...list.matchAll(/id: '([\w.-]+)', l: (?:tr(?:As)?\()?'[^']+'(?:, '[^']+')?\)?, ic: '\w+', group: '\w+'/g)].map((m) => ({ id: m[1], at: m.index, tabs: [] }));
  for (const [i, s] of sections.entries()) {
    const text = list.slice(s.at, i + 1 < sections.length ? sections[i + 1].at : list.length);
    s.tabs = [...text.matchAll(/\{ id: '(\w+)', l: [^,]+, bodies:/g)].map((m) => m[1]);
  }
  const layout = fs.readFileSync(path.join(demo.ROOT, 'web/src/model/layout.ts'), 'utf8');
  const block = layout.slice(layout.indexOf('export const PANELS'), layout.indexOf('];', layout.indexOf('export const PANELS')));
  const panels = [...block.matchAll(/\{ id: '(\w+)', title:/g)].map((m) => m[1]);
  const icons = [...list.matchAll(/\bic: '/g)].length;
  if (sections.length !== icons) throw new Error(`read ${sections.length} settings pages but the catalog has ${icons}`);
  if (sections.length < 15 || panels.length < 5) throw new Error('could not read the settings pages / panels from the sources');
  return { sections: sections.map(({ at, ...s }) => s), panels };
}

// ---------------------------------------------------------------------------------------------------------- the driver
async function driver() {
  const { app, BrowserWindow } = require('electron');
  const E = process.env;
  const out = E.I18N_OUT;
  const inv = JSON.parse(E.I18N_INV);
  const shots = E.I18N_SHOTS === '1';
  const results = { steps: [], console: [], layout: [] };
  const sleep = demo.sleep;
  await app.whenReady();
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: E.I18N_SHOW === '1', webPreferences: { offscreen: E.I18N_SHOW !== '1', contextIsolation: true, nodeIntegration: false } });
  let phase = 'load';
  win.webContents.on('console-message', (a, b, c) => {
    const level = typeof a === 'object' && a && 'level' in a ? a.level : b;
    const message = typeof a === 'object' && a && 'message' in a ? a.message : c;
    if (level === 'error' || level === 'warning' || Number(level) >= 2) results.console.push({ phase, level: String(level), message: String(message).slice(0, 300) });
  });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitFor = async (code, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await js(code)) return true; } catch { /* page not ready */ } await sleep(150); } return false; };
  const click = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const key = (k, mods = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods }); };
  const shot = async (name) => { if (!shots) return; try { fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG()); } catch { /* display locked */ } };

  // every piece of text a user can see right now: text nodes, and title / aria-label / placeholder / alt / value
  const SCAN = `(() => {
    const re = /[\\u3400-\\u9fff]/;
    const found = new Set();
    const visible = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || e.hidden || e.getAttribute('aria-hidden') === 'true' && !e.matches('[data-allow-hidden]')) return false; } return true; };
    const add = (t, where) => { const s = String(t).trim(); if (s && re.test(s) && s !== '中文') found.add(where + ': ' + s.replace(/\\s+/g, ' ').slice(0, 90)); };
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.parentElement && !/^(SCRIPT|STYLE)$/.test(n.parentElement.tagName) && visible(n.parentElement)) add(n.nodeValue, 'text'); }
    for (const e of document.querySelectorAll('[title], [aria-label], [placeholder], [alt]')) {
      if (!visible(e)) continue;
      for (const a of ['title', 'aria-label', 'placeholder', 'alt']) { const v = e.getAttribute(a); if (v) add(v, '@' + a); }
    }
    for (const e of document.querySelectorAll('option')) if (e.closest('select') && visible(e.closest('select'))) add(e.textContent, 'option');
    return [...found];
  })()`;
  const step = async (name, action) => {
    phase = name;
    try { if (action) await action(); } catch (e) { results.steps.push({ name, error: String(e.message ?? e) }); return; }
    await sleep(600);
    const found = await js(SCAN).catch((e) => ['scan failed: ' + e.message]);
    results.steps.push({ name, chinese: found });
    await shot(name.replace(/[^\w.-]+/g, '-'));
  };
  const closeMenus = async () => { key('Escape'); await sleep(200); key('Escape'); await sleep(200); };

  await win.loadURL(E.I18N_URL);
  await waitFor('!!document.querySelector(".composer")', 30_000);
  await waitFor('window.__store && window.__store.getState().metaLoaded', 20_000);
  await sleep(1500);
  const lang = await js('document.documentElement.lang');
  results.lang = lang;

  await step('welcome');
  // English is wider than Chinese: the composer's one row must still hold every control, at a few window widths
  const ROW = `(() => {
    const row = document.querySelector('.composer-bar.cb, .cb');
    if (!row) return ['no composer row'];
    const box = row.getBoundingClientRect();
    const bad = [];
    if (row.scrollWidth > row.clientWidth + 1) bad.push('the row overflows (' + row.scrollWidth + ' > ' + row.clientWidth + ')');
    for (const el of row.querySelectorAll('button')) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).display === 'none') continue;
      if (r.left < box.left - 1 || r.right > box.right + 1) bad.push('outside the row: ' + (el.getAttribute('aria-label') || el.className || el.textContent).toString().slice(0, 40));
    }
    return bad;
  })()`;
  for (const w of [1440, 1100, 900, 700]) {
    win.setContentSize(w, 900); await sleep(700);
    for (const b of await js(ROW).catch((e) => ['check failed: ' + e.message])) results.layout.push(`composer row at ${w}px: ${b}`);
  }
  win.setContentSize(1440, 900); await sleep(600);
  for (const [name, sel] of [['plus menu', '.cb .plus'], ['project menu', '.cb .dirpick'], ['model menu', '.cb .mm-anchor:not(.sub-anchor) > button.chip'], ['subagent menu', '.cb .sub-anchor > button.chip'], ['effort menu', '.cb .depth-chip'], ['permission menu', '.cb .perm-chip']]) {
    await step(`welcome · ${name}`, async () => { await click(sel); await sleep(500); });
    await closeMenus();
  }
  await step('rail · more menu', async () => { await click('.rail-btn[data-id="more"]'); await sleep(400); });
  await closeMenus();
  await step('command palette', async () => { await js('window.__store.setState({ paletteOpen: true })'); await sleep(500); });
  await js('window.__store.setState({ paletteOpen: false })');

  await step('conversation', async () => { await js(`window.__store.getState().loadHistory(${JSON.stringify(E.I18N_SID)})`); await sleep(2500); });
  for (const p of inv.panels) await step(`panel · ${p}`, async () => { await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: ${JSON.stringify(p)} })`); await sleep(700); });
  await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
  await step('conversation · header menu', async () => { await click('.chat-head .icon-btn:last-of-type'); await sleep(400); });
  await closeMenus();
  await step('conversation · message actions', async () => { await js(`(() => { const m = document.querySelector('.msg.user, .msg-user'); if (m) m.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })()`); });

  for (const s of inv.sections) {
    const tabs = s.tabs.length ? s.tabs : [''];
    for (const t of tabs) {
      await step(`settings · ${s.id}${t ? ' · ' + t : ''}`, async () => {
        await js(`window.__store.getState().openSettings(${JSON.stringify(t ? { section: s.id, tab: t } : { section: s.id })})`);
        await waitFor('!!document.querySelector(".modal.settings")', 4000);
        await sleep(700);
        // the page's own 更多选项 (the rows kept out of sight by default)
        await js(`(() => { for (const b of document.querySelectorAll('.modal.settings button')) if (/^(More options|更多选项)/.test(b.textContent.trim()) && b.getAttribute('aria-expanded') !== 'true') b.click(); })()`);
        await sleep(300);
      });
    }
  }
  await js('window.__store.setState({ settingsOpen: null })');
  await sleep(300);

  for (const [name, rail] of [['automation page', 'automation'], ['extensions page', 'extensions'], ['background page', 'background']]) {
    await step(name, async () => { await click(`.rail-btn[data-id="${rail}"]`); await sleep(1500); });
  }
  await click('.rail-btn[data-id="chat"]');
  await step('mission control', async () => { await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'mission' })`); await sleep(800); });
  await step('conversation waiting for a permission', async () => {
    await js(`window.__store.getState().loadHistory(${JSON.stringify(E.I18N_PERM_SID)}, { focus: true })`);
    await waitFor('!!document.querySelector(".pdock, .pdock-out")', 25_000);
    await sleep(800);
  });
  await step('phone layout', async () => { win.setContentSize(400, 820); await sleep(1200); });
  await step('phone layout · sidebar', async () => { await js('window.__store.setState({ sidebarOpen: true })'); await sleep(800); });

  fs.writeFileSync(E.I18N_RESULT, JSON.stringify(results));
  app.exit(0);
}

// ------------------------------------------------------------------------------------------------------------ runner
async function runner() {
  const out = path.resolve(String(arg('--out', path.join(os.tmpdir(), 'cw-i18n-smoke'))));
  fs.mkdirSync(out, { recursive: true });
  const home = demo.tmpHome('cw-i18n-');
  const seed = demo.seedDemo(home, 'en');
  const up = await demo.startUpstream('en');
  const srv = await demo.startServer(home, { lang: 'en', shop: seed.shop });
  console.log(`server up (HOME=${home})`);
  const c = demo.client(srv.port, srv.token);
  await c.ready;
  await c.req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  const prov = await c.req({ kind: 'providers.upsert', provider: { name: 'Relay', type: 'anthropic', baseUrl: up.url, apiKey: 'sk-demo-not-real', defaultModel: 'claude-sonnet-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'] } });
  await c.req({ kind: 'providers.upsert', provider: { name: 'DeepSeek', type: 'openai', baseUrl: up.url, apiKey: 'sk-demo-not-real', defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] } });
  for (const p of [seed.shop, seed.notes, seed.blog]) await c.req({ kind: 'workspaces.add', path: p });
  await c.req({ kind: 'schedules.upsert', schedule: { name: seed.texts.schedules[0][0], cwd: seed.shop, prompt: seed.texts.schedules[0][1], everyMinutes: 1440, enabled: true } });
  // a conversation that is asking for a permission, and one that is still working
  const o = await c.req({ kind: 'session.open', params: { cwd: seed.shop, providerId: prov.id, model: 'claude-sonnet-5-5', permissionMode: 'default' } });
  await c.req({ kind: 'session.send', params: { sessionId: o.sessionId, text: seed.texts.gitignore, uuid: require('node:crypto').randomUUID() } });
  const o2 = await c.req({ kind: 'session.open', params: { cwd: seed.notes, providerId: prov.id, model: 'claude-sonnet-5-5', permissionMode: 'default' } });
  await c.req({ kind: 'session.send', params: { sessionId: o2.sessionId, text: seed.texts.hang, uuid: require('node:crypto').randomUUID() } });
  await demo.sleep(6000);

  const result = path.join(out, 'i18n-smoke.json');
  fs.rmSync(result, { force: true });
  const { spawn } = require('node:child_process');
  const electron = require(path.join(demo.ROOT, 'node_modules', 'electron'));
  const env = { ...process.env, I18N_URL: srv.url, I18N_OUT: out, I18N_RESULT: result, I18N_SID: seed.sid, I18N_PERM_SID: o.sessionId, I18N_INV: JSON.stringify(inventory()), I18N_SHOTS: arg('--shots', false) ? '1' : '', I18N_SHOW: arg('--show', false) ? '1' : '', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((res) => {
    const p = spawn(electron, [__filename], { env, stdio: 'ignore', windowsHide: false });
    const t = setTimeout(() => { p.kill(); res(-1); }, 600_000);
    p.on('exit', (cd) => { clearTimeout(t); res(cd); });
  });
  c.ws.close();
  srv.server.kill();
  up.server.close();
  let r = null;
  try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { /* electron died */ }
  let failed = !r || code !== 0;
  if (r) {
    console.log(`page language: ${r.lang}`);
    if (r.lang !== 'en') { console.log('FAIL the page is not in English'); failed = true; }
    for (const s of r.steps) {
      const bad = s.error ? [`step failed: ${s.error}`] : s.chinese;
      console.log(`${bad.length ? 'FAIL' : 'PASS'} ${s.name}`);
      for (const b of bad.slice(0, 12)) console.log(`      ${b}`);
      if (bad.length) failed = true;
    }
    for (const l of r.layout) { console.log(`FAIL ${l}`); failed = true; }
    const noise = r.console.filter((m) => !/task queue exceeded allotted deadline|Electron Security Warning/.test(m.message));
    console.log(`console errors/warnings: ${noise.length}`);
    for (const m of noise.slice(0, 20)) { console.log(`  [${m.phase}] ${m.level}: ${m.message}`); failed = true; }
  } else console.log(`electron exited ${code} without a result`);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* a handle may still be held */ }
  seed.cleanup();
  console.log(failed ? '\nENGLISH SMOKE FAILED' : '\nEnglish smoke passed');
  process.exit(failed ? 1 : 0);
}

if (process.versions.electron) driver().catch((e) => { fs.writeFileSync(process.env.I18N_RESULT + '.err', String(e.stack ?? e)); process.exit(2); });
else runner().catch((e) => { console.error(e); process.exit(2); });
