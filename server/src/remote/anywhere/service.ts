// 在外面也能用: while remote access is on (and `remote.anywhere` is not off), the PC listens on the signaling brokers
// in one room per paired device (and, while a pairing code is valid, in that code's pairing room), takes the phones'
// links (direct, or the slow relay) and bridges them to its own remote-access listener (bridge.ts). The device list,
// tokens, pairing and revocation stay RemoteService's: a paired device gets its room, a revoked one loses it and
// every link it had at once.
import os from 'node:os';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { MetaStore } from '../../meta/store.js';
import type { AnywhereRecent, AnywhereStatus } from '../../protocol.js';
import { proxy, proxyAgentFor } from '../../net/proxy.js';
import type { RemoteService } from '../service.js';
import { serveBridge } from './bridge.js';
import {
  ACCEPT_FAILURE,
  Acceptor,
  Brokers,
  DEFAULT_BROKERS,
  DEFAULT_STUN,
  b64u,
  brokerEntries,
  deviceRoomFromHash,
  pairRoom,
  stunEntries,
  type BrokerDef,
  type Link,
  type LinkKind,
  type RtcCtor,
} from './core/index.js';
import { loadRtc } from './rtc.js';

/**
 * The phone page the QR opens while `remote.anywhere.shellUrl` is not set (the settings page shows it from status()):
 * the only place the default is written. It is the site of its own organization (claude-web-shell, created 2026-10-02),
 * served at its root and deployed by that site repo from this repo's release tags (deploy/shell-site/).
 */
export const DEFAULT_SHELL_URL = 'https://claude-web-shell.github.io/';
export const RECENT_MAX = 20;
/** The Acceptor's room id for the pairing code's room (device ids are 12 hex characters). */
const PAIR_ROOM = 'pairing';
const PAIR_SECRET_BYTES = 16;
/** pairUrl() waits this long at most for the pairing room's subscription before handing out the QR address. */
const PAIR_SUBSCRIBE_WAIT_MS = 3_000;
const BROKER_CLOSE_MS = 2_000;
const enc = new TextEncoder();

function report(what: string, e: unknown): void {
  console.error(`[anywhere] ${what}:`, e instanceof Error ? e.message : e);
}

/**
 * Settings' broker list (its usable entries, by core's rule: lists.ts, the same as the shell's), or the defaults when
 * there is none. CW_NO_PUBLIC_BROKERS=1 (the e2e and ui-smoke runs) leaves the defaults out: tests only ever reach a
 * local test broker they configure themselves.
 */
export function brokerDefs(v: unknown, env: Record<string, string | undefined> = process.env): BrokerDef[] {
  return brokerEntries(v) ?? (env.CW_NO_PUBLIC_BROKERS === '1' ? [] : DEFAULT_BROKERS);
}

/** Settings' STUN list (its usable entries, by core's rule), or the defaults when there is none. */
export function stunList(v: unknown): string[] {
  return stunEntries(v) ?? DEFAULT_STUN;
}

export function shellUrlOf(v: unknown): string {
  return typeof v === 'string' && /^https?:\/\/\S+$/i.test(v) ? v.split('#')[0] : DEFAULT_SHELL_URL;
}

/** What `recent` says about a link that ended on a protocol error: the phone's page and this app speak different versions. */
export function linkError(why: string): string | undefined {
  if (!why.startsWith('protocol:')) return undefined;
  return `手机上的页面和电脑上的 Claude Web 版本不一致，请刷新手机上的页面或更新电脑上的 Claude Web（${why}）`;
}

/**
 * What `recent` says about an attempt that ended without a link (Acceptor onFailure). The settings page puts it after
 * 「没连上：」; a reason from the relay link itself stays, in parentheses.
 */
export function failureText(why: string): string {
  if (why === ACCEPT_FAILURE.halfOpen) return '手机打了招呼，但通道没有建立起来';
  if (why === ACCEPT_FAILURE.evicted) return '同时连进来的太多，较早的一次被放弃了';
  if (why.startsWith(ACCEPT_FAILURE.relay)) {
    const raw = why.slice(ACCEPT_FAILURE.relay.length).replace(/^:\s*/, '');
    return raw ? `慢速转发没能建立（${raw}）` : '慢速转发没能建立';
  }
  return `没有建立起通道（${why}）`;
}

/**
 * The brokers' sockets: the `ws` package through the user's proxy (net/proxy.ts) when one applies to the broker.
 * A close waits at most 2 s for the broker's close frame (the default 30 s timer would hold stop()).
 */
class BrokerSocket extends WebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, { agent: proxyAgentFor(url), perMessageDeflate: false, closeTimeout: BROKER_CLOSE_MS } as WebSocket.ClientOptions);
  }
}

