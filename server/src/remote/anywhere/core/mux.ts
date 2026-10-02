// Streams over one Link: WebSockets and HTTP requests from the phone to the PC's remote-access listener, many at once
// (Mux is the phone's side; the PC's is bridge.ts), and the paced outgoing queue both sides send through (Outbox).
// Shared by the Node server and the phone shell, so Web-standard APIs only (no node:*, no Buffer).
//
// Streams, protocol v1. The phone shell (cached by its service worker) and the PC app run different copies of this
// file, so this table is the reference for both and a change to it is a new version. Stream ids are the phone's:
// 1 … 2^32 − 1, never reused on a link; stream 0 only carries PING / PONG.
//   WebSocket stream
//     phone → PC   WS_OPEN   the device token (UTF-8): the PC opens ws://127.0.0.1:<remote port>/ws?token= with it
//     PC → phone   WS_OPEN   empty: that WebSocket is open (what the phone sends before this waits on the phone)
//     both         WS_MSG    one text message, or the last piece of one; the BODY frames before it on the same
//                            stream are its earlier pieces (a message over CHUNK_BYTES goes as several frames)
//     both         WS_CLOSE  closed, or (from the PC) could not be opened; nothing more is sent on the stream
//   HTTP stream
//     phone → PC   HTTP_REQ  JSON {method, path, headers}, then the body as BODY pieces, then END
//     PC → phone   HTTP_RES  JSON {status, headers}, then BODY pieces, then END
//     PC → phone   ERR       text: the request failed (no response, or one cut off); the stream is over
//   PING (any payload up to 64 bytes) is answered with PONG carrying it back. ERR on a WebSocket stream closes it.
//   Unknown frame types, and frames for a stream the receiver does not have (any more), are ignored.
import { CHUNK_BYTES, F, decodeFrame, encodeFrame, text } from './frames.js';
import { report as reportAs } from './handshake.js';
import type { Link, LinkKind } from './link.js';

/** Past this much held by the link (by our accounting, see Outbox.load()) the sender waits. */
export const MUX_PAUSE_BYTES = 1_048_576;
/**
 * What each frame handed to the link counts for besides its bytes, until the link is seen empty again. The relay
 * link also caps the frames it queues (65 536), which bytes alone never reach with small frames: at this charge the
 * pause comes after at most 8 192 frames.
 */
export const MUX_FRAME_CHARGE = 128;
/** While paused, how often the link is looked at again (a Link has no drain event). */
export const MUX_POLL_MS = 20;
/** The JSON head of a request or a response. */
export const MUX_MAX_HEAD_BYTES = 65_536;
/** One WebSocket message put back together from its pieces (the `ws` package's own default limit). */
export const MUX_MAX_MESSAGE_BYTES = 104_857_600;
/** A PING's payload; anything longer is cut. */
export const MUX_MAX_PING_BYTES = 64;

const MAX_STREAM = 0xffff_ffff;
const enc = new TextEncoder();

function report(what: string, e: unknown): void {
  reportAs('mux', what, e);
}

