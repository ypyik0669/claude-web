// One connection to a paired PC: dial, the app's files for the PC's version, the app's tunnel, and a redial when the
// link drops (先直连，不行转发: dial() tries the direct link first, the slow relay after it). Also answers the app
// frame's requests that the service worker hands to this window (serve). Pairing is pairWith(). No DOM: main.ts
// shows the views, and the tests drive it with a fake PC.
import { Mux, deviceRoom, pairRoom, type DialResult, type DialState, type LinkKind, type Room } from '@anywhere';
import { cacheName, ensureAppCache, healthVersion, toCached, type CachesLike } from './assets';
import type { DeviceRec } from './devices';
import { explainDial, explainFiles, explainLinkEnd, explainPcError, errText, type Explained } from './explain';
import { replyFromError, replyFromPc, spaFallback, withToken, type ShellReply, type ShellRequest } from './forward';
import { readPairAnswer, type PairLink } from './pair-link';
import { appEntry, appKey, pcPath } from './route';
import { ShellTunnel } from './tunnel';

/** The shell's way to reach a room: dial() with its brokers, STUN list and RTC (main.ts). */
export interface Dialer {
  /** `fresh`: restart the broker connections first (a redial after the network changed). */
  dial(room: Room, onstate: (s: DialState) => void, fresh: boolean): Promise<DialResult>;
  /** A direct link is up: the broker connections can close until the next dial (the relay needs them). */
  idle(): void;
}

export type SessionView =
  | { k: 'dialing'; step: DialState }
  | { k: 'files'; done: number; total: number }
  /** Show the app at `url` (again, `reload`, when the PC's version changed). */
  | { k: 'open'; url: string; kind: LinkKind; reload: boolean }
  | { k: 'relinking' }
  | { k: 'linked'; kind: LinkKind }
  /** The PC's version changed while the app was open: its files are being taken. */
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
}

const REDIAL_DELAYS = [0, 2_000, 5_000];
/** How long a frame's request waits for a redial (the service worker gives up at 60 s). */
const SERVE_WAIT_MS = 55_000;
const VERSION_CHECK_EVERY_MS = 10_000;
const enc = new TextEncoder();

/** A failure that already says what the user reads. */
export class ShellError extends Error {
  constructor(readonly explained: Explained) {
    super(explained.raw || explained.text);
    this.name = 'ShellError';
  }
}

