/**
 * How fast the finger was going when it let go (the phone's bottom sheet and sidebar drawer: a flick lands
 * differently from a slow release). Pure: positions with their event times in, px/ms out.
 */
export interface DragSample { t: number; p: number }

/** Only the last stretch counts: a finger that rested before lifting did not flick. */
export const VELOCITY_WINDOW_MS = 100;
const KEEP = 12;

/** Remember where the finger was at `t` (the last few positions only). */
export function noteSample(samples: DragSample[], t: number, p: number): void {
  samples.push({ t, p });
  if (samples.length > KEEP) samples.splice(0, samples.length - KEEP);
}

/** px/ms over the samples of the last `within` ms before `now`, signed; 0 with fewer than two of them. */
export function releaseVelocity(samples: readonly DragSample[], now: number, within = VELOCITY_WINDOW_MS): number {
  const recent = samples.filter((s) => now - s.t <= within);
  if (recent.length < 2) return 0;
  const a = recent[0], b = recent[recent.length - 1];
  const dt = b.t - a.t;
  return dt > 0 ? (b.p - a.p) / dt : 0;
}
