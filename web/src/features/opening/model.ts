// 开场和背景 (设置 › 外观; 界面改版方案 第 7 版 #opening): the settings and the rules, pure. The desktop shell reads the
// same keys from meta.json before the server is up (desktop/src/opening-pack.ts `openingSettings`) — the defaults here
// and there must agree: Claude Web 娘, each day's first start, full length, no sound, the loop kept at 30%.
import type { OpeningInfo } from '@shared';
import { backdropOn } from '@/features/home/letter-flow';

export const OPENING_KEYS = {
  pack: 'ui.opening.pack',
  when: 'ui.opening.when',
  length: 'ui.opening.length',
  sound: 'ui.opening.sound',
  keep: 'ui.opening.keep',
  opacity: 'ui.opening.opacity',
} as const;

/** the built-in video pack (desktop/openings/claude-web-chan) */
export const DEFAULT_PACK = 'claude-web-chan';
/** 点火: drawn, no video, no folder */
export const IGNITE_ID = 'ignite';
/** the three drawn scenes of the 轻量版 (desktop/src/opening.ts DRAWN_KINDS): 点火 · 星图 · 字符雨 */
export const DRAWN_IDS = ['ignite', 'stars', 'ascii'] as const;
export type DrawnId = (typeof DRAWN_IDS)[number];
export const isDrawnId = (id: unknown): id is DrawnId => id === 'ignite' || id === 'stars' || id === 'ascii';
/** 网吧开门: the 3D cafe (its script: web/dist/opening/cafe-opening.js) */
export const CAFE_ID = 'cafe';
export const OPACITY_DEFAULT = 30;
export const OPACITY_MAX = 60;

export type OpeningWhen = 'always' | 'daily' | 'never';

export const packOf = (s: Record<string, unknown>): string => {
  const v = s[OPENING_KEYS.pack];
  return typeof v === 'string' && v ? v : DEFAULT_PACK;
};
export const whenOf = (s: Record<string, unknown>): OpeningWhen => {
  const v = s[OPENING_KEYS.when];
  return v === 'always' || v === 'never' ? v : 'daily';
};
export const fullOf = (s: Record<string, unknown>) => s[OPENING_KEYS.length] !== 'short';
export const soundOf = (s: Record<string, unknown>) => s[OPENING_KEYS.sound] === true;

/**
 * 放完留作背景: on unless switched off. While it was never set, someone who had turned 背景动画 off (they asked for a
 * still page) does not get a moving one out of the blue.
 */
export function keepOn(s: Record<string, unknown>): boolean {
  const v = s[OPENING_KEYS.keep];
  return typeof v === 'boolean' ? v : backdropOn(s);
}

/** 浓淡: how much of the background shows through the shell (0–60 %, 30 by default). */
export function opacityOf(s: Record<string, unknown>): number {
  const raw = s[OPENING_KEYS.opacity];
  const v = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(v) ? Math.max(0, Math.min(OPACITY_MAX, Math.round(v))) : OPACITY_DEFAULT;
}

export type BackdropKind = { kind: 'video'; pack: OpeningInfo; src: string } | { kind: 'embers' } | { kind: 'stars' } | { kind: 'rain' } | null;

/**
 * What stays behind the app: her loop on a dark theme (the film is dark — under a light shell it turns grey), 火星 on a
 * light one or for a pack without a loop (点火, 网吧开门 and the web packs too); 星图 leaves its stars, 字符雨 its
 * characters, drifting (in either brightness). Nothing on a phone, with 留作背景 off, or under a character theme that
 * brings its own backdrop (that theme is the look the user picked). `packs` null: not known yet — nothing until it is.
 */
export function backdropKind(o: { keep: boolean; mobile: boolean; light: boolean; themeBackdrop: boolean; pack: string; packs: OpeningInfo[] | null; url: (id: string, file: string) => string }): BackdropKind {
  if (!o.keep || o.mobile || o.themeBackdrop) return null;
  if (o.pack === 'stars') return { kind: 'stars' };
  if (o.pack === 'ascii') return { kind: 'rain' };
  if (o.light) return { kind: 'embers' };
  if (o.pack === IGNITE_ID || o.pack === CAFE_ID) return { kind: 'embers' };
  if (!o.packs) return null;
  const p = o.packs.find((x) => x.id === o.pack);
  return p?.loop ? { kind: 'video', pack: p, src: o.url(p.id, p.loop) } : { kind: 'embers' };
}

/** The shell's alpha over the background: the sidebar side keeps more of itself than the start page (the reference's 0.55). */
export function shellSolid(opacity: number): { side: string; main: string } {
  const op = Math.max(0, Math.min(OPACITY_MAX, opacity));
  return { side: `${Math.round((100 - op * 0.55) * 10) / 10}%`, main: `${100 - op}%` };
}

/** The address of a pack's file on the server (token-guarded like api/file). */
export function packFileUrl(id: string, file: string, token: string | null): string {
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return `api/opening/${encodeURIComponent(id)}/${encodeURIComponent(file)}${q}`;
}

/** A card of 设置 › 外观 › 开场动画: a pack (video or web), a drawn scene, or 网吧开门 (one member per kind, so a check narrows). */
export type OpeningCard =
  | { id: string; kind: 'video'; pack: OpeningInfo }
  | { id: string; kind: 'web'; pack: OpeningInfo }
  | { id: 'ignite'; kind: 'ignite' }
  | { id: 'stars'; kind: 'stars' }
  | { id: 'ascii'; kind: 'ascii' }
  | { id: typeof CAFE_ID; kind: 'cafe' };

/**
 * The cards (界面改版方案 第 7 版 #opening, 六种开场): the built-in video packs (Claude Web 娘), 点火, 星图, 字符雨,
 * 网吧开门, then the user's packs; 自己的视频 is the last card, drawn by the picker itself.
 */
export function openingCards(packs: OpeningInfo[]): OpeningCard[] {
  const asCard = (pack: OpeningInfo): OpeningCard => (pack.kind === 'web' ? { id: pack.id, kind: 'web', pack } : { id: pack.id, kind: 'video', pack });
  return [
    ...packs.filter((p) => p.builtin).map(asCard),
    ...DRAWN_IDS.map((id) => ({ id, kind: id }) as OpeningCard),
    { id: CAFE_ID, kind: 'cafe' },
    ...packs.filter((p) => !p.builtin).map(asCard),
  ];
}

/** The ids that are always there (no folder): what a chosen id that is not a pack can still be. */
export const isBuiltinId = (id: string) => isDrawnId(id) || id === CAFE_ID;
