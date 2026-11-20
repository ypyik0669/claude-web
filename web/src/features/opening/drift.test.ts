import { describe, expect, it } from 'vitest';
import { RAIN_CELL, RAIN_CHARS, makeRain, makeStars, rainChar, starAlpha, starCount, stepRain, stepStars } from './drift';

const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };

describe('星图 left behind: the stars', () => {
  it('sparse: between 24 and 140 for any window', () => {
    expect(starCount(100, 100)).toBe(24);
    expect(starCount(1400, 900)).toBe(90);
    expect(starCount(4000, 3000)).toBe(140);
    expect(makeStars(1400, 900, seq(0.5))).toHaveLength(90);
  });
  it('they drift and come back in on the other side', () => {
    const [s] = makeStars(100, 100, seq(0.5));
    const x0 = s.x;
    stepStars([s], 1, 100, 100);
    expect(s.x).toBeGreaterThan(x0);
    s.x = 104.5;
    stepStars([s], 0, 100, 100);
    expect(s.x).toBeCloseTo(-3.5);
    s.y = -5;
    stepStars([s], 0, 100, 100);
    expect(s.y).toBe(103);
  });
  it('a twinkle that never goes out or past full', () => {
    const [s] = makeStars(100, 100, seq(0.3));
    for (let t = 0; t < 20; t += 0.37) {
      const a = starAlpha(s, t);
      expect(a).toBeGreaterThanOrEqual(0.22);
      expect(a).toBeLessThanOrEqual(0.8);
    }
  });
});

describe('字符雨 left behind: the slow rain', () => {
  it('a drop in every fourth column', () => {
    const cols = Math.ceil(1400 / RAIN_CELL.w);
    expect(makeRain(1400, 900, seq(0.5))).toHaveLength(Math.ceil(cols / 4));
    expect(makeRain(1400, 900, seq(0.5)).map((d) => d.c).slice(0, 3)).toEqual([0, 4, 8]);
  });
  it('drops fall and start again above the top once gone below', () => {
    const rows = 40;
    const list = makeRain(100, rows * RAIN_CELL.h, seq(0.5));
    const d = list[0];
    const y0 = d.y;
    stepRain(list, 1, rows, seq(0.5));
    expect(d.y).toBeGreaterThan(y0);
    d.y = rows + d.len + 1;
    stepRain(list, 0, rows, seq(0.5));
    expect(d.y).toBe(-4);
  });
  it('the characters come from the code set and change over time, for any cell', () => {
    for (const [c, r] of [[0, 0], [3, 9], [-2, -7], [999, 12345]]) expect(RAIN_CHARS).toContain(rainChar(c, r, 1.2));
    const at = (t: number) => Array.from({ length: 12 }, (_, i) => rainChar(i, 5, t)).join('');
    expect(at(0)).not.toBe(at(0.4));
    expect(at(0)).toBe(at(0.3));
  });
});
