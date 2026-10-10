import { describe, expect, it } from 'vitest';
import { VELOCITY_WINDOW_MS, noteSample, releaseVelocity, type DragSample } from './drag-velocity';

describe('releaseVelocity', () => {
  it('px per ms over the last 100ms of the drag', () => {
    expect(VELOCITY_WINDOW_MS).toBe(100);
    const s: DragSample[] = [{ t: 0, p: 0 }, { t: 400, p: 10 }, { t: 450, p: 40 }, { t: 500, p: 70 }];
    // the slow first stretch is too old to count
    expect(releaseVelocity(s, 500)).toBeCloseTo(0.6);
  });
  it('signed: negative when the finger was going back', () => {
    expect(releaseVelocity([{ t: 0, p: 100 }, { t: 50, p: 60 }], 50)).toBeCloseTo(-0.8);
  });
  it('a finger that rested before lifting is not a flick', () => {
    expect(releaseVelocity([{ t: 0, p: 0 }, { t: 40, p: 200 }], 300)).toBe(0);
    expect(releaseVelocity([{ t: 0, p: 0 }, { t: 40, p: 200 }, { t: 300, p: 200 }], 300)).toBe(0);
  });
  it('nothing to go by: 0', () => {
    expect(releaseVelocity([], 10)).toBe(0);
    expect(releaseVelocity([{ t: 5, p: 5 }], 10)).toBe(0);
    expect(releaseVelocity([{ t: 5, p: 5 }, { t: 5, p: 50 }], 5)).toBe(0);
  });
});

describe('noteSample', () => {
  it('keeps the last few only', () => {
    const s: DragSample[] = [];
    for (let i = 0; i < 40; i++) noteSample(s, i, i * 2);
    expect(s.length).toBeLessThanOrEqual(12);
    expect(s[s.length - 1]).toEqual({ t: 39, p: 78 });
  });
});
