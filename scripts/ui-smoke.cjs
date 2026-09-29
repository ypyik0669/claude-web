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
  // a second, finished conversation with a turn of work (redesign phase 5: the fold, the change card, thinking time)
  const toolsSid = '5a0e0e0e-0000-4000-8000-00000000c0d5';
  const t0 = Date.now() - 600_000;
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const tb = { ...base, sessionId: toolsSid };
  const readme = path.join(repo, 'README.md');
  let pu = null, un = 0;
  const line = (o, s) => { const uuid = `00000000-0000-4000-8000-0000000c0d${String(++un).padStart(2, '0')}`; const l = { ...tb, parentUuid: pu, uuid, timestamp: at(s), ...o }; pu = uuid; return l; };
  const am = (content, s, id) => line({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model: 'claude-smoke', content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }, s);
  const tr = (id, content, s) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } }, s);
  fs.writeFileSync(path.join(proj, `${toolsSid}.jsonl`), [
    line({ type: 'user', message: { role: 'user', content: 'smoke: tidy the readme' } }, 0),
    am([{ type: 'thinking', thinking: 'read it first', signature: 'x' }], 12, 'msg_t1'),
    am([{ type: 'text', text: 'Looking at the readme.' }, { type: 'tool_use', id: 'toolu_t_read', name: 'Read', input: { file_path: readme } }], 13, 'msg_t1'),
    tr('toolu_t_read', '1\t# smoke repo', 14),
    am([{ type: 'tool_use', id: 'toolu_t_edit', name: 'Edit', input: { file_path: readme, old_string: '# smoke repo', new_string: '# smoke repo\n\nchanged' } }], 30, 'msg_t2'),
    tr('toolu_t_edit', 'updated', 31),
    am([{ type: 'tool_use', id: 'toolu_t_bash', name: 'Bash', input: { command: 'git status --short' } }], 40, 'msg_t3'),
    tr('toolu_t_bash', ' M README.md', 41),
    am([{ type: 'text', text: 'smoke: the readme is tidy now.' }], 45, 'msg_t4'),
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  return { repo, sid, toolsSid, transcript: path.join(proj, `${sid}.jsonl`) };
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
    SMOKE_TOOLS_SID: seed?.toolsSid ?? '',
    // the mock ACP agent (phase 5: a real permission request) runs under this node, not Electron
    SMOKE_NODE: process.execPath,
    SMOKE_SHOW: arg('--show', false) ? '1' : '',
    SMOKE_INVENTORY: JSON.stringify(inv),
  }, (idle + 520) * 1000);
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
  // the right-panel (phase 2), sidebar (phase 4) and chat (phase 5) phases together take ~6 minutes on a busy machine
  const hardStop = setTimeout(() => { check('driver finished in time', false); finish(6); }, (Number(E.SMOKE_IDLE || 0) + 480) * 1000);

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
    // every empty state seen on the way (redesign phase 7: 「还没有 X。Y 之后会出现在这里。」, at most one button)
    const emptySeen = new Map();
    const shot = async (name) => {
      try {
        // every empty state on screen, also the orchestra's own (.orch-empty) — one not built with EmptyState has no
        // .es-text, its whole text is checked (review 7 M14)
        const empties = await js(`[...document.querySelectorAll('.empty-state, .orch-empty')].filter((e) => e.getClientRects().length).map((e) => ({ t: (e.querySelector('.es-text') ?? e).textContent.trim(), b: e.querySelectorAll('button').length }))`).catch(() => []);
        for (const e of empties) emptySeen.set(e.t, e.b);
        const img = await wc.capturePage();
        const f = path.join(out, `ux-${name}.png`);
        fs.writeFileSync(f, img.toPNG());
        res.shots.push(f);
      } catch (e) { log(`shot ${name} failed: ${e.message}`); }
    };
    // an element below the fold is scrolled to the middle, not flush with the bottom edge (a toast sits there). When
    // that scrolled anything, wait for the scroll event before clicking: it fires on the next frame, and a menu the
    // click opens (the sidebar's anchored menus close when their anchor scrolls) would take it for its own.
    // A page still settling (a settings page mounting its parts) can move the target between measuring and clicking:
    // the point is checked with elementFromPoint and measured again (a few times) until the target is there.
    // A real mouse click at the target's centre — guarded (polish P5). The point is measured in the page but the input
    // event arrives a few ms later, asynchronously: a page still answering its own requests moves things in between
    // (设置 → 账号与登录 grows ~66px when the login check answers, 手机与其它电脑 ~200px when the remote / peer status
    // arrives — later on a busy server), and the old helper, after four failed hit tests, clicked anyway. So:
    //  1. wait until the target's box is the same on consecutive animation frames (it is not moving right now);
    //  2. arm a one-shot guard in the page: a mouse-down that does not land inside the target is swallowed together with
    //     its mouse-up / click (nothing else gets clicked by mistake) and reported;
    //  3. on a miss, measure again and click again (a few times), logging where each miss landed.
    // `beforeSend` (the helper's own check only): page code run once, after the first measurement, before the events
    const click = async (selector, { beforeSend } = {}) => {
      const S = JSON.stringify(selector);
      const place = (scroll) => js(`new Promise((res) => {
        const el0 = document.querySelector(${S});
        if (!el0) return res(null);
        const b0 = el0.getBoundingClientRect();
        // below the fold → the middle (flush with the bottom edge a toast sits there); else only as far as needed
        if (${scroll}) el0.scrollIntoView({ block: b0.top < 0 || b0.bottom > innerHeight - 48 ? 'center' : 'nearest' });
        let last = '', same = 0, n = 0, done = false;
        const finish = () => {
          if (done) return;
          done = true;
          const el = document.querySelector(${S});
          if (!el) return res(null);
          const b = el.getBoundingClientRect();
          const x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2);
          const at = document.elementFromPoint(x, y);
          res({ x, y, hit: !!at && (el === at || el.contains(at)), frames: n });
        };
        const tick = () => {
          if (done) return;
          const el = document.querySelector(${S});
          if (!el) { done = true; return res(null); }
          const b = el.getBoundingClientRect();
          const k = [b.left, b.top, b.width, b.height].map(Math.round).join(',');
          same = k === last ? same + 1 : 0;
          last = k;
          if (same >= 2 || ++n >= 90) return finish();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(finish, 2000); // frames stalled: measure anyway
      })`);
      let r = null;
      const misses = [];
      for (let attempt = 1; attempt <= 4; attempt++) {
        r = (await place(attempt === 1 || attempt === 3)) ?? r;
        if (!r) return null;
        await js(`(() => {
          const sel = ${S};
          const g = window.__smokeGuard = { down: null, stop: (e) => { e.preventDefault(); e.stopImmediatePropagation(); } };
          g.onDown = (e) => {
            const t = e.target;
            g.down = { hit: !!t.closest?.(sel), at: [t.tagName, String(t.className?.baseVal ?? t.className ?? ''), (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30)].join(' · ') };
            if (!g.down.hit) { g.stop(e); addEventListener('mouseup', g.stop, true); addEventListener('click', g.stop, true); }
          };
          addEventListener('mousedown', g.onDown, { capture: true, once: true });
        })()`);
        if (beforeSend && attempt === 1) await js(beforeSend);
        wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
        wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
        await sleep(250);
        const down = await js(`(() => { const g = window.__smokeGuard; removeEventListener('mousedown', g.onDown, true); removeEventListener('mouseup', g.stop, true); removeEventListener('click', g.stop, true); window.__smokeGuard = null; return g.down; })()`);
        if (down && down.hit) return { ...r, attempts: attempt, misses };
        misses.push(down ? down.at : 'nothing');
        log(`click ${selector} (attempt ${attempt}) at ${r.x},${r.y}${r.hit ? '' : ' (not on top there when measured)'} landed on ${down ? down.at : 'nothing'} — swallowed`);
      }
      return { ...r, missed: true, misses };
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
        if (E.SMOKE_READONLY === '1' || E.SMOKE_MODE === 'idle' || !E.SMOKE_REPO) {
          if (E.SMOKE_READONLY !== '1') await js('window.__store.getState().setSetting("onboarded", true)');
          else await js('document.querySelector(".modal-bg")?.remove()');
        } else {
          // redesign phase 7 (spec §5.8 / §7 row 7): two steps — ① 登录 (skippable) ② a project folder — and the
          // first message is one Enter away: 先跳过 · the folder · Enter = 3 steps from a cold start
          const steps = await js(`[...document.querySelectorAll('.modal.onboarding .ob-steps li')].map((l) => l.textContent)`);
          check('onboarding: two steps (登录 · 选一个项目文件夹)', steps.length === 2 && /登录/.test(steps[0]) && /项目文件夹/.test(steps[1]), JSON.stringify(steps));
          let taken = 0;
          // before the login check answers, a neutral 正在检查登录… (review 7 M9) — not a step to act on
          const checking = await js(`document.querySelector('.modal.onboarding')?.dataset.step === 'checking' ? (document.querySelector('.modal.onboarding .ob-checking')?.textContent ?? '') : null`);
          if (checking !== null) check('onboarding: 正在检查登录… until the login check answers (no login buttons yet)', /正在检查登录/.test(checking) && !(await js(`!!document.querySelector('.modal.onboarding [data-ob="skip"]')`)), checking);
          await waitFor(`document.querySelector('.modal.onboarding')?.dataset.step !== 'checking'`, 30_000);
          if (await js(`document.querySelector('.modal.onboarding')?.dataset.step === 'login'`)) {
            const loginRow = await js(`[...document.querySelectorAll('.modal.onboarding .ob-actions button')].map((b) => b.textContent.trim())`);
            check('onboarding ①: 在终端登录 / 添加供应商 / 先跳过', ['在终端登录', '添加供应商', '先跳过'].every((t) => loginRow.some((x) => x.includes(t))), JSON.stringify(loginRow));
            await click('.modal.onboarding [data-ob="skip"]');
            taken++;
          }
          const folderSel = `.modal.onboarding [data-ob="folder"][title=${JSON.stringify(E.SMOKE_REPO)}]`;
          const listed = await waitFor(`!!document.querySelector(${JSON.stringify(folderSel)})`, 8000);
          check('onboarding ②: the folder the CLI already worked in is one click away', listed, await js(`[...document.querySelectorAll('.modal.onboarding [data-ob]')].map((b) => b.dataset.ob + ':' + (b.title || b.textContent)).join(' | ')`));
          await shot('onboarding-project');
          await click(folderSel);
          taken++;
          const done = await waitFor(`!document.querySelector('.modal.onboarding') && window.__store.getState().workspaces.some((w) => w.path === ${JSON.stringify(E.SMOKE_REPO)})`, 5000);
          const ready = await waitFor(`document.activeElement === document.querySelector('.welcome .composer textarea') && (document.querySelector('.welcome .dirpick')?.textContent || '').includes(${JSON.stringify(path.basename(E.SMOKE_REPO))})`, 4000);
          wc.insertText('smoke：第一条');
          await sleep(250);
          const sendable = await js(`(() => { const b = document.querySelector('.welcome .composer [data-id="send"]'); return !!b && !b.disabled; })()`);
          // step 3 for real (review 7 M14): Enter sends — the tile becomes that conversation and holds the message
          await key('Enter');
          taken++;
          const sentExpr = `(() => { const st = window.__store.getState(); const o = Object.values(st.open).find((x) => x.conv.items.some((i) => i.kind === 'user' && String(i.text).includes('smoke：第一条'))); return o ? { sid: o.sessionId, cwd: o.cwd, lastSent: !!o.lastSent, inPane: st.layout.groups.some((g) => Object.values(g.panes).some((p) => p.tiles.some((t) => t.kind === 'chat' && t.sessionId === o.sessionId))) } : null; })()`;
          await waitFor(`!!${sentExpr}`, 30_000);
          const sent = await js(sentExpr);
          check('cold start → first message in 3 steps (先跳过 · the folder · Enter): Enter sent it from that folder into this tile', done && ready && sendable && taken <= 3 && !!sent && sent.lastSent && sent.inPane && sent.cwd === E.SMOKE_REPO, JSON.stringify({ done, ready, sendable, steps: taken, sent }));
          // the first message also ticks 发出第一个任务 in the 入门清单 (only a message sent from here does)
          check('入门清单: the message sent from here marks 发出第一个任务', await waitFor(`(window.__store.getState().settings['onboarding.checklist']?.done || []).includes('send')`, 5000));
          // leave its process (no login in this HOME) and come back to an empty start page for the checks below
          if (sent) await js(`window.__store.getState().closeSession(${JSON.stringify(sent.sid)})`).catch(() => {});
          await js(`window.__store.getState().openInPane(null, 'replace')`);
          await waitFor('!!document.querySelector(".welcome .composer textarea")', 5000);
          await sleep(300);
        }
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
      // redesign phase 7 (spec §5.8, mock-home.png): 「今天想做点什么？」 · four starters that only fill the box · the
      // login notice only when something is wrong · 入门清单 · 最近任务 / 定时任务 / 已归档
      {
        const home = await js(`(() => { const w = document.querySelector('.welcome'); if (!w) return null; return { title: w.querySelector('h1.greet')?.textContent ?? '', starters: [...w.querySelectorAll('.starters .starter')].map((b) => b.dataset.starter), tabs: [...w.querySelectorAll('.home-tabs [role="tab"]')].map((t) => t.dataset.tab), rows: w.querySelectorAll('.home-list .home-row').length, greetWords: /早上好|下午好|晚上好/.test(w.innerText) }; })()`);
        check('home: 「今天想做点什么？」, 4 starters, 最近任务 / 已归档 with the seeded conversation, no time-of-day greeting', home && home.title === '今天想做点什么？' && home.starters.length === 4 && home.tabs.includes('recent') && home.tabs.includes('archived') && (!E.SMOKE_SID || home.rows >= 1) && !home.greetWords, JSON.stringify(home));
        if (E.SMOKE_READONLY !== '1') {
          const layoutBefore = await js('JSON.stringify(window.__store.getState().layout.groups.map((g) => Object.values(g.panes).map((p) => p.tiles.map((t) => t.kind + ":" + (t.sessionId || "")))))');
          await click('.welcome .starters [data-starter="explain"]');
          await sleep(250);
          const filled = await js(`({ text: document.querySelector('.welcome .composer textarea').value, focused: document.activeElement === document.querySelector('.welcome .composer textarea'), layout: JSON.stringify(window.__store.getState().layout.groups.map((g) => Object.values(g.panes).map((p) => p.tiles.map((t) => t.kind + ":" + (t.sessionId || ""))))) })`);
          check('a starter fills the box (focused) and sends nothing', filled.text.length > 4 && filled.focused && filled.layout === layoutBefore, JSON.stringify({ ...filled, layoutBefore }));
          wc.selectAll(); wc.delete();
          await sleep(200);
        }
        // the 入门清单: one row (入门 d/4 · next step · its button · ×) that unfolds into the four steps
        const guide = await js(`(() => { const g = document.querySelector('.welcome .guide'); if (!g) return null; return { count: g.querySelector('.guide-count .n')?.textContent ?? '', next: g.querySelector('.guide-next')?.textContent ?? '' }; })()`);
        await click('.welcome .guide .guide-count');
        const steps = await js(`[...document.querySelectorAll('.welcome .guide .guide-steps li')].map((l) => l.dataset.step + (l.classList.contains('done') ? ':done' : ''))`);
        check('入门清单: 入门 d/4 with the next step, unfolding into 选项目 / 发任务 / 审阅 / Ctrl K (the project done by the wizard)', guide && /^入门 \d\/4$/.test(guide.count) && /下一步/.test(guide.next) && steps.length === 4 && (E.SMOKE_READONLY === '1' || !E.SMOKE_REPO || steps.includes('project:done')), JSON.stringify({ guide, steps }));
        await shot('home-checklist');
        await click('.welcome .guide .guide-count');
        // the login notice: exactly when the auth check says 「not logged in」 and no provider is set up
        await waitFor('window.__store.getState().auth !== null', 20_000);
        const notice = await js(`({ auth: window.__store.getState().auth?.loggedIn ?? null, providers: window.__store.getState().providers.length, text: document.querySelector('.welcome .home-notice')?.textContent ?? null })`);
        const wantNotice = notice.auth === false && notice.providers === 0;
        check('home: 「还没登录 Claude。[在终端登录] [添加供应商]」 only when not logged in (nothing when fine)', wantNotice ? /还没登录 Claude。/.test(notice.text ?? '') && /在终端登录/.test(notice.text) && /添加供应商/.test(notice.text) : notice.text === null || !/登录/.test(notice.text), JSON.stringify(notice));
      }
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
        const wanted = reach.reach.filter((r) => r.place === place && (!r.when || (r.when === 'speech' && speech && !states.mobile) || states[r.when]));
        const opener = reach.opener[place];
        const box = opener ? reach.container[place] : `${scope} ${reach.container[place]}`;
        if (opener) { await click(`${scope} ${opener}`); await waitFor(`!!document.querySelector(${JSON.stringify(box)})`, 5000); }
        const missing = (list) => js(`${JSON.stringify(list)}.filter((r) => !document.querySelector(${JSON.stringify(box)} + ' ' + r.sel)).map((r) => r.was + ' → ' + r.sel)`);
        const miss = await missing(wanted);
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
        // Brief and 频道: rows of their own under 进阶 (final review M3: 2 clicks, as 功能 → Brief was) — Brief right
        // after 主动, ↓ from Brief reaches the 频道 field, and what is typed there survives a click outside (it is saved
        // as you type, into meta.json ui.featureDefaults)
        await click('.welcome .cb .plus');
        const rows = await js(`[...document.querySelectorAll('.menu.plus-menu [data-id]')].map((e) => e.dataset.id)`);
        await js(`document.querySelector('.menu.plus-menu [data-id="brief"]').focus()`);
        await key('Down');
        const inField = await js('document.activeElement?.closest?.(\'[data-id="channels"]\') ? "channels" : document.activeElement?.tagName');
        wc.insertText('server:smoke');
        await sleep(100);
        await click('.welcome .composer textarea');
        const saved = await waitFor('JSON.stringify(window.__store.getState().settings["ui.featureDefaults"]?.channels) === \'["server:smoke"]\'', 3000);
        check('+ → Brief / 频道 in 2 clicks (rows under 进阶, no 「Brief、频道…」 expander); ↓ from Brief reaches the field; typing survives a click outside', rows.join() === 'files,folder,reference,chrome,computerUse,goal,coordinator,proactive,brief,channels' && inField === 'channels' && saved && !(await js('!!document.querySelector(".menu.plus-menu")')), JSON.stringify({ rows, inField, saved }));
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
      // the click helper itself (polish P5): the page moves down 44px between the measurement and the click (what a late
      // answer to the page's own request does), so the row above 更多选项 sits under the point; the mouse-down that lands
      // there is swallowed — no switch of that page flips — and the helper measures and clicks again. A transform, not
      // padding: the scroller's scroll anchoring cancels a padding shift above a scrolled-to button (tests nothing)
      phase = 'settings:click-guard';
      await js(`window.__store.getState().openSettings({ section: 'general' })`);
      await waitFor(onPage('general'), 3000);
      const generalValues = `JSON.stringify(${JSON.stringify(['ui.defaultMode', 'autoContinueOnReset', 'ui.showThinking', 'ui.diffMode', 'ui.inlineDiffs', 'ui.workbench', 'ui.autoSave', 'ui.notifications', 'ui.closeToTray', 'ui.confirmExit'])}.map((k) => window.__store.getState().settings[k]))`;
      const valuesBefore = await js(generalValues);
      const shifted = await click('.modal.settings .sp-more-h', { beforeSend: `document.querySelector('.modal.settings .sp-inner').style.transform = 'translateY(44px)'` });
      const guardOpened = await waitFor(`document.querySelector('.modal.settings .sp-more-h')?.getAttribute('aria-expanded') === 'true'`, 3000);
      await js(`document.querySelector('.modal.settings .sp-inner').style.transform = ''`);
      const valuesAfter = await js(generalValues);
      check('ui-smoke click helper: a click the page moved off its target is swallowed (nothing under it toggled) and made again (polish P5)', guardOpened && !!shifted && shifted.attempts === 2 && shifted.misses.length === 1 && shifted.misses[0] !== 'nothing' && valuesBefore === valuesAfter, JSON.stringify({ guardOpened, attempts: shifted && shifted.attempts, misses: shifted && shifted.misses, valuesBefore, valuesAfter }));
      // the loop below starts from a closed 更多选项 (another page resets it)
      await js(`window.__store.getState().openSettings({ section: 'appearance' })`);
      await waitFor(onPage('appearance'), 3000);
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
          // the page's own requests can still grow it: let it settle, or the click lands where the button was
          await sleep(400);
          // (diagnostics) the button's position every frame from here on, and what is on screen around it
          await js(`(() => { const L = window.__moreTrail = []; const t0 = performance.now(); let last = ''; const tick = () => { if (window.__moreTrail !== L) return; const b = document.querySelector('.modal.settings .sp-more-h'); const s = b ? Math.round(b.getBoundingClientRect().top) + '/' + document.querySelector('.sp-scroll')?.scrollTop + '/' + b.getAttribute('aria-expanded') : 'none'; if (s !== last) { L.push(Math.round(performance.now() - t0) + ':' + s); last = s; } requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
          const at = await click('.modal.settings .sp-more-h');
          const opened = await waitFor(`document.querySelector('.modal.settings .sp-more-h')?.getAttribute('aria-expanded') === 'true'`, 3000);
          if (!opened) log(`更多选项 on ${name} did not open: click ${JSON.stringify(at)} trail ${await js('JSON.stringify(window.__moreTrail)')} toasts ${await js('JSON.stringify([...document.querySelectorAll(".toast")].map((t) => t.textContent.slice(0, 60)))')} over ${await js(`(() => { const b = document.querySelector('.modal.settings .sp-more-h')?.getBoundingClientRect(); if (!b) return null; const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return e && [e.tagName, e.className].join(' '); })()`)}`);
          await js('window.__moreTrail = null');
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
        // the shortcut sheet over the page (final review M1): `?` with the focus on the page (not in a field) opens it
        // above the page — it used to open underneath and show up only after the page closed — and Esc closes the sheet only
        phase = 'settings:shortcuts';
        await js(`document.querySelector('.modal.settings.sp').focus()`);
        await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))`);
        await waitFor('!!document.querySelector(".shortcuts-bg")', 2000);
        await sleep(200);
        const sheetOver = await js(`(() => { const bg = document.querySelector('.shortcuts-bg'); if (!bg) return null; const m = bg.querySelector('.modal').getBoundingClientRect(); const e = document.elementFromPoint(m.left + m.width / 2, m.top + 20); return { hit: e ? (e.closest('.shortcuts-bg') ? 'sheet' : e.closest('.modal.settings') ? 'settings' : e.className) : null, inert: bg.hasAttribute('inert'), focus: !!document.activeElement?.closest('.shortcuts-bg') }; })()`);
        await key('Escape');
        const afterSheet = await js(`({ sheet: !!document.querySelector('.shortcuts-bg'), open: !!document.querySelector('.modal.settings.sp'), back: !!document.activeElement?.closest('.modal.settings.sp') })`);
        check('`?` on the settings page opens the shortcut sheet above it (not inert, focused); Esc closes only the sheet, the page gets the focus back', !!sheetOver && sheetOver.hit === 'sheet' && !sheetOver.inert && sheetOver.focus && !afterSheet.sheet && afterSheet.open && afterSheet.back, JSON.stringify({ sheetOver, afterSheet }));
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
        // final review I3: nothing in the corner until the context is filling up (≥ 60 %, spec §5.4) — no ring without an
        // occupancy, none at 40 % — and the numbers of the old stats bar are one menu away: ··· 本对话用量
        const setCu = (cu) => js(`(() => { const st = window.__store; const o = st.getState().open[${sidJs}]; st.setState({ open: { ...st.getState().open, [${sidJs}]: { ...o, contextUsage: ${JSON.stringify(cu)}, version: o.version + 1 } } }); })()`);
        const noMeter = await js(`!document.querySelector('.pane .composer .ctx-meter')`);
        await setCu({ percentage: 40, totalTokens: 80_000, maxTokens: 200_000 });
        await sleep(200);
        const noMeter40 = await js(`!document.querySelector('.pane .composer .ctx-meter')`);
        await click('.pane.focused .sess-head .sh-more > button');
        await waitFor(`!!document.querySelector('.menu.sess-menu [data-act="usage"]')`, 3000);
        await click('.menu.sess-menu [data-act="usage"]');
        await waitFor(`!!document.querySelector('.ctx-card')`, 3000);
        const usageCard = await js(`(() => { const c = document.querySelector('.ctx-card'); if (!c) return null; const r = c.getBoundingClientRect(); const bar = document.querySelector('.pane.focused .composer .composer-bar').getBoundingClientRect(); return { text: c.innerText, above: r.bottom <= bar.top + 1, right: Math.abs(r.right - bar.right) < 60 }; })()`);
        await key('Escape');
        const cardGone = await waitFor(`!document.querySelector('.ctx-card')`, 2000);
        check('below 60 % the corner is empty; ··· 本对话用量 opens the old stats (轮数 / 输入 / 上下文) above the composer, Esc closes it', noMeter40 && !!usageCard && /轮数/.test(usageCard.text) && /输入/.test(usageCard.text) && /40%/.test(usageCard.text) && usageCard.above && usageCard.right && cardGone, JSON.stringify({ noMeter, noMeter40, usageCard, cardGone }));
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
        // 定时任务 are this machine's, not the conversation's: the automation page (phase 7) over the main area; the
        // conversation underneath stays mounted (inert), × brings it back
        await click('.menu.sess-menu [data-view="schedules"]');
        const autoShown = '(() => { const p = document.querySelector(".auto-page"); return !!p && !p.hidden && p.dataset.tab === "schedules" && !!p.querySelector(".auto-body[data-body=schedules]:not([hidden]) .sched-view") && !!document.querySelector(".pane-layer[inert]"); })()';
        const inView = await waitFor(autoShown, 4000);
        const noPill = await js('!document.querySelector(".pane.focused .sh-view") && !!document.querySelector(".pane.focused .chat")');
        await shot('automation-from-header');
        await click('.auto-page .auto-head button[aria-label="关闭自动化"]');
        const back = await waitFor('document.querySelector(".auto-page")?.hidden === true && !document.querySelector(".pane-layer[inert]") && !!document.querySelector(".pane.focused .chat")', 4000);
        check('··· 定时任务 opens the automation page over the conversation (kept mounted underneath); × returns to it', inView && noPill && back, JSON.stringify({ inView, noPill, back }));

        // collapsed sidebar: the centre takes the whole width and the header's first button brings the sidebar back
        await js('window.__store.setState({ sidebarOpen: false })');
        await sleep(500);
        const collapsed = await js(`(() => { const c = document.querySelector('.center').getBoundingClientRect(); return { left: Math.round(c.left), reveal: !!document.querySelector('.pane .sess-head > .sb-reveal') }; })()`);
        check('collapsed sidebar: the centre starts at the window edge, the header shows 展开侧栏', collapsed.left === 0 && collapsed.reveal, JSON.stringify(collapsed));
        // review M10: 「连接断开，正在重连…」 at the top of the main area — seen with the sidebar (and its account row) away
        const banner = `(() => { const b = document.querySelector('.center .conn-banner'); if (!b) return null; const r = b.getBoundingClientRect(), c = document.querySelector('.center').getBoundingClientRect(); return { text: b.textContent, inCenter: r.left >= c.left && r.right <= c.right + 1, top: Math.round(r.top), visible: r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden' }; })()`;
        if (E.SMOKE_READONLY !== '1') {
          await js('window.__store.setState({ connected: false })');
          await waitFor(`!!${banner}`, 4000);
          const down = await js(banner);
          await shot('disconnected');
          await js('window.__store.setState({ connected: true })');
          const gone = await waitFor(`!${banner}`, 2000);
          check('disconnected: 「连接断开，正在重连…」 at the top of the main area with the sidebar collapsed; gone when back', down && down.text === '连接断开，正在重连…' && down.inCenter && down.visible && down.top < 140 && gone, JSON.stringify({ down, gone }));
        }
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
          // final review M4: Ctrl+K / `?` from the keyboard with the drawer open — the drawer (z 60) makes way, the
          // palette / the shortcut sheet is what a tap where the drawer was reaches
          const overDrawer = async (open, sel) => {
            await open();
            await waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 2000);
            await sleep(300);
            const r = await js(`(() => { const e = document.elementFromPoint(Math.round(innerWidth * 0.15), Math.round(innerHeight * 0.5)); return { drawer: document.querySelector('.app').classList.contains('drawer-open'), hit: e ? (e.closest(${JSON.stringify(sel)}) ? 'layer' : e.closest('.sidebar') ? 'drawer' : e.className || e.tagName) : null }; })()`);
            await key('Escape');
            await sleep(200);
            return r;
          };
          const palOver = await overDrawer(async () => { wc.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['control'] }); }, '.palette-bg');
          await click('.pane .sess-head .sb-reveal');
          await waitFor('document.querySelector(".app").classList.contains("drawer-open")', 3000);
          const sheetOverDrawer = await overDrawer(() => js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))`), '.shortcuts-bg');
          check('phone: Ctrl+K and `?` with the drawer open — the drawer makes way, the palette / shortcut sheet takes the tap (final review M4)', !palOver.drawer && palOver.hit === 'layer' && !sheetOverDrawer.drawer && sheetOverDrawer.hit === 'layer', JSON.stringify({ palOver, sheetOverDrawer }));
          await click('.pane .sess-head .sb-reveal');
          await waitFor('document.querySelector(".app").classList.contains("drawer-open")', 3000);
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
          // redesign phase 7 (spec §5.11): on a phone the right panel is a bottom drawer — the same Dock moved by CSS,
          // so nothing is mounted twice (one xterm) and nothing unmounts when it slides away. The default look from here.
          await js('window.__store.getState().setSetting("ui.workbench", false)');
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
          await sleep(400);
          const sheet = `(() => { const a = document.querySelector('.app'); const r = document.querySelector('.rpanel'); if (!r) return null; const b = r.getBoundingClientRect(); return { open: a.classList.contains('sheet-open'), bottom: Math.round(innerHeight - b.bottom), w: Math.round(b.width), vw: innerWidth, h: Math.round(b.height), backdrop: !!document.querySelector('.sheet-backdrop'), active: window.__store.getState().layout.dock.active, drawer: a.classList.contains('drawer-open'), toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }; })()`;
          const drawerUp = (s, panel) => !!s && s.open && Math.abs(s.bottom) <= 1 && s.w >= s.vw - 1 && s.h > 200 && s.backdrop && s.active === panel && !s.drawer && !s.toasts.some((t) => /手机/.test(t));
          // a tap on the backdrop above the drawer (its middle is under the drawer)
          const tapAbove = async () => {
            const at = await js(`(() => { const p = document.querySelector('.rpanel').getBoundingClientRect(); return { x: Math.round(innerWidth / 2), y: Math.max(4, Math.round(p.top / 2)) }; })()`);
            const hit = await js(`document.elementFromPoint(${at.x}, ${at.y})?.className ?? ''`);
            if (hit !== 'sheet-backdrop') log(`tapAbove: ${hit} at ${at.x},${at.y}`);
            wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
            await sleep(350);
          };
          const phoneMenu = async () => { await click('.pane .sess-head .sh-more > button'); await waitFor('!!document.querySelector(".menu.sess-menu [data-view]")', 3000); await sleep(200); };
          const phoneViews = await (async () => { await phoneMenu(); const v = await js(`[...document.querySelectorAll('.menu.sess-menu [data-view]')].map((b) => b.dataset.view)`); await key('Escape'); return v; })();
          check('phone ···: the views plus 终端 / 任务 (the header has no buttons for them)', ['changes', 'files', 'schedules', 'terminal', 'tasks'].every((v) => phoneViews.includes(v)), JSON.stringify(phoneViews));
          await phoneMenu();
          await click('.menu.sess-menu [data-view="changes"]');
          await waitFor(`(${drawerUp.toString()})(${sheet}, 'files')`, 4000);
          const sChanges = await js(sheet);
          await sleep(300);
          await shot('phone-sheet-review');
          check('phone: ··· 改动 slides 审阅 up from the bottom (full width, over a backdrop), no toast', drawerUp(sChanges, 'files'), JSON.stringify(sChanges));
          await tapAbove();
          const down = await waitFor(`!document.querySelector('.app').classList.contains('sheet-open') && !!document.querySelector('.dock-panel[data-panel="files"]')`, 3000);
          check('phone: the backdrop puts the drawer away, 审阅 stays mounted', down);
          await phoneMenu();
          await click('.menu.sess-menu [data-view="terminal"]');
          const termUp = await waitFor(`(${drawerUp.toString()})(${sheet}, 'terminal') && !!document.querySelector('.dock-panel[data-panel="terminal"] .xterm')`, 8000);
          await js(`document.querySelector('.dock-panel[data-panel="terminal"] .xterm').dataset.smokeMark = 'phone'`);
          await shot('phone-sheet-terminal');
          await tapAbove();
          await sleep(300);
          await js(`window.__store.getState().togglePanel('terminal')`);
          const termAgain = await waitFor(`(${drawerUp.toString()})(${sheet}, 'terminal')`, 3000);
          const xterms = await js(`({ n: document.querySelectorAll('.rpanel .xterm').length, same: document.querySelector('.dock-panel[data-panel="terminal"] .xterm')?.dataset.smokeMark === 'phone' })`);
          check('phone: ··· 终端 opens the terminal in the drawer; put away and toggled back it is the same terminal (one xterm)', termUp && termAgain && xterms.n === 1 && xterms.same, JSON.stringify({ termUp, termAgain, xterms }));
          await tapAbove();
          await sleep(300);
          // review 4b M3: from the phone's sidebar, 自动化 and the account menu's 用量 / 配置中心 open what they name
          // (the automation page / the drawer), no unrelated 「手机上没有右侧面板」, and both close the drawer alike
          await click('.pane .sess-head .sb-reveal');
          await waitFor('document.querySelector(".app").classList.contains("drawer-open")', 3000);
          await click('.sidebar [data-id="automation"]');
          const autoPhone = await waitFor(`(() => { const p = document.querySelector('.auto-page'); return !!p && !p.hidden && !document.querySelector('.app').classList.contains('drawer-open'); })()`, 3000);
          await click('.auto-page .auto-tabs [data-id="goals"]');
          const goalsPhone = await waitFor(`(() => { const b = document.querySelector('.auto-page .auto-body[data-body="goals"]:not([hidden])'); return !!b && b.getBoundingClientRect().height > 0; })()`, 3000);
          await click('.auto-page .auto-tabs [data-id="orchestra"]');
          const orchPhone = await waitFor(`(() => { const b = document.querySelector('.auto-page .auto-body[data-body="orchestra"]:not([hidden])'); return !!b && b.getBoundingClientRect().height > 0; })()`, 3000);
          const autoToasts = await js(`[...document.querySelectorAll('.toast')].map((t) => t.textContent)`);
          await shot('phone-automation');
          check('phone: sidebar 自动化 opens the automation page (目标 / 编排 tabs there), the drawer shuts, no toast', autoPhone && goalsPhone && orchPhone && !autoToasts.some((t) => /手机/.test(t)), JSON.stringify({ autoPhone, goalsPhone, orchPhone, autoToasts }));
          await key('Escape');
          await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          for (const [item, label] of [['usage', '用量与账本'], ['config', '配置中心']]) {
            await click('.pane .sess-head .sb-reveal');
            await waitFor('document.querySelector(".app").classList.contains("drawer-open")', 3000);
            await click('.sidebar [data-id="account"]');
            await click(`.menu.sb-acct-menu [data-id="${item}"]`);
            await waitFor(`(${drawerUp.toString()})(${sheet}, '${item}')`, 4000);
            const s = await js(sheet);
            check(`phone: 账户 → ${label} opens it in the bottom drawer and shuts the sidebar drawer, no toast`, drawerUp(s, item), JSON.stringify(s));
            await tapAbove();
            await sleep(300);
          }
          // review 7 I1: the settings page and the palette open over the drawer — a tap in the middle of the screen (or
          // where the drawer is) lands on them, never on the drawer underneath; the drawer is back when they close
          const hitAt = (fy) => js(`(() => { const e = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight * ${fy})); return e ? (e.closest('.modal.settings') ? 'settings' : e.closest('.palette-bg') ? 'palette' : e.closest('.rpanel') ? 'drawer' : e.className || e.tagName) : null; })()`);
          await phoneMenu();
          await click('.menu.sess-menu [data-view="changes"]');
          await waitFor(`(${drawerUp.toString()})(${sheet}, 'files')`, 4000);
          await js(`window.__store.getState().openSettings({ section: 'general' })`);
          await waitFor('!!document.querySelector(".modal.settings")', 3000);
          await sleep(300);
          const overSettings = [await hitAt(0.5), await hitAt(0.75)];
          await shot('phone-settings-over-drawer');
          await js('window.__store.setState({ settingsOpen: null })');
          await sleep(300);
          const drawerBack = await js(`(${drawerUp.toString()})(${sheet}, 'files') && getComputedStyle(document.querySelector('.rpanel')).visibility !== 'hidden'`);
          await js('window.__store.setState({ paletteOpen: true })');
          await waitFor('!!document.querySelector(".cmdk")', 3000);
          await sleep(200);
          const overPalette = [await hitAt(0.5), await hitAt(0.75)];
          await js('window.__store.setState({ paletteOpen: false })');
          await sleep(200);
          check('phone, drawer up: the settings page and the palette take the taps (the middle of the screen and where the drawer is), the drawer comes back after', overSettings.every((h) => h === 'settings') && overPalette.every((h) => h === 'palette') && drawerBack, JSON.stringify({ overSettings, overPalette, drawerBack }));
          // review 7 I2: going somewhere from inside the drawer puts it away — 任务's 定时任务 line opens the automation page on top
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'tasks' })`);
          await waitFor(`(${drawerUp.toString()})(${sheet}, 'tasks') && !!document.querySelector('.dock-panel[data-panel="tasks"]:not([hidden]) .tasks-link')`, 4000);
          await click('.dock-panel[data-panel="tasks"] .tasks-link');
          const fromDrawer = await waitFor(`(() => { const p = document.querySelector('.auto-page'); return !!p && !p.hidden && p.dataset.tab === 'schedules' && !document.querySelector('.app').classList.contains('sheet-open'); })()`, 3000);
          const hitPage = await js(`!!document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight * 0.6))?.closest('.auto-page')`);
          check('phone: 任务 → 定时任务 from inside the drawer opens the automation page and the drawer goes down (the page is what the tap reaches)', fromDrawer && hitPage, JSON.stringify({ fromDrawer, hitPage }));
          await key('Escape');
          await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          // a conversation on another machine keeps its views in place (its files are there): ··· → a view replaces the
          // conversation, the header pill brings it back (review 7 M14). A copy of the seeded conversation, as if remote
          const RID = 'peer_smokepeer~remote-1';
          await js(`(() => { const st = window.__store.getState(); const o = st.open[${sidJs}]; const s = st.sessions.find((x) => x.sessionId === ${sidJs}); window.__store.setState({ open: { ...st.open, ${JSON.stringify(RID)}: { ...o, sessionId: ${JSON.stringify(RID)}, pending: [], state: 'history' } }, sessions: [...st.sessions, { ...s, sessionId: ${JSON.stringify(RID)}, title: 'smoke: 远端对话', peer: { id: 'smokepeer', name: '另一台电脑' } }] }); st.openInPane(${JSON.stringify(RID)}, 'replace'); })()`);
          await waitFor(`!!document.querySelector('.pane.focused .sess-head')`, 3000);
          await phoneMenu();
          const remoteViews = await js(`[...document.querySelectorAll('.menu.sess-menu [data-view]')].map((b) => b.dataset.view)`);
          await click('.menu.sess-menu [data-view="artifacts"]');
          const inPlace = await waitFor('!!document.querySelector(".pane.focused .sh-view") && !!document.querySelector(".pane.focused .wb-body") && !document.querySelector(".app").classList.contains("sheet-open")', 3000);
          await shot('phone-remote-in-place');
          await click('.pane.focused .sh-view');
          const pillBack = await waitFor('!!document.querySelector(".pane.focused .chat-tile .composer textarea") && !document.querySelector(".pane.focused .wb-body") && !document.querySelector(".pane.focused .sh-view")', 3000);
          check('phone, a remote conversation: ··· lists only its views, a view opens in place (not the drawer), the header pill returns', remoteViews.length >= 1 && !remoteViews.includes('terminal') && inPlace && pillBack, JSON.stringify({ remoteViews, inPlace, pillBack }));
          await js(`(() => { const st = window.__store.getState(); st.openInPane(${sidJs}, 'replace'); const open = { ...st.open }; delete open[${JSON.stringify(RID)}]; window.__store.setState({ open, sessions: st.sessions.filter((x) => x.sessionId !== ${JSON.stringify(RID)}) }); })()`);
          await sleep(300);
          // the disconnect banner with the phone's drawer shut
          await js('window.__store.setState({ connected: false })');
          await waitFor(`!!${banner}`, 4000);
          const downPhone = await js(banner);
          await shot('phone-disconnected');
          await js('window.__store.setState({ connected: true })');
          await waitFor(`!${banner}`, 2000);
          check('phone: the disconnect banner shows over the conversation with the drawer shut', downPhone && downPhone.inCenter && downPhone.visible && downPhone.top < 120, JSON.stringify(downPhone));
          await js('window.__store.getState().setSetting("ui.workbench", true)');
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
        // each group title once: a group the query names is one block, not split around other hits (re-review M-c)
        const grpTitles = await js(`[...document.querySelectorAll('.cmdk .grp')].map((g) => g.textContent)`);
        check('palette: searching 「面板」 shows each group title once', grpTitles.length > 0 && new Set(grpTitles).size === grpTitles.length, JSON.stringify(grpTitles));
        await js('window.__store.setState({ paletteOpen: false })');
        await js(`(() => { const d = JSON.parse(${JSON.stringify(dockBefore)}); window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { tabs: d.tabs, active: d.active, open: false, minimized: false } }); })()`);
        await sleep(300);

        // I5: every view in the header ··· lands where viewTarget (panel-entries.ts) sends it — the same table
        // panel-entries.test.ts pins: 改动 / Git → 审阅, 文件 / 搜索 / 生成的文件 → 文件, Issue 与 PR → a tab, 定时任务 →
        // the automation page (phase 7)
        const activeTab = 'document.querySelector(".dock:not([hidden]) .dock-tabs .tab.active")?.dataset.panel';
        const landing = {
          changes: `${activeTab} === "files" && document.querySelector(".dock .rv-main:not([hidden]) .rv-scope .t")?.textContent === "本次对话改动"`,
          git: `${activeTab} === "files" && !!document.querySelector(".dock .rv-git:not([hidden])")`,
          files: `${activeTab} === "explorer" && !!document.querySelector(".dock .files-view .fv-body:not([hidden]) .filetree")`,
          search: `${activeTab} === "explorer" && !!document.querySelector(".dock .files-view .fv-body:not([hidden]) .search-view")`,
          artifacts: `${activeTab} === "explorer" && !!document.querySelector(".dock .files-view .fv-body:not([hidden]) .fv-group.open")`,
          board: `${activeTab} === "board"`,
          schedules: '(() => { const p = document.querySelector(".auto-page"); return !!p && !p.hidden && p.dataset.tab === "schedules"; })()',
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
          if (!ok || inPlace) viewMiss.push(`${view}: ${await js(`JSON.stringify({ tab: ${activeTab}, open: window.__store.getState().layout.dock.open, inPlace: ${inPlace}, auto: !document.querySelector('.auto-page')?.hidden })`)}`);
          if (inPlace) { await click('.pane.focused .sh-view'); await sleep(250); }
          if (view === 'schedules') { await js('document.querySelector(".auto-page .auto-head button[aria-label=关闭自动化]")?.click()'); await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000); }
          if (view === 'git') await js('document.querySelector(".dock .rv-git .rv-bar .btn")?.click()');
        }
        check('every header ··· view lands where viewTarget says (审阅 / 文件 / Issue 与 PR tab / 定时任务 → 自动化)', !viewMiss.length, viewMiss.join(' | '));

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
          // (phase 5: a finished turn folds its steps into one line — open it to reach the row)
          await waitFor('!!document.querySelector(".pane.focused .turn-sum")', 8000);
          // the appended Read lands in its own continuation turn (after the seeded turn's result): open every folded turn
          await js('document.querySelectorAll(".pane.focused .turn-sum[aria-expanded=\\"false\\"]").forEach((b) => b.click())');
          await sleep(250);
          const row = await waitFor('!!document.querySelector(\'.pane.focused .turn-body:not([hidden]) .tool-head button[aria-label="详情"]\')', 8000);
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
          // the temporary tab has its own tab here (the strip): no title row on top of the panel as well
          const noHead = await js(`!document.querySelector('.dock .dock-foldhead') && !!document.querySelector('.dock .dock-tablist .tab.active[data-panel="goals"]')`);
          check('a temporary tab shown in the strip gets no extra title row on its panel', noHead);
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
          // folded into 「更多」 and in front: the panel says what it is (目标) and has its ×; no fixed tab is lit
          const headProbe = `(() => { const h = document.querySelector('.dock .dock-foldhead'); const p = document.querySelector('.dock .dock-panel[data-panel="goals"]'); if (!h) return null; const hr = h.getBoundingClientRect(); return { text: h.querySelector('.t')?.textContent, x: !!h.querySelector('button[aria-label="关闭目标"]'), h: Math.round(hr.height), headTop: Math.round(hr.top), panelTop: p ? Math.round(p.getBoundingClientRect().top) : null, lit: document.querySelectorAll('.dock .dock-tabs .tab.fixed.active').length }; })()`;
          const head = await js(headProbe);
          check('1440: the folded temporary panel in front gets a title row — 目标 and a close ×, inside the panel (tab row unmoved), no fixed tab lit', r1440.strip ? !head : !!head && head.text === '目标' && head.x && head.h >= 32 && head.h <= 36 && head.headTop === r1440.bodyTop && head.panelTop >= head.headTop + head.h && head.lit === 0, JSON.stringify({ head, bodyTop: r1440.bodyTop }));
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
          // the title row's × closes it and goes back to the fixed tab that was in front (审阅: shown before 目标)
          const landedOn = (id) => `!window.__store.getState().layout.dock.tabs.includes('${id}') && !!document.querySelector('.dock .dock-tabs .tab.fixed.active[data-panel="files"]') && !document.querySelector('.dock .dock-more-n') && !document.querySelector('.dock .dock-foldhead')`;
          if (!r1440.strip) await click('.dock .dock-foldhead button[aria-label="关闭目标"]');
          else await click('.dock .dock-tabs .tab[data-panel="goals"] .x');
          const back = await waitFor(landedOn('goals'), 3000);
          check('the title row’s × closes the temporary panel and lands on 审阅 (the fixed tab in front before); the count and the row go', back, await js(dockState));
          // …and closing one from 「更多」 does the same
          if (!r1440.strip) {
            // two temporary panels folded into 「更多」, closed from its 「已打开」 list with the keyboard (re-review M-b):
            // the focus moves to the next open row, ↓ and Esc keep working, Esc hands the focus back to 「更多」
            await js(`(() => { const d = window.__store.getState().dispatchLayout; d({ t: 'dock.show', panel: 'usage' }); d({ t: 'dock.show', panel: 'goals' }); })()`);
            await sleep(400);
            await click('.dock button.dock-more');
            await waitFor('!!document.querySelector(".dock-more-menu .dock-more-open")', 2000);
            // (Enter on the focused × = its click)
            await js(`(() => { const x = document.querySelector('.dock-more-menu .dock-more-open[data-open="usage"] button.x'); x.focus(); document.activeElement.click(); })()`);
            await sleep(300);
            const kb1 = await js(`(() => { const a = document.activeElement; return { menu: !!document.querySelector('.dock-more-menu'), on: a?.closest('.dock-more-open')?.dataset.open ?? a?.tagName, usage: window.__store.getState().layout.dock.tabs.includes('usage') }; })()`);
            await key('Down');
            const kb2 = await js(`!!document.activeElement?.closest('.dock-more-menu')`);
            await key('Escape');
            await sleep(200);
            const kb3 = await js(`({ menu: !!document.querySelector('.dock-more-menu'), onMore: !!document.activeElement?.classList.contains('dock-more') })`);
            check('「更多」: closing an open panel with the keyboard moves the focus to the next open row; ↓ and Esc still work, Esc gives the focus back to 「更多」', !kb1.usage && kb1.menu && kb1.on === 'goals' && kb2 && !kb3.menu && kb3.onMore, JSON.stringify({ kb1, kb2, kb3 }));
            // the last one: the menu closes and the focus goes back to 「更多」
            await click('.dock button.dock-more');
            await waitFor('!!document.querySelector(".dock-more-menu .dock-more-open")', 2000);
            await js(`(() => { const x = document.querySelector('.dock-more-menu .dock-more-open[data-open="goals"] button.x'); x.focus(); document.activeElement.click(); })()`);
            const back2 = await waitFor(`${landedOn('goals')} && !document.querySelector('.dock-more-menu') && !!document.activeElement?.classList.contains('dock-more')`, 3000);
            check('closing the last one from 「更多」 lands on 审阅, closes the menu and gives the focus back to 「更多」', back2, await js(`JSON.stringify({ dock: ${dockState}, menu: !!document.querySelector('.dock-more-menu'), focus: document.activeElement?.className })`));
          }
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
          // one anchored menu app-wide (re-review N2): the header ··· and the sidebar funnel replace each other
          await js(`window.__store.getState().openInPane(${SID}, 'replace')`);
          if (await waitFor('!!document.querySelector(".pane.focused .sess-head .sh-more > button")', 4000)) {
            const menusNow = () => js('[...document.querySelectorAll(".menu")].map((m) => m.className)');
            await click('.pane.focused .sess-head .sh-more > button');
            const headerOpen = await waitFor('!!document.querySelector(".menu.sess-menu")', 3000);
            await click('.sidebar [data-id="filter"]');
            await sleep(250);
            const m1 = await menusNow();
            check('one menu app-wide: opening the sidebar funnel closes the header ···', headerOpen && m1.length === 1 && /sb-filter/.test(m1[0]), JSON.stringify({ headerOpen, m1 }));
            await click('.pane.focused .sess-head .sh-more > button');
            await sleep(250);
            const m2 = await menusNow();
            check('… and opening the header ··· closes the funnel', m2.length === 1 && /sess-menu/.test(m2[0]), JSON.stringify(m2));
            await closeMenus();
            // polish P2 (re-review 4b M2): the 文件 panel's right-click menu is one of them — the funnel opened after
            // it leaves one .menu; the settings page closes it (it used to reappear when the page closed); Esc closes it
            const dockWas = await js('JSON.stringify(window.__store.getState().layout.dock)');
            await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'explorer' })`);
            const ftRow = '.dock:not([hidden]) .dock-panel[data-panel="explorer"]:not([hidden]) .filetree .ft-row';
            if (await waitFor(`!!document.querySelector(${JSON.stringify(ftRow)})`, 6000)) {
              await sleep(300); // the right panel's width transition
              const rightClick = () => js(`(() => { const el = document.querySelector(${JSON.stringify(ftRow)}); if (!el) return false; const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: b.left + 30, clientY: b.top + 8, button: 2 })); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 30, clientY: b.top + 8, button: 2 })); return true; })()`);
              await rightClick();
              const ftOpen = await waitFor('!!document.querySelector(".menu.ft-menu")', 2000);
              await click('.sidebar [data-id="filter"]');
              await sleep(250);
              const m3 = await menusNow();
              check('one menu app-wide: the 文件 right-click menu, then the sidebar funnel → only the funnel is open (polish P2)', ftOpen && m3.length === 1 && /sb-filter/.test(m3[0]), JSON.stringify({ ftOpen, m3 }));
              await closeMenus();
              await rightClick();
              await waitFor('!!document.querySelector(".menu.ft-menu")', 2000);
              await js('window.__store.getState().openSettings()');
              await waitFor('!!document.querySelector(".modal.settings.sp")', 3000);
              const underSettings = await js('!!document.querySelector(".menu.ft-menu")');
              await js('window.__store.setState({ settingsOpen: null })');
              await sleep(250);
              const afterSettings = await js('!!document.querySelector(".menu.ft-menu")');
              await rightClick();
              const again = await waitFor('!!document.querySelector(".menu.ft-menu")', 2000);
              await key('Escape');
              const escClosed = !(await js('!!document.querySelector(".menu.ft-menu")'));
              check('the 文件 right-click menu closes when the settings page opens (not back after it closes) and on Esc', !underSettings && !afterSettings && again && escClosed, JSON.stringify({ underSettings, afterSettings, again, escClosed }));
            } else check('one menu app-wide: a file tree row to right-click', false, 'no .ft-row in the 文件 panel');
            await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: ${'JSON.parse(' + JSON.stringify(dockWas) + ')'} })`);
            await closeMenus();
          } else check('one menu app-wide: a conversation header to test with', false, 'no .sess-head in the focused pane');
          const ctxMenu = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 8, button: 2 })); return true; })()`);
          const count = (sel) => js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
          const exists = (sel) => js(`!!document.querySelector(${JSON.stringify(sel)})`);
          // every id of entries.ts PLACES must be seen in the DOM, each in its own place, at some point of this phase
          const PLACES = inv.sidebar;
          const SCOPES = {
            top: '.sidebar .sb-top [data-id], .sidebar .sb-nav [data-id]',
            automation: '.auto-page .auto-tabs [data-id]',
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
          // final review I3: 收起侧栏 shows with the pointer over the sidebar or the key focus on it, not at rest
          const collapseOp = () => js(`getComputedStyle(document.querySelector('.sidebar .sb-top [data-id="collapse"]')).opacity`);
          wc.sendInputEvent({ type: 'mouseMove', x: 900, y: 400 });
          await sleep(400);
          const opRest = await collapseOp();
          wc.sendInputEvent({ type: 'mouseMove', x: 120, y: 300 });
          await sleep(400);
          const opHover = await collapseOp();
          wc.sendInputEvent({ type: 'mouseMove', x: 900, y: 400 });
          await sleep(400);
          check('收起侧栏 at rest is invisible (still there for Tab and the pointer), shown with the pointer over the sidebar', opRest === '0' && opHover === '1', JSON.stringify({ opRest, opHover }));
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
          // redesign phase 7: 自动化 is a page over the main area (spec §5.9) — tabs 定时任务 / 目标 / 编排, 新建 at the
          // top right. Opening it closes whatever sidebar menu was open (here: the funnel)
          const dockClosed = `window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`;
          const autoTab = (tab) => `(() => { const p = document.querySelector('.auto-page'); const b = p && p.querySelector('.auto-body[data-body="${tab}"]:not([hidden])'); return !!p && !p.hidden && p.dataset.tab === '${tab}' && !!b && b.getBoundingClientRect().height > 0; })()`;
          await click('.sidebar [data-id="filter"]');
          await click('.sidebar [data-id="automation"]');
          const one = { menus: await count('.menu.sb-menu, .menu.sess-menu'), page: await waitFor(`(() => { const p = document.querySelector('.auto-page'); return !!p && !p.hidden; })()`, 3000), funnel: await exists('.menu.sb-filter'), inert: await exists('.pane-layer[inert]'), active: await exists('.sidebar [data-id="automation"].active') };
          check('自动化 opens the automation page (panes underneath inert, the entry marked) and closes the funnel', !one.menus && one.page && !one.funnel && one.inert && one.active, JSON.stringify(one));
          const am = await ids('.auto-page .auto-tabs [data-id]');
          const newBtn = await js(`document.querySelector('.auto-page .auto-head [data-new]')?.textContent ?? null`);
          check('自动化 page: tabs 定时任务 / 目标 / 编排, 新建 at the top right', has(am, ['schedules', 'goals', 'orchestra']) && !!newBtn, JSON.stringify({ am, newBtn }));
          await harvest();
          await shot('automation-schedules');
          const autoMiss = [];
          for (const tab of ['goals', 'orchestra', 'schedules']) {
            await click(`.auto-page .auto-tabs [data-id="${tab}"]`);
            if (!(await waitFor(autoTab(tab), 4000))) autoMiss.push(tab);
            const newFor = await js(`document.querySelector('.auto-page .auto-head [data-new]')?.dataset.new`);
            if (newFor !== tab) autoMiss.push(`${tab}: 新建 is for ${newFor}`);
            await shot(`automation-${tab}`);
          }
          const autoErr = await noBoundary('.auto-page');
          check('自动化 page: each tab shows its list (the three bodies stay mounted), without error boundary', !autoMiss.length && !autoErr && (await count('.auto-page .auto-body')) === 3, autoErr || autoMiss.join(', '));
          // polish: the page's 定时任务 tab has no second tab row under it (定时任务 › 全部 read twice): the list, then
          // 从模板开始; 运行记录 is a link and the records lead back
          const sv = '.auto-page .auto-body[data-body="schedules"]:not([hidden]) .sched-view';
          await waitFor(`!!document.querySelector('${sv} [data-id="sched-templates"] button')`, 5000);
          const svList = await js(`(() => { const v = document.querySelector('${sv}'); return v && { subtabs: !!v.querySelector('.subtabs'), runs: !!v.querySelector('[data-id="sched-runs"]'), templates: v.querySelectorAll('[data-id="sched-templates"] .row').length, view: v.dataset.view }; })()`);
          await click(`${sv} [data-id="sched-runs"]`);
          const svRuns = await waitFor(`document.querySelector('${sv}')?.dataset.view === 'history' && !!document.querySelector('${sv} [data-id="sched-back"]') && !document.querySelector('${sv} [data-id="sched-templates"]')`, 3000);
          await click(`${sv} [data-id="sched-back"]`);
          const svBack = await waitFor(`document.querySelector('${sv}')?.dataset.view === 'list'`, 3000);
          check('自动化 → 定时任务: no inner tab row; list + 从模板开始; 运行记录 opens the records and ‹ 定时任务 comes back', !!svList && !svList.subtabs && svList.runs && svList.templates > 0 && svList.view === 'list' && svRuns && svBack, JSON.stringify({ svList, svRuns, svBack }));
          // 新建 on 定时任务 opens the new-schedule form in the page (nothing saved until 保存)
          await click('.auto-page .auto-head [data-new]');
          const form = await waitFor(`!!document.querySelector('.auto-page .auto-body[data-body="schedules"]:not([hidden]) .sched-view input, .auto-page .auto-body[data-body="schedules"]:not([hidden]) .sched-view textarea')`, 3000);
          check('自动化 → 新建 (定时任务) opens the form in the page', form);
          // review 7 I4: the working directory is a 「项目」 choice (the current project first, 其它文件夹… to browse), and
          // no row of the form sticks out of it
          const sf = await js(`(() => { const f = document.querySelector('.auto-page .sched-form'); const p = f && f.querySelector('[data-id="sched-project"]'); if (!f || !p) return null; const fr = f.getBoundingClientRect(); const pr = p.getBoundingClientRect(); const over = [...f.querySelectorAll('input, select, textarea, button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > fr.right + 1 || r.left < fr.left - 1); }).length; return { w: Math.round(pr.width), value: p.value, options: [...p.options].map((o) => o.textContent), over }; })()`);
          check('新定时任务: 「项目」 is a dropdown (a project chosen, 其它文件夹… last), nothing sticks out of the form', !!sf && sf.w >= 150 && !!sf.value && sf.options[sf.options.length - 1] === '其它文件夹…' && sf.over === 0, JSON.stringify(sf));
          await shot('automation-new');
          // the main area goes elsewhere (a conversation from the sidebar): the page gets out of the way, stays mounted
          await click(`.sidebar .sb-list [data-sid=${SID}]`);
          const away = await waitFor(`(() => { const p = document.querySelector('.auto-page'); return !!p && p.hidden && p.querySelectorAll('.auto-body').length === 3 && !document.querySelector('.pane-layer[inert]'); })()`, 3000);
          check('opening a conversation closes the automation page (kept mounted, hidden)', away);
          // 自动化 → 定时任务: 1 click when it is the tab shown last, 2 from another tab (spec §4.2: ≤ 2)
          let clicks = 0;
          const counted = async (sel) => { clicks++; return click(sel); };
          await counted('.sidebar [data-id="automation"]');
          const sched1 = await waitFor(`${autoTab('schedules')} && !!document.querySelector('.auto-page .auto-body[data-body="schedules"] .sched-view')`, 3000);
          check('自动化 → 定时任务 in 1 click (the tab shown last), the scheduled-task list on screen', sched1 && clicks === 1, await js(`JSON.stringify({ clicks: ${clicks}, tab: document.querySelector('.auto-page')?.dataset.tab, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) })`));
          await click('.auto-page .auto-tabs [data-id="goals"]');
          await key('Escape');
          const escClosed = await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          clicks = 0;
          await counted('.sidebar [data-id="automation"]');
          await counted('.auto-page .auto-tabs [data-id="schedules"]');
          const sched2 = await waitFor(autoTab('schedules'), 3000);
          check('Esc closes the page; from another tab 定时任务 is 2 clicks', escClosed && sched2 && clicks === 2, JSON.stringify({ escClosed, sched2, clicks }));
          await click('.auto-page .auto-head button[aria-label="关闭自动化"]');
          await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          // review 7 M1: Esc with the focus nowhere (on <body>, after a click on empty space) closes the page too, and
          // the focus goes back to the conversation's composer (it was under the page)
          await click('.sidebar [data-id="automation"]');
          await waitFor(autoTab('schedules'), 3000);
          await js('document.activeElement?.blur()');
          const onBody = await js('document.activeElement === document.body');
          await key('Escape');
          const escBody = await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          const toComposer = await waitFor(`!!document.activeElement?.matches('.pane.focused .composer textarea')`, 2000);
          check('Esc with the focus on <body> closes the automation page, the focus returns to the composer', onBody && escBody && toComposer, JSON.stringify({ onBody, escBody, toComposer, at: await js('document.activeElement?.className ?? null') }));
          if (E.SMOKE_READONLY !== '1') {
            // review 7 I3: keys meant for the tabs under the page do not act on them unseen — Alt+W with a terminal in
            // front closes the page, the terminal (its shell) stays
            await js(`window.__store.getState().openTile({ id: 'smoke-altw', kind: 'term', cwd: ${JSON.stringify(E.SMOKE_REPO || '')} }, 'tab')`);
            await waitFor('!!document.querySelector(".pane.focused .xterm")', 8000);
            await click('.sidebar [data-id="automation"]');
            await waitFor(autoTab('schedules'), 3000);
            wc.focus();
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['alt'] });
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['alt'] });
            await sleep(500);
            const tileIds = `(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); return Object.values(g.panes).flatMap((p) => p.tiles.map((t) => t.id)); })()`;
            const altW = { page: await js('document.querySelector(".auto-page")?.hidden === true'), tiles: await js(tileIds) };
            check('Alt+W with the automation page over a terminal closes the page, not the terminal (review 7 I3)', altW.page && altW.tiles.includes('smoke-altw'), JSON.stringify(altW));
            // final review I2: the settings page covers the workbench the same way — Alt+W closes the settings page
            // (like a tab), the terminal under it stays; Alt+N first puts the page away, then opens the new conversation
            const settingsUp = '!!document.querySelector(".modal.settings.sp")';
            await js('window.__store.getState().openSettings()');
            await waitFor(settingsUp, 3000);
            wc.focus();
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['alt'] });
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['alt'] });
            await sleep(500);
            const altWs = { settings: await js(settingsUp), tiles: await js(tileIds) };
            check('Alt+W with the settings page over a terminal closes the settings page, not the terminal (final review I2)', !altWs.settings && altWs.tiles.includes('smoke-altw'), JSON.stringify(altWs));
            const beforeN = await js(tileIds);
            await js('window.__store.getState().openSettings()');
            await waitFor(settingsUp, 3000);
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['alt'] });
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['alt'] });
            await sleep(500);
            const afterN = await js(tileIds);
            const fresh = afterN.filter((x) => !beforeN.includes(x));
            const altN = { settings: await js(settingsUp), fresh, front: await js(`(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); const p = g.panes[g.focusedPaneId]; const t = p.tiles.find((x) => x.id === p.activeTileId); return t ? t.kind + ':' + (t.sessionId ?? 'new') : null; })()`) };
            check('Alt+N with the settings page open: the page goes first, the new conversation is what shows (final review I2)', !altN.settings && fresh.length === 1 && altN.front === 'chat:new', JSON.stringify(altN));
            await js(`(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); for (const p of Object.values(g.panes)) for (const t of p.tiles) if (${JSON.stringify(fresh)}.includes(t.id)) st.dispatchLayout({ t: 'tile.close', paneId: p.id, tileId: t.id }); })()`);
            await sleep(300);
            await js(`(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); for (const p of Object.values(g.panes)) { const t = p.tiles.find((x) => x.id === 'smoke-altw'); if (t) st.dispatchLayout({ t: 'tile.close', paneId: p.id, tileId: t.id }); } })()`);
            await sleep(300);
            await js(`window.__store.getState().openInPane(${SID}, 'replace')`);
            await sleep(300);
          }
          // 任务 (right panel) keeps a link to them
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'tasks' })`);
          await waitFor(`!!document.querySelector('.dock:not([hidden]) .dock-panel[data-panel="tasks"]:not([hidden]) .tasks-link')`, 3000);
          await click('.dock-panel[data-panel="tasks"] .tasks-link');
          check('任务 → 「定时任务 … 在「自动化」里」 opens the page on 定时任务', await waitFor(autoTab('schedules'), 3000));
          await click('.auto-page .auto-head button[aria-label="关闭自动化"]');
          await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          await js(dockClosed);
          await sleep(300);
          // the account row: quota, today's spend, usage & ledger, the config panel, appearance, shortcuts, palette
          await click('.sidebar [data-id="account"]');
          const acc = await ids('.menu.sb-acct-menu [data-id]');
          check('account popover: 今日费用, 用量与账本, 配置中心, 外观, 快捷键, 命令面板', has(acc, ['today', 'usage', 'config', 'appearance', 'shortcuts', 'palette']), JSON.stringify(acc));
          await harvest();
          await shot('sidebar-account');
          await closeMenus();
          // 账户 → 用量与账本 / 配置中心: two clicks to that right-panel tab
          for (const [item, label] of [['usage', '用量与账本'], ['config', '配置中心']]) {
            await js(dockClosed);
            await sleep(300);
            await click('.sidebar [data-id="account"]');
            await click(`.menu.sb-acct-menu [data-id="${item}"]`);
            const shown = await waitFor(`(() => { const d = window.__store.getState().layout.dock; return d.open && d.active === '${item}' && !!document.querySelector('.dock:not([hidden]) .dock-panel[data-panel="${item}"]:not([hidden])'); })()`, 4000);
            check(`账户 → ${label} shows that right-panel tab (2 clicks)`, shown, await js('JSON.stringify(window.__store.getState().layout.dock)'));
          }
          await js(dockClosed);
          await sleep(300);
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
          // polish P1 (re-review 4b M1): one Esc does one thing — with a menu open and the focus nowhere (<body>, as
          // after a click on a menu's heading) Esc closes only the menu; the multi-select and what is picked stay
          for (const [name, opener, menuSel] of [['the header ···', '.pane.focused .sess-head .sh-more > button', '.menu.sess-menu'], ['the composer +', '.pane.focused .composer .cb .plus', '.menu.cm']]) {
            const picked0 = await count('.sidebar .sb-list .sel-box:checked');
            await click(opener);
            const opened = await waitFor(`!!document.querySelector(${JSON.stringify(menuSel)})`, 3000);
            await js('document.activeElement?.blur()');
            const onBody = await js('!document.activeElement || document.activeElement === document.body');
            await key('Escape');
            await sleep(200);
            const after = { menu: await exists(menuSel), bar: await exists('.sidebar .sel-bar'), picked: await count('.sidebar .sb-list .sel-box:checked') };
            check(`Esc with ${name} open and the focus on <body> closes only the menu: the multi-select and its picks stay (polish P1)`, opened && onBody && !after.menu && after.bar && picked0 >= 1 && after.picked === picked0, JSON.stringify({ opened, onBody, picked0, ...after }));
          }
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
           * live runner. Then every id of entries.ts PLACES must have been seen in its place. Real events replace what
           * is faked (`sessions.changed` / `library.changed` → the list, the hub's 5-minute `limits`, `library.*` → the
           * sources), so for the whole scenario a `__store.subscribe` puts the fakes back whenever one of those three
           * changes; it is removed before the real state is restored.
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
            const saved = await js('JSON.stringify({ limits: window.__store.getState().limits, sources: window.__store.getState().librarySources })');
            const limits = { ok: true, capturedAt: new Date(now).toISOString(), subscriptionType: 'max', windows: [{ label: '5 小时', percent: 34, resetsAt: new Date(now + 3600e3).toISOString(), active: true }] };
            const codex = { kind: 'codex', name: 'Codex', installed: true, detected: true, joined: false, dismissed: false, enabled: false };
            const installed = await js(`(() => {
              const st = window.__store, F = ${JSON.stringify(fakes)}, L = ${JSON.stringify(limits)}, C = ${JSON.stringify(codex)};
              const apply = () => {
                const s = st.getState(), patch = {};
                const have = new Set(s.sessions.map((x) => x.sessionId));
                const add = F.filter((f) => !have.has(f.sessionId));
                if (add.length) patch.sessions = [...s.sessions, ...add];
                if (s.limits !== L) patch.limits = L;
                if (!s.librarySources.includes(C)) patch.librarySources = [...s.librarySources.filter((x) => x.kind !== C.kind), C];
                if (Object.keys(patch).length) st.setState(patch);
              };
              if (window.__cwSmokeFakesOff) window.__cwSmokeFakesOff();
              let busy = false;
              const off = st.subscribe((s, prev) => {
                if (busy || (s.sessions === prev.sessions && s.limits === prev.limits && s.librarySources === prev.librarySources)) return;
                busy = true;
                try { apply(); } finally { busy = false; }
              });
              window.__cwSmokeFakesOff = () => { off(); window.__cwSmokeFakesOff = null; };
              apply();
              return true;
            })()`);
            check('sidebar scenarios: fakes installed (kept by a store subscription while they run)', installed);
            await sleep(400);
            await harvest();
            check('library hint: a detected source that was not joined shows the one-line hint (加入 / 以后再说)', await exists('.sidebar .sb-hint [data-id="library-join"]') && await exists('.sidebar .sb-hint [data-id="library-later"]'));
            // several agents' names wrap onto a second line instead of being cut off; the full text is the tooltip
            await js(`(() => { const names = { opencode: 'OpenCode', gemini: 'Gemini CLI', qwen: 'Qwen Code' }; const extra = Object.keys(names).map((k) => ({ kind: k, name: names[k], installed: true, detected: true, joined: false, dismissed: false, enabled: false })); const st = window.__store.getState(); window.__store.setState({ librarySources: [...st.librarySources.filter((x) => !names[x.kind]), ...extra] }); })()`);
            await sleep(300);
            const hintFit = await js(`(() => { const m = document.querySelector('.sidebar .sb-hint .msg'); if (!m) return null; const lh = parseFloat(getComputedStyle(m).lineHeight); const j = document.querySelector('.sidebar .sb-hint [data-id="library-join"]').getBoundingClientRect(); const h = document.querySelector('.sidebar .sb-hint').getBoundingClientRect(); return { text: m.textContent, lines: Math.round(m.clientHeight / lh), clipped: m.scrollHeight > m.clientHeight + 1, title: m.title.includes('Qwen Code'), joinInside: j.right <= h.right && j.width > 10 }; })()`);
            check('library hint: four agents’ names wrap onto two lines instead of one cut-off line; what still does not fit is in the tooltip; 加入 stays whole', !!hintFit && hintFit.lines === 2 && hintFit.title && hintFit.joinInside, JSON.stringify(hintFit));
            await shot('sidebar-hint-wrap');
            // 其它文件夹 starts folded when there are projects: its running conversation stays in view, the header spins
            const other = { spin: await exists('.sidebar [data-id="other"] > .sb-sec-h .spin'), row: await exists('.sidebar [data-id="other"] .sb-kept [data-sid="smoke-elsewhere"] .st.run') };
            check('folded 其它文件夹: the header spins and the running conversation stays listed under it', other.spin && other.row, JSON.stringify(other));
            await js('document.querySelector(\'.sidebar [data-id="other"] > .sb-sec-h\')?.focus()');
            await key('Space');
            check('Space unfolds 其它文件夹 (its folders: 设为项目)', await waitFor('document.querySelector(\'.sidebar [data-id="other"] > .sb-sec-h\')?.getAttribute("aria-expanded") === "true" && !!document.querySelector(\'.sidebar [data-id="other"] .sb-group-head .acts [data-id="make-project"]\')', 3000));
            await harvest();
            await click('.sidebar [data-id="other"] > .sb-sec-h');
            // a fork under its parent
            await click('.sidebar .sb-list [data-sid="smoke-parent"] [data-id="kids"]');
            check('the arrow before a parent lists its forks underneath', await waitFor('!!document.querySelector(\'.sidebar .sb-list [data-sid="smoke-child"].kid\')', 3000));
            await harvest();
            // other machines: grouped by machine, 5 rows then 再显示 N 个 / 收起; an offline machine says so
            const peers = { rows: await count('.sidebar [data-group="peer:smokepeer"] .sb-row'), off: await exists('.sidebar [data-group="peer:offpeer"] .badge'), offRow: await exists('.sidebar [data-group="peer:offpeer"] .sb-row.offline') };
            await click('.sidebar [data-group="peer:smokepeer"] [data-id="more"]');
            const peersMore = { rows: await count('.sidebar [data-group="peer:smokepeer"] .sb-row'), less: await exists('.sidebar [data-group="peer:smokepeer"] [data-id="less"]') };
            check('其它电脑: 5 rows, 再显示 shows the rest and 收起; an offline machine is marked and read-only', peers.rows === 5 && peers.off && peers.offRow && peersMore.rows === 7 && peersMore.less, JSON.stringify({ peers, peersMore }));
            await harvest();
            await click('.sidebar [data-group="peer:smokepeer"] [data-id="less"]');
            // the funnel lists the machines once there is another one (the list just shrank: let it settle first)
            await sleep(300);
            await click('.sidebar [data-id="filter"]');
            await waitFor('!!document.querySelector(".menu.sb-filter")', 2000);
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
            // back to the real list: stop re-applying first
            await js('window.__cwSmokeFakesOff && window.__cwSmokeFakesOff()');
            await js(`(() => { const ids = new Set(${JSON.stringify(fakes.map((f) => f.sessionId))}); const r = JSON.parse(${JSON.stringify(saved)}); window.__store.setState((s) => ({ sessions: s.sessions.filter((x) => !ids.has(x.sessionId)), limits: r.limits, librarySources: r.sources })); })()`);
            // nothing is reachable only in the table: every id of every place was on screen
            const missing = [];
            for (const p of Object.keys(PLACES)) for (const id of PLACES[p]) if (!(seen[p] && seen[p].has(id))) missing.push(p + ':' + id);
            check(`sidebar entries: all ${Object.values(PLACES).reduce((n, v) => n + v.length, 0)} ids of entries.ts PLACES were found in the DOM, each in its place`, !missing.length, missing.join(', '));
          }
        }
      }

      // ---- redesign phase 5: chat rendering — folded turns, the change card, thinking time, hover actions, and the
      // permission card docked above the composer (a real request from the mock ACP agent: allow once with an empty
      // Enter, deny with the words in the box, 拒绝 with a reason; 总是允许 and 「还有 N 条」 on staged requests)
      if (E.SMOKE_READONLY !== '1' && E.SMOKE_TOOLS_SID) {
        phase = 'chat-turns';
        const tsid = JSON.stringify(E.SMOKE_TOOLS_SID);
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
        await js(`window.__store.getState().loadHistory(${tsid})`);
        const folded = await waitFor(`!!document.querySelector('.pane.focused .chat-inner[data-session-id=${tsid}] .turn.folded .turn-sum')`, 10_000);
        const turn = await js(`(() => { const t = document.querySelector('.pane.focused .turn.folded'); if (!t) return null; const body = t.querySelector('.turn-body'); return { sum: t.querySelector('.turn-sum').textContent, expanded: t.querySelector('.turn-sum').getAttribute('aria-expanded'), hidden: body.hidden, answer: t.querySelector('.turn-answer .md')?.textContent ?? null, card: t.querySelector('.fcard .fcard-h .t')?.textContent ?? null, rows: [...t.querySelectorAll('.fcard .fcard-f[data-path]')].map((r) => r.querySelector('.p').textContent), steps: body.querySelectorAll('.tl').length }; })()`);
        check('a finished turn folds to 「已处理 45 秒 · 读了 1 个文件 · 改了 1 个 · 运行 1 条命令」; the answer and 「改动了 1 个文件」 stay out', folded && turn && turn.sum === '已处理 45 秒 · 读了 1 个文件 · 改了 1 个 · 运行 1 条命令' && turn.expanded === 'false' && turn.hidden && /readme is tidy/.test(turn.answer ?? '') && turn.card === '改动了 1 个文件' && turn.rows.join() === 'README.md' && turn.steps >= 3, JSON.stringify(turn));
        await shot('chat-folded');
        await click('.pane.focused .turn-sum');
        const opened = await js(`(() => { const t = document.querySelector('.pane.focused .turn.folded'); const body = t.querySelector('.turn-body'); return { expanded: t.querySelector('.turn-sum').getAttribute('aria-expanded'), hidden: body.hidden, visible: body.getBoundingClientRect().height > 40, thinking: body.querySelector('.trail.thinking .tl-head .lbl')?.textContent ?? null, diffs: body.querySelectorAll('.diff').length }; })()`);
        check('clicking the line opens the same timeline; the thinking says 「思考了 12 秒」 folded; no diff open by default', opened.expanded === 'true' && !opened.hidden && opened.visible && opened.thinking === '思考了 12 秒' && opened.diffs === 0, JSON.stringify(opened));
        await shot('chat-expanded');
        // 在对话里直接展开改动 (ui.inlineDiffs): the edit step starts open
        await js('window.__store.getState().setSetting("ui.inlineDiffs", true)');
        const inline = await waitFor(`document.querySelectorAll('.pane.focused .turn.folded .turn-body .tl.open .diff').length === 1`, 3000);
        await js('window.__store.getState().setSetting("ui.inlineDiffs", false)');
        check('「在对话里直接展开改动」 opens the edit step\'s diff; off closes it again', inline && await waitFor(`document.querySelectorAll('.pane.focused .turn.folded .turn-body .diff').length === 0`, 3000));
        await click('.pane.focused .turn-sum');
        check('clicking it again folds the turn', await js(`document.querySelector('.pane.focused .turn.folded .turn-body').hidden`));
        // the message actions: hidden until hover / keyboard focus inside the message
        const actOpacity = () => js(`(() => { const a = document.querySelector('.pane.focused .turn-answer > .msg-actions'); return a ? getComputedStyle(a).opacity : null; })()`);
        wc.sendInputEvent({ type: 'mouseMove', x: 4, y: 400 });
        await sleep(300);
        const idle = await actOpacity();
        await js(`document.querySelector('.pane.focused .turn-answer > .msg-actions button').focus()`);
        await sleep(350);
        const focused = await actOpacity();
        await js('document.activeElement.blur()');
        check('message actions: invisible at rest, shown when the keyboard focus is inside the message', idle === '0' && focused === '1', JSON.stringify({ idle, focused }));
        // a file row of the change card: 审阅 on this conversation's changes, scrolled to that file and open
        await click('.pane.focused .fcard .fcard-f[data-path]');
        const reviewed = await waitFor(`!!document.querySelector('.dock-panel[data-panel="files"]:not([hidden]) .review') && /本次对话/.test(document.querySelector('.dock-panel[data-panel="files"] .rv-scope')?.textContent ?? '')`, 6000);
        const fileOpen = reviewed && await waitFor(`[...document.querySelectorAll('.dock-panel[data-panel="files"] .rv-fh')].some((h) => /README\\.md/.test(h.textContent) && h.getAttribute('aria-expanded') === 'true')`, 6000);
        check('a file row of the change card opens 审阅 on 本次对话改动 with that file open', reviewed && fileOpen, JSON.stringify({ reviewed, fileOpen }));
        await shot('chat-card-review');
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
        await sleep(300);
        win.setContentSize(740, 860);
        await waitFor('document.querySelector(".app").classList.contains("mobile")', 4000);
        await sleep(400);
        await click('.pane .fcard .fcard-f[data-path]');
        // a phone's right panel is the bottom drawer (redesign phase 7): 改动 opens there, like ··· → 改动
        const inDrawer = await waitFor(`document.querySelector('.app').classList.contains('sheet-open') && [...document.querySelectorAll('.rpanel .dock-panel[data-panel="files"]:not([hidden]) .rv-fh')].some((h) => /README\\.md/.test(h.textContent) && h.getAttribute('aria-expanded') === 'true')`, 6000);
        check('phone: a file row of the change card opens 审阅 (本次对话改动) in the bottom drawer, at that file', inDrawer && !(await js('!!document.querySelector(".pane .wb-body")')));
        await js('document.querySelector(".sheet-backdrop")?.click()');
        await waitFor('!document.querySelector(".app").classList.contains("sheet-open")', 3000);
        win.setContentSize(1360, 860);
        await waitFor('!document.querySelector(".app").classList.contains("mobile")', 4000);
        await sleep(300);

        // ---- the docked permission card, with a real request (the mock ACP agent asks before its Read)
        phase = 'chat-permission';
        // one request to the server from here (the page's socket is not reachable): agents.set, goals.create / start
        const serverRequest = (req) => new Promise((res, rej) => {
          const WS = require(path.join(ROOT, 'node_modules', 'ws'));
          const u = new URL(E.SMOKE_URL);
          const s = new WS(`ws://${u.host}/ws?token=${u.searchParams.get('token')}`);
          s.on('error', rej);
          s.on('open', () => s.send(JSON.stringify({ type: 'request', request: { id: '1', req } })));
          s.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'reply' && m.reply.id === '1') { s.close(); m.reply.ok ? res(m.reply.data) : rej(new Error(m.reply.error)); } });
        });
        await serverRequest({ kind: 'agents.set', agent: 'acp:smoke', patch: { name: 'Smoke Agent', command: E.SMOKE_NODE, args: [path.join(ROOT, 'server', 'src', 'agents', '__mocks__', 'acp-agent.mjs')], env: { MOCK_SLOW_MS: '12000' }, protocol: 'acp', label: 'smoke' } });
        const psid = await js(`window.__store.getState().openSession({ cwd: ${JSON.stringify(E.SMOKE_REPO)}, agent: 'acp:smoke', permissionMode: 'default' })`);
        const pj = JSON.stringify(psid);
        check('a mock-agent conversation opens', !!psid && await waitFor(`window.__store.getState().open[${pj}]?.state === 'idle'`, 20_000), String(psid));
        // record what the page answers (the WebSocket frames it sends)
        await js(`(() => { window.__permSent = []; const orig = WebSocket.prototype.send; if (orig.__smoke) return; const wrap = function (d) { try { const m = JSON.parse(d); if (m && m.request && m.request.req && m.request.req.kind === 'permission.respond') window.__permSent.push(m.request.req); } catch {} return orig.call(this, d); }; wrap.__smoke = true; WebSocket.prototype.send = wrap; })()`);
        const lastSent = () => js('JSON.stringify(window.__permSent[window.__permSent.length - 1] ?? null)');
        const askTool = async (text) => {
          await js(`window.__store.getState().send(${pj}, ${JSON.stringify(text)})`);
          return waitFor(`!!document.querySelector('.pane.focused .composer .pdock[data-kind="tool"]')`, 15_000);
        };
        const docked = await askTool('smoke: please use a tool');
        const dock = await js(`(() => { const c = document.querySelector('.pane.focused .composer'); const d = c.querySelector('.pdock'); if (!d) return null; return { title: d.querySelector('.pd-title')?.textContent, runCard: !!c.querySelector('.run-card'), inStream: !!document.querySelector('.pane.focused .chat .pdock, .pane.focused .chat .perm'), aboveBox: d.getBoundingClientRect().bottom <= c.querySelector('.composer-box').getBoundingClientRect().top + 1, allow: d.querySelector('[data-act="allow"]')?.textContent, always: !!d.querySelector('[data-act="always"]'), hint: d.querySelector('.pd-hint')?.textContent, placeholder: c.querySelector('textarea').placeholder, waitingStep: document.querySelector('.pane.focused .tl.waiting .tool-head .st.wait')?.textContent ?? null }; })()`);
        check('a permission request docks above the composer (not in the conversation), replacing the run card; the step says 等你确认', docked && dock && /想读取/.test(dock.title) && !dock.runCard && !dock.inStream && dock.aboveBox && /允许一次/.test(dock.allow) && !dock.always && /也可以直接在下面输入/.test(dock.hint) && /允许一次/.test(dock.placeholder) && dock.waitingStep === '等你确认', JSON.stringify(dock));
        // its status line (aria-live, not shown) reads out the title and what an empty Enter does (review M-6)
        await waitFor(`/空着按 Enter 允许一次/.test(document.querySelector('.pane.focused .composer .pdock .pd-live')?.textContent ?? '')`, 2000);
        const live = await js(`(() => { const l = document.querySelector('.pane.focused .composer .pdock .pd-live'); if (!l) return null; const r = l.getBoundingClientRect(); return { text: l.textContent, live: l.getAttribute('aria-live'), role: l.getAttribute('role'), w: r.width, h: r.height }; })()`);
        check('the card has a polite live status line (hidden): its title + 「空着按 Enter 允许一次」', !!live && live.live === 'polite' && live.role === 'status' && /想读取/.test(live.text) && /空着按 Enter 允许一次/.test(live.text) && live.w <= 1 && live.h <= 1, JSON.stringify(live));
        await sleep(400); // (an offscreen capture right after a change can still show the frame before it)
        await shot('chat-permission');
        // Mission Control still answers from its own card
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'mission' })`);
        check('Mission Control still lists the request (允许 / 拒绝 there)', await waitFor(`!!document.querySelector('.dock-panel[data-panel="mission"]:not([hidden]) .mcard .perm')`, 4000));
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
        // …and the sidebar's 需要你 (phase 4) lists it from the same pending list (the sidebar was collapsed earlier)
        if (await js(`!!document.querySelector('.pane.focused .sess-head > .sb-reveal')`)) await click('.pane.focused .sess-head > .sb-reveal');
        await waitFor(`!!document.querySelector('.sidebar .sb-attn .sb-attn-item')`, 4000);
        const attnCount = `document.querySelectorAll('.sidebar .sb-attn .sb-attn-item').length`;
        const attn1 = await js(attnCount);
        // 1. an empty box + Enter = 允许一次 — once the card has been on screen for a moment (review I3: 600 ms)
        await click('.pane.focused .composer textarea');
        await sleep(700);
        await key('Return');
        const allowed = await waitFor(`!document.querySelector('.pane.focused .composer .pdock') && /read ok/.test(document.querySelector('.pane.focused .chat-inner').textContent)`, 15_000);
        const allowSent = await lastSent();
        check('empty box + Enter = 允许一次: {behavior: allow} goes out, the card leaves, the agent carries on', allowed && /"behavior":"allow"/.test(allowSent) && !/updatedPermissions/.test(allowSent), allowSent);
        const attn2 = await js(attnCount);
        check('the sidebar 需要你 row for the request goes with the card', attn1 >= 1 && attn2 === attn1 - 1, JSON.stringify({ attn1, attn2 }));
        check('the turn folds once it is done', await waitFor(`[...document.querySelectorAll('.pane.focused .turn.folded .turn-sum')].some((s) => /^已处理/.test(s.textContent))`, 10_000));
        // 2. words in the box + Enter = deny with those words (the old card's 拒绝理由 field)
        await askTool('smoke: please use a tool again');
        await click('.pane.focused .composer textarea');
        wc.insertText('smoke: use another way');
        await sleep(200);
        const denyLabel = await js(`document.querySelector('.pane.focused .composer .steer.deny')?.textContent ?? null`);
        await key('Return');
        const denied = await waitFor(`!document.querySelector('.pane.focused .composer .pdock') && /denied/.test(document.querySelector('.pane.focused .chat-inner').textContent)`, 15_000);
        const denySent = await lastSent();
        const boxAfter = await js(`document.querySelector('.pane.focused .composer textarea').value`);
        check('words in the box + Enter = deny with them as the reason; the box is cleared; the send slot says 拒绝并发送', denied && /"behavior":"deny"/.test(denySent) && /"message":"smoke: use another way"/.test(denySent) && boxAfter === '' && /拒绝并发送/.test(denyLabel ?? ''), JSON.stringify({ denySent, boxAfter, denyLabel }));
        // 3. the card's 拒绝 with words in the box sends them too
        await askTool('smoke: a tool once more');
        await click('.pane.focused .composer textarea');
        wc.insertText('smoke: not now');
        await sleep(200);
        await click('.pane.focused .composer .pdock [data-act="deny"]');
        await waitFor(`!document.querySelector('.pane.focused .composer .pdock')`, 15_000);
        const btnSent = await lastSent();
        check('拒绝 on the card with words in the box: deny with them, the box is cleared', /"behavior":"deny"/.test(btnSent) && /"message":"smoke: not now"/.test(btnSent) && (await js(`document.querySelector('.pane.focused .composer textarea').value`)) === '', btnSent);
        await waitFor(`window.__store.getState().open[${pj}]?.state === 'idle'`, 15_000);
        // 4. an Enter meant for something else answers nothing (review I3). Staged requests from here on: the server
        // answers 「not found」 for these ids, and the card goes away as it does for one answered elsewhere
        const stageReq = (id, tool = 'Bash', input = `{ command: 'echo ${id}' }`) => `{ requestId: '${id}', sessionId: ${pj}, toolName: '${tool}', input: ${input} }`;
        const setOpen = (patch) => js(`(() => { const st = window.__store; const o = st.getState().open[${pj}]; st.setState({ open: { ...st.getState().open, [${pj}]: { ...o, ${patch}, version: o.version + 1 } } }); })()`);
        const sentFor = (id) => js(`JSON.stringify(window.__permSent.filter((r) => r.requestId === ${JSON.stringify(id)}).map((r) => r.response))`);
        await click('.pane.focused .composer textarea');
        // an Enter in the card's first moments (it has just docked), then a held-down (repeating) Enter
        const early = await js(`(async () => { const st = window.__store; const o = st.getState().open[${pj}]; st.setState({ open: { ...st.getState().open, [${pj}]: { ...o, pending: [${stageReq('smoke-early')}], version: o.version + 1 } } }); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))); const ta = document.querySelector('.pane.focused .composer textarea'); const docked0 = document.querySelector('.pane.focused .composer .pdock')?.dataset.request ?? null; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 200)); const note = document.querySelector('.pane.focused .composer .pdock .pd-hint.note')?.textContent ?? null; const live = document.querySelector('.pane.focused .composer .pdock .pd-live')?.textContent ?? null; await new Promise((r) => setTimeout(r, 600)); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, repeat: true })); await new Promise((r) => setTimeout(r, 300)); return { docked0, note, live, docked: document.querySelector('.pane.focused .composer .pdock')?.dataset.request ?? null, sent: window.__permSent.filter((r) => r.requestId === 'smoke-early').length }; })()`);
        check('an Enter in a card\'s first 600 ms and a held-down Enter answer nothing', early && early.docked0 === 'smoke-early' && early.docked === 'smoke-early' && early.sent === 0, JSON.stringify(early));
        check('…and the card says the early Enter did nothing (on the card and in its status line, review M-6)', !!early && /刚出现/.test(early.note ?? '') && /刚出现/.test(early.live ?? ''), JSON.stringify(early));
        // two requests, Enter twice in a row: the first is allowed, the second (just docked) is not
        await setOpen(`pending: [${stageReq('smoke-two-1')}, ${stageReq('smoke-two-2')}]`);
        await sleep(800);
        for (let i = 0; i < 2; i++) { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); }
        await sleep(1200);
        const two = { first: await sentFor('smoke-two-1'), second: await sentFor('smoke-two-2'), docked: await js(`document.querySelector('.pane.focused .composer .pdock')?.dataset.request ?? null`) };
        check('two requests, Enter pressed twice in a row: only the first is allowed, the second stays docked', two.first === '[{"behavior":"allow"}]' && two.second === '[]' && two.docked === 'smoke-two-2', JSON.stringify(two));
        // words written before a card came: Enter queues them as before (the card says so). After that an empty
        // Enter means what it always means (允许一次); answering with the queued words is the card's own button
        const queueTexts = `window.__store.getState().open[${pj}].queue.map((q) => q.text)`;
        const carryInto = async (id) => {
          await setOpen(`pending: []`);
          await waitFor(`!document.querySelector('.pane.focused .composer .pdock')`, 3000);
          await click('.pane.focused .composer textarea');
          wc.insertText('smoke: the next thing');
          await sleep(200);
          await setOpen(`pending: [${stageReq(id)}], state: 'waiting'`);
          await sleep(800);
          const note = await js(`document.querySelector('.pane.focused .composer .pdock .pd-hint.note')?.textContent ?? null`);
          await key('Return');
          await sleep(300);
          return { note, after: await js(`({ queue: ${queueTexts}, box: document.querySelector('.pane.focused .composer textarea').value, note: document.querySelector('.pane.focused .composer .pdock .pd-hint.note')?.textContent ?? null, button: document.querySelector('.pane.focused .composer .pdock [data-act="deny-queued"]')?.textContent ?? null })`), sent: await sentFor(id) };
        };
        // (a) queued, then an empty Enter: 允许一次 — the queued message stays queued
        const ca = await carryInto('smoke-carried-a');
        // the Enter right after the one that queued (the box was just emptied) is in the card's first moments again (review M-3)
        await key('Return');
        await sleep(250);
        const caDouble = { sent: await sentFor('smoke-carried-a'), note: await js(`document.querySelector('.pane.focused .composer .pdock .pd-hint.note')?.textContent ?? null`) };
        check('an Enter right after the queueing Enter answers nothing (the cool-down starts again when the box empties)', caDouble.sent === '[]' && /刚出现/.test(caDouble.note ?? ''), JSON.stringify(caDouble));
        await sleep(700);
        await key('Return');
        await waitFor(`window.__permSent.some((r) => r.requestId === 'smoke-carried-a')`, 3000);
        const caSent = await sentFor('smoke-carried-a');
        const caQueue = await js(queueTexts);
        check('words from before the card: Enter queues them (not a deny) and the card offers 「改用排队的这段话拒绝」; an empty Enter after that is still 允许一次',
          /卡出现前写的/.test(ca.note ?? '') && ca.sent === '[]' && ca.after.queue.join() === 'smoke: the next thing' && ca.after.box === '' && /点卡片上的「改用排队的这段话拒绝」/.test(ca.after.note ?? '') && ca.after.button === '改用排队的这段话拒绝'
          && caSent === '[{"behavior":"allow"}]' && caQueue.join() === 'smoke: the next thing', JSON.stringify({ ca, caSent, caQueue }));
        await js(`(() => { const st = window.__store.getState(); for (const q of st.open[${pj}].queue) st.recall(${pj}, q.id); })()`);
        // (b) queued, then the button: the queued message comes back out of the queue as the reason
        const cb = await carryInto('smoke-carried-b');
        await click('.pane.focused .composer .pdock [data-act="deny-queued"]');
        await waitFor(`window.__permSent.some((r) => r.requestId === 'smoke-carried-b')`, 3000);
        const cbSent = await sentFor('smoke-carried-b');
        const cbQueue = await js(`${queueTexts}.length`);
        check('…and 「改用排队的这段话拒绝」 takes the queued message back and denies with its words',
          cb.sent === '[]' && cb.after.button === '改用排队的这段话拒绝' && cbSent === '[{"behavior":"deny","message":"smoke: the next thing"}]' && cbQueue === 0, JSON.stringify({ cb, cbSent, cbQueue }));
        // a plan: an empty Enter does nothing, Ctrl+Enter approves
        await setOpen(`pending: [${stageReq('smoke-plan', 'ExitPlanMode', "{ plan: '## smoke plan' }")}], state: 'idle'`);
        await click('.pane.focused .composer textarea'); // (the button clicked above took the focus)
        await sleep(800);
        const planPh = await js(`document.querySelector('.pane.focused .composer textarea').placeholder`);
        await key('Return');
        await sleep(300);
        const planEnter = await sentFor('smoke-plan');
        const planNote = await js(`({ note: document.querySelector('.pane.focused .composer .pdock .pd-hint.note')?.textContent ?? null, live: document.querySelector('.pane.focused .composer .pdock .pd-live')?.textContent ?? null })`);
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['control'] });
        await waitFor(`window.__permSent.some((r) => r.requestId === 'smoke-plan')`, 3000);
        const planCtrl = await sentFor('smoke-plan');
        check('a plan: an empty Enter does nothing, Ctrl+Enter approves (the placeholder says so)', planEnter === '[]' && /^\[\{"behavior":"allow"/.test(planCtrl) && /Ctrl\+Enter/.test(planPh), JSON.stringify({ planEnter, planCtrl, planPh }));
        check('…and the empty Enter on a plan says 「批准请按 Ctrl+Enter」 (on the card and in its status line, review M-6)', /批准请按 Ctrl\+Enter/.test(planNote.note ?? '') && /批准请按 Ctrl\+Enter/.test(planNote.live ?? ''), JSON.stringify(planNote));
        await setOpen(`pending: []`);
        await sleep(300);
        // a card that docks while a page covers the conversation (final review I1): closing the page gives the focus
        // back to the box, and the Enter right after that answers nothing — the card's first moments start when the
        // page goes. The automation page (from the sidebar) and the settings page (opened from the box) alike
        for (const cover of ['automation', 'settings']) {
          const id = `smoke-covered-${cover}`;
          await click('.pane.focused .composer textarea');
          if (cover === 'automation') {
            if (!(await js(`!!document.querySelector('.sidebar [data-id="automation"]')`)) && await js(`!!document.querySelector('.pane.focused .sess-head > .sb-reveal')`)) await click('.pane.focused .sess-head > .sb-reveal');
            await click('.sidebar [data-id="automation"]');
            await waitFor(`(() => { const p = document.querySelector('.auto-page'); return !!p && !p.hidden; })()`, 3000);
          } else {
            await js('window.__store.getState().openSettings()');
            await waitFor(`!!document.querySelector('.modal.settings.sp')`, 3000);
          }
          await setOpen(`pending: [${stageReq(id)}], state: 'waiting'`);
          await sleep(1500);
          const under = await js(`(() => { const d = document.querySelector('.pane.focused .composer .pdock'); if (!d) return null; const r = d.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { docked: d.dataset.request, hidden: !d.contains(hit) }; })()`);
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
          const closed = await waitFor(cover === 'automation' ? 'document.querySelector(".auto-page")?.hidden === true' : '!document.querySelector(".modal.settings.sp")', 2000);
          const inBox = await waitFor(`!!document.activeElement?.matches('.pane.focused .composer textarea')`, 2000);
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
          await sleep(250);
          const right = { sent: await sentFor(id), note: await js(`document.querySelector('.pane.focused .composer .pdock .pd-hint.note')?.textContent ?? null`), docked: await js(`document.querySelector('.pane.focused .composer .pdock')?.dataset.request ?? null`) };
          check(`a card that docked under the ${cover === 'automation' ? 'automation' : 'settings'} page: Esc (the focus back in the box) then Enter at once answers nothing (final review I1)`,
            !!under && under.docked === id && under.hidden && closed && inBox && right.sent === '[]' && right.docked === id && /刚出现/.test(right.note ?? ''), JSON.stringify({ under, closed, inBox, right }));
          // …and once it has been on screen for a moment, an empty Enter is 允许一次 again
          await sleep(700);
          await key('Return');
          await waitFor(`window.__permSent.some((r) => r.requestId === ${JSON.stringify(id)})`, 3000);
          check(`…then, after its first moments, an empty Enter answers it (${cover})`, (await sentFor(id)) === '[{"behavior":"allow"}]', await sentFor(id));
          await setOpen(`pending: [], state: 'idle'`);
          await sleep(300);
        }
        // 5. 总是允许 and 「还有 N 条」: two staged requests with a suggestion (the mock agent sends none)
        const stage = (n) => `{ requestId: 'smoke-always-${n}', sessionId: ${pj}, toolName: 'Bash', input: { command: 'npm test' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }] }`;
        await js(`(() => { const st = window.__store; const o = st.getState().open[${pj}]; st.setState({ open: { ...st.getState().open, [${pj}]: { ...o, pending: [${stage(1)}, ${stage(2)}], version: o.version + 1 } } }); })()`);
        await waitFor(`!!document.querySelector('.pane.focused .composer .pdock [data-act="always"]')`, 4000);
        const staged = await js(`(() => { const d = document.querySelector('.pane.focused .composer .pdock'); return { title: d.querySelector('.pd-title')?.textContent, more: d.querySelector('.pd-more')?.textContent ?? null, always: d.querySelector('[data-act="always"]')?.textContent, cmd: d.querySelector('.pd-cmd code')?.textContent }; })()`);
        await sleep(400);
        await shot('chat-permission-always');
        await click('.pane.focused .composer .pdock [data-act="always"]');
        await waitFor(`window.__permSent.some((r) => r.requestId === 'smoke-always-1')`, 4000);
        const alwaysSent = await js(`JSON.stringify(window.__permSent.find((r) => r.requestId === 'smoke-always-1') ?? null)`);
        const next = await waitFor(`document.querySelector('.pane.focused .composer .pdock')?.dataset.request === 'smoke-always-2' && !document.querySelector('.pane.focused .composer .pdock .pd-more')`, 6000);
        check('总是允许 (only with suggestions) sends {allow, updatedPermissions}; 「还有 1 条」 then the next request', /想运行一条命令$/.test(staged.title ?? '') && staged.more === '还有 1 条' && staged.always === '总是允许 npm test' && staged.cmd === 'npm test' && /"behavior":"allow"/.test(alwaysSent) && /"updatedPermissions":\[\{"type":"addRules"/.test(alwaysSent) && next, JSON.stringify({ staged, alwaysSent, next }));
        // phone width: 允许一次 takes a row of its own when the buttons do not fit
        win.setContentSize(480, 860);
        await waitFor('innerWidth === 480', 4000);
        await sleep(500);
        const narrow = await js(`(() => { const d = document.querySelector('.pane .composer .pdock'); if (!d) return null; const a = d.querySelector('[data-act="allow"]').getBoundingClientRect(), r = d.querySelector('[data-act="deny"]').getBoundingClientRect(), box = d.getBoundingClientRect(); return { own: a.top >= r.bottom - 1, wide: a.width >= box.width - 40, inside: box.left >= 0 && box.right <= innerWidth }; })()`);
        check('phone width: the card is full width and 允许一次 gets its own row', narrow && narrow.own && narrow.wide && narrow.inside, JSON.stringify(narrow));
        await sleep(400);
        await shot('chat-permission-phone');
        win.setContentSize(1360, 860);
        await waitFor('innerWidth === 1360', 4000);
        await click('.pane.focused .composer .pdock [data-act="deny"]');
        await waitFor(`!document.querySelector('.pane.focused .composer .pdock')`, 6000);

        // ---- the goal bar, and a goal that runs two rounds (review I1): GoalService sends round 2 (「继续」) itself, so
        // it follows round 1's result with no user message in this window. The mock answers its first goal prompt
        // with 「GOAL_STATUS: continue」 (MOCK_GOAL_CONTINUE); the objective has 「slow」, so each round runs a command
        // and answers after it (MOCK_SLOW_ANSWER: the answer, with its 分享本轮, sits below the folded steps).
        phase = 'chat-goal';
        await serverRequest({ kind: 'agents.set', agent: 'acp:smoke', patch: { name: 'Smoke Agent', command: E.SMOKE_NODE, args: [path.join(ROOT, 'server', 'src', 'agents', '__mocks__', 'acp-agent.mjs')], env: { MOCK_SLOW_MS: '6000', MOCK_GOAL_CONTINUE: '1', MOCK_SLOW_ANSWER: '1' }, protocol: 'acp', label: 'smoke' } });
        // typed in the conversation's composer, as a user would: `/goal …` runs in a conversation of its own, which
        // then opens here — with its folder (review I-1: it used to open with an empty cwd and resume in the wrong place)
        await click('.pane.focused .composer textarea');
        wc.insertText('/goal smoke slow goal');
        await sleep(200);
        await key('Return');
        const goalSid = await waitFor(`(() => { const t = document.querySelector('.pane.focused .chat-inner')?.dataset.sessionId; return !!t && t !== ${pj}; })()`, 10_000)
          ? await js(`document.querySelector('.pane.focused .chat-inner').dataset.sessionId`) : null;
        const barText = `(document.querySelector('.pane.focused .goal-bar')?.textContent ?? '')`;
        const bar = await waitFor(`/目标：smoke slow goal/.test(${barText}) && /第 1 轮/.test(${barText})`, 10_000);
        check('`/goal` typed in a conversation opens the goal\'s own conversation here; its bar says 「目标：… · 第 1 轮 · 查看」', !!goalSid && bar, await js(`document.querySelector('.pane.focused .goal-bar')?.textContent ?? null`));
        const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const goalHead = await js(`(() => { const it = document.querySelector('.pane.focused .sess-head .sh-meta .it:not(.branch)'); return { cwd: window.__store.getState().open[${JSON.stringify(goalSid)}]?.cwd ?? null, folder: it ? it.title.split('\\n')[0] : null, name: it?.querySelector('.nm')?.textContent ?? null }; })()`);
        check('…with its project in the header (the conversation knows its folder)', goalHead && norm(goalHead.cwd) === norm(E.SMOKE_REPO) && norm(goalHead.folder) === norm(E.SMOKE_REPO) && !!goalHead.name, JSON.stringify(goalHead));
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
        await sleep(300);
        await sleep(400);
        await shot('chat-goal');
        if (bar) {
          await click('.pane.focused .goal-bar .gb-go');
          check('查看 opens the 目标 panel', await waitFor(`window.__store.getState().layout.dock.active === 'goals' && !!document.querySelector('.dock-panel[data-panel="goals"]:not([hidden])')`, 4000));
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
          // a phone: 查看 is back (phase 5 hid it while a phone had nowhere to show a goal) and is showGoals() too — the
          // automation page's 目标 tab, as /goal and every goal entry (review 7 M11)
          win.setContentSize(740, 860);
          await waitFor('document.querySelector(".app").classList.contains("mobile")', 4000);
          await sleep(400);
          const goPhone = await js(`(() => { const b = document.querySelector('.pane.focused .goal-bar .gb-go'); return !!b && b.getBoundingClientRect().width > 0; })()`);
          await click('.pane.focused .goal-bar .gb-go');
          const goalsPhone = await waitFor(`(() => { const p = document.querySelector('.auto-page'); const b = p && p.querySelector('.auto-body[data-body="goals"]:not([hidden])'); return !!b && !p.hidden && p.dataset.tab === 'goals' && !document.querySelector('.app').classList.contains('sheet-open'); })()`, 4000);
          check('phone: the goal bar has 查看 and it opens the automation page on 目标 (not the drawer)', goPhone && goalsPhone, JSON.stringify({ goPhone, goalsPhone }));
          await click('.auto-page .auto-head button[aria-label="关闭自动化"]');
          await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          win.setContentSize(1360, 860);
          await waitFor('!document.querySelector(".app").classList.contains("mobile")', 4000);
          await sleep(300);
          // round 2 running: round 1 folded with its own line, round 2 open with its running command in view
          const turnsNow = `(() => { const turns = [...document.querySelectorAll('.pane.focused .chat .turn')]; const last = turns[turns.length - 1], prev = turns[turns.length - 2]; return { n: turns.length, lastId: last?.dataset.turn ?? null, prevFolded: !!prev && prev.classList.contains('folded') && !prev.classList.contains('open'), prevSum: prev?.querySelector('.turn-sum')?.textContent ?? null, lastOpen: !!last && !last.classList.contains('folded'), running: !!last && [...last.querySelectorAll('.tl.active, .tl.pending')].some((el) => el.offsetParent !== null) }; })()`;
          const round2 = await waitFor(`/第 2 轮/.test(${barText}) && (${turnsNow}).running`, 30_000);
          const r2 = await js(turnsNow);
          check('a goal\'s second round: round 1 folded with its own line, round 2 (no user message here) open with its running step in view', round2 && r2.n >= 2 && r2.prevFolded && /^已处理/.test(r2.prevSum ?? '') && r2.lastOpen && r2.running, JSON.stringify(r2));
          await sleep(400);
          await shot('chat-goal-round2');
          check('the bar goes once the goal is done', await waitFor(`!document.querySelector('.pane.focused .goal-bar')`, 30_000));
          const folded = await waitFor(`(() => { const turns = [...document.querySelectorAll('.pane.focused .chat .turn')].slice(-2); return turns.length === 2 && turns.every((t) => t.classList.contains('folded') && /^已处理/.test(t.querySelector('.turn-sum')?.textContent ?? '')); })()`, 8000);
          check('…then both rounds are folded, each with its own summary line', folded, await js(`JSON.stringify([...document.querySelectorAll('.pane.focused .chat .turn')].map((t) => [t.dataset.turn, t.className, t.querySelector('.turn-sum')?.textContent ?? null]))`));
          // 分享本轮 under round 2's answer exports round 2 — its own `cont-…` turn, not round 1 (review M-4). The
          // download is caught in the page: the blob's HTML is read back, the anchor's click does nothing
          const shared = await js(`(async () => {
            const turns = [...document.querySelectorAll('.pane.focused .chat .turn')];
            const last = turns[turns.length - 1];
            const btn = last?.querySelector('.msg-actions button[aria-label="分享本轮"]');
            if (!btn) return { err: 'no share button', id: last?.dataset.turn ?? null };
            let html = null;
            const oc = URL.createObjectURL, ac = HTMLAnchorElement.prototype.click;
            URL.createObjectURL = (b) => { b.text().then((t) => { html = t; }); return 'blob:smoke'; };
            HTMLAnchorElement.prototype.click = function () {};
            try { btn.click(); } finally { URL.createObjectURL = oc; HTMLAnchorElement.prototype.click = ac; }
            for (let i = 0; i < 40 && html === null; i++) await new Promise((r) => setTimeout(r, 50));
            const doc = new DOMParser().parseFromString(html ?? '', 'text/html');
            return { id: last.dataset.turn, exported: [...doc.querySelectorAll('.turn')].map((t) => t.dataset.turn) };
          })()`);
          check('分享本轮 under a round this window did not start exports that round (its cont- turn), not the one before', !!shared && /^cont-/.test(shared.id ?? '') && Array.isArray(shared.exported) && shared.exported.length === 1 && shared.exported[0] === shared.id, JSON.stringify(shared));
          // the step view's 「轮」 counts the rounds as the chat draws them: the goal's second round is 2 (review M-11)
          const setView = (v) => js(`(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); const p = g.panes[g.focusedPaneId]; const t = p.tiles.find((x) => x.id === p.activeTileId) ?? p.tiles[0]; st.dispatchLayout({ t: 'tile.patch', paneId: p.id, tileId: t.id, patch: { view: ${JSON.stringify(v)} } }); })()`);
          await setView('trajectory');
          await waitFor(`!!document.querySelector('.pane.focused .traj tbody tr')`, 4000);
          const trajTurns = await js(`[...new Set([...document.querySelectorAll('.pane.focused .traj tbody tr')].map((r) => r.cells[0].textContent))]`);
          await setView('chat');
          check('the step view numbers the goal\'s rounds 1 and 2, as the chat has them', Array.isArray(trajTurns) && trajTurns.includes('1') && trajTurns.includes('2') && !trajTurns.includes('0'), JSON.stringify(trajTurns));
        }
        const err5 = await noBoundary('body');
        check('chat rendering checks without error boundary', !err5, err5);
      }

      const emptyBad = [...emptySeen].filter(([t, b]) => !/^还没有[^。]+。[^。]*之后[^。]*会出现在这里。$/.test(t) || b > 1).map(([t, b]) => `${t} (${b} buttons)`);
      check(`empty states read 「还没有 X。Y 之后会出现在这里。」 with at most one button (${emptySeen.size} seen)`, emptySeen.size > 0 && !emptyBad.length, emptyBad.join(' | ') || [...emptySeen.keys()].join(' | '));

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
