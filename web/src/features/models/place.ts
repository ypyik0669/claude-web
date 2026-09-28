import type { CSSProperties } from 'react';

const GAP = 6;
const MARGIN = 8;
const MAX = 560;
const MIN = 120;
const ROOMY = 260;

export type Placement = CSSProperties & { top?: number; bottom?: number; left?: number; right?: number; maxHeight: number };

/**
 * Fixed coordinates for a popover next to an anchor: the preferred side unless the other has clearly more
 * room; height capped to the room on that side (at least MIN, never taller than the viewport); a gutter at
 * the edges. `need` = the menu's natural height once measured: then the preferred side only if the menu fits
 * there (capped at MAX), else whichever side has more room — a composer in the middle of the welcome page has
 * more room below it, one at the bottom of a conversation above it.
 */
export function placeMenu(r: { top: number; bottom: number; left: number; right: number }, view: { vw: number; vh: number }, prefer: 'up' | 'down', align: 'left' | 'right', need?: number): Placement {
  const { vw, vh } = view;
  const above = r.top - GAP - MARGIN;
  const below = vh - r.bottom - GAP - MARGIN;
  const enough = need === undefined ? ROOMY : Math.min(need, MAX);
  const up = prefer === 'up' ? above >= enough || above >= below : !(below >= enough || below >= above);
  const room = up ? above : below;
  const maxHeight = Math.min(vh - 2 * MARGIN, Math.max(MIN, Math.min(MAX, room)));
  const st: Placement = { position: 'fixed', maxHeight };
  // when the room is below MIN the box is taller than the room: pin it inside the viewport instead
  if (up) st.bottom = Math.min(vh - r.top + GAP, vh - MARGIN - maxHeight);
  else st.top = Math.min(r.bottom + GAP, vh - MARGIN - maxHeight);
  if (align === 'right') st.right = Math.max(MARGIN, vw - r.right); else st.left = Math.max(MARGIN, r.left);
  return st;
}

/** Same coordinates: the layout observers fire often (every keystroke that grows the composer), skip the re-render. */
export function samePlacement(a: Placement | null, b: Placement): boolean {
  return !!a && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right && a.maxHeight === b.maxHeight;
}
