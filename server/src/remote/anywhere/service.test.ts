// The PC side end to end: a real server (startServer) with remote access on a free port and the "works anywhere"
// service pointed at a local test broker; the phone is played by dial() + Mux over node-datachannel, in process.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBroker } from './__mocks__/mqtt-broker.mjs';
import { loadRtc } from './rtc.js';
import { Brokers, DialError, Mux, deviceRoom, dial, pairRoom, unb64u, type Link, type LinkKind, type MuxWs, type RtcCtor } from './core/index.js';

// before anything reads the home folder: the server's modules are imported below, after this
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-anywhere-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.CLAUDE_WEB_DIR = path.join(home, '.claude-web');
process.env.CW_NO_MODEL_REFRESH = '1';
process.env.CW_NO_PUBLIC_BROKERS = '1';
delete process.env.CLAUDE_WEB_TOKEN;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A port nothing listens on right now (RemoteService.set does not take 0). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

type Broker = Awaited<ReturnType<typeof startBroker>>;
let broker: Broker;
let server: { port: number; close(): Promise<void> };
let client: WebSocket;
let phone: Brokers;
let rtc: RtcCtor;
let maskSecrets: (t: string) => string;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let nextId = 0;
const opened: Link[] = [];

/** A request to the server over its local (main) WebSocket, as the settings page sends it. */
function req<T = any>(kind: string, extra: Record<string, unknown> = {}): Promise<T> {
  const id = `t${++nextId}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    client.send(JSON.stringify({ type: 'request', request: { id, req: { kind, ...extra } } }));
  });
}

async function anywhere() {
  return (await req('remote.status')).anywhere;
}

async function dialRoom(room: Awaited<ReturnType<typeof deviceRoom>>, extra: { forceRelay?: boolean; helloTimeoutMs?: number } = {}) {
  const r = await dial({ brokers: phone, room, stun: [], rtc, helloTimeoutMs: extra.helloTimeoutMs ?? 5000, forceRelay: extra.forceRelay });
  opened.push(r.link);
  // synchronously after the await, as the Link contract asks
  const mux = new Mux(r.link);
  return { ...r, mux };
}

interface WsEnd {
  ws: MuxWs;
  got: string[];
  open: boolean;
  closedAt: number;
}

function openWs(mux: Mux, token: string): WsEnd {
  const ws = mux.openWs(token);
  const e: WsEnd = { ws, got: [], open: false, closedAt: 0 };
  ws.onopen = () => {
    e.open = true;
  };
  ws.onmessage = (t) => e.got.push(t);
  ws.onclose = () => {
    e.closedAt = Date.now();
  };
  return e;
}

/** sessions.list over a tunneled WebSocket, the way the phone's app asks it. */
async function listOver(e: WsEnd, id: string): Promise<any> {
  await until(() => e.open, 'the tunneled WebSocket to open');
  e.ws.send(JSON.stringify({ type: 'request', request: { id, req: { kind: 'sessions.list' } } }));
  let reply: any;
  await until(() => {
    for (const t of e.got) {
      const m = JSON.parse(t);
      if (m.type === 'reply' && m.reply?.id === id) reply = m.reply;
    }
    return !!reply;
  }, `the reply to ${id}`);
  return reply;
}

beforeAll(async () => {
  broker = await startBroker();
  maskSecrets = (await import('../../diag/service.js')).maskSecrets;
  const { startServer } = await import('../../index.js');
  const dist = fs.mkdtempSync(path.join(home, 'dist-'));
  server = await startServer({ port: 0, host: '127.0.0.1', distDir: dist, version: '0.0.0-test' });
  client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  client.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type !== 'reply') return;
    const p = pending.get(m.reply.id);
    if (!p) return;
    pending.delete(m.reply.id);
    if (m.reply.ok) p.resolve(m.reply.data);
    else p.reject(new Error(m.reply.error));
  });
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });
  const defs = [{ name: 'mock', url: broker.url, relay: true }];
  await req('settings.set', { key: 'remote.anywhere.brokers', value: defs });
  await req('settings.set', { key: 'remote.anywhere.stun', value: [] });
  const st = await req('remote.set', { enabled: true, port: await freePort() });
  expect(st.running).toBe(true);
  // the PC: on, its one broker up
  let a: any;
  const t0 = Date.now();
  for (;;) {
    a = await anywhere();
    if (a?.on && a.brokers.length === 1 && a.brokers[0].ok) break;
    if (Date.now() - t0 > 10_000) throw new Error(`anywhere never came up: ${JSON.stringify(a)}`);
    await sleep(50);
  }
  const m = await loadRtc();
  if ('error' in m) throw new Error(m.error);
  rtc = m.RTCPeerConnection as unknown as RtcCtor;
  phone = new Brokers(defs);
  phone.start();
  await until(() => phone.status().every((s) => s.ok), 'the phone pool up');
}, 60_000);

afterAll(async () => {
  for (const l of opened) l.close();
  phone?.stop();
  client?.terminate();
  await server?.close();
  await broker?.close();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // the server keeps memory.db open after close() (it has no close for it): the OS temp cleanup takes it
  }
}, 60_000);

describe('AnywhereService', () => {
  let token = '';
  let device: Awaited<ReturnType<typeof dialRoom>>;
  let relay: Awaited<ReturnType<typeof dialRoom>>;

  it('status: on, the broker, the shell address, keep-awake on by default', async () => {
    const a = await anywhere();
    expect(a.on).toBe(true);
    expect(a.brokers).toEqual([{ name: 'mock', ok: true }]);
    expect(a.shellUrl).toBe('https://ypyik0669.github.io/claude-web/');
    expect(a.keepAwake).toBe(true);
    expect(a.sessions).toEqual([]);
  });

  it('pairs through the pairing room: only POST /api/pair goes through, then the device room answers', async () => {
    const pc = await req('remote.pairCode');
    expect(pc.url).toMatch(/\/pair#\d{6}$/);
    expect(typeof pc.anywhereUrl).toBe('string');
    const u = new URL(pc.anywhereUrl);
    expect(`${u.origin}${u.pathname}`).toBe('https://ypyik0669.github.io/claude-web/');
    expect(u.hash.startsWith('#p=')).toBe(true);
    const q = JSON.parse(dec.decode(unb64u(u.hash.slice(3))));
    expect(q.v).toBe(1);
    expect(q.code).toBe(pc.code);
    expect(typeof q.pc).toBe('string');
    const ps = unb64u(q.ps);
    expect(ps.length).toBe(16);

    const p = await dialRoom(await pairRoom(ps));
    // anything but the pairing request is refused in the pairing room
    const root = await p.mux.request({ method: 'GET', path: '/' });
    expect(root.status).toBe(403);
    const ws = openWs(p.mux, 'whatever');
    await until(() => ws.closedAt > 0, 'a WebSocket refused in the pairing room');
    expect(ws.open).toBe(false);

    const res = await p.mux.request({
      method: 'POST',
      path: '/api/pair',
      headers: { 'content-type': 'application/json' },
      body: enc.encode(JSON.stringify({ code: q.code, name: '测试手机' })),
    });
    expect(res.status).toBe(200);
    const j = JSON.parse(dec.decode(res.body));
    expect(typeof j.token).toBe('string');
    expect(j.device.name).toBe('测试手机');
    token = j.token;
    p.mux.close();

    device = await dialRoom(await deviceRoom(token));
    expect(['p2p-v4', 'p2p-v6']).toContain(device.link.kind);
    expect(device.pcName).toBe(q.pc);
    const a = await anywhere();
    expect(a.sessions).toEqual([expect.objectContaining({ deviceId: j.device.id, kind: device.link.kind })]);
    expect(a.recent[0]).toEqual(expect.objectContaining({ deviceId: j.device.id, ok: true, kind: device.link.kind }));
  });

  it('a tunneled WebSocket reaches the hub: sessions.list gets its reply', async () => {
    const e = openWs(device.mux, token);
    const reply = await listOver(e, '1');
    expect(reply.ok).toBe(true);
    e.ws.close();
    await until(() => e.closedAt > 0, 'onclose after our own close');
  });

  it('a wrong token: the tunneled WebSocket closes at once and never opens', async () => {
    const e = openWs(device.mux, 'not-a-device-token');
    const t0 = Date.now();
    await until(() => e.closedAt > 0, 'onclose for a wrong token', 3000);
    expect(e.closedAt - t0).toBeLessThan(2000);
    expect(e.open).toBe(false);
  });

  it('GET /api/file with a range: 206 and those four bytes', async () => {
    const file = path.join(home, 'range.txt');
    fs.writeFileSync(file, 'abcdefghij');
    const res = await device.mux.request({
      method: 'GET',
      path: `/api/file?path=${encodeURIComponent(file)}&token=${encodeURIComponent(token)}`,
      headers: { range: 'bytes=2-5' },
    });
    expect(res.status).toBe(206);
    expect(dec.decode(res.body)).toBe('cdef');
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
  });

  it('a large response over the direct link comes through whole', async () => {
    const file = path.join(home, 'big.bin');
    const big = new Uint8Array(300_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    fs.writeFileSync(file, big);
    const res = await device.mux.request({ method: 'GET', path: `/api/file?path=${encodeURIComponent(file)}&token=${encodeURIComponent(token)}` });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(big.length);
    expect(Buffer.from(res.body).equals(Buffer.from(big))).toBe(true);
  });

  it('over the slow relay: /api/file is refused with 413 and its sentence, the WebSocket still works', async () => {
    const r = await dialRoom(await deviceRoom(token), { forceRelay: true });
    relay = r;
    expect(r.link.kind).toBe('relay');
    const file = path.join(home, 'range.txt');
    const res = await r.mux.request({ method: 'GET', path: `/api/file?path=${encodeURIComponent(file)}&token=${encodeURIComponent(token)}` });
    expect(res.status).toBe(413);
    expect(dec.decode(res.body)).toBe('慢速转发时不能预览 / 上传文件');
    const up = await r.mux.request({ method: 'POST', path: `/api/attachments?sessionId=s&rel=a.txt&token=${encodeURIComponent(token)}`, body: enc.encode('hi') });
    expect(up.status).toBe(413);
    expect(dec.decode(up.body)).toBe('慢速转发时不能预览 / 上传文件');
    const e = openWs(r.mux, token);
    const reply = await listOver(e, '2');
    expect(reply.ok).toBe(true);
    const kinds = (await anywhere()).sessions.map((s: { kind: LinkKind }) => s.kind);
    expect(kinds).toContain('relay');
  });

  it('revoking the device closes its open tunneled WebSockets within 2 s (direct and relay), and its room goes silent', async () => {
    const direct = openWs(device.mux, token);
    await listOver(direct, '3');
    const slow = openWs(relay.mux, token);
    await listOver(slow, '4');
    let muxClosed = '';
    relay.mux.onclose = (why) => {
      muxClosed = why;
    };
    const a = await req('remote.status');
    const id = a.devices[0].id;
    expect((await anywhere()).sessions.map((s: { deviceId: string }) => s.deviceId)).toEqual([id, id]);
    const t0 = Date.now();
    await req('remote.devices.revoke', { id });
    await until(() => direct.closedAt > 0 && slow.closedAt > 0, 'the tunneled WebSockets to close after revoke', 2000);
    expect(direct.closedAt - t0).toBeLessThan(2000);
    expect(slow.closedAt - t0).toBeLessThan(2000);
    expect(muxClosed).not.toBe('');
    expect((await anywhere()).sessions).toEqual([]);
    const err = await dial({ brokers: phone, room: await deviceRoom(token), stun: [], rtc, helloTimeoutMs: 2000 }).then(
      (r) => {
        r.link.close();
        return null;
      },
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(DialError);
    expect((err as DialError).code).toBe('pc-silent');
  });

  it('a second pairing code replaces the first one\'s pairing room', async () => {
    const secret = (url: string) => unb64u(JSON.parse(dec.decode(unb64u(new URL(url).hash.slice(3)))).ps);
    const first = await req('remote.pairCode');
    const second = await req('remote.pairCode');
    const old = await dial({ brokers: phone, room: await pairRoom(secret(first.anywhereUrl)), stun: [], rtc, helloTimeoutMs: 2000 }).then(
      (r) => {
        r.link.close();
        return null;
      },
      (x: unknown) => x,
    );
    expect((old as DialError).code).toBe('pc-silent');
    const now = await dialRoom(await pairRoom(secret(second.anywhereUrl)));
    expect((await now.mux.request({ method: 'GET', path: '/api/health' })).status).toBe(403);
    now.mux.close();
  });

  it('remote.set turns 在外面也能用 and keep-awake off and on without restarting the listener', async () => {
    const before = await req('remote.status');
    const off = await req('remote.set', { anywhere: false, keepAwake: false });
    expect(off.port).toBe(before.port);
    expect(off.running).toBe(true);
    expect(off.anywhere).toEqual(expect.objectContaining({ on: false, brokers: [], sessions: [], keepAwake: false }));
    expect((await req('remote.pairCode')).anywhereUrl).toBeNull();
    const on = await req('remote.set', { anywhere: true, keepAwake: true });
    expect(on.anywhere.on).toBe(true);
    expect(on.anywhere.keepAwake).toBe(true);
    let a: any;
    const t0 = Date.now();
    do {
      a = await anywhere();
      if (a.brokers[0]?.ok) break;
      await sleep(50);
    } while (Date.now() - t0 < 10_000);
    expect(a.brokers).toEqual([{ name: 'mock', ok: true }]);
    expect(typeof (await req('remote.pairCode')).anywhereUrl).toBe('string');
  });

  it('a link that ends on a protocol error is recorded as a version mismatch', async () => {
    const { linkError } = await import('./service.js');
    expect(linkError('protocol: unknown kind 9')).toMatch(/^手机上的页面和电脑上的 Claude Web 版本不一致.*（protocol: unknown kind 9）$/);
    expect(linkError('the other side closed the link')).toBeUndefined();
  });

  it('settings: broker and STUN lists are validated; without one the defaults, none of them under CW_NO_PUBLIC_BROKERS', async () => {
    const { brokerDefs, stunList, shellUrlOf, DEFAULT_SHELL_URL } = await import('./service.js');
    const { DEFAULT_BROKERS, DEFAULT_STUN } = await import('./core/index.js');
    expect(brokerDefs(undefined, {})).toEqual(DEFAULT_BROKERS);
    expect(brokerDefs(undefined, { CW_NO_PUBLIC_BROKERS: '1' })).toEqual([]);
    expect(brokerDefs([{ name: 'a', url: 'wss://a/mqtt', relay: true, username: 'u', password: 'p' }, { name: '', url: 'wss://b' }, { name: 'c', url: 'http://c' }, 7], {})).toEqual([
      { name: 'a', url: 'wss://a/mqtt', relay: true, username: 'u', password: 'p' },
    ]);
    expect(stunList(undefined)).toEqual(DEFAULT_STUN);
    expect(stunList(['stun:a:3478', 'nope', 5])).toEqual(['stun:a:3478']);
    expect(shellUrlOf(undefined)).toBe(DEFAULT_SHELL_URL);
    expect(shellUrlOf('https://me.example/shell/#old')).toBe('https://me.example/shell/');
    expect(shellUrlOf('javascript:alert(1)')).toBe(DEFAULT_SHELL_URL);
  });

  it('the diagnostics bundle masks tokenHash (the device rooms are derived from it)', () => {
    const out = maskSecrets('{"tokenHash":"abcdef1234"}');
    expect(out).not.toContain('abcdef1234');
    expect(out).toContain('"tokenHash"');
  });
});
