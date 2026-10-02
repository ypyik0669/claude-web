// serveBridge against a stand-in for the remote-access listener (http + ws on 127.0.0.1), with the phone's Mux on the
// other end of an in-memory link.
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { PAIRING_ONLY, RELAY_MAX_RESPONSE_BYTES, RELAY_REFUSED, RELAY_TOO_LARGE, serveBridge, type BridgeOptions } from './bridge.js';
import { MUX_PAUSE_BYTES, Mux, type Link, type LinkKind, type MuxWs } from './core/index.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dec = new TextDecoder();
const enc = new TextEncoder();

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** One end of an in-memory link: frames go over a tick later, buffered() is what is still on the way. */
class MemLink implements Link {
  onframe: (f: Uint8Array) => void = () => {};
  onclose: (why: string) => void = () => {};
  peer!: MemLink;
  inflight = 0;
  maxInflight = 0;
  ended = false;
  constructor(public kind: LinkKind) {}
  send(f: Uint8Array): void {
    if (this.ended) return;
    if (f.length > 1_048_576) throw new RangeError('frame over 1 MiB');
    const c = f.slice();
    this.inflight += c.length;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    setImmediate(() => {
      this.inflight -= c.length;
      if (!this.ended && !this.peer.ended) this.peer.onframe(c);
    });
  }
  buffered(): number {
    return this.ended ? 0 : this.inflight;
  }
  close(): void {
    if (this.ended) return;
    this.ended = true;
    const p = this.peer;
    setImmediate(() => {
      if (p.ended) return;
      p.ended = true;
      p.onclose('the other side closed the link');
    });
  }
}

