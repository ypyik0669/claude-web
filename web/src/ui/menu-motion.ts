// How an anchored menu comes and goes (UI refresh §4.5, styles/floating.css):
//  - in: every `.menu` scales in from `--menu-origin` (set by the code that places it) — unless it was not the
//    pointer that opened it: then it carries `data-kb` and is simply there;
//  - out: when the pointer closed it (a click outside, a click on a row, its chip), an inert copy fades out where it
//    was for 120ms (ui/ghost.ts). The menu itself is unmounted at once, as before. Closed from the keyboard, by a
//    timer or by a script, nothing is left behind.
// A menu shown as an action sheet on a phone has none of this (`off`): the sheet around it slides (ui/ActionSheet.tsx).
import { useState } from 'react';
import { useLeaveGhost, type GhostOpts } from './ghost';
import { byPointer } from './input-intent';

/** floating.css: `.menu.leaving` runs the exit keyframes for this long. */
export const MENU_OUT_MS = 120;
const MENU_GHOST: GhostOpts = { ms: MENU_OUT_MS, className: 'leaving' };

/**
 * For a menu component: spread the result on the menu's root element. `get` returns that element, `deps` says when
 * it appears (a menu that renders on its second pass, once it is placed). `off`: the menu is an action sheet — no
 * entrance from an anchor, no copy left behind.
 */
export function useMenuMotion(get: () => HTMLElement | null, deps: readonly unknown[] = [], off = false): { 'data-kb'?: '' } {
  // decided once, when the component mounts: a click handler mounts it within the same task as the pointer event
  const [kb] = useState(() => !byPointer());
  useLeaveGhost(get, () => (!off && byPointer() ? MENU_GHOST : null), deps);
  return kb && !off ? { 'data-kb': '' } : {};
}
