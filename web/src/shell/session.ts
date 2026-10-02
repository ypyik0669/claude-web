// One connection to a paired PC: dial, the app's files for the PC's build, the app's tunnel, and a redial when the
// link drops (先直连，不行转发: dial() tries the direct link first, the slow relay after it). Also answers the app
// frame's requests that the service worker hands to this window (serve). Pairing is pairWith(). No DOM: main.ts
// shows the views, and the tests drive it with a fake PC.
import {
  Mux, RELAY_AGAIN_ICE_MS, deviceRoom, pairRoom, type DialResult, type DialState, type LinkKind, type MuxResponse, type Room,
} from '@anywhere';
import { appVersion, ensureAppCache, fetchOk, healthVersion, toCached, type CachesLike } from './assets';
import { listsOf, type DeviceRec } from './devices';
import { explainDial, explainFiles, explainLinkEnd, explainPairDial, explainPcError, errText, type DialContext, type Explained } from './explain';
import { replyFromError, replyFromPc, spaFallback, withToken, type ShellReply, type ShellRequest } from './forward';
import { readPairAnswer, type PairLink, type PcLists } from './pair-link';
import { appEntry, appKey, pcPath } from './route';
import { ShellTunnel } from './tunnel';

/** How one dial goes. */
export interface DialPlan {
  /** Restart the broker connections first (a redial: the old ones may have died with the network). */
  fresh: boolean;
  /** ICE gets this long before the slow relay; absent: dial()'s own window (20 s). */
  iceMs?: number;
  /** The PC's lists (from its pairing link, kept on its device record); none: the defaults. */
  lists: PcLists;
}

/** The shell's way to reach a room: dial() with the PC's brokers, STUN list and RTC (main.ts). */
export interface Dialer {
  dial(room: Room, onstate: (s: DialState) => void, plan: DialPlan): Promise<DialResult>;
  /** A direct link is up: the broker connections can close until the next dial (the relay needs them). */
  idle(): void;
  /**
   * The broker connections closed and opened again now (the network changed under a relay link: the old ones are
   * likely dead; the subscriptions are kept, and the relay goes on by resending what was lost meanwhile).
   */
  restart(): void;
}

export type SessionView =
  | { k: 'dialing'; step: DialState }
  | { k: 'files'; done: number; total: number }
  /** Show the app at `url` (again, `reload`, when the PC's build changed). */
  | { k: 'open'; url: string; kind: LinkKind; reload: boolean }
  /** The link dropped: dialing again (before the app opened too). */
  | { k: 'relinking' }
  | { k: 'linked'; kind: LinkKind }
  /** The PC's build changed while the app was open: its files are being taken. */
  | { k: 'updating' }
  /** The PC refused a request with 413 (a preview or an upload over the slow relay): its words, for the bar. */
  | { k: 'refused'; text: string }
  | { k: 'down'; why: Explained }
  | { k: 'failed'; why: Explained };

export interface SessionOptions {
  device: DeviceRec;
  dialer: Dialer;
  caches: CachesLike;
  /** The shell's folder (the service worker's scope), as a URL. */
  scope: string;
  /** This window's id, put on the app frame's address. */
  owner: string;
  onview: (v: SessionView) => void;
  /** The app opened: the device's lastAt can be stored. */
  onopened?: () => void;
  /** Waits before each redial attempt (0, 2 s, 5 s). */
  redialDelays?: number[];
  wait?: (ms: number) => Promise<void>;
  /** The first dial right after pairing: once more on pc-silent (the PC may still be subscribing the new room). */
  justPaired?: boolean;
  /** No RTCPeerConnection here: the dials are the slow relay only, and a failure's 原文 says why (C4). */
  rtcMissing?: boolean;
}

const REDIAL_DELAYS = [0, 2_000, 5_000];
/**
 * A network change (the phone came online) counts this long: a link that drops within it is redialed with the full
 * ICE window (direct may work on the new network), not the short one after a relay link. The page shown again is not
 * a network change: a phone put down for more than 30 s comes back to a relay link that is about to be declared dead,
 * and its redial must get the short window to be back within seconds.
 */
export const NETWORK_CHANGE_MS = 60_000;
/** How long a frame's request waits for a redial (the service worker gives up at 60 s). */
const SERVE_WAIT_MS = 55_000;
const VERSION_CHECK_EVERY_MS = 10_000;
const enc = new TextEncoder();

/** A failure that already says what the user reads; `pcAnswered`: the PC gave a final answer (a pairing refused). */
export class ShellError extends Error {
  constructor(readonly explained: Explained, readonly pcAnswered = false) {
    super(explained.raw || explained.text);
    this.name = 'ShellError';
  }
}

class Stale extends Error {}

