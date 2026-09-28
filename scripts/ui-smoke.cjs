// UI smoke test: every settings section, every dock panel, the model menu and the welcome composer (its one row at
// 1440 / 1024 / 760, the + / permission / project menus, every control the old composer had — see
// web/src/features/composer/reach.ts), driven in a real Chromium (Electron) against a throwaway server — and it
// FAILS on any console error / warning.
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

/**
 * Settings pages straight from features/settings/catalog.ts (`id: 'x', l: '…', ic: '…', group: '…'`, their tabs
 * `{ id: 't', l: …, bodies: […], more: […] }`, the rows of the entry tables, and the old-id aliases of
 * LEGACY_SECTIONS), panels from layout.ts PANELS. `pages`: every page / tab with its parts and what 更多选项 holds.
 */
function uiInventory() {
  const cat = fs.readFileSync(path.join(ROOT, 'web/src/features/settings/catalog.ts'), 'utf8');
  const list = cat.slice(cat.indexOf('export const SETTINGS_SECTIONS'), cat.indexOf('export const VISIBLE_SECTIONS'));
  const ids = (x) => [...String(x || '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
  // entry tables: `const GENERAL: EntryMeta[] = [ { id: 'x', more: true, … }, … ];`
  const tables = {};
  for (const m of cat.matchAll(/const (\w+): EntryMeta\[\] = \[([\s\S]*?)\n\];/g)) {
    tables[m[1]] = [...m[2].matchAll(/\{ id: '([\w.]+)', (more: true)?/g)].map((e) => ({ id: e[1], more: !!e[2] }));
  }
  const sections = [...list.matchAll(/id: '([\w.-]+)', l: '([^']+)', ic: '\w+', group: '(\w+)'(, advanced: true)?/g)].map((m) => ({ id: m[1], label: m[2], group: m[3], advanced: !!m[4], at: m.index, tabs: [], pages: [] }));
  for (const [i, s] of sections.entries()) {
    const text = list.slice(s.at, i + 1 < sections.length ? sections[i + 1].at : list.length);
    const entries = tables[(/entries: (\w+)/.exec(text) || [])[1]] || [];
    const moreEntries = entries.filter((e) => e.more).map((e) => e.id);
    const tabs = [...text.matchAll(/\{ id: '(\w+)', l: [^,]+, bodies: \[([^\]]*)\](?:, more: \[([^\]]*)\])?/g)];
    if (tabs.length) {
      for (const t of tabs) { s.tabs.push(t[1]); s.pages.push({ tab: t[1], bodies: ids(t[2]), more: ids(t[3]), moreEntries }); }
    } else {
      const own = /bodies: \[([^\]]*)\](?:, more: \[([^\]]*)\])?/.exec(text);
      s.pages.push({ tab: '', bodies: ids(own && own[1]), more: ids(own && own[2]), moreEntries });
    }
  }
  const legacy = cat.slice(cat.indexOf('export const LEGACY_SECTIONS'), cat.indexOf('};', cat.indexOf('export const LEGACY_SECTIONS')));
  const aliases = [...legacy.matchAll(/(\w+): \{ section: '(\w+)'(?:, tab: '(\w+)')?(, more: true)?(?:, body: '(\w+)')? \}/g)].map((m) => ({ old: m[1], section: m[2], tab: m[3] || '', more: !!m[4], body: m[5] || '' }));
  const layout = fs.readFileSync(path.join(ROOT, 'web/src/model/layout.ts'), 'utf8');
  const block = layout.slice(layout.indexOf('export const PANELS'), layout.indexOf('];', layout.indexOf('export const PANELS')));
  const panels = [...block.matchAll(/\{ id: '(\w+)', title: '([^']+)'/g)].map((m) => ({ id: m[1], title: m[2] }));
  const withMore = sections.flatMap((s) => s.pages.filter((p) => p.more.length || p.moreEntries.length));
  if (sections.length < 15 || aliases.length < 5 || !panels.length || !sections.some((s) => s.tabs.length) || withMore.length < 5 || !aliases.some((a) => a.more)) throw new Error('could not read the settings pages / 更多选项 / aliases / panels from the sources');
  // the sidebar's entry ids by place (web/src/features/sidebar/entries.ts PLACES): the sidebar phase must find each in the DOM
  const sbSrc = fs.readFileSync(path.join(ROOT, 'web/src/features/sidebar/entries.ts'), 'utf8');
  const lists = Object.fromEntries([...sbSrc.matchAll(/export const (\w+) = \[([^\]]*)\] as const;/g)].map((m) => [m[1], [...m[2].matchAll(/'([\w-]+)'/g)].map((x) => x[1])]));
  const placesAt = sbSrc.indexOf('export const PLACES');
  const sidebar = Object.fromEntries([...sbSrc.slice(placesAt, sbSrc.indexOf('} as const;', placesAt)).matchAll(/(\w+): ([A-Z_]+)\b/g)].map((m) => [m[1], lists[m[2]]]));
  if (Object.keys(sidebar).length < 8 || Object.values(sidebar).some((v) => !v || !v.length)) throw new Error('could not read the sidebar PLACES from entries.ts');
  return { sections: sections.map(({ at, ...s }) => s), aliases, panels, sidebar };
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
  }, (idle + 400) * 1000);
  let r = null;
  try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { /* electron died */ }
  let failed = !r || code !== 0;
  if (r) {
    for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    const bad = r.console.filter((m) => !m.expected);
    console.log(`\nconsole errors/warnings: ${bad.length}${r.console.length !== bad.length ? ` (+${r.console.length - bad.length} expected from the crash probe)` : ''}`);
    for (const m of bad.slice(0, 40)) console.log(`  [${m.phase}] ${m.level}: ${m.message}`);
    if (bad.length || r.checks.some((c) => !c.ok)) failed = true;
    console.log(`screenshots: ${r.shots.length} in ${out}${r.seconds ? ` (driver: ${r.seconds} s)` : ""}`);
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
      const ok = /\[web error\] 设置 · 模型与智能程度: /.test(srv.log());
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
  const res = { checks: [], console: [], shots: [], idle: null, startedAt: Date.now(), seconds: 0 };
  let phase = 'load';
  let expectErrors = false;
  const check = (name, ok, detail) => { res.checks.push({ name, ok: !!ok, detail: detail || undefined }); log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`); };
  const finish = (code) => { res.seconds = Math.round((Date.now() - res.startedAt) / 1000); try { fs.writeFileSync(E.SMOKE_RESULT, JSON.stringify(res, null, 2)); } catch { /* ignore */ } app.exit(code); };
  process.on('uncaughtException', (e) => { log(`uncaught ${e.stack || e}`); check('driver', false, String(e.message || e)); finish(3); });
  // the right-panel (phase 2) and sidebar (phase 4) phases together take ~4 minutes on a busy machine
  const hardStop = setTimeout(() => { check('driver finished in time', false); finish(6); }, (Number(E.SMOKE_IDLE || 0) + 360) * 1000);

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
        // redesign phase 3: the project chip's menu = recent projects · 打开文件夹… · 在独立副本里运行 (worktree)
        const projRows = await js(`({ browse: !!document.querySelector('.menu.dirmenu [data-id="browse"]'), worktree: !!document.querySelector('.menu.dirmenu [data-id="worktree"]') })`);
        check('project menu: 打开文件夹… and the 独立副本 (worktree) switch', projRows.browse && projRows.worktree, JSON.stringify(projRows));
        await key('End');
        const atEnd = await focused();
        await key('Home');
        const atHome = await focused();
        check('Home / End move to the first / last entry', atHome === 'row' && /独立副本/.test(atEnd), `${atHome} / ${atEnd}`);
        await key('Tab');
        check('Tab closes the directory menu and focus returns to the chip', !(await js('!!document.querySelector(".menu.dirmenu")')) && (await focused()) === 'chip');
        await click('.welcome .dirpick');
        await key('Escape');
        check('Esc closes the directory menu', !(await js('!!document.querySelector(".menu.dirmenu")')) && (await focused()) === 'chip');
      }

      // ---- model menu
      phase = 'model-menu';
      // the other agents are sections of this menu, and agents.list probes every CLI's version first (≈ 13 s on a
      // cold machine): wait for the list rather than racing it
      check('agent list arrived (other agents in the model menu)', await waitFor('window.__store.getState().agents.length > 0', 30_000));
      await click('.welcome .mm-anchor > button.chip');
      check('model menu opens', await waitFor('!!document.querySelector(".menu.mm")', 5000));
      await waitFor('!!document.querySelector(\'.menu.mm [data-sec^="agent:"]\')', 30_000);
      await sleep(600);
      await shot('model-menu');
      check('model menu without error boundary', !(await noBoundary('body')), await noBoundary('body'));
      // redesign phase 3: 智能程度 + 深度编排 on top, the other agents as sections of the same flat list (no sub-menu)
      const mm = await js(`(() => { const m = document.querySelector('.menu.mm'); if (!m) return null; return { levels: [...m.querySelectorAll('.mm-intel [data-level]')].map((b) => b.textContent), ultra: !!m.querySelector('[data-id="ultracode"]'), agents: m.querySelectorAll('[data-sec^="agent:"]').length, nested: m.querySelectorAll('.menu').length, ids: ['add-provider', 'agents', 'manage', 'refresh'].filter((i) => !m.querySelector('[data-id="' + i + '"]')), words: /effort|ultracode|档案|引擎/i.test(m.innerText) }; })()`);
      check('model menu: 智能程度 (快…极限), 深度编排, other agents flat, add / manage / refresh', mm && mm.levels.join('') === '快均衡深入更深极限' && mm.ultra && mm.agents >= 1 && !mm.nested && !mm.ids.length, JSON.stringify(mm));
      check('model menu shows no implementation words (effort / ultracode / 档案 / 引擎)', mm && !mm.words);
      await click('.menu.mm .mm-intel [data-level="low"]');
      const chipLow = await js(`document.querySelector('.welcome .mm-anchor > button.chip').getAttribute('aria-label')`);
      check('picking 快 keeps the menu open and the chip says 模型 · 快', /· 快$/.test(chipLow) && !!(await js('!!document.querySelector(".menu.mm")')), chipLow);
      await click('.menu.mm .mm-intel [data-level="high"]');
      await key('Escape');
      await sleep(200);

      // ---- redesign phase 3: the composer row, the + menu, the permission menu
      phase = 'composer';
      const oneRow = `(() => { const bar = document.querySelector('.welcome .composer-bar'); if (!bar) return null; const b = bar.getBoundingClientRect(); const kids = [...bar.querySelectorAll('.cb-left > *, .cb-right > *')].filter((e) => e.getBoundingClientRect().width > 0); const inside = kids.every((e) => { const r = e.getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 && r.left >= b.left - 8 && r.right <= b.right + 1; }); return { w: Math.round(b.width), h: Math.round(b.height), n: kids.length, inside, overflow: bar.scrollWidth > bar.clientWidth + 1 }; })()`;
      for (const [w, h] of [[1440, 900], [1024, 800], [760, 860]]) {
        win.setSize(w, h);
        await sleep(700);
        const r = await js(oneRow);
        check(`composer row stays one line at ${w} wide`, r && r.h <= 36 && r.inside && !r.overflow && r.n >= 5, JSON.stringify(r));
      }
      win.setSize(1360, 860);
      await sleep(600);
      const bar = await js(`(() => { const b = document.querySelector('.welcome .composer-bar'); return { plus: !!b.querySelector('.plus'), project: !!b.querySelector('.dirpick'), model: !!b.querySelector('.mm-anchor'), perm: !!b.querySelector('.perm-chip'), send: !!b.querySelector('[data-id="send"]'), selects: document.querySelectorAll('.composer select').length }; })()`);
      check('welcome row: + · project · model · permission · send, no hidden <select>', bar.plus && bar.project && bar.model && bar.perm && bar.send && !bar.selects, JSON.stringify(bar));
      // every control of the old composer, from the reach table the unit test checks (web/src/features/composer/reach.ts):
      // open each place (+ / project / model / permission menu, or the row itself) and query every selector in it
      const reach = await js('window.__cwComposerReach ? JSON.parse(JSON.stringify(window.__cwComposerReach)) : null');
      check('composer reach table exposed (window.__cwComposerReach)', !!reach && reach.reach.length > 20);
      const speech = await js('!!(window.SpeechRecognition || window.webkitSpeechRecognition)');
      const walk = async (place, scope, states = {}) => {
        const wanted = reach.reach.filter((r) => r.place === place && (!r.when || r.when === 'more' || (r.when === 'speech' && speech && !states.mobile) || states[r.when]));
        const opener = reach.opener[place];
        const box = opener ? reach.container[place] : `${scope} ${reach.container[place]}`;
        if (opener) { await click(`${scope} ${opener}`); await waitFor(`!!document.querySelector(${JSON.stringify(box)})`, 5000); }
        const missing = (list) => js(`${JSON.stringify(list)}.filter((r) => !document.querySelector(${JSON.stringify(box)} + ' ' + r.sel)).map((r) => r.was + ' → ' + r.sel)`);
        const miss = await missing(wanted.filter((r) => r.when !== 'more'));
        const later = wanted.filter((r) => r.when === 'more');
        if (later.length) { await click(`${box} [data-id="more"]`); miss.push(...(await missing(later))); }
        if (opener) { await key('Escape'); await sleep(200); }
        return { n: wanted.length, miss };
      };
      for (const place of ['plus', ...(E.SMOKE_REPO ? ['project'] : []), 'model', 'permission', 'bar']) {
        const w = await walk(place, '.welcome');
        check(`reach · ${place}: every old control is there (${w.n})`, w.n > 0 && !w.miss.length, w.miss.join(' ; '));
      }
      await click('.welcome .cb .plus');
      await shot('composer-plus');
      await click('.menu.plus-menu [data-id="chrome"]');
      const on = await js(`document.querySelector('.menu.plus-menu [data-id="chrome"]').getAttribute('aria-checked')`);
      await key('Escape');
      const tag = await waitFor('!!document.querySelector(\'.welcome .cap-tag[data-cap="chrome"]\')', 2000);
      check('switching on 控制浏览器 shows a removable tag in the text box', on === 'true' && tag, JSON.stringify({ on, tag }));
      await click('.welcome .cap-tag[data-cap="chrome"] button');
      check('the tag\'s × turns it off again', await waitFor('!document.querySelector(\'.welcome .cap-tag[data-cap="chrome"]\')', 2000));
      if (E.SMOKE_READONLY !== '1') {
        // 频道: clicking 「Brief、频道…」 (the row goes away) moves the focus to Brief, ↓ reaches the field, and what is
        // typed survives a click outside (it is saved as you type, into meta.json ui.featureDefaults)
        await click('.welcome .cb .plus');
        await click('.menu.plus-menu [data-id="more"]');
        const afterMore = await js('document.activeElement?.dataset?.id ?? document.activeElement?.tagName');
        await key('Down');
        const inField = await js('document.activeElement?.closest?.(\'[data-id="channels"]\') ? "channels" : document.activeElement?.tagName');
        wc.insertText('server:smoke');
        await sleep(100);
        await click('.welcome .composer textarea');
        const saved = await waitFor('JSON.stringify(window.__store.getState().settings["ui.featureDefaults"]?.channels) === \'["server:smoke"]\'', 3000);
        check('频道: 「Brief、频道…」 hands the focus to Brief, ↓ reaches the field, typing survives a click outside', afterMore === 'brief' && inField === 'channels' && saved && !(await js('!!document.querySelector(".menu.plus-menu")')), JSON.stringify({ afterMore, inField, saved }));
        check('频道 shows as a removable tag', await waitFor('!!document.querySelector(\'.welcome .cap-tag[data-cap="channels"]\')', 2000));
        await click('.welcome .cap-tag[data-cap="channels"] button');
        await waitFor('!document.querySelector(\'.welcome .cap-tag[data-cap="channels"]\')', 2000);
        check('the capability defaults live in meta.json, not localStorage', await js('localStorage.getItem("cw.lastFeatures") === null && !!window.__store.getState().settings["ui.featureDefaults"]'));
        await click('.welcome .cb .plus');
        await click('.menu.plus-menu [data-id="goal"]');
        check('设定一个目标 puts /goal into the text box', await waitFor('document.querySelector(".welcome .composer textarea").value.startsWith("/goal")', 2000));
        wc.selectAll(); wc.delete(); await sleep(200);
        if (E.SMOKE_SID) {
          await click('.welcome .cb .plus');
          await click('.menu.plus-menu [data-id="reference"]');
          const listed = await waitFor('document.querySelectorAll(".menu.plus-menu .cm-ref-list .cm-it").length > 0', 3000);
          // from the search box ↓ and Tab land on the first result (not the 返回 button, not closing the menu)
          const where = 'document.activeElement?.closest?.(".cm-ref-list") ? "result" : document.activeElement?.getAttribute?.("aria-label") ?? document.activeElement?.tagName';
          const inSearch = await js('document.activeElement?.getAttribute?.("aria-label")');
          await key('Down');
          const afterDown = await js(where);
          await js(`document.querySelector('.menu.plus-menu .cm-ref-head input')?.focus()`);
          await key('Tab');
          const afterTab = await js(where);
          check('reference search: ↓ and Tab go to the first result and keep the menu open', inSearch === '搜索对话' && afterDown === 'result' && afterTab === 'result' && !!(await js('!!document.querySelector(".menu.plus-menu")')), JSON.stringify({ inSearch, afterDown, afterTab }));
          await click('.menu.plus-menu .cm-ref-list .cm-it');
          const refChip = await waitFor('!!document.querySelector(".welcome .attach .att-chip.ref")', 2000);
          check('引用另一个对话 lists conversations and adds the reference chip', listed && refChip, JSON.stringify({ listed, refChip }));
          await js(`document.querySelector('.welcome .attach .att-chip.ref button')?.click()`);
          await sleep(200);
        }
      }
      await click('.welcome .cb .perm-chip');
      const perm = await js(`(() => { const m = document.querySelector('.menu.perm-menu'); if (!m) return null; return { modes: [...m.querySelectorAll('[data-mode]')].map((b) => b.dataset.mode), danger: m.querySelector('[data-mode="bypassPermissions"]').classList.contains('danger'), rec: !!m.querySelector('[data-mode="default"] .cm-rec'), foot: /设为新对话的默认/.test(m.innerText), lines: [...m.querySelectorAll('[data-mode] .cm-d')].every((d) => d.textContent.length > 6) }; })()`);
      check('permission menu: six modes with one line each, 完全放开 in the danger colour, 推荐, 设为新对话的默认…', perm && perm.modes.length === 6 && perm.danger && perm.rec && perm.foot && perm.lines, JSON.stringify(perm));
      await shot('composer-perm');
      await click('.menu.perm-menu [data-mode="acceptEdits"]');
      const permLabel = await js(`document.querySelector('.welcome .cb .perm-chip').getAttribute('aria-label')`);
      check('picking a mode updates the chip', /自动改文件/.test(permLabel), permLabel);
      await click('.welcome .cb .perm-chip');
      await click('.menu.perm-menu [data-mode="default"]');
      check('composer menus without error boundary', !(await noBoundary('body')), await noBoundary('body'));

      // ---- settings (redesign phase 6): a full-window page, 5 groups + a collapsed 高级, every page and tab, old ids
      phase = 'settings';
      const onPage = (id, tab) => `(() => { const r = document.querySelector('.modal.settings.sp'); return !!r && r.dataset.section === ${JSON.stringify(id)}${tab ? ` && r.dataset.tab === ${JSON.stringify(tab)}` : ''}; })()`;
      await js('window.__store.getState().openSettings()');
      check('settings open on 通用', await waitFor(onPage('general'), 5000));
      const frame = await js(`(() => { const r = document.querySelector('.modal.settings.sp').getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width) - innerWidth, h: Math.round(r.height) - innerHeight }; })()`);
      check('settings fill the window (not a dialog)', frame.l === 0 && frame.t === 0 && frame.w === 0 && frame.h === 0, JSON.stringify(frame));
      const nav = await js(`({ items: document.querySelectorAll('.sp-nav .sp-si').length, groups: [...document.querySelectorAll('.sp-nav .sp-gh')].map((g) => g.textContent.trim()), adv: document.querySelector('.sp-adv-h')?.getAttribute('aria-expanded') })`);
      check('settings nav: ≤ 15 pages in 5 groups, 高级 collapsed', nav.items <= 15 && nav.items === inv.sections.filter((s) => !s.advanced).length && nav.groups.join(',') === '常用,模型,扩展,连接,数据,高级' && nav.adv === 'false', JSON.stringify(nav));
      const wbRow = await js(`!!document.querySelector('.modal.settings [data-entry="ui.workbench"] .toggle')`);
      check('「显示工作台工具」 is on 通用', wbRow);
      await shot('settings-general');
      for (const s of inv.sections) {
        phase = `settings:${s.id}`;
        await js(`window.__store.getState().openSettings({ section: ${JSON.stringify(s.id)} })`);
        const opened = await waitFor(`${onPage(s.id)} && document.querySelector('.modal.settings .sp-title')?.textContent === ${JSON.stringify(s.label)}`, 5000);
        await sleep(1500); // requests the page fires on mount
        let err = await noBoundary('.modal.settings');
        if (s.advanced) err = err || ((await js(`document.querySelector('.sp-adv-h')?.getAttribute('aria-expanded')`)) === 'true' ? '' : '高级 did not expand for an advanced page');
        check(`settings · ${s.label}`, opened && !err, err || (opened ? '' : 'page did not open'));
        await shot(`settings-${s.id}`);
        for (const t of s.tabs.slice(1)) {
          await click(`.modal.settings .sp-tabs [data-tab="${t}"]`);
          const on = await waitFor(onPage(s.id, t), 3000);
          await sleep(1500);
          const terr = await noBoundary('.modal.settings');
          check(`settings · ${s.label} › ${t}`, on && !terr, terr || (on ? '' : 'tab did not open'));
          await shot(`settings-${s.id}-${t}`);
        }
      }
      // 更多选项 on every page that has one: it opens without an error boundary, and the page lays out the parts the
      // catalog lists, in and out of 更多选项. `data-body` is written by the page from the catalog, so this says nothing
      // about which component draws a part — that is wording.test.ts (the BODIES table)
      const shownParts = `[...document.querySelectorAll('.modal.settings .sp-main [data-body]')].filter((e) => !e.closest('[hidden]')).map((e) => e.dataset.body).sort().join(',')`;
      const moreRows = `[...document.querySelectorAll('.modal.settings .sp-more-body:not([hidden]) [data-entry]')].map((e) => e.dataset.entry).sort().join(',')`;
      for (const s of inv.sections) {
        for (const pg of s.pages) {
          if (!pg.more.length && !pg.moreEntries.length) continue;
          const name = `${s.label}${pg.tab ? ` › ${pg.tab}` : ''}`;
          phase = `settings:more:${s.id}${pg.tab ? `/${pg.tab}` : ''}`;
          await js(`window.__store.getState().openSettings({ section: ${JSON.stringify(s.id)} })`);
          await waitFor(onPage(s.id), 3000);
          if (pg.tab) { await click(`.modal.settings .sp-tabs [data-tab="${pg.tab}"]`); await waitFor(onPage(s.id, pg.tab), 3000); }
          const before = await js(shownParts);
          await click('.modal.settings .sp-more-h');
          const opened = await waitFor(`document.querySelector('.modal.settings .sp-more-h')?.getAttribute('aria-expanded') === 'true'`, 3000);
          await sleep(1500); // requests the parts fire on first open
          const after = await js(shownParts);
          const rows = await js(moreRows);
          const err = await noBoundary('.modal.settings');
          const want = { before: [...pg.bodies].sort().join(','), after: [...pg.bodies, ...pg.more].sort().join(','), rows: [...pg.moreEntries].sort().join(',') };
          check(`settings · ${name} › 更多选项 (parts as in the catalog)`, opened && !err && before === want.before && after === want.after && rows === want.rows, err || JSON.stringify({ opened, before, after, rows, want }));
          await shot(`settings-${s.id}${pg.tab ? `-${pg.tab}` : ''}-more`);
        }
      }
      // the old flat-window ids still open the page (and tab) that has their content now; 引擎与账号 with 更多选项 open
      for (const a of inv.aliases) {
        phase = `settings:alias:${a.old}`;
        await js(`window.__store.getState().openSettings({ section: ${JSON.stringify(a.old)} })`);
        const more = a.more ? ` && !!document.querySelector('.modal.settings .sp-more.open [data-body="${a.body}"]')` : '';
        check(`settings · old id ${a.old} → ${a.section}${a.tab ? `/${a.tab}` : ''}${a.more ? ' › 更多选项' : ''}`, await waitFor(onPage(a.section, a.tab) + more, 3000));
      }
      // reveal: an entry under 更多选项 opens it and is highlighted
      phase = 'settings:reveal';
      await js('window.__store.getState().openSettings({ reveal: "ui.softwareRender" })');
      check('reveal opens 更多选项 and highlights the row', await waitFor(`${onPage('general')} && !!document.querySelector('.sp-more.open [data-entry="ui.softwareRender"].reveal')`, 3000));
      // Ctrl+, again while open (openSettings() without a page): same page, search cleared and focused
      phase = 'settings:reopen';
      await js('window.__store.getState().openSettings({ section: "models" })');
      await waitFor(onPage('models'), 3000);
      await js(`(() => { const i = document.querySelector('.sp-search input'); i.focus(); })()`);
      wc.insertText('zz');
      await sleep(200);
      await js('window.__store.getState().openSettings()');
      await sleep(300);
      const reopen = await js(`({ page: document.querySelector('.modal.settings.sp')?.dataset.section, q: document.querySelector('.sp-search input').value, focus: document.activeElement === document.querySelector('.sp-search input') })`);
      check('openSettings() while open keeps the page, clears and focuses the search', reopen.page === 'models' && reopen.q === '' && reopen.focus, JSON.stringify(reopen));
      // a short window: the current page stays in view in the navigation (an advanced page at the bottom)
      phase = 'settings:nav-scroll';
      win.setContentSize(1360, 420);
      await sleep(400);
      await js('window.__store.getState().openSettings({ section: "raw" })');
      await waitFor(onPage('raw'), 3000);
      await sleep(400);
      const navIn = await js(`(() => { const on = document.querySelector('.sp-si.on'), box = document.querySelector('.sp-groups'); if (!on || !box) return null; const a = on.getBoundingClientRect(), b = box.getBoundingClientRect(); return { inside: a.top >= b.top - 1 && a.bottom <= b.bottom + 1, scrolled: box.scrollTop > 0 }; })()`);
      check('the navigation scrolls the current page into view', navIn && navIn.inside, JSON.stringify(navIn));
      win.setContentSize(1360, 860);
      await sleep(400);
      // search: rows with a 分组 › 分区 crumb; a part under 更多选项 jumps there and opens it
      phase = 'settings:search';
      await js('window.__store.getState().openSettings({ section: "general" })');
      await waitFor(onPage('general'), 3000);
      wc.focus();
      await key('/');
      const searchFocused = await js(`document.activeElement === document.querySelector('.sp-search input')`);
      if (!searchFocused) await click('.sp-search input');
      wc.insertText('托盘');
      const tray = await waitFor(`[...document.querySelectorAll('.sp-hit')].some((h) => h.querySelector('[data-entry="ui.closeToTray"]') && h.querySelector('.sp-crumb')?.textContent === '常用 › 通用')`, 3000);
      check('search finds a row with its 分组 › 分区 crumb (「/」 focuses the search)', tray && searchFocused, JSON.stringify({ tray, searchFocused }));
      await shot('settings-search');
      await js(`(() => { const i = document.querySelector('.sp-search input'); i.select(); })()`);
      wc.insertText('ssh');
      const hostHit = await waitFor(`!!document.querySelector('.sp-jump[data-target="remote#hosts"]')`, 3000);
      await click('.sp-jump[data-target="remote#hosts"]');
      const hosts = await waitFor(`${onPage('remote')} && !!document.querySelector('.sp-more.open [data-body="hosts"]') && !document.querySelector('.sp-hits')`, 3000);
      check('search finds a part under 更多选项 and opens it there', hostHit && hosts, JSON.stringify({ hostHit, hosts }));
      // Esc in the page closes it; the app underneath was never unmounted
      await click('.modal.settings .sp-title');
      await key('Escape');
      check('Esc closes the settings page', await waitFor('!document.querySelector(".modal.settings") && !!document.querySelector(".sidebar") && !!document.querySelector(".pane")', 3000));
      await sleep(300);

      // keyboard: the page takes the focus from the composer and gives it back; nothing typed or pressed while it is
      // open reaches the covered app (typing there would be lost, Esc would interrupt a running turn)
      if (E.SMOKE_READONLY !== '1') {
        phase = 'settings:keyboard';
        const ta = '.welcome .composer textarea';
        await click(ta);
        wc.insertText('abc');
        await sleep(200);
        wc.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: ',', modifiers: ['control'] });
        const kbOpen = await waitFor('!!document.querySelector(".modal.settings.sp")', 3000);
        await sleep(200);
        const cover = await js(`(() => { const r = document.querySelector('.modal.settings.sp'); const t = document.querySelector(${JSON.stringify(ta)}); return { search: document.activeElement === document.querySelector('.sp-search input'), composerInert: !!t && !!t.closest('[inert]'), pageInert: !!r && !!r.closest('[inert]'), inert: document.querySelectorAll('.app > [inert]').length }; })()`);
        check('Ctrl+, from the composer: focus moves to the settings search, the app underneath is inert', kbOpen && cover.search && cover.composerInert && !cover.pageInert && cover.inert > 0, JSON.stringify({ kbOpen, ...cover }));
        wc.insertText('托盘');
        await sleep(300);
        const typed = await js(`({ q: document.querySelector('.sp-search input').value, ta: document.querySelector(${JSON.stringify(ta)}).value })`);
        check('typing after Ctrl+, goes into the search; the composer is unchanged', typed.q === '托盘' && typed.ta === 'abc', JSON.stringify(typed));
        await js(`(() => { window.__cwKd = 0; window.__cwKdFn = () => { window.__cwKd++; }; document.querySelector(${JSON.stringify(ta)}).addEventListener('keydown', window.__cwKdFn, true); })()`);
        await click('.modal.settings .sp-lead'); // focus off the search box: Esc still only clears the search
        await key('Escape');
        const cleared = await js(`({ open: !!document.querySelector('.modal.settings.sp'), q: document.querySelector('.sp-search input')?.value })`);
        check('Esc with a search typed only clears the search (wherever the focus is)', cleared.open && cleared.q === '', JSON.stringify(cleared));
        await key('A');
        await key('Escape');
        const back = await js(`({ open: !!document.querySelector('.modal.settings'), kd: window.__cwKd, focus: document.activeElement === document.querySelector(${JSON.stringify(ta)}), inert: document.querySelectorAll('.app [inert]').length, ta: document.querySelector(${JSON.stringify(ta)}).value })`);
        check('Esc closes the settings: no key reached the composer, focus is back in it, nothing left inert', !back.open && back.kd === 0 && back.focus && back.inert === 0 && back.ta === 'abc', JSON.stringify(back));
        await js(`document.querySelector(${JSON.stringify(ta)}).removeEventListener('keydown', window.__cwKdFn, true)`);
        wc.selectAll(); wc.delete(); await sleep(300);

        // a menu left open when the page opens is closed (portalled to <body>, it would float over the page)
        phase = 'settings:menus';
        const ctrl = async (k) => { wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: ['control'] }); await sleep(300); };
        const menusLeft = [];
        for (const [chip, menu] of [['.welcome .dirpick', '.menu.dirmenu'], ['.welcome .mm-anchor > button.chip', '.menu.mm']]) {
          await click(chip);
          const opened = await waitFor(`!!document.querySelector(${JSON.stringify(menu)})`, 3000);
          await ctrl(',');
          await waitFor('!!document.querySelector(".modal.settings.sp")', 3000);
          const still = await js(`!!document.querySelector(${JSON.stringify(menu)})`);
          if (!opened || still) menusLeft.push(`${menu} ${opened ? 'still open' : 'did not open'}`);
          await js('window.__store.setState({ settingsOpen: null })');
          await sleep(300);
        }
        check('opening settings closes a menu left open (directory menu, model menu)', !menusLeft.length, menusLeft.join(' ; '));
        // Esc with a search typed and the focus nowhere (<body>) still only clears the search
        phase = 'settings:esc-body';
        await ctrl(',');
        await waitFor('!!document.querySelector(".modal.settings.sp")', 3000);
        wc.insertText('托盘');
        await sleep(300);
        await js('document.activeElement && document.activeElement.blur()');
        const onBody = await js('document.activeElement === document.body');
        await key('Escape');
        const bodyEsc = await js(`({ open: !!document.querySelector('.modal.settings.sp'), q: document.querySelector('.sp-search input')?.value })`);
        check('Esc with a search typed and the focus on <body> only clears the search', onBody && bodyEsc.open && bodyEsc.q === '', JSON.stringify({ onBody, ...bodyEsc }));
        // the command palette over the page: Esc closes the palette only
        phase = 'settings:palette';
        await ctrl('K');
        const pal = await waitFor('!!document.querySelector(".palette-bg")', 3000);
        await key('Escape');
        const afterPal = await js(`({ palette: !!document.querySelector('.palette-bg'), open: !!document.querySelector('.modal.settings.sp') })`);
        check('the command palette opened over settings: Esc closes only the palette', pal && !afterPal.palette && afterPal.open, JSON.stringify({ pal, ...afterPal }));
        // nodes inserted while the page is open are covered too: Ctrl+B twice swaps the sidebar for a placeholder and back
        phase = 'settings:swap';
        const sbState = `({ open: window.__store.getState().sidebarOpen, sb: [...document.querySelectorAll('.app > .sidebar')].map((e) => (e.classList.contains('has-resizer') ? 'column' : 'placeholder') + (e.hasAttribute('inert') ? ':inert' : '')) })`;
        const swap0 = await js(sbState);
        await ctrl('B');
        const swap1 = await js(sbState);
        await ctrl('B');
        const swap2 = await js(sbState);
        const swapped = swap1.open !== swap0.open && swap2.open === swap0.open && [swap1, swap2].every((x) => x.sb.length === 1 && x.sb[0].endsWith(':inert')) && swap1.sb[0] !== swap2.sb[0];
        check('while settings are open, the sidebar node swapped in by Ctrl+B (twice) is inert both times', swapped, JSON.stringify({ swap0, swap1, swap2 }));
        await key('Escape');
        const clean = await js(`({ open: !!document.querySelector('.modal.settings'), inert: document.querySelectorAll('.app [inert]').length })`);
        check('closing settings after that leaves nothing inert', !clean.open && clean.inert === 0, JSON.stringify(clean));
      }

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

        // ---- redesign phase 3: the stats bar is behind the context ring; + says the capabilities apply to new conversations
        phase = 'session-composer';
        check('no stats bar under the composer', !(await js('!!document.querySelector(".pane .composer .statusbar")')));
        const sidJs = JSON.stringify(E.SMOKE_SID);
        // no occupancy reported (a conversation opened from history, ACP…) → no ring (an empty circle reads as a
        // radio button / a spinner), but with a turn behind it a plain stats icon keeps the numbers one click away
        const noCu = await js(`(() => { const o = window.__store.getState().open[${sidJs}]; return !!o && !(o.contextUsage ?? o.conv.contextUsage); })()`);
        if (noCu) {
          const plain = await js(`(() => { const m = document.querySelector('.pane .composer .ctx-meter'); return m ? { cls: m.className, circles: m.querySelectorAll('circle').length } : null; })()`);
          await click('.pane .composer .ctx-meter');
          const plainCard = await js(`document.querySelector('.ctx-card')?.innerText ?? null`);
          await click('.pane .composer .ctx-meter');
          check('no occupancy: no ring, a plain stats icon whose card still has 轮数 / 输入 (no 上下文 line)', plain && /plain/.test(plain.cls) && !plain.circles && !!plainCard && /轮数/.test(plainCard) && !/上下文/.test(plainCard), JSON.stringify({ plain, plainCard }));
        }
        const setCu = (cu) => js(`(() => { const st = window.__store; const o = st.getState().open[${sidJs}]; st.setState({ open: { ...st.getState().open, [${sidJs}]: { ...o, contextUsage: ${JSON.stringify(cu)}, version: o.version + 1 } } }); })()`);
        await setCu({ percentage: 83, totalTokens: 166_000, maxTokens: 200_000 });
        const ring = await waitFor('!!document.querySelector(".pane .composer .ctx-meter circle")', 2000);
        const ringLook = await js(`(() => { const m = document.querySelector('.pane .composer .ctx-meter'); if (!m) return null; const cs = getComputedStyle(m); return { cls: m.className, pct: m.textContent, weight: cs.fontWeight, chip: !!document.querySelector('.pane .status-strip .ctx-full') }; })()`);
        check('83 %: the ring shows the percentage in ink, bold, not yellow; no second 83 % above the composer', ring && ringLook && /strong/.test(ringLook.cls) && ringLook.pct === '83%' && Number(ringLook.weight) >= 600 && !ringLook.chip, JSON.stringify(ringLook));
        // the rest of the row is in the reach table too (the ring = the old stats bar)
        for (const place of ['meter', 'bar']) {
          const w = await walk(place, '.pane .composer', { usage: true });
          check(`reach · ${place} in a conversation (${w.n})`, w.n > 0 && !w.miss.length, w.miss.join(' ; '));
        }
        await click('.pane .composer .ctx-meter');
        const card = await js(`document.querySelector('.ctx-card')?.innerText ?? null`);
        check('the context ring shows the old stats (轮数 / 输入 / 输出 / 上下文) on click', !!card && /轮数/.test(card) && /输入/.test(card) && /上下文/.test(card), JSON.stringify(card));
        await click('.pane .composer .ctx-meter');
        await setCu({ percentage: 97, totalTokens: 194_000, maxTokens: 200_000 });
        const full = await waitFor('!!document.querySelector(".pane .status-strip .ctx-full")', 2000);
        const fullText = await js(`document.querySelector('.pane .status-strip .ctx-full')?.textContent ?? null`);
        check('≥ 95 %: the strip offers /compact once, without repeating the percentage', full && /compact/.test(fullText ?? '') && !/%/.test(fullText ?? ''), JSON.stringify(fullText));
        await setCu(undefined);
        await sleep(200);
        // + in a running conversation: the switches show THIS conversation's state, read-only; one note says where to change them
        await click('.pane .composer .cb .plus');
        const live = await js(`(() => { const m = document.querySelector('.menu.plus-menu'); if (!m) return null; const rows = [...m.querySelectorAll('[role="menuitemcheckbox"]')]; return { sub: m.querySelector('.cm-sub')?.textContent ?? null, mentions: (m.innerText.match(/新对话/g) || []).length, rows: rows.length, ro: rows.every((r) => r.getAttribute('aria-disabled') === 'true'), checked: rows.filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.dataset.id) }; })()`);
        const before = await js('JSON.stringify(window.__store.getState().settings["ui.featureDefaults"] ?? null)');
        await click('.menu.plus-menu [data-id="chrome"]');
        const after = await js('JSON.stringify(window.__store.getState().settings["ui.featureDefaults"] ?? null)');
        const stillOff = await js(`document.querySelector('.menu.plus-menu [data-id="chrome"]')?.getAttribute('aria-checked')`);
        check('in a conversation the + capabilities show its own state, read-only, 「要改请在新对话的 + 里设置」 said once', live && /要改请在新对话的 \+ 里设置/.test(live.sub ?? '') && live.mentions === 1 && live.rows >= 4 && live.ro && !live.checked.length && before === after && stillOff === 'false', JSON.stringify({ live, before, after, stillOff }));
        await key('Escape');

        // ---- redesign phase 1: one ≤ 52px row above the conversation; the workbench tabs live in ···
        phase = 'session-chrome';
        const head = await js(`(() => { const p = document.querySelector('.pane.focused') || document.querySelector('.pane'); const h = p && p.querySelector('.sess-head'); const c = p && p.querySelector('.chat'); if (!h || !c) return null; const pr = p.getBoundingClientRect(); return { h: Math.round(h.getBoundingClientRect().height), above: Math.round(c.getBoundingClientRect().top - pr.top), strips: p.querySelectorAll('.tabstrip').length, wbTabs: !!document.querySelector('.wb-tabs') }; })()`);
        check('one header row above the conversation (≤ 52px, no tab strip, no workbench tab row)', head && head.h <= 52 && head.above <= 53 && !head.strips && !head.wbTabs, JSON.stringify(head));
        await click('.sess-head .sh-more > button');
        const views = await js(`[...document.querySelectorAll('.menu.sess-menu [data-view]')].map((b) => b.dataset.view)`);
        check('··· lists every workbench view', ['changes', 'git', 'files', 'search', 'schedules', 'artifacts', 'board'].every((v) => views.includes(v)), JSON.stringify(views));
        await shot('session-menu');
        await click('.menu.sess-menu [data-view="schedules"]'); // still an in-place view (文件 / 改动… open the right panel since phase 2)
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
        const splitBars = await js(`[...document.querySelectorAll('.pane .composer-bar')].map((bar) => ({ w: Math.round(bar.getBoundingClientRect().width), h: Math.round(bar.getBoundingClientRect().height), overflow: bar.scrollWidth > bar.clientWidth + 1 }))`);
        check('split panes: each composer row is still one line', splitBars.length === 2 && splitBars.every((b) => b.h <= 36 && !b.overflow), JSON.stringify(splitBars));
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
          const phoneBar = await js(`(() => { const bar = document.querySelector('.pane .composer-bar'); if (!bar) return null; const b = bar.getBoundingClientRect(); return { h: Math.round(b.height), overflow: bar.scrollWidth > bar.clientWidth + 1, mic: !!bar.querySelector('[data-id="mic"]') }; })()`);
          check('phone: the composer row is one line, no mic (spec §5.11)', phoneBar && phoneBar.h <= 36 && !phoneBar.overflow && !phoneBar.mic, JSON.stringify(phoneBar));
          await click('.pane .sess-head .sb-reveal');
          const drawer = await waitFor('document.querySelector(".app").classList.contains("drawer-open") && !!document.querySelector(".sidebar.has-resizer")', 3000);
          check('phone: 展开侧栏 opens the sidebar drawer', drawer);
          await shot('phone-drawer');
          const drawerParts = await js(`({ nav: [...document.querySelectorAll('.sidebar .sb-nav [data-id]')].map((e) => e.dataset.id), account: !!document.querySelector('.sidebar .sb-account [data-id="account"]') })`);
          check('phone: the drawer is the same sidebar (新对话 / 搜索 / 自动化, account row)', ['new', 'search', 'automation'].every((x) => drawerParts.nav.includes(x)) && drawerParts.account, JSON.stringify(drawerParts));
          await click('.sidebar .sb-account [data-id="settings"]');
          const settings = await waitFor('!!document.querySelector(".modal.settings")', 3000);
          await sleep(200);
          const phoneFocus = await js('document.activeElement === document.querySelector(".modal.settings.sp")');
          check('phone: settings open from the sidebar, the page itself takes the focus (no keyboard pops up)', settings && phoneFocus, JSON.stringify({ settings, phoneFocus }));
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['control'] });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['control'] });
          await sleep(400);
          const noDrawer = await js(`({ open: window.__store.getState().sidebarOpen, drawer: document.querySelector('.app').classList.contains('drawer-open') })`);
          check('phone: Ctrl+B with settings open does not bring the drawer over the page', !noDrawer.open && !noDrawer.drawer, JSON.stringify(noDrawer));
          // settings at phone width (≤ 600px): the page list first, a page replaces it, 全部设置 brings the list back
          win.setContentSize(480, 860);
          await sleep(600);
          const spVis = `(() => { const d = (s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; }; return { nav: d('.sp-nav'), main: d('.sp-main'), drawer: document.querySelector('.app').classList.contains('drawer-open') }; })()`;
          const listFirst = await js(spVis);
          await click('.sp-nav .sp-si[data-section="appearance"]');
          const pageNow = await js(spVis);
          await click('.sp-phone-back');
          const listAgain = await js(spVis);
          check('phone settings: the list first (drawer closed), a page replaces it, 全部设置 returns', listFirst.nav && !listFirst.main && !listFirst.drawer && !pageNow.nav && pageNow.main && listAgain.nav && !listAgain.main, JSON.stringify({ listFirst, pageNow, listAgain }));
          win.setContentSize(740, 860);
          await sleep(400);
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

        // ---- redesign phase 2: the right panel — 审阅 · 文件 · 终端 · 任务 + temporary tabs, nothing unmounts
        phase = 'right-panel';
        const dockState = 'JSON.stringify(window.__store.getState().layout.dock)';
        // the header ··· toggles: an earlier step may have left it open (a synthetic body click does not close it)
        const openHeaderMenu = async () => { if (!(await js('!!document.querySelector(".menu.sess-menu")'))) await click('.sess-head .sh-more > button'); await waitFor('!!document.querySelector(".menu.sess-menu [data-view]")', 3000); await sleep(250); };
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false, minimized: false } })`);
        await sleep(300);
        await click('.sess-head button[aria-label="右侧面板"]');
        // (the columns animate for --dur-3: let them settle, or the next clicks land where the buttons were)
        const rp = await waitFor('!!document.querySelector(".dock.simple:not([hidden])") && document.querySelector(".rpanel").offsetWidth >= 430', 4000);
        await sleep(400);
        const fixedTabs = await js(`[...document.querySelectorAll('.dock .dock-tabs .tab.fixed')].map((t) => t.dataset.panel + (t.querySelector('.x') ? '×' : '')).join(',')`);
        check('right panel: the four fixed tabs 审阅 · 文件 · 终端 · 任务, none closable', rp && fixedTabs === 'files,explorer,terminal,tasks', `${rp} ${fixedTabs}`);
        // ··· 改动 → 审阅 on this conversation's files; the scope menu lists the scopes and recent commits
        await openHeaderMenu();
        await click('.menu.sess-menu [data-view="changes"]');
        const review = await waitFor('document.querySelector(".dock .dock-tabs .tab.active")?.dataset.panel === "files" && document.querySelector(".dock .rv-scope .t")?.textContent === "本次对话改动"', 5000);
        check('··· 改动 opens 审阅 on 本次对话改动 (the conversation stays in place)', review && !(await js('!!document.querySelector(".pane.focused .sh-view")')), await js(`JSON.stringify({ dock: window.__store.getState().layout.dock.active, tab: document.querySelector(".dock .dock-tabs .tab.active")?.dataset.panel, scope: document.querySelector(".dock .rv-scope .t")?.textContent, menu: !!document.querySelector(".menu.sess-menu"), toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent) })`));
        await click('.dock .rv-scope');
        const scopes = await waitFor('document.querySelectorAll(".rv-scope-menu .rv-commit-item").length > 0', 5000);
        const scopeItems = await js(`[...document.querySelectorAll('.rv-scope-menu [role=menuitemradio]')].map((b) => b.textContent)`);
        check('审阅 scope menu: 未提交 / 已暂存 / 本次对话 + commits', scopes && ['未提交的改动', '已暂存', '本次对话改动'].every((l) => scopeItems.some((t) => t.includes(l))), JSON.stringify(scopeItems));
        await js(`[...document.querySelectorAll('.rv-scope-menu button')].find((b) => b.textContent.includes('未提交'))?.click()`);
        const readme = await waitFor('[...document.querySelectorAll(".dock .rv-file")].some((f) => f.textContent.includes("README.md") && f.querySelector(".rv-body .diff"))', 8000);
        check('未提交的改动 lists the modified README.md with its diff; 提交 box at the bottom', readme && (await js('!!document.querySelector(".dock .rv-foot textarea")')));
        await shot('right-panel-review');
        await js('document.querySelector(\'.dock .rv-bar button[aria-label="更多审阅操作"]\')?.click()');
        await sleep(300);
        await js(`[...document.querySelectorAll('.rv-more-menu button')].find((b) => b.textContent.includes('Git'))?.click()`);
        const gitView = await waitFor('!!document.querySelector(".dock .rv-git:not([hidden]) .git-view .git-head")', 6000);
        check('审阅 ··· → Git: the full Git view (branches, pull / push, stash, worktrees, history)', gitView);
        await js('document.querySelector(".dock .rv-git .rv-bar .btn")?.click()');
        await sleep(300);
        // ··· 搜索 → 文件 in search mode
        await openHeaderMenu();
        await click('.menu.sess-menu [data-view="search"]');
        const search = await waitFor('document.querySelector(".dock .dock-tabs .tab.active")?.dataset.panel === "explorer" && !!document.querySelector(".dock .files-view .fv-body:not([hidden]) .search-view")', 5000);
        check('··· 搜索 opens 文件 in search mode', search);
        // 「更多」: the extra tier as temporary tabs with a ×
        await click('.dock button.dock-more');
        const more = await js(`[...document.querySelectorAll('.dock-more-menu [data-panel]')].map((b) => b.dataset.panel)`);
        check('「更多」 lists the extra panels (目标 / 编排 / 用量 / 详情 / Issue 与 PR)', ['goals', 'orchestra', 'usage', 'inspector', 'board'].every((p) => more.includes(p)) && !more.includes('files'), JSON.stringify(more));
        await js(`document.querySelector('.dock-more-menu [data-panel="goals"]')?.click()`);
        const temp = await waitFor('!!document.querySelector(".dock .dock-tabs .tab.active:not(.fixed)[data-panel=goals] .x")', 3000);
        await click('.dock .dock-tabs .tab[data-panel="goals"] .x');
        const closed = await waitFor('!document.querySelector(".dock .dock-tabs .tab[data-panel=goals]")', 3000);
        check('a temporary tab opens from 「更多」 and its × closes it', temp && closed);
        if (E.SMOKE_READONLY !== '1') {
          // the terminal is never remounted: switching tabs, hiding the panel, flipping the workbench tools
          await click('.dock .dock-tabs .tab[data-panel="terminal"]');
          const xt = await waitFor('!!document.querySelector(".dock .xterm")', 8000);
          await js('document.querySelector(".dock .xterm").dataset.smokeMark = "1"');
          await click('.dock .dock-tabs .tab[data-panel="files"]');
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
          await sleep(300);
          await js('window.__store.getState().setSetting("ui.workbench", true)');
          await sleep(500);
          await js('window.__store.getState().setSetting("ui.workbench", false)');
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: true } })`);
          await sleep(500);
          const kept = await js('document.querySelector(".dock .xterm")?.dataset.smokeMark === "1" && document.querySelector(".dock .rv-scope .t")?.textContent === "未提交的改动"');
          check('switching tabs / hiding / the workbench setting keep the terminal (same xterm) and the review’s scope', xt && kept, await js(dockState));
          // default mode: toggling a fixed tab hides the panel, the tab stays mounted
          await js(`window.__store.getState().togglePanel('files')`);
          await sleep(300);
          const hid = await js('(() => { const d = window.__store.getState().layout.dock; return !d.open && d.tabs.includes("files"); })()');
          check('toggling 审阅 in view hides the right panel and keeps its tab', hid, await js(dockState));
        }

        // ---- redesign phase 2 review fixes
        // I1: a window whose right panel was never opened mounts no 审阅 and never asks the server to watch the repo
        // (a watch = a file watcher + a background `git fetch` every 5 minutes). A second window with a fresh layout
        // (?win=) records every WebSocket frame it sends: a preload in the page's own world (no context isolation,
        // this window only) wraps WebSocket#send before any page script runs.
        if (E.SMOKE_READONLY !== '1') {
          phase = 'right-panel-cold';
          const recorder = path.join(out, 'smoke-ws-recorder.cjs');
          fs.writeFileSync(recorder, '(() => { const sent = (window.__cwSent = []); const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { sent.push(typeof d === "string" ? d : "[binary]"); return send.call(this, d); }; })();\n');
          const cold = new BrowserWindow({ width: 1360, height: 860, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, preload: recorder, contextIsolation: false, sandbox: false } });
          const cw = cold.webContents;
          cw.on('console-message', (a, b, c) => {
            const level = typeof a === 'object' && a && 'level' in a ? a.level : b;
            const message = typeof a === 'object' && a && 'message' in a ? a.message : c;
            if (level === 'error' || level === 'warning' || Number(level) >= 2) res.console.push({ phase, level: String(level), message: `[cold window] ${String(message).slice(0, 780)}` });
          });
          const cjs = (code) => cw.executeJavaScript(code, true);
          const cwait = async (code, ms = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cjs(code).catch(() => false)) return true; await sleep(150); } return false; };
          try {
            const u = new URL(E.SMOKE_URL);
            u.searchParams.set('win', 'smoke-cold');
            await Promise.race([cold.loadURL(u.toString()), sleep(20_000)]);
            await cwait('!!window.__store && window.__store.getState().connected && window.__store.getState().metaLoaded && Array.isArray(window.__cwSent)', 20_000);
            await cjs(`window.__store.getState().loadHistory(${JSON.stringify(E.SMOKE_SID)})`);
            const opened = await cwait('!!document.querySelector(".sess-head") && !document.querySelector(".welcome")', 10_000);
            await sleep(2500);
            const st = await cjs(`({ review: !!document.querySelector('.dock-panel[data-panel="files"]'), panels: document.querySelectorAll('.dock-panel').length, tabs: window.__store.getState().layout.dock.tabs, watch: window.__cwSent.filter((m) => m.includes('"git.watch"')).length, sent: window.__cwSent.length })`);
            check('cold start, right panel never opened: no 审阅 mounted, no git.watch sent', opened && st.sent > 0 && !st.review && !st.panels && st.watch === 0, JSON.stringify(st));
            // …and the other way round: opening it mounts 审阅, which watches the repo once it is on screen
            await cjs(`document.querySelector('.sess-head button[aria-label="右侧面板"]').click()`);
            const watched = await cwait(`!!document.querySelector('.dock-panel[data-panel="files"]:not([hidden]) .review') && window.__cwSent.some((m) => m.includes('"git.watch"'))`, 8000);
            check('opening the right panel mounts 审阅 on screen, and only then is the repo watched', watched);
          } catch (e) {
            check('cold-start window', false, String(e && e.message || e));
          }
          cold.destroy();
          phase = 'right-panel';
        }

        // I5: every panel from the command palette (it is 2 clicks away: 搜索 → the item), by its label
        const pickItem = async (label) => {
          const ok = await js(`(() => { document.querySelectorAll('[data-smoke-pick]').forEach((e) => e.removeAttribute('data-smoke-pick')); const it = [...document.querySelectorAll('.cmdk .it')].find((x) => x.querySelector('.t')?.textContent === ${JSON.stringify(label)}); if (!it) return false; it.setAttribute('data-smoke-pick', '1'); return true; })()`);
          if (ok) await click('[data-smoke-pick]');
          return ok;
        };
        const dockBefore = await js(dockState);
        const paletteMiss = [];
        for (const p of inv.panels) {
          if (E.SMOKE_READONLY === '1' && p.id === 'terminal') continue;
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
          await js('window.__store.setState({ paletteOpen: true })');
          await waitFor('!!document.querySelector(".cmdk input")', 3000);
          await js('document.querySelector(".cmdk input").focus()');
          wc.insertText(`>${p.title}`);
          await sleep(250);
          const listed = await pickItem(`打开${p.title}面板`);
          const shown = listed && await waitFor(`(() => { const d = window.__store.getState().layout.dock; return d.open && document.querySelector('.dock .dock-tabs .tab.active')?.dataset.panel === ${JSON.stringify(p.id)} && !!document.querySelector('.dock-panel[data-panel="${p.id}"]:not([hidden])'); })()`, 4000);
          if (!shown) { paletteMiss.push(`${p.id}${listed ? '' : ' (not listed)'}`); await js('window.__store.setState({ paletteOpen: false })'); }
        }
        check('palette: every panel is listed as 「打开…面板」 and opens in the right panel', !paletteMiss.length, paletteMiss.join(', '));
        // the palette's 「面板」 group is not cut to 8 when the query names it
        await js('window.__store.setState({ paletteOpen: true })');
        await waitFor('!!document.querySelector(".cmdk input")', 3000);
        await js('document.querySelector(".cmdk input").focus()');
        wc.insertText('>面板');
        await sleep(250);
        const inGroup = await js(`[...document.querySelectorAll('.cmdk .it .t')].filter((t) => /^(打开|隐藏|关闭).*面板/.test(t.textContent)).length`);
        check('palette: searching 「面板」 lists every panel', inGroup >= inv.panels.length, `${inGroup} / ${inv.panels.length}`);
        await js('window.__store.setState({ paletteOpen: false })');
        await js(`(() => { const d = JSON.parse(${JSON.stringify(dockBefore)}); window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { tabs: d.tabs, active: d.active, open: false, minimized: false } }); })()`);
        await sleep(300);

        // I5: every view in the header ··· lands where viewTarget (panel-entries.ts) sends it — the same table
        // panel-entries.test.ts pins: 改动 / Git → 审阅, 文件 / 搜索 / 生成的文件 → 文件, Issue 与 PR → a tab, 定时任务 in place
        const activeTab = 'document.querySelector(".dock:not([hidden]) .dock-tabs .tab.active")?.dataset.panel';
        const landing = {
          changes: `${activeTab} === "files" && document.querySelector(".dock .rv-main:not([hidden]) .rv-scope .t")?.textContent === "本次对话改动"`,
          git: `${activeTab} === "files" && !!document.querySelector(".dock .rv-git:not([hidden])")`,
          files: `${activeTab} === "explorer" && !!document.querySelector(".dock .files-view .fv-body:not([hidden]) .filetree")`,
          search: `${activeTab} === "explorer" && !!document.querySelector(".dock .files-view .fv-body:not([hidden]) .search-view")`,
          artifacts: `${activeTab} === "explorer" && !!document.querySelector(".dock .files-view .fv-body:not([hidden]) .fv-group.open")`,
          board: `${activeTab} === "board"`,
          schedules: '!!document.querySelector(".pane.focused .sh-view") && !!document.querySelector(".pane.focused .wb-body")',
        };
        const viewMiss = [];
        for (const [view, expect] of Object.entries(landing)) {
          if (E.SMOKE_READONLY === '1' && view !== 'schedules' && view !== 'artifacts') continue;
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
          await sleep(350); // the columns animate
          await openHeaderMenu();
          await click(`.menu.sess-menu [data-view="${view}"]`);
          const ok = await waitFor(`!!(${expect})`, 6000);
          const inPlace = await js('!!document.querySelector(".pane.focused .sh-view")');
          if (!ok || (view !== 'schedules' && inPlace)) viewMiss.push(`${view}: ${await js(`JSON.stringify({ tab: ${activeTab}, open: window.__store.getState().layout.dock.open, inPlace: ${inPlace} })`)}`);
          if (inPlace) { await click('.pane.focused .sh-view'); await sleep(250); }
          if (view === 'git') await js('document.querySelector(".dock .rv-git .rv-bar .btn")?.click()');
        }
        check('every header ··· view lands where viewTarget says (审阅 / 文件 / Issue 与 PR tab / 定时任务 in place)', !viewMiss.length, viewMiss.join(' | '));

        if (E.SMOKE_READONLY !== '1') {
          // I5: the header's terminal button → 终端
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
          await sleep(350);
          await click('.sess-head button[aria-label="终端"]');
          check('the header terminal button opens 终端', await waitFor(`${activeTab} === "terminal" && !!document.querySelector(".dock .xterm")`, 8000));

          // I5: a tool row's 详情 → 详情; closing it (M12) keeps the default panel open on a fixed tab
          const t = new Date().toISOString();
          const base = { isSidechain: false, userType: 'external', cwd: E.SMOKE_REPO, sessionId: E.SMOKE_SID, version: '2.1.281', gitBranch: 'master' };
          const lines = [
            { ...base, parentUuid: '00000000-0000-4000-8000-000000000002', type: 'assistant', message: { id: 'msg_smoke_read', type: 'message', role: 'assistant', model: 'claude-smoke', content: [{ type: 'tool_use', id: 'toolu_smoke_read', name: 'Read', input: { file_path: path.join(E.SMOKE_REPO, 'README.md') } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }, uuid: '00000000-0000-4000-8000-000000000003', timestamp: t },
            { ...base, parentUuid: '00000000-0000-4000-8000-000000000003', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_smoke_read', content: '# smoke repo' }] }, uuid: '00000000-0000-4000-8000-000000000004', timestamp: t },
          ];
          fs.appendFileSync(E.SMOKE_TRANSCRIPT, lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
          // only the fixed tabs open (the palette walk above opened every panel): 详情 is the one temporary tab
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { tabs: ['files', 'explorer', 'terminal', 'tasks'], active: 'terminal' } })`);
          await js(`window.__store.getState().loadHistory(${JSON.stringify(E.SMOKE_SID)})`);
          const row = await waitFor('!!document.querySelector(\'.pane.focused .tool-head button[aria-label="详情"]\')', 8000);
          await click('.pane.focused .tool-head button[aria-label="详情"]');
          const detail = row && await waitFor(`${activeTab} === "inspector" && !!document.querySelector('.dock-panel[data-panel="inspector"]:not([hidden])')`, 4000);
          check('a tool row’s 详情 opens 详情 in the right panel', detail, JSON.stringify({ row }));
          await click('.dock .dock-tabs .tab[data-panel="inspector"] .x');
          // N7: back on the fixed tab that was in front before (终端), not the first one (审阅)
          const landed = await waitFor(`window.__store.getState().layout.dock.open && !document.querySelector('.dock .dock-tabs .tab[data-panel="inspector"]') && !!document.querySelector('.dock .dock-tabs .tab.fixed.active[data-panel="terminal"]')`, 3000);
          check('closing the last temporary tab keeps the right panel open, on the fixed tab last in front (终端)', landed, await js(dockState));

          // I2: the desktop app on Windows at 1024 wide — the caption buttons take the top-right 150px of the tab
          // row: the four fixed tabs stay whole (never scrolled away), the 「更多」 menu stays inside the window
          phase = 'right-panel-desktop';
          win.setContentSize(1024, 860);
          await waitFor('innerWidth === 1024', 4000);
          await js(`document.documentElement.classList.add('desktop', 'win'); window.__store.setState({ sidebarOpen: true })`);
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'files' })`);
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'goals' })`);
          await sleep(900);
          const fit = await js(`(() => { const vw = innerWidth; const rp = document.querySelector('.rpanel').getBoundingClientRect(); const tabs = [...document.querySelectorAll('.dock .dock-tabs .tab.fixed')].map((t) => { const r = t.getBoundingClientRect(); const whole = r.width > 0 && r.left >= rp.left - 0.5 && r.right <= Math.min(rp.right, vw) + 0.5; const underCaption = r.top < 40 && r.right > vw - 150; return { id: t.dataset.panel, ok: whole && !underCaption }; }); return { vw, rp: Math.round(rp.width), stacked: !!document.querySelector('.dock-tabs.stacked'), tabs }; })()`);
          check('desktop · Windows, 1024 wide, a temporary tab open: the four fixed tabs are fully visible', fit.tabs.length === 4 && fit.tabs.every((x) => x.ok), JSON.stringify(fit));
          await click('.dock button.dock-more');
          const menu = await js(`(() => { const m = document.querySelector('.dock-more-menu'); if (!m) return null; const r = m.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom), vw: innerWidth, vh: innerHeight }; })()`);
          check('desktop · Windows, 1024 wide: the 「更多」 menu is inside the window', !!menu && menu.l >= 0 && menu.r <= menu.vw && menu.b <= menu.vh, JSON.stringify(menu));
          await shot('right-panel-desktop-win');
          await key('Escape');
          await click('.dock .dock-tabs .tab[data-panel="goals"] .x');

          // N1: the default size — 1440 wide, the 440px panel, 审阅 listing files, one temporary tab open: the row stays
          // beside the caption buttons (no room for a strip there: the temporary tab is in 「更多」, which says so)
          win.setContentSize(1440, 900);
          await waitFor('innerWidth === 1440', 4000);
          await js(`(() => { const d = window.__store.getState().dispatchLayout; d({ t: 'dock.set', patch: { width: 440 } }); d({ t: 'dock.show', panel: 'files' }); })()`);
          const countSel = `(document.querySelector('.dock .dock-tabs .tab[data-panel="files"] .n')?.textContent || '')`;
          // (the ··· walk above left 审阅 on 本次对话改动, which lists nothing here: back to 未提交的改动 — README.md)
          await sleep(400);
          await click('.dock .rv-scope');
          await waitFor('!!document.querySelector(".rv-scope-menu")', 3000);
          await js(`[...document.querySelectorAll('.rv-scope-menu button')].find((b) => b.textContent.includes('未提交'))?.click()`);
          const counted = await waitFor(`${countSel} !== ''`, 8000);
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'goals' })`);
          await sleep(700);
          const rowProbe = `(() => { const vw = innerWidth; const rp = document.querySelector('.rpanel').getBoundingClientRect(); const fixed = [...document.querySelectorAll('.dock .dock-tabs .tab.fixed')].map((t) => { const r = t.getBoundingClientRect(); return r.width > 0 && r.right <= Math.min(rp.right, vw) + 0.5 && !(r.top < 40 && r.right > vw - 150); }); const strip = document.querySelector('.dock .dock-tablist .tab[data-panel="goals"]'); return { vw, rp: Math.round(rp.width), stacked: !!document.querySelector('.dock-tabs.stacked'), fixedOk: fixed.length === 4 && fixed.every(Boolean), count: ${countSel}, badge: document.querySelector('.dock .dock-more-n')?.textContent ?? null, strip: !!strip && strip.getBoundingClientRect().width > 0, moreActive: !!document.querySelector('.dock button.dock-more.active'), fixedW: Math.round(document.querySelector('.dock .dock-fixed').getBoundingClientRect().width), ctlW: Math.round(document.querySelector('.dock .dock-ctl').getBoundingClientRect().width), bodyTop: Math.round(document.querySelector('.dock .dock-body').getBoundingClientRect().top) }; })()`;
          const r1440 = await js(rowProbe);
          check('desktop · Windows, 1440 wide, default panel, 审阅 with files, a temporary tab open: the row is not moved below the caption buttons', counted && r1440.rp === 440 && !r1440.stacked && r1440.fixedOk && r1440.bodyTop <= 53, JSON.stringify(r1440));
          check('…and the temporary tab is reachable: its own tab, or 「更多」 counting it (and marked while it is in front)', r1440.strip || (r1440.badge === '1' && r1440.moreActive), JSON.stringify(r1440));
          await shot('right-panel-desktop-win-1440');
          await click('.dock button.dock-more');
          const openRow = await js(`(() => { const b = document.querySelector('.dock-more-menu .dock-more-open[data-open="goals"] button[data-panel="goals"]'); return b ? b.getAttribute('aria-checked') : null; })()`);
          check('1440: 「更多」 lists the open temporary tab on top, checked while it is in front', r1440.strip || openRow === 'true', String(openRow));
          // N2: the menu closes when the settings page covers the window, and when its button goes away (Ctrl+J)
          await js('window.__store.getState().openSettings()');
          const closedBySettings = await waitFor('!document.querySelector(".dock-more-menu")', 3000);
          await js('window.__store.setState({ settingsOpen: null })');
          await sleep(300);
          await click('.dock button.dock-more');
          const reopened = await waitFor('!!document.querySelector(".dock-more-menu")', 2000);
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
          const closedByHide = await waitFor('!document.querySelector(".dock-more-menu")', 3000);
          check('the 「更多」 menu closes when settings open and when the right panel is hidden', closedBySettings && reopened && closedByHide, JSON.stringify({ closedBySettings, reopened, closedByHide }));
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: true } })`);
          await sleep(400);
          // closing it from the menu goes back to the fixed tab that was in front (审阅: shown before 目标)
          if (!r1440.strip) {
            await click('.dock button.dock-more');
            await click('.dock-more-menu .dock-more-open[data-open="goals"] button.x');
          } else await click('.dock .dock-tabs .tab[data-panel="goals"] .x');
          const back = await waitFor(`!window.__store.getState().layout.dock.tabs.includes('goals') && !!document.querySelector('.dock .dock-tabs .tab.fixed.active[data-panel="files"]') && !document.querySelector('.dock .dock-more-n')`, 3000);
          check('closing the temporary tab from 「更多」 lands on 审阅 (the fixed tab in front before) and the count goes', back, await js(dockState));
          // switching conversation (审阅 reloads: its count goes empty, then back) never moves the row or the panel
          await js(`(() => { const r = document.querySelector('.dock .dock-tabs'); window.__cwFlips = []; window.__cwFlipObs = new MutationObserver(() => window.__cwFlips.push(r.className)); window.__cwFlipObs.observe(r, { attributes: true, attributeFilter: ['class'] }); })()`);
          const top0 = await js(rowProbe);
          await js(`window.__store.getState().openInPane(null, 'replace')`);
          await sleep(900);
          const topMid = await js(rowProbe);
          await js(`window.__store.getState().openInPane(${JSON.stringify(E.SMOKE_SID)}, 'replace')`);
          const recounted = await waitFor(`${countSel} !== ''`, 8000);
          await sleep(300);
          const top1 = await js(rowProbe);
          const flips = await js('(() => { window.__cwFlipObs.disconnect(); return window.__cwFlips; })()');
          check('switching conversation and back: the panel top stays put and the row never moves down', recounted && top0.bodyTop === topMid.bodyTop && top1.bodyTop === top0.bodyTop && !top0.stacked && !flips.some((c) => /stacked/.test(c)), JSON.stringify({ top0: top0.bodyTop, mid: [topMid.bodyTop, topMid.count], top1: [top1.bodyTop, top1.count], flips }));
          await js(`document.documentElement.classList.remove('desktop', 'win')`);
          win.setContentSize(1360, 860);
          await waitFor('innerWidth === 1360', 4000);
          await sleep(300);
          phase = 'right-panel';
        }
        const errRp = await noBoundary('.dock');
        check('right panel checks without error boundary', !errRp, errRp);

        {
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
          // the right-panel phase before this one opens the header ··· and panel menus: nothing of it may be left over
          // (the one-menu checks below count menus)
          await js('window.dispatchEvent(new Event("cw:close-menus"))');
          await closeMenus();
          const leftover = await js('[...document.querySelectorAll(".menu")].map((m) => m.className).join(" | ")');
          check('sidebar phase starts with no menu left open by the right-panel phase', !leftover, leftover);
          const ctxMenu = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 8, button: 2 })); return true; })()`);
          const count = (sel) => js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
          const exists = (sel) => js(`!!document.querySelector(${JSON.stringify(sel)})`);
          // every id of entries.ts PLACES must be seen in the DOM, each in its own place, at some point of this phase
          const PLACES = inv.sidebar;
          const SCOPES = {
            top: '.sidebar .sb-top [data-id], .sidebar .sb-nav [data-id]',
            automation: '.menu.sb-auto-menu [data-id]',
            section: '.sidebar .sb-sec[data-id], .sidebar .sb-group[data-id]',
            head: '.sidebar [data-id="projects"] > .sb-sec-h [data-id]',
            filter: '.menu.sb-filter [data-id]',
            project: '.menu.sb-menu[aria-label^="项目"] [data-id], .sidebar .sb-group-head .acts [data-id]',
            row: '.sidebar .sb-list [data-id], .sidebar .sb-attn [data-id]',
            rowMenu: '.menu.sess-menu [data-id]',
            account: '.sidebar .sb-account [data-id]',
            hint: '.sidebar .sb-hint [data-id]',
          };
          const seen = {};
          const harvest = async () => {
            const got = await js(`(() => { const S = ${JSON.stringify(SCOPES)}; const o = {}; for (const p of Object.keys(S)) o[p] = [...document.querySelectorAll(S[p])].map((e) => e.dataset.id); return o; })()`);
            for (const p of Object.keys(got)) for (const id of got[p]) if ((PLACES[p] || []).includes(id)) (seen[p] = seen[p] || new Set()).add(id);
          };
          const sb = await js(`({ chipRows: !!document.querySelector('.sidebar .sb-sources, .sidebar .src-chip, .sidebar .sb-search, .sidebar .lib-banner'), top: [...document.querySelectorAll('.sidebar .sb-top [data-id], .sidebar .sb-nav [data-id]')].map((e) => e.dataset.id), head: [...document.querySelectorAll('.sidebar [data-id="projects"] > .sb-sec-h [data-id]')].map((e) => e.dataset.id), account: [...document.querySelectorAll('.sidebar .sb-account [data-id]')].map((e) => e.dataset.id), row: !!document.querySelector('.sidebar .sb-list [data-sid=' + ${JSON.stringify(SID)} + '] [data-id="status"]') })`);
          check('sidebar: no chip / filter-box rows; 新对话 · 搜索 · 自动化; funnel + 打开文件夹 on 项目; account row (connection, settings); the row ends in one status',
            !sb.chipRows && has(sb.top, ['collapse', 'new', 'search', 'automation']) && has(sb.head, ['filter', 'add-project']) && has(sb.account, ['account', 'connection', 'settings']) && sb.row, JSON.stringify(sb));
          await harvest();
          await shot('sidebar');
          // the funnel: sources, machines (when there are other machines), archived, multi-select, the filter box
          await click('.sidebar [data-id="filter"]');
          const fm = await ids('.menu.sb-filter [data-id]');
          const fmIn = await js('(() => { const m = document.querySelector(".menu.sb-filter"); if (!m) return false; const r = m.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()');
          check('funnel menu: filter box, sources, 显示已归档, 选择多个, 管理对话来源 — inside the window', has(fm, ['query', 'source', 'archived', 'select', 'library']) && fmIn, JSON.stringify({ fm, fmIn }));
          await harvest();
          await shot('sidebar-filter');
          if (E.SMOKE_READONLY !== '1') {
            wc.insertText('zzz-no-such-conversation');
            await sleep(400);
            const filtered = await js('({ summary: document.querySelector(".sidebar .sb-filtered .what")?.textContent || "", rows: document.querySelectorAll(".sidebar .sb-list .sb-row").length })');
            check('the filter box filters the list and the list says it is filtered', filtered.rows === 0 && filtered.summary.includes('zzz-no-such'), JSON.stringify(filtered));
            // the 已筛选 row pushed the funnel down: the menu follows its anchor instead of covering it
            const follow = await js('(() => { const b = document.querySelector(".sidebar [data-id=filter]")?.getBoundingClientRect(); const m = document.querySelector(".menu.sb-filter")?.getBoundingClientRect(); return !!b && !!m && (m.top >= b.bottom - 1 || m.bottom <= b.top + 1); })()');
            check('the funnel menu follows its button when the list above it changes', follow);
            await closeMenus();
            await click('.sidebar .sb-filtered .link');
            check('清除 brings the list back', await waitFor(`!document.querySelector('.sidebar .sb-filtered') && !!document.querySelector('.sidebar .sb-list [data-sid=' + ${JSON.stringify(SID)} + ']')`, 3000));
          }
          await closeMenus();
          // one menu at a time: with the funnel open, 自动化 replaces it (the toggles stop the click that closes menus,
          // so only the one menu state can close the other; the funnel's menu does not cover the 自动化 row)
          await click('.sidebar [data-id="filter"]');
          await click('.sidebar [data-id="automation"]');
          const one = { menus: await count('.menu.sb-menu, .menu.sess-menu'), auto: await exists('.menu.sb-auto-menu'), funnel: await exists('.menu.sb-filter') };
          check('the sidebar shows one menu at a time (漏斗 → 自动化 closes the funnel)', one.menus === 1 && one.auto && !one.funnel, JSON.stringify(one));
          // 自动化 → the schedules / goals / orchestration panels (until the automation page)
          if (!one.auto) await click('.sidebar [data-id="automation"]');
          const am = await ids('.menu.sb-auto-menu [data-id]');
          check('自动化 lists 定时任务 / 目标 / 编排', has(am, ['schedules', 'goals', 'orchestra']), JSON.stringify(am));
          await harvest();
          await click('.menu.sb-auto-menu [data-id="goals"]');
          check('自动化 → 目标 shows the goals panel', await waitFor(`(() => { const d = window.__store.getState().layout.dock; return d.open && d.active === 'goals'; })()`, 3000));
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
          // the account row: quota, today's spend, usage & ledger, the config panel, appearance, shortcuts, palette
          await click('.sidebar [data-id="account"]');
          const acc = await ids('.menu.sb-acct-menu [data-id]');
          check('account popover: 今日费用, 用量与账本, 配置中心, 外观, 快捷键, 命令面板', has(acc, ['today', 'usage', 'config', 'appearance', 'shortcuts', 'palette']), JSON.stringify(acc));
          await harvest();
          await shot('sidebar-account');
          await closeMenus();
          // the conversation menu (right-click = ···): every session action, by capability
          await ctxMenu(`.sidebar .sb-list [data-sid=${SID}]`);
          await sleep(300);
          const rm = await ids('.menu.sess-menu [data-id]');
          check('conversation right-click menu: open in tab / split, resume, pin, folder, VS Code, reference, rename, fork, archive, hand-over, native CLI, copy id, delete',
            has(rm, ['open-tab', 'open-split', 'resume', 'pin', 'explorer', 'vscode', 'reference', 'rename', 'fork', 'archive', 'handoff', 'native-cli', 'copy-id', 'delete']), JSON.stringify(rm));
          await harvest();
          await shot('sidebar-row-menu');
          if (E.SMOKE_READONLY !== '1') {
            await click('.menu.sess-menu [data-id="pin"]');
            check('置顶 moves the conversation into the 置顶 section', await waitFor(`!!document.querySelector('.sidebar [data-group="__pinned"] [data-sid=' + ${JSON.stringify(SID)} + ']')`, 4000));
            await harvest();
            await js(`window.__store.getState().setSessionMeta(${SID}, { pinned: false })`);
            await waitFor(`!document.querySelector('.sidebar [data-group="__pinned"]')`, 4000);
            // a project: its right-click menu has everything the old workspace ··· had
            await js(`window.__store.getState().addWorkspace(${JSON.stringify(E.SMOKE_REPO)})`);
            const proj = await waitFor(`!!document.querySelector('.sidebar [data-id="projects"] .sb-group [data-sid=' + ${JSON.stringify(SID)} + ']')`, 5000);
            await ctxMenu(`.sidebar [data-id="projects"] .sb-group:has([data-sid=${SID}]) .sb-group-head`);
            await sleep(300);
            const pm = await ids('.menu.sb-menu[aria-label^="项目"] [data-id]');
            check('a project (opened folder) groups its conversations; its menu: new here, worktree, terminal, rename, folder, VS Code, remove', proj && has(pm, ['new-here', 'worktree', 'terminal', 'rename', 'explorer', 'vscode', 'remove']), JSON.stringify({ proj, pm }));
            await harvest();
            await closeMenus();
            // 需要你: a conversation waiting for a permission shows there and at its row's end (the request is faked client-side)
            await js(`window.__store.setState((s) => { const o = s.open[${SID}]; return o ? { open: { ...s.open, [${SID}]: { ...o, state: 'waiting', pending: [{ requestId: 'smoke-fake', sessionId: ${SID}, toolName: 'Bash', input: { command: 'echo smoke' } }] } } } : {}; })`);
            const attn = await waitFor(`(() => { const a = document.querySelector('.sidebar [data-id="attention"] [data-sid=' + ${JSON.stringify(SID)} + '] [data-id="status"]'); const r = document.querySelector('.sidebar .sb-list [data-sid=' + ${JSON.stringify(SID)} + '] [data-id="status"]'); return !!a && a.textContent === '待确认' && r && r.textContent === '待确认'; })()`, 3000);
            check('需要你 lists a conversation waiting for a permission; its row ends in 待确认', attn);
            await harvest();
            await shot('sidebar-needs-you');
            // the same conversation is in 需要你 and in its project: a right-click opens one menu, on the row that was used
            await ctxMenu(`.sidebar [data-id="attention"] [data-sid=${SID}]`);
            await sleep(300);
            const attnMenu = { menus: await count('.menu.sess-menu'), inAttn: await count('.sidebar [data-id="attention"] .menu.sess-menu') };
            check('right-click on a 需要你 row opens exactly one conversation menu, there', attnMenu.menus === 1 && attnMenu.inAttn === 1, JSON.stringify(attnMenu));
            await closeMenus();
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
          await harvest();
          await shot('sidebar-select');
          // Esc belongs to what is on top: closing the command palette leaves the multi-select alone
          await js('window.__store.setState({ paletteOpen: true })');
          await waitFor('!!document.querySelector(".palette-bg")', 3000);
          await key('Escape');
          await sleep(200);
          const selKept = { palette: await exists('.palette-bg'), bar: await exists('.sidebar .sel-bar') };
          check('Esc in the command palette closes the palette, not the multi-select', !selKept.palette && selKept.bar, JSON.stringify(selKept));
          await js(`document.querySelector('.sidebar .sb-list [data-sid=' + ${JSON.stringify(SID)} + ']')?.focus()`);
          await key('Escape');
          const selOff = await js('!document.querySelector(".sidebar .sel-bar") && !document.querySelector(".sidebar .sel-box")');
          check('Shift-click starts multi-select with that row checked; Esc (in the sidebar) ends it', selOn.bar && selOn.checked >= 1 && selOff, JSON.stringify({ selOn, selOff }));
          if (E.SMOKE_READONLY !== '1') await sidebarScenarios();
          else check('sidebar entry coverage: skipped (read-only run: the scenarios change the list)', true);
          const errSb = await noBoundary('.sidebar');
          check('sidebar checks without error boundary', !errSb, errSb);

          /**
           * Scenarios the seeded HOME does not have, faked client-side (`__store.setState`): other machines (one offline),
           * a conversation with a fork, one running outside every project, account limits, an undiscovered source, a
           * live runner. Then every id of entries.ts PLACES must have been seen in its place.
           */
          async function sidebarScenarios() {
            const now = Date.now();
            const sep = E.SMOKE_REPO.includes('\\') ? '\\' : '/';
            const elsewhere = E.SMOKE_REPO.slice(0, E.SMOKE_REPO.lastIndexOf(sep)) + sep + 'elsewhere';
            const box = { id: 'smokepeer', name: 'Smoke Box' };
            const fakes = [
              ...Array.from({ length: 7 }, (_, i) => ({ sessionId: 'peer_smokepeer~s' + i, title: 'remote ' + i, cwd: '/remote/w', lastModified: now - 1000 * (i + 1), peer: box })),
              { sessionId: 'peer_offpeer~s0', title: 'offline machine', cwd: '/remote/x', lastModified: now - 9000, peer: { id: 'offpeer', name: 'Off Box', offline: true } },
              { sessionId: 'smoke-parent', title: 'has a fork', cwd: E.SMOKE_REPO, lastModified: now - 500, childCount: 1 },
              { sessionId: 'smoke-child', title: 'the fork', cwd: E.SMOKE_REPO, lastModified: now - 400, parentId: 'smoke-parent' },
              { sessionId: 'smoke-elsewhere', title: 'running outside the projects', cwd: elsewhere, lastModified: now - 300, live: 'running' },
            ];
            // a sessions.changed from the server replaces the list: put the fakes back before each step
            const inject = () => js(`(() => { const F = ${JSON.stringify(fakes)}; const s = window.__store.getState(); const have = new Set(s.sessions.map((x) => x.sessionId)); const add = F.filter((f) => !have.has(f.sessionId)); if (add.length) window.__store.setState({ sessions: [...s.sessions, ...add] }); return add.length; })()`);
            const saved = await js('JSON.stringify({ limits: window.__store.getState().limits, sources: window.__store.getState().librarySources })');
            const limits = { ok: true, capturedAt: new Date(now).toISOString(), subscriptionType: 'max', windows: [{ label: '5 小时', percent: 34, resetsAt: new Date(now + 3600e3).toISOString(), active: true }] };
            const codex = { kind: 'codex', name: 'Codex', installed: true, detected: true, joined: false, dismissed: false, enabled: false };
            await js(`(() => { const s = window.__store.getState(); const c = ${JSON.stringify(codex)}; window.__store.setState({ limits: ${JSON.stringify(limits)}, librarySources: [...s.librarySources.filter((x) => x.kind !== 'codex'), c] }); })()`);
            await inject();
            await sleep(400);
            await harvest();
            check('library hint: a detected source that was not joined shows the one-line hint (加入 / 以后再说)', await exists('.sidebar .sb-hint [data-id="library-join"]') && await exists('.sidebar .sb-hint [data-id="library-later"]'));
            // 其它文件夹 starts folded when there are projects: its running conversation stays in view, the header spins
            const other = { spin: await exists('.sidebar [data-id="other"] > .sb-sec-h .spin'), row: await exists('.sidebar [data-id="other"] .sb-kept [data-sid="smoke-elsewhere"] .st.run') };
            check('folded 其它文件夹: the header spins and the running conversation stays listed under it', other.spin && other.row, JSON.stringify(other));
            await js('document.querySelector(\'.sidebar [data-id="other"] > .sb-sec-h\')?.focus()');
            await key('Space');
            check('Space unfolds 其它文件夹 (its folders: 设为项目)', await waitFor('document.querySelector(\'.sidebar [data-id="other"] > .sb-sec-h\')?.getAttribute("aria-expanded") === "true" && !!document.querySelector(\'.sidebar [data-id="other"] .sb-group-head .acts [data-id="make-project"]\')', 3000));
            await harvest();
            await click('.sidebar [data-id="other"] > .sb-sec-h');
            // a fork under its parent
            await inject();
            await click('.sidebar .sb-list [data-sid="smoke-parent"] [data-id="kids"]');
            check('the arrow before a parent lists its forks underneath', await waitFor('!!document.querySelector(\'.sidebar .sb-list [data-sid="smoke-child"].kid\')', 3000));
            await harvest();
            // other machines: grouped by machine, 5 rows then 再显示 N 个 / 收起; an offline machine says so
            await inject();
            const peers = { rows: await count('.sidebar [data-group="peer:smokepeer"] .sb-row'), off: await exists('.sidebar [data-group="peer:offpeer"] .badge'), offRow: await exists('.sidebar [data-group="peer:offpeer"] .sb-row.offline') };
            await click('.sidebar [data-group="peer:smokepeer"] [data-id="more"]');
            const peersMore = { rows: await count('.sidebar [data-group="peer:smokepeer"] .sb-row'), less: await exists('.sidebar [data-group="peer:smokepeer"] [data-id="less"]') };
            check('其它电脑: 5 rows, 再显示 shows the rest and 收起; an offline machine is marked and read-only', peers.rows === 5 && peers.off && peers.offRow && peersMore.rows === 7 && peersMore.less, JSON.stringify({ peers, peersMore }));
            await harvest();
            await click('.sidebar [data-group="peer:smokepeer"] [data-id="less"]');
            // the funnel lists the machines once there is another one
            await inject();
            await click('.sidebar [data-id="filter"]');
            await harvest();
            check('funnel menu: 机器 once another machine has conversations', await exists('.menu.sb-filter [data-id="machine"]'));
            await closeMenus();
            // 显示已归档 widens the list, it is not a filter: no 已筛选 row, empty projects stay, the funnel shows it is on
            await js(`window.__store.getState().addWorkspace(${JSON.stringify(E.SMOKE_REPO + sep + 'src')})`);
            await waitFor('window.__store.getState().workspaces.length >= 2', 4000);
            await js('window.__store.setState({ showArchived: true })');
            await sleep(300);
            const arch = { row: await exists('.sidebar .sb-filtered'), dot: await exists('.sidebar [data-id="filter"] .fdot'), groups: await count('.sidebar [data-id="projects"] .sb-group'), projects: await js('window.__store.getState().workspaces.length') };
            check('显示已归档 is not a filter: no 已筛选 row, empty projects stay listed, the funnel is marked', !arch.row && arch.dot && arch.groups === arch.projects, JSON.stringify(arch));
            await js('window.__store.setState({ showArchived: false })');
            // the account popover with the account's limits: the quota windows
            await click('.sidebar [data-id="account"]');
            await harvest();
            check('account popover: the quota windows when the limits are known', await exists('.menu.sb-acct-menu [data-id="quota"]'));
            await closeMenus();
            // a live runner: 结束进程 in the conversation menu
            await js(`window.__store.setState((s) => { const o = s.open[${SID}]; return o ? { open: { ...s.open, [${SID}]: { ...o, state: 'idle' } } } : {}; })`);
            await ctxMenu(`.sidebar .sb-list [data-sid=${SID}]`);
            await sleep(300);
            await harvest();
            await closeMenus();
            await js(`window.__store.setState((s) => { const o = s.open[${SID}]; return o ? { open: { ...s.open, [${SID}]: { ...o, state: 'history' } } } : {}; })`);
            // back to the real list
            await js(`(() => { const ids = new Set(${JSON.stringify(fakes.map((f) => f.sessionId))}); const r = JSON.parse(${JSON.stringify(saved)}); window.__store.setState((s) => ({ sessions: s.sessions.filter((x) => !ids.has(x.sessionId)), limits: r.limits, librarySources: r.sources })); })()`);
            // nothing is reachable only in the table: every id of every place was on screen
            const missing = [];
            for (const p of Object.keys(PLACES)) for (const id of PLACES[p]) if (!(seen[p] && seen[p].has(id))) missing.push(p + ':' + id);
            check(`sidebar entries: all ${Object.values(PLACES).reduce((n, v) => n + v.length, 0)} ids of entries.ts PLACES were found in the DOM, each in its place`, !missing.length, missing.join(', '));
          }
        }
      }

      // ---- error boundary probe: a crash in one settings section stays in that section, 重试 recovers it
      if (E.SMOKE_READONLY !== '1') {
        phase = 'crash-probe';
        await js('window.__store.getState().openSettings({ section: "models" })');
        await sleep(800);
        expectErrors = true;
        await js('window.__cwCrash("设置 · 模型与智能程度")');
        const caught = await waitFor('!!document.querySelector(\'.modal.settings .err-boundary[data-area="设置 · 模型与智能程度"]\')', 5000);
        const rest = await js('!!document.querySelector(".modal.settings .sp-nav") && !!document.querySelector(".sidebar")');
        check('boundary catches a crash in its own section only', caught && rest);
        await shot('crash-boundary');
        await js('document.querySelector(\'.modal.settings .err-boundary[data-area="设置 · 模型与智能程度"] .eb-actions .btn\').click()');
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
