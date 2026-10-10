// The phases of something that folds open and shut with its height animated (UI refresh §4.5: a grid row 1fr ⇄ 0fr and
// opacity, 340 ms, the sheet curve). Pure — the hook and the component are Fold.tsx; a turn's steps use the same phases
// (ChatView.tsx `TurnView`).
//
//   closed ──open──▶ pre ──(laid out)──▶ opening ──(time)──▶ open
//   open ──close──▶ closing ──(time)──▶ closed
//
// `pre` is one frame: the content is in the page, collapsed, so the transition to `opening` has a height to start
// from. A change that is not animated (the keyboard, a setting, a find-in-page hit, 「减少动态效果」) goes straight to
// `open` / `closed`; a change of mind half way turns around from where it is (`closing` → `opening` and back).

export type FoldPhase = 'closed' | 'pre' | 'opening' | 'open' | 'closing';

/** The transition's length (chat.css `--fold-ms`). */
export const FOLD_MS = 340;

/** The phase after the wanted state became `open`. */
export function foldTo(phase: FoldPhase, open: boolean, animate: boolean): FoldPhase {
  if (open) {
    if (phase === 'open') return phase;
    if (!animate) return 'open';
    if (phase === 'closed') return 'pre';
    return phase === 'closing' ? 'opening' : phase;
  }
  if (phase === 'closed') return phase;
  if (!animate || phase === 'pre') return 'closed';
  return 'closing';
}

/** The phase a moving one ends in: after the frame (`pre`) or the time (`opening`, `closing`). */
export function foldSettle(phase: FoldPhase): FoldPhase {
  return phase === 'pre' ? 'opening' : phase === 'opening' ? 'open' : phase === 'closing' ? 'closed' : phase;
}

/** In the page (laid out), whatever its height. */
export const foldShown = (phase: FoldPhase): boolean => phase !== 'closed';

/** The classes a phase puts on the folding element: `shut` = collapsed, `moving` = clips what is taller than it. */
export function foldClass(phase: FoldPhase): string {
  return phase === 'pre' || phase === 'closing' ? 'shut moving' : phase === 'opening' ? 'moving' : '';
}
