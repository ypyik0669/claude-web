import { describe, expect, it } from 'vitest';
import { menuKey, menuMaxWidth } from './dir-menu';

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

  it('other keys are left alone', () => {
    expect(menuKey('a', 0, 3)).toBeNull();
    expect(menuKey('Enter', 0, 3)).toBeNull(); // the focused button's own click
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