/** The pieces, joined; nothing is copied when there is only one. */
export function concatPieces(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface Pieces {
  stream: number;
  data: Uint8Array;
  at: number;
  piece: F;
  last?: F;
  sent?: () => void;
}

type Entry = Uint8Array | Pieces;

/**
 * The frames one side sends, in order per stream and taken in turn across streams (a big body does not hold a small
 * message back behind all of it). Handed to the link while it holds less than MUX_PAUSE_BYTES, counting
 * MUX_FRAME_CHARGE per frame since the link was last empty; past that, looked at again every MUX_POLL_MS. Sources
 * that can wait (a socket, a response) ask busy() after handing something over and pause until ondrain.
 */
export class Outbox {
  /** After busy() said true: the queue is empty and the link below the mark again. */
  ondrain: () => void = () => {};
  private readonly queues = new Map<number, Entry[]>();
  private sinceEmpty = 0;
  private wantDrain = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly link: Link, private readonly pauseBytes = MUX_PAUSE_BYTES) {}

  /** What the link holds by this accounting: its unconfirmed bytes, plus MUX_FRAME_CHARGE per frame since it was last empty. */
  load(): number {
    let b = 0;
    try {
      b = this.link.buffered();
    } catch (e) {
      report('buffered()', e);
    }
    if (b === 0) this.sinceEmpty = 0;
    return b + this.sinceEmpty * MUX_FRAME_CHARGE;
  }

  /** One frame. */
  frame(stream: number, type: F, payload?: Uint8Array | string): void {
    if (this.closed) return;
    this.enqueue(stream, encodeFrame(type, stream, payload));
  }

  /**
   * `data` as CHUNK_BYTES pieces of type `piece`, the last one of type `last` when given (an empty `data` is then one
   * empty `last` frame, and nothing without `last`). The pieces are views on `data`, framed as they go out: the
   * caller must not change it meanwhile. `sent` runs (a microtask later) once the last piece went to the link; not if
   * the stream is dropped or the outbox closed first.
   */
  pieces(stream: number, data: Uint8Array, piece: F, last?: F, sent?: () => void): void {
    if (this.closed) return;
    if (data.length === 0) {
      if (last !== undefined) this.frame(stream, last);
      if (sent) queueMicrotask(() => this.call(sent, 'sent handler'));
      return;
    }
    this.enqueue(stream, { stream, data, at: 0, piece, last, sent });
  }

  /** True when what was handed over has to wait: the caller pauses its source until ondrain. */
  busy(): boolean {
    if (this.closed) return false;
    if (this.queues.size === 0 && this.load() < this.pauseBytes) return false;
    this.wantDrain = true;
    this.arm();
    return true;
  }

  /** Whatever of `stream` has not gone out yet is not sent. */
  drop(stream: number): void {
    this.queues.delete(stream);
  }

  /** For good: nothing more goes out, the timer is gone. */
  close(): void {
    this.closed = true;
    this.queues.clear();
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private enqueue(stream: number, e: Entry): void {
    const q = this.queues.get(stream);
    if (q) q.push(e);
    else this.queues.set(stream, [e]);
    this.flush();
  }

  private readonly tick = () => {
    this.timer = undefined;
    this.flush();
  };

  private arm(): void {
    if (this.timer === undefined && !this.closed) this.timer = setTimeout(this.tick, MUX_POLL_MS);
  }

  private flush(): void {
    while (!this.closed && this.queues.size > 0 && this.load() < this.pauseBytes) {
      // the stream that has waited longest; it goes to the back if it has more
      const [stream, q] = this.queues.entries().next().value as [number, Entry[]];
      const f = this.take(q);
      this.queues.delete(stream);
      if (q.length > 0) this.queues.set(stream, q);
      this.sinceEmpty++;
      try {
        this.link.send(f);
      } catch (e) {
        // RangeError only, for a frame over 1 MiB: ours are at most CHUNK_BYTES + header
        report('send', e);
      }
    }
    if (this.closed) return;
    if (this.queues.size > 0) return this.arm();
    if (!this.wantDrain) return;
    if (this.load() >= this.pauseBytes) return this.arm();
    this.wantDrain = false;
    try {
      this.ondrain();
    } catch (e) {
      report('drain handler', e);
    }
  }

  private take(q: Entry[]): Uint8Array {
    const head = q[0];
    if (head instanceof Uint8Array) {
      q.shift();
      return head;
    }
    const end = Math.min(head.data.length, head.at + CHUNK_BYTES);
    const done = end >= head.data.length;
    const f = encodeFrame(done && head.last !== undefined ? head.last : head.piece, head.stream, head.data.subarray(head.at, end));
    head.at = end;
    if (done) {
      q.shift();
      // later: flush() is in the middle of its bookkeeping, and the callback may hand over more
      const sent = head.sent;
      if (sent) queueMicrotask(() => this.call(sent, 'sent handler'));
    }
    return f;
  }

  private call(fn: () => void, what: string): void {
    try {
      fn();
    } catch (e) {
      report(what, e);
    }
  }
}

/** A WebSocket to the PC through the link: the browser WebSocket's shape, text messages only. */
export interface MuxWs {
  /** Before onopen it waits on the phone; after close it is dropped. */
  send(text: string): void;
  /** Tells the PC; onclose follows (a microtask later), as with a WebSocket. */
  close(): void;
  onmessage: (text: string) => void;
  /** The PC's WebSocket to its remote-access listener is open (the token was taken). */
  onopen: () => void;
  /** Once: closed by either side, refused (a wrong token), or the link ended. */
  onclose: () => void;
}

export interface MuxRequest {
  method: string;
  /** Path and query on the PC's remote-access listener, starting with one `/`. */
  path: string;
  headers?: Record<string, string>;
  /** Read as it goes out: do not change it before the promise settles. A content-length is added for it. */
  body?: Uint8Array;
}

export interface MuxResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: Uint8Array;
}

