// Dialing the PC (the phone's side): hello / ack over the sealed signaling channel, then a direct WebRTC link (we
// offer, the PC answers, candidates go one by one), or the slow relay when ICE does not connect in time or is not
// wanted. Shared by the Node server and the phone shell, so Web-standard APIs only (no node:*, no Buffer).
//
// Signaling, protocol v1 (each message sealed, see envelope.ts). s is a fresh session id per dial; pn and cn are the
// phone's and the PC's 16-byte nonces (b64u), which also salt the relay key. Every message after the hello carries
// the nonce of the other side's opening message, so an envelope replayed from an older session never matches: the
// replay guard lives only as long as one channel, and a new dial opens a new one.
//   phone → PC   hello  {s, pn}
//   PC → phone   ack    {s, pn, cn, pc: the PC's name}
//   phone → PC   offer  {s, cn, sdp}
//   PC → phone   answer {s, pn, sdp}
//   both         cand   {s, cn (from the phone) | pn (from the PC), c: {candidate, sdpMid, sdpMLineIndex}}
//   phone → PC   relay  {s, cn}   ICE gave up (or was never tried); the phone's relay link for s is already open
//   PC → phone   relay  {s, pn}   the PC's relay link is subscribed: frames sent from now on are not lost to a resend
//   phone → PC   bye    {s, cn}   the PC may drop the half-open session
// The brokers do not keep order across each other: a cand can come before its offer or answer (it is held until the
// remote description is set), or never come (ICE just does not try that path).
import { b64u, relayKey, unb64u, type Room } from './keys.js';
import type { SignalMsg } from './envelope.js';
import type { Link } from './link.js';
import type { Brokers } from './mqtt.js';
import {
  P2P_CHANNEL,
  P2pLink,
  closeRtc,
  iceCandidate,
  pairKind,
  rtcConfig,
  type RtcCandidate,
  type RtcCtor,
  type RtcPeerConnectionLike,
} from './p2p-link.js';
import { openRelayLink } from './relay-link.js';
import { SignalChannel } from './signal.js';

export const HELLO_TIMEOUT_MS = 15_000;
export const ICE_TIMEOUT_MS = 20_000;
const NONCE_BYTES = 16;
/** Session ids become part of relay topics (relay-link.ts checks the same shape). */
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Remote candidates held until the remote description is set; a flood past it is dropped. */
export const MAX_HELD_CANDIDATES = 64;
const MAX_PC_NAME = 256;

export type DialState = 'finding' | 'connecting' | 'relay';
export type DialErrorCode = 'pc-silent' | 'no-broker' | 'unreachable';

/** Why a dial failed: the PC did not answer, no signaling broker was reachable, or not even the relay could be set up. */
export class DialError extends Error {
  readonly code: DialErrorCode;

  constructor(code: DialErrorCode, message: string) {
    super(message);
    this.name = 'DialError';
    this.code = code;
  }
}

/** The part of the pool a dial uses (a Brokers fits); status() tells "no broker" from "no PC". */
export type DialBrokers = Pick<Brokers, 'subscribe' | 'unsubscribe' | 'publish' | 'status'>;

export interface DialOptions {
  brokers: DialBrokers;
  room: Room;
  stun: string[];
  rtc: RtcCtor;
  /** Straight to the slow relay, no ICE. */
  forceRelay?: boolean;
  /** No ack this long after the hello: pc-silent (15 000 ms). */
  helloTimeoutMs?: number;
  /** ICE not connected this long after the ack: the slow relay (20 000 ms). */
  iceTimeoutMs?: number;
  onstate?: (s: DialState) => void;
}

export interface DialResult {
  /** Set its onframe synchronously after dial() resolves: frames may already be waiting (and are capped until then). */
  link: Link;
  pcName: string;
}

export function newNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
}

/** The 16 bytes of a b64u nonce from the other side, or null. */
export function readNonce(v: unknown): Uint8Array | null {
  if (typeof v !== 'string' || v.length > 32) return null;
  try {
    const b = unb64u(v);
    return b.length === NONCE_BYTES ? b : null;
  } catch {
    return null;
  }
}

export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_RE.test(v);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function report(what: string, e: unknown): void {
  console.error(`[dial] ${what} threw`, e);
}

