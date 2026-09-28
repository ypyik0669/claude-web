import { describe, expect, it } from 'vitest';
import { placeMenu } from './place';

const rect = (top: number, bottom: number, left = 600, right = 700) => ({ top, bottom, left, right });

describe('placeMenu', () => {
  it('prefers up when there is room, height capped at 560', () => {
    const p = placeMenu(rect(800, 830), { vw: 1400, vh: 900 }, 'up', 'right');
    expect(p.bottom).toBe(900 - 800 + 6);
    expect(p.maxHeight).toBe(560);
    expect(p.right).toBe(700);
  });
  it('opens down when up is cramped and down has more room', () => {
    const p = placeMenu(rect(100, 130), { vw: 1400, vh: 900 }, 'up', 'right');
    expect(p.top).toBe(136);
    expect(p.bottom).toBeUndefined();
  });
  it('neither side has 120px: at least 120, never taller than the viewport', () => {
    const p = placeMenu(rect(90, 120), { vw: 400, vh: 220 }, 'up', 'right');
    expect(p.maxHeight).toBeGreaterThanOrEqual(120);
    expect(p.maxHeight).toBeLessThanOrEqual(220 - 16);
  });
  it('the available space itself when it is between 120 and 560', () => {
    const p = placeMenu(rect(300, 330), { vw: 1400, vh: 500 }, 'up', 'right');
    expect(p.maxHeight).toBe(300 - 6 - 8);
  });
  it('keeps a gutter at the edges', () => {
    expect(placeMenu(rect(800, 830, 900, 1398), { vw: 1400, vh: 900 }, 'up', 'right').right).toBe(8);
    expect(placeMenu(rect(800, 830, 2, 60), { vw: 1400, vh: 900 }, 'up', 'left').left).toBe(8);
  });
});
