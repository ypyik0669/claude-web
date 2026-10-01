// Slow relay (慢速转发): a Link over the public MQTT brokers, for when no direct connection can be made (on mobile
// data that is the common case). Every packet is sealed with the session's relay key, numbered, and published to
// every relay broker at once; the receiver puts them back in order, drops the copies and acknowledges, and lost
// ones are sent again. Paced: at most maxPerSec packets a second leave each side, acks and resends included.
// Shared by the Node server and the phone shell, so Web-standard APIs only (no node:*, no Buffer).
//
// Wire format, one MQTT payload:
//   packet    = iv (12 bytes) ‖ AES-GCM(relay key, iv, AAD = topic, plaintext) (ciphertext ‖ 16-byte tag)
//   iv        = direction (1 up: phone → PC, 2 down: PC → phone) ‖ 0 ‖ 0 ‖ 0 ‖ sequence (8 bytes, big-endian)
//   sequence  = data packets: their seq (0 … 2^32 − 1); control packets (ack, close): 2^32 + their own counter
//   plaintext = seq u32 (the low half of the IV's sequence) ‖ ack u32 ‖ kind u8 ‖ data
// One key serves both directions, so the direction byte is what keeps their IVs apart. Within a direction every
// sequence is sealed once: a resend publishes the very same bytes (its ack is stale, which is harmless, acks only
// ever grow), so no IV ever covers two plaintexts.
//
// ack = the number of data packets received in order (the next seq expected). Kinds: 0 the last (or only) piece
// of a frame, 3 a piece the frame goes on from in the next seq, 1 ack only (data = a bitmap of the packets held
// past `ack`: bit i, LSB first, is seq ack + 1 + i), 2 close. A data-range kind this version does not know uses
// up its seq and delivers nothing; a control kind it does not know is ignored.
import type { Side } from './envelope.js';
import type { Room } from './keys.js';
import type { Link } from './link.js';
import type { Brokers } from './mqtt.js';

/** Most bytes of a frame in one packet; longer frames go in pieces. */
export const RELAY_MAX_DATA = 12_288;
const IV_BYTES = 12;
const HEAD_BYTES = 9;
const TAG_BYTES = 16;
const MIN_PACKET = IV_BYTES + HEAD_BYTES + TAG_BYTES;
/** Largest MQTT payload the link sends; anything longer arriving is junk. */
export const RELAY_MAX_PACKET = MIN_PACKET + RELAY_MAX_DATA;
/** Largest frame (channel frames are at most 16 389 bytes); a peer's frame growing past it ends the link. */
export const MAX_FRAME_BYTES = 1_048_576;
/** Bytes send() takes before the other side confirms them; past it the link ends (callers pause on buffered()). */
export const MAX_QUEUED_BYTES = 8 * MAX_FRAME_BYTES;
/** Packets waiting to be decrypted; a flood past it is dropped instead of queueing without bound. */
export const MAX_INBOX = 256;
/** The receiver holds up to max(window, MIN_REORDER) packets past a gap (≈ 0.8 MB at the default window). */
export const MIN_REORDER = 64;
const MAX_WINDOW = 256;
/** Frames held while no onframe is set yet. */
const MAX_EARLY_BYTES = MAX_FRAME_BYTES;
const MAX_EARLY_FRAMES = 1024;
/** The close packet goes out this many times (paced like the rest), so one lost copy does not lose it. */
const CLOSE_COPIES = 2;
const ACK_DELAY_MAX_MS = 200;
/**
 * How late a timer may fire and still have its packet's slot honored, so the rate holds on average: Windows rounds
 * timers up to its 15.6 ms clock tick, which would otherwise stretch every 50 ms gap to 62. Plus 1 ms: timers can
 * also fire up to 1 ms early by performance.now() (the event loop's clock is whole milliseconds).
 */
const TIMER_SLACK_MS = 16;
const EARLY_MS = 1;
const MAX_U32 = 0xffff_ffff;

