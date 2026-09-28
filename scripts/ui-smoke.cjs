// UI smoke test: every settings section, every dock panel, the model menu and the welcome composer, driven in a
// real Chromium (Electron) against a throwaway server — and it FAILS on any console error / warning.
//
//   npm run build:all && node scripts/ui-smoke.cjs [--out <dir>] [--show] [--keep]
//   node scripts/ui-smoke.cjs --idle 180 [--live] [--activity] [--out <dir>]   # spawn-frequency measurement (CW_SPAWN_LOG)
//     --live      also opens a real engine session in the seeded repo (ccb / claude starts, no prompt is sent)
//     --activity  during the window, append to the seeded transcript every 5 s, edit a repo file every 10 s and
//                 run `git status` in the repo every 20 s (what a session working in the background looks like)
//   node scripts/ui-smoke.cjs --url "http://127.0.0.1:<port>/?token=…"  # an already running server (read-only phases)
//
// Plain `node` runs the orchestration half: temp HOME + CLAUDE_WEB_DIR (never the real ~/.claude / ~/.claude-web),
// a seeded git repo + one seeded Claude session (so the welcome page has a recent directory), the built server
// (server/dist), then Electron with this same file as its main script. Electron is a GUI app on Windows and prints
// nothing to a bash pipe, so the Electron half reports through a JSON file; options travel in env vars (an argv
// token containing ':' makes Electron treat the launch as "open URL" and exit 127).
//
// Output (default: <tmp>/cw-ui-smoke): ui-smoke.json (checks, console messages, idle window), ux-*.png
// screenshots, server.log. `--idle` adds spawn-summary.json (per-minute spawn counts and their sources).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const isElectronMain = !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE;
if (isElectronMain) driver();
else runner().catch((e) => { console.error(e.stack || e); process.exit(2); });

/* ------------------------------------------------------------------ orchestration (plain node) */

