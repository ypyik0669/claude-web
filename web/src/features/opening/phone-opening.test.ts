import { afterEach, describe, expect, it, vi } from 'vitest';
import { PHONE_OPENING_K, PHONE_OPENING_MS, PORTRAIT_MARKS, firstStartToday, framePath, playsFull } from './phone-opening';

describe('the phone opening', () => {
  it('the fuse runs once round the gold logo\'s rounded square, lit at its top middle, clockwise', () => {
    const d = framePath({ x: 0, y: 0, w: 100, h: 80, r: 10 });
    expect(d.startsWith('M50 0 H90 A10 10 0 0 1 100 10 V70')).toBe(true);
    expect(d.endsWith('A10 10 0 0 1 10 0 Z')).toBe(true);
    // the logo in the portrait sits inside the picture (720 × 1080), the orb to its left
    const f = PORTRAIT_MARKS.frame;
    expect(f.x > 0 && f.y >= 0 && f.x + f.w < 720 && f.y + f.h < 1080).toBe(true);
    expect(PORTRAIT_MARKS.orb.cx).toBeLessThan(f.x);
  });

  it('简短 is the same steps faster; reduced motion holds only a moment; all end before the old splash\'s worst case', () => {
    expect(PHONE_OPENING_K.short).toBeLessThan(PHONE_OPENING_K.full);
    expect(PHONE_OPENING_MS.short).toBeLessThan(PHONE_OPENING_MS.full);
    expect(PHONE_OPENING_MS.reduced).toBeLessThan(PHONE_OPENING_MS.short);
    // the motion has to be over by then: the wordmark's credit comes in at 2.05 s + 0.5 s (× k)
    expect(PHONE_OPENING_MS.full / 1000).toBeGreaterThanOrEqual(2.55 * PHONE_OPENING_K.full);
    expect(PHONE_OPENING_MS.short / 1000).toBeGreaterThanOrEqual(2.55 * PHONE_OPENING_K.short);
  });

  it('每天第一次: the day\'s first start plays the chosen length, the later ones 简短; 每次打开: the chosen one every time', () => {
    expect(playsFull('always', true, false)).toBe(true);
    expect(playsFull('always', false, true)).toBe(false);
    expect(playsFull('daily', true, true)).toBe(true);
    expect(playsFull('daily', true, false)).toBe(false);
    expect(playsFull('daily', false, true)).toBe(false);
  });

  describe('the day\'s first start, per phone', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('is first once a day, and every time when there is no storage', () => {
      const mem = new Map<string, string>();
      vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) });
      expect(firstStartToday('k', 'Fri Nov 20 2026')).toBe(true);
      expect(firstStartToday('k', 'Fri Nov 20 2026')).toBe(false);
      expect(firstStartToday('k', 'Sat Nov 21 2026')).toBe(true);
      vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem() {} });
      expect(firstStartToday('k', 'Sat Nov 21 2026')).toBe(true);
    });
  });
});
