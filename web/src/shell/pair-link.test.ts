import { describe, expect, it } from 'vitest';
import { b64u } from '@anywhere';
import { parsePairLink, readPairAnswer } from './pair-link';

const enc = new TextEncoder();
const P = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
/** The QR address's fragment, as the PC writes it (AnywhereService.pairUrl). */
const link = (o: unknown) => `#p=${b64u(enc.encode(JSON.stringify(o)))}`;

describe('parsePairLink', () => {
  it('reads the pairing secret, the code and the PC name', () => {
    const r = parsePairLink(link({ v: 1, ps: b64u(P), code: '123456', pc: 'my-pc' }));
    expect(r).not.toBeNull();
    expect([...r!.ps]).toEqual([...P]);
    expect(r!.code).toBe('123456');
    expect(r!.pc).toBe('my-pc');
  });

  it('a fragment without the leading # reads the same', () => {
    expect(parsePairLink(link({ v: 1, ps: b64u(P), code: '000001', pc: 'x' }).slice(1))?.code).toBe('000001');
  });

  it('bad base64 is null, and so is base64 that is not the JSON', () => {
    expect(parsePairLink('#p=***not-base64***')).toBeNull();
    expect(parsePairLink('#p=a')).toBeNull();
    expect(parsePairLink(`#p=${b64u(enc.encode('not json'))}`)).toBeNull();
    expect(parsePairLink(`#p=${b64u(new Uint8Array([0xff, 0xfe, 0xfd]))}`)).toBeNull();
  });

  it('another version (v: 2) is null', () => {
    expect(parsePairLink(link({ v: 2, ps: b64u(P), code: '123456', pc: 'my-pc' }))).toBeNull();
  });

  it('a code that is not 6 digits is null', () => {
    expect(parsePairLink(link({ v: 1, ps: b64u(P), code: '12a456', pc: 'my-pc' }))).toBeNull();
    expect(parsePairLink(link({ v: 1, ps: b64u(P), code: '12345', pc: 'my-pc' }))).toBeNull();
    expect(parsePairLink(link({ v: 1, ps: b64u(P), code: 123456, pc: 'my-pc' }))).toBeNull();
  });

  it('a pairing secret that is not 16 bytes, or no fragment at all, is null', () => {
    expect(parsePairLink(link({ v: 1, ps: b64u(P.subarray(0, 8)), code: '123456', pc: 'my-pc' }))).toBeNull();
    expect(parsePairLink('')).toBeNull();
    expect(parsePairLink('#x=1')).toBeNull();
  });

  it('a missing PC name is empty, a long one is cut', () => {
    expect(parsePairLink(link({ v: 1, ps: b64u(P), code: '123456' }))?.pc).toBe('');
    expect(parsePairLink(link({ v: 1, ps: b64u(P), code: '123456', pc: 'x'.repeat(1000) }))?.pc.length).toBe(256);
  });
});

describe('readPairAnswer', () => {
  const body = (o: unknown) => enc.encode(JSON.stringify(o));

  it('the token and the device id the PC gave', () => {
    expect(readPairAnswer({ status: 200, headers: {}, body: body({ token: 't0k', device: { id: 'abc123', name: 'iPhone' } }) })).toEqual({ token: 't0k', id: 'abc123' });
  });

  it("the PC's own words when it refused (they are Chinese already)", () => {
    expect(readPairAnswer({ status: 400, headers: {}, body: body({ error: '配对码已过期，请在电脑上重新生成' }) })).toEqual({ error: '配对码已过期，请在电脑上重新生成' });
  });

  it('an answer that cannot be read says what came back', () => {
    const r = readPairAnswer({ status: 500, headers: {}, body: enc.encode('boom') });
    expect('error' in r && r.error).toContain('500');
    const r2 = readPairAnswer({ status: 200, headers: {}, body: body({ token: '', device: {} }) });
    expect('error' in r2).toBe(true);
  });
});
