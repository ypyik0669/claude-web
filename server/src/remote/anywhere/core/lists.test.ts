import { describe, expect, it } from 'vitest';
import { unb64u } from './keys.js';
import {
  DEFAULT_BROKERS, DEFAULT_STUN, MAX_LIST_ENTRIES, MAX_PAIR_LINK_BYTES, MAX_PAIR_PC_NAME, brokerEntries, isBrokerUrl, isStunUrl,
  pairLink, pairLinkBytes, pairLists, stunEntries,
} from './lists.js';
import type { BrokerDef } from './mqtt.js';
import { rtcConfig } from './p2p-link.js';

describe('broker lists', () => {
  it('not a list: null (the caller decides what that means)', () => {
    for (const v of [undefined, null, 'wss://a', { name: 'a', url: 'wss://a' }, 7]) expect(brokerEntries(v)).toBeNull();
  });

  it('keeps the usable entries with their fields, drops the rest', () => {
    expect(
      brokerEntries([
        { name: 'local', url: 'ws://127.0.0.1:1234/mqtt', relay: true },
        { name: 'auth', url: 'wss://b.example:8084/mqtt', username: 'u', password: 'p', relay: 'yes', extra: 1 },
        { name: '', url: 'wss://c' },
        { name: 'd', url: 'wss://' },
        { name: 'e', url: 'https://e/mqtt' },
        { name: 'f', url: 'wss://has space' },
        { name: 7, url: 'wss://g' },
        { name: 'h', url: 'wss://h', username: 5 },
        null,
        'wss://i',
      ]),
    ).toEqual([
      { name: 'local', url: 'ws://127.0.0.1:1234/mqtt', relay: true },
      { name: 'auth', url: 'wss://b.example:8084/mqtt', username: 'u', password: 'p' },
      { name: 'h', url: 'wss://h' },
    ]);
  });

  it('an empty list, or one with nothing usable, is an empty list', () => {
    expect(brokerEntries([])).toEqual([]);
    expect(brokerEntries([{ name: 'a', url: 'http://a' }, 3])).toEqual([]);
  });

  it(`keeps the first ${MAX_LIST_ENTRIES} usable entries`, () => {
    const bad = Array.from({ length: 30 }, (_, i) => ({ name: `x${i}`, url: 'nope' }));
    const good = Array.from({ length: 40 }, (_, i) => ({ name: `b${i}`, url: `wss://b${i}.example/mqtt` }));
    const got = brokerEntries([...bad, ...good])!;
    expect(got).toHaveLength(MAX_LIST_ENTRIES);
    expect(got[0].name).toBe('b0');
    expect(got.at(-1)!.name).toBe(`b${MAX_LIST_ENTRIES - 1}`);
  });

  it('isBrokerUrl: ws:// or wss:// with something after it, no spaces', () => {
    expect(isBrokerUrl('wss://broker.emqx.io:8084/mqtt')).toBe(true);
    expect(isBrokerUrl('WS://127.0.0.1:1/mqtt')).toBe(true);
    for (const s of ['wss://', 'https://a', 'wss://a b', '', 5, null]) expect(isBrokerUrl(s)).toBe(false);
  });
});

describe('STUN lists', () => {
  it('not a list: null', () => {
    for (const v of [undefined, 'stun:a:3478', { 0: 'stun:a' }]) expect(stunEntries(v)).toBeNull();
  });

  it('stun: and stuns: entries only; an empty list stays empty', () => {
    expect(stunEntries(['stun:127.0.0.1:3478', 'STUNS:x.example:5349', 'turn:t.example:3478', 'http://x', 5, 'stun: a', 'stun:'])).toEqual([
      'stun:127.0.0.1:3478',
      'STUNS:x.example:5349',
    ]);
    expect(stunEntries([])).toEqual([]);
  });

  it(`keeps the first ${MAX_LIST_ENTRIES} usable entries`, () => {
    expect(stunEntries(Array.from({ length: 40 }, (_, i) => `stun:s${i}.example:3478`))).toHaveLength(MAX_LIST_ENTRIES);
  });

  it('the ICE config takes what isStunUrl takes, and nothing else', () => {
    const list = ['stun:a.example:3478', 'turn:t.example:3478', 'stuns:b.example:5349', 'x'];
    expect(rtcConfig(list)).toEqual({ iceServers: [{ urls: list.filter(isStunUrl) }] });
    expect(rtcConfig(['turn:t.example'])).toEqual({ iceServers: [] });
  });
});

