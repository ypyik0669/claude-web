// 开场动画包 (界面改版方案 第 7 版 #opening): a folder with an opening.json — the built-in ones travel with the app
// (CLAUDE_WEB_OPENINGS: desktop/openings, `resources/openings` when packaged), the user's live in
// <data dir>/openings/<id>/. Two kinds:
// - video: `intro` is the film (at most 12 s are played), `logoAt` the second it cuts to black and the logo takes over,
//   `shortFrom` where 简短 starts, `loop` what stays behind the app;
// - web: `entry` (index.html by default) is one self-contained page — its images, fonts and sounds inside it as data:
//   URIs — that plays in a sandboxed frame without network and says when it is done (`cwOpening.done()`); it is cut at
//   `maxSeconds` (at most 12) and 点火 plays instead.
// `poster` is the card in 设置 › 外观. The desktop shell reads the same file before the server is up
// (desktop/src/opening-pack.ts). Pure.
import type { OpeningInfo } from '../protocol.js';
import { tr } from '../i18n/index.js';

export const OPENING_MAX_SECONDS = 12;
export const PACK_FILE = 'opening.json';
/** a web pack's page may be at most this big (desktop/src/opening-pack.ts WEB_ENTRY_MAX) */
export const WEB_ENTRY_MAX = 8 * 1024 * 1024;
/** a pack's folder name: what the settings store and the addresses carry */
export const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,47}$/;
/** ids the app gives the openings without a folder (点火 / 星图 / 字符雨 / 网吧开门): never a pack's */
export const RESERVED_IDS: ReadonlySet<string> = new Set(['ignite', 'stars', 'ascii', 'cafe']);
const VIDEO = /\.(mp4|webm|mov)$/i;
const IMAGE = /\.(webp|png|jpe?g)$/i;
const HTML = /\.html?$/i;

/** One plain file name inside the pack's folder (no folders, nothing that climbs out). */
export const safeFile = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 120 && s !== '.' && s !== '..' && !/[\\/:*?"<>|\0]/.test(s);

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const sec = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 1000) / 1000 : undefined);

/**
 * An opening.json read for listing / importing: what the app may use of it, or why it cannot be used. Files are only
 * named here — whether they are in the folder is the caller's to check (`packFiles()` lists the ones to look for).
 */
export function readPack(json: unknown, id: string, builtin: boolean): OpeningInfo | { error: string } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { error: tr('opening.json 不是一个 JSON 对象') };
  const j = json as Record<string, unknown>;
  if (j.kind !== 'video' && j.kind !== 'web') return { error: tr('kind 要写 "video"（视频做的开场）或 "web"（一个网页做的开场）') };
  if (j.poster !== undefined && (!safeFile(j.poster) || !IMAGE.test(j.poster))) return { error: tr('poster 要写成这个文件夹里的一张图片（webp / png / jpg）') };
  const maxSeconds = Math.min(OPENING_MAX_SECONDS, sec(j.maxSeconds) || OPENING_MAX_SECONDS);
  const common = {
    id, builtin,
    name: str(j.name, 60) ?? id,
    ...(str(j.author, 80) ? { author: str(j.author, 80) } : {}),
    ...(str(j.license, 60) ? { license: str(j.license, 60) } : {}),
    ...(str(j.credits, 300) ? { credits: str(j.credits, 300) } : {}),
    ...(j.poster ? { poster: j.poster as string } : {}),
  };
  if (j.kind === 'web') {
    const entry = j.entry === undefined ? 'index.html' : j.entry;
    if (!safeFile(entry) || !HTML.test(entry)) return { error: tr('entry 要写成这个文件夹里的一个网页文件名（.html），不写就是 index.html') };
    return { ...common, kind: 'web', entry, maxSeconds };
  }
  if (!safeFile(j.intro) || !VIDEO.test(j.intro)) return { error: tr('intro 要写成这个文件夹里的一个视频文件名（mp4 / webm / mov）') };
  if (j.loop !== undefined && (!safeFile(j.loop) || !VIDEO.test(j.loop))) return { error: tr('loop 要写成这个文件夹里的一个视频文件名（mp4 / webm / mov）') };
  const logoAt = sec(j.logoAt);
  const shortFrom = sec(j.shortFrom);
  return {
    ...common, kind: 'video',
    intro: j.intro,
    ...(j.loop ? { loop: j.loop as string } : {}),
    ...(logoAt !== undefined ? { logoAt: Math.min(logoAt, maxSeconds) } : {}),
    ...(shortFrom !== undefined ? { shortFrom: Math.min(shortFrom, maxSeconds) } : {}),
    maxSeconds,
  };
}

/** A pack's main file: its film (video) or its page (web). */
export const mainFile = (p: Pick<OpeningInfo, 'kind' | 'intro' | 'entry'>): string => (p.kind === 'web' ? p.entry ?? 'index.html' : p.intro ?? '');

/** The files a pack uses (the only ones copied on import and served to the app). */
export const packFiles = (p: Pick<OpeningInfo, 'intro' | 'entry' | 'loop' | 'poster'>) => [p.intro, p.entry, p.loop, p.poster].filter((f): f is string => !!f);

/** A folder name for a new pack: from `name`, lower-case ASCII, not one of `taken` (opening, opening-2, …) nor an id of the app's. */
export function packIdFor(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[-.]+$/g, '').slice(0, 40) || 'opening';
  const free = (id: string) => !taken.has(id) && !RESERVED_IDS.has(id);
  if (free(base)) return base;
  for (let i = 2; ; i++) if (free(`${base}-${i}`)) return `${base}-${i}`;
}
