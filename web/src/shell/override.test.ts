import { describe, expect, it } from 'vitest';
import { brokerOverride, stunOverride } from './override';

const j = (v: unknown) => JSON.stringify(v);

describe('brokerOverride', () => {
  it('nothing stored, or nothing that reads: null (the defaults)', () => {
    expect(brokerOverride(null)).toBeNull();
    expect(brokerOverride('')).toBeNull();
    expect(brokerOverride('not json')).toBeNull();
    expect(brokerOverride(j({ name: 'a', url: 'ws://a' }))).toBeNull();
    expect(brokerOverride(j([]))).toBeNull();
    expect(brokerOverride(j([{ name: 'a', url: 'https://a/mqtt' }, 7, null]))).toBeNull();
  });

  it('keeps the valid entries with their fields, drops the rest', () => {
    const got = brokerOverride(
      j([
        { name: 'local', url: 'ws://127.0.0.1:1234/mqtt', relay: true },
        { name: 'auth', url: 'wss://b.example:8084/mqtt', username: 'u', password: 'p', relay: 'yes', extra: 1 },
        { name: '', url: 'wss://c' },
        { name: 'd', url: 'wss://' },
        { name: 'e', url: 'javascript:alert(1)' },
        { name: 'f', url: 'wss://has space' },
      ]),
    );
    expect(got).toEqual([
      { name: 'local', url: 'ws://127.0.0.1:1234/mqtt', relay: true },
      { name: 'auth', url: 'wss://b.example:8084/mqtt', username: 'u', password: 'p' },
    ]);
  });

  it('reads at most 16 entries', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `b${i}`, url: `wss://b${i}.example/mqtt` }));
    expect(brokerOverride(j(many))).toHaveLength(16);
  });
});

describe('stunOverride', () => {
  it('not a list: null (the defaults)', () => {
    expect(stunOverride(null)).toBeNull();
    expect(stunOverride('stun:a:3478')).toBeNull();
    expect(stunOverride(j('stun:a:3478'))).toBeNull();
  });

  it('an empty list stays empty: no STUN server at all', () => {
    expect(stunOverride(j([]))).toEqual([]);
  });

  it('stun: and stuns: entries only (core uses nothing else)', () => {
    expect(stunOverride(j(['stun:127.0.0.1:3478', 'STUNS:x.example:5349', 'turn:t.example:3478', 'http://x', 5, 'stun: a']))).toEqual(['stun:127.0.0.1:3478', 'STUNS:x.example:5349']);
  });
});
