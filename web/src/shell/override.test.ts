import { describe, expect, it } from 'vitest';
import { brokerOverride, overrideNote, stunOverride } from './override';

const j = (v: unknown) => JSON.stringify(v);

describe('brokerOverride', () => {
  it('the key absent: null (the defaults)', () => {
    expect(brokerOverride(null)).toBeNull();
  });

  it('present but unusable (not JSON, not a list, nothing usable): an empty list, never the defaults', () => {
    for (const raw of ['', 'not json', j({ name: 'a', url: 'ws://a' }), j('wss://a'), j([]), j([{ name: 'a', url: 'https://a/mqtt' }, 7, null])]) {
      expect(brokerOverride(raw)).toEqual([]);
    }
  });

  it('keeps the usable entries with their fields (core\'s rule), at most 16', () => {
    expect(brokerOverride(j([{ name: 'local', url: 'ws://127.0.0.1:1234/mqtt', relay: true }, { name: 'e', url: 'javascript:alert(1)' }]))).toEqual([
      { name: 'local', url: 'ws://127.0.0.1:1234/mqtt', relay: true },
    ]);
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `b${i}`, url: `wss://b${i}.example/mqtt` }));
    expect(brokerOverride(j(many))).toHaveLength(16);
  });
});

describe('stunOverride', () => {
  it('the key absent: null; present but unusable: an empty list (no STUN server)', () => {
    expect(stunOverride(null)).toBeNull();
    for (const raw of ['', 'stun:a:3478', j('stun:a:3478'), j([])]) expect(stunOverride(raw)).toEqual([]);
  });

  it('stun: and stuns: entries only', () => {
    expect(stunOverride(j(['stun:127.0.0.1:3478', 'turn:t.example:3478', 'STUNS:x.example:5349']))).toEqual(['stun:127.0.0.1:3478', 'STUNS:x.example:5349']);
  });
});

describe('overrideNote', () => {
  it('names the keys in use and their sizes; nothing when no override is in use', () => {
    expect(overrideNote(null, null)).toBeNull();
    expect(overrideNote([{ name: 'a', url: 'ws://a' }], [])).toBe('[shell] 使用 localStorage 里的自定义列表：cw.shell.brokers（1 个）、cw.shell.stun（0 个）');
    expect(overrideNote(null, ['stun:a:1'])).toBe('[shell] 使用 localStorage 里的自定义列表：cw.shell.stun（1 个）');
  });
});
