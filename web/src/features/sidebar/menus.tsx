import { useEffect, useLayoutEffect, useRef } from 'react';
import { clsx } from '@/util';
import { placeFixed } from './place';

/**
 * Position a menu rendered inside its anchor (the parent element) fixed to the viewport, and close it on a click
 * elsewhere, a right-click elsewhere, Escape, or a scroll that moves the anchor. A streaming chat in another pane
 * (auto-scroll) or a scrolling list elsewhere leaves it open.
 */
export function useAnchoredMenu(ref: React.RefObject<HTMLElement | null>, onClose: () => void, o: { align?: 'left' | 'right'; prefer?: 'down' | 'up'; deps?: unknown[] } = {}) {
  useLayoutEffect(() => {
    const el = ref.current, anchor = el?.parentElement;
    if (!el || !anchor) return;
    Object.assign(el.style, { position: 'fixed', right: 'auto', bottom: 'auto', maxHeight: '' });
    const spot = placeFixed(anchor.getBoundingClientRect(), { w: el.offsetWidth, h: el.scrollHeight }, { vw: window.innerWidth, vh: window.innerHeight }, o);
    el.style.left = `${spot.left}px`;
    el.style.top = `${spot.top}px`;
    if (spot.maxHeight) el.style.maxHeight = `${spot.maxHeight}px`;
  }, o.deps ?? []);
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
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('click', k);
    window.addEventListener('contextmenu', k, true);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('click', k); window.removeEventListener('contextmenu', k, true); window.removeEventListener('keydown', esc, true); };
  }, []);
}

/** A sidebar popover menu (filter / automation / project / account): `.menu` fixed next to its parent element. */
export function Menu({ onClose, className, align, prefer, label, children }: { onClose: () => void; className?: string; align?: 'left' | 'right'; prefer?: 'down' | 'up'; label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useAnchoredMenu(ref, onClose, { align, prefer });
  return (
    <div ref={ref} role="menu" aria-label={label} title="" className={clsx('menu sb-menu', className)} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {children}
    </div>
  );
}
