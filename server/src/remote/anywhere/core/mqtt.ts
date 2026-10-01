// Minimal MQTT 3.1.1 client over WebSocket (QoS 0 only), and a pool that talks to several public brokers at
// once; signaling and the slow relay ride on it. Shared by the Node server and the phone shell, so Web-standard
// APIs only (no node:*, no Buffer). Brokers are public and anyone can publish to them: everything that comes in
// is untrusted, a malformed or oversized packet drops that connection and never throws out of a handler.

export interface BrokerDef {
  name: string;
  url: string;
  username?: string;
  password?: string;
  /** Also carries the slow relay (the brokers that rate-limit signaling-sized traffic are not used for it). */
  relay?: boolean;
}

/**
 * The slice of the WebSocket API used here. Node 22's global (undici), the browser's and the `ws` package's all
 * fit; declared locally because the server typecheck has no DOM lib. Handler events are `any` so that each of
 * those constructors can be passed as `WebSocket` without a cast (their event types differ).
 */
export interface WsLike {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
}

export type WsCtor = new (url: string, protocols?: string | string[]) => WsLike;

export interface MqttOptions {
  /** Defaults to `globalThis.WebSocket`, looked up when connecting; the server may pass one that uses its proxy. */
  WebSocket?: WsCtor;
  /** PINGREQ interval (30 s). A connection over which nothing at all arrived between two pings counts as dead. */
  pingMs?: number;
}

const KEEPALIVE_S = 60;
const PING_MS = 30_000;
const SUBACK_TIMEOUT_MS = 10_000;
/** The most a 4-byte remaining length can say (MQTT 2.2.3). */
const PROTOCOL_MAX_REMAINING = 268_435_455;
/**
 * Our cap on one incoming packet's remaining length (the packet minus its 2..5-byte fixed header), checked on
 * the header alone, before any of the body is buffered.
 */
export const MAX_REMAINING_BYTES = 1_048_576;
/** Past this much unsent data publish() refuses: the relay retransmits later instead of queueing without bound. */
const MAX_BUFFERED = 1_048_576;
const OPEN = 1;

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const SUBSCRIBE = 8;
const SUBACK = 9;
const UNSUBSCRIBE = 10;
const PINGREQ = 12;
const DISCONNECT = 14;

const enc = new TextEncoder();
// topics must be valid UTF-8 (MQTT 1.5.3); a broker sending anything else is broken and gets dropped
const strictDec = new TextDecoder('utf-8', { fatal: true });

class ProtocolError extends Error {}

export function encodeRemainingLength(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > PROTOCOL_MAX_REMAINING) throw new Error(`remaining length out of range: ${n}`);
  const out: number[] = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    out.push(d);
  } while (n > 0);
  return out;
}

function utf8(s: string): Uint8Array {
  const b = enc.encode(s);
  if (b.length > 0xffff) throw new Error('MQTT string longer than 65535 bytes');
  return b;
}

