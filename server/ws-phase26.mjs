// Phase 26 end-to-end: 网吧's characters (spec docs/superpowers/specs/2026-10-13-cafe-design.md §4). A real server
// and the real `web` MCP entry (server/dist/web/mcp.js) driven with raw JSON-RPC over stdio, the way an agent drives
// it. No model, no token. Checks:
//   · the MCP server lists the five character tools next to 联网's;
//   · character_guide is the skill; a bad draft is refused with what is wrong; a good one is kept as a draft and
//     answered with a picture; every window hears characters.changed and sees the draft in characters.list;
//   · a draft cannot be given to anyone; character_save makes it a character; character_assign gives it; deleting it
//     takes it back from everyone;
//   · a paired device can read the library, not change it;
//   · a Claude conversation is handed the cafe plugin: its engine lists the cafe-character skill (no message sent).
//   node server/ws-phase26.mjs   (starts its own server)
import WebSocket from 'ws';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase26-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');
const dataDir = path.join(home, '.claude-web');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const until = async (fn, ms, step = 50) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, step)); } };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: dataDir, CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_)/.test(k) || /^(no|http|https|all)_proxy$/i.test(k) || k === 'CW_WEB_TOKEN' || k === 'CW_WEB_TOKEN_FILE' || k === 'CLAUDE_WEB_DIST') delete env[k];
// the conversation's engine must not reach anything: a dead endpoint (it only starts, nothing is sent)
env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
env.ANTHROPIC_API_KEY = 'sk-phase26-not-a-key';
const server = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let slog = '';
server.stderr.on('data', (d) => { slog += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${slog}`)), 60_000);
  server.stdout.on('data', (d) => { slog += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(slog); if (m) { clearTimeout(t); res(m[1]); } });
  server.on('exit', (c) => rej(new Error(`server exited (${c})\n${slog}`)));
});

function client(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
    if (m.type === 'event') events.push(m.event);
  });
  return {
    ws, events,
    open: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    req: (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); }),
  };
}

function startMcp(entry, mcpEnv) {
  const p = spawn(process.execPath, [entry], { cwd: proj, env: { ...env, ...mcpEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const replies = new Map();
  let buf = '', stderr = '', seq = 0;
  p.stderr.on('data', (d) => { stderr += String(d); });
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) try { const m = JSON.parse(line); replies.set(m.id, m); } catch { /* not ours */ }
    }
  });
  const wait = async (id, ms = 30_000) => (await until(() => replies.get(id), ms)) ?? { error: { message: `no answer in ${ms} ms. stderr: ${stderr.slice(-300)}` } };
  const send = (method, params = {}) => { const id = ++seq; p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); return id; };
  return {
    rpc: (method, params) => wait(send(method, params)),
    call: async (name, args = {}) => { const r = await wait(send('tools/call', { name, arguments: args })); return r.result ?? { isError: true, content: [{ type: 'text', text: `rpc error: ${r.error?.message}` }] }; },
    stop: () => new Promise((r) => { p.once('exit', r); p.stdin.end(); setTimeout(() => p.kill(), 5000).unref?.(); }),
  };
}
const textOf = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

/** A small cat: 24 × 24, outlined, two eyes, legs from row 18. */
function cat(id = 'cat-mimi') {
  const rows = [];
  for (let y = 0; y < 24; y++) {
    let r = '';
    for (let x = 0; x < 24; x++) {
      const head = ((x - 12) / 8) ** 2 + ((y - 9) / 6.5) ** 2 <= 1;
      const ear = (y >= 1 && y <= 4) && ((x >= 5 && x <= 7 && x - 5 <= y - 1) || (x >= 16 && x <= 18 && 18 - x <= y - 1));
      const body = y >= 14 && y <= 21 && x >= 7 && x <= 16;
      const legs = y >= 18 && y <= 22 && (x === 8 || x === 9 || x === 14 || x === 15);
      r += (y === 9 || y === 10) && (x === 9 || x === 15) ? 'p' : head || ear || body || legs ? 'o' : '.';
    }
    rows.push(r);
  }
  return { v: 1, id, name: '咪咪', palette: { o: '#e8a33c', p: '#1b1b1b' }, front: rows, back: rows.map((r) => r.replace(/p/g, 'o')), rig: { legs: 18, eyes: [[9, 9], [15, 9], [9, 10], [15, 10]], hands: [[7, 15], [16, 15]] } };
}

const a = client(`ws://127.0.0.1:${port}/ws?token=${token}`);
const b = client(`ws://127.0.0.1:${port}/ws?token=${token}`);
let mcp = null;

async function main() {
  await Promise.all([a.open, b.open]);
  const tokenFile = path.join(dataDir, 'runtime', 'web-mcp', `${server.pid}.token`);
  await until(() => fs.existsSync(tokenFile), 5000);
  const entry = path.join(here, 'dist', 'web', 'mcp.js');
  if (!fs.existsSync(entry)) { check('server/dist/web/mcp.js exists (npm run build -w server)', false, entry); return; }
  mcp = startMcp(entry, { CW_WEB_URL: `http://127.0.0.1:${port}`, CW_WEB_TOKEN_FILE: tokenFile, CW_SESSION_ID: 'phase26-conv' });
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase26', version: '0' } });
  const tools = ((await mcp.rpc('tools/list')).result?.tools ?? []).map((t) => t.name);
  check('the web MCP server lists the five character tools', ['character_guide', 'character_draft', 'character_save', 'character_assign', 'character_list'].every((n) => tools.includes(n)), tools.join(','));

  const guide = await mcp.call('character_guide');
  check('character_guide is the skill', !guide.isError && textOf(guide).includes('# Making a 网吧 character') && !textOf(guide).startsWith('---'), textOf(guide).slice(0, 60));

  const lib0 = await a.req({ kind: 'characters.list' });
  check('characters.list starts with the built-ins', lib0.characters.map((c) => c.id).join(',') === 'octopus,admin' && JSON.stringify(lib0.assign) === '{}', JSON.stringify(lib0.characters.map((c) => c.id)));

  const bad = cat();
  bad.front[3] = bad.front[3].slice(2);
  const r1 = await mcp.call('character_draft', { character: bad });
  check('a bad draft is refused with what is wrong', r1.isError === true && textOf(r1).includes('front 第 4 行有 22 个字符'), textOf(r1).slice(0, 120));
  check('… and nothing was written', !fs.existsSync(path.join(dataDir, 'characters', 'cat-mimi.json')));

  const before = b.events.length;
  const r2 = await mcp.call('character_draft', { character: cat() });
  const img = r2.content?.find((c) => c.type === 'image');
  check('a good draft is answered with a picture', !r2.isError && img?.mimeType === 'image/png' && img.data.startsWith('iVBOR'), textOf(r2).slice(0, 80));
  check('every window hears characters.changed', !!(await until(() => b.events.slice(before).some((e) => e.kind === 'characters.changed'), 3000)));
  const lib1 = await b.req({ kind: 'characters.list' });
  check('… and sees the draft', lib1.characters.some((c) => c.id === 'cat-mimi' && c.draft === true && c.name === '咪咪'));

  const early = await mcp.call('character_assign', { id: 'cat-mimi', target: 'type:Explore' });
  check('a draft cannot be given to anyone', early.isError === true && textOf(early).includes('草稿'), textOf(early));
  const saved = await mcp.call('character_save', { id: 'cat-mimi' });
  check('character_save makes it a character', !saved.isError && !(await a.req({ kind: 'characters.list' })).characters.find((c) => c.id === 'cat-mimi').draft, textOf(saved));
  const given = await mcp.call('character_assign', { id: 'cat-mimi', target: 'type:Explore' });
  const lib2 = await a.req({ kind: 'characters.list' });
  check('character_assign gives it to a sub-agent type', !given.isError && lib2.assign.byType?.Explore === 'cat-mimi', JSON.stringify(lib2.assign));
  const listed = await mcp.call('character_list');
  check('character_list says who has it', textOf(listed).includes('cat-mimi · 咪咪 · 已保存 · 给了 type:Explore'), textOf(listed));
  await a.req({ kind: 'characters.assign', id: 'cat-mimi', target: 'admin' });
  check('a window can give it too (the 网管 now)', (await a.req({ kind: 'characters.list' })).assign.admin === 'cat-mimi');

  // a paired device: may look, not change
  const rst = await a.req({ kind: 'remote.set', enabled: true, port: await freePort(), anywhere: false });
  const pair = await a.req({ kind: 'remote.pairCode' });
  const dev = await (await fetch(`http://127.0.0.1:${rst.port}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.code, name: 'phase26 phone' }) })).json();
  const phone = client(`ws://127.0.0.1:${rst.port}/ws?token=${dev.token}`);
  await phone.open;
  const seen = await phone.req({ kind: 'characters.list' }).then((r) => r.characters.length, () => -1);
  const refused = await phone.req({ kind: 'characters.delete', id: 'cat-mimi' }).then(() => null, (e) => e.message);
  check('a paired device can read the library, not change it', seen === 3 && /本机/.test(refused ?? ''), `${seen} | ${refused}`);
  phone.ws.terminate();
  await a.req({ kind: 'remote.set', enabled: false });

  const del = await a.req({ kind: 'characters.delete', id: 'cat-mimi' });
  const lib3 = await a.req({ kind: 'characters.list' });
  check('deleting it takes it back from everyone', del.ok === true && !lib3.characters.some((c) => c.id === 'cat-mimi') && !lib3.assign.admin && !lib3.assign.byType?.Explore, JSON.stringify(lib3.assign));

  // a Claude conversation is handed the cafe plugin: its engine lists the skill (nothing is sent)
  const o = await a.req({ kind: 'session.open', params: { cwd: proj, permissionMode: 'default' } });
  const sid = o.sessionId;
  const info = await until(async () => { const e = a.events.find((x) => x.kind === 'session.info' && x.info?.sessionId === sid && (x.info.skills?.length || x.info.slashCommands?.length)); return e?.info; }, 60_000, 200);
  const names = [...(info?.skills ?? []), ...(info?.slashCommands ?? []).map((c) => c.name)];
  check('a Claude conversation\'s engine lists the cafe-character skill (the plugin was handed over)', names.some((n) => n === 'cafe:cafe-character' || n === 'cafe-character'), names.filter((n) => /cafe/.test(n)).join(',') || `${names.length} names`);
  check('… from the plugin written under the data folder', fs.existsSync(path.join(dataDir, 'runtime', 'plugins', 'cafe', 'skills', 'cafe-character', 'SKILL.md')));
  await a.req({ kind: 'session.close', sessionId: sid }).catch(() => {});
}

main().catch((e) => { check('phase26 ran to the end', false, e.stack || e.message); }).finally(async () => {
  try { await mcp?.stop(); } catch { /* */ }
  for (const c of [a, b]) { try { c.ws.terminate(); } catch { /* */ } }
  server.kill();
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
  const bad = results.filter(([, ok]) => !ok);
  if (bad.length) console.log(`\n--- server log (tail) ---\n${slog.split('\n').slice(-60).join('\n')}`);
  console.log(`\nphase26: ${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
});