export const RELAY_DIR = { up: 1, down: 2 } as const;
export const RELAY_KIND = { data: 0, ack: 1, close: 2, more: 3 } as const;
const DATA_RANGE = 0;
const CTRL_RANGE = 1;

const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMPTY = new Uint8Array(0);
const enc = new TextEncoder();
const now = () => performance.now();

/** The part of the pool a link uses (a Brokers fits). */
export type RelayBrokers = Pick<Brokers, 'subscribe' | 'unsubscribe' | 'publish'>;

export interface RelayLinkOptions {
  brokers: RelayBrokers;
  room: Room;
  /** The session id from signaling; it becomes part of the topics, so letters, digits, - and _ only (≤ 64). */
  session: string;
  side: Side;
  /** relayKey(room, phone nonce, PC nonce). */
  key: CryptoKey;
  /** Packets this side publishes per second, acks, resends and keepalives included (20). */
  maxPerSec?: number;
  /** Packets sent and not yet confirmed before new ones wait (32). */
  window?: number;
  /** The oldest unconfirmed packet is sent again after this long (1 500 ms). */
  retransmitMs?: number;
  /** Nothing heard from the other side for this long ends the link (30 000 ms); an idle side sends a keepalive every third of it. */
  deadMs?: number;
}

export function relayTopics(room: Room, session: string): { up: string; down: string } {
  return { up: `${room.topic}/r/${session}/up`, down: `${room.topic}/r/${session}/down` };
}

function checkU32(n: number, what: string): void {
  // DataView.setUint32 wraps silently, and a wrapped sequence is an IV already used
  if (!Number.isInteger(n) || n < 0 || n > MAX_U32) throw new RangeError(`${what} must be an integer in 0..0xffffffff, got ${n}`);
}

/** dir ‖ 0 ‖ 0 ‖ 0 ‖ the 8-byte sequence hi·2^32 + lo. */
export function relayIv(dir: number, hi: number, lo: number): Uint8Array<ArrayBuffer> {
  checkU32(hi, 'sequence high half');
  checkU32(lo, 'sequence');
  const iv = new Uint8Array(IV_BYTES);
  const v = new DataView(iv.buffer);
  iv[0] = dir;
  v.setUint32(4, hi);
  v.setUint32(8, lo);
  return iv;
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

async function seal(
  key: CryptoKey, aad: Uint8Array<ArrayBuffer>, dir: number, hi: number, lo: number, ack: number, kind: number, data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = relayIv(dir, hi, lo);
  const pt = new Uint8Array(HEAD_BYTES + data.length);
  const v = new DataView(pt.buffer);
  v.setUint32(0, lo);
  v.setUint32(4, ack);
  v.setUint8(8, kind);
  pt.set(data, HEAD_BYTES);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, pt));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv);
  out.set(ct, IV_BYTES);
  return out;
}

interface Packet {
  ctrl: boolean;
  seq: number;
  ack: number;
  kind: number;
  data: Uint8Array;
}

/** Null for anything that does not decrypt under this key and topic, or whose plaintext disagrees with its IV. */
async function openPacket(key: CryptoKey, aad: Uint8Array<ArrayBuffer>, w: Uint8Array<ArrayBuffer>): Promise<Packet | null> {
  let pt: Uint8Array;
  try {
    pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: w.subarray(0, IV_BYTES), additionalData: aad }, key, w.subarray(IV_BYTES)));
  } catch {
    return null;
  }
  const seq = u32(w, 8);
  if (pt.length < HEAD_BYTES || u32(pt, 0) !== seq) return null;
  return { ctrl: u32(w, 4) === CTRL_RANGE, seq, ack: u32(pt, 4), kind: pt[8], data: pt.subarray(HEAD_BYTES) };
}

