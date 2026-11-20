/**
 * 字流, the new-conversation page's backdrop (2026-10-17, designed here — the user asked for 「一个有意思特别的」): letters
 * drift like ink in slow water, along a current that turns over time, each leaving a short fading trail. The pointer
 * parts the current; a click splashes a ring of letters in the theme's accent; and what you type in the box floats out
 * of it, in the accent, and joins the stream. The motion is here (pure, tested); LetterFlow.tsx draws it.
 */

/**
 * 背景动画 (外观, spec 2026-10-24 A6 — the user: 「就做动画或者无在外观里面设置就好」): on → the new-conversation page
 * moves (a character theme's own backdrop, 字流 on the classic themes), off → still. **Off unless turned on**
 * (redesign 2026-11 #pages 首页: 「背景默认不动」): not set, only an explicit pick of the old `ui.welcomeBackdrop`
 * (字流 / 字场 / true) still counts as on.
 */
export function backdropOn(settings: Record<string, unknown>): boolean {
  const v = settings['ui.backdropMotion'];
  if (typeof v === 'boolean') return v;
  const old = settings['ui.welcomeBackdrop'];
  return old !== undefined && old !== null && old !== false && old !== 'off';
}

/** 背景动画 switched off on purpose (now or in the old setting) — not merely left at its default. */
export function backdropOff(settings: Record<string, unknown>): boolean {
  const v = settings['ui.backdropMotion'];
  if (typeof v === 'boolean') return !v;
  const old = settings['ui.welcomeBackdrop'];
  return old === false || old === 'off';
}

export interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ch: string;
  /** seconds alive */
  age: number;
  /** how long it lives before it fades out and is born again elsewhere (ambient letters) */
  span: number;
  /** 1 = the theme's accent (typed / splashed), fading to 0 = the field's ink */
  accent: number;
  /** font size px (typed letters start larger) */
  size: number;
  /** a typed / splashed letter: not born again, gone once faded */
  guest: boolean;
}

export const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789{}[]()<>/\\=+-*;:.,_#$&@%';
/** ambient letters per px² of page */
export const DENSITY = 1 / 1700;
export const MIN_MOTES = 120;
export const MAX_MOTES = 1100;
/** px per second the current carries a letter, from slow to fast */
export const SPEED = [10, 34] as const;
/** how fast a letter takes on the current's direction (per second) */
const STEER = 1.6;
/** the pointer pushes letters away within this many px */
export const PART_R = 120;
const PART_FORCE = 520;
const ACCENT_LIFE = 4;
const GUEST_LIFE = 7;

export const moteCount = (w: number, h: number) => Math.round(Math.min(MAX_MOTES, Math.max(MIN_MOTES, w * h * DENSITY)));

const pick = (rand: () => number) => LETTERS[Math.floor(rand() * LETTERS.length)];

export function ambient(w: number, h: number, rand: () => number, age = rand() * 10): Mote {
  return { x: rand() * w, y: rand() * h, vx: 0, vy: 0, ch: pick(rand), age, span: 8 + rand() * 14, accent: 0, size: 10, guest: false };
}

/** The current at a point: a direction that turns slowly with place and time, and how fast it runs there. */
export function current(noise: (x: number, y: number, z: number) => number, x: number, y: number, t: number): { vx: number; vy: number } {
  const a = noise(x * 0.0016, y * 0.0016, t * 0.035) * Math.PI * 3;
  const s = SPEED[0] + (SPEED[1] - SPEED[0]) * noise(x * 0.004 + 31, y * 0.004 + 17, t * 0.05);
  return { vx: Math.cos(a) * s, vy: Math.sin(a) * s };
}

/**
 * One step of `dt` seconds. Ambient letters steer into the current and are born again (somewhere random) when they
 * leave the page or outlive their span; guests (typed, splashed) coast, then join the current as their accent fades,
 * and are dropped when done. Returns the letters still there. `pointer`: page px, or null.
 */
export function step(motes: Mote[], o: { dt: number; t: number; w: number; h: number; noise: (x: number, y: number, z: number) => number; pointer: { x: number; y: number } | null; rand: () => number; flicker: number }): Mote[] {
  const { dt, t, w, h, noise, pointer, rand } = o;
  const out: Mote[] = [];
  for (const m of motes) {
    m.age += dt;
    if (m.guest) {
      if (m.age > GUEST_LIFE) continue;
      m.accent = Math.max(0, 1 - m.age / ACCENT_LIFE);
      m.size = 10 + (m.size - 10) * Math.exp(-dt * 0.9);
    }
    // a guest coasts on its own push first, then the current takes it more and more
    const c = current(noise, m.x, m.y, t);
    const k = Math.min(1, dt * STEER * (m.guest ? Math.min(1, m.age / 1.5) : 1));
    m.vx += (c.vx - m.vx) * k;
    m.vy += (c.vy - m.vy) * k;
    if (pointer) {
      const dx = m.x - pointer.x, dy = m.y - pointer.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.5 && d < PART_R) {
        const f = (1 - d / PART_R) * PART_FORCE * dt;
        m.vx += (dx / d) * f;
        m.vy += (dy / d) * f;
      }
    }
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    if (rand() < o.flicker * dt && !m.guest) m.ch = pick(rand);
    const out_ = m.x < -20 || m.y < -20 || m.x > w + 20 || m.y > h + 20;
    if (!m.guest && (out_ || m.age > m.span)) { out.push(ambient(w, h, rand, 0)); continue; }
    if (m.guest && out_) continue;
    out.push(m);
  }
  return out;
}

/** How visible a letter is now (before the page's quiet zone): ambient ones fade in and out over their span. */
export function moteAlpha(m: Mote): number {
  if (m.guest) return Math.min(1, m.age / 0.15) * Math.max(0, 1 - Math.max(0, m.age - (GUEST_LIFE - 2)) / 2);
  const fadeIn = Math.min(1, m.age / 1.5);
  const fadeOut = Math.min(1, Math.max(0, m.span - m.age) / 1.5);
  return Math.min(fadeIn, fadeOut);
}

/** What you typed, floating up out of the box: one guest per character (a few at most), from where the caret is. */
export function typed(text: string, at: { x: number; y: number }, rand: () => number): Mote[] {
  return [...text].filter((c) => c.trim()).slice(0, 6).map((ch, i) => ({
    x: at.x + i * 9, y: at.y, vx: (rand() - 0.5) * 30, vy: -(45 + rand() * 40), ch, age: 0, span: GUEST_LIFE, accent: 1, size: 17, guest: true,
  }));
}

/** A click: a ring of accent letters thrown out from the point. */
export function splash(at: { x: number; y: number }, rand: () => number, n = 14): Mote[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + rand() * 0.3;
    const s = 70 + rand() * 60;
    return { x: at.x, y: at.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, ch: pick(rand), age: 0, span: GUEST_LIFE, accent: 1, size: 13, guest: true };
  });
}
