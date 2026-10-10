/**
 * DOM helpers shared by the phone's two sliding surfaces (`phone-sheet.ts`, `phone-drawer.ts`).
 *
 * How they move: the style sheet (`styles/phone-sheet.css`) gives each surface its resting places and the transition
 * between them. While the finger has one, the element carries `data-drag` (no transition) and an inline transform
 * set straight from the pointer event — no React state per frame. Letting go removes both, and the transition takes
 * it from where the finger left it to where it rests.
 */

/** Text goes in here: a touch that starts on one is for the caret or the selection. */
export const TEXT_FIELDS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/** These take a touch themselves (the terminal scrolls and selects, an editor too, the terminal's key row scrolls sideways). */
export const OWN_TOUCH = `.xterm, .monaco-editor, .term-keys, webview, iframe, ${TEXT_FIELDS}`;

/**
 * A finger that stayed put this long before it moved was a long press — it is selecting text or waiting for a menu —
 * and what it does next is not a swipe (under the 500ms a long press on a conversation row takes to open its menu).
 */
export const LONG_PRESS_MS = 400;

/** Can this element be scrolled sideways right now? */
export function scrollsSideways(el: Element): boolean {
  if (el.scrollWidth <= el.clientWidth + 1) return false;
  const ox = getComputedStyle(el).overflowX;
  return ox === 'auto' || ox === 'scroll';
}

/** The nearest element from `from` up to (not including) `stop` that scrolls sideways. */
export function sidewaysScroller(from: Element, stop: Element | null): HTMLElement | null {
  for (let el: Element | null = from; el && el !== stop; el = el.parentElement) {
    if (el instanceof HTMLElement && scrollsSideways(el)) return el;
  }
  return null;
}

/** A duration token (tokens.css: `--dur-base`…) in ms; `fallback` when it cannot be read. */
export function tokenMs(name: string, fallback: number): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return /ms$/i.test(v) ? n : n * 1000;
}

/** The element's translation right now, mid-transition included. */
export function shiftNow(el: HTMLElement): { x: number; y: number } {
  try {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { x: m.m41, y: m.m42 };
  } catch {
    return { x: 0, y: 0 };
  }
}

/** The finger has it: no transition, and the browser may keep it on its own layer. */
export function holdStill(el: HTMLElement | null): void {
  if (el) el.dataset.drag = '';
}

/** The finger let go: whatever was set by hand goes, and the element's own transition takes it to rest. */
export function letSettle(el: HTMLElement | null): void {
  if (!el) return;
  delete el.dataset.drag;
  el.style.transform = '';
  el.style.opacity = '';
}

/**
 * Start `el` at `transform` and let its transition bring it to where it rests. For an element that has just been put
 * in place and not painted yet (a layout effect), or one whose resting place has just changed.
 */
export function slideFrom(el: HTMLElement, transform: string): void {
  holdStill(el);
  el.style.transform = transform;
  void el.offsetHeight; // this is where the slide starts from
  letSettle(el);
}

/** After a drag that began on a button: the click that follows the release is not a click. */
export function swallowNextClick(ms = 300): void {
  const stop = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, true), ms);
}
