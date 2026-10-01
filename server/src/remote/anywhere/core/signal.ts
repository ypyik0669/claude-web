// Sealed signaling channel (牵线频道): one room's envelopes over the broker pool. Every message goes to all
// brokers that are up, so it usually comes back once per broker (and to ourselves); the envelope's nonce makes
// sure each one is handed to the listeners once. Shared by the Node server and the phone shell, so Web-standard
// APIs only (no node:*, no Buffer).
import { ReplayGuard, openEnvelope, seal, type Side, type SignalMsg, type SignalType } from './envelope.js';
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

const CLOSED = 'signal channel closed';
const dec = new TextDecoder();

/**
 * Which channel holds each topic on each pool. A pool keeps one callback per topic and the newest open() takes it
 * over, so closing a channel that was already replaced (the PC re-creating a device's channel) must not
 * unsubscribe its successor.
 */
const holders = new WeakMap<SignalBrokers, Map<string, SignalChannel>>();

/** A listener bug must not stop the other listeners or later messages, nor escape into the pool's callback. */
function report(what: string, e: unknown): void {
  console.error(`[signal] ${what} threw`, e);
}

export class SignalChannel {
  /** Per room (one channel per room): a busy shared guard would evict nonces sooner and let replays through. */
  private readonly guard = new ReplayGuard();
  private readonly listeners = new Set<(m: SignalMsg) => void>();
  private closed = false;
  private opened: Promise<void> | undefined;
  // Both directions are handled one message at a time: WebCrypto may finish out of order, and a candidate that
  // overtakes its offer would be needless trouble for the caller.
  private inbox: Promise<void> = Promise.resolve();
  private outbox: Promise<void> = Promise.resolve();

  constructor(private readonly brokers: SignalBrokers, private readonly room: Room, private readonly self: Side) {}

  /**
   * Subscribes the room's topic. Resolves once a broker confirmed it, or once none that is up or dialing can (all
   * unreachable: it does not wait for redials, the pool resubscribes when one comes back); check the pool's
   * status() to tell the two apart. Messages that arrive while nobody listens (on()) are dropped.
   */
  open(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(CLOSED));
    if (!this.opened) {
      let m = holders.get(this.brokers);
      if (!m) holders.set(this.brokers, (m = new Map()));
      m.set(this.room.topic, this);
      this.opened = this.brokers.subscribe(this.room.topic, (payload) => this.receive(payload));
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
    const m = holders.get(this.brokers);
    if (m?.get(this.room.topic) === this) {
      m.delete(this.room.topic);
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
    if (this.brokers.publish(this.room.topic, raw) === 0) {
      throw new Error('signal message not sent: no broker is connected');
    }
  }

  /** The pool's callback: anything can arrive here, nothing may throw back into it. */
  private receive(payload: Uint8Array): void {
    if (this.closed || payload.length > MAX_ENVELOPE_BYTES) return;
    // not fatal: bytes that are not UTF-8 just fail the base64url check in openEnvelope
    const raw = dec.decode(payload);
    // handle() does not throw (openEnvelope never does, listeners are caught); the catch keeps the chain alive anyway
    this.inbox = this.inbox.then(() => this.handle(raw)).catch((e) => report('message handling', e));
  }

  private async handle(raw: string): Promise<void> {
    if (this.closed) return;
    // null for tampered, foreign-room, stale, replayed (or a second broker's copy) and our own echo
    const msg = await openEnvelope(this.room, raw, this.self, this.guard);
    if (!msg || this.closed) return;
    for (const cb of [...this.listeners]) {
      try {
        cb(msg);
      } catch (e) {
        report('listener', e);
      }
    }
  }
}
