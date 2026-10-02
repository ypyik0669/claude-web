// Accepting phones (the PC's side): one signaling channel per room (a paired device, or a pairing code), answering
// hello with ack and then either the direct link (the phone offers, we answer) or, once the phone asks for it, the
// slow relay. The protocol is described in dial.ts. The brokers are public: anything that arrives is untrusted and
// nothing throws out of a callback; hellos are answered at most maxHellosPerMin a minute per room, and sessions that
// have not become a link are bounded per room and expire. Shared code (no node:*), though only the PC runs it.
import type { SignalMsg } from './envelope.js';
import { b64u, relayKey, type Room } from './keys.js';
import type { Link, LinkKind } from './link.js';
import type { Brokers } from './mqtt.js';
import { isSessionId, newNonce, readNonce, MAX_HELD_CANDIDATES } from './dial.js';
import {
  P2P_CHANNEL,
  P2pLink,
  closeRtc,
  iceCandidate,
  pairKind,
  rtcConfig,
  type RtcCandidate,
  type RtcCtor,
  type RtcDataChannelLike,
  type RtcPeerConnectionLike,
} from './p2p-link.js';
import { openRelayLink } from './relay-link.js';
import { SignalChannel } from './signal.js';

export const ACCEPT_HELLOS_PER_MIN = 30;
/** Long enough for a phone's hello timeout, ICE timeout and the relay request after it. */
export const ACCEPT_HALF_OPEN_MS = 60_000;
/** Sessions per room that are not a link yet; past it the oldest is dropped (a phone redialing wins). */
export const ACCEPT_MAX_HALF_OPEN = 16;
const RATE_WINDOW_MS = 60_000;

/** The part of the pool an Acceptor uses (a Brokers fits). */
export type AcceptBrokers = Pick<Brokers, 'subscribe' | 'unsubscribe' | 'publish'>;

export interface AcceptorOptions {
  brokers: AcceptBrokers;
  rtc: RtcCtor;
  stun: string[];
  /** Sent in every ack; the phone shows it. */
  pcName: string;
  /**
   * Each new link (direct or relay), with the id given to addRoom(). Set its onframe synchronously in here: frames
   * may already be waiting (and are capped until then). Its onclose also fires for removeRoom() and close().
   */
  onLink: (link: Link, roomId: string) => void;
  /** Hellos answered per room per minute (30); the rest get no ack. */
  maxHellosPerMin?: number;
  /** A session that has not become a link this long after its hello is dropped (60 000 ms). */
  halfOpenMs?: number;
  /**
   * Test only: ICE cannot connect. Our candidates are not sent and the phone's are not used (with only one of the
   * two cut, ICE still connects through peer-reflexive candidates). Never set by the defaults.
   */
  dropCandidates?: boolean;
}

type SessionState = 'acked' | 'ice' | 'relay' | 'link' | 'gone';

interface Session {
  s: string;
  pn: Uint8Array;
  pnText: string;
  cn: Uint8Array;
  cnText: string;
  state: SessionState;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The direct attempt, before it is a link. */
  pc?: RtcPeerConnectionLike;
  p2p?: P2pLink;
  remoteSet: boolean;
  held: RtcCandidate[];
  link?: TrackedLink;
}

interface RoomState {
  id: string;
  room: Room;
  ch: SignalChannel;
  /** In hello order (a Map keeps insertion order): the oldest half-open one is the first that is not a link. */
  sessions: Map<string, Session>;
  /** When each of the last hellos was answered (performance.now()), at most maxHellos. */
  answered: number[];
  links: Set<TrackedLink>;
  gone: boolean;
}

function report(what: string, e: unknown): void {
  console.error(`[accept] ${what} threw`, e);
}

/**
 * What onLink hands out: the link itself, plus bookkeeping. The Acceptor learns when it ends (to forget it), and can
 * end it with onclose for removeRoom() / close(), which are not the consumer's own close().
 */
class TrackedLink implements Link {
  onclose: (why: string) => void = () => {};
  private done = false;

  constructor(private readonly inner: Link, private readonly gone: () => void) {
    inner.onclose = (why) => {
      if (this.done) return;
      this.finish();
      this.tell(why);
    };
  }

