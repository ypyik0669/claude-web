// Phase 21 end-to-end: 手机在外面也能连 (server/src/remote/anywhere/). A real server (throwaway HOME, remote access on a
// random port) with 在外面也能用 pointed at two local test brokers; the phone is played here by the built core
// (server/dist/remote/anywhere/core) over node-datachannel, the way the shell runs it in a browser. Checks:
//   · pairing through the QR's pairing room: POST /api/pair over the link gives a device token;
//   · the device room: a direct link, sessions.list over a tunneled WebSocket (the seeded conversation is in it),
//     /api/file with a Range, an attachment upload that lands on disk;
//   · the slow relay (forced) on a broker that drops every 7th message: sessions.list still answers, every request
//     comes back whole although relay packets were lost, /api/file and /api/attachments are 413 with the sentence;
//   · revoking the device closes its tunneled WebSockets (direct and relay) at once and its room goes silent;
//   · nothing tries the public internet: the server's proxy is a recorder that must see no request at all.
// The signaling also goes through a second, lossless broker (the defaults do the same: the emqx pair signals, the
// relay uses others) — hello / offer / answer are sent once, a single lossy broker would make the dial itself a lottery.
//   node server/ws-phase21.mjs   (starts its own server: it needs its own env; scripts/e2e.mjs' port/token are ignored)
import WebSocket from 'ws';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBroker } from './src/remote/anywhere/__mocks__/mqtt-broker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(path.join(here, 'dist', 'remote', 'anywhere', 'core', 'index.js')).href);
const { RTCPeerConnection } = await import('node-datachannel/polyfill');
const { Brokers, Mux, DialError, deviceRoom, dial, pairRoom, unb64u } = core;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-phase21-'));
const home = path.join(root, 'home');
const proj = path.join(root, 'proj');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
const enc = new TextEncoder();
const dec = new TextDecoder();
const RELAY_REFUSED = '慢速转发时不能预览 / 上传文件';

const results = [];
const check = (name, ok, detail = '') => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 50) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

// ---- one finished Claude conversation in the temp HOME: sessions.list has something to show ----
const SID = randomUUID();
{
  const dir = path.join(home, '.claude', 'projects', proj.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString();
  const base = { isSidechain: false, userType: 'external', cwd: proj, sessionId: SID, version: '2.1.281' };
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), [
    { ...base, parentUuid: null, type: 'user', message: { role: 'user', content: 'phase21: seeded conversation' }, uuid: '00000000-0000-4000-8000-000000000211', timestamp: t },
    { ...base, parentUuid: '00000000-0000-4000-8000-000000000211', type: 'assistant', message: { id: 'msg_p21', type: 'message', role: 'assistant', model: 'claude-p21', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, uuid: '00000000-0000-4000-8000-000000000212', timestamp: t },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
}

// ---- the server's proxy: records anything that would go out, lets nothing through ----
const outgoing = [];
const recorder = http.createServer((q, s) => { outgoing.push(`${q.method} ${q.url}`); s.writeHead(502).end('phase21: nothing goes out'); });
recorder.on('connect', (q, sock) => { outgoing.push(`CONNECT ${q.url}`); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
const recorderUrl = await new Promise((r) => recorder.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${recorder.address().port}`)));

// ---- the brokers: one that signals cleanly, one that drops every 7th message and carries the relay ----
const signal = await startBroker();
const lossy = await startBroker({ dropEvery: 7 });
const defs = [{ name: 'signal', url: signal.url }, { name: 'lossy', url: lossy.url, relay: true }];

// ---- the server ----
const token = randomBytes(12).toString('hex');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: '0', CLAUDE_WEB_TOKEN: token, CLAUDE_WEB_DIR: path.join(home, '.claude-web'), CW_NO_MODEL_REFRESH: '1', CW_NO_PUBLIC_BROKERS: '1' };
for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_)/.test(k) || /^(no|http|https|all)_proxy$/i.test(k)) delete env[k];
Object.assign(env, { HTTPS_PROXY: recorderUrl, HTTP_PROXY: recorderUrl });
const server = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let slog = '';
server.stderr.on('data', (d) => { slog += d; });
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server did not start in 60s\n${slog}`)), 60_000);
  server.stdout.on('data', (d) => { slog += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(slog); if (m) { clearTimeout(t); res(m[1]); } });
  server.on('exit', (c) => rej(new Error(`server exited (${c})\n${slog}`)));
});

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type !== 'reply') return;
  const p = pending.get(m.reply.id);
  if (!p) return;
  pending.delete(m.reply.id);
  m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error));
});
const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
const anywhere = async () => (await req({ kind: 'remote.status' })).anywhere;

