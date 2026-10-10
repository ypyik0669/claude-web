import { describe, expect, it } from 'vitest';
import { MAX_EDGE, NEED_SCREENSHOT, fitWithin, toImage, toScreen, zoomRect, type Frame } from './coords.js';

/** a 2560x1440 screen, seen as 1568x882 */
const qhd: Frame = { width: 1568, height: 882, rect: { x: 0, y: 0, width: 2560, height: 1440 } };
/** a screen small enough to be seen as it is */
const small: Frame = { width: 1366, height: 768, rect: { x: 0, y: 0, width: 1366, height: 768 } };

describe('the size of a screenshot', () => {
  it('scales the long edge down to 1568, never up', () => {
    expect(MAX_EDGE).toBe(1568);
    expect(fitWithin(2560, 1440)).toEqual({ width: 1568, height: 882 });
    expect(fitWithin(1920, 1080)).toEqual({ width: 1568, height: 882 });
    expect(fitWithin(3840, 2160)).toEqual({ width: 1568, height: 882 });
    expect(fitWithin(1366, 768)).toEqual({ width: 1366, height: 768 });
    expect(fitWithin(1080, 1920)).toEqual({ width: 882, height: 1568 }); // a portrait monitor
    expect(fitWithin(300, 200)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(5000, 1)).toEqual({ width: 1568, height: 1 });
  });
});

describe('a position in the screenshot → the screen', () => {
  it('before any screenshot: take one first', () => {
    expect(toScreen(null, [10, 10])).toEqual({ ok: false, error: NEED_SCREENSHOT });
    expect(NEED_SCREENSHOT.toLowerCase()).toContain('take a screenshot first');
    expect(zoomRect(null, [0, 0, 10, 10])).toEqual({ ok: false, error: NEED_SCREENSHOT });
  });

  it('a malformed coordinate is said to be one, screenshot or not', () => {
    for (const c of [undefined, null, 5, '10,10', [1], [1, 2, 3], ['1', '2'], [NaN, 1], [1, Infinity], {}]) {
      for (const f of [null, qhd]) {
        const r = toScreen(f, c);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('[x, y]');
      }
    }
    const r = toScreen(qhd, 'x', 'start_coordinate');
    if (!r.ok) expect(r.error).toContain('"start_coordinate"');
  });

  it('1:1 when the screenshot was not scaled', () => {
    expect(toScreen(small, [0, 0])).toEqual({ ok: true, x: 0, y: 0 });
    expect(toScreen(small, [683, 384])).toEqual({ ok: true, x: 683, y: 384 });
    expect(toScreen(small, [1365, 767])).toEqual({ ok: true, x: 1365, y: 767 });
  });

  it('scaled: the centre of an image pixel lands in the middle of the screen pixels it stands for', () => {
    const s = 2560 / 1568; // 1.6327
    expect(toScreen(qhd, [0, 0])).toEqual({ ok: true, x: 0, y: 0 });
    expect(toScreen(qhd, [784, 441])).toEqual({ ok: true, x: Math.round(784.5 * s - 0.5), y: Math.round(441.5 * (1440 / 882) - 0.5) });
    expect(toScreen(qhd, [784, 441])).toEqual({ ok: true, x: 1280, y: 720 }); // the middle of the image is the middle of the screen
    expect(toScreen(qhd, [1567, 881])).toEqual({ ok: true, x: 2559, y: 1439 }); // the last image pixel covers the last screen pixels
    // every image pixel maps inside the patch it covers
    for (const x of [1, 100, 333, 1000, 1500]) {
      const r = toScreen(qhd, [x, 0]);
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.x).toBeGreaterThanOrEqual(Math.floor(x * s)); expect(r.x).toBeLessThan(Math.ceil((x + 1) * s)); }
    }
  });

  it('fractions are fine; the far edge is the last pixel; further out is refused', () => {
    expect(toScreen(qhd, [100.4, 200.6]).ok).toBe(true);
    expect(toScreen(qhd, [1568, 882])).toEqual({ ok: true, x: 2559, y: 1439 });
    for (const c of [[-1, 10], [10, -0.5], [1569, 10], [10, 883], [2560, 1440]]) {
      const r = toScreen(qhd, c);
      expect(r.ok, String(c)).toBe(false);
      if (!r.ok) { expect(r.error).toContain('outside the screenshot'); expect(r.error).toContain('1568x882'); }
    }
  });

  it('a screenshot of a rectangle that does not start at the origin', () => {
    const f: Frame = { width: 100, height: 50, rect: { x: 1000, y: 500, width: 200, height: 100 } };
    expect(toScreen(f, [0, 0])).toEqual({ ok: true, x: 1001, y: 501 }); // image pixel 0 covers screen pixels 1000–1001: its centre rounds to 1001
    expect(toScreen(f, [99, 49])).toEqual({ ok: true, x: 1199, y: 599 });
    expect(toScreen(f, [50, 25])).toEqual({ ok: true, x: 1101, y: 551 });
  });
});

describe('the screen → a position in the screenshot', () => {
  it('is the way back', () => {
    for (const p of [[0, 0], [100, 200], [784, 441], [1567, 881]] as const) {
      const s = toScreen(qhd, [...p]);
      if (!s.ok) throw new Error('unexpected');
      expect(toImage(qhd, s.x, s.y)).toEqual({ x: p[0], y: p[1], inside: true });
    }
    expect(toImage(small, 10, 20)).toEqual({ x: 10, y: 20, inside: true });
  });

  it('says when the pointer is off the captured display', () => {
    expect(toImage(qhd, -300, 100).inside).toBe(false);
    expect(toImage(qhd, 2560, 100).inside).toBe(false);
    expect(toImage(qhd, 100, 1440).inside).toBe(false);
    expect(toImage(qhd, 2559, 1439).inside).toBe(true);
  });
});

describe('a zoom region', () => {
  it('covers every screen pixel the rectangle touches', () => {
    expect(zoomRect(small, [10, 20, 110, 70])).toEqual({ ok: true, rect: { x: 10, y: 20, width: 100, height: 50 } });
    const r = zoomRect(qhd, [100, 100, 200, 150]);
    expect(r).toEqual({ ok: true, rect: { x: 163, y: 163, width: 327 - 163, height: 245 - 163 } });
    expect(zoomRect(qhd, [0, 0, 1568, 882])).toEqual({ ok: true, rect: { x: 0, y: 0, width: 2560, height: 1440 } });
  });

  it('refuses what is not a rectangle inside the screenshot', () => {
    for (const bad of [undefined, [1, 2, 3], [1, 2, 3, '4'], 'all', [0, 0, NaN, 5]]) {
      const r = zoomRect(qhd, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('[x0, y0, x1, y1]');
    }
    for (const bad of [[100, 100, 100, 200], [100, 100, 50, 200], [100, 200, 300, 200], [10, 10, 5, 5]]) {
      const r = zoomRect(qhd, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('x1 > x0');
    }
    for (const bad of [[-1, 0, 10, 10], [0, 0, 1569, 10], [0, 0, 10, 883]]) {
      const r = zoomRect(qhd, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('outside the screenshot');
    }
  });
});
