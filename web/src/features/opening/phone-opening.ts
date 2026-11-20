// The phone's opening (2026-11-20, the user after a real iPhone: 手机也要有动画). It was a still picture for a second;
// now Claude Web 娘's portrait comes up out of the dark, embers rise, a line of fire runs round the gold logo behind
// her and its letters flare, the orb in her hand ignites, then the logo and the wordmark come up below her.
//
// Framework-free (plain DOM + phone-opening.css, no app aliases): the app's PhoneSplash.tsx plays it when a phone
// opens the app by itself (局域网), and the phone shell (web/src/shell) plays it on its own start — while it connects,
// so a home-screen app goes from this straight into the app (the app inside the shell then skips its own).
import { EMBER_COLORS, EMBER_HALO, emberAlpha, emberCount, rgba, spawn, stepEmbers, type Ember } from './embers';

export interface PhoneOpeningOptions {
  /** The portrait's address (web/src/assets/opening/portrait.webp, 720 × 1080). */
  portrait: string;
  /** 完整, or 简短: the same steps about twice as fast. */
  full: boolean;
  /** 减少动态效果: the end frame at once, no embers, no fuse. */
  reduced: boolean;
  /** The screen reader's name for it (「Claude Web 正在打开」). */
  label: string;
}

export interface PhoneOpening {
  el: HTMLElement;
  /** Resolves when its motion has played; the end frame stays until out(). */
  played: Promise<void>;
  /** Jumps to the end frame (a tap): played resolves now. */
  skip(): void;
  /** A line under the wordmark (the shell: 正在连接 … and a 换电脑), or null to take it away. */
  status(text: string | null, action?: { label: string; run: () => void } | null): void;
  /** Fades out (0.35 s) and removes itself. */
  out(): Promise<void>;
}

/** How long the motion takes before the end frame holds (ms): 完整, 简短, reduced motion. */
export const PHONE_OPENING_MS = { full: 2900, short: 1600, reduced: 700 } as const;

/**
 * Whether this start plays 完整: 每次打开 plays the chosen length every time; 每天第一次 the day's first start, the
 * later ones 简短 (1.6 s, as long as the desktop's classic opening on those starts).
 */
export function playsFull(when: 'always' | 'daily', full: boolean, firstToday: boolean): boolean {
  return full && (when === 'always' || firstToday);
}

/** Whether this is the phone's first start today, marking today as started (this page's own storage: per phone). */
export function firstStartToday(key: string, today = new Date().toDateString()): boolean {
  try {
    const first = localStorage.getItem(key) !== today;
    localStorage.setItem(key, today);
    return first;
  } catch {
    // no storage here (a private window): every start is the first
    return true;
  }
}
/** The CSS timeline's speed (phone-opening.css multiplies every delay and duration by it). */
export const PHONE_OPENING_K = { full: 1, short: 0.55 } as const;
const OUT_MS = 360;

/**
 * Where the gold logo sits in the portrait (its own 720 × 1080 units): the rounded square the fuse runs round, the
 * letters' middle, the orb in her hand. Measured on the picture; the overlay and the picture share one viewBox.
 */
export const PORTRAIT_MARKS = {
  frame: { x: 191, y: 14, w: 334, h: 276, r: 74 },
  letters: { cx: 358, cy: 120 },
  orb: { cx: 158, cy: 244 },
} as const;

/** The rounded square as one path that starts at the top middle and runs clockwise (a fuse lit at the top). */
export function framePath(f: { x: number; y: number; w: number; h: number; r: number } = PORTRAIT_MARKS.frame): string {
  const { x, y, w, h, r } = f;
  const mx = x + w / 2;
  return [
    `M${mx} ${y}`,
    `H${x + w - r}`,
    `A${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    `V${y + h - r}`,
    `A${r} ${r} 0 0 1 ${x + w - r} ${y + h}`,
    `H${x + r}`,
    `A${r} ${r} 0 0 1 ${x} ${y + h - r}`,
    `V${y + r}`,
    `A${r} ${r} 0 0 1 ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

const SVG = 'http://www.w3.org/2000/svg';
let seq = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function svg(tag: string, attrs: Record<string, string | number>, ...kids: Element[]): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k);
  return e;
}

/** The logo (desktop/openings opening-logo.svg), as the desktop's opening draws it. */
function logo(): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 1024 1024', 'aria-hidden': 'true', class: 'ph-logo' },
    svg('rect', { width: 1024, height: 1024, rx: 236, fill: '#0B0B0C' }),
    svg(
      'g',
      { transform: 'translate(92 452)', fill: '#FFFFFF' },
      svg('path', { d: 'M0 260 V0 H250 V110 H120 V260 Z' }),
      svg('path', { d: 'M300 0 H420 L360 260 H240 Z' }),
      svg('path', { d: 'M460 -140 H580 V260 H460 Z' }),
      svg('circle', { cx: 710, cy: 130, r: 130, fill: '#FF5A1F' }),
    ),
  );
}

/** A spark's sprite: a warm core and its glow (drawn once per colour). */
function sprite(color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, rgba('#fff4dc', 1));
    grad.addColorStop(0.18, rgba(color, 0.95));
    grad.addColorStop(0.45, rgba(color, 0.32));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  return c;
}

