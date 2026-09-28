import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from '@/util';
import { placePopover } from './popover-place';

type Pos = ReturnType<typeof placePopover>;
const same = (a: Pos | null, b: Pos) => !!a && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.width === b.width && a.maxHeight === b.maxHeight;

/**
 * A menu hanging from a button in the right panel (the 「更多」 menu, 审阅's scope and ··· menus), portalled to
 * <body> with fixed coordinates (`placePopover`): the panel's `overflow: hidden` clipped them, and the tab row is a
 * title-bar drag region on the desktop. Closes on a click outside it and its anchor (the anchor's own click
 * toggles) and on Esc; follows the anchor when the window or the panel resizes.
 */
export function Popover({ anchor, open, onClose, width, align, className, label, onClick, children }: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  width: number;
  align: 'left' | 'right';
  className?: string;
  label?: string;
  /** e.g. close after any item was picked */
  onClick?: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const a = anchor.current;
    if (!open || !a) { setPos(null); return; }
    const place = () => {
      const next = placePopover(a.getBoundingClientRect(), { vw: window.innerWidth, vh: window.innerHeight }, { width, align });
      setPos((cur) => (same(cur, next) ? cur : next));
    };
    place();
    // (a frame later: placing it never resizes what is observed, but the panel's own layout may still be settling)
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); });
    ro.observe(a.closest('.dock, .pane') ?? document.body);
    window.addEventListener('resize', place);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', place); };
  }, [open, width, align, anchor]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      closeRef.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, anchor]);

  if (!open || !pos) return null;
  return createPortal(
    <div ref={box} className={clsx('menu', 'rp-pop', className)} style={pos} role="menu" aria-label={label} onClick={onClick}>
      {children}
    </div>,
    document.body,
  );
}