function linkPair(kind: LinkKind): [MemLink, MemLink] {
  const a = new MemLink(kind);
  const b = new MemLink(kind);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Stands in for the remote-access listener: /ws (token "good", echoes), /echo, /big?n=&cl=1, /api/file, /api/pair. */
async function listener() {
  const seen = { upgrades: 0, open: 0, closed: 0, paths: [] as string[], headers: [] as http.IncomingHttpHeaders[] };
  const srv = http.createServer((req, res) => {
    seen.paths.push(`${req.method} ${req.url}`);
    seen.headers.push(req.headers);
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/echo') {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'set-cookie': 'a=b' });
        res.end(Buffer.concat(parts));
      });
      return;
    }
    if (url.pathname === '/big') {
      const n = Number(url.searchParams.get('n'));
      const body = Buffer.alloc(n);
      for (let i = 0; i < n; i++) body[i] = i & 0xff;
      res.writeHead(200, url.searchParams.get('cl') ? { 'content-length': String(n) } : {});
      // in several writes, no content-length: chunked
      for (let i = 0; i < n; i += 65_536) res.write(body.subarray(i, i + 65_536));
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok ${req.method} ${url.pathname}`);
  });
  const wss = new WebSocketServer({ noServer: true });
  srv.on('upgrade', (req, socket, head) => {
    seen.upgrades++;
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== 'good' || req.headers.origin) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      seen.open++;
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
      ws.on('close', () => seen.closed++);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  );
  return { port, seen };
}

async function setup(kind: LinkKind, opts: Partial<BridgeOptions> = {}) {
  const l = await listener();
  const [phone, pc] = linkPair(kind);
  const ends: string[] = [];
  const stop = serveBridge(pc, { port: l.port, relay: kind === 'relay', onclose: (w) => ends.push(w), ...opts });
  const mux = new Mux(phone);
  cleanup.push(() => mux.close());
  return { ...l, phone, pc, mux, stop, ends };
}

function open(mux: Mux, token: string) {
  const ws: MuxWs = mux.openWs(token);
  const e = { ws, got: [] as string[], open: false, closed: false };
  ws.onopen = () => (e.open = true);
  ws.onmessage = (t) => e.got.push(t);
  ws.onclose = () => (e.closed = true);
  return e;
}

describe('serveBridge', () => {
  it('a WebSocket to the listener without Origin; messages far over one piece come back whole', async () => {
    const s = await setup('p2p-v4');
    const e = open(s.mux, 'good');
    await until(() => e.open, 'open');
    expect(s.seen.open).toBe(1);
    const long = '中文 messages '.repeat(30_000);
    e.ws.send(long);
    e.ws.send('');
    e.ws.send('short');
    await until(() => e.got.length === 3, 'three echoes');
    expect(e.got).toEqual([long, '', 'short']);
    e.ws.close();
    await until(() => s.seen.closed === 1, 'the listener sees the close');
  });

  it('a token the listener refuses: closed, never open; one tokenOk refuses is not even tried', async () => {
    const s = await setup('p2p-v4', { tokenOk: (t) => t !== 'other-device' });
    const bad = open(s.mux, 'bad');
    await until(() => bad.closed, 'refused by the listener');
    expect(bad.open).toBe(false);
    expect(s.seen.upgrades).toBe(1);
    const other = open(s.mux, 'other-device');
    await until(() => other.closed, 'refused by tokenOk');
    expect(s.seen.upgrades).toBe(1);
  });

  it('HTTP: method, path, headers and body through; hop-by-hop and set-cookie stay out', async () => {
    const s = await setup('p2p-v4');
    const body = new Uint8Array(100_000);
    for (let i = 0; i < body.length; i++) body[i] = (i * 7) & 0xff;
    const res = await s.mux.request({ method: 'post', path: '/echo?x=1', headers: { 'X-A': '1', Origin: 'https://evil', Connection: 'close' }, body });
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(Buffer.from(body))).toBe(true);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(s.seen.paths).toEqual(['POST /echo?x=1']);
    expect(s.seen.headers[0]['x-a']).toBe('1');
    expect(s.seen.headers[0].origin).toBeUndefined();
    expect(s.seen.headers[0]['content-length']).toBe(String(body.length));
  });

  it('a big response is paced: the link never holds much more than the pause mark', async () => {
    const s = await setup('p2p-v4');
    const n = 6_000_000;
    const res = await s.mux.request({ method: 'GET', path: `/big?n=${n}` });
    expect(res.body.length).toBe(n);
    expect(res.body.every((b, i) => b === (i & 0xff))).toBe(true);
    expect(s.pc.maxInflight).toBeLessThan(MUX_PAUSE_BYTES + 128 * 1024);
  });

  it('a pairing link: only POST /api/pair; anything else 403, a WebSocket refused', async () => {
    const s = await setup('p2p-v4', { pairing: true });
    const get = await s.mux.request({ method: 'GET', path: '/' });
    expect(get.status).toBe(403);
    expect(dec.decode(get.body)).toBe(PAIRING_ONLY);
    expect((await s.mux.request({ method: 'GET', path: '/api/pair' })).status).toBe(403);
    const pair = await s.mux.request({ method: 'POST', path: '/api/pair', body: enc.encode('{}') });
    expect(pair.status).toBe(200);
    expect(dec.decode(pair.body)).toBe('ok POST /api/pair');
    const e = open(s.mux, 'good');
    await until(() => e.closed, 'refused');
    expect(e.open).toBe(false);
    expect(s.seen.upgrades).toBe(0);
    expect(s.seen.paths).toEqual(['POST /api/pair']);
  });

  it('over the relay: previews and uploads refused with their sentence, responses over 2 MB refused', async () => {
    const s = await setup('relay');
    for (const path of ['/api/file?path=x', '/api/attachments?sessionId=a&rel=b']) {
      const r = await s.mux.request({ method: path.includes('attach') ? 'POST' : 'GET', path, body: path.includes('attach') ? enc.encode('x') : undefined });
      expect(r.status).toBe(413);
      expect(dec.decode(r.body)).toBe(RELAY_REFUSED);
    }
    for (const q of ['', '&cl=1']) {
      const over = await s.mux.request({ method: 'GET', path: `/big?n=${RELAY_MAX_RESPONSE_BYTES + 1}${q}` });
      expect(over.status).toBe(413);
      expect(dec.decode(over.body)).toBe(RELAY_TOO_LARGE);
    }
    const at = await s.mux.request({ method: 'GET', path: `/big?n=${RELAY_MAX_RESPONSE_BYTES}` });
    expect(at.status).toBe(200);
    expect(at.body.length).toBe(RELAY_MAX_RESPONSE_BYTES);
    expect(s.seen.paths.some((p) => p.includes('/api/'))).toBe(false);
  });

  it('a request that cannot reach the listener rejects with why; a path for another host is refused', async () => {
    const s = await setup('p2p-v4');
    const dead = await new Promise<number>((r) => {
      const t = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (t.address() as net.AddressInfo).port;
        t.close(() => r(p));
      });
    });
    const [phone, pc] = linkPair('p2p-v4');
    serveBridge(pc, { port: dead, relay: false });
    const mux = new Mux(phone);
    cleanup.push(() => mux.close());
    await expect(mux.request({ method: 'GET', path: '/x' })).rejects.toThrow(/ECONNREFUSED/);
    await expect(s.mux.request({ method: 'GET', path: '//evil.example/x' })).rejects.toThrow(/cannot be read/);
    expect(s.seen.paths).toEqual([]);
  });

  it('the link ending closes the local WebSockets; stop() closes the link and them, without onclose', async () => {
    const a = await setup('p2p-v4');
    const e = open(a.mux, 'good');
    await until(() => e.open, 'open');
    a.mux.close();
    await until(() => a.seen.closed === 1, 'the listener sees the WebSocket go');
    expect(a.ends).toEqual(['the other side closed the link']);

    const b = await setup('relay');
    const f = open(b.mux, 'good');
    await until(() => f.open, 'open');
    let muxEnd = '';
    b.mux.onclose = (w) => (muxEnd = w);
    b.stop();
    await until(() => f.closed && b.seen.closed === 1, 'both sides closed');
    expect(muxEnd).toBe('the other side closed the link');
    expect(b.ends).toEqual([]);
  });

  it('answers PING with PONG', async () => {
    const s = await setup('p2p-v4');
    const got: Uint8Array[] = [];
    const [phone, pc] = linkPair('p2p-v4');
    serveBridge(pc, { port: s.port, relay: false });
    phone.onframe = (f) => got.push(f);
    phone.send(new Uint8Array([0x30, 0, 0, 0, 0, 1, 2, 3]));
    await until(() => got.length === 1, 'pong');
    expect([...got[0]]).toEqual([0x31, 0, 0, 0, 0, 1, 2, 3]);
    phone.close();
  });
});
