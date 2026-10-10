/**
 * A phone's sidebar drawer follows the finger (UI refresh §8 侧栏抽屉): a swipe to the right on the conversation
 * brings it in, a swipe to the left on the drawer or its backdrop pushes it out; letting go lands it open or shut
 * (`drawer-gesture.ts`, pure).
 *
 * `store.sidebarOpen` means what it always did — it turns true only when a release (or a tap) decides 「open」. The
 * sidebar is unmounted while that is false, so two things keep it in the document a little longer
 * (`usePhoneDrawer.held`, read by App): the finger pulling it in (a peek — mounted the moment the swipe takes over),
 * and the slide out after it was closed. Fully open it carries no transform at all: the menus inside it are
 * `position: fixed`, and a transformed ancestor would become what they are fixed to.
 *
 * Touch only. The conversation's `touch-action` (`styles/phone-sheet.css`) leaves sideways moves to the page and
 * keeps up-and-down scrolling the browser's; the pointer is taken away (pointercancel) when the browser scrolls, and
 * the gesture ends there. A conversation that itself scrolls sideways (a wide table) cannot open the drawer: the
 * same swipe pans it instead (`pan` below — the browser no longer does, since sideways moves are ours there).
 */
import { create } from 'zustand';
import { flushSync } from 'react-dom';
import { useStore } from '@/store';
import { anchoredMenuOpen } from './menus';
import { byPointer, reducedMotion } from './input-intent';
import { noteSample, releaseVelocity, type DragSample } from './drag-velocity';
import { DRAWER_EDGE_PX, DRAWER_TAKE_PX, closeRelease, closeTakeover, drawerDim, drawerShift, drawerWidth, openRelease, openTakeover } from './drawer-gesture';
import { LONG_PRESS_MS, OWN_TOUCH, TEXT_FIELDS, holdStill, letSettle, sidewaysScroller, slideFrom, tokenMs } from './touch-dom';

/** The sidebar stays mounted although `sidebarOpen` is false: a finger is pulling it in, or it is sliding shut. */
export const usePhoneDrawer = create<{ held: boolean }>(() => ({ held: false }));

type AppState = ReturnType<typeof useStore.getState>;

/** Where an opening swipe may not start (besides text fields and whatever takes a touch itself). */
const NO_SWIPE = `${OWN_TOUCH}, .starters, .auto-page, [data-no-swipe]`;
/** The scrollers whose sideways moves are ours (the style sheet's `touch-action: pan-y`): a wide one is panned by hand. */
const OURS = '.chat, .welcome';
/** Something modal lies over the conversation. */
const OVER_APP = '.dialog-bg, .viewer';
/** The finger has left the spot it went down on. */
const MOVED_PX = 8;

