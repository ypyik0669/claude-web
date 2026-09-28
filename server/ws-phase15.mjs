// Phase 15 end-to-end: cross-machine sessions (federation) with two servers on this machine.
// A is the server scripts/e2e.mjs started (port / token in argv); this script starts B itself with its
// own temp HOME + CLAUDE_WEB_DIR, turns on B's remote listener on a free port, makes a mock-ACP
// session on B, then has A pair with B by code and checks: B's session in A's list, open + send from A
// with events coming back, a permission round trip, hand-over to a local agent, the loop guard,
// revoked token → unauthorized → re-pair, and B going down → offline peer, local list unaffected.
//   node server/ws-phase15.mjs [port] [token]   (meant for scripts/e2e.mjs: temp HOME + CLAUDE_WEB_DIR)
import WebSocket from 'ws';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const portA = args[0] ?? '3090';
const tokenA = args[1];
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const mock = path.join(here, 'src', 'agents', '__mocks__', 'acp-agent.mjs');
const AGENT = 'acp:e2e-fed';
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '0.0.0.0', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

function client(url, label) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];
  const safe = (fn, e) => { try { return fn(e); } catch { return false; } };
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (process.env.CW_DEBUG) console.error(label, '<<', String(raw).slice(0, 240));
    if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); return; }
    if (m.type === 'event') { events.push(m.event); for (const w of [...waiters]) if (safe(w.fn, m.event)) { waiters.splice(waiters.indexOf(w), 1); w.res(m.event); } }
  });
  const raw = (envelope) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, ...envelope } })); });
  const req = (r) => raw({ req: r });
  const waitEvent = (fn, ms = 60000) => new Promise((res, rej) => { const hit = events.find((e) => safe(fn, e)); if (hit) return res(hit); const w = { fn, res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error('timeout waiting for event')); }, ms); });
  const open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return { ws, req, raw, events, waitEvent, open };
}
const until = async (fn, ms = 20000, step = 250) => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) return null; await sleep(step); } };
// peers.add / peers.repair answer after a short wait for the first connect; a slow machine may still be
// "connecting" then — poll the list instead of trusting one window
const onlineIn = (c, id, ms = 30000) => until(async () => (await c.req({ kind: 'peers.list' })).find((p) => p.id === id && p.state === 'online') ?? null, ms);

// ---- start B ----
const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-e2e-b-'));
const tokenB = randomBytes(12).toString('hex');
const envB = { ...process.env, HOME: homeB, USERPROFILE: homeB, PORT: '0', CLAUDE_WEB_TOKEN: tokenB, CLAUDE_WEB_DIR: path.join(homeB, '.claude-web') };
for (const k of Object.keys(envB)) if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(k)) delete envB[k];
const serverB = spawn(process.execPath, [path.join(here, 'dist', 'index.js')], { cwd: root, env: envB, stdio: ['ignore', 'pipe', 'pipe'] });
let logB = '';
serverB.stderr.on('data', (d) => { logB += d; });
let bAlive = true;
serverB.on('exit', () => { bAlive = false; });
const portB = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`server B did not start\n${logB}`)), 60_000);
  serverB.stdout.on('data', (d) => { logB += d; const m = /listening on http:\/\/[^:]+:(\d+)/.exec(logB); if (m) { clearTimeout(t); res(m[1]); } });
});
console.log(`server B on :${portB} (HOME=${homeB})`);

