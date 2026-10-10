/**
 * Phones: the system's back gesture (Android's edge swipe / back button, a browser's back) closes what is on top —
 * a menu sheet, the bottom sheet, the sidebar drawer — instead of leaving the page (UI refresh §8).
 *
 * Each open layer owns one history entry. `pushBackLayer(close)` registers a layer and returns `release`, to call
 * when the layer closes for any other reason (a tap, Esc, a choice made). A back press lands on a shallower entry:
 * the layers above that depth are closed, top first.
 *
 * The history is brought in line with the layers a moment later (one deferred step for any number of pushes and
 * releases), never in the middle of one: `history.back()` followed by `pushState` in the same task makes Chromium
 * drop the new entry — closing the drawer and opening the sheet in one commit (账户 → 用量) left the sheet with no
 * entry, and the next back gesture left the page. So a release followed by a push reuses the entry, and nothing is
 * pushed while a traversal of our own is still on its way. How deep we are is read from `history.state.cwLayer`
 * (written with each entry) after every popstate, so a forward press or a reload among our entries cannot make the
 * count drift.
 *
 * Off everywhere but a phone-width page in a browser: the desktop app and wide windows have no back gesture to catch,
 * and pushing entries there would only make the browser's back button do nothing.
 */
export interface BackHost {
  pushState(data: unknown, unused: string): void;
  go(delta: number): void;
  readonly state: unknown;
  /** subscribe to popstate; returns unsubscribe */
  onPop(fn: () => void): () => void;
  /** run `fn` in a later task */
  defer(fn: () => void): void;
  /** whether layers take history entries here at all (phone width, not the desktop app) */
  enabled(): boolean;
}

export interface BackLayers {
  push(close: () => void): () => void;
  /** how many layers are open (tests) */
  readonly depth: number;
}

export function createBackLayers(host: BackHost): BackLayers {
  const stack: { id: number; close: () => void }[] = [];
  let seq = 0;
  let owned = -1;         // our entries at or below the current one; -1 = not read yet
  let traversing = false; // a go() of our own is on its way (its popstate closes nothing)
  let scheduled = false;
  let off: (() => void) | null = null;
  const stateObj = (): Record<string, unknown> => (host.state && typeof host.state === 'object' ? (host.state as Record<string, unknown>) : {});
  const depthNow = (): number => { const d = stateObj().cwLayer; return typeof d === 'number' && d > 0 ? Math.floor(d) : 0; };
  const reconcile = () => {
    scheduled = false;
    if (traversing) return; // its popstate reconciles again
    if (owned < 0) owned = depthNow();
    const want = stack.length;
    while (owned < want) { owned++; host.pushState({ ...stateObj(), cwLayer: owned }, ''); }
    if (owned > want) { traversing = true; host.go(want - owned); return; }
    if (!want && off) { off(); off = null; owned = -1; } // nothing open, nothing of ours left: stop listening
  };
  const schedule = () => { if (!scheduled) { scheduled = true; host.defer(reconcile); } };
  const onPop = () => {
    owned = depthNow();
    if (traversing) traversing = false;
    else while (stack.length > owned) stack.pop()!.close(); // a back press: what was above this depth closes
    schedule();
  };
  return {
    get depth() { return stack.length; },
    push(close) {
      if (!host.enabled()) return () => {};
      if (!off) off = host.onPop(onPop);
      const id = ++seq;
      stack.push({ id, close });
      schedule();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const i = stack.findIndex((l) => l.id === id);
        if (i < 0) return; // a back press already took it
        stack.splice(i, 1);
        schedule();
      };
    },
  };
}

const browserHost: BackHost = {
  pushState: (d, u) => history.pushState(d, u),
  go: (n) => history.go(n),
  get state() { return history.state; },
  onPop: (fn) => { window.addEventListener('popstate', fn); return () => window.removeEventListener('popstate', fn); },
  defer: (fn) => { setTimeout(fn, 0); },
  enabled: () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (document.documentElement.classList.contains('desktop')) return false;
    try { return !!window.matchMedia?.('(max-width: 760px)').matches; } catch { return false; }
  },
};

let layers: BackLayers | null = null;

/** Register an open layer; call the returned function when it closes for any reason (it is safe to call twice). */
export function pushBackLayer(close: () => void): () => void {
  layers ??= createBackLayers(browserHost);
  return layers.push(close);
}
