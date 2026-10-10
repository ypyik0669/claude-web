/**
 * 界面缩放: the page zoom of every window (a browser's Ctrl + / Ctrl −, remembered) — which factors there are, which of
 * them a screen can take, and what has to follow the factor. Pure; main.ts applies it.
 *
 * The page is drawn `zoom` times as big, so a window `w` wide shows `w / zoom` of the page's own pixels. Two things are
 * measured in the window's pixels and not the page's, and so have to be told: the smallest window (the page turns into
 * the phone layout under 760 of its own pixels), and the system's caption buttons / traffic lights.
 */

/** The factors a step moves between — a browser's own list, up to 300%. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
/** The smallest page a window shows, in the page's own pixels (the window's minimum size at 100%). */
export const MIN_PAGE = { width: 900, height: 600 } as const;
/**
 * Zoomed in, the page may get shorter than that — down to this — but never narrower: the width is what the layout
 * depends on (under 760 it is the phone's), the height only decides how much of a conversation shows. With the
 * 100% height, a 1080p screen at 125% system scaling could not go past 125%.
 */
export const SHORT_PAGE = 480;

export type ZoomAsk = 'in' | 'out' | 'reset' | number;
export interface Size { width: number; height: number }
export interface Rect extends Size { x: number; y: number }

const EPS = 1e-6;

/** A request from a page or a stored value, as something `nextZoom` takes; null for anything else. */
export function zoomAsk(v: unknown): ZoomAsk | null {
  if (v === 'in' || v === 'out' || v === 'reset') return v;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The largest factor a screen can take: the smallest window at that factor (`minWindow`) still fits its work area —
 * a window can always be made big enough for the desktop layout. Never under 100%.
 */
export function zoomLimit(area: Size): number {
  let max = 1;
  for (const z of ZOOM_STEPS) {
    const m = minWindow(z);
    if (z > max && m.width <= area.width + EPS && m.height <= area.height + EPS) max = z;
  }
  return max;
}

/** A stored or typed factor as one of the steps (the nearest one), at most `max`; anything unreadable is 100%. */
export function cleanZoom(v: unknown, max: number = ZOOM_STEPS[ZOOM_STEPS.length - 1]): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 1;
  let best: number = ZOOM_STEPS[0];
  for (const z of ZOOM_STEPS) if (z <= max + EPS && Math.abs(z - v) < Math.abs(best - v) - EPS) best = z;
  return best;
}

/** The factor after a request: one step in / out (stopping at the ends), back to 100%, or a given factor. */
export function nextZoom(cur: number, ask: ZoomAsk, max: number): number {
  if (ask === 'reset') return 1;
  if (typeof ask === 'number') return cleanZoom(ask, max);
  const steps = ZOOM_STEPS.filter((z) => z <= max + EPS);
  if (ask === 'in') return steps.find((z) => z > cur + EPS) ?? steps[steps.length - 1];
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i] < cur - EPS) return steps[i];
  return steps[0];
}

/**
 * The window's smallest size at a factor: the page stays MIN_PAGE wide and at least SHORT_PAGE tall, as big as they
 * are drawn — and never under the 100% minimum (zoomed out, or only a little in).
 */
export function minWindow(zoom: number): Size {
  const k = Math.max(1, zoom);
  return { width: Math.round(MIN_PAGE.width * k), height: Math.max(MIN_PAGE.height, Math.round(SHORT_PAGE * k)) };
}

/**
 * A window that is smaller than its new minimum, grown to it and moved back onto its screen if growing pushed it off;
 * null when it is big enough as it is.
 */
export function fitWindow(b: Rect, min: Size, area: Rect): Rect | null {
  if (b.width >= min.width && b.height >= min.height) return null;
  const width = Math.max(b.width, min.width), height = Math.max(b.height, min.height);
  const x = Math.max(area.x, Math.min(b.x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(b.y, area.y + area.height - height));
  return { x, y, width, height };
}

/**
 * macOS: where the traffic lights' top goes so they stay centred in the sidebar's top row — the row is 52 of the
 * page's pixels under an 8px gap (its centre 34 down), the buttons 14 of the window's.
 */
export function trafficLightY(zoom: number): number {
  return Math.round(34 * zoom - 7);
}

/**
 * The caption buttons' area (Windows / Linux) when the factor changes before the page has said how tall its top row
 * now is: the height it reported, scaled the same way.
 */
export function scaleCaption(height: number, from: number, to: number): number {
  return from > 0 ? Math.round((height * to) / from) : height;
}
