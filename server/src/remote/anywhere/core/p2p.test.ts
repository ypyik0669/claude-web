import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBroker } from '../__mocks__/mqtt-broker.mjs';
import { loadRtc } from '../rtc.js';
import {
  ACCEPT_MAX_HALF_OPEN,
  Acceptor,
  Brokers,
  DEFAULT_BROKERS,
  DEFAULT_STUN,
  DialError,
  MAX_FRAME_BYTES,
  P2P_DISCONNECT_GRACE_MS,
  P2P_FLAG,
  P2P_PIECE_BYTES,
  P2pLink,
  SignalChannel,
  b64u,
  deviceRoom,
  dial,
  type AcceptorOptions,
  type BrokerDef,
  type DialOptions,
  type Link,
  type Room,
  type RtcCtor,
} from './index.js';

type Broker = Awaited<ReturnType<typeof startBroker>>;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function rand(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65_536)));
  return out;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Records every RTCPeerConnection and data channel made through it, so a test can reach them and check they closed. */
async function tracked() {
  const m = await loadRtc();
  if ('error' in m) throw new Error(m.error);
  const pcs: any[] = [];
  const dcs: any[] = [];
  const Base = m.RTCPeerConnection;
  class Pc extends Base {
    constructor(config?: any) {
      super(config);
      pcs.push(this);
      const create = this.createDataChannel.bind(this);
      (this as any).createDataChannel = (...a: Parameters<typeof create>) => {
        const dc = create(...a);
        dcs.push(dc);
        return dc;
      };
      this.addEventListener('datachannel', (e: any) => dcs.push(e.channel));
    }
  }
  return { Ctor: Pc as unknown as RtcCtor, pcs, dcs };
}

/** Topics a pool is subscribed to right now (subscribe / unsubscribe calls, as the pool sees them). */
function topicsOf(p: Brokers): Set<string> {
  const live = new Set<string>();
  const sub = p.subscribe.bind(p);
  const unsub = p.unsubscribe.bind(p);
  vi.spyOn(p, 'subscribe').mockImplementation((t, cb) => {
    live.add(t);
    return sub(t, cb);
  });
  vi.spyOn(p, 'unsubscribe').mockImplementation((t) => {
    live.delete(t);
    unsub(t);
  });
  return live;
}

/** Live timers set from the files under test (the socket and relay code set and clear their own). */
function ourTimers(): () => number {
  const live = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const mine = /[\\/](dial|accept|p2p-link)\.ts/.test(new Error().stack ?? '');
    const h = realSet((...a: unknown[]) => {
      live.delete(h);
      fn(...a);
    }, ms, ...args);
    if (mine) live.add(h);
    return h;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((h?: Parameters<typeof clearTimeout>[0]) => {
    live.delete(h);
    realClear(h);
  }) as typeof clearTimeout);
  return () => live.size;
}

async function broker(): Promise<Broker> {
  const b = await startBroker();
  cleanup.push(() => b.close());
  return b;
}

function pool(defs: BrokerDef[]): Brokers {
  const p = new Brokers(defs);
  cleanup.push(() => p.stop());
  p.start();
  return p;
}

interface End {
  link: Link;
  got: Uint8Array[];
  closed: string[];
}

function watch(link: Link): End {
  const e: End = { link, got: [], closed: [] };
  // synchronously, as the Link contract asks: frames may already be waiting
  link.onframe = (f) => e.got.push(f);
  link.onclose = (why) => e.closed.push(why);
  return e;
}

