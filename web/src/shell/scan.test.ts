import { describe, expect, it } from 'vitest';
import { readSize, scanFailure } from './scan';

describe('扫码配对: the camera', () => {
  it('a refusal says what the person can do about it', () => {
    expect(scanFailure({ name: 'NotAllowedError' })).toBe('denied');
    expect(scanFailure({ name: 'SecurityError' })).toBe('denied');
    expect(scanFailure({ name: 'NotFoundError' })).toBe('nocamera');
    expect(scanFailure({ name: 'OverconstrainedError' })).toBe('nocamera');
    expect(scanFailure({ name: 'NotReadableError' })).toBe('nocamera');
    expect(scanFailure(new Error('boom'))).toBe('other');
    expect(scanFailure(null)).toBe('other');
  });

  it('frames are read at most 720 px on their long side, never upscaled, never 0', () => {
    expect(readSize(1920, 1080)).toEqual({ w: 720, h: 405 });
    expect(readSize(1080, 1920)).toEqual({ w: 405, h: 720 });
    expect(readSize(640, 480)).toEqual({ w: 640, h: 480 });
    expect(readSize(0, 0)).toEqual({ w: 1, h: 1 });
  });
});