function timeout(v: number | undefined, def: number, what: string): number {
  if (v === undefined) return def;
  if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${what} must be a positive number of ms, got ${v}`);
  return v;
}

/** `p`'s value, or null after `ms`; the timer never outlives the call. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    void p.then((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

interface Ack {
  cn: Uint8Array;
  cnText: string;
  pc: string;
}

/**
 * Reaches the PC of `room`: resolves with a direct link, or with the slow relay when ICE did not connect within
 * iceTimeoutMs (or failed sooner); rejects with DialError. Every listener, timer, subscription and connection of a
 * failed attempt is gone by the time it settles; on success only the link remains, and it owns what it uses.
 */
export function dial(opts: DialOptions): Promise<DialResult> {
  return new Dialer(opts).run();
}

class Dialer {
  private readonly s = b64u(newNonce());
  private readonly pn = newNonce();
  private readonly pnText = b64u(this.pn);
  private readonly ch: SignalChannel;
  private readonly helloMs: number;
  private readonly iceMs: number;
  private gotAck = false;
  private onAck: ((a: Ack) => void) | undefined;
  private onRelayOk: (() => void) | undefined;
  // the direct attempt in progress
  private pc: RtcPeerConnectionLike | undefined;
  private p2p: P2pLink | undefined;
  private answered = false;
  private remoteSet = false;
  private held: RtcCandidate[] = [];
  private giveUp: (() => void) | undefined;

  constructor(private readonly o: DialOptions) {
    this.helloMs = timeout(o.helloTimeoutMs, HELLO_TIMEOUT_MS, 'helloTimeoutMs');
    this.iceMs = timeout(o.iceTimeoutMs, ICE_TIMEOUT_MS, 'iceTimeoutMs');
    this.ch = new SignalChannel(o.brokers, o.room, 'phone');
  }

  async run(): Promise<DialResult> {
    try {
      return await this.go();
    } finally {
      // signaling is only for setting up: the link (if any) lives on its own
      this.ch.close();
      this.giveUp?.();
      this.p2p?.close();
    }
  }

  private state(s: DialState): void {
    try {
      this.o.onstate?.(s);
    } catch (e) {
      report('state handler', e);
    }
  }

  private async go(): Promise<DialResult> {
    const { o } = this;
    this.state('finding');
    this.ch.on((m) => this.onSignal(m));
    try {
      await this.ch.open();
    } catch (e) {
      throw new DialError('no-broker', `signaling could not start: ${errText(e)}`);
    }
    if (!o.brokers.status().some((b) => b.ok)) throw new DialError('no-broker', 'no signaling broker could be reached');
    const acked = new Promise<Ack>((resolve) => {
      this.onAck = resolve;
    });
    try {
      await this.ch.send({ t: 'hello', s: this.s, pn: this.pnText });
    } catch (e) {
      throw new DialError('no-broker', `the hello was not sent: ${errText(e)}`);
    }
    const ack = await within(acked, this.helloMs);
    this.onAck = undefined;
    if (!ack) throw new DialError('pc-silent', `no answer from the PC within ${this.helloMs} ms`);
    if (!o.forceRelay) {
      this.state('connecting');
      const link = await this.direct(ack);
      if (link) return { link, pcName: ack.pc };
    }
    return { link: await this.relay(ack), pcName: ack.pc };
  }

  /** Our session's messages only, bound to our hello: the room's channel also carries other dials' (and old copies). */
  private onSignal(m: SignalMsg): void {
    if (m.s !== this.s || m.pn !== this.pnText) return;
    if (m.t === 'ack') {
      const cn = readNonce(m.cn);
      if (this.gotAck || !this.onAck || !cn || typeof m.pc !== 'string') return;
      this.gotAck = true;
      this.onAck({ cn, cnText: m.cn as string, pc: m.pc.slice(0, MAX_PC_NAME) });
    } else if (m.t === 'answer') {
      this.onAnswer(m.sdp);
    } else if (m.t === 'cand') {
      this.onCandidate(m.c);
    } else if (m.t === 'relay') {
      this.onRelayOk?.();
    }
  }

  private onAnswer(sdp: unknown): void {
    const pc = this.pc;
    if (!pc || this.answered || typeof sdp !== 'string' || !sdp) return;
    this.answered = true;
    pc.setRemoteDescription({ type: 'answer', sdp }).then(
      () => {
        if (this.pc !== pc) return;
        this.remoteSet = true;
        for (const c of this.held.splice(0)) pc.addIceCandidate(c).catch(() => {});
      },
      // an answer we cannot use: no point waiting for ICE
      () => {
        if (this.pc === pc) this.giveUp?.();
      },
    );
  }

  private onCandidate(c: unknown): void {
    const pc = this.pc;
    const cand = iceCandidate(c);
    if (!pc || !cand) return;
    // a candidate that does not parse or arrives late is just a path ICE does not try
    if (this.remoteSet) pc.addIceCandidate(cand).catch(() => {});
    else if (this.held.length < MAX_HELD_CANDIDATES) this.held.push(cand);
  }

  /** The direct link once its channel is open, or null when ICE failed, timed out, or could not even start. */
  private direct(ack: Ack): Promise<P2pLink | null> {
    const { o } = this;
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (link: P2pLink | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.giveUp = undefined;
        // given up: the channel and the connection are closed (and their handlers off) before the relay is asked for
        if (!link) this.p2p?.close();
        this.p2p = undefined;
        this.pc = undefined;
        resolve(link);
      };
      this.giveUp = () => finish(null);
      timer = setTimeout(() => finish(null), this.iceMs);
      let pc: RtcPeerConnectionLike;
      try {
        pc = new o.rtc(rtcConfig(o.stun));
      } catch {
        return finish(null);
      }
      this.pc = pc;
      pc.onicecandidate = (ev: { candidate?: unknown } | undefined) => {
        const c = iceCandidate(ev?.candidate);
        // fire and forget: one that does not get through is a path ICE does not try
        if (c) this.ch.send({ t: 'cand', s: this.s, cn: ack.cnText, c }).catch(() => {});
      };
      let link: P2pLink;
      try {
        link = new P2pLink(pc, pc.createDataChannel(P2P_CHANNEL, { ordered: true }));
      } catch {
        closeRtc(pc);
        return finish(null);
      }
      this.p2p = link;
      // failed, or closed, before it was ours
      link.onclose = () => finish(null);
      link.onopen = () => {
        clearTimeout(timer);
        void pairKind(pc).then((kind) => {
          if (done) return;
          if (!link.isOpen()) return finish(null);
          link.kind = kind;
          link.onclose = () => {};
          finish(link);
        });
      };
      void (async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (done) return;
        if (typeof offer.sdp !== 'string' || !offer.sdp) throw new Error('the offer has no SDP');
        await this.ch.send({ t: 'offer', s: this.s, cn: ack.cnText, sdp: offer.sdp });
      })().catch(() => finish(null));
    });
  }

  private async relay(ack: Ack): Promise<Link> {
    const { o } = this;
    this.state('relay');
    // once per session (fresh nonces): the relay link refuses a key it already sealed with
    const key = await relayKey(o.room, this.pn, ack.cn);
    let link: Link;
    try {
      // subscribed before the PC is asked, so what it sends first is not lost to a resend
      link = await openRelayLink({ brokers: o.brokers, room: o.room, session: this.s, side: 'phone', key });
    } catch (e) {
      throw new DialError('unreachable', `the slow relay could not be opened: ${errText(e)}`);
    }
    const confirmed = new Promise<true>((resolve) => {
      this.onRelayOk = () => resolve(true);
    });
    try {
      await this.ch.send({ t: 'relay', s: this.s, cn: ack.cnText });
    } catch (e) {
      link.close();
      throw new DialError('unreachable', `the PC could not be asked for the slow relay: ${errText(e)}`);
    }
    // Until the PC has subscribed its side, what the phone sends is lost to the broker and only comes through on the
    // 1 500 ms resend. What the PC sends meanwhile waits in the link (capped while no onframe is set; the PC only
    // answers what the phone asks, so little does).
    const ok = await within(confirmed, this.helloMs);
    this.onRelayOk = undefined;
    if (!ok) {
      link.close();
      throw new DialError('unreachable', `the PC did not take up the slow relay within ${this.helloMs} ms`);
    }
    return link;
  }
}
