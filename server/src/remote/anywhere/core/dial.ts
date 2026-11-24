// Dialing the PC (the phone's side): hello / ack over the sealed signaling channel, then a direct WebRTC link (we
// offer, the PC answers, candidates go one by one), or the slow relay when ICE does not connect in time or is not
// wanted. Shared by the Node server and the phone shell, so Web-standard APIs only (no node:*, no Buffer).
//
// Signaling, protocol v1 (each message sealed, see envelope.ts). s is a fresh session id per dial; pn and cn are the
// phone's and the PC's 16-byte nonces (b64u), which also salt the relay key. Every message after the hello carries
// the nonce of the other side's opening message, so an envelope replayed from an older session never matches: the
// replay guard lives only as long as one channel, and a new dial opens a new one.
//   phone → PC   hello    {s, pn}
//   PC → phone   ack      {s, pn, cn, pc: the PC's name, r?: 1 when this PC answers repeated steps (see below)}
//   phone → PC   offer    {s, cn, sdp}
//   PC → phone   answer   {s, pn, sdp}
//   both         cand     {s, cn (from the phone) | pn (from the PC), c: {candidate, sdpMid, sdpMLineIndex}}
//   PC → phone   nodirect {s, pn}   no direct link from the PC for this session (no RTCPeerConnection, no answer, or
//                                   a failure taking the data channel): go to the relay now instead of waiting out the
//                                   ICE timeout
//   phone → PC   relay    {s, cn}   ICE gave up (or was never tried); the phone's relay link for s is already open
//   PC → phone   relay    {s, pn}   the PC's relay link is subscribed. Only a fast path: the phone waits for it at most
//                                   one relay resend interval, then goes ahead (anything lost meanwhile is resent)
//   bye          reserved, not sent in v1; ignored on arrival
// The brokers do not keep order across each other: a cand can come before its offer or answer (it is held until the
// remote description is set), or never come (ICE just does not try that path).
//
// Nothing here is delivered for sure (QoS 0, public brokers, a phone on mobile data whose broker connections come up
// one by one): every step is sent again until the other side's next step is seen (2026-11-24, a phone on China
// Mobile whose ack was lost while a working broker connection sat idle for the whole 15 s). Each resend is sealed
// anew (the replay guard drops a repeated envelope) and goes to every broker that is up by then.
//   hello    again every resendMs until the ack; the PC answers a hello it already knows with the same ack. A PC from
//            before this does not, so every helloAgainMs the phone also says a fresh hello (new s / pn, the same g):
//            the first ack of any of them wins. g names the dial, so the PC drops the hellos that lost quietly.
//   offer    again every resendMs until the answer; the PC answers a repeated offer with the same answer and its
//            candidates so far. Both sides send their candidates once more a little later.
//   relay    again every RELAY_CONFIRM_MS until the PC's relay (or a frame on the relay link), a few times.
import type { SignalMsg } from './envelope.js';
import { MAX_HELD_CANDIDATES, errText, newNonce, readNonce, report as reportAs } from './handshake.js';
import { b64u, relayKey, type Room } from './keys.js';
import type { Link, LinkKind } from './link.js';
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
import { MAX_EARLY_BYTES, MAX_EARLY_FRAMES, openRelayLink } from './relay-link.js';
import { SignalChannel } from './signal.js';

export const HELLO_TIMEOUT_MS = 15_000;
export const ICE_TIMEOUT_MS = 20_000;
/**
 * The ICE window of a redial whose last working link was the slow relay, when nothing says the network changed (the
 * shell's Session): direct did not get through on this network a moment ago, so the relay is not kept waiting 20 s
 * (on mobile data, where direct never works, that was the whole wait). A few seconds still let a direct link that
 * comes up fast win.
 */
export const RELAY_AGAIN_ICE_MS = 4_000;
/** The relay link's resend interval (its retransmitMs default): past it, waiting for the PC's confirm gains nothing. */
export const RELAY_CONFIRM_MS = 1_500;
/**
 * How many times the relay request goes out. A PC that answers repeats (ack.r) confirms each one (asked every
 * resendMs), so none of them confirmed means it is not there: the dial fails. An older PC confirms once only, and that one may be what was lost:
 * after RELAY_ASKS_OLD the link is handed over without it.
 */
