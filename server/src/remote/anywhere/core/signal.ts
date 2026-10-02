// Sealed signaling channel (牵线频道): one room's envelopes over the broker pool. Every message goes to all
// brokers that are up, so it usually comes back once per broker (and to ourselves); the envelope's nonce makes
// sure each one is handed to the listeners once. Shared by the Node server and the phone shell, so Web-standard
// APIs only (no node:*, no Buffer).
import { ReplayGuard, openEnvelope, seal, type Side, type SignalMsg, type SignalType } from './envelope.js';
import { report as reportAs } from './handshake.js';
import type { Room } from './keys.js';
import type { Brokers } from './mqtt.js';

/**
 * What send() takes: seal() fills in v / n / ts and the channel fills in `from`. Spelled out for the same reason
 * as SignalDraft (Omit over an index signature drops t / s).
 */
export interface SignalOut {
  t: SignalType;
  s: string;
  [k: string]: unknown;
}

/** The part of the pool a channel uses (a Brokers fits). */
export type SignalBrokers = Pick<Brokers, 'subscribe' | 'unsubscribe' | 'publish'>;

/**
 * Cap on one envelope, checked on the raw payload before anything is decoded or decrypted: the brokers are public
 * and anyone can publish megabytes onto a topic. Signaling messages are small (an SDP offer is a few KB).
 */
export const MAX_ENVELOPE_BYTES = 65_536;
/** Envelopes waiting to be opened per channel; past this a flood is dropped instead of queueing without bound. */
export const MAX_PENDING = 256;
/** The 12-byte IV is exactly the first 16 base64url characters (whole 3-byte groups: one spelling per IV). */
const IV_CHARS = 16;
/** IVs of envelopes already handled, so copies from the other brokers are dropped without a decrypt. */
const RECENT_IVS = 2048;

const CLOSED = 'signal channel closed';
const dec = new TextDecoder();

/** Insertion-ordered set that forgets its oldest entries past `cap`. */
class Recent {
  private readonly keys = new Set<string>();

  constructor(private readonly cap: number) {}

  has(k: string): boolean {
    return this.keys.has(k);
  }

  add(k: string): void {
    if (this.keys.has(k)) return;
    this.keys.add(k);
    if (this.keys.size > this.cap) this.keys.delete(this.keys.values().next().value as string);
  }
}

interface Shared {
  members: Set<SignalChannel>;
  deliver: (payload: Uint8Array) => void;
}

/**
 * One subscription per pool and topic, shared by every open channel of that room on the pool. A pool keeps one
 * callback per topic, so channels subscribing on their own would take it from each other (two overlapping dials
 * on the phone across a network change, or both sides in one process): each raw delivery is fanned out to every
 * member instead, and the topic is unsubscribed when the last one closes.
 */
const shared = new WeakMap<SignalBrokers, Map<string, Shared>>();

/** A listener bug must not stop the other listeners or later messages, nor escape into the pool's callback. */
function report(what: string, e: unknown): void {
  reportAs('signal', what, e);
}

/**
 * Order: listeners get messages in the order their first copy arrived, and send() publishes in call order. The
 * brokers are QoS 0 and independent (one may drop or lag), so that is not the sender's order: a candidate can
 * still arrive before its offer, or not at all, and callers must cope with both.
 */
export class SignalChannel {
  /** Per channel (one per room in use): a busy shared guard would evict nonces sooner and let replays through. */
  private readonly guard = new ReplayGuard();
  private readonly ivs = new Recent(RECENT_IVS);
  private readonly listeners = new Set<(m: SignalMsg) => void>();
  private closed = false;
  private opened: Promise<void> | undefined;
  private pending = 0;
  // Inbound envelopes are opened one at a time, in arrival order (WebCrypto may finish overlapping decrypts out of
  // order); outbound ones are sealed and published one at a time, in send() order.
  private inbox: Promise<void> = Promise.resolve();
  private outbox: Promise<void> = Promise.resolve();

  constructor(private readonly brokers: SignalBrokers, private readonly room: Room, private readonly self: Side) {}

