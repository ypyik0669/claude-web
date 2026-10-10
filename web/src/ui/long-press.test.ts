import { describe, expect, it } from 'vitest';
import { CLICK_TAIL_MS, LONG_PRESS_MS, LONG_PRESS_SLOP_PX, pressStep, pressTail, type PressStart } from './long-press';

const start: PressStart = { x: 100, y: 200, at: 1000 };

describe('pressStep — what a finger held on a row has become', () => {
  it('the spec numbers: 500ms, about 10px', () => {
    expect(LONG_PRESS_MS).toBe(500);
    expect(LONG_PRESS_SLOP_PX).toBe(10);
  });
  it('fires when the timer comes round after 500ms', () => {
    expect(pressStep(start, { kind: 'timer', at: 1500 })).toBe('fire');
    expect(pressStep(start, { kind: 'timer', at: 1730 })).toBe('fire');
  });
  it('a timer that woke early keeps waiting', () => {
    expect(pressStep(start, { kind: 'timer', at: 1499 })).toBe('held');
  });
  it('lifting before that is a tap: no menu', () => {
    expect(pressStep(start, { kind: 'up' })).toBe('drop');
  });
  it('the browser taking the touch over (a scroll, a system gesture) drops it', () => {
    expect(pressStep(start, { kind: 'cancel' })).toBe('drop');
  });
  it('a finger that wobbles within 10px is still held', () => {
    expect(pressStep(start, { kind: 'move', x: 104, y: 203 })).toBe('held');
    expect(pressStep(start, { kind: 'move', x: 100, y: 210 })).toBe('held');
    expect(pressStep(start, { kind: 'move', x: 94, y: 192 })).toBe('held'); // 6, 8 → exactly 10
  });
  it('moving further than that is a scroll or a swipe: dropped', () => {
    expect(pressStep(start, { kind: 'move', x: 100, y: 211 })).toBe('drop');
    expect(pressStep(start, { kind: 'move', x: 89, y: 200 })).toBe('drop');
    expect(pressStep(start, { kind: 'move', x: 108, y: 208 })).toBe('drop'); // 8, 8 → 11.3
  });
});

describe('pressTail — the click that follows a long press', () => {
  it('nothing fired: every click is a real one', () => {
    expect(pressTail(null, null, 5000)).toBe(false);
    expect(pressTail(null, 4990, 5000)).toBe(false);
  });
  it('a click while the finger is still down belongs to the press', () => {
    expect(pressTail(1500, null, 1600)).toBe(true);
  });
  it('so does the click the browser makes of the lift', () => {
    expect(pressTail(1500, 2000, 2000)).toBe(true);
    expect(pressTail(1500, 2000, 2000 + CLICK_TAIL_MS)).toBe(true);
  });
  it('a tap after that is the next thing the user does (a row of the sheet)', () => {
    expect(pressTail(1500, 2000, 2001 + CLICK_TAIL_MS)).toBe(false);
    expect(CLICK_TAIL_MS).toBeLessThanOrEqual(350);
  });
});
