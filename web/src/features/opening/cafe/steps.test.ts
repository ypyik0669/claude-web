import { describe, expect, it } from 'vitest';
import { cafeSteps } from './steps';

describe('网吧开门 · the steps', () => {
  it('dark first, then the rows light up one by one (A, B, C), within the opening\'s cafe part', () => {
    const s = cafeSteps(true);
    expect(s.map((x) => x.zones.map((z) => z.letter).join(''))).toEqual(['', 'A', 'A', 'AB', 'ABC']);
    for (let i = 1; i < s.length; i++) expect(s[i].at).toBeGreaterThan(s[i - 1].at);
    // the logo lights up at CAFE.lit (2.3 s): the last row is on well before
    expect(s[s.length - 1].at).toBeLessThan(2);
  });
  it('the first row comes with people (the cafe "has people" from then on), so a customer added later walks in from the door', () => {
    const [, first, walk] = cafeSteps(true);
    expect(first.zones[0].bots.length).toBeGreaterThan(1);
    const before = new Set(first.zones[0].bots.map((b) => b.id));
    const added = walk.zones[0].bots.filter((b) => !before.has(b.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: 'customer', status: 'working' });
  });
  it('every row has its 网管 at the counter and its own colour; ids and looks stay the same from step to step (nobody pops)', () => {
    const s = cafeSteps(true);
    const last = s[s.length - 1];
    expect(last.zones.map((z) => z.bots.filter((b) => b.kind === 'lead').length)).toEqual([1, 1, 1]);
    expect(new Set(last.zones.map((z) => z.accent)).size).toBe(3);
    const seen = new Map<string, string>();
    for (const st of s) for (const z of st.zones) for (const b of z.bots) {
      expect(seen.get(b.id) ?? b.look).toBe(b.look);
      seen.set(b.id, b.look);
      expect(b.seat === -1 || (b.seat >= 0 && b.seat < 6)).toBe(true);
    }
  });
  it('简短: the same steps at half the time', () => {
    const full = cafeSteps(true), short = cafeSteps(false);
    expect(short.map((x) => x.zones.length)).toEqual(full.map((x) => x.zones.length));
    short.forEach((x, i) => expect(x.at).toBeCloseTo(full[i].at / 2, 9));
  });
});
