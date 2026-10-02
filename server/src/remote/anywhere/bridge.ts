// The PC's side of the streams (the table is in core/mux.ts): every WebSocket and HTTP request that comes over a link
// is made, as it is, to this machine's remote-access listener on 127.0.0.1, whose sockets are marked cwRemote and
// must present a device token. Never the main listener (3090), which trusts loopback without a token. A pairing link
// may only pair; over the slow relay file previews and uploads are refused, and so is any response over 2 MB.
import http from 'node:http';
import WebSocket from 'ws';
import {
  F,
  MUX_MAX_HEAD_BYTES,
  MUX_MAX_MESSAGE_BYTES,
  MUX_MAX_PING_BYTES,
  Outbox,
  concatPieces,
  decodeFrame,
  text,
  type Link,
} from './core/index.js';

/** The 413 body for /api/file and /api/attachments over the slow relay (the phone shows it where the preview would be). */
export const RELAY_REFUSED = '慢速转发时不能预览 / 上传文件';
/** Largest response sent over the slow relay; anything longer is a 413. */
export const RELAY_MAX_RESPONSE_BYTES = 2_097_152;
/**
 * Relay responses held whole at once per link (so at most 8 MB in memory); a response past it is not read until one
 * of them is done (it waits, it is not refused).
 */
export const RELAY_MAX_HELD = 4;
export const RELAY_TOO_LARGE = '慢速转发时单个响应不能超过 2 MB';
export const PAIRING_ONLY = '还没配对，只能先配对';
/** Streams open at once on one link; past it a new one is refused. */
export const BRIDGE_MAX_STREAMS = 256;
const MAX_TOKEN_BYTES = 1024;
const WS_HANDSHAKE_MS = 10_000;
const RELAY_REFUSED_PATHS = new Set(['/api/file', '/api/attachments']);
/** Request headers the bridge's own connection decides (and Origin: the local WebSocket goes without one too). */
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect', 'proxy-connection', 'proxy-authorization', 'origin']);
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'trailer', 'upgrade', 'proxy-connection', 'set-cookie']);
const METHOD_RE = /^[A-Za-z]{1,16}$/;
/** One `/`, then printable ASCII only: `//host/x` would be read as another host, and http.request throws on the rest. */
const PATH_RE = /^\/(?![/\\])[\x21-\x7e]*$/;
const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8' };

export interface BridgeOptions {
  /** The remote-access listener's port (RemoteService.port). */
  port: number;
  /** The link is the slow relay: /api/file and /api/attachments get 413, responses are capped. */
  relay: boolean;
  /** The paired device whose room the link came through (none for a pairing link); names the link in the log. */
  deviceId?: string;
  /** A pairing link: only POST /api/pair goes through, everything else is 403 (a WebSocket is refused). */
  pairing?: boolean;
  /** A device link: a WebSocket only opens with a token this says is that device's. */
  tokenOk?: (token: string) => boolean;
  /** The link ended by itself or from the other side (not by the returned stop()); every stream is gone by then. */
  onclose?: (why: string) => void;
  /** How many relay responses are held right now, each time it changes (tests, diagnostics). */
  onHeld?: (n: number) => void;
}

