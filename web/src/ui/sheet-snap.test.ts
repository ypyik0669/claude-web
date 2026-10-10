import { describe, expect, it } from 'vitest';
import { SHEET_DOWN_PX, SHEET_FLICK, SHEET_FRACTION, SHEET_OVERSHOOT_PX, SHEET_UP_PX, sheetDim, sheetSizes, sheetSnap, sheetTravel } from './sheet-snap';

// a phone 800px tall: 半 is 496px of it, 全 736px — 240px between the two
const sizes = sheetSizes(800);
const at = (detent: 'half' | 'full', dy: number, vy = 0) => sheetSnap({ detent, dy, vy, ...sizes });

describe('sheetSizes', () => {
  it('two detents: 62% and 92% of the room above the keyboard', () => {
    expect(SHEET_FRACTION).toEqual({ half: 0.62, full: 0.92 });
    expect(sizes).toEqual({ half: 496, full: 736 });
  });
  it('never taller than the room minus the status bar', () => {
    // keyboard up: 400px of room, a 47px notch — 92% (368) would reach under it
    expect(sheetSizes(400, 47)).toEqual({ half: 248, full: 353 });
    // …and the lower detent is never the taller one
    expect(sheetSizes(100, 60)).toEqual({ half: 40, full: 40 });
  });
  it('what was measured on screen wins for the detent it is at', () => {
    expect(sheetSizes(800, 0, { detent: 'half', height: 500 })).toEqual({ half: 500, full: 736 });
    expect(sheetSizes(800, 0, { detent: 'full', height: 730 })).toEqual({ half: 496, full: 730 });
  });
});

describe('sheetSnap — a slow release', () => {
  it('back where it was within the thresholds', () => {
    for (const dy of [0, 1, SHEET_DOWN_PX, -SHEET_UP_PX, -1]) expect(at('half', dy)).toBe('half');
    for (const dy of [0, SHEET_DOWN_PX, -30, -400]) expect(at('full', dy)).toBe('full');
  });
  it('pulled down more than 70px: one detent down (全 → 半 → closed)', () => {
    expect(SHEET_DOWN_PX).toBe(70);
    expect(at('full', 71)).toBe('half');
    expect(at('half', 71)).toBe('closed');
  });
  it('pulled up more than 50px from 半: 全', () => {
    expect(SHEET_UP_PX).toBe(50);
    expect(at('half', -50)).toBe('half');
    expect(at('half', -51)).toBe('full');
    expect(at('half', -900)).toBe('full');
  });
  it('from 全, let go more than 70px below where 半 sits: closed (it does not jump back up to 半)', () => {
    expect(at('full', 240 + 70)).toBe('half');
    expect(at('full', 240 + 71)).toBe('closed');
  });
});

describe('sheetSnap — a flick', () => {
  const fast = SHEET_FLICK, slow = SHEET_FLICK - 0.01;
  it('the threshold is 0.5 px/ms', () => {
    expect(SHEET_FLICK).toBe(0.5);
    expect(at('half', 20, slow)).toBe('half');
    expect(at('half', 20, fast)).toBe('closed');
  });
  it('down: one detent at a time, however short the drag', () => {
    expect(at('full', 12, fast)).toBe('half');
    expect(at('full', 12, 3)).toBe('half');
    expect(at('half', 12, 3)).toBe('closed');
  });
  it('down, from 全 and already below where 半 sits: closed', () => {
    expect(at('full', 241, fast)).toBe('closed');
  });
  it('down, after having pulled 半 up: back to 半, not closed', () => {
    expect(at('half', -80, fast)).toBe('half');
  });
  it('up from 半: 全', () => {
    expect(at('half', -10, -fast)).toBe('full');
    expect(at('half', -10, -slow)).toBe('half');
  });
  it('up, after having pulled it down: back where it was', () => {
    expect(at('half', 120, -fast)).toBe('half');
    expect(at('full', 120, -fast)).toBe('full');
    // from 全, below where 半 sits: the next stop on the way up is 半
    expect(at('full', 300, -fast)).toBe('half');
  });
});

describe('sheetTravel', () => {
  it('follows the finger down without a limit', () => {
    expect(sheetTravel('half', 0, sizes)).toBe(0);
    expect(sheetTravel('half', 300, sizes)).toBe(300);
    expect(sheetTravel('full', 900, sizes)).toBe(900);
  });
  it('半 rises as far as 全 sits, then resists', () => {
    expect(sheetTravel('half', -100, sizes)).toBe(-100);
    expect(sheetTravel('half', -240, sizes)).toBe(-240);
    const past = sheetTravel('half', -280, sizes);
    expect(past).toBeLessThan(-240);
    expect(past).toBeGreaterThan(-280);
    expect(sheetTravel('half', -5000, sizes)).toBe(-240 - SHEET_OVERSHOOT_PX);
  });
  it('全 does not rise: a pull up only gives a little', () => {
    const up = sheetTravel('full', -40, sizes);
    expect(up).toBeLessThan(0);
    expect(up).toBeGreaterThan(-40);
    expect(sheetTravel('full', -5000, sizes)).toBe(-SHEET_OVERSHOOT_PX);
  });
});

describe('sheetDim — the backdrop follows the sheet', () => {
  it('full strength while at least 半 of it shows', () => {
    expect(sheetDim('half', 0, sizes)).toBe(1);
    expect(sheetDim('half', -120, sizes)).toBe(1);
    expect(sheetDim('full', 0, sizes)).toBe(1);
    expect(sheetDim('full', 240, sizes)).toBe(1);
  });
  it('fades as the sheet leaves, gone when it is out', () => {
    expect(sheetDim('half', 248, sizes)).toBeCloseTo(0.5);
    expect(sheetDim('half', 496, sizes)).toBe(0);
    expect(sheetDim('half', 9999, sizes)).toBe(0);
    expect(sheetDim('full', 240 + 248, sizes)).toBeCloseTo(0.5);
  });
});