// ---- the phone ----
const rtc = RTCPeerConnection;
const phone = new Brokers(defs);
const links = [];

async function dialTo(room, o = {}) {
  const r = await dial({ brokers: phone, room, stun: [], rtc, helloTimeoutMs: o.helloTimeoutMs ?? 8000, forceRelay: o.forceRelay });
  links.push(r.link);
  // synchronously after the await (the Link contract): frames may already be waiting
  return { ...r, mux: new Mux(r.link) };
}

/** Why a dial failed (its DialError code), or 'linked' when it did not. */
async function dialFails(room) {
  return dial({ brokers: phone, room, stun: [], rtc, helloTimeoutMs: 3000 }).then((r) => { r.link.close(); return 'linked'; }, (e) => (e instanceof DialError ? e.code : String(e?.message ?? e)));
}

function openWs(mux, tok) {
  const e = { ws: mux.openWs(tok), got: [], open: false, closedAt: 0 };
  e.ws.onopen = () => { e.open = true; };
  e.ws.onmessage = (t) => e.got.push(t);
  e.ws.onclose = () => { e.closedAt = Date.now(); };
  return e;
}

/** A request over a tunneled WebSocket, the way the app sends it: its reply. */
async function ask(e, r, ms = 20_000) {
  if (!(await until(() => e.open || e.closedAt, ms)) || !e.open) throw new Error('the tunneled WebSocket did not open');
  const id = `p21-${++seq}`;
  e.ws.send(JSON.stringify({ type: 'request', request: { id, req: r } }));
  const reply = await until(() => { for (const t of e.got) { const m = JSON.parse(t); if (m.type === 'reply' && m.reply?.id === id) return m.reply; } return null; }, ms);
  if (!reply) throw new Error(`no reply to ${r.kind} within ${ms} ms`);
  return reply;
}

const fileUrl = (p, tok) => `/api/file?path=${encodeURIComponent(p)}&token=${encodeURIComponent(tok)}`;

