import { describe, expect, it } from 'vitest';
import { MIN_PAGE, SHORT_PAGE, ZOOM_STEPS, cleanZoom, fitWindow, minWindow, nextZoom, scaleCaption, trafficLightY, zoomAsk, zoomLimit } from './zoom';

describe('界面缩放', () => {
  it('the steps go up, include 100%, and are what a browser offers', () => {
    expect([...ZOOM_STEPS]).toEqual([...ZOOM_STEPS].sort((a, b) => a - b));
    expect(ZOOM_STEPS).toContain(1);
    expect(ZOOM_STEPS[0]).toBe(0.5);
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(3);
  });

  it('a screen takes the largest factor at which the smallest window still fits its work area', () => {
    expect(zoomLimit({ width: 3840, height: 2112 })).toBe(3); // 4K at 100%: 2700 × 1440 fits
    expect(zoomLimit({ width: 2560, height: 1392 })).toBe(2.5); // 1440p: 3 would need 2700 of width
    expect(zoomLimit({ width: 1920, height: 1032 })).toBe(2); // 1080p: 2.5 would need 2250
    expect(zoomLimit({ width: 1536, height: 816 })).toBe(1.5); // 1080p at 125% system scaling: 1.75 would need 1575
    expect(zoomLimit({ width: 1366, height: 728 })).toBe(1.5); // a small laptop: 1350 × 720 just fits
    expect(zoomLimit({ width: 1280, height: 672 })).toBe(1.25); // 1.5 would need 1350 of width (and 720 of height)
    expect(zoomLimit({ width: 800, height: 500 })).toBe(1); // never under 100%, however small the screen
    for (const area of [{ width: 3840, height: 2112 }, { width: 1920, height: 1032 }, { width: 1536, height: 816 }]) {
      const m = minWindow(zoomLimit(area));
      expect(m.width).toBeLessThanOrEqual(area.width);
      expect(m.height).toBeLessThanOrEqual(area.height);
    }
  });

  it('a stored value becomes the nearest step within the limit; anything unreadable is 100%', () => {
    expect(cleanZoom(1.25)).toBe(1.25);
    expect(cleanZoom(1.2500000000000002)).toBe(1.25); // what Chromium reports back for 125%
    expect(cleanZoom(1.3)).toBe(1.25);
    expect(cleanZoom(1.4)).toBe(1.5);
    expect(cleanZoom(9)).toBe(3);
    expect(cleanZoom(0.1)).toBe(0.5);
    expect(cleanZoom(2, 1.5)).toBe(1.5); // remembered on a big monitor, started on a small one
    expect(cleanZoom(undefined)).toBe(1);
    expect(cleanZoom('1.5')).toBe(1);
    expect(cleanZoom(NaN)).toBe(1);
    expect(cleanZoom(-1)).toBe(1);
  });

  it('one step in or out, stopping at the ends; reset is 100%; a number is set as given', () => {
    expect(nextZoom(1, 'in', 3)).toBe(1.1);
    expect(nextZoom(1.1, 'in', 3)).toBe(1.25);
    expect(nextZoom(1, 'out', 3)).toBe(0.9);
    expect(nextZoom(0.5, 'out', 3)).toBe(0.5);
    expect(nextZoom(3, 'in', 3)).toBe(3);
    expect(nextZoom(1.5, 'in', 1.5)).toBe(1.5); // the screen's limit
    expect(nextZoom(1.25, 'in', 1.5)).toBe(1.5);
    expect(nextZoom(2, 'in', 1.5)).toBe(1.5); // above a limit that came down: in brings it to the limit
    expect(nextZoom(2, 'out', 1.5)).toBe(1.5);
    expect(nextZoom(1.75, 'reset', 3)).toBe(1);
    expect(nextZoom(1, 1.5, 3)).toBe(1.5);
    expect(nextZoom(1, 2.5, 1.5)).toBe(1.5);
    // every step is reachable from 100% and comes back to it
    let z = 1;
    for (let i = 0; i < 20; i++) z = nextZoom(z, 'in', 3);
    expect(z).toBe(3);
    for (let i = 0; i < 40; i++) z = nextZoom(z, 'out', 3);
    expect(z).toBe(0.5);
  });

  it('only in / out / reset and positive numbers are requests', () => {
    expect(zoomAsk('in')).toBe('in');
    expect(zoomAsk('out')).toBe('out');
    expect(zoomAsk('reset')).toBe('reset');
    expect(zoomAsk(1.5)).toBe(1.5);
    for (const bad of ['bigger', '', null, undefined, {}, [], 0, -2, NaN, Infinity]) expect(zoomAsk(bad), String(bad)).toBeNull();
  });

  it('the smallest window grows with the factor, and never shrinks below the 100% one', () => {
    expect(minWindow(1)).toEqual({ width: MIN_PAGE.width, height: MIN_PAGE.height });
    expect(minWindow(1.1)).toEqual({ width: 990, height: 600 }); // 480 × 1.1 is under the 100% minimum: that stays
    expect(minWindow(1.25)).toEqual({ width: 1125, height: 600 });
    expect(minWindow(1.5)).toEqual({ width: 1350, height: 720 });
    expect(minWindow(3)).toEqual({ width: 2700, height: 1440 });
    expect(minWindow(0.5)).toEqual({ width: 900, height: 600 });
    // the page may get shorter zoomed in, never under SHORT_PAGE of its own pixels
    for (const z of ZOOM_STEPS) expect(minWindow(z).height / Math.max(1, z)).toBeGreaterThanOrEqual(SHORT_PAGE - 1);
    // …so the page never gets narrower than the desktop layout needs (760 of its own pixels is the phone layout)
    for (const z of ZOOM_STEPS) expect(minWindow(z).width / z).toBeGreaterThanOrEqual(MIN_PAGE.width - 1);
  });

  it('a window under its new minimum grows to it and stays on its screen', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1032 };
    expect(fitWindow({ x: 100, y: 80, width: 1400, height: 900 }, minWindow(1.5), area)).toBeNull(); // big enough already
    expect(fitWindow({ x: 100, y: 80, width: 1000, height: 650 }, minWindow(1.5), area)).toEqual({ x: 100, y: 80, width: 1350, height: 720 });
    // growing would push it off the right / bottom edge: moved back
    expect(fitWindow({ x: 900, y: 400, width: 1000, height: 650 }, minWindow(1.5), area)).toEqual({ x: 570, y: 312, width: 1350, height: 720 });
    // a second screen to the left (negative origin)
    expect(fitWindow({ x: -500, y: 600, width: 900, height: 600 }, minWindow(2), { x: -1920, y: 0, width: 1920, height: 1040 })).toEqual({ x: -1800, y: 80, width: 1800, height: 960 });
    // only one side too small: the other is kept
    expect(fitWindow({ x: 0, y: 0, width: 1800, height: 650 }, minWindow(1.5), area)).toEqual({ x: 0, y: 0, width: 1800, height: 720 });
  });

  it('macOS: the traffic lights stay centred in the top row', () => {
    expect(trafficLightY(1)).toBe(27); // what the window is created with at 100%
    for (const z of ZOOM_STEPS) expect(trafficLightY(z) + 7).toBe(Math.round(34 * z)); // the buttons' centre = the row's
  });

  it('the caption area scales with the factor until the page reports its own', () => {
    expect(scaleCaption(60, 1, 1.5)).toBe(90);
    expect(scaleCaption(90, 1.5, 1)).toBe(60);
    expect(scaleCaption(48, 1, 2)).toBe(96);
    expect(scaleCaption(60, 0, 2)).toBe(60);
  });
});
