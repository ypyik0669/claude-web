import { describe, expect, it } from 'vitest';
import { frameAt, outOfSight } from './ticker';

describe('the process glyphs\' clock', () => {
  it('a loop goes round its frames; an ending holds its last frame, then is over', () => {
    const loop = { t0: 0, fps: 10, frames: ['a', 'b', 'c'], once: false };
    expect(frameAt(loop, 0).i).toBe(0);
    expect(frameAt(loop, 250).i).toBe(2);
    expect(frameAt(loop, 350).i).toBe(0);
    const end = { t0: 0, fps: 10, frames: ['a', 'b', 'c'], once: true };
    // three frames at 10 fps (300 ms), then the last one held 260 ms
    expect(frameAt(end, 150)).toEqual({ i: 1, over: false });
    expect(frameAt(end, 400)).toEqual({ i: 2, over: false });
    expect(frameAt(end, 560)).toEqual({ i: 2, over: true });
  });

  it('writes nothing to a glyph out of sight: no box, out of view, or under a page that lies over the conversations', () => {
    expect(outOfSight({})).toBe(false);
    expect(outOfSight({ seen: true })).toBe(false);
    expect(outOfSight({ seen: false })).toBe(true);
    expect(outOfSight({ seen: true, layer: { inert: true } as HTMLElement })).toBe(true);
    expect(outOfSight({ seen: true, layer: { inert: false } as HTMLElement })).toBe(false);
  });
});
