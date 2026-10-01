import { describe, expect, it } from 'vitest';
import { F, chunks, decodeFrame, encodeFrame, json, text } from './frames.js';

function bytes(n: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 37 + seed) & 0xff);
}

describe('encodeFrame / decodeFrame', () => {
  it('pins the type values both ends switch on', () => {
    expect([F.WS_OPEN, F.WS_MSG, F.WS_CLOSE, F.HTTP_REQ, F.BODY, F.END, F.HTTP_RES, F.PING, F.PONG, F.ERR])
      .toEqual([1, 2, 3, 0x10, 0x11, 0x12, 0x20, 0x30, 0x31, 0x40]);
  });

  it('lays out 1 type byte, a big-endian stream id, then the payload', () => {
    const f = encodeFrame(F.HTTP_REQ, 0x01020304, new Uint8Array([0xaa, 0xbb]));
    expect(Array.from(f)).toEqual([0x10, 0x01, 0x02, 0x03, 0x04, 0xaa, 0xbb]);
  });

  it('round-trips an empty payload, with or without the argument', () => {
    for (const f of [encodeFrame(F.PING, 7), encodeFrame(F.PING, 7, new Uint8Array(0)), encodeFrame(F.PING, 7, '')]) {
      expect(f.length).toBe(5);
      const d = decodeFrame(f);
      expect(d.type).toBe(F.PING);
      expect(d.stream).toBe(7);
      expect(d.payload.length).toBe(0);
    }
  });

  it('round-trips a UTF-8 string payload (Chinese, emoji, a leading BOM kept)', () => {
    const bom = String.fromCharCode(0xfeff);
    const s = `${bom}慢速转发时不能预览 / 上传文件 \u{1F600}`;
    const d = decodeFrame(encodeFrame(F.WS_MSG, 3, s));
    expect(d.type).toBe(F.WS_MSG);
    expect(text(d.payload)).toBe(s);
  });

  it('round-trips binary payloads and JSON', () => {
    const b = bytes(1000, 5);
    expect(Array.from(decodeFrame(encodeFrame(F.BODY, 9, b)).payload)).toEqual(Array.from(b));
    const head = { method: 'GET', path: '/api/file?path=C%3A%5Cx', headers: { range: 'bytes=0-9' } };
    expect(json(decodeFrame(encodeFrame(F.HTTP_REQ, 1, JSON.stringify(head))).payload)).toEqual(head);
  });

  it('stream ids are unsigned 32-bit: 0 and 0xffffffff round-trip', () => {
    expect(decodeFrame(encodeFrame(F.END, 0)).stream).toBe(0);
    const f = encodeFrame(F.END, 0xffffffff);
    expect(Array.from(f.subarray(1, 5))).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(decodeFrame(f).stream).toBe(0xffffffff);
  });

  it('rejects stream ids outside 0..0xffffffff instead of silently wrapping', () => {
    for (const bad of [-1, 0x1_0000_0000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => encodeFrame(F.WS_MSG, bad, 'x')).toThrow();
    }
  });

  it('rejects a type that does not fit in one byte', () => {
    expect(() => encodeFrame(256 as F, 1)).toThrow();
    expect(() => encodeFrame(-1 as F, 1)).toThrow();
  });

  it('copies the payload into the frame (later edits to the source do not leak in)', () => {
    const p = new Uint8Array([1, 2, 3]);
    const f = encodeFrame(F.BODY, 1, p);
    p[0] = 99;
    expect(Array.from(decodeFrame(f).payload)).toEqual([1, 2, 3]);
  });

  it('decodes a frame sitting at an offset inside a larger buffer', () => {
    const f = encodeFrame(F.HTTP_RES, 0xdeadbeef, '{"status":200}');
    const big = new Uint8Array(f.length + 20);
    big.set(f, 11);
    const d = decodeFrame(big.subarray(11, 11 + f.length));
    expect(d.type).toBe(F.HTTP_RES);
    expect(d.stream).toBe(0xdeadbeef);
    expect(json(d.payload)).toEqual({ status: 200 });
  });

  it('the decoded payload is a view on the input, not a copy', () => {
    const f = encodeFrame(F.BODY, 1, new Uint8Array([1, 2, 3]));
    const d = decodeFrame(f);
    expect(d.payload.buffer).toBe(f.buffer);
    f[5] = 42;
    expect(d.payload[0]).toBe(42);
  });

  it('throws on input shorter than the 5-byte header', () => {
    expect(() => decodeFrame(new Uint8Array(4))).toThrow();
    expect(() => decodeFrame(new Uint8Array(0))).toThrow();
    expect(decodeFrame(new Uint8Array(5)).payload.length).toBe(0);
  });
});

describe('chunks', () => {
  it('splits 40 000 bytes into 16384 / 16384 / 7232, in order, losing nothing', () => {
    const data = bytes(40_000, 1);
    const cs = chunks(data);
    expect(cs.map((c) => c.length)).toEqual([16384, 16384, 7232]);
    const joined = new Uint8Array(40_000);
    let at = 0;
    for (const c of cs) {
      joined.set(c, at);
      at += c.length;
    }
    expect(Array.from(joined)).toEqual(Array.from(data));
  });

  it('an exact multiple has no empty tail; empty data gives no chunks', () => {
    expect(chunks(bytes(32_768)).map((c) => c.length)).toEqual([16384, 16384]);
    expect(chunks(bytes(16_384)).map((c) => c.length)).toEqual([16384]);
    expect(chunks(bytes(1)).map((c) => c.length)).toEqual([1]);
    expect(chunks(new Uint8Array(0))).toEqual([]);
  });

  it('honours a custom size and rejects one that would never advance', () => {
    expect(chunks(bytes(10), 4).map((c) => c.length)).toEqual([4, 4, 2]);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => chunks(bytes(10), bad)).toThrow();
  });

  it('every chunk plus its header fits a 16 389-byte frame', () => {
    for (const c of chunks(bytes(50_000))) expect(encodeFrame(F.BODY, 1, c).length).toBeLessThanOrEqual(16_389);
  });
});