describe('the pairing link (F2: the phone learns the PC’s lists when it scans)', () => {
  const SHELL = 'https://claude-web-shell.github.io/';
  const read = (link: string) => JSON.parse(new TextDecoder().decode(unb64u(link.slice(link.indexOf('#p=') + 3))));
  const mine: BrokerDef[] = [{ name: 'cn', url: 'wss://mqtt.example.cn:8084/mqtt', username: 'u', password: 'p', relay: true }];

  it('names the lists only when they are not the defaults; v stays 1', () => {
    expect(pairLists(DEFAULT_BROKERS, DEFAULT_STUN)).toEqual({});
    // the same entries written again (another key order, relay: false spelled out) are still the defaults
    const again = DEFAULT_BROKERS.map((d) => ({ relay: false, ...d, name: d.name }));
    expect(pairLists(brokerEntries(again)!, [...DEFAULT_STUN])).toEqual({});
    expect(pairLists(mine, DEFAULT_STUN)).toEqual({ b: mine });
    expect(pairLists(DEFAULT_BROKERS, [])).toEqual({ st: [] });
    expect(pairLists(DEFAULT_BROKERS, ['stun:stun.example.cn:3478'])).toEqual({ st: ['stun:stun.example.cn:3478'] });
    // the defaults in another order are another list (the order is the preference)
    expect(pairLists([...DEFAULT_BROKERS].reverse(), DEFAULT_STUN).b).toHaveLength(DEFAULT_BROKERS.length);
    // nothing to dial: left out
    expect(pairLists([], DEFAULT_STUN)).toEqual({});

    const def = read(pairLink(SHELL, { ps: 'P'.repeat(22), code: '123456', pc: 'my-pc', brokers: DEFAULT_BROKERS, stun: DEFAULT_STUN }));
    expect(def).toEqual({ v: 1, ps: 'P'.repeat(22), code: '123456', pc: 'my-pc' });
    const custom = read(pairLink(SHELL, { ps: 'P'.repeat(22), code: '123456', pc: 'my-pc', brokers: mine, stun: [] }));
    expect(custom).toEqual({ v: 1, ps: 'P'.repeat(22), code: '123456', pc: 'my-pc', b: mine, st: [] });
    // what the shell reads back with the same rules is the list itself
    expect(brokerEntries(custom.b)).toEqual(mine);
  });

  it(`cuts the PC's name at ${MAX_PAIR_PC_NAME} characters; pairLinkBytes counts the worst case`, () => {
    const link = pairLink(SHELL, { ps: 'P'.repeat(22), code: '123456', pc: 'x'.repeat(300), brokers: DEFAULT_BROKERS, stun: DEFAULT_STUN });
    expect(read(link).pc).toBe('x'.repeat(MAX_PAIR_PC_NAME));
    const named = pairLink(SHELL, { ps: 'P'.repeat(22), code: '999999', pc: '电'.repeat(500), brokers: mine, stun: [] });
    expect(new TextEncoder().encode(named).length).toBeLessThanOrEqual(pairLinkBytes(SHELL, mine, []));
    // a PC on the defaults: as short as before the lists were added
    expect(pairLinkBytes(SHELL, DEFAULT_BROKERS, DEFAULT_STUN)).toBeLessThan(400);
  });

  it(`a full list of ${MAX_LIST_ENTRIES} brokers and ${MAX_LIST_ENTRIES} STUN servers of ordinary length fits the limit`, () => {
    const b = Array.from({ length: MAX_LIST_ENTRIES }, (_, i) => ({ name: `broker-${i}`, url: `wss://broker-${i}.example.com:8084/mqtt`, relay: true }));
    const s = Array.from({ length: MAX_LIST_ENTRIES }, (_, i) => `stun:stun${i}.example.com:3478`);
    expect(pairLinkBytes(SHELL, b, s)).toBeLessThanOrEqual(MAX_PAIR_LINK_BYTES);
  });
});
