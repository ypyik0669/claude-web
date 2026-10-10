// On a phone every anchored menu is an action sheet from the bottom (UI refresh §8 菜单): the composer's + /
// permission / branch menus and the right panel's 更多 / 审阅 menus (composer/Popover.tsx), the model menu, the project
// menu, the sidebar's menus and the session header's ··· (sidebar/menus.tsx). The menu's own root element and
// everything in it are what they are on a desktop — same rows, same classes, same `data-*`, same key handling; this
// only draws it somewhere else:
//
//   <body>
//     <div class="as-layer [as-in]">           no box of its own (display: contents)
//       <div class="as-scrim">                 z 149 — a tap closes
//       <div class="as-sheet [tall]">          z 150 — fixed to the bottom, slides up
//         <div class="as-grab"><i></div>       the handle: drag down to close
//         <div class="as-body">{the menu}</div>   scrolls
//         <div class="as-foot"><button class="as-cancel">取消</button></div>
//
// In <body> because nothing may clip or transform it (the sidebar drawer is a transformed, overflow-hidden box).
// It closes the way the menu always did (a row chosen, Esc, another menu's claim) and by its own means: the scrim,
// 取消, a drag on the handle (ui/action-sheet.ts) and the system's back gesture (ui/back-layer.ts).
// Styles: styles/phone-menus.css.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dragVelocity, sheetOffset, sheetRelease, sheetScrim } from './action-sheet';
import { pushBackLayer } from './back-layer';
import { useLeaveGhost, type GhostOpts } from './ghost';
import { imeComposing } from './ime';
import { byPointer } from './input-intent';

/** phone-menus.css: `.as-leaving` slides the sheet away for this long (--dur-slow). */
export const SHEET_OUT_MS = 240;
const SHEET_GHOST: GhostOpts = { ms: SHEET_OUT_MS, className: 'as-leaving' };
/** A pointer press this recent is what opened the sheet: a long press opens it 500ms after the finger came down. */
const OPENED_BY_POINTER_MS = 1500;

/**
 * Is this menu a sheet? On a phone (`store.mobile`) — decided when the menu mounts and kept for its life: a window
 * narrowed or widened under an open menu does not re-mount it as the other kind.
 */
export function useSheetMenu(): boolean {
  const [sheet] = useState(() => useStore.getState().mobile);
  return sheet;
}

const isField = (el: Element | null): boolean => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

// The sheet is a portal: React would hand what happens on it to the menu's React parents (a sidebar row that opens
// its conversation on a click, a tab row that drags the bottom sheet…), and the browser to listeners on document
// (an outside-press that closes the menu before the scrim's own click). Nothing that happens on the layer leaves it.
const stop = (e: SyntheticEvent) => e.stopPropagation();
const SEAL = {
  onClick: stop, onDoubleClick: stop, onAuxClick: stop, onMouseDown: stop, onMouseUp: stop,
  onPointerDown: stop, onPointerMove: stop, onPointerUp: stop, onPointerCancel: stop,
  onTouchStart: stop, onTouchMove: stop, onTouchEnd: stop, onTouchCancel: stop, onWheel: stop,
  // a long press on the sheet is not the browser's menu (nor the row's under it); a text field keeps its paste menu
  onContextMenu: (e: SyntheticEvent) => { if (!isField(e.target as Element)) e.preventDefault(); e.stopPropagation(); },
};

/**
 * The sheet around a menu's root element (`children`: exactly that element).
 * `onClose(refocus)`: the sheet closing itself — 取消 hands the focus back to what opened the menu (like Esc), the
 * scrim, a drag and the system's back do not (like a press outside).
 * `tall`: up to 92% of the screen instead of 82%, and the menu scrolls inside itself (the model menu's list under its
 * search box, the project menu's folders).
 */