function concat(parts: Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A bug in a callback must not tear the link down, nor escape into the pool's callback or a timer. */
function report(what: string, e: unknown): void {
  console.error(`[relay] ${what} threw`, e);
}

function option(v: number | undefined, def: number, min: number, max: number, what: string, int = false): number {
  if (v === undefined) return def;
  if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
    throw new RangeError(`${what} must be ${int ? 'an integer ' : ''}in ${min}..${max}, got ${v}`);
  }
  return v;
}

interface Sent {
  seq: number;
  wire: Uint8Array<ArrayBuffer>;
  /** Frame bytes it carries (for buffered()). */
  bytes: number;
  /** Last time it went out. */
  sentAt: number;
  /** The other side reported holding it (past a gap). */
  sacked: boolean;
}

interface Held {
  kind: number;
  data: Uint8Array;
}

type Job = 'close' | 'data' | 'ack' | Sent;

/** Inbound topics with an open link, per pool: a pool keeps one callback per topic, a second link would take it. */
const inUse = new WeakMap<RelayBrokers, Set<string>>();
/**
 * Outbound topics each key has sealed for, for as long as the key lives. A second link on the same session and
 * direction would number from 0 again under the same key: the same IVs over other plaintexts, which gives away both
 * plaintexts' XOR and GCM's authentication key. A new session (new hello / ack) derives a new key.
 */
const sealedFor = new WeakMap<CryptoKey, Set<string>>();

class RelayLink implements Link {
  readonly kind = 'relay' as const;
  onclose: (why: string) => void = () => {};

  private state: 'open' | 'closing' | 'closed' = 'open';
  private readonly brokers: RelayBrokers;
  private readonly key: CryptoKey;
  private readonly inTopic: string;
  private readonly outTopic: string;
  private readonly inAad: Uint8Array<ArrayBuffer>;
  private readonly outAad: Uint8Array<ArrayBuffer>;
  private readonly inDir: number;
  private readonly outDir: number;
  private readonly interval: number;
  private readonly window: number;
  private readonly slots: number;
  private readonly rto: number;
  /** A packet counts as lost once one sent this much later got through (brokers may reorder a little). */
  private readonly reo: number;
  private readonly ackDelay: number;
  private readonly ackEvery: number;
  private readonly deadMs: number;
  private readonly keepaliveMs: number;

  // pacing: one timer for everything, every packet leaves from step(). GCRA: packet n's slot is tat, each send
  // moves tat one interval on, and a packet may leave up to `slack` before its slot. So a late timer is made up
  // for by the next gap, and any T ms window holds at most 1 + (T + slack) / interval packets: 41 in 2 s at 20/s.
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = Infinity;
  private busy = false;
  private tat = -Infinity;
  private readonly slack: number;
  private lastOut: number;

  // sending
  private queue: Uint8Array[] = [];
  private qHead = 0;
  private qOff = 0;
  /** Bytes send() took that are not confirmed yet. */
  private pending = 0;
  private nextSeq = 0;
  /** Sent, not yet covered by the other side's ack; out[i].seq === sendBase + i. */
  private out: Sent[] = [];
  private sendBase = 0;
  /** Latest send time of any packet known to have arrived. */
  private rackAt = -Infinity;
  private ctrl = 0;
  private closeLeft = 0;

  // receiving
  private recvNext = 0;
  private readonly held = new Map<number, Held>();
  private parts: Uint8Array[] = [];
  private partsBytes = 0;
  /** Highest control counter opened: older ones (copies, replays) are dropped before decrypting. */
  private ctrlMax = -1;
  private lastHeard: number;
  private lastNewAt = -Infinity;
  private lastAckAt = -Infinity;
  private ackDueAt = Infinity;
  /** New data packets since an ack last went out. */
  private unacked = 0;
  private inbox: Promise<void> = Promise.resolve();
  private inboxN = 0;
  private handler: ((f: Uint8Array) => void) | null = null;
  private early: Uint8Array[] = [];
  private earlyBytes = 0;