/** Fixed header + body parts, written once into a fresh buffer. Strings become u16-length-prefixed UTF-8. */
function encodePacket(first: number, parts: (Uint8Array | string | number[])[]): Uint8Array<ArrayBuffer> {
  const bufs: Uint8Array[] = [];
  let n = 0;
  for (const p of parts) {
    if (typeof p === 'string') {
      const b = utf8(p);
      bufs.push(new Uint8Array([b.length >> 8, b.length & 0xff]), b);
      n += 2 + b.length;
    } else {
      const b = p instanceof Uint8Array ? p : new Uint8Array(p);
      bufs.push(b);
      n += b.length;
    }
  }
  const head = [first, ...encodeRemainingLength(n)];
  const out = new Uint8Array(head.length + n);
  out.set(head);
  let o = head.length;
  for (const b of bufs) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function encodeConnect(clientId: string, def: BrokerDef): Uint8Array<ArrayBuffer> {
  let flags = 0x02; // clean session: nothing is kept between connections, we resubscribe instead
  const tail: string[] = [clientId];
  // 3.1.1 forbids a password without a username
  if (def.username !== undefined) {
    flags |= 0x80;
    tail.push(def.username);
    if (def.password !== undefined) {
      flags |= 0x40;
      tail.push(def.password);
    }
  }
  return encodePacket(CONNECT << 4, ['MQTT', [4, flags, ...u16(KEEPALIVE_S)], ...tail]);
}

/** QoS 0 PUBLISH; the same bytes a broker sends to subscribers. */
export function encodePublish(topic: string, payload: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return encodePacket(PUBLISH << 4, [topic, typeof payload === 'string' ? enc.encode(payload) : payload]);
}

/** Next packet id after `prev`: 1..65535 (0 is not a valid id), skipping ids still waiting for their ack. */
export function nextPacketId(prev: number, inUse: (id: number) => boolean): number {
  let id = prev;
  for (let i = 0; i < 0xffff; i++) {
    id = (id % 0xffff) + 1;
    if (!inUse(id)) return id;
  }
  throw new Error('no free MQTT packet id');
}

/**
 * Splits a byte stream into MQTT packets. WS messages and MQTT packets need not line up: one message may carry
 * several packets, or a piece of one. Throws on a malformed stream; after that the reader must be dropped.
 */
export class PacketReader {
  private buf = new Uint8Array(0);
  private start = 0;
  private end = 0;
  private stopped = false;

  constructor(private readonly max = MAX_REMAINING_BYTES) {}

  /** Calls `onPacket` for each complete packet; `body` is a view that is only valid during the call. */
  push(chunk: Uint8Array, onPacket: (first: number, body: Uint8Array) => void): void {
    if (this.stopped) return;
    if (this.start === this.end) {
      // common case, whole packets per message: parse in place, keep only an incomplete tail
      const used = this.scan(chunk, onPacket);
      if (!this.stopped && used < chunk.length) this.keep(chunk.subarray(used));
      return;
    }
    this.keep(chunk);
    const used = this.scan(this.buf.subarray(this.start, this.end), onPacket);
    if (this.stopped) return;
    this.start += used;
    if (this.start === this.end) {
      this.start = this.end = 0;
      // do not hold on to a 1 MiB buffer after one big packet
      if (this.buf.length > 65_536) this.buf = new Uint8Array(0);
    }
  }

  /** Stops for good (also from inside `onPacket`): the rest of the current chunk is not parsed. */
  stop(): void {
    this.stopped = true;
    this.buf = new Uint8Array(0);
    this.start = this.end = 0;
  }

  private scan(v: Uint8Array, onPacket: (first: number, body: Uint8Array) => void): number {
    let at = 0;
    while (!this.stopped && v.length - at >= 2) {
      let len = 0;
      let mul = 1;
      let i = at + 1;
      for (;;) {
        if (i - at > 4) throw new ProtocolError('remaining length longer than 4 bytes');
        if (i >= v.length) return at;
        const byte = v[i++];
        len += (byte & 0x7f) * mul;
        if (!(byte & 0x80)) break;
        mul *= 128;
      }
      if (len > this.max) throw new ProtocolError(`packet of ${len} bytes exceeds ${this.max}`);
      if (v.length - i < len) return at;
      const first = v[at];
      at = i + len;
      onPacket(first, v.subarray(i, at));
    }
    return at;
  }

  private keep(b: Uint8Array): void {
    const live = this.end - this.start;
    if (this.end + b.length > this.buf.length) {
      if (live + b.length <= this.buf.length) {
        this.buf.copyWithin(0, this.start, this.end);
      } else {
        const next = new Uint8Array(Math.max(live + b.length, this.buf.length * 2, 4096));
        next.set(this.buf.subarray(this.start, this.end));
        this.buf = next;
      }
      this.start = 0;
      this.end = live;
    }
    this.buf.set(b, this.end);
    this.end += b.length;
  }
}

/** '' when there is nothing to say (the browser's WebSocket error event carries no detail at all). */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    // undici's ErrorEvent has message / error
    const o = e as { message?: unknown; error?: unknown };
    if (typeof o.message === 'string' && o.message) return o.message;
    if (o.error instanceof Error) return o.error.message;
  }
  return '';
}

