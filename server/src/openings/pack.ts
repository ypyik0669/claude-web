// 开场动画包 (界面改版方案 第 7 版 #opening): a folder with an opening.json — the built-in ones travel with the app
// (CLAUDE_WEB_OPENINGS: desktop/openings, `resources/openings` when packaged), the user's live in
// <data dir>/openings/<id>/. Only video packs so far: `intro` is the film (at most 12 s are played), `logoAt` the second
// it cuts to black and the logo takes over, `shortFrom` where 简短 starts, `loop` what stays behind the app, `poster`
// the card in 设置 › 外观. The desktop shell reads the same file before the server is up (desktop/src/opening-pack.ts).
// Pure.
import type { OpeningInfo } from '../protocol.js';
import { tr } from '../i18n/index.js';

export const OPENING_MAX_SECONDS = 12;
export const PACK_FILE = 'opening.json';
/** a pack's folder name: what the settings store and the addresses carry */
export const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const VIDEO = /\.(mp4|webm|mov)$/i;
const IMAGE = /\.(webp|png|jpe?g)$/i;

/** One plain file name inside the pack's folder (no folders, nothing that climbs out). */
export const safeFile = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 120 && s !== '.' && s !== '..' && !/[\\/:*?"<>|\0]/.test(s);

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const sec = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 1000) / 1000 : undefined);

/**
 * An opening.json read for listing / importing: what the app may use of it, or why it cannot be used. Files are only
 * named here — whether they are in the folder is the caller's to check (`files()` lists the ones to look for).
 */
export function readPack(json: unknown, id: string, builtin: boolean): OpeningInfo | { error: string } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { error: tr('opening.json 不是一个 JSON 对象') };
  const j = json as Record<string, unknown>;
  if (j.kind !== 'video') return { error: tr('现在只认视频做的开场：opening.json 里要写 "kind": "video"') };
  if (!safeFile(j.intro) || !VIDEO.test(j.intro)) return { error: tr('intro 要写成这个文件夹里的一个视频文件名（mp4 / webm / mov）') };
  if (j.loop !== undefined && (!safeFile(j.loop) || !VIDEO.test(j.loop))) return { error: tr('loop 要写成这个文件夹里的一个视频文件名（mp4 / webm / mov）') };
  if (j.poster !== undefined && (!safeFile(j.poster) || !IMAGE.test(j.poster))) return { error: tr('poster 要写成这个文件夹里的一张图片（webp / png / jpg）') };
  const maxSeconds = Math.min(OPENING_MAX_SECONDS, sec(j.maxSeconds) || OPENING_MAX_SECONDS);
  const logoAt = sec(j.logoAt);
  const shortFrom = sec(j.shortFrom);
  return {
    id, builtin, kind: 'video',
    name: str(j.name, 60) ?? id,
    ...(str(j.author, 80) ? { author: str(j.author, 80) } : {}),
    ...(str(j.license, 60) ? { license: str(j.license, 60) } : {}),
    ...(str(j.credits, 300) ? { credits: str(j.credits, 300) } : {}),
    intro: j.intro,
    ...(j.loop ? { loop: j.loop as string } : {}),
    ...(j.poster ? { poster: j.poster as string } : {}),
    ...(logoAt !== undefined ? { logoAt: Math.min(logoAt, maxSeconds) } : {}),
    ...(shortFrom !== undefined ? { shortFrom: Math.min(shortFrom, maxSeconds) } : {}),
    maxSeconds,
  };
}

/** The files a pack uses (the only ones copied on import and served to the app). */
export const packFiles = (p: Pick<OpeningInfo, 'intro' | 'loop' | 'poster'>) => [p.intro, p.loop, p.poster].filter((f): f is string => !!f);

/** A folder name for a new pack: from `name`, lower-case ASCII, not one of `taken` (opening, opening-2, …). */
export function packIdFor(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[-.]+$/g, '').slice(0, 40) || 'opening';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