  constructor(o: RelayLinkOptions, inTopic: string, outTopic: string) {
    this.brokers = o.brokers;
    this.key = o.key;
    this.inTopic = inTopic;
    this.outTopic = outTopic;
    this.inAad = enc.encode(inTopic);
    this.outAad = enc.encode(outTopic);
    this.outDir = o.side === 'phone' ? RELAY_DIR.up : RELAY_DIR.down;
    this.inDir = o.side === 'phone' ? RELAY_DIR.down : RELAY_DIR.up;
    this.interval = 1000 / option(o.maxPerSec, 20, 0.1, 1000, 'maxPerSec');
    // half an interval at the default 20/s (25 of 50 ms): + EARLY_MS that is still under one interval, so a 2 s
    // window holds 41, the same as strict spacing would; never under one timer tick, for the faster rates
    this.slack = Math.max(this.interval / 2, TIMER_SLACK_MS);
    this.window = option(o.window, 32, 1, MAX_WINDOW, 'window', true);
    this.slots = Math.max(this.window, MIN_REORDER);
    this.rto = option(o.retransmitMs, 1500, 10, 600_000, 'retransmitMs');
    this.reo = this.rto / 8;
    this.ackDelay = Math.min(ACK_DELAY_MAX_MS, this.rto / 4);
    this.ackEvery = Math.max(1, Math.floor(this.window / 4));
    this.deadMs = option(o.deadMs, 30_000, 100, 86_400_000, 'deadMs');
    this.keepaliveMs = this.deadMs / 3;
    this.lastHeard = this.lastOut = now();
    this.arm(this.wake(now()));
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

  send(frame: Uint8Array): void {
    if (this.state !== 'open') return;
    if (frame.length > MAX_FRAME_BYTES) throw new RangeError(`relay frame of ${frame.length} bytes is over ${MAX_FRAME_BYTES}`);
    if (this.pending + frame.length > MAX_QUEUED_BYTES) {
      return this.shutdown(`more than ${MAX_QUEUED_BYTES} bytes waiting to be sent`, true);
    }
    // a copy, never a view (Buffer#slice would be one): the caller may reuse its bytes
    this.queue.push(new Uint8Array(frame));
    this.pending += frame.length;
    this.kick();
  }

  buffered(): number {
    return this.state === 'open' ? this.pending : 0;
  }

  close(): void {
    if (this.state === 'open') this.stop(true);
  }

  /** Never opened: nobody to tell. */
  discard(): void {
    if (this.state === 'open') this.stop(false);
  }

  /** The pool's callback for the inbound topic: anything can arrive here, nothing may throw back into it. */
  readonly deliver = (payload: Uint8Array): void => {
    try {
      if (this.state !== 'open' || this.inboxN >= MAX_INBOX || !this.worth(payload)) return;
      // WebCrypto wants ArrayBuffer-backed bytes (the pool hands over its own copy, which is)
      const w = payload.buffer instanceof ArrayBuffer ? (payload as Uint8Array<ArrayBuffer>) : new Uint8Array(payload);
      this.inboxN++;
      // one at a time, in arrival order: a broker's copy is checked only after its twin was handled
      this.inbox = this.inbox.then(() => this.handle(w)).catch((e) => report('packet handling', e));
    } catch (e) {
      report('packet', e);
    }
  };

  /**
   * Cheap checks before decrypting: shape, direction, and whether it is news. Only authenticated state is used to
   * call something old (a seq already delivered or held, a control counter already opened): remembering anything
   * from a packet that did not open would let junk published under a real IV get the real one skipped.
   */
  private worth(w: Uint8Array): boolean {
    if (w.length < MIN_PACKET || w.length > RELAY_MAX_PACKET) return false;
    if (w[0] !== this.inDir || w[1] !== 0 || w[2] !== 0 || w[3] !== 0) return false;
    const hi = u32(w, 4);
    const lo = u32(w, 8);
    if (hi === DATA_RANGE) {
      if (lo < this.recvNext || this.held.has(lo)) {
        this.dup();
        return false;
      }
      return lo < this.recvNext + this.slots;
    }
    return hi === CTRL_RANGE && lo > this.ctrlMax;
  }

  private async handle(w: Uint8Array<ArrayBuffer>): Promise<void> {
    try {
      // again: its twin from another broker may have been handled while this one waited
      if (this.state !== 'open' || !this.worth(w)) return;
      const p = await openPacket(this.key, this.inAad, w);
      if (!p || this.state !== 'open') return;
      if (p.ctrl) {
        this.ctrlMax = p.seq;
        this.lastHeard = now();
        this.onAck(p.ack, p.kind === RELAY_KIND.ack ? p.data : null);
        if (p.kind === RELAY_KIND.close) this.shutdown('the other side closed the link', false);
        return;
      }
      this.onAck(p.ack, null);
      this.onData(p.seq, p.kind, p.data);
    } finally {
      this.inboxN--;
    }
  }

  private onAck(ack: number, sack: Uint8Array | null): void {
    const end = this.sendBase + this.out.length;
    // confirms something never sent: not ours to believe
    if (ack > end) return;
    let moved = false;
    if (ack > this.sendBase) {
      for (const e of this.out.splice(0, ack - this.sendBase)) {
        this.pending -= e.bytes;
        if (e.sentAt > this.rackAt) this.rackAt = e.sentAt;
      }
      this.sendBase = ack;
      moved = true;
    }
    if (sack) {
      // at most one bit per packet the window allows
      const bits = Math.min(sack.length * 8, MAX_WINDOW);
      for (let i = 0; i < bits; i++) {
        if (!(sack[i >> 3] & (1 << (i & 7)))) continue;
        const seq = ack + 1 + i;
        if (seq >= end) break;
        if (seq < this.sendBase) continue;
        const e = this.out[seq - this.sendBase];
        if (e.sacked) continue;
        e.sacked = true;
        if (e.sentAt > this.rackAt) this.rackAt = e.sentAt;
        moved = true;
      }
    }
    if (moved) this.kick();
  }

  private onData(seq: number, kind: number, data: Uint8Array): void {
    if (seq < this.recvNext || this.held.has(seq) || seq >= this.recvNext + this.slots) return;
    const t = now();
    this.lastHeard = this.lastNewAt = t;
    this.unacked++;
    if (seq !== this.recvNext) {
      this.held.set(seq, { kind, data });
    } else {
      this.take(kind, data);
      this.recvNext++;
      for (let h = this.held.get(this.recvNext); h && this.state === 'open'; h = this.held.get(this.recvNext)) {
        this.held.delete(this.recvNext);
        this.take(h.kind, h.data);
        this.recvNext++;
      }
    }
    if (this.state !== 'open') return;
    this.ackDueAt = Math.min(this.ackDueAt, this.unacked >= this.ackEvery ? t : t + this.ackDelay);
    this.arm(this.ackDueAt);
  }

  /**
   * A copy of something already delivered or held. Right after new data (or our ack) it is just another broker's
   * twin; when the other side keeps sending it, it did not get our ack: send one again soon.
   */
  private dup(): void {
    const t = now();
    if (t - Math.max(this.lastAckAt, this.lastNewAt) < this.rto / 2) return;
    this.ackDueAt = Math.min(this.ackDueAt, t);
    this.arm(t);
  }

  private take(kind: number, data: Uint8Array): void {
    // a kind this version does not know: its slot is used up, there is nothing to deliver
    if (kind !== RELAY_KIND.data && kind !== RELAY_KIND.more) return;
    if (kind === RELAY_KIND.data && this.parts.length === 0) return this.emit(data);
    this.partsBytes += data.length;
    if (this.partsBytes > MAX_FRAME_BYTES) {
      return this.shutdown(`the other side sent a frame over ${MAX_FRAME_BYTES} bytes`, true);
    }
    this.parts.push(data);
    if (kind === RELAY_KIND.more) return;
    const f = concat(this.parts, this.partsBytes);
    this.parts = [];
    this.partsBytes = 0;
    this.emit(f);
  }

  private emit(f: Uint8Array): void {
    if (this.state !== 'open') return;
    if (!this.handler) {
      this.earlyBytes += f.length;
      this.early.push(f);
      if (this.earlyBytes > MAX_EARLY_BYTES || this.early.length > MAX_EARLY_FRAMES) {
        this.shutdown('frames arrived and nothing took them (onframe was never set)', true);
      }
      return;
    }
    try {
      this.handler(f);
    } catch (e) {
      report('frame handler', e);
    }
  }

  // ---- pacing ----

  /** When the next packet may leave. */
  private allowedAt(): number {
    return this.tat - this.slack;
  }

  /** Runs step() at `at`, but never before the next packet may leave. */
  private arm(at: number): void {
    if (this.state === 'closed' || this.busy) return; // a running step re-arms when it is done
    const when = Math.max(at, this.allowedAt());
    if (this.timer !== undefined) {
      if (this.timerAt <= when) return;
      clearTimeout(this.timer);
    }
    this.timerAt = when;
    this.timer = setTimeout(this.fire, Math.max(0, when - now()));
  }

  private readonly fire = (): void => {
    this.timer = undefined;
    this.timerAt = Infinity;
    this.step().catch((e) => report('send step', e));
  };

  private kick(): void {
    this.arm(now());
  }

  private async step(): Promise<void> {
    if (this.busy || this.state === 'closed') return;
    const t = now();
    if (this.state === 'open' && this.lastHeard + this.deadMs <= t) {
      return this.shutdown(`nothing heard from the other side for ${this.deadMs} ms`, true);
    }
    // fired early by the event loop's whole-millisecond clock: go now rather than wait another tick
    if (t + EARLY_MS < this.allowedAt()) return this.arm(t);
    const job = this.pick(t);
    if (!job) return this.arm(this.wake(t));
    if (typeof job === 'object') {
      // a resend: the same bytes as the first time
      job.sentAt = this.publish(job.wire);
      return this.arm(this.wake(now()));
    }
    this.busy = true;
    let failed: unknown;
    try {
      if (job === 'data') await this.sendData();
      else if (job === 'ack') await this.sendAck();
      else await this.sendClose();
    } catch (e) {
      failed = e;
    } finally {
      this.busy = false;
    }
    // ended while sealing (a close packet that made the other side's link go, or a shutdown from a callback)
    if (this.ended()) return;
    if (failed !== undefined) {
      // only sealing can throw: the sequence space used up, or WebCrypto refusing the key
      if (this.state === 'open') return this.shutdown(`sending failed: ${failed instanceof Error ? failed.message : String(failed)}`, true);
      return this.finish();
    }
    if (this.state === 'closing' && this.closeLeft === 0) return this.finish();
    this.arm(this.wake(now()));
  }

  /** What to send now, most urgent first: close, a resend, an ack with gaps to report, new data, an ack. */
  private pick(t: number): Job | null {
    if (this.state === 'closing') return this.closeLeft > 0 ? 'close' : null;
    const lost = this.due(t);
    if (lost) return lost;
    const ackDue = this.ackDueAt <= t;
    // data packets have no room for the gap bitmap, only an ack-only packet carries it
    if (ackDue && this.held.size > 0) return 'ack';
    if (this.qHead < this.queue.length && this.nextSeq - this.sendBase < this.window) return 'data';
    if (ackDue || this.lastOut + this.keepaliveMs <= t) return 'ack';
    return null;
  }

  /**
   * The packet to send again, if any: one that a packet sent later than it overtook (the other side confirmed the
   * later one), or the oldest unconfirmed one after retransmitMs without news. Only the oldest times out, so a
   * long silence costs one resend per retransmitMs, not the whole window.
   */
  private due(t: number): Sent | null {
    let first = true;
    for (const e of this.out) {
      if (e.sacked) continue;
      if (e.sentAt + this.reo < this.rackAt) return e;
      if (first && e.sentAt + this.rto <= t) return e;
      first = false;
    }
    return null;
  }

  /** Earliest time pick() could find something (after step() found nothing at `t`). */
  private wake(t: number): number {
    // an ack that came in while a packet was being sealed may have shown others lost
    if (this.state === 'closing' || this.due(t)) return t;
    let at = Math.min(this.ackDueAt, this.lastOut + this.keepaliveMs, this.lastHeard + this.deadMs);
    const oldest = this.out.find((e) => !e.sacked);
    if (oldest) at = Math.min(at, oldest.sentAt + this.rto);
    if (this.qHead < this.queue.length && this.nextSeq - this.sendBase < this.window) at = t;
    return at;
  }

  /** Returns the send time. A publish no broker took is just a lost packet: the resend timeout covers it. */
  private publish(wire: Uint8Array<ArrayBuffer>): number {
    try {
      this.brokers.publish(this.outTopic, wire, { relayOnly: true });
    } catch (e) {
      report('publish', e);
    }
    const t = now();
    // after a pause the slots start again from now: idle time is not saved up for a burst
    this.tat = Math.max(this.tat, t) + this.interval;
    return t;
  }

  /**
   * A packet the other side will count as news went out, with our current ack. Not for resends: their ack is
   * stale, and the other side drops them before decrypting, so they neither ack nor keep the link alive.
   */
  private fresh(t: number): void {
    this.lastOut = this.lastAckAt = t;
  }

  private nextSegment(): Held {
    const f = this.queue[this.qHead];
    const n = Math.min(RELAY_MAX_DATA, f.length - this.qOff);
    const data = f.subarray(this.qOff, this.qOff + n);
    this.qOff += n;
    if (this.qOff < f.length) return { kind: RELAY_KIND.more, data };
    // let go of the frame (the segment's view keeps it until it is sealed)
    this.queue[this.qHead++] = EMPTY;
    this.qOff = 0;
    if (this.qHead >= 64 && this.qHead * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.qHead);
      this.qHead = 0;
    }
    return { kind: RELAY_KIND.data, data };
  }

