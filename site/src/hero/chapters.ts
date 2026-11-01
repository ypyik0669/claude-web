// What each chapter of the home page shows (spec §4.3): where the camera looks, which demo phase it needs (jumped to
// when the loop is elsewhere), whose seat the overlay hangs on. The texts are in copy.ts.
import { onPage, type SceneSize, type View } from './engine';
import type { DemoPhase, GUESTS } from './demo';

export type ChapterId = 'agents' | 'turns' | 'permission' | 'review' | 'checkout' | 'elsewhere';
export interface ChapterLook { u: number; v: number; h?: number; zoom: number }
export interface ChapterSpec {
  id: ChapterId;
  look: ChapterLook;
  /** The phase to jump to when the loop is not in one of `ok`; null: any moment will do. */
  jump: DemoPhase | null;
  ok: DemoPhase[];
  /** The guest the overlay hangs over (and the camera follows). */
  focus: keyof typeof GUESTS | null;
  /** copy(locale).scene.labels[label]: the scene's aria-label in this chapter. */
  label: ChapterId;
}

export const CAMERA_MS = 400;
/**
 * The first screen. Desktops: the room pulled out a little and to the right, so the door (and its sign) and the
 * counter (the admin's bubble) stand right of the copy column (`.hero-copy`, 600 CSS px) from 1280 px wide up; the
 * far right of the room is cut off instead. Phones (copy below the scene): the middle of the room.
 */
export const HERO_LOOK: ChapterLook = { u: 6.5, v: 15.5, zoom: 0.8 };
export const HERO_LOOK_PHONE: ChapterLook = { u: 14, v: 8, zoom: 1 };
/** The copy column's width on desktops (site.css: .hero-copy max-width). */
export const HERO_COPY_PX = 600;
export const heroLookFor = (cssWidth: number): ChapterLook => (cssWidth < 720 ? HERO_LOOK_PHONE : HERO_LOOK);
// seats of the demo's one row: api u 7, tests u 10, docs u 13, lint u 16 (v 3, chair v 4); counter u 1–2 v 12–14;
// the door (2, 17)
export const CHAPTERS: ChapterSpec[] = [
  { id: 'agents', look: { u: 14, v: 8, zoom: 1.1 }, jump: null, ok: [], focus: null, label: 'agents' },
  { id: 'turns', look: { u: 8, v: 4, h: 8, zoom: 2.2 }, jump: 'noodles', ok: ['noodles', 'needsYou'], focus: 'api', label: 'turns' },
  { id: 'permission', look: { u: 8, v: 4, h: 8, zoom: 2.6 }, jump: 'needsYou', ok: ['needsYou'], focus: 'api', label: 'permission' },
  { id: 'review', look: { u: 11, v: 4, h: 8, zoom: 2.2 }, jump: 'noodles', ok: ['arrive', 'noodles', 'needsYou'], focus: 'tests', label: 'review' },
  { id: 'checkout', look: { u: 2.5, v: 13, h: 6, zoom: 2.4 }, jump: 'checkout', ok: ['checkout'], focus: null, label: 'checkout' },
  { id: 'elsewhere', look: { u: 6, v: 13, zoom: 1.4 }, jump: 'guest', ok: ['guest'], focus: 'lint', label: 'elsewhere' },
];

export const chapterById = (id: string): ChapterSpec | undefined => CHAPTERS.find((c) => c.id === id);

/** Where on the stage the camera's point goes: the middle on phones (copy below), right of the copy on desktops. */
export function anchorFor(cssWidth: number): { x: number; y: number } {
  return cssWidth < 720 ? { x: 0.5, y: 0.36 } : { x: 0.64, y: 0.52 };
}

/** The view that shows `look` at `anchor` of a cw × ch canvas; at zoom 1 the room covers the canvas. */
export function cameraView(look: ChapterLook, sz: SceneSize, cw: number, ch: number, anchor: { x: number; y: number }): View {
  const scale = Math.max(cw / sz.w, ch / sz.h) * look.zoom;
  const p = onPage({ scale, x: 0, y: 0 }, sz, look.u, look.v, look.h ?? 0);
  return { scale, x: anchor.x * cw - p.x, y: anchor.y * ch - p.y };
}

export function easeView(a: View, b: View, k: number): View {
  const t = Math.min(1, Math.max(0, k));
  if (t === 0) return { ...a };
  if (t === 1) return { ...b };
  const e = 1 - (1 - t) ** 3;
  return { scale: a.scale + (b.scale - a.scale) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
}
