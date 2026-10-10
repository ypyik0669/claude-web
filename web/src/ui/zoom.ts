// 界面缩放 in the page. The desktop shell owns the factor — one for every window, remembered, changed from its menu's
// accelerators as well as from here (desktop/src/zoom.ts). This keeps the page's copy: `--zoom` on <html> for the few
// lengths that are measured in the window's pixels (the room left for the caption buttons / traffic lights —
// styles.css divides them by it), and a value components can read. In a browser there is no shell and nothing to
// keep: the browser's own zoom does it, and the factor here stays 1.
import { useSyncExternalStore } from 'react';
import { desktop, type ZoomInfo } from '@/desktop';
import { useStore } from '@/store';
import { tidyZoom, zoomNotice } from './zoom-math';

export type ZoomState = ZoomInfo;

let state: ZoomState = { zoom: tidyZoom(desktop?.getZoom?.()), max: 3, min: 0.5 };
const subs = new Set<() => void>();

function paint() {
  if (typeof document !== 'undefined') document.documentElement.style.setProperty('--zoom', String(state.zoom));
}
paint(); // before the first paint: the rows under the caption buttons are laid out with it

function publish(next: Partial<ZoomState> | null | undefined) {
  if (!next) return;
  const n: ZoomState = { zoom: tidyZoom(next.zoom ?? state.zoom), max: tidyZoom(next.max ?? state.max), min: tidyZoom(next.min ?? state.min), steps: next.steps ?? state.steps };
  if (n.zoom === state.zoom && n.max === state.max && n.min === state.min && String(n.steps) === String(state.steps)) return;
  state = n;
  paint();
  for (const f of subs) f();
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const snapshot = () => state;

/** Whether this page can change the factor (the desktop app). */
export const canZoom = !!desktop?.setZoom;
/** The factor this page is drawn at (1 in a browser). */
export const getZoom = () => state.zoom;
export function useZoom(): number { return useSyncExternalStore(subscribe, getZoom); }
export function useZoomState(): ZoomState { return useSyncExternalStore(subscribe, snapshot); }

/** One step in / out, back to 100%, or a factor. The shell tells every window what came of it (`installZoom`). */
export function changeZoom(ask: 'in' | 'out' | 'reset' | number) {
  void desktop?.setZoom?.(ask).then(publish).catch(() => { /* an older shell */ });
}
/** Ask the shell again — the limit is the screen's, and a window can have moved to another one. */
export function refreshZoom() {
  void desktop?.zoomInfo?.().then(publish).catch(() => { /* an older shell */ });
}

/** App, once: follow the shell's factor, and say what a request did in the window that has the focus. */
export function installZoom(): () => void {
  if (!desktop?.onZoom) return () => {};
  refreshZoom();
  return desktop.onZoom((e) => {
    publish(e);
    if (!document.hasFocus()) return;
    const text = zoomNotice({ ...e, zoom: tidyZoom(e.zoom) });
    // one toast, rewritten in place while the key is held or pressed again
    if (text) useStore.getState().toast(text, true, 1800, 'zoom');
  });
}
