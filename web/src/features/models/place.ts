import type { CSSProperties } from 'react';

const GAP = 6;
const MARGIN = 8;
const MAX = 560;
const MIN = 120;
const ROOMY = 260;

/** The CSS variable a placed menu scales in from (`transform-origin`, styles/floating.css). */
export const MENU_ORIGIN = '--menu-origin';

export type Placement = CSSProperties & { top?: number; bottom?: number; left?: number; right?: number; maxHeight: number; [MENU_ORIGIN]?: string };

interface Edges { top: number; bottom: number; left: number; right: number }

/**
 * Where a placed menu grows from (UI refresh §4.5: a menu scales in from its anchor): the anchor's centre, on the
 * menu's edge that faces the anchor — the top edge of a menu that opened below it, the bottom edge of one above.
 * Horizontally in px from the edge the menu is anchored by (its width is not known here): from its left edge, or
 * `calc(100% - Npx)` from its right one. Never outside the menu (a menu pushed in from the window's edge).
 */
export function menuOrigin(r: { left: number; right: number }, st: { top?: number; bottom?: number; left?: number; right?: number }, vw: number): string {
  const cx = (r.left + r.right) / 2;
  const y = st.top !== undefined ? '0%' : '100%';
  if (st.left !== undefined) return `${Math.max(0, Math.round(cx - st.left))}px ${y}`;
  if (st.right !== undefined) return `calc(100% - ${Math.max(0, Math.round(vw - st.right - cx))}px) ${y}`;
  return `50% ${y}`;
}

/** The placement with its origin recomputed (after it was moved to the window's other edge). */
export function withOrigin<P extends Placement>(st: P, r: { left: number; right: number }, vw: number): P {
  return { ...st, [MENU_ORIGIN]: menuOrigin(r, st, vw) };
}

/**
 * Fixed coordinates for a popover next to an anchor: the preferred side unless the other has clearly more
 * room; height capped to the room on that side (at least MIN, never taller than the viewport); a gutter at
 * the edges. `need` = the menu's natural height once measured: then the preferred side only if the menu fits
 * there (capped at MAX), else whichever side has more room — a composer in the middle of the welcome page has
 * more room below it, one at the bottom of a conversation above it. The side it opened on and where the anchor is
 * also give the point it scales in from (`--menu-origin`).
 */
export function placeMenu(r: Edges, view: { vw: number; vh: number }, prefer: 'up' | 'down', align: 'left' | 'right', need?: number): Placement {
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
  st[MENU_ORIGIN] = menuOrigin(r, st, vw);
  return st;
}

/** Same coordinates: the layout observers fire often (every keystroke that grows the composer), skip the re-render. */
export function samePlacement(a: Placement | null, b: Placement): boolean {
  return !!a && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right && a.maxHeight === b.maxHeight;
}
