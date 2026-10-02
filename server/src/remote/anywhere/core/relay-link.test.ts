import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBroker } from '../__mocks__/mqtt-broker.mjs';
import type { Side } from './envelope.js';
import { deviceRoom, relayKey, type Room } from './keys.js';
import type { Link } from './link.js';
import { Brokers, encodePublish, type BrokerDef } from './mqtt.js';
import {
  MAX_FRAME_BYTES,
  MAX_INBOX,
  MAX_QUEUED_BYTES,
  MAX_QUEUED_FRAMES,
  MIN_REORDER,
  RELAY_DIR,
  RELAY_KIND,
  RELAY_MAX_DATA,
  RELAY_MAX_PACKET,
  openRelayLink,
  relayIv,
  relayTopics,
  type RelayBrokers,
  type RelayLinkOptions,
} from './relay-link.js';

type Broker = Awaited<ReturnType<typeof startBroker>>;
type Extra = Partial<Pick<RelayLinkOptions, 'maxPerSec' | 'window' | 'retransmitMs' | 'deadMs'>>;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();
/** The bulk tests at the default 20 packets/s would take 20 s each; the logic is the same at 1000/s. */
const FAST: Extra = { maxPerSec: 1000, retransmitMs: 150 };

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Long enough for packets already received to be decrypted and handled. */
const settle = () => sleep(100);

/**
 * Counts the timers set from relay-link.ts that have neither fired nor been cleared (the process-wide count is
 * noisy: the socket stack sets and clears its own timers).
 */
function linkTimers(): () => number {
  const live = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const mine = /relay-link\.ts/.test(new Error().stack ?? '');
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

async function broker(opts?: Parameters<typeof startBroker>[0]): Promise<Broker> {
  const b = await startBroker(opts);
  cleanup.push(() => b.close());
  return b;
}

const def = (b: Broker, name: string, relay = true): BrokerDef => ({ name, url: b.url, relay });

/** One side's broker pool; `raw` counts every payload the pool hands to a subscriber of `topic`. */
function pool(defs: BrokerDef[], opts?: ConstructorParameters<typeof Brokers>[1]) {
  const p = new Brokers(defs, opts);
  cleanup.push(() => p.stop());
  const raw = new Map<string, number>();
  const subscribe = p.subscribe.bind(p);
  vi.spyOn(p, 'subscribe').mockImplementation((topic, cb) => subscribe(topic, (payload, name) => {
    raw.set(topic, (raw.get(topic) ?? 0) + 1);
    cb(payload, name);
  }));
  return { p, raw: (topic: string) => raw.get(topic) ?? 0 };
}

async function upAll(...ps: Brokers[]): Promise<void> {
  await until(() => ps.every((p) => p.status().every((s) => s.ok)), 'every pool up');
}

async function keys() {
  const room = await deviceRoom('device-token');
  const phoneNonce = crypto.getRandomValues(new Uint8Array(16));
  const pcNonce = crypto.getRandomValues(new Uint8Array(16));
  // the same room with the nonces the other way round: a key for another session
  return { room, key: await relayKey(room, phoneNonce, pcNonce), wrong: await relayKey(room, pcNonce, phoneNonce) };
}

interface End {
  link: Link;
  got: Uint8Array[];
  closed: string[];
}

async function end(brokers: Brokers, room: Room, side: Side, key: CryptoKey, extra: Extra = {}, session = 'sess-1'): Promise<End> {
  const link = await openRelayLink({ brokers, room, session, side, key, ...extra });
  cleanup.push(() => link.close());
  const e: End = { link, got: [], closed: [] };
  link.onframe = (f) => e.got.push(f);
  link.onclose = (why) => e.closed.push(why);
  return e;
}

/** Phone and PC, each with its own pool on `defs`, plus a sniffer pool that records every packet on both topics. */
async function pair(defs: BrokerDef[], extra: Extra = {}, o: { pcKey?: 'wrong' } = {}) {
  const k = await keys();
  const topics = relayTopics(k.room, 'sess-1');
  const phone = pool(defs);
  const pc = pool(defs);
  const sniff = pool(defs);
  for (const s of [phone, pc, sniff]) s.p.start();
  await upAll(phone.p, pc.p, sniff.p);
  const captured = { up: [] as Uint8Array[], down: [] as Uint8Array[] };
  await sniff.p.subscribe(topics.up, (b) => captured.up.push(b));
  await sniff.p.subscribe(topics.down, (b) => captured.down.push(b));
  const P = await end(phone.p, k.room, 'phone', k.key, extra);
  const C = await end(pc.p, k.room, 'pc', o.pcKey === 'wrong' ? k.wrong : k.key, extra);
  return { ...k, topics, phone, pc, sniff, captured, P, C };
}

/** Deterministic sizes in min..max (so a failure reproduces), random content. */
function frames(n: number, seed: number, max = 30_000, min = 1): Uint8Array[] {
  let s = seed;
  const rnd = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: n }, () => crypto.getRandomValues(new Uint8Array(min + Math.floor(rnd() * (max - min + 1)))));
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Index of the first frame that differs from what was sent (or is missing / extra), -1 when all match. */
function firstDiff(got: Uint8Array[], want: Uint8Array[]): number {
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (!got[i] || !want[i] || !same(got[i], want[i])) return i;
  }
  return -1;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A packet sealed by hand straight from the wire format, not through the link's own code. */