async function main() {
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  await req({ kind: 'settings.set', key: 'remote.anywhere.brokers', value: defs });
  await req({ kind: 'settings.set', key: 'remote.anywhere.stun', value: [] });
  const st = await req({ kind: 'remote.set', enabled: true, port: await freePort() });
  const up = await until(async () => { const a = await anywhere(); return a?.on && a.brokers.length === 2 && a.brokers.every((b) => b.ok) ? a : null; }, 15_000, 100);
  check('remote access runs on its own port, 在外面也能用 is on with both test brokers', st.running && st.port > 0 && !!up, JSON.stringify(up?.brokers ?? up));
  phone.start();
  check('the phone reaches both brokers', !!(await until(() => phone.status().every((s) => s.ok), 10_000)), JSON.stringify(phone.status()));

  // ---- pairing ----
  const pc = await req({ kind: 'remote.pairCode' });
  let q = null;
  try { q = JSON.parse(dec.decode(unb64u(new URL(pc.anywhereUrl).hash.replace(/^#p=/, '')))); } catch { /* checked below */ }
  const ps = q?.ps ? unb64u(q.ps) : new Uint8Array();
  check('the 在哪都能用 QR: #p= with v 1, the code and a 16-byte pairing secret', q?.v === 1 && q.code === pc.code && ps.length === 16 && typeof q.pc === 'string', String(pc.anywhereUrl).replace(/#p=.*/, '#p=…'));
  const p = await dialTo(await pairRoom(ps));
  const pr = await p.mux.request({ method: 'POST', path: '/api/pair', headers: { 'content-type': 'application/json' }, body: enc.encode(JSON.stringify({ code: q.code, name: 'phase21 手机' })) });
  let paired = null;
  try { paired = JSON.parse(dec.decode(pr.body)); } catch { /* checked below */ }
  const devToken = paired?.token ?? '';
  check('pairing over the link: POST /api/pair gives a device token', pr.status === 200 && typeof devToken === 'string' && devToken.length > 20 && paired.device?.name === 'phase21 手机', `${pr.status} ${dec.decode(pr.body).slice(0, 120).replace(/"token":"[^"]+"/, '"token":"…"')}`);
  p.mux.close();

  // ---- the device room: direct ----
  const d = await dialTo(await deviceRoom(devToken));
  check('the device room answers with a direct link', /^p2p-v[46]$/.test(d.link.kind) && d.pcName === q.pc, d.link.kind);
  const sesOk = await until(async () => (await anywhere()).sessions.some((s) => s.deviceId === paired.device.id) || null, 5000, 100);
  check('… and the PC lists the session under that device', !!sesOk);
  const e1 = openWs(d.mux, devToken);
  const r1 = await ask(e1, { kind: 'sessions.list' });
  check('sessions.list over the tunneled WebSocket: the seeded conversation is in the reply', r1.ok && Array.isArray(r1.data) && r1.data.some((x) => x.sessionId === SID), r1.ok ? `${r1.data.length} conversations` : r1.error);

  const small = path.join(root, 'range.txt');
  fs.writeFileSync(small, 'abcdefghij');
  const rg = await d.mux.request({ method: 'GET', path: fileUrl(small, devToken), headers: { range: 'bytes=2-5' } });
  check('/api/file with a Range: 206, those four bytes, the content-range', rg.status === 206 && dec.decode(rg.body) === 'cdef' && rg.headers['content-range'] === 'bytes 2-5/10', `${rg.status} ${dec.decode(rg.body).slice(0, 40)} ${rg.headers['content-range']}`);
  const big = path.join(root, 'big.bin');
  const bigBytes = Buffer.alloc(600_000);
  for (let i = 0; i < bigBytes.length; i++) bigBytes[i] = (i * 131) & 0xff;
  fs.writeFileSync(big, bigBytes);
  const whole = await d.mux.request({ method: 'GET', path: fileUrl(big, devToken) });
  check('/api/file of 600 KB over the direct link comes through whole', whole.status === 200 && Buffer.from(whole.body).equals(bigBytes), `${whole.status} ${whole.body.length} bytes`);

  const attSid = randomUUID();
  const attText = 'phase21 附件 ✓';
  const at = await d.mux.request({ method: 'POST', path: `/api/attachments?sessionId=${attSid}&rel=${encodeURIComponent('notes/phase21.txt')}&token=${encodeURIComponent(devToken)}`, headers: { 'content-type': 'application/octet-stream' }, body: enc.encode(attText) });
  let atj = null;
  try { atj = JSON.parse(dec.decode(at.body)); } catch { /* checked below */ }
  const onDisk = atj?.path && fs.existsSync(atj.path) ? fs.readFileSync(atj.path, 'utf8') : null;
  check('an attachment upload over the direct link lands in the data dir with its bytes', at.status === 200 && onDisk === attText && atj.path.startsWith(path.join(home, '.claude-web')), `${at.status} ${atj?.path ?? dec.decode(at.body).slice(0, 80)}`);

  // ---- the slow relay, forced, on the lossy broker ----
  const before = lossy.droppedTopics.length;
  const r = await dialTo(await deviceRoom(devToken), { forceRelay: true });
  check('forced relay: the link is the slow relay', r.link.kind === 'relay', r.link.kind);
  const e2 = openWs(r.mux, devToken);
  const r2 = await ask(e2, { kind: 'sessions.list' }, 30_000);
  check('sessions.list over the relay answers as usual', r2.ok && r2.data.some((x) => x.sessionId === SID), r2.ok ? `${r2.data.length} conversations` : r2.error);
  // enough traffic that the broker's every-7th drop hits the relay's own packets; every answer must still be whole
  let asked = 0;
  let allWhole = true;
  const relayDrops = () => lossy.droppedTopics.slice(before).filter((t) => t.includes('/r/')).length;
  while (asked < 40 && (asked < 10 || relayDrops() < 2)) {
    asked++;
    const h = await r.mux.request({ method: 'GET', path: '/api/health' });
    let j = null;
    try { j = JSON.parse(dec.decode(h.body)); } catch { /* not whole */ }
    if (h.status !== 200 || j?.ok !== true) allWhole = false;
    const s = await ask(e2, { kind: 'remote.status' }, 30_000);
    if (!s.ok || !Array.isArray(s.data?.devices)) allWhole = false;
  }
  check('relay packets were lost on the way and every answer still came back whole', relayDrops() >= 1 && allWhole, `${asked} rounds, ${relayDrops()} relay packets dropped`);
  const rf = await r.mux.request({ method: 'GET', path: fileUrl(small, devToken) });
  check('over the relay /api/file is 413 with its sentence', rf.status === 413 && dec.decode(rf.body) === RELAY_REFUSED, `${rf.status} ${dec.decode(rf.body)}`);
  const ru = await r.mux.request({ method: 'POST', path: `/api/attachments?sessionId=${attSid}&rel=x.txt&token=${encodeURIComponent(devToken)}`, body: enc.encode('no') });
  check('over the relay /api/attachments is 413 with its sentence', ru.status === 413 && dec.decode(ru.body) === RELAY_REFUSED, `${ru.status} ${dec.decode(ru.body)}`);
  const kinds = (await anywhere()).sessions.map((s) => s.kind);
  check('the PC lists both sessions (direct and relay)', kinds.includes('relay') && kinds.some((k) => k.startsWith('p2p-')), kinds.join(', '));

  // ---- revoke ----
  const t0 = Date.now();
  await req({ kind: 'remote.devices.revoke', id: paired.device.id });
  const closed = await until(() => e1.closedAt && e2.closedAt, 2000, 20);
  check('revoking the device closes its tunneled WebSockets within 2 s (direct and relay)', !!closed, closed ? `${e1.closedAt - t0} / ${e2.closedAt - t0} ms` : `direct ${e1.closedAt ? 'closed' : 'open'}, relay ${e2.closedAt ? 'closed' : 'open'}`);
  check('… the PC has no session left', (await until(async () => (await anywhere()).sessions.length === 0 || null, 3000, 100)) === true);
  check('… and the device room no longer answers', (await dialFails(await deviceRoom(devToken))) === 'pc-silent');

  check('both local test brokers were used (the PC and the phone connected to each)', signal.connects.length >= 2 && lossy.connects.length >= 2, `${signal.connects.length} + ${lossy.connects.length} CONNECTs`);
  check('nothing tried the public internet (the server\'s proxy saw no request)', outgoing.length === 0, outgoing.slice(0, 5).join(', '));
}

main().catch((e) => { check('phase21 ran to the end', false, e.stack || e.message); }).finally(async () => {
  for (const l of links) { try { l.close(); } catch { /* */ } }
  phone.stop();
  try { ws.close(); } catch { /* */ }
  server.kill();
  recorder.closeAllConnections?.();
  recorder.close();
  await signal.close();
  await lossy.close();
  await sleep(800);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
  const bad = results.filter(([, ok]) => !ok);
  if (bad.length) console.log(`\n--- server log (tail) ---\n${slog.split('\n').slice(-60).join('\n')}`);
  console.log(`\nphase21: ${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
});
