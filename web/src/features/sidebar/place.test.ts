import { describe, expect, it } from 'vitest';
import { placeFixed } from './place';

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
