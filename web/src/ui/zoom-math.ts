// 界面缩放, the pure part: how a factor reads, and what a window says after a request. The desktop shell owns the
// factor (desktop/src/zoom.ts); the page shows it and asks for changes (ui/zoom.ts).

export interface ZoomOutcome { zoom: number; max: number; min: number; changed: boolean; ask: 'in' | 'out' | 'reset' | 'set' }

/** 1.2500000000000002 (what Chromium reports for 125%) → 1.25; anything unreadable is 1. */
export function tidyZoom(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 1;
}

/** 「125%」 */
export const zoomPercent = (zoom: number) => `${Math.round(zoom * 100)}%`;

/** The largest factor there is (desktop/src/zoom.ts ZOOM_STEPS): under it, `max` is the screen's limit. */
export const ZOOM_TOP = 3;

/**
 * What the focused window says after a request: the new size, or why nothing happened — a key that did nothing
 * would read as broken. Null when there is nothing to say.
 */
export function zoomNotice(e: ZoomOutcome): string | null {
  const now = zoomPercent(e.zoom);
  if (e.changed) return `界面缩放 ${now}`;
  if (e.ask === 'in') return e.max < ZOOM_TOP ? `已经放到最大了（${now}）：再大，窗口就放不进这块屏幕` : `已经放到最大了（${now}）`;
  if (e.ask === 'out') return `已经缩到最小了（${now}）`;
  if (e.ask === 'reset') return `界面缩放已经是 ${now}`;
  return null;
}

/**
 * The factors the settings control lists: the shell's steps up to this screen's limit, and the current one if it is
 * not among them (a limit that came down after it was chosen).
 */
export function zoomChoices(steps: readonly number[] | undefined, info: { zoom: number; max: number }): number[] {
  const list = (steps ?? []).map(tidyZoom).filter((z) => z <= info.max + 1e-6);
  if (!list.includes(info.zoom)) list.push(info.zoom);
  return [...new Set(list)].sort((a, b) => a - b);
}
