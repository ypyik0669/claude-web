import { describe, expect, it } from 'vitest';
import { DRAWER_CLOSE_SHARE, DRAWER_EDGE_PX, DRAWER_FLICK, DRAWER_OPEN_PX, DRAWER_TAKE_PX, closeRelease, closeTakeover, drawerDim, drawerShift, drawerWidth, openRelease, openTakeover } from './drawer-gesture';

describe('drawerWidth', () => {
  it('86% of the window, 380px at most', () => {
    expect(drawerWidth(390)).toBeCloseTo(335.4);
    expect(drawerWidth(360)).toBeCloseTo(309.6);
    expect(drawerWidth(740)).toBe(380);
  });
});

describe('openTakeover — a swipe to the right on the conversation', () => {
  const from = (dx: number, dy: number, startX = 120) => openTakeover({ startX, dx, dy });
  it('the numbers of the spec: 20px from the edge, 15px sideways', () => {
    expect(DRAWER_EDGE_PX).toBe(20);
    expect(DRAWER_TAKE_PX).toBe(15);
  });
  it('never from the left edge: that swipe is the system’s back gesture', () => {
    expect(from(60, 0, 20)).toBe('no');
    expect(from(60, 0, 4)).toBe('no');
    expect(from(60, 0, 21)).toBe('take');
  });
  it('waits until the finger has gone 15px sideways', () => {
    expect(from(0, 0)).toBe('wait');
    expect(from(14, 2)).toBe('wait');
    expect(from(15, 2)).toBe('take');
    expect(from(80, 30)).toBe('take');
  });
  it('a scroll is not a swipe: once the movement is mostly vertical it is left alone', () => {
    expect(from(4, 12)).toBe('no');
    expect(from(20, 40)).toBe('no');
    // a few pixels either way decide nothing yet
    expect(from(3, 6)).toBe('wait');
  });
  it('a swipe to the left opens nothing', () => {
    expect(from(-15, 0)).toBe('no');
    expect(from(-6, 0)).toBe('wait');
  });
});

describe('openRelease', () => {
  it('past 50px: open', () => {
    expect(DRAWER_OPEN_PX).toBe(50);
    expect(openRelease({ dx: 50, vx: 0 })).toBe('closed');
    expect(openRelease({ dx: 51, vx: 0 })).toBe('open');
  });
  it('a quick swipe opens it however short', () => {
    expect(openRelease({ dx: 22, vx: DRAWER_FLICK })).toBe('open');
    expect(openRelease({ dx: 22, vx: DRAWER_FLICK - 0.01 })).toBe('closed');
  });
  it('flicked back to the left: it stays shut, however far it had come', () => {
    expect(openRelease({ dx: 200, vx: -DRAWER_FLICK })).toBe('closed');
  });
});

describe('closeTakeover — a swipe to the left on the drawer or its backdrop', () => {
  it('takes over after 15px to the left', () => {
    expect(closeTakeover({ dx: -14, dy: 0 })).toBe('wait');
    expect(closeTakeover({ dx: -15, dy: 3 })).toBe('take');
  });
  it('scrolling the list is not a swipe; a swipe to the right does nothing', () => {
    expect(closeTakeover({ dx: -8, dy: 20 })).toBe('no');
    expect(closeTakeover({ dx: 15, dy: 0 })).toBe('no');
  });
});

describe('closeRelease', () => {
  const width = 320;
  it('past 30% of its width: closed; less: it comes back', () => {
    expect(DRAWER_CLOSE_SHARE).toBe(0.3);
    expect(closeRelease({ dx: -96, vx: 0, width })).toBe('open');
    expect(closeRelease({ dx: -97, vx: 0, width })).toBe('closed');
  });
  it('a flick decides by its direction', () => {
    expect(closeRelease({ dx: -20, vx: -DRAWER_FLICK, width })).toBe('closed');
    expect(closeRelease({ dx: -300, vx: DRAWER_FLICK, width })).toBe('open');
  });
});

describe('drawerShift / drawerDim', () => {
  const width = 320;
  it('opening: the drawer comes in from the left by as much as the finger has travelled since it took over', () => {
    expect(drawerShift('open', 0, width)).toBe(-320);
    expect(drawerShift('open', 100, width)).toBe(-220);
    expect(drawerShift('open', 500, width)).toBe(0);
    expect(drawerShift('open', -40, width)).toBe(-320);
  });
  it('closing: it follows the finger to the left, never to the right of its place', () => {
    expect(drawerShift('close', 0, width)).toBe(0);
    expect(drawerShift('close', -100, width)).toBe(-100);
    expect(drawerShift('close', 30, width)).toBe(0);
    expect(drawerShift('close', -900, width)).toBe(-320);
  });
  it('the backdrop is as strong as the drawer is far in', () => {
    expect(drawerDim(0, width)).toBe(1);
    expect(drawerDim(-160, width)).toBe(0.5);
    expect(drawerDim(-320, width)).toBe(0);
    expect(drawerDim(-10, 0)).toBe(0);
  });
});