export function ActionSheet({ onClose, tall, children }: { onClose: (refocus: boolean) => void; tall?: boolean; children: ReactNode }) {
  const layer = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** closed by the sheet's own doing: it slides away also when no pointer did it (the back gesture) */
  const own = useRef(false);
  const shut = (refocus: boolean) => { own.current = true; closeRef.current(refocus); };
  // slides up unless the keyboard (or a script) opened it — UI refresh §4.5
  const [entering, setEntering] = useState(() => byPointer(OPENED_BY_POINTER_MS));

  // out: the sheet is unmounted at once like any menu; an inert copy slides down where it was (ui/ghost.ts) when a
  // pointer or the sheet itself closed it. Esc and scripts: simply gone. Never with 减少动态效果.
  useLeaveGhost(() => layer.current, () => (own.current || byPointer() ? SHEET_GHOST : null), []);

  // The system's back gesture closes the sheet instead of leaving the page. The entry is given back a task later, not
  // in the cleanup itself: what the closing tap opens next (the bottom drawer from ··· → 改动, another sheet) pushes its
  // own entry in this same commit, and a history.back() started before a pushState takes that new entry with it
  // (Chrome resolves where back() goes when it is called) — the next back press would then leave the page.
  useEffect(() => {
    const release = pushBackLayer(() => shut(false));
    return () => { setTimeout(release, 0); };
  }, []);

  // Focus: the menu itself, never a text field — a search box that takes the focus brings the keyboard up over half
  // the sheet. The fields are inert until every effect of this mount has run (a filter box that focuses itself in its
  // own effect asks in vain); a tap on one focuses it as usual. On the way out the focus goes back to where it was,
  // unless the owner already put it somewhere or that was a text field (no keyboard popping up behind the sheet).
  const fields = useRef<HTMLElement[]>([]);
  useLayoutEffect(() => {
    const root = layer.current;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = body.current?.firstElementChild as HTMLElement | null;
    fields.current = [...(body.current?.querySelectorAll<HTMLElement>('input, textarea') ?? [])];
    for (const f of fields.current) f.inert = true;
    if (menu) {
      if (!menu.hasAttribute('tabindex')) menu.tabIndex = -1;
      menu.focus({ preventScroll: true });
    }
    return () => {
      for (const f of fields.current) f.inert = false;
      fields.current = [];
      const a = document.activeElement;
      if (prev && prev.isConnected && !isField(prev) && (!a || a === document.body || !!root?.contains(a))) prev.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    // a microtask: after the passive effects of the whole commit (the menu's owner is this component's parent)
    queueMicrotask(() => {
      for (const f of fields.current) f.inert = false;
      fields.current = [];
      const a = document.activeElement;
      if (isField(a) && body.current?.contains(a)) (body.current.firstElementChild as HTMLElement | null)?.focus({ preventScroll: true });
    });
  }, []);

  // the handle: the sheet follows the finger down; let go past 70px or flicked down it closes, else it springs back
  const drag = useRef<{ id: number; y0: number; h: number; samples: { y: number; t: number }[] } | null>(null);
  const grabDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = sheet.current;
    if (!el || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag.current = { id: e.pointerId, y0: e.clientY, h: el.offsetHeight, samples: [{ y: e.clientY, t: e.timeStamp }] };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer is gone already */ }
    setEntering(false); // an entrance still running would out-rank the transform below
    layer.current?.setAttribute('data-drag', '');
  };
  const grabMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !sheet.current) return;
    d.samples.push({ y: e.clientY, t: e.timeStamp });
    if (d.samples.length > 12) d.samples.shift();
    const off = sheetOffset(e.clientY - d.y0);
    sheet.current.style.transform = `translateY(${off}px)`;
    if (scrim.current) scrim.current.style.opacity = String(sheetScrim(off, d.h));
  };
  const grabEnd = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    // closing: the sheet stays where the finger left it — its leaving copy slides on from there
    if (!cancelled && sheetRelease(e.clientY - d.y0, dragVelocity(d.samples, e.timeStamp)) === 'close') { shut(false); return; }
    layer.current?.removeAttribute('data-drag');
    if (sheet.current) sheet.current.style.transform = '';
    if (scrim.current) scrim.current.style.opacity = '';
  };

  // Esc that the menu's own key handling did not take (the focus is on 取消, outside the menu's root): close like Esc
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || imeComposing(e.nativeEvent)) return;
    e.preventDefault();
    e.stopPropagation();
    closeRef.current(true);
  };

  return createPortal(
    <div ref={layer} className={clsx('as-layer', entering && 'as-in')} {...SEAL} onKeyDown={onKeyDown}>
      <div ref={scrim} className="as-scrim" onClick={() => shut(false)} />
      <div ref={sheet} className={clsx('as-sheet', tall && 'tall')} onAnimationEnd={(e) => { if (e.target === e.currentTarget) setEntering(false); }}>
        <div className="as-grab" aria-hidden onPointerDown={grabDown} onPointerMove={grabMove} onPointerUp={(e) => grabEnd(e, false)} onPointerCancel={(e) => grabEnd(e, true)}><i /></div>
        <div ref={body} className="as-body">{children}</div>
        <div className="as-foot"><button type="button" className="as-cancel" onClick={() => shut(true)}>取消</button></div>
      </div>
    </div>,
    document.body,
  );
}
