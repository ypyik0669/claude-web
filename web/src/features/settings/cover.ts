// The settings page covers the whole window while the app stays mounted underneath (nothing may unmount: terminals,
// drafts, editors). Covering is not enough on its own: keyboard focus would stay in the covered composer / editor /
// terminal, so typing would land there unseen, Enter would send, Esc would interrupt a running turn (review C1).
// `coverApp` makes the rest of the app inert while the page is open and gives focus back when it closes.

/** Is this sibling a layer drawn above the page (dialog, palette, toasts…) that must stay usable? */
export function aboveCover(position: string, zIndex: string, coverZ: number): boolean {
  const z = Number(zIndex);
  return position === 'fixed' && Number.isFinite(z) && z > coverZ;
}

/**
 * Make every sibling of `root` inert except layers stacked above it (a dialog asked for from inside the page must
 * work), also for siblings added while open (the sidebar is swapped for a placeholder when it toggles). Returns the
 * cleanup: inert removed from exactly the elements this set it on, then focus back to `restoreTo` when that element
 * is still in the document.
 */
export function coverApp(root: HTMLElement, restoreTo: Element | null): () => void {
  const parent = root.parentElement;
  const set = new Set<Element>();
  const coverZ = Number(getComputedStyle(root).zIndex) || 0;
  const apply = (el: Element) => {
    if (el === root || el.contains(root) || el.hasAttribute('inert')) return;
    const cs = getComputedStyle(el);
    if (aboveCover(cs.position, cs.zIndex, coverZ)) return;
    el.setAttribute('inert', '');
    set.add(el);
  };
  if (parent) for (const el of Array.from(parent.children)) apply(el);
  const mo = parent ? new MutationObserver((recs) => { for (const r of recs) r.addedNodes.forEach((n) => { if (n instanceof Element) apply(n); }); }) : null;
  mo?.observe(parent!, { childList: true });
  return () => {
    mo?.disconnect();
    for (const el of set) el.removeAttribute('inert');
    set.clear();
    if (restoreTo instanceof HTMLElement && restoreTo !== document.body && restoreTo.isConnected) restoreTo.focus({ preventScroll: true });
  };
}
