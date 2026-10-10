/**
 * A phone's bottom sheet — the right panel at ≤ 760px (UI refresh §8 抽屉): two detents, and where a release lands.
 *
 * Pure. The element, the finger and the store are `phone-sheet.ts`; the sizes on screen are `styles/phone-sheet.css`
 * (the same two fractions).
 *
 * Distances are px, positive = down. A velocity is px/ms, positive = down.
 */
export type SheetDetent = 'half' | 'full';
/** where a release lands: one of the detents, or put away */
export type SheetLanding = SheetDetent | 'closed';

/** The share of the room above the keyboard each detent takes. */
export const SHEET_FRACTION: Record<SheetDetent, number> = { half: 0.62, full: 0.92 };
/** Let go more than this far below a detent: one detent down. */
export const SHEET_DOWN_PX = 70;
/** Let go more than this far above 半: 全. */
export const SHEET_UP_PX = 50;
/** A release at least this fast is a flick: it goes one stop in its direction, however short the drag. */
export const SHEET_FLICK = 0.5;
/** Past the highest it may rise the sheet gives a quarter of the finger's way, this much at most. */
export const SHEET_RESIST = 0.25;
export const SHEET_OVERSHOOT_PX = 24;

export interface SheetSizes { half: number; full: number }

/**
 * The two heights for `room` px above the keyboard: 62% and 92% of it, never taller than the room minus the status
 * bar (`safeTop`). `measured` is the sheet's height on screen right now — exact for the detent it is at.
 */
export function sheetSizes(room: number, safeTop = 0, measured?: { detent: SheetDetent; height: number }): SheetSizes {
  const cap = Math.max(0, room - safeTop);
  let full = Math.round(Math.min(room * SHEET_FRACTION.full, cap));
  let half = Math.min(Math.round(room * SHEET_FRACTION.half), full);
  if (measured && measured.height > 0) {
    if (measured.detent === 'full') { full = measured.height; half = Math.min(half, full); }
    else { half = measured.height; full = Math.max(full, half); }
  }
  return { half, full };
}

export interface SheetRelease extends SheetSizes {
  /** the detent the drag started from */
  detent: SheetDetent;
  /** how far the finger has taken it from there */
  dy: number;
  /** the finger's speed as it let go */
  vy: number;
}

/**
 * Where the sheet lands when the finger lets go.
 *
 * A flick goes to the next stop in its direction from where the sheet is — so one detent at a time (全 → 半 → closed),
 * and a flick back the way it came returns it to where it was. Otherwise: more than 70px below its detent, one detent
 * down; more than 50px above 半, 全; else back where it was. From 全, a slow release more than 70px below where 半 sits
 * closes it (it would have to jump back up to reach 半).
 */
export function sheetSnap(r: SheetRelease): SheetLanding {
  const step = Math.max(0, r.full - r.half);
  // how far the sheet's top is below where 全 has it: 0 = 全, step = 半
  const pos = (r.detent === 'full' ? 0 : step) + r.dy;
  if (r.vy >= SHEET_FLICK) return pos < step ? 'half' : 'closed';
  if (r.vy <= -SHEET_FLICK) return pos > step ? 'half' : 'full';
  if (r.detent === 'full') {
    if (pos - step > SHEET_DOWN_PX) return 'closed';
    return r.dy > SHEET_DOWN_PX ? 'half' : 'full';
  }
  if (r.dy > SHEET_DOWN_PX) return 'closed';
  return r.dy < -SHEET_UP_PX ? 'full' : 'half';
}

/**
 * How far the sheet is moved for a finger `dy` away from where the drag began: down as far as the finger goes (it
 * leaves the screen); up as far as 全 sits above it (nothing, from 全), and past that only a little.
 */
export function sheetTravel(detent: SheetDetent, dy: number, sizes: SheetSizes): number {
  const rise = detent === 'half' ? Math.max(0, sizes.full - sizes.half) : 0;
  if (dy >= -rise) return dy;
  return -rise + Math.max(-SHEET_OVERSHOOT_PX, (dy + rise) * SHEET_RESIST);
}

/** The backdrop's strength (0–1) with the sheet moved by `offset`: full while at least 半 of it shows, then fading. */
export function sheetDim(detent: SheetDetent, offset: number, sizes: SheetSizes): number {
  if (sizes.half <= 0) return 0;
  const showing = (detent === 'full' ? sizes.full : sizes.half) - offset;
  return Math.min(1, Math.max(0, showing / sizes.half));
}
