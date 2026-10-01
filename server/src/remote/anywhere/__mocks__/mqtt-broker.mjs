// Minimal MQTT 3.1.1 broker over WebSocket, for tests only (unit tests and e2e scripts import it directly).
// QoS 0, exact-topic subscriptions; no retained messages, wills or sessions. Plain JS so it runs without a build.
import { WebSocketServer } from 'ws';

const enc = new TextEncoder();
const dec = new TextDecoder();

function remLen(n) {
  const out = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    out.push(d);
  } while (n > 0);
  return out;
}

function packet(first, ...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const head = [first, ...remLen(n)];
  const out = new Uint8Array(head.length + n);
  out.set(head);
  let o = head.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u16(n) {
  return new Uint8Array([(n >> 8) & 255, n & 255]);
}

function str(s) {
  const b = enc.encode(s);
  const out = new Uint8Array(2 + b.length);
  out.set(u16(b.length));
  out.set(b, 2);
  return out;
}

/** Reads length-prefixed fields out of one packet body. */
class Fields {
  constructor(body) {
    this.b = body;
    this.o = 0;
  }
  u8() {
    if (this.o >= this.b.length) throw new Error('packet too short');
    return this.b[this.o++];
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  bytes() {
    const n = this.u16();
    if (this.o + n > this.b.length) throw new Error('field runs past the packet');
    const v = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return v;
  }
  str() {
    return dec.decode(this.bytes());
  }
  rest() {
    return this.b.subarray(this.o);
  }
  get left() {
    return this.b.length - this.o;
  }
}

/**
 * @param {{
 *   port?: number,            // 0 = pick one; pass a previous broker's port to restart it under the same url
 *   dropEvery?: number,       // drop every n-th forwarded message (counted over all deliveries)
 *   frameBytes?: number,      // split everything this broker sends into WS messages of at most n bytes
 *   auth?: { username: string, password: string },  // require these credentials (CONNACK 4 otherwise)
 *   denyTopics?: string[],    // SUBACK 0x80 for these topics
 *   ignorePing?: boolean,     // never answer PINGREQ (a half-dead broker)
 *   silent?: boolean,         // accept the WebSocket but never answer CONNECT
 * }} [opts]
 */
export async function startBroker(opts = {}) {
  const { port = 0, dropEvery = 0, frameBytes = 0, auth, denyTopics = [], ignorePing = false, silent = false } = opts;
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    // MQTT over WebSockets requires the `mqtt` subprotocol; refusing without it makes the tests check the client sends it
    handleProtocols: (protocols) => (protocols.has('mqtt') ? 'mqtt' : false),
  });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const conns = new Set();
  let published = 0;
  let forwarded = 0;

  function send(c, bytes) {
    if (c.ws.readyState !== 1) return;
    if (frameBytes > 0) {
      for (let i = 0; i < bytes.length; i += frameBytes) c.ws.send(bytes.subarray(i, i + frameBytes));
    } else {
      c.ws.send(bytes);
    }
  }

  function handle(c, first, body) {
    const type = first >> 4;
    const f = new Fields(body);
    if (!c.connected && type !== 1) throw new Error('first packet must be CONNECT');
    switch (type) {
      case 1: {
        if (c.connected) throw new Error('second CONNECT');
        const proto = f.str();
        const level = f.u8();
        const flags = f.u8();
        const keepalive = f.u16();
        const clientId = f.str();
        const username = flags & 0x80 ? f.str() : undefined;
        const password = flags & 0x40 ? f.str() : undefined;
        broker.connects.push({ proto, level, flags, keepalive, clientId, username, password });
        if (silent) return;
        let rc = 0;
        if (proto !== 'MQTT' || level !== 4) rc = 1;
        else if (auth && (username !== auth.username || password !== auth.password)) rc = 4;
        send(c, new Uint8Array([0x20, 2, 0, rc]));
        if (rc !== 0) c.ws.close();
        else c.connected = true;
        return;
      }
      case 3: {
        const qos = (first >> 1) & 3;
        const topic = f.str();
        if (qos > 0) f.u16();
        const payload = f.rest();
        published++;
        const out = packet(0x30, str(topic), payload);
        for (const other of conns) {
          if (!other.subs.has(topic)) continue;
          forwarded++;
          if (dropEvery > 0 && forwarded % dropEvery === 0) continue;
          send(other, out);
        }
        return;
      }
      case 8: {
        if (first !== 0x82) throw new Error('SUBSCRIBE flags must be 0x2');
        const id = f.u16();
        broker.packetIds.push(id);
        const codes = [];
        while (f.left > 0) {
          const topic = f.str();
          f.u8();
          if (denyTopics.includes(topic)) codes.push(0x80);
          else {
            c.subs.add(topic);
            codes.push(0);
          }
        }
        send(c, packet(0x90, u16(id), new Uint8Array(codes)));
        return;
      }
      case 10: {
        if (first !== 0xa2) throw new Error('UNSUBSCRIBE flags must be 0x2');
        const id = f.u16();
        broker.packetIds.push(id);
        while (f.left > 0) c.subs.delete(f.str());
        send(c, packet(0xb0, u16(id)));
        return;
      }
      case 12:
        broker.pings++;
        if (!ignorePing) send(c, new Uint8Array([0xd0, 0]));
        return;
      case 14:
        c.ws.close();
        return;
      default:
        throw new Error(`unexpected packet type ${type}`);
    }
  }

  function feed(c, chunk) {
    c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
    for (;;) {
      if (c.buf.length < 2) return;
      let len = 0;
      let mult = 1;
      let i = 1;
      let byte;
      do {
        if (i > 4) throw new Error('remaining length longer than 4 bytes');
        if (i >= c.buf.length) return;
        byte = c.buf[i++];
        len += (byte & 127) * mult;
        mult *= 128;
      } while (byte & 128);
      if (c.buf.length < i + len) return;
      const first = c.buf[0];
      const body = c.buf.subarray(i, i + len);
      c.buf = c.buf.subarray(i + len);
      handle(c, first, body);
    }
  }

  wss.on('connection', (ws) => {
    if (ws.protocol !== 'mqtt') {
      ws.close(1002, 'mqtt subprotocol required');
      return;
    }
    const c = { ws, subs: new Set(), connected: false, buf: Buffer.alloc(0) };
    conns.add(c);
    ws.on('close', () => conns.delete(c));
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      try {
        if (!isBinary) throw new Error('text frame');
        feed(c, Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
      } catch {
        ws.terminate();
      }
    });
  });

  const broker = {
    url: `ws://127.0.0.1:${wss.address().port}/mqtt`,
    port: wss.address().port,
    /** PUBLISH packets received from clients. */
    get published() {
      return published;
    },
    /** Clients past CONNACK. */
    get clients() {
      let n = 0;
      for (const c of conns) if (c.connected) n++;
      return n;
    },
    /** Every CONNECT seen: { proto, level, flags, keepalive, clientId, username, password }. */
    connects: [],
    /** Packet ids of every SUBSCRIBE / UNSUBSCRIBE seen. */
    packetIds: [],
    pings: 0,
    /** Sends raw bytes to every client as one WS message (glued, split or malformed packets). */
    sendRaw(bytes) {
      for (const c of conns) if (c.ws.readyState === 1) c.ws.send(bytes);
    },
    /** Drops every client the hard way (no close frame), like a broker going down, then stops listening. */
    close() {
      for (const c of conns) c.ws.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
  return broker;
}
