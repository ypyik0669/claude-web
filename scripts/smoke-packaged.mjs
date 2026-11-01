// Cold-starts a PACKAGED desktop build and checks it really works on this OS:
// server boots inside the app, the page is served, both engines resolve from app.asar.unpacked and run,
// the terminal (node-pty + spawn-helper + the SDK's native claude binary) produces output, and the app finds a new
// version by itself (a local update feed advertising 99.0.0): the Windows installer build downloads it, macOS downloads,
// checks and unpacks it (desktop/src/mac-update.ts; the swap itself is update-policy.test.ts), Linux only reports it.
//   node scripts/smoke-packaged.mjs "<path to app executable>" [screenshot.png]
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const [built, shot] = process.argv.slice(2);
if (!built || !existsSync(built)) { console.error(`app executable not found: ${built}`); process.exit(2); }
const ud = mkdtempSync(path.join(os.tmpdir(), 'cw-smoke-'));
// Run a copy outside the repo: started from dist-desktop/ its module lookup walks up into the repo's node_modules and
// finds packages the installer does not ship (v0.2.7: `yaml`, every install died at start while this passed).
const appRoot = process.platform === 'darwin' ? built.slice(0, built.indexOf('.app/') + 4) : path.dirname(built);
const copyRoot = path.join(mkdtempSync(path.join(os.tmpdir(), 'cw-smoke-app-')), path.basename(appRoot));
cpSync(appRoot, copyRoot, { recursive: true, verbatimSymlinks: true });
const exe = path.join(copyRoot, path.relative(appRoot, built));
const token = randomBytes(12).toString('hex');

// a generic update feed (desktop/src/main.ts CW_UPDATE_FEED): 99.0.0 with a 1 MB stand-in file — on macOS a zip of a
// stand-in app the downloader accepts (bundle id and version in Info.plist, an executable)
function standInMacZip() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cw-smoke-upd-'));
  const app = path.join(dir, 'Claude Web.app');
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleIdentifier</key><string>com.claude-web.desktop</string>',
    '<key>CFBundleShortVersionString</key><string>99.0.0</string>',
    '<key>CFBundleExecutable</key><string>Claude Web</string>',
    '</dict></plist>',
    '',
  ].join('\n'));
  const bin = path.join(app, 'Contents', 'MacOS', 'Claude Web');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  const zip = path.join(dir, 'up.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  return readFileSync(zip);
}
const upPayload = process.platform === 'darwin' ? standInMacZip() : Buffer.alloc(1 << 20, 7);
const upSha = createHash('sha512').update(upPayload).digest('base64');
const upFile = process.platform === 'darwin' ? `ClaudeWeb-99.0.0-mac-${process.arch}.zip` : 'ClaudeWeb-99.0.0-win-x64.exe';
const upYml = [
  'version: 99.0.0',
  'files:',
  `  - url: ${upFile}`,
  `    sha512: ${upSha}`,
  `    size: ${upPayload.length}`,
  `path: ${upFile}`,
  `sha512: ${upSha}`,
  "releaseDate: '2026-01-01T00:00:00.000Z'",
  'releaseNotes: smoke',
  '',
].join('\n');
const feedHits = [];
const feed = http.createServer((q, s) => {
  feedHits.push(q.url);
  if (q.url.startsWith('/latest.yml') || q.url.startsWith('/latest-mac.yml')) { s.writeHead(200, { 'content-type': 'text/yaml' }).end(upYml); return; }
  if (q.url.startsWith(`/${upFile}`) && !q.url.includes('.blockmap')) { s.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': upPayload.length }).end(upPayload); return; }
  s.writeHead(404).end();
});
await new Promise((r) => feed.listen(0, '127.0.0.1', r));
const env = { ...process.env, CLAUDE_WEB_TOKEN: token, CW_UPDATE_FEED: `http://127.0.0.1:${feed.address().port}/`, CW_UPDATE_FIRST_MS: '2000' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|ELECTRON_RUN_AS_NODE)/.test(k)) delete env[k];
const app = spawn(exe, [`--user-data-dir=${ud}`], { env, stdio: 'ignore', detached: process.platform !== 'win32' });

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => { try { return readFileSync(path.join(ud, 'server.log'), 'utf8'); } catch { return ''; } };

let port = null;
for (let i = 0; i < 120 && !port; i++) { await sleep(500); port = /listening on http:\/\/[^:]+:(\d+)/.exec(log())?.[1] ?? null; }
check('app starts its embedded server', !!port, port ? `:${port}` : log().slice(-800) || 'no server.log');