function elementOf(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

/** May a swipe that starts on `t` open the drawer? (the store's side of it; where on the screen is the caller's) */
function swipeOpens(s: AppState, t: Element): boolean {
  if (s.settingsOpen || s.paletteOpen || s.shortcutsOpen || s.sheetAt > 0) return false;
  return !!t.closest('.pane-layer') && !t.closest(NO_SWIPE) && !document.querySelector(OVER_APP);
}

/**
 * SidebarColumn, in a layout effect, when it has just been mounted: a drawer a tap opened slides in from the left
 * (one a swipe pulled in is under the finger already; what the keyboard opens is simply there).
 */
export function drawerEnter(el: HTMLElement): void {
  const s = useStore.getState();
  if (!s.mobile || !s.sidebarOpen || reducedMotion() || !byPointer()) return;
  slideFrom(el, 'translate3d(-100%, 0, 0)');
}

interface Gesture {
  mode: 'open' | 'close' | 'pan';
  id: number;
  x0: number;
  y0: number;
  /** when the finger went down, and whether it has left the spot since */
  t0: number;
  moved: boolean;
  taken: boolean;
  /** where the finger was (dx) when the drawer took over: it moves by what the finger travels from there */
  dx0: number;
  width: number;
  samples: DragSample[];
  /** `pan`: the conversation that scrolls sideways, and where it was */
  scroller?: HTMLElement;
  left0?: number;
}

/** Wire the drawer's gestures and its slide out to the app element; returns the undo. */
export function installPhoneDrawer(app: HTMLElement): () => void {
  const sidebar = () => app.querySelector<HTMLElement>(':scope > .sidebar.has-resizer');
  const backdrop = () => app.querySelector<HTMLElement>(':scope > .drawer-backdrop');
  let g: Gesture | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // ---- staying in the document while it slides out
  const letGo = () => {
    clearTimeout(timer);
    timer = undefined;
    if (usePhoneDrawer.getState().held) usePhoneDrawer.setState({ held: false });
  };
  const hold = () => {
    clearTimeout(timer);
    if (!usePhoneDrawer.getState().held) usePhoneDrawer.setState({ held: true });
    // the transition's end lets go; the timer is for a window that is not being drawn
    timer = setTimeout(letGo, tokenMs('--dur-base', 180) + 150);
  };
  const onSlid = (e: TransitionEvent) => {
    if (e.propertyName === 'transform' && !g && e.target === sidebar() && !useStore.getState().sidebarOpen) letGo();
  };
  const settle = () => { letSettle(sidebar()); letSettle(backdrop()); };

  // ---- the gesture
  const stop = () => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    if (g?.taken) { try { app.releasePointerCapture(g.id); } catch { /* released already */ } }
    g = null;
  };
  /** the drawer follows the finger from here on; false when there is nothing to move */
  const take = (dx: number): boolean => {
    if (!g) return false;
    if (g.mode === 'open') {
      // a peek: the sidebar is mounted now, at its resting place out of sight
      clearTimeout(timer);
      timer = undefined;
      flushSync(() => usePhoneDrawer.setState({ held: true }));
    }
    const el = sidebar();
    if (!el) { stop(); return false; }
    g.taken = true;
    g.dx0 = dx;
    g.width = el.getBoundingClientRect().width || drawerWidth(window.innerWidth);
    holdStill(el);
    holdStill(backdrop());
    try { app.setPointerCapture(g.id); } catch { /* the pointer is gone */ }
    return true;
  };
  const follow = (dx: number) => {
    const el = sidebar();
    if (!g || !el) return;
    const x = drawerShift(g.mode === 'open' ? 'open' : 'close', dx - g.dx0, g.width);
    el.style.transform = `translate3d(${x}px, 0, 0)`;
    const b = backdrop();
    if (b) b.style.opacity = String(drawerDim(x, g.width));
  };
  /** the finger let go (or the gesture was taken away): the drawer goes where it belongs */
  const land = (open: boolean) => {
    const s = useStore.getState();
    if (s.sidebarOpen !== open) flushSync(() => useStore.setState({ sidebarOpen: open }));
    // shut: it stays in the document until it has slid out (with no motion there is nothing to wait for)
    if (!open) { if (reducedMotion()) letGo(); else hold(); }
    settle();
  };

  const onMove = (e: PointerEvent) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.moved) {
      if (Math.abs(dx) < MOVED_PX && Math.abs(dy) < MOVED_PX) return;
      // a long press that then moves is selecting text (or about to open a row's menu), not swiping
      if (e.timeStamp - g.t0 > LONG_PRESS_MS) { stop(); return; }
      g.moved = true;
    }
    if (g.mode === 'pan') {
      // the conversation scrolls sideways: once the move is more sideways than not, the swipe pans it
      if (!g.taken) {
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) >= DRAWER_TAKE_PX) { stop(); return; }
        if (Math.abs(dx) < DRAWER_TAKE_PX || Math.abs(dx) <= Math.abs(dy)) return;
        g.taken = true;
        g.dx0 = dx;
        try { app.setPointerCapture(g.id); } catch { /* the pointer is gone */ }
      }
      if (g.scroller) g.scroller.scrollLeft = (g.left0 ?? 0) - (dx - g.dx0);
      return;
    }
    if (!g.taken) {
      const v = g.mode === 'open' ? openTakeover({ startX: g.x0, dx, dy }) : closeTakeover({ dx, dy });
      if (v === 'no') { stop(); return; }
      if (v === 'wait' || !take(dx)) return;
    }
    noteSample(g.samples, e.timeStamp, e.clientX);
    follow(dx);
  };
  const onUp = (e: PointerEvent) => {
    if (!g || e.pointerId !== g.id) return;
    const cur = g;
    stop();
    if (!cur.taken || cur.mode === 'pan') return;
    noteSample(cur.samples, e.timeStamp, e.clientX);
    const dx = e.clientX - cur.x0;
    const vx = releaseVelocity(cur.samples, e.timeStamp);
    land((cur.mode === 'open' ? openRelease({ dx, vx }) : closeRelease({ dx: dx - cur.dx0, vx, width: cur.width })) === 'open');
  };
  const onCancel = (e: PointerEvent) => {
    if (!g || e.pointerId !== g.id) return;
    const cur = g;
    stop();
    // taken away mid-swipe: back where it was
    if (cur.taken && cur.mode !== 'pan') land(cur.mode === 'close');
  };
  const onDown = (e: PointerEvent) => {
    if (g || !e.isPrimary || e.pointerType !== 'touch') return;
    const s = useStore.getState();
    const t = elementOf(e.target);
    if (!s.mobile || !t || anchoredMenuOpen()) return;
    let mode: Gesture['mode'];
    let scroller: HTMLElement | undefined;
    if (s.sidebarOpen) {
      if (!t.closest('.sidebar, .drawer-backdrop') || t.closest(TEXT_FIELDS)) return;
      mode = 'close';
    } else {
      if (e.clientX <= DRAWER_EDGE_PX || !swipeOpens(s, t)) return;
      const wide = sidewaysScroller(t, app);
      if (wide && !wide.matches(OURS)) return; // a code block, a table of its own, a diff: the browser scrolls it
      mode = wide ? 'pan' : 'open';
      scroller = wide ?? undefined;
    }
    g = { mode, id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, moved: false, taken: false, dx0: 0, width: 0, samples: [], scroller, left0: scroller?.scrollLeft };
    // (capture, on the window: nothing between here and there can keep a move or the release from arriving)
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
  };

  // ---- closed by anything else (the backdrop, a row picked, the back gesture): it slides out before it goes
  const off = useStore.subscribe((s, p) => {
    if (s.sidebarOpen === p.sidebarOpen && s.mobile === p.mobile) return;
    if (!s.mobile || s.sidebarOpen) { letGo(); return; }
    if (p.sidebarOpen && p.mobile && !g && !reducedMotion()) hold();
  });

  app.addEventListener('pointerdown', onDown);
  app.addEventListener('transitionend', onSlid);
  return () => {
    off();
    stop();
    app.removeEventListener('pointerdown', onDown);
    app.removeEventListener('transitionend', onSlid);
    settle();
    letGo();
  };
}