  private async sendData(): Promise<void> {
    const seg = this.nextSegment();
    // taken now, before sealing: whatever happens next, this seq is never sealed again
    const seq = this.nextSeq++;
    const ack = this.recvNext;
    // with a gap the ack-only packet (with its bitmap) is still owed
    if (this.held.size === 0) this.ackSent();
    const wire = await seal(this.key, this.outAad, this.outDir, DATA_RANGE, seq, ack, seg.kind, seg.data);
    // closed while sealing: dropped unsent, and the seq stays used
    if (this.state !== 'open') return;
    const e: Sent = { seq, wire, bytes: seg.data.length, sentAt: 0, sacked: false };
    this.out.push(e);
    this.fresh((e.sentAt = this.publish(wire)));
  }

  private async sendAck(): Promise<void> {
    const ack = this.recvNext;
    const sack = this.gaps();
    this.ackSent();
    const wire = await seal(this.key, this.outAad, this.outDir, CTRL_RANGE, this.nextCtrl(), ack, RELAY_KIND.ack, sack);
    if (this.state === 'open') this.fresh(this.publish(wire));
  }

  private async sendClose(): Promise<void> {
    const wire = await seal(this.key, this.outAad, this.outDir, CTRL_RANGE, this.nextCtrl(), this.recvNext, RELAY_KIND.close, EMPTY);
    if (this.state !== 'closing') return;
    this.fresh(this.publish(wire));
    this.closeLeft--;
  }

