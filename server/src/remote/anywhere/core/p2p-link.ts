// Direct link (直连): a Link over one WebRTC data channel, for when ICE finds a way through (IPv6, or the same
// network). The phone uses the browser's RTCPeerConnection, the PC node-datachannel's W3C polyfill; both fit the
// narrow structural types below (declared here because the server typecheck has no DOM lib). Shared by the Node
// server and the phone shell, so Web-standard APIs only (no node:*, no Buffer).
//
// Wire format, protocol v1, one data channel message (the shell, cached by its service worker, and the PC app run
// different copies of this file, so a change here is a new version):
//   message = flag (1 byte) ‖ piece
//   flag    0  END   the last (or only) piece of a frame
//           1  MORE  a piece of a frame that goes on in the next message; never empty
//   any other flag, an empty or text message, a piece over P2P_PIECE_BYTES, or a frame growing past 1 MiB ends the link
// A piece is at most P2P_PIECE_BYTES, one chunked channel frame (frames.ts): the usual frame is one message, and
// every message stays far under any browser's max-message-size. The channel is ordered and reliable (SCTP).
import { CHUNK_BYTES, HEADER_BYTES } from './frames.js';
import { errText, report as reportAs } from './handshake.js';
import type { Link, LinkKind } from './link.js';
import { isStunUrl } from './lists.js';
import { MAX_FRAME_BYTES, MAX_QUEUED_BYTES, MAX_QUEUED_FRAMES } from './relay-link.js';

/** The data channel's label; any other channel on the connection is closed. */
export const P2P_CHANNEL = 'cw';
export const P2P_PIECE_BYTES = CHUNK_BYTES + HEADER_BYTES;
export const P2P_FLAG = { end: 0, more: 1 } as const;
/** Past this much in the channel's own buffer, frames wait in ours (callers pause on buffered() long before). */
const HIGH_WATER = 1_048_576;
const LOW_WATER = 262_144;
/**
 * ICE "disconnected" can come back by itself (a moment without consent checks); past this long it counts as lost,
 * so a phone that changed networks redials within seconds instead of waiting for "failed" (~30 s in browsers).
 */
export const P2P_DISCONNECT_GRACE_MS = 4_000;
/** How long pairKind() waits for getStats() before calling the link IPv4. */
export const PAIR_KIND_TIMEOUT_MS = 2_000;
/** Frames held while no onframe is set yet. */
const MAX_EARLY_BYTES = MAX_FRAME_BYTES;
const MAX_EARLY_FRAMES = 1024;
const MAX_CANDIDATE_CHARS = 2048;
const EMPTY = new Uint8Array(0);

/** What a candidate travels as in signaling (RTCIceCandidateInit). */
export interface RtcCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** RTCSdpType: a plain string would not fit the browser's setLocalDescription(). */
export type RtcSdpType = 'offer' | 'answer' | 'pranswer' | 'rollback';

export interface RtcDescription {
  type?: RtcSdpType;
  sdp?: string;
}

export interface RtcConfig {
  iceServers: { urls: string[] }[];
}

/** RTCStatsReport is a Map of stats objects; only iterated. */
export interface RtcStatsLike {
  forEach(cb: (value: any) => void): void;
}

/**
 * The slice of RTCDataChannel used here. Handler events are `any` so that the browser's channel and the polyfill's
 * both fit without a cast (as WsLike does in mqtt.ts).
 */
export interface RtcDataChannelLike {
  readonly label: string;
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: string;
  onopen: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onbufferedamountlow: ((ev: any) => void) | null;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
}

/** The slice of RTCPeerConnection used here. */
export interface RtcPeerConnectionLike {
  readonly connectionState?: string;
  readonly iceConnectionState: string;
  onicecandidate: ((ev: any) => void) | null;
  ondatachannel: ((ev: any) => void) | null;
  onconnectionstatechange: ((ev: any) => void) | null;
  oniceconnectionstatechange: ((ev: any) => void) | null;
  createDataChannel(label: string, init?: { ordered?: boolean }): RtcDataChannelLike;
  createOffer(): Promise<RtcDescription>;
  createAnswer(): Promise<RtcDescription>;
  setLocalDescription(d: RtcDescription): Promise<void>;
  setRemoteDescription(d: { type: 'offer' | 'answer'; sdp: string }): Promise<void>;
  addIceCandidate(c: RtcCandidate): Promise<void>;
  getStats(): Promise<RtcStatsLike>;
  /** node-datachannel's extension; the standard getStats() is tried first. */
  selectedCandidatePair?(): { local?: { address?: string } } | null;
  close(): void;
}