interface WsStream {
  kind: 'ws';
  ws: MuxWs;
  open: boolean;
  closed: boolean;
  /** Messages sent before the PC said open. */
  waiting: Uint8Array[];
  parts: Uint8Array[];
  partsBytes: number;
}

interface HttpStream {
  kind: 'http';
  resolve: (r: MuxResponse) => void;
  reject: (e: Error) => void;
  status?: number;
  headers?: Record<string, string>;
  body: Uint8Array[];
}

/** The head of a response, or null when it is not one. */
function readHead(payload: Uint8Array): { status: number; headers: Record<string, string> } | null {
  if (payload.length > MUX_MAX_HEAD_BYTES) return null;
  let j: unknown;
  try {
    j = JSON.parse(text(payload));
  } catch {
    return null;
  }
  const o = j as { status?: unknown; headers?: unknown };
  if (!o || typeof o !== 'object' || !Number.isInteger(o.status) || (o.status as number) < 100 || (o.status as number) > 999) return null;
  const headers: Record<string, string> = {};
  if (o.headers && typeof o.headers === 'object') {
    for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
  }
  return { status: o.status as number, headers };
}

/**
 * The phone's side of the streams (table above). Takes the link's onframe and onclose at once, so make it right
 * after dial() resolves; from then on the link is the Mux's.
 */
export class Mux {
  /** The link ended (not by close()): every stream has been told already. Dial again from here. */
  onclose: (why: string) => void = () => {};
  private readonly out: Outbox;
  private readonly streams = new Map<number, WsStream | HttpStream>();
  private last = 0;
  private ended: string | undefined;

  constructor(private readonly link: Link) {
    this.out = new Outbox(link);
    link.onframe = (f) => this.onFrame(f);
    link.onclose = (why) => this.end(why, true);
  }

  get kind(): LinkKind {
    return this.link.kind;
  }

  openWs(token: string): MuxWs {
    const id = this.newId();
    let st: WsStream | undefined;
    const ws: MuxWs = {
      onmessage: () => {},
      onopen: () => {},
      onclose: () => {},
      send: (t: string) => {
        if (!st || st.closed) return;
        const b = enc.encode(t);
        if (st.open) this.out.pieces(id, b, F.BODY, F.WS_MSG);
        else st.waiting.push(b);
      },
      close: () => {
        if (!st || st.closed) return;
        this.out.frame(id, F.WS_CLOSE);
        this.closeWs(id, st, true);
      },
    };
    if (this.ended !== undefined) {
      queueMicrotask(() => this.tell(ws, 'onclose'));
      return ws;
    }
    st = { kind: 'ws', ws, open: false, closed: false, waiting: [], parts: [], partsBytes: 0 };
    this.streams.set(id, st);
    this.out.frame(id, F.WS_OPEN, token);
    return ws;
  }

