import { describe, expect, it } from 'vitest';
import { b64u, deviceRoom, deviceRoomFromHash, pairRoom, relayKey, unb64u } from './keys.js';

// Web-standard only (this directory also ships to the phone shell), so no node:crypto here either.
async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytes(n: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed) & 0xff);
}

describe('b64u', () => {
  it('round-trips every length and byte value without padding or +/', () => {
    for (let len = 0; len <= 40; len++) {
      const b = bytes(len, len);
      const s = b64u(b);
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(Array.from(unb64u(s))).toEqual(Array.from(b));
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(unb64u(b64u(all)))).toEqual(Array.from(all));
    expect(b64u(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });

  it('handles inputs larger than one fromCharCode chunk', () => {
    const big = bytes(200_000, 7);
    expect(Array.from(unb64u(b64u(big)))).toEqual(Array.from(big));
  });

  it('rejects characters outside the base64url alphabet', () => {
    expect(() => unb64u('ab+c')).toThrow();
    expect(() => unb64u('ab/c')).toThrow();
    expect(() => unb64u('abc=')).toThrow();
    expect(() => unb64u('a')).toThrow();
  });
});

describe('rooms', () => {
  it('the phone (token) and the PC (stored hex hash) land in the same room', async () => {
    const a = await deviceRoom('tok');
    const b = await deviceRoomFromHash(await sha256hex('tok'));
    expect(a.topic).toMatch(/^cw1\/[0-9a-f]{32}$/);
    expect(b.topic).toBe(a.topic);
    expect(Array.from(b.ikm)).toEqual(Array.from(a.ikm));
    expect(a.ikm.length).toBe(32);
    expect(a.key.extractable).toBe(false);
  });

  it('accepts an upper-case hash and rejects anything that is not 64 hex chars', async () => {
    const h = await sha256hex('tok');
    expect((await deviceRoomFromHash(h.toUpperCase())).topic).toBe((await deviceRoom('tok')).topic);
    await expect(deviceRoomFromHash(h.slice(1))).rejects.toThrow();
    await expect(deviceRoomFromHash(`${h.slice(1)}g`)).rejects.toThrow();
  });

  it('different tokens, and device vs pairing salts, give different rooms', async () => {
    const a = await deviceRoom('tok');
    const b = await deviceRoom('tok2');
    expect(b.topic).not.toBe(a.topic);
    // same 16 bytes as K under both salts must not collide
    const p = bytes(16, 3);
    const pr = await pairRoom(p);
    expect(pr.topic).toMatch(/^cw1\/[0-9a-f]{32}$/);
    expect(pr.topic).not.toBe(a.topic);
  });

  it('pairRoom only takes the 16-byte QR secret', async () => {
    await expect(pairRoom(new Uint8Array(15))).rejects.toThrow();
    await expect(pairRoom(new Uint8Array(32))).rejects.toThrow();
  });

  // Fixed vectors: if these change, every paired phone and every printed QR stops finding the PC.
  // Taken from the first run and cross-checked against node:crypto hkdfSync with the same salt / info.
  it('pinned derivation vectors', async () => {
    expect((await pairRoom(new Uint8Array(16))).topic).toBe('cw1/8e7c3c8ae6cecf1c8a8fd69f15b242ff');
    expect((await deviceRoom('tok')).topic).toBe('cw1/66699aa863b4d9aabbebb471311d5fac');
  });
});

describe('relayKey', () => {
  async function canDecrypt(enc: CryptoKey, dec: CryptoKey): Promise<boolean> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, enc, new TextEncoder().encode('frame'));
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dec, ct);
      return new TextDecoder().decode(pt) === 'frame';
    } catch {
      return false;
    }
  }

  it('both sides with the same nonces get keys that decrypt each other', async () => {
    const phone = await deviceRoom('tok');
    const pc = await deviceRoomFromHash(await sha256hex('tok'));
    const pn = crypto.getRandomValues(new Uint8Array(16));
    const cn = crypto.getRandomValues(new Uint8Array(16));
    const kPhone = await relayKey(phone, pn, cn);
    const kPc = await relayKey(pc, pn, cn);
    expect(await canDecrypt(kPhone, kPc)).toBe(true);
    expect(await canDecrypt(kPc, kPhone)).toBe(true);
  });

  it('different nonces, swapped nonces, or another room give a key that does not decrypt', async () => {
    const room = await deviceRoom('tok');
    const pn = bytes(16, 1);
    const cn = bytes(16, 2);
    const k = await relayKey(room, pn, cn);
    expect(await canDecrypt(k, await relayKey(room, bytes(16, 9), cn))).toBe(false);
    expect(await canDecrypt(k, await relayKey(room, pn, bytes(16, 9)))).toBe(false);
    expect(await canDecrypt(k, await relayKey(room, cn, pn))).toBe(false);
    expect(await canDecrypt(k, await relayKey(await deviceRoom('tok2'), pn, cn))).toBe(false);
  });

  it('pinned: decrypts a frame encrypted by node:crypto with HKDF(K, phone ‖ pc nonce, "relay")', async () => {
    const raw = unb64u('BitQdZq_5AkuU3idd4u-YhalGt2DraKn-M_mdX0QUIib');
    const k = await relayKey(await deviceRoom('tok'), bytes(16, 1), bytes(16, 2));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, k, raw.subarray(12));
    expect(new TextDecoder().decode(pt)).toBe('frame');
  });

  it('nonces must be 16 bytes each', async () => {
    const room = await deviceRoom('tok');
    await expect(relayKey(room, new Uint8Array(8), new Uint8Array(16))).rejects.toThrow();
    await expect(relayKey(room, new Uint8Array(16), new Uint8Array(24))).rejects.toThrow();
  });
});
