// The arithmetic of the segmented control (ui/Segmented.tsx): which option the thumb sits under, the two numbers the
// stylesheet slides it with, and where an arrow key goes. Pure, so it is tested without a DOM.

/** The chosen option's position; −1 when nothing is chosen (or the value is not one of the options): no thumb. */
export function segIndex<T>(values: readonly T[], value: T | null | undefined): number {
  return value === null || value === undefined ? -1 : values.indexOf(value);
}

/**
 * `--seg-n` / `--seg-i` (styles/floating.css): the thumb is one n-th of the track wide and sits i widths in. With no
 * choice it is hidden and parked under the first option — picking one then fades it in there instead of sliding it
 * in from outside the track.
 */
export function segVars(count: number, index: number): { '--seg-n': number; '--seg-i': number } {
  return { '--seg-n': Math.max(1, count), '--seg-i': Math.max(0, index) };
}

/**
 * A radio group's own keys: → ↓ the next option, ← ↑ the one before (both wrap), Home / End the first / last —
 * disabled options stepped over. `null` = not one of these keys, or nowhere else to go.
 */
export function segStep(index: number, key: string, enabled: readonly boolean[]): number | null {
  const n = enabled.length;
  const dir = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  let next = -1;
  if (dir) {
    // from nothing chosen: → lands on the first option, ← on the last
    const from = index < 0 ? (dir > 0 ? -1 : n) : index;
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (enabled[i]) { next = i; break; }
    }
  } else if (key === 'Home') next = enabled.indexOf(true);
  else if (key === 'End') next = enabled.lastIndexOf(true);
  else return null;
  return next < 0 || next === index ? null : next;
}