  request(r: MuxRequest): Promise<MuxResponse> {
    if (this.ended !== undefined) return Promise.reject(new Error(`the link to the PC has ended: ${this.ended}`));
    if (typeof r.method !== 'string' || typeof r.path !== 'string' || !r.path.startsWith('/')) {
      return Promise.reject(new Error('a request needs a method and a path starting with /'));
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = String(v);
    if (r.body && headers['content-length'] === undefined) headers['content-length'] = String(r.body.length);
    const head = enc.encode(JSON.stringify({ method: r.method, path: r.path, headers }));
    if (head.length > MUX_MAX_HEAD_BYTES) return Promise.reject(new Error(`the request head is over ${MUX_MAX_HEAD_BYTES} bytes`));
    const id = this.newId();
    return new Promise<MuxResponse>((resolve, reject) => {
      this.streams.set(id, { kind: 'http', resolve, reject, body: [] });
      this.out.frame(id, F.HTTP_REQ, head);
      if (r.body && r.body.length > 0) this.out.pieces(id, r.body, F.BODY);
      this.out.frame(id, F.END);
    });
  }

  /** For good, and the link with it (which tells the PC); every stream is told, onclose is not called. */
  close(): void {
    if (this.ended !== undefined) return;
    this.end('closed', false);
    this.link.close();
  }

  private newId(): number {
    for (let i = 0; i < MAX_STREAM; i++) {
      this.last = this.last >= MAX_STREAM ? 1 : this.last + 1;
      if (!this.streams.has(this.last)) return this.last;
    }
    throw new Error('no free stream id');
  }

  private tell(ws: MuxWs, what: 'onopen' | 'onclose'): void {
    try {
      ws[what]();
    } catch (e) {
      report(`${what} handler`, e);
    }
  }

  /** `later`: our own close(), told a microtask later like a WebSocket. */
  private closeWs(id: number, st: WsStream, later = false): void {
    if (st.closed) return;
    st.closed = true;
    st.waiting = [];
    st.parts = [];
    if (this.streams.get(id) === st) this.streams.delete(id);
    if (later) queueMicrotask(() => this.tell(st.ws, 'onclose'));
    else this.tell(st.ws, 'onclose');
  }

  private finishHttp(id: number, st: HttpStream): void {
    if (this.streams.get(id) === st) this.streams.delete(id);
    // the PC answered: the rest of a body it did not wait for is not sent
    this.out.drop(id);
  }

  private onFrame(buf: Uint8Array): void {
    if (this.ended !== undefined) return;
    let fr;
    try {
      fr = decodeFrame(buf);
    } catch {
      return;
    }
    const { type, stream, payload } = fr;
    if (type === F.PING) return this.out.frame(stream, F.PONG, payload.subarray(0, MUX_MAX_PING_BYTES));
    const st = this.streams.get(stream);
    if (!st) return;
    if (st.kind === 'ws') return this.onWs(stream, st, type, payload);
    this.onHttp(stream, st, type, payload);
  }

  private onWs(id: number, st: WsStream, type: F, payload: Uint8Array): void {
    switch (type) {
      case F.WS_OPEN: {
        if (st.open) return;
        st.open = true;
        for (const b of st.waiting.splice(0)) this.out.pieces(id, b, F.BODY, F.WS_MSG);
        return this.tell(st.ws, 'onopen');
      }
      case F.BODY: {
        st.partsBytes += payload.length;
        if (st.partsBytes > MUX_MAX_MESSAGE_BYTES) {
          this.out.frame(id, F.WS_CLOSE);
          return this.closeWs(id, st);
        }
        st.parts.push(payload);
        return;
      }
      case F.WS_MSG: {
        st.parts.push(payload);
        const msg = text(concatPieces(st.parts));
        st.parts = [];
        st.partsBytes = 0;
        try {
          st.ws.onmessage(msg);
        } catch (e) {
          report('message handler', e);
        }
        return;
      }
      case F.WS_CLOSE:
      case F.ERR:
        return this.closeWs(id, st);
      default:
        return;
    }
  }

  private onHttp(id: number, st: HttpStream, type: F, payload: Uint8Array): void {
    switch (type) {
      case F.HTTP_RES: {
        if (st.status !== undefined) return;
        const head = readHead(payload);
        if (!head) {
          this.finishHttp(id, st);
          return st.reject(new Error('the PC sent a response that cannot be read'));
        }
        st.status = head.status;
        st.headers = head.headers;
        return;
      }
      case F.BODY:
        if (st.status !== undefined) st.body.push(payload);
        return;
      case F.END: {
        this.finishHttp(id, st);
        if (st.status === undefined) return st.reject(new Error('the PC ended the request without a response'));
        return st.resolve({ status: st.status, headers: st.headers ?? {}, body: concatPieces(st.body) });
      }
      case F.ERR:
        this.finishHttp(id, st);
        return st.reject(new Error(text(payload) || 'the request failed on the PC'));
      default:
        return;
    }
  }

  private end(why: string, fromLink: boolean): void {
    if (this.ended !== undefined) return;
    this.ended = why;
    this.out.close();
    const all = [...this.streams.entries()];
    this.streams.clear();
    for (const [id, st] of all) {
      if (st.kind === 'ws') this.closeWs(id, st);
      else st.reject(new Error(`the link to the PC has ended: ${why}`));
    }
    if (!fromLink) return;
    try {
      this.onclose(why);
    } catch (e) {
      report('close handler', e);
    }
  }
}
