import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from '@/util';
import { placeMenu, samePlacement, type Placement } from '@/features/models/place';
import { fieldStep, menuKey } from './dir-menu';
import { onCloseMenus } from '@/ui/menus';

const FIELD_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Escape', 'Tab']);

/**
 * A composer menu (the + menu, the permission menu, the branch menu — and the right panel's 「更多」 / 审阅 scope / ···
 * menus): portalled to <body> with fixed coordinates next
 * to its chip — a pane's `overflow: hidden` would clip it otherwise — on whichever side has more room (placeMenu),
 * following the chip when the composer grows or the pane is resized. Closes on a click outside (the chip's own
 * click toggles it), Esc / Tab (focus back to the chip). ↑ ↓ Home End move between the rows (`[data-mi]`; a text
 * field can be one of them); inside a text field ↑ ↓ and Tab / Shift+Tab move on to the rows (a search box goes to
 * the first result after it) — Home / End move the caret.
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
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    const place = () => {
      const r = a.getBoundingClientRect();
      // the chip went away under the menu (the right panel hidden with Ctrl+J, its tab switched, the chip unmounted):
      // close instead of floating at the window's corner
      if (!a.isConnected || (r.width === 0 && r.height === 0)) { closeRef.current(false); return; }
      const next = placeMenu(r, { vw: window.innerWidth, vh: window.innerHeight }, prefer, align, need.current);
      setPos((cur) => (samePlacement(cur, next) ? cur : next));
    };
    placeRef.current = place;
    place();
    const onScroll = (e: Event) => { if (!box.current?.contains(e.target as Node)) place(); };
    const ro = new ResizeObserver(place); // moves the menu, never resizes what it observes
    for (const el of [a, a.closest('.composer'), a.closest('.pane'), a.closest('.dock'), document.body]) if (el) ro.observe(el);
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
    // the focused row went away under the focus (an entry removed from the menu): the focus is on <body>, out of the
    // menu's own key handling — Esc still closes the menu (and hands the focus back to the chip)
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const a = document.activeElement;
      if (a && a !== document.body && a !== document.documentElement) return;
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    const offCover = onCloseMenus(() => onClose(false)); // the settings page opening over the app
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); offCover(); };
  }, [anchor, onClose]);
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const field = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
    // in a text field only ↑ ↓ Tab (on to the rows) and Esc belong to the menu; Home / End / typing stay the field's
    if (field && (e.nativeEvent.isComposing || !FIELD_KEYS.has(e.key))) return;
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('[data-mi]:not(:disabled)') ?? [])];
    // Tab in a text field moves on like ↓ (Shift+Tab like ↑) instead of closing the menu mid-search
    const key = field && e.key === 'Tab' ? (e.shiftKey ? 'ArrowUp' : 'ArrowDown') : e.key;
    const idx = rows.indexOf(document.activeElement as HTMLElement);
    if (field && idx < 0 && (key === 'ArrowDown' || key === 'ArrowUp')) {
      // a search box that is not a row: the first result after it, not the 返回 button before it
      const before = rows.filter((r) => t.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_PRECEDING).length;
      const next = fieldStep(key === 'ArrowDown' ? 'down' : 'up', before, rows.length);
      e.preventDefault();
      e.stopPropagation();
      if (next !== null) rows[next]?.focus();
      return;
    }
    const act = menuKey(key, idx, rows.length);
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