class Stale extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Session {
  readonly tunnel: ShellTunnel;
  private mux: Mux | null = null;
  private version = '';
  private cache = '';
  private opened = false;
  private closed = false;
  private redialing: Promise<void> | null = null;
  private waiters: ((m: Mux | null) => void)[] = [];
  private checking = false;
  private lastCheck = 0;

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
      let mux: Mux;
      try {
        mux = await this.link(false);
      } catch (e) {
        if (!this.o.justPaired || (e as { code?: string }).code !== 'pc-silent' || this.closed) throw e;
        mux = await this.link(false);
      }
      const version = await this.files(mux);
      if (mux !== this.mux) throw new Error('the link to the PC has ended');
      this.version = version.version;
      this.cache = version.cache;
      this.opened = true;
      this.tunnel.setLink(mux, 'up');
      this.o.onopened?.();
      this.view({ k: 'open', url: this.entry(), kind: mux.kind, reload: false });
    } catch (e) {
      if (e instanceof Stale || this.closed) return;
      this.mux?.close();
      this.mux = null;
      this.view({ k: 'failed', why: explain(e) });
    }
  }

  /** Dials again now (重新连接, the network came back); nothing while a link is up or a redial is on. */
  redial(): Promise<void> {
    if (this.closed || !this.opened || this.mux) return this.redialing ?? Promise.resolve();
    return (this.redialing ??= this.relink().finally(() => (this.redialing = null)));
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
    let res;
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
        // the PC has no such file: an old frame asking for its version's file after an upgrade
        this.checkVersion();
        return { status: 404, headers: {}, body: null };
      }
      // index.html is only ever stored by ensureAppCache, last: it is the mark that a cache is whole
      if (res.status === 200 && m.method === 'GET' && m.cache && m.cache === this.cache && m.path.split('?')[0] !== pcPath('index.html')) {
        await (await this.o.caches.open(this.cache)).put(appKey(this.o.scope, m.path), toCached(res)).catch(() => {});
      }
    }
    return replyFromPc(res);
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

  /** A dial to the device room, its Mux made at once (the link's frames may already be waiting). */
  private async link(fresh: boolean): Promise<Mux> {
    const room = await deviceRoom(this.o.device.token);
    if (this.closed) throw new Stale();
    const r = await this.o.dialer.dial(room, (step) => this.view({ k: 'dialing', step }), fresh);
    if (this.closed) {
      r.link.close();
      throw new Stale();
    }
    const mux = new Mux(r.link);
    mux.onclose = (why) => this.lost(mux, why);
    this.mux = mux;
    if (r.link.kind !== 'relay') this.o.dialer.idle();
    return mux;
  }

  /** The PC's version, and its files in the cache (taken now if new). */
  private async files(mux: Mux): Promise<{ version: string; cache: string }> {
    let version: string;
    try {
      version = healthVersion(await mux.request({ method: 'GET', path: pcPath('api/health') }));
      const cache = await ensureAppCache({
        caches: this.o.caches,
        scope: this.o.scope,
        deviceId: this.o.device.id,
        version,
        get: (path) => mux.request({ method: 'GET', path }),
        onProgress: (done, total) => this.view({ k: 'files', done, total }),
      });
      return { version, cache };
    } catch (e) {
      throw new ShellError(explainFiles(e));
    }
  }

  private lost(mux: Mux, why: string): void {
    if (mux !== this.mux || this.closed) return;
    this.mux = null;
    // before the app opened, start() sees the link gone and fails
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
        const { version, cache } = await this.files(mux);
        if (mux !== this.mux) throw new Error('the link to the PC has ended');
        if (version !== this.version) this.switchTo(mux, version, cache);
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
    this.down(explain(last));
  }

  /** The PC runs another version now: the app's streams end and it is opened again on that version's files. */
  private switchTo(mux: Mux, version: string, cache: string): void {
    this.tunnel.closeAll();
    this.version = version;
    this.cache = cache;
    this.tunnel.setLink(mux, 'up');
    this.view({ k: 'open', url: this.entry(), kind: mux.kind, reload: true });
  }

  /** An old frame asked for a file the PC no longer has: has the PC been upgraded? (at most every 10 s) */
  private checkVersion(): void {
    const mux = this.mux;
    const now = Date.now();
    if (!mux || this.checking || this.redialing || now - this.lastCheck < VERSION_CHECK_EVERY_MS) return;
    this.checking = true;
    this.lastCheck = now;
    void (async () => {
      const v = healthVersion(await mux.request({ method: 'GET', path: pcPath('api/health') }));
      if (v === this.version || mux !== this.mux) return;
      this.view({ k: 'updating' });
      const { version, cache } = await this.files(mux);
      if (mux === this.mux) this.switchTo(mux, version, cache);
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
export function explain(e: unknown): Explained {
  if (e instanceof ShellError) return e.explained;
  return explainDial(e);
}

/**
 * Pairs over the pairing room of `link` (the QR): dial, POST api/pair {code, name} (the PC names the phone from the
 * user agent), the pairing link closed after. Returns the device to keep; throws a ShellError.
 */
export async function pairWith(link: PairLink, dialer: Dialer, onstate: (s: DialState) => void, userAgent: string, now: () => number = Date.now): Promise<DeviceRec> {
  let r: DialResult;
  try {
    r = await dialer.dial(await pairRoom(link.ps), onstate, false);
  } catch (e) {
    throw new ShellError(explainDial(e));
  }
  const mux = new Mux(r.link);
  try {
    let res;
    try {
      res = await mux.request({
        method: 'POST',
        path: pcPath('api/pair'),
        headers: { 'content-type': 'application/json', 'user-agent': userAgent },
        body: enc.encode(JSON.stringify({ code: link.code, name: '' })),
      });
    } catch (e) {
      throw new ShellError(explainPcError(errText(e)));
    }
    const a = readPairAnswer(res);
    if ('error' in a) throw new ShellError({ text: a.error, raw: '' });
    return { id: a.id, pcName: r.pcName || link.pc || '电脑', token: a.token, pairedAt: now() };
  } finally {
    mux.close();
  }
}