/** Section ids + labels straight from SettingsModal.tsx (`{ id: 'x', l: '…'`), panels from layout.ts PANELS. */
function uiInventory() {
  const settings = fs.readFileSync(path.join(ROOT, 'web/src/features/settings/SettingsModal.tsx'), 'utf8');
  const sections = [...settings.matchAll(/\{ id: '([\w.-]+)', l: '([^']+)', ic: '/g)].map((m) => ({ id: m[1], label: m[2] }));
  const layout = fs.readFileSync(path.join(ROOT, 'web/src/model/layout.ts'), 'utf8');
  const block = layout.slice(layout.indexOf('export const PANELS'), layout.indexOf('];', layout.indexOf('export const PANELS')));
  const panels = [...block.matchAll(/\{ id: '(\w+)', title: '([^']+)'/g)].map((m) => ({ id: m[1], title: m[2] }));
  if (!sections.length || !panels.length) throw new Error('could not read the settings sections / panels from the sources');
  return { sections, panels };
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

function seedHome(home) {
  const { execFileSync } = require('node:child_process');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# smoke repo\n');
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
  const git = (...a) => execFileSync('git', a, { cwd: repo, windowsHide: true, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid', GIT_COMMITTER_NAME: 'smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid' } });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'README.md'), '# smoke repo\n\nchanged\n'); // one modified file for the git badges
  // one finished Claude session in that repo (Claude Code's own transcript layout) → a recent directory
  const sid = '5a0e0e0e-0000-4000-8000-00000000c0de';
  const proj = path.join(home, '.claude', 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const t = new Date().toISOString();
  const base = { isSidechain: false, userType: 'external', cwd: repo, sessionId: sid, version: '2.1.281', gitBranch: 'master' };
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), [
    { ...base, parentUuid: null, type: 'user', message: { role: 'user', content: 'smoke: seeded session' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: t },
    { ...base, parentUuid: '00000000-0000-4000-8000-000000000001', type: 'assistant', message: { id: 'msg_smoke', type: 'message', role: 'assistant', model: 'claude-smoke', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, uuid: '00000000-0000-4000-8000-000000000002', timestamp: t },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  return { repo, sid, transcript: path.join(proj, `${sid}.jsonl`) };
}

async function startServer(home, out, extraEnv) {
  const { spawn } = require('node:child_process');
  const token = require('node:crypto').randomBytes(12).toString('hex');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', ...extraEnv };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(k)) delete env[k];
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
  return { server, url: `http://127.0.0.1:${port}/?token=${token}`, log: () => log };
}

function runElectron(env, timeoutMs) {
  const { spawn } = require('node:child_process');
  const electron = require(path.join(ROOT, 'node_modules', 'electron')); // the binary path when required from node
  const e = { ...process.env, ...env };
  delete e.ELECTRON_RUN_AS_NODE;
  e.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'; // Electron's dev-only CSP notice (never shown when packaged) is not an app error
  return new Promise((res) => {
    const c = spawn(electron, [__filename], { env: e, stdio: 'ignore', windowsHide: false });
    const t = setTimeout(() => { c.kill(); res(-1); }, timeoutMs);
    c.on('exit', (code) => { clearTimeout(t); res(code); });
  });
}

/** Per-minute spawn counts inside [from, to] of a CW_SPAWN_LOG file, with the top sources. */
function spawnSummary(file, from, to) {
  const recs = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  if (!from) from = recs.length ? recs[0].t : to; // "from the start of the log"
  const inWin = recs.filter((r) => r.t >= from && r.t <= to);
  const minutes = Math.max(1, (to - from) / 60_000);
  const by = {};
  for (const r of inWin) {
    const k = `${r.role} · ${path.basename(String(r.cmd))} ${(r.args || []).slice(0, 2).join(' ')} ← ${r.from}`;
    by[k] = (by[k] || 0) + 1;
  }
  const perMinute = [];
  for (let m = from; m < to; m += 60_000) perMinute.push(inWin.filter((r) => r.t >= m && r.t < m + 60_000).length);
  return { total: inWin.length, minutes: +minutes.toFixed(2), perMinute: +(inWin.length / minutes).toFixed(2), byMinute: perMinute, sources: Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ n, k })), allRecords: recs.length };
}

async function runner() {
  const out = path.resolve(String(arg('--out', path.join(os.tmpdir(), 'cw-ui-smoke'))));
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) if (/^(ux-.*\.png|ui-smoke\.json|spawn-summary\.json)$/.test(f)) fs.rmSync(path.join(out, f), { force: true });
  const idle = Number(arg('--idle', 0)) || 0;
  const live = !!arg('--live', false);
  const external = arg('--url', '');
  const inv = uiInventory();

  let home = null, srv = null, seed = null;
  const spawnLog = path.join(out, 'spawn-log.jsonl');
  if (external) {
    console.log(`using ${String(external).replace(/token=[^&]+/, 'token=…')} (read-only phases only)`);
  } else {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-smoke-'));
    seed = seedHome(home);
    if (idle) fs.rmSync(spawnLog, { force: true });
    srv = await startServer(home, out, idle ? { CW_SPAWN_LOG: '1', CW_SPAWN_LOG_FILE: spawnLog } : {});
    console.log(`server up (HOME=${home})`);
  }
  const result = path.join(out, 'ui-smoke.json');
  fs.rmSync(result, { force: true });
  const code = await runElectron({
    SMOKE_URL: external || srv.url,
    SMOKE_OUT: out,
    SMOKE_RESULT: result,
    SMOKE_MODE: idle ? 'idle' : 'smoke',
    SMOKE_IDLE: String(idle),
    SMOKE_LIVE: live ? '1' : '',
    SMOKE_ACTIVITY: arg('--activity', false) ? '1' : '',
    SMOKE_TRANSCRIPT: seed?.transcript ?? '',
    SMOKE_READONLY: external ? '1' : '',
    SMOKE_REPO: seed?.repo ?? '',
    SMOKE_SID: seed?.sid ?? '',
    SMOKE_SHOW: arg('--show', false) ? '1' : '',
    SMOKE_INVENTORY: JSON.stringify(inv),
  }, (idle + 240) * 1000);
  let r = null;
  try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { /* electron died */ }
  let failed = !r || code !== 0;
  if (r) {
    for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    const bad = r.console.filter((m) => !m.expected);
    console.log(`\nconsole errors/warnings: ${bad.length}${r.console.length !== bad.length ? ` (+${r.console.length - bad.length} expected from the crash probe)` : ''}`);
    for (const m of bad.slice(0, 40)) console.log(`  [${m.phase}] ${m.level}: ${m.message}`);
    if (bad.length || r.checks.some((c) => !c.ok)) failed = true;
    console.log(`screenshots: ${r.shots.length} in ${out}`);
    if (r.idle && idle) {
      const s = spawnSummary(spawnLog, r.idle.start, r.idle.end);
      const pre = spawnSummary(spawnLog, 0, r.idle.start); // server start → UI loaded → session opened → settled
      s.startup = { total: pre.total, sources: pre.sources.slice(0, 15) };
      fs.writeFileSync(path.join(out, 'spawn-summary.json'), JSON.stringify(s, null, 2));
      console.log(`\nstartup (server start → settled, before the window): ${pre.total} spawns`);
      for (const x of pre.sources.slice(0, 12)) console.log(`  ${String(x.n).padStart(4)}  ${x.k}`);
      console.log(`idle ${s.minutes} min: ${s.total} spawns = ${s.perMinute}/min  (per minute: ${s.byMinute.join(', ')})`);
      for (const x of s.sources.slice(0, 20)) console.log(`  ${String(x.n).padStart(4)}  ${x.k}`);
    }
  } else {
    console.log(`electron exited ${code} without a result (see ${result}.log)`);
  }
  if (srv) {
    // the crash probe must have reached the server log through client.log
    if (r && !external && idle === 0) {
      const ok = /\[web error\] 设置 · 模型: /.test(srv.log());
      console.log(`${ok ? 'PASS' : 'FAIL'} boundary error reached the server log (client.log)`);
      if (!ok) failed = true;
    }
    srv.server.kill();
    await new Promise((res) => setTimeout(res, 800));
  }
  if (home && !arg('--keep', false)) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ } }
  console.log(failed ? '\nUI SMOKE FAILED' : '\nUI smoke passed');
  process.exit(failed ? 1 : 0);
}

/* ------------------------------------------------------------------ Electron half */

