import { describe, expect, it } from 'vitest';
import { drawerYields } from './viewport';

const at = (o: Partial<{ mobile: boolean; sidebarOpen: boolean; paletteOpen: boolean; shortcutsOpen: boolean }>) => ({ mobile: true, sidebarOpen: true, paletteOpen: false, shortcutsOpen: false, ...o });

describe('a phone\'s sidebar drawer (z 60) makes way for the palette and the shortcut sheet (final review M4)', () => {
  it('the palette or the sheet coming up while the drawer is open closes the drawer', () => {
    expect(drawerYields(at({}), at({ paletteOpen: true }))).toBe(true);
    expect(drawerYields(at({}), at({ shortcutsOpen: true }))).toBe(true);
  });
  it('only when they come up: the drawer opened over an open palette (Ctrl+B) stays', () => {
    expect(drawerYields(at({ paletteOpen: true, sidebarOpen: false }), at({ paletteOpen: true }))).toBe(false);
    expect(drawerYields(at({ paletteOpen: true }), at({ paletteOpen: false }))).toBe(false);
  });
  it('not on a desktop, not with the drawer shut', () => {
    expect(drawerYields(at({ mobile: false }), at({ mobile: false, paletteOpen: true }))).toBe(false);
    expect(drawerYields(at({ sidebarOpen: false }), at({ sidebarOpen: false, shortcutsOpen: true }))).toBe(false);
  });
});