  /** What arrives while the ack is being sealed sets a new due time of its own. */
  private ackSent(): void {
    this.ackDueAt = Infinity;
    this.unacked = 0;
  }

  private nextCtrl(): number {
    checkU32(this.ctrl, 'control counter');
    return this.ctrl++;
  }

  /** Bitmap of the packets held past recvNext: bit i is seq recvNext + 1 + i. */
  private gaps(): Uint8Array {
    if (this.held.size === 0) return EMPTY;
    let top = 0;
    for (const s of this.held.keys()) top = Math.max(top, s - this.recvNext - 1);
    const bits = new Uint8Array((top >> 3) + 1);
    for (const s of this.held.keys()) {
      const i = s - this.recvNext - 1;
      bits[i >> 3] |= 1 << (i & 7);
    }
    return bits;
  }

  // ---- ending ----

  /** Ends for a reason of its own (not close()): tells the caller once, and the other side if it may still listen. */
  private shutdown(why: string, tellPeer: boolean): void {
    if (this.state !== 'open') return;
    this.stop(tellPeer);
    try {
      this.onclose(why);
    } catch (e) {
      report('close handler', e);
    }
  }

  /** Stops receiving and drops every buffer at once; the close packets, if any, still leave paced. */
  private stop(tellPeer: boolean): void {
    this.state = tellPeer ? 'closing' : 'closed';
    inUse.get(this.brokers)?.delete(this.inTopic);
    try {
      this.brokers.unsubscribe(this.inTopic);
    } catch (e) {
      report('unsubscribe', e);
    }
    this.queue = [];
    this.qHead = this.qOff = 0;
    this.out = [];
    this.pending = 0;
    this.held.clear();
    this.parts = [];
    this.partsBytes = 0;
    this.early = [];
    this.earlyBytes = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = Infinity;
    if (tellPeer) {
      this.closeLeft = CLOSE_COPIES;
      this.kick();
    }
  }