/** Without node-datachannel there is no direct link: every attempt says nodirect and the phone takes the relay. */
function noRtc(why: string): RtcCtor {
  return class {
    constructor() {
      throw new Error(`no direct link on this PC: ${why}`);
    }
  } as unknown as RtcCtor;
}

interface Session {
  deviceId: string;
  kind: LinkKind;
  since: number;
}

interface Run {
  key: string;
  port: number;
  brokers: Brokers;
  acceptor: Acceptor;
  /** The pairing code whose room is answered, and when that room goes. */
  pairCode?: string;
  pairTimer?: ReturnType<typeof setTimeout>;
}

export interface AnywhereOptions {
  /** The Acceptor's halfOpenMs (tests: an attempt given up half-way fails sooner). */
  halfOpenMs?: number;
}

export class AnywhereService extends EventEmitter {
  private run: Run | null = null;
  private readonly sessions = new Set<Session>();
  private recent: AnywhereRecent[] = [];
  private chain: Promise<void> = Promise.resolve();
  private gen = 0;
  private pairGen = 0;

  constructor(private readonly meta: MetaStore, private readonly remote: RemoteService, private readonly opts: AnywhereOptions = {}) {
    super();
    remote.on('paired', (id: string) => void this.addDevice(id));
    remote.on('revoked', (id: string) => this.dropDevice(id));
    remote.on('pairEnded', (code: string) => this.pairEnded(code));
    remote.pairUrlHook = (code) => this.pairUrl(code);
  }

  /** Starts if remote access is running and 在外面也能用 is on; otherwise stays off. */
  start(): Promise<void> {
    return this.serial(() => this.startNow());
  }

  stop(): Promise<void> {
    return this.serial(async () => this.stopNow());
  }

  /** After a setting changed: restarts when what it runs with changed, starts or stops when it should. */
  refresh(): Promise<void> {
    return this.serial(async () => {
      const cfg = this.config();
      if (this.run && cfg.on && this.run.key === cfg.key) {
        this.emit('changed');
        return;
      }
      this.stopNow();
      await this.startNow();
    });
  }

  status(): AnywhereStatus {
    const r = this.run;
    const s = this.meta.settings();
    return {
      on: !!r,
      brokers: r ? r.brokers.status() : [],
      sessions: [...this.sessions].map(({ deviceId, kind, since }) => ({ deviceId, kind, since })),
      recent: this.recent.map((e) => ({ ...e })),
      shellUrl: shellUrlOf(s['remote.anywhere.shellUrl']),
      keepAwake: s['remote.keepAwake'] !== false,
    };
  }

