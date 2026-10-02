import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBroker } from '../__mocks__/mqtt-broker.mjs';
import { seal, type SignalMsg } from './envelope.js';
import { b64u, deviceRoom, unb64u, type Room } from './keys.js';
import { Brokers, encodePublish, type BrokerDef } from './mqtt.js';
import { MAX_ENVELOPE_BYTES, MAX_PENDING, SignalChannel } from './signal.js';

type Broker = Awaited<ReturnType<typeof startBroker>>;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dec = new TextDecoder();

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Long enough for every delivery already received to be decrypted and handled (each takes well under 1 ms). */
const settle = () => sleep(60);

async function broker(): Promise<Broker> {
  const b = await startBroker();
  cleanup.push(() => b.close());
  return b;
}

/**
 * A broker url that fails at once: a listener held open for the whole test that drops every connection before
 * the WebSocket upgrade (a closed port could be handed to the next broker a test starts).
 */
async function deadUrl(): Promise<string> {
  const socks = new Set<net.Socket>();
  const srv = net.createServer((s) => {
    s.on('error', () => {});
    s.destroy();
  });
  srv.on('connection', (s) => socks.add(s));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  cleanup.push(() => {
    for (const s of socks) s.destroy();
    return new Promise((r) => srv.close(r));
  });
  return `ws://127.0.0.1:${(srv.address() as net.AddressInfo).port}/mqtt`;
}

/** Concatenated PUBLISH packets for one WS message: the pool hands all of them over in one synchronous go. */
function glue(topic: string, payloads: (string | Uint8Array)[]): Uint8Array {
  const packets = payloads.map((p) => encodePublish(topic, p));
  const out = new Uint8Array(packets.reduce((n, p) => n + p.length, 0));
  packets.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
}

/**
 * Makes WebCrypto `op` take `ms` longer for inputs over 10 KB, so work that is not serialized would finish out of
 * order for sure (without it, small and big mixed only usually do).
 */
function slowForBig(op: 'encrypt' | 'decrypt', ms = 25): void {
  const real = crypto.subtle[op].bind(crypto.subtle) as (...a: unknown[]) => Promise<ArrayBuffer>;
  vi.spyOn(crypto.subtle, op).mockImplementation((async (...a: unknown[]) => {
    const out = await real(...a);
    if ((a[2] as ArrayBufferView).byteLength > 10_000) await sleep(ms);
    return out;
  }) as never);
}

/** Counts WebCrypto decrypts from now on (every envelope that got as far as AES-GCM, on any side). */
function countDecrypts(): () => number {
  const spy = vi.spyOn(crypto.subtle, 'decrypt');
  return () => spy.mock.calls.length;
}

/**
 * One side's broker pool; `raw` counts every payload the pool hands to a subscriber, so a test can tell the
 * channel did receive something (a copy per broker) even when the channel rightly calls back nobody.
 */
function pool(defs: BrokerDef[], opts?: ConstructorParameters<typeof Brokers>[1]) {
  const p = new Brokers(defs, opts);
  cleanup.push(() => p.stop());
  const raw = new Map<string, number>();
  let afterDeliver: (() => void) | undefined;
  const subscribe = p.subscribe.bind(p);
  vi.spyOn(p, 'subscribe').mockImplementation((topic, cb) => subscribe(topic, (payload, name) => {
    raw.set(topic, (raw.get(topic) ?? 0) + 1);
    cb(payload, name);
    afterDeliver?.();
  }));
  return {
    p,
    raw: (topic: string) => raw.get(topic) ?? 0,
    /** Runs right after the channel's broker callback returned (its decrypt still pending). */
    onDeliver(fn: () => void) {
      afterDeliver = fn;
    },
  };
}

const defsOf = (...bs: Broker[]): BrokerDef[] => bs.map((b, i) => ({ name: `B${i}`, url: b.url }));
const allUp = (p: Brokers) => p.status().every((s) => s.ok);

function channel(brokers: Brokers, room: Room, self: 'phone' | 'pc') {
  const ch = new SignalChannel(brokers, room, self);
  cleanup.push(() => ch.close());
  const got: SignalMsg[] = [];
  ch.on((m) => got.push(m));
  return { ch, got };
}

