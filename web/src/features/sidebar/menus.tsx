import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { claimMenu } from '@/ui/menus';
import { useLeaveGhost } from '@/ui/ghost';
import { byPointer } from '@/ui/input-intent';
import { MENU_OUT_MS } from '@/ui/menu-motion';
import { ActionSheet, useSheetMenu } from '@/ui/ActionSheet';
import { placeFixed, spotOrigin } from './place';

/** On a phone the sidebar is a drawer over the page: after an action it gets out of the way of what the action did. */
export const closeDrawer = () => { if (useStore.getState().mobile) useStore.setState({ sidebarOpen: false }); };

/**
 * Position a menu rendered inside its anchor (the parent element) fixed to the viewport, and close it on a click
 * elsewhere, a right-click elsewhere, Escape, or a scroll that moves the anchor. A streaming chat in another pane
 * (auto-scroll) or a scrolling list elsewhere leaves it open. Inside the sidebar the menu follows its anchor when
 * the list above it changes (the 「已筛选」 row appears while typing in the filter box, a pinned row is filtered out…).
 *
 * It scales in from its anchor (`--menu-origin`, from where it was placed) unless the keyboard opened it (`data-kb`),
 * and fades out when the pointer closes it (an inert copy, ui/ghost.ts) — UI refresh §4.5.
 *
 * On a phone the menu is an action sheet from the bottom (UI refresh §8): its root is rendered inside `MenuHost`,
 * which puts it in the sheet (ui/ActionSheet.tsx) — nothing is placed and nothing anchors it, so only Escape, a
 * click that reaches the window and another menu's claim are left here; the scrim, 取消, the handle and the system's
 * back are the sheet's.
 */
export function useAnchoredMenu(ref: React.RefObject<HTMLElement | null>, onClose: () => void, o: { align?: 'left' | 'right'; prefer?: 'down' | 'up'; side?: 'right'; deps?: unknown[] } = {}) {
  const opts = useRef(o);
  opts.current = o;
  const sheet = useSheetMenu();
  // decided as the menu mounts: a click handler mounts it within the same task as the pointer event
  const [kb] = useState(() => !byPointer());
  useLayoutEffect(() => {
    if (sheet) return;
    const el = ref.current, anchor = el?.parentElement;
    if (!el || !anchor) return;
    if (kb) el.dataset.kb = '';
    const place = () => {
      Object.assign(el.style, { position: 'fixed', right: 'auto', bottom: 'auto', maxHeight: '' });
      const a = anchor.getBoundingClientRect(), size = { w: el.offsetWidth, h: el.scrollHeight };
      const spot = placeFixed(a, size, { vw: window.innerWidth, vh: window.innerHeight }, opts.current);
      el.style.left = `${spot.left}px`;
      el.style.top = `${spot.top}px`;
      if (spot.maxHeight) el.style.maxHeight = `${spot.maxHeight}px`;
      el.style.setProperty('--menu-origin', spotOrigin(a, spot, size, opts.current));
    };
    place();
    // rows inserted / removed above the anchor move it without a scroll or a resize of the anchor itself
    const scope = anchor.closest('.sidebar');
    let raf = 0;
    const again = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
    const mo = scope ? new MutationObserver(again) : null;
    mo?.observe(scope!, { childList: true, subtree: true });
    window.addEventListener('resize', again);
    return () => { mo?.disconnect(); cancelAnimationFrame(raf); window.removeEventListener('resize', again); };
  }, o.deps ?? []);
  useLeaveGhost(() => ref.current, () => (!sheet && byPointer() ? { ms: MENU_OUT_MS, className: 'leaving' } : null), []);
  // parents pass a fresh closure every render; the listeners below must not re-subscribe for that
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onScroll = (e: Event) => {
      const anchor = ref.current?.parentElement;
      const t = e.target as Node | null;
      if (!anchor || !t || ref.current?.contains(t)) return;
      if (t === document || (t as Node).contains?.(anchor)) closeRef.current();
    };
    const k = () => closeRef.current();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); } };
    // a sheet has no anchor a scroll could move (its parent is the sheet's own scrolling body), and a long press on
    // it — the one that opened it may still be down — is a `contextmenu` on a phone, not a wish to close it
    if (!sheet) {
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('contextmenu', k, true);
    }
    window.addEventListener('click', k);
    window.addEventListener('keydown', esc, true);
    // the one anchored menu app-wide: close the others (the header ···, a composer / right-panel popover…); the next
    // one to open, or the settings page covering the app, closes this one
    const offClaim = claimMenu(k);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('click', k); window.removeEventListener('contextmenu', k, true); window.removeEventListener('keydown', esc, true); offClaim(); };
  }, []);
}

/**
 * Where the root element of a `useAnchoredMenu` menu is drawn: in place on a desktop (inside its anchor, fixed next
 * to it by the hook); on a phone inside an action sheet in <body> — the sidebar drawer is a transformed,
 * overflow-hidden box, nothing fixed inside it gets out. `children` is exactly the menu's root element.
 */
export function MenuHost({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const sheet = useSheetMenu();
  return sheet ? <ActionSheet onClose={onClose}>{children}</ActionSheet> : <>{children}</>;
}

/** A sidebar popover menu (filter / automation / project / account): `.menu` fixed next to its parent element. */
export function Menu({ onClose, className, align, prefer, side, label, children }: { onClose: () => void; className?: string; align?: 'left' | 'right'; prefer?: 'down' | 'up'; side?: 'right'; label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useAnchoredMenu(ref, onClose, { align, prefer, side });
  const sheet = useSheetMenu();
  // (a phone: a long press in the filter box is its paste menu — the only way to paste there)
  const onContextMenu = (e: React.MouseEvent) => { if (!(sheet && (e.target as Element).tagName === 'INPUT')) e.preventDefault(); e.stopPropagation(); };
  return (
    <MenuHost onClose={onClose}>
      <div ref={ref} role="menu" aria-label={label} title="" className={clsx('menu sb-menu', className)} onClick={(e) => e.stopPropagation()} onContextMenu={onContextMenu}>
        {children}
      </div>
    </MenuHost>
  );
}
