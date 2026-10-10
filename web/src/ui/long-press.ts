// Holding a row on a phone opens its menu (UI refresh §8 菜单: 对话行长按 500ms 打开同一张操作单).
// The decisions are pure (`pressStep`, `pressTail`); `useLongPress` wires them to a row's pointer events.
//
// What ends a press before it fires: lifting (a tap), moving more than ~10px (a scroll, a swipe), the browser taking
// the touch over (pointercancel). What must not follow one that fired: the click the browser makes of the lift — it
// would open the conversation, or land on the sheet that just came up under the finger.
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react';

/** Held this long without moving, a press opens the menu. */
export const LONG_PRESS_MS = 500;
/** Moving further than this from where the finger came down is not holding. */
export const LONG_PRESS_SLOP_PX = 10;
/** A click this soon after the finger of a fired press lifts is that lift, not a new tap. */
export const CLICK_TAIL_MS = 300;

export interface PressStart { x: number; y: number; at: number }
export type PressInput =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'up' }
  | { kind: 'cancel' }
  | { kind: 'timer'; at: number };

/** What a press that started at `start` is after `input`: still `held`, a long press (`fire`), or nothing (`drop`). */
export function pressStep(start: PressStart, input: PressInput): 'held' | 'fire' | 'drop' {
  switch (input.kind) {
    case 'move': return Math.hypot(input.x - start.x, input.y - start.y) > LONG_PRESS_SLOP_PX ? 'drop' : 'held';
    case 'timer': return input.at - start.at >= LONG_PRESS_MS ? 'fire' : 'held';
    default: return 'drop';
  }
}

/**
 * Is a click arriving `now` the tail of a long press that fired at `firedAt` (to be swallowed)? Yes while the finger
 * is still down (`upAt` null) and for a moment after it lifted; a tap later than that is the user's next move.
 */
export function pressTail(firedAt: number | null, upAt: number | null, now: number): boolean {
  if (firedAt === null) return false;
  return upAt === null || now - upAt <= CLICK_TAIL_MS;
}

/** A finger that never reports lifting (a lost pointerup) stops swallowing clicks after this long. */
const TAIL_CAP_MS = 8000;

export interface LongPress {
  /** spread on the row; empty while `enabled` is false */
  handlers: {
    onPointerDown?: (e: ReactPointerEvent) => void;
    onPointerMove?: (e: ReactPointerEvent) => void;
    onPointerUp?: (e: ReactPointerEvent) => void;
    onPointerCancel?: (e: ReactPointerEvent) => void;
    onTouchEnd?: (e: ReactTouchEvent) => void;
  };
  /**
   * The browser recognised the same hold first (Android sends `contextmenu` for a long press): fire now instead of
   * waiting for the timer. False when no press is being held (a mouse's right-click) — the caller does what it did.
   */
  trigger(): boolean;
}

/**
 * Long press on an element: `onFire` once a primary pointer has been held on it for 500ms without moving. A press
 * that starts on a control inside the element (a button, a field) is that control's. After it fired, the lift does
 * not click: the touch's own click is cancelled (touchend) and one that still arrives is swallowed.
 */
export function useLongPress(onFire: () => void, enabled: boolean): LongPress {
  const fire = useRef(onFire);
  fire.current = onFire;
  const held = useRef<{ start: PressStart; id: number; timer: number } | null>(null);
  /** a press fired and its tail is not over (pointerup comes before touchend): that touchend must not become a click */
  const fired = useRef(false);
  const tailOff = useRef<(() => void) | null>(null);

  const drop = () => {
    if (held.current) window.clearTimeout(held.current.timer);
    held.current = null;
  };
  // swallow the click that the lift of a fired press turns into, wherever it lands (the row, the sheet over it)
  const armTail = () => {
    tailOff.current?.();
    const firedAt = performance.now();
    let upAt: number | null = null;
    let timer = 0;
    const off = () => {
      window.clearTimeout(timer);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      if (tailOff.current === off) { tailOff.current = null; fired.current = false; }
    };
    const onUp = () => {
      upAt = performance.now();
      window.clearTimeout(timer);
      timer = window.setTimeout(off, CLICK_TAIL_MS + 20);
    };
    const onClick = (e: Event) => {
      if (pressTail(firedAt, upAt, performance.now())) { e.preventDefault(); e.stopPropagation(); }
      off();
    };
    window.addEventListener('click', onClick, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    timer = window.setTimeout(off, TAIL_CAP_MS);
    tailOff.current = off;
  };
  const go = () => {
    const h = held.current;
    if (!h) return false;
    drop();
    armTail();
    fired.current = true;
    fire.current();
    return true;
  };
  const tick = () => {
    const h = held.current;
    if (!h) return;
    const verdict = pressStep(h.start, { kind: 'timer', at: performance.now() });
    if (verdict === 'fire') go();
    // a timer that came round early (they may, by a millisecond): wait out the rest
    else h.timer = window.setTimeout(tick, Math.max(1, LONG_PRESS_MS - (performance.now() - h.start.at)));
  };
  useEffect(() => () => { drop(); tailOff.current?.(); }, []);
  useEffect(() => { if (!enabled) drop(); }, [enabled]);

  if (!enabled) return { handlers: {}, trigger: () => false };
  return {
    trigger: go,
    handlers: {
      onPointerDown: (e) => {
        if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
        // a control inside the row (its ···, the fold arrow, a checkbox) keeps its own press
        const t = e.target as Element;
        if (t !== e.currentTarget && t.closest?.('button, input, a, select, textarea')) return;
        drop();
        held.current = { start: { x: e.clientX, y: e.clientY, at: performance.now() }, id: e.pointerId, timer: window.setTimeout(tick, LONG_PRESS_MS) };
      },
      onPointerMove: (e) => {
        const h = held.current;
        if (h && h.id === e.pointerId && pressStep(h.start, { kind: 'move', x: e.clientX, y: e.clientY }) === 'drop') drop();
      },
      onPointerUp: (e) => { if (held.current?.id === e.pointerId) drop(); },
      onPointerCancel: (e) => { if (held.current?.id === e.pointerId) drop(); },
      // a touch's click is made of its touchend: cancelled here it never comes (mouse events are not; they hit the tail)
      onTouchEnd: (e) => { if (fired.current && e.cancelable) e.preventDefault(); },
    },
  };
}
