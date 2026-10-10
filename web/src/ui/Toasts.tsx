import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { mergeToasts, stackToasts, type ToastEntry } from './toast-stack';
import { reducedMotion } from './input-intent';

/** floating.css: `.toast.out` runs its exit keyframes for 200ms; the entry is dropped a moment after. */
const OUT_MS = 200;
/** The others making room: the sheet curve (tokens.css `--ease-sheet`), as long as the stack's own scale transition. */
const SLIDE_MS = 260;
const SLIDE_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * One toast: an ink pill (UI refresh §6). `ok` gets a tick, anything else the alert mark — the store has just these
 * two kinds. (One line of text is a pill; text that wraps — a failure with its explanation on top and the original
 * underneath — comes out a rounded card: the radius is the stylesheet's, see `.toast`.)
 */
function Toast({ t, depth, hidden }: { t: ToastEntry; depth: number; hidden: boolean }) {
  return (
    <div className={clsx('toast', t.ok && 'ok', t.out && 'out', hidden && 'over')} style={{ '--depth': depth } as CSSProperties} aria-hidden={hidden || t.out ? true : undefined}>
      <Icon name={t.ok ? 'check' : 'alert'} size={14} className="toast-ic" />
      <span className="toast-t">{t.text}</span>
    </div>
  );
}

/**
 * The toasts (store `toasts`, added by `toast(text, ok?, ms?)` and removed by it after `ms`): top centre of the main
 * column, the newest lowest and in front; at most three on screen, the older ones stacked above it and a little smaller, the rest waiting
 * behind them (`toast-stack.ts`). A toast gone from the store stays for its 200ms exit. They never take a click:
 * what is under them stays usable.
 */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const [list, setList] = useState<ToastEntry[]>(() => mergeToasts([], toasts));
  const [seen, setSeen] = useState(toasts);
  // derived state: the store's list changed → merge it in during this render (no frame with a toast missing)
  if (seen !== toasts) {
    setSeen(toasts);
    setList((prev) => mergeToasts(prev, toasts));
  }
  // every leaving toast is dropped once its exit has played
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    for (const t of list) {
      if (!t.out || timers.current.has(t.id)) continue;
      timers.current.set(t.id, setTimeout(() => {
        timers.current.delete(t.id);
        setList((prev) => prev.filter((x) => x.id !== t.id));
      }, OUT_MS + 20));
    }
  }, [list]);
  useEffect(() => () => { for (const h of timers.current.values()) clearTimeout(h); timers.current.clear(); }, []);
  // a toast arriving under the others (or one above them gone) moves them: they slide to their new place instead of
  // jumping there. Positions are layout numbers from the stack's top edge — that edge is the one that stays put
  const wrap = useRef<HTMLDivElement>(null);
  const places = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    const w = wrap.current;
    const next = new Map<number, number>();
    const still = reducedMotion();
    list.forEach((t, i) => {
      const el = w?.children[i] as HTMLElement | undefined;
      if (!w || !el || !el.offsetHeight) return;
      const at = el.offsetTop;
      next.set(t.id, at);
      const was = places.current.get(t.id);
      if (was !== undefined && was !== at && !still && typeof el.animate === 'function') el.animate([{ translate: `0 ${was - at}px` }, { translate: '0 0' }], { duration: SLIDE_MS, easing: SLIDE_EASE });
    });
    places.current = next;
  });
  if (!list.length) return null;
  const stack = stackToasts(list);
  return (
    <div className="toast-wrap" ref={wrap}>
      {list.map((t, i) => <Toast key={t.id} t={t} depth={stack[i].depth} hidden={stack[i].hidden} />)}
    </div>
  );
}