  get kind(): LinkKind {
    return this.inner.kind;
  }

  get onframe(): (f: Uint8Array) => void {
    return this.inner.onframe;
  }

  set onframe(fn: (f: Uint8Array) => void) {
    this.inner.onframe = fn;
  }

  send(frame: Uint8Array): void {
    this.inner.send(frame);
  }

  buffered(): number {
    return this.inner.buffered();
  }

  close(): void {
    if (this.done) return;
    this.finish();
    this.inner.close();
  }

  /** Closed by the Acceptor: the consumer hears it like any other end. */
  end(why: string): void {
    if (this.done) return;
    this.finish();
    this.inner.close();
    this.tell(why);
  }

  private finish(): void {
    this.done = true;
    try {
      this.gone();
    } catch (e) {
      report('link bookkeeping', e);
    }
  }

  private tell(why: string): void {
    try {
      this.onclose(why);
    } catch (e) {
      report('close handler', e);
    }
  }
}

function withoutCandidates(sdp: string): string {
  return sdp.split(/\r?\n/).filter((l) => !l.startsWith('a=candidate')).join('\r\n');
}

export class Acceptor {
  private readonly rooms = new Map<string, RoomState>();
  private readonly maxHellos: number;
  private readonly halfOpenMs: number;
  private closed = false;

