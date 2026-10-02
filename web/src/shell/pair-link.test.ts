import { describe, expect, it } from 'vitest';
import { b64u } from '@anywhere';
import { LINK_FRESH_MS, linkState, pairPlan, parsePairLink, readPairAnswer, rememberLink } from './pair-link';

const enc = new TextEncoder();
const P = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
/** The QR address's fragment, as the PC writes it (AnywhereService.pairUrl). */
const link = (o: unknown) => `#p=${b64u(enc.encode(JSON.stringify(o)))}`;
const GOOD = link({ v: 1, ps: b64u(P), code: '123456', pc: 'my-pc' });

describe('parsePairLink', () => {
  it('reads the pairing secret, the code and the PC name', () => {
    const r = parsePairLink(GOOD);
    expect(r).not.toBeNull();
    expect([...r!.ps]).toEqual([...P]);
    expect(r!.code).toBe('123456');
    expect(r!.pc).toBe('my-pc');
  });

  it('a pasted link reads the same: the whole address, the part after #, or just p=…', () => {
    expect(parsePairLink(`https://ypyik0669.github.io/claude-web/${GOOD}`)?.code).toBe('123456');
    expect(parsePairLink(`  https://ypyik0669.github.io/claude-web/?x=1${GOOD}  `)?.code).toBe('123456');
    expect(parsePairLink(GOOD.slice(1))?.code).toBe('123456');
    expect(parsePairLink('https://ypyik0669.github.io/claude-web/')).toBeNull();
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

  it('the token and the device id the PC gave (12 lowercase hex, as RemoteService makes them)', () => {
    expect(readPairAnswer({ status: 200, headers: {}, body: body({ token: 't0k', device: { id: 'a1b2c3d4e5f6', name: 'iPhone' } }) })).toEqual({ token: 't0k', id: 'a1b2c3d4e5f6' });
  });

  it('an id of another shape is not taken (it names the app caches)', () => {
    expect('error' in readPairAnswer({ status: 200, headers: {}, body: body({ token: 't', device: { id: 'abc-123' } }) })).toBe(true);
    expect('error' in readPairAnswer({ status: 200, headers: {}, body: body({ token: 't', device: { id: 'A1B2C3D4E5F6' } }) })).toBe(true);
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

describe('pairPlan (ruling R12b: iOS keeps Safari and the home screen apart)', () => {
  it('no pairing link: the list', () => {
    expect(pairPlan({ ios: true, standalone: false, hasPairLink: false })).toBe('list');
    expect(pairPlan({ ios: false, standalone: false, hasPairLink: false })).toBe('list');
  });
  it('iOS Safari (not from the home screen): ask first, the link stays in the address', () => {
    expect(pairPlan({ ios: true, standalone: false, hasPairLink: true })).toBe('ask');
  });
  it('from the home screen, or any other browser: pair at once', () => {
    expect(pairPlan({ ios: true, standalone: true, hasPairLink: true })).toBe('pair');
    expect(pairPlan({ ios: false, standalone: false, hasPairLink: true })).toBe('pair');
  });
});

describe('links already tried (a home-screen app opens its saved address, #p= and all, every time)', () => {
  const now = 1_000_000;
  it('a new link is fresh; one paired with, or refused by the PC, is used', () => {
    let m = rememberLink({}, 'k1', now, false);
    expect(linkState(m, 'k1', now + 1000)).toBe('fresh');
    expect(linkState(m, 'k2', now)).toBe('fresh');
    m = rememberLink(m, 'k1', now + 2000, true);
    expect(linkState(m, 'k1', now + 3000)).toBe('used');
  });
  it('past the code’s 10 minutes since it was first seen, a link that never paired is expired', () => {
    const m = rememberLink({}, 'k1', now, false);
    expect(linkState(m, 'k1', now + LINK_FRESH_MS + 1)).toBe('expired');
  });
  it('keeps the first time a link was seen, and only the newest 20', () => {
    let m = rememberLink({}, 'k1', now, false);
    m = rememberLink(m, 'k1', now + 5000, false);
    expect(m.k1.first).toBe(now);
    for (let i = 0; i < 30; i++) m = rememberLink(m, `x${i}`, now + i, false);
    expect(Object.keys(m).length).toBe(20);
    expect(m.x29).toBeTruthy();
    expect(m.k1).toBeUndefined();
  });
  it('a memory that is not one reads as empty', () => {
    expect(linkState(null as never, 'k', now)).toBe('fresh');
  });
});