function driver() {
  const { app, BrowserWindow } = require('electron');
  const E = process.env;
  const out = E.SMOKE_OUT;
  const logFile = `${E.SMOKE_RESULT}.log`;
  const log = (s) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`); } catch { /* ignore */ } };
  try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
  const inv = JSON.parse(E.SMOKE_INVENTORY);
  const res = { checks: [], console: [], shots: [], idle: null };
  let phase = 'load';
  let expectErrors = false;
  const check = (name, ok, detail) => { res.checks.push({ name, ok: !!ok, detail: detail || undefined }); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`); };
  const finish = (code) => { try { fs.writeFileSync(E.SMOKE_RESULT, JSON.stringify(res, null, 2)); } catch { /* ignore */ } app.exit(code); };
  process.on('uncaughtException', (e) => { log(`uncaught ${e.stack || e}`); check('driver', false, String(e.message || e)); finish(3); });
  const hardStop = setTimeout(() => { check('driver finished in time', false); finish(6); }, (Number(E.SMOKE_IDLE || 0) + 200) * 1000);

  app.whenReady().then(async () => {
    const show = E.SMOKE_SHOW === '1';
    const win = new BrowserWindow({ width: 1360, height: 860, show, webPreferences: { offscreen: !show, backgroundThrottling: false } });
    if (show) win.showInactive();
    const wc = win.webContents;
    wc.on('console-message', (a, b, c) => {
      const level = typeof a === 'object' && a && 'level' in a ? a.level : b;
      const message = typeof a === 'object' && a && 'message' in a ? a.message : c;
      const bad = level === 'error' || level === 'warning' || Number(level) >= 2;
      if (bad) res.console.push({ phase, level: String(level), message: String(message).slice(0, 800), expected: expectErrors || undefined });
    });
    wc.on('render-process-gone', (_e, d) => check('renderer alive', false, d.reason));
    wc.on('did-fail-load', (_e, code, desc) => check('page load', false, `${code} ${desc}`));
    const js = (code) => wc.executeJavaScript(code, true);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (code, ms = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(code).catch(() => false)) return true; await sleep(150); } return false; };
    const shot = async (name) => {
      try {
        const img = await wc.capturePage();
        const f = path.join(out, `ux-${name}.png`);
        fs.writeFileSync(f, img.toPNG());
        res.shots.push(f);
      } catch (e) { log(`shot ${name} failed: ${e.message}`); }
    };
    const click = async (selector) => {
      const r = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      if (!r) return null;
      wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
      wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await sleep(250);
      return r;
    };
    const key = async (keyCode) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); wc.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(200); };
    const noBoundary = (scope) => js(`[...document.querySelectorAll(${JSON.stringify(`${scope} .err-boundary`)})].map((e) => e.dataset.area + ': ' + e.querySelector('.eb-msg')?.textContent).join(' | ')`);

    try {
      await win.loadURL(E.SMOKE_URL);
      check('app mounted and connected', await waitFor('!!window.__store && window.__store.getState().connected && window.__store.getState().metaLoaded', 30_000));
      await sleep(1500);
      phase = 'onboarding';
      if (await js('!!document.querySelector(".modal.onboarding")')) {
        await shot('onboarding');
        if (E.SMOKE_READONLY !== '1') await js('window.__store.getState().setSetting("onboarded", true)');
        else await js('document.querySelector(".modal-bg")?.remove()');
        await sleep(400);
      }

      if (E.SMOKE_MODE === 'idle') {
        // a git-repo session in view (history → ContextRow / git status), optionally a live one (spawns the engine)
        phase = 'idle-setup';
        if (E.SMOKE_SID) { await js(`window.__store.getState().loadHistory(${JSON.stringify(E.SMOKE_SID)})`); await sleep(2000); }
        if (E.SMOKE_LIVE === '1' && E.SMOKE_REPO) {
          await js(`window.__store.getState().openSession({ cwd: ${JSON.stringify(E.SMOKE_REPO)}, providerId: 'claude' })`).catch((e) => log(`openSession: ${e.message}`));
        }
        // a second tile on the same session showing the workbench 文件 tab (git badges → useGitStatus)
        if (E.SMOKE_SID) {
          const sid = JSON.stringify(E.SMOKE_SID);
          await js(`(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); const paneId = Object.keys(g.panes).find((p) => g.panes[p].tiles.some((t) => t.kind === 'chat' && t.sessionId === ${sid})) || g.focusedPaneId; st.dispatchLayout({ t: 'pane.split', paneId, dir: 'row', tile: { id: 'smoke-files', kind: 'chat', sessionId: ${sid}, view: 'chat', wb: 'files' } }); })()`).catch((e) => log(`split: ${e.message}`));
        }
        await sleep(30_000); // let startup and the session settle before the measured window
        await shot('idle-start');
        phase = 'idle';
        res.idle = { start: Date.now(), end: 0 };
        const timers = [];
        if (E.SMOKE_ACTIVITY === '1') {
          let n = 0;
          timers.push(setInterval(() => {
            n++;
            const line = { isSidechain: false, userType: 'external', cwd: E.SMOKE_REPO, sessionId: E.SMOKE_SID, version: '2.1.281', parentUuid: null, type: 'assistant', message: { id: `msg_act_${n}`, type: 'message', role: 'assistant', model: 'claude-smoke', content: [{ type: 'text', text: `working ${n}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, uuid: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`, timestamp: new Date().toISOString() };
            try { fs.appendFileSync(E.SMOKE_TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch (e) { log(`append: ${e.message}`); }
          }, 5000));
          // the agent edits files (top level: the file tree watches depth 1) and runs `git status` now and then,
          // which refreshes .git/index → git.changed
          timers.push(setInterval(() => {
            try { fs.writeFileSync(path.join(E.SMOKE_REPO, 'README.md'), `# smoke repo\n\n${Date.now()}\n`); } catch (e) { log(`edit: ${e.message}`); }
          }, 10_000));
          timers.push(setInterval(() => {
            require('node:child_process').execFile('git', ['status', '--short'], { cwd: E.SMOKE_REPO, windowsHide: true }, () => {});
          }, 20_000));
        }
        await sleep(Number(E.SMOKE_IDLE) * 1000);
        for (const t of timers) clearInterval(t);
        res.idle.end = Date.now();
        await shot('idle-end');
        clearTimeout(hardStop);
        return finish(0);
      }

      // ---- welcome composer: a click in the text box types, nothing opens over it
      phase = 'welcome';
      check('welcome composer present', await waitFor('!!document.querySelector(".welcome .composer textarea")'));
      // redesign phase 1: one pane, one tab, no workbench setting → no global top bar, no group bar, no tab strip, no panel rail
      if (E.SMOKE_READONLY !== '1') {
        const chrome = await js('({ wb: window.__store.getState().settings["ui.workbench"], topbar: !!document.querySelector(".topbar"), groupbar: !!document.querySelector(".groupbar"), strips: document.querySelectorAll(".tabstrip").length, rail: !!document.querySelector(".dock-rail") })');
        check('default chrome: no top bar / group bar / tab strip / panel rail', chrome.wb === false && !chrome.topbar && !chrome.groupbar && !chrome.strips && !chrome.rail, JSON.stringify(chrome));
        const quota = await js('[...document.querySelectorAll(".quota")].every((q) => q.closest(".sb-foot"))');
        check('the quota ring lives in the sidebar bottom row', quota);
      }
      await shot('welcome');
      const leaks = await js(`[...document.querySelectorAll('.composer select')].filter((s) => { const p = s.closest('.chip, label, .dirpick') || s.parentElement; const a = s.getBoundingClientRect(), b = p.getBoundingClientRect(); return a.width > b.width + 2 || a.height > b.height + 2; }).map((s) => s.outerHTML.slice(0, 80))`);
      check('no invisible <select> larger than its chip', !leaks.length, leaks.join(' ; '));
      const at = await click('.welcome .composer textarea');
      const hit = at && await js(`(() => { const el = document.elementFromPoint(${at.x}, ${at.y}); return { hit: el && el.tagName, focused: document.activeElement && document.activeElement.tagName }; })()`);
      check('click on the welcome text box lands on the text box', hit && hit.hit === 'TEXTAREA' && hit.focused === 'TEXTAREA', JSON.stringify(hit));
      // typing saves the welcome draft on the server: not against somebody's running server (--url)
      if (E.SMOKE_READONLY !== '1') {
        wc.insertText('smoke：输入测试');
        await sleep(300);
        check('typing goes into the text box', await js('document.querySelector(".welcome .composer textarea").value.includes("输入测试")'));
      }
      check('no dropdown / menu open after clicking the text box', !(await js('!!document.querySelector(".menu.dirmenu, .menu.mm")')));
      await shot('welcome-click');
      if (E.SMOKE_READONLY !== '1') { wc.selectAll(); wc.delete(); await sleep(200); }

      // ---- working-directory chip: our own menu, only from the chip
      phase = 'dirpicker';
      if (E.SMOKE_REPO) {
        await click('.welcome .dirpick');
        const listed = await js(`[...document.querySelectorAll('.menu.dirmenu [data-dir]')].map((b) => b.dataset.dir)`);
        check('directory chip opens the directory menu', listed.includes(E.SMOKE_REPO), JSON.stringify(listed));
        const inside = '(() => { const m = document.querySelector(".menu.dirmenu"); if (!m) return "closed"; const r = m.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth - 8 && r.bottom <= innerHeight ? true : JSON.stringify({ left: r.left, right: r.right, vw: innerWidth }); })()';
        check('directory menu stays inside the window', (await js(inside)) === true);
        await shot('dirmenu');
        win.setSize(620, 860); // narrower window while the menu is open: its width must follow
        await sleep(700);
        const narrow = await js(inside);
        check('directory menu stays inside a window narrowed while it is open', narrow === true, String(narrow));
        win.setSize(1360, 860);
        await sleep(700);
        const focused = () => js('(() => { const a = document.activeElement; return a ? (a.dataset.dir ? "row" : a.classList.contains("dirpick") ? "chip" : a.textContent.trim()) : null; })()');
        await key('End');
        const atEnd = await focused();
        await key('Home');
        const atHome = await focused();
        check('Home / End move to the first / last entry', atHome === 'row' && /浏览文件夹/.test(atEnd), `${atHome} / ${atEnd}`);
        await key('Tab');
        check('Tab closes the directory menu and focus returns to the chip', !(await js('!!document.querySelector(".menu.dirmenu")')) && (await focused()) === 'chip');
        await click('.welcome .dirpick');
        await key('Escape');
        check('Esc closes the directory menu', !(await js('!!document.querySelector(".menu.dirmenu")')) && (await focused()) === 'chip');
      }

      // ---- model menu
      phase = 'model-menu';
      await click('.welcome .mm-anchor > button.chip');
      check('model menu opens', await waitFor('!!document.querySelector(".menu.mm")', 5000));
      await sleep(600);
      await shot('model-menu');
      check('model menu without error boundary', !(await noBoundary('body')), await noBoundary('body'));
      await key('Escape');
      await sleep(200);

      // ---- every settings section
      for (const s of inv.sections) {
        phase = `settings:${s.id}`;
        await js(`window.__store.getState().openSettings({ section: ${JSON.stringify(s.id)} })`);
        const opened = await waitFor(`document.querySelector('.modal.settings .set-head h3')?.textContent === ${JSON.stringify(s.label)}`, 5000);
        await sleep(1500); // requests the section fires on mount
        const err = await noBoundary('.modal.settings');
        check(`settings · ${s.label}`, opened && !err, err || (opened ? '' : 'section did not open'));
        await shot(`settings-${s.id}`);
      }
      await js('window.__store.setState({ settingsOpen: null })');
      await sleep(300);

      // ---- every dock panel
      for (const p of inv.panels) {
        if (E.SMOKE_READONLY === '1' && p.id === 'terminal') continue; // would start a pty on that server
        phase = `panel:${p.id}`;
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: ${JSON.stringify(p.id)} })`);
        const shown = await waitFor(`!!document.querySelector('.dock .dock-tabs .tab.active') && document.querySelector('.dock .dock-tabs .tab.active .t')?.textContent === ${JSON.stringify(p.title)}`, 5000);
        await sleep(1500);
        const err = await noBoundary('.dock');
        check(`panel · ${p.title}`, shown && !err, err || (shown ? '' : 'panel did not open'));
        await shot(`panel-${p.id}`);
      }

      // ---- hiding the right panel (Ctrl+J / the header button) is CSS: the terminal keeps its pty and buffer
      if (E.SMOKE_READONLY !== '1') {
        phase = 'dock-hide';
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'terminal' })`);
        const term = await waitFor('!!document.querySelector(".dock .xterm")', 8000);
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
        await sleep(400);
        const kept = await js('!!document.querySelector(".dock .xterm") && document.querySelector(".rpanel").offsetWidth === 0');
        check('hiding the right panel keeps the terminal mounted', term && kept, JSON.stringify({ term, kept }));
      }

      // ---- a seeded session in a pane (chat tile, session header, git badges)
      if (E.SMOKE_SID) {
        phase = 'session';
        await js(`window.__store.getState().loadHistory(${JSON.stringify(E.SMOKE_SID)})`);
        check('seeded session renders', await waitFor('!!document.querySelector(".composer textarea") && !document.querySelector(".welcome")', 10_000));
        await sleep(1500);
        const err = await noBoundary('body');
        check('session tile without error boundary', !err, err);
        await shot('session');

        // ---- redesign phase 1: one ≤ 52px row above the conversation; the workbench tabs live in ···
        phase = 'session-chrome';
        const head = await js(`(() => { const p = document.querySelector('.pane.focused') || document.querySelector('.pane'); const h = p && p.querySelector('.sess-head'); const c = p && p.querySelector('.chat'); if (!h || !c) return null; const pr = p.getBoundingClientRect(); return { h: Math.round(h.getBoundingClientRect().height), above: Math.round(c.getBoundingClientRect().top - pr.top), strips: p.querySelectorAll('.tabstrip').length, wbTabs: !!document.querySelector('.wb-tabs') }; })()`);
        check('one header row above the conversation (≤ 52px, no tab strip, no workbench tab row)', head && head.h <= 52 && head.above <= 53 && !head.strips && !head.wbTabs, JSON.stringify(head));
        await click('.sess-head .sh-more > button');
        const views = await js(`[...document.querySelectorAll('.menu.sess-menu [data-view]')].map((b) => b.dataset.view)`);
        check('··· lists every workbench view', ['changes', 'git', 'files', 'search', 'schedules', 'artifacts', 'board'].every((v) => views.includes(v)), JSON.stringify(views));
        await shot('session-menu');
        await click('.menu.sess-menu [data-view="files"]');
        const inView = await waitFor('!!document.querySelector(".pane.focused .wb-body") && !!document.querySelector(".pane.focused .sh-view")', 4000);
        await click('.pane.focused .sh-view');
        const back = await waitFor('!!document.querySelector(".pane.focused .chat") && !document.querySelector(".pane.focused .sh-view")', 4000);
        check('a view opens from ··· and the header pill returns to the conversation', inView && back);

        // collapsed sidebar: the centre takes the whole width and the header's first button brings the sidebar back
        await js('window.__store.setState({ sidebarOpen: false })');
        await sleep(500);
        const collapsed = await js(`(() => { const c = document.querySelector('.center').getBoundingClientRect(); return { left: Math.round(c.left), reveal: !!document.querySelector('.pane .sess-head > .sb-reveal') }; })()`);
        check('collapsed sidebar: the centre starts at the window edge, the header shows 展开侧栏', collapsed.left === 0 && collapsed.reveal, JSON.stringify(collapsed));
        await click('.pane .sess-head > .sb-reveal');
        const reopened = await waitFor(`!!document.querySelector('.sidebar.has-resizer') && Math.round(document.querySelector('.center').getBoundingClientRect().left) === Math.round(document.querySelector('.sidebar.has-resizer').getBoundingClientRect().right) && !document.querySelector('.sb-reveal')`, 4000);
        check('展开侧栏 brings the sidebar back beside the centre', reopened);

        // Ctrl+D: the split brings the tab strips; closing the split takes them away again
        const strips = () => js('document.querySelectorAll(".pane .tabstrip").length');
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'D', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'D', modifiers: ['control'] });
        const split = await waitFor('document.querySelectorAll(".pane").length === 2 && document.querySelectorAll(".pane .tabstrip").length === 2', 4000);
        check('Ctrl+D splits and both panes get a tab strip', split, `strips ${await strips()}`);
        await shot('split');
        await click('.pane.focused .tabstrip button[aria-label="关闭这个分屏"]');
        const merged = await waitFor('document.querySelectorAll(".pane").length === 1 && document.querySelectorAll(".pane .tabstrip").length === 0', 4000);
        check('closing the split hides the tab strip again', merged, `strips ${await strips()}`);

        // 「显示工作台工具」 brings everything back; off hides it again
        if (E.SMOKE_READONLY !== '1') {
          await js('window.__store.getState().setSetting("ui.workbench", true)');
          const on = await waitFor('!!document.querySelector(".groupbar") && !!document.querySelector(".dock-rail") && document.querySelectorAll(".pane .tabstrip").length === 1', 4000);
          check('workbench tools on: group bar, panel rail and tab strip', on);
          await shot('workbench');
          await js('window.__store.getState().setSetting("ui.workbench", false)');
          const off = await waitFor('!document.querySelector(".groupbar") && !document.querySelector(".dock-rail") && !document.querySelector(".pane .tabstrip")', 4000);
          check('workbench tools off: back to one row', off);
        }

        // ---- review fixes (phase 0–1)
        phase = 'session-review';
        const paneTiles = `(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); const p = g.panes[g.focusedPaneId]; return p.tiles.map((t) => t.kind === 'chat' ? 'chat:' + (t.sessionId || 'new') : t.kind + ':' + t.id).join(',') + '|' + p.activeTileId; })()`;
        // header ··· hands over straight away: the agents (or the note that there are none) are in the menu itself
        await click('.sess-head .sh-more > button');
        const handoff = await js(`(() => { const m = document.querySelector('.menu.sess-menu'); if (!m) return null; return { label: [...m.querySelectorAll('.menu-label')].some((l) => l.textContent.includes('交给')), nested: !!m.querySelector('button[aria-expanded]') }; })()`);
        check('header ··· lists the hand-over agents directly (no sub-menu)', handoff && handoff.label && !handoff.nested, JSON.stringify(handoff));
        await js('document.body.click()');
        await sleep(200);
        // right panel minimized to its icon strip: the header button brings it back
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'tasks' }); window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { minimized: true } })`);
        await sleep(300);
        const expandBtn = await js(`!!document.querySelector('.sess-head button[aria-label="展开右侧面板"]')`);
        await click('.sess-head button[aria-label="展开右侧面板"]');
        const expanded = await waitFor('window.__store.getState().layout.dock.open && !window.__store.getState().layout.dock.minimized', 3000);
        check('minimized right panel: the header button says 展开 and expands it', expandBtn && expanded, JSON.stringify({ expandBtn, expanded }));
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
        if (E.SMOKE_READONLY !== '1') {
          // 新对话 (Alt+N) with a terminal in front: a new tab next to it, the terminal tile is untouched
          await js(`window.__store.getState().openTile({ id: 'smoke-term', kind: 'term', cwd: ${JSON.stringify(E.SMOKE_REPO || '')} }, 'tab')`);
          await waitFor('!!document.querySelector(".pane.focused .xterm")', 8000);
          wc.focus();
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['alt'] });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['alt'] });
          await sleep(500);
          const tiles = await js(paneTiles);
          check('新对话 with a terminal in front opens a tab beside it (the terminal is not replaced)', /^chat:[^,]+,term:smoke-term,chat:new\|/.test(tiles), tiles);
          await js(`(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); const p = g.panes[g.focusedPaneId]; for (const t of p.tiles.slice(1)) st.dispatchLayout({ t: 'tile.close', paneId: p.id, tileId: t.id }); })()`);
          await sleep(300);
          check('back to the conversation alone', /^chat:[^,]+\|/.test(await js(paneTiles)), await js(paneTiles));

          // phone width with the workbench tools on: still one row, 展开侧栏 opens the drawer, settings are reachable
          phase = 'phone';
          await js('window.__store.getState().setSetting("ui.workbench", true)');
          win.setContentSize(740, 860);
          const phone = await waitFor('document.querySelector(".app").classList.contains("mobile") && !document.querySelector(".groupbar") && !document.querySelector(".pane .tabstrip")', 4000);
          const phoneHead = await js(`(() => { const h = document.querySelector('.pane .sess-head'); if (!h) return null; return { reveal: !!h.querySelector('.sb-reveal'), diff: !!h.querySelector('.sh-diff'), term: !!h.querySelector('button[aria-label="终端"]'), panel: !!h.querySelector('button[aria-label="右侧面板"], button[aria-label="展开右侧面板"]'), more: !!h.querySelector('.sh-more > button') }; })()`);
          check('phone + workbench tools: no group bar / tab strip; header has 展开侧栏 and ··· but no 改动 / 终端 / 右侧面板', phone && phoneHead && phoneHead.reveal && phoneHead.more && !phoneHead.diff && !phoneHead.term && !phoneHead.panel, JSON.stringify({ phone, phoneHead }));
          await shot('phone-workbench');
          await click('.pane .sess-head .sb-reveal');
          const drawer = await waitFor('document.querySelector(".app").classList.contains("drawer-open") && !!document.querySelector(".sidebar.has-resizer")', 3000);
          check('phone: 展开侧栏 opens the sidebar drawer', drawer);
          await shot('phone-drawer');
          const drawerParts = await js(`({ nav: [...document.querySelectorAll('.sidebar .sb-nav [data-id]')].map((e) => e.dataset.id), account: !!document.querySelector('.sidebar .sb-account [data-id="account"]') })`);
          check('phone: the drawer is the same sidebar (新对话 / 搜索 / 自动化, account row)', ['new', 'search', 'automation'].every((x) => drawerParts.nav.includes(x)) && drawerParts.account, JSON.stringify(drawerParts));
          await click('.sidebar .sb-account [data-id="settings"]');
          const settings = await waitFor('!!document.querySelector(".modal.settings")', 3000);
          check('phone: settings open from the sidebar (account row gear)', settings);
          await js('window.__store.setState({ settingsOpen: null, sidebarOpen: false })');
          const before = await js('JSON.stringify(window.__store.getState().layout.dock)');
          await js(`window.__store.getState().togglePanel('terminal')`);
          const after = await js('JSON.stringify(window.__store.getState().layout.dock)');
          check('phone: a panel toggle opens nothing behind the screen', before === after, after);
          win.setContentSize(1360, 860);
          await js('window.__store.getState().setSetting("ui.workbench", false)');
          await waitFor('!document.querySelector(".app").classList.contains("mobile") && !document.querySelector(".groupbar")', 4000);
          await sleep(300);
        }
        const err2 = await noBoundary('body');
        check('session chrome checks without error boundary', !err2, err2);

        // ---- redesign phase 4: the sidebar — every entry point of the old one is still reachable
        // (ids from web/src/features/sidebar/entries.ts; menus are checked by what they list, not by how they look)
        phase = 'sidebar';
        const SID = JSON.stringify(E.SMOKE_SID);
        const ids = (sel) => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.dataset.id)`);
        const has = (list, want) => want.every((x) => list.includes(x));
        const closeMenus = async () => { await js('document.body.click()'); await sleep(250); };
        await js('window.__store.setState({ sidebarOpen: true })'); // the phone phase closed it
        await waitFor('!!document.querySelector(".sidebar .sb-nav")', 3000);
        await sleep(300);
        const ctxMenu = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 8, button: 2 })); return true; })()`);
        const sb = await js(`({ chipRows: !!document.querySelector('.sidebar .sb-sources, .sidebar .src-chip, .sidebar .sb-search, .sidebar .lib-banner'), top: [...document.querySelectorAll('.sidebar .sb-top [data-id], .sidebar .sb-nav [data-id]')].map((e) => e.dataset.id), head: [...document.querySelectorAll('.sidebar [data-id="projects"] > .sb-sec-h [data-id]')].map((e) => e.dataset.id), account: [...document.querySelectorAll('.sidebar .sb-account [data-id]')].map((e) => e.dataset.id), row: !!document.querySelector('.sidebar .sb-list [data-sid=' + ${JSON.stringify(SID)} + '] [data-id="status"]') })`);
        check('sidebar: no chip / filter-box rows; 新对话 · 搜索 · 自动化; funnel + 打开文件夹 on 项目; account row (connection, settings); the row ends in one status',
          !sb.chipRows && has(sb.top, ['collapse', 'new', 'search', 'automation']) && has(sb.head, ['filter', 'add-project']) && has(sb.account, ['account', 'connection', 'settings']) && sb.row, JSON.stringify(sb));
        await shot('sidebar');
        // the funnel: sources, machines (when there are other machines), archived, multi-select, the filter box
        await click('.sidebar [data-id="filter"]');
        const fm = await ids('.menu.sb-filter [data-id]');
        const fmIn = await js('(() => { const m = document.querySelector(".menu.sb-filter"); if (!m) return false; const r = m.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()');
        check('funnel menu: filter box, sources, 显示已归档, 选择多个, 管理对话来源 — inside the window', has(fm, ['query', 'source', 'archived', 'select', 'library']) && fmIn, JSON.stringify({ fm, fmIn }));
        await shot('sidebar-filter');
        if (E.SMOKE_READONLY !== '1') {
          wc.insertText('zzz-no-such-conversation');
          await sleep(400);
          const filtered = await js('({ summary: document.querySelector(".sidebar .sb-filtered .what")?.textContent || "", rows: document.querySelectorAll(".sidebar .sb-list .sb-row").length })');
          check('the filter box filters the list and the list says it is filtered', filtered.rows === 0 && filtered.summary.includes('zzz-no-such'), JSON.stringify(filtered));
          await closeMenus();
          await click('.sidebar .sb-filtered .link');
          check('清除 brings the list back', await waitFor(`!document.querySelector('.sidebar .sb-filtered') && !!document.querySelector('.sidebar .sb-list [data-sid=' + ${JSON.stringify(SID)} + ']')`, 3000));
        }
        await closeMenus();
        // 自动化 → the schedules / goals / orchestration panels (until the automation page)
        await click('.sidebar [data-id="automation"]');
        const am = await ids('.menu.sb-auto-menu [data-id]');
        check('自动化 lists 定时任务 / 目标 / 编排', has(am, ['schedules', 'goals', 'orchestra']), JSON.stringify(am));
        await click('.menu.sb-auto-menu [data-id="goals"]');
        check('自动化 → 目标 shows the goals panel', await waitFor(`(() => { const d = window.__store.getState().layout.dock; return d.open && d.active === 'goals'; })()`, 3000));
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
        // the account row: quota, today's spend, usage & ledger, the config panel, appearance, shortcuts, palette
        await click('.sidebar [data-id="account"]');
        const acc = await ids('.menu.sb-acct-menu [data-id]');
        check('account popover: 今日费用, 用量与账本, 配置中心, 外观, 快捷键, 命令面板', has(acc, ['today', 'usage', 'config', 'appearance', 'shortcuts', 'palette']), JSON.stringify(acc));
        await shot('sidebar-account');
        await closeMenus();
        // the conversation menu (right-click = ···): every session action, by capability
        await ctxMenu(`.sidebar .sb-list [data-sid=${SID}]`);
        await sleep(300);
        const rm = await ids('.menu.sess-menu [data-id]');
        check('conversation right-click menu: open in tab / split, resume, pin, folder, VS Code, reference, rename, fork, archive, hand-over, native CLI, copy id, delete',
          has(rm, ['open-tab', 'open-split', 'resume', 'pin', 'explorer', 'vscode', 'reference', 'rename', 'fork', 'archive', 'handoff', 'native-cli', 'copy-id', 'delete']), JSON.stringify(rm));
        await shot('sidebar-row-menu');
        if (E.SMOKE_READONLY !== '1') {
          await click('.menu.sess-menu [data-id="pin"]');
          check('置顶 moves the conversation into the 置顶 section', await waitFor(`!!document.querySelector('.sidebar [data-group="__pinned"] [data-sid=' + ${JSON.stringify(SID)} + ']')`, 4000));
          await js(`window.__store.getState().setSessionMeta(${SID}, { pinned: false })`);
          await waitFor(`!document.querySelector('.sidebar [data-group="__pinned"]')`, 4000);
          // a project: its right-click menu has everything the old workspace ··· had
          await js(`window.__store.getState().addWorkspace(${JSON.stringify(E.SMOKE_REPO)})`);
          const proj = await waitFor(`!!document.querySelector('.sidebar [data-id="projects"] .sb-group [data-sid=' + ${JSON.stringify(SID)} + ']')`, 5000);
          await ctxMenu(`.sidebar [data-id="projects"] .sb-group:has([data-sid=${SID}]) .sb-group-head`);
          await sleep(300);
          const pm = await ids('.menu.sb-menu[aria-label^="项目"] [data-id]');
          check('a project (opened folder) groups its conversations; its menu: new here, worktree, terminal, rename, folder, VS Code, remove', proj && has(pm, ['new-here', 'worktree', 'terminal', 'rename', 'explorer', 'vscode', 'remove']), JSON.stringify({ proj, pm }));
          await closeMenus();
          // 需要你: a conversation waiting for a permission shows there and at its row's end (the request is faked client-side)
          await js(`window.__store.setState((s) => { const o = s.open[${SID}]; return o ? { open: { ...s.open, [${SID}]: { ...o, state: 'waiting', pending: [{ requestId: 'smoke-fake', sessionId: ${SID}, toolName: 'Bash', input: { command: 'echo smoke' } }] } } } : {}; })`);
          const attn = await waitFor(`(() => { const a = document.querySelector('.sidebar [data-id="attention"] [data-sid=' + ${JSON.stringify(SID)} + '] [data-id="status"]'); const r = document.querySelector('.sidebar .sb-list [data-sid=' + ${JSON.stringify(SID)} + '] [data-id="status"]'); return !!a && a.textContent === '待确认' && r && r.textContent === '待确认'; })()`, 3000);
          check('需要你 lists a conversation waiting for a permission; its row ends in 待确认', attn);
          await shot('sidebar-needs-you');
          await js(`window.__store.setState((s) => { const o = s.open[${SID}]; return o ? { open: { ...s.open, [${SID}]: { ...o, state: 'history', pending: [] } } } : {}; })`);
          check('需要你 disappears when nothing waits', await waitFor('!document.querySelector(\'.sidebar [data-id="attention"]\')', 3000));
        }
        // Shift-click starts multi-select (batch archive / delete); Esc ends it
        const rowAt = await js(`(() => { const el = document.querySelector('.sidebar .sb-list [data-sid=' + ${JSON.stringify(SID)} + '] .t'); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }; })()`);
        if (rowAt) {
          wc.sendInputEvent({ type: 'mouseDown', x: rowAt.x, y: rowAt.y, button: 'left', clickCount: 1, modifiers: ['shift'] });
          wc.sendInputEvent({ type: 'mouseUp', x: rowAt.x, y: rowAt.y, button: 'left', clickCount: 1, modifiers: ['shift'] });
          await sleep(300);
        }
        const selOn = await js('({ bar: !!document.querySelector(".sidebar .sel-bar"), checked: document.querySelectorAll(".sidebar .sb-list .sel-box:checked").length })');
        await shot('sidebar-select');
        await key('Escape');
        const selOff = await js('!document.querySelector(".sidebar .sel-bar") && !document.querySelector(".sidebar .sel-box")');
        check('Shift-click starts multi-select with that row checked; Esc ends it', selOn.bar && selOn.checked >= 1 && selOff, JSON.stringify({ selOn, selOff }));
        const err3 = await noBoundary('.sidebar');
        check('sidebar checks without error boundary', !err3, err3);
      }

      // ---- error boundary probe: a crash in one settings section stays in that section, 重试 recovers it
      if (E.SMOKE_READONLY !== '1') {
        phase = 'crash-probe';
        await js('window.__store.getState().openSettings({ section: "models" })');
        await sleep(800);
        expectErrors = true;
        await js('window.__cwCrash("设置 · 模型")');
        const caught = await waitFor('!!document.querySelector(\'.modal.settings .err-boundary[data-area="设置 · 模型"]\')', 5000);
        const rest = await js('!!document.querySelector(".modal.settings .set-nav") && !!document.querySelector(".sidebar")');
        check('boundary catches a crash in its own section only', caught && rest);
        await shot('crash-boundary');
        await js('document.querySelector(\'.modal.settings .err-boundary[data-area="设置 · 模型"] .eb-actions .btn\').click()');
        await sleep(600);
        expectErrors = false;
        check('重试 remounts the section', !(await js('!!document.querySelector(".modal.settings .err-boundary")')));
        await js('window.__store.setState({ settingsOpen: null })');
        await sleep(1500); // let the client.log request land
      }
    } catch (e) {
      check('driver', false, e.stack || String(e));
    }
    clearTimeout(hardStop);
    finish(0);
  });
}