/** Phone and PC, each with its own pool on the same two brokers, plus a sniffer pool that sees the raw topic. */
async function pair(room?: Room) {
  const [a, b] = [await broker(), await broker()];
  const r = room ?? await deviceRoom('device-token');
  const phone = pool(defsOf(a, b));
  const pc = pool(defsOf(a, b));
  const sniff = pool(defsOf(a, b));
  for (const s of [phone, pc, sniff]) s.p.start();
  await until(() => allUp(phone.p) && allUp(pc.p) && allUp(sniff.p), 'every pool up');
  const captured: Uint8Array[] = [];
  await sniff.p.subscribe(r.topic, (payload) => captured.push(payload));
  const P = channel(phone.p, r, 'phone');
  const C = channel(pc.p, r, 'pc');
  await Promise.all([P.ch.open(), C.ch.open()]);
  return { a, b, room: r, phone, pc, sniff, captured, P, C };
}

describe('SignalChannel', () => {
  it('a message sent through two brokers calls back the other side exactly once', async () => {
    const t = await pair();
    await t.C.ch.send({ t: 'ack', s: 'x' });
    await until(() => t.a.published === 1 && t.b.published === 1, 'one publish on each broker');
    await until(() => t.P.got.length === 1, 'the ack on the phone');
    await until(() => t.phone.raw(t.room.topic) === 2, 'the second copy on the phone');
    await settle();
    expect(t.P.got).toHaveLength(1);
    const m = t.P.got[0];
    expect(m).toMatchObject({ v: 1, t: 'ack', s: 'x', from: 'pc' });
    expect(typeof m.n).toBe('string');
    expect(typeof m.ts).toBe('number');
    // and the other way round
    await t.P.ch.send({ t: 'hello', s: 'y', pn: 'nonce' });
    await until(() => t.C.got.length === 1, 'the hello on the PC');
    expect(t.C.got[0]).toMatchObject({ t: 'hello', s: 'y', pn: 'nonce', from: 'phone' });
  });

  it('never calls back the side that sent it (the brokers echo our own publishes)', async () => {
    const t = await pair();
    await t.C.ch.send({ t: 'ack', s: 'x' });
    await until(() => t.P.got.length === 1, 'the ack on the phone');
    await until(() => t.pc.raw(t.room.topic) === 2, 'both echoes back on the PC');
    await settle();
    expect(t.C.got).toEqual([]);
  });

  it('the sender cannot be forged through send(): from is always this side', async () => {
    const t = await pair();
    await t.C.ch.send({ t: 'ack', s: 'x', from: 'phone' });
    await until(() => t.P.got.length === 1, 'the ack on the phone');
    expect(t.P.got[0].from).toBe('pc');
    await settle();
    expect(t.C.got).toEqual([]);
  });

  it('a channel of another room hears nothing, not even when it listens on the same topic', async () => {
    const t = await pair();
    const other = await deviceRoom('another-token');
    expect(other.topic).not.toBe(t.room.topic);
    // another device's room on the same two pools (the PC keeps one channel per device on one pool)
    const B = channel(t.phone.p, other, 'phone');
    const OC = channel(t.pc.p, other, 'pc');
    await Promise.all([B.ch.open(), OC.ch.open()]);
    // and a channel on our topic without our key
    const lost = pool(defsOf(t.a, t.b));
    lost.p.start();
    await until(() => allUp(lost.p), 'the extra pool up');
    const W = channel(lost.p, { ...other, topic: t.room.topic }, 'phone');
    await W.ch.open();
    // one message in each room
    await t.C.ch.send({ t: 'ack', s: 'ours' });
    await OC.ch.send({ t: 'ack', s: 'theirs' });
    await until(() => t.P.got.length === 1 && B.got.length === 1, 'each room its own ack');
    await until(() => t.phone.raw(t.room.topic) === 2 && t.phone.raw(other.topic) === 2, 'every copy on the phone pool');
    await until(() => lost.raw(t.room.topic) === 2, 'the wrong-key channel to get both copies of ours');
    await settle();
    expect(t.P.got.map((m) => m.s)).toEqual(['ours']);
    expect(B.got.map((m) => m.s)).toEqual(['theirs']);
    expect(W.got).toEqual([]);
  });

  it('an envelope sealed with another key and published onto our topic is dropped silently', async () => {
    const t = await pair();
    const err = vi.spyOn(console, 'error');
    const other = await deviceRoom('attacker');
    const forged = await seal({ ...other, topic: t.room.topic }, { t: 'ack', s: 'x', from: 'pc' });
    expect(t.sniff.p.publish(t.room.topic, forged)).toBe(2);
    await until(() => t.phone.raw(t.room.topic) === 2, 'both copies of the forgery on the phone');
    await settle();
    expect(t.P.got).toEqual([]);
    expect(err).not.toHaveBeenCalled();
  });

  it('replaying the ciphertext captured off a broker calls nobody back again', async () => {
    const t = await pair();
    await t.C.ch.send({ t: 'offer', s: 'x', sdp: 'v=0' });
    await until(() => t.P.got.length === 1 && t.captured.length === 2, 'the offer and its capture');
    const before = t.phone.raw(t.room.topic);
    // the attacker re-publishes the exact bytes, through both brokers, twice
    for (const copy of [t.captured[0], t.captured[1]]) expect(t.sniff.p.publish(t.room.topic, copy)).toBe(2);
    await until(() => t.phone.raw(t.room.topic) === before + 4, 'the replays on the phone');
    await settle();
    expect(t.P.got).toHaveLength(1);
    // the channel still works afterwards
    await t.C.ch.send({ t: 'answer', s: 'x' });
    await until(() => t.P.got.length === 2, 'a fresh message');
    expect(t.P.got[1].t).toBe('answer');
  });

  it('garbage from an untrusted broker is dropped without a throw or a log, and the channel keeps working', async () => {
    const t = await pair();
    const err = vi.spyOn(console, 'error');
    const junk: (string | Uint8Array)[] = [
      '',
      new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28]),
      'not base64url!!',
      'A',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      JSON.stringify({ v: 1, t: 'ack', s: 'x', n: 'n', ts: Date.now(), from: 'pc' }),
      'A'.repeat(MAX_ENVELOPE_BYTES + 4),
    ];
    for (const j of junk) expect(t.sniff.p.publish(t.room.topic, j)).toBe(2);
    await until(() => t.phone.raw(t.room.topic) === junk.length * 2, 'all the junk on the phone');
    await t.C.ch.send({ t: 'ack', s: 'after' });
    await until(() => t.P.got.length === 1, 'the real message');
    await settle();
    expect(t.P.got.map((m) => m.s)).toEqual(['after']);
    expect(err).not.toHaveBeenCalled();
  });

  it('an envelope over the size cap is dropped even when it is genuine, and send() refuses to make one', async () => {
    const t = await pair();
    const big = await seal(t.room, { t: 'offer', s: 'x', from: 'pc', sdp: 'x'.repeat(MAX_ENVELOPE_BYTES) });
    expect(big.length).toBeGreaterThan(MAX_ENVELOPE_BYTES);
    expect(t.sniff.p.publish(t.room.topic, big)).toBe(2);
    await until(() => t.phone.raw(t.room.topic) === 2, 'both copies on the phone');
    await settle();
    expect(t.P.got).toEqual([]);
    await expect(t.C.ch.send({ t: 'offer', s: 'x', sdp: 'x'.repeat(MAX_ENVELOPE_BYTES) })).rejects.toThrow(/too large/);
    // a marker on the same connections: once it is through, anything published before it would be counted too
    await t.C.ch.send({ t: 'ack', s: 'marker' });
    await until(() => t.P.got.length === 1, 'the marker');
    expect(t.P.got[0].s).toBe('marker');
    // the sniffer's big one and the marker, nothing else
    expect([t.a.published, t.b.published]).toEqual([2, 2]);
  });

  it('messages arrive in the order send() was called, even when nobody awaits in between', async () => {
    const t = await pair();
    const ids = Array.from({ length: 12 }, (_, i) => String(i));
    // big and small mixed, the big ones' encrypt slower: unserialized, a small one would be published first
    slowForBig('encrypt');
    const pad = (i: number) => (i % 3 === 0 ? 'x'.repeat(40_000) : '');
    await Promise.all(ids.map((s, i) => t.C.ch.send({ t: 'cand', s, pad: pad(i) })));
    await until(() => t.P.got.length === ids.length, 'every candidate');
    await until(() => t.phone.raw(t.room.topic) === ids.length * 2, 'every copy');
    await settle();
    expect(t.P.got.map((m) => m.s)).toEqual(ids);
  });

  it('messages are handed over in the order they arrived, also when a burst arrives at once', async () => {
    const t = await pair();
    const ids = Array.from({ length: 12 }, (_, i) => `b${i}`);
    const sealed: string[] = [];
    for (const [i, s] of ids.entries()) {
      sealed.push(await seal(t.room, { t: 'cand', s, from: 'pc', pad: i % 3 === 0 ? 'x'.repeat(40_000) : '' }));
    }
    // all glued into one WS message: the pool hands them over in one go, so their decrypts would overlap, and the
    // big ones' decrypt is slower
    slowForBig('decrypt');
    t.a.sendRaw(glue(t.room.topic, sealed));
    await until(() => t.phone.raw(t.room.topic) === ids.length, 'the whole burst on the phone');
    await until(() => t.P.got.length === ids.length, 'the whole burst handed over');
    expect(t.P.got.map((m) => m.s)).toEqual(ids);
  });

  it('send() rejects when no broker took the message, and works once one is up', async () => {
    const a = await broker();
    const room = await deviceRoom('tok');
    const phone = pool(defsOf(a));
    const pc = pool(defsOf(a));
    const P = channel(phone.p, room, 'phone');
    const C = channel(pc.p, room, 'pc');
    // nothing started yet: nothing can take it
    await expect(C.ch.send({ t: 'ack', s: 'x' })).rejects.toThrow(/no broker took it \(none connected, or all backed up\)/);
    phone.p.start();
    pc.p.start();
    await until(() => allUp(phone.p) && allUp(pc.p), 'both pools up');
    await P.ch.open();
    await C.ch.send({ t: 'ack', s: 'y' });
    await until(() => P.got.length === 1, 'the ack');
    await settle();
    // the refused one was not kept and sent later either
    expect(P.got.map((m) => m.s)).toEqual(['y']);
    expect(a.published).toBe(1);
  });

  it('open() does not hang with every broker down, and send() then rejects', async () => {
    const p = pool([{ name: 'dead', url: await deadUrl() }], { redialMs: 60_000 });
    p.p.start();
    const { ch } = channel(p.p, await deviceRoom('tok'), 'phone');
    const t0 = Date.now();
    await ch.open();
    expect(Date.now() - t0).toBeLessThan(5000);
    await expect(ch.send({ t: 'hello', s: 'x' })).rejects.toThrow(/no broker/i);
  });

  it('a listener that throws does not stop other listeners or later messages; on() returns an off switch', async () => {
    const t = await pair();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second: string[] = [];
    const third: string[] = [];
    t.P.ch.on(() => {
      throw new Error('listener bug');
    });
    t.P.ch.on((m) => second.push(m.s));
    const off = t.P.ch.on((m) => third.push(m.s));
    await t.C.ch.send({ t: 'ack', s: '1' });
    await until(() => second.length === 1, 'the first message');
    off();
    off();
    await t.C.ch.send({ t: 'ack', s: '2' });
    await until(() => second.length === 2, 'the second message');
    expect(second).toEqual(['1', '2']);
    expect(third).toEqual(['1']);
    expect(t.P.got.map((m) => m.s)).toEqual(['1', '2']);
    expect(err).toHaveBeenCalled();
  });

  // queued: closed right after the pool handed the first copy over, before the channel looked at it;
  // decrypting: closed one microtask later, when its decrypt has started and not finished
  it.each(['queued', 'decrypting'])('close() stops callbacks (a message %s included), unsubscribes, and makes send / open reject', async (when) => {
    const t = await pair();
    t.phone.onDeliver(() => (when === 'queued' ? t.P.ch.close() : queueMicrotask(() => t.P.ch.close())));
    await t.C.ch.send({ t: 'ack', s: 'x' });
    await until(() => t.captured.length === 2, 'the sniffer to see it');
    await settle();
    expect(t.P.got).toEqual([]);
    const seen = t.phone.raw(t.room.topic);
    expect(seen).toBe(1);
    // unsubscribed: later messages do not even reach the phone's pool callback
    await t.C.ch.send({ t: 'ack', s: 'y' });
    await until(() => t.captured.length === 4, 'the sniffer to see the second one');
    await settle();
    expect(t.phone.raw(t.room.topic)).toBe(seen);
    expect(t.P.got).toEqual([]);
    await expect(t.P.ch.send({ t: 'bye', s: 'x' })).rejects.toThrow(/closed/);
    await expect(t.P.ch.open()).rejects.toThrow(/closed/);
    t.P.ch.close();
  });

  it('a phone and a PC channel of one room on ONE pool each hear the other exactly once; closing one leaves the other working', async () => {
    const [a, b] = [await broker(), await broker()];
    const room = await deviceRoom('one-pool');
    const one = pool(defsOf(a, b));
    const far = pool(defsOf(a, b));
    one.p.start();
    far.p.start();
    await until(() => allUp(one.p) && allUp(far.p), 'both pools up');
    const P = channel(one.p, room, 'phone');
    const C = channel(one.p, room, 'pc');
    await Promise.all([P.ch.open(), C.ch.open()]);
    await C.ch.send({ t: 'ack', s: 'from-pc' });
    await P.ch.send({ t: 'hello', s: 'from-phone' });
    await until(() => P.got.length === 1 && C.got.length === 1, 'each side its message');
    await until(() => one.raw(room.topic) === 4, 'two copies of each on the shared pool');
    await settle();
    expect(P.got.map((m) => [m.s, m.from])).toEqual([['from-pc', 'pc']]);
    expect(C.got.map((m) => [m.s, m.from])).toEqual([['from-phone', 'phone']]);
    // the phone channel goes; a phone channel on another pool still reaches the PC channel, and back
    P.ch.close();
    const X = channel(far.p, room, 'phone');
    await X.ch.open();
    await X.ch.send({ t: 'hello', s: 'third' });
    await until(() => C.got.length === 2, 'the PC channel to hear the third channel');
    expect(C.got[1].s).toBe('third');
    await C.ch.send({ t: 'ack', s: 'back' });
    await until(() => X.got.length === 1, 'the third channel to hear the PC');
    expect(X.got[0].s).toBe('back');
    await settle();
    expect(P.got).toHaveLength(1);
    expect(C.got).toHaveLength(2);
  });

  it('two channels of one room and side on one pool (overlapping dials) both hear; the topic goes only with the last', async () => {
    const t = await pair();
    const next = channel(t.phone.p, t.room, 'phone');
    await next.ch.open();
    await t.C.ch.send({ t: 'ack', s: 'both' });
    await until(() => t.P.got.length === 1 && next.got.length === 1, 'both phone channels');
    // the newer one closes first: the older one keeps hearing
    next.ch.close();
    await t.C.ch.send({ t: 'ack', s: 'still' });
    await until(() => t.P.got.length === 2, 'the older channel after the newer closed');
    // the last one closes: unsubscribed, later messages do not even reach the phone pool
    t.P.ch.close();
    const seen = t.phone.raw(t.room.topic);
    await t.C.ch.send({ t: 'ack', s: 'gone' });
    await until(() => t.captured.length === 6, 'the sniffer to see the third message');
    await settle();
    expect(t.phone.raw(t.room.topic)).toBe(seen);
    expect(t.P.got.map((m) => m.s)).toEqual(['both', 'still']);
    expect(next.got.map((m) => m.s)).toEqual(['both']);
  });

  it('copies from the other brokers, our own echoes and replays are dropped without a decrypt', async () => {
    const t = await pair();
    const decrypts = countDecrypts();
    await t.C.ch.send({ t: 'ack', s: 'x' });
    await until(() => t.P.got.length === 1 && t.captured.length === 2, 'the ack and its capture');
    await until(() => t.phone.raw(t.room.topic) === 2 && t.pc.raw(t.room.topic) === 2, 'both copies on each side');
    await settle();
    // one decrypt in all: the phone's first copy (its second copy and both echoes on the PC are skipped)
    expect(decrypts()).toBe(1);
    for (const copy of t.captured) expect(t.sniff.p.publish(t.room.topic, copy)).toBe(2);
    await until(() => t.phone.raw(t.room.topic) === 6 && t.pc.raw(t.room.topic) === 6, 'the replays on each side');
    await settle();
    expect(decrypts()).toBe(1);
    expect(t.P.got).toHaveLength(1);
  });

  it('junk under a real envelope\'s IV, published ahead of it, does not get the real one skipped', async () => {
    const t = await pair();
    t.C.ch.close(); // only the phone opens anything here
    const decrypts = countDecrypts();
    const real = await seal(t.room, { t: 'ack', s: 'real', from: 'pc' });
    const bytes = unb64u(real);
    bytes[bytes.length - 1] ^= 0x01; // same IV, broken tag
    const junk = b64u(bytes);
    expect(junk.slice(0, 16)).toBe(real.slice(0, 16));
    expect(t.sniff.p.publish(t.room.topic, junk)).toBe(2);
    await until(() => t.phone.raw(t.room.topic) === 2, 'both copies of the junk');
    await settle();
    // both tried, neither remembered
    expect(decrypts()).toBe(2);
    expect(t.sniff.p.publish(t.room.topic, real)).toBe(2);
    await until(() => t.P.got.length === 1, 'the real one');
    await until(() => t.phone.raw(t.room.topic) === 4, 'both copies of the real one');
    await settle();
    expect(t.P.got.map((m) => m.s)).toEqual(['real']);
    // the real one's second copy was skipped
    expect(decrypts()).toBe(3);
  });

  it('a flood past MAX_PENDING envelopes waiting to be opened is dropped, and the channel recovers', async () => {
    const t = await pair();
    t.C.ch.close();
    const decrypts = countDecrypts();
    // junk that gets as far as AES-GCM: well-formed base64url, long enough, no valid tag
    const junk = Array.from({ length: MAX_PENDING + 100 }, () => b64u(crypto.getRandomValues(new Uint8Array(64))));
    // one WS message: every one of them is handed to the channel before the first is opened
    t.a.sendRaw(glue(t.room.topic, junk));
    await until(() => t.phone.raw(t.room.topic) === junk.length, 'the whole flood on the phone pool', 15_000);
    await until(() => decrypts() === MAX_PENDING, 'the queued part to be tried', 15_000);
    await settle();
    expect(decrypts()).toBe(MAX_PENDING);
    expect(t.sniff.p.publish(t.room.topic, await seal(t.room, { t: 'ack', s: 'after', from: 'pc' }))).toBe(2);
    await until(() => t.P.got.length === 1, 'a real message after the flood');
    expect(t.P.got[0].s).toBe('after');
  });

  it('close() while open() still waits for its subscription makes open() reject', async () => {
    const silent = await startBroker({ silent: true });
    cleanup.push(() => silent.close());
    const p = pool([{ name: 'silent', url: silent.url }], { connectTimeoutMs: 20_000 });
    p.p.start();
    const { ch } = channel(p.p, await deviceRoom('tok'), 'phone');
    const opening = ch.open();
    const t0 = Date.now();
    ch.close();
    await expect(opening).rejects.toThrow(/closed before its subscription was confirmed/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('payloads are decoded as UTF-8 text before opening (non-ASCII fields survive)', async () => {
    const t = await pair();
    await t.C.ch.send({ t: 'ack', s: 'x', pc: '我的电脑 \u{1F4BB}' });
    await until(() => t.P.got.length === 1, 'the ack');
    expect(t.P.got[0].pc).toBe('我的电脑 \u{1F4BB}');
    expect(dec.decode(t.captured[0])).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
