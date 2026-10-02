// serveBridge against a stand-in for the remote-access listener (http + ws on 127.0.0.1), with the phone's Mux on the
// other end of an in-memory link.
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { PAIRING_ONLY, RELAY_MAX_HELD, RELAY_MAX_RESPONSE_BYTES, RELAY_REFUSED, RELAY_TOO_LARGE, serveBridge, type BridgeOptions } from './bridge.js';
import { F, MUX_PAUSE_BYTES, Mux, decodeFrame, encodeFrame, type Link, type LinkKind, type MuxWs } from './core/index.js';

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

/**
 * One end of an in-memory link: frames go over a tick later, buffered() is what is still on the way. stall() holds
 * what is sent until release(). `sent` is every frame handed to send(), `got` every frame delivered to this end.
 */
class MemLink implements Link {
  onframe: (f: Uint8Array) => void = () => {};
  onclose: (why: string) => void = () => {};
  peer!: MemLink;
  inflight = 0;
  maxInflight = 0;
  ended = false;
  sent: Uint8Array[] = [];
  got: Uint8Array[] = [];
  private stalled: (() => void)[] | null = null;
  constructor(public kind: LinkKind) {}
  send(f: Uint8Array): void {
    if (this.ended) return;
    if (f.length > 1_048_576) throw new RangeError('frame over 1 MiB');
    const c = f.slice();
    this.sent.push(c);
    this.inflight += c.length;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    const go = () =>
      setImmediate(() => {
        this.inflight -= c.length;
        if (this.ended || this.peer.ended) return;
        this.peer.got.push(c);
        this.peer.onframe(c);
      });
    if (this.stalled) this.stalled.push(go);
    else go();
  }
  stall(): void {
    this.stalled ??= [];
  }
  release(): void {
    const q = this.stalled ?? [];
    this.stalled = null;
    for (const go of q) go();
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

/**
 * Stands in for the remote-access listener: /ws (token "good" echoes, and answers "flood" with 30 × 100 KB; token
 * "slow" is upgraded 300 ms late), /echo, /big?n=&cl=1&slow=1, anything else "ok <method> <path>".
 */
async function listener() {
  const seen = { upgrades: 0, open: 0, closed: 0, aborted: 0, flooded: 0, paths: [] as string[], headers: [] as http.IncomingHttpHeaders[] };
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
    if (url.pathname === '/stall') {
      // a few bytes, then nothing more, ever (the test closes the connection)
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      return;
    }
    if (url.pathname === '/big') {
      const n = Number(url.searchParams.get('n'));
      const body = Buffer.alloc(n);
      for (let i = 0; i < n; i++) body[i] = i & 0xff;
      res.writeHead(200, url.searchParams.get('cl') ? { 'content-length': String(n) } : {});
      if (url.searchParams.get('slow')) {
        // 100 KB every 10 ms, so that several responses are in flight at once
        let i = 0;
        const step = () => {
          if (i >= n) return res.end();
          res.write(body.subarray(i, i + 100_000));
          i += 100_000;
          setTimeout(step, 10);
        };
        return step();
      }
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
    const token = url.searchParams.get('token');
    if (url.pathname !== '/ws' || (token !== 'good' && token !== 'slow') || req.headers.origin) return socket.destroy();
    let upgraded = false;
    socket.once('close', () => {
      if (!upgraded) seen.aborted++;
    });
    const upgrade = () => {
      if (socket.destroyed) return;
      // handleUpgrade destroys a socket the client already left, and then never calls back
      wss.handleUpgrade(req, socket, head, (ws) => {
        upgraded = true;
        seen.open++;
        ws.on('message', (data, isBinary) => {
          if (String(data) !== 'flood') return ws.send(data, { binary: isBinary });
          for (let i = 0; i < 30; i++) ws.send('x'.repeat(100_000), () => seen.flooded++);
        });
        ws.on('close', () => seen.closed++);
      });
    };
    if (token === 'slow') setTimeout(upgrade, 300);
    else upgrade();
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

  it('a phone close before the ack ends the local socket still connecting; the stream id is free again', async () => {
    const s = await setup('p2p-v4');
    const [phone, pc] = linkPair('p2p-v4');
    serveBridge(pc, { port: s.port, relay: false });
    cleanup.push(() => phone.close());
    phone.send(encodeFrame(F.WS_OPEN, 5, 'slow'));
    // the listener has the upgrade request and takes its time: the phone gives up meanwhile
    await until(() => s.seen.upgrades === 1, 'the upgrade request');
    phone.send(encodeFrame(F.WS_CLOSE, 5));
    // gone either before the late upgrade, or right after it (its first write meets a closed connection)
    await until(() => s.seen.aborted + s.seen.closed === 1, 'the listener sees the socket go');
    await sleep(300);
    expect(s.seen.open).toBe(s.seen.closed);
    // nothing came back for stream 5: no ack, no hub message
    expect(phone.got).toEqual([]);
    // the bridge holds nothing for 5 any more: the same id opens anew
    phone.send(encodeFrame(F.WS_OPEN, 5, 'good'));
    await until(() => phone.got.length === 1, 'the ack');
    expect(decodeFrame(phone.got[0])).toEqual(expect.objectContaining({ type: F.WS_OPEN, stream: 5 }));
  });

  it('a phone close drops what the hub sent that is still queued for the stream', async () => {
    const s = await setup('p2p-v4');
    const e = open(s.mux, 'good');
    await until(() => e.open, 'open');
    const id = decodeFrame(s.phone.sent[0]).stream;
    // the PC's side of the link stops delivering: what the bridge sends piles up (1 MiB on the link, the rest queued)
    s.pc.stall();
    e.ws.send('flood');
    await until(() => s.seen.flooded > 10, 'the hub sends');
    await sleep(200);
    const handed = s.pc.sent.filter((f) => decodeFrame(f).stream === id).length;
    expect(handed * 16_389).toBeLessThan(30 * 100_000);
    e.ws.close();
    await until(() => s.seen.closed === 1, 'the local socket closed');
    s.pc.release();
    await sleep(300);
    // only what was on the link already arrives; nothing queued in the outbox follows the close
    expect(s.pc.sent.filter((f) => decodeFrame(f).stream === id).length).toBe(handed);
    expect(s.phone.got.filter((f) => decodeFrame(f).stream === id).length).toBe(handed);
  });

  it(`over the relay at most ${RELAY_MAX_HELD} responses are held at once; the others wait, untouched by a busy WebSocket on the link, and arrive whole`, async () => {
    let held = 0;
    let most = 0;
    const s = await setup('relay', {
      onHeld: (n) => {
        held = n;
        most = Math.max(most, n);
      },
    });
    const e = open(s.mux, 'good');
    await until(() => e.open, 'open');
    // the link to the phone stalls: the hub's flood backs the outbox up (busy now, ondrain once it moves again, which
    // resumes the streams that paused; the two waiting for a turn must not be among them)
    s.pc.stall();
    e.ws.send('flood');
    const n = 1_000_000;
    const pending = Promise.all(Array.from({ length: 6 }, () => s.mux.request({ method: 'GET', path: `/big?n=${n}&slow=1` })));
    await until(() => s.seen.paths.filter((p) => p.startsWith('GET /big')).length === 6 && most === RELAY_MAX_HELD, 'six requests, four turns');
    // the four with a turn are read whole meanwhile (1 MB at 100 KB / 10 ms); the other two wait, unread
    await sleep(400);
    expect(held).toBe(RELAY_MAX_HELD);
    s.pc.release();
    const all = await pending;
    for (const r of all) {
      expect(r.status).toBe(200);
      expect(r.body.length).toBe(n);
      expect(r.body.every((b, i) => b === (i & 0xff))).toBe(true);
    }
    expect(most).toBe(RELAY_MAX_HELD);
    await until(() => held === 0, 'every turn given back');
    await until(() => e.got.length === 30, 'the flood arrives too', 10_000);
    expect(e.got.every((m) => m.length === 100_000)).toBe(true);
  });

  it('a reused stream id cannot cost the link a turn: pieces dropped from the outbox still give theirs back', async () => {
    let held = 0;
    const l = await listener();
    // a raw phone end (no Mux), so that one id can be used twice
    const [phone, pc] = linkPair('relay');
    serveBridge(pc, { port: l.port, relay: true, onHeld: (n) => (held = n) });
    cleanup.push(() => phone.close());
    pc.stall();
    const head = JSON.stringify({ method: 'GET', path: `/big?n=${RELAY_MAX_RESPONSE_BYTES}`, headers: {} });
    phone.send(encodeFrame(F.HTTP_REQ, 7, head));
    phone.send(encodeFrame(F.END, 7));
    // read whole and handed over: about 1 MiB on the stalled link, the rest still in the outbox, the turn still held
    await until(() => pc.sent.some((f) => decodeFrame(f).type === F.HTTP_RES), 'the response head');
    await sleep(100);
    expect(held).toBe(1);
    expect(pc.sent.filter((f) => decodeFrame(f).type === F.END)).toEqual([]);
    // the stream is over on the bridge's side; the same id again, as a WebSocket closed at once: its drop discards
    // the old body's remaining pieces
    phone.send(encodeFrame(F.WS_OPEN, 7, 'good'));
    phone.send(encodeFrame(F.WS_CLOSE, 7));
    await until(() => held === 0, 'the turn given back');
    pc.release();
    // every turn is free: four slow responses are held at once and all arrive
    const mux = new Mux(phone);
    let most = 0;
    const watch = setInterval(() => (most = Math.max(most, held)), 5);
    cleanup.push(() => clearInterval(watch));
    const all = await Promise.all(Array.from({ length: RELAY_MAX_HELD }, () => mux.request({ method: 'GET', path: '/big?n=500000&slow=1' })));
    expect(all.every((r) => r.status === 200 && r.body.length === 500_000)).toBe(true);
    expect(most).toBe(RELAY_MAX_HELD);
    await until(() => held === 0, 'all turns given back');
  });

  it('a held relay response that makes no progress fails after heldIdleMs and frees its turn for the next', async () => {
    let held = 0;
    const s = await setup('relay', { heldIdleMs: 300, onHeld: (n) => (held = n) });
    // the next request takes the turn the first failed stall gives back, so it may finish before the others fail
    let firstFailedAt = 0;
    const stalls = Array.from({ length: RELAY_MAX_HELD }, () =>
      s.mux.request({ method: 'GET', path: '/stall' }).then(
        () => 'answered',
        (e: Error) => {
          firstFailedAt ||= Date.now();
          return e.message;
        },
      ),
    );
    await until(() => held === RELAY_MAX_HELD, 'every turn taken by a stalled response');
    let doneAt = 0;
    const next = s.mux.request({ method: 'GET', path: '/big?n=1000' }).then((r) => {
      doneAt = Date.now();
      return r;
    });
    const why = await Promise.all(stalls);
    expect(why).toEqual(Array(RELAY_MAX_HELD).fill('no data from the listener for 300 ms'));
    const r = await next;
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(1000);
    // it had to wait for a turn the stalled ones gave back
    expect(doneAt).toBeGreaterThanOrEqual(firstFailedAt);
    await until(() => held === 0, 'turns given back');
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
