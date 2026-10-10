// Where a sidebar menu goes: fixed to the viewport next to its anchor, so the scrolling list, the sidebar's
// overflow and a pane edge never clip it. Pure; `useAnchoredMenu` (menus.tsx) measures and applies it.

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
 * `side: 'right'`: beside the anchor instead (the icon rail's menus) — its top edge level with the anchor's, or its
 * bottom edge with `prefer: 'up'` (a menu at the foot of the rail).
 */
export function placeFixed(a: AnchorRect, size: { w: number; h: number }, view: { vw: number; vh: number }, o: { align?: 'left' | 'right'; prefer?: 'down' | 'up'; side?: 'right' } = {}): MenuSpot {
  const { w, h } = size, { vw, vh } = view;
  if (o.side === 'right') {
    const sx = Math.max(EDGE, Math.min(a.right + SIDE_GAP, vw - w - EDGE));
    if (h > vh - 2 * EDGE) return { left: sx, top: EDGE, maxHeight: vh - 2 * EDGE };
    return { left: sx, top: Math.max(EDGE, Math.min(o.prefer === 'up' ? a.bottom - h : a.top, vh - h - EDGE)) };
  }
  const x = o.align === 'left' ? a.left : a.right - w - 6;
  const left = Math.max(EDGE, Math.min(x, vw - w - EDGE));
  const below = h <= vh - a.bottom - EDGE, above = h <= a.top - EDGE;
  const down = { left, top: a.bottom + GAP }, up = { left, top: a.top - h - GAP };
  if (o.prefer === 'up') { if (above) return up; if (below) return down; }
  else { if (below) return down; if (above) return up; }
  return { left, top: EDGE, maxHeight: vh - 2 * EDGE };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

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
