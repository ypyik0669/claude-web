// Cold-starts a PACKAGED desktop build and checks it really works on this OS:
// server boots inside the app, the page is served, both engines resolve from app.asar.unpacked and run,
// the terminal (node-pty + spawn-helper + the SDK's native claude binary) produces output, the WebRTC addon
// (node-datachannel) loads from app.asar.unpacked, and the app finds a new
// version by itself (a local update feed advertising 99.0.0): the Windows installer build downloads it, macOS only
// reports it (unsigned: the prompt offers the download instead).
//   node scripts/smoke-packaged.mjs "<path to app executable>" [screenshot.png]
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const [exe, shot] = process.argv.slice(2);
if (!exe || !existsSync(exe)) { console.error(`app executable not found: ${exe}`); process.exit(2); }
const ud = mkdtempSync(path.join(os.tmpdir(), 'cw-smoke-'));
const token = randomBytes(12).toString('hex');

// a generic update feed (desktop/src/main.ts CW_UPDATE_FEED): 99.0.0 with a 1 MB stand-in file
const upPayload = Buffer.alloc(1 << 20, 7);
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

  const v = await req({ kind: 'engine.cli', args: ['--version'] }).catch((e) => ({ code: -1, stderr: e.message }));
  check('engine runs (Electron as node)', v.code === 0 && /\d+\.\d+\.\d+/.test(v.stdout), (v.stdout || v.stderr).trim().slice(0, 200));

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

// the WebRTC addon (phone reaches the PC from anywhere): its prebuilt .node must be unpacked and load under Electron.
// Required through app.asar the way the server's import resolves it (its JS dependency detect-libc stays inside the
// asar; Electron redirects the unpacked files), then the loaded binary must be the one in app.asar.unpacked.
{
  const dir = path.dirname(path.resolve(exe)); // absolute: a bare relative path would be looked up as a package name
  const resources = process.platform === 'darwin' ? path.join(dir, '..', 'Resources') : path.join(dir, 'resources');
  const mod = path.join(resources, 'app.asar', 'node_modules', 'node-datachannel');
  const script = path.join(ud, 'rtc-smoke.cjs');
  writeFileSync(script, [
    'const ndc = require(process.argv[2]);',
    "const pc = new ndc.PeerConnection('smoke', { iceServers: [] });",
    'pc.close();',
    'ndc.cleanup();',
    "const bin = Object.keys(require.cache).find((k) => k.endsWith('node_datachannel.node')) || 'no .node loaded';",
    "console.log('rtc ok ' + ndc.getLibraryVersion() + ' ' + bin);",
    '',
  ].join('\n'));
  const r = spawnSync(exe, [script, mod], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  // require.cache names the binary by its virtual app.asar path; the real file must sit in app.asar.unpacked
  const bin = /rtc ok \S+ (.+node_datachannel\.node)/.exec(out)?.[1] ?? '';
  const ok = r.status === 0 && !!bin && existsSync(bin.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`));
  check('WebRTC addon loads from app.asar.unpacked (Electron as node)', ok, r.error ? r.error.message : `exit ${r.status}: ${out.slice(0, 300)}`);
}

// the app's own update check (desktop/src/main.ts): main.log records each step
{
  const mainLog = () => { try { return readFileSync(path.join(ud, 'main.log'), 'utf8'); } catch { return ''; } };
  const want = process.platform === 'win32' ? '[update] downloaded 99.0.0' : '[update] available 99.0.0';
  for (let i = 0; i < 120 && !mainLog().includes(want); i++) await sleep(500);
  const steps = mainLog().split('\n').filter((l) => l.includes('[update]')).map((l) => l.slice(l.indexOf('[update]'))).join(' | ');
  check(process.platform === 'win32' ? 'finds and downloads a new version by itself (installer build)' : 'finds a new version by itself (unsigned build: offers the download)', mainLog().includes(want), `${steps || 'no [update] lines'} · feed: ${feedHits.join(', ')}`);
  if (process.platform !== 'win32') check('… and downloads nothing itself', !feedHits.some((u) => u.startsWith(`/${upFile}`)));
}
feed.close();
if (shot && process.platform === 'darwin') { try { await sleep(1500); execFileSync('screencapture', ['-x', shot]); console.log(`screenshot: ${shot}`); } catch (e) { console.log(`screenshot failed: ${e.message}`); } }

try { if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(app.pid), '/t', '/f'], { stdio: 'ignore' }); else process.kill(-app.pid, 'SIGTERM'); } catch { /* already gone */ }
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} smoke checks passed`);
if (bad) console.log(`--- server.log tail ---\n${log().slice(-2000)}`);
process.exit(bad ? 1 : 0);
