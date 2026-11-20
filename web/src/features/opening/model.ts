// 开场和背景 (设置 › 外观; 界面改版方案 第 7 版 #opening): the settings and the rules, pure. The desktop shell reads the
// same keys from meta.json before the server is up (desktop/src/opening-pack.ts `openingSettings`) — the defaults here
// and there must agree: Claude Web 娘, each day's first start, full length, no sound, the loop kept at 30%.
import type { OpeningInfo } from '@shared';
import { backdropOff } from '@/features/home/letter-flow';

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
  // (背景动画 is off by default since redesign 2026-11: only one switched off on purpose holds this back)
  return typeof v === 'boolean' ? v : !backdropOff(s);
}

/** 浓淡: how much of the background shows through the shell (0–60 %, 30 by default). */
export function opacityOf(s: Record<string, unknown>): number {
  const raw = s[OPENING_KEYS.opacity];
  const v = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(v) ? Math.max(0, Math.min(OPACITY_MAX, Math.round(v))) : OPACITY_DEFAULT;
}

export type BackdropKind = { kind: 'video'; pack: OpeningInfo; src: string } | { kind: 'embers' } | null;

/**
 * What stays behind the app: her loop on a dark theme (the film is dark — under a light shell it turns grey), 火星 on a
 * light one or for a pack without a loop (点火 too). Nothing on a phone, with 留作背景 off, or under a character theme
 * that brings its own backdrop (that theme is the look the user picked). `packs` null: not known yet — nothing until it is.
 */
export function backdropKind(o: { keep: boolean; mobile: boolean; light: boolean; themeBackdrop: boolean; pack: string; packs: OpeningInfo[] | null; url: (id: string, file: string) => string }): BackdropKind {
  if (!o.keep || o.mobile || o.themeBackdrop) return null;
  if (o.light) return { kind: 'embers' };
  if (o.pack === IGNITE_ID) return { kind: 'embers' };
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

/** The cards of 设置 › 外观 › 开场动画: the built-in video packs, 点火, the user's packs (自己的视频 is the last card). */
export function openingCards(packs: OpeningInfo[]): ({ id: string; kind: 'video'; pack: OpeningInfo } | { id: typeof IGNITE_ID; kind: 'ignite' })[] {
  const builtin = packs.filter((p) => p.builtin);
  const mine = packs.filter((p) => !p.builtin);
  return [...builtin.map((pack) => ({ id: pack.id, kind: 'video' as const, pack })), { id: IGNITE_ID, kind: 'ignite' as const }, ...mine.map((pack) => ({ id: pack.id, kind: 'video' as const, pack }))];
}