const A = client(`ws://127.0.0.1:${portA}/ws${tokenA ? `?token=${tokenA}` : ''}`, 'A');
const B = client(`ws://127.0.0.1:${portB}/ws?token=${tokenB}`, 'B');
await Promise.all([A.open, B.open]);
let peerId;
try {
  const helloA = await A.waitEvent((e) => e.kind === 'hello', 5000);
  const helloB = await B.waitEvent((e) => e.kind === 'hello', 5000);
  check('hello carries a serverId (and they differ)', !!helloA.serverId && !!helloB.serverId && helloA.serverId !== helloB.serverId, `${helloA.serverId} / ${helloB.serverId}`);

  // ---- B: remote listener + a mock-ACP session with one finished turn ----
  const remotePort = await freePort();
  const st = await B.req({ kind: 'remote.set', enabled: true, port: remotePort });
  check('B: remote listener up', st.running && st.port === remotePort, st.error);
  await B.req({ kind: 'agents.set', agent: AGENT, patch: { name: 'Fed Mock', command: process.execPath, args: [mock], protocol: 'acp' } });
  const ob = await B.req({ kind: 'session.open', params: { cwd: root, agent: AGENT, permissionMode: 'default' } });
  const sidB = ob.sessionId;
  await B.waitEvent((e) => e.kind === 'session.state' && e.sessionId === sidB && (e.state === 'idle' || e.state === 'error'), 60000);
  await B.req({ kind: 'session.send', params: { sessionId: sidB, text: 'hello from machine B' } });
  await B.waitEvent((e) => e.kind === 'session.event' && e.sessionId === sidB && e.message.type === 'result', 60000);
  const bList = await B.req({ kind: 'sessions.list' });
  check('B: its session is listed', bList.some((s) => s.sessionId === sidB), sidB);

  // ---- A: one local session of its own (must survive everything below) ----
  await A.req({ kind: 'agents.set', agent: AGENT, patch: { name: 'Fed Mock (A)', command: process.execPath, args: [mock], protocol: 'acp' } });
  const oLocal = await A.req({ kind: 'session.open', params: { cwd: root, agent: AGENT } });
  await A.waitEvent((e) => e.kind === 'session.state' && e.sessionId === oLocal.sessionId && (e.state === 'idle' || e.state === 'error'), 60000);
  await A.req({ kind: 'session.send', params: { sessionId: oLocal.sessionId, text: 'hello from machine A' } });
  await A.waitEvent((e) => e.kind === 'session.event' && e.sessionId === oLocal.sessionId && e.message.type === 'result', 60000);
  await A.req({ kind: 'session.close', sessionId: oLocal.sessionId }).catch(() => {});
  const localBefore = await A.req({ kind: 'sessions.list' });
  check('A: has its own local session', localBefore.some((s) => s.sessionId === oLocal.sessionId), `${localBefore.length} local`);

  // ---- A pairs with B ----
  const pc = await B.req({ kind: 'remote.pairCode' });
  const wrong = pc.code === '000000' ? '111111' : '000000';
  const bad = await A.req({ kind: 'peers.add', url: `http://127.0.0.1:${remotePort}`, code: wrong }).then(() => null, (e) => e.message);
  check('A: wrong pairing code is refused', !!bad && bad.includes('不对'), bad ?? '');
  const peer = await A.req({ kind: 'peers.add', url: `127.0.0.1:${remotePort}`, code: pc.code });
  peerId = peer.id;
  const peerOn = await onlineIn(A, peer.id);
  check('A: peers.add pairs by code and connects', !!peerOn && /^[a-z0-9]+$/.test(peer.id) && peer.via === 'direct', `${peerOn?.state ?? peer.state} ${peer.name} ${peer.error ?? ''}`);
  const peers = await A.req({ kind: 'peers.list' });
  check('A: peers.list never carries the token', peers.length === 1 && !('token' in peers[0]) && !JSON.stringify(peers).includes('enc:'));
  const devs = (await B.req({ kind: 'remote.status' })).devices;
  check('B: A shows up as a paired device', devs.length === 1 && /Claude Web/.test(devs[0].name), devs[0]?.name);

  const psid = `peer_${peerId}~${sidB}`;
  const aList = await until(async () => { const l = await A.req({ kind: 'sessions.list' }); return l.some((s) => s.sessionId === psid) ? l : null; });
  const row = aList?.find((s) => s.sessionId === psid);
  check("A: B's session is in A's list, tagged with the machine", !!row && row.peer?.id === peerId && !row.peer.offline && row.agent === AGENT, row ? JSON.stringify(row.peer) : 'missing');
  check("A: A's own sessions are still there", localBefore.every((s) => aList?.some((x) => x.sessionId === s.sessionId)), `${localBefore.length} local`);
  // ---- mutual peering: B adds A too. No event echo, no rows bouncing back ----
  const remoteA = await freePort();
  const stA = await A.req({ kind: 'remote.set', enabled: true, port: remoteA });
  check('A: remote listener up (for B to join)', stA.running, stA.error);
  const pcA = await A.req({ kind: 'remote.pairCode' });
  const peerA = await B.req({ kind: 'peers.add', url: `http://127.0.0.1:${remoteA}`, code: pcA.code });
  check('B: adds A as a peer (mutual)', !!(await onlineIn(B, peerA.id)), `${peerA.state} ${peerA.error ?? ''}`);
  const bLocalIds = new Set(bList.map((s) => s.sessionId));
  const bBack = await until(async () => { const l = await B.req({ kind: 'sessions.list' }); return l.some((s) => s.peer?.id === peerA.id) ? l : null; });
  const fromA = (bBack ?? []).filter((s) => s.peer);
  const remoteIds = fromA.map((s) => s.sessionId.slice(`peer_${peerA.id}~`.length));
  check("B: sees A's own session through A", remoteIds.includes(oLocal.sessionId), remoteIds.join(' '));
  check("B: none of B's own sessions come back through A (no multi-hop echo)", fromA.length > 0 && remoteIds.every((id) => !id.startsWith('peer_') && !bLocalIds.has(id)), remoteIds.join(' '));
  // one change on each side, then count sessions.changed for a few seconds: an echo loop would be hundreds
  const countFrom = (c) => c.events.length;
  const a0 = countFrom(A), b0 = countFrom(B);
  await B.req({ kind: 'library.rename', sessionId: sidB, title: 'renamed on B' });
  await A.req({ kind: 'library.rename', sessionId: oLocal.sessionId, title: 'renamed on A' });
  await sleep(4000);
  const changedA = A.events.slice(a0).filter((e) => e.kind === 'sessions.changed' || e.kind === 'library.changed').length;
  const changedB = B.events.slice(b0).filter((e) => e.kind === 'sessions.changed' || e.kind === 'library.changed').length;
  check('mutual peers: list-change events stay bounded (no echo)', changedA > 0 && changedA <= 12 && changedB > 0 && changedB <= 12, `A ${changedA}, B ${changedB} in 4s`);
  const peersFromPeer = await B.raw({ req: { kind: 'peers.list' }, via: [helloA.serverId + 'x'] }).then(() => null, (e) => e.message);
  check('peers.* are refused for requests coming from another machine', !!peersFromPeer, peersFromPeer ?? '');
  // B adding its own address: refused before the code is redeemed (no orphan device on B)
  const devCount = (await B.req({ kind: 'remote.status' })).devices.length;
  const pcSelf = await B.req({ kind: 'remote.pairCode' });
  const selfErr = await B.req({ kind: 'peers.add', url: `http://127.0.0.1:${remotePort}`, code: pcSelf.code }).then(() => null, (e) => e.message);
  const devAfter = (await B.req({ kind: 'remote.status' })).devices.length;
  check('adding yourself is refused without leaving a device token behind', !!selfErr && selfErr.includes('本机') && devAfter === devCount, `${selfErr} · devices ${devCount}→${devAfter}`);
  await B.req({ kind: 'peers.remove', id: peerA.id });
  await A.req({ kind: 'remote.set', enabled: false });

  const hist = await A.req({ kind: 'transcript.load', sessionId: psid });
  check('A: transcript.load of a remote session', Array.isArray(hist) && JSON.stringify(hist).includes('hello from machine B'), `${hist?.length} messages`);

  // ---- open + send from A, events come back prefixed; permission round trip ----
  const oa = await A.req({ kind: 'session.open', params: { sessionId: psid, cwd: row?.cwd ?? root } });
  check('A: session.open on a remote session returns the prefixed id', oa.sessionId === psid && oa.info?.sessionId === psid, oa.sessionId);
  await A.req({ kind: 'session.send', params: { sessionId: psid, text: 'please use a tool' } });
  const perm = await A.waitEvent((e) => e.kind === 'permission.request' && e.request.sessionId === psid, 60000).catch(() => null);
  check('A: the remote permission request arrives prefixed', !!perm && perm.request.requestId.startsWith(`peer_${peerId}~`), perm?.request.requestId);
  const onB = B.events.find((e) => e.kind === 'permission.request' && e.request.sessionId === sidB);
  check('B: the same request exists un-prefixed on B', !!onB && `peer_${peerId}~${onB.request.requestId}` === perm?.request.requestId);
  if (perm) await A.req({ kind: 'permission.respond', requestId: perm.request.requestId, response: { behavior: 'allow' } });
  const resolved = await A.waitEvent((e) => e.kind === 'permission.resolved' && e.requestId === perm?.request.requestId, 30000).catch(() => null);
  check('A: permission.resolved comes back prefixed', !!resolved);
  const result = await A.waitEvent((e) => e.kind === 'session.event' && e.sessionId === psid && e.message.type === 'result', 60000).catch(() => null);
  check('A: the turn result streams back to A', !!result && !result.message.is_error);
  const streamed = A.events.filter((e) => e.kind === 'session.event' && e.sessionId === psid).map((e) => JSON.stringify(e.message)).join('');
  check('A: the allowed tool ran on B', streamed.includes('read ok'));
  check('A: nothing about B arrives un-prefixed', !A.events.some((e) => (e.kind === 'session.event' || e.kind === 'session.state') && e.sessionId === sidB));

  // ---- guards ----
  const loop = await A.raw({ req: { kind: 'sessions.list' }, via: [helloA.serverId] }).then(() => null, (e) => e.message);
  check('loop guard: a request that already passed through A is refused', !!loop && loop.includes('环路'), loop ?? '');
  const hop = await B.raw({ req: { kind: 'session.interrupt', sessionId: `peer_zz~x` }, via: ['someone'] }).then(() => null, (e) => e.message);
  check('no multi-hop forwarding', !!hop && hop.includes('多跳'), hop ?? '');
  const nope = await A.req({ kind: 'session.setProvider', sessionId: psid }).then(() => null, (e) => e.message);
  check('unsupported operations on remote sessions are refused', !!nope, nope ?? '');
  // what the panels send while a remote session has focus: memory is this machine's, touched files are B's
  const mem = await A.req({ kind: 'memory.search', sessionId: psid, cwd: row?.cwd, limit: 5 }).catch((e) => e.message);
  const wrote = await A.req({ kind: 'memory.write', text: 'fed e2e note', scope: 'session', sessionId: psid }).then(() => true, (e) => e.message);
  check('memory panel works with a remote session focused (memory stays local)', Array.isArray(mem) && wrote === true, `${JSON.stringify(mem).slice(0, 60)} ${wrote}`);
  const touched = await A.req({ kind: 'files.changed', sessionId: psid }).catch((e) => e.message);
  check('files.changed for a remote session is answered by B', Array.isArray(touched), JSON.stringify(touched).slice(0, 60));

  // ---- hand-over to a local agent ----
  const ho = await A.req({ kind: 'peers.handover', sessionId: psid, agent: AGENT, cwd: root });
  check('A: hand-over starts a NEW local session with a briefing', !!ho.sessionId && !ho.sessionId.startsWith('peer_') && (ho.briefing ?? '').includes('hello from machine B'), ho.sessionId);
  await A.req({ kind: 'session.close', sessionId: ho.sessionId }).catch(() => {});

  // ---- revoked token → unauthorized → re-pair ----
  await A.req({ kind: 'session.close', sessionId: psid }).catch(() => {});
  const dev = (await B.req({ kind: 'remote.status' })).devices[0];
  await B.req({ kind: 'remote.devices.revoke', id: dev.id });
  await A.req({ kind: 'peers.update', id: peerId, patch: { enabled: false } });
  const dis = (await A.req({ kind: 'peers.list' }))[0];
  const hidden = await A.req({ kind: 'sessions.list' });
  check('A: a disabled peer and its sessions are hidden', dis.state === 'disabled' && !hidden.some((s) => s.peer), dis.state);
  await A.req({ kind: 'peers.update', id: peerId, patch: { enabled: true } });
  const unauth = await until(async () => { const p = (await A.req({ kind: 'peers.list' }))[0]; return p.state === 'unauthorized' ? p : null; }, 20000);
  check('A: a revoked device token shows "令牌失效"', !!unauth && unauth.error.includes('重新配对'), unauth?.error);
  const pc2 = await B.req({ kind: 'remote.pairCode' });
  const re = await A.req({ kind: 'peers.repair', id: peerId, code: pc2.code });
  check('A: re-pair keeps the peer id and comes back online', re.id === peerId && !!(await onlineIn(A, peerId)), re.state);

  // ---- B goes down ----
  serverB.kill();
  await until(async () => !bAlive, 10000);
  const off = await until(async () => { const p = (await A.req({ kind: 'peers.list' }))[0]; return p.state === 'offline' ? p : null; }, 20000);
  check('A: B down → peer offline', !!off, off?.error);
  const t0 = Date.now();
  const afterList = await A.req({ kind: 'sessions.list' });
  const ms = Date.now() - t0;
  const grey = afterList.find((s) => s.sessionId === psid);
  check('A: offline peer rows come from the cache, greyed out', !!grey && grey.peer?.offline === true && !grey.live);
  check("A: A's own list is unaffected and fast", localBefore.every((s) => afterList.some((x) => x.sessionId === s.sessionId)) && ms < 3000, `${ms} ms`);
  const offErr = await A.req({ kind: 'session.interrupt', sessionId: psid }).then(() => null, (e) => e.message);
  check('A: requests to an offline machine fail cleanly', !!offErr && offErr.includes('离线'), offErr ?? '');

  await A.req({ kind: 'peers.remove', id: peerId });
  const gone = await A.req({ kind: 'sessions.list' });
  check('A: peers.remove drops its sessions', !gone.some((s) => s.peer) && (await A.req({ kind: 'peers.list' })).length === 0);
  peerId = undefined;
} catch (e) {
  check('script error', false, e.stack ?? String(e));
}
if (peerId) await A.req({ kind: 'peers.remove', id: peerId }).catch(() => {});
await A.req({ kind: 'agents.set', agent: AGENT, patch: null }).catch(() => {});
if (bAlive) serverB.kill();
A.ws.close();
B.ws.close();
await sleep(500);
try { fs.rmSync(homeB, { recursive: true, force: true }); } catch { /* windows may still hold a handle */ }
const pass = results.filter((r) => r[1]).length;
// B is this script's own server: its log is nowhere else, so a failure prints its tail here
if (pass !== results.length) console.log(`\n----- server B log (last 60 lines) -----\n${logB.split('\n').slice(-60).join('\n')}`);
console.log(`\n${pass}/${results.length} checks passed`);
process.exit(pass === results.length ? 0 : 1);
