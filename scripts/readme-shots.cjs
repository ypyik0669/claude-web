// The README's pictures, taken from the real app in one language:
//   node scripts/readme-shots.cjs --lang en|zh [--out <dir>] [--only chat,home,…] [--show]
// A throwaway server with the demo of scripts/lib/demo.cjs (a repo with real uncommitted changes, conversations in
// three projects, a fake upstream, one conversation waiting for a permission and one still working) is driven in a
// real Chromium (Electron); every picture is a capture of that window (offscreen: works with the screen locked).
// Output: <out>/{characters,home,chat,split,models,subagent,settings,connect,automation,background,permission,
// language,themes,theme-home,mobile}.png and <out>/cafe.gif (frames of the 3D cafe put together with ffmpeg).
// The interface of the 2026-11 redesign: the sidebar's five entries, the line under the box, one right panel at a
// time, the settings dialog (4 groups / 14 pages), 自动化's tabs. There is no `mission` picture any more: the Overview
// is only a palette command now, and the README's 「同时管理多个对话」 shows `permission` (需要你 + the docked card).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const demo = require('./lib/demo.cjs');

const arg = (name, def) => { const i = process.argv.indexOf(name); if (i < 0) return def; const v = process.argv[i + 1]; return v === undefined || v.startsWith('--') ? true : v; };

