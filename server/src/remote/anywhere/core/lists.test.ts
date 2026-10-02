import { describe, expect, it } from 'vitest';
import { MAX_LIST_ENTRIES, brokerEntries, isBrokerUrl, isStunUrl, stunEntries } from './lists.js';
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