/** The link ended while the files came over it: a dropped link (dialed again), not a files failure. */
class LinkLost extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Build {
  /** appVersion(): the PC's version + a hash of its index.html. */
  build: string;
  cache: string;
}

export class Session {
  readonly tunnel: ShellTunnel;
  private mux: Mux | null = null;
  private build = '';
  private cache = '';
  private opened = false;
  private closed = false;
  private redialing: Promise<void> | null = null;
  private waiters: ((m: Mux | null) => void)[] = [];
  private checking = false;
  private lastCheck = 0;
  /** The kind of the last link a dial gave, and when the network last may have changed. */
  private lastKind: LinkKind | null = null;
  private netAt = -Infinity;

  constructor(private readonly o: SessionOptions) {
    this.tunnel = new ShellTunnel(o.device.token);
  }

  get device(): DeviceRec {
    return this.o.device;
  }

  /** The app frame is up (and this session not closed): its requests are ours to serve. */
  get isOpen(): boolean {
    return this.opened && !this.closed;
  }

  /** The first connection; ends on an 'open' or a 'failed' view. */
  async start(): Promise<void> {
    try {
      const { mux, got } = await this.firstLink();
      this.build = got.build;
      this.cache = got.cache;
      this.opened = true;
      this.tunnel.setLink(mux, 'up');
      this.o.onopened?.();
      this.view({ k: 'open', url: this.entry(), kind: mux.kind, reload: false });
    } catch (e) {
      if (e instanceof Stale || this.closed) return;
      this.mux?.close();
      this.mux = null;
      this.view({ k: 'failed', why: this.explain(e) });
    }
  }

  /** Dials again now (重新连接, the network came back); nothing while a link is up or a redial is on. */
  redial(): Promise<void> {
    if (this.closed || !this.opened || this.mux) return this.redialing ?? Promise.resolve();
    return (this.redialing ??= this.relink().finally(() => (this.redialing = null)));
  }

  /**
   * The phone's network may have changed (it came online). Over the slow relay the broker connections start over at
   * once: the link itself lives on (it resends what was lost), where waiting for it to notice would take its 30 s of
   * silence and then a redial. A dropped link is dialed again, and a drop soon after gets the full ICE window (direct
   * may work on the new network).
   */
  networkChanged(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.netAt = Date.now();
    return this.revive();
  }

  /**
   * The page was shown again. The same as networkChanged, except that it says nothing about the network: a relay
   * link that drops right after (its 30 s of silence ran out while the phone was put down) is redialed with the short
   * ICE window, so it is back over the relay within seconds.
   */
  pageShown(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.revive();
  }

  /** The relay's brokers start over at once; a dropped link is dialed again. */
  private revive(): Promise<void> {
    if (this.mux?.kind === 'relay') this.o.dialer.restart();
    return this.redial();
  }

  /** The link that is up right now: its kind, or null while there is none. */
  get linkKind(): LinkKind | null {
    return this.mux?.kind ?? null;
  }

  /** For good: the app's streams, the link, any redial. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.tunnel.closeAll();
    this.tunnel.setLink(null, 'down');
    const m = this.mux;
    this.mux = null;
    m?.close();
    this.wake(null);
  }

  /** A request of the app frame, made over the link (the service worker asked this window). */
  async serve(m: ShellRequest): Promise<ShellReply> {
    const mux = await this.linkUp();
    if (!mux) return replyFromError(new Error('the link to the PC has ended'));
    const body = m.body ? new Uint8Array(m.body) : undefined;
    const path = m.kind === 'api' ? withToken(m.path, this.o.device.token) : m.path;
    let res: MuxResponse;
    try {
      res = await mux.request({ method: m.method, path, headers: m.headers, body });
    } catch (e) {
      return replyFromError(e);
    }
    if (res.status === 413) {
      // the frame gets the answer as it is; an <img> shows nothing for it, so the shell says it as well
      const said = new TextDecoder().decode(res.body.subarray(0, 600)).trim().slice(0, 200);
      if (said) this.view({ k: 'refused', text: said });
    }
    if (m.kind === 'asset') {
      if (spaFallback(m.path, res)) {
        // the PC has no such file: an old frame asking for its build's file after an upgrade or a rebuild
        this.checkVersion();
        return { status: 404, headers: {}, body: null };
      }
      // the answer first; keeping it is extra (and index.html is only ever stored by ensureAppCache, last: it marks
      // a cache whole)
      if (res.status === 200 && m.method === 'GET' && m.cache && m.cache === this.cache && m.path.split('?')[0] !== pcPath('index.html')) {
        void this.keep(this.cache, m.path, res);
      }
    }
    return replyFromPc(res);
  }

