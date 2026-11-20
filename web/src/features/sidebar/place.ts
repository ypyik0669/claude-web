// Where a sidebar menu goes: fixed to the viewport next to its anchor, so the scrolling list, the sidebar's
// overflow and a pane edge never clip it. Pure; `useAnchoredMenu` (menus.tsx) measures and applies it.

import { clearOfCaption, type CaptionBox } from '@/ui/caption';
export type { CaptionBox };

export interface AnchorRect { left: number; top: number; right: number; bottom: number }
export interface MenuSpot { left: number; top: number; maxHeight?: number }

const EDGE = 8;
const GAP = 2;
const SIDE_GAP = 8;

/**
 * Below the anchor (or above with `prefer: 'up'`) when it fits, else the other side, else pinned to the top
 * with a max height. Right-aligned to the anchor's right edge (6px in, clear of the row's ··· button) by
 * default, left-aligned on request; always inside the window.
 *
 * `minLeft`: the leftmost the menu may start (the sidebar's own left edge: not over the icon rail).
 *
 * `side: 'right'`: beside the anchor instead (the icon rail's menus) — its top edge level with the anchor's, or its
 * bottom edge with `prefer: 'up'` (a menu at the foot of the rail).
 */
export function placeFixed(a: AnchorRect, size: { w: number; h: number }, view: { vw: number; vh: number }, o: { align?: 'left' | 'right'; prefer?: 'down' | 'up'; side?: 'right'; minLeft?: number; caption?: CaptionBox | null } = {}): MenuSpot {
  const spot = placeRaw(a, size, view, o);
  // never under the desktop window's own buttons (they are drawn over the page: those rows could not be clicked)
  const top = clearOfCaption(spot.left, spot.top, size.w, o.caption ?? null);
  if (top === spot.top) return spot;
  const room = view.vh - top - EDGE;
  return size.h > room ? { left: spot.left, top, maxHeight: room } : { left: spot.left, top };
}

function placeRaw(a: AnchorRect, size: { w: number; h: number }, view: { vw: number; vh: number }, o: { align?: 'left' | 'right'; prefer?: 'down' | 'up'; side?: 'right'; minLeft?: number }): MenuSpot {
  const { w, h } = size, { vw, vh } = view;
  if (o.side === 'right') {
    const sx = Math.max(EDGE, Math.min(a.right + SIDE_GAP, vw - w - EDGE));
    if (h > vh - 2 * EDGE) return { left: sx, top: EDGE, maxHeight: vh - 2 * EDGE };
    return { left: sx, top: Math.max(EDGE, Math.min(o.prefer === 'up' ? a.bottom - h : a.top, vh - h - EDGE)) };
  }
  const x = o.align === 'left' ? a.left : a.right - w - 6;
  // `minLeft`: a sidebar menu stays off the icon rail beside it (its buttons stay reachable while the menu is open)
  const left = Math.max(o.minLeft ?? EDGE, Math.min(x, vw - w - EDGE));
  const below = h <= vh - a.bottom - EDGE, above = h <= a.top - EDGE;
  const down = { left, top: a.bottom + GAP }, up = { left, top: a.top - h - GAP };
  if (o.prefer === 'up') { if (above) return up; if (below) return down; }
  else { if (below) return down; if (above) return up; }
  return { left, top: EDGE, maxHeight: vh - 2 * EDGE };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** How far a fly-out tucks under the edge of the menu it comes out of: the pointer never crosses a gap to reach it. */
export const FLY_OVERLAP = 4;
/** A menu's padding: the fly-out's first row is level with the row that opened it. */
const FLY_PAD = 6;

export interface FlySpot extends MenuSpot { side: 'right' | 'left' }

/**
 * Where a submenu flies out (redesign 2026-11 stage 3, 图 7: 「子菜单往右展开」): beside the menu it comes out of
 * (`box`, the whole menu, not just the row — a row is narrower than its menu), to the right, its first row level with
 * the row that opened it (`row`); to the left when the right has no room and the left has; pushed up to stay inside
 * the window; taller than the window → pinned to the top with a max height. Never under the desktop window buttons.
 */
export function placeFly(row: AnchorRect, box: AnchorRect, size: { w: number; h: number }, view: { vw: number; vh: number }, caption: CaptionBox | null = null): FlySpot {
  const right = box.right - FLY_OVERLAP, left = box.left - size.w + FLY_OVERLAP;
  const side: FlySpot['side'] = right + size.w <= view.vw - EDGE || left < EDGE ? 'right' : 'left';
  const x = clamp(side === 'right' ? right : left, EDGE, Math.max(EDGE, view.vw - size.w - EDGE));
  if (size.h > view.vh - 2 * EDGE) return { left: x, top: EDGE, maxHeight: view.vh - 2 * EDGE, side };
  const y = clamp(row.top - FLY_PAD, EDGE, view.vh - size.h - EDGE);
  const top = clearOfCaption(x, y, size.w, caption);
  if (top === y) return { left: x, top: y, side };
  const room = view.vh - top - EDGE;
  return size.h > room ? { left: x, top, maxHeight: room, side } : { left: x, top, side };
}

/** Where a fly-out scales in from: the edge that faces the menu, level with the row that opened it. */
export function flyOrigin(row: AnchorRect, spot: FlySpot, size: { w: number; h: number }): string {
  const h = Math.min(size.h, spot.maxHeight ?? size.h);
  return `${spot.side === 'right' ? '0%' : '100%'} ${Math.round(clamp((row.top + row.bottom) / 2 - spot.top, 0, h))}px`;
}

/**
 * Where the placed menu scales in from (UI refresh §4.5: from its anchor), as a `transform-origin`: on the menu's
 * edge that faces the anchor (top for one that opened below it, bottom for one above; pinned with a max height —
 * the anchor's own height inside the menu). Horizontally the anchor's centre when it is a button; an anchor wider
 * than the menu is a whole row, and what was clicked is at the end the menu is aligned to (the row's ···), not in
 * the row's middle. Never outside the menu's box.
 */
export function spotOrigin(a: AnchorRect, spot: MenuSpot, size: { w: number; h: number }, o: { align?: 'left' | 'right' } = {}): string {
  const wide = a.right - a.left > size.w;
  const ax = wide ? (o.align === 'left' ? a.left + 16 : a.right - 20) : (a.left + a.right) / 2;
  const x = Math.round(clamp(ax - spot.left, 0, size.w));
  const h = Math.min(size.h, spot.maxHeight ?? size.h);
  if (spot.top >= a.bottom) return `${x}px 0%`;
  if (spot.top + h <= a.top) return `${x}px 100%`;
  return `${x}px ${Math.round(clamp((a.top + a.bottom) / 2 - spot.top, 0, h))}px`;
}