/**
 * An RTCPeerConnection constructor: the browser's, or node-datachannel's polyfill (loadRtc() in ../rtc.ts). A local
 * structural type rather than `typeof globalThis.RTCPeerConnection`, which does not exist without the DOM lib.
 */
export type RtcCtor = new (config: RtcConfig) => RtcPeerConnectionLike;

/** STUN entries that are not stun: / stuns: URLs are dropped (a bad entry in the settings must not stop ICE). */
export function rtcConfig(stun: readonly string[]): RtcConfig {
  const urls = stun.filter(isStunUrl);
  return { iceServers: urls.length ? [{ urls }] : [] };
}

/** A candidate to send, or one received; null for end-of-candidates ('') and anything malformed. */
export function iceCandidate(c: unknown): RtcCandidate | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown };
  if (typeof o.candidate !== 'string' || !o.candidate || o.candidate.length > MAX_CANDIDATE_CHARS) return null;
  const sdpMid = typeof o.sdpMid === 'string' && o.sdpMid.length <= 32 ? o.sdpMid : null;
  const line = o.sdpMLineIndex;
  const sdpMLineIndex = typeof line === 'number' && Number.isInteger(line) && line >= 0 && line <= 255 ? line : null;
  // one m-line (the data channel): at least one of the two is required by every implementation
  return { candidate: o.candidate, sdpMid, sdpMLineIndex: sdpMid === null && sdpMLineIndex === null ? 0 : sdpMLineIndex };
}

/**
 * Closes the channel first, then the connection: node-datachannel keeps the event loop alive for good when a
 * connection is closed with a channel that never opened still on it (the process then never exits).
 */
export function closeRtc(pc: RtcPeerConnectionLike, dc?: RtcDataChannelLike): void {
  try {
    dc?.close();
  } catch {
    // already closing
  }
  try {
    pc.close();
  } catch {
    // already closed
  }
}

function closeChannel(dc: unknown): void {
  try {
    (dc as RtcDataChannelLike | undefined)?.close();
  } catch {
    // already closing
  }
}

function family(addr: unknown): LinkKind | null {
  if (typeof addr !== 'string' || !addr) return null;
  // an IPv4-mapped IPv6 address is still IPv4 on the wire
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(addr)) return 'p2p-v4';
  return addr.includes(':') ? 'p2p-v6' : 'p2p-v4';
}

/**
 * IPv6 or IPv4, by the local address of the candidate pair ICE selected: the transport's selectedCandidatePairId
 * (Chrome, Safari, the polyfill), else the pair marked selected (Firefox) or nominated and succeeded; then the
 * polyfill's own selectedCandidatePair(). IPv4 when nothing says (a hostname, stats not ready, or getStats() not
 * settling within `timeoutMs`: the link is open and must not wait on a label). Never rejects.
 */
export async function pairKind(pc: RtcPeerConnectionLike, timeoutMs = PAIR_KIND_TIMEOUT_MS): Promise<LinkKind> {
  try {
    // first: a getStats() that throws at once (or is missing) falls back without a timer ever being set
    const pending = pc.getStats();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const stats = await Promise.race([pending, late]).finally(() => clearTimeout(timer));
    if (!stats) throw new Error('getStats() did not settle');
    const byId = new Map<string, any>();
    stats.forEach((v) => {
      if (v && typeof v.id === 'string') byId.set(v.id, v);
    });
    let pair: any;
    for (const v of byId.values()) {
      if (v.type === 'transport' && typeof v.selectedCandidatePairId === 'string') pair = byId.get(v.selectedCandidatePairId);
    }
    if (!pair) {
      for (const v of byId.values()) {
        if (v.type === 'candidate-pair' && (v.selected === true || (v.nominated === true && v.state === 'succeeded'))) {
          pair = v;
          break;
        }
      }
    }
    const local = pair && typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : undefined;
    const kind = family(local?.address ?? local?.ip);
    if (kind) return kind;
  } catch {
    // stats are only a hint
  }
  try {
    const kind = family(pc.selectedCandidatePair?.()?.local?.address);
    if (kind) return kind;
  } catch {
    // nor is this
  }
  return 'p2p-v4';
}

function report(what: string, e: unknown): void {
  reportAs('p2p', what, e);
}

/**
 * One direct link over one connection and its "cw" channel, which it owns: it takes over the channel's and the
 * connection's state handlers from the start (an attempt that fails before opening ends the same way, onclose), and
 * closing the link closes both. dial() / Acceptor keep the negotiation (candidates, descriptions) to themselves.
 */
export class P2pLink implements Link {
  /** Set by dial() / Acceptor from pairKind() before the link is handed out. */
  kind: LinkKind = 'p2p-v4';
  onclose: (why: string) => void = () => {};
  /** For dial() / Acceptor: the channel opened (once; never after the link ended). Not part of Link. */
  onopen: () => void = () => {};

