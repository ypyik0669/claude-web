import { describe, expect, it } from 'vitest';
import { placeMenu, samePlacement } from './place';

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

describe('placeMenu with the menu\'s natural height (need)', () => {
  // a composer in the middle of the page (the welcome screen): 380px above, 500px below
  const mid = rect(388, 420);
  const view = { vw: 1400, vh: 934 };
  it('stays on the preferred side when the menu fits there', () => {
    expect(placeMenu(mid, view, 'up', 'left', 300).bottom).toBeDefined();
  });
  it('flips to the roomier side when the menu does not fit on the preferred one', () => {
    const p = placeMenu(mid, view, 'up', 'left', 620);
    expect(p.top).toBe(426);
    expect(p.maxHeight).toBe(934 - 420 - 6 - 8); // all the room below
  });
  it('fits nowhere: the side with more room', () => {
    expect(placeMenu(rect(700, 730), view, 'down', 'left', 2000).bottom).toBeDefined(); // composer at the bottom: up
  });
  it('without a known height: the old rule (the preferred side when it has 260px)', () => {
    expect(placeMenu(mid, view, 'up', 'left').bottom).toBeDefined();
  });
});

describe('samePlacement', () => {
  it('equal coordinates are the same placement (no re-render); any change is not', () => {
    const a = placeMenu(rect(800, 830), { vw: 1400, vh: 900 }, 'up', 'right');
    expect(samePlacement(a, placeMenu(rect(800, 830), { vw: 1400, vh: 900 }, 'up', 'right'))).toBe(true);
    expect(samePlacement(a, placeMenu(rect(790, 820), { vw: 1400, vh: 900 }, 'up', 'right'))).toBe(false);
    expect(samePlacement(null, a)).toBe(false);
  });
});