async function forge(key: CryptoKey, topic: string, dir: number, hi: number, lo: number, ack: number, kind: number, data = new Uint8Array(0)): Promise<Uint8Array> {
  const iv = new Uint8Array(12);
  iv[0] = dir;
  new DataView(iv.buffer).setUint32(4, hi);
  new DataView(iv.buffer).setUint32(8, lo);
  const pt = new Uint8Array(9 + data.length);
  const v = new DataView(pt.buffer);
  v.setUint32(0, lo);
  v.setUint32(4, ack);
  v.setUint8(8, kind);
  pt.set(data, 9);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(topic) }, key, pt));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function unseal(key: CryptoKey, topic: string, wire: Uint8Array) {
  try {
    const w = new Uint8Array(wire);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: w.subarray(0, 12), additionalData: enc.encode(topic) }, key, w.subarray(12)));
    const v = new DataView(pt.buffer);
    return { seq: v.getUint32(0), ack: v.getUint32(4), kind: pt[8], data: pt.subarray(9) };
  } catch {
    return null;
  }
}

/** Right length and header for `dir`, random body (no valid tag). */
function shaped(dir: number, hi: number, lo: number, len = 64, pad = 0): Uint8Array {
  const w = crypto.getRandomValues(new Uint8Array(len));
  w[0] = dir;
  w[1] = pad;
  w[2] = 0;
  w[3] = 0;
  new DataView(w.buffer).setUint32(4, hi);
  new DataView(w.buffer).setUint32(8, lo);
  return w;
}

/** Concatenated PUBLISH packets for one WS message: the pool hands all of them over in one synchronous go. */
function glue(topic: string, payloads: Uint8Array[]): Uint8Array {
  const packets = payloads.map((p) => encodePublish(topic, p));
  const out = new Uint8Array(packets.reduce((n, p) => n + p.length, 0));
  packets.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
}