async function run() {
  if (!port) return;
  const page = await fetch(`http://127.0.0.1:${port}/?token=${token}`).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ status: 0, text: String(e) }));
  check('page is served', page.status === 200 && page.text.includes('<div id="root"'), `HTTP ${page.status}`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let seq = 0; const pending = new Map(); const events = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); }
    else if (m.type === 'event') events.push(m.event);
  });
  const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });

  const eng = await req({ kind: 'engine.info' }).catch((e) => ({ error: e.message }));
  check('engine resolves inside the app', !!eng.path && eng.path.includes('app.asar.unpacked'), `${eng.runtime} ${eng.version ?? ''} ${eng.path ?? eng.error}`);
  check('fallback engine resolves inside the app', !!eng.fallback?.path?.includes('app.asar.unpacked'), `${eng.fallback?.runtime} ${eng.fallback?.version ?? ''}`);

  // 托管程序: CLIProxyAPI / Magpie travel in <resources>/engines — a fresh install starts them without a download
  const engs = await req({ kind: 'engines.status' }).catch((e) => ({ error: e.message, engines: [] }));
  const byId = Object.fromEntries((engs.engines ?? []).map((e) => [e.id, e]));
  check('CLIProxyAPI and Magpie ship with the app', ['cliproxyapi', 'magpie'].every((id) => byId[id]?.installed && byId[id]?.bundled), engs.error ?? ['cliproxyapi', 'magpie'].map((id) => `${id}: ${byId[id]?.version ?? 'missing'}${byId[id]?.bundled ? ' (bundled)' : ''}`).join(', '));
  for (const id of ['magpie', 'cliproxyapi']) {
    const started = await req({ kind: 'engines.start', id }).catch((e) => ({ error: e.message }));
    check(`bundled ${id} starts`, started.running === true && started.health === 'ok', started.error ?? `${started.version ?? ''} · port ${started.port ?? '?'}`);
    await req({ kind: 'engines.stop', id }).catch(() => {});
  }

  const v = await req({ kind: 'engine.cli', args: ['--version'] }).catch((e) => ({ code: -1, stderr: e.message }));
  check('engine runs (Electron as node)', v.code === 0 && /\d+\.\d+\.\d+/.test(v.stdout), (v.stdout || v.stderr).trim().slice(0, 200));

  // 联网: agents are handed the `web` MCP server (web search + the built-in browser) unless it is switched off
  const web = await req({ kind: 'web.status' }).catch((e) => ({ error: e.message }));
  check('web search and the browser are on for agents', web.enabled === true && Array.isArray(web.engines) && web.engines.length >= 3, web.error ?? `engine ${web.engine}, ${web.engines?.length} engines`);

  // the terminal tile runs the official native binary through node-pty
  let term = null;
  try { term = await req({ kind: 'terminal.open', cwd: os.homedir(), cols: 100, rows: 30 }); } catch (e) { check('terminal opens (node-pty)', false, e.message); }
  if (term) {
    for (let i = 0; i < 40 && !events.some((e) => e.kind === 'terminal.data' && e.termId === term.termId); i++) await sleep(250);
    const out = events.filter((e) => e.kind === 'terminal.data' && e.termId === term.termId).map((e) => e.data).join('');
    const exit = events.find((e) => e.kind === 'terminal.exit' && e.termId === term.termId);
    check('terminal runs the native claude binary', out.length > 0 && !/posix_spawnp|ENOENT|EACCES/.test(out), exit ? `exited ${exit.code}: ${out.slice(0, 200)}` : `${out.length} bytes`);
    await req({ kind: 'terminal.close', termId: term.termId }).catch(() => {});
  }
  ws.close();
}

try { await run(); } catch (e) { check('smoke run', false, e.stack ?? String(e)); }

