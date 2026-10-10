// An exit animation for something React unmounts at once (UI refresh §4.5: menus leave in 120ms, a docked card in
// 180ms). The real element is gone the moment its owner closes it — every close path (outside click, Esc, another
// menu's claim, the anchor disappearing, the settings page covering the app), the focus hand-back and the one-menu
// rule work exactly as before. What fades out is an inert copy of it, put where it was for the length of the
// animation: no pointer events, hidden from assistive tech, no ids, and removed when the animation ends.
//
// `useLeaveGhost` takes the copy in its layout-effect cleanup, while the element is still in the document with its
// scroll offsets (React runs a deleted component's cleanups before it removes its DOM nodes), and decides a
// microtask later whether this was a real unmount: under StrictMode (development) effects are torn down and set up
// again right after mounting, and a dependency change does the same — the hook is alive again by then, no copy.
import { useLayoutEffect, useRef } from 'react';
import { floatBox, ghostClass, type GhostOpts } from './ghost-box';
import { reducedMotion } from './input-intent';

export type { GhostOpts };

interface Snapshot {
  clone: HTMLElement;
  parent: Node;
  next: Node | null;
  /** [index among the element and its descendants, scrollTop, scrollLeft] of everything that was scrolled */
  scrolls: [number, number, number][];
  box: { left: number; bottom: number; width: number } | null;
}

function snapshot(node: HTMLElement, o: GhostOpts): Snapshot | null {
  const parent = node.parentNode;
  if (!parent || !node.isConnected) return null;
  const all = [node, ...node.querySelectorAll<HTMLElement>('*')];
  const scrolls: Snapshot['scrolls'] = [];
  all.forEach((el, i) => { if (el.scrollTop || el.scrollLeft) scrolls.push([i, el.scrollTop, el.scrollLeft]); });
  const clone = node.cloneNode(true) as HTMLElement;
  // what was typed is a property, not an attribute: a clone would show the box empty
  const fields = clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach((f, i) => { if (fields[i]) fields[i].value = f.value; });
  const op = node.offsetParent as HTMLElement | null;
  return { clone, parent, next: node.nextSibling, scrolls, box: o.float && op ? floatBox(node, op.clientHeight) : null };
}

function spawn(s: Snapshot, o: GhostOpts): void {
  if (!s.parent.isConnected || (o.float && !s.box)) return;
  const g = s.clone;
  g.className = ghostClass(g.className, o);
  for (const el of [g, ...g.querySelectorAll<HTMLElement>('[id]')]) el.removeAttribute('id');
  if (o.strip) g.querySelectorAll(o.strip).forEach((el) => el.remove());
  for (const a of ['role', 'aria-label', 'aria-labelledby', 'aria-live', 'tabindex', 'data-request']) g.removeAttribute(a);
  g.setAttribute('aria-hidden', 'true');
  g.setAttribute('inert', '');
  if (s.box) {
    // out of the flow, so its place among its siblings does not matter to the layout — at the end, where it does
    // not come between two siblings a stylesheet styles as neighbours (the run card and the composer's box)
    Object.assign(g.style, { position: 'absolute', left: `${s.box.left}px`, bottom: `${s.box.bottom}px`, width: `${s.box.width}px`, top: 'auto', right: 'auto', margin: '0' });
    s.parent.appendChild(g);
  } else s.parent.insertBefore(g, s.next && s.next.parentNode === s.parent ? s.next : null);
  const all = [g, ...g.querySelectorAll<HTMLElement>('*')];
  for (const [i, top, left] of s.scrolls) { const el = all[i]; if (el) { el.scrollTop = top; el.scrollLeft = left; } }
  const done = () => g.remove();
  g.addEventListener('animationend', (e) => { if (e.target === g) done(); });
  setTimeout(done, o.ms + 80);
}

/**
 * Leave a fading copy of `get()`'s element behind when the component unmounts. `when` is asked at that moment: the
 * options, or `null` for no exit animation (a keyboard close). `deps`: when the element appears (a menu that renders
 * on its second pass passes that flag). Nothing happens with 减少动态效果.
 */
export function useLeaveGhost(get: () => HTMLElement | null, when: () => GhostOpts | null, deps: readonly unknown[]): void {
  const alive = useRef(0);
  const whenRef = useRef(when);
  whenRef.current = when;
  useLayoutEffect(() => {
    const node = get();
    if (!node) return;
    alive.current++;
    return () => {
      alive.current--;
      const o = whenRef.current();
      if (!o || reducedMotion()) return;
      const snap = snapshot(node, o);
      if (snap) queueMicrotask(() => { if (alive.current <= 0) spawn(snap, o); });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
