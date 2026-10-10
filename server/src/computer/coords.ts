/**
 * Where is that? — the model reads positions off the screenshot it was last given (scaled down so its long edge is at
 * most 1568 px); the mouse lives in real screen pixels. This maps between the two. Pure.
 *
 * Before any screenshot there is no frame: every action that takes coordinates fails with NEED_SCREENSHOT.
 */

export interface Rect { x: number; y: number; width: number; height: number }

/** The most recent screenshot: the size of the image the model saw, and the real-pixel rectangle it shows. */
export interface Frame {
  width: number;
  height: number;
  rect: Rect;
}

export const NEED_SCREENSHOT = 'Take a screenshot first: coordinates are positions in the most recent screenshot, and there is none yet.';

export const MAX_EDGE = 1568;

/** The image size for a real rectangle: scaled down (never up) so the long edge fits. The helper does the same sum. */
export function fitWithin(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type PointResult = { ok: true; x: number; y: number } | { ok: false; error: string };

/**
 * A `[x, y]` from the model → real screen pixels. The centre of an image pixel maps to the centre of the patch of
 * screen it stands for. A position on the far edge (x = width) is taken as the last pixel; anything further out is
 * refused — it usually means the coordinates were read in some other scale.
 */
export function toScreen(frame: Frame | null, coordinate: unknown, what = 'coordinate'): PointResult {
  if (!Array.isArray(coordinate) || coordinate.length !== 2 || !isNum(coordinate[0]) || !isNum(coordinate[1])) {
    return { ok: false, error: `"${what}" must be [x, y]: two numbers, a position in the most recent screenshot.` };
  }
  if (!frame) return { ok: false, error: NEED_SCREENSHOT };
  const [x, y] = coordinate;
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) {
    return { ok: false, error: `${what} (${x}, ${y}) is outside the screenshot, which is ${frame.width}x${frame.height} px. Read positions off the most recent screenshot image.` };
  }
  // multiply before dividing: whole numbers stay whole (784 of 1568 across 1920 is exactly 960)
  const px = Math.min(frame.rect.width - 1, Math.max(0, Math.round(((x + 0.5) * frame.rect.width) / frame.width - 0.5)));
  const py = Math.min(frame.rect.height - 1, Math.max(0, Math.round(((y + 0.5) * frame.rect.height) / frame.height - 0.5)));
  return { ok: true, x: frame.rect.x + px, y: frame.rect.y + py };
}

/** Real screen pixels → the position in the screenshot. `inside` is false off the captured display (another monitor). */
export function toImage(frame: Frame, x: number, y: number): { x: number; y: number; inside: boolean } {
  const rx = x - frame.rect.x;
  const ry = y - frame.rect.y;
  const inside = rx >= 0 && ry >= 0 && rx < frame.rect.width && ry < frame.rect.height;
  const ix = Math.round(((rx + 0.5) * frame.width) / frame.rect.width - 0.5);
  const iy = Math.round(((ry + 0.5) * frame.height) / frame.rect.height - 0.5);
  return { x: Math.min(frame.width - 1, Math.max(0, ix)), y: Math.min(frame.height - 1, Math.max(0, iy)), inside };
}

export type RegionResult = { ok: true; rect: Rect } | { ok: false; error: string };

/** A zoom `[x0, y0, x1, y1]` in screenshot coordinates → the real rectangle to capture (every screen pixel it touches). */
export function zoomRect(frame: Frame | null, region: unknown): RegionResult {
  if (!Array.isArray(region) || region.length !== 4 || !region.every(isNum)) {
    return { ok: false, error: '"region" must be [x0, y0, x1, y1]: the top-left and bottom-right corners, in the most recent screenshot.' };
  }
  if (!frame) return { ok: false, error: NEED_SCREENSHOT };
  const [x0, y0, x1, y1] = region as number[];
  if (x1 <= x0 || y1 <= y0) return { ok: false, error: '"region" must have x1 > x0 and y1 > y0 (top-left corner first).' };
  if (x0 < 0 || y0 < 0 || x1 > frame.width || y1 > frame.height) {
    return { ok: false, error: `region (${x0}, ${y0})–(${x1}, ${y1}) is outside the screenshot, which is ${frame.width}x${frame.height} px.` };
  }
  const left = Math.max(0, Math.floor((x0 * frame.rect.width) / frame.width));
  const top = Math.max(0, Math.floor((y0 * frame.rect.height) / frame.height));
  const right = Math.min(frame.rect.width, Math.ceil((x1 * frame.rect.width) / frame.width));
  const bottom = Math.min(frame.rect.height, Math.ceil((y1 * frame.rect.height) / frame.height));
  return { ok: true, rect: { x: frame.rect.x + left, y: frame.rect.y + top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) } };
}
