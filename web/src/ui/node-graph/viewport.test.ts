import { describe, expect, it } from 'vitest';
import { wheelZoom } from '@/ui/wheel-zoom';
import { chatFit, entranceTimes, fitHeight, fitView, fullFit, motionOn, NG_ZOOM, PAN_KEYS, panToShow, pct, zoomAt, zoomBy } from './viewport';

describe('全屏查看: fitted to the window (issue #17)', () => {
  it("the issue's picture: a wide graph the reply holds at its 60 % floor fills the window instead", () => {
    const graph = { w: 2000, h: 900 };
    expect(fitHeight(graph, 760, chatFit(true)).scale).toBe(0.6);
    const v = fitView(graph, { w: 1888, h: 960 }, fullFit(true));
    // the width decides here: 24px each side; the title row (64) and the zoom buttons (56) kept free
    expect(v.scale).toBeCloseTo((1888 - 48) / 2000);
    expect(v.x).toBeCloseTo(24);
    expect(v.y).toBeCloseTo(64 + (960 - 64 - 56 - 900 * v.scale) / 2);
  });
  it('a small graph stops at 125 %; one too big even at the smallest zoom starts at the top left', () => {
    expect(fitView({ w: 300, h: 150 }, { w: 1600, h: 900 }, fullFit(false)).scale).toBe(1.25);
    expect(fitView({ w: 20000, h: 9000 }, { w: 1600, h: 900 }, fullFit(true))).toEqual({ scale: NG_ZOOM.min, x: 24, y: 64 });
  });
  it('the title row is kept only when there is a title / badge; the corner of the zoom buttons always', () => {
    expect(fullFit(true).top).toBe(64);
    expect(fullFit(false).top).toBe(24);
    expect(fullFit(false).bottom).toBeGreaterThanOrEqual(10 + 44); // 10px from the edge, 40px buttons + padding on a phone
  });
  it('a phone (390 × 700 below the bar): the stage is the window, the graph fits its width', () => {
    const v = fitView({ w: 1200, h: 500 }, { w: 390, h: 700 }, fullFit(true));
    expect(v.scale).toBeCloseTo((390 - 48) / 1200);
    expect(v.x).toBeCloseTo(24);
  });
});

describe('viewport', () => {
  it('the arrow keys pan toward what is on that side (shared by the node graph and the picture canvas)', () => {
    expect(PAN_KEYS.get('ArrowLeft')).toEqual([1, 0]);
    expect(PAN_KEYS.get('ArrowDown')).toEqual([0, -1]);
    expect(PAN_KEYS.get('a')).toBeUndefined();
  });
  it('fit: centred, never above max', () => {
    expect(fitView({ w: 400, h: 200 }, { w: 800, h: 400 })).toEqual({ scale: 1.25, x: 150, y: 75 });
  });
  it('fit: a huge graph stops at the minimum zoom', () => {
    expect(fitView({ w: 4000, h: 100 }, { w: 400, h: 300 })).toEqual({ scale: 0.25, x: -300, y: 137.5 });
  });
  it('fit: no size yet (a hidden panel) leaves 100%', () => {
    expect(fitView({ w: 400, h: 200 }, { w: 0, h: 0 })).toEqual({ scale: 1, x: 0, y: 0 });
  });
  it('zooming keeps the point under the pointer', () => {
    expect(zoomAt({ scale: 1, x: 10, y: 20 }, 2, { x: 110, y: 220 })).toEqual({ scale: 2, x: -90, y: -180 });
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 10, { x: 0, y: 0 }).scale).toBe(NG_ZOOM.max);
  });
  it('the − / + buttons zoom about the middle', () => {
    expect(zoomBy({ scale: 1, x: 0, y: 0 }, 1, { w: 200, h: 100 }).scale).toBeCloseTo(1.2);
    expect(zoomBy({ scale: 1, x: 0, y: 0 }, -1, { w: 200, h: 100 }).scale).toBeCloseTo(1 / 1.2);
  });
  it('the percentage', () => {
    expect(pct(1.16)).toBe('116%');
    expect(pct(0.999)).toBe('100%');
  });
  it('the wheel rule is the shared one (stage A3)', () => {
    expect(wheelZoom(1, { deltaY: -100, shiftKey: false }, NG_ZOOM)).toBeCloseTo(1.2);
    expect(wheelZoom(NG_ZOOM.max, { deltaY: -100, shiftKey: false }, NG_ZOOM)).toBeNull();
    expect(wheelZoom(1, { deltaY: -100, shiftKey: true }, NG_ZOOM)).toBeNull();
  });
  it('no animation when reduced or above 150 cards / 300 edges', () => {
    expect(motionOn(150, 0, false)).toBe(true);
    expect(motionOn(151, 0, false)).toBe(false);
    expect(motionOn(3, 0, true)).toBe(false);
    expect(motionOn(3, 300, false)).toBe(true);
    expect(motionOn(3, 301, false)).toBe(false);
  });
  it('fit: room for the title and the zoom buttons; a graph too wide for the minimum starts at the top left (review D4)', () => {
    expect(fitView({ w: 400, h: 200 }, { w: 432, h: 300 }, { max: 1, top: 56, bottom: 44 })).toEqual({ scale: 1, x: 16, y: 56 });
    expect(fitView({ w: 2000, h: 200 }, { w: 632, h: 300 }, { min: 0.6, max: 1, top: 56, bottom: 44, start: true })).toEqual({ scale: 0.6, x: 16, y: 56 + (200 - 120) / 2 });
  });
  it('chat sizing: the width sets the scale, the height follows it — no empty band (review D4)', () => {
    const o = chatFit(true);
    expect(fitHeight({ w: 1180, h: 400 }, 640, o)).toEqual({ scale: 0.6, height: 340 });
    expect(fitHeight({ w: 600, h: 400 }, 832, o)).toEqual({ scale: 1, height: 500 });
    expect(fitHeight({ w: 600, h: 900 }, 832, o).height).toBe(560);
    expect(fitHeight({ w: 300, h: 60 }, 832, chatFit(false)).height).toBe(200);
    // the fitted view at that height is that scale (the title row and the zoom buttons keep their room)
    const { scale, height } = fitHeight({ w: 800, h: 400 }, 700, o);
    expect(fitView({ w: 800, h: 400 }, { w: 700, h: height }, { ...o, start: true }).scale).toBeCloseTo(scale);
  });
  it('a focused card is panned into view (review D6)', () => {
    const v = { scale: 1, x: 0, y: 0 };
    expect(panToShow(v, { x: 20, y: 20, w: 100, h: 50 }, { w: 400, h: 300 })).toBe(v);
    expect(panToShow(v, { x: 500, y: 20, w: 100, h: 50 }, { w: 400, h: 300 })).toEqual({ scale: 1, x: -216, y: 0 });
    expect(panToShow({ scale: 0.5, x: 0, y: 0 }, { x: -100, y: 700, w: 100, h: 50 }, { w: 400, h: 300 }, { bottom: 44 })).toEqual({ scale: 0.5, x: 66, y: -119 });
  });
  it('cards one after another, then the edges', () => {
    const t = entranceTimes(3, 2);
    expect([t.card(0), t.card(2), t.edge(0), t.edge(1), t.total]).toEqual([0, 180, 372, 412, 832]);
    expect(entranceTimes(2, 0).total).toBe(410);
  });
});