export const RELAY_ASKS = 12;
export const RELAY_ASKS_OLD = 2;
/** A step that got no reply is sent again this often. */
export const SIGNAL_RESEND_MS = 1_000;
/** No ack for this long: a fresh hello (a PC from before resends answers each session's hello only once). */
export const HELLO_AGAIN_MS = 4_000;
/** Repeats of one step the PC answers per session (a flood past it is ignored). */
export const MAX_STEP_REPEATS = 40;
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
  /** A step with no reply is sent again this often (1 000 ms). */
  resendMs?: number;
  /** No ack this long after a hello: a fresh one as well (4 000 ms). */
  helloAgainMs?: number;
  onstate?: (s: DialState) => void;
}

export interface DialResult {
  /** Set its onframe synchronously after dial() resolves: frames may already be waiting (and are capped until then). */
  link: Link;
  pcName: string;
  /** Why a direct attempt was given up for the slow relay (logs, tests); absent when direct worked or was not tried. */
  directWhy?: string;
}

function why(e: unknown): string {
  return errText(e) || String(e);
}

function report(what: string, e: unknown): void {
  reportAs('dial', what, e);
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
  /** The PC answers repeated steps (hello, offer, relay). */
  resends: boolean;
}

/**
 * The relay link as dial() hands it out. dial() takes the link's onframe and onclose the moment it opens (the PC
 * may already be sending, and an end while dial still waits must make dial fail, not hand out a dead link): frames
 * that arrive before the caller sets onframe are held here and given to its first onframe in order, before anything
 * newer, under the relay link's own early-buffer bounds. Nothing is delivered once the link has ended or been closed
 * (a caller that closes from inside its first onframe gets none of the rest). While dial waits, an end goes to
 * `waiting` instead of onclose; after release() it goes to onclose as usual.
 */
class HandedRelay implements Link {
  onclose: (why: string) => void = () => {};
  private handler: ((f: Uint8Array) => void) | null = null;
  private held: Uint8Array[] = [];
  private heldBytes = 0;
  private endedWhy: string | undefined;
  private waiting: (() => void) | undefined;

  constructor(private readonly inner: Link, waiting: () => void, private heard: (() => void) | undefined = undefined) {
    this.waiting = waiting;
    inner.onframe = (f) => this.frame(f);
    inner.onclose = (why) => this.end(why);
  }

  get kind(): LinkKind {
    return this.inner.kind;
  }

  get onframe(): (f: Uint8Array) => void {
    return this.handler ?? (() => {});
  }

  set onframe(fn: (f: Uint8Array) => void) {
    this.handler = fn;
    const q = this.held;
    this.held = [];
    this.heldBytes = 0;
    for (const f of q) this.deliver(f);
  }

  private get live(): boolean {
    return this.endedWhy === undefined;
  }

  /** Why it ended while dial() still held it, if it did. */
  ended(): string | undefined {
    return this.endedWhy;
  }

  /** dial() is done with it: from now on an end is the caller's onclose. */
  release(): void {
    this.waiting = undefined;
  }

  send(frame: Uint8Array): void {
    this.inner.send(frame);
  }

  buffered(): number {
    return this.inner.buffered();
  }

  close(): void {
    this.endedWhy ??= 'closed';
    this.waiting = undefined;
    this.held = [];
    this.heldBytes = 0;
    this.inner.close();
  }

  private frame(f: Uint8Array): void {
    if (!this.live) return;
    // the PC's side is up, whatever became of its confirm
    const heard = this.heard;
    this.heard = undefined;
    heard?.();
    if (this.handler) return this.deliver(f);
    this.held.push(f);
    this.heldBytes += f.length;
    // the relay link's early-buffer bounds, and its way of ending: tell the other side, then the same reason
    if (this.heldBytes > MAX_EARLY_BYTES || this.held.length > MAX_EARLY_FRAMES) {
      this.held = [];
      this.heldBytes = 0;
      this.inner.close();
      this.end('frames arrived and nothing took them (onframe was never set)');
    }
  }

  private deliver(f: Uint8Array): void {
    // checked per frame: the handler may have closed the link (or the link ended) since the last one
    if (!this.live) return;
    try {
      this.handler!(f);
    } catch (e) {
      report('frame handler', e);
    }
  }

