// Sealed signaling envelope: what actually goes over the public MQTT brokers.
// Shared by the Node server and the phone shell, so Web-standard APIs only.
import { b64u, unb64u, type Room } from './keys.js';

export type Side = 'phone' | 'pc';

/** What each one carries is in dial.ts; a type not listed here is dropped on arrival. */
export type SignalType = 'hello' | 'ack' | 'offer' | 'answer' | 'cand' | 'nodirect' | 'relay' | 'bye';

export interface SignalMsg {
  v: 1;
  t: SignalType;
  /** session id */
  s: string;
  /** random nonce (b64u of 16 bytes); replay key */
  n: string;
  ts: number;
  from: Side;
  [k: string]: unknown;
}

/**
 * What callers hand to `seal`. Spelled out instead of `Omit<SignalMsg, 'v' | 'n' | 'ts'>`: Omit over a type
 * with an index signature collapses to just the index signature and would drop t / s / from.
 */
export interface SignalDraft {
  t: SignalType;
  s: string;
  from: Side;
  [k: string]: unknown;
}

const TYPES: ReadonlySet<string> = new Set<SignalType>(['hello', 'ack', 'offer', 'answer', 'cand', 'nodirect', 'relay', 'bye']);
const MAX_SKEW_MS = 300_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const NONCE_BYTES = 16;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** base64url(iv ‖ ciphertext+tag), AAD = topic, so an envelope cannot be moved to another room. */
export async function seal(room: Room, msg: SignalDraft): Promise<string> {
  // ours win over anything the caller put in: a reused n or a forged ts would defeat the replay checks
  const full = { ...msg, v: 1, n: b64u(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))), ts: Date.now() };
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(room.topic) }, room.key, enc.encode(JSON.stringify(full)),
  ));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv);
  out.set(ct, IV_BYTES);
  return b64u(out);
}

/** Nonces seen recently, least recently seen evicted first. */
export class ReplayGuard {
  private readonly cap: number;
  private readonly ns = new Map<string, true>();

  constructor(cap = 2048) {
    this.cap = cap;
  }

  /** True if `n` was already seen; otherwise remembers it. */
  seen(n: string): boolean {
    if (this.ns.has(n)) {
      this.ns.delete(n);
      this.ns.set(n, true);
      return true;
    }
    this.ns.set(n, true);
    if (this.ns.size > this.cap) this.ns.delete(this.ns.keys().next().value as string);
    return false;
  }
}

function isSignal(m: unknown): m is SignalMsg {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const o = m as Record<string, unknown>;
  return o.v === 1
    && typeof o.t === 'string' && TYPES.has(o.t)
    && typeof o.s === 'string'
    && typeof o.n === 'string' && o.n.length > 0
    && typeof o.ts === 'number' && Number.isFinite(o.ts)
    && (o.from === 'phone' || o.from === 'pc');
}

/**
 * Null for anything that is not a fresh message from the other side: undecodable, tampered, sealed in another
 * room, not a signal message, our own echo (brokers deliver our publishes back to us), more than 5 minutes off,
 * or a nonce already seen (replay, or the same message via a second broker). Never throws.
 */
export async function openEnvelope(room: Room, raw: string, self: Side, guard: ReplayGuard, now = Date.now()): Promise<SignalMsg | null> {
  let msg: unknown;
  try {
    if (typeof raw !== 'string') return null;
    const b = unb64u(raw);
    if (b.length < IV_BYTES + TAG_BYTES) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b.subarray(0, IV_BYTES), additionalData: enc.encode(room.topic) }, room.key, b.subarray(IV_BYTES),
    );
    msg = JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
  if (!isSignal(msg)) return null;
  if (msg.from === self) return null;
  if (Math.abs(now - msg.ts) > MAX_SKEW_MS) return null;
  // last: only messages that passed everything else take a slot in the guard
  if (guard.seen(msg.n)) return null;
  return msg;
}