/** Bugs in callbacks must not tear down the stream, and must not escape into the WebSocket's event dispatch. */
function report(what: string, e: unknown): void {
  console.error(`[mqtt] ${what} threw`, e);
}

function randomClientId(): string {
  // 3.1.1 servers must accept 1..23 characters of [0-9a-zA-Z]
  const b = crypto.getRandomValues(new Uint8Array(10));
  return 'cw' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

interface SubWait {
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (e: Error) => void;
}

/** One connection to one broker, used once: after it closes, make a new one. */
export class MqttClient {
  /** Every PUBLISH that arrives; `payload` is the client's own copy. */
  onmessage: (topic: string, payload: Uint8Array) => void = () => {};
  /** The established connection was lost (not called after close(), nor for a failed connect()). */
  onclose: (reason?: string) => void = () => {};

  private state: 'new' | 'connecting' | 'open' | 'closed' = 'new';
  private ws: WsLike | null = null;
  private readonly reader = new PacketReader();
  private readonly subWait = new Map<number, SubWait>();
  private lastId = 0;
  private connectWait: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private heard = false;

  constructor(private readonly def: BrokerDef, private readonly opts: MqttOptions = {}) {}

  connect(timeoutMs = 10_000): Promise<void> {
    if (this.state !== 'new') return Promise.reject(new Error('connect() can only be called once'));
    this.state = 'connecting';
    return new Promise<void>((resolve, reject) => {
      this.connectWait = { resolve, reject };
      this.connectTimer = setTimeout(() => this.end(`no answer from the broker within ${timeoutMs} ms`), timeoutMs);
      const Ctor = this.opts.WebSocket ?? (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket;
      if (!Ctor) return this.end('WebSocket is not available');
      let ws: WsLike;
      try {
        ws = new Ctor(this.def.url, ['mqtt']);
      } catch (e) {
        return this.end(errText(e) || 'cannot open a WebSocket');
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => this.send(encodeConnect(randomClientId(), this.def));
      ws.onmessage = (ev: { data: unknown }) => this.onData(ev.data);
      ws.onerror = (ev: unknown) => this.end(errText(ev) || 'websocket error');
      ws.onclose = (ev: { code?: number } | undefined) => this.end(`connection closed (${ev?.code ?? 'no code'})`);
    });
  }

  /** Resolves on SUBACK; rejects if the broker refuses the topic, does not answer in 10 s, or the connection ends. */
  subscribe(topic: string): Promise<void> {
    if (this.state !== 'open') return Promise.reject(new Error('not connected'));
    return new Promise<void>((resolve, reject) => {
      let pkt: Uint8Array<ArrayBuffer>;
      const id = nextPacketId(this.lastId, (n) => this.subWait.has(n));
      try {
        pkt = encodePacket((SUBSCRIBE << 4) | 0x02, [u16(id), topic, [0]]);
      } catch (e) {
        return reject(e instanceof Error ? e : new Error(String(e)));
      }
      this.lastId = id;
      const timer = setTimeout(() => {
        this.subWait.delete(id);
        reject(new Error(`no SUBACK within ${SUBACK_TIMEOUT_MS} ms`));
      }, SUBACK_TIMEOUT_MS);
      this.subWait.set(id, { timer, resolve, reject });
      this.send(pkt);
    });
  }

  /** Fire and forget: the UNSUBACK is not waited for (packets on one connection are processed in order). */
  unsubscribe(topic: string): void {
    if (this.state !== 'open') return;
    const id = nextPacketId(this.lastId, (n) => this.subWait.has(n));
    let pkt: Uint8Array<ArrayBuffer>;
    try {
      pkt = encodePacket((UNSUBSCRIBE << 4) | 0x02, [u16(id), topic]);
    } catch {
      return; // a topic that cannot be encoded was never subscribed either
    }
    this.lastId = id;
    this.send(pkt);
  }

  /**
   * QoS 0: true means handed to the socket, not delivered. False when not connected, the socket is backed up,
   * or the packet cannot be encoded (topic over 65 535 bytes, packet over 256 MiB). Never throws.
   */
  publish(topic: string, payload: string | Uint8Array): boolean {
    const ws = this.ws;
    if (this.state !== 'open' || !ws || ws.readyState !== OPEN) return false;
    if ((ws.bufferedAmount ?? 0) > MAX_BUFFERED) return false;
    let pkt: Uint8Array<ArrayBuffer>;
    try {
      pkt = encodePublish(topic, payload);
    } catch {
      return false;
    }
    return this.send(pkt);
  }

  close(): void {
    if (this.state === 'open') {
      try {
        this.ws?.send(new Uint8Array([DISCONNECT << 4, 0]));
      } catch {
        // closing anyway
      }
    }
    this.end('closed', true);
  }

  private send(pkt: Uint8Array<ArrayBuffer>): boolean {
    try {
      this.ws!.send(pkt);
      return true;
    } catch (e) {
      this.end(errText(e) || 'send failed');
      return false;
    }
  }

  private onData(data: unknown): void {
    if (this.state === 'closed') return;
    this.heard = true;
    let chunk: Uint8Array;
    if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return this.end('broker sent a non-binary WebSocket message');
    try {
      this.reader.push(chunk, (first, body) => this.onPacket(first, body));
    } catch (e) {
      this.end(`malformed packet from the broker: ${errText(e)}`);
    }
  }

  private onPacket(first: number, body: Uint8Array): void {
    switch (first >> 4) {
      case CONNACK: {
        if (this.state !== 'connecting') return;
        if (body.length !== 2) throw new ProtocolError('CONNACK must be 2 bytes');
        const rc = body[1];
        if (rc !== 0) return this.end(`broker refused the connection (CONNACK return code ${rc})`);
        clearTimeout(this.connectTimer);
        this.state = 'open';
        this.heard = true;
        this.pingTimer = setInterval(() => this.ping(), this.opts.pingMs ?? PING_MS);
        const w = this.connectWait;
        this.connectWait = null;
        w?.resolve();
        return;
      }
      case PUBLISH: {
        if (this.state !== 'open') return;
        const qos = (first >> 1) & 3;
        if (qos === 3) throw new ProtocolError('PUBLISH with QoS 3');
        if (body.length < 2) throw new ProtocolError('PUBLISH without a topic');
        const tl = (body[0] << 8) | body[1];
        // we only ever subscribe at QoS 0, but a packet id is still skipped if a broker sends one
        const at = 2 + tl + (qos > 0 ? 2 : 0);
        if (at > body.length) throw new ProtocolError('PUBLISH topic runs past the packet');
        const topic = strictDec.decode(body.subarray(2, 2 + tl));
        const payload = body.slice(at);
        try {
          this.onmessage(topic, payload);
        } catch (e) {
          report('message handler', e);
        }
        return;
      }
      case SUBACK: {
        if (body.length < 3) throw new ProtocolError('SUBACK shorter than 3 bytes');
        const id = (body[0] << 8) | body[1];
        const w = this.subWait.get(id);
        if (!w) return;
        this.subWait.delete(id);
        clearTimeout(w.timer);
        if (body[2] === 0x80) w.reject(new Error('subscription refused by the broker'));
        else w.resolve();
        return;
      }
      default:
        // UNSUBACK, PINGRESP: nothing to do; anything else a broker should not send is ignored
        return;
    }
  }

  private ping(): void {
    if (!this.heard) return this.end('no answer to ping');
    this.heard = false;
    this.send(new Uint8Array([PINGREQ << 4, 0]));
  }

  private end(reason: string, byUser = false): void {
    if (this.state === 'closed') return;
    const was = this.state;
    this.state = 'closed';
    clearTimeout(this.connectTimer);
    clearInterval(this.pingTimer);
    this.reader.stop();
    const ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      // not null: the `ws` package emits 'error' when a still-connecting socket is closed (and may for a late
      // socket error), and an EventEmitter 'error' with no listener is an uncaught exception
      ws.onerror = () => {};
      try {
        ws.close();
      } catch {
        // already closing
      }
    }
    const err = new Error(reason);
    for (const w of this.subWait.values()) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.subWait.clear();
    if (this.connectWait) {
      const w = this.connectWait;
      this.connectWait = null;
      w.reject(err);
    } else if (was === 'open' && !byUser) {
      try {
        this.onclose(reason);
      } catch (e) {
        report('close handler', e);
      }
    }
  }
}

export interface BrokersOptions extends MqttOptions {
  /** Wait between a lost or failed connection and the next dial (15 s). */
  redialMs?: number;
  connectTimeoutMs?: number;
}

export interface BrokerStatus {
  name: string;
  ok: boolean;
  /** Why it is not up (the last failure, in the broker's or the socket's own words). */
  error?: string;
}

interface Entry {
  def: BrokerDef;
  client?: MqttClient;
  state: 'idle' | 'connecting' | 'up' | 'down';
  error?: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Topics this connection has confirmed, and topics with a SUBSCRIBE in flight on it. */
  acked: Set<string>;
  inflight: Set<string>;
}

interface Waiter {
  topic: string;
  /** Brokers that might still confirm it. */
  pending: Set<Entry>;
  done: () => void;
}

/**
 * Several brokers at once: every publish goes to all that are up, every subscription is kept on all of them
 * (and restored after a redial). The same message therefore usually arrives once per broker: nothing is deduped
 * here, that is the envelope's / the relay's job (they know what a message id is).
 */
export class Brokers {
  onchange?: () => void;

  private readonly entries: Entry[];
  private readonly topics = new Map<string, (payload: Uint8Array, broker: string) => void>();
  private readonly waiters = new Set<Waiter>();
  private readonly redialMs: number;
  private running = false;
  private last = '';

  constructor(defs: BrokerDef[], private readonly opts: BrokersOptions = {}) {
    this.entries = defs.map((def) => ({ def, state: 'idle', acked: new Set(), inflight: new Set() }));
    this.redialMs = opts.redialMs ?? 15_000;
    this.last = JSON.stringify(this.status());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const e of this.entries) this.dial(e);
  }

  /**
   * Closes every connection and cancels redials. Subscriptions are kept: start() again dials everything right
   * away and resubscribes (also the way to redial at once after a network change instead of waiting redialMs).
   */
  stop(): void {
    this.running = false;
    for (const e of this.entries) {
      clearTimeout(e.timer);
      e.timer = undefined;
      const c = e.client;
      e.client = undefined;
      e.state = 'idle';
      e.error = undefined;
      e.acked.clear();
      e.inflight.clear();
      c?.close();
    }
    for (const w of [...this.waiters]) w.done();
    this.changed();
  }

  /**
   * Exact topics only (no wildcards); a second call for the same topic replaces the callback. Kept across
   * redials. Resolves as soon as one broker has confirmed it, or once no broker that is up or dialing right now
   * could still confirm it (none reachable: resolves after the dials fail, never hangs on a redial). Never
   * rejects for broker trouble.
   */
  subscribe(topic: string, cb: (payload: Uint8Array, broker: string) => void): Promise<void> {
    if (!topic || /[+#]/.test(topic)) return Promise.reject(new Error(`not an exact MQTT topic: ${JSON.stringify(topic)}`));
    this.topics.set(topic, cb);
    const live = this.entries.filter((e) => e.state === 'connecting' || e.state === 'up');
    if (live.length === 0 || live.some((e) => e.acked.has(topic))) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const w: Waiter = {
        topic,
        pending: new Set(live),
        done: () => {
          this.waiters.delete(w);
          resolve();
        },
      };
      this.waiters.add(w);
      // dialing brokers subscribe every topic once they are up
      for (const e of live) this.subscribeOn(e, topic);
    });
  }

  unsubscribe(topic: string): void {
    if (!this.topics.delete(topic)) return;
    for (const e of this.entries) {
      const had = e.acked.delete(topic);
      const inflight = e.inflight.delete(topic);
      if ((had || inflight) && e.state === 'up') e.client?.unsubscribe(topic);
    }
    for (const w of [...this.waiters]) if (w.topic === topic) w.done();
  }

  /** Returns how many brokers took it (QoS 0: handed over, not delivered); 0 for a topic that cannot be encoded. */
  publish(topic: string, payload: string | Uint8Array, opts: { relayOnly?: boolean } = {}): number {
    const bytes = typeof payload === 'string' ? enc.encode(payload) : payload;
    let n = 0;
    for (const e of this.entries) {
      if (e.state !== 'up' || !e.client) continue;
      if (opts.relayOnly && !e.def.relay) continue;
      if (e.client.publish(topic, bytes)) n++;
    }
    return n;
  }

  status(): BrokerStatus[] {
    return this.entries.map((e) => {
      const s: BrokerStatus = { name: e.def.name, ok: e.state === 'up' };
      if (e.state !== 'up' && e.error) s.error = e.error;
      return s;
    });
  }

  private dial(e: Entry): void {
    e.timer = undefined;
    const c = new MqttClient(e.def, this.opts);
    e.client = c;
    e.state = 'connecting';
    e.acked.clear();
    e.inflight.clear();
    c.onmessage = (topic, payload) => this.topics.get(topic)?.(payload, e.def.name);
    c.onclose = (reason) => this.lost(e, c, reason || 'connection lost');
    c.connect(this.opts.connectTimeoutMs).then(
      () => {
        if (e.client !== c) return; // stopped meanwhile
        e.state = 'up';
        e.error = undefined;
        this.changed();
        for (const t of this.topics.keys()) this.subscribeOn(e, t);
      },
      (err) => this.lost(e, c, errText(err) || 'connect failed'),
    );
  }

  private lost(e: Entry, c: MqttClient, reason: string): void {
    if (e.client !== c) return;
    e.client = undefined;
    e.state = 'down';
    e.error = reason;
    e.acked.clear();
    e.inflight.clear();
    for (const w of [...this.waiters]) this.giveUp(w, e);
    if (this.running) e.timer = setTimeout(() => this.dial(e), this.redialMs);
    this.changed();
  }

  private subscribeOn(e: Entry, topic: string): void {
    const c = e.client;
    if (!c || e.state !== 'up' || e.acked.has(topic) || e.inflight.has(topic)) return;
    e.inflight.add(topic);
    c.subscribe(topic).then(
      () => {
        if (e.client !== c) return;
        e.inflight.delete(topic);
        // unsubscribed meanwhile: the UNSUBSCRIBE went out after the SUBSCRIBE, so the broker ends up without it
        if (!this.topics.has(topic)) return;
        e.acked.add(topic);
        for (const w of [...this.waiters]) if (w.topic === topic) w.done();
      },
      () => {
        if (e.client !== c) return;
        e.inflight.delete(topic);
        for (const w of [...this.waiters]) if (w.topic === topic) this.giveUp(w, e);
      },
    );
  }

  private giveUp(w: Waiter, e: Entry): void {
    w.pending.delete(e);
    if (w.pending.size === 0) w.done();
  }

  /** onchange only when what status() says actually changed (a broker failing every redial is not news). */
  private changed(): void {
    const now = JSON.stringify(this.status());
    if (now === this.last) return;
    this.last = now;
    try {
      this.onchange?.();
    } catch (err) {
      report('change handler', err);
    }
  }
}
