// One clock for every process animation on the page: a glyph registers its element and its frames (as HTML), and the
// clock writes the element only when that glyph's frame number changes. No React render per frame.
//
// …and only while the glyph can be seen (2026-11-20, perf-busy with four conversations running): every write is a
// DOM change the page restyles, lays out and paints, also for a glyph in a tab behind another, scrolled out of view or
// under a page (自动化, Artifacts…) that lies over the conversations. A glyph out of sight keeps its clock (an ending
// still hands over on time) and gets its current frame the moment it is seen again.

export interface Run {
  el: HTMLElement;
  frames: string[];
  fps: number;
  /** play once, then hold the last frame and call onEnd (a `done` / `fail` ending) */
  once: boolean;
  onEnd?: () => void;
  t0: number;
  shown: number;
  ended?: boolean;
  /** what the IntersectionObserver last said: false = no box (a hidden tab or page) or out of view; unset = not yet */
  seen?: boolean;
  /** the conversations' layer it is drawn in: inert while a page lies over it (Workbench) */
  layer?: HTMLElement | null;
}

const runs = new Set<Run>();
let timer: ReturnType<typeof setInterval> | null = null;
/** how long the last frame of an ending stays before the glyph hands over */
const HOLD_MS = 260;

let io: IntersectionObserver | null = null;
const byEl = new Map<Element, Set<Run>>();

function watch(r: Run): void {
  if (typeof IntersectionObserver === 'undefined') return;
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries) for (const run of byEl.get(e.target) ?? []) run.seen = e.isIntersecting;
  });
  let set = byEl.get(r.el);
  if (!set) {
    set = new Set();
    byEl.set(r.el, set);
    io.observe(r.el);
  }
  set.add(r);
}

function unwatch(r: Run): void {
  const set = byEl.get(r.el);
  if (!set) return;
  set.delete(r);
  if (!set.size) {
    byEl.delete(r.el);
    io?.unobserve(r.el);
  }
}

/** Out of sight: no box or out of view, or in the conversations' layer while a page lies over it. */
export function outOfSight(r: Pick<Run, 'seen' | 'layer'>): boolean {
  return r.seen === false || !!r.layer?.inert;
}

/** The frame a run shows `now` (and whether its ending has played out: an ending holds its last frame HOLD_MS). */
export function frameAt(r: Pick<Run, 't0' | 'fps' | 'frames' | 'once'>, now: number): { i: number; over: boolean } {
  const n = Math.floor(((now - r.t0) * r.fps) / 1000);
  if (!r.once) return { i: n % r.frames.length, over: false };
  return { i: Math.min(n, r.frames.length - 1), over: now - r.t0 >= (r.frames.length * 1000) / r.fps + HOLD_MS };
}

function tick() {
  const now = performance.now();
  for (const r of runs) {
    const { i, over } = frameAt(r, now);
    if (over && !r.ended) {
      r.ended = true;
      r.onEnd?.();
    }
    if (i !== r.shown && !outOfSight(r)) {
      r.shown = i;
      r.el.innerHTML = r.frames[i];
    }
  }
}

export function play(r: Omit<Run, 't0' | 'shown'>): () => void {
  const run: Run = { ...r, t0: performance.now(), shown: 0 };
  run.el.innerHTML = run.frames[0] ?? '';
  run.layer = run.el.closest<HTMLElement>('.pane-layer');
  runs.add(run);
  watch(run);
  if (!timer) timer = setInterval(tick, 1000 / 30);
  return () => {
    runs.delete(run);
    unwatch(run);
    if (!runs.size && timer) { clearInterval(timer); timer = null; }
  };
}