/** A phone pool, a PC pool, one room, and an Acceptor on the PC side with the room added. */
async function env(acceptor: Partial<AcceptorOptions> = {}) {
  const b = await broker();
  const defs: BrokerDef[] = [{ name: 'local', url: b.url, relay: true }];
  const phone = pool(defs);
  const pc = pool(defs);
  const phoneTopics = topicsOf(phone);
  const pcTopics = topicsOf(pc);
  await until(() => [phone, pc].every((p) => p.status().every((s) => s.ok)), 'both pools up');
  const room = await deviceRoom('device-token');
  const phoneRtc = await tracked();
  const pcRtc = await tracked();
  const links: End[] = [];
  const rooms: string[] = [];
  const acc = new Acceptor({
    brokers: pc,
    rtc: pcRtc.Ctor,
    stun: [],
    pcName: 'Test PC',
    onLink: (link, id) => {
      links.push(watch(link));
      rooms.push(id);
    },
    ...acceptor,
  });
  cleanup.push(() => acc.close());
  await acc.addRoom('dev1', room);
  const dialNow = async (extra: Partial<DialOptions> = {}) => {
    const r = await dial({ brokers: phone, room, stun: [], rtc: phoneRtc.Ctor, helloTimeoutMs: 3000, ...extra });
    const e = watch(r.link);
    cleanup.push(() => r.link.close());
    return { ...r, end: e };
  };
  return { b, defs, phone, pc, phoneTopics, pcTopics, room, phoneRtc, pcRtc, acc, links, rooms, dialNow };
}

/** Frames both ways, every size class: empty, one piece, one piece and a byte, many pieces. */
async function exchange(phone: End, pc: End, sizes = [0, 1, 300, P2P_PIECE_BYTES, P2P_PIECE_BYTES + 1, 200_000]) {
  const up = sizes.map((n) => rand(n));
  const down = sizes.map((n) => rand(n)).reverse();
  const g0 = pc.got.length;
  const g1 = phone.got.length;
  for (const f of up) phone.link.send(f);
  for (const f of down) pc.link.send(f);
  await until(() => pc.got.length - g0 === up.length && phone.got.length - g1 === down.length, 'frames both ways', 20_000);
  expect(pc.got.slice(g0).every((f, i) => same(f, up[i]))).toBe(true);
  expect(phone.got.slice(g1).every((f, i) => same(f, down[i]))).toBe(true);
}