  private end(why: string): void {
    if (this.endedWhy !== undefined) return;
    this.endedWhy = why;
    const waiting = this.waiting;
    if (waiting) {
      // never handed out: dial() rejects, nobody else is told
      this.waiting = undefined;
      return waiting();
    }
    try {
      this.onclose(why);
    } catch (e) {
      report('close handler', e);
    }
  }
}

/**
 * Reaches the PC of `room`: resolves with a direct link, or with the slow relay when ICE did not connect within
 * iceTimeoutMs (or failed sooner); rejects with DialError. Every listener, timer, subscription and connection of a
 * failed attempt is gone by the time it settles; on success only the link remains, and it owns what it uses.
 */
export function dial(opts: DialOptions): Promise<DialResult> {
  return new Dialer(opts).run();
}

interface Hello {
  s: string;
  pn: Uint8Array;
  pnText: string;
}

class Dialer {
  /** The session the PC acked: '' until then (nothing but an ack is listened to before it). */
  private s = '';
  private pn: Uint8Array = new Uint8Array(0);
  private pnText = '';
  /** Names this dial across its hellos, so the PC can tell the ones that lost from attempts that failed. */
  private readonly g = b64u(newNonce());
  /** Every hello said so far, by session id: the first ack for any of them wins. */
  private readonly hellos = new Map<string, Hello>();
  private hellosSent = 0;
  private readonly ch: SignalChannel;
  private readonly helloMs: number;
  private readonly iceMs: number;
  private readonly resendMs: number;
  private readonly helloAgainMs: number;
  private readonly timers = new Set<ReturnType<typeof setInterval>>();
  private gotAck = false;
  private onAck: ((a: Ack) => void) | undefined;
  private onRelayOk: (() => void) | undefined;
  // the direct attempt in progress
  private pc: RtcPeerConnectionLike | undefined;
  private p2p: P2pLink | undefined;
  private answered = false;
  private remoteSet = false;
  private held: RtcCandidate[] = [];
  private giveUp: ((why: string) => void) | undefined;
  private directWhy: string | undefined;

  constructor(private readonly o: DialOptions) {
    this.helloMs = timeout(o.helloTimeoutMs, HELLO_TIMEOUT_MS, 'helloTimeoutMs');
    this.iceMs = timeout(o.iceTimeoutMs, ICE_TIMEOUT_MS, 'iceTimeoutMs');
    this.resendMs = timeout(o.resendMs, SIGNAL_RESEND_MS, 'resendMs');
    this.helloAgainMs = timeout(o.helloAgainMs, HELLO_AGAIN_MS, 'helloAgainMs');
    this.ch = new SignalChannel(o.brokers, o.room, 'phone');
  }

