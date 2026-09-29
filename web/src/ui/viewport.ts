// Phone breakpoint (spec §5.11). App keeps `store.mobile` in sync with it; components read the store, not the query.
export const MOBILE_QUERY = '(max-width: 760px)';

interface DrawerState { mobile: boolean; sidebarOpen: boolean; paletteOpen: boolean; shortcutsOpen: boolean }

/**
 * A phone's sidebar drawer is fixed at z 60, over the command palette (55) and the shortcut sheet (52): when one of
 * them comes up while the drawer is open (Ctrl+K / `?` from the keyboard — the sidebar's own 搜索 puts the drawer
 * away itself), the drawer makes way (final review M4). Only on the way up: opening the drawer afterwards is the
 * user's choice.
 */
export function drawerYields(prev: DrawerState, next: DrawerState): boolean {
  if (!next.mobile || !next.sidebarOpen) return false;
  return (next.paletteOpen && !prev.paletteOpen) || (next.shortcutsOpen && !prev.shortcutsOpen);
}