  constructor(private readonly o: AcceptorOptions) {
    const max = o.maxHellosPerMin ?? ACCEPT_HELLOS_PER_MIN;
    if (!Number.isInteger(max) || max < 0) throw new RangeError(`maxHellosPerMin must be a whole number, got ${max}`);
    const ms = o.halfOpenMs ?? ACCEPT_HALF_OPEN_MS;
    if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`halfOpenMs must be a positive number of ms, got ${ms}`);
    this.maxHellos = max;
    this.halfOpenMs = ms;
  }

  /**
   * Starts answering in `room` under `id` (a second call with the same id replaces it, ending its links). Resolves
   * once the subscription is confirmed, or once no broker can confirm it (they resubscribe when back); also resolves
   * when removeRoom() / close() came first. Rejects after close().
   */
  async addRoom(id: string, room: Room): Promise<void> {
    if (this.closed) throw new Error('the acceptor is closed');
    this.remove(id, 'room replaced');
    const r: RoomState = {
      id,
      room,
      ch: new SignalChannel(this.o.brokers, room, 'pc'),
      sessions: new Map(),
      answered: [],
      links: new Set(),
      gone: false,
    };
    this.rooms.set(id, r);
    r.ch.on((m) => this.onSignal(r, m));
    try {
      await r.ch.open();
    } catch (e) {
      // open() only rejects once the channel was closed, which is removeRoom() / close() having come first
      if (r.gone) return;
      this.remove(id, 'room failed');
      throw e;
    }
  }

  /** Unsubscribes the room, drops its half-open sessions and ends its links (their onclose: 'room removed'). */
  removeRoom(id: string): void {
    this.remove(id, 'room removed');
  }

  /** Every room, as removeRoom() (onclose: 'acceptor closed'); addRoom() rejects afterwards. */
  close(): void {
    this.closed = true;
    for (const id of [...this.rooms.keys()]) this.remove(id, 'acceptor closed');
  }

  private remove(id: string, why: string): void {
    const r = this.rooms.get(id);
    if (!r) return;
    this.rooms.delete(id);
    r.gone = true;
    r.ch.close();
    for (const t of [...r.links]) t.end(why);
    for (const ses of [...r.sessions.values()]) this.drop(r, ses);
  }

  /** From the channel: anything can arrive here, nothing may throw back into it. */
  private onSignal(r: RoomState, m: SignalMsg): void {
    if (r.gone) return;
    try {
      switch (m.t) {
        case 'hello':
          return this.onHello(r, m);
        case 'offer':
          return this.onOffer(r, m);
        case 'cand':
          return this.onCandidate(r, m);
        case 'relay':
          return this.onRelay(r, m);
        case 'bye':
          return this.onBye(r, m);
        default:
          // ack / answer only ever go the other way
          return;
      }
    } catch (e) {
      report(`${m.t} handling`, e);
    }
  }

  /** The session a message after the hello is for, if it carries that session's PC nonce. */
  private bound(r: RoomState, m: SignalMsg): Session | undefined {
    const ses = r.sessions.get(m.s);
    return ses && m.cn === ses.cnText ? ses : undefined;
  }

  private onHello(r: RoomState, m: SignalMsg): void {
    const pn = readNonce(m.pn);
    if (!isSessionId(m.s) || !pn || r.sessions.has(m.s)) return;
    const now = performance.now();
    while (r.answered.length > 0 && now - r.answered[0] >= RATE_WINDOW_MS) r.answered.shift();
    if (r.answered.length >= this.maxHellos) return;
    r.answered.push(now);
    this.evict(r);
    const cn = newNonce();
    const ses: Session = {
      s: m.s,
      pn,
      pnText: m.pn as string,
      cn,
      cnText: b64u(cn),
      state: 'acked',
      timer: undefined,
      remoteSet: false,
      held: [],
    };
    ses.timer = setTimeout(() => this.drop(r, ses), this.halfOpenMs);
    r.sessions.set(ses.s, ses);
    // fire and forget: a lost ack is the phone's pc-silent, and it dials again
    r.ch.send({ t: 'ack', s: ses.s, pn: ses.pnText, cn: ses.cnText, pc: this.o.pcName }).catch(() => {});
  }

  /** Makes room for one more half-open session. */
  private evict(r: RoomState): void {
    let n = 0;
    let oldest: Session | undefined;
    for (const ses of r.sessions.values()) {
      if (ses.state === 'link') continue;
      oldest ??= ses;
      n++;
    }
    if (oldest && n >= ACCEPT_MAX_HALF_OPEN) this.drop(r, oldest);
  }

  private onOffer(r: RoomState, m: SignalMsg): void {
    const ses = this.bound(r, m);
    if (!ses || ses.state !== 'acked' || typeof m.sdp !== 'string' || !m.sdp) return;
    ses.state = 'ice';
    let pc: RtcPeerConnectionLike;
    try {
      pc = new this.o.rtc(rtcConfig(this.o.stun));
    } catch (e) {
      // no direct link from this side: the phone's ICE times out and it asks for the relay
      report('RTCPeerConnection', e);
      return;
    }
    ses.pc = pc;
    pc.onicecandidate = (ev: { candidate?: unknown } | undefined) => {
      const c = iceCandidate(ev?.candidate);
      if (c && !this.o.dropCandidates) r.ch.send({ t: 'cand', s: ses.s, pn: ses.pnText, c }).catch(() => {});
    };
    pc.ondatachannel = (ev: { channel?: unknown } | undefined) => this.onChannel(r, ses, pc, ev?.channel);
    const sdp = m.sdp;
    void (async () => {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      if (ses.pc !== pc) return;
      ses.remoteSet = true;
      for (const c of ses.held.splice(0)) pc.addIceCandidate(c).catch(() => {});
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (ses.pc !== pc) return;
      if (typeof answer.sdp !== 'string' || !answer.sdp) throw new Error('the answer has no SDP');
      await r.ch.send({ t: 'answer', s: ses.s, pn: ses.pnText, sdp: this.o.dropCandidates ? withoutCandidates(answer.sdp) : answer.sdp });
    })().catch(() => {
      // an offer we cannot answer: the phone falls back to the relay on its own
      if (ses.pc === pc) this.dropDirect(ses);
    });
  }

  private onChannel(r: RoomState, ses: Session, pc: RtcPeerConnectionLike, channel: unknown): void {
    const dc = channel as RtcDataChannelLike | undefined;
    if (!dc) return;
    if (ses.pc !== pc || ses.p2p || ses.state !== 'ice' || dc.label !== P2P_CHANNEL) {
      try {
        dc.close();
      } catch {
        // already closing
      }
      return;
    }
    const link = new P2pLink(pc, dc);
    ses.p2p = link;
    // ended before it was handed out: the session waits for the phone's relay request (or expires)
    link.onclose = () => {
      if (ses.p2p !== link) return;
      ses.p2p = undefined;
      if (ses.pc === pc) ses.pc = undefined;
    };
    link.onopen = () => {
      void pairKind(pc).then((kind) => {
        if (r.gone || ses.p2p !== link || ses.state !== 'ice' || !link.isOpen()) return;
        link.kind = kind;
        link.onclose = () => {};
        ses.p2p = undefined;
        ses.pc = undefined;
        this.handOut(r, ses, link);
      });
    };
  }

  private onCandidate(r: RoomState, m: SignalMsg): void {
    const ses = this.bound(r, m);
    if (!ses || this.o.dropCandidates || (ses.state !== 'acked' && ses.state !== 'ice')) return;
    const c = iceCandidate(m.c);
    if (!c) return;
    if (ses.pc && ses.remoteSet) ses.pc.addIceCandidate(c).catch(() => {});
    else if (ses.held.length < MAX_HELD_CANDIDATES) ses.held.push(c);
  }

  private onRelay(r: RoomState, m: SignalMsg): void {
    const ses = this.bound(r, m);
    if (!ses || ses.state === 'relay' || ses.state === 'gone') return;
    if (ses.state === 'link') {
      // the phone gave up on ICE just as our end of the channel opened: it is waiting on the relay now
      const old = ses.link;
      if (!old || old.kind === 'relay') return;
      ses.state = 'relay';
      old.end('the phone switched to the slow relay');
    }
    ses.state = 'relay';
    this.dropDirect(ses);
    void this.openRelay(r, ses);
  }

  private async openRelay(r: RoomState, ses: Session): Promise<void> {
    try {
      // once per session (the relay link refuses a key it already sealed with): this is the only place, and
      // the session is in 'relay' from now on
      const key = await relayKey(r.room, ses.pn, ses.cn);
      if (r.gone || ses.state !== 'relay') return;
      const link = await openRelayLink({ brokers: this.o.brokers, room: r.room, session: ses.s, side: 'pc', key });
      if (r.gone || ses.state !== 'relay') return link.close();
      // subscribed: the phone may send now (fire and forget: without it the phone gives up, and dials again)
      r.ch.send({ t: 'relay', s: ses.s, pn: ses.pnText }).catch(() => {});
      this.handOut(r, ses, link);
    } catch (e) {
      report('relay link', e);
      this.drop(r, ses);
    }
  }

  private onBye(r: RoomState, m: SignalMsg): void {
    const ses = this.bound(r, m);
    if (ses && (ses.state === 'acked' || ses.state === 'ice')) this.drop(r, ses);
  }

  private handOut(r: RoomState, ses: Session, inner: Link): void {
    clearTimeout(ses.timer);
    ses.timer = undefined;
    ses.state = 'link';
    const t: TrackedLink = new TrackedLink(inner, () => {
      r.links.delete(t);
      if (ses.link !== t) return;
      ses.link = undefined;
      // a link that ended for good (not one replaced by the relay): the session is over
      if (ses.state === 'link') {
        ses.state = 'gone';
        if (r.sessions.get(ses.s) === ses) r.sessions.delete(ses.s);
      }
    });
    ses.link = t;
    r.links.add(t);
    try {
      this.o.onLink(t, r.id);
    } catch (e) {
      report('link handler', e);
    }
  }

  /** Closes the direct attempt, if any (not a link already handed out). */
  private dropDirect(ses: Session): void {
    const { p2p, pc } = ses;
    ses.p2p = undefined;
    ses.pc = undefined;
    ses.held = [];
    ses.remoteSet = false;
    if (p2p) p2p.close();
    else if (pc) closeRtc(pc);
  }

  /** Forgets a session that is not a link (expired, evicted, bye, its room removed). */
  private drop(r: RoomState, ses: Session): void {
    if (ses.state === 'gone') return;
    ses.state = 'gone';
    clearTimeout(ses.timer);
    ses.timer = undefined;
    this.dropDirect(ses);
    if (r.sessions.get(ses.s) === ses) r.sessions.delete(ses.s);
  }
}
