// Where a sidebar menu goes: fixed to the viewport next to its anchor, so the scrolling list, the sidebar's
// overflow and a pane edge never clip it. Pure; `useAnchoredMenu` (menus.tsx) measures and applies it.

export interface AnchorRect { left: number; top: number; right: number; bottom: number }
export interface MenuSpot { left: number; top: number; maxHeight?: number }

const EDGE = 8;
const GAP = 2;

/**
 * Below the anchor (or above with `prefer: 'up'`) when it fits, else the other side, else pinned to the top
 * with a max height. Right-aligned to the anchor's right edge (6px in, clear of the row's ··· button) by
 * default, left-aligned on request; always inside the window.
 */
export function placeFixed(a: AnchorRect, size: { w: number; h: number }, view: { vw: number; vh: number }, o: { align?: 'left' | 'right'; prefer?: 'down' | 'up' } = {}): MenuSpot {
  const { w, h } = size, { vw, vh } = view;
  const x = o.align === 'left' ? a.left : a.right - w - 6;
  const left = Math.max(EDGE, Math.min(x, vw - w - EDGE));
  const below = h <= vh - a.bottom - EDGE, above = h <= a.top - EDGE;
  const down = { left, top: a.bottom + GAP }, up = { left, top: a.top - h - GAP };
  if (o.prefer === 'up') { if (above) return up; if (below) return down; }
  else { if (below) return down; if (above) return up; }
  return { left, top: EDGE, maxHeight: vh - 2 * EDGE };
}
