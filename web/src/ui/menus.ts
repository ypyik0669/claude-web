// Anchored menus (the directory menu, the model menu, the composer's popovers, the right panel's popovers, the
// sidebar's menus, the header ···) — one open at a time, app-wide, and all of them close on one window event:
//  - a menu that opens first tells the others to close (`closeAnchoredMenus()`), then listens for the next such
//    call itself: broadcast, then subscribe — the event is dispatched synchronously, so the menu that sends it never
//    receives its own. Toggle buttons that stop their click (the sidebar's) can't close another menu through a
//    window click; this does (re-review N2: the header ··· and the sidebar funnel used to be open together);
//  - the settings page covering the app calls `closeAnchoredMenus()` too: a menu portalled to <body> is outside the
//    app that the page makes inert, and left open it would float above the page (review of redesign phase 6).
// A menu component calls `useMenuClaim(onClose)` once (mount-only: a parent re-rendering it must not close the
// others again).
import { useEffect, useRef } from 'react';

export const CLOSE_MENUS = 'cw:close-menus';

/** Close every open anchored menu. */
export function closeAnchoredMenus(): void {
  window.dispatchEvent(new Event(CLOSE_MENUS));
}

/** Call `fn` when menus are told to close; returns the unsubscribe (fits a useEffect cleanup). */
export function onCloseMenus(fn: () => void): () => void {
  window.addEventListener(CLOSE_MENUS, fn);
  return () => window.removeEventListener(CLOSE_MENUS, fn);
}

/** This menu is opening: close the others, then close it when the next one opens (or the app is covered). */
export function claimMenu(close: () => void): () => void {
  closeAnchoredMenus();
  return onCloseMenus(close);
}

/** `claimMenu` for a menu component's lifetime; `onClose` may be a fresh closure on every render. */
export function useMenuClaim(onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => claimMenu(() => ref.current()), []);
}