  private async keep(cache: string, path: string, res: MuxResponse): Promise<void> {
    try {
      await (await this.o.caches.open(cache)).put(appKey(this.o.scope, path), toCached(res));
    } catch (e) {
      console.error('[shell] keeping an app file:', errText(e));
    }
  }

  private explain(e: unknown): Explained {
    // the device room: silence there may also be a phone revoked on the PC
    return explain(e, { rtcMissing: this.o.rtcMissing, device: true });
  }

  private view(v: SessionView): void {
    if (this.closed) return;
    try {
      this.o.onview(v);
    } catch (e) {
      console.error('[shell] view:', e);
    }
  }

  private entry(): string {
    return appEntry(this.o.scope, this.o.owner, this.cache);
  }

  /**
   * A dial to the device room, its Mux made at once (the link's frames may already be waiting). After a relay link,
   * with no sign of a network change since, ICE gets only a short window: direct did not get through here just now.
   */
  private async link(fresh: boolean): Promise<Mux> {
    const room = await deviceRoom(this.o.device.token);
    if (this.closed) throw new Stale();
    const short = this.lastKind === 'relay' && Date.now() - this.netAt >= NETWORK_CHANGE_MS;
    const plan: DialPlan = { fresh, lists: listsOf(this.o.device), ...(short ? { iceMs: RELAY_AGAIN_ICE_MS } : {}) };
    const r = await this.o.dialer.dial(room, (step) => this.view({ k: 'dialing', step }), plan);
    if (this.closed) {
      r.link.close();
      throw new Stale();
    }
    this.lastKind = r.link.kind;
    const mux = new Mux(r.link);
    mux.onclose = (why) => this.lost(mux, why);
    this.mux = mux;
    if (r.link.kind !== 'relay') this.o.dialer.idle();
    return mux;
  }

  /**
   * The first link and the app's files over it. A dial that fails ends it (once more on pc-silent right after
   * pairing); a link that drops while the files come is dialed again, like a redial.
   */
  private async firstLink(): Promise<{ mux: Mux; got: Build }> {
    const delays = this.o.redialDelays ?? REDIAL_DELAYS;
    const wait = this.o.wait ?? sleep;
    let silentRetry = !!this.o.justPaired;
    let again = 0;
    let fresh = false;
    for (;;) {
      let mux: Mux;
      try {
        mux = await this.link(fresh);
      } catch (e) {
        if (silentRetry && (e as { code?: string }).code === 'pc-silent' && !this.closed) {
          silentRetry = false;
          continue;
        }
        throw e;
      }
      try {
        return { mux, got: await this.files(mux) };
      } catch (e) {
        if (!(e instanceof LinkLost) || ++again >= delays.length) throw e;
        this.view({ k: 'relinking' });
        if (delays[again]) await wait(delays[again]);
        if (this.closed) throw new Stale();
        fresh = true;
      }
    }
  }

  /** The PC's build (version + index.html), and its files in the cache (taken now if new). */
  private async files(mux: Mux): Promise<Build> {
    try {
      const version = healthVersion(await mux.request({ method: 'GET', path: pcPath('api/health') }));
      const get = (path: string) => mux.request({ method: 'GET', path });
      // index.html first, every time: it names the build (a rebuild at the same version is another one)
      const index = await fetchOk(get, pcPath('index.html'));
      const build = await appVersion(version, index.body);
      const cache = await ensureAppCache({
        caches: this.o.caches,
        scope: this.o.scope,
        deviceId: this.o.device.id,
        version: build,
        index,
        get,
        onProgress: (done, total) => this.view({ k: 'files', done, total }),
      });
      if (mux !== this.mux) throw new LinkLost('the link to the PC has ended');
      return { build, cache };
    } catch (e) {
      if (e instanceof LinkLost || mux !== this.mux) throw new LinkLost(errText(e));
      throw new ShellError(explainFiles(e));
    }
  }

  private lost(mux: Mux, why: string): void {
    if (mux !== this.mux || this.closed) return;
    this.mux = null;
    // before the app opened, firstLink() sees the link gone and dials again
    if (!this.opened) return;
    const end = explainLinkEnd(why);
    if (end) return this.down(end);
    void this.redial();
  }

  private async relink(): Promise<void> {
    this.tunnel.setLink(null, 'redialing');
    this.view({ k: 'relinking' });
    const wait = this.o.wait ?? sleep;
    let last: unknown = new Error('no redial attempt was made');
    for (const ms of this.o.redialDelays ?? REDIAL_DELAYS) {
      if (ms) await wait(ms);
      if (this.closed) return;
      try {
        const mux = await this.link(true);
        const got = await this.files(mux);
        if (mux !== this.mux) throw new LinkLost('the link to the PC has ended');
        if (got.build !== this.build) this.switchTo(mux, got);
        else {
          this.tunnel.setLink(mux, 'up');
          this.view({ k: 'linked', kind: mux.kind });
        }
        this.wake(mux);
        return;
      } catch (e) {
        if (e instanceof Stale || this.closed) return;
        last = e;
        const m = this.mux;
        this.mux = null;
        m?.close();
      }
    }
    this.down(this.explain(last));
  }

