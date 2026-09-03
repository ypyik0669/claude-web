// Phase 6 end-to-end: remote listener + pairing + device tokens, remote hosts / tunnels, IM gateway config.
//   node server/ws-phase6.mjs [port] [token]
import WebSocket from 'ws';
import net from 'node:net';

const port = process.argv[2] ?? '3090';
const token = process.argv[3];
const REMOTE_PORT = 3191 + Math.floor(Math.random() * 100);
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

function client(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.type === 'reply') { const p = pending.get(m.reply.id); pending.delete(m.reply.id); m.reply.ok ? p.res(m.reply.data) : p.rej(new Error(m.reply.error)); } });
  const req = (r) => new Promise((res, rej) => { const id = String(++seq); pending.set(id, { res, rej }); ws.send(JSON.stringify({ type: 'request', request: { id, req: r } })); });
  const open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); });
  return { ws, req, open };
}
const lanIp = () => new Promise((res) => { const s = net.createConnection({ host: '8.8.8.8', port: 53 }); s.once('connect', () => { const ip = s.localAddress; s.destroy(); res(ip); }); s.once('error', () => res('127.0.0.1')); });

const main = client(`ws://127.0.0.1:${port}/ws${token ? `?token=${token}` : ''}`);
await main.open;
const req = main.req;
try {
  // ---- remote listener ----
  const st0 = await req({ kind: 'remote.status' });
  check('remote.status', typeof st0.enabled === 'boolean' && Array.isArray(st0.devices));
  const st1 = await req({ kind: 'remote.set', enabled: true, port: REMOTE_PORT });
  check('remote.set enables the listener', st1.running && st1.port === REMOTE_PORT, st1.error);
  const ip = await lanIp();
  const health = await fetch(`http://${ip}:${REMOTE_PORT}/api/health`).then((r) => r.json()).catch((e) => ({ error: e.message }));
  check('remote listener answers on the LAN address', health.ok === true, `${ip}:${REMOTE_PORT}`);
  check('primary LAN address listed first', st1.addresses[0] === ip, `${st1.addresses[0]} vs ${ip}`);
  const pairPage = await fetch(`http://127.0.0.1:${REMOTE_PORT}/pair`).then((r) => r.text());
  check('/pair page served', pairPage.includes('配对码'));
  const pc = await req({ kind: 'remote.pairCode' });
  check('remote.pairCode', /^\d{6}$/.test(pc.code) && pc.url.includes(`:${REMOTE_PORT}/pair#${pc.code}`), pc.url);
  const bad = await fetch(`http://127.0.0.1:${REMOTE_PORT}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '000000', name: 'x' }) });
  check('wrong pairing code rejected', bad.status === 400);
  const good = await fetch(`http://127.0.0.1:${REMOTE_PORT}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pc.code, name: 'e2e phone' }) }).then((r) => r.json());
  check('pairing returns a device token', typeof good.token === 'string' && good.token.length > 20 && good.device?.name === 'e2e phone');
  const reuse = await fetch(`http://127.0.0.1:${REMOTE_PORT}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pc.code, name: 'again' }) });
  check('pairing code is single-use', reuse.status === 400);
  // device token works on the remote listener (and on the main one), unknown token does not
  const dev = client(`ws://127.0.0.1:${REMOTE_PORT}/ws?token=${good.token}`);
  let devOk = false;
  try { await dev.open; const list = await dev.req({ kind: 'sessions.list', limit: 3 }); devOk = Array.isArray(list); } catch { devOk = false; }
  check('device token opens a websocket on the remote listener', devOk);
  dev.ws.close();
  const nope = client(`ws://127.0.0.1:${REMOTE_PORT}/ws?token=not-a-token`);
  let rejected = false;
  try { await nope.open; } catch { rejected = true; }
  check('unknown token rejected on the remote listener (even without a main token)', rejected);
  const fileOk = await fetch(`http://127.0.0.1:${REMOTE_PORT}/api/file?path=${encodeURIComponent(process.cwd() + '/package.json')}`, { headers: { cookie: `cw_token=${good.token}` } });
  check('device cookie authorizes /api/file', fileOk.status === 200);
  const st2 = await req({ kind: 'remote.status' });
  const d = st2.devices.find((x) => x.name === 'e2e phone');
  check('device listed with lastSeen', !!d && d.lastSeenAt > 0);
  await req({ kind: 'remote.devices.rename', id: d.id, name: 'renamed phone' });
  await req({ kind: 'remote.devices.revoke', id: d.id });
  const st3 = await req({ kind: 'remote.status' });
  check('device rename + revoke', !st3.devices.some((x) => x.id === d.id));
  const revoked = client(`ws://127.0.0.1:${REMOTE_PORT}/ws?token=${good.token}`);
  let revokedRejected = false;
  try { await revoked.open; await revoked.req({ kind: 'sessions.list', limit: 1 }); } catch { revokedRejected = true; }
  check('revoked token no longer works', revokedRejected);
  const st4 = await req({ kind: 'remote.set', enabled: false });
  check('remote.set disables the listener', !st4.running);
  const closed = await fetch(`http://127.0.0.1:${REMOTE_PORT}/api/health`).then(() => false).catch(() => true);
  check('remote port closed after disable', closed);

  // ---- hosts + tunnels ----
  await req({ kind: 'remote.hosts.set', host: { id: 'e2e-host', name: 'bogus', target: 'nobody@127.0.0.1', sshPort: 1, remotePort: 3090 } });
  const hosts = await req({ kind: 'remote.hosts.list' });
  check('remote.hosts.set/list', hosts.some((h) => h.id === 'e2e-host'));
  const t = await req({ kind: 'tunnel.open', hostId: 'e2e-host' });
  check('tunnel.open to an unreachable host fails cleanly', t.state === 'down' && typeof t.error === 'string' && t.error.length > 0, t.error.slice(0, 80));
  await req({ kind: 'remote.hosts.remove', id: 'e2e-host' });
  check('remote.hosts.remove', !(await req({ kind: 'remote.hosts.list' })).some((h) => h.id === 'e2e-host'));

  // ---- IM gateways ----
  const kinds = await req({ kind: 'im.kinds' });
  check('im.kinds', ['telegram', 'discord', 'slack', 'feishu', 'dingtalk', 'wecom'].every((k) => kinds.some((x) => x.kind === k)));
  const l1 = await req({ kind: 'im.set', id: 'e2e-tg', patch: { kind: 'telegram', name: 'e2e', enabled: true, config: { botToken: '123:not-a-real-token' } } });
  const g = l1.find((x) => x.id === 'e2e-tg');
  check('im.set stores a masked secret', g && g.config.botToken === '••••••');
  await new Promise((r) => setTimeout(r, 4000));
  const g2 = (await req({ kind: 'im.list' })).find((x) => x.id === 'e2e-tg');
  check('bogus telegram token → error state', g2.state === 'error' && g2.error.length > 0, g2.error.slice(0, 60));
  const pcode = await req({ kind: 'im.pairCode', id: 'e2e-tg' });
  check('im.pairCode', /^\d{6}$/.test(pcode.code));
  const l3 = await req({ kind: 'im.set', id: 'e2e-tg', patch: { enabled: false, allowUsers: ['42'], allowNames: { 42: 'Bob' } } });
  const g3 = l3.find((x) => x.id === 'e2e-tg');
  check('im.set patch keeps the secret and updates allow list', g3.enabled === false && g3.state === 'stopped' && g3.allowUsers[0] === '42' && g3.config.botToken === '••••••');
  await req({ kind: 'im.set', id: 'e2e-tg', patch: null });
  check('im.set null removes', !(await req({ kind: 'im.list' })).some((x) => x.id === 'e2e-tg'));
} catch (e) {
  check('script error', false, e.stack ?? String(e));
}
const pass = results.filter((r) => r[1]).length;
console.log(`\n${pass}/${results.length} checks passed`);
main.ws.close();
process.exit(pass === results.length ? 0 : 1);
