/**
 * A phone's right panel is a bottom sheet you can drag (UI refresh §8 抽屉): a handle on top, two detents (半 62%,
 * 全 92% — `store.sheetDetent`), and a release that lands on one of them or puts it away (`sheet-snap.ts`, pure).
 *
 * The sheet is the same element as on a desktop (`.app > .rpanel` with the Dock in it): it is never remounted, so the
 * terminal keeps its pty and buffer. Down = `display: none` (App), exactly as before; what is new is how it gets
 * there and back:
 *  - up: App shows it and calls `sheetEnter` before the first paint — it starts below the screen and its own
 *    transition brings it up (only when a tap opened it: what the keyboard or a script opens is simply there);
 *  - down: it stays displayed while it slides out (`useSheetLeaving`), then App hides it;
 *  - a drag: the handle strip and the tab row take any pointer (`touch-action` there leaves vertical moves to us);
 *    inside a panel a touch that pulls down takes the sheet with it when everything under the finger is scrolled to
 *    its top — never from the terminal, an editor, a text field or something that scrolls sideways. While the finger
 *    has it the element carries `data-drag` and an inline transform (`touch-dom.ts`); the backdrop's opacity follows.
 *
 * Sizes, resting places and transitions: `styles/phone-sheet.css`. With 减少动态效果 there is no transition there, so
 * the same code just puts it where it lands.
 */
import { create } from 'zustand';
import { flushSync } from 'react-dom';
import { hideSheet, useStore } from '@/store';
import { anchoredMenuOpen } from './menus';
import { imeComposing } from './ime';
import { byPointer, reducedMotion } from './input-intent';
import { noteSample, releaseVelocity, type DragSample } from './drag-velocity';
import { sheetDim, sheetSizes, sheetSnap, sheetTravel, type SheetDetent, type SheetSizes } from './sheet-snap';
import { LONG_PRESS_MS, OWN_TOUCH, TEXT_FIELDS, holdStill, letSettle, scrollsSideways, shiftNow, slideFrom, swallowNextClick, tokenMs } from './touch-dom';

/** The sheet has been put away and is still sliding out: App keeps it displayed until it is off the screen. */
export const useSheetLeaving = create<{ leaving: boolean }>(() => ({ leaving: false }));

type AppState = ReturnType<typeof useStore.getState>;
/** up = raised, open, with something to show (the same rule as composer/covered.ts) */
const sheetIsUp = (s: AppState): boolean => s.mobile && s.sheetAt > 0 && s.layout.dock.open && (s.layout.dock.tabs.length > 0 || !!s.inspect);
/** the settings page, the palette and the shortcut sheet lie over it (App hides it meanwhile) */
const sheetCovered = (s: AppState): boolean => !!s.settingsOpen || s.paletteOpen || s.shortcutsOpen;

/** The handle strip and the tab row: a drag that starts there moves the sheet. */
const GRIPS = '.sheet-grip, .dock-tabs';
/** A press becomes a drag after this much, more up-or-down than sideways (less is a tap on a tab). */
const GRIP_SLOP_PX = 10;
/** Inside a panel: this much before the direction of a touch is read. */
const PULL_SLOP_PX = 8;
/** What lies over the sheet takes Esc first. */
const OVER_SHEET = '.dialog-bg, .viewer';

/** set when the sheet comes up from fully down; `sheetEnter` plays it once */
let enterNext = false;

/** App, in a layout effect, when the sheet has just been shown: slide it up from below the screen. */
export function sheetEnter(panel: HTMLElement): void {
  const play = enterNext;
  enterNext = false;
  if (play && !reducedMotion() && byPointer()) slideFrom(panel, 'translate3d(0, 100%, 0)');
}

/**
 * Another detent: the sheet takes its new height at once and slides from where its top edge was to where it now
 * belongs (only the transform moves — a height that animates would resize the terminal on every frame).
 */
function retune(panel: HTMLElement, to: SheetDetent, backdrop: HTMLElement | null = null): void {
  const before = panel.getBoundingClientRect().top;
  holdStill(panel);
  flushSync(() => useStore.setState({ sheetDetent: to }));
  panel.style.transform = '';
  const after = panel.getBoundingClientRect().top;
  panel.style.transform = `translate3d(0, ${before - after}px, 0)`;
  void panel.offsetHeight; // the slide starts here
  letSettle(panel);
  letSettle(backdrop);
}

/** A tap on the handle: 半 ⇄ 全. */
export function toggleSheetDetent(panel: HTMLElement): void {
  const s = useStore.getState();
  if (sheetIsUp(s)) retune(panel, s.sheetDetent === 'half' ? 'full' : 'half');
}