  private state: 'new' | 'open' | 'closed' = 'new';
  private handler: ((f: Uint8Array) => void) | null = null;
  private early: Uint8Array[] = [];
  private earlyBytes = 0;
  /** Messages (flag ‖ piece) not handed to the channel yet. */
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private qHead = 0;
  private queued = 0;
  /** The frame being put back together from MORE pieces. */
  private acc: Uint8Array = EMPTY;
  private accLen = 0;
  private grace: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly pc: RtcPeerConnectionLike, private readonly dc: RtcDataChannelLike) {
    try {
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = LOW_WATER;
    } catch (e) {
      report('channel setup', e);
    }
    dc.onopen = () => this.opened();
    dc.onmessage = (ev: { data?: unknown } | undefined) => this.onMessage(ev?.data);
    dc.onbufferedamountlow = () => this.flush(false);
    dc.onclose = () => this.end('the direct connection closed');
    dc.onerror = (ev: unknown) => this.end(`the direct connection failed: ${errText(ev) || 'data channel error'}`);
    pc.onconnectionstatechange = () => this.watch();
    pc.oniceconnectionstatechange = () => this.watch();
    // the PC side gets its channel already open (no open event follows); after the creator has set onopen
    if (dc.readyState === 'open') queueMicrotask(() => this.opened());
  }

  get onframe(): (f: Uint8Array) => void {
    return this.handler ?? (() => {});
  }

  /** Frames that arrived before the first handler was set are handed to it right away, in order. */
  set onframe(fn: (f: Uint8Array) => void) {
    this.handler = fn;
    const q = this.early;
    this.early = [];
    this.earlyBytes = 0;
    for (const f of q) this.emit(f);
  }

  isOpen(): boolean {
    return this.state === 'open';
  }

  send(frame: Uint8Array): void {
    if (this.state === 'closed') return;
    if (frame.length > MAX_FRAME_BYTES) throw new RangeError(`direct frame of ${frame.length} bytes is over ${MAX_FRAME_BYTES}`);
    const n = Math.max(1, Math.ceil(frame.length / P2P_PIECE_BYTES));
    // onclose later, never from inside the caller's own send()
    if (this.queued + frame.length + n > MAX_QUEUED_BYTES) {
      return this.shutdown(`more than ${MAX_QUEUED_BYTES} bytes waiting to be sent`, true);
    }
    if (this.queue.length - this.qHead + n > MAX_QUEUED_FRAMES) {
      return this.shutdown(`more than ${MAX_QUEUED_FRAMES} messages waiting to be sent`, true);
    }
    for (let i = 0; i < n; i++) {
      const piece = frame.subarray(i * P2P_PIECE_BYTES, (i + 1) * P2P_PIECE_BYTES);
      // a copy, never a view: the caller may reuse its bytes
      const m = new Uint8Array(1 + piece.length);
      m[0] = i === n - 1 ? P2P_FLAG.end : P2P_FLAG.more;
      m.set(piece, 1);
      this.queue.push(m);
      this.queued += m.length;
    }
    this.flush(true);
  }

  buffered(): number {
    if (this.state === 'closed') return 0;
    let inChannel = 0;
    try {
      inChannel = this.dc.bufferedAmount;
    } catch {
      // closing under us
    }
    return this.queued + (Number.isFinite(inChannel) ? inChannel : 0);
  }

  close(): void {
    if (this.state !== 'closed') this.stop();
  }

  private opened(): void {
    if (this.state !== 'new') return;
    this.state = 'open';
    // negotiation is over: nothing more to trickle, and no other channel is wanted on this connection
    this.pc.onicecandidate = null;
    this.pc.ondatachannel = (ev: { channel?: unknown } | undefined) => closeChannel(ev?.channel);
    try {
      this.onopen();
    } catch (e) {
      report('open handler', e);
    }
    this.flush(false);
  }

  private watch(): void {
    if (this.state === 'closed') return;
    let a: unknown;
    let b: unknown;
    try {
      a = this.pc.connectionState;
      b = this.pc.iceConnectionState;
    } catch {
      return;
    }
    if (a === 'failed' || b === 'failed') return this.end('the direct connection failed');
    if (a === 'closed' || b === 'closed') return this.end('the direct connection closed');
    if (a === 'disconnected' || b === 'disconnected') {
      this.grace ??= setTimeout(() => this.end(`the direct connection was lost for ${P2P_DISCONNECT_GRACE_MS} ms`), P2P_DISCONNECT_GRACE_MS);
    } else if (this.grace !== undefined) {
      clearTimeout(this.grace);
      this.grace = undefined;
    }
  }

  /** Hands queued messages to the channel while its own buffer is not backed up; bufferedamountlow resumes. */
  private flush(inSend: boolean): void {
    if (this.state !== 'open') return;
    while (this.qHead < this.queue.length) {
      let backed = 0;
      try {
        backed = this.dc.bufferedAmount;
      } catch {
        // closing under us: send() below says so
      }
      if (backed > HIGH_WATER) break;
      const m = this.queue[this.qHead];
      try {
        this.dc.send(m);
      } catch (e) {
        return this.shutdown(`sending failed: ${errText(e) || 'the channel refused the message'}`, inSend);
      }
      this.queue[this.qHead++] = EMPTY;
      this.queued -= m.length;
    }
    if (this.qHead === this.queue.length) {
      this.queue = [];
      this.qHead = 0;
    } else if (this.qHead >= 1024 && this.qHead * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.qHead);
      this.qHead = 0;
    }
  }

  private onMessage(data: unknown): void {
    if (this.state === 'closed') return;
    let b: Uint8Array;
    if (data instanceof ArrayBuffer) b = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) b = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return this.protocol('a message that is not binary');
    if (b.length === 0) return this.protocol('an empty message');
    const flag = b[0];
    const piece = b.subarray(1);
    if (flag !== P2P_FLAG.end && flag !== P2P_FLAG.more) return this.protocol(`unknown flag ${flag}`);
    // checked for every piece, the single-message frame included: it is what bounds a frame without a second piece
    if (piece.length > P2P_PIECE_BYTES) return this.protocol(`a piece of ${piece.length} bytes, over ${P2P_PIECE_BYTES}`);
    // a copy: the frame is the receiver's own, not a view sharing the message's buffer
    if (flag === P2P_FLAG.end && this.accLen === 0) return this.emit(piece.slice());
    if (flag === P2P_FLAG.more && piece.length === 0) return this.protocol('an empty piece');
    const need = this.accLen + piece.length;
    if (need > MAX_FRAME_BYTES) return this.shutdown(`the other side sent a frame over ${MAX_FRAME_BYTES} bytes`, false);
    if (need > this.acc.length) {
      // grown, not kept per piece: memory stays bounded by the frame cap however small the pieces are
      const next = new Uint8Array(Math.min(MAX_FRAME_BYTES, Math.max(need, this.acc.length * 2, 65_536)));
      next.set(this.acc.subarray(0, this.accLen));
      this.acc = next;
    }
    this.acc.set(piece, this.accLen);
    this.accLen = need;
    if (flag === P2P_FLAG.more) return;
    const f = this.acc.slice(0, this.accLen);
    this.acc = EMPTY;
    this.accLen = 0;
    this.emit(f);
  }

  private protocol(what: string): void {
    this.shutdown(`protocol: ${what}`, false);
  }

  private emit(f: Uint8Array): void {
    if (this.state === 'closed') return;
    if (!this.handler) {
      this.earlyBytes += f.length;
      this.early.push(f);
      if (this.earlyBytes > MAX_EARLY_BYTES || this.early.length > MAX_EARLY_FRAMES) {
        this.shutdown('frames arrived and nothing took them (onframe was never set)', false);
      }
      return;
    }
    try {
      this.handler(f);
    } catch (e) {
      report('frame handler', e);
    }
  }

  /** Ended on its own (not close()): tells the caller once. */
  private end(why: string): void {
    this.shutdown(why, false);
  }

  /** `later`: from inside the caller's own send(), onclose waits for a microtask instead of running re-entrantly. */
  private shutdown(why: string, later: boolean): void {
    if (this.state === 'closed') return;
    this.stop();
    const call = () => {
      try {
        this.onclose(why);
      } catch (e) {
        report('close handler', e);
      }
    };
    if (later) queueMicrotask(call);
    else call();
  }

  /** Drops every buffer and closes the channel and the connection (which tells the other side). */
  private stop(): void {
    this.state = 'closed';
    clearTimeout(this.grace);
    this.grace = undefined;
    this.queue = [];
    this.qHead = 0;
    this.queued = 0;
    this.acc = EMPTY;
    this.accLen = 0;
    this.early = [];
    this.earlyBytes = 0;
    const { pc, dc } = this;
    dc.onopen = dc.onmessage = dc.onbufferedamountlow = dc.onclose = dc.onerror = null;
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = pc.onicecandidate = null;
    pc.ondatachannel = (ev: { channel?: unknown } | undefined) => closeChannel(ev?.channel);
    closeRtc(pc, dc);
  }
}