  /**
   * The QR address for the pairing code `code` (RemoteService's current one): a fresh pairing secret P, its room
   * subscribed until the code expires (a newer code's room replaces it). Null when off, or for any other code.
   */
  async pairUrl(code: string): Promise<string | null> {
    const r = this.run;
    const p = this.remote.currentPair();
    if (!r || !p || p.code !== code) return null;
    const mine = ++this.pairGen;
    const ps = crypto.getRandomValues(new Uint8Array(PAIR_SECRET_BYTES));
    const room = await pairRoom(ps);
    // stopped, a newer code came meanwhile (its own call returns the address), or this one was used up already
    if (this.run !== r || mine !== this.pairGen || this.remote.currentPair()?.code !== code) return null;
    clearTimeout(r.pairTimer);
    // at expiry the room goes, with any pairing link still open through it
    const timer = setTimeout(() => {
      if (this.run !== r || r.pairTimer !== timer) return;
      r.pairTimer = undefined;
      r.pairCode = undefined;
      r.acceptor.removeRoom(PAIR_ROOM);
    }, Math.max(0, p.expiresAt - Date.now()));
    timer.unref?.();
    r.pairTimer = timer;
    r.pairCode = code;
    const added = r.acceptor.addRoom(PAIR_ROOM, room).catch((e) => {
      if (this.run === r) report('pairing room', e);
    });
    // not held for long by a slow broker: the phone takes seconds to scan anyway
    let wait: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([added, new Promise<void>((res) => (wait = setTimeout(res, PAIR_SUBSCRIBE_WAIT_MS)))]);
    clearTimeout(wait);
    if (this.run !== r || mine !== this.pairGen || r.pairCode !== code) return null;
    const qr = { v: 1, ps: b64u(ps), code, pc: os.hostname() };
    return `${shellUrlOf(this.meta.settings()['remote.anywhere.shellUrl'])}#p=${b64u(enc.encode(JSON.stringify(qr)))}`;
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private config(): { on: boolean; key: string; port: number; brokers: BrokerDef[]; stun: string[] } {
    const s = this.meta.settings();
    const port = this.remote.isRunning() ? this.remote.port : 0;
    const brokers = brokerDefs(s['remote.anywhere.brokers']);
    const stun = stunList(s['remote.anywhere.stun']);
    return { on: port > 0 && s['remote.anywhere'] !== false, key: JSON.stringify({ port, brokers, stun }), port, brokers, stun };
  }

  private async startNow(): Promise<void> {
    if (this.run) return;
    const cfg = this.config();
    if (!cfg.on) {
      this.emit('changed');
      return;
    }
    const gen = ++this.gen;
    // the brokers are reached through the user's proxy, if any: a fresh look first, as for any request that goes out
    await proxy.refresh().catch(() => {});
    const loaded = await loadRtc();
    if (gen !== this.gen) return;
    const rtc = 'error' in loaded ? noRtc(loaded.error) : (loaded.RTCPeerConnection as unknown as RtcCtor);
    if ('error' in loaded) report('direct links are off', loaded.error);
    const brokers = new Brokers(cfg.brokers, { WebSocket: BrokerSocket });
    const acceptor = new Acceptor({
      brokers,
      rtc,
      stun: cfg.stun,
      pcName: os.hostname(),
      onLink: (link, roomId) => this.onLink(link, roomId),
      onFailure: (roomId, why) => this.failed(roomId, why),
      ...(this.opts.halfOpenMs !== undefined ? { halfOpenMs: this.opts.halfOpenMs } : {}),
    });
    const r: Run = { key: cfg.key, port: cfg.port, brokers, acceptor };
    this.run = r;
    brokers.onchange = () => {
      if (this.run === r) this.emit('changed');
    };
    brokers.start();
    this.emit('changed');
    for (const d of this.meta.devices()) void this.addDevice(d.id);
  }

  private stopNow(): void {
    this.gen++;
    this.pairGen++;
    const r = this.run;
    this.run = null;
    if (!r) return;
    clearTimeout(r.pairTimer);
    // ends every link (each bridge hears it and closes its streams), then the subscriptions go with the brokers
    r.acceptor.close();
    r.brokers.onchange = undefined;
    r.brokers.stop();
    this.sessions.clear();
    this.emit('changed');
  }

  private async addDevice(id: string): Promise<void> {
    const r = this.run;
    const d = r && this.meta.devices().find((x) => x.id === id);
    if (!r || !d) return;
    let room;
    try {
      room = await deviceRoomFromHash(d.tokenHash);
    } catch (e) {
      // never the hash itself in the log: it is the device room's key material
      return report(`device ${id} has no usable token hash`, e);
    }
    // stopped, or revoked meanwhile
    if (this.run !== r || !this.meta.devices().some((x) => x.id === id)) return;
    try {
      await r.acceptor.addRoom(id, room);
    } catch (e) {
      if (this.run === r) report(`device ${id} room`, e);
    }
  }

  /** Revoked: its room is unsubscribed and every link through it ends now (the bridges close their streams). */
  private dropDevice(id: string): void {
    this.run?.acceptor.removeRoom(id);
  }

  /**
   * The code was used (or its tries ran out): its room stops answering at once. The pairing link that carried the
   * reply is not cut (the phone closes it once it has the token; at expiry it goes anyway).
   */
  private pairEnded(code: string): void {
    const r = this.run;
    if (!r || r.pairCode !== code) return;
    r.pairCode = undefined;
    r.acceptor.retireRoom(PAIR_ROOM);
  }

  private failed(roomId: string, why: string): void {
    const deviceId = roomId === PAIR_ROOM ? undefined : roomId;
    this.record({ at: Date.now(), ...(deviceId ? { deviceId } : {}), ok: false, error: failureText(why) });
  }

  private onLink(link: Link, roomId: string): void {
    const r = this.run;
    if (!r) return link.close();
    const pairing = roomId === PAIR_ROOM;
    const deviceId = pairing ? undefined : roomId;
    const kind = link.kind;
    const ses: Session | null = deviceId ? { deviceId, kind, since: Date.now() } : null;
    // synchronously, inside onLink: frames may already be waiting
    serveBridge(link, {
      port: r.port,
      relay: kind === 'relay',
      deviceId,
      pairing,
      tokenOk: deviceId ? (t) => this.remote.authenticate(t) === deviceId : undefined,
      onclose: (why) => this.ended(ses, deviceId, kind, why),
    });
    if (ses) this.sessions.add(ses);
    this.record({ at: Date.now(), ...(deviceId ? { deviceId } : {}), ok: true, kind });
  }

  private ended(ses: Session | null, deviceId: string | undefined, kind: LinkKind, why: string): void {
    if (ses) this.sessions.delete(ses);
    const error = linkError(why);
    if (error) this.record({ at: Date.now(), ...(deviceId ? { deviceId } : {}), ok: false, kind, error });
    else this.emit('changed');
  }

  private record(e: AnywhereRecent): void {
    this.recent.unshift(e);
    if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX;
    this.emit('changed');
  }
}