/**
 * With the sheet up, is this key press the one that puts it away — and does nothing else? Not while a menu or a
 * dialog lies over it (one Esc does one thing), and not from the terminal, an editor or a field inside the sheet:
 * Esc is theirs there. From anywhere else — the composer under the sheet included, where Esc would stop a running
 * turn nobody can see — it only closes the sheet.
 */
export function sheetTakesEscape(e: KeyboardEvent): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented || imeComposing(e)) return false;
  if (anchoredMenuOpen() || document.querySelector(OVER_SHEET)) return false;
  const t = elementOf(e.target);
  return !(t && t.closest('.rpanel') && t.closest(`.xterm, .monaco-editor, ${TEXT_FIELDS}`));
}

/** Everything between the touch and the sheet is scrolled to its top, and nothing there takes the touch itself. */
function pullable(target: Element, panel: HTMLElement): boolean {
  if (!target.closest('.dock-body') || target.closest(OWN_TOUCH) || target.closest('[data-no-drag]')) return false;
  for (let el: Element | null = target; el && el !== panel; el = el.parentElement) {
    if (el.scrollTop >= 1 || scrollsSideways(el)) return false;
  }
  return true;
}

/** an event's target as an element (a touch can land on a text node) */
function elementOf(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

interface Pending { kind: 'pointer' | 'touch'; id: number; x: number; y: number; t: number; target: Element }
interface Drag { y0: number; base: number; detent: SheetDetent; sizes: SheetSizes; samples: DragSample[]; pointer?: number }

/**
 * Wire the sheet's gestures and its way out to the panel element; returns the undo. `backdropOf` is the scrim behind
 * it (App's `.sheet-backdrop`).
 */
export function installPhoneSheet(panel: HTMLElement, backdropOf: () => HTMLElement | null): () => void {
  let pend: Pending | null = null;
  let drag: Drag | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;

  // (not with a menu open: one that is fixed inside the sheet would be carried along by the sheet's transform)
  const usable = () => { const s = useStore.getState(); return sheetIsUp(s) && !sheetCovered(s) && !anchoredMenuOpen(); };
  const settle = () => { letSettle(panel); letSettle(backdropOf()); };

  // ---- sliding out
  const stopLeaving = () => {
    clearTimeout(leaveTimer);
    leaveTimer = undefined;
    if (useSheetLeaving.getState().leaving) useSheetLeaving.setState({ leaving: false });
  };
  const startLeaving = () => {
    clearTimeout(leaveTimer);
    if (!useSheetLeaving.getState().leaving) useSheetLeaving.setState({ leaving: true });
    // the transition's end takes it away; the timer is for a window that is not being drawn
    leaveTimer = setTimeout(stopLeaving, tokenMs('--dur-base', 180) + 150);
  };
  const onSlid = (e: TransitionEvent) => {
    if (e.target === panel && e.propertyName === 'transform' && !sheetIsUp(useStore.getState())) stopLeaving();
  };

  // ---- a drag
  const begin = (y: number, t: number, pointer?: number) => {
    const s = useStore.getState();
    const vv = window.visualViewport;
    const room = vv ? vv.height + vv.offsetTop : window.innerHeight;
    // (a slide still on its way: the drag carries on from where the sheet is right now)
    const base = shiftNow(panel).y;
    drag = { y0: y, base, detent: s.sheetDetent, sizes: sheetSizes(room, 0, { detent: s.sheetDetent, height: panel.getBoundingClientRect().height }), samples: [], pointer };
    holdStill(panel);
    holdStill(backdropOf());
    if (pointer !== undefined) { try { panel.setPointerCapture(pointer); } catch { /* the pointer is gone */ } }
    place(y, t);
  };
  const place = (y: number, t: number) => {
    if (!drag) return;
    noteSample(drag.samples, t, y);
    const off = sheetTravel(drag.detent, drag.base + y - drag.y0, drag.sizes);
    panel.style.transform = `translate3d(0, ${off}px, 0)`;
    const b = backdropOf();
    if (b) b.style.opacity = String(sheetDim(drag.detent, off, drag.sizes));
  };
  /** the finger let go at `y` (null: the gesture was taken away — back where it was) */
  const finish = (y: number | null, t: number) => {
    const d = drag;
    if (!d) return;
    drag = null;
    if (d.pointer !== undefined) { try { panel.releasePointerCapture(d.pointer); } catch { /* released already */ } }
    if (y === null || !usable()) { settle(); return; }
    noteSample(d.samples, t, y);
    const to = sheetSnap({ detent: d.detent, dy: d.base + y - d.y0, vy: releaseVelocity(d.samples, t), ...d.sizes });
    // (closed: the store first — the sheet's resting place is below the screen by the time the transform is let go)
    if (to === 'closed') { flushSync(hideSheet); settle(); }
    else if (to !== d.detent) retune(panel, to, backdropOf());
    else settle();
  };

  // ---- the handle strip and the tab row: any pointer
  const onPointerMove = (e: PointerEvent) => {
    if (!pend || pend.kind !== 'pointer' || e.pointerId !== pend.id) return;
    if (drag) { place(e.clientY, e.timeStamp); return; }
    const dx = e.clientX - pend.x, dy = e.clientY - pend.y;
    if (Math.abs(dy) >= GRIP_SLOP_PX && Math.abs(dy) > Math.abs(dx)) begin(e.clientY, e.timeStamp, e.pointerId);
  };
  const onPointerEnd = (e: PointerEvent) => {
    if (!pend || pend.kind !== 'pointer' || e.pointerId !== pend.id) return;
    unlisten();
    pend = null;
    if (!drag) return;
    const up = e.type === 'pointerup';
    finish(up ? e.clientY : null, e.timeStamp);
    if (up) swallowNextClick(); // the drag began on a tab or a button: letting go is not a click on it
  };
  // (capture, on the window: nothing between here and there can keep a move or the release from arriving)
  const listen = () => {
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerEnd, true);
    window.addEventListener('pointercancel', onPointerEnd, true);
  };
  const unlisten = () => {
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerEnd, true);
    window.removeEventListener('pointercancel', onPointerEnd, true);
  };
  const onPointerDown = (e: PointerEvent) => {
    if (pend || drag || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0) || !usable()) return;
    const t = elementOf(e.target);
    if (!t?.closest(GRIPS)) return;
    pend = { kind: 'pointer', id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, target: t };
    listen();
  };

  // ---- inside a panel: a touch that pulls down from the top of what it is on
  const fingerOf = (list: TouchList, id: number): Touch | undefined => Array.from(list).find((f) => f.identifier === id);
  const onTouchStart = (e: TouchEvent) => {
    if (pend || drag || e.touches.length !== 1 || !usable()) return;
    const t = elementOf(e.target);
    if (!t || !pullable(t, panel)) return;
    const f = e.touches[0];
    pend = { kind: 'touch', id: f.identifier, x: f.clientX, y: f.clientY, t: e.timeStamp, target: t };
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!pend || pend.kind !== 'touch') return;
    const f = fingerOf(e.touches, pend.id);
    if (!f || e.touches.length !== 1) { pend = null; finish(null, e.timeStamp); return; } // a second finger: not a pull
    if (drag) {
      if (e.cancelable) e.preventDefault();
      place(f.clientY, e.timeStamp);
      return;
    }
    const dx = f.clientX - pend.x, dy = f.clientY - pend.y;
    if (Math.abs(dx) < PULL_SLOP_PX && Math.abs(dy) < PULL_SLOP_PX) return;
    // down, more down than sideways, still at the top — and the browser has not begun to scroll with this touch
    // (once it has, the move cannot be taken from it; a touch that was not ours stays the browser's to the end).
    // Not after a long press: that finger is selecting text
    if (dy < PULL_SLOP_PX || dy <= Math.abs(dx) || !e.cancelable || e.timeStamp - pend.t > LONG_PRESS_MS || !pullable(pend.target, panel)) { pend = null; return; }
    e.preventDefault();
    begin(f.clientY, e.timeStamp);
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (!pend || pend.kind !== 'touch') return;
    const f = fingerOf(e.changedTouches, pend.id);
    if (!f) return; // another finger's
    pend = null;
    finish(e.type === 'touchend' ? f.clientY : null, e.timeStamp);
  };

  // ---- up and down, whoever asked
  const off = useStore.subscribe((s, p) => {
    const now = sheetIsUp(s), was = sheetIsUp(p);
    if (now === was) return;
    if (now) { enterNext = !useSheetLeaving.getState().leaving; stopLeaving(); return; }
    // put away while a finger had it (something opened over the main area): the drag is over
    if (pend || drag) { pend = null; unlisten(); finish(null, 0); }
    if (s.mobile && !sheetCovered(s) && !reducedMotion()) startLeaving();
    else stopLeaving();
  });

  panel.addEventListener('pointerdown', onPointerDown);
  panel.addEventListener('touchstart', onTouchStart, { passive: true });
  panel.addEventListener('touchmove', onTouchMove, { passive: false });
  panel.addEventListener('touchend', onTouchEnd);
  panel.addEventListener('touchcancel', onTouchEnd);
  panel.addEventListener('transitionend', onSlid);
  return () => {
    off();
    unlisten();
    panel.removeEventListener('pointerdown', onPointerDown);
    panel.removeEventListener('touchstart', onTouchStart);
    panel.removeEventListener('touchmove', onTouchMove);
    panel.removeEventListener('touchend', onTouchEnd);
    panel.removeEventListener('touchcancel', onTouchEnd);
    panel.removeEventListener('transitionend', onSlid);
    pend = null;
    drag = null;
    enterNext = false;
    settle();
    stopLeaving();
  };
}
