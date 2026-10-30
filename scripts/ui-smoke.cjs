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
  const sections = [...list.matchAll(/id: '([\w.-]+)', l: (?:tr(?:As)?\()?'([^']+)'(?:, '[^']+')?\)?, ic: '\w+', group: '(\w+)'(, advanced: true)?/g)].map((m) => ({ id: m[1], label: m[2], group: m[3], advanced: !!m[4], at: m.index, tabs: [], pages: [] }));
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
  const panels = [...block.matchAll(/\{ id: '(\w+)', title: (?:tr\()?'([^']+)'/g)].map((m) => ({ id: m[1], title: m[2] }));
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
  // the smoke asserts Chinese texts: the interface language is pinned (scripts/i18n-smoke.cjs looks at the English one)
  fs.mkdirSync(path.join(home, '.claude-web'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-web', 'meta.json'), JSON.stringify({ version: 1, settings: { 'ui.language': 'zh', 'ui.sidebarFolded': false, 'ui.welcomeLayout': 'inbox' } }));
  // 连接器 → 编辑: one user-scope MCP server with a credential and a plain variable; 导入: a Pencil copy and a
  // Gemini entry pointing at an extension folder that is gone
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'smoke-edit': { type: 'stdio', command: 'smoke-old.exe', args: ['--mcp'], env: { SMOKE_API_KEY: 'smoke-secret-1', SMOKE_HOME: 'D:/old' } } } }));
  fs.mkdirSync(path.join(home, '.pencil', 'mcp', 'antigravity', 'out'), { recursive: true });
  fs.writeFileSync(path.join(home, '.pencil', 'mcp', 'antigravity', 'out', process.platform === 'win32' ? 'mcp-server-windows-x64.exe' : `mcp-server-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`), '');
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { 'smoke-gone': { command: path.join(home, 'gone-ext-0.1', 'mcp.exe'), args: ['--app', 'x'] } } }));
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
    // the inline code is for the double click (parity-a A4: it selects the whole span)
    // the two links are for parity-a A1 (review I1): a file:/// link and a drive path in a reply keep their href
    am([{ type: 'text', text: 'smoke: the readme is tidy now, see `activation_status` there.\n\n```\nline one\nline two\n```\n\n'
      + `Links: [smoke-file-url](${require('node:url').pathToFileURL(readme).href}) and [smoke-drive-path](<${process.platform === 'win32' ? readme.replace(/\//g, '\\') : 'C:\\smoke\\README.md'}>) and [smoke-web-link](https://example.invalid/stage-b)` }], 45, 'msg_t4'),
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  // a third: /code-review's findings, reported through ReportFindings (spec 2026-10-16 review-pr §2)
  const reviewSid = '5a0e0e0e-0000-4000-8000-00000000c0e1';
  pu = null; un = 40;
  const rb = { ...base, sessionId: reviewSid };
  const rline = (o, s) => { const uuid = `00000000-0000-4000-8000-0000000c0e${String(++un).padStart(2, '0')}`; const l = { ...rb, parentUuid: pu, uuid, timestamp: at(s), ...o }; pu = uuid; return l; };
  fs.writeFileSync(path.join(proj, `${reviewSid}.jsonl`), [
    rline({ type: 'user', message: { role: 'user', content: 'smoke: /code-review' } }, 0),
    rline({ type: 'assistant', message: { id: 'msg_r1', type: 'message', role: 'assistant', model: 'claude-smoke', content: [{ type: 'tool_use', id: 'toolu_r_find', name: 'ReportFindings', input: { level: 'high', findings: [{ file: 'src/index.ts', line: 1, summary: 'smoke finding one', failure_scenario: 'x → y', category: 'correctness', verdict: 'CONFIRMED' }, { file: 'README.md', summary: 'smoke finding two', failure_scenario: 'a → b' }] } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } }, 5),
    rline({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r_find', content: 'reported' }] } }, 6),
    rline({ type: 'assistant', message: { id: 'msg_r2', type: 'message', role: 'assistant', model: 'claude-smoke', content: [{ type: 'text', text: 'smoke: review done.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }, 8),
    // 跨对话工具 (spec 2026-10-16 sessions-env §1–2): a message from another conversation, then a suggested task
    rline({ type: 'user', message: { role: 'user', content: '<cw-from session="' + sid + '" title="smoke sender">\nsmoke: hello from the other one\n</cw-from>' } }, 10),
    rline({ type: 'assistant', message: { id: 'msg_r3', type: 'message', role: 'assistant', model: 'claude-smoke', content: [{ type: 'tool_use', id: 'toolu_r_task', name: 'mcp__sessions__suggest_task', input: { title: 'smoke task', prompt: 'smoke: do the other thing', worktree: true } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } }, 12),
    rline({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r_task', content: 'Shown to the user as a task chip.' }] } }, 13),
    rline({ type: 'assistant', message: { id: 'msg_r4', type: 'message', role: 'assistant', model: 'claude-smoke', content: [{ type: 'text', text: 'smoke: suggested.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }, 14),
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  // a fourth (spec 2026-10-24 D4): the mp4's node graph (keep the same as web/src/ui/node-graph/sample.ts), a mermaid
  // flowchart the node graph can read, and a broken ```nodegraph block
  const graphSid = '5a0e0e0e-0000-4000-8000-00000000c0f1';
  const NG_SAMPLE = {
    title: 'Access settings', subtitle: 'Who can read the customers bucket', badge: { count: 'error', text: '{n} open path', okText: 'No open paths' },
    nodes: [
      { id: 'anyone', title: 'Anyone', subtitle: 'Public internet' }, { id: 'admin', title: 'Admin', subtitle: '2 people' }, { id: 'backup', title: 'Nightly backup', subtitle: 'paused' },
      { id: 'link', title: 'Share link', subtitle: 's3://acme-customers', rows: [
        { id: 'read', label: 'read', value: 'Anyone', options: [{ value: 'Anyone', marks: { 'e-open': 'error' } }, { value: 'Admin', marks: { 'e-open': 'dashed' } }] },
        { id: 'write', label: 'write', value: 'Admin', options: ['Admin', 'Team'] }] },
      { id: 'bucket', title: 'customers', subtitle: 'S3 bucket', list: { title: '4 reads this week', items: [{ text: 'Lisbon', tags: ['PT', '2h'] }, { text: 'Austin', tags: ['US', '1d'] }, { text: 'Osaka', tags: ['JP', '3d'] }, { text: 'Berlin', tags: ['DE', '5d'] }] } },
    ],
    edges: [
      { id: 'e-open', from: 'anyone', to: 'link', label: 'public', style: 'error' }, { id: 'e-admin', from: 'admin', to: 'link', label: 'member' },
      { id: 'e-read', from: 'link', to: 'bucket', fromRow: 'read', label: 'read' }, { id: 'e-write', from: 'link', to: 'bucket', fromRow: 'write', label: 'write' },
      { id: 'e-backup', from: 'backup', to: 'bucket', label: 'paused', style: 'dashed' },
    ],
  };
  const graphText = [
    'Here is who can read the bucket:', '', '```nodegraph', JSON.stringify(NG_SAMPLE, null, 1), '```', '',
    'The request path:', '', '```mermaid', 'flowchart LR', '  A[Client] -->|HTTPS| B(API)', '  B -.-> C{{Cache}}', '  B ==> D[(Orders DB)]', '```', '',
    'And a broken one:', '', '```nodegraph', '{"nodes": [', '```',
  ].join('\n');
  pu = null; un = 60;
  const gb = { ...base, sessionId: graphSid };
  const gline = (o, s) => { const uuid = `00000000-0000-4000-8000-0000000c0f${String(++un).padStart(2, '0')}`; const l = { ...gb, parentUuid: pu, uuid, timestamp: at(s), ...o }; pu = uuid; return l; };
  // staged outside the projects folder and copied in by the node-graph phase: one more sidebar row earlier makes the
  // list overflow, and the 显示 → 分组方式 check (its menu closes when the list it sits in scrolls) would trip on it
  const graphStage = path.join(home, `${graphSid}.jsonl`);
  fs.writeFileSync(graphStage, [
    gline({ type: 'user', message: { role: 'user', content: 'smoke: draw who can read the bucket' } }, 0),
    gline({ type: 'assistant', message: { id: 'msg_g1', type: 'message', role: 'assistant', model: 'claude-smoke', content: [{ type: 'text', text: graphText }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }, 4),
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  return { repo, sid, toolsSid, reviewSid, graphSid, graphStage, graphDest: path.join(proj, `${graphSid}.jsonl`), transcript: path.join(proj, `${sid}.jsonl`) };
}

async function startServer(home, out, extraEnv) {
  const { spawn } = require('node:child_process');
  const token = require('node:crypto').randomBytes(12).toString('hex');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1', ...extraEnv };
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
    // a profile of its own, never the user's (their Claude Web may be running)
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-uismoke-udd-'));
    const c = spawn(electron, [__filename, `--user-data-dir=${udd}`], { env: e, stdio: 'ignore', windowsHide: false });
    const t = setTimeout(() => { console.log(`electron still running after ${Math.round(timeoutMs / 1000)} s: killed`); c.kill(); res(-1); }, timeoutMs);
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
    // stage E: the PR bar's forge requests go to scripts/fake-forge.cjs (the driver starts it and writes this file)
    srv = await startServer(home, out, { CW_FAKE_FORGE_FILE: path.join(home, 'fake-forge.json'), ...(idle ? { CW_SPAWN_LOG: '1', CW_SPAWN_LOG_FILE: spawnLog } : {}) });
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
    SMOKE_REVIEW_SID: seed?.reviewSid ?? '',
    SMOKE_GRAPH_SID: seed?.graphSid ?? '',
    SMOKE_GRAPH_STAGE: seed?.graphStage ?? '',
    SMOKE_GRAPH_DEST: seed?.graphDest ?? '',
    // the server's data dir (the temp HOME's): checks that read what the server wrote (the canonical mirror)
    SMOKE_DATA: home ? path.join(home, '.claude-web') : '',
    SMOKE_FAKE_FORGE: home ? path.join(home, 'fake-forge.json') : '',
    // the mock ACP agent (phase 5: a real permission request) runs under this node, not Electron
    SMOKE_NODE: process.execPath,
    SMOKE_SHOW: arg('--show', false) ? '1' : '',
    SMOKE_INVENTORY: JSON.stringify(inv),
    // longer than the driver's own hard stop (below): the driver must get to write its result and say where it stopped
    // (with 520 s here the grown smoke, ~9 min, was killed mid stage B and reported only "electron exited -1");
    // stages D / E / F added the node-graph, stage-e and stage-f phases on top
  }, (idle + 1020) * 1000);
  let r = null;
  try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { /* electron died */ }
  let failed = !r || code !== 0;
  if (r) {
    for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    const bad = r.console.filter((m) => !m.expected && !/task queue exceeded allotted deadline/.test(m.message || ""));
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
      // the emptied code block (chat-turns) reported what it saw: the translator's mark, the attribute it left
      const blank = /\[web warn\] 代码块: 代码块有内容却显示为空，重画一次后恢复 · 语言 自动识别 · 2 行 · \d+ 字 · 已完成 · 页面被 微软翻译 改过 · 外来属性 _msthash · Electron \d+ · 浏览器/.test(srv.log());
      console.log(`${blank ? 'PASS' : 'FAIL'} an emptied code block reached the server log with what was there`);
      if (!blank) failed = true;
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
  // the whole smoke takes ~9 minutes on a busy machine (stage B's browser section alone ~1.5), more with stages D / E / F;
  // the runner waits longer
  const hardStop = setTimeout(() => { check(`driver finished in time (stopped in phase ${phase})`, false); finish(6); }, (Number(E.SMOKE_IDLE || 0) + 960) * 1000);

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
    // one request to the server over its own socket (the page's is not reachable)
    const srvReq = (req) => new Promise((res, rej) => {
      const WS = require(path.join(ROOT, 'node_modules', 'ws'));
      const u = new URL(E.SMOKE_URL);
      const s = new WS(`ws://${u.host}/ws?token=${u.searchParams.get('token')}`);
      s.on('error', rej);
      s.on('open', () => s.send(JSON.stringify({ type: 'request', request: { id: '1', req } })));
      s.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'reply' && m.reply.id === '1') { s.close(); m.reply.ok ? res(m.reply.data) : rej(new Error(m.reply.error)); } });
    });
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
          // redesign phase 7 (spec §5.8 / §7 row 7): two steps — ① 接一个模型 (skippable) ② a project folder — and the
          // first message is one Enter away: 接一个模型 · the folder · Enter = 3 steps from a cold start. This HOME has no
          // key: it skips ① and the send asks for a model (one more click, on a provider added from here)
          const steps = await js(`[...document.querySelectorAll('.modal.onboarding .ob-steps li')].map((l) => l.textContent)`);
          check('onboarding: two steps (接一个模型 · 选一个项目文件夹)', steps.length === 2 && /接一个模型/.test(steps[0]) && /项目文件夹/.test(steps[1]), JSON.stringify(steps));
          let taken = 0;
          // before the login check answers, a neutral 正在检查登录… (review 7 M9) — not a step to act on
          const checking = await js(`document.querySelector('.modal.onboarding')?.dataset.step === 'checking' ? (document.querySelector('.modal.onboarding .ob-checking')?.textContent ?? '') : null`);
          if (checking !== null) check('onboarding: 正在检查登录… until the login check answers (no login buttons yet)', /正在检查登录/.test(checking) && !(await js(`!!document.querySelector('.modal.onboarding [data-ob="skip"]')`)), checking);
          await waitFor(`document.querySelector('.modal.onboarding')?.dataset.step !== 'checking'`, 30_000);
          if (await js(`document.querySelector('.modal.onboarding')?.dataset.step === 'login'`)) {
            const loginRow = await js(`[...document.querySelectorAll('.modal.onboarding .ob-actions button')].map((b) => b.textContent.trim())`);
            const presets = await js(`[...document.querySelectorAll('.modal.onboarding .qc .qc-preset')].map((b) => b.textContent.trim())`);
            // no key needed to look: the quick connect is the step itself (presets, the key field, 连接); the Claude login is secondary
            check('onboarding ①: 接一个模型 in place (中转站 / DeepSeek / Kimi… · API Key · 连接), then 用 Claude 账号登录 / 先跳过', presets[0] === '中转站' && presets.length >= 6 && await js(`!!document.querySelector('.modal.onboarding .qc [data-qc="key"]') && !!document.querySelector('.modal.onboarding .qc [data-qc="connect"]')`) && ['用 Claude 账号登录', '先跳过'].every((t) => loginRow.some((x) => x.includes(t))) && !loginRow.some((x) => /添加供应商|在终端登录/.test(x)), JSON.stringify({ presets, loginRow }));
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
          // no login and no model here: the send asks for one first (it would only come back 「Not logged in」), keeps
          // the text, and goes out once one is picked — a provider added from here (its endpoint is never reached)
          let smokeProv = null;
          if (await waitFor(`document.querySelector('.modal.connect-model')?.dataset.reason === 'send'`, 4000)) {
            const held = await js(`({ text: document.querySelector('.welcome .composer textarea')?.value ?? '', open: Object.keys(window.__store.getState().open).length })`);
            check('send with no login and no model: 「先接一个模型」 opens, the text stays, nothing is started', held.text.includes('smoke：第一条') && held.open === 0, JSON.stringify(held));
            smokeProv = await srvReq({ kind: 'providers.upsert', provider: { name: 'Smoke 首发', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'smoke-placeholder-not-a-key', models: ['smoke-m1'], defaultModel: 'smoke-m1' } });
            await js('window.__store.getState().loadProviders()');
            const pickSel = '.modal.connect-model [data-qc="existing"]';
            if (await waitFor(`!!document.querySelector('${pickSel}')`, 5000)) await click(pickSel);
            taken++;
          }
          const sentExpr = `(() => { const st = window.__store.getState(); const o = Object.values(st.open).find((x) => x.conv.items.some((i) => i.kind === 'user' && String(i.text).includes('smoke：第一条'))); return o ? { sid: o.sessionId, cwd: o.cwd, lastSent: !!o.lastSent, inPane: st.layout.groups.some((g) => Object.values(g.panes).some((p) => p.tiles.some((t) => t.kind === 'chat' && t.sessionId === o.sessionId))) } : null; })()`;
          await waitFor(`!!${sentExpr}`, 30_000);
          const sent = await js(sentExpr);
          check('cold start → first message (先跳过 · the folder · Enter [· a model, when there is none]): sent from that folder into this tile', done && ready && sendable && taken <= (smokeProv ? 4 : 3) && !!sent && sent.lastSent && sent.inPane && sent.cwd === E.SMOKE_REPO, JSON.stringify({ done, ready, sendable, steps: taken, sent }));
          // the first message also ticks 发出第一个任务 in the 入门清单 (only a message sent from here does)
          check('入门清单: the message sent from here marks 发出第一个任务', await waitFor(`(window.__store.getState().settings['onboarding.checklist']?.done || []).includes('send')`, 5000));
          // leave its process (no login in this HOME) and come back to an empty start page for the checks below
          if (sent) await js(`window.__store.getState().closeSession(${JSON.stringify(sent.sid)})`).catch(() => {});
          // the provider goes again: the checks below expect the account on the chips
          if (smokeProv) { await srvReq({ kind: 'providers.remove', id: smokeProv.id }).catch(() => {}); await js('window.__store.getState().loadProviders()'); }
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
        check('home: 「还没接模型…[接一个模型] [用 Claude 账号登录]」 only when not logged in with no provider (nothing when fine)', wantNotice ? /还没接模型/.test(notice.text ?? '') && /接一个模型/.test(notice.text) && /用 Claude 账号登录/.test(notice.text) : notice.text === null || !/登录/.test(notice.text), JSON.stringify(notice));
      }
      // redesign phase 1: one pane, one tab, no workbench setting → no global top bar, no group bar, no tab strip, no panel rail
      if (E.SMOKE_READONLY !== '1') {
        const chrome = await js('({ wb: window.__store.getState().settings["ui.workbench"], topbar: !!document.querySelector(".topbar"), groupbar: !!document.querySelector(".groupbar"), strips: document.querySelectorAll(".tabstrip").length, rail: !!document.querySelector(".dock-rail"), iconRail: [...document.querySelectorAll(".rail .rail-main > [data-id], .rail .rail-main > .rail-anchor > [data-id]")].map((b) => b.dataset.id).join(" ") })');
        check('default chrome: no top bar / group bar / tab strip / row of panel icons; the icon rail is 对话 · 后台 · 自动化 · Bot · 网关 · 扩展 · 更多', chrome.wb === false && !chrome.topbar && !chrome.groupbar && !chrome.strips && !chrome.rail && chrome.iconRail === 'chat background automation bots gateway extensions more', JSON.stringify(chrome));
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
      // the other agents as sections of the same flat list (no sub-menu); 智能程度 / 深度编排 are NOT in here any more
      const mm = await js(`(() => { const m = document.querySelector('.menu.mm'); if (!m) return null; return { levels: [...m.querySelectorAll('[data-level]')].map((b) => b.textContent), ultra: !!m.querySelector('[data-id="ultracode"]'), agents: m.querySelectorAll('[data-sec^="agent:"]').length, nested: m.querySelectorAll('.menu').length, ids: ['add-provider', 'agents', 'manage', 'refresh'].filter((i) => !m.querySelector('[data-id="' + i + '"]')), words: /effort|ultracode|档案|引擎/i.test(m.innerText) }; })()`);
      check('model menu: only models — other agents flat, add / manage / refresh; no 智能程度, no 深度编排', mm && !mm.levels.length && !mm.ultra && mm.agents >= 1 && !mm.nested && !mm.ids.length, JSON.stringify(mm));
      check('model menu shows no implementation words (effort / ultracode / 档案 / 引擎)', mm && !mm.words);
      await key('Escape');
      await sleep(250);
      // structure round 2: 想多深 — its own chip, one row per level (name + what it costs), 深度编排 the last row
      await click('.welcome .cb .depth-chip');
      const em = await waitFor(`!!document.querySelector('.menu.depth-menu')`, 3000) && await js(`(() => { const m = document.querySelector('.menu.depth-menu'); return { levels: [...m.querySelectorAll('[data-id="effort"] [data-level] .cm-l')].map((b) => b.childNodes[0].textContent).join(''), descs: [...m.querySelectorAll('[data-level] .cm-d')].every((d) => d.textContent.length > 3), on: m.querySelector('[data-level][aria-checked="true"]')?.dataset.level, ultra: m.querySelector('[data-id="ultracode"]')?.getAttribute('aria-checked'), last: [...m.querySelectorAll('[data-mi]')].pop()?.dataset.id, words: /effort|ultracode|档案|引擎/i.test(m.innerText) }; })()`);
      check('effort chip: 快 · 均衡 · 深入 · 更深 · 极限 each with a line, the default lit, 深度编排 the last row and off; no implementation words', em && em.levels === '快均衡深入更深极限' && em.descs && em.on === 'high' && em.ultra === 'false' && em.last === 'ultracode' && !em.words, JSON.stringify(em));
      await shot('effort-menu');
      await click('.menu.depth-menu [data-level="low"]');
      const chipLow = await waitFor(`!document.querySelector('.menu.depth-menu') && document.querySelector('.welcome .cb .depth-chip')?.getAttribute('aria-label') === '智能程度：快'`, 2000);
      check('picking 快 closes the menu and the chip says 快', chipLow, await js(`document.querySelector('.welcome .cb .depth-chip')?.getAttribute('aria-label')`));
      await click('.welcome .cb .depth-chip');
      await click('.menu.depth-menu [data-id="ultracode"]');
      const chipUltra = await waitFor(`(() => { const c = document.querySelector('.welcome .cb .depth-chip'); return !!c && c.classList.contains('ultra') && c.getAttribute('aria-label') === '智能程度：深度编排'; })()`, 2000);
      await click('.welcome .cb .depth-chip');
      const ultraMenu = await js(`(() => { const m = document.querySelector('.menu.depth-menu'); return m ? { ultra: m.querySelector('[data-id="ultracode"]')?.getAttribute('aria-checked'), level: m.querySelector('[data-level][aria-checked="true"]')?.dataset.level ?? null } : null; })()`);
      check('深度编排 on: the chip says so (accent), and no level is the chosen one', chipUltra && ultraMenu && ultraMenu.ultra === 'true' && ultraMenu.level === null, JSON.stringify({ chipUltra, ultraMenu }));
      await click('.menu.depth-menu [data-level="high"]');
      const backHigh = await waitFor(`(() => { const c = document.querySelector('.welcome .cb .depth-chip'); return !!c && !c.classList.contains('ultra') && c.getAttribute('aria-label') === '智能程度：深入'; })()`, 2000);
      check('picking a level leaves 深度编排', backHigh, await js(`document.querySelector('.welcome .cb .depth-chip')?.getAttribute('aria-label')`));
      await sleep(200);
      // 子代理: its own chip next to the model's — the model menu locked to one provider, 「跟主模型一样」 on top
      phase = 'subagent-chip';
      const subChip = await js(`document.querySelector('.welcome .cb .sub-anchor > button.chip')?.getAttribute('aria-label') ?? null`);
      check('子代理 chip next to the model chip, nothing picked', subChip === '子代理：同主模型', subChip);
      // any provider's models are offered, whatever the conversation runs on (2026-10-18)
      const subProv = await srvReq({ kind: 'providers.upsert', provider: { name: 'Smoke 子代理', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'smoke-placeholder-not-a-key', models: ['smoke-sub-m'], defaultModel: 'smoke-sub-m' } }).catch(() => null);
      await js('window.__store.getState().loadProviders()');
      await sleep(300);
      await click('.welcome .cb .sub-anchor > button.chip');
      const otherListed = subProv && await waitFor(`!!document.querySelector('.menu.mm [data-sec="${subProv.id}"]')`, 3000);
      const mainProv = await js(`window.__store.getState().settings?.['ui.lastProvider'] ?? null`);
      check('子代理 menu lists another provider’s models', !!otherListed, JSON.stringify({ id: subProv?.id, mainProv, secs: await js(`[...document.querySelectorAll('.menu.mm [data-sec]')].map((e) => e.dataset.sec)`) }));
      await key('Escape');
      await sleep(250);
      if (subProv) { await srvReq({ kind: 'providers.remove', id: subProv.id }).catch(() => {}); await js('window.__store.getState().loadProviders()'); }
      await sleep(300);
      await click('.welcome .cb .sub-anchor > button.chip');
      const sm = await waitFor(`!!document.querySelector('.menu.mm [data-id="subagent-same"]')`, 3000) && await js(`(() => { const m = document.querySelector('.menu.mm'); return { label: m.getAttribute('aria-label'), same: m.querySelector('[data-id="subagent-same"]')?.classList.contains('cur'), def: !!m.querySelector('[data-id="subagent-default"] [role="switch"]'), agents: m.querySelectorAll('[data-sec^="agent:"]').length, heads: m.querySelectorAll('[data-sec="favorites"], [data-sec="recent"]').length, words: /effort|ultracode|档案|引擎/i.test(m.innerText) }; })()`);
      check('子代理 menu: 「跟主模型一样」 checked, the default switch, no other agents / favourites / recents, no implementation words', sm && sm.label === '子代理用的模型' && sm.same && sm.def && !sm.agents && !sm.heads && !sm.words, JSON.stringify(sm));
      await shot('subagent-menu');
      check('子代理 menu without error boundary', !(await noBoundary('body')), await noBoundary('body'));
      await key('Escape');
      await sleep(250);

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
      // 操控电脑 (our own `computer` MCP server): a switch where the machine the server runs on can do it (Windows),
      // a row that says why not elsewhere. engine.info says which
      await waitFor('!!window.__store.getState().engine', 20_000);
      const canComputer = await js('window.__store.getState().engine?.computerUse === true');
      const cuRow = `(() => { const r = document.querySelector('.menu.plus-menu [data-id="computerUse"]'); return r && { disabled: r.getAttribute('aria-disabled'), checked: r.getAttribute('aria-checked'), text: r.textContent, toggle: !!r.querySelector('.toggle'), stored: !!(window.__store.getState().settings['ui.featureDefaults'] || {}).computerUse }; })()`;
      const cuBefore = await js(cuRow);
      if (canComputer) {
        await click('.menu.plus-menu [data-id="computerUse"]');
        await waitFor(`document.querySelector('.menu.plus-menu [data-id="computerUse"]')?.getAttribute('aria-checked') === 'true'`, 2000);
        const cuOn = await js(cuRow);
        const cuTag = await waitFor('!!document.querySelector(\'.welcome .cap-tag[data-cap="computerUse"]\')', 2000);
        check('+ → 操控电脑 on this machine: a switch that says the user is asked first; on → a removable tag in the text box', !!cuBefore && cuBefore.disabled !== 'true' && cuBefore.toggle && cuBefore.checked === 'false' && /先问你/.test(cuBefore.text) && !cuBefore.text.includes('暂不可用') && cuOn.checked === 'true' && cuOn.stored && cuTag, JSON.stringify({ cuBefore, cuOn, cuTag }));
        await click('.menu.plus-menu [data-id="computerUse"]');
        await waitFor(`document.querySelector('.menu.plus-menu [data-id="computerUse"]')?.getAttribute('aria-checked') === 'false'`, 2000);
        const cuOff = await js(cuRow);
        check('… and off again: no tag, nothing left in the defaults', cuOff.checked === 'false' && !cuOff.stored && !(await js('!!document.querySelector(\'.welcome .cap-tag[data-cap="computerUse"]\')')), JSON.stringify(cuOff));
      } else {
        await js(`document.querySelector('.menu.plus-menu [data-id="computerUse"]').click()`);
        await sleep(150);
        const cuAfter = await js(cuRow);
        check('+ → 操控电脑 where this machine cannot do it: shown as 暂不可用 with the reason (and where the web is reached instead), no switch, a click changes nothing', !!cuBefore && cuBefore.disabled === 'true' && cuBefore.text.includes('暂不可用') && cuBefore.text.includes('Windows') && cuBefore.text.includes('浏览器') && !cuBefore.toggle && cuAfter.checked === 'false' && !cuAfter.stored, JSON.stringify({ cuBefore, cuAfter }));
      }
      await click('.menu.plus-menu [data-id="chrome"]');
      const on = await js(`document.querySelector('.menu.plus-menu [data-id="chrome"]').getAttribute('aria-checked')`);
      await key('Escape');
      const tag = await waitFor('!!document.querySelector(\'.welcome .cap-tag[data-cap="chrome"]\')', 2000);
      check('switching on 控制 Chrome shows a removable tag in the text box', on === 'true' && tag, JSON.stringify({ on, tag }));
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
        check('+ → Brief / 频道 in 2 clicks (rows under 进阶, no 「Brief、频道…」 expander); ↓ from Brief reaches the field; typing survives a click outside', rows.join() === 'files,folder,reference,slash,chatOnly,chrome,computerUse,goal,coordinator,proactive,brief,channels' && inField === 'channels' && saved && (await waitFor('!document.querySelector(".menu.plus-menu")', 2000)), JSON.stringify({ rows, inField, saved }));
        check('频道 shows as a removable tag', await waitFor('!!document.querySelector(\'.welcome .cap-tag[data-cap="channels"]\')', 2000));
        await click('.welcome .cap-tag[data-cap="channels"] button');
        await waitFor('!document.querySelector(\'.welcome .cap-tag[data-cap="channels"]\')', 2000);
        check('the capability defaults live in meta.json, not localStorage', await js('localStorage.getItem("cw.lastFeatures") === null && !!window.__store.getState().settings["ui.featureDefaults"]'));
        // ---- 只聊天 (spec 2026-10-16 pages §5): this new conversation only — a tag, the capability rows go, × undoes it
        await click('.welcome .cb .plus');
        await click('.menu.plus-menu [data-id="chatOnly"]');
        const chatOnlyOn = await js(`document.querySelector('.menu.plus-menu [data-id="chatOnly"]')?.getAttribute('aria-checked')`);
        const capsGone = await js(`!document.querySelector('.menu.plus-menu [data-id="chrome"]')`);
        await key('Escape');
        const chatTag = await waitFor(`!!document.querySelector('.welcome .cap-tag[data-cap="chatOnly"]')`, 2000);
        const notStored = await js(`!('chatOnly' in (window.__store.getState().settings['ui.featureDefaults'] || {}))`);
        await click('.welcome .cap-tag[data-cap="chatOnly"] button');
        const chatTagGone = await waitFor(`!document.querySelector('.welcome .cap-tag[data-cap="chatOnly"]')`, 2000);
        check('只聊天: + → 只聊天 hides the tool switches, shows a removable tag, is never a stored default', chatOnlyOn === 'true' && capsGone && chatTag && notStored && chatTagGone, JSON.stringify({ chatOnlyOn, capsGone, chatTag, notStored, chatTagGone }));
        // ---- menu digits: 1–9 pick the Nth row (the official app's)
        await click('.welcome .cb .plus');
        await waitFor('!!document.querySelector(".menu.plus-menu [data-mi]")', 2000);
        await js(`document.querySelector('.menu.plus-menu [data-mi]')?.focus()`);
        await key('5');
        const digit = await waitFor(`!!document.querySelector('.welcome .cap-tag[data-cap="chatOnly"]')`, 2000);
        if (digit) await click('.welcome .cap-tag[data-cap="chatOnly"] button');
        await key('Escape');
        check('menus: a digit picks that row (5 → 只聊天 in the + menu)', digit, JSON.stringify({ digit }));
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
      // 2026-09-30 user reports: settings → Agents gives every other agent 「新对话用」 (its own login, the providers it
      // can use, 添加供应商…); an IM bot has 「用哪个供应商」 (跟新对话一样 / the account / the providers)
      // 从其它工具导入: the dialog reads the other tools' settings (read-only), shows no key, and goes away on 取消
      phase = 'settings:import';
      await js(`window.__store.getState().openSettings({ section: 'providers' })`);
      await waitFor(`!!document.querySelector('.modal.settings [data-act="import"]')`, 8000);
      await js(`document.querySelector('.modal.settings [data-act="import"]')?.click()`);
      const impDone = await waitFor(`!!document.querySelector('.import-dialog .imp-list, .import-dialog .imp-empty')`, 15000);
      const imp = await js(`({ title: document.querySelector('.import-dialog h3')?.textContent, keys: /sk-[A-Za-z0-9]{6}/.test(document.querySelector('.import-dialog')?.textContent || ''), rows: document.querySelectorAll('.import-dialog .imp-row').length })`);
      check('settings · 供应商: 从其它工具导入 lists what other tools have, without a key in the page', impDone && imp.title === '从其它工具导入' && !imp.keys, JSON.stringify(imp));
      await js(`[...document.querySelectorAll('.import-dialog .qc-foot button')].find((b) => b.textContent === '取消')?.click()`);
      check('settings · 从其它工具导入: 取消 closes it', await waitFor(`!document.querySelector('.import-dialog')`, 3000));
      if (E.SMOKE_READONLY !== '1') {
        phase = 'settings:agent-provider';
        const tmpProv = await srvReq({ kind: 'providers.upsert', provider: { name: 'Smoke 中转', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'smoke-placeholder-not-a-key', models: ['smoke-m1'], defaultModel: 'smoke-m1' } }).catch(() => null);
        await js('window.__store.getState().loadProviders()');
        await js(`window.__store.getState().openSettings({ section: 'agents' })`);
        // a dropdown is the shared Select now: open it, read its rows, close it again
        const optsOf = async (sel) => {
          await click(sel);
          await waitFor(`!!document.querySelector('.menu.select-popover')`, 3000);
          const opts = await js(`[...document.querySelectorAll('.menu.select-popover .select-option')].map((b) => (b.querySelector('.select-option-label')?.textContent ?? b.textContent).trim())`);
          await key('Escape');
          await waitFor(`!document.querySelector('.menu.select-popover')`, 3000);
          return opts;
        };
        const apSel = '.modal.settings .agent-provider [data-provider-select]';
        await waitFor(`!!document.querySelector(${JSON.stringify(apSel)})`, 8000);
        const apOpts = await optsOf(apSel);
        check('settings · Agents: another agent picks the provider its new conversations use (自己的登录 · providers · 添加供应商…)', apOpts[0] === '自己的登录' && apOpts.some((t) => t.startsWith('Smoke 中转')) && apOpts.at(-1) === '添加供应商…', JSON.stringify(apOpts));
        await srvReq({ kind: 'im.set', id: 'smoke-dd', patch: { kind: 'dingtalk', name: 'Smoke 钉钉', enabled: false } }).catch(() => {});
        await js(`window.__store.getState().openSettings({ section: 'im' })`);
        const imSel = '.modal.settings [data-provider-select]';
        await waitFor(`!!document.querySelector(${JSON.stringify(imSel)})`, 8000);
        const imOpts = await optsOf(imSel);
        check('settings · IM 机器人: a bot picks its provider (跟新对话一样 · Claude 账号 · providers)', /^跟新对话一样/.test(imOpts[0] ?? '') && imOpts[1] === 'Claude 账号' && imOpts.some((t) => t.startsWith('Smoke 中转')), JSON.stringify(imOpts));
        await shot('settings-im-provider');
        await srvReq({ kind: 'im.set', id: 'smoke-dd', patch: null }).catch(() => {});
        // ego lite (2026-10-26): 联网 says which browser Agents act in, whether its ego-browser command was found, 重新检测
        await js(`window.__store.getState().openSettings({ section: 'web' })`);
        const egoRow = await waitFor(`!!document.querySelector('.modal.settings [data-id="web-agent-browser"]') && !!document.querySelector('.modal.settings [data-id="web-ego-detect"]')`, 8000);
        const egoHint = await js(`document.querySelector('.modal.settings [data-id="web-agents"]')?.textContent ?? ''`);
        check('settings · 联网: 「Agent 用哪个浏览器操作网页」 with 重新检测, saying whether ego lite was found', egoRow && /没找到 ego lite|找到了 ego lite/.test(egoHint), egoHint.slice(0, 200));
        await click('.modal.settings [data-id="web-ego-detect"]');
        await sleep(800);
        await js(`window.__store.getState().setSetting('web.browser.agent', 'builtin')`);
        const egoSt = await srvReq({ kind: 'web.status' }).catch(() => null);
        check('… 内置浏览器 picked: the server says so', egoSt?.agentBrowser === 'builtin' && typeof egoSt?.ego?.found === 'boolean', JSON.stringify(egoSt && { agentBrowser: egoSt.agentBrowser, ego: egoSt.ego }));
        await js(`window.__store.getState().setSetting('web.browser.agent', undefined)`);
        if (tmpProv) await srvReq({ kind: 'providers.remove', id: tmpProv.id }).catch(() => {});
        await js('window.__store.getState().loadProviders()');

        // A7 (2026-10-24): 账号与登录 → Claude 账号「编辑」 — Opus / Sonnet / Fable at 200K or 1M (1M unless picked), Haiku
        // fixed, 自动压缩 that refuses under 50K; nothing is saved on 取消. A provider's edit page has 自动压缩 too
        phase = 'a7';
        {
          await js(`window.__store.getState().openSettings({ section: 'account' })`);
          const edit = await waitFor(`!!document.querySelector('.modal.settings [data-act="account-windows-edit"]')`, 8000);
          if (edit) await click('.modal.settings [data-act="account-windows-edit"]');
          const dlgSel = '[data-act="account-windows-dialog"]';
          const opened = await waitFor(`!!document.querySelector('${dlgSel} [data-act="compact-at"]')`, 3000);
          const aw = await js(`(() => { const d = document.querySelector('${dlgSel}'); if (!d) return null; return { title: d.querySelector('h3')?.textContent ?? null, rows: [...d.querySelectorAll('.aw-row')].map((r) => ({ f: r.dataset.family, sizes: [...r.querySelectorAll('[data-size]')].map((b) => b.textContent).join('/'), on: r.querySelector('[data-size][aria-checked="true"]')?.dataset.size ?? null })), compact: d.querySelector('[data-act="compact-at"] .compact-at-h')?.textContent ?? null, mode: d.querySelector('[data-act="compact-at"]')?.dataset.mode ?? null }; })()`);
          const picks = aw ? aw.rows.filter((r) => r.sizes) : [];
          check('A7 · 账号与登录 → Claude 账号「编辑」: Opus / Sonnet / Fable at 200K · 1M (1M picked), Haiku fixed, 自动压缩 following the window', edit && opened && !!aw && aw.title === 'Claude 账号的上下文窗口' && picks.map((r) => r.f).join(',') === 'opus,sonnet,fable' && picks.every((r) => r.sizes === '200K/1M' && r.on === '1000000') && aw.rows.some((r) => r.f === 'haiku' && !r.sizes) && aw.compact === '自动压缩' && aw.mode === 'follow', JSON.stringify(aw));
          await click(`${dlgSel} [data-act="compact-at"] [data-mode="at"]`);
          const box = await waitFor(`!!document.querySelector('${dlgSel} [data-act="compact-at-input"]')`, 2000);
          if (box) { await click(`${dlgSel} [data-act="compact-at-input"]`); wc.selectAll(); wc.insertText('30'); }
          const err = box && await waitFor(`/50K/.test(document.querySelector('${dlgSel} .compact-at-err')?.textContent ?? '')`, 2000);
          await shot('a7-account-windows');
          await js(`(() => { const b = [...document.querySelectorAll('${dlgSel} .row-btns button')].find((x) => x.textContent === '取消'); if (b) b.dataset.smokePick = 'a7cancel'; })()`);
          await click(`${dlgSel} [data-smoke-pick="a7cancel"]`);
          const closed = await waitFor(`!document.querySelector('${dlgSel}')`, 2000);
          const kept = await js(`(() => { const s = window.__store.getState().settings; return s['claude.compactAt'] === undefined && s['claude.contextWindows'] === undefined; })()`);
          check('A7 · … 在这个大小时压缩 + 「30」 says 最少 50K; 取消 closes it and saves nothing', !!box && !!err && closed && kept, JSON.stringify({ box, err: await js(`document.querySelector('.compact-at-err')?.textContent ?? null`), closed, kept }));
          if (!closed) await js(`document.querySelector('${dlgSel}')?.closest('.modal-bg')?.remove()`);
          // final review M5: the dialog takes the focus; Esc closes the dialog only (it used to close the whole settings
          // window: the focus stayed on 编辑), and the focus goes back to 编辑
          await click('.modal.settings [data-act="account-windows-edit"]');
          const focusIn = await waitFor(`!!document.activeElement?.closest('${dlgSel}')`, 2000);
          await key('Escape');
          const escClosed = await waitFor(`!document.querySelector('${dlgSel}')`, 2000);
          const escState = await js(`({ settings: !!document.querySelector('.modal.settings'), back: document.activeElement?.dataset?.act ?? document.activeElement?.tagName ?? null })`);
          check('A7 · … the dialog takes the focus; Esc closes only it and the focus is back on 编辑', !!focusIn && escClosed && escState.settings && escState.back === 'account-windows-edit', JSON.stringify({ focusIn, escClosed, ...escState }));
          if (!escClosed) await js(`document.querySelector('${dlgSel}')?.closest('.modal-bg')?.remove()`);
          if (!escState.settings) await js(`window.__store.getState().openSettings({ section: 'account' })`);
          // a provider's edit page
          const a7Prov = await srvReq({ kind: 'providers.upsert', provider: { name: 'Smoke A7 中转', type: 'anthropic', baseUrl: 'http://127.0.0.1:9', apiKey: 'smoke-placeholder-not-a-key', models: ['claude-sonnet-4-6'], defaultModel: 'claude-sonnet-4-6' } }).catch(() => null);
          await js('window.__store.getState().loadProviders()');
          await js(`window.__store.getState().openSettings({ section: 'providers' })`);
          const row = await waitFor(`(() => { const r = [...document.querySelectorAll('.modal.settings .row')].find((x) => x.textContent.includes('Smoke A7 中转')); const b = r && [...r.querySelectorAll('button')].find((x) => x.textContent === '编辑'); if (b) b.dataset.smokePick = 'a7edit'; return !!b; })()`, 8000);
          if (row) await click('.modal.settings [data-smoke-pick="a7edit"]');
          const provCompact = await waitFor(`document.querySelector('.modal.settings [data-act="compact-at"] .compact-at-h')?.textContent === '自动压缩'`, 3000);
          const provMode = await js(`document.querySelector('.modal.settings [data-act="compact-at"]')?.dataset.mode ?? null`);
          check('A7 · a provider’s edit page has 自动压缩 (跟着上下文窗口 when unset)', !!a7Prov && row && provCompact && provMode === 'follow', JSON.stringify({ prov: !!a7Prov, row, provCompact, provMode }));
          await shot('a7-provider-compact');
          await js(`(() => { const b = [...document.querySelectorAll('.modal.settings .section button')].find((x) => x.textContent === '取消' && x.closest('.section')?.querySelector('[data-act="compact-at"]')); b?.click(); })()`);
          if (a7Prov) await srvReq({ kind: 'providers.remove', id: a7Prov.id }).catch(() => {});
          await js('window.__store.getState().loadProviders()');
        }
        phase = 'settings';

        // 在外面也能用 (remote-anywhere task 13): the switch (disabled until remote access is on) and its status line, the
        // QR for anywhere with the LAN switch and 「复制配对链接」, keep-awake (the browser build: only the sentence), a
        // phone paired from this machine shows no 127.0.0.1, no MQTT / WebRTC / STUN / ICE in what the page shows by
        // default, and 更多选项 lists the brokers and refuses a bad one. The one broker is a closed local port: the smoke
        // never reaches a public broker (CW_NO_PUBLIC_BROKERS leaves the defaults out as well)
        phase = 'settings:anywhere';
        const remotePort = await new Promise((res, rej) => { const s = require('node:net').createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
        await js(`window.__store.getState().setSetting('remote.anywhere.brokers', [{ name: 'smoke', url: 'wss://127.0.0.1:9/mqtt', relay: true }])`);
        await srvReq({ kind: 'remote.set', port: remotePort });
        await js(`window.__store.getState().openSettings({ section: 'remote' })`);
        const RS = '.modal.settings [data-body="remote"]';
        const awOff = await waitFor(`(() => { const t = document.querySelector('${RS} [data-id="anywhere"]'); return !!t && t.disabled && /允许其它设备访问/.test(document.querySelector('${RS} [data-id="anywhere-note"]')?.textContent ?? ''); })()`, 8000);
        check('手机与其它电脑: 「在外面也能用」 is there; with remote access off it is disabled and says to turn that on first', awOff, await js(`document.querySelector('${RS}')?.innerText.slice(0, 400)`));
        await click(`${RS} [data-id="remote-enabled"]`);
        const awFailing = await waitFor(`(document.querySelector('${RS} [data-id="anywhere-status"]')?.textContent ?? '').includes('连不上牵线服务器，检查网络') && !document.querySelector('${RS} [data-id="anywhere"]').disabled`, 15_000);
        check('remote access on, its only broker unreachable: the status line says 连不上牵线服务器，检查网络', awFailing, await js(`document.querySelector('${RS} [data-id="anywhere-status"]')?.textContent ?? 'no status line'`));
        const keep = await js(`({ note: document.querySelector('${RS} [data-id="keep-awake-note"]')?.textContent ?? '', toggle: !!document.querySelector('${RS} [data-id="keep-awake"]') })`);
        check('不让电脑睡眠 in the browser build: the sentence, no switch', keep.note.includes('网页版做不到，去系统电源设置里关掉睡眠') && !keep.toggle, JSON.stringify(keep));
        await click(`${RS} [data-id="pair-new"]`);
        const qrAnywhere = await waitFor(`!!document.querySelector('${RS} img.pair-qr[data-kind="anywhere"]') && document.querySelectorAll('${RS} [data-id="pair-switch"] button').length === 2 && !!document.querySelector('${RS} [data-id="pair-copy"]')`, 10_000);
        const switchText = await js(`[...document.querySelectorAll('${RS} [data-id="pair-switch"] button')].map((b) => b.textContent.trim())`);
        check('a pairing code: the QR is the 在哪都能用 one, with the switch (在哪都能用 / 只在局域网（不用联网）) and 复制配对链接', qrAnywhere && JSON.stringify(switchText) === JSON.stringify(['在哪都能用', '只在局域网（不用联网）']), JSON.stringify({ qrAnywhere, switchText }));
        await shot('settings-remote-anywhere');
        await js(`(() => { window.__cwCopied = null; Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (t) => { window.__cwCopied = t; } }); })()`);
        await click(`${RS} [data-id="pair-copy"]`);
        // the phone page's address as the server reports it (DEFAULT_SHELL_URL lives in one place only)
        const shellUrl = (await srvReq({ kind: 'remote.status' }))?.anywhere?.shellUrl ?? '';
        const linkRe = `^${shellUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}#p=[A-Za-z0-9_-]+$`;
        const copied = !!shellUrl && await waitFor(`new RegExp(${JSON.stringify(linkRe)}).test(window.__cwCopied ?? '') && [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('配对链接已复制')) && !location.href.includes('#p=')`, 3000);
        check('复制配对链接 copies the 在哪都能用 link (never into the page address) and says so', copied, `${shellUrl} · ${await js('String(window.__cwCopied).slice(0, 60)')}`);
        // this PC is not on the default lists: the link names its broker list for the phone to dial (F2)
        let named = null;
        try { named = JSON.parse(Buffer.from(String(await js('window.__cwCopied')).split('#p=')[1], 'base64url').toString('utf8')); } catch { /* checked below */ }
        check('… and the link carries this PC\'s own broker list (it is not the default one)', named?.v === 1 && JSON.stringify(named?.b) === JSON.stringify([{ name: 'smoke', url: 'wss://127.0.0.1:9/mqtt', relay: true }]), JSON.stringify(named));
        await click(`${RS} [data-id="pair-switch"] [data-kind="lan"]`);
        const qrLan = await waitFor(`!!document.querySelector('${RS} img.pair-qr[data-kind="lan"]') && !document.querySelector('${RS} [data-id="pair-copy"]')`, 3000);
        check('只在局域网（不用联网）: the LAN QR, no 复制配对链接', qrLan);
        await click(`${RS} [data-id="pair-switch"] [data-kind="anywhere"]`);
        // a phone paired over the listener on this machine (as the bridge does): its row shows no 127.0.0.1
        const lanPair = await srvReq({ kind: 'remote.pairCode' });
        const paired = await new Promise((res) => {
          const body = JSON.stringify({ code: lanPair.code, name: 'smoke 手机' });
          const rq = require('node:http').request({ host: '127.0.0.1', port: remotePort, method: 'POST', path: '/api/pair', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => { let t = ''; r.on('data', (c) => (t += c)); r.on('end', () => { try { res(JSON.parse(t)); } catch { res(null); } }); });
          rq.on('error', () => res(null));
          rq.end(body);
        });
        const devRow = paired?.device?.id ? `${RS} [data-device="${paired.device.id}"]` : '';
        const noFakeIp = !!devRow && (await waitFor(`!!document.querySelector('${devRow}')`, 5000)) && !(await js(`document.querySelector('${devRow}').textContent`)).includes('127.0.0.1');
        check('a phone paired through this machine (the way the bridge does): its row shows no 127.0.0.1', noFakeIp, devRow ? await js(`document.querySelector('${devRow}')?.textContent ?? 'no row'`) : JSON.stringify(paired));
        // what the page shows by default (更多选项 still closed) has none of the network words
        await js(`window.__store.getState().openSettings({ section: 'general' })`);
        await waitFor(onPage('general'), 3000);
        await js(`window.__store.getState().openSettings({ section: 'remote' })`);
        await waitFor(`${onPage('remote')} && !!document.querySelector('${RS} [data-id="anywhere-status"]')`, 8000);
        const shownText = await js(`document.querySelector('.modal.settings .sp-inner').innerText`);
        const netWords = shownText.match(/MQTT|WebRTC|STUN|\bICE\b/gi) ?? [];
        check('手机与其它电脑 by default: no MQTT / WebRTC / STUN / ICE on screen', !netWords.length && !(await js(`!!document.querySelector('.modal.settings .sp-more-body:not([hidden])')`)), JSON.stringify(netWords));
        await click('.modal.settings .sp-more-h');
        const brokers = await waitFor(`(() => { const l = document.querySelector('.modal.settings [data-id="anywhere-brokers"]'); if (!l) return false; const rows = [...l.querySelectorAll('.aw-row')]; return rows.length === 1 && rows[0].querySelector('input[data-f="name"]')?.value === 'smoke' && /不通/.test(rows[0].textContent) && rows[0].querySelector('[data-f="relay"]')?.getAttribute('aria-checked') === 'true'; })()`, 8000);
        const moreParts = await js(`['anywhere-stun', 'anywhere-shell', 'anywhere-recent'].filter((id) => !document.querySelector('.modal.settings [data-id="' + id + '"]'))`);
        check('更多选项: the broker list (名称 · 地址 · 通 / 不通 · 用于转发), STUN, the phone page address, recent connections', brokers && !moreParts.length, JSON.stringify({ brokers, missing: moreParts }));
        await click('.modal.settings [data-id="broker-add"]');
        await click('.modal.settings [data-id="anywhere-brokers"] .aw-row:last-child input[data-f="name"]');
        wc.insertText('bad');
        await click('.modal.settings [data-id="anywhere-brokers"] .aw-row:last-child input[data-f="url"]');
        wc.insertText('http://bad.example/mqtt');
        await click('.modal.settings [data-id="broker-save"]');
        const refused = await waitFor(`/wss:\\/\\//.test(document.querySelector('.modal.settings [data-id="broker-error"]')?.textContent ?? '') && (window.__store.getState().settings['remote.anywhere.brokers'] ?? []).length === 1`, 3000);
        check('更多选项: a broker address that is not wss:// is refused with a sentence, nothing saved', refused, await js(`document.querySelector('.modal.settings [data-id="broker-error"]')?.textContent ?? 'no sentence'`));
        await shot('settings-remote-anywhere-more');
        // the broker list changes (here: as another window would save it): the PC listens anew, the pairing room of the
        // code on screen is gone, so its QR goes too (F2)
        await click(`${RS} [data-id="pair-new"]`);
        const qrBefore = await waitFor(`!!document.querySelector('${RS} img.pair-qr')`, 10_000);
        await js(`window.__store.getState().setSetting('remote.anywhere.brokers', [{ name: 'smoke2', url: 'wss://127.0.0.1:9/mqtt', relay: true }])`);
        const qrGone = await waitFor(`!document.querySelector('${RS} img.pair-qr') && !document.querySelector('${RS} [data-id="pair-copy"]')`, 5000);
        check('a changed broker list clears the QR and the pairing link on screen (they were for the old pairing room)', qrBefore && qrGone, JSON.stringify({ qrBefore, qrGone }));
        await js(`window.__store.getState().setSetting('remote.anywhere.brokers', [{ name: 'smoke', url: 'wss://127.0.0.1:9/mqtt', relay: true }])`);
        if (paired?.device?.id) await srvReq({ kind: 'remote.devices.revoke', id: paired.device.id }).catch(() => {});
        await srvReq({ kind: 'remote.set', enabled: false }).catch(() => {});
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
      check('ui-smoke click helper: a click the page moved off its target is swallowed (nothing under it toggled) and made again (polish P5)', // (fix V4: one more retry is timing — the modal still settling when attempt 2 measures — not a weaker proof: the
      // first click must still be swallowed on a real element, every miss counted, nothing toggled, a later one land)
      guardOpened && !!shifted && (shifted.attempts === 2 || shifted.attempts === 3) && shifted.misses.length === shifted.attempts - 1 && shifted.misses[0] !== 'nothing' && valuesBefore === valuesAfter, JSON.stringify({ guardOpened, attempts: shifted && shifted.attempts, misses: shifted && shifted.misses, valuesBefore, valuesAfter }));
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
        for (const [chip, menu] of [['.welcome .dirpick', '.menu.dirmenu'], ['.welcome .mm-anchor > button.chip', '.menu.mm'], ['.welcome .sub-anchor > button.chip', '.menu.mm']]) {
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
        // 更新内容 (spec 2026-10-16 pages §4): from the palette, the changelog in the interface language
        await ctrl('K');
        await waitFor('!!document.querySelector(".palette-bg input")', 3000);
        wc.insertText('更新内容');
        await sleep(300);
        await key('Enter');
        const wn = await waitFor('!!document.querySelector(".modal.whats-new .wn-body h2")', 5000);
        const wnText = await js(`document.querySelector('.modal.whats-new .wn-body h2')?.textContent ?? ''`);
        await key('Escape');
        const wnGone = await waitFor('!document.querySelector(".modal.whats-new")', 2000);
        check('更新内容: the palette opens the changelog (a version heading), Esc closes it', wn && /\d+\.\d+\.\d+/.test(wnText) && wnGone, JSON.stringify({ wn, wnText, wnGone }));
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
        // Ctrl+/ (the official key) opens it too
        wc.sendInputEvent({ type: 'keyDown', keyCode: '/', modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: '/', modifiers: ['control'] });
        const slashSheet = await waitFor('!!document.querySelector(".shortcuts-bg")', 2000);
        await key('Escape');
        check('Ctrl+/ opens the shortcut sheet', slashSheet && (await waitFor('!document.querySelector(".shortcuts-bg")', 2000)), JSON.stringify({ slashSheet }));
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
        const shown = await waitFor(`(document.querySelector('.dock .dock-tabs .tab.active .t') ?? document.querySelector('.dock .dock-foldhead .t'))?.textContent === ${JSON.stringify(p.title)}`, 5000);
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
        // the panel fades for 150 ms before its column goes (longer when the window is busy)
        const kept = await waitFor('!!document.querySelector(".dock .xterm") && document.querySelector(".rpanel").offsetWidth === 0', 3000);
        check('hiding the right panel keeps the terminal mounted', term && kept, JSON.stringify({ term, kept }));
      }

      // ---- a seeded session in a pane (chat tile, session header, git badges)
      if (E.SMOKE_SID) {
        // re-review M-5: a conversation picked in the command palette over the settings page — the page closes and
        // the conversation is what shows (it used to open underneath, unseen)
        phase = 'settings:palette-pick';
        const ctrlKey = async (k) => { wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: ['control'] }); await sleep(300); };
        await ctrlKey(',');
        await waitFor('!!document.querySelector(".modal.settings.sp")', 3000);
        await ctrlKey('K');
        await waitFor('!!document.querySelector(".palette-bg")', 3000);
        wc.insertText('seeded session');
        const palRow = await waitFor(`(() => { const r = [...document.querySelectorAll('.cmdk .it')].find((x) => /seeded session/.test(x.querySelector('.t')?.textContent ?? '')); if (r) r.dataset.smokePick = '1'; return !!r; })()`, 8000);
        if (palRow) await click('.cmdk .it[data-smoke-pick="1"]');
        const picked = await waitFor(`!document.querySelector('.modal.settings.sp') && !document.querySelector('.palette-bg') && window.__store.getState().activeId === ${JSON.stringify(E.SMOKE_SID)} && !!document.querySelector('.pane.focused .composer textarea') && !document.querySelector('.pane.focused .welcome')`, 10_000);
        check('a conversation picked in the command palette over the settings page: the page closes and the conversation shows (re-review M-5)', palRow && picked, JSON.stringify({ palRow, picked, settings: await js('!!document.querySelector(".modal.settings.sp")'), active: await js('window.__store.getState().activeId') }));
        if (!picked) { await js('window.__store.setState({ settingsOpen: null, paletteOpen: false })'); await sleep(300); }
        phase = 'session';
        await js(`window.__store.getState().loadHistory(${JSON.stringify(E.SMOKE_SID)})`);
        check('seeded session renders', await waitFor('!!document.querySelector(".composer textarea") && !document.querySelector(".welcome")', 10_000));
        await sleep(1500);
        const err = await noBoundary('body');
        check('session tile without error boundary', !err, err);
        await shot('session');

        // ---- chat & input (spec 2026-10-16 chat-input): Ctrl+O view mode, 旁聊 from /btw and Ctrl+;, @ file completion
        phase = 'chat-input';
        {
          const ctrlKey = async (k) => { wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: ['control'] }); await sleep(300); };
          const vm = () => js("window.__store.getState().settings['ui.viewMode'] ?? 'normal'");
          const before = await vm();
          await js('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
          await ctrlKey('O');
          const v1 = await vm();
          await ctrlKey('O');
          const v2 = await vm();
          await ctrlKey('O');
          const v3 = await vm();
          check('Ctrl+O steps the view mode 普通 → 显示思考 → 详细 → 普通, and the conversation still renders', before === 'normal' && v1 === 'thinking' && v2 === 'verbose' && v3 === 'normal' && !(await noBoundary('.pane.focused')), JSON.stringify({ before, v1, v2, v3 }));
          if (E.SMOKE_READONLY !== '1') {
            await click('.pane.focused .composer textarea');
            wc.insertText('/btw');
            await sleep(300);
            await key('Enter');
            const opened = await waitFor('!!document.querySelector(".pane.focused .side-chat") && document.activeElement === document.querySelector(".side-chat .sc-input textarea")', 4000);
            const boxEmpty = await js('document.querySelector(".pane.focused .composer textarea").value === ""');
            await key('Escape');
            const closed = await waitFor('!document.querySelector(".side-chat")', 3000);
            check('/btw opens the side chat card over the input box (focus in its own line, the box cleared); Esc closes it', opened && boxEmpty && closed, JSON.stringify({ opened, boxEmpty, closed }));
            await ctrlKey(';');
            const viaKey = await waitFor('!!document.querySelector(".pane.focused .side-chat")', 3000);
            await js('document.querySelector(".side-chat .icon-btn[aria-label]")?.click()');
            const viaKeyClosed = await waitFor('!document.querySelector(".side-chat")', 3000);
            check('Ctrl+; opens the side chat too; its × closes it', viaKey && viaKeyClosed, JSON.stringify({ viaKey, viaKeyClosed }));
            await click('.pane.focused .composer textarea');
            wc.insertText('@');
            const atList = await waitFor('document.querySelectorAll(".pane.focused .palette.at-files .it").length > 0', 5000);
            const atCount = await js('document.querySelectorAll(".pane.focused .palette.at-files .it").length');
            await key('Tab');
            const picked = await js('document.querySelector(".pane.focused .composer textarea").value');
            check('@ lists the project\'s files over the input box; Tab writes the first as @path', atList && /^@\S+ $/.test(picked), JSON.stringify({ atList, atCount, picked }));
            wc.selectAll(); wc.delete(); await sleep(200);
            await js(`window.__store.getState().saveDraft(${JSON.stringify(E.SMOKE_SID)}, '')`);

            // the menu over selected text (SelectionMenu.tsx, 2026-10-20): select the seeded reply's text, release the
            // mouse — the menu is there with 复制 / 复制整条消息 / 引用到输入框; 引用到输入框 puts `> ok` in the box
            phase = 'selection-menu';
            await js('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
            const selected = await js(`(() => {
              const t = document.querySelector('.pane.focused .chat-inner .assistant-wrap .msg-text');
              const chat = t && t.closest('.chat');
              const w = t && document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
              const n = w && w.nextNode();
              if (!n) return false;
              chat.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
              const r = document.createRange(); r.selectNodeContents(n);
              const s = getSelection(); s.removeAllRanges(); s.addRange(r);
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
              return s.toString();
            })()`);
            const menuUp = await waitFor(`!!document.querySelector('.menu.sel-menu [data-act="copy"]') && !!document.querySelector('.menu.sel-menu [data-act="quote"]') && document.querySelector('.menu.sel-menu').style.visibility !== 'hidden'`, 3000);
            const rows = await js(`[...document.querySelectorAll('.menu.sel-menu [data-act]')].map((b) => b.dataset.act).join(',')`);
            if (menuUp) await js(`document.querySelector('.menu.sel-menu [data-act="quote"]').click()`);
            const quoted = await waitFor(`!document.querySelector('.menu.sel-menu') && /^> ok\\n/.test(document.querySelector('.pane.focused .composer textarea').value)`, 3000);
            check('selecting text in a reply brings up the selection menu (复制 · 复制整条消息 · 引用到输入框 …); 引用到输入框 quotes it into the input box', selected === 'ok' && menuUp && /copy,copyMsg,copyMd,quote/.test(rows) && quoted, JSON.stringify({ selected, menuUp, rows, box: await js(`document.querySelector('.pane.focused .composer textarea')?.value`) }));
            await click('.pane.focused .composer textarea');
            wc.selectAll(); wc.delete(); await sleep(200);
            await js(`window.__store.getState().saveDraft(${JSON.stringify(E.SMOKE_SID)}, '')`);
          }
        }

        // final review §9 #1: a conversation that is not running (every one after a restart) still shows its model and
        // permission chips with 「发送后继续」; a pick there is what the send resumes with. Nothing picked (re-review I-1 /
        // M-2): the chips show what the resume really gets — the default model by name, 每步询问 — and the transcript's
        // model is only the tooltip's 「上次回答用的是 …」
        {
          phase = 'session-resume-chips';
          const sidR = JSON.stringify(E.SMOKE_SID);
          const bar = '.pane.focused .composer';
          const look = () => js(`(() => { const b = document.querySelector('${bar}'); if (!b) return null; const c = b.querySelector('.mm-anchor > button.chip'); return { state: window.__store.getState().open[${sidR}]?.state, model: c?.textContent ?? null, title: c?.title ?? null, perm: b.querySelector('.perm-chip')?.textContent ?? null, status: b.querySelector('.cb-status')?.textContent ?? null, resume: window.__store.getState().open[${sidR}]?.resume ?? null }; })()`);
          const r0 = await look();
          check('a conversation not running shows the default it will resume on (not the transcript\'s claude-smoke, which is in the tooltip) and 每步询问, with 「发送后继续」', !!r0 && r0.state === 'history' && !!r0.model && !/claude-smoke|默认模型/.test(r0.model) && /（默认）/.test(r0.title ?? '') && /上次回答用的是 claude-smoke/.test(r0.title ?? '') && /每步询问/.test(r0.perm ?? '') && r0.status === '发送后继续', JSON.stringify(r0));
          await click(`${bar} .perm-chip`);
          await waitFor(`!!document.querySelector('.menu.perm-menu [data-mode="plan"]')`, 3000);
          await click('.menu.perm-menu [data-mode="plan"]');
          await sleep(200);
          const r1 = await look();
          await click(`${bar} .mm-anchor > button.chip`);
          const rowSel = `.menu.mm [data-sec="builtin"] .mm-row:not(.cur):not(.off):not(.mm-more)`;
          await waitFor(`[...document.querySelectorAll('${rowSel}')].length > 1`, 5000);
          const picked = await js(`(() => { const rows = [...document.querySelectorAll('${rowSel}')]; const r = rows[rows.length - 1]; r.scrollIntoView({ block: 'nearest' }); r.dataset.smokePick = '1'; return r.textContent; })()`);
          await click('.menu.mm [data-smoke-pick="1"]');
          await sleep(300);
          const r2 = await look();
          const menuClosed = await js(`!document.querySelector('.menu.mm')`);
          if (!menuClosed) await key('Escape');
          check('picking 只做计划 and another model there changes the chips and what the send resumes with — nothing is sent, it stays not running', !!r1 && /只做计划/.test(r1.perm ?? '') && r1.resume?.permissionMode === 'plan' && !!r2 && r2.state === 'history' && !!r2.resume?.model && r2.resume.model !== 'claude-smoke' && !/claude-smoke/.test(r2.model ?? '') && r2.status === '发送后继续', JSON.stringify({ r1, picked, r2 }));
          await js(`window.__store.setState((s) => { const o = s.open[${sidR}]; if (!o) return {}; const { resume, ...rest } = o; return { open: { ...s.open, [${sidR}]: { ...rest, version: o.version + 1 } } }; })`);
        }

        // ---- redesign phase 3: the stats bar is behind the context ring; + says the capabilities apply to new conversations
        phase = 'session-composer';
        check('no stats bar under the composer', !(await js('!!document.querySelector(".pane .composer .statusbar")')));
        const sidJs = JSON.stringify(E.SMOKE_SID);
        // no ring without an occupancy; below 60 % a quiet ring without the number (2026-10-15: users asked why some
        // conversations had a ring and others none) — and the numbers of the old stats bar are one menu away: ··· 本对话用量
        const setCu = (cu) => js(`(() => { const st = window.__store; const o = st.getState().open[${sidJs}]; st.setState({ open: { ...st.getState().open, [${sidJs}]: { ...o, conv: { ...o.conv, contextUsage: ${JSON.stringify(cu)} }, version: o.version + 1 } } }); })()`);
        await setCu({ percentage: 40, totalTokens: 80_000, maxTokens: 200_000 });
        await sleep(200);
        const quiet40 = await js(`(() => { const m = document.querySelector('.pane .composer .ctx-meter'); return m ? { cls: m.className, pct: !!m.querySelector('.pct') } : null; })()`);
        await click('.pane.focused .sess-head .sh-more > button');
        await waitFor(`!!document.querySelector('.menu.sess-menu [data-act="usage"]')`, 3000);
        await click('.menu.sess-menu [data-act="usage"]');
        await waitFor(`!!document.querySelector('.ctx-card')`, 3000);
        const usageCard = await js(`(() => { const c = document.querySelector('.ctx-card'); if (!c) return null; const r = c.getBoundingClientRect(); const m = document.querySelector('.pane.focused .composer .ctx-meter')?.getBoundingClientRect(); return { text: c.innerText, above: !!m && r.bottom <= m.top + 1, byRing: !!m && Math.abs(r.right - m.right) < 2 }; })()`);
        await key('Escape');
        const cardGone = await waitFor(`!document.querySelector('.ctx-card')`, 2000);
        check('40 %: a quiet ring without the number; ··· 本对话用量 opens the old stats (轮数 / 输入 / 上下文) above the composer at the ring, Esc closes it', !!quiet40 && /quiet/.test(quiet40.cls) && !quiet40.pct && !!usageCard && /轮数/.test(usageCard.text) && /输入/.test(usageCard.text) && /40%/.test(usageCard.text) && usageCard.above && usageCard.byRing && cardGone, JSON.stringify({ quiet40, usageCard, cardGone }));
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
        // a second click unpins: once the pointer is away the card is gone (verification 2026-10-16 caught it staying)
        const [rx, ry] = await js(`(() => { const r = document.querySelector('.pane .composer .ctx-meter').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()`);
        wc.sendInputEvent({ type: 'mouseMove', x: Math.max(5, rx - 300), y: Math.max(5, ry - 200) });
        const unpinned = await waitFor(`!document.querySelector('.ctx-card')`, 1500);
        check('a second click on the context ring closes its card', unpinned);
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

        // ---- phase 6 (the official app's recording): info column, header tools, the line under the box, the menus
        phase = 'recording-ux';
        {
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
          win.setSize(1440, 900);
          await sleep(700);
          const info = await js(`(() => { const p = document.querySelector('.pane.focused'); const c = p?.querySelector('.info-col'); const m = p?.querySelector('.chat-main'); if (!c) return { col: false, w: Math.round(p?.getBoundingClientRect().width ?? 0) }; return { col: true, cards: [...c.querySelectorAll('.info-card')].map((x) => x.dataset.card), width: Math.round(c.getBoundingClientRect().width), beside: Math.round(c.getBoundingClientRect().left) >= Math.round(m.getBoundingClientRect().right) - 1, on: p.querySelector('.sess-head button[aria-label="对话信息"]')?.getAttribute('aria-pressed') }; })()`);
          check('信息栏: a column beside the conversation with 环境 / 上下文 / 连接器 / 改动 / 后台任务, the header ⓘ pressed', info.col && JSON.stringify(info.cards) === JSON.stringify(['env', 'context', 'connectors', 'changes', 'background']) && info.width >= 280 && info.width <= 296 && info.beside && info.on === 'true', JSON.stringify(info));
          await click('.pane.focused .info-card[data-card="context"] .ic-title');
          await sleep(300);
          const unfolded = await js(`(() => { const c = document.querySelector('.pane.focused .info-card[data-card="context"]'); return { open: c?.querySelector('.ic-title')?.getAttribute('aria-expanded'), body: !!c?.querySelector('.ic-body'), stored: JSON.stringify(window.__store.getState().settings['ui.infoCards'] ?? null) }; })()`);
          await click('.pane.focused .info-card[data-card="context"] .ic-title');
          check('上下文 card unfolds on click (stored in ui.infoCards) and folds back', unfolded.open === 'true' && unfolded.body && !/"context"/.test(JSON.parse(unfolded.stored)?.collapsed ?? '[]'), JSON.stringify(unfolded));
          // A7 (2026-10-24): the window and the compaction point the server reports (info.contextWindow / compactWindow)
          // on the 上下文 card, a line under its title row (the folded card's percentage stays on the row); it fits the
          // 288px column in English too (the English text is put in the same elements and measured: the smoke's
          // interface is pinned to Chinese). Next to the percentage it squeezed 「上下文」 to a character per line.
          phase = 'a7';
          {
            const setA7 = (on) => js(`(() => { const st = window.__store; const o = st.getState().open[${sidJs}]; if (!o) return false; if (${on}) window.__a7Saved = { info: o.info, cu: o.conv.contextUsage }; const sv = window.__a7Saved ?? {}; const info = ${on} ? { ...(o.info ?? {}), contextWindow: 1000000, compactWindow: 700000 } : sv.info; const cu = ${on} ? { percentage: 42, totalTokens: 294000, maxTokens: 700000 } : sv.cu; st.setState({ open: { ...st.getState().open, [${sidJs}]: { ...o, info, conv: { ...o.conv, contextUsage: cu }, version: o.version + 1 } } }); return true; })()`);
            const winSel = '.pane.focused .info-card[data-card="context"] > .ic-window';
            await setA7(true);
            const shown = await waitFor(`document.querySelector(${JSON.stringify(winSel)})?.textContent === '窗口 1M · 700K 内压缩'`, 3000);
            const enCat = fs.readFileSync(path.join(ROOT, 'web/src/i18n/en.ts'), 'utf8');
            const en = (k) => { const pre = `${JSON.stringify(k)}: `; const line = enCat.split('\n').find((l) => l.trimStart().startsWith(pre)); return line ? JSON.parse(line.trim().slice(pre.length).replace(/,$/, '')) : null; };
            const enTitle = en('窗口 {w} · {c} 内压缩')?.replace('{w}', '1M').replace('{c}', '700K');
            const enCard = en('上下文');
            // the title row: nothing overflows, the card's name on one line; the window text not cut, inside the card
            const fit = (texts) => js(`(() => {
              const w = document.querySelector(${JSON.stringify(winSel)});
              if (!w) return null;
              const card = w.closest('.info-card'), head = card.querySelector('.ic-head'), t = head.querySelector('.ic-title'), tn = t.firstChild;
              const lines = (n) => { if (!n) return 0; const rg = document.createRange(); rg.selectNodeContents(n); return new Set([...rg.getClientRects()].map((x) => Math.round(x.top))).size; };
              const was = [w.textContent, tn?.nodeType === 3 ? tn.textContent : null];
              const texts = ${JSON.stringify(texts)};
              if (texts) { w.textContent = texts[0]; if (was[1] !== null && texts[1]) tn.textContent = texts[1]; }
              const cs = getComputedStyle(card), inner = card.getBoundingClientRect().right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
              const r = { text: w.textContent, card: t.textContent, pct: !!head.querySelector('.ic-sum .ic-meter'), head: head.scrollWidth - head.clientWidth, title: t.scrollWidth - t.clientWidth, titleLines: lines(tn), win: w.scrollWidth - w.clientWidth, winLines: lines(w.firstChild), over: Math.round(w.getBoundingClientRect().right - inner), col: Math.round(head.closest('.info-col').getBoundingClientRect().width) };
              if (texts) { w.textContent = was[0]; if (was[1] !== null && texts[1]) tn.textContent = was[1]; }
              return r;
            })()`);
            const zh = await fit(null);
            const enFit = enTitle ? await fit([enTitle, enCard]) : null;
            const fits = (r) => !!r && r.pct && r.head <= 1 && r.title <= 1 && r.titleLines === 1 && r.win <= 1 && r.winLines === 1 && r.over <= 1;
            check('A7 · 上下文 card: 「窗口 1M · 700K 内压缩」 from the server’s info under the title row (percentage on the row), fits the column', shown && fits(zh), JSON.stringify({ shown, zh }));
            check('A7 · … the English title (「Window 1M · compacts at 700K」) fits the 288px column too', !!enTitle && fits(enFit) && enFit.text === enTitle, JSON.stringify({ enTitle, enFit }));
            await shot('a7-context-title');
            await setA7(false);
            // the model menu marks the own login's Claude models with their window (1M by default)
            await click('.pane.focused .composer .mm-anchor > button.chip');
            await waitFor(`document.querySelectorAll('.menu.mm [data-sec="builtin"] .mm-row').length > 1`, 5000);
            const marks = await js(`[...document.querySelectorAll('.menu.mm [data-sec="builtin"] .mm-row')].map((r) => ({ m: r.querySelector('.mm-label .m')?.textContent ?? r.textContent.trim().slice(0, 30), w: r.querySelector('.mm-label .mm-win')?.textContent ?? null }))`);
            await shot('a7-model-menu');
            await key('Escape');
            if (!(await waitFor(`!document.querySelector('.menu.mm')`, 1500))) await click('.pane.focused .chat');
            const opus = marks.find((x) => /Opus/.test(x.m));
            check('A7 · model menu: the Claude rows say 1M (Opus among them), the default entry no mark', !!opus && opus.w === '1M' && marks.filter((x) => x.w === '1M').length >= 2 && marks.every((x) => !/默认/.test(x.m) || x.w === null), JSON.stringify(marks));
          }
          phase = 'recording-ux';
          await shot('info-column');
          await click('.pane.focused .sess-head button[aria-label="对话信息"]');
          const off = await waitFor(`!document.querySelector('.pane.focused .info-col') && window.__store.getState().settings['ui.infoPanel'] === false`, 3000);
          const diffBack = await js(`!!document.querySelector('.pane.focused .sess-head .sh-diff') || !document.querySelector('.pane.focused .info-col')`);
          await click('.pane.focused .sess-head button[aria-label="对话信息"]');
          const onAgain = await waitFor(`!!document.querySelector('.pane.focused .info-col')`, 3000);
          check('the header ⓘ turns the column off and on (ui.infoPanel)', off && diffBack && onAgain, JSON.stringify({ off, onAgain }));
          // 审阅 / 浏览器 / 文件 in the header: each opens its right-panel tab, a second click closes the panel
          const tools = await js(`[...document.querySelectorAll('.pane.focused .sess-head [data-tool]')].map((b) => b.dataset.tool)`);
          await click('.pane.focused .sess-head [data-tool="browser"]');
          const opened = await waitFor(`(() => { const d = window.__store.getState().layout.dock; return d.open && d.active === 'browser'; })()`, 3000);
          const pressed = await js(`document.querySelector('.pane.focused .sess-head [data-tool="browser"]')?.getAttribute('aria-pressed')`);
          await click('.pane.focused .sess-head [data-tool="browser"]');
          const closed = await waitFor(`!window.__store.getState().layout.dock.open`, 3000);
          check('header tools 审阅 / 浏览器 / 文件: one opens its panel (pressed), again closes it', JSON.stringify(tools) === JSON.stringify(['files', 'browser', 'explorer']) && opened && pressed === 'true' && closed, JSON.stringify({ tools, opened, pressed, closed }));
          // ⋮: 旁聊 and 后台任务 on top
          await click('.pane.focused .sess-head .sh-more > button');
          await waitFor(`!!document.querySelector('.menu.sess-menu')`, 3000);
          const top = await js(`[...document.querySelectorAll('.menu.sess-menu [data-act]')].slice(0, 2).map((b) => b.dataset.act)`);
          await key('Escape');
          check('⋮ starts with 旁聊 and 后台任务', JSON.stringify(top) === JSON.stringify(['side', 'background']), JSON.stringify(top));
          // the box is one line; permission left and model / effort / ring right on the line under it
          const under = await js(`(() => { const c = document.querySelector('.pane.focused .composer'); const box = c.querySelector('.composer-box').getBoundingClientRect(); const u = c.querySelector('.composer-under'); if (!u) return null; const r = u.getBoundingClientRect(); const ta = c.querySelector('textarea').getBoundingClientRect(); const plus = c.querySelector('.cb .plus').getBoundingClientRect(); const perm = u.querySelector('.perm-chip')?.getBoundingClientRect(); const model = u.querySelector('.mm-anchor')?.getBoundingClientRect(); return { below: r.top >= box.bottom - 1, h: Math.round(r.height), oneLine: Math.abs((plus.top + plus.bottom) / 2 - (ta.top + ta.bottom) / 2) < 6, permLeft: !!perm && !!model && perm.right < model.left, inBox: !!c.querySelector('.composer-box .mm-anchor, .composer-box .perm-chip'), placeholder: c.querySelector('textarea').placeholder }; })()`);
          check('composer: + and the words on one line in the box; permission left, model right on the line under it', !!under && under.below && under.h <= 36 && under.oneLine && under.permLeft && !under.inBox, JSON.stringify(under));
          // + in a conversation: 斜杠命令 puts a / in the box; 连接器 › is there (reach table, state 'live')
          const wp = await walk('plus', '.pane.focused .composer', { live: true });
          check(`reach · plus in a conversation (${wp.n})`, wp.n > 0 && !wp.miss.length, wp.miss.join(' ; '));
          await click('.pane.focused .composer .cb .plus');
          await waitFor(`!!document.querySelector('.menu.plus-menu [data-id="slash"]')`, 3000);
          const ctrlU = await js(`document.querySelector('.menu.plus-menu [data-id="files"] .kbd')?.textContent ?? null`);
          await click('.menu.plus-menu [data-id="slash"]');
          const slashed = await waitFor(`document.querySelector('.pane.focused .composer textarea')?.value.startsWith('/')`, 2000);
          await js(`window.__store.getState().saveDraft(${sidJs}, '')`);
          await js(`(() => { const t = document.querySelector('.pane.focused .composer textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
          await key('Escape');
          check('+ → 斜杠命令 starts a / command in the box; 添加文件或图片 says Ctrl+U', slashed && /U$/.test(ctrlU ?? ''), JSON.stringify({ slashed, ctrlU }));
          // the model menu: rows numbered, 强度 › in it
          await click('.pane.focused .composer .composer-under .mm-anchor > button.chip');
          await waitFor(`!!document.querySelector('.menu.mm .mm-row')`, 4000);
          const mm = await js(`(() => { const m = document.querySelector('.menu.mm'); return { nums: [...m.querySelectorAll('.mm-num')].slice(0, 3).map((n) => n.textContent), effort: !!m.querySelector('[data-id="model-effort"]') }; })()`);
          await click('.menu.mm [data-id="model-effort"]');
          const depth = await waitFor(`!!document.querySelector('.menu.depth-menu')`, 3000);
          await key('Escape');
          await sleep(200);
          check('model menu: rows numbered 1 2 3…; 强度 › opens the effort menu', JSON.stringify(mm.nums) === JSON.stringify(['1', '2', '3']) && mm.effort && depth, JSON.stringify({ mm, depth }));

          // ---- 2026-10-17: the rest of the recording and the user's screenshots ----
          // 钉住 under a reply → the info column's 钉住的回复 card; a click there scrolls to it; × unpins (card gone)
          const pinBtn = '.pane.focused .msg-actions [data-act="pin"]';
          const hasPin = await js(`!!document.querySelector(${JSON.stringify(pinBtn)})`);
          let pins = null;
          if (hasPin) {
            await click(pinBtn);
            const card = await waitFor(`!!document.querySelector('.pane.focused .info-card[data-card="pins"] .ic-pin')`, 3000);
            const stored = await js(`(window.__store.getState().sessionMeta[${sidJs}]?.pinnedMsgs ?? []).length`);
            await click('.pane.focused .info-card[data-card="pins"] .ic-pin .ic-row-btn');
            const flashed = await waitFor(`!!document.querySelector('.pane.focused .msg.assistant.msg-flash')`, 2000);
            await click('.pane.focused .info-card[data-card="pins"] .ic-pin .icon-btn');
            const gone = await waitFor(`!document.querySelector('.pane.focused .info-card[data-card="pins"]')`, 3000);
            pins = { card, stored, flashed, gone };
          }
          check('钉住 a reply: listed in the info column (SessionMeta.pinnedMsgs), a click there finds it, × unpins', hasPin && pins.card && pins.stored === 1 && pins.flashed && pins.gone, JSON.stringify({ hasPin, pins }));
          const speak = await js(`!('speechSynthesis' in window) || !!document.querySelector('.pane.focused .msg-actions [data-act="speak"]')`);
          check('朗读 sits in the reply row (where the browser can speak)', speak);
          // ☰: the browser's own menu with the official groups
          await click('[data-id="app-menu"]');
          const appMenu = await waitFor(`!!document.querySelector('.menu.app-menu')`, 2000);
          const groups = await js(`[...document.querySelectorAll('.menu.app-menu .menu-label')].map((e) => e.textContent)`);
          await key('Escape');
          await sleep(200);
          check('☰ opens the application menu: 对话 · 编辑 · 视图 · 前往 · 帮助', appMenu && JSON.stringify(groups) === JSON.stringify(['对话', '编辑', '视图', '前往', '帮助']), JSON.stringify(groups));
          // the account menu over a full page (扩展): nothing of it under the page (user report, macOS)
          await js(`(() => { const b = [...document.querySelectorAll('.rail [data-id]')].find((e) => e.dataset.id === 'extensions'); b && b.click(); })()`);
          await waitFor(`!!document.querySelector('.ext-page')`, 3000);
          // 模型: one hub with nine first-level pages (no tabs, no 高级设置); 上游 has one filter strip; 设置 holds sharing
          await js(`window.__store.setState({ sidebarOpen: true })`);
          await sleep(200);
          await js(`(() => { const b = [...document.querySelectorAll('.rail [data-id]')].find((e) => e.dataset.id === 'gateway'); b && b.click(); })()`);
          const hubReady = await waitFor(`(() => { const p = document.querySelector('.over-page.hub-page'); return !!p && !p.hidden && document.querySelectorAll('.hub-side [data-id]').length >= 9; })()`, 20000);
          const hub = hubReady ? await js(`(() => ({ pages: [...document.querySelectorAll('.hub-side [data-id]')].map((x) => x.dataset.id).join(','), tabs: !!document.querySelector('.hub-page .over-tabs'), adv: document.body.innerText.includes('高级设置') }))()`) : null;
          check('模型 opens on the hub with nine pages (概览 · 上游 · 路由 · 操控 · 用量 · 隐私 · 插件 · 接入 · 设置), no tabs, no 高级设置', hub && hub.pages === 'overview,sources,routing,control,usage,privacy,plugins,agents,settings' && !hub.tabs && !hub.adv, JSON.stringify(hub));
          await js(`document.querySelector('.hub-side [data-id="sources"]')?.click()`);
          await waitFor(`document.querySelectorAll('.hub-filters [data-id]').length >= 6`, 10000);
          const filters = await js(`(() => ({ ids: [...document.querySelectorAll('.hub-filters [data-id]')].map((x) => x.dataset.id).join(','), cards: document.querySelectorAll('.hub-pgrid .hub-provider').length }))()`);
          check('上游 has the six source filters and one card per source/preset', filters.ids === 'all,subscription,api,local,custom,remote' && filters.cards > 0, JSON.stringify(filters));
          await js(`document.querySelector('.hub-side [data-id="settings"]')?.click()`);
          const share = await waitFor(`(() => { const p = document.querySelector('.hub-settings'); return !!p && p.innerText.includes('本机地址') && p.innerText.includes('网关密钥'); })()`, 10000);
          const afterSettings = await js(`({ settings: !!document.querySelector('.hub-settings'), page: !!document.querySelector('.hub-page:not([hidden])'), drawer: !!document.querySelector('.gw-drawer-wrap[data-drawer="share"]:not([hidden])') })`);
          check('设置 shows gateway address/key and sharing in the page (no drawer)', share && afterSettings.settings && afterSettings.page && !afterSettings.drawer, JSON.stringify(afterSettings));
          await js(`(() => { const b = [...document.querySelectorAll('.rail [data-id]')].find((e) => e.dataset.id === 'chat'); b && b.click(); })()`);
          await waitFor(`!document.querySelector('.hub-page:not([hidden])')`, 3000);
          await click('.rail-acct');
          await waitFor(`!!document.querySelector('.sb-acct-menu')`, 2000);
          const onTop = await js(`(() => { const m = document.querySelector('.sb-acct-menu'); if (!m) return null; const b = m.getBoundingClientRect(); return [[b.right - 10, b.top + 16], [b.right - 10, b.bottom - 16], [b.left + 10, b.top + 16]].every(([x, y]) => m.contains(document.elementFromPoint(x, y))); })()`);
          await key('Escape');
          await js(`(() => { const b = [...document.querySelectorAll('.rail [data-id]')].find((e) => e.dataset.id === 'chat'); b && b.click(); })()`);
          await waitFor(`!document.querySelector('.ext-page:not([hidden])') && !!document.querySelector('.sidebar .sb-list [data-sid]')`, 4000);
          await js(`window.__store.setState({ sidebarOpen: true })`);
          await sleep(300);
          check('the account menu lies over the 扩展 page, not under it', onTop === true, String(onTop));
          // projects / folders start folded (GitHub issue #3); the current conversation's stays open
          await js(`window.__store.getState().setSetting('ui.sidebarFolded', true)`);
          await sleep(500);
          const fold = await js(`(() => { const gs = [...document.querySelectorAll('.sidebar [data-group]')].filter((g) => !g.classList.contains('sb-sec') && g.dataset.group !== '__other_kept'); const act = document.querySelector('.sidebar .sess.active')?.closest('.sb-group'); return { groups: gs.length, folded: gs.filter((g) => g.classList.contains('collapsed')).length, activeOpen: !!act && !act.classList.contains('collapsed') }; })()`);
          await js(`window.__store.getState().setSetting('ui.sidebarFolded', false)`);
          await sleep(300);
          check('侧栏 folds projects and folders by default, the current conversation\'s open (issue #3)', fold.groups >= 1 && fold.activeOpen && (fold.groups === 1 || fold.folded >= 1), JSON.stringify(fold));
          // the new-conversation page the official way: 代码 / 聊天, the folder… under a one-line box; the backdrop; ← back
          await js(`window.__store.getState().setSetting('ui.welcomeLayout', 'under')`);
          await js(`window.__store.getState().openInPane(null, 'replace')`);
          const welcomeUp = await waitFor(`!!document.querySelector('.pane.focused .welcome .composer') && window.__store.getState().activeId == null`, 5000);
          await sleep(500);
          const wl = await js(`(() => { const c = document.querySelector('.pane.focused .welcome .composer'); const u = c?.querySelector('.composer-under'); return { under: !!u, mode: !!u?.querySelector('.cmp-mode [data-mode="chat"]'), folder: !!u?.querySelector('.dirpick'), boxChips: !!c?.querySelector('.composer-box .dirpick'), backdrop: !!document.querySelector('.pane.focused .welcome-tile > canvas.ascii-field') }; })()`);
          await click('.pane.focused .composer-under .cmp-mode [data-mode="chat"]');
          const chatOnly = await waitFor(`!!document.querySelector('.pane.focused .welcome .cap-tag[data-cap="chatOnly"]')`, 2000);
          await click('.pane.focused .composer-under .cmp-mode [data-mode="code"]');
          check('新对话页: the chips under a one-line box (代码 / 聊天 → 只聊天), the moving backdrop behind it', wl.under && wl.mode && wl.folder && !wl.boxChips && wl.backdrop && chatOnly, JSON.stringify({ wl, chatOnly }));
          await click('[data-id="back"]');
          const backTo = await waitFor(`window.__store.getState().activeId === ${sidJs}`, 4000);
          await js(`window.__store.getState().setSetting('ui.welcomeLayout', 'inbox')`);
          check('← goes back to the conversation looked at before (from the new-conversation page)', welcomeUp && backTo, JSON.stringify({ welcomeUp, backTo }));
          await sleep(400);
          win.setSize(1360, 860);
          await sleep(500);
        }

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
        await click(':is(.app.has-rail .rail [data-id="chat"], .app.mobile .auto-page .auto-head button[aria-label="关闭自动化"])');
        const back = await waitFor('document.querySelector(".auto-page")?.hidden === true && !document.querySelector(".pane-layer[inert]") && !!document.querySelector(".pane.focused .chat")', 4000);
        check('··· 定时任务 opens the automation page over the conversation (kept mounted underneath); × returns to it', inView && noPill && back, JSON.stringify({ inView, noPill, back }));

        // collapsed sidebar: the centre takes the whole width and the header's first button brings the sidebar back
        await js('window.__store.setState({ sidebarOpen: false })');
        await sleep(500);
        const collapsed = await js(`(() => { const c = document.querySelector('.center').getBoundingClientRect(); return { left: Math.round(c.left), reveal: !!document.querySelector('.rail .sb-reveal'), inHeader: !!document.querySelector('.pane .sess-head .sb-reveal') }; })()`);
        // (the centre is a card on the shell, right after the icon rail — 52px; 展开侧栏 is the rail's first button, not
        // one more button in the conversation's header)
        check('collapsed sidebar: the centre starts right after the icon rail, whose first button is 展开侧栏', collapsed.left === 52 && collapsed.reveal && !collapsed.inHeader, JSON.stringify(collapsed));
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
        await click('.rail .sb-reveal');
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
        // phase 6 §3: the box is one line (+ · words · send), the chips a line under it
        // (the new pane is a welcome page: its chips stay in the box, on one row)
        const splitBars = await js(`[...document.querySelectorAll('.pane .composer')].map((c) => { const box = c.querySelector('.composer-box'), u = c.querySelector('.composer-under'), bar = c.querySelector('.composer-bar'); const row = u ?? bar; return { welcome: !u, box: Math.round(box.getBoundingClientRect().height), row: Math.round(row.getBoundingClientRect().height), overflow: row.scrollWidth > row.clientWidth + 1 }; })`);
        check('split panes: each composer row is still one line (a conversation: one in the box, one under it)', splitBars.length === 2 && splitBars.every((b) => b.row <= 36 && !b.overflow && (b.welcome || b.box <= 60)), JSON.stringify(splitBars));
        await click('.pane.focused .tabstrip button[aria-label="关闭这个分屏"]');
        const merged = await waitFor('document.querySelectorAll(".pane").length === 1 && document.querySelectorAll(".pane .tabstrip").length === 0', 4000);
        check('closing the split hides the tab strip again', merged, `strips ${await strips()}`);

        // 「显示工作台工具」 brings everything back; off hides it again
        if (E.SMOKE_READONLY !== '1') {
          await js('window.__store.getState().setSetting("ui.workbench", true)');
          const on = await waitFor('!!document.querySelector(".groupbar") && !document.querySelector(".dock-rail") && document.querySelectorAll(".pane .tabstrip").length === 1', 4000);
          check('workbench tools on: group bar and tab strip (no row of panel icons: they are behind the rail\'s ···)', on);
          await shot('workbench');
          // the tab strip's ＋ menu is not clipped by the sideways-scrolling tab row (Enroll 2026-10-14: the ＋ looked dead)
          await click('.pane .tabstrip .tab-add');
          await waitFor(`!!document.querySelector('.pane .tabstrip .menu')`, 2000);
          const addMenu = await js(`(() => { const m = document.querySelector('.pane .tabstrip .menu'); if (!m) return null; const items = [...m.querySelectorAll('button')]; const last = items[items.length - 1].getBoundingClientRect(); const first = items[0].getBoundingClientRect(); const at = (r) => { const h = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 6)); return !!h && m.contains(h); }; const over = document.elementFromPoint(last.left + last.width / 2, last.top + Math.min(last.height / 2, 6)); return { items: items.length, first: at(first), lastReachable: at(last) || (m.scrollHeight > m.clientHeight && last.top >= m.getBoundingClientRect().bottom - 1), lastAt: Math.round(last.top), vh: innerHeight, over: over && !m.contains(over) ? over.tagName + '.' + String(over.className).slice(0, 40) : null, card: document.querySelector('.ctx-card')?.getAttribute('role') ?? null, ringExpanded: [...document.querySelectorAll('.ctx-meter')].map((b) => b.getAttribute('aria-expanded')), active: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 30) : null }; })()`);
          await key('Escape');
          check('tab strip ＋: its menu shows below the ＋ and every item can be reached', !!addMenu && addMenu.first && addMenu.lastReachable && addMenu.items >= 3, JSON.stringify(addMenu));
          await js('window.__store.getState().setSetting("ui.workbench", false)');
          const off = await waitFor('!document.querySelector(".groupbar") && !document.querySelector(".dock-rail") && !document.querySelector(".pane .tabstrip")', 4000);
          check('workbench tools off: back to one row', off);
        }

        // ---- review fixes (phase 0–1)
        phase = 'session-review';
        const paneTiles = `(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); const p = g.panes[g.focusedPaneId]; return p.tiles.map((t) => t.kind === 'chat' ? 'chat:' + (t.sessionId || 'new') : t.kind + ':' + t.id).join(',') + '|' + p.activeTileId; })()`;
        // header ··· hands over straight away: the agents (or the note that there are none) are in the menu itself
        await click('.sess-head .sh-more > button');
        const handoff = await js(`(() => { const m = document.querySelector('.menu.sess-menu'); if (!m) return null; return { label: [...m.querySelectorAll('.menu-label')].some((l) => l.textContent.includes('交给')), nested: !!m.querySelector('button[aria-expanded]:not([data-act="thinking-language"])') }; })()`);
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
          check('phone + workbench tools: no group bar / tab strip; header has 展开侧栏 and ··· (and +N −M when there are changes) but no 终端 / 右侧面板', phone && phoneHead && phoneHead.reveal && phoneHead.more && !phoneHead.term && !phoneHead.panel, JSON.stringify({ phone, phoneHead }));
          await shot('phone-workbench');
          const phoneBar = await js(`(() => { const bar = document.querySelector('.pane .composer-bar'); if (!bar) return null; const b = bar.getBoundingClientRect(); return { h: Math.round(b.height), overflow: bar.scrollWidth > bar.clientWidth + 1, mic: !!bar.querySelector('[data-id="mic"]') }; })()`);
          check('phone: the composer row is one line (the 40px send button high), no mic (spec §5.11, UI refresh §8)', phoneBar && phoneBar.h <= 40 && !phoneBar.overflow && !phoneBar.mic, JSON.stringify(phoneBar));
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
          await click(':is(.rail, .sidebar) [data-id="automation"]');
          const autoPhone = await waitFor(`(() => { const p = document.querySelector('.auto-page'); return !!p && !p.hidden && !document.querySelector('.app').classList.contains('drawer-open'); })()`, 3000);
          await click(':is(.auto-page .auto-tabs, .sb-sect:not([hidden]) .auto-side .sect-nav) [data-id="goals"]');
          const goalsPhone = await waitFor(`(() => { const b = document.querySelector('.auto-page .auto-body[data-body="goals"]:not([hidden])'); return !!b && b.getBoundingClientRect().height > 0; })()`, 3000);
          await click(':is(.auto-page .auto-tabs, .sb-sect:not([hidden]) .auto-side .sect-nav) [data-id="orchestra"]');
          const orchPhone = await waitFor(`(() => { const b = document.querySelector('.auto-page .auto-body[data-body="orchestra"]:not([hidden])'); return !!b && b.getBoundingClientRect().height > 0; })()`, 3000);
          const autoToasts = await js(`[...document.querySelectorAll('.toast')].map((t) => t.textContent)`);
          await shot('phone-automation');
          check('phone: sidebar 自动化 opens the automation page (目标 / 编排 tabs there), the drawer shuts, no toast', autoPhone && goalsPhone && orchPhone && !autoToasts.some((t) => /手机/.test(t)), JSON.stringify({ autoPhone, goalsPhone, orchPhone, autoToasts }));
          await key('Escape');
          await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          for (const [item, label] of [['usage', '用量与账本'], ['config', '配置中心']]) {
            await click('.pane .sess-head .sb-reveal');
            await waitFor('document.querySelector(".app").classList.contains("drawer-open")', 3000);
            await click(':is(.rail, .sidebar) [data-id="account"]');
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
        check('right panel: the five fixed tabs 审阅 · 文件 · 终端 · 浏览器 · 任务, none closable', rp && fixedTabs === 'files,explorer,terminal,browser,tasks', `${rp} ${fixedTabs}`);
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
        // ---- 审阅: comments on diff lines (spec 2026-10-16 review-pr §1)
        if (E.SMOKE_READONLY !== '1') {
          const lineFound = await js(`(() => { const l = [...document.querySelectorAll('.dock .rv-file .rv-body .dl.commentable')].find((x) => x.classList.contains('add')); if (l) l.dataset.smokeLine = '1'; return !!l; })()`);
          if (lineFound) await click('.dock .dl[data-smoke-line="1"]');
          const box = await waitFor('document.activeElement === document.querySelector(".dock .dl-note-edit textarea")', 3000);
          wc.insertText('smoke comment');
          await key('Enter');
          const added = await waitFor('document.querySelectorAll(".dock .dl-note").length === 1 && /1 条评论/.test(document.querySelector(".dock .rv-comments")?.textContent ?? "")', 3000);
          await js('document.querySelector(".dock .rv-comments .btn.ghost")?.click()');
          const cleared = await waitFor('!document.querySelector(".dock .rv-comments") && !document.querySelector(".dock .dl-note")', 3000);
          check('审阅: a click on a diff line opens a comment box, Enter adds it (the bar says 1 条评论), 清空 clears them', lineFound && box && added && cleared, JSON.stringify({ lineFound, box, added, cleared }));
        }
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
        const temp = await waitFor('!!document.querySelector(".dock .dock-tabs .tab.active:not(.fixed)[data-panel=goals] .x, .dock .dock-foldhead[data-panel=goals] button")', 3000);
        await click((await js('!!document.querySelector(".dock .dock-tabs .tab[data-panel=goals] .x")')) ? '.dock .dock-tabs .tab[data-panel="goals"] .x' : '.dock .dock-foldhead[data-panel="goals"] button');
        const closed = await waitFor('!window.__store.getState().layout.dock.tabs.includes("goals") && !document.querySelector(".dock .dock-tabs .tab[data-panel=goals]") && !document.querySelector(".dock .dock-foldhead[data-panel=goals]")', 3000);
        check('a temporary tab opens from 「更多」 and its × closes it', temp && closed, JSON.stringify({ temp, closed }));
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
          const shown = listed && await waitFor(`(() => { const d = window.__store.getState().layout.dock; return d.open && (document.querySelector('.dock .dock-tabs .tab.active') ?? document.querySelector('.dock .dock-foldhead'))?.dataset.panel === ${JSON.stringify(p.id)} && !!document.querySelector('.dock-panel[data-panel="${p.id}"]:not([hidden])'); })()`, 4000);
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
        const activeTab = '(document.querySelector(".dock:not([hidden]) .dock-tabs .tab.active") ?? document.querySelector(".dock:not([hidden]) .dock-foldhead"))?.dataset.panel';
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
          await click((await js('!!document.querySelector(".dock .dock-tabs .tab[data-panel=inspector] .x")')) ? '.dock .dock-tabs .tab[data-panel="inspector"] .x' : '.dock .dock-foldhead[data-panel="inspector"] button');
          // N7: back on the fixed tab that was in front before (终端), not the first one (审阅)
          const landed = await waitFor(`window.__store.getState().layout.dock.open && !document.querySelector('.dock .dock-tabs .tab[data-panel="inspector"]') && !!document.querySelector('.dock .dock-tabs .tab.fixed.active[data-panel="terminal"]')`, 3000);
          check('closing the last temporary tab keeps the right panel open, on the fixed tab last in front (终端)', landed, await js(dockState));

          // I2: the desktop app on Windows at 1024 wide — the caption buttons take the top-right 150px of the tab
          // row: the four fixed tabs stay whole (never scrolled away), the 「更多」 menu stays inside the window
          phase = 'right-panel-desktop';
          win.setContentSize(1080, 860);
          await waitFor('innerWidth === 1080', 4000);
          await js(`document.documentElement.classList.add('desktop', 'win'); window.__store.setState({ sidebarOpen: true })`);
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'files' })`);
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'goals' })`);
          await sleep(900);
          const fit = await js(`(() => { const vw = innerWidth; const rp = document.querySelector('.rpanel').getBoundingClientRect(); const tabs = [...document.querySelectorAll('.dock .dock-tabs .tab.fixed')].map((t) => { const r = t.getBoundingClientRect(); const whole = r.width > 0 && r.left >= rp.left - 0.5 && r.right <= Math.min(rp.right, vw) + 0.5; const underCaption = r.top < 60 && r.right > vw - 150; return { id: t.dataset.panel, ok: whole && !underCaption }; }); return { vw, rp: Math.round(rp.width), stacked: !!document.querySelector('.dock-tabs.stacked'), tabs }; })()`);
          check('desktop · Windows, 1080 wide (1024 + the icon rail), a temporary tab open: the five fixed tabs are fully visible', fit.tabs.length === 5 && fit.tabs.every((x) => x.ok), JSON.stringify(fit));
          // the temporary tab is reachable here too: its own tab in the strip (then no title row on the panel as well),
          // or — no room for a strip beside five fixed tabs — in 「更多」 with the panel named on top
          const narrowTemp = await js(`({ strip: !!document.querySelector('.dock .dock-tablist .tab.active[data-panel="goals"]'), head: !!document.querySelector('.dock .dock-foldhead[data-panel="goals"]'), badge: document.querySelector('.dock .dock-more-n')?.textContent ?? null })`);
          check('1080: the temporary tab is either a tab of the strip (no title row) or folded into 「更多」 (title row, counted)', narrowTemp.strip ? !narrowTemp.head : narrowTemp.head && narrowTemp.badge === '1', JSON.stringify(narrowTemp));
          await click('.dock button.dock-more');
          const menu = await js(`(() => { const m = document.querySelector('.dock-more-menu'); if (!m) return null; const r = m.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom), vw: innerWidth, vh: innerHeight }; })()`);
          check('desktop · Windows, 1080 wide: the 「更多」 menu is inside the window', !!menu && menu.l >= 0 && menu.r <= menu.vw && menu.b <= menu.vh, JSON.stringify(menu));
          await shot('right-panel-desktop-win');
          await key('Escape');
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.close', panel: 'goals', workbench: false })`);
          await sleep(200);

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
          const rowProbe = `(() => { const vw = innerWidth; const rp = document.querySelector('.rpanel').getBoundingClientRect(); const fixed = [...document.querySelectorAll('.dock .dock-tabs .tab.fixed')].map((t) => { const r = t.getBoundingClientRect(); return r.width > 0 && r.right <= Math.min(rp.right, vw) + 0.5 && !(r.top < 60 && r.right > vw - 150); }); const strip = document.querySelector('.dock .dock-tablist .tab[data-panel="goals"]'); return { vw, rp: Math.round(rp.width), stacked: !!document.querySelector('.dock-tabs.stacked'), fixedOk: fixed.length === 5 && fixed.every(Boolean), short: !!document.querySelector('.dock .dock-fixed.short'), named: [...document.querySelectorAll('.dock .dock-fixed .tab')].filter((t) => { const l = t.querySelector('.t'); return !!l && l.getClientRects().length > 0; }).map((t) => t.dataset.panel).join(','), count: ${countSel}, badge: document.querySelector('.dock .dock-more-n')?.textContent ?? null, strip: !!strip && strip.getBoundingClientRect().width > 0, moreActive: !!document.querySelector('.dock button.dock-more.active'), fixedW: Math.round(document.querySelector('.dock .dock-fixed').getBoundingClientRect().width), ctlW: Math.round(document.querySelector('.dock .dock-ctl').getBoundingClientRect().width), bodyTop: Math.round(document.querySelector('.dock .dock-body').getBoundingClientRect().top) }; })()`;
          const r1440 = await js(rowProbe);
          check('desktop · Windows, 1440 wide, default panel, 审阅 with files, a temporary tab open: the row is not moved below the caption buttons', counted && r1440.rp === 432 /* the 440 column less the shell gap */ && !r1440.stacked && r1440.fixedOk && r1440.bodyTop <= 61 /* 8 gap + the 52px row */, JSON.stringify(r1440));
          check('…and the temporary tab is reachable: its own tab, or 「更多」 counting it (and marked while it is in front)', r1440.strip || (r1440.badge === '1' && r1440.moreActive), JSON.stringify(r1440));
          // 忍冬 2026-10-14: the row's last button sat 4px from − and a click meant for one landed on the other
          const air = await js(`(() => { const bs = [...document.querySelectorAll('.dock .dock-tabs button')].filter((b) => b.getClientRects().length && b.getBoundingClientRect().top < 40); const right = Math.max(...bs.map((b) => b.getBoundingClientRect().right)); return { right: Math.round(right), air: Math.round(innerWidth - 138 - right) }; })()`);
          check('desktop · Windows: at least 16px between the right panel\'s last button and the caption buttons', air.air >= 16, JSON.stringify(air));
          // five names do not fit beside the caption buttons of the default panel: only the tab in front keeps its name
          // (a temporary panel is in front here, so none does); the others are their icons, each with its name as tooltip
          const shortTips = await js(`[...document.querySelectorAll('.dock .dock-fixed .tab')].map((t) => t.title).join(',')`);
          check('1440, default panel: the fixed tabs are in their short form — icons, their names in the tooltips', r1440.short && r1440.named === '' && shortTips === '审阅,文件,终端,浏览器,任务', JSON.stringify({ short: r1440.short, named: r1440.named, shortTips }));
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { active: 'files' } })`);
          await sleep(250);
          const namedFront = await js(`({ named: [...document.querySelectorAll('.dock .dock-fixed .tab')].filter((t) => { const l = t.querySelector('.t'); return !!l && l.getClientRects().length > 0; }).map((t) => t.dataset.panel).join(','), stacked: !!document.querySelector('.dock-tabs.stacked'), bodyTop: Math.round(document.querySelector('.dock .dock-body').getBoundingClientRect().top) })`);
          check('…the one in front is named (审阅), and switching does not move the row', namedFront.named === 'files' && !namedFront.stacked && namedFront.bodyTop === r1440.bodyTop, JSON.stringify(namedFront));
          // a wider panel has room for all five names and a strip: the temporary tab gets its own tab and no title row
          await js(`(() => { const d = window.__store.getState().dispatchLayout; d({ t: 'dock.set', patch: { width: 620 } }); d({ t: 'dock.show', panel: 'goals' }); })()`);
          await sleep(700);
          const wide = await js(`({ short: !!document.querySelector('.dock .dock-fixed.short'), stacked: !!document.querySelector('.dock-tabs.stacked'), strip: !!document.querySelector('.dock .dock-tablist .tab.active[data-panel="goals"]'), head: !!document.querySelector('.dock .dock-foldhead') })`);
          check('a 620px panel names all five; the temporary tab is in the strip and gets no extra title row on its panel', !wide.short && !wide.stacked && wide.strip && !wide.head, JSON.stringify(wide));
          await js(`(() => { const d = window.__store.getState().dispatchLayout; d({ t: 'dock.set', patch: { width: 440 } }); d({ t: 'dock.show', panel: 'goals' }); })()`);
          await sleep(700);
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
            await click('.sidebar [data-id="view"]');
            await sleep(250);
            const m1 = await menusNow();
            check('one menu app-wide: opening the sidebar funnel closes the header ···', headerOpen && m1.length === 1 && /sb-view/.test(m1[0]), JSON.stringify({ headerOpen, m1 }));
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
              await click('.sidebar [data-id="view"]');
              await sleep(250);
              const m3 = await menusNow();
              check('one menu app-wide: the 文件 right-click menu, then the sidebar funnel → only the funnel is open (polish P2)', ftOpen && m3.length === 1 && /sb-view/.test(m3[0]), JSON.stringify({ ftOpen, m3 }));
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
            top: '.rail .rail-top > [data-id], .rail .rail-top > .rail-anchor > [data-id], .rail .rail-main > [data-id]:not(.pinned), .rail .rail-main > .rail-anchor > [data-id], .sidebar .sb-top [data-id], .sidebar .sb-nav [data-id]',
            automation: ':is(.auto-page .auto-tabs, .sb-sect:not([hidden]) .auto-side .sect-nav) [data-id]',
            section: '.sidebar .sb-sec[data-id], .sidebar .sb-group[data-id]',
            head: '.sidebar [data-id="projects"] > .sb-sec-h [data-id]',
            view: '.menu.sb-view [data-id]',
            custom: '.sidebar [data-id="custom-section"], .sidebar .sb-custom [data-id], .menu.sb-custom-menu [data-id]',
            project: '.menu.sb-menu[aria-label^="项目"] [data-id], .sidebar .sb-group-head .acts [data-id]',
            row: '.sidebar .sb-list [data-id], .sidebar .sb-attn [data-id]',
            rowMenu: '.menu.sess-menu [data-id]',
            account: '.rail .rail-foot [data-id], .sidebar .sb-account [data-id]',
            hint: '.sidebar .sb-hint [data-id]',
          };
          const seen = {};
          const harvest = async () => {
            const got = await js(`(() => { const S = ${JSON.stringify(SCOPES)}; const o = {}; for (const p of Object.keys(S)) o[p] = [...document.querySelectorAll(S[p])].map((e) => e.dataset.id); return o; })()`);
            for (const p of Object.keys(got)) for (const id of got[p]) if ((PLACES[p] || []).includes(id)) (seen[p] = seen[p] || new Set()).add(id);
          };
          const sb = await js(`({ chipRows: !!document.querySelector('.sidebar .sb-sources, .sidebar .src-chip, .sidebar .sb-search, .sidebar .lib-banner'), top: [...document.querySelectorAll('.sidebar .sb-top [data-id], .sidebar .sb-nav [data-id]')].map((e) => e.dataset.id), rail: [...document.querySelectorAll('.rail .rail-top > [data-id], .rail .rail-main > [data-id], .rail .rail-main > .rail-anchor > [data-id]')].map((e) => e.dataset.id), head: [...document.querySelectorAll('.sidebar [data-id="projects"] > .sb-sec-h [data-id]')].map((e) => e.dataset.id), account: [...document.querySelectorAll('.rail .rail-foot [data-id]')].map((e) => e.dataset.id), inSidebar: document.querySelectorAll('.sidebar .sb-account, .sidebar .sb-nav [data-id="automation"]').length, row: !!document.querySelector('.sidebar .sb-list [data-sid=' + ${JSON.stringify(SID)} + '] [data-id="status"]') })`);
          check('sidebar: no chip / filter-box rows; 新对话 · 搜索; the rail: the switch · 对话 · 后台 · 自动化 · 扩展 · 更多, at its foot 设置 and the account (connection); funnel + 打开文件夹 on 项目; the row ends in one status',
            !sb.chipRows && has(sb.top, ['new', 'search']) && has(sb.rail, ['collapse', 'chat', 'background', 'automation', 'extensions', 'more']) && has(sb.head, ['view', 'add-project']) && has(sb.account, ['account', 'connection', 'settings']) && sb.inSidebar === 0 && sb.row, JSON.stringify(sb));
          // final review I3: 收起侧栏 shows with the pointer over the sidebar or the key focus on it, not at rest
          // (and the 项目 header's funnel and +, the same way)
          const collapseOp = () => js(`['.sb-sec-h [data-id="view"]', '.sb-sec-h [data-id="add-project"]'].map((s) => getComputedStyle(document.querySelector('.sidebar ' + s)).opacity).join(',')`);
          wc.sendInputEvent({ type: 'mouseMove', x: 900, y: 400 });
          await sleep(400);
          const opRest = await collapseOp();
          wc.sendInputEvent({ type: 'mouseMove', x: 120, y: 300 });
          await sleep(400);
          const opHover = await collapseOp();
          wc.sendInputEvent({ type: 'mouseMove', x: 900, y: 400 });
          await sleep(400);
          check('the funnel and + (打开文件夹) at rest are invisible (still there for Tab and the pointer), shown with the pointer over the sidebar', opRest === '0,0' && opHover === '1,1', JSON.stringify({ opRest, opHover }));
          // final review §9 #5: no project yet but conversations in 文件夹 → the empty state points at their folders,
          // whose 「设为项目」 is written out at rest (no second 打开文件夹 button); with a project it is the hover icon again
          {
            const wsSaved = await js('JSON.stringify(window.__store.getState().workspaces)');
            const secSaved = await js('JSON.stringify(window.__store.getState().layout.sidebar?.sections ?? {})');
            await js(`window.__store.setState({ workspaces: [] })`);
            // no fold recorded
            await js(`(() => { const st = window.__store.getState(); const { __older, ...rest } = st.layout.sidebar?.sections ?? {}; st.dispatchLayout({ t: 'sidebar.set', patch: { sections: rest } }); })()`);
            await sleep(400);
            const nc = await js(`(() => { const e = document.querySelector('.sidebar [data-id="projects"] .ws-empty'); const mk = document.querySelector('.sidebar [data-id="other"] .sb-group-head [data-id="make-project"]'); const h = document.querySelector('.sidebar [data-id="other"] > .sb-sec-h'); return { text: e?.textContent ?? null, button: !!e?.querySelector('button'), mk: mk?.textContent ?? null, mkShown: !!mk && mk.getBoundingClientRect().width > 20, head: h ? { role: h.getAttribute('role'), expanded: h.getAttribute('aria-expanded') } : null }; })()`);
            await shot('sidebar-newcomer');
            const groups = await js(`document.querySelectorAll('.sidebar [data-id="other"] > .sb-group').length`);
            check('文件夹 (2026-10-14): a plain heading, every folder its own group right under it', !!nc.head && nc.head.role === null && groups >= 1, JSON.stringify({ head: nc.head, groups }));
            await js(`(() => { const st = window.__store.getState(); window.__store.setState({ workspaces: JSON.parse(${JSON.stringify(wsSaved)}) }); st.dispatchLayout({ t: 'sidebar.set', patch: { sections: JSON.parse(${JSON.stringify(secSaved)}) } }); })()`);
            await sleep(300);
            check('no project, folders in 文件夹: 「把常用的文件夹设为项目」 with no button, the folder says 「设为项目」 at rest', !!nc.text && /把常用的文件夹设为项目/.test(nc.text) && !nc.button && nc.mk === '设为项目' && nc.mkShown, JSON.stringify(nc));
          }
          await harvest();
          await shot('sidebar');
          // the funnel: sources, machines (when there are other machines), archived, multi-select, the filter box
          await click('.sidebar [data-id="view"]');
          const fm = await ids('.menu.sb-view [data-id]');
          const fmIn = await js('(() => { const m = document.querySelector(".menu.sb-view"); if (!m) return false; const r = m.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()');
          check('显示 menu (stage C3, was the funnel): filter box, 分组方式, 排序, 显示已归档, 其它 agent, 每组, sources, 选择多个, 新建分区, 恢复默认, 查看全部, 管理对话来源 — inside the window', has(fm, ['query', 'source', 'group-by', 'sort-by', 'archived', 'other-agents', 'per-group', 'select', 'new-section', 'reset', 'all', 'library']) && fmIn, JSON.stringify({ fm, fmIn }));
          await harvest();
          await shot('sidebar-filter');
          if (E.SMOKE_READONLY !== '1') {
            wc.insertText('zzz-no-such-conversation');
            await sleep(400);
            const filtered = await js('({ summary: document.querySelector(".sidebar .sb-filtered .what")?.textContent || "", rows: document.querySelectorAll(".sidebar .sb-list .sb-row").length })');
            check('the filter box filters the list and the list says it is filtered', filtered.rows === 0 && filtered.summary.includes('zzz-no-such'), JSON.stringify(filtered));
            // the 已筛选 row pushed the funnel down: the menu follows its anchor instead of covering it
            const follow = await js('(() => { const b = document.querySelector(".sidebar [data-id=view]")?.getBoundingClientRect(); const m = document.querySelector(".menu.sb-view")?.getBoundingClientRect(); return !!b && !!m && (m.top >= b.bottom - 1 || m.bottom <= b.top + 1); })()');
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
          await click('.sidebar [data-id="view"]');
          await click(':is(.rail, .sidebar) [data-id="automation"]');
          // a closed menu leaves an inert fading copy (.leaving, ui/ghost.ts) for ~120ms: not a menu
          await waitFor('!document.querySelector(".menu.sb-menu:not(.leaving), .menu.sess-menu:not(.leaving)")', 1000);
          const one = { menus: await count('.menu.sb-menu:not(.leaving), .menu.sess-menu:not(.leaving)'), page: await waitFor(`(() => { const p = document.querySelector('.auto-page'); return !!p && !p.hidden; })()`, 3000), funnel: await exists('.menu.sb-view:not(.leaving)'), inert: await exists('.pane-layer[inert]'), active: await exists('.rail [data-id="automation"].on') };
          check('自动化 opens the automation page (panes underneath inert, the entry marked) and closes the funnel', !one.menus && one.page && !one.funnel && one.inert && one.active, JSON.stringify(one));
          const am = await ids(':is(.auto-page .auto-tabs, .sb-sect:not([hidden]) .auto-side .sect-nav) [data-id]');
          const newBtn = await js(`document.querySelector('.auto-page .auto-head [data-new]')?.textContent ?? null`);
          check('自动化 page: tabs 定时任务 / 目标 / 编排, 新建 at the top right', has(am, ['schedules', 'goals', 'orchestra']) && !!newBtn, JSON.stringify({ am, newBtn }));
          await harvest();
          await shot('automation-schedules');
          const autoMiss = [];
          for (const tab of ['goals', 'orchestra', 'schedules']) {
            await click(`:is(.auto-page .auto-tabs, .sb-sect:not([hidden]) .auto-side .sect-nav) [data-id="${tab}"]`);
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
          const svList = await js(`(() => { const v = document.querySelector('${sv}'); return v && { subtabs: !!v.querySelector('.subtabs'), runs: !!v.querySelector('[data-id="sched-runs"]'), templates: v.querySelectorAll('[data-id="sched-templates"] .tpl-card').length, view: v.dataset.view }; })()`);
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
          const sf = await js(`(() => { const f = document.querySelector('.auto-page .sched-form'); const p = f && f.querySelector('[data-id="sched-project"]'); if (!f || !p) return null; const fr = f.getBoundingClientRect(); const pr = p.getBoundingClientRect(); const over = [...f.querySelectorAll('input, select, textarea, button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > fr.right + 1 || r.left < fr.left - 1); }).length; return { w: Math.round(pr.width), value: (p.textContent || '').trim(), dropdown: p.getAttribute('aria-haspopup'), over }; })()`);
          // the choices themselves: open the shared Select and read its rows (其它文件夹… is the last one)
          await click('.auto-page .sched-form [data-id="sched-project"]');
          await waitFor(`!!document.querySelector('.menu.select-popover')`, 3000);
          const sfOpts = await js(`[...document.querySelectorAll('.menu.select-popover .select-option')].map((b) => b.textContent.trim())`);
          await key('Escape');
          await waitFor(`!document.querySelector('.menu.select-popover')`, 3000);
          check('新定时任务: 「项目」 is a dropdown (a project chosen, 其它文件夹… last), nothing sticks out of the form', !!sf && sf.w >= 150 && !!sf.value && sf.dropdown === 'menu' && sfOpts.at(-1) === '其它文件夹…' && sf.over === 0, JSON.stringify({ ...sf, sfOpts }));
          await shot('automation-new');
          // the main area goes elsewhere (a conversation opened from the palette, a notification, a link — the sidebar
          // column is the automation section's own while the page is up): the page gets out of the way, stays mounted
          const sideIsSection = await js(`(() => { const list = document.querySelector('.sidebar .sb-sect[data-section="chat"]'); const auto = document.querySelector('.sidebar .sb-sect[data-section="automation"]'); return !!list && list.hidden && !!auto && !auto.hidden && [...auto.querySelectorAll('.sect-nav [data-id]')].map((b) => b.dataset.id).join(' ') === 'schedules goals orchestra'; })()`);
          check('自动化 in front: the sidebar column is its own (定时任务 · 目标 · 编排), the conversation list kept mounted behind it', sideIsSection);
          await js(`window.__store.getState().openInPane(${SID}, 'replace')`);
          const away = await waitFor(`(() => { const p = document.querySelector('.auto-page'); return !!p && p.hidden && p.querySelectorAll('.auto-body').length === 3 && !document.querySelector('.pane-layer[inert]'); })()`, 3000);
          const listBack = await waitFor(`(() => { const list = document.querySelector('.sidebar .sb-sect[data-section="chat"]'); return !!list && !list.hidden && !!list.querySelector('.sb-list [data-sid=' + ${JSON.stringify(SID)} + ']') && !!document.querySelector('.rail [data-id="chat"].on'); })()`, 2000);
          check('opening a conversation closes the automation page (kept mounted, hidden); the sidebar is the conversation list again, the rail on 对话', away && listBack, JSON.stringify({ away, listBack }));
          // 自动化 → 定时任务: 1 click when it is the tab shown last, 2 from another tab (spec §4.2: ≤ 2)
          let clicks = 0;
          const counted = async (sel) => { clicks++; return click(sel); };
          await counted(':is(.rail, .sidebar) [data-id="automation"]');
          const sched1 = await waitFor(`${autoTab('schedules')} && !!document.querySelector('.auto-page .auto-body[data-body="schedules"] .sched-view')`, 3000);
          check('自动化 → 定时任务 in 1 click (the tab shown last), the scheduled-task list on screen', sched1 && clicks === 1, await js(`JSON.stringify({ clicks: ${clicks}, tab: document.querySelector('.auto-page')?.dataset.tab, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) })`));
          await click(':is(.auto-page .auto-tabs, .sb-sect:not([hidden]) .auto-side .sect-nav) [data-id="goals"]');
          await key('Escape');
          const escClosed = await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          clicks = 0;
          await counted(':is(.rail, .sidebar) [data-id="automation"]');
          await counted(':is(.auto-page .auto-tabs, .sb-sect:not([hidden]) .auto-side .sect-nav) [data-id="schedules"]');
          const sched2 = await waitFor(autoTab('schedules'), 3000);
          check('Esc closes the page; from another tab 定时任务 is 2 clicks', escClosed && sched2 && clicks === 2, JSON.stringify({ escClosed, sched2, clicks }));
          await click(':is(.app.has-rail .rail [data-id="chat"], .app.mobile .auto-page .auto-head button[aria-label="关闭自动化"])');
          await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          // review 7 M1: Esc with the focus nowhere (on <body>, after a click on empty space) closes the page too, and
          // the focus goes back to the conversation's composer (it was under the page)
          await click(':is(.rail, .sidebar) [data-id="automation"]');
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
            await click(':is(.rail, .sidebar) [data-id="automation"]');
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
          await click(':is(.app.has-rail .rail [data-id="chat"], .app.mobile .auto-page .auto-head button[aria-label="关闭自动化"])');
          await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          await js(dockClosed);
          await sleep(300);
          // the account row: quota, today's spend, usage & ledger, the config panel, appearance, shortcuts, palette
          await click(':is(.rail, .sidebar) [data-id="account"]');
          const acc = await ids('.menu.sb-acct-menu [data-id]');
          check('account popover: 今日费用, 用量与账本, 配置中心, 外观, 快捷键, 命令面板', has(acc, ['today', 'usage', 'config', 'appearance', 'shortcuts', 'palette']), JSON.stringify(acc));
          await harvest();
          await shot('sidebar-account');
          // final review §9 #3: dark mode within two clicks — account → 深色 (the popover stays open to show it), and 设置 →
          // 外观 has the themes as swatches, not a dropdown
          if (E.SMOKE_READONLY !== '1') {
            const themeBefore = await js('JSON.stringify(window.__store.getState().settings["ui.theme"] ?? null)');
            const quick = await js(`[...document.querySelectorAll('.menu.sb-acct-menu [data-id="theme"] [role="radio"]')].map((b) => b.textContent)`);
            await click('.menu.sb-acct-menu [data-id="theme"] [data-theme-pick="dark"]');
            const dark = await waitFor(`document.documentElement.dataset.theme === 'dark' && window.__store.getState().settings['ui.theme'] === 'dark' && document.querySelector('.menu.sb-acct-menu [data-theme-pick="dark"]')?.getAttribute('aria-checked') === 'true'`, 2000);
            await click('.menu.sb-acct-menu [data-id="theme"] [data-theme-pick="light"]');
            const light = await waitFor(`document.documentElement.dataset.theme === 'light' && !!document.querySelector('.menu.sb-acct-menu')`, 2000);
            check('account → 深色 / 浅色: the theme in two clicks (浅色 / 深色 / 跟随系统), the popover stays open', JSON.stringify(quick) === JSON.stringify(['浅色', '深色', '跟随系统']) && dark && light, JSON.stringify({ quick, dark, light }));
            await closeMenus();
            await js(`window.__store.getState().openSettings({ section: 'appearance' })`);
            await waitFor(`!!document.querySelector('.sp [data-entry="ui.theme"] .theme-sw')`, 4000);
            const sw = await js(`(() => { const row = document.querySelector('.sp [data-entry="ui.theme"]'); return { select: !!row.querySelector('select'), picks: [...row.querySelectorAll('.theme-sw [role="radio"]')].map((b) => b.dataset.themePick), ascii: [...row.querySelectorAll('.theme-gallery [role="radio"]')].map((b) => b.dataset.themePick), make: !!row.querySelector('.theme-gallery [data-theme-new]'), on: row.querySelector('.theme-sw [aria-checked="true"]')?.dataset.themePick ?? null }; })()`);
            await click('.sp [data-entry="ui.theme"] [data-theme-pick="nord"]');
            const nord = await waitFor(`document.documentElement.dataset.theme === 'nord' && document.querySelector('.sp [data-entry="ui.theme"] [data-theme-pick="nord"]')?.getAttribute('aria-checked') === 'true'`, 2000);
            await shot('settings-appearance-themes');
            check('设置 → 外观: every theme is a swatch (跟随系统 first), no dropdown; a click applies it', !sw.select && sw.picks.length >= 7 && sw.picks[0] === 'system' && sw.on === 'light' && nord, JSON.stringify({ sw, nord }));
            // 字符画主题 (docs/notes/ascii-themes.md): the gallery above the classic swatches — ten built-in cards and 「描述一个新主题」;
            // the card under the pointer runs its backdrop (a worker canvas) and four process animations
            const ASCII = ['phosphor', 'abyss', 'koi', 'moon', 'dither', 'orb', 'garden', 'paper', 'letters', 'ink'];
            await js(`document.querySelector('.sp [data-entry="ui.theme"] [data-theme-pick="ascii:koi"]')?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })), document.querySelector('.sp [data-entry="ui.theme"] [data-theme-pick="ascii:koi"]')?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))`);
            const hoverLive = await waitFor(`!!document.querySelector('.sp [data-theme-pick="ascii:koi"] .preview-bd') && document.querySelectorAll('.sp [data-theme-pick="ascii:koi"] .tc-procs .pg').length === 4`, 3000);
            await shot('settings-appearance-gallery-hover');
            check('设置 → 外观: the ten character themes as cards, then 「描述一个新主题」; the card under the pointer runs its backdrop and four process animations', ASCII.every((id) => sw.ascii.includes(`ascii:${id}`)) && sw.make && hoverLive, JSON.stringify({ ascii: sw.ascii, make: sw.make, hoverLive }));
            // every built-in theme put on in turn: its palette on <html data-ascii>, over the classic theme of its brightness,
            // the welcome page's backdrop running in a worker (no console error from any of them: the run's tally says)
            const applied = [];
            for (const id of ASCII) {
              await click(`.sp [data-entry="ui.theme"] [data-theme-pick="ascii:${id}"]`);
              const ok = await waitFor(`document.documentElement.dataset.ascii === '${id}' && !!document.getElementById('cw-ascii-theme') && document.querySelector('.sp [data-theme-pick="ascii:${id}"]')?.getAttribute('aria-checked') === 'true'`, 2000);
              applied.push([id, ok, await js(`document.documentElement.dataset.theme`)]);
              await shot(`settings-ascii-${id}`);
            }
            const phosBg = await (async () => { await click('.sp [data-entry="ui.theme"] [data-theme-pick="ascii:phosphor"]'); return waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#060a07' && document.documentElement.dataset.theme === 'dark'`, 2000); })();
            const paperLight = await (async () => { await click('.sp [data-entry="ui.theme"] [data-theme-pick="ascii:paper"]'); return waitFor(`document.documentElement.dataset.theme === 'light'`, 2000); })();
            await click('.sp [data-entry="ui.theme"] [data-theme-pick="nord"]');
            const off = await waitFor(`!document.documentElement.dataset.ascii && !document.getElementById('cw-ascii-theme') && document.documentElement.dataset.theme === 'nord'`, 2000);
            check('设置 → 外观: each of the ten character themes puts its colours on (phosphor dark, paper light); a classic one takes them off', applied.every(([, ok]) => ok) && phosBg && paperLight && off, JSON.stringify({ applied, phosBg, paperLight, off }));
            // a theme of the user's own (what the theme skill saves: ~/.claude-web/themes/<id>/): the server watches the folder,
            // the window shows it as a card marked 我的, it goes on — its backdrop only after the page saw the worker's
            // no-network CSP — and right-click offers 改一改 / 删除; removed from the folder, the card goes
            let mine = null;
            if (E.SMOKE_DATA && E.SMOKE_READONLY !== '1') {
              const src = path.join(__dirname, '..', 'web', 'src', 'themes', 'builtin', 'phosphor');
              const dir = path.join(E.SMOKE_DATA, 'themes', 'smoke-mine');
              fs.mkdirSync(dir, { recursive: true });
              const j = JSON.parse(fs.readFileSync(path.join(src, 'theme.json'), 'utf8'));
              j.id = 'smoke-mine';
              j.name = { zh: '冒烟主题', en: 'Smoke theme' };
              fs.writeFileSync(path.join(dir, 'backdrop.js'), fs.readFileSync(path.join(src, 'backdrop.js')));
              fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify(j));
              const card = await waitFor(`!!document.querySelector('.sp [data-theme-pick="ascii:smoke-mine"] .tc-own')`, 5000);
              await click('.sp [data-entry="ui.theme"] [data-theme-pick="ascii:smoke-mine"]');
              const on = await waitFor(`document.documentElement.dataset.ascii === 'smoke-mine'`, 2000);
              await js(`window.__store.getState().openSettings({ section: 'appearance' })`);
              await js(`(() => { const b = document.querySelector('.sp [data-theme-pick="ascii:smoke-mine"]'); b?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); })()`);
              const menu = await waitFor(`[...document.querySelectorAll('.menu button')].map((b) => b.textContent.trim()).join('|').includes('改一改')`, 6000);
              await shot('settings-ascii-mine');
              await closeMenus();
              await click('.sp [data-entry="ui.theme"] [data-theme-pick="nord"]');
              fs.rmSync(dir, { recursive: true, force: true });
              const gone = await waitFor(`!document.querySelector('.sp [data-theme-pick="ascii:smoke-mine"]')`, 5000);
              mine = { card, on, menu, gone };
              check('a theme of the user\'s own: the folder appears as a card (我的), it goes on, right-click offers 改一改, removing the folder takes the card away', card && on && menu && gone, JSON.stringify(mine));
            }
            // 「描述一个新主题」: a new conversation whose input holds the ask for the ascii-theme skill
            const tilesNow = `(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); return Object.values(g.panes).flatMap((p) => p.tiles.map((t) => t.id)); })()`;
            const tilesBefore = await js(tilesNow);
            await click('.sp [data-entry="ui.theme"] [data-theme-new]');
            const maker = await waitFor(`!document.querySelector('.sp') && [...document.querySelectorAll('.composer textarea')].some((t) => t.value.startsWith('用 ascii-theme 帮我做一个字符画主题'))`, 4000);
            check('「描述一个新主题」 closes the settings and opens a new conversation with the ask typed in', maker, String(maker));
            // that new conversation goes again, and the smoke conversation is back in front (later checks use its header)
            const makerTiles = (await js(tilesNow)).filter((x) => !tilesBefore.includes(x));
            await js(`(() => { const st = window.__store.getState(); const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId); for (const p of Object.values(g.panes)) for (const t of p.tiles) if (${JSON.stringify(makerTiles)}.includes(t.id)) st.dispatchLayout({ t: 'tile.close', paneId: p.id, tileId: t.id }); })()`);
            await sleep(300);
            if (SID) await js(`window.__store.getState().openInPane(${SID}, 'replace')`);
            await js(`window.__store.getState().openSettings({ section: 'appearance' })`);
            await waitFor(`!!document.querySelector('.sp [data-entry="ui.theme"]')`, 4000);
            // 界面缩放 is the desktop shell's (desktop/src/zoom.ts; checked against the real shell by hand): this page is a
            // browser's, with no shell to keep the factor — the row is there and says so, with no control, and the factor is 1
            const zoomRow = await js(`(() => { const row = document.querySelector('.sp [data-entry="ui.zoom"]'); if (!row) return null; return { label: row.querySelector('.l')?.textContent ?? '', hint: row.querySelector('.sub')?.textContent ?? '', ctl: !!row.querySelector('.zoomer'), factor: getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim() }; })()`);
            check('设置 → 外观 → 界面缩放: the row is there; in a browser it has no control (the hint says to use the browser zoom) and the factor is 1', !!zoomRow && zoomRow.label === '界面缩放' && /浏览器自己的缩放/.test(zoomRow.hint) && !zoomRow.ctl && zoomRow.factor === '1', JSON.stringify(zoomRow));
            await js(`(() => { const st = window.__store.getState(); void st.setSetting('ui.theme', ${themeBefore}); window.__store.setState({ settingsOpen: null }); })()`);
            await sleep(300);
          }
          await closeMenus();
          // 账户 → 用量与账本 / 配置中心: two clicks to that right-panel tab
          for (const [item, label] of [['usage', '用量与账本'], ['config', '配置中心']]) {
            await js(dockClosed);
            await sleep(300);
            await click(':is(.rail, .sidebar) [data-id="account"]');
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
            const saved = await js('JSON.stringify({ limits: window.__store.getState().limits, sources: window.__store.getState().librarySources, checklist: window.__store.getState().settings["onboarding.checklist"] ?? null })');
            const limits = { ok: true, capturedAt: new Date(now).toISOString(), subscriptionType: 'max', windows: [{ label: '5 小时', percent: 34, resetsAt: new Date(now + 3600e3).toISOString(), active: true }] };
            const codex = { kind: 'codex', name: 'Codex', installed: true, detected: true, joined: false, dismissed: false, enabled: false };
            const installed = await js(`(() => {
              const st = window.__store, F = ${JSON.stringify(fakes)}, L = ${JSON.stringify(limits)}, C = ${JSON.stringify(codex)};
              // the newcomer checklist (the discovery hint waits for it): window.__cwSmokeChecklist, kept like the fakes
              window.__cwSmokeChecklist = { done: ['project'] };
              const apply = () => {
                const s = st.getState(), patch = {};
                const have = new Set(s.sessions.map((x) => x.sessionId));
                const add = F.filter((f) => !have.has(f.sessionId));
                if (add.length) patch.sessions = [...s.sessions, ...add];
                if (s.limits !== L) patch.limits = L;
                if (!s.librarySources.includes(C)) patch.librarySources = [...s.librarySources.filter((x) => x.kind !== C.kind), C];
                if (s.settings['onboarding.checklist'] !== window.__cwSmokeChecklist) patch.settings = { ...s.settings, 'onboarding.checklist': window.__cwSmokeChecklist };
                if (Object.keys(patch).length) st.setState(patch);
              };
              window.__cwSmokeFakesApply = apply;
              if (window.__cwSmokeFakesOff) window.__cwSmokeFakesOff();
              let busy = false;
              const off = st.subscribe((s, prev) => {
                if (busy || (s.sessions === prev.sessions && s.limits === prev.limits && s.librarySources === prev.librarySources && s.settings === prev.settings)) return;
                busy = true;
                try { apply(); } finally { busy = false; }
              });
              window.__cwSmokeFakesOff = () => { off(); window.__cwSmokeFakesOff = null; };
              apply();
              return true;
            })()`);
            check('sidebar scenarios: fakes installed (kept by a store subscription while they run)', installed);
            await sleep(400);
            // final review §9 #5: the discovery hint waits while the newcomer checklist is still on the home page…
            const hintEarly = await exists('.sidebar .sb-hint');
            // …while the home page shows it under the checklist (user report: a newcomer who came for Codex found no way to it)
            const homeEarly = await js(`(() => ({ home: !!document.querySelector('.welcome'), hint: !!document.querySelector('.welcome .home-hint .msg'), ids: document.querySelectorAll('.welcome .home-hint [data-id]').length }))()`);
            // …but not forever (re-review M-7): 3 days after the list first showed (`since`) it comes anyway
            await js(`(() => { window.__cwSmokeChecklist = { done: ['project'], since: Date.now() - 86400e3 }; window.__cwSmokeFakesApply(); })()`);
            await sleep(300);
            const hintDay = await exists('.sidebar .sb-hint');
            await js(`(() => { window.__cwSmokeChecklist = { done: ['project'], since: Date.now() - 4 * 86400e3 }; window.__cwSmokeFakesApply(); })()`);
            const hintAged = await waitFor(`!!document.querySelector('.sidebar .sb-hint')`, 2000);
            check('library hint: an unfinished checklist shown a day ago still holds it back; one shown 4 days ago no longer does (re-review M-7)', !hintDay && hintAged, JSON.stringify({ hintDay, hintAged }));
            await js(`(() => { window.__cwSmokeChecklist = { done: ['project'], dismissed: true }; window.__cwSmokeFakesApply(); })()`);
            await sleep(300);
            await harvest();
            // (this machine may have its own detected tools too — e.g. OpenCode's data folder — so the words follow the list)
            const hintNow = await js(`(() => { const m = document.querySelector('.sidebar .sb-hint .msg'); const names = window.__store.getState().librarySources.filter((x) => x.kind !== 'claude' && x.detected && !x.joined && !x.dismissed).map((x) => x.name); return { msg: m?.textContent ?? null, title: m?.title ?? '', names }; })()`);
            const hintWant = hintNow.names.length === 1 ? `把 ${hintNow.names[0]} 里的对话也列在这里？` : `把 ${hintNow.names[0]} 等工具里的对话也列在这里？`;
            const homeLate = await exists('.welcome .home-hint');
            check('library hint on the home page: there while the checklist holds the sidebar one back (no sidebar ids), gone once the sidebar has it', !homeEarly.home || (homeEarly.hint && homeEarly.ids === 0 && !homeLate), JSON.stringify({ homeEarly, homeLate }));
            check('library hint: not while the newcomer checklist is on; once it is closed, one plain question (把 Codex 里的对话也列在这里？ · 列出来 / 以后再说)', !hintEarly && hintNow.msg === hintWant && hintNow.title.includes('Codex') && await exists('.sidebar .sb-hint [data-id="library-join"]') && await exists('.sidebar .sb-hint [data-id="library-later"]'), JSON.stringify({ hintEarly, hintNow, hintWant }));
            // several agents' names wrap onto a second line instead of being cut off; the full text is the tooltip
            await js(`(() => { const names = { opencode: 'OpenCode', gemini: 'Gemini CLI', qwen: 'Qwen Code' }; const extra = Object.keys(names).map((k) => ({ kind: k, name: names[k], installed: true, detected: true, joined: false, dismissed: false, enabled: false })); const st = window.__store.getState(); window.__store.setState({ librarySources: [...st.librarySources.filter((x) => !names[x.kind]), ...extra] }); })()`);
            await sleep(300);
            // the leading name is whatever this machine detected first (DeepSeek Harness and friends join Codex on a
            // machine that has them), so the expected sentence is computed from the list, not hard-coded
            const hintFit = await js(`(() => { const m = document.querySelector('.sidebar .sb-hint .msg'); if (!m) return null; const lh = parseFloat(getComputedStyle(m).lineHeight); const j = document.querySelector('.sidebar .sb-hint [data-id="library-join"]').getBoundingClientRect(); const h = document.querySelector('.sidebar .sb-hint').getBoundingClientRect(); const names = window.__store.getState().librarySources.filter((x) => x.kind !== 'claude' && x.detected && !x.joined && !x.dismissed).map((x) => x.name); return { text: m.textContent, names, want: names.length === 1 ? \`把 \${names[0]} 里的对话也列在这里？\` : \`把 \${names[0]} 等工具里的对话也列在这里？\`, lines: Math.round(m.clientHeight / lh), clipped: m.scrollHeight > m.clientHeight + 1, title: m.title.includes('Qwen Code'), joinInside: j.right <= h.right && j.width > 10 }; })()`);
            check('library hint: several agents → 「把 <first> 等工具里的对话也列在这里？」, not cut off (up to three lines), every name in the tooltip; 选择… stays whole', !!hintFit && hintFit.text === hintFit.want && !hintFit.clipped && hintFit.lines <= 3 && hintFit.title && hintFit.joinInside, JSON.stringify(hintFit));
            await shot('sidebar-hint-wrap');
            // 文件夹 (2026-10-14): every folder its own group, open — the running conversation is listed in its folder's
            // group, which offers 在这里新建对话 and 设为项目
            const other = { row: await exists('.sidebar [data-id="other"] > .sb-group [data-sid="smoke-elsewhere"] .st.run'), acts: await exists('.sidebar [data-id="other"] > .sb-group .acts [data-id="make-project"]') && await exists('.sidebar [data-id="other"] > .sb-group .acts [data-id="new-here"]'), fold: await exists('.sidebar [data-id="other"] > .sb-sec-h[role="button"]') };
            check('文件夹: the running conversation sits open in its own folder group (no fold over the section), 新建 / 设为项目 on the folder', other.row && other.acts && !other.fold, JSON.stringify(other));
            await harvest();
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
            await click('.sidebar [data-id="view"]');
            await waitFor('!!document.querySelector(".menu.sb-view")', 2000);
            await harvest();
            check('funnel menu: 机器 once another machine has conversations', await exists('.menu.sb-view [data-id="machine"]'));
            await closeMenus();
            // 显示已归档 widens the list, it is not a filter: no 已筛选 row, empty projects stay, the funnel shows it is on
            await js(`window.__store.getState().addWorkspace(${JSON.stringify(E.SMOKE_REPO + sep + 'src')})`);
            await waitFor('window.__store.getState().workspaces.length >= 2', 4000);
            await js('window.__store.setState({ showArchived: true })');
            await sleep(300);
            const arch = { row: await exists('.sidebar .sb-filtered'), dot: await exists('.sidebar [data-id="view"] .fdot'), groups: await count('.sidebar [data-id="projects"] .sb-group'), projects: await js('window.__store.getState().workspaces.length') };
            check('显示已归档 is not a filter: no 已筛选 row, empty projects stay listed, the funnel is marked', !arch.row && arch.dot && arch.groups === arch.projects, JSON.stringify(arch));
            await js('window.__store.setState({ showArchived: false })');
            // two projects now: the lower one's menu moves it up / to the top, the upper one's down (2026-10-14)
            {
              const heads = '.sidebar [data-id="projects"] .sb-group > .sb-group-head';
              const order = () => js(`[...document.querySelectorAll('${heads} .name')].map((e) => e.textContent).join('|')`);
              const before = await order();
              await js(`[...document.querySelectorAll('${heads}')].at(-1).querySelector('[aria-label="项目菜单"]').click()`);
              await waitFor('!!document.querySelector(".menu [data-id=\\"move-up\\"]")', 2000);
              await harvest();
              await click('.menu [data-id="move-top"]');
              await sleep(500);
              const moved = await order();
              await js(`document.querySelector('${heads} [aria-label="项目菜单"]').click()`);
              await waitFor('!!document.querySelector(".menu [data-id=\\"move-down\\"]")', 2000);
              await harvest();
              await click('.menu [data-id="move-down"]');
              await sleep(500);
              const back = await order();
              const draggable = await js(`document.querySelector('${heads}')?.getAttribute('draggable')`);
              check('projects reorder: 移到最上面 puts the last first, 下移 puts it back; the headers can be dragged', moved.split('|')[0] === before.split('|').at(-1) && back === before && draggable === 'true', JSON.stringify({ before, moved, back, draggable }));
            }
            // stage C3: the 显示 menu — 分组方式 / 排序 / 每组 / 其它 agent / 显示已归档 change the list at once (the menu
            // stays open), 新建分区 + a row dragged in (still in its own group too) + × takes it out, 恢复默认 keeps the
            // sections, 查看全部 opens the palette
            {
              const viewKey = 'ui.sidebar.view';
              const viewNow = () => js(`JSON.stringify(window.__store.getState().settings[${JSON.stringify(viewKey)}] ?? null)`);
              const openView = async () => { if (!(await exists('.menu.sb-view:not(.leaving)'))) await click('.sidebar [data-id="view"]'); await waitFor('!!document.querySelector(".menu.sb-view:not(.leaving)")', 2000); };
              const pickIn = async (row, label) => {
                await openView();
                if (!(await js(`document.querySelector('.menu.sb-view [data-id="${row}"]')?.getAttribute('aria-expanded') === 'true'`))) await click(`.menu.sb-view [data-id="${row}"]`);
                await js(`[...document.querySelectorAll('.menu.sb-view .sb-view-sub [role="menuitemradio"]')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`);
                await sleep(350);
              };
              const projSec = '.sidebar [data-id="projects"]';
              await pickIn('group-by', '文件夹');
              const byFolder = { other: await exists('.sidebar [data-id="other"]'), title: await js(`document.querySelector('${projSec} > .sb-sec-h > span')?.textContent`), groups: await count(`${projSec} .sb-group`), view: JSON.parse(await viewNow())?.groupBy, menu: await exists('.menu.sb-view:not(.leaving)') };
              await harvest();
              await pickIn('group-by', '日期');
              const dateNames = await js(`[...document.querySelectorAll('${projSec} .sb-group.date > .sb-group-head .name')].map((e) => e.textContent)`);
              await pickIn('group-by', '不分组');
              const flat = { heads: await count(`${projSec} .sb-group-head`), flat: await exists(`${projSec} .sb-group.flat`), rows: await count(`${projSec} .sb-group.flat .sb-row`) };
              await pickIn('sort-by', '名称');
              const titles = await js(`[...document.querySelectorAll('${projSec} .sb-group.flat .sb-row:not(.kid) .t')].map((e) => e.textContent)`);
              const sortedOk = titles.length > 1 && titles.every((t, i) => i === 0 || titles[i - 1].toLocaleLowerCase().localeCompare(t.toLocaleLowerCase(), undefined, { numeric: true }) <= 0);
              await pickIn('sort-by', '最近更新');
              await pickIn('group-by', '项目');
              check('显示 → 分组方式: 文件夹 (no 项目 / 文件夹 split, the head says 对话), 日期 (今天 …), 不分组 (one flat list, no group heads); 排序 名称 orders the rows; the menu stays open',
                !byFolder.other && byFolder.title === '对话' && byFolder.groups > 0 && byFolder.view === 'folder' && byFolder.menu && dateNames.length > 0 && dateNames.every((n) => ['今天', '昨天', '最近 7 天', '最近 30 天', '更早'].includes(n)) && flat.heads === 0 && flat.flat && flat.rows > 0 && sortedOk,
                JSON.stringify({ byFolder, dateNames, flat, titles, sortedOk }));
              // 每组: the other machine's 7 conversations — 5, then all 7 with 10
              const peerRows = () => count('.sidebar [data-group="peer:smokepeer"] .sb-row');
              const five = await peerRows();
              await pickIn('per-group', '10');
              const ten = await peerRows();
              const lessShown = await exists('.sidebar [data-group="peer:smokepeer"] [data-id="less"]');
              await pickIn('per-group', '5');
              check('显示 → 每组 10 shows more rows of a group (5 → 7), no 收起 at its own limit', five === 5 && ten === 7 && !lessShown, JSON.stringify({ five, ten, lessShown }));
              // 其它 agent 的对话: a Codex conversation leaves the list and comes back
              await js(`window.__store.setState((s) => ({ sessions: [...s.sessions.filter((x) => x.sessionId !== 'smoke-codex-row'), { sessionId: 'smoke-codex-row', title: 'a codex conversation', cwd: ${JSON.stringify(E.SMOKE_REPO)}, lastModified: Date.now() - 200, agent: 'codex' }] }))`);
              await sleep(300);
              const codexRow = '.sidebar .sb-list [data-sid="smoke-codex-row"]';
              await pickIn('group-by', '不分组'); // one open list: the row is on screen whatever folder it is in
              const codexOn = await exists(codexRow);
              await openView();
              await click('.menu.sb-view [data-id="other-agents"]');
              await sleep(300);
              const codexOff = !(await exists(codexRow));
              const otherFlag = JSON.parse(await viewNow())?.show?.otherAgents;
              await click('.menu.sb-view [data-id="other-agents"]');
              await sleep(300);
              const codexBack = await exists(codexRow);
              await js(`window.__store.setState((s) => ({ sessions: s.sessions.filter((x) => x.sessionId !== 'smoke-codex-row') }))`);
              await pickIn('group-by', '项目');
              check('显示 → 其它 agent 的对话 off hides a Codex conversation, on brings it back (kept in ui.sidebar.view)', codexOn && codexOff && otherFlag === false && codexBack, JSON.stringify({ codexOn, codexOff, otherFlag, codexBack }));
              // 显示已归档: the store and meta.json
              await openView();
              await click('.menu.sb-view [data-id="archived"]');
              await sleep(300);
              const archOn = { store: await js('window.__store.getState().showArchived'), saved: JSON.parse(await viewNow())?.show?.archived, checked: await js(`document.querySelector('.menu.sb-view [data-id="archived"]')?.getAttribute('aria-checked')`) };
              await click('.menu.sb-view [data-id="archived"]');
              await sleep(300);
              const archOff = { store: await js('window.__store.getState().showArchived'), saved: JSON.parse(await viewNow())?.show?.archived };
              check('显示 → 显示已归档 sets the store and is kept in ui.sidebar.view; off again', archOn.store === true && archOn.saved === true && archOn.checked === 'true' && archOff.store === false && archOff.saved === false, JSON.stringify({ archOn, archOff }));
              // 新建分区: named in the dialog, a row dropped on its header, × takes it out
              await openView();
              await click('.menu.sb-view [data-id="new-section"]');
              const asked = await waitFor('!!document.querySelector(".dialog-bg .dialog input.field")', 3000);
              wc.insertText('本周要交');
              await sleep(150);
              await js(`document.querySelector('.dialog-bg .dialog .actions .btn.primary')?.click()`);
              const made = await waitFor(`[...document.querySelectorAll('.sidebar .sb-custom > .sb-sec-h .name')].some((e) => e.textContent === '本周要交')`, 3000);
              const sid0 = await js(`(() => { const r = document.querySelector('${projSec} .sb-row[data-sid]') || document.querySelector('.sidebar .sb-list .sb-row[data-sid]'); return r ? r.dataset.sid : null; })()`);
              const dropped = await js(`(() => { const h = document.querySelector('.sidebar .sb-custom [data-id="custom-section"]'); if (!h) return false; const dt = new DataTransfer(); dt.setData('application/x-cw-session', ${JSON.stringify(sid0)}); h.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); h.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
              const inBoth = await waitFor(`!!document.querySelector('.sidebar .sb-custom [data-sid="${sid0}"]') && document.querySelectorAll('.sidebar .sb-list [data-sid="${sid0}"]').length >= 2`, 3000);
              await harvest();
              const secMenu = await js(`(() => { const b = document.querySelector('.sidebar .sb-custom [aria-label="分区菜单"]'); if (!b) return false; b.click(); return true; })()`) && await waitFor('!!document.querySelector(".menu.sb-custom-menu [data-id=\\"custom-rename\\"]")', 2000);
              await harvest();
              await closeMenus();
              await js(`document.querySelector('.sidebar .sb-custom [data-sid="${sid0}"]')?.closest('.sb-row-wrap')?.querySelector('[data-id="custom-out"]')?.click()`);
              const out = await waitFor(`!document.querySelector('.sidebar .sb-custom [data-sid="${sid0}"]') && !!document.querySelector('.sidebar .sb-list [data-sid="${sid0}"]')`, 3000);
              const sections = JSON.parse(await js(`JSON.stringify(window.__store.getState().settings['ui.sidebar.sections'] ?? null)`));
              check('新建分区 (named in the dialog) sits above the groups; a row dropped on it is there and in its own group too; × takes it out; kept in ui.sidebar.sections', asked && made && !!sid0 && dropped && inBoth && secMenu && out && Array.isArray(sections) && sections.some((x) => x.name === '本周要交' && Array.isArray(x.ids) && x.ids.length === 0), JSON.stringify({ asked, made, sid0, dropped, inBoth, secMenu, out, sections }));
              // stage C fix wave C-U3: no drag needed — the row menu's 加入分区「…」 / 移出分区「…」 and the multi-select bar's
              // 加入分区; the section's heading folds with a real button (C-U4)
              const inSec = `!!document.querySelector('.sidebar .sb-custom [data-sid="${sid0}"]')`;
              await ctxMenu(`${projSec} [data-sid="${sid0}"]`);
              const addItem = await waitFor('!!document.querySelector(".menu.sess-menu [data-id=\\"section-add\\"]")', 2000);
              const addLabel = await js(`document.querySelector('.menu.sess-menu [data-id="section-add"]')?.textContent?.trim() ?? null`);
              await harvest();
              await click('.menu.sess-menu [data-id="section-add"]');
              const addedByMenu = await waitFor(inSec, 3000);
              await closeMenus();
              await ctxMenu(`.sidebar .sb-custom [data-sid="${sid0}"]`);
              const outItem = await waitFor('!!document.querySelector(".menu.sess-menu [data-id=\\"section-out\\"]")', 2000);
              await harvest();
              await click('.menu.sess-menu [data-id="section-out"]');
              const outByMenu = await waitFor(`!(${inSec})`, 3000);
              await closeMenus();
              await openView();
              await click('.menu.sb-view [data-id="select"]');
              await waitFor('!!document.querySelector(".sidebar .sel-bar")', 2000);
              await js(`document.querySelector('${projSec} [data-sid="${sid0}"]')?.click()`);
              const barBtn = await waitFor('!!document.querySelector(".sidebar .sel-bar [data-id=\\"select-section\\"]")', 2000);
              await click('.sidebar .sel-bar [data-id="select-section"]');
              await waitFor('!!document.querySelector(".menu [data-section]")', 2000);
              await harvest();
              await js(`[...document.querySelectorAll('.menu [data-section]')].find((b) => b.textContent.trim() === '本周要交')?.click()`);
              const addedByBar = await waitFor(`${inSec} && !document.querySelector('.sidebar .sel-bar')`, 3000);
              const head = await js(`(() => { const h = document.querySelector('.sidebar .sb-custom > .sb-sec-h'); const t = h?.querySelector('button.sb-sec-t'); return { role: h?.getAttribute('role') ?? null, btn: !!t, expanded: t?.getAttribute('aria-expanded') ?? null, nested: !!t?.querySelector('button') }; })()`);
              await js(`document.querySelector('.sidebar .sb-custom [data-sid="${sid0}"]')?.closest('.sb-row-wrap')?.querySelector('[data-id="custom-out"]')?.click()`);
              await waitFor(`!(${inSec})`, 3000);
              check('C-U3: row menu 加入分区「本周要交」 puts it in, 移出分区「本周要交」 there takes it out; 选择多个 → 加入分区 → 本周要交 adds the picked and ends the selection; the heading folds with its own button (C-U4)',
                addItem && /本周要交/.test(addLabel || '') && addedByMenu && outItem && outByMenu && barBtn && addedByBar && head.role === null && head.btn && head.expanded === 'true' && !head.nested, JSON.stringify({ addItem, addLabel, addedByMenu, outItem, outByMenu, barBtn, addedByBar, head }));
              // 恢复默认: back to the defaults (and 显示已归档 off), the section stays; 查看全部 opens the palette
              await pickIn('group-by', '日期');
              await openView();
              await click('.menu.sb-view [data-id="reset"]');
              await sleep(300);
              const reset = { view: JSON.parse(await viewNow()), archived: await js('window.__store.getState().showArchived'), section: await exists('.sidebar .sb-custom'), other: await exists('.sidebar [data-id="other"]') || await exists(`${projSec} .sb-group`) };
              await openView();
              await click('.menu.sb-view [data-id="all"]');
              const palette = await waitFor('window.__store.getState().paletteOpen === true', 2000);
              await js('window.__store.setState({ paletteOpen: false })');
              await sleep(200);
              check('显示 → 恢复默认: 项目 / 最近更新 / 5, archived off, own sections kept; 查看全部 opens the command palette',
                !!reset.view && reset.view.groupBy === 'project' && reset.view.sortBy === 'updated' && reset.view.show.perGroup === 5 && reset.view.show.otherAgents === true && reset.archived === false && reset.section && palette, JSON.stringify({ reset, palette }));
              // remove the section again (its menu → 删除分区 → confirm)
              await js(`document.querySelector('.sidebar .sb-custom [aria-label="分区菜单"]')?.click()`);
              await waitFor('!!document.querySelector(".menu.sb-custom-menu [data-id=\\"custom-delete\\"]")', 2000);
              await click('.menu.sb-custom-menu [data-id="custom-delete"]');
              await waitFor('!!document.querySelector(".dialog-bg .dialog .actions .btn.danger")', 2000);
              await js(`document.querySelector('.dialog-bg .dialog .actions .btn.danger')?.click()`);
              check('删除分区 (after a confirm) removes the section, the conversations stay', await waitFor('!document.querySelector(".sidebar .sb-custom")', 3000) && !!(await exists('.sidebar .sb-list .sb-row')));
              await closeMenus();
            }
            // the account popover with the account's limits: the quota windows
            await click(':is(.rail, .sidebar) [data-id="account"]');
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
            await js(`(() => { const ids = new Set(${JSON.stringify(fakes.map((f) => f.sessionId))}); const r = JSON.parse(${JSON.stringify(saved)}); window.__store.setState((s) => { const settings = { ...s.settings }; if (r.checklist === null) delete settings['onboarding.checklist']; else settings['onboarding.checklist'] = r.checklist; return { sessions: s.sessions.filter((x) => !ids.has(x.sessionId)), limits: r.limits, librarySources: r.sources, settings }; }); window.__cwSmokeFakesApply = null; })()`);
            // nothing is reachable only in the table: every id of every place was on screen
            const missing = [];
            for (const p of Object.keys(PLACES)) for (const id of PLACES[p]) if (!(seen[p] && seen[p].has(id))) missing.push(p + ':' + id);
            check(`sidebar entries: all ${Object.values(PLACES).reduce((n, v) => n + v.length, 0)} ids of entries.ts PLACES were found in the DOM, each in its place`, !missing.length, missing.join(', '));
          }
        }
      }

      // ---- structure round 2 (spec 2026-10-10-ui-structure): the rail's ··· menu and its pins, the 扩展 page, and 浏览器
      // in the right panel (here the web app's: pages are <iframe>s; the real one is scripts/browser-smoke.cjs)
      if (E.SMOKE_READONLY !== '1') {
        phase = 'structure';
        win.setContentSize(1360, 860);
        await waitFor('innerWidth === 1360', 4000);
        await js(`(() => { document.documentElement.classList.remove('desktop', 'win'); window.__store.setState({ sidebarOpen: true, settingsOpen: null }); const st = window.__store.getState(); st.setSetting('ui.workbench', false); })()`);
        await sleep(500);
        // ··· on the rail: the panels that are neither a fixed tab of the right panel nor a section
        await click('.rail [data-id="more"]');
        const moreRows = (await waitFor(`document.querySelectorAll('.menu.rail-menu [data-id^="open-"]').length === 7`, 3000)) && await js(`[...document.querySelectorAll('.menu.rail-menu [data-id^="open-"]')].map((b) => b.dataset.id.slice(5)).join(',')`);
        const hints = await js(`[...document.querySelectorAll('.menu.rail-menu .rm-t .h')].every((h) => h.scrollWidth <= h.clientWidth + 1)`);
        check('rail ···: 总览 · 网吧 · 用量 · 记忆 · Issue 与 PR · Android · 配置中心, each with one line that is not cut off', moreRows === 'mission,cafe,usage,memory,board,android,config' && hints, JSON.stringify({ moreRows, hints }));
        await shot('rail-more');
        await js(`document.querySelector('.menu.rail-menu [data-id="pin-usage"]').click()`);
        const pinned = await waitFor(`!!document.querySelector('.rail [data-id="panel-usage"]') && JSON.stringify(window.__store.getState().settings['ui.railPins']) === '["usage"]'`, 3000);
        check('pinning 用量 puts its button on the rail (meta.json ui.railPins)', pinned, JSON.stringify(await js(`window.__store.getState().settings['ui.railPins']`)));
        await key('Escape');
        await waitFor(`!document.querySelector('.menu.rail-menu')`, 2000);
        await click('.rail [data-id="panel-usage"]');
        const usageOpen = await waitFor(`!!document.querySelector('.dock .dock-panel[data-panel="usage"]:not([hidden])')`, 5000);
        check('the pinned button opens its panel in the right panel', usageOpen);
        await click('.rail [data-id="more"]');
        await waitFor(`!!document.querySelector('.menu.rail-menu [data-id="pin-usage"]')`, 2000);
        await js(`document.querySelector('.menu.rail-menu [data-id="pin-usage"]').click()`);
        const unpinned = await waitFor(`!document.querySelector('.rail [data-id="panel-usage"]')`, 3000);
        check('unpinning takes it off the rail again', unpinned);
        await key('Escape');
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.close', panel: 'usage', workbench: false })`);
        await sleep(200);

        // 扩展: the connector directory on a page; its three parts are the sidebar's rows
        await click('.rail [data-id="extensions"]');
        const extUp = await waitFor(`!!document.querySelector('.ext-page:not([hidden]) .ext-body[data-body="connectors"] .cx-grid .cx-row')`, 10_000);
        const extInfo = await js(`({ rows: document.querySelectorAll('.ext-page .ext-body[data-body="connectors"] [data-id="directory"] .cx-row, .ext-page .ext-body[data-body="connectors"] .cx-grid .cx-row').length, side: [...document.querySelectorAll('.sb-sect:not([hidden]) .ext-side .sect-nav [data-id]')].map((b) => b.dataset.id).join(','), title: document.querySelector('.ext-page .over-title h2')?.textContent, marks: document.querySelectorAll('.ext-page .tile-ic svg').length, railOn: !!document.querySelector('.rail [data-id="extensions"].on'), tabs: !!document.querySelector('.ext-page .over-tabs'), close: (() => { const c = document.querySelector('.ext-page .over-close'); return !!c && c.getClientRects().length > 0; })() })`);
        check('扩展 opens a page: the connector directory (each with its mark), the three parts as the sidebar\'s rows — no second tab row, no × beside the rail', extUp && extInfo.rows >= 20 && extInfo.marks >= 20 && extInfo.side === 'connectors,skills,plugins' && extInfo.title === '连接器' && extInfo.railOn && !extInfo.tabs && !extInfo.close, JSON.stringify(extInfo));
        const centred = await js(`(() => { const p = document.querySelector('.ext-page').getBoundingClientRect(); const h = document.querySelector('.ext-page .over-head-in').getBoundingClientRect(); const b = document.querySelector('.ext-page .ext-body[data-body="connectors"] > *').getBoundingClientRect(); return { head: Math.round((h.left + h.right) / 2 - (p.left + p.right) / 2), body: Math.round((b.left + b.right) / 2 - (p.left + p.right) / 2), same: Math.abs(h.left - b.left) <= 1 && Math.abs(h.right - b.right) <= 1 }; })()`);
        check('…its column sits in the middle of the card, the title row over the same edges', Math.abs(centred.head) <= 1 && Math.abs(centred.body) <= 6 && centred.same, JSON.stringify(centred));
        await shot('extensions-connectors');
        // 连接器 → 编辑 (2026-10-30): the seeded smoke-edit server; the credential comes masked, a renamed masked row
        // keeps its value, the edited variable and command land in ~/.claude.json
        if (E.SMOKE_DATA && E.SMOKE_READONLY !== '1') {
          const home = path.dirname(E.SMOKE_DATA);
          const rowSel = `.ext-page .cx-row[data-name="smoke-edit"]`;
          const rowUp = await waitFor(`!!document.querySelector('${rowSel} [data-act="edit"]')`, 90_000);
          await js(`document.querySelector('${rowSel} [data-act="edit"]')?.click()`);
          const formUp = await waitFor(`!!document.querySelector('.mcp-edit [data-field="command"]')`, 10_000);
          const form = await js(`(() => { const d = document.querySelector('.mcp-edit'); const pairs = [...d.querySelectorAll('.mcp-edit-pair')].map((p) => [...p.querySelectorAll('input')].map((i) => i.value)); return { cmd: d.querySelector('[data-field="command"]').value, args: d.querySelector('[data-field="args"]').value, pairs, leak: /smoke-secret/.test(d.innerHTML) }; })()`);
          check('连接器 → 编辑 opens the server\'s form: command, args, env with the credential masked (its value not in the page)', rowUp && formUp && form.cmd === 'smoke-old.exe' && form.args === '--mcp' && JSON.stringify(form.pairs) === JSON.stringify([['SMOKE_API_KEY', '••••••'], ['SMOKE_HOME', 'D:/old']]) && !form.leak, JSON.stringify(form));
          await shot('connector-edit');
          await js(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }; const d = document.querySelector('.mcp-edit'); set(d.querySelector('[data-field="command"]'), 'C:/Pencil/new.exe'); const rows = d.querySelectorAll('.mcp-edit-pair'); set(rows[0].querySelectorAll('input')[0], 'SMOKE_RENAMED_KEY'); set(rows[1].querySelectorAll('input')[1], 'E:/new'); })()`);
          await js(`[...document.querySelectorAll('.mcp-edit .actions .btn')].find((b) => b.classList.contains('primary'))?.click()`);
          const closed = await waitFor(`!document.querySelector('.mcp-edit')`, 60_000);
          let saved = null;
          try { saved = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers?.['smoke-edit']; } catch { /* checked below */ }
          check('…保存 writes it back: the new command and variable, the renamed credential keeps its value, no mask on disk', closed && saved?.command === 'C:/Pencil/new.exe' && saved?.env?.SMOKE_RENAMED_KEY === 'smoke-secret-1' && saved?.env?.SMOKE_HOME === 'E:/new' && !('SMOKE_API_KEY' in (saved?.env ?? {})) && !JSON.stringify(saved).includes('••'), JSON.stringify(saved));
          // 从其它工具导入: the Pencil copy ticked, the gone one tagged and not ticked
          await js(`document.querySelector('.ext-page [data-act="import"]')?.click()`);
          const impUp = await waitFor(`!!document.querySelector('.import-dialog .imp-group[data-from="pencil"]')`, 20_000);
          const imp = await js(`(() => { const row = (from) => document.querySelector('.import-dialog .imp-group[data-from="' + from + '"] .imp-row'); const p = row('pencil'), g = row('gemini'); return { pencil: p && { on: p.querySelector('input').checked, name: p.querySelector('.nm').textContent }, gone: g && { on: g.querySelector('input').checked, tag: g.querySelector('.tag.warn')?.textContent } }; })()`);
          check('导入: Pencil\'s own copy is found and ticked; a server whose program is gone is tagged 程序不在了 and not ticked', impUp && imp.pencil?.on === true && imp.pencil?.name === 'pencil' && imp.gone?.on === false && imp.gone?.tag === '程序不在了', JSON.stringify(imp));
          await shot('connector-import');
          await js(`(() => { const d = document.querySelector('.import-dialog'); d?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
          await waitFor(`!document.querySelector('.import-dialog')`, 3000);
        }
        await js(`(() => { const i = document.querySelector('.ext-page .cx-search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'github'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        const narrowed = await waitFor(`(() => { const n = document.querySelectorAll('.ext-page .ext-body[data-body="connectors"] .cx-grid .cx-row').length; return n >= 1 && n <= 4; })()`, 3000);
        check('…searching narrows the directory', narrowed, String(await js(`document.querySelectorAll('.ext-page .ext-body[data-body="connectors"] .cx-grid .cx-row').length`)));
        await js(`(() => { const i = document.querySelector('.ext-page .cx-search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await click('.sb-sect:not([hidden]) .ext-side [data-id="skills"]');
        const skillsUp = await waitFor(`document.querySelector('.ext-page')?.dataset.tab === 'skills' && !!document.querySelector('.ext-page .ext-body[data-body="skills"]:not([hidden]) .cx') && document.querySelector('.ext-page .over-title h2')?.textContent === 'Skills'`, 8000);
        await shot('extensions-skills');
        await click('.sb-sect:not([hidden]) .ext-side [data-id="plugins"]');
        const pluginsUp = await waitFor(`document.querySelector('.ext-page')?.dataset.tab === 'plugins' && !!document.querySelector('.ext-page .ext-body[data-body="plugins"]:not([hidden]) [data-id="install"]')`, 8000);
        await sleep(1200);
        const extErr = await noBoundary('.ext-page');
        check('Skills and 插件 are its other two parts; each is mounted when first shown and the three stay', skillsUp && pluginsUp && !extErr && (await js(`document.querySelectorAll('.ext-page .ext-body').length`)) === 3, extErr || JSON.stringify({ skillsUp, pluginsUp }));
        await shot('extensions-plugins');
        await key('Escape');
        const extClosed = await waitFor(`document.querySelector('.ext-page')?.hidden === true && !!document.querySelector('.rail [data-id="chat"].on') && !document.querySelector('.sb-sect:not([hidden]) .ext-side')`, 3000);
        check('Esc leaves the page: 对话 is in front again, with its own sidebar', extClosed);

        // 浏览器: the right panel's fifth fixed tab
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'browser' })`);
        const bwUp = await waitFor(`!!document.querySelector('.dock .tab.fixed.active[data-panel="browser"]') && !!document.querySelector('.dock-panel[data-panel="browser"]:not([hidden]) .bw .bw-newtab .bw-search input')`, 6000);
        check('右侧面板 → 浏览器: a new tab with its own page (a search box); one tab, so no tab row', bwUp && !(await js(`!!document.querySelector('.bw .bw-tabs')`)));
        await shot('browser-newtab');
        await js(`(() => { const i = document.querySelector('.bw .bw-addr input'); i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'about:blank'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await key('Enter');
        const framed = await waitFor(`!!document.querySelector('.bw .bw-view.page iframe') && !!document.querySelector('.bw .bw-hint') && !document.querySelector('.bw .bw-newtab')`, 4000);
        check('an address opens the page — in the web app an <iframe>, with the sentence about what cannot be embedded', framed);
        await click('.bw [data-id="new-tab"]');
        const twoTabs = await waitFor(`document.querySelectorAll('.bw .bw-tabs .bw-tab').length === 2 && !!document.querySelector('.bw .bw-view:not(.back) .bw-newtab')`, 3000);
        await js(`document.querySelector('.bw .bw-tabs .bw-tab.on .x').click()`);
        const oneTab = await waitFor(`!document.querySelector('.bw .bw-tabs') && !!document.querySelector('.bw .bw-view.page:not(.back) iframe')`, 3000);
        check('a second tab brings a tab row; closing it takes the row away, the first page still there', twoTabs && oneTab, JSON.stringify({ twoTabs, oneTab }));
        // behind another tab of the right panel the browser's pages stay laid out (an Agent may be at work in one)
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'files' })`);
        const behind = await waitFor(`(() => { const p = document.querySelector('.dock-panel[data-panel="browser"]'); const f = p?.querySelector('iframe'); return !!p && p.hidden && getComputedStyle(p).visibility === 'hidden' && !!f && f.offsetWidth > 0; })()`, 3000);
        check('behind 审阅 the browser stays laid out, unseen', behind);
        const bwErr = await noBoundary('.dock');
        check('浏览器 without error boundary', !bwErr, bwErr);
      }

      // ---- 后台 (spec 2026-10-12-background-office-design.md): a conversation's background put in through the debug
      // hook (no CLI here; phase 25 drives the real thing) — the composer's pill, the page (cards, office, graph, feed),
      // an agent's drawer, the task panel
      if (E.SMOKE_READONLY !== '1' && E.SMOKE_SID) {
        phase = 'background';
        const bsid = JSON.stringify(E.SMOKE_SID);
        await js(`(() => { window.__store.setState({ sidebarOpen: true }); window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } }); })()`);
        await js(`window.__store.getState().loadHistory(${bsid})`);
        await waitFor(`!!document.querySelector('.pane.focused .composer textarea')`, 8000);
        await js(`(() => { const now = Date.now(); const A = (key, color, label, phase, phaseTitle, state, o) => Object.assign({ key, color, label, phase, phaseTitle, state, model: 'claude-haiku-4-5', beats: state === 'running' ? [now - 30000, now - 9000] : [], agentId: state === 'queued' ? undefined : 'a' + key + '00000' }, o || {}); window.__cwBackground.inject({ sessionId: ${bsid}, updatedAt: now, tasks: [ { id: 'wf1', toolUseId: 'tu-wf', kind: 'workflow', description: 'smoke', name: 'smoke-flow', status: 'running', startedAt: now - 60000, phases: [{ index: 1, title: '一' }, { index: 2, title: '二' }], agents: [A('w1', 1, 'alpha', 1, '一', 'running', { lastSummary: '改了 a.ts' }), A('w2', 2, 'beta', 1, '一', 'done'), A('w3', 3, 'gamma', 2, '二', 'queued')] }, { id: 'ag1', kind: 'agent', description: '查一下', status: 'running', backgrounded: true, startedAt: now - 20000, agents: [A('ag1', 4, '查一下', undefined, undefined, 'running', { agentType: 'Explore' })] }, { id: 'sh1', kind: 'shell', description: 'npm run dev', status: 'running', backgrounded: true, startedAt: now - 90000, agents: [] } ], events: [ { at: now - 5000, taskId: 'wf1', agent: 'w1', who: 'alpha', color: 1, text: '改了 a.ts', tone: 'tool' } ] }); })()`);
        const pill = (await waitFor(`!!document.querySelector('.pane.focused .composer .bg-pill')`, 4000)) && await js(`document.querySelector('.pane.focused .composer .bg-pill').textContent`);
        check('后台: the composer\'s pill says what runs besides the turn', pill === '后台 · 1 个工作流 · 1 个子代理 · 1 条命令 · 2 个在跑', JSON.stringify(pill));
        await shot('background-pill');
        await click('.pane.focused .composer .bg-pill');
        const up = await waitFor(`!!document.querySelector('.bg-page:not([hidden]) .cafe-canvas') && document.querySelectorAll('.bg-page .cafe-person').length >= 5`, 10000);
        await sleep(600);
        await waitFor(`document.querySelectorAll('.bg-page .bg-graph .ng-card').length >= 9`, 8000);   // the node graph is its own chunk (spec D2)
        const sidSel = JSON.stringify(JSON.stringify(E.SMOKE_SID));
        const page = await js(`(() => { const p = document.querySelector('.bg-page'); return { title: p.querySelector('.over-title h2')?.textContent, desc: p.querySelector('.over-sub, .over-desc')?.textContent ?? '', cards: p.querySelectorAll('.bg-card:not(.bg-card-more)').length, chars: p.querySelectorAll('.cafe-person').length, admin: !!p.querySelector('.cafe-person[aria-label^="网管"]'), lit: (() => { const c = p.querySelector('.cafe-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, k = 0; for (let i = 0; i < d.length; i += 4 * 97) { k++; if (d[i] + d[i + 1] + d[i + 2] > 60) n++; } return Math.round((n / k) * 100); })(), nodes: p.querySelectorAll('.bg-graph .ng-card').length, edges: p.querySelectorAll('.bg-graph .ng-edge').length, strong: p.querySelector('.bg-graph .ng-edge[data-edge="wf|wf1|p1>wf1|w1"]')?.dataset.style, feed: p.querySelector('.bg-feed')?.textContent ?? '', chips: p.querySelectorAll('.bg-chips .bg-chip').length, rail: !!document.querySelector('.rail [data-id="background"].on'), side: !!document.querySelector('.sb-sect:not([hidden]) .bg-side .bg-srow.active[data-sid=' + ${sidSel} + ']') }; })()`);
        check('the pill opens 后台 on this conversation: five cards (three of a workflow, a sub-agent, a command), four guests and the admin in the cafe (the picture drawn), a node each in the graph, the feed, a chip per task', up && page.title && page.title !== '后台' && /运行中/.test(page.desc) && page.cards === 5 && page.chars === 5 && page.admin && page.lit > 15 && page.nodes === 9 && page.edges === 8 && page.strong === 'strong' && /alpha/.test(page.feed) && page.chips === 4 && page.rail && page.side, JSON.stringify(page));
        const bgErr = await noBoundary('.bg-page');
        check('后台 without error boundary', !bgErr, bgErr);
        await shot('background-page');
        // ---- stage A of 2026-10-24 (spec desktop-parity): the cafe wheel (A3) — here, while the page is up
        phase = 'parity-a';
        {
          // a shorter window gives the page room to scroll; it starts a little down, so a wheel either way would move it
          win.setContentSize(1360, 700);
          await sleep(500);
          const bodySel = `'.bg-page .over-body.bg-body'`;
          const room = await js(`(() => { const p = document.querySelector(${bodySel}); if (!p) return -1; p.scrollTop = 40; return p.scrollHeight - p.clientHeight; })()`);
          await sleep(200);
          // every wheel event the page sees, after the cafe had its say (a passive listener on window: bubble phase)
          await js(`(() => { window.__smokeWheel = []; window.__smokeWheelOn = (e) => window.__smokeWheel.push({ prevented: e.defaultPrevented, shift: e.shiftKey, dy: e.deltaY, cafe: !!e.target.closest?.('.cafe-canvas') }); addEventListener('wheel', window.__smokeWheelOn, { passive: true }); })()`);
          // a point on the canvas itself (not on a guest's button over it), nearest its middle and on screen
          const pos = () => js(`(() => { const c = document.querySelector('.bg-page .cafe-canvas'); const b = c.getBoundingClientRect(); let best = null; for (let i = 1; i < 12; i++) for (let j = 1; j < 8; j++) { const x = Math.round(b.left + (b.width * i) / 12), y = Math.round(b.top + (b.height * j) / 8); if (y < 0 || y > innerHeight - 4 || document.elementFromPoint(x, y) !== c) continue; const d = Math.hypot(x - (b.left + b.width / 2), y - (b.top + b.height / 2)); if (!best || d < best.d) best = { x, y, d: Math.round(d) }; } const s = document.querySelector(${bodySel}).getBoundingClientRect(); let other = null; for (let y = Math.max(s.top, 0) + 10; !other && y < Math.min(s.bottom, innerHeight) - 4; y += 24) for (const x of [s.left + 12, s.left + s.width / 2, s.right - 30]) { const el = document.elementFromPoint(Math.round(x), Math.round(y)); if (el && document.querySelector(${bodySel}).contains(el) && !el.closest('.cafe-canvas, .cafe-person, .cafe-tools, .cafe-lib')) { other = { x: Math.round(x), y: Math.round(y), el: el.className?.baseVal ?? el.className }; break; } } return { ...(best || { x: -1, y: -1 }), below: other }; })()`);
          const scrollTop = () => js(`document.querySelector(${bodySel}).scrollTop`);
          const wheelAt = async (x, y, deltaY, modifiers) => { wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY, ...(modifiers ? { modifiers } : {}) }); await sleep(120); };
          const p = await pos();
          await sleep(200);
          const before = await scrollTop();
          // in and out by turns: the fitted view sits a step or two above the zoom floor, where the page would scroll
          for (const dy of [120, -120, 120, -120]) await wheelAt(p.x, p.y, dy);
          await sleep(300);
          const after = await scrollTop();
          const plain = await js('window.__smokeWheel.splice(0)');
          check('A3: the wheel over the cafe zooms it (each wheel taken by the cafe) and the page stays where it was', room >= 40 && p.x > 0 && before === after && plain.length >= 4 && plain.every((w) => w.cafe && w.prevented), JSON.stringify({ room, at: p, before, after, wheels: plain }));
          // Shift + wheel: the cafe leaves it alone (no zoom, not prevented). Chromium on Windows turns it into a
          // sideways scroll, so the page does not move down either — that is the platform, not asserted
          for (const dy of [-120, 120]) await wheelAt(p.x, p.y, dy, ['shift']);
          await sleep(300);
          const shifted = await js('window.__smokeWheel.splice(0)');
          check('A3: Shift + wheel over the cafe is not taken by it (no zoom, not prevented)', shifted.length >= 2 && shifted.every((w) => w.cafe && w.shift && !w.prevented), JSON.stringify(shifted));
          // the control: the same wheel on the page outside the cafe scrolls it (so the input above did reach the page)
          let control = null;
          if (p.below) {
            const t0 = await scrollTop();
            for (const dy of [120, -120]) {
              await wheelAt(p.below.x, p.below.y, dy);
              await sleep(400);
              control = { from: t0, to: await scrollTop(), wheels: [...(control?.wheels ?? []), ...(await js('window.__smokeWheel.splice(0)'))] };
              if (control.to !== t0) break;
            }
          }
          check('A3 (control): the same wheel on the page outside the cafe scrolls it', p.x > 0 && !!control && control.to !== control.from && control.wheels.every((w) => !w.cafe && !w.prevented), JSON.stringify({ control, at: p }));
          await js(`(() => { removeEventListener('wheel', window.__smokeWheelOn, { passive: true }); delete window.__smokeWheel; delete window.__smokeWheelOn; document.querySelector('.bg-page .cafe-canvas').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); document.querySelector(${bodySel}).scrollTop = 0; })()`);
          win.setContentSize(1360, 860);
          await sleep(500);
        }
        phase = 'background';
        // spec D2: an agent card in the 指挥台 opens that agent's conversation beside the board (pointerdown / up, no drag)
        await js(`(() => { const c = document.querySelector('.bg-page .bg-graph .ng-card[data-node="wf1|w1"]'); const r = c.getBoundingClientRect(); const o = { bubbles: true, button: 0, pointerId: 7, clientX: r.left + 10, clientY: r.top + 10 }; c.dispatchEvent(new PointerEvent('pointerdown', o)); c.dispatchEvent(new PointerEvent('pointerup', o)); })()`);
        const cardDrawer = await waitFor(`/alpha/.test(document.querySelector('.bg-page .bg-drawer .bg-drawer-title .n')?.textContent ?? '')`, 4000);
        check('指挥台: an agent card opens its conversation in the drawer', cardDrawer);
        await js(`document.querySelector('.bg-page').focus()`);
        await key('Escape');
        await waitFor(`!document.querySelector('.bg-page .bg-drawer')`, 3000);
        await js(`document.querySelector('.bg-page .cafe-person[aria-label^="alpha"]').click()`);
        const drawer = await waitFor(`/alpha/.test(document.querySelector('.bg-page .bg-drawer .bg-drawer-title .n')?.textContent ?? '')`, 4000);
        check('a guest in the cafe opens their own conversation beside the board', drawer);
        await shot('background-drawer');
        await click('.bg-page .cafe-tools .btn');
        const lib = (await waitFor(`!!document.querySelector('.cafe-lib')`, 3000)) && await js(`[...document.querySelectorAll('.cafe-lib .cafe-card')].map((c) => c.dataset.character).join(',')`);
        check('网吧 → 角色库: the octopus and the admin, walking', lib === 'octopus,admin', JSON.stringify(lib));
        await shot('cafe-library');
        await key('Escape');
        check('Esc closes the library, the page stays', await waitFor(`!document.querySelector('.cafe-lib') && !document.querySelector('.bg-page').hidden`, 2000));
        await js(`document.querySelector('.bg-page').focus()`);
        await key('Escape');
        const drawerGone = await waitFor(`!document.querySelector('.bg-page .bg-drawer') && !document.querySelector('.bg-page').hidden`, 3000);
        await key('Escape');
        const pageGone = await waitFor(`document.querySelector('.bg-page').hidden === true && !!document.querySelector('.rail [data-id="chat"].on')`, 3000);
        check('Esc closes the drawer first, then the page', drawerGone && pageGone, JSON.stringify({ drawerGone, pageGone }));
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'tasks' })`);
        const tasks = (await waitFor(`!!document.querySelector('.dock-panel[data-panel="tasks"]:not([hidden]) .bg-tasks .bg-graph .ng-card')`, 5000)) && await js(`(() => { const p = document.querySelector('.dock-panel[data-panel="tasks"] .bg-tasks'); return { tasks: p.querySelectorAll('.bg-ttask').length, agents: p.querySelectorAll('.bg-tagent').length, stops: p.querySelectorAll('.bg-ttask .btn.danger').length }; })()`);
        check('右侧面板 → 任务: the small graph, the three tasks (a Stop each) and the workflow\'s agents', tasks && tasks.tasks === 3 && tasks.agents === 3 && tasks.stops === 3, JSON.stringify(tasks));
        await shot('background-tasks');
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'cafe' })`);
        const panelCafe = await waitFor(`!!document.querySelector('.dock-panel[data-panel="cafe"]:not([hidden]) .cafe-canvas') && document.querySelectorAll('.dock-panel[data-panel="cafe"] .cafe-person').length >= 5`, 8000);
        check('右侧面板 → 网吧: the same cafe, small, with its guests and the admin', panelCafe);
        await shot('cafe-panel');
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.close', panel: 'cafe', workbench: false })`);
        await js(`(() => { window.__cwBackground.inject({ sessionId: ${bsid}, updatedAt: Date.now(), tasks: [], events: [] }); window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } }); })()`);
        const pillGone = await waitFor(`!document.querySelector('.pane.focused .composer .bg-pill')`, 3000);
        check('nothing running: no pill', pillGone);
      }

      // ---- stage A of 2026-10-24 (spec desktop-parity), A2: a sidebar row's ··· menu in a short window — its first and
      // last item can be reached, and the list's fading mask (which clipped the menu, a fixed descendant, to the list's
      // box: the top lost under 新对话) is off while it is open
      if (E.SMOKE_READONLY !== '1') {
        phase = 'parity-a';
        await js('window.__store.setState({ sidebarOpen: true })');
        win.setContentSize(1360, 600);
        await sleep(500);
        await js(`(() => { const l = document.querySelector('.sb-list'); if (l) l.scrollTop = l.scrollHeight / 2; })()`);
        await sleep(200);
        const opened = await js(`(() => { const rows = [...document.querySelectorAll('.sb-list .sb-row.sess')].filter((r) => { const b = r.getBoundingClientRect(); return b.height > 0 && b.top > 60 && b.bottom < innerHeight - 40; }); const row = rows[0]; const more = row && row.querySelector(':scope > .more'); if (!more) return false; more.click(); return true; })()`);
        const up = await waitFor(`!!document.querySelector('.sb-list .menu.sess-menu') && document.querySelector('.sb-list .menu.sess-menu').style.visibility !== 'hidden'`, 3000);
        await sleep(400);
        const reach = up && await js(`(() => {
          const m = document.querySelector('.sb-list .menu.sess-menu'); const list = m.closest('.sb-list');
          const items = [...m.querySelectorAll('button')].filter((b) => b.getClientRects().length);
          const at = (b, top) => { m.scrollTop = top ? 0 : m.scrollHeight; const r = b.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 6)); return !!h && m.contains(h) && r.top >= 0 && r.bottom <= innerHeight; };
          const box = m.getBoundingClientRect(), lb = list.getBoundingClientRect();
          const mask = getComputedStyle(list).maskImage || getComputedStyle(list).webkitMaskImage;
          const first = at(items[0], true); const last = at(items[items.length - 1], false);
          return { first, last, n: items.length, mask, menu: [Math.round(box.top), Math.round(box.bottom)], list: [Math.round(lb.top), Math.round(lb.bottom)], scrolls: m.scrollHeight > m.clientHeight, overflowY: getComputedStyle(m).overflowY };
        })()`);
        check('A2: a sidebar ··· menu in a short window — first and last item can be reached, the list\'s mask is off while it is open', opened && reach && reach.n > 3 && reach.first && reach.last && reach.mask === 'none', JSON.stringify({ opened, up, reach }));
        await shot('parity-a-sidebar-menu');
        await key('Escape');
        const maskBack = await waitFor(`!document.querySelector('.sb-list .menu') && getComputedStyle(document.querySelector('.sb-list')).maskImage !== 'none'`, 3000);
        check('A2: the menu closed, the list fades again', maskBack, await js(`getComputedStyle(document.querySelector('.sb-list')).maskImage.slice(0, 40)`));
        win.setContentSize(1360, 860);
        await sleep(400);
      }

      {
        phase = 'structure';
        await js(`(() => { const d = window.__store.getState().dispatchLayout; d({ t: 'dock.set', patch: { open: true, minimized: false, width: 440 } }); d({ t: 'dock.show', panel: 'config' }); })()`);
        await sleep(700);
        const cut = await js(`(() => { const tab = document.querySelector('.dock .dock-tablist .tab[data-panel="config"]'); const list = document.querySelector('.dock .dock-tablist'); const head = document.querySelector('.dock .dock-foldhead[data-panel="config"] .t'); if (!tab || !list) return { folded: true, head: head ? head.textContent : null, badge: document.querySelector('.dock .dock-more-n')?.textContent ?? null }; const a = tab.getBoundingClientRect(); const b = list.getBoundingClientRect(); return { folded: false, whole: a.left >= b.left - 1 && a.right <= b.right + 1, tab: Math.round(a.width), strip: Math.round(b.width) }; })()`);
        check('a temporary tab is shown whole or not at all: 配置中心 is a whole tab of the strip, or folded into 「更多」 with its name on the panel', cut.folded ? cut.head === '配置中心' && cut.badge === '1' : cut.whole, JSON.stringify(cut));
        await shot('panel-config-folded');
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.close', panel: 'config', workbench: false })`);
        await sleep(250);
      }

      // ---- redesign phase 5: chat rendering — folded turns, the change card, thinking time, hover actions, and the
      // permission card docked above the composer (a real request from the mock ACP agent: allow once with an empty
      // Enter, deny with the words in the box, 拒绝 with a reason; 总是允许 and 「还有 N 条」 on staged requests)
      if (E.SMOKE_READONLY !== '1' && E.SMOKE_REVIEW_SID) {
        phase = 'code-review-card';
        const rsid = JSON.stringify(E.SMOKE_REVIEW_SID);
        await js(`window.__store.getState().setSetting('ui.viewMode', 'verbose')`);
        await js(`window.__store.getState().loadHistory(${rsid})`);
        const card = await waitFor(`document.querySelectorAll('.pane.focused .findings .fd-item').length === 2`, 10_000);
        const files = await js(`[...document.querySelectorAll('.pane.focused .findings .fd-path')].map((p) => p.textContent)`);
        const openBtn = await js(`document.querySelector('.pane.focused .findings .fd-foot .btn')?.textContent ?? ''`);
        await js(`document.querySelector('.pane.focused .findings .fd-item .fd-acts .btn.ghost')?.click()`);
        const dismissed = await waitFor(`document.querySelector('.pane.focused .findings .fd-item')?.classList.contains('done') && /（1）/.test(document.querySelector('.pane.focused .findings .fd-foot .btn')?.textContent ?? '') && (window.__store.getState().sessionMeta[${rsid}]?.reviewDismissed ?? []).length === 1`, 4000);
        check('代码审查卡: ReportFindings draws by file, 修复还开着的（2）; 忽略 greys one out, remembers it, and the count drops', card && files.join() === 'src/index.ts,README.md' && /（2）/.test(openBtn) && dismissed, JSON.stringify({ card, files, openBtn, dismissed }));
        // ---- 跨对话工具: the message from another conversation, and the task chip
        const fromHead = await js(`document.querySelector('.pane.focused .from-head')?.textContent ?? ''`);
        const fromBody = await js(`[...document.querySelectorAll('.pane.focused .bubble')].some((b) => b.textContent.includes('smoke: hello from the other one') && !b.textContent.includes('cw-from'))`);
        check('跨对话: a <cw-from> message shows who sent it (来自「smoke sender」) and only what was said', /smoke sender/.test(fromHead) && fromBody, JSON.stringify({ fromHead, fromBody }));
        const chip = await waitFor(`!!document.querySelector('.pane.focused .task-chip .tc-t')`, 4000);
        const chipT = await js(`document.querySelector('.pane.focused .task-chip .tc-t')?.textContent ?? ''`);
        await js(`document.querySelector('.pane.focused .task-chip .tc-acts .btn.ghost')?.click()`);
        const chipOff = await waitFor(`document.querySelector('.pane.focused .task-chip')?.classList.contains('off') && (window.__store.getState().sessionMeta[${rsid}]?.taskDismissed ?? []).includes('toolu_r_task')`, 4000);
        check('任务 chip: suggest_task draws as a chip (title, 在新对话里做); 忽略 greys it and remembers it', chip && chipT === 'smoke task' && chipOff, JSON.stringify({ chip, chipT, chipOff }));
        // ---- 文件右键: a file path in the conversation opens the file menu
        const fl = await js(`(() => { const a = document.querySelector('.pane.focused .findings .fd-path a, .pane.focused .findings .fd-path [role="link"], .pane.focused .findings .fd-path > *'); if (!a) return null; const r = a.getBoundingClientRect(); a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 })); return true; })()`);
        const fileMenu = await waitFor(`!!document.querySelector('.file-menu [data-act="copy"]') && !!document.querySelector('.file-menu [data-act="reveal"]')`, 3000);
        await key('Escape');
        const fileMenuGone = await waitFor(`!document.querySelector('.file-menu:not(.leaving)')`, 3000);
        check('文件右键: a file path\'s context menu has 复制路径 / 在资源管理器中显示, Esc closes it', !!fl && fileMenu && fileMenuGone, JSON.stringify({ fl, fileMenu, fileMenuGone }));
        await js(`window.__store.getState().setSetting('ui.viewMode', 'normal')`);
      }
      // ---- stage D of 2026-10-24 (spec desktop-parity D): the node graph — a ```nodegraph block in an answer (the mp4's
      // picture), drag / pan / zoom / wheel / reduced motion, a dropdown re-marking an edge, 把改动发给 Claude, a broken
      // block, a Mermaid flowchart's 节点图 / 原图, and the orchestra's run view
      if (E.SMOKE_READONLY !== '1' && E.SMOKE_GRAPH_SID) {
        phase = 'node-graph';
        const gsid = JSON.stringify(E.SMOKE_GRAPH_SID);
        const G = '.pane.focused .ng-chat';
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
        fs.copyFileSync(E.SMOKE_GRAPH_STAGE, E.SMOKE_GRAPH_DEST);
        await waitFor(`!!document.querySelector('.sidebar [data-sid=' + ${JSON.stringify(JSON.stringify(E.SMOKE_GRAPH_SID))} + ']')`, 15000);
        await js(`window.__store.getState().loadHistory(${gsid})`);
        const drawn = await waitFor(`document.querySelectorAll('${G} .ng-card').length === 5`, 10000);
        await js(`document.querySelector('${G}')?.scrollIntoView({ block: 'center' })`);
        await sleep(900);
        const first = drawn && await js(`(() => { const r = document.querySelector('${G}'); const b = r.querySelector('.ng-badge');
          return { title: r.querySelector('.ng-title')?.textContent, badge: b?.textContent, tone: b?.dataset.tone, open: r.querySelector('.ng-edge[data-edge="e-open"]')?.dataset.style,
            dashed: r.querySelector('.ng-edge[data-edge="e-backup"]')?.dataset.style, labels: r.querySelectorAll('.ng-label').length, list: r.querySelectorAll('.ng-card[data-node="bucket"] .ng-li').length,
            motion: r.querySelector('.ng').dataset.motion, dots: r.querySelectorAll('.ng-edge[data-style="error"] animateMotion').length, pct: r.querySelector('.ng-zoom-pct')?.textContent }; })()`);
        check('```nodegraph: title, red badge 「1 open path」, error / dashed edges, 5 labels, the list under a card, − N% + control', !!first && first.title === 'Access settings' && /1 open path/.test(first.badge) && first.tone === 'error' && first.open === 'error' && first.dashed === 'dashed' && first.labels === 5 && first.list === 4 && /^\d+%$/.test(first.pct), JSON.stringify(first));
        check('the red path carries a travelling dot while motion is on', !!first && first.motion === 'on' && first.dots >= 1, JSON.stringify(first));
        await shot('node-graph-sample');
        // review D4: the canvas is as tall as the cards need at the reply's width — no empty band under them, the title row free
        const band = drawn && await js(`(() => { const v = document.querySelector('${G} .ng-viewport').getBoundingClientRect(); const cs = [...document.querySelectorAll('${G} .ng-card')].map((c) => c.getBoundingClientRect()); return { gap: Math.round(v.bottom - Math.max(...cs.map((c) => c.bottom))), top: Math.round(Math.min(...cs.map((c) => c.top)) - v.top), h: Math.round(v.height), pct: document.querySelector('${G} .ng-zoom-pct').textContent }; })()`);
        check('```nodegraph in a reply: no empty band under the cards, the title row kept free (review D4)', !!band && band.gap <= 96 && band.top >= 40, JSON.stringify(band));
        if (drawn) {
          // 减少动画 (the in-app setting): no travelling dot, no breathing glow
          await js(`window.__store.getState().setSetting('ui.reduceMotion', true)`);
          const off = await waitFor(`document.querySelector('${G} .ng').dataset.motion === 'off'`, 3000);
          const rm = await js(`({ dots: document.querySelectorAll('${G} animateMotion').length, anim: getComputedStyle(document.querySelector('${G} .ng-glow')).animationName })`);
          check('减少动画: no travelling dot, no breathing glow', off && rm.dots === 0 && rm.anim === 'none', JSON.stringify(rm));
          await js(`window.__store.getState().setSetting('ui.reduceMotion', false)`);
          await waitFor(`document.querySelector('${G} .ng').dataset.motion === 'on'`, 3000);
          // − N% +, then the wheel (the shared A3 rule: taken over the graph, Shift left to the page)
          const pctOf = () => js(`parseInt(document.querySelector('${G} .ng-zoom-pct').textContent, 10)`);
          const p0 = await pctOf();
          // review D5: in a reply the graph takes the wheel only once it was clicked / focused — before that the page scrolls
          await js(`(() => { document.activeElement?.blur?.(); window.__ngW0 = []; window.__ngW0On = (e) => window.__ngW0.push(e.defaultPrevented); addEventListener('wheel', window.__ngW0On, { passive: true }); })()`);
          {
            const r = await js(`(() => { const r = document.querySelector('${G} .ng-viewport').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
            wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y }); wc.sendInputEvent({ type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: 120 }); await sleep(250);
          }
          const w0 = await js(`(() => { removeEventListener('wheel', window.__ngW0On, { passive: true }); return window.__ngW0; })()`);
          const pw = await pctOf();
          check('in a reply, before the graph was clicked, the wheel is left to the page (review D5)', pw === p0 && w0.length >= 1 && w0.every((x) => x === false), `${p0}→${pw} ${JSON.stringify(w0)}`);
          await js(`document.querySelector('${G}')?.scrollIntoView({ block: 'center' })`);
          await sleep(300);
          await click(`${G} .ng-zoom-in`); await sleep(100); const p1 = await pctOf();
          await click(`${G} .ng-zoom-out`); await sleep(100); const p2 = await pctOf();
          check('zoom control: + is about ×1.2, − comes back', Math.abs(p1 - Math.round(p0 * 1.2)) <= 1 && Math.abs(p2 - p0) <= 1, `${p0} ${p1} ${p2}`);
          const vp = await js(`(() => { const r = document.querySelector('${G} .ng-viewport').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
          await js(`(() => { window.__ngWheel = []; window.__ngWheelOn = (e) => window.__ngWheel.push(e.defaultPrevented); addEventListener('wheel', window.__ngWheelOn, { passive: true }); })()`);
          const wheelAt = async (x, y, deltaY, modifiers) => { wc.sendInputEvent({ type: 'mouseMove', x, y }); wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY, ...(modifiers ? { modifiers } : {}) }); await sleep(250); };
          await wheelAt(vp.x, vp.y, 120);
          const p3 = await pctOf();
          await wheelAt(vp.x, vp.y, 120, ['shift']);
          const wheel = await js(`(() => { removeEventListener('wheel', window.__ngWheelOn, { passive: true }); return window.__ngWheel; })()`);
          check('wheel over the graph zooms (taken); Shift+wheel is left to the page (A3 rule)', p3 !== p0 && wheel.length >= 2 && wheel[0] === true && wheel[wheel.length - 1] === false, `${p0}→${p3} ${JSON.stringify(wheel)}`);
          await js(`document.querySelector('${G}')?.scrollIntoView({ block: 'center' })`);
          await sleep(300);
          // drag a card, drag the canvas, double-click empty space
          const drag = async (from, dx, dy) => {
            wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
            wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
            for (let i = 1; i <= 6; i++) { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + (dx * i) / 6), y: Math.round(from.y + (dy * i) / 6), button: 'left', modifiers: ['leftButtonDown'] }); await sleep(40); }
            wc.sendInputEvent({ type: 'mouseUp', x: from.x + dx, y: from.y + dy, button: 'left', clickCount: 1 }); await sleep(250);
          };
          const cardAt = () => js(`(() => { const r = document.querySelector('${G} .ng-card[data-node="anyone"] .ng-card-h').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()`);
          const dOpen = () => js(`document.querySelector('${G} .ng-edge[data-edge="e-open"] .ng-line').getAttribute('d')`);
          const c0 = await cardAt(), d0 = await dOpen();
          await drag(c0, 80, 40);
          const c1 = await cardAt(), d1 = await dOpen();
          check('drag a card: it follows the mouse and its edge follows the card', c1.x - c0.x > 40 && c1.y - c0.y > 20 && d1 !== d0, `${JSON.stringify(c0)} → ${JSON.stringify(c1)}`);
          const t0 = await js(`document.querySelector('${G} .ng-layer').style.transform`);
          // an empty point of the canvas: scan its lower-left area for one that hits the viewport itself
          const blank = await js(`(() => { const v = document.querySelector('${G} .ng-viewport'); const r = v.getBoundingClientRect(); for (let y = r.bottom - 12; y > r.top + 40; y -= 16) for (let x = r.left + 12; x < r.left + r.width / 2; x += 16) { const el = document.elementFromPoint(x, y); if (el === v || el?.classList.contains('ng-layer') || el?.closest?.('svg.ng-edges')) return { x: Math.round(x), y: Math.round(y) }; } return null; })()`);
          if (blank) await drag(blank, 60, 0);
          const t1 = await js(`document.querySelector('${G} .ng-layer').style.transform`);
          check('drag empty canvas: it pans', !!blank && t1 !== t0, `${JSON.stringify(blank)} ${t0} → ${t1}`);
          if (blank) {
            wc.sendInputEvent({ type: 'mouseDown', x: blank.x, y: blank.y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x: blank.x, y: blank.y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseDown', x: blank.x, y: blank.y, button: 'left', clickCount: 2 });
            wc.sendInputEvent({ type: 'mouseUp', x: blank.x, y: blank.y, button: 'left', clickCount: 2 }); await sleep(300);
          }
          const dBack = await dOpen();
          check('double-click empty space: the card goes back', dBack === d0, dBack);
          // the dropdown re-marks the red path; the badge follows; 把改动发给 Claude fills the input
          await click(`${G} .ng-card[data-node="link"] .ng-row[data-row="read"] .select-trigger`);
          const menu = await waitFor(`!!document.querySelector('.select-popover .select-option')`, 3000);
          if (menu) await js(`[...document.querySelectorAll('.select-popover .select-option')].find((o) => o.textContent.trim() === 'Admin')?.click()`);
          await waitFor(`document.querySelector('${G} .ng-badge').dataset.tone === 'ok'`, 3000);
          const after = await js(`({ badge: document.querySelector('${G} .ng-badge').textContent, open: document.querySelector('${G} .ng-edge[data-edge="e-open"]').dataset.style, send: !!document.querySelector('${G} .ng-send') })`);
          check('dropdown read → Admin: the red path turns dashed, the badge says 「No open paths」, 把改动发给 Claude appears', menu && /No open paths/.test(after.badge) && after.open === 'dashed' && after.send, JSON.stringify(after));
          await shot('node-graph-sample-ok');
          if (after.send) await click(`${G} .ng-send`);
          await sleep(200);
          const draft = await js(`document.querySelector('.pane.focused .composer textarea')?.value ?? ''`);
          check('把改动发给 Claude fills the input with one sentence (not sent)', /read/.test(draft) && /Anyone/.test(draft) && /Admin/.test(draft) && !/^>/.test(draft), draft);
          await js(`window.__store.getState().saveDraft(${gsid}, '')`);
        }
        // a broken block, and the Mermaid flowchart
        const badBlock = await js(`(() => { const b = document.querySelector('.pane.focused .ng-bad'); return { text: b?.textContent ?? '', code: b?.previousElementSibling?.textContent ?? '' }; })()`);
        check('broken ```nodegraph: the code stays, plus 「这张图格式有误」 and where', /这张图格式有误/.test(badBlock.text) && badBlock.code.includes('"nodes"'), JSON.stringify(badBlock));
        const mmView = await waitFor(`!!document.querySelector('.pane.focused .mmd-view') && document.querySelectorAll('.pane.focused .ng-mermaid .ng-card').length === 4`, 10000);
        const mm = await js(`({ cards: document.querySelectorAll('.pane.focused .ng-mermaid .ng-card').length, dashed: document.querySelector('.pane.focused .ng-mermaid .ng-edge[data-style="dashed"]') !== null, label: [...document.querySelectorAll('.pane.focused .ng-mermaid .ng-label text')].some((t) => t.textContent === 'HTTPS') })`);
        check('mermaid flowchart: drawn as a node graph by default (4 cards, dashed -.->, |HTTPS| label)', mmView && mm.cards === 4 && mm.dashed && mm.label, JSON.stringify(mm));
        if (mmView) await js(`document.querySelector('.pane.focused .mmd-view [data-view="raw"]').click()`);
        const raw = await waitFor(`!!document.querySelector('.pane.focused .mermaid-svg svg')`, 15000);
        check("节点图 / 原图: 原图 shows Mermaid's own picture", raw);
        const ngErr = await noBoundary('.pane.focused');
        check('node graph in the conversation without error boundary', !ngErr, ngErr);
        // the orchestra's run view (spec D3): a run put into the store, no engine
        const at = Date.now();
        const orun = (b) => ({ id: 'smoke-run', workflowId: 'smoke-wf', name: 'smoke 编排', cwd: E.SMOKE_REPO, input: '', startedAt: at - 60000, state: b === 'failed' ? 'failed' : 'running',
          workflow: [['plan', []], ['build', ['plan']], ['check', ['build']]].map(([id, dependsOn]) => ({ id, kind: 'task', title: id, agent: 'claude', prompt: 'p', dependsOn, workspace: 'shared' })),
          nodes: { plan: { state: 'done', sessionIds: [], startedAt: at - 50000, finishedAt: at - 30000 }, build: { state: b, sessionIds: [], startedAt: at - 20000, ...(b === 'failed' ? { finishedAt: at - 1000 } : {}) }, check: { state: 'pending', sessionIds: [] } } });
        await js(`(() => { window.__cwOrch.inject(${JSON.stringify(orun('running'))}); window.__cwOrch.open('smoke-run'); })()`);
        const OG = '.dock-panel[data-panel="orchestra"]:not([hidden]) .orch-graph';
        const orchUp = await waitFor(`document.querySelectorAll('${OG} .ng-card').length === 3`, 8000);
        const og = await js(`({ run: document.querySelector('${OG} .ng-card[data-node="build"]')?.dataset.state, edge: document.querySelector('${OG} .ng-edge[data-edge="plan>build"]')?.dataset.style })`);
        check('orchestra run view: the running step glows, the edge into it is strong', orchUp && og.run === 'running' && og.edge === 'strong', JSON.stringify(og));
        const oh = await js(`(() => { const g = document.querySelector('${OG}'); const v = g?.querySelector('.ng-viewport')?.getBoundingClientRect(); return { h: v ? Math.round(v.height) : 0, tip: g?.querySelector('.ng-card[data-node="build"]')?.getAttribute('title') ?? null }; })()`);
        check('orchestra: the graph is as tall as its cards need (160–420), a card names itself on hover (review D5)', oh.h >= 160 && oh.h <= 420 && oh.tip === 'build', JSON.stringify(oh));
        await shot('node-graph-orchestra');
        await js(`window.__cwOrch.inject(${JSON.stringify(orun('failed'))})`);
        const red = await waitFor(`document.querySelector('${OG} .ng-edge[data-edge="plan>build"]')?.dataset.style === 'error'`, 3000);
        check('orchestra: a failed step turns its edge red', red);
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.close', panel: 'orchestra', workbench: false })`);
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
        await sleep(200);
      }
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
        // a code block that something outside React empties (a page translator, an extension — reported 2026-10-09:
        // 「12 行」 and nothing under it) is drawn again, and server.log says what was there (code-blank.ts)
        const codeSel = `.pane.focused .turn-answer .code pre.code-body`;
        const codeBefore = await js(`document.querySelector(${JSON.stringify(codeSel)})?.textContent ?? null`);
        expectErrors = true;
        await js(`(() => { const c = document.querySelector(${JSON.stringify(codeSel)}).firstElementChild; c.textContent = ''; c.setAttribute('_msthash', '1'); })()`);
        const codeBack = await waitFor(`/line one/.test(document.querySelector(${JSON.stringify(codeSel)})?.textContent ?? '')`, 4000);
        for (let i = 0; i < 30 && !res.console.some((m) => /\[code block\]/.test(m.message)); i++) await sleep(100);
        expectErrors = false;
        const codeWarn = res.console.find((m) => /\[code block\]/.test(m.message))?.message ?? null;
        check('a code block emptied from outside React is drawn again and says so (a warning, its text never in it)', /line one/.test(codeBefore ?? '') && codeBack && /重画一次后恢复/.test(codeWarn ?? '') && !/line one/.test(codeWarn ?? ''), JSON.stringify({ codeBefore, codeBack, codeWarn }));
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
        // issue #1 (「一直点不到」): the user message's buttons are under it now, like the reply's; a real mouse from its
        // text to 编辑 keeps them clickable all the way, and the click opens the editor
        const ug = await js(`(async () => { const m = document.querySelector('.pane.focused .msg.user:not(.meta)'); if (!m) return null; m.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300)); const b = m.querySelector('.bubble').getBoundingClientRect(); const e = m.querySelector('.msg-actions button[aria-label="编辑"]').getBoundingClientRect(); return { below: e.top >= b.bottom, from: { x: Math.round(b.left + 10), y: Math.round(b.top + b.height / 2) }, to: { x: Math.round(e.left + e.width / 2), y: Math.round(e.top + e.height / 2) } }; })()`);
        const lost = [];
        if (ug) {
          wc.sendInputEvent({ type: 'mouseMove', x: ug.from.x, y: ug.from.y });
          await sleep(250);
          for (let i = 1; i <= 20; i++) {
            const x = Math.round(ug.from.x + ((ug.to.x - ug.from.x) * i) / 20), y = Math.round(ug.from.y + ((ug.to.y - ug.from.y) * i) / 20);
            wc.sendInputEvent({ type: 'mouseMove', x, y });
            await sleep(16);
            if (await js(`getComputedStyle(document.querySelector('.pane.focused .msg.user:not(.meta) .msg-actions')).pointerEvents`) === 'none') lost.push(`${x},${y}`);
          }
          await sleep(200);
          wc.sendInputEvent({ type: 'mouseDown', x: ug.to.x, y: ug.to.y, button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp', x: ug.to.x, y: ug.to.y, button: 'left', clickCount: 1 });
        }
        const editorOpen = !!ug && await waitFor(`!!document.querySelector('.pane.focused .msg.user textarea')`, 3000);
        if (editorOpen) { await js(`document.querySelector('.pane.focused .msg.user textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await waitFor(`!document.querySelector('.pane.focused .msg.user textarea')`, 3000); }
        check('the user message\'s buttons sit under it; moving from its text to 编辑 they never vanish, and the click opens the editor (issue #1)', !!ug?.below && !lost.length && editorOpen, JSON.stringify({ ug, lost, editorOpen }));
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

        // ---- stage A of 2026-10-24 (spec desktop-parity): double click (A4), context colours (A5), 背景动画 (A6)
        phase = 'parity-a';
        // A4: a real double click on inline code selects the code span whole (no trailing space), then the selection
        // menu; with the conversation running on this machine it offers 旁聊, which opens the side chat with the quote
        {
          const codeSel = `.pane.focused .msg.assistant .msg-text code:not(pre code):not(.code code)`;
          const p = await js(`(async () => { const c = document.querySelector(${JSON.stringify(codeSel)}); if (!c) return null; c.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300)); const r = c.getBoundingClientRect(); return { x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2), text: c.textContent }; })()`);
          if (p) {
            // the conversation counts as running here (no engine is started, nothing is sent): 旁聊 is offered then
            await js(`window.__store.setState((s) => { const o = s.open[${tsid}]; return o ? { open: { ...s.open, [${tsid}]: { ...o, state: 'idle', version: o.version + 1 } } } : {}; })`);
            await js('document.activeElement && document.activeElement.blur && document.activeElement.blur(); getSelection().removeAllRanges()');
            await sleep(200);
            wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
            wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 2 }); wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 2 });
            await sleep(400);
            const sel = await js('getSelection().toString()');
            check('A4: a double click on inline code selects exactly that code (no trailing space)', sel === p.text && p.text === 'activation_status', JSON.stringify({ sel, code: p.text }));
            const menu = await waitFor(`!!document.querySelector('.menu.sel-menu [data-act="copy"]') && document.querySelector('.menu.sel-menu').style.visibility !== 'hidden'`, 2000);
            const rows = await js(`[...document.querySelectorAll('.menu.sel-menu [data-act]')].map((b) => b.dataset.act).join(',')`);
            if (rows.includes('side')) await js(`document.querySelector('.menu.sel-menu [data-act="side"]').click()`);
            const side = rows.includes('side') && await waitFor(`!document.querySelector('.menu.sel-menu') && document.querySelector('.pane.focused .side-chat .sc-input textarea')?.value === '> activation_status\\n\\n'`, 3000);
            // the side chat card sits inside .composer: the main box is the other textarea
            const mainBox = await js(`document.querySelector('.pane.focused .composer textarea:not(.side-chat textarea)')?.value ?? null`);
            check('A4: the selection menu comes up and offers 旁聊; 旁聊 opens the side chat with the quote filled in, nothing sent', menu && side && mainBox === '', JSON.stringify({ menu, rows, side, sideBox: await js(`document.querySelector('.pane.focused .side-chat .sc-input textarea')?.value ?? null`), mainBox }));
            if (await js('!!document.querySelector(".pane.focused .side-chat")')) {
              await js(`document.querySelector('.side-chat .icon-btn[aria-label]')?.click()`);
              await waitFor('!document.querySelector(".side-chat")', 3000);
            }
            await js(`window.__store.setState((s) => { const o = s.open[${tsid}]; return o ? { open: { ...s.open, [${tsid}]: { ...o, state: 'history', version: o.version + 1 } } } : {}; })`);
            await js('getSelection().removeAllRanges()');
            if (await js('!!document.querySelector(".menu.sel-menu")')) await key('Escape');
            // not running: no 旁聊 (as the header's ··· has it)
            wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 2 }); wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 2 });
            const menu2 = await waitFor(`!!document.querySelector('.menu.sel-menu [data-act="copy"]')`, 2000);
            const rows2 = await js(`[...document.querySelectorAll('.menu.sel-menu [data-act]')].map((b) => b.dataset.act).join(',')`);
            check('A4: a conversation that is not running gets the menu without 旁聊', menu2 && !rows2.split(',').includes('side'), JSON.stringify({ menu2, rows2 }));
            await key('Escape');
            await js('getSelection().removeAllRanges()');
            await waitFor(`!document.querySelector('.menu.sel-menu')`, 2000);
          } else check('A4: the seeded reply has inline code', false, 'no inline code in the seed');
        }
        // A1 (review I1): a file:/// link and a C:\ path in a reply keep a non-empty href (react-markdown's default
        // blanked them); a click on the file one opens the file in a tab and the window stays on the app page
        {
          const links = await js(`[...document.querySelectorAll('.pane.focused .msg.assistant .md a')].filter((a) => /^smoke-(file-url|drive-path)$/.test(a.textContent)).map((a) => ({ text: a.textContent, href: a.getAttribute('href') ?? '' }))`);
          const fileUrl = links.find((l) => l.text === 'smoke-file-url');
          const drive = links.find((l) => l.text === 'smoke-drive-path');
          check('A1: a reply\'s file:/// link and C:\\ link render with their href', !!fileUrl && /^file:\/\/\//.test(fileUrl.href) && !!drive && /^[A-Za-z]:/.test(drive.href), JSON.stringify(links));
          const docTiles = `window.__store.getState().layout.groups.flatMap((g) => Object.entries(g.panes).flatMap(([paneId, p]) => p.tiles.filter((t) => t.kind === 'doc' && /README\\.md$/i.test(t.path ?? '')).map((t) => ({ paneId, id: t.id, path: t.path }))))`;
          const before = await js('location.href');
          await js(`[...document.querySelectorAll('.pane.focused .msg.assistant .md a')].find((a) => a.textContent === 'smoke-file-url')?.click()`);
          const opened = await waitFor(`${docTiles}.length > 0`, 3000);
          await sleep(300);
          const after = await js('location.href');
          const tiles = await js(docTiles);
          check('A1: clicking the file:/// link opens the file in a tab; the window does not navigate', opened && after === before, JSON.stringify({ tiles, before, after }));
          for (const t of tiles ?? []) await js(`window.__store.getState().dispatchLayout({ t: 'tile.close', paneId: ${JSON.stringify(t.paneId)}, tileId: ${JSON.stringify(t.id)} })`);
          await sleep(300);
        }
        // A5: context colours are fixed per category — the card's rows (when it has a count; no engine runs here, so
        // usually none) never use the old rotating sw-0…7, those rules are gone, and the five tones are five colours
        {
          const tones = await js(`[...document.querySelectorAll('.ctx .ctx-row > i, .ctx .ctx-bar > i')].map((i) => i.className).join(',')`);
          const css = await js(`(() => {
            const sels = []; const walk = (rules) => { for (const r of rules) { if (r.selectorText) sels.push(r.selectorText); if (r.cssRules) walk(r.cssRules); } };
            for (const s of document.styleSheets) { try { walk(s.cssRules); } catch { /* another origin */ } }
            const probe = document.createElement('div'); probe.className = 'ctx'; probe.style.cssText = 'position:fixed;left:-50px;top:0;';
            const tones = ['messages', 'tools', 'mcp', 'skills', 'other'];
            probe.innerHTML = tones.map((t) => '<i class="ctx-t-' + t + '" style="display:block;width:4px;height:4px"></i>').join('');
            document.body.appendChild(probe);
            const colours = [...probe.children].map((i) => getComputedStyle(i).backgroundColor);
            probe.remove();
            return { oldRules: sels.filter((x) => /\\.sw-[0-7]\\b/.test(x)), colours, distinct: new Set(colours).size, clear: colours.filter((c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent').length };
          })()`);
          check('A5: context rows use the fixed per-category colours (no sw-0…7 rows or rules; five tones, five colours)', !/\bsw-[0-7]\b/.test(tones) && !css.oldRules.length && css.distinct === 5 && !css.clear, JSON.stringify({ tones, ...css }));
        }
        // A6: the old setting is gone, 背景动画 is under 外观
        {
          await js('window.__store.getState().openSettings({ section: "appearance" })');
          await waitFor(`!!document.querySelector('.modal.settings.sp')`, 4000);
          await sleep(600);
          const rows = await js(`({ motion: !!document.querySelector('.sp [data-entry="ui.backdropMotion"]'), label: document.querySelector('.sp [data-entry="ui.backdropMotion"]')?.textContent.slice(0, 20) ?? null, old: !!document.querySelector('[data-entry="ui.welcomeBackdrop"]') })`);
          check('A6: 外观 has 背景动画 and the old backdrop setting is gone', rows.motion && /背景动画/.test(rows.label ?? '') && !rows.old, JSON.stringify(rows));
          await js('window.__store.setState({ settingsOpen: null })');
          await waitFor(`!document.querySelector('.modal.settings.sp')`, 3000);
          await sleep(300);
        }

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
        await sleep(450); // the card's entrance (it rises into place): measure where it rests
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
        if (await js(`!!document.querySelector('.rail .sb-reveal')`)) await click('.rail .sb-reveal');
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
          await waitFor(`!!document.querySelector('.pane.focused .composer .pdock [data-act="deny-queued"]')`, 3000);
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
        // 操控电脑 asking which applications it may control: its own card (the reason, the applications, what a yes
        // means). The whole desktop is behind that yes: no key gives it — Enter and Ctrl+Enter do nothing and say so —
        // only the card's button
        await setOpen(`pending: [${stageReq('smoke-access', 'mcp__computer__request_access', "{ apps: ['记事本', 'Paint'], reason: '把这段话写进记事本', clipboardWrite: true }")}], state: 'idle'`);
        await click('.pane.focused .composer textarea');
        await sleep(800);
        const acc = await js(`(() => { const c = document.querySelector('.pane.focused .composer'); const d = c.querySelector('.pdock'); if (!d) return null; const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null; }; return { kind: d.dataset.kind, title: d.querySelector('.pd-title')?.textContent, why: d.querySelector('.pd-why')?.textContent, apps: [...d.querySelectorAll('.pd-apps .pd-app')].map((a) => a.textContent), notes: [...d.querySelectorAll('.pd-access .pd-note')].map((n) => n.textContent), allow: d.querySelector('[data-act="allow"]')?.textContent, deny: d.querySelector('[data-act="deny"]')?.textContent, always: !!d.querySelector('[data-act="always"]'), chip: r(d.querySelector('.pd-app')), list: getComputedStyle(d.querySelector('.pd-apps')).listStyleType, placeholder: c.querySelector('textarea').placeholder, live: d.querySelector('.pd-live')?.textContent ?? null }; })()`);
        check('操控电脑\'s access request has its own card: the title, the reason, the applications as chips, what else it asked for, what a yes means',
          !!acc && acc.kind === 'access' && /想操控这台电脑上的 2 个应用/.test(acc.title ?? '') && /把这段话写进记事本/.test(acc.why ?? '') && acc.apps.join('|') === '记事本|Paint' && acc.notes.some((n) => /写剪贴板/.test(n)) && acc.notes.some((n) => /只对这一个对话有效/.test(n)) && acc.chip && acc.chip.h >= 24 && acc.chip.h <= 40 && acc.list === 'none', JSON.stringify(acc));
        check('… its buttons are 不允许 and 允许操控 (no 总是允许), and the box and the status line say a key will not allow it',
          !!acc && acc.allow === '允许操控' && acc.deny === '不允许' && !acc.always && /允许请点卡片上的按钮/.test(acc.placeholder) && /按键不会允许/.test(acc.live ?? ''), JSON.stringify(acc));
        await sleep(400);
        await shot('chat-access');
        // 总览 lists it — in words, and without an 允许: there neither the applications' card nor the reason can be read
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'mission' })`);
        const mcAccess = await waitFor(`!!document.querySelector('.dock-panel[data-panel="mission"]:not([hidden]) .mcard .perm[data-kind="access"]')`, 4000);
        const mcLine = await js(`(() => { const l = document.querySelector('.dock-panel[data-panel="mission"] .mcard .perm[data-kind="access"]'); return l && { text: l.textContent, buttons: l.querySelectorAll('button').length }; })()`);
        check('总览 lists the access request in words, with no 允许 there (it is answered on the conversation\'s card)', mcAccess && !!mcLine && mcLine.buttons === 0 && /记事本、Paint/.test(mcLine.text) && !/mcp__/.test(mcLine.text), JSON.stringify(mcLine));
        await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
        await sleep(300);
        await click('.pane.focused .composer textarea');
        await sleep(700); // (the panel going away is not a cover: the card's cooldown is long past either way)
        await key('Return');
        await sleep(300);
        const accNote = await js(`({ note: document.querySelector('.pane.focused .composer .pdock .pd-hint.note')?.textContent ?? null, live: document.querySelector('.pane.focused .composer .pdock .pd-live')?.textContent ?? null })`);
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['control'] });
        await sleep(500);
        const accKeys = { sent: await sentFor('smoke-access'), docked: await js(`document.querySelector('.pane.focused .composer .pdock')?.dataset.request ?? null`) };
        check('… Enter and Ctrl+Enter answer nothing, however long the card has been there — and the card says a click is needed', accKeys.sent === '[]' && accKeys.docked === 'smoke-access' && /按键不会允许/.test(accNote.note ?? '') && /按键不会允许/.test(accNote.live ?? ''), JSON.stringify({ accKeys, accNote }));
        await click('.pane.focused .composer .pdock [data-act="allow"]');
        await waitFor(`window.__permSent.some((r) => r.requestId === 'smoke-access')`, 3000);
        check('… a click on 允许操控 is the yes', (await sentFor('smoke-access')) === '[{"behavior":"allow"}]', await sentFor('smoke-access'));
        // …and words in the box are a no with them, like on every card
        await setOpen(`pending: [${stageReq('smoke-access-no', 'mcp__computer__request_access', "{ apps: ['记事本'], reason: 'again' }")}], state: 'idle'`);
        await click('.pane.focused .composer textarea');
        await sleep(800);
        wc.insertText('smoke: 别动记事本');
        await sleep(200);
        const accSendLabel = await js(`document.querySelector('.pane.focused .composer .steer.deny')?.textContent ?? null`);
        await key('Return');
        await waitFor(`window.__permSent.some((r) => r.requestId === 'smoke-access-no')`, 3000);
        const accNo = await sentFor('smoke-access-no');
        check('… words in the box + Enter = 不允许 with them (the send slot says 不允许并发送)', accNo === '[{"behavior":"deny","message":"smoke: 别动记事本"}]' && /不允许并发送/.test(accSendLabel ?? ''), JSON.stringify({ accNo, accSendLabel }));
        await setOpen(`pending: []`);
        await sleep(300);
        // a card that docks while a page covers the conversation (final review I1): closing the page gives the focus
        // back to the box, and the Enter right after that answers nothing — the card's first moments start when the
        // page goes. The automation page (from the sidebar) and the settings page (opened from the box) alike, and the
        // shortcut sheet (re-review M-4: F1 over the box on the desktop — closing it gives the focus back to the box)
        const coverName = { automation: 'automation page', settings: 'settings page', shortcuts: 'shortcut sheet' };
        for (const cover of ['automation', 'settings', 'shortcuts']) {
          const id = `smoke-covered-${cover}`;
          await click('.pane.focused .composer textarea');
          if (cover === 'automation') {
            if (!(await js(`!!document.querySelector(':is(.rail, .sidebar) [data-id="automation"]')`)) && await js(`!!document.querySelector('.rail .sb-reveal')`)) await click('.rail .sb-reveal');
            await click(':is(.rail, .sidebar) [data-id="automation"]');
            await waitFor(`(() => { const p = document.querySelector('.auto-page'); return !!p && !p.hidden; })()`, 3000);
            // the section page's header and the Windows caption buttons (138px): 20px of air as on the other rows (the
            // verification of 2026-10-16 found 12 — rail.css kept the old reserve); measured with the desktop class on
            const capAir = await js(`(() => { const de = document.documentElement; const had = de.classList.contains('desktop'); de.classList.add('desktop'); const app = document.querySelector('.app'); const wb = document.querySelector('.workbench'); const h = [...document.querySelectorAll('.auto-page .over-head')].find((x) => x.getClientRects().length); let res; if (h && !app.classList.contains('dock-open') && !wb.classList.contains('gb')) { const bs = [...h.querySelectorAll('button')].filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden' && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().top < 60); const right = Math.max(...bs.map((b) => b.getBoundingClientRect().right)); res = { air: Math.round(innerWidth - 138 - right), vw: innerWidth, buttons: bs.length }; } else res = { notApplicable: { dockOpen: app.classList.contains('dock-open'), groupBar: wb.classList.contains('gb'), head: !!h } }; if (!had) de.classList.remove('desktop'); return res; })()`);
            check('desktop · Windows: the automation page header keeps 16px+ before the caption buttons', capAir.notApplicable ? true : capAir.buttons > 0 && capAir.air >= 16, JSON.stringify(capAir));
          } else if (cover === 'settings') {
            await js('window.__store.getState().openSettings()');
            await waitFor(`!!document.querySelector('.modal.settings.sp')`, 3000);
          } else {
            await js('window.__store.setState({ shortcutsOpen: true })');
            await waitFor(`!!document.querySelector('.shortcuts-bg')`, 3000);
          }
          await setOpen(`pending: [${stageReq(id)}], state: 'waiting'`);
          await sleep(1500);
          const under = await js(`(() => { const d = document.querySelector('.pane.focused .composer .pdock'); if (!d) return null; const r = d.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { docked: d.dataset.request, hidden: !d.contains(hit) }; })()`);
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
          const closed = await waitFor(cover === 'automation' ? 'document.querySelector(".auto-page")?.hidden === true' : cover === 'settings' ? '!document.querySelector(".modal.settings.sp")' : '!document.querySelector(".shortcuts-bg")', 2000);
          const inBox = await waitFor(`!!document.activeElement?.matches('.pane.focused .composer textarea')`, 2000);
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
          await sleep(250);
          const right = { sent: await sentFor(id), note: await js(`document.querySelector('.pane.focused .composer .pdock .pd-hint.note')?.textContent ?? null`), docked: await js(`document.querySelector('.pane.focused .composer .pdock')?.dataset.request ?? null`) };
          check(`a card that docked under the ${coverName[cover]}: Esc (the focus back in the box) then Enter at once answers nothing (final review I1, re-review M-4)`,
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
        // phone width: every button a row of its own, 允许一次 on top (UI refresh §8)
        win.setContentSize(480, 860);
        await waitFor('innerWidth === 480', 4000);
        await sleep(500);
        const narrow = await js(`(() => { const d = document.querySelector('.pane .composer .pdock'); if (!d) return null; const a = d.querySelector('[data-act="allow"]').getBoundingClientRect(), r = d.querySelector('[data-act="deny"]').getBoundingClientRect(), box = d.getBoundingClientRect(); return { own: a.bottom <= r.top + 1, wide: a.width >= box.width - 40, inside: box.left >= 0 && box.right <= innerWidth }; })()`);
        check('phone width: the card is full width and 允许一次 has a row of its own, above 拒绝', narrow && narrow.own && narrow.wide && narrow.inside, JSON.stringify(narrow));
        await sleep(400);
        await shot('chat-permission-phone');
        win.setContentSize(1360, 860);
        await waitFor('innerWidth === 1360', 4000);
        await click('.pane.focused .composer .pdock [data-act="deny"]');
        await waitFor(`!document.querySelector('.pane.focused .composer .pdock')`, 6000);
        // ---- stage C1: the question card is in the conversation (not docked over the box) — one question a page,
        // paging keeps the answers, keys, 其它, preview, IME, the answer the CLI expects, 跳过 / all skipped = deny,
        // 需要你 in the sidebar, the box's empty Enter only moves the focus into the card
        phase = 'stage-c-ask';
        const count = (sel) => js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
        const exists = (sel) => js(`!!document.querySelector(${JSON.stringify(sel)})`);
        const ctxMenuAt = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 8, button: 2 })); return true; })()`);
        {
          const askInput = (two) => `{ questions: [{ question: '用哪个库？', header: '库', multiSelect: false, options: [{ label: 'zod', description: '新一点' }, { label: 'yup' }] }${two ? `, { question: '要哪些检查？', multiSelect: true, options: [{ label: 'lint', preview: 'npm run lint' }, { label: 'test' }, { label: 'build' }] }` : ''}] }`;
          const putAsk = (id) => js(`(async () => { const st = window.__store; const o = st.getState().open[${pj}]; st.setState({ open: { ...st.getState().open, [${pj}]: { ...o, pending: [${stageReq(id, 'AskUserQuestion', askInput(true))}], version: o.version + 1 } } }); await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60))); return true; })()`);
          const clearAsk = () => js(`(() => { const st = window.__store; const o = st.getState().open[${pj}]; st.setState({ open: { ...st.getState().open, [${pj}]: { ...o, pending: [], version: o.version + 1 } } }); })()`);
          const card = '.pane.focused .chat-inner .ask-card';
          // keys go to whatever has the focus — never to a row picked here (that hid the focus falling to <body>: C-V1)
          const keyOn = (k, o = {}) => js(`(() => { const t = document.activeElement || document.body; t.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ctrlKey: ${!!o.ctrl}, isComposing: ${!!o.composing} })); return true; })()`);
          const inCard = () => js(`!!document.activeElement?.closest('${card}')`);
          const page = () => js(`document.querySelector('${card} .ask-page')?.textContent ?? null`);
          if (await exists('.rail .sb-reveal')) await click('.rail .sb-reveal');
          await sleep(300);
          const attnBefore = await count('.sidebar .sb-attn .sb-attn-item');
          await putAsk('smoke-ask-1');
          // C-U2: the box's Enter in the card's first moments (600 ms) does nothing and the card says why (and reads it out) — right away
          const soon = await js(`(async () => { const ta = document.querySelector('.pane.focused .composer textarea'); ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 250)); return { note: document.querySelector('${card} [data-id="ask-note"]')?.textContent ?? null, live: document.querySelector('${card} .pd-live[role="status"]')?.textContent ?? null, inCard: !!document.activeElement?.closest('.ask-card') }; })()`);
          await waitFor(`document.querySelectorAll('.sidebar .sb-attn .sb-attn-item').length > ${attnBefore}`, 3000);
          const placed = await js(`(() => { const c = document.querySelector('${card}'); if (!c) return null; const pd = document.querySelector('.pane.focused .chat-inner .plan-dock'); return { inDock: !!c.closest('.pdock'), dock: !!document.querySelector('.pane.focused .composer .pdock'), box: !!document.querySelector('.pane.focused .composer textarea'), beforePlan: !pd || !!(c.compareDocumentPosition(pd) & Node.DOCUMENT_POSITION_FOLLOWING), focusTaken: !!document.activeElement?.closest('.ask-card'), need: document.querySelector('${card} .ask-need')?.textContent ?? null }; })()`);
          const attnDuring = await count('.sidebar .sb-attn .sb-attn-item');
          check('question card: in the conversation (above the plan), not docked; the box stays; it does not take the focus; 需要你回答; the sidebar lists it under 需要你',
            !!placed && !placed.inDock && !placed.dock && placed.box && placed.beforePlan && !placed.focusTaken && placed.need === '需要你回答' && attnDuring > attnBefore, JSON.stringify({ placed, attnBefore, attnDuring }));
          check('question card: an Enter in its first moments says 「卡片刚出现…」 on the card and in its status line, the focus stays in the box', !!soon.note && soon.note.startsWith('卡片刚出现') && soon.live === soon.note && !soon.inCard, JSON.stringify(soon));
          // the box's empty Enter (after the card's 600 ms): the focus goes into the card, nothing is sent
          await sleep(700);
          const enterInto = await js(`(async () => { const ta = document.querySelector('.pane.focused .composer textarea'); ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 200)); return { inCard: !!document.activeElement?.closest('.ask-card'), sent: window.__permSent.filter((r) => r.requestId === 'smoke-ask-1').length }; })()`);
          check('question card: an empty Enter in the box moves the focus into the card and sends nothing', enterInto.inCard && enterInto.sent === 0, JSON.stringify(enterInto));
          // 1 picks the first option, Enter goes to 2 / 2, ‹ back keeps the pick
          const p1 = await page();
          await keyOn('1');
          const picked1 = await js(`document.querySelector('${card} .ask-opt[data-index="0"]')?.getAttribute('aria-checked')`);
          await keyOn('Enter');
          await sleep(150);
          const p2 = await page();
          const focus = { enter: await inCard() };
          await click(`${card} [data-act="prev"]`);
          await sleep(150);
          const back = { page: await page(), kept: await js(`document.querySelector('${card} .ask-opt[data-index="0"]')?.getAttribute('aria-checked')`) };
          focus.prev = await inCard();
          focus.onPick = await js(`document.activeElement === document.querySelector('${card} .ask-opt[data-index="0"]')`);
          await click(`${card} [data-act="next-page"]`);
          await sleep(150);
          focus.next = await inCard();
          check('question card: 1 / 2, the key 1 picks the first option, Enter goes on to 2 / 2, ‹ goes back with the pick kept', p1 === '1 / 2' && picked1 === 'true' && p2 === '2 / 2' && back.page === '1 / 2' && back.kept === 'true', JSON.stringify({ p1, picked1, p2, back }));
          // C-V1: the focus stays in the card on every page change (‹ lands on the page's chosen row), and the keys
          // still reach it: back with ‹, then Ctrl+Enter goes on again
          await click(`${card} [data-act="prev"]`);
          await sleep(150);
          await keyOn('Enter', { ctrl: true });
          await sleep(150);
          focus.ctrlPage = await page();
          focus.ctrl = await inCard();
          check('question card: the focus stays in the card after Enter, ‹, ›, Ctrl+Enter (‹ puts it on the chosen row)', focus.enter && focus.prev && focus.onPick && focus.next && focus.ctrl && focus.ctrlPage === '2 / 2', JSON.stringify(focus));
          // the preview of a focused option; 1 and 3 tick (multi), 其它 opens its box with the focus
          await js(`document.querySelector('${card} .ask-opt[data-index="0"]')?.focus()`);
          await sleep(150);
          const preview = await js(`document.querySelector('${card} .ask-preview')?.textContent ?? null`);
          await keyOn('1');
          await keyOn('3');
          await click(`${card} [data-act="other"]`);
          const otherBox = await waitFor(`document.activeElement === document.querySelector('${card} .ask-other')`, 2000);
          wc.insertText('e2e');
          await sleep(150);
          check('question card: a focused option shows its preview; 其它 opens a box that gets the focus', preview === 'npm run lint' && otherBox, JSON.stringify({ preview, otherBox }));
          await sleep(300);
          await shot('stage-c-ask');
          // IME: an Enter while composing does nothing
          await keyOn('Enter', { composing: true });
          await sleep(150);
          const ime = { page: await page(), sent: (JSON.parse(await sentFor('smoke-ask-1'))).length };
          check('question card: an Enter while the IME composes does nothing', ime.page === '2 / 2' && ime.sent === 0, JSON.stringify(ime));
          // Ctrl+Enter on the last page sends what the CLI expects
          await keyOn('Enter', { ctrl: true });
          await waitFor(`window.__permSent.some((r) => r.requestId === 'smoke-ask-1')`, 3000);
          const sent1 = JSON.parse(await sentFor('smoke-ask-1'));
          const ans1 = sent1[0]?.updatedInput?.answers;
          check('question card: Ctrl+Enter on the last page answers — { 用哪个库？: zod, 要哪些检查？: "lint, build, e2e" }', sent1.length === 1 && sent1[0].behavior === 'allow' && ans1?.['用哪个库？'] === 'zod' && ans1?.['要哪些检查？'] === 'lint, build, e2e', JSON.stringify(sent1));
          await clearAsk();
          await waitFor(`document.querySelectorAll('.sidebar .sb-attn .sb-attn-item').length < ${attnDuring}`, 3000);
          const attnAfter = await count('.sidebar .sb-attn .sb-attn-item');
          check('question card: answered → gone from the conversation and from 需要你', !(await exists(card)) && attnAfter < attnDuring, JSON.stringify({ attnDuring, attnAfter }));
          // one skipped, one answered → the skipped one says so; both skipped → deny
          await putAsk('smoke-ask-2');
          await click(`${card} .ask-opt[data-index="0"]`); // picked, then skipped: the skip wins and the pick goes
          await click(`${card} [data-act="skip"]`);
          await sleep(150);
          const afterSkip = { page: await page(), inCard: await inCard() };
          await click(`${card} [data-act="prev"]`);
          await sleep(150);
          afterSkip.backChecked = await count(`${card} .ask-opt[aria-checked="true"]`);
          afterSkip.said = await js(`document.querySelector('${card} [data-id="ask-skipped"]')?.textContent ?? null`);
          await click(`${card} [data-act="next-page"]`);
          await sleep(150);
          check('question card: 跳过 goes on with the focus in the card; back on that page nothing is chosen and it says 已跳过 (C-V1, C-V2)', afterSkip.page === '2 / 2' && afterSkip.inCard && afterSkip.backChecked === 0 && afterSkip.said === '已跳过', JSON.stringify(afterSkip));
          // multi choice: Space ticks the focused row (a real key), Enter goes on — here: submits (C-V3; it used to tick)
          await js(`document.querySelector('${card} .ask-opt[data-index="1"]')?.focus()`);
          await key('Space');
          const ticked = await js(`document.querySelector('${card} .ask-opt[data-index="1"]')?.getAttribute('aria-checked')`);
          await keyOn('Enter');
          check('question card: in a multi choice Space ticks the row and Enter goes on (submits on the last page)', ticked === 'true', JSON.stringify({ ticked }));
          await waitFor(`window.__permSent.some((r) => r.requestId === 'smoke-ask-2')`, 3000);
          const sent2 = JSON.parse(await sentFor('smoke-ask-2'));
          await clearAsk();
          await putAsk('smoke-ask-3');
          await click(`${card} [data-act="skip"]`);
          await sleep(150);
          await click(`${card} [data-act="skip"]`);
          await waitFor(`window.__permSent.some((r) => r.requestId === 'smoke-ask-3')`, 3000);
          const sent3 = JSON.parse(await sentFor('smoke-ask-3'));
          await clearAsk();
          check('question card: 跳过 one → 「（用户跳过）」 for it; 跳过 both → deny', sent2[0]?.behavior === 'allow' && sent2[0]?.updatedInput?.answers?.['用哪个库？'] === '（用户跳过）' && sent2[0]?.updatedInput?.answers?.['要哪些检查？'] === 'test' && sent3[0]?.behavior === 'deny', JSON.stringify({ sent2, sent3 }));
        }

        // ---- stage C2: 编辑项目 — the main folder (no ×), an extra folder → the files panel lists a group per folder,
        // 取消 sends nothing, 从侧栏移除项目 asks first (cancelled: the project stays)
        phase = 'stage-c-project';
        if (E.SMOKE_READONLY !== '1') {
          const extraDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cw-smoke-extra-'));
          fs.writeFileSync(path.join(extraDir, 'extra-file.txt'), 'extra');
          await js(`(async () => { const st = window.__store.getState(); if (!st.workspaces.some((w) => w.path.toLowerCase() === ${JSON.stringify(E.SMOKE_REPO.toLowerCase())})) await st.addWorkspace(${JSON.stringify(E.SMOKE_REPO)}); })()`);
          if (await exists('.rail .sb-reveal')) await click('.rail .sb-reveal');
          await sleep(300);
          const wsId = await js(`window.__store.getState().workspaces.find((w) => w.path.toLowerCase() === ${JSON.stringify(E.SMOKE_REPO.toLowerCase())})?.id ?? null`);
          await js(`(() => { window.__reqKinds = []; const orig = WebSocket.prototype.send; const wrap = function (d) { try { const m = JSON.parse(d); if (m && m.request && m.request.req) window.__reqKinds.push(m.request.req.kind); } catch {} return orig.call(this, d); }; wrap.__smoke = true; WebSocket.prototype.send = wrap; })()`);
          await ctxMenuAt(`.sidebar [data-group="${wsId}"] > .sb-group-head`);
          const menuEdit = await waitFor('!!document.querySelector(".menu [data-id=\\"edit\\"]")', 2000);
          if (menuEdit) await click('.menu [data-id="edit"]');
          const dlgShown = await waitFor('!!document.querySelector("[data-id=\\"project-dialog\\"] .project-dialog")', 2000);
          const rows = await js(`(() => { const d = document.querySelector('.project-dialog'); if (!d) return null; return { main: !!d.querySelector('.pj-folder.main'), mainX: !!d.querySelector('.pj-folder.main [data-act="remove-folder"]'), path: d.querySelector('.pj-folder.main .pj-path')?.textContent ?? null, name: d.querySelector('#pj-name')?.value ?? null }; })()`);
          await js(`[...document.querySelectorAll('.project-dialog .actions .btn')].find((b) => b.textContent === '取消')?.click()`);
          await sleep(300);
          const cancelled = { closed: !(await exists('.project-dialog')), sent: await js(`window.__reqKinds.filter((k) => k === 'workspaces.update').length`) };
          check('编辑项目: from the project menu; the main folder row has no ×; 取消 closes it and sends nothing', menuEdit && dlgShown && !!rows && rows.main && !rows.mainX && cancelled.closed && cancelled.sent === 0, JSON.stringify({ menuEdit, dlgShown, rows, cancelled }));
          // an extra folder: the files panel shows a group per folder
          await js(`window.__store.getState().updateWorkspace(${JSON.stringify(wsId)}, { folders: [${JSON.stringify(extraDir)}] })`);
          await waitFor(`(window.__store.getState().workspaces.find((w) => w.id === ${JSON.stringify(wsId)})?.folders ?? []).length === 1`, 3000);
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
          await sleep(350);
          if (!(await js('!!document.querySelector(".menu.sess-menu")'))) await click('.sess-head .sh-more > button');
          await waitFor('!!document.querySelector(".menu.sess-menu [data-view]")', 3000);
          await sleep(250);
          await click('.menu.sess-menu [data-view="files"]');
          const groups = await waitFor('document.querySelectorAll(".dock .files-view .fv-body:not([hidden]) .root-group").length === 2', 6000);
          const groupNames = await js(`[...document.querySelectorAll('.dock .files-view .fv-body:not([hidden]) .root-group-head')].map((h) => h.getAttribute('title'))`);
          check('a project with an extra folder: the files panel has a group per folder (main first)', groups && String(groupNames[1]).toLowerCase() === extraDir.toLowerCase(), JSON.stringify({ groups, groupNames }));
          // 从侧栏移除项目 asks first; cancelled, the project stays
          await ctxMenuAt(`.sidebar [data-group="${wsId}"] > .sb-group-head`);
          await waitFor('!!document.querySelector(".menu [data-id=\\"edit\\"]")', 2000);
          await click('.menu [data-id="edit"]');
          await waitFor('!!document.querySelector(".project-dialog [data-act=\\"remove-project\\"]")', 2000);
          const extraRow = await exists('.project-dialog .pj-folder:not(.main) [data-act="remove-folder"]');
          await click('.project-dialog [data-act="remove-project"]');
          const confirmShown = await waitFor('document.querySelectorAll(".dialog-bg .dialog").length >= 2', 2000);
          await js(`[...document.querySelectorAll('.dialog-bg .dialog:not(.project-dialog) .actions .btn')].find((b) => !b.classList.contains('danger') && !b.classList.contains('primary'))?.click()`);
          await sleep(300);
          const stays = await js(`window.__store.getState().workspaces.some((w) => w.id === ${JSON.stringify(wsId)})`);
          await js(`[...document.querySelectorAll('.project-dialog .actions .btn')].find((b) => b.textContent === '取消')?.click()`);
          check('编辑项目: the extra folder is listed with ×; 从侧栏移除项目 asks first — cancelled, the project stays', extraRow && confirmShown && stays, JSON.stringify({ extraRow, confirmShown, stays }));
          await js(`window.__store.getState().updateWorkspace(${JSON.stringify(wsId)}, { folders: [] })`);
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`);
          await sleep(300);
          try { fs.rmSync(extraDir, { recursive: true, force: true }); } catch { /* windows may hold it */ }
        }

        // ---- stage F: 项目页 tabs (说明 / 资料 / 对话), 派活 / 已发布 / 导入 claude.ai from the palette, 发布 from a file —
        // each opens, shows its parts and closes with Esc / 取消 without sending anything it should not
        phase = 'stage-f-cloud';
        if (E.SMOKE_READONLY !== '1') {
          const wsF = await js(`window.__store.getState().workspaces[0]?.id ?? null`);
          let tabs = null;
          if (wsF) {
            if (await exists('.rail .sb-reveal')) await click('.rail .sb-reveal');
            await sleep(250);
            await ctxMenuAt(`.sidebar [data-group="${wsF}"] > .sb-group-head`);
            if (await waitFor('!!document.querySelector(".menu [data-id=\\"edit\\"]")', 2000)) await click('.menu [data-id="edit"]');
            await waitFor('!!document.querySelector("[data-id=\\"project-page\\"]")', 2000);
            tabs = {};
            for (const t of ['instructions', 'files', 'conversations', 'settings']) {
              await click(`[data-id="project-page"] [data-tab="${t}"]`);
              await sleep(250);
              tabs[t] = await js(`(() => { const d = document.querySelector('[data-id="project-page"]'); if (!d) return false; const sel = { instructions: '#pj-instr', files: '[data-id="project-files"] .pj-drop', conversations: '[data-id="project-conversations"]', settings: '#pj-name' }[${JSON.stringify(t)}]; const el = d.querySelector(sel); return !!el && !!el.offsetParent; })()`);
            }
            await js(`[...document.querySelectorAll('.project-dialog .actions .btn')].find((b) => b.textContent === '取消')?.click()`);
            await sleep(250);
          }
          check('项目页: 说明 / 资料 / 对话 / 设置 tabs each show their part', !!tabs && Object.values(tabs).every(Boolean), JSON.stringify(tabs));
          const viaPalette = async (q, label, sel) => {
            await js('window.__store.setState({ paletteOpen: true })');
            await waitFor('!!document.querySelector(".cmdk input")', 3000);
            await js('document.querySelector(".cmdk input").focus()');
            wc.insertText(`>${q}`);
            await sleep(300);
            const ok = await js(`(() => { const it = [...document.querySelectorAll('.cmdk .it')].find((x) => x.querySelector('.t')?.textContent === ${JSON.stringify(label)}); if (!it) return false; it.setAttribute('data-smoke-pick', 'f'); return true; })()`);
            if (ok) await click('[data-smoke-pick="f"]');
            const shown = ok && await waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 4000);
            await key('Escape');
            await sleep(250);
            const closed = !(await exists(sel));
            if (await js('window.__store.getState().paletteOpen')) await js('window.__store.setState({ paletteOpen: false })');
            return { ok, shown, closed };
          };
          const disp = await viaPalette('派活', '派活…', '[data-id="dispatch-dialog"] textarea');
          check('派活: from the palette, a task box, Esc closes it', disp.ok && disp.shown && disp.closed, JSON.stringify(disp));
          const pubs = await viaPalette('已发布', '已发布的文件', '[data-id="published-dialog"]');
          check('已发布: from the palette, Esc closes it', pubs.ok && pubs.shown && pubs.closed, JSON.stringify(pubs));
          const imp = await viaPalette('claude.ai', '导入 claude.ai 数据…', '[data-id="claudeai-import"] [data-act="pick-zip"]');
          check('导入 claude.ai 数据: from the palette, a zip picker, Esc closes it', imp.ok && imp.shown && imp.closed, JSON.stringify(imp));
          // 发布 from a file's right-click menu: the dialog with the three expiries; closing it publishes nothing
          const pubFile = path.join(E.SMOKE_REPO, 'README.md');
          await js(`(() => { const el = document.createElement('span'); el.id = 'smoke-f-file'; el.textContent = 'x'; el.style.cssText = 'position:fixed;left:40px;top:40px;z-index:99999'; document.body.appendChild(el); })()`);
          await js(`(() => { window.__fReq = []; const orig = WebSocket.prototype.send; const wrap = function (d) { try { const m = JSON.parse(d); if (m && m.request && m.request.req) window.__fReq.push(m.request.req.kind); } catch {} return orig.call(this, d); }; WebSocket.prototype.send = wrap; })()`);
          // the file menu is opened the way fileMenuProps does it (a contextmenu with the path), on a throwaway element
          await js(`window.__openFileMenu ? window.__openFileMenu(${JSON.stringify(pubFile)}) : null`);
          const fm = await js(`!!window.__openFileMenu`);
          let pubDlg = null;
          if (fm && await waitFor('!!document.querySelector(".file-menu [data-act=\\"publish\\"]")', 2000)) {
            await click('.file-menu [data-act="publish"]');
            const shown = await waitFor('!!document.querySelector("[data-id=\\"publish-dialog\\"] [data-exp=\\"never\\"]")', 3000);
            const exps = await js(`[...document.querySelectorAll('[data-id="publish-dialog"] [data-exp]')].map((b) => b.dataset.exp)`);
            await key('Escape');
            await sleep(250);
            pubDlg = { shown, exps, closed: !(await exists('[data-id="publish-dialog"]')), sent: await js(`window.__fReq.filter((k) => k === 'publish.create').length`) };
          }
          await js(`document.getElementById('smoke-f-file')?.remove()`);
          check('发布: from the file menu, 1 天 / 7 天 / 永久; closing publishes nothing', !fm || (!!pubDlg && pubDlg.shown && pubDlg.exps.join() === '1d,7d,never' && pubDlg.closed && pubDlg.sent === 0), JSON.stringify({ fm, pubDlg }));
          // nothing of this section may stay open over the checks after it
          await js(`[...document.querySelectorAll('.dialog-bg .cloud-dialog .actions .btn')].filter((b) => /^(关闭|取消|完成)$/.test(b.textContent.trim())).forEach((b) => b.click())`);
          await sleep(200);
        }

        // ---- re-review I-2: a provider picked on the chips of a conversation that is not running is recorded like
        // session.setProvider when the send reopens it — SessionMeta.providerId and the canonical 「switch」 line (usage
        // attribution, the hand-over briefing). The mock agent's conversation: the provider's endpoint is never called.
        if (E.SMOKE_DATA) {
          phase = 'chat-resume-provider';
          const prov = await serverRequest({ kind: 'providers.upsert', provider: { name: 'Smoke 供应商', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'smoke-placeholder-not-a-key', models: ['smoke-m1'], defaultModel: 'smoke-m1' } });
          const provJ = JSON.stringify(prov.id);
          await js(`window.__store.getState().closeSession(${pj})`);
          await js(`window.__store.getState().loadHistory(${pj})`);
          const ready = await waitFor(`window.__store.getState().open[${pj}]?.state === 'history' && !window.__store.getState().open[${pj}]?.loading && window.__store.getState().providers.some((p) => p.id === ${provJ}) && !!document.querySelector('.pane.focused .composer .cb-status')`, 10_000);
          await click('.pane.focused .composer .composer-under .mm-anchor > button.chip');
          const rowSel = `.menu.mm [data-sec=${provJ}] .mm-row:not(.off)`;
          const listed = await waitFor(`!!document.querySelector('${rowSel}')`, 5000);
          if (listed) await click(rowSel);
          await sleep(300);
          if (await js(`!!document.querySelector('.menu.mm')`)) await key('Escape');
          const picked = await js(`JSON.stringify(window.__store.getState().open[${pj}]?.resume ?? null)`);
          await js(`window.__store.getState().send(${pj}, 'smoke: resume on the picked one')`);
          const metaOk = await waitFor(`window.__store.getState().sessionMeta[${pj}]?.providerId === ${provJ}`, 15_000);
          const canonFile = path.join(E.SMOKE_DATA, 'canonical', `${psid}.jsonl`);
          let sw = [];
          for (let i = 0; i < 30 && !sw.length; i++) {
            try { sw = fs.readFileSync(canonFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'switch'); } catch { /* not written yet */ }
            if (!sw.length) await sleep(200);
          }
          check('a provider picked on the chips of a conversation not running → the send records it like 换供应商: SessionMeta and one canonical switch line (from the account)', ready && listed && JSON.parse(picked)?.providerId === prov.id && metaOk && sw.length === 1 && sw[0].providerId === prov.id && sw[0].fromProviderId === 'claude' && /Smoke 供应商/.test(sw[0].note ?? ''), JSON.stringify({ ready, listed, picked, metaOk, sw }));
          await waitFor(`window.__store.getState().open[${pj}]?.state === 'idle'`, 20_000);
          await serverRequest({ kind: 'providers.remove', id: prov.id });
        }

        // ---- the goal bar, and a goal that runs two rounds (review I1): GoalService sends round 2 (「继续」) itself — the
        // window shows it from the server's copy of what was sent (hub `cw_echo`), a turn of its own. The mock answers its first goal prompt
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
          await click(':is(.app.has-rail .rail [data-id="chat"], .app.mobile .auto-page .auto-head button[aria-label="关闭自动化"])');
          await waitFor('document.querySelector(".auto-page")?.hidden === true', 2000);
          win.setContentSize(1360, 860);
          await waitFor('!document.querySelector(".app").classList.contains("mobile")', 4000);
          await sleep(300);
          // round 2 running: round 1 folded with its own line, round 2 open with its running command in view
          const turnsNow = `(() => { const turns = [...document.querySelectorAll('.pane.focused .chat .turn')]; const last = turns[turns.length - 1], prev = turns[turns.length - 2]; return { n: turns.length, lastId: last?.dataset.turn ?? null, prevFolded: !!prev && prev.classList.contains('folded') && !prev.classList.contains('open'), prevSum: prev?.querySelector('.turn-sum')?.textContent ?? null, lastOpen: !!last && !last.classList.contains('folded'), running: !!last && [...last.querySelectorAll('.tl.active, .tl.pending')].some((el) => el.offsetParent !== null) }; })()`;
          const round2 = await waitFor(`/第 2 轮/.test(${barText}) && (${turnsNow}).running`, 30_000);
          const r2 = await js(turnsNow);
          check('a goal\'s second round: round 1 folded with its own line, round 2 (sent by the goal, not this window) open with its running step in view', round2 && r2.n >= 2 && r2.prevFolded && /^已处理/.test(r2.prevSum ?? '') && r2.lastOpen && r2.running, JSON.stringify(r2));
          await sleep(400);
          await shot('chat-goal-round2');
          check('the bar goes once the goal is done', await waitFor(`!document.querySelector('.pane.focused .goal-bar')`, 30_000));
          const folded = await waitFor(`(() => { const turns = [...document.querySelectorAll('.pane.focused .chat .turn')].slice(-2); return turns.length === 2 && turns.every((t) => t.classList.contains('folded') && /^已处理/.test(t.querySelector('.turn-sum')?.textContent ?? '')); })()`, 8000);
          check('…then both rounds are folded, each with its own summary line', folded, await js(`JSON.stringify([...document.querySelectorAll('.pane.focused .chat .turn')].map((t) => [t.dataset.turn, t.className, t.querySelector('.turn-sum')?.textContent ?? null]))`));
          // 分享本轮 under round 2's answer exports round 2 — its own turn, not round 1 (review M-4). The
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
            return { id: last.dataset.turn, prev: turns[turns.length - 2]?.dataset.turn ?? null, exported: [...doc.querySelectorAll('.turn')].map((t) => t.dataset.turn) };
          })()`);
          check('分享本轮 under a round this window did not start exports that round, not the one before', !!shared && !!shared.id && shared.id !== shared.prev && Array.isArray(shared.exported) && shared.exported.length === 1 && shared.exported[0] === shared.id, JSON.stringify(shared));
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

      // ---- stage B (the built-in browser): its hooks, in a second window that can host it (a <webview> tag, and a
      // stand-in for the desktop shell's bridge with the shell's real file guard and viewport emulation behind it)
      if (E.SMOKE_READONLY !== '1') {
        phase = 'browser-b';
        const http = require('node:http');
        const { ipcMain, webContents: allWc, session } = require('electron');
        const D = (m) => require(path.join(ROOT, 'desktop', 'dist', m));
        const { FileGuard, guardSession } = D('file-guard.js');
        const { emulate, cleanVp, endStuckPage, BROWSER_PARTITIONS, LOCAL_PARTITION } = D('guest-tools.js');
        const guard = new FileGuard();
        for (const p of [...BROWSER_PARTITIONS, LOCAL_PARTITION]) guardSession(session.fromPartition(p), guard);
        // as main.ts desktop:browser:recover does (the shell's own code): a page stuck in a script is ended and loaded
        // again once its renderer is gone; never one in the app window's process
        ipcMain.handle('smoke:recover', (_e, id) => { const g = allWc.fromId(id); return !!g && endStuckPage(g, _e.sender.getOSProcessId()); });
        ipcMain.handle('smoke:allowFile', (_e, u) => guard.allowOnce(u));
        ipcMain.handle('smoke:emulate', async (_e, id, vp) => { const g = allWc.fromId(id); if (!g) return false; await emulate(g, cleanVp(vp) ?? null, { base: g.getUserAgent(), uaFor: () => g.getUserAgent() }); return true; });
        const site = http.createServer((req, res) => {
          if (req.url === '/slow') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.write('<!doctype html><title>Slow</title><p>still coming'); return; } // never ends: a page that keeps loading
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<!doctype html><html><head><title>B Page</title><meta name="viewport" content="width=device-width"></head><body style="margin:0;font:15px sans-serif"><button id="b" style="position:absolute;left:40px;top:40px;width:160px;height:50px" onclick="document.title=\'pressed\'">Press</button><p style="position:absolute;top:140px;left:40px">Stage B page</p></body></html>');
        });
        await new Promise((r) => site.listen(0, '127.0.0.1', r));
        const SITE = `http://127.0.0.1:${site.address().port}`;
        const preload = path.join(out, 'browser-b-preload.js');
        fs.writeFileSync(preload, `const { ipcRenderer } = require('electron');
window.__smokeExternal = [];
window.desktop = {
  version: '0.0.0-smoke', platform: 'win32',
  pickDir: async () => null, openPath: async () => {}, openExternal: async (u) => { window.__smokeExternal.push(String(u)); },
  notify() {}, setBadge() {}, setTitleBarColors() {}, getLoginItem: async () => false, setLoginItem: async () => {},
  onCommand: () => () => {}, onFocusSession: () => () => {},
  allowFileOnce: (u) => ipcRenderer.invoke('smoke:allowFile', u),
  guestEmulate: (id, vp) => ipcRenderer.invoke('smoke:emulate', id, vp),
  guestRecover: (id) => ipcRenderer.invoke('smoke:recover', id),
  saveScreenshot: async () => null, pickHtmlFile: async () => null, importCookies: async () => false, clearBrowsingData: async () => true,
};`);
        const bw = new BrowserWindow({ width: 1320, height: 860, show: false, webPreferences: { webviewTag: true, preload, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
        bw.showInactive();
        const bwc = bw.webContents;
        // as the desktop shell does: a page of the browser gets no preload, opens no window, and its profile is guarded
        bwc.on('will-attach-webview', (_e, prefs, params) => { delete prefs.preload; prefs.nodeIntegration = false; prefs.contextIsolation = true; guardSession(session.fromPartition(params.partition || ''), guard); });
        bwc.on('did-attach-webview', (_e, g) => { g.setWindowOpenHandler(() => ({ action: 'deny' })); });
        bwc.on('console-message', (a, b, c) => {
          const level = typeof a === 'object' && a && 'level' in a ? a.level : b;
          const message = typeof a === 'object' && a && 'message' in a ? a.message : c;
          if (level === 'error' || level === 'warning' || Number(level) >= 2) res.console.push({ phase, level: String(level), message: String(message).slice(0, 800) });
        });
        const bjs = (code) => bwc.executeJavaScript(code, true);
        const bwait = async (code, ms = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await bjs(code).catch(() => false)) return true; await sleep(150); } return false; };
        let bseq = 0;
        // as the server sends it: a page-changing op carries the `site` its check judged (service.ts gated) — the tab's own host
        const op = (sessionId, o, args = {}) => bjs(`(() => { const c = ${JSON.stringify({ id: `b${++bseq}`, sessionId, op: o, args })}; const B = window.__cwBrowser;
          const gated = ['click', 'type', 'key', 'scroll', 'hover', 'drag', 'select', 'eval'].includes(c.op) || (c.op === 'computer' && !['screenshot', 'wait'].includes(c.args.action));
          if (gated && !('site' in c.args)) c.args.site = B.siteOf(c.sessionId);
          return B.carryOut(c); })().then((a) => ({ ok: true, a }), (e) => ({ ok: false, error: String(e && e.message || e) }))`);
        const bkey = async (keyCode) => { bwc.sendInputEvent({ type: 'keyDown', keyCode }); bwc.sendInputEvent({ type: 'keyUp', keyCode }); await sleep(250); };
        const openMore = async () => { await bjs(`document.querySelector('.bw [data-id=more]').click()`); return bwait(`!!document.querySelector('.cm-ref [data-act]')`, 3000); };
        const tabSel = (id) => `.bw-view[data-tab="${id}"]`;
        try {
          await bwc.loadURL(E.SMOKE_URL);
          const up = await bwait(`!!window.__store && window.__store.getState().connected && window.__store.getState().metaLoaded && !!window.__cwBrowser && window.__cwBrowser.canHost()`, 30_000);
          check('browser-b: a window that can host the browser is up (desktop bridge stand-in, <webview>)', up);
          await bjs(`window.__store.getState().setSetting('onboarded', true)`);
          await sleep(500);

          // a link in a reply opens as a tab of the built-in browser (desktop), not in the system browser
          await bjs(`window.__store.getState().loadHistory(${JSON.stringify(E.SMOKE_TOOLS_SID)})`);
          const linkShown = await bwait(`[...document.querySelectorAll('.msg.assistant .md a')].some((a) => a.textContent === 'smoke-web-link')`, 15_000);
          await bjs(`[...document.querySelectorAll('.msg.assistant .md a')].find((a) => a.textContent === 'smoke-web-link').click()`);
          const linkTab = await bwait(`window.__cwBrowser.state.getState().tabs.some((t) => t.url === 'https://example.invalid/stage-b')`, 8000);
          const ext = await bjs(`window.__smokeExternal.slice()`);
          check('browser-b: a web link in a reply opens as a built-in browser tab (not the system browser)', linkShown && linkTab && ext.length === 0, `shown=${linkShown} tab=${linkTab} external=${JSON.stringify(ext)}`);

          // an Agent's page, in front
          const A = 'smoke-browser-b';
          const opened = await op(A, 'open', { url: `${SITE}/page` });
          const aid = await bjs(`window.__cwBrowser.state.getState().tabs.find((t) => t.agent === ${JSON.stringify(A)})?.id`);
          await bjs(`window.__cwBrowser.state.setState({ active: ${JSON.stringify(aid)} })`);
          await bwait(`!!document.querySelector('${tabSel(aid)}') && !document.querySelector('${tabSel(aid)}').hidden`, 5000);
          check('browser-b: the Agent opens a page (carryOut open)', opened.ok && opened.a.page?.title === 'B Page', JSON.stringify(opened).slice(0, 200));

          // ⋯ menu: every item
          await openMore();
          const acts = await bjs(`[...document.querySelectorAll('.cm-ref [data-act]')].map((b) => b.dataset.act)`);
          const want = ['external', 'copy-url', 'screenshot', 'viewport', 'open-html', 'devtools', 'open-links', 'open-files', 'auto-verify', 'allowed-sites', 'import-cookies', 'cookies', 'clear-data'];
          check('browser-b: the ⋯ menu has screenshot, local HTML, viewport, the three switches, allowed sites, the Cookie items and clear data', want.every((a) => acts.includes(a)), `missing=${want.filter((a) => !acts.includes(a)).join(',')} got=${acts.join(',')}`);
          await bjs(`document.querySelector('.cm-ref [data-act=cookies]').click()`);
          const cookieRows = await bwait(`document.querySelectorAll('[data-id=cookies-menu] [data-cookies]').length === 3`, 3000);
          check('browser-b: 保留 Cookie lists its three choices', cookieRows, await bjs(`[...document.querySelectorAll('[data-id=cookies-menu] [data-cookies]')].map((b) => b.dataset.cookies).join(',')`));
          await bkey('Escape');
          await bkey('Escape');

          // viewport: phone changes the page's size
          const size = () => bjs(`(() => { const w = document.querySelector('${tabSel(aid)} webview'); if (!w) return null; return w.executeJavaScript('innerWidth + "x" + innerHeight').then((inner) => ({ css: w.offsetWidth + 'x' + w.offsetHeight, inner, vp: document.querySelector('${tabSel(aid)}').dataset.viewport || null })); })()`);
          const before = await size();
          await openMore();
          await bjs(`document.querySelector('.cm-ref [data-act=viewport]').click()`);
          await bwait(`!!document.querySelector('[data-id=viewport-menu] [data-vp=phone]')`, 3000);
          await bjs(`document.querySelector('[data-id=viewport-menu] [data-vp=phone]').click()`);
          await bwait(`document.querySelector('${tabSel(aid)}')?.dataset.viewport === 'phone'`, 4000);
          await sleep(800);
          const phone = await size();
          check('browser-b: the phone viewport resizes the page (the webview 390×844, the page sees 390 wide)', !!before && !!phone && phone.css === '390x844' && /^390x/.test(phone.inner) && before.css !== phone.css, `${JSON.stringify(before)} → ${JSON.stringify(phone)}`);
          await bjs(`window.__cwBrowser.state.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === ${JSON.stringify(aid)} ? { ...t, viewport: undefined } : t)) }))`);
          await sleep(600);

          // the stop button while a page loads; reload once it stopped
          await bjs(`(() => { const s = window.__cwBrowser.state; const t = s.getState().tabs.find((x) => x.id === ${JSON.stringify(aid)}); s.setState({ tabs: [...s.getState().tabs, { ...t, id: 'bslow', agent: undefined, src: ${JSON.stringify(`${SITE}/slow`)}, url: ${JSON.stringify(`${SITE}/slow`)}, title: '', loading: true, viewport: undefined }], active: 'bslow' }); })()`);
          const stopShown = await bwait(`!!document.querySelector('.bw [data-id=stop]') && window.__cwBrowser.state.getState().tabs.find((t) => t.id === 'bslow')?.loading === true`, 8000);
          await sleep(500);
          const stillLoading = await bjs(`!!document.querySelector('.bw [data-id=stop]')`);
          await bjs(`document.querySelector('.bw [data-id=stop]')?.click()`);
          const stopped = await bwait(`!!document.querySelector('.bw [data-id=reload]') && !window.__cwBrowser.state.getState().tabs.find((t) => t.id === 'bslow')?.loading`, 5000);
          check('browser-b: while a page loads the bar shows 停止加载; clicking it stops the load (重新加载 is back)', stopShown && stillLoading && stopped, `shown=${stopShown} still=${stillLoading} stopped=${stopped}`);
          await bjs(`window.__cwBrowser.state.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== 'bslow'), active: ${JSON.stringify(aid)} }))`);
          await sleep(600);

          // annotate: the bar, a rectangle counts 1, closing with a mark asks first
          await bjs(`document.querySelector('.bw [data-id=annotate-btn]').click()`);
          const annOpen = await bwait(`(() => { const a = document.querySelector('.bw-ann[data-id=annotate]'); return !!a && !a.hidden; })()`, 4000);
          await bjs(`document.querySelector('.bw-ann [data-act=ann-rect]').click()`);
          await sleep(300);
          const box = await bjs(`(() => { const c = document.querySelector('.bw-ann canvas') || document.querySelector('.bw-ann'); const r = c.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
          const x0 = box.x + 60, y0 = box.y + 80;
          bwc.sendInputEvent({ type: 'mouseMove', x: x0, y: y0 });
          bwc.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
          for (let i = 1; i <= 6; i++) { bwc.sendInputEvent({ type: 'mouseMove', x: x0 + i * 25, y: y0 + i * 15, button: 'left', modifiers: ['leftButtonDown'] }); await sleep(30); }
          bwc.sendInputEvent({ type: 'mouseUp', x: x0 + 150, y: y0 + 90, button: 'left', clickCount: 1 });
          const counted = await bwait(`/1/.test(document.querySelector('.bw-ann [data-id=annotate-count]')?.textContent || '')`, 3000);
          check('browser-b: 标注 — the bar appears, one rectangle makes the count 1', annOpen && counted, `open=${annOpen} count=${await bjs(`document.querySelector('.bw-ann [data-id=annotate-count]')?.textContent`)} box=${JSON.stringify(box)}`);
          await bjs(`document.querySelector('.bw-ann [data-act=ann-close]').click()`);
          const asked = await bwait(`!!document.querySelector('.modal.dialog')`, 3000);
          await bjs(`document.querySelector('.modal.dialog .actions .btn').click()`); // 取消: it stays
          await sleep(400);
          const kept = await bjs(`(() => { const a = document.querySelector('.bw-ann[data-id=annotate]'); return !!a && !a.hidden; })()`);
          await bjs(`document.querySelector('.bw-ann [data-act=ann-close]').click()`);
          await bwait(`!!document.querySelector('.modal.dialog')`, 3000);
          await bjs(`document.querySelector('.modal.dialog .actions .btn.danger, .modal.dialog .actions .btn:last-child').click()`);
          const gone = await bwait(`(() => { const a = document.querySelector('.bw-ann[data-id=annotate]'); return !a || a.hidden; })()`, 3000);
          check('browser-b: closing 标注 with a mark asks 丢掉标注？ — 取消 keeps it, 丢掉 closes it', asked && kept && gone, `asked=${asked} kept=${kept} gone=${gone}`);

          // the Agent's cursor on a click; 接管 refuses the next click; 交还
          const pressRef = (opened.a?.page?.elements ?? []).find((e) => /Press/.test(e.name))?.ref;
          const clicked = await op(A, 'click', { ref: pressRef });
          const cursor = await bwait(`!!document.querySelector('${tabSel(aid)} [data-id=agent-cursor][data-shown=true]')`, 3000);
          check('browser-b: the Agent\'s cursor shows over the page when it clicks (carryOut click)', clicked.ok && cursor, `${JSON.stringify(clicked).slice(0, 160)} cursor=${cursor}`);
          await bjs(`document.querySelector('.bw [data-id=agent-strip] [data-id=takeover]').click()`);
          await bwait(`!!document.querySelector('.bw [data-id=agent-strip][data-taken=true]')`, 3000);
          const refused = await op(A, 'click', { ref: pressRef });
          await bjs(`document.querySelector('.bw [data-id=agent-strip] [data-id=giveback]').click()`);
          const back = await op(A, 'click', { ref: pressRef });
          check('browser-b: after 接管 a carryOut click is refused (用户接管了浏览器); after 交还 it works again', !refused.ok && /用户接管了浏览器/.test(refused.error) && back.ok, `${JSON.stringify(refused).slice(0, 160)} back=${back.ok}`);

          // the owed security check: a file:// page the app let in starts a blob: Worker and a SharedWorker that
          // fetch (and sync-XHR) a secret file — both must fail (desktop/src/file-guard.ts serves the page with a CSP)
          const wkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-smoke-wk-'));
          const secret = path.join(wkDir, 'secret.txt');
          fs.writeFileSync(secret, 'SMOKE-SECRET-B');
          const secretUrl = require('node:url').pathToFileURL(secret).href;
          const probe = `self.onconnect = (e) => { const p = e.ports[0]; go((m) => p.postMessage(m)); }; self.onmessage = () => go((m) => self.postMessage(m));
function go(say) { fetch(${JSON.stringify(secretUrl)}).then((r) => r.text()).then((t) => say('READ:' + t), (e) => say('FAILED:' + e)); try { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(secretUrl)}, false); x.send(); say('XHR:' + x.responseText); } catch (e) { say('XHRFAILED:' + e); } }`;
          const wkPage = path.join(wkDir, 'worker.html');
          fs.writeFileSync(wkPage, `<!doctype html><html><head><title>Worker probe</title></head><body><script>
window.__res = { dedicated: [], shared: [] };
const src = ${JSON.stringify(probe)};
try { const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); w.onmessage = (e) => window.__res.dedicated.push(String(e.data)); w.onerror = () => window.__res.dedicated.push('ERROR'); w.postMessage('go'); } catch (e) { window.__res.dedicated.push('START-FAILED:' + e); }
try { const s = new SharedWorker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); s.port.onmessage = (e) => window.__res.shared.push(String(e.data)); s.onerror = () => window.__res.shared.push('ERROR'); s.port.start(); } catch (e) { window.__res.shared.push('START-FAILED:' + e); }
</script></body></html>`);
          const wkUrl = require('node:url').pathToFileURL(wkPage).href;
          const allowed = await bjs(`window.desktop.allowFileOnce(${JSON.stringify(wkUrl)})`);
          await bjs(`(() => { const s = window.__cwBrowser.state; const t = s.getState().tabs[0]; s.setState({ tabs: [...s.getState().tabs, { ...t, id: 'bfile', agent: undefined, src: ${JSON.stringify(wkUrl)}, url: ${JSON.stringify(wkUrl)}, title: '', loading: true, viewport: undefined }], active: 'bfile' }); })()`);
          const fileLoaded = await bwait(`(() => { const w = document.querySelector('${tabSel('bfile')} webview'); return !!w && w.getURL().startsWith('file:') && !w.isLoading(); })()`, 15_000);
          await sleep(3000);
          const wk = await bjs(`document.querySelector('${tabSel('bfile')} webview').executeJavaScript('JSON.stringify(window.__res)')`).then((s) => JSON.parse(s), (e) => ({ error: String(e) }));
          const leaked = (a) => !Array.isArray(a) || a.some((m) => /SMOKE-SECRET-B/.test(m));
          check('browser-b · security: in a file:// page the app opened, neither a blob: Worker nor a SharedWorker can read a local file', allowed === true && fileLoaded && !leaked(wk.dedicated) && !leaked(wk.shared) && wk.dedicated.length > 0 && wk.shared.length > 0, `allowed=${allowed} loaded=${fileLoaded} ${JSON.stringify(wk)}`);
          try { fs.rmSync(wkDir, { recursive: true, force: true }); } catch { /* busy */ }

          // ---- stage B fix wave
          // U6: a local page the app opened shows its own style / script / picture next to it (in the cw-local
          // profile); fetch of a sibling file still fails, a Worker still does not start
          const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-smoke-local-'));
          fs.writeFileSync(path.join(siteDir, 'style.css'), 'body { background: rgb(1, 2, 3); }');
          fs.writeFileSync(path.join(siteDir, 'app.js'), 'window.__js = "ran";');
          fs.writeFileSync(path.join(siteDir, 'sibling.txt'), 'SMOKE-SIBLING');
          fs.writeFileSync(path.join(siteDir, 'pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
          fs.writeFileSync(path.join(siteDir, 'index.html'), `<!doctype html><html><head><title>Local site</title><link rel="stylesheet" href="style.css"><script src="app.js"></script></head><body><img src="pic.png" alt=""><script>
window.__fetch = 'pending';
fetch('sibling.txt').then((r) => r.text()).then((t) => { window.__fetch = 'READ:' + t; }, (e) => { window.__fetch = 'FAILED'; });
try { const w = new Worker('app.js'); w.onerror = () => { window.__worker = 'ERROR'; }; window.__worker = 'STARTED'; } catch (e) { window.__worker = 'START-FAILED'; }
</script></body></html>`);
          const siteUrl = require('node:url').pathToFileURL(path.join(siteDir, 'index.html')).href;
          const siteOk = await bjs(`window.desktop.allowFileOnce(${JSON.stringify(siteUrl)})`);
          await bjs(`(() => { const s = window.__cwBrowser.state; const t = s.getState().tabs[0]; s.setState({ tabs: [...s.getState().tabs, { ...t, id: 'blocal', agent: undefined, partition: 'cw-local', src: ${JSON.stringify(siteUrl)}, url: ${JSON.stringify(siteUrl)}, title: '', loading: true, viewport: undefined, error: undefined }], active: 'blocal' }); })()`);
          const localLoaded = await bwait(`(() => { const w = document.querySelector('${tabSel('blocal')} webview'); return !!w && w.getURL().startsWith('file:') && !w.isLoading(); })()`, 15_000);
          await sleep(1500);
          const lp = await bjs(`document.querySelector('${tabSel('blocal')} webview').executeJavaScript('JSON.stringify({ bg: getComputedStyle(document.body).backgroundColor, js: window.__js, img: document.images[0] && document.images[0].naturalWidth, fetch: window.__fetch, worker: window.__worker })')`).then((x) => JSON.parse(x), (e) => ({ error: String(e) }));
          const part = await bjs(`document.querySelector('${tabSel('blocal')} webview').getAttribute('partition')`);
          check('fix wave U6: a local page shows its own css / js / picture from its folder; fetch of a sibling file fails; a Worker does not start; it is in the cw-local profile', siteOk === true && localLoaded && lp.bg === 'rgb(1, 2, 3)' && lp.js === 'ran' && lp.img === 1 && lp.fetch === 'FAILED' && lp.worker !== 'STARTED' && part === 'cw-local', `ok=${siteOk} loaded=${localLoaded} part=${part} ${JSON.stringify(lp)}`);
          // V1 / V2: a local page the shell refused (never granted) — the scripts that look at it do not take the app
          // window down, and the tab says why it is empty
          const nope = require('node:url').pathToFileURL(path.join(siteDir, 'sibling.txt')).href;
          await bjs(`(() => { const s = window.__cwBrowser.state; const t = s.getState().tabs[0]; s.setState({ tabs: [...s.getState().tabs, { ...t, id: 'bblank', agent: 'smoke-blank', partition: 'cw-local', src: ${JSON.stringify(nope)}, url: ${JSON.stringify(nope)}, title: '', loading: true, viewport: undefined, error: undefined }], active: 'bblank' }); })()`);
          const said = await bwait(`!!document.querySelector('${tabSel('bblank')} .bw-error')`, 10_000);
          const saidText = await bjs(`(document.querySelector('${tabSel('bblank')} .bw-error') || {}).textContent || ''`);
          const chk = await bjs(`Promise.resolve(window.__cwBrowser.checkPage('bblank')).then((x) => 'ok:' + JSON.stringify(x).slice(0, 80), (e) => 'err:' + String(e && e.message || e))`).catch((e) => 'THREW:' + e);
          const rd = await op('smoke-blank', 'read');
          const ev = await op('smoke-blank', 'eval', { script: '1+1' });
          const alive = await bjs('1 + 1').catch(() => 0);
          check('fix wave V1: scripts on a refused / blank local tab (page check, read, eval) do not crash the app window', alive === 2 && !/THREW/.test(chk), `alive=${alive} check=${chk} read=${JSON.stringify(rd).slice(0, 120)} eval=${JSON.stringify(ev).slice(0, 120)}`);
          check('fix wave V2: a refused local page says so in its tab (not a silent blank page)', said && /本地/.test(saidText), `said=${said} ${saidText.slice(0, 160)}`);
          try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch { /* busy */ }

          // A5: a browser_eval that never yields (an endless loop) is given up on, the page ended and loaded again,
          // and the next op works
          await bjs(`window.__cwBrowser.state.setState({ active: ${JSON.stringify(aid)} })`);
          const t0 = Date.now();
          const loop = await op(A, 'eval', { script: 'while (1) {}' });
          const took = Date.now() - t0;
          await sleep(2500);
          let next = await op(A, 'read');
          if (!next.ok) { await sleep(2500); next = await op(A, 'read'); }
          check('fix wave A5: an eval that never yields times out (about 15 s), and the next op on the page works', !loop.ok && /卡住/.test(loop.error) && took < 25_000 && next.ok && /Stage B page/.test(JSON.stringify(next.a)), `took=${took} ${JSON.stringify(loop).slice(0, 160)} next=${JSON.stringify(next).slice(0, 160)}`);
        } catch (e) {
          check('browser-b driver', false, e.stack || String(e));
        } finally {
          bw.destroy();
          site.closeAllConnections?.();
          site.close();
          ipcMain.removeHandler('smoke:allowFile');
          ipcMain.removeHandler('smoke:emulate');
          ipcMain.removeHandler('smoke:recover');
        }
      }

      // ---- stage E: the 文件 panel's empty state, 选机器 → 添加 SSH 机器…, 录屏's picker (no recording), the PR bar with
      // comments against the fake GitHub (scripts/fake-forge.cjs). A window of its own with a desktop-bridge stand-in
      // (captureSources from the real desktopCapturer); nothing is sent to a model, nothing recorded.
      if (E.SMOKE_READONLY !== '1' && E.SMOKE_FAKE_FORGE) {
        phase = 'stage-e';
        const { ipcMain } = require('electron');
        const { execFileSync } = require('node:child_process');
        const { startFakeForge } = require(path.join(ROOT, 'scripts', 'fake-forge.cjs'));
        const forge = await startFakeForge();
        fs.writeFileSync(E.SMOKE_FAKE_FORGE, JSON.stringify({ 'github.fake': forge.origin, 'gitlab.fake': forge.origin }));
        const sreq = (req) => new Promise((res, rej) => {
          const WS = require(path.join(ROOT, 'node_modules', 'ws'));
          const u = new URL(E.SMOKE_URL);
          const s = new WS(`ws://${u.host}/ws?token=${u.searchParams.get('token')}`);
          s.on('error', rej);
          s.on('open', () => s.send(JSON.stringify({ type: 'request', request: { id: '1', req } })));
          s.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'reply' && m.reply.id === '1') { s.close(); m.reply.ok ? res(m.reply.data) : rej(new Error(m.reply.error)); } });
        });
        await sreq({ kind: 'vcs.tokens.set', host: 'github.fake', token: 'gh-test' });
        const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
        const ghRepo = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cw-smoke-gh-'));
        for (const a of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'init'], ['remote', 'add', 'origin', 'https://github.fake/acme/app.git'], ['checkout', '-q', '-b', 'feat/retry']]) execFileSync('git', a, { cwd: ghRepo, windowsHide: true, env: gitEnv, stdio: 'ignore' });
        // a fixed list: the real desktopCapturer took the smoke's Electron down (exit -1, twice in a row on this machine)
        const thumb = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        ipcMain.handle('smoke:captureSources', async () => [{ id: 'screen:0:0', name: 'Screen 1', kind: 'screen', thumb }, { id: 'window:1:0', name: 'Notepad', kind: 'window', thumb }]);
        const epre = path.join(out, 'stage-e-preload.js');
        fs.writeFileSync(epre, `const { ipcRenderer } = require('electron');
window.desktop = {
  version: '0.0.0-smoke', platform: 'win32',
  pickDir: async () => null, pickFile: async () => null, openPath: async () => {}, openExternal: async () => {},
  notify() {}, setBadge() {}, setTitleBarColors() {}, getLoginItem: async () => false, setLoginItem: async () => {},
  onCommand: () => () => {}, onFocusSession: () => () => {},
  captureSources: () => ipcRenderer.invoke('smoke:captureSources'), chooseCapture: async () => false,
};`);
        const ew = new BrowserWindow({ width: 1320, height: 860, show: false, webPreferences: { preload: epre, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
        ew.showInactive();
        const ewc = ew.webContents;
        ewc.on('console-message', (a, b, c) => {
          const level = typeof a === 'object' && a && 'level' in a ? a.level : b;
          const message = typeof a === 'object' && a && 'message' in a ? a.message : c;
          if (level === 'error' || level === 'warning' || Number(level) >= 2) res.console.push({ phase, level: String(level), message: String(message).slice(0, 800) });
        });
        const ejs = (code) => ewc.executeJavaScript(code, true);
        const ewait = async (code, ms = 15_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ejs(code).catch(() => false)) return true; await sleep(150); } return false; };
        const ekey = async (keyCode, modifiers = []) => { ewc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); ewc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(250); };
        const eshot = async (name) => { try { const img = await ewc.capturePage(); const f = path.join(out, `ux-${name}.png`); fs.writeFileSync(f, img.toPNG()); res.shots.push(f); } catch (e) { log(`shot ${name} failed: ${e.message}`); } };
        const eclick = (sel) => ejs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollIntoView({ block: 'nearest' }); el.click(); return true; })()`);
        try {
          await ewc.loadURL(E.SMOKE_URL);
          const up = await ewait(`!!window.__store && window.__store.getState().connected && window.__store.getState().metaLoaded`, 30_000);
          check('stage-e: a window with the desktop-bridge stand-in is up', up);
          await ejs(`window.__store.getState().setSetting('onboarded', true)`);
          await sleep(500);

          // 1. 文件: a conversation where Claude read and changed nothing → 本对话的文件's sentence and its two buttons
          await ejs(`window.__store.getState().loadHistory(${JSON.stringify(E.SMOKE_REVIEW_SID)})`);
          await ewait(`!!document.querySelector('.sess-head .sh-more > button')`, 15_000);
          await eclick('.sess-head .sh-more > button');
          await ewait('!!document.querySelector(".menu.sess-menu [data-view=\\"files\\"]")', 3000);
          await eclick('.menu.sess-menu [data-view="files"]');
          const fileEmpty = await ewait(`[...document.querySelectorAll('.dock .fv-touched .es-text')].some((e) => e.textContent === 'Claude 读过和改过的文件会显示在这里')`, 8000);
          const btns = await ejs(`[...document.querySelectorAll('.dock .fv-touched .es-act button')].map((b) => b.textContent.trim())`);
          await eshot('stage-e-files-empty');
          await ejs(`[...document.querySelectorAll('.dock .fv-touched .es-act button')].find((b) => b.textContent.startsWith('搜索文件'))?.click()`);
          const toSearch = await ewait(`[...document.querySelectorAll('.dock .files-view .seg [role=tab]')].some((t) => t.getAttribute('aria-selected') === 'true' && t.textContent === '搜索')`, 4000);
          check('stage-e 文件: 本对话的文件 says 「Claude 读过和改过的文件会显示在这里」 with 打开文件 / 搜索文件 (kbd); 搜索文件 switches to the search', fileEmpty && btns.length === 2 && btns[0] === '打开文件' && btns[1].startsWith('搜索文件') && toSearch, JSON.stringify({ fileEmpty, btns, toSearch }));

          // 2. 选机器: the welcome page's machine chip; its last row 添加 SSH 机器… opens the dialog; Esc closes it
          await ekey('N', ['alt']);
          const chip = await ewait(`!!document.querySelector('.welcome .composer .machine-chip')`, 8000);
          await eclick('.welcome .composer .machine-chip');
          await ewait(`!!document.querySelector('.menu.machine-menu [data-id="machine-add-ssh"]')`, 4000);
          const last = await ejs(`(() => { const m = document.querySelector('.menu.machine-menu'); const its = m ? [...m.querySelectorAll('[data-mi]')] : []; return its.length ? its[its.length - 1].textContent.trim() : null; })()`);
          await sleep(1500); // the distros' checks come back (read-only: wsl -l -q, a login shell's home / claude / interop)
          await eshot('stage-e-machine-menu');
          await eclick('.menu.machine-menu [data-id="machine-add-ssh"]');
          const dlg = await ewait(`!!document.querySelector('.add-ssh-dlg') && document.querySelector('.add-ssh-dlg').textContent.includes('地址')`, 4000);
          await eshot('stage-e-add-ssh');
          await ekey('Escape');
          const closed = await ewait(`!document.querySelector('.add-ssh-dlg')`, 3000);
          const focusBack = await ejs(`!!document.activeElement?.closest('.machine-chip')`);
          check('stage-e 选机器: the chip is on the welcome page; 添加 SSH 机器… is the last row; it opens the dialog (地址); Esc closes it, the focus back on the chip', chip && last === '添加 SSH 机器…' && dlg && closed && focusBack, JSON.stringify({ chip, last, dlg, closed, focusBack }));

          // 3. 录屏: the + menu has it; the picker lists at least one whole screen; Esc closes it, nothing recorded
          await eclick('.welcome .cb .plus');
          const recRow = await ewait(`!!document.querySelector('[data-id="record"]')`, 3000);
          await eclick('[data-id="record"]');
          const thumbs = await ewait(`(() => { const p = document.querySelector('.rec-picker'); if (!p) return false; const h = [...p.querySelectorAll('.rec-h')].find((x) => x.textContent === '整个屏幕'); return !!h && !!h.nextElementSibling?.querySelector('.rec-src img'); })()`, 10_000);
          await eshot('stage-e-rec-picker');
          await ejs(`document.querySelector('.rec-picker')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
          const pickerGone = await ewait(`!document.querySelector('.rec-picker')`, 3000);
          const notRec = await ejs(`!document.querySelector('.rec-dot') && !document.querySelector('.rec-countdown')`);
          check('stage-e 录屏: the + menu has 录屏; the picker shows 整个屏幕 with a thumbnail; Esc closes it, nothing records', recRow && thumbs && pickerGone && notRec, JSON.stringify({ recRow, thumbs, pickerGone, notRec }));

          // 4. the PR bar against the fake GitHub: PR #12, 3 条评论 (自动处理评论 off), alice / dependabot (机器人), the CI menu has 自动处理评论
          const ghSid = await ejs(`window.__store.getState().openSession({ cwd: ${JSON.stringify(ghRepo)}, agent: 'acp:smoke', permissionMode: 'default' })`);
          const bar = await ewait(`(() => { const b = document.querySelector('.pane.focused .pr-bar'); return !!b && b.querySelector('.pr-n')?.textContent === 'PR #12' && b.querySelector('.pr-comments')?.textContent === '3 条评论'; })()`, 20_000);
          await eclick('.pane.focused .pr-bar .pr-comments');
          const listed = await ewait(`(() => { const l = document.querySelector('.menu.pr-comment-list'); if (!l) return false; const t = l.textContent; return t.includes('alice') && t.includes('dependabot') && !!l.querySelector('.pr-cm-bot'); })()`, 4000);
          await eshot('stage-e-pr-comments');
          await ekey('Escape');
          await eclick('.pane.focused .pr-bar .pr-ci:not(.pr-comments)');
          const autoRow = await ewait(`!!document.querySelector('.menu.pr-menu .pr-auto-comments')`, 3000);
          await eshot('stage-e-pr-ci');
          await ekey('Escape');
          check('stage-e PR bar: PR #12, 3 条评论 while 自动处理评论 is off; the list has alice and dependabot (机器人); the CI menu has 自动处理评论', !!ghSid && bar && listed && autoRow, JSON.stringify({ ghSid, bar, listed, autoRow }));
          const writes = forge.calls.filter((c) => (c.method !== 'GET' && c.path !== '/api/graphql') || (c.path === '/api/graphql' && /mutation/.test(String(c.body?.query ?? '')))).length;
          check('stage-e PR bar: nothing was written to the forge (no reply, no auto-merge, no resolve)', writes === 0, String(writes));
          if (ghSid) await ejs(`window.__store.getState().closeSession(${JSON.stringify(ghSid)})`).catch(() => {});
        } catch (e) {
          check('stage-e', false, e.stack || String(e));
        } finally {
          ipcMain.removeHandler('smoke:captureSources');
          try { ew.destroy(); } catch { /* gone */ }
          await forge.close();
          try { fs.rmSync(ghRepo, { recursive: true, force: true }); } catch { /* windows may hold it */ }
        }
      }

      // ---- 值班 Bot (spec 2026-10-30-duty-bots-design): the page with two bots put in through the debug hook (no run;
      // phase 42 drives the real thing) — the rows, the load bar, the create dialog's templates (Esc closes the dialog
      // first, then the page), and the two approvals with 批准 in 总览's 需要你 lane
      if (E.SMOKE_READONLY !== '1') {
        phase = 'bots';
        try {
          const now = Date.now();
          const botOf = (id, name, state, pendingInbox) => ({ id, name, charter: { role: `${name} 的活`, sources: [] }, cwd: E.SMOKE_REPO || '.', tier: 'balanced', policy: { rules: [] }, budget: { dailyUsd: 2 }, routines: [{ id: 'r_smoke' + id, name: '巡检', prompt: 'p', everyMinutes: 60, enabled: true, onFail: 'inbox', acceptance: { kind: 'none' } }], outputs: [{ kind: 'inbox' }], createdAt: now - 3600_000, updatedAt: now, state, todayUsd: 0.12, weekUsd: 0.5, pendingInbox, trust: {} });
          const appr = (id, cmd) => ({ id, kind: 'approval', botId: 'b_smoke1', runId: 'r_smoke1-x', routineId: 'r_smokeb_smoke1', sessionId: 'smoke-bot-session', at: now - 60_000, title: `Bash: ${cmd}`, toolName: 'Bash', input: { command: cmd }, cls: 'send' });
          const payload = { bots: [botOf('b_smoke1', '烟测 A', 'attention', 2), botOf('b_smoke2', '烟测 B', 'running', 0)], inbox: [appr('i_smoke1', 'git push origin main'), appr('i_smoke2', 'curl -X POST https://example.com/hook')], load: { running: 1, queued: 0, todayUsd: 0.12, weekEstimateUsd: 0.5, concurrency: 2 } };
          // the server pushes its own load every tick: put ours in again right before each look
          const inject = `window.__cwBots.inject(${JSON.stringify(payload)})`;
          await js(`(() => { window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } }); ${inject}; window.__cwBots.open('b_smoke1'); })()`);
          const page = await waitFor(`(${inject}, document.querySelectorAll('.bot-list .bot-row').length === 2 && /在跑 1/.test(document.querySelector('.bots-load .bl-text')?.textContent ?? ''))`, 8000);
          const seen = await js(`({ rows: [...document.querySelectorAll('.bot-list .bot-row')].map((r) => r.dataset.id + ':' + r.querySelector('.bot-state')?.dataset.state), load: document.querySelector('.bots-load .bl-text')?.textContent ?? null })`);
          check('bots: two rows (attention, running), the load bar says 在跑 1', page && seen.rows.includes('b_smoke1:attention') && seen.rows.includes('b_smoke2:running'), JSON.stringify(seen));
          await shot('bots-page');
          const newBtn = await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '新建 Bot' && x.offsetParent); if (!b) return false; b.click(); return true; })()`);
          const tpls = await waitFor(`document.querySelectorAll('.bc-tpls .bc-tpl').length === 14`, 8000);
          check('bots: 新建 Bot opens the dialog with 14 template cards', newBtn && tpls, String(await js(`document.querySelectorAll('.bc-tpls .bc-tpl').length`)));
          await shot('bots-create');
          await key('Escape');
          const closed = await waitFor(`!document.querySelector('.bc-tpls') && window.__cwBots.state().open === true`, 3000);
          check('bots: Esc closes the dialog, the page stays', closed, JSON.stringify(await js(`({ dialog: !!document.querySelector('.bc-tpls'), open: window.__cwBots.state().open })`)));
          await key('Escape');
          check('bots: a second Esc closes the page', await waitFor(`window.__cwBots.state().open === false`, 3000));
          await js(`(() => { ${inject}; window.__store.getState().dispatchLayout({ t: 'dock.show', panel: 'mission' }); })()`);
          const MP = '.dock-panel[data-panel="mission"]:not([hidden])';
          const inboxUp = await waitFor(`document.querySelectorAll('${MP} .bots-inbox .ib-item[data-kind="approval"]').length === 2`, 8000);
          const ib = await js(`[...document.querySelectorAll('${MP} .bots-inbox .ib-item[data-kind="approval"]')].map((i) => ({ id: i.dataset.id, approve: [...i.querySelectorAll('button')].some((b) => b.textContent.trim() === '批准') }))`);
          check('bots: the inbox (总览 · 需要你) has the 2 approvals, each with 批准', inboxUp && ib.length === 2 && ib.every((i) => i.approve), JSON.stringify(ib));
          await shot('bots-inbox');
          const bErr = await noBoundary(MP);
          check('bots: inbox without error boundary', !bErr, bErr);
        } catch (e) {
          check('bots', false, e.stack || String(e));
        } finally {
          await js(`window.__store.getState().dispatchLayout({ t: 'dock.set', patch: { open: false } })`).catch(() => {});
          await js(`window.__cwBots.inject({ bots: [], inbox: [], load: { running: 0, queued: 0, todayUsd: 0, weekEstimateUsd: 0, concurrency: 2 } })`).catch(() => {});
          await sleep(200);
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
        // the section's rows have boundaries of their own whose area starts the same (「… · 思考用的语言」): they took
        // the crash too — each one's 重试
        await js('document.querySelectorAll(\'.modal.settings .err-boundary[data-area^="设置 · 模型与智能程度"] .eb-actions .btn:first-child\').forEach((b) => b.click())');
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