describe('relay link', () => {
  it('200 frames of 1–30 000 bytes arrive whole, in order and unchanged, both ways at once', async () => {
    const [a, b] = [await broker(), await broker()];
    const t = await pair([def(a, 'A'), def(b, 'B')], FAST);
    const up = frames(200, 1);
    const down = frames(200, 2);
    // some frames need three packets
    expect(up.some((f) => f.length > 2 * RELAY_MAX_DATA)).toBe(true);
    for (const f of up) t.P.link.send(f);
    for (const f of down) t.C.link.send(f);
    await until(() => t.C.got.length >= 200 && t.P.got.length >= 200, 'every frame', 20_000);
    expect(firstDiff(t.C.got, up)).toBe(-1);
    expect(firstDiff(t.P.got, down)).toBe(-1);
    await until(() => t.P.link.buffered() === 0 && t.C.link.buffered() === 0, 'everything confirmed');
    await settle();
    expect([t.C.got.length, t.P.got.length]).toEqual([200, 200]);
    // no packet on the wire carried more than RELAY_MAX_DATA bytes of a frame
    expect(RELAY_MAX_PACKET).toBe(12 + 9 + RELAY_MAX_DATA + 16);
    for (const w of t.captured.up) expect(w.length).toBeLessThanOrEqual(RELAY_MAX_PACKET);
    for (const w of t.captured.down) expect(w.length).toBeLessThanOrEqual(RELAY_MAX_PACKET);
    expect(t.P.closed).toEqual([]);
    expect(t.C.closed).toEqual([]);
  });

  it('the same with every 5th delivery dropped by the broker', async () => {
    const a = await broker({ dropEvery: 5 });
    const t = await pair([def(a, 'A')], FAST);
    const up = frames(200, 3);
    const down = frames(200, 4);
    for (const f of up) t.P.link.send(f);
    for (const f of down) t.C.link.send(f);
    await until(() => t.C.got.length >= 200 && t.P.got.length >= 200, 'every frame', 25_000);
    expect(firstDiff(t.C.got, up)).toBe(-1);
    expect(firstDiff(t.P.got, down)).toBe(-1);
    await until(() => t.P.link.buffered() === 0 && t.C.link.buffered() === 0, 'everything confirmed', 5000);
    await settle();
    expect([t.C.got.length, t.P.got.length]).toEqual([200, 200]);
  });

  it('two relay brokers both deliver every packet, each frame calls back once; a broker not marked relay carries none of it', async () => {
    const [a, b, c] = [await broker(), await broker(), await broker()];
    const t = await pair([def(a, 'A'), def(b, 'B'), def(c, 'C', false)], FAST);
    const up = frames(30, 5, 5000);
    const down = frames(30, 6, 5000);
    for (const f of up) t.P.link.send(f);
    for (const f of down) t.C.link.send(f);
    await until(() => t.C.got.length >= 30 && t.P.got.length >= 30, 'every frame', 10_000);
    await until(() => t.P.link.buffered() === 0 && t.C.link.buffered() === 0, 'everything confirmed');
    await settle();
    expect(firstDiff(t.C.got, up)).toBe(-1);
    expect(firstDiff(t.P.got, down)).toBe(-1);
    // a copy of every packet through each relay broker (the sniffer saw each one twice too)
    const ivs = new Set(t.captured.up.map((w) => hex(w.subarray(0, 12))));
    expect(ivs.size).toBeGreaterThan(1);
    expect(t.pc.raw(t.topics.up)).toBeGreaterThanOrEqual(2 * ivs.size);
    expect(t.captured.up.length).toBeGreaterThanOrEqual(2 * ivs.size);
    expect(a.published).toBeGreaterThan(0);
    expect(b.published).toBe(a.published);
    expect(c.published).toBe(0);
  });

  it('one relay broker dropping, both delivering copies: every frame arrives in order, exactly once', async () => {
    const [a, b] = [await broker({ dropEvery: 3 }), await broker()];
    const t = await pair([def(a, 'A'), def(b, 'B')], FAST);
    const up = frames(80, 15, 20_000);
    const down = frames(80, 16, 20_000);
    for (const f of up) t.P.link.send(f);
    for (const f of down) t.C.link.send(f);
    await until(() => t.C.got.length >= 80 && t.P.got.length >= 80, 'every frame', 15_000);
    await until(() => t.P.link.buffered() === 0 && t.C.link.buffered() === 0, 'everything confirmed', 5000);
    await settle();
    expect(firstDiff(t.C.got, up)).toBe(-1);
    expect(firstDiff(t.P.got, down)).toBe(-1);
    // copies did come in: more deliveries than distinct packets
    const ivs = new Set(t.captured.up.map((w) => hex(w.subarray(0, 12))));
    expect(t.pc.raw(t.topics.up)).toBeGreaterThan(ivs.size);
  });

  it('small frames are packed: 500 frames of 10–200 bytes sent at once arrive in order in at most 60 MQTT packets', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')]);
    const before = a.published;
    const sent = frames(500, 17, 200, 10);
    for (const f of sent) t.P.link.send(f);
    await until(() => t.C.got.length >= 500, 'every frame', 10_000);
    await until(() => t.P.link.buffered() === 0, 'everything confirmed');
    await settle();
    expect(firstDiff(t.C.got, sent)).toBe(-1);
    // both sides, data and acks: one packet per frame would have been 500 (25 s at 20 packets/s)
    expect(a.published - before).toBeLessThanOrEqual(60);
    // and the data went in batches
    const kinds = await Promise.all(t.captured.up.map(async (w) => (await unseal(t.key, t.topics.up, w))?.kind));
    expect(kinds).toContain(RELAY_KIND.batch);
  });

  it('batched and split frames mixed stay in order, both ways', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST);
    // runs of small frames between frames of two or three packets, and frames just under / over one packet
    const mix = (seed: number) => {
      const out: Uint8Array[] = [];
      for (let i = 0; i < 12; i++) {
        out.push(...frames(1 + (i % 5) * 7, seed + i, 300, 1));
        out.push(...frames(1, seed + 100 + i, i % 2 ? 30_000 : RELAY_MAX_DATA + 1, i % 2 ? 12_289 : RELAY_MAX_DATA - 1));
      }
      out.push(new Uint8Array(0), ...frames(3, seed + 200, 50, 1));
      return out;
    };
    const up = mix(1000);
    const down = mix(2000);
    for (const f of up) t.P.link.send(f);
    for (const f of down) t.C.link.send(f);
    await until(() => t.C.got.length >= up.length && t.P.got.length >= down.length, 'every frame', 15_000);
    await settle();
    expect(firstDiff(t.C.got, up)).toBe(-1);
    expect(firstDiff(t.P.got, down)).toBe(-1);
    const kinds = new Set(await Promise.all(t.captured.up.map(async (w) => (await unseal(t.key, t.topics.up, w))?.kind)));
    for (const k of [RELAY_KIND.batch, RELAY_KIND.more, RELAY_KIND.data]) expect(kinds).toContain(k);
  });

  it('rate limit: neither side publishes more than 41 MQTT packets in 2 s at the default 20/s, acks included', async () => {
    // the phone is on X and Y, the PC on Y and Z: they meet on Y, X counts the phone's packets alone, Z the PC's
    const [x, y, z] = [await broker(), await broker(), await broker()];
    const k = await keys();
    const phone = pool([def(x, 'X'), def(y, 'Y')]);
    const pc = pool([def(y, 'Y'), def(z, 'Z')]);
    phone.p.start();
    pc.p.start();
    await upAll(phone.p, pc.p);
    const P = await end(phone.p, k.room, 'phone', k.key);
    const C = await end(pc.p, k.room, 'pc', k.key);
    // both ways at once, every packet also carrying an ack for the other direction; frames too big to share a
    // packet, so each side has a packet to send in every slot
    const up = frames(70, 7, 12_000, 10_000);
    const down = frames(70, 8, 12_000, 10_000);
    for (const f of up) P.link.send(f);
    for (const f of down) C.link.send(f);
    await sleep(400);
    const [x0, z0, t0] = [x.published, z.published, performance.now()];
    await sleep(2000);
    const [x1, z1, el] = [x.published, z.published, performance.now() - t0];
    const phoneSent = x1 - x0;
    const pcSent = z1 - z0;
    // one packet per 50 ms, a timer up to 26 ms late being made up for: at most 41 in any 2 s window (the cap only
    // grows if this test's own timer came back more than 24 ms late)
    const cap = 1 + Math.floor(((el + 26) * 20) / 1000);
    expect(1 + Math.floor(((2000 + 26) * 20) / 1000)).toBe(41);
    expect(phoneSent).toBeLessThanOrEqual(cap);
    expect(pcSent).toBeLessThanOrEqual(cap);
    // and it is the limit holding them back: both kept sending close to it (the precise rate is the next test's)
    expect(phoneSent).toBeGreaterThanOrEqual(30);
    expect(pcSent).toBeGreaterThanOrEqual(30);
    await until(() => C.got.length >= 70 && P.got.length >= 70, 'every frame', 15_000);
    expect(firstDiff(C.got, up)).toBe(-1);
    expect(firstDiff(P.got, down)).toBe(-1);
  });

  it('pacing, timed at each publish: never more than 41 in any 2 s, and the full 20/s even though timers fire late', async () => {
    // no sockets, nothing else running: only the pacer's own timing is measured
    const times: number[] = [];
    const fake: RelayBrokers = {
      subscribe: async () => {},
      unsubscribe: () => {},
      publish: () => (times.push(performance.now()), 1),
    };
    const k = await keys();
    // window 256: 2 s worth of packets without anyone acking
    const link = await openRelayLink({ brokers: fake, room: k.room, session: 'pace', side: 'phone', key: k.key, window: 256 });
    cleanup.push(() => link.close());
    // too big to share a packet: one packet per frame
    for (let i = 0; i < 100; i++) link.send(new Uint8Array(12_000));
    await sleep(2300);
    link.close();
    let most = 0;
    for (let i = 0, j = 0; i < times.length; i++) {
      while (j < times.length && times[j] <= times[i] + 2000) j++;
      most = Math.max(most, j - i);
    }
    expect(most).toBeLessThanOrEqual(41);
    // strict spacing from the last send would lose every timer's lateness: on Windows, which rounds timers up to
    // its 15.6 ms tick, each 50 ms gap became 62 and 2 s held 32
    expect(times.filter((t) => t <= times[0] + 2000).length).toBeGreaterThanOrEqual(37);
  });

  it('close() reaches the other side within 3 s, sends only its close packets, and leaves no timer behind', async () => {
    const a = await broker();
    const k = await keys();
    const phone = pool([def(a, 'A')]);
    const pc = pool([def(a, 'A')]);
    phone.p.start();
    pc.p.start();
    await upAll(phone.p, pc.p);
    const timers = linkTimers();
    const P = await end(phone.p, k.room, 'phone', k.key);
    const C = await end(pc.p, k.room, 'pc', k.key);
    P.link.send(enc.encode('hello'));
    await until(() => C.got.length === 1, 'the frame');
    await until(() => P.link.buffered() === 0, 'its ack');
    // one each while open (keepalive / ack / resend share it)
    expect(timers()).toBe(2);
    const published = a.published;
    const t0 = performance.now();
    P.link.close();
    P.link.close();
    await until(() => C.closed.length === 1, 'onclose on the PC', 3000);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(C.closed[0]).toMatch(/closed/);
    // the closing side gets no onclose of its own; send() is ignored, nothing is buffered
    P.link.send(enc.encode('after'));
    expect(P.link.buffered()).toBe(0);
    await sleep(300);
    expect(P.closed).toEqual([]);
    expect(C.closed).toHaveLength(1);
    expect(C.got).toHaveLength(1);
    // two copies of the close packet (one may be lost on the way), nothing else from either side
    expect(a.published - published).toBe(2);
    // both links done (the PC's ended on the close packet, the phone's after sending it): no timer of theirs is left
    expect(timers()).toBe(0);
    C.link.close();
    expect(timers()).toBe(0);
  });

  it('a side with the wrong key receives no frames, and neither does the other side', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST, { pcKey: 'wrong' });
    const err = vi.spyOn(console, 'error');
    for (const f of frames(5, 9, 20_000)) t.P.link.send(f);
    for (const f of frames(5, 10, 20_000)) t.C.link.send(f);
    await until(() => t.pc.raw(t.topics.up) >= 5 && t.phone.raw(t.topics.down) >= 5, 'packets on both sides');
    // a few retransmit rounds
    await sleep(600);
    expect(t.C.got).toEqual([]);
    expect(t.P.got).toEqual([]);
    // nothing was confirmed either
    expect(t.P.link.buffered()).toBeGreaterThan(0);
    expect(t.C.link.buffered()).toBeGreaterThan(0);
    expect(err).not.toHaveBeenCalled();
  });

  it('IV = direction byte ‖ 0 0 0 ‖ 8-byte sequence: the directions never share one, and a resend is the same bytes', async () => {
    expect([...relayIv(RELAY_DIR.up, 0, 5)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
    expect([...relayIv(RELAY_DIR.down, 0, 0x01020304)]).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
    // control packets (acks, close) count in their own range: 2^32 + n
    expect([...relayIv(RELAY_DIR.up, 1, 7)]).toEqual([1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 7]);
    // DataView would wrap these silently into an IV already used
    expect(() => relayIv(RELAY_DIR.up, 0, 2 ** 32)).toThrow(RangeError);
    expect(() => relayIv(RELAY_DIR.up, 0, -1)).toThrow(RangeError);

    // odd: each packet goes to two subscribers (a link and the sniffer), an even count would always hit the sniffer
    const a = await broker({ dropEvery: 5 });
    const t = await pair([def(a, 'A')], FAST);
    const up = frames(40, 11, 20_000);
    const down = frames(40, 12, 20_000);
    for (const f of up) t.P.link.send(f);
    for (const f of down) t.C.link.send(f);
    await until(() => t.C.got.length >= 40 && t.P.got.length >= 40, 'every frame', 15_000);
    await until(() => t.P.link.buffered() === 0 && t.C.link.buffered() === 0, 'everything confirmed', 5000);
    expect(firstDiff(t.C.got, up)).toBe(-1);
    expect(firstDiff(t.P.got, down)).toBe(-1);

    const ivs = { up: new Map<string, string>(), down: new Map<string, string>() };
    let resends = 0;
    for (const [dir, list, map] of [[1, t.captured.up, ivs.up], [2, t.captured.down, ivs.down]] as const) {
      for (const w of list) {
        expect(w[0]).toBe(dir);
        expect([w[1], w[2], w[3]]).toEqual([0, 0, 0]);
        const iv = hex(w.subarray(0, 12));
        const seen = map.get(iv);
        if (seen === undefined) map.set(iv, hex(w));
        else {
          resends++;
          // never other bytes under an IV already used
          expect(seen).toBe(hex(w));
        }
      }
    }
    expect(resends).toBeGreaterThan(0);
    // both directions used the same data sequence numbers (the sniffer misses some packets), never the same IV
    const dataSeqs = (m: Map<string, string>) => new Set([...m.keys()].filter((iv) => iv.slice(8, 16) === '00000000').map((iv) => iv.slice(16)));
    const downSeqs = dataSeqs(ivs.down);
    expect([...dataSeqs(ivs.up)].filter((s) => downSeqs.has(s)).length).toBeGreaterThan(10);
    for (const iv of ivs.up.keys()) expect(ivs.down.has(iv)).toBe(false);
    // the IV on the wire is the one it was sealed with, the topic is the AAD
    const w = t.captured.up[0];
    const opened = await unseal(t.key, t.topics.up, w);
    expect(opened).not.toBeNull();
    expect(opened!.seq).toBe(new DataView(w.buffer, w.byteOffset, w.byteLength).getUint32(8));
    expect(await unseal(t.key, t.topics.down, w)).toBeNull();
    const flipped = new Uint8Array(w);
    flipped[0] = RELAY_DIR.down;
    expect(await unseal(t.key, t.topics.up, flipped)).toBeNull();
  });

  it('keepalives hold an idle link open; a side that vanishes without a word is noticed after deadMs', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], { ...FAST, deadMs: 600 });
    await sleep(1500);
    expect(t.P.closed).toEqual([]);
    expect(t.C.closed).toEqual([]);
    // the PC's network goes away: no close packet, just silence
    t.pc.p.stop();
    const t0 = performance.now();
    await until(() => t.P.closed.length === 1, 'the phone to notice', 3000);
    expect(t.P.closed[0]).toMatch(/nothing heard/);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('opening does not hang with every broker down; what was sent meanwhile goes out once they are up', async () => {
    const a = await broker();
    const k = await keys();
    const phone = pool([def(a, 'A')], { redialMs: 100 });
    const pc = pool([def(a, 'A')], { redialMs: 100 });
    const t0 = performance.now();
    const P = await end(phone.p, k.room, 'phone', k.key, FAST);
    const C = await end(pc.p, k.room, 'pc', k.key, FAST);
    expect(performance.now() - t0).toBeLessThan(1000);
    const sent = frames(10, 13, 20_000);
    for (const f of sent) P.link.send(f);
    // several retransmit timeouts with nobody to take the packets
    await sleep(500);
    expect(a.published).toBe(0);
    expect(C.got).toEqual([]);
    phone.p.start();
    pc.p.start();
    await until(() => C.got.length >= 10, 'the frames once the brokers are up', 10_000);
    expect(firstDiff(C.got, sent)).toBe(-1);
    await until(() => P.link.buffered() === 0, 'everything confirmed');
  });

  it('the phone restarts its brokers (F4: a network change under the relay): the link goes on, nothing is lost, it does not wait out deadMs', async () => {
    const a = await broker();
    // deadMs short, so that "it would have died" shows within the test: the restart must not cost the link
    const t = await pair([def(a, 'A')], { ...FAST, deadMs: 2_000 });
    t.P.link.send(enc.encode('before'));
    await until(() => t.C.got.length === 1, 'the frame before');
    // what the shell does on online / visibilitychange: every broker connection closed and opened again at once
    t.phone.p.stop();
    const ups = frames(6, 31, 4_000);
    const downs = frames(6, 32, 4_000);
    for (const f of ups) t.P.link.send(f);
    for (const f of downs) t.C.link.send(f);
    t.phone.p.start();
    await until(() => t.C.got.length === 1 + ups.length && t.P.got.length === downs.length, 'both directions after the restart', 10_000);
    expect(firstDiff(t.C.got.slice(1), ups)).toBe(-1);
    expect(firstDiff(t.P.got, downs)).toBe(-1);
    // past deadMs since the restart: both ends still up (they kept hearing each other), and it still carries frames
    await sleep(2_500);
    expect(t.P.closed).toEqual([]);
    expect(t.C.closed).toEqual([]);
    t.C.link.send(enc.encode('after'));
    await until(() => t.P.got.length === downs.length + 1, 'a frame after');
    expect(dec.decode(t.P.got.at(-1)!)).toBe('after');
  });

  it('garbage and replays from an untrusted broker are dropped without a throw or a log, and the link keeps working', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST);
    const err = vi.spyOn(console, 'error');
    const { up, down } = t.topics;
    const junk = [
      new Uint8Array(0),
      new Uint8Array([1]),
      new Uint8Array(36), // one byte short of the smallest packet
      shaped(RELAY_DIR.up, 0, 0), // right header, no valid tag
      shaped(RELAY_DIR.up, 1, 0), // control header, no valid tag
      shaped(RELAY_DIR.down, 0, 0), // the other direction's byte
      shaped(RELAY_DIR.up, 0, 0, 64, 7), // padding not zero
      shaped(RELAY_DIR.up, 2, 0), // neither data nor control
      shaped(RELAY_DIR.up, 0, 0, RELAY_MAX_PACKET + 1),
      await forge(t.wrong, up, RELAY_DIR.up, 0, 0, 0, RELAY_KIND.data, enc.encode('another session')),
      await forge(t.key, down, RELAY_DIR.up, 0, 0, 0, RELAY_KIND.data, enc.encode('sealed for the other topic')),
      // the right key and topic, but the down direction's IV: only the direction byte check stops this one
      await forge(t.key, up, RELAY_DIR.down, 0, 0, 0, RELAY_KIND.data, enc.encode('wrong direction byte')),
    ];
    for (const j of junk) expect(t.sniff.p.publish(up, j)).toBe(1);
    await until(() => t.pc.raw(up) === junk.length, 'all the junk on the PC');
    await settle();
    expect(t.C.got).toEqual([]);
    const ups = ['one', 'two', 'three'].map((s) => enc.encode(s));
    const downs = ['uno', 'dos', 'tres'].map((s) => enc.encode(s));
    for (const f of ups) t.P.link.send(f);
    for (const f of downs) t.C.link.send(f);
    await until(() => t.C.got.length === 3 && t.P.got.length === 3, 'the real frames');
    await until(() => t.P.link.buffered() === 0 && t.C.link.buffered() === 0, 'everything confirmed');
    // the attacker replays every packet it saw on both topics, twice
    const seenUp = [...t.captured.up];
    const seenDown = [...t.captured.down];
    for (let i = 0; i < 2; i++) {
      for (const w of seenUp) t.sniff.p.publish(up, w);
      for (const w of seenDown) t.sniff.p.publish(down, w);
    }
    await until(() => t.pc.raw(up) >= junk.length + 2 * seenUp.length, 'the replays on the PC');
    await settle();
    expect(t.C.got.map((f) => dec.decode(f))).toEqual(['one', 'two', 'three']);
    expect(t.P.got.map((f) => dec.decode(f))).toEqual(['uno', 'dos', 'tres']);
    expect(t.C.closed).toEqual([]);
    expect(err).not.toHaveBeenCalled();
  });

  it('junk under the IV of the next packet, published ahead of it, does not get the real one skipped', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST);
    expect(t.sniff.p.publish(t.topics.up, shaped(RELAY_DIR.up, 0, 0, 100))).toBe(1);
    await until(() => t.pc.raw(t.topics.up) === 1, 'the junk on the PC');
    await settle();
    t.P.link.send(enc.encode('real'));
    await until(() => t.C.got.length === 1, 'the real frame');
    expect(dec.decode(t.C.got[0])).toBe('real');
  });

  it('a sealed packet too far ahead of the receiver is not held: the reorder buffer is bounded', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST);
    // the default window is 32, so the receiver holds at most MIN_REORDER packets ahead: 0 … 63
    const evil = await forge(t.key, t.topics.up, RELAY_DIR.up, 0, MIN_REORDER, 0, RELAY_KIND.data, enc.encode('evil'));
    expect(t.sniff.p.publish(t.topics.up, evil)).toBe(1);
    await until(() => t.pc.raw(t.topics.up) === 1, 'the far-ahead packet on the PC');
    await settle();
    // too big to share a packet, so the real stream does reach that sequence
    const sent = frames(MIN_REORDER + 5, 18, 8000, 7000);
    for (const f of sent) t.P.link.send(f);
    await until(() => t.C.got.length >= sent.length, 'every frame', 10_000);
    // had it been kept, the real packet at that sequence would have been dropped as a copy
    expect(firstDiff(t.C.got, sent)).toBe(-1);
  });

  it('a flood past MAX_INBOX packets waiting to be opened is dropped, and the link recovers', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST);
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    // well-formed control headers with fresh numbers: each one gets as far as AES-GCM
    const junk = Array.from({ length: MAX_INBOX + 100 }, (_, i) => shaped(RELAY_DIR.up, 1, i));
    // one WS message: every one of them reaches the link before the first is opened
    a.sendRaw(glue(t.topics.up, junk));
    await until(() => t.pc.raw(t.topics.up) === junk.length, 'the whole flood on the PC pool');
    await until(() => decrypt.mock.calls.length >= MAX_INBOX, 'the queued part to be tried');
    await settle();
    expect(decrypt.mock.calls.length).toBe(MAX_INBOX);
    t.P.link.send(enc.encode('after'));
    await until(() => t.C.got.length === 1, 'a real frame after the flood');
    expect(dec.decode(t.C.got[0])).toBe('after');
  });

  it('one link per session and side on a pool; the session id must be safe in a topic', async () => {
    const a = await broker();
    const k = await keys();
    const one = pool([def(a, 'A')]);
    one.p.start();
    await upAll(one.p);
    const base = { brokers: one.p, room: k.room, key: k.key };
    const P = await end(one.p, k.room, 'phone', k.key, FAST);
    await expect(openRelayLink({ ...base, session: 'sess-1', side: 'phone' })).rejects.toThrow(/already open/);
    // the other end of the same session listens on the other topic: both ends on one pool work
    const C = await end(one.p, k.room, 'pc', k.key, FAST);
    P.link.send(enc.encode('ping'));
    C.link.send(enc.encode('pong'));
    await until(() => C.got.length === 1 && P.got.length === 1, 'a frame each way');
    expect([dec.decode(C.got[0]), dec.decode(P.got[0])]).toEqual(['ping', 'pong']);
    for (const session of ['', 'a/b', 'a+b', 'a#b', 'x'.repeat(65), 'é']) {
      await expect(openRelayLink({ ...base, session, side: 'phone' })).rejects.toThrow(/session/);
    }
    await expect(openRelayLink({ ...base, session: 'other', side: 'tablet' as Side })).rejects.toThrow(/side/);
    // closing frees the slot, but never for the same key: the new link would number from 0 again, under IVs the
    // first one already used (on another pool just the same)
    P.link.close();
    await expect(openRelayLink({ ...base, session: 'sess-1', side: 'phone' })).rejects.toThrow(/repeat its IVs/);
    const elsewhere = pool([def(a, 'A')]);
    await expect(openRelayLink({ ...base, brokers: elsewhere.p, session: 'sess-1', side: 'phone' })).rejects.toThrow(/repeat its IVs/);
    // the IV does not contain the session (the topic is only the AAD): another session, same key and direction,
    // would repeat them just the same, even while the first link is still open
    await expect(openRelayLink({ ...base, session: 'sess-2', side: 'phone' })).rejects.toThrow(/repeat its IVs/);
    await expect(openRelayLink({ ...base, session: 'sess-3', side: 'pc' })).rejects.toThrow(/repeat its IVs/);
    const fresh = await keys();
    const again = await end(one.p, fresh.room, 'phone', fresh.key, FAST);
    expect(again.link.kind).toBe('relay');
  });

  it('send() copies the frame, carries empty frames, refuses frames over MAX_FRAME_BYTES; buffered() counts until confirmed', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST);
    expect(t.P.link.kind).toBe('relay');
    const f = new Uint8Array([1, 2, 3]);
    t.P.link.send(f);
    f[0] = 9;
    t.P.link.send(new Uint8Array(0));
    expect(() => t.P.link.send(new Uint8Array(MAX_FRAME_BYTES + 1))).toThrow(RangeError);
    t.P.link.send(new Uint8Array(MAX_FRAME_BYTES));
    expect(t.P.link.buffered()).toBe(3 + MAX_FRAME_BYTES);
    await until(() => t.C.got.length === 3, 'the three frames', 10_000);
    expect([...t.C.got[0]]).toEqual([1, 2, 3]);
    expect(t.C.got[1].length).toBe(0);
    expect(t.C.got[2].length).toBe(MAX_FRAME_BYTES);
    await until(() => t.P.link.buffered() === 0, 'everything confirmed');
  });

  it('frames that arrive before onframe is set are kept and handed over, in order, once it is', async () => {
    const a = await broker();
    const k = await keys();
    const phone = pool([def(a, 'A')]);
    const pc = pool([def(a, 'A')]);
    phone.p.start();
    pc.p.start();
    await upAll(phone.p, pc.p);
    const C = await openRelayLink({ brokers: pc.p, room: k.room, session: 'sess-1', side: 'pc', key: k.key, ...FAST });
    cleanup.push(() => C.close());
    const P = await end(phone.p, k.room, 'phone', k.key, FAST);
    for (const s of ['a', 'b', 'c']) P.link.send(enc.encode(s));
    await until(() => P.link.buffered() === 0, 'the PC to confirm all three');
    const got: string[] = [];
    C.onframe = (f) => got.push(dec.decode(f));
    expect(got).toEqual(['a', 'b', 'c']);
    P.link.send(enc.encode('d'));
    await until(() => got.length === 4, 'a later frame');
    expect(got).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a frame handler that throws is reported, and later frames still arrive', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: string[] = [];
    t.C.link.onframe = (f) => {
      got.push(dec.decode(f));
      if (got.length === 1) throw new Error('handler bug');
    };
    for (const s of ['1', '2', '3']) t.P.link.send(enc.encode(s));
    await until(() => got.length === 3, 'all three frames');
    expect(got).toEqual(['1', '2', '3']);
    expect(err).toHaveBeenCalled();
    expect(t.C.closed).toEqual([]);
  });

  it('more than MAX_QUEUED_BYTES waiting to be sent ends the link instead of growing without bound', async () => {
    const k = await keys();
    // never started: nothing can be sent, let alone confirmed
    const phone = pool([def(await broker(), 'A')]);
    const P = await end(phone.p, k.room, 'phone', k.key);
    const big = new Uint8Array(MAX_FRAME_BYTES);
    for (let i = 0; i < MAX_QUEUED_BYTES / MAX_FRAME_BYTES; i++) P.link.send(big);
    expect(P.closed).toEqual([]);
    expect(P.link.buffered()).toBe(MAX_QUEUED_BYTES);
    P.link.send(new Uint8Array(1));
    // ended at once, but onclose is not run from inside the caller's send()
    expect(P.link.buffered()).toBe(0);
    expect(P.closed).toEqual([]);
    await Promise.resolve();
    expect(P.closed).toHaveLength(1);
    expect(P.closed[0]).toMatch(/bytes waiting to be sent/);
    P.link.send(big);
    expect(P.link.buffered()).toBe(0);
  });

  it('more than MAX_QUEUED_FRAMES frames waiting ends the link too (empty frames count no bytes)', async () => {
    const k = await keys();
    const phone = pool([def(await broker(), 'A')]);
    const P = await end(phone.p, k.room, 'phone', k.key);
    const empty = new Uint8Array(0);
    for (let i = 0; i < MAX_QUEUED_FRAMES; i++) P.link.send(empty);
    // nothing has been taken off the queue yet (the pacer runs from a timer, this loop never yields)
    expect(P.closed).toEqual([]);
    P.link.send(empty);
    await Promise.resolve();
    expect(P.closed).toHaveLength(1);
    expect(P.closed[0]).toMatch(new RegExp(`${MAX_QUEUED_FRAMES} frames waiting to be sent`));
  });

  it('a frame from the other side growing past MAX_FRAME_BYTES ends the link, and the other side is told', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST);
    const piece = new Uint8Array(RELAY_MAX_DATA);
    const n = Math.ceil(MAX_FRAME_BYTES / RELAY_MAX_DATA) + 1;
    const packets: Uint8Array[] = [];
    for (let i = 0; i < n; i++) packets.push(await forge(t.key, t.topics.up, RELAY_DIR.up, 0, i, 0, RELAY_KIND.more, piece));
    // in two halves, so the second half is inside the receiver's reorder window when it arrives
    const half = Math.ceil(n / 2);
    for (const p of packets.slice(0, half)) t.sniff.p.publish(t.topics.up, p);
    await until(() => t.pc.raw(t.topics.up) >= half, 'the first half on the PC');
    await settle();
    for (const p of packets.slice(half)) t.sniff.p.publish(t.topics.up, p);
    await until(() => t.C.closed.length === 1, 'the PC link to end', 5000);
    expect(t.C.closed[0]).toMatch(new RegExp(`over ${MAX_FRAME_BYTES} bytes`));
    expect(t.C.got).toEqual([]);
    await until(() => t.P.closed.length === 1, 'the phone to be told', 3000);
    expect(t.P.closed[0]).toMatch(/closed/);
  });

  it('protocol v1: an unknown control kind is ignored; an unknown data kind ends the link, the frames before it delivered', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST);
    const { up } = t.topics;
    // packets sealed by hand play a newer phone (the real phone link stays quiet)
    t.sniff.p.publish(up, await forge(t.key, up, RELAY_DIR.up, 0, 0, 0, RELAY_KIND.data, enc.encode('known')));
    t.sniff.p.publish(up, await forge(t.key, up, RELAY_DIR.up, 1, 0, 0, 7, enc.encode('future control')));
    await until(() => t.C.got.length === 1, 'the known frame');
    await settle();
    expect(t.C.closed).toEqual([]);
    // a data kind this version does not know may carry a frame: skipping it would lose that frame unnoticed
    t.sniff.p.publish(up, await forge(t.key, up, RELAY_DIR.up, 0, 1, 0, 9, enc.encode('future frame')));
    t.sniff.p.publish(up, await forge(t.key, up, RELAY_DIR.up, 0, 2, 0, RELAY_KIND.data, enc.encode('after it')));
    await until(() => t.C.closed.length === 1, 'the link to end');
    expect(t.C.closed[0]).toBe('protocol: unknown kind 9');
    await settle();
    expect(t.C.got.map((f) => dec.decode(f))).toEqual(['known']);
    // and the phone is told
    await until(() => t.P.closed.length === 1, 'the phone to be told');
  });

  it('protocol v1: anything but MORE or END inside a split frame ends the link, and the frame with the hole is not delivered', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST);
    const { up } = t.topics;
    const piece = new Uint8Array(100).fill(7);
    const batch = new Uint8Array([0, 1, 42]);
    t.sniff.p.publish(up, await forge(t.key, up, RELAY_DIR.up, 0, 0, 0, RELAY_KIND.more, piece));
    t.sniff.p.publish(up, await forge(t.key, up, RELAY_DIR.up, 0, 1, 0, RELAY_KIND.batch, batch));
    t.sniff.p.publish(up, await forge(t.key, up, RELAY_DIR.up, 0, 2, 0, RELAY_KIND.data, piece));
    await until(() => t.C.closed.length === 1, 'the link to end');
    expect(t.C.closed[0]).toBe(`protocol: kind ${RELAY_KIND.batch} inside a split frame`);
    await settle();
    expect(t.C.got).toEqual([]);
  });

  it('protocol v1: a batch cut short ends the link and delivers none of it', async () => {
    const a = await broker();
    const t = await pair([def(a, 'A')], FAST);
    const { up } = t.topics;
    // two good frames ([1] and [2, 3]), then a length of 9 with only one byte behind it
    const batch = new Uint8Array([0, 1, 1, 0, 2, 2, 3, 0, 9, 4]);
    t.sniff.p.publish(up, await forge(t.key, up, RELAY_DIR.up, 0, 0, 0, RELAY_KIND.batch, batch));
    await until(() => t.C.closed.length === 1, 'the link to end');
    expect(t.C.closed[0]).toBe('protocol: a batch cut short');
    expect(t.C.got).toEqual([]);
    // a well-formed one, for contrast, on a fresh pair
    const u = await pair([def(a, 'A')], FAST);
    u.sniff.p.publish(u.topics.up, await forge(u.key, u.topics.up, RELAY_DIR.up, 0, 0, 0, RELAY_KIND.batch, batch.subarray(0, 7)));
    await until(() => u.C.got.length === 2, 'both frames of the good batch');
    expect(u.C.got.map((f) => [...f])).toEqual([[1], [2, 3]]);
    // each frame of a batch is its own buffer
    expect(u.C.got[0].buffer).not.toBe(u.C.got[1].buffer);
  });
});
