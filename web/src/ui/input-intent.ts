// Pointer or keyboard? UI refresh §4.5: what the keyboard triggers is not animated — a menu opened with Enter on its
// chip is simply there, one closed with Esc is simply gone; the pointer gets the scale-in / fade-out. A menu does not
// know how it was opened or closed (a chip's click handler, an outside mouse-down, another menu's claim…), so this
// keeps the time of the last real pointer press / release and the last real key press, app-wide.
//
// Only trusted events count: a script's `el.click()` (tests, the smoke run) is neither, so what it opens or closes is
// not animated either.

export interface InputTimes { pointerAt: number; keyAt: number }

/** How long after a pointer press something still counts as its doing (a click handler runs within a few ms). */
export const POINTER_WINDOW_MS = 400;

/** Was the last input a pointer press, and recent enough for what is happening `now` to be its doing? */
export function pointerLed(t: InputTimes, now: number, within = POINTER_WINDOW_MS): boolean {
  return t.pointerAt > t.keyAt && now - t.pointerAt <= within;
}

const times: InputTimes = { pointerAt: -Infinity, keyAt: -Infinity };

if (typeof window !== 'undefined') {
  const pointer = (e: Event) => { if (e.isTrusted) times.pointerAt = performance.now(); };
  const key = (e: Event) => { if (e.isTrusted) times.keyAt = performance.now(); };
  // capture: before any handler that opens or closes something (and before one that stops the event)
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) window.addEventListener(type, pointer, true);
  window.addEventListener('keydown', key, true);
}

/** Is what is happening right now the pointer's doing? (false for the keyboard, timers, server events, scripts) */
export function byPointer(within?: number): boolean {
  return pointerLed(times, performance.now(), within);
}

/** 减少动态效果 (the setting, or the system's): nothing moves. */
export function reducedMotion(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.dataset.reduceMotion === '1') return true;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
