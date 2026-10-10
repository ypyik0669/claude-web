import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { clsx } from '@/util';
import { FOLD_MS, foldClass, foldSettle, foldShown, foldTo, type FoldPhase } from './fold-phase';

let systemReduce: MediaQueryList | null | undefined;

/** 「减少动态效果」 — the setting (`<html data-reduce-motion>`) or the system's. */
export function reducedMotion(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.dataset.reduceMotion === '1') return true;
  // one query object for the page: this is asked on every streamed delta
  if (systemReduce === undefined) systemReduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  return !!systemReduce?.matches;
}

/** Whether `el` is in front of the user right now: the window is, and nothing around it is hidden (a background tab, a zoomed-away pane). */
export function onScreen(el: Element | null | undefined): boolean {
  if (!el || typeof document === 'undefined' || document.visibilityState !== 'visible') return false;
  const check = (el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility;
  if (typeof check === 'function') return check.call(el, { visibilityProperty: true, checkVisibilityCSS: true });
  return el.getClientRects().length > 0;
}

/**
 * The phase of a fold (fold-phase.ts) for the wanted state `open`. `animate` is read when `open` changes: whether that
 * change moves or happens at once (never under 「减少动态效果」). Put `ref` (or the caller's own, `at`) on the folding
 * element — its collapsed start is laid out through it before it opens.
 */
export function useFold<T extends HTMLElement = HTMLDivElement>(open: boolean, animate: boolean, at?: RefObject<T | null>): { phase: FoldPhase; ref: RefObject<T | null> } {
  const [want, setWant] = useState(open);
  const [phase, setPhase] = useState<FoldPhase>(open ? 'open' : 'closed');
  if (open !== want) {
    setWant(open);
    setPhase(foldTo(phase, open, animate && !reducedMotion()));
  }
  const own = useRef<T>(null);
  const ref = at ?? own;
  useLayoutEffect(() => {
    if (phase !== 'pre') return;
    ref.current?.getBoundingClientRect(); // lay the collapsed start out: the transition has a height to start from
    setPhase((p) => (p === 'pre' ? foldSettle(p) : p));
  }, [phase]);
  useEffect(() => {
    if (phase !== 'opening' && phase !== 'closing') return;
    // by the clock, not `transitionend`: inside something hidden no transition runs and none would end
    const t = setTimeout(() => setPhase((p) => (p === phase ? foldSettle(p) : p)), FOLD_MS + 40);
    return () => clearTimeout(t);
  }, [phase]);
  return { phase, ref };
}

/**
 * A region that opens and shuts with its height animated. Its content is mounted when it opens and unmounted once it
 * has closed — a closed one costs nothing, and what was inside starts fresh the next time.
 */
export function Fold({ open, animate = true, className, children }: { open: boolean; animate?: boolean; className?: string; children: ReactNode }) {
  const { phase, ref } = useFold(open, animate);
  if (!foldShown(phase)) return null;
  return (
    <div ref={ref} className={clsx('fold', foldClass(phase), className)}>
      <div className="fold-in">{children}</div>
    </div>
  );
}

/**
 * True for `ms` after `on` turned true while mounted — never for one that was already true at mount (history, a
 * conversation switched back to). For a class that plays an animation once: it must not outlive the animation, or the
 * animation plays again whenever something around it is hidden and shown.
 */
export function useJust(on: boolean, ms: number): boolean {
  const [prev, setPrev] = useState(on);
  const [just, setJust] = useState(false);
  if (on !== prev) {
    setPrev(on);
    setJust(on);
  }
  useEffect(() => {
    if (!just) return;
    const t = setTimeout(() => setJust(false), ms);
    return () => clearTimeout(t);
  }, [just, ms]);
  return just;
}

/** A flag decided once, at mount, that turns itself off after `ms` (an entrance — same reason as `useJust`). */
export function useEntrance(decide: () => boolean, ms: number): boolean {
  const [on, setOn] = useState(decide);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on;
}
