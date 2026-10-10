// A menu on a phone is an action sheet from the bottom (UI refresh §8 菜单; ui/ActionSheet.tsx draws it). These are
// the decisions of a drag on its handle, as numbers in and a verdict out: down follows the finger; released past 70px
// or flicked down the sheet closes, otherwise it springs back.

/** Released this far below where it rests (px), the sheet closes. */
export const SHEET_CLOSE_PX = 70;
/** A release moving at least this fast (px / ms) is a flick: down closes from anywhere, up keeps the sheet. */
export const SHEET_FLICK = 0.5;
/** …once the finger has travelled this far: a tap that twitches is not a flick. */
export const SHEET_FLICK_MIN_PX = 12;
/** How far the sheet gives when pulled up: it already is as high as it goes. */
export const SHEET_GIVE_PX = 10;
/** The speed at release is the travel over this long before it (ms). */
export const VELOCITY_WINDOW_MS = 100;

/** Where the sheet is drawn (px from where it rests) with the finger `dy` px below the point it took hold. */
export function sheetOffset(dy: number): number {
  return dy >= 0 ? dy : -Math.min(SHEET_GIVE_PX, Math.sqrt(-dy));
}

/**
 * The finger let go `dy` px below where it took hold, moving at `vy` px / ms (down is positive): close, or spring
 * back. Thrown back up the sheet stays, wherever it was let go — the last thing the finger said wins.
 */
export function sheetRelease(dy: number, vy: number): 'close' | 'back' {
  if (dy <= 0 || vy <= -SHEET_FLICK) return 'back';
  if (dy >= SHEET_CLOSE_PX) return 'close';
  return vy >= SHEET_FLICK && dy >= SHEET_FLICK_MIN_PX ? 'close' : 'back';
}

/** The backdrop's opacity (0–1 of its own) with the sheet `offset` px down, `height` px tall. */
export function sheetScrim(offset: number, height: number): number {
  if (height <= 0 || offset <= 0) return 1;
  return Math.max(0, 1 - offset / height);
}

/**
 * The finger's speed at `now` (px / ms, down positive) from its last positions: the travel over the last 100ms.
 * A finger that rested before lifting (no sample in that time) has none.
 */
export function dragVelocity(samples: readonly { y: number; t: number }[], now: number, windowMs = VELOCITY_WINDOW_MS): number {
  const recent = samples.filter((s) => now - s.t <= windowMs);
  if (recent.length < 2) return 0;
  const a = recent[0], b = recent[recent.length - 1];
  return b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0;
}
