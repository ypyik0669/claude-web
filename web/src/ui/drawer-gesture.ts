/**
 * A phone's sidebar drawer follows the finger (UI refresh §8 侧栏抽屉): a swipe to the right on the conversation
 * opens it, a swipe to the left on the drawer or its backdrop closes it.
 *
 * Pure: does this movement take the gesture over, and where does a release land. The elements and the pointer are
 * `phone-drawer.ts`; the drawer's size and resting places are `styles/phone-sheet.css`.
 *
 * Distances are px from where the finger went down, positive = right / down. A velocity is px/ms, positive = right.
 */

/** The drawer is 86% of the window wide, 380px at most (the same numbers as the style sheet). */
export const DRAWER_VW = 0.86;
export const DRAWER_MAX_PX = 380;
/** A swipe that starts this close to the left edge is the system's back gesture, not ours. */
export const DRAWER_EDGE_PX = 20;
/** The finger has to go this far sideways before the drawer takes the gesture. */
export const DRAWER_TAKE_PX = 15;
/** …and this far up or down, being more of a scroll than a swipe, before the gesture is given up as a scroll. */
export const DRAWER_SCROLL_PX = 10;
/** Opening: let go further than this and it opens. */
export const DRAWER_OPEN_PX = 50;
/** Closing: let go with it pushed back by more than this share of its width and it closes. */
export const DRAWER_CLOSE_SHARE = 0.3;
/** A release at least this fast is a flick: its direction decides. */
export const DRAWER_FLICK = 0.4;

export function drawerWidth(viewport: number): number {
  return Math.min(viewport * DRAWER_VW, DRAWER_MAX_PX);
}

/** `take`: the drawer follows the finger from here on; `wait`: not decided yet; `no`: this gesture is not ours. */
export type Takeover = 'take' | 'wait' | 'no';

/** Opening: a swipe to the right that began at `startX`, now `dx` / `dy` away. */
export function openTakeover(m: { startX: number; dx: number; dy: number }): Takeover {
  if (m.startX <= DRAWER_EDGE_PX) return 'no';
  const ax = Math.abs(m.dx), ay = Math.abs(m.dy);
  if (ay > ax && ay >= DRAWER_SCROLL_PX) return 'no';
  if (m.dx <= -DRAWER_TAKE_PX) return 'no';
  return m.dx >= DRAWER_TAKE_PX && ax > ay ? 'take' : 'wait';
}

/** Closing: a swipe to the left on the open drawer or its backdrop. */
export function closeTakeover(m: { dx: number; dy: number }): Takeover {
  const ax = Math.abs(m.dx), ay = Math.abs(m.dy);
  if (ay > ax && ay >= DRAWER_SCROLL_PX) return 'no';
  if (m.dx >= DRAWER_TAKE_PX) return 'no';
  return m.dx <= -DRAWER_TAKE_PX && ax > ay ? 'take' : 'wait';
}

export type DrawerLanding = 'open' | 'closed';

/** Letting go of an opening swipe: open past 50px or on a quick swipe to the right; a flick back keeps it shut. */
export function openRelease(r: { dx: number; vx: number }): DrawerLanding {
  if (r.vx <= -DRAWER_FLICK) return 'closed';
  if (r.vx >= DRAWER_FLICK) return 'open';
  return r.dx > DRAWER_OPEN_PX ? 'open' : 'closed';
}

/** Letting go of a closing swipe: closed past 30% of the drawer's width or on a quick swipe to the left. */
export function closeRelease(r: { dx: number; vx: number; width: number }): DrawerLanding {
  if (r.vx >= DRAWER_FLICK) return 'open';
  if (r.vx <= -DRAWER_FLICK) return 'closed';
  return -r.dx > r.width * DRAWER_CLOSE_SHARE ? 'closed' : 'open';
}

/**
 * Where the drawer is (its translateX: 0 = in place, −width = out of sight) for a finger that has travelled `travel`
 * px since the drawer took the gesture over.
 */
export function drawerShift(mode: 'open' | 'close', travel: number, width: number): number {
  const x = mode === 'open' ? travel - width : travel;
  return Math.min(0, Math.max(-width, x));
}

/** The backdrop's strength (0–1): as far in as the drawer is. */
export function drawerDim(shift: number, width: number): number {
  if (width <= 0) return 0;
  return Math.min(1, Math.max(0, 1 + shift / width));
}
