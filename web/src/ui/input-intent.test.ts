import { describe, expect, it } from 'vitest';
import { pointerLed } from './input-intent';

describe('pointerLed: was what just happened done with the pointer? (keyboard-triggered things are not animated)', () => {
  it('a pointer press a moment ago, nothing typed since: yes', () => {
    expect(pointerLed({ pointerAt: 1000, keyAt: 200 }, 1010)).toBe(true);
    expect(pointerLed({ pointerAt: 1000, keyAt: -Infinity }, 1300)).toBe(true);
  });
  it('a key pressed after the last pointer press: no (Enter on a focused chip, Esc in a menu)', () => {
    expect(pointerLed({ pointerAt: 1000, keyAt: 1005 }, 1010)).toBe(false);
  });
  it('the pointer press was a while ago: no (a timer, a server event, a script opened or closed it)', () => {
    expect(pointerLed({ pointerAt: 1000, keyAt: 200 }, 1000 + 401)).toBe(false);
    expect(pointerLed({ pointerAt: 1000, keyAt: 200 }, 1000 + 2000, 3000)).toBe(true);
  });
  it('no input at all yet: no', () => {
    expect(pointerLed({ pointerAt: -Infinity, keyAt: -Infinity }, 5)).toBe(false);
  });
});