  async run(): Promise<DialResult> {
    try {
      return await this.go();
    } finally {
      // signaling is only for setting up: the link (if any) lives on its own
      for (const t of [...this.timers]) this.stopEvery(t);
      this.ch.close();
      this.giveUp?.('the dial ended');
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

  /** `fn` every `ms` until stopEvery() or the dial ends; a throw is logged, never escapes into the timer. */
  private every(ms: number, fn: () => void): ReturnType<typeof setInterval> {
    const t = setInterval(() => {
      try {
        fn();
      } catch (e) {
        report('resend', e);
      }
    }, ms);
    this.timers.add(t);
    return t;
  }

  private stopEvery(t: ReturnType<typeof setInterval> | undefined): void {
    if (t === undefined) return;
    clearInterval(t);
    this.timers.delete(t);
  }

  private newHello(): Hello {
    const pn = newNonce();
    const h: Hello = { s: b64u(newNonce()), pn, pnText: b64u(pn) };
    this.hellos.set(h.s, h);
    return h;
  }

  private sayHello(h: Hello): Promise<void> {
    this.hellosSent++;
    return this.ch.send({ t: 'hello', s: h.s, pn: h.pnText, g: this.g });
  }

  /** What the pool looked like when the PC stayed silent: which brokers the hellos could go through. */
  private silentWhy(): string {
    const st = this.o.brokers.status();
    const up = st.filter((b) => b.ok).map((b) => b.name);
    const down = st.filter((b) => !b.ok).map((b) => b.name);
    const pool = `brokers up: ${up.join(', ') || 'none'}${down.length ? `; down: ${down.join(', ')}` : ''}`;
    return `no answer from the PC within ${this.helloMs} ms (${this.hellosSent} hellos; ${pool})`;
  }

  private async go(): Promise<DialResult> {
    const { o } = this;
    this.state('finding');
    this.ch.on((m) => this.onSignal(m));
    try {
      await this.ch.open();
    } catch (e) {
      throw new DialError('no-broker', `signaling could not start: ${why(e)}`);
    }
    if (!o.brokers.status().some((b) => b.ok)) throw new DialError('no-broker', 'no signaling broker could be reached');
    const acked = new Promise<Ack>((resolve) => {
      this.onAck = resolve;
    });
    let hello = this.newHello();
    let saidAt = Date.now();
    try {
      await this.sayHello(hello);
    } catch (e) {
      throw new DialError('no-broker', `the hello was not sent: ${why(e)}`);
    }
    // the same hello again (a PC that knows it acks again), and now and then a fresh one (an older PC acks each
    // session once only); a resend that no broker takes is just one that was lost
    const again = this.every(this.resendMs, () => {
      if (Date.now() - saidAt >= this.helloAgainMs) {
        hello = this.newHello();
        saidAt = Date.now();
      }
      this.sayHello(hello).catch(() => {});
    });
    const ack = await within(acked, this.helloMs);
    this.stopEvery(again);
    this.onAck = undefined;
    if (!ack) throw new DialError('pc-silent', this.silentWhy());
    if (!o.forceRelay) {
      this.state('connecting');
      const link = await this.direct(ack);
      if (link) return { link, pcName: ack.pc };
    }
    return { link: await this.relay(ack), pcName: ack.pc, ...(this.directWhy ? { directWhy: this.directWhy } : {}) };
  }

  /** Our session's messages only, bound to our hello: the room's channel also carries other dials' (and old copies). */
  private onSignal(m: SignalMsg): void {
    if (m.t === 'ack') {
      const h = this.hellos.get(m.s);
      const cn = readNonce(m.cn);
      if (!h || m.pn !== h.pnText || this.gotAck || !this.onAck || !cn || typeof m.pc !== 'string') return;
      this.gotAck = true;
      // this hello's session is the dial's from here on; the others are left to the PC to forget (same g)
      this.s = h.s;
      this.pn = h.pn;
      this.pnText = h.pnText;
      this.onAck({ cn, cnText: m.cn as string, pc: m.pc.slice(0, MAX_PC_NAME), resends: m.r === 1 });
      return;
    }
    if (!this.gotAck || m.s !== this.s || m.pn !== this.pnText) return;
    if (m.t === 'answer') {
      this.onAnswer(m.sdp);
    } else if (m.t === 'cand') {
      this.onCandidate(m.c);
    } else if (m.t === 'nodirect') {
      // only does something while the direct attempt is still on
      this.giveUp?.('the PC has no direct link for this session (nodirect)');
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
      (e) => {
        if (this.pc === pc) this.giveUp?.(`the PC's answer could not be used: ${why(e)}`);
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
      let again: ReturnType<typeof setInterval> | undefined;
      let sdp = '';
      let offers = 0;
      let candsAgain = false;
      const mine: RtcCandidate[] = [];
      const finish = (link: P2pLink | null, reason = '') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.stopEvery(again);
        this.giveUp = undefined;
        if (!link) this.directWhy = reason;
        // given up: the channel and the connection are closed (and their handlers off) before the relay is asked for
        if (!link) this.p2p?.close();
        this.p2p = undefined;
        this.pc = undefined;
        resolve(link);
      };
      this.giveUp = (w) => finish(null, w);
      timer = setTimeout(() => finish(null, `ICE did not connect within ${this.iceMs} ms`), this.iceMs);
      let pc: RtcPeerConnectionLike;
      try {
        pc = new o.rtc(rtcConfig(o.stun));
      } catch (e) {
        return finish(null, `no RTCPeerConnection: ${why(e)}`);
      }
      this.pc = pc;
      pc.onicecandidate = (ev: { candidate?: unknown } | undefined) => {
        const c = iceCandidate(ev?.candidate);
        if (!c) return;
        if (mine.length < MAX_HELD_CANDIDATES) mine.push(c);
        // fire and forget: one that does not get through goes out once more below, or is a path ICE does not try
        this.ch.send({ t: 'cand', s: this.s, cn: ack.cnText, c }).catch(() => {});
      };
      // no answer yet: the offer again (the PC answers a repeat with the same answer). Once it is here, our
      // candidates once more, a tick later: any of them may have been lost, and one lost path can be the only one
      again = this.every(this.resendMs, () => {
        if (done || !sdp) return;
        if (!this.answered) {
          if (++offers <= MAX_STEP_REPEATS) this.ch.send({ t: 'offer', s: this.s, cn: ack.cnText, sdp }).catch(() => {});
          return;
        }
        if (candsAgain) return;
        candsAgain = true;
        for (const c of mine) this.ch.send({ t: 'cand', s: this.s, cn: ack.cnText, c }).catch(() => {});
      });
      let link: P2pLink;
      try {
        link = new P2pLink(pc, pc.createDataChannel(P2P_CHANNEL, { ordered: true }));
      } catch (e) {
        closeRtc(pc);
        return finish(null, `no data channel: ${why(e)}`);
      }
      this.p2p = link;
      // failed, or closed, before it was ours
      link.onclose = (w) => finish(null, `before it opened: ${w}`);
      link.onopen = () => {
        clearTimeout(timer);
        void pairKind(pc).then((kind) => {
          if (done) return;
          if (!link.isOpen()) return finish(null, 'it closed while its kind was read');
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
        sdp = offer.sdp;
        await this.ch.send({ t: 'offer', s: this.s, cn: ack.cnText, sdp });
      })().catch((e) => finish(null, `the offer: ${why(e)}`));
    });
  }

  private async relay(ack: Ack): Promise<Link> {
    const { o } = this;
    this.state('relay');
    let key: CryptoKey;
    try {
      // once per session (fresh nonces): the relay link refuses a key it already sealed with
      key = await relayKey(o.room, this.pn, ack.cn);
    } catch (e) {
      throw new DialError('unreachable', `the slow relay key could not be derived: ${why(e)}`);
    }
    let link: Link;
    try {
      // subscribed before the PC is asked, so what it sends first is not lost to a resend
      link = await openRelayLink({ brokers: o.brokers, room: o.room, session: this.s, side: 'phone', key });
    } catch (e) {
      throw new DialError('unreachable', `the slow relay could not be opened: ${why(e)}`);
    }
    let wake: () => void = () => {};
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    // synchronously after the open, as the Link contract asks: from here dial holds its frames and hears its end
    const handed = new HandedRelay(link, () => wake(), () => wake());
    this.onRelayOk = () => wake();
    try {
      await this.ch.send({ t: 'relay', s: this.s, cn: ack.cnText });
    } catch (e) {
      handed.close();
      throw new DialError('unreachable', `the PC could not be asked for the slow relay: ${why(e)}`);
    }
    // The PC's confirm (or a first frame from it) says its side is subscribed. Without one the request itself may be
    // what was lost, and then the PC never opens its side: it is asked again. A PC that answers repeats confirms each
    // time, so silence all the way means it is gone, and a dead link is not handed out. An older PC confirms once
    // only, and that one may be what was lost: the link goes to the caller after a couple of asks anyway (a PC that
    // never takes it up shows as the link's own end, later).
    const asks = ack.resends ? RELAY_ASKS : RELAY_ASKS_OLD;
    let confirmed = false;
    for (let asked = 1; ; asked++) {
      confirmed = (await within(woken.then(() => true), ack.resends ? this.resendMs : RELAY_CONFIRM_MS)) === true;
      if (confirmed || asked >= asks || handed.ended() !== undefined) break;
      this.ch.send({ t: 'relay', s: this.s, cn: ack.cnText }).catch(() => {});
    }
    if (!confirmed && ack.resends && handed.ended() === undefined) {
      handed.close();
      this.onRelayOk = undefined;
      throw new DialError('unreachable', `the PC did not take the slow relay up (asked ${asks} times)`);
    }
    this.onRelayOk = undefined;
    const ended = handed.ended();
    if (ended !== undefined) {
      handed.close();
      throw new DialError('unreachable', `the slow relay ended before it was handed over: ${ended}`);
    }
    handed.release();
    return handed;
  }
}
