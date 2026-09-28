import { describe, expect, it } from 'vitest';
import { Memo } from './memo.js';

describe('Memo', () => {
  it('shares an in-flight call, reuses the result for the TTL, then asks again', async () => {
    let t = 0;
    const m = new Memo<number>(1000, () => t);
    let runs = 0;
    const fn = () => new Promise<number>((r) => setTimeout(() => r(++runs), 5));
    const [a, b] = await Promise.all([m.get('k', fn), m.get('k', fn)]);
    expect([a, b, runs]).toEqual([1, 1, 1]);
    t = 999;
    expect(await m.get('k', fn)).toBe(1);
    t = 1001;
    expect(await m.get('k', fn)).toBe(2);
    expect(await m.get('k', fn, true)).toBe(3); // force
    expect(await m.get('other', fn)).toBe(4); // per key
  });

  it('does not keep failures', async () => {
    const m = new Memo<string>(60_000);
    let n = 0;
    await expect(m.get('k', async () => { n++; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await m.get('k', async () => { n++; return 'ok'; })).toBe('ok');
    expect(n).toBe(2);
  });
});

describe('Memo keep predicate', () => {
  it('shares a failed-looking result with callers already waiting, but does not keep it', async () => {
    const m = new Memo<{ ok: boolean; n: number }>(60_000, Date.now, { keep: (v) => v.ok });
    let n = 0;
    const bad = () => new Promise<{ ok: boolean; n: number }>((r) => setTimeout(() => r({ ok: false, n: ++n }), 5));
    const [a, b] = await Promise.all([m.get('k', bad), m.get('k', bad)]);
    expect([a.n, b.n]).toEqual([1, 1]); // one run for concurrent callers
    expect((await m.get('k', bad)).n).toBe(2); // …but not remembered
    const good = async () => ({ ok: true, n: ++n });
    expect((await m.get('k', good)).n).toBe(3);
    expect((await m.get('k', good)).n).toBe(3); // kept
  });
});
