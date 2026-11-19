// spec D1: zoom (wheel / − + / fit), the entrance timetable, and when not to animate (reduced motion, >150 cards).
export interface View { scale: number; x: number; y: number }
export interface Size { w: number; h: number }
export const NG_ZOOM = { min: 0.25, max: 2.5, step: 1.2 } as const;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * How a graph is fitted. `top` / `bottom`: room kept for the title and badge (top) and the zoom buttons (bottom);
 * `start`: a graph that does not fit at `min` starts at the top left (the rest is a pan away) instead of centred.
 */
export interface FitOpts { min?: number; max?: number; pad?: number; top?: number; bottom?: number; start?: boolean }
export function fitView(content: Size, box: Size, o: FitOpts = {}): View {
  const max = o.max ?? 1.25, min = o.min ?? NG_ZOOM.min, pad = o.pad ?? 16, top = o.top ?? pad, bottom = o.bottom ?? pad;
  if (content.w <= 0 || content.h <= 0 || box.w <= 0 || box.h <= 0) return { scale: 1, x: 0, y: 0 };
  const aw = Math.max(1, box.w - 2 * pad), ah = Math.max(1, box.h - top - bottom);
  const scale = clamp(Math.min(aw / content.w, ah / content.h), min, max);
  const w = content.w * scale, h = content.h * scale;
  return { scale, x: o.start && w > aw ? pad : (box.w - w) / 2, y: o.start && h > ah ? top : top + (ah - h) / 2 };
}
/**
 * review D4 / D5: a graph in a column (a chat reply, the orchestra panel) — the scale its width allows (between
 * `min` and `max`) and the height that holds it at that scale, between `lo` and `hi`: no empty band under the cards.
 */
export function fitHeight(content: Size, width: number, o: Required<Pick<FitOpts, 'min' | 'max' | 'pad' | 'top' | 'bottom'>> & { lo: number; hi: number }): { scale: number; height: number } {
  if (content.w <= 0 || content.h <= 0 || width <= 0) return { scale: 1, height: o.lo };
  const scale = clamp((width - 2 * o.pad) / content.w, o.min, o.max);
  return { scale, height: Math.round(clamp(content.h * scale + o.top + o.bottom, o.lo, o.hi)) };
}
/** the chat's numbers (review D4): 60 %–100 %, 200–560 px, room for the title / badge and the zoom buttons */
export const chatFit = (hasHead: boolean) => ({ min: 0.6, max: 1, pad: 16, top: hasHead ? 56 : 16, bottom: 44, lo: 200, hi: 560 });
/**
 * issue #17, 全屏查看: the whole picture in the window — down to the smallest zoom (then from the top left, the rest a
 * pan away), never above 125 %; room above for the title / badge row, below for the zoom buttons (40px on a phone).
 */
export const fullFit = (hasHead: boolean): FitOpts => ({ min: NG_ZOOM.min, max: 1.25, pad: 24, top: hasHead ? 64 : 24, bottom: 56, start: true });
/** review D6: a card that got the focus (Tab) is panned into view; one already in view leaves the view alone */
export function panToShow(v: View, b: { x: number; y: number; w: number; h: number }, box: Size, o: { pad?: number; top?: number; bottom?: number } = {}): View {
  if (box.w <= 0 || box.h <= 0) return v;
  const pad = o.pad ?? 16, top = o.top ?? pad, bottom = o.bottom ?? pad;
  const shift = (a: number, len: number, lo: number, hi: number) => (a < lo || len > hi - lo ? lo - a : a + len > hi ? hi - (a + len) : 0);
  const dx = shift(b.x * v.scale + v.x, b.w * v.scale, pad, box.w - pad);
  const dy = shift(b.y * v.scale + v.y, b.h * v.scale, top, box.h - bottom);
  return dx || dy ? { ...v, x: v.x + dx, y: v.y + dy } : v;
}
/** arrow keys pan by this many pixels */
export const NG_PAN_STEP = 60;
/** arrow key → which way the view moves (the content follows the arrow's opposite: ← shows what is on the left) */
export const PAN_KEYS: ReadonlyMap<string, readonly [number, number]> = new Map<string, readonly [number, number]>([['ArrowLeft', [1, 0]], ['ArrowRight', [-1, 0]], ['ArrowUp', [0, 1]], ['ArrowDown', [0, -1]]]);
export function zoomAt(v: View, scale: number, p: { x: number; y: number }): View {
  const s = clamp(scale, NG_ZOOM.min, NG_ZOOM.max), k = s / v.scale;
  return { scale: s, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k };
}
export const zoomBy = (v: View, dir: 1 | -1, box: Size): View => zoomAt(v, dir > 0 ? v.scale * NG_ZOOM.step : v.scale / NG_ZOOM.step, { x: box.w / 2, y: box.h / 2 });
export const pct = (scale: number) => `${Math.round(scale * 100)}%`;

export const NG_ANIMATE_MAX = 150, NG_ANIMATE_MAX_EDGES = 300;
/** review D3: no animation for a big graph — above 150 cards or 300 edges — or when motion is reduced */
export const motionOn = (cards: number, edges: number, reduced: boolean) => !reduced && cards <= NG_ANIMATE_MAX && edges <= NG_ANIMATE_MAX_EDGES;
export const NG_CARD_STAGGER = 90, NG_CARD_IN = 320, NG_EDGE_STAGGER = 40, NG_EDGE_IN = 420;
export function entranceTimes(cards: number, edges: number) {
  const card = (i: number) => Math.min(i * NG_CARD_STAGGER, 1500);
  const edgesAt = cards ? card(cards - 1) + Math.round(NG_CARD_IN * 0.6) : 0;
  const edge = (i: number) => edgesAt + Math.min(i * NG_EDGE_STAGGER, 800);
  const total = edges ? edge(edges - 1) + NG_EDGE_IN : cards ? card(cards - 1) + NG_CARD_IN : 0;
  return { card, edge, total };
}
