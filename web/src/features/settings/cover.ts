// The settings page covers the whole window while the app stays mounted underneath (nothing may unmount: terminals,
// drafts, editors). Covering is not enough on its own: keyboard focus would stay in the covered composer / editor /
// terminal, so typing would land there unseen, Enter would send, Esc would interrupt a running turn (review C1).
// `coverApp` makes the rest of the app inert while the page is open and gives focus back when it closes.
import { closeAnchoredMenus } from '@/ui/menus';

/**
 * Layers drawn above the page that stay usable while it covers the app: dialogs (asked for from inside the page),
 * the command palette, the shortcut sheet (`?` / F1 from the page, final review M1: it used to open under the page and
 * show up only after it closed), toasts, the image viewer, crash cards and first-run onboarding. An allow-list rather than
 * "fixed with a higher z-index": the phone's sidebar drawer is fixed at z-index 60 too, and must not float over the
 * page as a live layer (review round 2).
 */
export const ABOVE_COVER = '.dialog-bg, .palette-bg, .shortcuts-bg, .toast-wrap, .viewer, .err-boundary.floating';

/** Is this sibling one of the layers above the page? */
export function aboveCover(el: Element): boolean {
  return el.matches(ABOVE_COVER) || (el.matches('.modal-bg') && !!el.querySelector(':scope > .modal.onboarding'));
}

/**
 * Make every sibling of `root` inert except the layers above it, also siblings added while open (the sidebar is
 * swapped for a placeholder when it toggles); open anchored menus are closed first (a menu portalled to <body> is
 * outside the app). Returns the cleanup: inert removed from exactly the elements this set it on, then focus back to
 * `restoreTo` when that element is still in the document.
 */
export function coverApp(root: HTMLElement, restoreTo: Element | null): () => void {
  closeAnchoredMenus();
  const parent = root.parentElement;
  const set = new Set<Element>();
  const apply = (el: Element) => {
    if (el === root || el.contains(root) || el.hasAttribute('inert') || aboveCover(el)) return;
    el.setAttribute('inert', '');
    set.add(el);
  };
  if (parent) for (const el of Array.from(parent.children)) apply(el);
  const mo = parent ? new MutationObserver((recs) => { for (const r of recs) r.addedNodes.forEach((n) => { if (n.nodeType === 1) apply(n as Element); }); }) : null;
  mo?.observe(parent!, { childList: true });
  return () => {
    mo?.disconnect();
    for (const el of set) el.removeAttribute('inert');
    set.clear();
    const to = restoreTo as HTMLElement | null;
    if (to && typeof to.focus === 'function' && to !== document.body && to.isConnected) to.focus({ preventScroll: true });
  };
}