// the `web` MCP server: its entry is inside app.asar and is started with the app's own binary as node (web/launcher.ts)
{
  const dir = path.dirname(path.resolve(exe));
  const resources = process.platform === 'darwin' ? path.join(dir, '..', 'Resources') : path.join(dir, 'resources');
  const entry = path.join(resources, 'app.asar', 'server', 'dist', 'web', 'mcp.js');
  const say = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  const input = [say(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } }), say(2, 'tools/list')].join('\n') + '\n';
  const r = spawnSync(exe, [entry], { env: { ...env, ELECTRON_RUN_AS_NODE: '1', CW_WEB_URL: `http://127.0.0.1:${port ?? 9}`, CW_SESSION_ID: 'smoke' }, input, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const answers = String(r.stdout ?? '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = answers.find((a) => a.id === 1)?.result;
  const tools = answers.find((a) => a.id === 2)?.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  check('the web MCP server starts from inside the app (Electron as node)', init?.serverInfo?.name === 'claude-web-web' && names.includes('web_search') && names.includes('browser_open') && names.includes('browser_screenshot'), r.error ? r.error.message : `exit ${r.status}: ${init?.serverInfo?.name ?? 'no handshake'}, ${names.length} tools ${String(r.stderr ?? '').trim().slice(0, 200)}`);
}

// 操控电脑's `computer` MCP server (Windows): the same way — its entry inside app.asar, the app's binary as node
// (computer/launcher.ts). Only the handshake and the tool list: nothing is looked at or sent.
if (process.platform === 'win32') {
  const dir = path.dirname(path.resolve(exe));
  const entry = path.join(dir, 'resources', 'app.asar', 'server', 'dist', 'computer', 'mcp.js');
  const say = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  const input = [say(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } }), say(2, 'tools/list')].join('\n') + '\n';
  const r = spawnSync(exe, [entry], { env: { ...env, ELECTRON_RUN_AS_NODE: '1', CW_COMPUTER_ASK_URL: `http://127.0.0.1:${port ?? 9}`, CW_SESSION_ID: 'smoke', CW_COMPUTER_SELF_EXE: path.resolve(exe) }, input, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const answers = String(r.stdout ?? '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = answers.find((a) => a.id === 1)?.result;
  const names = (answers.find((a) => a.id === 2)?.result?.tools ?? []).map((t) => t.name);
  check('the computer MCP server starts from inside the app (Electron as node)', init?.serverInfo?.name === 'claude-web-computer' && names.length === 29 && names.includes('request_access') && names.includes('screenshot'), r.error ? r.error.message : `exit ${r.status}: ${init?.serverInfo?.name ?? 'no handshake'}, ${names.length} tools ${String(r.stderr ?? '').trim().slice(0, 200)}`);
}

// the app's own update check (desktop/src/main.ts): main.log records each step
{
  const mainLog = () => { try { return readFileSync(path.join(ud, 'main.log'), 'utf8'); } catch { return ''; } };
  const selfUpdating = process.platform === 'win32' || process.platform === 'darwin';
  const want = selfUpdating ? '[update] downloaded 99.0.0' : '[update] available 99.0.0';
  for (let i = 0; i < 120 && !mainLog().includes(want); i++) await sleep(500);
  const steps = mainLog().split('\n').filter((l) => l.includes('[update]')).map((l) => l.slice(l.indexOf('[update]'))).join(' | ');
  check(
    process.platform === 'win32' ? 'finds and downloads a new version by itself (installer build)'
      : process.platform === 'darwin' ? 'finds, downloads, checks and unpacks a new version by itself (macOS, the app in a writable folder)'
      : 'finds a new version by itself (offers the download)',
    mainLog().includes(want), `${steps || 'no [update] lines'} · feed: ${feedHits.join(', ')}`);
  if (process.platform === 'darwin') check('… the new app waits unpacked for the restart', existsSync(path.join(ud, 'update', 'new', 'Claude Web.app', 'Contents', 'Info.plist')));
  if (!selfUpdating) check('… and downloads nothing itself', !feedHits.some((u) => u.startsWith(`/${upFile}`)));
}
if (shot && process.platform === 'darwin') { try { await sleep(1500); execFileSync('screencapture', ['-x', shot]); console.log(`screenshot: ${shot}`); } catch (e) { console.log(`screenshot failed: ${e.message}`); } }

const stop = (p) => { try { if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore' }); else process.kill(-p.pid, 'SIGTERM'); } catch { /* already gone */ } };
stop(app);

// a server that will not start (its data directory is a file) must not strand the installer build: it looks for a
// newer version and downloads it instead of only quitting (v0.2.7 died at start and could not update out of it)
if (process.platform === 'win32') {
  const ud2 = mkdtempSync(path.join(os.tmpdir(), 'cw-smoke-broken-'));
  const notADir = path.join(ud2, 'not-a-directory');
  writeFileSync(notADir, '');
  const broken = spawn(exe, [`--user-data-dir=${ud2}`], { env: { ...env, CLAUDE_WEB_DIR: notADir }, stdio: 'ignore' });
  const mainLog2 = () => { try { return readFileSync(path.join(ud2, 'main.log'), 'utf8'); } catch { return ''; } };
  for (let i = 0; i < 120 && !mainLog2().includes('[update] downloaded 99.0.0'); i++) await sleep(500);
  const lines = mainLog2().split('\n').filter((l) => l.includes('启动失败') || l.includes('Failed to start') || l.includes('[update]')).map((l) => l.slice(l.indexOf(']') + 2, l.indexOf(']') + 80)).join(' | ');
  check('a server that will not start: the app downloads the new version instead of only quitting', /启动失败|Failed to start/.test(mainLog2()) && mainLog2().includes('[update] downloaded 99.0.0'), lines || 'no main.log');
  stop(broken);
}
feed.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} smoke checks passed`);
if (bad) console.log(`--- server.log tail ---\n${log().slice(-2000)}`);
process.exit(bad ? 1 : 0);
