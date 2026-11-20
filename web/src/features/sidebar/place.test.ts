import { describe, expect, it } from 'vitest';
import { FLY_OVERLAP, flyOrigin, placeFixed, placeFly, spotOrigin } from './place';

const view = { vw: 1440, vh: 900 };
const anchor = (left: number, top: number, w = 200, h = 30) => ({ left, top, right: left + w, bottom: top + h });

describe('placeFixed: a sidebar menu next to its anchor, never clipped by the scrolling list', () => {
  it('below the anchor, right edges aligned (6px in), by default', () => {
    expect(placeFixed(anchor(20, 100), { w: 180, h: 200 }, view)).toEqual({ left: 20 + 200 - 180 - 6, top: 132 });
  });
  it('a menu wider than what is left of its anchor stops at the sidebar\'s edge, off the icon rail beside it', () => {
    // the 项目 funnel (anchor right at 335), a 315-wide menu: right-aligned it would start at 14, over the rail
    expect(placeFixed({ left: 315, top: 150, right: 335, bottom: 170 }, { w: 315, h: 320 }, view, { minLeft: 64 }).left).toBe(64);
    expect(placeFixed({ left: 315, top: 150, right: 335, bottom: 170 }, { w: 315, h: 320 }, view).left).toBe(14);
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
  it('a menu taller than the room on either side is pinned to the top with a max height', () => {
    const spot = placeFixed({ left: 100, top: 300, right: 300, bottom: 328 }, { w: 200, h: 500 }, { vw: 1200, vh: 600 });
    expect(spot.top).toBe(8);
    expect(spot.maxHeight).toBe(584);
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

describe('placeFly: a submenu flies out beside its menu (redesign 2026-11 stage 3)', () => {
  // the 显示 menu at 20..252, its 分组方式 row at y 140..174
  const box = { left: 20, top: 120, right: 252, bottom: 420 };
  const row = { left: 26, top: 140, right: 246, bottom: 174 };
  it('to the right, tucked under the menu\'s edge, its first row level with the row', () => {
    expect(placeFly(row, box, { w: 180, h: 160 }, view)).toEqual({ left: 252 - FLY_OVERLAP, top: 134, side: 'right' });
  });
  it('to the left when the right has no room and the left has', () => {
    const far = { left: 1180, top: 120, right: 1412, bottom: 420 };
    expect(placeFly({ ...row, left: 1186, right: 1406 }, far, { w: 180, h: 160 }, view)).toEqual({ left: 1180 - 180 + FLY_OVERLAP, top: 134, side: 'left' });
  });
  it('neither side has room: right, kept inside the window', () => {
    const narrow = { vw: 400, vh: 900 };
    const spot = placeFly(row, { left: 100, top: 120, right: 300, bottom: 420 }, { w: 260, h: 160 }, narrow);
    expect(spot.side).toBe('right');
    expect(spot.left).toBe(400 - 260 - 8);
  });
  it('pushed up to stay inside the window (the account menu\'s rows near the bottom)', () => {
    const low = { left: 26, top: 820, right: 246, bottom: 854 };
    expect(placeFly(low, box, { w: 180, h: 200 }, view).top).toBe(900 - 200 - 8);
  });
  it('taller than the window: pinned to the top with a max height', () => {
    expect(placeFly(row, box, { w: 180, h: 1200 }, view)).toEqual({ left: 248, top: 8, maxHeight: 884, side: 'right' });
  });
  it('never under the desktop window buttons', () => {
    const caption = { left: 300, top: 0, right: 440, bottom: 40 };
    const top = { left: 26, top: 10, right: 246, bottom: 44 };
    expect(placeFly(top, { ...box, top: 4 }, { w: 180, h: 160 }, { vw: 440, vh: 900 }, caption).top).toBe(44);
  });
  it('scales in from the edge that faces the menu, level with the row', () => {
    const spot = placeFly(row, box, { w: 180, h: 160 }, view);
    expect(flyOrigin(row, spot, { w: 180, h: 160 })).toBe('0% 23px');
    const far = { left: 1180, top: 120, right: 1412, bottom: 420 };
    const leftSpot = placeFly(row, far, { w: 180, h: 160 }, view);
    expect(flyOrigin(row, leftSpot, { w: 180, h: 160 })).toBe('100% 23px');
  });
});

describe('placeFixed: never under the desktop window buttons', () => {
  const caption = { left: 1760, top: 0, right: 1920, bottom: 40 };
  const view = { vw: 1920, vh: 1080 };
  it('a menu that would sit under the buttons moves below them; one beside them stays', () => {
    // the conversation header's ⋯ at the top right: right-aligned, pinned near the top
    const a = { left: 1880, top: 8, right: 1910, bottom: 30 };
    const spot = placeFixed(a, { w: 320, h: 1100 }, view, { caption });
    expect(spot.top).toBe(44);
    expect(spot.maxHeight).toBe(1080 - 44 - 8);
    // a sidebar menu on the left is not near the buttons
    const left = placeFixed({ left: 70, top: 8, right: 340, bottom: 30 }, { w: 300, h: 1100 }, view, { caption, align: 'left' });
    expect(left.top).toBe(8);
  });
  it('no caption box (browser, macOS): unchanged', () => {
    const a = { left: 1880, top: 8, right: 1910, bottom: 30 };
    expect(placeFixed(a, { w: 320, h: 1100 }, view, { caption: null })).toEqual(placeFixed(a, { w: 320, h: 1100 }, view));
  });
});
