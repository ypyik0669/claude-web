import { describe, expect, it } from 'vitest';
import { dirMenuLayout, fieldStep, menuKey, menuMaxWidth, sameLayout } from './dir-menu';

describe('directory menu keyboard', () => {
  it('↑ ↓ wrap around, Home / End jump to the ends', () => {
    expect(menuKey('ArrowDown', 0, 3)).toEqual({ focus: 1 });
    expect(menuKey('ArrowDown', 2, 3)).toEqual({ focus: 0 });
    expect(menuKey('ArrowUp', 0, 3)).toEqual({ focus: 2 });
    expect(menuKey('ArrowDown', -1, 3)).toEqual({ focus: 0 }); // nothing focused yet
    expect(menuKey('Home', 2, 3)).toEqual({ focus: 0 });
    expect(menuKey('End', 0, 3)).toEqual({ focus: 2 });
  });

  it('Esc and Tab close the menu and hand focus back to the chip', () => {
    expect(menuKey('Escape', 1, 3)).toEqual({ close: true, refocus: true });
    expect(menuKey('Tab', 1, 3)).toEqual({ close: true, refocus: true });
  });

  it('from a search box (not a row): ↓ / Tab to the first row after it, ↑ to the one before it (re-review 3 Minor 4)', () => {
    // 引用另一个对话: [返回] <search> [r1] [r2] → ↓ lands on r1 (index 1), not on 返回
    expect(fieldStep('down', 1, 3)).toBe(1);
    expect(fieldStep('up', 1, 3)).toBe(0);
    // 筛选分支…: <filter> [b1] [b2] → ↓ b1, ↑ wraps to the last
    expect(fieldStep('down', 0, 2)).toBe(0);
    expect(fieldStep('up', 0, 2)).toBe(1);
    // everything above the field: ↓ wraps to the first
    expect(fieldStep('down', 2, 2)).toBe(0);
    expect(fieldStep('down', 0, 0)).toBeNull();
  });

  it('other keys are left alone', () => {
    expect(menuKey('a', 0, 3)).toBeNull();
    expect(menuKey('Enter', 0, 3)).toBeNull(); // the focused button's own click
  });
});

describe('directory menu layout (position + width as one value)', () => {
  const chip = { top: 500, bottom: 526, left: 300, right: 400 };
  it('a narrower window with the chip where it was: same position, smaller width → a different layout', () => {
    const wide = dirMenuLayout(chip, { vw: 1360, vh: 860 });
    const narrow = dirMenuLayout(chip, { vw: 600, vh: 860 });
    expect(narrow.left).toBe(wide.left);
    expect(narrow.top).toBe(wide.top);
    expect([wide.maxWidth, narrow.maxWidth]).toEqual([520, 292]);
    expect(narrow.minWidth).toBe(280);
    expect(sameLayout(wide, narrow)).toBe(false); // a resize must re-render even though the menu did not move
    expect(sameLayout(wide, dirMenuLayout(chip, { vw: 1360, vh: 860 }))).toBe(true);
    expect(sameLayout(null, wide)).toBe(false);
  });

  it('min-width never exceeds the room', () => {
    expect(dirMenuLayout(chip, { vw: 500, vh: 860 })).toMatchObject({ maxWidth: 192, minWidth: 192 });
  });
});

describe('directory menu width', () => {
  it('never wider than the room right of its left edge (minus the gutter)', () => {
    expect(menuMaxWidth({ left: 300 }, 1360)).toBe(520); // plenty of room: the design cap
    expect(menuMaxWidth({ left: 300 }, 600)).toBe(292); // 600 - 300 - 8
    expect(menuMaxWidth({ left: 8 }, 360)).toBe(344);
  });

  it('right-aligned or unplaced: the viewport minus both gutters', () => {
    expect(menuMaxWidth({ right: 8 }, 400)).toBe(384);
    expect(menuMaxWidth({}, 300)).toBe(284);
  });
});
