import { describe, expect, it } from 'vitest';
import { placePopover } from './popover-place';

const view = { vw: 1024, vh: 860 };
const rect = (left: number, top: number, w = 28, h = 28) => ({ left, top, right: left + w, bottom: top + h });

describe('right-panel popovers stay inside the window', () => {
  it('right-aligned to its button when there is room', () => {
    const p = placePopover(rect(900, 6), view, { width: 240, align: 'right' });
    expect(p).toMatchObject({ position: 'fixed', left: 928 - 240, width: 240, top: 40 });
  });

  it('a right-aligned menu whose button sits near the left edge slides right instead of losing its first pixels', () => {
    // the 「更多」 button 219px from the panel's left edge at 1024 wide: the menu used to start 20px outside
    const p = placePopover(rect(625 + 191, 6), view, { width: 240, align: 'right' });
    expect(p.left).toBeGreaterThanOrEqual(8);
    const q = placePopover(rect(4, 6), view, { width: 240, align: 'right' });
    expect(q.left).toBe(8);
  });

  it('a left-aligned menu near the right edge slides left; a window narrower than the menu shrinks it', () => {
    const p = placePopover(rect(900, 40), view, { width: 300, align: 'left' });
    expect((p.left ?? 0) + p.width).toBeLessThanOrEqual(1024 - 8);
    const n = placePopover(rect(10, 40), { vw: 280, vh: 600 }, { width: 300, align: 'left' });
    expect(n).toMatchObject({ left: 8, width: 264 });
  });

  it('opens upwards when the anchor is low and there is more room above', () => {
    const p = placePopover(rect(100, 800), view, { width: 200, align: 'left' });
    expect(p.bottom).toBeDefined();
    expect(p.top).toBeUndefined();
  });
});
