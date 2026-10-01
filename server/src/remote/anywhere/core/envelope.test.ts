import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplayGuard, openEnvelope, seal, type SignalMsg } from './envelope.js';
import { b64u, deviceRoom, pairRoom, unb64u, type Room } from './keys.js';

const SKEW = 300_000;

afterEach(() => { vi.restoreAllMocks(); });

function flip(raw: string, at: number): string {
  const b = unb64u(raw);
  b[at < 0 ? b.length + at : at] ^= 0x01;
  return b64u(b);
}

async function sealAt(room: Room, ts: number, extra: Record<string, unknown> = {}): Promise<string> {
  vi.spyOn(Date, 'now').mockReturnValue(ts);
  try {
    return await seal(room, { t: 'hello', s: 'sess1', from: 'phone', ...extra });
  } finally {
    vi.restoreAllMocks();
  }
}

describe('seal / openEnvelope', () => {
  it('round-trips, filling v, a fresh 16-byte n and ts', async () => {
    const room = await deviceRoom('tok');
    const before = Date.now();
    const raw = await seal(room, { t: 'offer', s: 'sess1', from: 'phone', sdp: 'v=0\r\n', fp: ['a', 1] });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const msg = await openEnvelope(room, raw, 'pc', new ReplayGuard());
    expect(msg).not.toBeNull();
    const m = msg as SignalMsg;
    expect(m).toMatchObject({ v: 1, t: 'offer', s: 'sess1', from: 'phone', sdp: 'v=0\r\n', fp: ['a', 1] });
    expect(unb64u(m.n).length).toBe(16);
    expect(m.ts).toBeGreaterThanOrEqual(before);
    expect(m.ts).toBeLessThanOrEqual(Date.now());
  });

  // Built with node:crypto (HKDF "signal" key, AES-256-GCM, AAD = topic, iv ‖ ct+tag): pins the wire format the
  // phone shell and the PC must agree on, independently of seal().
  it('pinned: opens an envelope sealed by an independent implementation', async () => {
    const raw = 'BSpPdJm-4wgtUnecs1FU--yl3OiYCAqeh5vC7mJzFTIhllsvQFfRTROwRz6Are8wqAI75wRTzrWJxUPCgRtStYImrh3h2uuk_iSvNNPGPvmDjZvjrnHZd6pRxYVbOnJNfL9Tm8D6HRmBfxlUTxL4pezrOfuMwawOOvow5OMIfcbgWnZEnnfS';
    const m = await openEnvelope(await deviceRoom('tok'), raw, 'pc', new ReplayGuard(), 1_800_000_000_000);
    expect(m).toEqual({ v: 1, t: 'hello', s: 'sess1', n: 'bm9uY2Utbm9uY2Utbm9uY2U', ts: 1_800_000_000_000, from: 'phone', pn: 'AAAA' });
  });

  it('every envelope gets its own iv and n', async () => {
    const room = await deviceRoom('tok');
    const a = await seal(room, { t: 'hello', s: 'x', from: 'phone' });
    const b = await seal(room, { t: 'hello', s: 'x', from: 'phone' });
    expect(a).not.toBe(b);
    expect(b64u(unb64u(a).subarray(0, 12))).not.toBe(b64u(unb64u(b).subarray(0, 12)));
    const ma = await openEnvelope(room, a, 'pc', new ReplayGuard());
    const mb = await openEnvelope(room, b, 'pc', new ReplayGuard());
    expect(ma?.n).not.toBe(mb?.n);
  });

  it('seal cannot be told to reuse a nonce or forge v / ts', async () => {
    const room = await deviceRoom('tok');
    const raw = await seal(room, { t: 'hello', s: 'x', from: 'phone', v: 2, n: 'fixed', ts: 1 });
    const m = await openEnvelope(room, raw, 'pc', new ReplayGuard());
    expect(m?.v).toBe(1);
    expect(m?.n).not.toBe('fixed');
    expect(m?.ts).not.toBe(1);
  });

  it('a changed byte anywhere (iv, ciphertext, tag) is dropped', async () => {
    const room = await deviceRoom('tok');
    const raw = await seal(room, { t: 'hello', s: 'sess1', from: 'phone' });
    const guard = new ReplayGuard();
    for (const at of [0, 11, 12, 20, -17, -1]) {
      expect(await openEnvelope(room, flip(raw, at), 'pc', guard)).toBeNull();
    }
    // the untouched original still opens (the failed attempts did not burn its nonce)
    expect(await openEnvelope(room, raw, 'pc', guard)).not.toBeNull();
  });

  it('another room cannot open it, nor the same key under another topic (AAD)', async () => {
    const room = await deviceRoom('tok');
    const raw = await seal(room, { t: 'hello', s: 'sess1', from: 'phone' });
    expect(await openEnvelope(await deviceRoom('tok2'), raw, 'pc', new ReplayGuard())).toBeNull();
    expect(await openEnvelope(await pairRoom(new Uint8Array(16)), raw, 'pc', new ReplayGuard())).toBeNull();
    expect(await openEnvelope({ ...room, topic: 'cw1/00000000000000000000000000000000' }, raw, 'pc', new ReplayGuard())).toBeNull();
  });

  it('drops anything more than 300 000 ms off, either way', async () => {
    const room = await deviceRoom('tok');
    const t0 = 1_800_000_000_000;
    const raw = () => sealAt(room, t0);
    expect(await openEnvelope(room, await raw(), 'pc', new ReplayGuard(), t0 + SKEW + 1)).toBeNull();
    expect(await openEnvelope(room, await raw(), 'pc', new ReplayGuard(), t0 - SKEW - 1)).toBeNull();
    expect(await openEnvelope(room, await raw(), 'pc', new ReplayGuard(), t0 + SKEW)).not.toBeNull();
    expect(await openEnvelope(room, await raw(), 'pc', new ReplayGuard(), t0 - SKEW)).not.toBeNull();
  });

  it('the same envelope opens once (two brokers deliver it twice)', async () => {
    const room = await deviceRoom('tok');
    const raw = await seal(room, { t: 'cand', s: 'sess1', from: 'pc', c: 'candidate:1' });
    const guard = new ReplayGuard();
    expect(await openEnvelope(room, raw, 'phone', guard)).not.toBeNull();
    expect(await openEnvelope(room, raw, 'phone', guard)).toBeNull();
  });

  it('our own message echoed back by the broker is dropped', async () => {
    const room = await deviceRoom('tok');
    const raw = await seal(room, { t: 'ack', s: 'sess1', from: 'pc' });
    expect(await openEnvelope(room, raw, 'pc', new ReplayGuard())).toBeNull();
    expect(await openEnvelope(room, raw, 'phone', new ReplayGuard())).not.toBeNull();
  });

  it('garbage never throws, it is just dropped', async () => {
    const room = await deviceRoom('tok');
    const g = new ReplayGuard();
    for (const raw of ['', 'a', '!!!!', 'AAAA', b64u(new Uint8Array(12)), b64u(new Uint8Array(60)), 42 as unknown as string]) {
      expect(await openEnvelope(room, raw, 'pc', g)).toBeNull();
    }
  });

  it('a correctly sealed body that is not a signal message is dropped', async () => {
    const room = await deviceRoom('tok');
    const enc = new TextEncoder();
    const sealRaw = async (body: unknown) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(room.topic) }, room.key, enc.encode(typeof body === 'string' ? body : JSON.stringify(body)));
      const out = new Uint8Array(12 + ct.byteLength);
      out.set(iv);
      out.set(new Uint8Array(ct), 12);
      return b64u(out);
    };
    const ok = { v: 1, t: 'hello', s: 's', n: 'abc', ts: Date.now(), from: 'phone' };
    expect(await openEnvelope(room, await sealRaw(ok), 'pc', new ReplayGuard())).not.toBeNull();
    const bad: unknown[] = [
      'not json', null, [ok], '"just a string"', '5',
      { ...ok, v: 2 }, { ...ok, t: 'nope' }, { ...ok, s: 1 }, { ...ok, n: '' }, { ...ok, n: 5 },
      { ...ok, ts: 'now' }, { ...ok, ts: null }, { ...ok, from: 'server' },
    ];
    for (const body of bad) {
      expect(await openEnvelope(room, await sealRaw(body), 'pc', new ReplayGuard())).toBeNull();
    }
  });
});

describe('ReplayGuard', () => {
  it('reports a nonce the second time it is seen', () => {
    const g = new ReplayGuard();
    expect(g.seen('a')).toBe(false);
    expect(g.seen('a')).toBe(true);
    expect(g.seen('b')).toBe(false);
  });

  it('defaults to 2048 entries and forgets the least recently seen', () => {
    const g = new ReplayGuard();
    for (let i = 0; i < 2048; i++) g.seen(`n${i}`);
    expect(g.seen('n0')).toBe(true); // refreshes n0, so n1 is now the oldest
    g.seen('new');
    expect(g.seen('n0')).toBe(true);
    expect(g.seen('n2047')).toBe(true);
    expect(g.seen('n1')).toBe(false); // evicted
  });

  it('honours a custom capacity', () => {
    const g = new ReplayGuard(2);
    g.seen('a');
    g.seen('b');
    g.seen('c');
    expect(g.seen('a')).toBe(false);
  });
});
