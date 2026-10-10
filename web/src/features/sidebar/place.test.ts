import { describe, expect, it } from 'vitest';
import { placeFixed, spotOrigin } from './place';

const view = { vw: 1440, vh: 900 };
const anchor = (left: number, top: number, w = 200, h = 30) => ({ left, top, right: left + w, bottom: top + h });

describe('placeFixed: a sidebar menu next to its anchor, never clipped by the scrolling list', () => {
  it('below the anchor, right edges aligned (6px in), by default', () => {
    expect(placeFixed(anchor(20, 100), { w: 180, h: 200 }, view)).toEqual({ left: 20 + 200 - 180 - 6, top: 132 });
  });
  it('left-aligned when asked', () => {
    expect(placeFixed(anchor(20, 100), { w: 180, h: 200 }, view, { align: 'left' })).toEqual({ left: 20, top: 132 });
  });
  it('flips above when there is no room below', () => {
    expect(placeFixed(anchor(20, 800), { w: 180, h: 200 }, view)).toEqual({ left: 34, top: 800 - 200 - 2 });
  });
  it('opens upwards first when preferred (the account row at the bottom)', () => {
    expect(placeFixed(anchor(10, 840, 240, 60), { w: 260, h: 300 }, view, { prefer: 'up', align: 'left' })).toEqual({ left: 10, top: 840 - 300 - 2 });
  });
  it('taller than either side: pinned to the top with a max height', () => {
    expect(placeFixed(anchor(20, 400), { w: 180, h: 2000 }, view)).toEqual({ left: 34, top: 8, maxHeight: 884 });
  });
  it('stays inside the window horizontally', () => {
    expect(placeFixed(anchor(1300, 100, 130), { w: 300, h: 100 }, view, { align: 'left' }).left).toBe(1440 - 300 - 8);
    expect(placeFixed(anchor(0, 100, 50), { w: 300, h: 100 }, view).left).toBe(8);
  });
});

describe('spotOrigin: where a sidebar menu scales in from (UI refresh §4.5)', () => {
  const size = { w: 180, h: 200 };
  it('a button narrower than the menu: its centre, on the edge that faces it', () => {
    const a = anchor(300, 100, 28, 28); // the header's ···
    const below = placeFixed(a, size, view);
    expect(below.top).toBe(130);
    // menu left = 328 − 180 − 6 = 142; the button's centre is 314 → 172px in
    expect(spotOrigin(a, below, size)).toBe('172px 0%');
    const low = anchor(300, 860, 28, 28);
    expect(spotOrigin(low, placeFixed(low, size, view), size)).toBe('172px 100%');
  });
  it('a row wider than the menu: near the edge the menu is aligned to (where its ··· is), not the row\'s centre', () => {
    const row = anchor(8, 100, 248, 32);
    const right = placeFixed(row, size, view); // left = 256 − 180 − 6 = 70
    expect(spotOrigin(row, right, size)).toBe('166px 0%'); // 256 − 20 − 70
    const left = placeFixed(row, size, view, { align: 'left' }); // left = 8
    expect(spotOrigin(row, left, size, { align: 'left' })).toBe('16px 0%');
  });
  it('never outside the menu\'s box', () => {
    const a = anchor(0, 100, 50); // menu pushed in to left 8, 300 wide
    const spot = placeFixed(a, { w: 300, h: 100 }, view);
    expect(spotOrigin(a, spot, { w: 300, h: 100 })).toBe('17px 0%');
    const far = anchor(1400, 100, 30);
    expect(spotOrigin(far, placeFixed(far, { w: 300, h: 100 }, view, { align: 'left' }), { w: 300, h: 100 }, { align: 'left' })).toBe('283px 0%');
  });
  it('pinned to the top with a max height: from the anchor\'s height inside the menu', () => {
    const a = anchor(20, 400);
    const spot = placeFixed(a, { w: 180, h: 2000 }, view); // top 8, maxHeight 884
    expect(spotOrigin(a, spot, { w: 180, h: 2000 })).toBe('166px 407px'); // anchor centre y 415 − 8
  });
});