  /** A method, not a field read: callers check it after an await, which TypeScript's narrowing does not see. */
  private ended(): boolean {
    return this.state === 'closed';
  }

  private finish(): void {
    this.state = 'closed';
    clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = Infinity;
  }
}

/**
 * Opens this side of a relay session: subscribes the inbound topic and returns at once when that is confirmed, or
 * when no broker that is up or dialing can confirm it (every broker down: it does not wait, the pool resubscribes
 * when one comes back, and what was sent meanwhile is sent again). The two sides may open in either order.
 */
export async function openRelayLink(opts: RelayLinkOptions): Promise<Link> {
  if (typeof opts.session !== 'string' || !SESSION_RE.test(opts.session)) {
    throw new Error(`relay session id must be 1..64 of [A-Za-z0-9_-], got ${JSON.stringify(opts.session)}`);
  }
  if (opts.side !== 'phone' && opts.side !== 'pc') throw new Error(`relay side must be phone or pc, got ${JSON.stringify(opts.side)}`);
  const { up, down } = relayTopics(opts.room, opts.session);
  const [inTopic, outTopic] = opts.side === 'phone' ? [down, up] : [up, down];
  let topics = inUse.get(opts.brokers);
  if (!topics) inUse.set(opts.brokers, (topics = new Set()));
  if (topics.has(inTopic)) throw new Error(`relay session ${opts.session} is already open on the ${opts.side} side of this pool`);
  let sealed = sealedFor.get(opts.key);
  if (!sealed) sealedFor.set(opts.key, (sealed = new Set()));
  if (sealed.has(outTopic)) {
    throw new Error(`relay key already used for session ${opts.session} from the ${opts.side} side: reopening would repeat IVs, derive a new key`);
  }
  // before anything can fail half-way: option errors throw here, with nothing subscribed or reserved yet
  const link = new RelayLink(opts, inTopic, outTopic);
  topics.add(inTopic);
  sealed.add(outTopic);
  try {
    await opts.brokers.subscribe(inTopic, link.deliver);
  } catch (e) {
    link.discard();
    throw e;
  }
  return link;
}
