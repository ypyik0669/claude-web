import { placeMenu, samePlacement, type Placement } from '@/features/models/place';

/** Keyboard of the working-directory menu: which row to focus, or close (handing focus back to the chip). */
export function menuKey(key: string, index: number, count: number): { focus: number } | { close: true; refocus: true } | null {
  if (!count) return key === 'Escape' || key === 'Tab' ? { close: true, refocus: true } : null;
  switch (key) {
    case 'ArrowDown': return { focus: index < 0 ? 0 : (index + 1) % count };
    case 'ArrowUp': return { focus: index < 0 ? count - 1 : (index - 1 + count) % count };
    case 'Home': return { focus: 0 };
    case 'End': return { focus: count - 1 };
    case 'Escape':
    case 'Tab': return { close: true, refocus: true };
    default: return null;
  }
}

export type DirMenuLayout = Placement & { maxWidth: number; minWidth: number };

/**
 * Where the menu goes and how wide it may be, as one value: below the chip, left-aligned; min / max width from
 * the room right of its left edge. Width depends on the viewport, not only on the position — so a resize that
 * leaves the chip where it was still yields a different layout (and a re-render).
 */
export function dirMenuLayout(chip: { top: number; bottom: number; left: number; right: number }, view: { vw: number; vh: number }): DirMenuLayout {
  const pos = placeMenu(chip, view, 'down', 'left');
  const maxWidth = menuMaxWidth(pos, view.vw);
  return { ...pos, maxWidth, minWidth: Math.min(280, maxWidth) };
}

export function sameLayout(a: DirMenuLayout | null, b: DirMenuLayout): boolean {
  return samePlacement(a, b) && a!.maxWidth === b.maxWidth && a!.minWidth === b.minWidth;
}

const CAP = 520;
const GUTTER = 8;
/** max-width for the menu at its fixed position: the design cap, but never past the right edge of the viewport. */
export function menuMaxWidth(pos: { left?: number; right?: number }, vw: number): number {
  const room = pos.left !== undefined ? vw - pos.left - GUTTER : vw - 2 * GUTTER;
  return Math.max(0, Math.min(CAP, room));
}
