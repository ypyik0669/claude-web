import { describe, expect, it } from 'vitest';
import { HAPTIC_MS, hapticAllowed, haptic } from './haptics';

describe('haptics', () => {
  it('ticks only where the device can, the setting is on and motion is not reduced', () => {
    expect(hapticAllowed({ canVibrate: true, enabled: true, reduceMotion: false })).toBe(true);
    expect(hapticAllowed({ canVibrate: false, enabled: true, reduceMotion: false })).toBe(false); // iOS, desktop
    expect(hapticAllowed({ canVibrate: true, enabled: false, reduceMotion: false })).toBe(false); // ui.haptics off
    expect(hapticAllowed({ canVibrate: true, enabled: true, reduceMotion: true })).toBe(false);   // 减少动态效果
  });

  it('every kind is the same short tick', () => {
    for (const ms of Object.values(HAPTIC_MS)) expect(ms).toBe(10);
  });

  it('is a no-op without a document (tests, the server)', () => {
    expect(() => haptic('confirm')).not.toThrow();
  });
});
