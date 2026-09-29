// Anchored menus (the directory menu, the model menu, the composer's popovers, the right panel's popovers, the
// sidebar's menus, the header ···, the file tree's right-click menu, the workbench's dropdowns) — one open at a time,
// app-wide, and all of them close on one window event:
//  - a menu that opens first tells the others to close (`closeAnchoredMenus()`), then listens for the next such
//    call itself: broadcast, then subscribe — the event is dispatched synchronously, so the menu that sends it never
//    receives its own. Toggle buttons that stop their click (the sidebar's) can't close another menu through a
//    window click; this does (re-review N2: the header ··· and the sidebar funnel used to be open together);
//  - the settings page covering the app calls `closeAnchoredMenus()` too: a menu portalled to <body> is outside the
//    app that the page makes inert, and left open it would float above the page (review of redesign phase 6).
// A menu component calls `useMenuClaim(onClose)` once (mount-only: a parent re-rendering it must not close the
// others again); a plain dropdown whose open state lives in its owner uses `useDropdown`.
//
// While a menu is claimed, `anchoredMenuOpen()` is true: one Esc does one thing — with a menu open it only closes the
// menu (the sidebar's multi-select, the automation page, a running turn don't take that Esc; polish P1).
import { useEffect, useRef, type RefObject } from 'react';
import { imeComposing } from './ime';

export const CLOSE_MENUS = 'cw:close-menus';

/** The claims of the menus open right now (one at a time; a set so a double release is harmless). */
const claimed = new Set<object>();

/** Close every open anchored menu. */
export function closeAnchoredMenus(): void {
  window.dispatchEvent(new Event(CLOSE_MENUS));
}

/** Is an anchored menu open (claimed and not yet released)? */
export function anchoredMenuOpen(): boolean {
  return claimed.size > 0;
}

/** Call `fn` when menus are told to close; returns the unsubscribe (fits a useEffect cleanup). */
export function onCloseMenus(fn: () => void): () => void {
  window.addEventListener(CLOSE_MENUS, fn);
  return () => window.removeEventListener(CLOSE_MENUS, fn);
}

/** This menu is opening: close the others, then close it when the next one opens (or the app is covered). */
export function claimMenu(close: () => void): () => void {
  closeAnchoredMenus();
  const token = {};
  claimed.add(token);
  const off = onCloseMenus(close);
  return () => { claimed.delete(token); off(); };
}

/** `claimMenu` for a menu component's lifetime; `onClose` may be a fresh closure on every render. */
export function useMenuClaim(onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => claimMenu(() => ref.current()), []);
}

/**
 * A plain dropdown whose open state lives in its owner (the group bar's layout presets, a tab strip's +, the dock
 * rail's panel list, the Git view's branches, the file tree's right-click menu): while `open` it is the one anchored
 * menu app-wide, and it closes on a mouse-down outside `box` (the toggle button belongs inside it: its own click
 * toggles), on Esc — that key goes no further, wherever the focus is (not to the composer, which would stop a running
 * turn, nor to the sidebar's multi-select) — and when another menu opens or the settings page covers the app.
 */
export function useDropdown(open: boolean, close: () => void, box: RefObject<HTMLElement | null>): void {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!open) return;
    const shut = () => ref.current();
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) shut(); };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || imeComposing(e)) return;
      e.preventDefault();
      // immediate: a window capture listener added after this one (the sidebar's multi-select) must not see the key
      // after React has already released this menu's claim
      e.stopImmediatePropagation();
      shut();
    };
    document.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', esc, true);
    const release = claimMenu(shut);
    return () => { document.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', esc, true); release(); };
  }, [open]);
}