/** The embers rising over her (embers.ts' motion, a little denser than the backdrop's), until stop(). */
function embers(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const sprites = EMBER_COLORS.dark.map(sprite);
  const rand = Math.random;
  let w = 0;
  let h = 0;
  let list: Ember[] = [];
  let raf = 0;
  let last = 0;
  const born = performance.now();
  const size = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.round(emberCount(w, h) * 1.6);
    list = list.slice(0, want);
    while (list.length < want) list.push(spawn(w, h, rand, true));
  };
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000);
    if (dt < 1 / 40) return;
    last = now;
    stepEmbers(list, dt * 1.4, w, h, rand);
    // they come up with her: none at first, all of them after a second
    const ramp = Math.min(1, (now - born) / 1100);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of list) {
      const r = e.s * EMBER_HALO;
      ctx.globalAlpha = emberAlpha(e) * 0.95 * ramp;
      ctx.drawImage(sprites[Math.floor((e.life / e.max) * sprites.length) % sprites.length], e.x - r, e.y - r, r * 2, r * 2);
    }
    ctx.restore();
  };
  size();
  last = performance.now();
  raf = requestAnimationFrame(tick);
  window.addEventListener('resize', size);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', size);
  };
}

/** Mounts the opening over everything in `host` and starts it. */
export function phoneOpening(host: HTMLElement, o: PhoneOpeningOptions): PhoneOpening {
  const id = `ph${++seq}`;
  const root = el('div', o.reduced ? 'ph-open still' : 'ph-open');
  root.setAttribute('role', 'presentation');
  root.style.setProperty('--k', String(o.full ? PHONE_OPENING_K.full : PHONE_OPENING_K.short));
  const m = PORTRAIT_MARKS;
  const path = framePath();
  const art = svg(
    'svg',
    { class: 'ph-art', viewBox: '0 0 720 1080', preserveAspectRatio: 'xMidYMin slice', 'aria-hidden': 'true' },
    svg(
      'defs',
      {},
      svg('filter', { id: `${id}-blur`, x: '-20%', y: '-20%', width: '140%', height: '140%' }, svg('feGaussianBlur', { stdDeviation: 7 })),
      svg(
        'radialGradient',
        { id: `${id}-orb` },
        svg('stop', { offset: '0', 'stop-color': '#fff6dc', 'stop-opacity': 1 }),
        svg('stop', { offset: '0.28', 'stop-color': '#ffc46a', 'stop-opacity': 0.9 }),
        svg('stop', { offset: '0.6', 'stop-color': '#ff5a1f', 'stop-opacity': 0.35 }),
        svg('stop', { offset: '1', 'stop-color': '#ff5a1f', 'stop-opacity': 0 }),
      ),
      svg(
        'radialGradient',
        { id: `${id}-flare` },
        svg('stop', { offset: '0', 'stop-color': '#ffe2a8', 'stop-opacity': 0.85 }),
        svg('stop', { offset: '0.5', 'stop-color': '#ffb347', 'stop-opacity': 0.3 }),
        svg('stop', { offset: '1', 'stop-color': '#ff8a3d', 'stop-opacity': 0 }),
      ),
    ),
    svg('image', { href: o.portrait, width: 720, height: 1080, preserveAspectRatio: 'xMidYMin slice' }),
    // the line of fire round the logo behind her: a wide glow, the burnt line, and a bright head running ahead
    svg('path', { class: 'ph-fuse-glow', d: path, pathLength: 1000, filter: `url(#${id}-blur)` }),
    svg('path', { class: 'ph-fuse', d: path, pathLength: 1000 }),
    svg('path', { class: 'ph-fuse-head', d: path, pathLength: 1000 }),
    svg('ellipse', { class: 'ph-flare', cx: m.letters.cx, cy: m.letters.cy, rx: 175, ry: 95, fill: `url(#${id}-flare)` }),
    svg('circle', { class: 'ph-orb', cx: m.orb.cx, cy: m.orb.cy, r: 70, fill: `url(#${id}-orb)` }),
  );
  const canvas = el('canvas', 'ph-embers');
  const stat = el('div', 'ph-status');
  stat.hidden = true;
  const mark = el('div', 'ph-mark');
  mark.setAttribute('aria-label', o.label);
  const word = el('div', 'w');
  word.append(el('span', 'c', 'Claude'), document.createTextNode('Web'));
  const by = el('div', 'by');
  by.append(el('span', '', 'by'), document.createTextNode('Super NB'));
  mark.append(logo(), word, by, stat);
  root.append(art, canvas, el('i', 'ph-fade'), mark);
  host.append(root);

  const stopEmbers = o.reduced ? () => {} : embers(canvas);
  let resolvePlayed: () => void = () => {};
  const played = new Promise<void>((r) => (resolvePlayed = r));
  const ms = o.reduced ? PHONE_OPENING_MS.reduced : o.full ? PHONE_OPENING_MS.full : PHONE_OPENING_MS.short;
  const timer = setTimeout(() => resolvePlayed(), ms);
  let gone: Promise<void> | null = null;

  return {
    el: root,
    played,
    skip() {
      root.classList.add('end');
      clearTimeout(timer);
      resolvePlayed();
    },
    status(text, action) {
      stat.replaceChildren();
      stat.hidden = !text;
      if (!text) return;
      stat.append(el('span', 'ph-status-text', text));
      if (action) {
        const b = el('button', 'ph-status-act', action.label);
        b.type = 'button';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          action.run();
        });
        stat.append(b);
      }
    },
    out() {
      if (gone) return gone;
      clearTimeout(timer);
      resolvePlayed();
      root.classList.add('out');
      gone = new Promise<void>((r) =>
        setTimeout(() => {
          stopEmbers();
          root.remove();
          r();
        }, OUT_MS),
      );
      return gone;
    },
  };
}
