import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBroker } from '../__mocks__/mqtt-broker.mjs';
import {
  Brokers, MAX_PACKET_BYTES, MqttClient, PacketReader, encodePublish, encodeRemainingLength, nextPacketId,
  type BrokerDef,
} from './mqtt.js';

type Broker = Awaited<ReturnType<typeof startBroker>>;
type Got = { topic: string; payload: Uint8Array };

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 3000): Promise<number> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
  return Date.now() - t0;
}

function bytes(n: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function broker(opts?: Parameters<typeof startBroker>[0]): Promise<Broker> {
  const b = await startBroker(opts);
  cleanup.push(() => b.close());
  return b;
}

/** A port nothing listens on any more. */
async function deadUrl(): Promise<string> {
  const b = await startBroker();
  await b.close();
  return b.url;
}

function newClient(url: string, def: Partial<BrokerDef> = {}, opts?: ConstructorParameters<typeof MqttClient>[1]): MqttClient {
  const c = new MqttClient({ name: 'test', url, ...def }, opts);
  cleanup.push(() => c.close());
  return c;
}

async function client(b: Broker, def: Partial<BrokerDef> = {}, opts?: ConstructorParameters<typeof MqttClient>[1]) {
  const c = newClient(b.url, def, opts);
  await c.connect();
  return c;
}

function inbox(c: MqttClient): Got[] {
  const got: Got[] = [];
  c.onmessage = (topic, payload) => got.push({ topic, payload });
  return got;
}

function closes(c: MqttClient): string[] {
  const why: string[] = [];
  c.onclose = (reason?: string) => why.push(reason ?? '');
  return why;
}

describe('packet codec', () => {
  it('encodes remaining lengths at every byte-count boundary', () => {
    const cases: [number, number[]][] = [
      [0, [0]], [127, [0x7f]], [128, [0x80, 0x01]], [16_383, [0xff, 0x7f]], [16_384, [0x80, 0x80, 0x01]],
      [2_097_151, [0xff, 0xff, 0x7f]], [2_097_152, [0x80, 0x80, 0x80, 0x01]], [268_435_455, [0xff, 0xff, 0xff, 0x7f]],
    ];
    for (const [n, want] of cases) expect(encodeRemainingLength(n), String(n)).toEqual(want);
    for (const bad of [268_435_456, -1, 1.5, Number.NaN]) expect(() => encodeRemainingLength(bad)).toThrow();
  });

  it('a 70 000-byte PUBLISH carries a 3-byte remaining length', () => {
    const p = encodePublish('cw1/t', bytes(70_000));
    const rem = 2 + 5 + 70_000;
    expect(p[0]).toBe(0x30);
    expect(Array.from(p.subarray(1, 4))).toEqual(encodeRemainingLength(rem));
    expect(encodeRemainingLength(rem)).toHaveLength(3);
    expect(p.length).toBe(1 + 3 + rem);
  });

  it('packet ids are 1..65535: never 0, wrap after 65535, skip ids still in use', () => {
    expect(nextPacketId(0, () => false)).toBe(1);
    expect(nextPacketId(1, () => false)).toBe(2);
    expect(nextPacketId(65_535, () => false)).toBe(1);
    expect(nextPacketId(65_534, (id) => id === 65_535 || id === 1)).toBe(2);
    expect(() => nextPacketId(5, () => true)).toThrow();
  });

  it('the reader reassembles packets fed one byte at a time and splits glued ones', () => {
    const a = encodePublish('a', bytes(300, 1));
    const b = encodePublish('b/c', 'two');
    const whole = concat(a, b);
    for (const feed of [[whole], Array.from(whole, (x) => new Uint8Array([x])), [whole.subarray(0, 2), whole.subarray(2, 400), whole.subarray(400)]]) {
      const r = new PacketReader();
      const seen: { first: number; body: number[] }[] = [];
      for (const chunk of feed) r.push(chunk, (first, body) => seen.push({ first, body: Array.from(body) }));
      expect(seen.map((s) => s.first)).toEqual([0x30, 0x30]);
      expect(seen[0].body).toEqual(Array.from(a.subarray(3)));
      expect(seen[1].body).toEqual(Array.from(b.subarray(2)));
    }
  });

  it('the reader refuses an oversized packet from its header alone, and a 5-byte remaining length', () => {
    const r = new PacketReader();
    expect(() => r.push(new Uint8Array([0x30, ...encodeRemainingLength(MAX_PACKET_BYTES + 1)]), () => {})).toThrow(/exceeds/);
    expect(() => new PacketReader().push(new Uint8Array([0x30, 0x80, 0x80, 0x80, 0x80, 0x01]), () => {})).toThrow(/4 bytes/);
    // a packet of exactly the cap is fine
    const seen: number[] = [];
    new PacketReader().push(concat(new Uint8Array([0x30, ...encodeRemainingLength(MAX_PACKET_BYTES)]), new Uint8Array(MAX_PACKET_BYTES)), (_f, body) => seen.push(body.length));
    expect(seen).toEqual([MAX_PACKET_BYTES]);
  });
});

describe('MqttClient', () => {
  it('connects as MQTT 3.1.1 with the mqtt subprotocol, clean session, keepalive 60 and a short client id', async () => {
    const b = await broker();
    await client(b);
    expect(b.clients).toBe(1);
    const c = b.connects[0];
    expect(c).toMatchObject({ proto: 'MQTT', level: 4, flags: 0x02, keepalive: 60 });
    expect(c.clientId).toMatch(/^[0-9a-zA-Z]{1,23}$/);
    expect(c.username).toBeUndefined();
  });

  it('sends username and password, and rejects when the broker refuses them', async () => {
    const b = await broker({ auth: { username: 'public', password: 'public' } });
    await client(b, { username: 'public', password: 'public' });
    expect(b.connects[0]).toMatchObject({ flags: 0xc2, username: 'public', password: 'public' });
    await expect(newClient(b.url, { username: 'public', password: 'nope' }).connect()).rejects.toThrow(/4/);
  });

  it('self-publish round-trips the payload byte for byte, 70 000 bytes split over several WS messages included', async () => {
    const b = await broker({ frameBytes: 16_384 });
    const c = await client(b);
    const got = inbox(c);
    await c.subscribe('cw1/rt');
    const payloads = [new Uint8Array(0), new TextEncoder().encode('你好 MQTT \u{1F600}'), bytes(256), bytes(70_000, 7)];
    for (const p of payloads) expect(c.publish('cw1/rt', p)).toBe(true);
    expect(c.publish('cw1/rt', '文字也行')).toBe(true);
    await until(() => got.length === 5, 'five messages');
    expect(b.published).toBe(5);
    for (let i = 0; i < payloads.length; i++) {
      expect(got[i].topic).toBe('cw1/rt');
      expect(got[i].payload.length).toBe(payloads[i].length);
      expect(Buffer.from(got[i].payload).equals(Buffer.from(payloads[i]))).toBe(true);
    }
    expect(new TextDecoder().decode(got[4].payload)).toBe('文字也行');
  });

  it('two PUBLISH packets glued into one WS message both arrive, in order', async () => {
    const b = await broker();
    const c = await client(b);
    const got = inbox(c);
    b.sendRaw(concat(encodePublish('t/a', 'one'), encodePublish('t/b', bytes(20_000))));
    await until(() => got.length === 2, 'two messages');
    expect(got.map((g) => g.topic)).toEqual(['t/a', 't/b']);
    expect(new TextDecoder().decode(got[0].payload)).toBe('one');
    expect(Buffer.from(got[1].payload).equals(Buffer.from(bytes(20_000)))).toBe(true);
  });

  it('a packet arriving one byte per WS message (remaining length split too) arrives once', async () => {
    const b = await broker();
    const c = await client(b);
    const got = inbox(c);
    const p = encodePublish('t/slow', bytes(200, 3));
    for (const x of p) b.sendRaw(new Uint8Array([x]));
    b.sendRaw(encodePublish('t/after', 'x'));
    await until(() => got.length === 2, 'both messages');
    expect(Buffer.from(got[0].payload).equals(Buffer.from(bytes(200, 3)))).toBe(true);
    expect(got[1].topic).toBe('t/after');
  });

  it('accepts a packet of exactly 1 MiB', async () => {
    const b = await broker();
    const c = await client(b);
    const got = inbox(c);
    const payload = bytes(MAX_PACKET_BYTES - 2 - 3, 9);
    const p = encodePublish('t/1', payload);
    expect(p.length).toBe(1 + 3 + MAX_PACKET_BYTES);
    b.sendRaw(p);
    await until(() => got.length === 1, 'the 1 MiB message');
    expect(Buffer.from(got[0].payload).equals(Buffer.from(payload))).toBe(true);
  });

  const malformed: [string, Uint8Array | string][] = [
    ['a remaining length over 1 MiB (header only)', new Uint8Array([0x30, ...encodeRemainingLength(MAX_PACKET_BYTES + 1)])],
    ['a 5-byte remaining length', new Uint8Array([0x30, 0xff, 0xff, 0xff, 0xff, 0x01])],
    ['a topic length running past the packet', new Uint8Array([0x30, 3, 0x00, 0x09, 0x61])],
    ['PUBLISH with QoS 3', new Uint8Array([0x36, 5, 0x00, 0x01, 0x61, 0x00, 0x01])],
    ['a topic that is not UTF-8', new Uint8Array([0x30, 4, 0x00, 0x02, 0xc3, 0x28])],
    ['a SUBACK shorter than 3 bytes', new Uint8Array([0x90, 2, 0x00, 0x01])],
    ['a text frame', 'not mqtt'],
  ];
  it.each(malformed)('drops the connection on %s, without throwing', async (_what, raw) => {
    const b = await broker();
    const c = await client(b);
    const got = inbox(c);
    const why = closes(c);
    b.sendRaw(raw);
    await until(() => why.length === 1, 'the drop');
    expect(why[0]).toBeTruthy();
    expect(c.publish('t', 'x')).toBe(false);
    await until(() => b.clients === 0, 'the broker to see the drop');
    expect(got).toEqual([]);
  });

  it('a message handler that throws does not stop later messages or the connection', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const b = await broker();
    const c = await client(b);
    const got: string[] = [];
    c.onmessage = (topic) => {
      got.push(topic);
      if (topic === 't/bad') throw new Error('handler bug');
    };
    await c.subscribe('t/bad');
    await c.subscribe('t/good');
    c.publish('t/bad', 'x');
    c.publish('t/good', 'y');
    await until(() => got.length === 2, 'both messages');
    expect(got).toEqual(['t/bad', 't/good']);
    expect(err).toHaveBeenCalled();
    expect(c.publish('t/good', 'z')).toBe(true);
  });

  it('unsubscribe stops delivery (checked against a later message on another topic)', async () => {
    const b = await broker();
    const c = await client(b);
    const got = inbox(c);
    await c.subscribe('t/a');
    await c.subscribe('t/b');
    c.unsubscribe('t/a');
    c.publish('t/a', 'gone');
    c.publish('t/b', 'barrier');
    await until(() => got.some((g) => g.topic === 't/b'), 'the barrier');
    expect(got.map((g) => g.topic)).toEqual(['t/b']);
  });

  it('a refused subscription rejects and leaves the connection usable', async () => {
    const b = await broker({ denyTopics: ['t/no'] });
    const c = await client(b);
    await expect(c.subscribe('t/no')).rejects.toThrow(/refused/);
    await c.subscribe('t/yes');
    const got = inbox(c);
    c.publish('t/yes', 'ok');
    await until(() => got.length === 1, 'the message');
  });

  it('never uses packet id 0, and concurrent subscriptions get distinct ids', async () => {
    const b = await broker();
    const c = await client(b);
    await Promise.all(Array.from({ length: 20 }, (_, i) => c.subscribe(`t/${i}`)));
    c.unsubscribe('t/0');
    await c.subscribe('t/again');
    expect(b.packetIds.length).toBe(22);
    expect(b.packetIds).not.toContain(0);
    expect(new Set(b.packetIds.slice(0, 20)).size).toBe(20);
  });

  it('pings on its interval and stays up while the broker answers', async () => {
    const b = await broker();
    const c = await client(b, {}, { pingMs: 40 });
    const why = closes(c);
    await sleep(300);
    expect(b.pings).toBeGreaterThanOrEqual(3);
    expect(why).toEqual([]);
    expect(c.publish('t', 'x')).toBe(true);
  });

  it('drops a connection that stops answering pings', async () => {
    const b = await broker({ ignorePing: true });
    const c = await client(b, {}, { pingMs: 40 });
    const why = closes(c);
    await until(() => why.length === 1, 'the drop', 1000);
    expect(why[0]).toMatch(/ping/);
  });

  it('connect times out when the broker never answers CONNECT', async () => {
    const b = await broker({ silent: true });
    const t0 = Date.now();
    await expect(newClient(b.url).connect(150)).rejects.toThrow(/150 ms/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('connect rejects when nothing listens, and when called twice', async () => {
    await expect(newClient(await deadUrl()).connect(2000)).rejects.toThrow();
    const b = await broker();
    const c = await client(b);
    await expect(c.connect()).rejects.toThrow(/once/);
  });

  it('close() ends quietly: no onclose, publish false, subscribe rejects', async () => {
    const b = await broker();
    const c = await client(b);
    const why = closes(c);
    c.close();
    c.close();
    expect(c.publish('t', 'x')).toBe(false);
    await expect(c.subscribe('t')).rejects.toThrow();
    await until(() => b.clients === 0, 'the broker to see the close');
    expect(why).toEqual([]);
  });

  it('close() during connect rejects the connect', async () => {
    const b = await broker({ silent: true });
    const c = newClient(b.url);
    const p = c.connect();
    await until(() => b.connects.length === 1, 'CONNECT');
    c.close();
    await expect(p).rejects.toThrow();
  });

  it('a subscribe still waiting when the connection drops rejects', async () => {
    const b = await broker();
    const c = await client(b);
    closes(c);
    const p = c.subscribe('t/x');
    b.sendRaw(new Uint8Array([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]));
    await expect(p).rejects.toThrow();
  });
});

describe('Brokers', () => {
  function pool(defs: BrokerDef[], opts?: ConstructorParameters<typeof Brokers>[1]): Brokers {
    const p = new Brokers(defs, opts);
    cleanup.push(() => p.stop());
    return p;
  }

  const allUp = (p: Brokers) => p.status().every((s) => s.ok);

  function listen(p: Brokers, topic: string) {
    const got: { payload: string; broker: string }[] = [];
    const ready = p.subscribe(topic, (payload, name) => got.push({ payload: new TextDecoder().decode(payload), broker: name }));
    return { got, ready };
  }

  it('publishes to every connected broker and does not dedupe what comes back', async () => {
    const [a, b] = [await broker(), await broker()];
    const p = pool([{ name: 'A', url: a.url }, { name: 'B', url: b.url }]);
    const changes = vi.fn();
    p.onchange = changes;
    p.start();
    await until(() => allUp(p), 'both brokers up');
    expect(changes).toHaveBeenCalled();
    expect(p.status()).toEqual([{ name: 'A', ok: true }, { name: 'B', ok: true }]);
    const { got, ready } = listen(p, 'cw1/x');
    await ready;
    expect(p.publish('cw1/x', 'hi')).toBe(2);
    await until(() => got.length === 2, 'a copy from each broker');
    expect(got.map((g) => g.broker).sort()).toEqual(['A', 'B']);
    expect(got.every((g) => g.payload === 'hi')).toBe(true);
    expect([a.published, b.published]).toEqual([1, 1]);
  });

  it('a broker that goes down turns ok:false, and is redialed with its subscriptions once it is back', async () => {
    const a = await broker();
    let b = await broker();
    const port = b.port;
    const url = b.url;
    const p = pool([{ name: 'A', url: a.url }, { name: 'B', url }], { redialMs: 200 });
    p.start();
    await until(() => allUp(p), 'both brokers up');
    const { got, ready } = listen(p, 'cw1/r');
    await ready;

    await b.close();
    await until(() => p.status()[1].ok === false, 'B down');
    expect(p.status()[1].error).toBeTruthy();
    expect(p.status()[0]).toEqual({ name: 'A', ok: true });
    expect(p.publish('cw1/r', 'while down')).toBe(1);
    await until(() => got.length === 1, 'the copy from A');

    await sleep(500); // a few failed redials in between
    b = await startBroker({ port });
    cleanup.push(() => b.close());
    expect(b.url).toBe(url);
    const took = await until(() => p.status()[1].ok, 'B back', 3000);
    expect(took).toBeLessThan(1500);
    expect(p.publish('cw1/r', 'back')).toBe(2);
    await until(() => got.filter((g) => g.payload === 'back').length === 2, 'both copies after the redial');
    expect(got.filter((g) => g.payload === 'back').map((g) => g.broker).sort()).toEqual(['A', 'B']);
  });

  it('relayOnly sends only to relay brokers', async () => {
    const [a, b] = [await broker(), await broker()];
    const p = pool([{ name: 'A', url: a.url }, { name: 'B', url: b.url, relay: true }]);
    p.start();
    await until(() => allUp(p), 'both brokers up');
    const { got, ready } = listen(p, 'cw1/r/s/up');
    await ready;
    expect(p.publish('cw1/r/s/up', 'frame', { relayOnly: true })).toBe(1);
    expect(p.publish('cw1/r/s/up', 'barrier')).toBe(2);
    await until(() => got.length === 3, 'three copies');
    expect(got.filter((g) => g.payload === 'frame').map((g) => g.broker)).toEqual(['B']);
    expect([a.published, b.published]).toEqual([1, 2]);
  });

  it('subscribe right after start() waits for a broker to confirm it', async () => {
    const a = await broker();
    const p = pool([{ name: 'A', url: a.url }]);
    p.start();
    const { got, ready } = listen(p, 'cw1/early');
    await ready;
    expect(p.publish('cw1/early', 'x')).toBe(1);
    await until(() => got.length === 1, 'the message');
  });

  it('a subscription made before start() is applied when brokers connect', async () => {
    const a = await broker();
    const p = pool([{ name: 'A', url: a.url }]);
    const { got, ready } = listen(p, 'cw1/before');
    await ready;
    p.start();
    await until(() => allUp(p), 'A up');
    // the SUBSCRIBE goes out right after CONNACK, so it is ahead of anything we publish on the same connection
    expect(p.publish('cw1/before', 'x')).toBe(1);
    await until(() => got.length === 1, 'the message');
  });

  it('a subscription refused by one broker still resolves through the other', async () => {
    const [a, b] = [await broker({ denyTopics: ['cw1/deny'] }), await broker()];
    const p = pool([{ name: 'A', url: a.url }, { name: 'B', url: b.url }]);
    p.start();
    await until(() => allUp(p), 'both brokers up');
    const { got, ready } = listen(p, 'cw1/deny');
    await ready;
    expect(p.publish('cw1/deny', 'x')).toBe(2);
    await until(() => got.length === 1, 'the copy from B');
    await sleep(50);
    expect(got.map((g) => g.broker)).toEqual(['B']);
  });

  it('a broker that never comes up does not hold up subscribe, and shows why', async () => {
    const a = await broker();
    const p = pool([{ name: 'dead', url: await deadUrl() }, { name: 'A', url: a.url }], { redialMs: 60_000 });
    p.start();
    const { got, ready } = listen(p, 'cw1/one');
    await ready;
    expect(p.publish('cw1/one', 'x')).toBe(1);
    await until(() => got.length === 1, 'the message');
    await until(() => p.status()[0].error !== undefined, 'the dead broker error');
    expect(p.status()[0]).toMatchObject({ name: 'dead', ok: false });
  });

  it('onchange fires when the status changes, not again on every redial that fails the same way', async () => {
    const a = await broker({ auth: { username: 'u', password: 'p' } });
    const p = pool([{ name: 'A', url: a.url }], { redialMs: 20 });
    const changes = vi.fn();
    p.onchange = changes;
    p.start();
    await until(() => a.connects.length >= 5, 'several refused dials');
    expect(p.status()).toEqual([{ name: 'A', ok: false, error: expect.stringMatching(/return code 4/) }]);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('with every broker down, subscribe resolves once the dials have failed', async () => {
    const p = pool([{ name: 'dead', url: await deadUrl() }], { redialMs: 60_000 });
    p.start();
    const t0 = Date.now();
    await listen(p, 'cw1/none').ready;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(p.publish('cw1/none', 'x')).toBe(0);
  });

  it('unsubscribe stops the callback', async () => {
    const a = await broker();
    const p = pool([{ name: 'A', url: a.url }]);
    p.start();
    const one = listen(p, 'cw1/a');
    const two = listen(p, 'cw1/b');
    await Promise.all([one.ready, two.ready]);
    p.unsubscribe('cw1/a');
    p.publish('cw1/a', 'gone');
    p.publish('cw1/b', 'barrier');
    await until(() => two.got.length === 1, 'the barrier');
    expect(one.got).toEqual([]);
  });

  it('stop() closes everything and stops redialing; start() again reconnects with the subscriptions', async () => {
    const a = await broker();
    const p = pool([{ name: 'A', url: a.url }], { redialMs: 50 });
    p.start();
    await until(() => allUp(p), 'A up');
    const { got, ready } = listen(p, 'cw1/kept');
    await ready;
    p.stop();
    expect(p.status()).toEqual([{ name: 'A', ok: false }]);
    expect(p.publish('cw1/x', 'x')).toBe(0);
    await until(() => a.clients === 0, 'the broker to see the close');
    const dials = a.connects.length;
    await sleep(300);
    expect(a.connects.length).toBe(dials);
    p.start();
    await until(() => allUp(p), 'A up again');
    expect(a.connects.length).toBe(dials + 1);
    expect(p.publish('cw1/kept', 'again')).toBe(1);
    await until(() => got.length === 1, 'the message after the restart');
  });

  it('rejects wildcard and empty topics', async () => {
    const p = pool([]);
    await expect(p.subscribe('cw1/+', () => {})).rejects.toThrow();
    await expect(p.subscribe('cw1/#', () => {})).rejects.toThrow();
    await expect(p.subscribe('', () => {})).rejects.toThrow();
  });
});