  /** The PC runs another build now: the app's streams end and it is opened again on that build's files. */
  private switchTo(mux: Mux, got: Build): void {
    this.tunnel.closeAll();
    this.build = got.build;
    this.cache = got.cache;
    this.tunnel.setLink(mux, 'up');
    this.view({ k: 'open', url: this.entry(), kind: mux.kind, reload: true });
  }

  /** An old frame asked for a file the PC no longer has: another build on the PC? (at most every 10 s) */
  private checkVersion(): void {
    const mux = this.mux;
    const now = Date.now();
    if (!mux || this.checking || this.redialing || now - this.lastCheck < VERSION_CHECK_EVERY_MS) return;
    this.checking = true;
    this.lastCheck = now;
    void (async () => {
      const version = healthVersion(await mux.request({ method: 'GET', path: pcPath('api/health') }));
      const index = await fetchOk((path) => mux.request({ method: 'GET', path }), pcPath('index.html'));
      if ((await appVersion(version, index.body)) === this.build || mux !== this.mux) return;
      this.view({ k: 'updating' });
      const got = await this.files(mux);
      if (mux === this.mux) this.switchTo(mux, got);
    })()
      .catch((e) => console.error('[shell] version check:', errText(e)))
      .finally(() => (this.checking = false));
  }

  private down(why: Explained): void {
    this.tunnel.setLink(null, 'down');
    this.wake(null);
    this.view({ k: 'down', why });
  }

  private linkUp(): Promise<Mux | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.mux && !this.redialing) return Promise.resolve(this.mux);
    if (!this.redialing) return Promise.resolve(null);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(null);
      }, SERVE_WAIT_MS);
      const done = (m: Mux | null) => {
        clearTimeout(t);
        resolve(m);
      };
      this.waiters.push(done);
    });
  }

  private wake(m: Mux | null): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f(m);
  }
}

/** What the user reads for a failure anywhere in a connection. */
export function explain(e: unknown, c: DialContext = {}): Explained {
  if (e instanceof ShellError) return e.explained;
  return explainDial(e, c);
}

function aborted(): Error {
  const e = new Error('the pairing was cancelled');
  e.name = 'AbortError';
  return e;
}

/**
 * Pairs over the pairing room of `link` (the QR): dial, POST api/pair {code, name} (the PC names the phone from the
 * user agent), the pairing link closed after. Returns the device to keep; throws a ShellError, or an AbortError once
 * `signal` fires (its link is closed then, and its result dropped).
 */
export async function pairWith(
  link: PairLink,
  dialer: Dialer,
  onstate: (s: DialState) => void,
  userAgent: string,
  o: { signal?: AbortSignal; now?: () => number; rtcMissing?: boolean } = {},
): Promise<DeviceRec> {
  const ctx = { rtcMissing: o.rtcMissing };
  if (o.signal?.aborted) throw aborted();
  let r: DialResult;
  // the link's own lists (a PC on the defaults names none): the PC listens on them
  const lists: PcLists = { ...(link.brokers ? { brokers: link.brokers } : {}), ...(link.stun ? { stun: link.stun } : {}) };
  try {
    r = await dialer.dial(await pairRoom(link.ps), (s) => o.signal?.aborted || onstate(s), { fresh: false, lists });
  } catch (e) {
    if (o.signal?.aborted) throw aborted();
    throw new ShellError(explainPairDial(e, ctx));
  }
  const mux = new Mux(r.link);
  const stop = () => mux.close();
  o.signal?.addEventListener('abort', stop, { once: true });
  try {
    if (o.signal?.aborted) throw aborted();
    let res: MuxResponse;
    try {
      res = await mux.request({
        method: 'POST',
        path: pcPath('api/pair'),
        headers: { 'content-type': 'application/json', 'user-agent': userAgent },
        body: enc.encode(JSON.stringify({ code: link.code, name: '' })),
      });
    } catch (e) {
      if (o.signal?.aborted) throw aborted();
      throw new ShellError(explainPcError(errText(e)));
    }
    if (o.signal?.aborted) throw aborted();
    const a = readPairAnswer(res);
    if ('error' in a) throw new ShellError({ text: a.error, raw: '' }, true);
    // the lists go on the record: every later dial of this PC uses them
    return { id: a.id, pcName: r.pcName || link.pc || '电脑', token: a.token, pairedAt: (o.now ?? Date.now)(), ...lists };
  } finally {
    o.signal?.removeEventListener('abort', stop);
    mux.close();
  }
}