  /**
   * Subscribes the room's topic. Resolves once a broker confirmed it, or once none that is up or dialing can (all
   * unreachable: it does not wait for redials, the pool resubscribes when one comes back); check the pool's
   * status() to tell the two apart. Rejects if close() comes first. Messages that arrive while nobody listens
   * (on()) are dropped.
   */
  open(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(CLOSED));
    if (!this.opened) {
      let topics = shared.get(this.brokers);
      if (!topics) shared.set(this.brokers, (topics = new Map()));
      let sh = topics.get(this.room.topic);
      if (!sh) {
        const members = new Set<SignalChannel>();
        sh = {
          members,
          deliver: (payload) => {
            if (payload.length > MAX_ENVELOPE_BYTES) return;
            // not fatal: bytes that are not UTF-8 just fail the base64url check in openEnvelope
            const raw = dec.decode(payload);
            for (const ch of [...members]) ch.receive(raw);
          },
        };
        topics.set(this.room.topic, sh);
      }
      sh.members.add(this);
      // the same callback again: this just waits for the topic to be confirmed (at once if it already is)
      this.opened = this.brokers.subscribe(this.room.topic, sh.deliver).then(() => {
        if (this.closed) throw new Error(`${CLOSED} before its subscription was confirmed`);
      });
    }
    return this.opened;
  }

  /**
   * Seals and publishes to every broker that is up, in the order send() was called. Rejects when no broker took
   * it (nothing was sent), when the envelope would be over MAX_ENVELOPE_BYTES, or after close().
   */
  send(msg: SignalOut): Promise<void> {
    const p = this.outbox.then(() => this.sendNow(msg));
    this.outbox = p.catch(() => {});
    return p;
  }

  /** Each message from the other side, once. Returns the off switch. */
  on(cb: (m: SignalMsg) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** For good: no more callbacks (not even for a message still being decrypted), send() and open() reject. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    const topics = shared.get(this.brokers);
    const sh = topics?.get(this.room.topic);
    if (topics && sh?.members.delete(this) && sh.members.size === 0) {
      topics.delete(this.room.topic);
      this.brokers.unsubscribe(this.room.topic);
    }
  }

  private async sendNow(msg: SignalOut): Promise<void> {
    if (this.closed) throw new Error(CLOSED);
    // ours wins over a `from` smuggled in through the index signature
    const raw = await seal(this.room, { ...msg, from: this.self });
    if (raw.length > MAX_ENVELOPE_BYTES) {
      throw new Error(`signal message too large (${raw.length} > ${MAX_ENVELOPE_BYTES} bytes)`);
    }
    if (this.closed) throw new Error(CLOSED);
    // our own IV, not an attacker's: the brokers' echoes of this message are dropped without a decrypt
    this.ivs.add(raw.slice(0, IV_CHARS));
    if (this.brokers.publish(this.room.topic, raw) === 0) {
      throw new Error('signal message not sent: no broker took it (none connected, or all backed up)');
    }
  }

  /** From the shared pool callback: anything can arrive here, nothing may throw back into it. */
  private receive(raw: string): void {
    if (this.closed || this.pending >= MAX_PENDING) return;
    this.pending++;
    // handle() does not throw (openEnvelope never does, listeners are caught); the catch keeps the chain alive anyway
    this.inbox = this.inbox.then(() => this.handle(raw)).catch((e) => report('message handling', e));
  }

  private async handle(raw: string): Promise<void> {
    try {
      if (this.closed) return;
      const iv = raw.slice(0, IV_CHARS);
      // another broker's copy of an envelope already opened (or our own echo)
      if (this.ivs.has(iv)) return;
      // null for tampered, foreign-room, stale, replayed and our own echo
      const msg = await openEnvelope(this.room, raw, this.self, this.guard);
      if (!msg) return;
      // only once it opened: remembering an IV before that would let anyone who saw it on one broker publish junk
      // under it on another and get the real envelope skipped
      this.ivs.add(iv);
      if (this.closed) return;
      for (const cb of [...this.listeners]) {
        try {
          cb(msg);
        } catch (e) {
          report('listener', e);
        }
      }
    } finally {
      this.pending--;
    }
  }
}
