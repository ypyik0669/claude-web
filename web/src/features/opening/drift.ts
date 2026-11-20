// 放完留作背景 after 星图 and 字符雨 (界面改版方案 第 7 版 #opening: 「火星、星星或字符慢慢飘」): the stars of 星图's sky,
// twinkling and drifting, and 字符雨's code falling slowly in a few columns. The motion is here (pure, tested);
// OpeningBackdrop.tsx draws it (~24 fps while the window is watched, one frame when motion is reduced).

/** dark: the stars and the rain of the opening's dark palette; light: its ink on paper (desktop/src/opening.ts PAL) */
export const DRIFT_COLORS = {
  dark: { star: '#eee2cc', rain: '#d6aa60', head: '#fff1d6' },
  light: { star: '#785c34', rain: '#966828', head: '#5a3a10' },
} as const;

export interface Star { x: number; y: number; vx: number; vy: number; s: number; p: number; tw: number }

/** Sparse: one per ~14 000 px² of window, between 24 and 140. */
export const starCount = (w: number, h: number) => Math.min(140, Math.max(24, Math.round((w * h) / 14000)));

export function makeStars(w: number, h: number, rand: () => number): Star[] {
  return Array.from({ length: starCount(w, h) }, () => ({
    x: rand() * w, y: rand() * h,
    // a slow drift, mostly sideways (the sky turning)
    vx: 2 + rand() * 4, vy: (rand() - 0.5) * 2,
    s: 0.5 + rand() * 1.3, p: rand() * Math.PI * 2, tw: 0.6 + rand() * 1.4,
  }));
}

/** Move every star `dt` seconds on; one that leaves comes back in on the other side. */
export function stepStars(list: Star[], dt: number, w: number, h: number): void {
  for (const s of list) {
    s.x += s.vx * dt; s.y += s.vy * dt;
    if (s.x > w + 4) s.x -= w + 8; else if (s.x < -4) s.x += w + 8;
    if (s.y > h + 4) s.y -= h + 8; else if (s.y < -4) s.y += h + 8;
  }
}

/** How bright a star is at `t`: a slow twinkle, never quite out. */
export const starAlpha = (s: Star, t: number) => 0.22 + 0.58 * (0.5 + 0.5 * Math.sin(t * s.tw + s.p));

/** The rain's grid (px): a column every RAIN_CELL.w, a row every RAIN_CELL.h; 13 px monospace characters. */
export const RAIN_CELL = { w: 14, h: 19 } as const;
export const RAIN_CHARS = '{}[]<>/=+*#%$&;:.01abcdefxyz';

export interface Drop { c: number; y: number; v: number; len: number }

/** Every fourth column has a drop (the opening's own rain, thinned out); `y` in rows. */
export function makeRain(w: number, h: number, rand: () => number): Drop[] {
  const cols = Math.ceil(w / RAIN_CELL.w), rows = Math.ceil(h / RAIN_CELL.h);
  const out: Drop[] = [];
  for (let c = 0; c < cols; c += 4) out.push({ c, y: rand() * (rows + 12) - 6, v: 1.6 + rand() * 2.8, len: 5 + Math.floor(rand() * 10) });
  return out;
}

/** Fall `dt` seconds; a drop that is gone below starts again above the top. */
export function stepRain(list: Drop[], dt: number, rows: number, rand: () => number): void {
  for (const d of list) {
    d.y += d.v * dt;
    if (d.y - d.len > rows) { d.y = -rand() * 8; d.v = 1.6 + rand() * 2.8; }
  }
}

/** The character at a cell, changing about three times a second. */
export function rainChar(c: number, r: number, t: number): string {
  const n = c * 31 + r * 17 + Math.floor(t * 3) * 7;
  return RAIN_CHARS[((n % RAIN_CHARS.length) + RAIN_CHARS.length) % RAIN_CHARS.length];
}
