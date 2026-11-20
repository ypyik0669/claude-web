// 火星: what 放完留作背景 leaves behind the app where the film cannot be (a light theme — the dark film under a light
// shell turns grey — or 点火, which has no film): sparse warm sparks drifting up, the ignite scene's ambient embers
// (界面改版方案 第 7 版, 轻量版). The motion is here (pure, tested); OpeningBackdrop.tsx draws it.

export interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** seconds alive / how long it lives */
  life: number;
  max: number;
  /** radius (px) and a phase for its flicker and sway */
  s: number;
  p: number;
}

/** dark: light that adds up (lighter); light: warm ink that sits on the paper */
export const EMBER_COLORS = { dark: ['#ffc46a', '#ff8a3d', '#ff5a1f'], light: ['#fb7d2c', '#ee5a24', '#b9410f'] } as const;

/**
 * A spark's glow reaches this many times its core radius. They are seen through the shell (70 % of it solid by
 * default): a bare 2 px dot was gone on a light theme, a core with a glow around it still reads as a spark.
 */
export const EMBER_HALO = 4.5;

/** '#rrggbb' and an alpha → 'rgba(r,g,b,a)' (the glow's colour stops). */
export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Sparse: one per ~16 000 px² of window, between 14 and 80. */
export const emberCount = (w: number, h: number) => Math.min(80, Math.max(14, Math.round((w * h) / 16000)));

/** A new ember: anywhere (`seed`, the first frame is already full) or from just below the bottom edge. */
export function spawn(w: number, h: number, rand: () => number, seed = false): Ember {
  const max = 8 + rand() * 7;
  return { x: rand() * w, y: seed ? rand() * h : h + 6, vx: (rand() - 0.5) * 10, vy: -(12 + rand() * 22), life: seed ? rand() * max * 0.8 : 0, max, s: 1.1 + rand() * 1.9, p: rand() * Math.PI * 2 };
}

/** Move every ember `dt` seconds on; one that burnt out or left the top is born again at the bottom. */
export function stepEmbers(list: Ember[], dt: number, w: number, h: number, rand: () => number): void {
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    e.life += dt;
    e.x += (e.vx + Math.sin(e.life * 1.3 + e.p) * 6) * dt;
    e.y += e.vy * dt;
    if (e.life > e.max || e.y < -8) list[i] = spawn(w, h, rand);
  }
}

/** How bright an ember is now: fades in, flickers, burns out. */
export function emberAlpha(e: Ember): number {
  const k = e.life / e.max;
  return Math.max(0, Math.min(1, e.life * 1.5) * (1 - k) * (0.6 + 0.4 * Math.sin(e.life * 6 + e.p)));
}
