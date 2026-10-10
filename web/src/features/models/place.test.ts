import { describe, expect, it } from 'vitest';
import { MENU_ORIGIN, menuOrigin, placeMenu, samePlacement, withOrigin } from './place';

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

describe('menuOrigin: the menu scales in from its anchor (UI refresh §4.5)', () => {
  const view = { vw: 1400, vh: 900 };
  it('a menu above its chip grows from its bottom edge, one below from its top edge', () => {
    expect(menuOrigin(rect(800, 830), { bottom: 106, left: 600 }, 1400)).toMatch(/ 100%$/);
    expect(menuOrigin(rect(100, 130), { top: 136, left: 600 }, 1400)).toMatch(/ 0%$/);
  });
  it('left-anchored: the chip\'s centre, in px from the menu\'s left edge', () => {
    // chip 600–700 (centre 650), menu's left edge at 600
    expect(menuOrigin(rect(100, 130), { top: 136, left: 600 }, 1400)).toBe('50px 0%');
    // the menu was pushed in from the window's edge: the chip's centre is left of it — never a negative offset
    expect(menuOrigin(rect(100, 130, 0, 10), { top: 136, left: 8 }, 1400)).toBe('0px 0%');
  });
  it('right-anchored: the chip\'s centre, in px from the menu\'s right edge (its width is not known here)', () => {
    // chip 600–700, menu's right edge at 1400 − 700 = the chip's right edge: the centre is 50px in from it
    expect(menuOrigin(rect(800, 830), { bottom: 106, right: 700 }, 1400)).toBe('calc(100% - 50px) 100%');
    expect(menuOrigin(rect(800, 830, 1390, 1398), { bottom: 106, right: 8 }, 1400)).toBe('calc(100% - 0px) 100%');
  });
  it('placeMenu carries it as the --menu-origin variable, next to the coordinates', () => {
    const up = placeMenu(rect(800, 830), view, 'up', 'right');
    expect(up[MENU_ORIGIN]).toBe('calc(100% - 50px) 100%');
    const down = placeMenu(rect(100, 130), view, 'up', 'left');
    expect(down[MENU_ORIGIN]).toBe('50px 0%');
  });
  it('withOrigin recomputes it after a placement was moved to the other edge', () => {
    const p = placeMenu(rect(800, 830, 20, 60), view, 'up', 'right'); // right-anchored, would stick out on the left
    const moved = withOrigin({ ...p, right: undefined, left: 8 }, rect(800, 830, 20, 60), 1400);
    expect(moved[MENU_ORIGIN]).toBe('32px 100%'); // centre 40 − left 8
    expect(moved.left).toBe(8);
  });
  it('the origin is not part of "the same placement": only coordinates re-render', () => {
    const a = placeMenu(rect(800, 830), view, 'up', 'right');
    expect(samePlacement(a, { ...a, [MENU_ORIGIN]: '0px 0%' })).toBe(true);
  });
});