describe('defaults', () => {
  it('lists the brokers and STUN servers of the plan, in order', () => {
    expect(DEFAULT_BROKERS).toEqual([
      { name: 'emqx', url: 'wss://broker.emqx.io:8084/mqtt' },
      { name: 'emqx-cn', url: 'wss://broker-cn.emqx.io:8084/mqtt' },
      { name: 'mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt', relay: true },
      { name: 'shiftr', url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public', relay: true },
      { name: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt', relay: true },
    ]);
    expect(DEFAULT_STUN).toEqual([
      'stun:stun.cloudflare.com:3478',
      'stun:stun.hitv.com:3478',
      'stun:stun.miwifi.com:3478',
      'stun:stun.chat.bilibili.com:3478',
      'stun:stun.l.google.com:19302',
    ]);
  });
});

describe('dial and Acceptor', () => {
  it('connects directly: p2p kind, the PC name, frames both ways', async () => {
    const e = await env();
    const states: string[] = [];
    const r = await e.dialNow({ onstate: (s) => states.push(s) });
    expect(['p2p-v4', 'p2p-v6']).toContain(r.link.kind);
    expect(r.pcName).toBe('Test PC');
    expect(states).toEqual(['finding', 'connecting']);
    await until(() => e.links.length === 1, 'the PC side link');
    expect(e.rooms).toEqual(['dev1']);
    expect(e.links[0].link.kind).toBe(r.link.kind);
    await exchange(r.end, e.links[0]);
    // the biggest frame the contract allows, both ways
    const big = rand(MAX_FRAME_BYTES);
    r.end.link.send(big);
    e.links[0].link.send(big);
    await until(() => r.end.got.length === 7 && e.links[0].got.length === 7, '1 MiB frames', 20_000);
    expect(same(r.end.got[6], big) && same(e.links[0].got[6], big)).toBe(true);
    expect(r.end.closed).toEqual([]);
  });

  it('PC not there: pc-silent after the hello timeout', async () => {
    const e = await env();
    e.acc.removeRoom('dev1');
    const t0 = Date.now();
    const err = await dial({ brokers: e.phone, room: e.room, stun: [], rtc: e.phoneRtc.Ctor, helloTimeoutMs: 300 }).catch((x) => x);
    expect(err).toBeInstanceOf(DialError);
    expect(err.code).toBe('pc-silent');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(e.phoneRtc.pcs).toHaveLength(0);
  });

  it('no broker reachable: no-broker', async () => {
    const b = await broker();
    const url = b.url;
    await b.close();
    const p = pool([{ name: 'gone', url }]);
    const m = await loadRtc();
    if ('error' in m) throw new Error(m.error);
    const err = await dial({ brokers: p, room: await deviceRoom('device-token'), stun: [], rtc: m.RTCPeerConnection as unknown as RtcCtor, helloTimeoutMs: 300 })
      .catch((x) => x);
    expect(err).toBeInstanceOf(DialError);
    expect(err.code).toBe('no-broker');
  });

  it('forceRelay: a relay link, frames both ways', async () => {
    const e = await env();
    const states: string[] = [];
    const r = await e.dialNow({ forceRelay: true, onstate: (s) => states.push(s) });
    expect(r.link.kind).toBe('relay');
    expect(r.pcName).toBe('Test PC');
    expect(states).toEqual(['finding', 'relay']);
    await until(() => e.links.length === 1, 'the PC side link');
    expect(e.links[0].link.kind).toBe('relay');
    await exchange(r.end, e.links[0], [0, 1, 300, 20_000]);
    expect(e.phoneRtc.pcs).toHaveLength(0);
    expect(e.pcRtc.pcs).toHaveLength(0);
  });

  it('waits for the PC to confirm the relay; no confirmation: unreachable, nothing left subscribed', async () => {
    const e = await env();
    e.acc.removeRoom('dev1');
    // a PC that acks but never takes the relay up (its relay subscription failing, say)
    const fake = new SignalChannel(e.pc, e.room, 'pc');
    cleanup.push(() => fake.close());
    fake.on((m) => {
      if (m.t === 'hello') void fake.send({ t: 'ack', s: m.s, pn: m.pn, cn: b64u(rand(16)), pc: 'Fake PC' });
    });
    await fake.open();
    const t0 = Date.now();
    const err = await dial({ brokers: e.phone, room: e.room, stun: [], rtc: e.phoneRtc.Ctor, forceRelay: true, helloTimeoutMs: 400 })
      .catch((x) => x);
    expect(err).toBeInstanceOf(DialError);
    expect(err.code).toBe('unreachable');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390);
    // its relay link was closed again (the room topic is the fake PC's, on the other pool)
    expect([...e.phoneTopics]).toEqual([]);
  });

  it('relay: the first frames from the phone are not lost to a resend', async () => {
    const e = await env();
    const r = await e.dialNow({ forceRelay: true });
    const t0 = Date.now();
    r.link.send(enc.encode('first'));
    await until(() => e.links.length === 1 && e.links[0].got.length === 1, 'the first frame');
    // well under the relay's 1 500 ms resend: the PC was subscribed before dial() resolved
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('ICE cannot connect: the slow relay after iceTimeoutMs', async () => {
    const e = await env({ dropCandidates: true });
    const states: string[] = [];
    const t0 = Date.now();
    const r = await e.dialNow({ iceTimeoutMs: 1500, onstate: (s) => states.push(s) });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1490);
    expect(r.link.kind).toBe('relay');
    expect(states).toEqual(['finding', 'connecting', 'relay']);
    await until(() => e.links.length === 1, 'the PC side link');
    expect(e.links[0].link.kind).toBe('relay');
    await exchange(r.end, e.links[0], [0, 300, 20_000]);
    // both direct attempts were given up and closed
    await until(() => [...e.phoneRtc.pcs, ...e.pcRtc.pcs].every((p) => p.connectionState === 'closed'), 'attempts closed');
    expect(e.phoneRtc.pcs).toHaveLength(1);
    expect(e.pcRtc.pcs).toHaveLength(1);
  });

  it('removeRoom: established links end on both sides, the next dial gets pc-silent', async () => {
    const e = await env();
    const r = await e.dialNow();
    await until(() => e.links.length === 1, 'the PC side link');
    e.acc.removeRoom('dev1');
    expect(e.links[0].closed).toEqual(['room removed']);
    await until(() => r.end.closed.length === 1, 'the phone side onclose');
    const err = await dial({ brokers: e.phone, room: e.room, stun: [], rtc: e.phoneRtc.Ctor, helloTimeoutMs: 300 }).catch((x) => x);
    expect(err).toBeInstanceOf(DialError);
    expect(err.code).toBe('pc-silent');
    // the room's channel is gone from the PC pool
    expect([...e.pcTopics]).toEqual([]);
  });

  it('removeRoom also ends relay links on both sides', async () => {
    const e = await env();
    const r = await e.dialNow({ forceRelay: true });
    await until(() => e.links.length === 1, 'the PC side link');
    e.acc.removeRoom('dev1');
    expect(e.links[0].closed).toEqual(['room removed']);
    // the PC's close packet reaches the phone
    await until(() => r.end.closed.length === 1, 'the phone side onclose');
  });

  it('answers at most 30 hellos a minute per room; the 31st gets no ack', async () => {
    const e = await env();
    const ch = new SignalChannel(e.phone, e.room, 'phone');
    cleanup.push(() => ch.close());
    const acks = new Set<string>();
    ch.on((m) => {
      if (m.t === 'ack') acks.add(m.s);
    });
    await ch.open();
    const ss = Array.from({ length: 31 }, (_, i) => `rate-${i}`);
    for (const s of ss) await ch.send({ t: 'hello', s, pn: b64u(rand(16)) });
    await until(() => acks.size >= 30, '30 acks');
    await sleep(500);
    expect(acks.size).toBe(30);
    expect(ss.slice(0, 30).every((s) => acks.has(s))).toBe(true);
    expect(acks.has('rate-30')).toBe(false);
    // the same minute: a real dial is not answered either
    const err = await dial({ brokers: e.phone, room: e.room, stun: [], rtc: e.phoneRtc.Ctor, helloTimeoutMs: 300 }).catch((x) => x);
    expect(err.code).toBe('pc-silent');
  });

  it('redial after the direct link drops: the phone hears onclose, a new dial connects', async () => {
    const e = await env();
    const r = await e.dialNow();
    await until(() => e.links.length === 1, 'the PC side link');
    // the PC side's connection goes away under the link (a network change, a crash)
    expect(e.pcRtc.pcs).toHaveLength(1);
    e.pcRtc.pcs[0].close();
    await until(() => r.end.closed.length === 1, 'the phone side onclose');
    await until(() => e.links[0].closed.length === 1, 'the PC side onclose');
    const again = await e.dialNow();
    expect(['p2p-v4', 'p2p-v6']).toContain(again.link.kind);
    await until(() => e.links.length === 2, 'the second PC side link');
    await exchange(again.end, e.links[1], [0, 300, P2P_PIECE_BYTES + 1]);
  });

  it('drops junk, foreign rooms and messages not bound to the session', async () => {
    const e = await env();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ch = new SignalChannel(e.phone, e.room, 'phone');
    cleanup.push(() => ch.close());
    const got: { t: string; s: string; cn?: unknown }[] = [];
    ch.on((m) => got.push(m as never));
    await ch.open();
    // raw junk on the room topic, and an envelope from another room
    e.phone.publish(e.room.topic, 'not an envelope');
    e.phone.publish(e.room.topic, new Uint8Array([0, 1, 2, 3]));
    const other = new SignalChannel(e.phone, await deviceRoom('another-token'), 'phone');
    cleanup.push(() => other.close());
    await other.open();
    await other.send({ t: 'hello', s: 'foreign', pn: b64u(rand(16)) });
    // malformed hellos: bad nonce, a session id that cannot be a topic segment
    await ch.send({ t: 'hello', s: 'bad-nonce', pn: 'xyz' });
    await ch.send({ t: 'hello', s: 'a/b', pn: b64u(rand(16)) });
    await ch.send({ t: 'hello', s: 'no-nonce' });
    // an offer for a session nobody said hello for
    await ch.send({ t: 'offer', s: 'nobody', cn: b64u(rand(16)), sdp: 'v=0' });
    // a real hello, then an offer and a relay with the wrong PC nonce
    await ch.send({ t: 'hello', s: 'good', pn: b64u(rand(16)) });
    await until(() => got.some((m) => m.t === 'ack'), 'the ack');
    await ch.send({ t: 'offer', s: 'good', cn: b64u(rand(16)), sdp: 'v=0' });
    await ch.send({ t: 'relay', s: 'good', cn: b64u(rand(16)) });
    await ch.send({ t: 'cand', s: 'good', cn: 12, c: { candidate: 5 } });
    await sleep(500);
    expect(got.map((m) => `${m.t}:${m.s}`)).toEqual(['ack:good']);
    expect(e.links).toHaveLength(0);
    expect(e.pcRtc.pcs).toHaveLength(0);
    // still answers a real dial
    const r = await e.dialNow();
    expect(['p2p-v4', 'p2p-v6']).toContain(r.link.kind);
  });

  it('half-open sessions expire and are bounded per room', async () => {
    const e = await env({ halfOpenMs: 1500 });
    const ch = new SignalChannel(e.phone, e.room, 'phone');
    cleanup.push(() => ch.close());
    const acks = new Map<string, string>();
    ch.on((m) => {
      if (m.t === 'ack') acks.set(m.s, m.cn as string);
    });
    await ch.open();
    await ch.send({ t: 'hello', s: 'late', pn: b64u(rand(16)) });
    await until(() => acks.has('late'), 'the ack');
    await sleep(1800);
    await ch.send({ t: 'relay', s: 'late', cn: acks.get('late') });
    await sleep(300);
    expect(e.links).toHaveLength(0);

    // one more than the bound: the oldest is dropped, the newest still works
    const ss = Array.from({ length: ACCEPT_MAX_HALF_OPEN + 1 }, (_, i) => `many-${i}`);
    for (const s of ss) await ch.send({ t: 'hello', s, pn: b64u(rand(16)) });
    await until(() => ss.every((s) => acks.has(s)), 'all acks');
    await ch.send({ t: 'relay', s: ss[0], cn: acks.get(ss[0]) });
    await ch.send({ t: 'relay', s: ss[ss.length - 1], cn: acks.get(ss[ss.length - 1]) });
    await until(() => e.links.length === 1, 'the newest session becomes a link');
    await sleep(300);
    expect(e.links).toHaveLength(1);
    expect(e.links[0].link.kind).toBe('relay');
  });

  it('a throwing onLink or onstate does not break anything', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    const e = await env({
      onLink: (link) => {
        n++;
        link.close();
        throw new Error('consumer bug');
      },
    });
    const r = await e.dialNow({
      onstate: () => {
        throw new Error('ui bug');
      },
    });
    expect(['p2p-v4', 'p2p-v6']).toContain(r.link.kind);
    await until(() => n === 1, 'onLink');
    expect(errors).toHaveBeenCalled();
    await until(() => r.end.closed.length === 1, 'the phone hears the PC side close');
  });

  it('leaves no timers, connections or subscriptions behind', async () => {
    const live = ourTimers();
    const e = await env({ dropCandidates: false });
    // a direct link, closed from the phone
    const a = await e.dialNow();
    await until(() => e.links.length === 1, 'the first PC side link');
    a.link.close();
    await until(() => e.links[0].closed.length === 1, 'the PC side hears it');
    // a relay link, closed from the PC
    const b = await e.dialNow({ forceRelay: true });
    await until(() => e.links.length === 2, 'the second PC side link');
    e.links[1].link.close();
    await until(() => b.end.closed.length === 1, 'the phone hears it');
    b.link.close();
    // a failed dial
    e.acc.removeRoom('dev1');
    await expect(dial({ brokers: e.phone, room: e.room, stun: [], rtc: e.phoneRtc.Ctor, helloTimeoutMs: 200 })).rejects.toThrow(DialError);
    e.acc.close();
    await sleep(100);
    expect(live()).toBe(0);
    await until(() => [...e.phoneRtc.pcs, ...e.pcRtc.pcs].every((p) => p.connectionState === 'closed'), 'every connection closed');
    await until(() => [...e.phoneRtc.dcs, ...e.pcRtc.dcs].every((d) => d.readyState === 'closed'), 'every channel closed');
    // relay links unsubscribe their topics; the room channels are gone
    await until(() => e.phoneTopics.size === 0 && e.pcTopics.size === 0, 'no subscriptions left');
  });

  it('an abandoned direct attempt closes its never-opened channel and both connections', async () => {
    // a connection closed with a channel that never opened still on it keeps node-datachannel (and the process) alive
    const live = ourTimers();
    const e = await env({ dropCandidates: true });
    const r = await e.dialNow({ iceTimeoutMs: 800 });
    expect(r.link.kind).toBe('relay');
    await until(() => e.links.length === 1, 'the PC side link');
    r.link.close();
    e.acc.close();
    expect(e.phoneRtc.dcs).toHaveLength(1);
    await until(() => [...e.phoneRtc.pcs, ...e.pcRtc.pcs].every((p) => p.connectionState === 'closed'), 'every connection closed');
    await until(() => e.phoneRtc.dcs.every((d) => d.readyState === 'closed'), 'the channel closed');
    await sleep(100);
    expect(live()).toBe(0);
    await until(() => e.phoneTopics.size === 0 && e.pcTopics.size === 0, 'no subscriptions left');
  });
});

/**
 * A data channel whose buffer the test controls: on loopback libdatachannel drains as fast as send() can be called
 * (each call blocks ~1 ms), so a real channel never backs up and its backpressure cannot be tested deterministically.
 */
class FakeChannel {
  label = 'cw';
  readyState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'blob';
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onbufferedamountlow: ((ev: unknown) => void) | null = null;
  /** Messages handed over and not drained yet, and every one ever handed over. */
  out: Uint8Array[] = [];
  sent: Uint8Array[] = [];
  closed = 0;

  send(m: Uint8Array): void {
    if (this.readyState !== 'open') throw new Error('not open');
    this.out.push(m.slice());
    this.sent.push(m.slice());
    this.bufferedAmount += m.length;
  }

  close(): void {
    this.closed++;
    this.readyState = 'closed';
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.({});
  }

  /** The network took everything: what was in the buffer, as the other side receives it. */
  drain(): Uint8Array[] {
    const got = this.out;
    this.out = [];
    this.bufferedAmount = 0;
    this.onbufferedamountlow?.({});
    return got;
  }

  receive(m: Uint8Array | string): void {
    this.onmessage?.({ data: typeof m === 'string' ? m : m.slice().buffer });
  }
}

class FakePc {
  connectionState = 'connecting';
  iceConnectionState = 'checking';
  onicecandidate: unknown = null;
  ondatachannel: unknown = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  closed = 0;

  close(): void {
    this.closed++;
  }

  state(conn: string, ice = conn): void {
    this.connectionState = conn;
    this.iceConnectionState = ice;
    this.onconnectionstatechange?.();
  }
}

function fakeLink() {
  const pc = new FakePc();
  const dc = new FakeChannel();
  const link = new P2pLink(pc as never, dc as never);
  const got: Uint8Array[] = [];
  const closed: string[] = [];
  link.onframe = (f) => got.push(f);
  link.onclose = (why) => closed.push(why);
  return { pc, dc, link, got, closed };
}

describe('direct link contract', () => {
  it('splits frames into END / MORE pieces of at most P2P_PIECE_BYTES, and puts them back together', () => {
    const a = fakeLink();
    const b = fakeLink();
    a.dc.open();
    b.dc.open();
    const sizes = [0, 1, P2P_PIECE_BYTES, P2P_PIECE_BYTES + 1, 3 * P2P_PIECE_BYTES, MAX_FRAME_BYTES];
    const frames = sizes.map((n) => rand(n));
    for (const f of frames) a.link.send(f);
    // past ~1 MiB in the channel the rest waits in the link, and comes out after the next bufferedamountlow
    const msgs: Uint8Array[] = [];
    for (let batch = a.dc.drain(); batch.length > 0; batch = a.dc.drain()) msgs.push(...batch);
    expect(msgs.every((m) => m.length >= 1 && m.length <= 1 + P2P_PIECE_BYTES)).toBe(true);
    // one message per frame up to one piece; the last piece of each frame is END, the others MORE and never empty
    expect(msgs.slice(0, 3).map((m) => [m[0], m.length])).toEqual([[P2P_FLAG.end, 1], [P2P_FLAG.end, 2], [P2P_FLAG.end, 1 + P2P_PIECE_BYTES]]);
    expect(msgs.slice(3, 5).map((m) => [m[0], m.length])).toEqual([[P2P_FLAG.more, 1 + P2P_PIECE_BYTES], [P2P_FLAG.end, 2]]);
    expect(msgs.filter((m) => m[0] === P2P_FLAG.more).every((m) => m.length > 1)).toBe(true);
    for (const m of msgs) b.dc.receive(m);
    expect(b.got).toHaveLength(frames.length);
    expect(b.got.every((f, i) => same(f, frames[i]))).toBe(true);
    // each frame is its own array, not a view on the message it came in
    expect(b.got.every((f) => f.byteOffset === 0 && f.buffer.byteLength === f.length)).toBe(true);
    expect(a.closed).toEqual([]);
    expect(b.closed).toEqual([]);
  });

  it('copies what send() takes: the caller may reuse its buffer', () => {
    const a = fakeLink();
    a.dc.open();
    const f = new Uint8Array([1, 2, 3]);
    a.link.send(f);
    f.fill(9);
    expect(Array.from(a.dc.drain()[0])).toEqual([P2P_FLAG.end, 1, 2, 3]);
  });

  it('refuses frames over 1 MiB with a RangeError, and stays open', () => {
    const a = fakeLink();
    a.dc.open();
    expect(() => a.link.send(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(RangeError);
    a.link.send(new Uint8Array(1));
    expect(a.dc.sent).toHaveLength(1);
    expect(a.closed).toEqual([]);
  });

  it('holds frames while the channel is backed up, counts them in buffered(), and resumes on bufferedamountlow', () => {
    const a = fakeLink();
    a.dc.open();
    const f = rand(MAX_FRAME_BYTES);
    for (let i = 0; i < 3; i++) a.link.send(f);
    const pieces = Math.ceil(MAX_FRAME_BYTES / P2P_PIECE_BYTES);
    const total = 3 * (MAX_FRAME_BYTES + pieces);
    // the channel took a little over 1 MiB, the rest waits in the link; buffered() is both
    expect(a.dc.bufferedAmount).toBeGreaterThan(1_048_576);
    expect(a.dc.bufferedAmount).toBeLessThan(1_048_576 + 2 * P2P_PIECE_BYTES);
    expect(a.link.buffered()).toBe(total);
    let out = 0;
    for (let i = 0; i < 10 && out < total; i++) out += a.dc.drain().reduce((n, m) => n + m.length, 0);
    expect(out).toBe(total);
    expect(a.link.buffered()).toBe(0);
    expect(a.closed).toEqual([]);
  });

  it('nothing goes out before the channel opens; what was sent goes out once it does', () => {
    const a = fakeLink();
    a.link.send(new Uint8Array([7]));
    expect(a.dc.sent).toHaveLength(0);
    a.dc.open();
    expect(a.dc.sent).toHaveLength(1);
  });

  it('a send past the queue bound ends the link; onclose comes after send() returns', async () => {
    const a = fakeLink();
    a.dc.open();
    const f = new Uint8Array(MAX_FRAME_BYTES);
    let n = 0;
    while (a.link.buffered() > 0 || n === 0) {
      a.link.send(f);
      n++;
      expect(a.closed).toEqual([]);
      if (n > 20) break;
    }
    // 8 MiB of queue plus the ~1 MiB the channel took
    expect(n).toBeGreaterThanOrEqual(9);
    expect(n).toBeLessThanOrEqual(10);
    await Promise.resolve();
    expect(a.closed).toHaveLength(1);
    expect(a.closed[0]).toMatch(/waiting to be sent/);
    expect(a.dc.closed).toBe(1);
    expect(a.pc.closed).toBe(1);
    const before = a.dc.sent.length;
    a.link.send(f);
    expect(a.dc.sent.length).toBe(before);
  });

  it('close() discards what is still queued, closes channel and connection, and does not call onclose', async () => {
    const a = fakeLink();
    a.dc.open();
    const f = rand(MAX_FRAME_BYTES);
    for (let i = 0; i < 4; i++) a.link.send(f);
    const before = a.dc.sent.length;
    a.link.close();
    expect(a.link.buffered()).toBe(0);
    a.dc.drain();
    expect(a.dc.sent.length).toBe(before);
    expect(a.dc.closed).toBe(1);
    expect(a.pc.closed).toBe(1);
    await sleep(10);
    expect(a.closed).toEqual([]);
  });

  it('ends on a protocol error: unknown flag, text, empty message, empty piece, a frame past 1 MiB', () => {
    const cases: [string, (dc: FakeChannel) => void][] = [
      ['unknown flag 7', (dc) => dc.receive(new Uint8Array([7, 1]))],
      ['not binary', (dc) => dc.receive('hello')],
      ['an empty message', (dc) => dc.receive(new Uint8Array(0))],
      ['an empty piece', (dc) => dc.receive(new Uint8Array([P2P_FLAG.more]))],
      [
        'over',
        (dc) => {
          const piece = new Uint8Array(1 + P2P_PIECE_BYTES);
          piece[0] = P2P_FLAG.more;
          for (let i = 0; i < Math.ceil(MAX_FRAME_BYTES / P2P_PIECE_BYTES) + 1; i++) dc.receive(piece);
        },
      ],
    ];
    for (const [what, act] of cases) {
      const b = fakeLink();
      b.dc.open();
      act(b.dc);
      expect(b.closed).toHaveLength(1);
      expect(b.closed[0]).toContain(what);
      expect(b.got).toEqual([]);
      expect(b.dc.closed).toBe(1);
    }
  });

  it('holds frames that arrive before onframe is set, and hands them over in order', () => {
    const pc = new FakePc();
    const dc = new FakeChannel();
    const link = new P2pLink(pc as never, dc as never);
    dc.open();
    dc.receive(new Uint8Array([P2P_FLAG.end, 1]));
    dc.receive(new Uint8Array([P2P_FLAG.end, 2]));
    const got: number[] = [];
    link.onframe = (f) => got.push(f[0]);
    expect(got).toEqual([1, 2]);
  });

  it('ends once when the channel closes or the connection fails', () => {
    const a = fakeLink();
    a.dc.open();
    a.dc.onclose?.({});
    a.pc.state('closed');
    expect(a.closed).toEqual(['the direct connection closed']);
    const b = fakeLink();
    b.dc.open();
    b.pc.state('failed');
    expect(b.closed).toEqual(['the direct connection failed']);
    expect(b.dc.closed).toBe(1);
  });

  it('a disconnect that comes back within the grace period is not an end; one that lasts is', async () => {
    vi.useFakeTimers();
    try {
      const a = fakeLink();
      a.dc.open();
      a.pc.state('disconnected');
      vi.advanceTimersByTime(P2P_DISCONNECT_GRACE_MS - 100);
      a.pc.state('connected');
      vi.advanceTimersByTime(P2P_DISCONNECT_GRACE_MS * 2);
      expect(a.closed).toEqual([]);
      a.pc.state('disconnected');
      vi.advanceTimersByTime(P2P_DISCONNECT_GRACE_MS);
      expect(a.closed).toHaveLength(1);
      expect(a.closed[0]).toMatch(/lost/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
