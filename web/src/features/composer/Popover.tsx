import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from '@/util';
import { placeMenu, samePlacement, type Placement } from '@/features/models/place';
import { menuKey } from './dir-menu';

/**
 * A composer menu (the + menu, the permission menu, the branch menu): portalled to <body> with fixed coordinates next
 * to its chip — a pane's `overflow: hidden` would clip it otherwise — on whichever side has more room (placeMenu),
 * following the chip when the composer grows or the pane is resized. Closes on a click outside (the chip's own
 * click toggles it), Esc / Tab (focus back to the chip). ↑ ↓ Home End move between the rows (`[data-mi]`), but not
 * inside a text field.
 */
export function Popover({ anchor, onClose, prefer = 'up', align = 'left', className, label, children, role = 'menu' }: {
  anchor: RefObject<HTMLElement | null>;
  onClose: (refocus: boolean) => void;
  prefer?: 'up' | 'down';
  align?: 'left' | 'right';
  className?: string;
  label: string;
  role?: 'menu' | 'dialog';
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placement | null>(null);
  // the menu's natural height, measured once after the first paint: it then opens where it fits (and keeps that
  // side — a menu that jumps while you use it is worse than one that scrolls)
  const need = useRef<number | undefined>(undefined);
  const placeRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    const place = () => {
      const next = placeMenu(a.getBoundingClientRect(), { vw: window.innerWidth, vh: window.innerHeight }, prefer, align, need.current);
      setPos((cur) => (samePlacement(cur, next) ? cur : next));
    };
    placeRef.current = place;
    place();
    const onScroll = (e: Event) => { if (!box.current?.contains(e.target as Node)) place(); };
    const ro = new ResizeObserver(place); // moves the menu, never resizes what it observes
    for (const el of [a, a.closest('.composer'), a.closest('.pane'), document.body]) if (el) ro.observe(el);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true); };
  }, [anchor, prefer, align]);
  // keep it inside the window horizontally (a right-aligned menu wider than the room to its left)
  useLayoutEffect(() => {
    const el = box.current;
    if (!pos || !el) return;
    if (need.current === undefined) { need.current = el.scrollHeight; placeRef.current?.(); return; }
    const r = el.getBoundingClientRect();
    if (r.left < 8 && pos.right !== undefined) setPos({ ...pos, right: undefined, left: 8 });
    else if (r.right > window.innerWidth - 8 && pos.left !== undefined) setPos({ ...pos, left: undefined, right: 8 });
  }, [pos]);
  // first paint: focus the checked row, else the first one (keyboard users land inside the menu)
  useLayoutEffect(() => {
    if (!pos) return;
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('[data-mi]') ?? [])];
    (rows.find((b) => b.getAttribute('aria-checked') === 'true') ?? rows[0])?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!pos]);
  useEffect(() => {
    const off = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      // a dialog opened from the menu (dlg.prompt) sits outside it: it closes the menu itself
      if ((t as Element).closest?.('.modal-bg, .modal')) return;
      onClose(false);
    };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [anchor, onClose]);
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); }
      return;
    }
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('[data-mi]:not(:disabled)') ?? [])];
    const act = menuKey(e.key, rows.indexOf(document.activeElement as HTMLElement), rows.length);
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    if ('focus' in act) rows[act.focus]?.focus();
    else onClose(act.refocus);
  };
  if (!pos) return null;
  return createPortal(
    <div ref={box} className={clsx('menu cm', className)} style={pos} role={role} aria-label={label} onKeyDown={onKey}>
      {children}
    </div>,
    document.body,
  );
}