// --------------------------------------------------------------------------------------------------------- driver
async function driver() {
  const { app, BrowserWindow } = require('electron');
  const E = process.env;
  const out = E.SHOTS_OUT;
  const only = E.SHOTS_ONLY ? E.SHOTS_ONLY.split(',') : null;
  const want = (n) => !only || only.includes(n);
  const lang = E.SHOTS_LANG;
  const sleep = demo.sleep;
  fs.mkdirSync(out, { recursive: true });
  await app.whenReady();
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: E.SHOTS_SHOW === '1', webPreferences: { offscreen: E.SHOTS_SHOW !== '1', contextIsolation: true, nodeIntegration: false } });
  win.webContents.setFrameRate(30);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitFor = async (code, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await js(code)) return true; } catch { /* not ready */ } await sleep(150); } return false; };
  const click = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const key = (k, mods = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods }); };
  const png = async (name, rect) => { const img = await win.webContents.capturePage(rect); fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG()); console.log('wrote', name); };
  const store = (code) => js(`(() => { const st = window.__store.getState(); return (${code}); })()`);
  const load = async (url) => { await win.loadURL(url); await waitFor('!!document.querySelector(".composer")', 30_000); await waitFor('window.__store && window.__store.getState().metaLoaded', 20_000); await waitFor('window.__store.getState().agents.length > 0', 40_000); await sleep(2500); };
  const openChat = async (sid) => { await js(`window.__store.getState().loadHistory(${JSON.stringify(sid)}, { focus: true })`); await sleep(2500); };
  const reset = async () => { key('Escape'); await sleep(150); key('Escape'); await js('window.__store.setState({ settingsOpen: null, paletteOpen: false })'); };
  const dock = (panel) => js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: ${JSON.stringify(panel)} })`);
  const dockClose = () => js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
  // the sidebar's 新对话 (redesign 2026-11 stage 1: the first of the five entries under the brand row)
  const newConv = async () => { await click('.sidebar .sb-nav [data-id="new"]'); await sleep(1500); };
  const closePages = async () => { await js("document.querySelectorAll('.over-page:not([hidden]) .over-close').forEach((b) => b.click())"); await sleep(500); };

  // the first-run face (no model connected yet): the start page's notice and the 接一个模型 dialog
  if (E.SHOTS_PHASE === 'fresh') {
    await load(E.SHOTS_URL);
    if (want('connect')) {
      await waitFor('!!document.querySelector(".modal")', 8000);
      // 正在检查登录… until the server's first answer about the login (it runs the CLI; slow on a busy machine)
      await waitFor('!!document.querySelector(".modal.onboarding:not([data-step=\\"checking\\"])")', 45_000);
      await sleep(1200);
      await png('connect');
    }
    app.exit(0);
    return;
  }

  // the start page opens on the shop project, like the conversation of most pictures
  await win.loadURL(E.SHOTS_URL);
  await js(`localStorage.setItem('cw.lastCwd', ${JSON.stringify(E.SHOTS_SHOP)})`);
  await load(E.SHOTS_URL);
  await store("st.setSetting('ui.theme', 'dark')");
  await dockClose();

  // the start page (redesign 2026-11 stage 4): the logo, 今天想做点什么？, the box and the line under it (文件夹 · 分支 ·
  // 权限 … 模型 · 子代理 · 智能程度); the shop project has conversations, so no starter suggestions and no checklist
  if (want('home')) { await reset(); await sleep(800); await png('home'); }
  if (want('models')) {
    // from a conversation's line under the box: the menu opens upwards with the window's height to fill (on the start
    // page the box sits in the middle and only the first section fits)
    await reset(); await openChat(E.SHOTS_SID); await dockClose(); await sleep(600);
    await click('.pane.focused .composer-under .mm-anchor:not(.sub-anchor) > button.chip'); await sleep(1000); await png('models'); await reset(); await sleep(300);
    await newConv();
  }
  if (want('subagent')) {
    await reset(); await click('.cb .sub-anchor > button.chip'); await sleep(900); await png('subagent'); await reset(); await sleep(300);
  }
  if (want('chat')) {
    // the right panel on 改动 (it was 审阅; one panel at a time, the picker at its top left): both files' diffs open
    await reset(); await openChat(E.SHOTS_SID); await dock('files'); await sleep(3000);
    await png('chat');
  }
  if (want('split')) {
    await reset(); await openChat(E.SHOTS_SID);
    // an empty pane beside it (the way the sidebar's split does), then the second conversation into that pane
    await js(`(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); st.dispatchLayout({ t: 'pane.split', paneId: g.focusedPaneId, dir: 'row' }); })()`);
    await sleep(800);
    await openChat(E.SHOTS_SID2);
    await dock('files'); await sleep(1500);
    await png('split');
    await js(`(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); const p = Object.keys(g.panes).find((k) => g.panes[k].tiles.some((t) => t.sessionId === ${JSON.stringify(E.SHOTS_SID2)})); if (p) st.dispatchLayout({ t: 'pane.close', paneId: p }); })()`);
    await sleep(600);
  }
  await dockClose();
  // 需要你 at the top of the sidebar (the orange dot at the row's end, the spinner of the one still working) and the
  // waiting conversation open, its card docked above the box — the README's 「同时管理多个对话」, in place of the Overview
  if (want('permission')) {
    await reset(); await openChat(E.SHOTS_PERM_SID); await waitFor('!!document.querySelector(".pdock, .pdock-out")', 20_000); await sleep(1500); await png('permission');
  }
  if (want('settings')) {
    // 设置 › 模型 › 来源 (redesign 2026-11 stage 2: the settings dialog; the providers are the Models page's Sources tab)
    await reset(); await store("st.openSettings({ section: 'model', tab: 'sources' })"); await waitFor('!!document.querySelector(".modal.settings")', 5000); await sleep(1500);
    await png('settings'); await js('window.__store.setState({ settingsOpen: null })');
  }
  if (want('language')) {
    // 设置 › 外观: 语言 is the page's first row
    await reset(); await store("st.openSettings({ section: 'appearance' })"); await waitFor('!!document.querySelector(".modal.settings")', 5000); await sleep(1500);
    await png('language'); await js('window.__store.setState({ settingsOpen: null })');
  }
  // 字符画主题: the gallery with one card live under the pointer, then the start page in one of them
  if (want('themes')) {
    await reset(); await store("st.openSettings({ section: 'appearance', reveal: 'ui.theme' })"); await waitFor('!!document.querySelector(".theme-gallery")', 5000);
    await js(`(() => { const c = document.querySelector('.theme-gallery [data-theme-pick="ascii:moon"]'); c?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); c?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false })); })()`);
    await sleep(3000);
    await png('themes'); await js('window.__store.setState({ settingsOpen: null })');
  }
  if (want('theme-home')) {
    // a character theme's backdrop moves on the start page only with 外观 › 背景动画 on (off by default since redesign
    // 2026-11 stage 4: the page is a still colour otherwise); null after = back to the default (not "turned off")
    await reset(); await store("st.setSetting('ui.theme', 'ascii:koi')"); await store("st.setSetting('ui.backdropMotion', true)"); await newConv(); await sleep(4500);
    await png('theme-home'); await store("st.setSetting('ui.theme', 'dark')"); await store("st.setSetting('ui.backdropMotion', null)"); await sleep(800);
  }
  // 自动化 (redesign 2026-11 stage 1: the sidebar's entry; one tab row for 运行中 · 定时任务 · Bot · 目标 · 编排)
  if (want('automation')) { await reset(); await click('.sidebar .sb-nav [data-id="automation"]'); await sleep(800); await click('.over-page:not([hidden]) .fam-tabs [data-id="schedules"]'); await sleep(1600); await png('automation'); await closePages(); }
  if (want('background') || want('cafe') || want('characters')) {
    await reset(); await openChat(E.SHOTS_SID);
    const sid = JSON.stringify(E.SHOTS_SID);
    const scene = (nowOffsets) => `(() => { const now = Date.now(); const A = (key, color, label, phase, phaseTitle, state, o) => Object.assign({ key, color, label, phase, phaseTitle, state, model: 'claude-haiku-4-5', beats: state === 'running' ? [now - 30000, now - 9000, now - 2000] : [], agentId: state === 'queued' ? undefined : 'a' + key + '00000' }, o || {}); window.__cwBackground.inject({ sessionId: ${sid}, updatedAt: now, tasks: [ { id: 'wf1', toolUseId: 'tu-wf', kind: 'workflow', description: ${JSON.stringify(E.SHOTS_WF_DESC)}, name: ${JSON.stringify(E.SHOTS_WF_NAME)}, status: 'running', startedAt: now - 8 * 60000, phases: [{ index: 1, title: ${JSON.stringify(E.SHOTS_PH1)} }, { index: 2, title: ${JSON.stringify(E.SHOTS_PH2)} }], agents: [ A('w1', 1, 'api', 1, ${JSON.stringify(E.SHOTS_PH1)}, 'running', { lastSummary: ${JSON.stringify(E.SHOTS_S1)}, tokens: 41200 }), A('w2', 2, 'tests', 1, ${JSON.stringify(E.SHOTS_PH1)}, 'done', { lastSummary: ${JSON.stringify(E.SHOTS_S2)}, tokens: 18800 }), A('w3', 3, 'docs', 2, ${JSON.stringify(E.SHOTS_PH2)}, 'running', { lastSummary: ${JSON.stringify(E.SHOTS_S3)}, tokens: 9400 }), A('w4', 4, 'lint', 2, ${JSON.stringify(E.SHOTS_PH2)}, 'queued') ] }, { id: 'ag1', kind: 'agent', description: ${JSON.stringify(E.SHOTS_AG)}, status: 'running', backgrounded: true, startedAt: now - 3 * 60000, agents: [ A('ag1', 5, ${JSON.stringify(E.SHOTS_AG)}, undefined, undefined, 'running', { agentType: 'Explore', lastSummary: ${JSON.stringify(E.SHOTS_S4)}, tokens: 22000 }) ] }, { id: 'sh1', kind: 'shell', description: 'npm run dev', status: 'running', backgrounded: true, startedAt: now - 20 * 60000, agents: [] } ], events: [ { at: now - 5000, taskId: 'wf1', agent: 'w1', who: 'api', color: 1, text: ${JSON.stringify(E.SHOTS_S1)}, tone: 'tool' }, { at: now - 22000, taskId: 'wf1', agent: 'w2', who: 'tests', color: 2, text: ${JSON.stringify(E.SHOTS_S2)}, tone: 'tool' } ] }); })()`;
    await js(scene());
    // the composer's pill opens 自动化 › 运行中 on this conversation — on 列表 (redesign 2026-11: the groups of what each
    // conversation runs); the cafe is 列表 / 网吧 → 网吧 (remembered: set back to 列表 at the end)
    await click('.pane.focused .composer .bg-pill'); await sleep(2500);
    if (want('background')) await png('background');
    const toCafe = want('cafe') || want('characters');
    if (toCafe) await click('.bg-page .bg-runview [data-view="cafe"]');
    // the page must be visible for requestAnimationFrame to run (the canvas starts at 300×150 otherwise)
    if (toCafe) { await waitFor('!!document.querySelector(".bg-office-wrap:not([hidden]) canvas.office-canvas")', 8000); await sleep(2500); }
    if (want('cafe')) {
      let rect = await js(`(() => { const c = document.querySelector('.office canvas, canvas.office-canvas, .bg-stage canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
      if (rect) {
        // the tools overlay out of the way, and a little closer: the 3D hall's wheel zooms about the camera's target (the
        // whole hall's middle), not at the pointer; focusing zone A instead would aim at the row's middle and leave its
        // guests (PCs 0–3, the row's left end) under the zone list
        await js("(() => { const t = document.querySelector('.office-tools'); if (t) t.style.display = 'none'; })()");
        const at = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        await js(`(() => { const c = document.querySelector('.office-canvas'); for (let i = 0; i < ${Number(E.SHOTS_ZSTEPS || 3)}; i++) c.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, clientX: ${at.x}, clientY: ${at.y}, bubbles: true, cancelable: true })); })()`);
        await sleep(400);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x + 2, y: rect.y + 2 }); // no tooltip over the guests
        // (the wheel also scrolled the page: back to the top, and measure the canvas again)
        await js("(() => { for (let e = document.querySelector('.office-canvas'); e; e = e.parentElement) e.scrollTop = 0; })()");
        await sleep(600);
        rect = await js(`(() => { const c = document.querySelector('.office-canvas'); const r = c.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
        const dir = path.join(out, 'cafe-frames');
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        const frames = Number(E.SHOTS_FRAMES || 96);
        for (let i = 0; i < frames; i++) {
          const img = await win.webContents.capturePage(rect);
          fs.writeFileSync(path.join(dir, `f${String(i).padStart(4, '0')}.png`), img.toPNG());
          if (i % 24 === 23) await js(scene()); // keep the scene's beats fresh
          await sleep(55);
        }
        console.log('cafe frames', frames, JSON.stringify(rect));
      } else console.log('cafe: no canvas');
    }
    if (want('characters')) {
      // the character library dialog (the café page's 角色库 / Character library button), cropped to the dialog
      const opened = await js(`(() => { const b = [...document.querySelectorAll('.office-tools button')].find((x) => /角色库|Character library/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
      await sleep(1200);
      const box = opened ? await js(`(() => { const m = document.querySelector('.cafe-lib'); if (!m) return null; const r = m.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`) : null;
      if (box) await png('characters', box); else console.log('characters: no library dialog');
      key('Escape'); await sleep(300);
    }
    if (toCafe) { await click('.bg-page .bg-runview [data-view="list"]'); await sleep(300); }
    await closePages();
    // nothing runs any more (the phone's picture opens the same conversation: no pill over its box)
    await js(`window.__cwBackground.inject({ sessionId: ${sid}, updatedAt: Date.now(), tasks: [], events: [] })`); await sleep(300);
  }
  // a phone (redesign 2026-11 stage 4): the conversation page's head is ☰ · title · ⋯, the box sits at the bottom
  if (want('mobile')) {
    await reset(); await dockClose();
    win.setContentSize(392, 847); await sleep(1500);
    await openChat(E.SHOTS_SID); await sleep(2000);
    await png('mobile');
    win.setContentSize(1440, 900); await sleep(800);
  }
  app.exit(0);
}

// ------------------------------------------------------------------------------------------------------------ runner
// The throwaway HOME: on Windows not under %TEMP%, which is inside this machine's home folder (C:\Users\<name>\…): with
// CW_DEMO_WORK_IN_HOME=1 the demo's repos are in the HOME, and the permission card shows a path there — the user name
// would be in a README picture. A folder of each run's own under C:\cw-shots (removed after), else %TEMP%.
const SHOTS_ROOT = 'C:/cw-shots';
function shotsHome(lang) {
  if (process.platform === 'win32') {
    try { fs.mkdirSync(SHOTS_ROOT, { recursive: true }); return fs.mkdtempSync(`${SHOTS_ROOT}/${lang}-`); } catch { /* no write access to C:\ */ }
  }
  return demo.tmpHome(`cw-shots-${lang}-`);
}

async function runner() {
  const lang = String(arg('--lang', 'en'));
  if (!['en', 'zh'].includes(lang)) throw new Error('--lang en|zh');
  const out = path.resolve(String(arg('--out', path.join(demo.ROOT, 'docs', 'images', lang))));
  fs.mkdirSync(out, { recursive: true });
  const home = shotsHome(lang);
  const seed = demo.seedDemo(home, lang);
  // our engine's built-in `weixin` plugin can't connect in a throwaway HOME (never logged in) and would sit in the info
  // column's 连接器 as 「无法连接」: switched off with the engine's own setting (scripts/record-themes.cjs does the same)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'weixin@builtin': false } }, null, 2));
  const T = demo.TEXT[lang];
  const up = await demo.startUpstream(lang);
  const srv = await demo.startServer(home, { lang, shop: seed.shop });
  console.log(`server up (HOME=${home})`);
  const c = demo.client(srv.port, srv.token);
  await c.ready;
  await c.req({ kind: 'settings.set', key: 'network.proxy', value: 'off' });
  // one-time notes the pictures should not carry: the start page's 「东西搬到哪了」 card (it is for people who used the
  // old layout) and a phone's 「长按一条消息…」 toast
  await c.req({ kind: 'settings.set', key: 'ui.movedNoticeSeen', value: true });
  await c.req({ kind: 'settings.set', key: 'ui.hint.longPress', value: true });
  // …and the sidebar's quiet line 「把 Codex 等工具里的对话也列在这里？」 (it finds this machine's own CLIs): 以后再说
  for (const s of await c.req({ kind: 'library.sources' }).catch(() => [])) if (!s.joined && !s.dismissed) await c.req({ kind: 'library.dismiss', kind_: s.kind }).catch(() => {});
  const { spawn } = require('node:child_process');
  const electron = require(path.join(demo.ROOT, 'node_modules', 'electron'));
  const only = arg('--only', '');
  const run = (extra) => new Promise((res) => {
    const env = { ...process.env, SHOTS_URL: srv.url, SHOTS_OUT: out, SHOTS_LANG: lang, SHOTS_ONLY: only === true ? '' : String(only), SHOTS_SHOW: arg('--show', false) ? '1' : '', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', ...extra };
    delete env.ELECTRON_RUN_AS_NODE;
    const p = spawn(electron, [__filename], { env, stdio: 'inherit', windowsHide: false });
    const t = setTimeout(() => { p.kill(); res(-1); }, 900_000);
    p.on('exit', (cd) => { clearTimeout(t); res(cd); });
  });

  // 1) nothing connected yet
  await run({ SHOTS_PHASE: 'fresh' });
  // 2) a relay and DeepSeek connected, the projects added, two live conversations
  const prov = await c.req({ kind: 'providers.upsert', provider: { name: lang === 'zh' ? '中转' : 'Relay', type: 'anthropic', baseUrl: up.url, apiKey: 'sk-demo-not-real', defaultModel: 'claude-sonnet-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'], runtime: 'ccb' } });
  await c.req({ kind: 'providers.upsert', provider: { name: 'DeepSeek', type: 'openai', baseUrl: up.url, apiKey: 'sk-demo-not-real', defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'] } });
  await c.req({ kind: 'settings.set', key: 'defaultProviderId', value: prov.id });
  // the finished demo conversations ran on the relay: without it they would be the Claude account's, which is not
  // logged in here, and their box would say 「这个对话没有能用的模型来源」
  for (const sid of [seed.sid, ...seed.ids]) await c.req({ kind: 'session.setMeta', sessionId: sid, patch: { providerId: prov.id } });
  for (const p of [seed.shop, seed.notes, seed.blog]) await c.req({ kind: 'workspaces.add', path: p });
  await c.req({ kind: 'schedules.upsert', schedule: { name: T.schedules[0][0], cwd: seed.shop, prompt: T.schedules[0][1], everyMinutes: 1440, enabled: true } });
  const uuid = () => require('node:crypto').randomUUID();
  const o = await c.req({ kind: 'session.open', params: { cwd: seed.shop, providerId: prov.id, model: 'claude-sonnet-5-5', permissionMode: 'default' } });
  await c.req({ kind: 'session.send', params: { sessionId: o.sessionId, text: T.gitignore, uuid: uuid() } });
  const o2 = await c.req({ kind: 'session.open', params: { cwd: seed.notes, providerId: prov.id, model: 'claude-sonnet-5-5', permissionMode: 'default' } });
  await c.req({ kind: 'session.send', params: { sessionId: o2.sessionId, text: T.hang, uuid: uuid() } });
  await demo.sleep(6000);
  const bg = lang === 'zh'
    ? { WF_NAME: '结账模块重构', WF_DESC: '把结账模块拆成几块同时改', PH1: '改代码', PH2: '收尾', S1: '改了 cart.ts', S2: '补了 14 个测试', S3: '更新了 README', S4: '读了 12 个文件', AG: '查一下订单的数据结构' }
    : { WF_NAME: 'checkout-refactor', WF_DESC: 'Split the checkout module and change the parts at once', PH1: 'Change', PH2: 'Wrap up', S1: 'edited cart.ts', S2: 'wrote 14 tests', S3: 'updated the README', S4: 'read 12 files', AG: 'Look into the order data model' };
  const extra = { SHOTS_SHOP: seed.shop, SHOTS_SID: seed.sid, SHOTS_SID2: seed.ids[4], SHOTS_PERM_SID: o.sessionId, SHOTS_FRAMES: String(arg('--frames', 96)) };
  for (const [k, v] of Object.entries(bg)) extra[`SHOTS_${k}`] = v;
  const code = await run({ SHOTS_PHASE: 'main', ...extra });
  c.ws.close();
  // the HOME is removed at the end: the server has to let go of its files (memory.db) first — a short --only run
  // otherwise left its HOME behind under C:\cw-shots
  const gone = new Promise((r) => { if (srv.server.exitCode !== null || srv.server.signalCode) r(); else { srv.server.once('exit', r); setTimeout(r, 10_000); } });
  srv.server.kill();
  await gone;
  up.server.close();

  // the café frames → a GIF
  const frames = path.join(out, 'cafe-frames');
  if (fs.existsSync(frames) && fs.readdirSync(frames).length) {
    const { execFileSync } = require('node:child_process');
    const gif = path.join(out, 'cafe.gif');
    const w = 820;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '14', '-i', path.join(frames, 'f%04d.png'), '-vf', `scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', gif], { windowsHide: true });
    fs.rmSync(frames, { recursive: true, force: true });
    console.log(`wrote cafe.gif (${(fs.statSync(gif).size / 1024).toFixed(0)} KB)`);
  }
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch { /* a handle may still be held */ }
  seed.cleanup();
  if (process.platform === 'win32') try { fs.rmdirSync(SHOTS_ROOT); } catch { /* another run's HOME is in it, or it was never made */ }
  console.log(code === 0 ? 'done' : `electron exited ${code}`);
  process.exit(code === 0 ? 0 : 1);
}

if (process.versions.electron) driver().catch((e) => { console.error(e); process.exit(2); });
else runner().catch((e) => { console.error(e); process.exit(2); });
