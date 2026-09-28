// Where a right-panel popover (the 「更多」 menu, 审阅's scope and ··· menus) goes. They are portalled to <body>
// with fixed coordinates: inside the right panel they were clipped by its `overflow: hidden` (a 240px menu
// right-aligned to a button 220px from the panel's left edge lost its first 20px). Pure: unit tested.
import { placeMenu, type Placement } from '@/features/models/place';

const MARGIN = 8;

/**
 * Below the anchor (or above, when there is clearly more room there), aligned to its left or right edge, and
 * always entirely inside the window: `width` shrinks to the window, and a box that would cross an edge slides
 * back in.
 */
export function placePopover(
  r: { top: number; bottom: number; left: number; right: number },
  view: { vw: number; vh: number },
  o: { width: number; align: 'left' | 'right'; prefer?: 'down' | 'up' },
): Placement & { width: number } {
  const width = Math.max(0, Math.min(o.width, view.vw - 2 * MARGIN));
  const st = placeMenu(r, view, o.prefer ?? 'down', o.align);
  const want = o.align === 'right' ? r.right - width : r.left;
  const left = Math.max(MARGIN, Math.min(want, view.vw - MARGIN - width));
  const out: Placement & { width: number } = { ...st, left, width };
  delete out.right;
  return out;
}
