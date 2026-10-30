import { describe, expect, it } from 'vitest';
import { dutyAfter, dutyShown, eachUntilError, parseBudget } from './bots-settings';

describe('parseBudget', () => {
  it('a positive number is stored; empty and 0 mean no global budget', () => {
    expect(parseBudget(' 12.5 ')).toEqual({ ok: true, value: 12.5 });
    expect(parseBudget('')).toEqual({ ok: true, value: undefined });
    expect(parseBudget('0')).toEqual({ ok: true, value: undefined });
  });
  it('negative or not a number is an error, not silently cleared', () => {
    expect(parseBudget('-1')).toEqual({ ok: false });
    expect(parseBudget('abc')).toEqual({ ok: false });
    expect(parseBudget('5元')).toEqual({ ok: false });
  });
});

describe('duty switch state', () => {
  it('a failed change keeps the state it had', () => {
    expect(dutyAfter(true, false, { ok: false, detail: 'x' }, 1)).toEqual({ on: true, ok: false, detail: 'x', at: 1 });
    expect(dutyAfter(false, true, { ok: false, detail: 'portable' }, 1).on).toBe(false);
    expect(dutyAfter(false, true, { ok: true, detail: '' }, 1).on).toBe(true);
    expect(dutyAfter(true, false, { ok: true, detail: '' }, 1).on).toBe(false);
  });
  it('the system answer wins over the stored state', () => {
    const last = dutyAfter(true, false, { ok: false, detail: '' }, 1);
    expect(dutyShown(last, null)).toBe(true);
    expect(dutyShown(last, false)).toBe(false);
    expect(dutyShown(undefined, null)).toBe(false);
    expect(dutyShown(undefined, true)).toBe(true);
  });
});

describe('eachUntilError', () => {
  it('runs in order and stops at the first failure', async () => {
    const seen: string[] = [];
    const r = await eachUntilError(['a', 'b', 'c'], async (x) => { seen.push(x); if (x === 'b') throw new Error('no'); });
    expect(seen).toEqual(['a', 'b']);
    expect(r.done).toBe(1);
    expect(r.failed?.target).toBe('b');
    expect((r.failed?.error as Error).message).toBe('no');
  });
  it('all done', async () => {
    expect(await eachUntilError([1, 2], async () => {})).toEqual({ done: 2 });
  });
});
