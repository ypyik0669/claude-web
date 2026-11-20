import { describe, expect, it } from 'vitest';
import { DEFAULT_BROKERS, DEFAULT_STUN, b64u, pairLink } from '@anywhere';
import {
  BAD_LISTS,
  HANDOFF_COOKIE,
  LINK_FRESH_MS,
  handoffClear,
  handoffCookie,
  handoffLink,
  linkState,
  pairPlan,
  parsePairLink,
  readPairAnswer,
  rememberLink,
  scannedQr,
  startLink,
  type PairLink,
} from './pair-link';

const enc = new TextEncoder();
const P = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const SHELL = 'https://claude-web-shell.github.io/';
/** The QR address's fragment, as the PC writes it (AnywhereService.pairUrl). */
const link = (o: unknown) => `#p=${b64u(enc.encode(JSON.stringify(o)))}`;
const GOOD = link({ v: 1, ps: b64u(P), code: '123456', pc: 'my-pc' });
/** A link that read as one (not null, not BAD_LISTS), else null. */
const parsed = (s: string): PairLink | null => {
  const p = parsePairLink(s);
  return p && p !== BAD_LISTS ? p : null;
};

describe('parsePairLink', () => {
  it('reads the pairing secret, the code and the PC name', () => {
    const r = parsed(GOOD);
    expect(r).not.toBeNull();
    expect([...r!.ps]).toEqual([...P]);
    expect(r!.code).toBe('123456');
    expect(r!.pc).toBe('my-pc');
    // a PC on the default lists names none
    expect('brokers' in r! || 'stun' in r!).toBe(false);
  });

  it('a pasted link reads the same: the whole address, the part after #, or just p=…', () => {
    expect(parsed(`${SHELL}${GOOD}`)?.code).toBe('123456');
    expect(parsed(`  ${SHELL}?x=1${GOOD}  `)?.code).toBe('123456');
    expect(parsed(GOOD.slice(1))?.code).toBe('123456');
    expect(parsePairLink(SHELL)).toBeNull();
  });

  it("the PC's own lists (F2): read with core's rules, as the PC wrote them", () => {
    const brokers = [{ name: 'cn', url: 'wss://mqtt.example.cn:8084/mqtt', username: 'u', password: 'p', relay: true }];
    const r = parsed(pairLink(SHELL, { ps: b64u(P), code: '123456', pc: 'my-pc', brokers, stun: ['stun:stun.example.cn:3478'] }));
    expect(r?.brokers).toEqual(brokers);
    expect(r?.stun).toEqual(['stun:stun.example.cn:3478']);
    // unusable entries next to usable ones are dropped, as on the PC
    const mixed = parsed(link({ v: 1, ps: b64u(P), code: '123456', pc: 'x', b: [{ name: 'bad', url: 'http://x' }, ...brokers], st: ['turn:t', 'stun:s:3478'] }));
    expect(mixed?.brokers).toEqual(brokers);
    expect(mixed?.stun).toEqual(['stun:s:3478']);
    // an empty STUN list is a list: no STUN server (the PC was set so)
    expect(parsed(pairLink(SHELL, { ps: b64u(P), code: '123456', pc: 'x', brokers: DEFAULT_BROKERS, stun: [] }))?.stun).toEqual([]);
    // the defaults written by the PC are not named, so a link stays as it was
    expect(parsed(pairLink(SHELL, { ps: b64u(P), code: '123456', pc: 'x', brokers: DEFAULT_BROKERS, stun: DEFAULT_STUN }))?.brokers).toBeUndefined();
  });

  it('a list present but with nothing usable in it refuses the link (never the defaults instead)', () => {
    const base = { v: 1, ps: b64u(P), code: '123456', pc: 'x' };
    for (const b of [[], 'wss://a', [{ name: 'a', url: 'http://a' }], {}, null, 3]) expect(parsePairLink(link({ ...base, b }))).toBe(BAD_LISTS);
    for (const st of ['stun:a', [5, 'turn:t'], {}, null]) expect(parsePairLink(link({ ...base, st }))).toBe(BAD_LISTS);
    // fields this page does not know are ignored (spec §11)
    expect(parsed(link({ ...base, zz: [1, 2] }))?.code).toBe('123456');
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
    expect(parsed(link({ v: 1, ps: b64u(P), code: '123456' }))?.pc).toBe('');
    expect(parsed(link({ v: 1, ps: b64u(P), code: '123456', pc: 'x'.repeat(1000) }))?.pc.length).toBe(256);
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

describe('扫码配对: what the shell\'s scanner read', () => {
  it('the 在哪都能用 QR (the whole address, as the PC draws it) pairs', () => {
    const r = scannedQr(`${SHELL}${GOOD}`);
    expect(r.kind).toBe('pair');
    expect(r.kind === 'pair' && r.link.code).toBe('123456');
  });
  it('the 只在局域网 QR is told apart: only the PC\'s own /pair page takes it', () => {
    expect(scannedQr('http://192.168.0.113:8091/pair#123456')).toEqual({ kind: 'lan' });
    expect(scannedQr(' http://[fe80::1]:3091/pair#654321 ')).toEqual({ kind: 'lan' });
  });
  it('a pairing QR whose server list does not read says so; anything else is not ours', () => {
    expect(scannedQr(link({ v: 1, ps: b64u(P), code: '123456', pc: 'x', b: [{ name: 'x', url: 'http://not-wss' }] }))).toEqual({ kind: 'bad-lists' });
    expect(scannedQr('https://example.com/some/page')).toEqual({ kind: 'other' });
    expect(scannedQr('WIFI:S:home;T:WPA;P:secret;;')).toEqual({ kind: 'other' });
    expect(scannedQr('http://192.168.0.113:8091/pair#12345')).toEqual({ kind: 'other' });
  });
});

describe('the handoff cookie (iOS copies cookies into a home-screen app, and not the #p= in the address)', () => {
  /** What `document.cookie` reads back after the assignment: the name=value part. */
  const jar = (assignment: string | null) => (assignment ?? '').split(';')[0];

  it('keeps the p= of the link, for as long as a pairing code lives, sent nowhere else than this host over https', () => {
    const c = handoffCookie(`${SHELL}${GOOD}`, '/');
    expect(c).toBe(`${HANDOFF_COOKIE}=${GOOD.slice(3)}; Max-Age=600; Path=/; Secure; SameSite=Strict`);
    // a fragment alone, or a shell below a folder
    expect(handoffCookie(GOOD, '/cw/')).toContain('; Path=/cw/;');
  });

  it('the home-screen app reads back the very link the QR gave', () => {
    const back = handoffLink(`theme=dark; ${jar(handoffCookie(GOOD, '/'))}; x=1`);
    expect(back).toBe(GOOD);
    expect(parsed(back!)?.code).toBe('123456');
  });

  it('no link, one with characters a cookie cannot carry as they are, or one too long for a cookie: none', () => {
    expect(handoffCookie(`${SHELL}`, '/')).toBeNull();
    expect(handoffCookie('#p=a;b', '/')).toBeNull();
    expect(handoffCookie(`#p=${'A'.repeat(3801)}`, '/')).toBeNull();
    expect(handoffCookie(`#p=${'A'.repeat(3800)}`, '/')).not.toBeNull();
  });

  it('other cookies, or none, hand nothing over; a name that only ends like it is not it', () => {
    expect(handoffLink('')).toBeNull();
    expect(handoffLink('theme=dark')).toBeNull();
    expect(handoffLink(`x${HANDOFF_COOKIE}=abc`)).toBeNull();
  });

  it('removing it: the same name and path, gone now', () => {
    expect(handoffClear('/')).toBe(`${HANDOFF_COOKIE}=; Max-Age=0; Path=/; Secure; SameSite=Strict`);
  });

  it('the address comes first; the cookie only counts in a home-screen app (Safari still has the link in its address)', () => {
    const cookies = jar(handoffCookie(GOOD, '/'));
    expect(startLink({ hash: GOOD, cookies, standalone: true })).toEqual({ link: GOOD, from: 'address' });
    expect(startLink({ hash: '', cookies, standalone: true })).toEqual({ link: GOOD, from: 'cookie' });
    expect(startLink({ hash: '', cookies, standalone: false })).toBeNull();
    expect(startLink({ hash: '#other', cookies: '', standalone: true })).toBeNull();
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