function report(what: string, e: unknown): void {
  console.error(`[anywhere bridge] ${what}:`, e instanceof Error ? e.message : e);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function bytes(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

interface Stream {
  fromPhone(type: F, payload: Uint8Array): void;
  /** The source may go on (the outbox drained). */
  resume(): void;
  /** Gone for good, nothing more is sent (link ended or bridge stopped). */
  kill(): void;
}

/**
 * Serves one link until it ends. Takes its onframe and onclose at once (call it inside Acceptor's onLink). Returns
 * stop(): every stream and the link closed (onclose is not called for it).
 */
export function serveBridge(link: Link, opts: BridgeOptions): () => void {
  const b = new Bridge(link, opts);
  return () => b.stop();
}

class Bridge {
  readonly out: Outbox;
  private readonly streams = new Map<number, Stream>();
  private done = false;
  /** Relay responses held right now, and the ones waiting for a turn (each says whether it still wants it). */
  private holding = 0;
  private waiting: (() => boolean)[] = [];

  constructor(private readonly link: Link, readonly opts: BridgeOptions) {
    this.out = new Outbox(link);
    this.out.ondrain = () => {
      for (const s of this.streams.values()) s.resume();
    };
    const who = opts.deviceId ? `device ${opts.deviceId}` : opts.pairing ? 'pairing' : 'link';
    link.onframe = (f) => {
      try {
        this.onFrame(f);
      } catch (e) {
        report(`${who} frame`, e);
      }
    };
    link.onclose = (why) => {
      this.teardown();
      try {
        opts.onclose?.(why);
      } catch (e) {
        report(`${who} close handler`, e);
      }
    };
  }

  stop(): void {
    if (this.done) return;
    this.teardown();
    this.link.close();
  }

  forget(id: number, s: Stream): void {
    if (this.streams.get(id) === s) this.streams.delete(id);
  }

  /**
   * A turn to hold a relay response, at most RELAY_MAX_HELD at once (each up to 2 MB): `take` runs now or when one is
   * let go, and returns false if its stream ended while it waited. Every taken turn is given back with release().
   */
  hold(take: () => boolean): void {
    this.waiting.push(take);
    this.pump();
  }

  release(): void {
    this.holding--;
    this.held();
    this.pump();
  }

  private pump(): void {
    while (!this.done && this.holding < RELAY_MAX_HELD && this.waiting.length > 0) {
      const take = this.waiting.shift()!;
      this.holding++;
      if (!take()) this.holding--;
      else this.held();
    }
  }

  private held(): void {
    try {
      this.opts.onHeld?.(this.holding);
    } catch (e) {
      report('held handler', e);
    }
  }

  private teardown(): void {
    if (this.done) return;
    this.done = true;
    const all = [...this.streams.values()];
    this.streams.clear();
    this.waiting = [];
    this.out.close();
    for (const s of all) s.kill();
  }

  private onFrame(buf: Uint8Array): void {
    if (this.done) return;
    let fr;
    try {
      fr = decodeFrame(buf);
    } catch {
      return;
    }
    const { type, stream, payload } = fr;
    if (type === F.PING) return this.out.frame(stream, F.PONG, payload.subarray(0, MUX_MAX_PING_BYTES));
    if (type !== F.WS_OPEN && type !== F.HTTP_REQ) return this.streams.get(stream)?.fromPhone(type, payload);
    // a new stream: 0 is not one, and an id in use is not taken twice
    if (stream === 0 || this.streams.has(stream)) return;
    if (this.streams.size >= BRIDGE_MAX_STREAMS) {
      return this.out.frame(stream, type === F.WS_OPEN ? F.WS_CLOSE : F.ERR, `more than ${BRIDGE_MAX_STREAMS} streams at once`);
    }
    if (type === F.WS_OPEN) return this.openWs(stream, payload);
    const s = new HttpStream(this, stream);
    this.streams.set(stream, s);
    s.start(payload);
  }

  private openWs(id: number, payload: Uint8Array): void {
    const token = payload.length <= MAX_TOKEN_BYTES ? text(payload) : '';
    const { opts } = this;
    if (opts.pairing || !token || (opts.tokenOk && !opts.tokenOk(token))) return this.out.frame(id, F.WS_CLOSE);
    this.streams.set(id, new WsStream(this, id, token));
  }
}

/** One tunneled WebSocket: the phone's messages to the hub and back, the local socket paused while the link is backed up. */
class WsStream implements Stream {
  private readonly ws: WebSocket;
  private open = false;
  private done = false;
  private parts: Uint8Array[] = [];
  private partsBytes = 0;

  constructor(private readonly b: Bridge, private readonly id: number, token: string) {
    // no Origin: the listener takes a WebSocket without one (and checks the token)
    const ws = new WebSocket(`ws://127.0.0.1:${b.opts.port}/ws?token=${encodeURIComponent(token)}`, {
      perMessageDeflate: false,
      maxPayload: MUX_MAX_MESSAGE_BYTES,
      handshakeTimeout: WS_HANDSHAKE_MS,
    });
    this.ws = ws;
    // a refused upgrade is an 'error' then a 'close'; without a listener the error would be uncaught
    ws.on('error', () => {});
    ws.on('open', () => {
      if (this.done) return;
      this.open = true;
      b.out.frame(id, F.WS_OPEN);
    });
    ws.on('message', (data) => {
      if (this.done) return;
      b.out.pieces(id, bytes(data), F.BODY, F.WS_MSG);
      if (b.out.busy()) ws.pause();
    });
    ws.on('close', () => {
      if (this.done) return;
      this.done = true;
      b.out.frame(id, F.WS_CLOSE);
      b.forget(id, this);
    });
  }

  fromPhone(type: F, payload: Uint8Array): void {
    if (this.done) return;
    // a close counts in any state: before the ack it ends the local socket still connecting (else it would open and
    // stream every hub broadcast to a stream the phone has forgotten)
    if (type === F.WS_CLOSE || type === F.ERR) return this.close(false);
    if (!this.open) return;
    switch (type) {
      case F.BODY:
        this.partsBytes += payload.length;
        if (this.partsBytes > MUX_MAX_MESSAGE_BYTES) return this.close(true);
        this.parts.push(payload);
        return;
      case F.WS_MSG: {
        this.parts.push(payload);
        const msg = concatPieces(this.parts);
        this.parts = [];
        this.partsBytes = 0;
        this.ws.send(msg, { binary: false });
        return;
      }
      default:
        return;
    }
  }

  resume(): void {
    if (!this.done) this.ws.resume();
  }

  kill(): void {
    if (this.done) return;
    this.done = true;
    this.ws.terminate();
  }

  /**
   * Ended here: the local socket goes (terminate(): a close() would wait up to 30 s for the hub's close frame), and
   * whatever the hub sent that is still queued for the stream is not sent. `tell`: the phone did not ask for it, so
   * it gets a WS_CLOSE.
   */
  private close(tell: boolean): void {
    this.kill();
    this.b.forget(this.id, this);
    this.b.out.drop(this.id);
    if (tell) this.b.out.frame(this.id, F.WS_CLOSE);
  }
}

/** One tunneled HTTP request to the listener, and its response back. */
class HttpStream implements Stream {
  private req: http.ClientRequest | null = null;
  private res: http.IncomingMessage | null = null;
  private done = false;
  private sentEnd = false;
  /** Over the relay the response is held whole (≤ 2 MB) before anything goes out. */
  private held: Buffer[] | null = null;
  private heldBytes = 0;
  /** Holding one of the link's RELAY_MAX_HELD turns: from the first byte read until the last piece left the outbox. */
  private slot = false;

  constructor(private readonly b: Bridge, private readonly id: number) {}

  start(payload: Uint8Array): void {
    const head = this.readHead(payload);
    if (!head) return this.fail('the request head cannot be read');
    const { method, path, headers } = head;
    const { opts } = this.b;
    const pathname = new URL(path, 'http://127.0.0.1').pathname;
    if (opts.pairing && !(method === 'POST' && pathname === '/api/pair')) return this.reply(403, PAIRING_ONLY);
    if (opts.relay && RELAY_REFUSED_PATHS.has(pathname)) return this.reply(413, RELAY_REFUSED);
    let req: http.ClientRequest;
    try {
      req = http.request({ host: '127.0.0.1', port: opts.port, method, path, headers, agent: false });
    } catch (e) {
      return this.fail(`the request cannot be made: ${errText(e)}`);
    }
    this.req = req;
    req.on('error', (e) => this.fail(errText(e)));
    req.on('response', (res) => this.onResponse(res));
  }

  fromPhone(type: F, payload: Uint8Array): void {
    const req = this.req;
    if (this.done || !req || this.sentEnd) return;
    if (type === F.BODY) {
      if (payload.length) req.write(payload);
    } else if (type === F.END) {
      this.sentEnd = true;
      req.end();
    }
  }

  resume(): void {
    if (!this.done && !this.held) this.res?.resume();
  }

  kill(): void {
    this.letGo();
    if (this.done) return;
    this.done = true;
    this.req?.destroy();
    this.res?.destroy();
  }

  private letGo(): void {
    if (!this.slot) return;
    this.slot = false;
    this.b.release();
  }

  private readHead(payload: Uint8Array): { method: string; path: string; headers: Record<string, string> } | null {
    if (payload.length > MUX_MAX_HEAD_BYTES) return null;
    let j: unknown;
    try {
      j = JSON.parse(text(payload));
    } catch {
      return null;
    }
    const o = j as { method?: unknown; path?: unknown; headers?: unknown };
    if (!o || typeof o !== 'object' || typeof o.method !== 'string' || !METHOD_RE.test(o.method)) return null;
    if (typeof o.path !== 'string' || !PATH_RE.test(o.path)) return null;
    const headers: Record<string, string> = {};
    if (o.headers && typeof o.headers === 'object') {
      for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
        const name = k.toLowerCase();
        if (typeof v === 'string' && !DROP_REQUEST.has(name)) headers[name] = v;
      }
    }
    return { method: o.method.toUpperCase(), path: o.path, headers };
  }

  private onResponse(res: http.IncomingMessage): void {
    if (this.done) {
      res.destroy();
      return;
    }
    this.res = res;
    const status = res.statusCode ?? 502;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined || DROP_RESPONSE.has(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    let ended = false;
    res.on('error', () => {});
    res.on('close', () => {
      if (!ended) this.fail('the response was cut off');
    });
    if (this.b.opts.relay) {
      const declared = Number(headers['content-length']);
      if (Number.isFinite(declared) && declared > RELAY_MAX_RESPONSE_BYTES) return this.refuseLarge();
      // not read until it has a turn: the listener's socket (and the listener) wait meanwhile
      this.b.hold(() => {
        if (this.done) return false;
        this.slot = true;
        this.held = [];
        res.on('data', (c: Buffer) => {
          if (this.done || !this.held) return;
          this.heldBytes += c.length;
          if (this.heldBytes > RELAY_MAX_RESPONSE_BYTES) return this.refuseLarge();
          this.held.push(c);
        });
        res.on('end', () => {
          ended = true;
          if (this.done || !this.held) return;
          const body = Buffer.concat(this.held);
          this.held = null;
          this.send(status, headers, body);
        });
        return true;
      });
      return;
    }
    const { out } = this.b;
    out.frame(this.id, F.HTTP_RES, JSON.stringify({ status, headers }));
    res.on('data', (c: Buffer) => {
      if (this.done) return;
      out.pieces(this.id, c, F.BODY);
      if (out.busy()) res.pause();
    });
    res.on('end', () => {
      ended = true;
      if (this.done) return;
      out.frame(this.id, F.END);
      this.finish();
    });
  }

  /** A whole response at once: refused here, or held over the relay (its turn ends once the body left the outbox). */
  private send(status: number, headers: Record<string, string>, body: Uint8Array): void {
    if (this.done) return;
    const { out } = this.b;
    out.frame(this.id, F.HTTP_RES, JSON.stringify({ status, headers: { ...headers, 'content-length': String(body.length) } }));
    out.pieces(this.id, body, F.BODY, undefined, () => this.letGo());
    out.frame(this.id, F.END);
    this.finish();
  }

  private reply(status: number, body: string): void {
    this.send(status, TEXT_HEADERS, Buffer.from(body));
  }

  private refuseLarge(): void {
    if (this.done) return;
    this.held = null;
    this.reply(413, RELAY_TOO_LARGE);
  }

  private fail(why: string): void {
    if (this.done) return;
    this.letGo();
    this.b.out.frame(this.id, F.ERR, why);
    this.finish();
  }

  /** Answered (or failed): the stream is over; a request body the listener did not wait for is not sent on. */
  private finish(): void {
    this.done = true;
    this.b.forget(this.id, this);
    if (!this.sentEnd) this.req?.destroy();
    this.res?.destroy();
  }
}
