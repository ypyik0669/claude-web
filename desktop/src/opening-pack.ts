// 开场动画 · the shell's side: which opening a start shows (设置 › 外观 › 开场和背景, read from meta.json before the
// server is up), where its pack is, and the files of that pack served to the opening page on cw-opening://.
//
// A pack is a folder with an opening.json (界面改版方案 第 7 版 #opening): the built-in ones travel with the app
// (desktop/openings, `resources/openings` when packaged), the user's are in <data dir>/openings/<id>/ (the server
// imports them: server/src/openings). Only `kind: "video"` packs exist so far.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { OPENING_SCHEME, filmTimes } from './opening';

export type OpeningWhen = 'always' | 'daily' | 'never';
/** The built-in video pack, the default opening. */
export const DEFAULT_PACK = 'claude-web-chan';
/** 点火: the opening drawn without a video (no pack folder). */
export const IGNITE_ID = 'ignite';

/** The data directory (meta.json, openings/): CLAUDE_WEB_DIR, else ~/.claude-web — the server's own rule. */
export const dataDir = (env: NodeJS.ProcessEnv = process.env) => env.CLAUDE_WEB_DIR || path.join(os.homedir(), '.claude-web');

/** meta.json's settings, read once at start (the server writes them; the shell only reads). */
export function readMetaSettings(dir = dataDir()): Record<string, unknown> {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))?.settings;
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

/** The opening settings (`ui.opening.*`) with their defaults: Claude Web 娘, the first start of a day, full, no sound. */
export function openingSettings(s: Record<string, unknown>): { pack: string; when: OpeningWhen; full: boolean; sound: boolean } {
  const pack = s['ui.opening.pack'];
  const when = s['ui.opening.when'];
  return {
    pack: typeof pack === 'string' && pack ? pack : DEFAULT_PACK,
    when: when === 'always' || when === 'never' ? when : 'daily',
    full: s['ui.opening.length'] !== 'short',
    sound: s['ui.opening.sound'] === true,
  };
}

/** The local calendar day, for 每天第一次. */
export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Which opening this start shows: the chosen one (`fancy`) every time / on the day's first start, the classic 1.6 s
 * one the other times, its last frame only when the opening is off (the window still needs something while the server
 * starts). A start into the tray (`--hidden`) shows nobody anything: the classic page, and the day is not used up.
 */
export function pickOpening(o: { when: OpeningWhen; today: string; lastDay?: unknown; hidden: boolean }): { show: 'fancy' | 'classic' | 'still'; markDay: boolean } {
  if (o.hidden) return { show: 'classic', markDay: false };
  if (o.when === 'never') return { show: 'still', markDay: false };
  if (o.when === 'daily' && o.lastDay === o.today) return { show: 'classic', markDay: false };
  return { show: 'fancy', markDay: true };
}

/** The app's shell ground (tokens.css `--bg-1`) for a `ui.theme`, so the opening ends on the colour the app starts on. */
export function groundOf(theme: unknown, systemDark: boolean): { ground: string; dark: boolean } {
  const t = typeof theme === 'string' ? theme : 'system';
  const grounds: Record<string, string> = { dark: '#12110f', light: '#f7f6f2', dracula: '#21222c', nord: '#272c36', 'tokyo-night': '#16161e', paper: '#f1ece1' };
  if (grounds[t]) return { ground: grounds[t], dark: t !== 'light' && t !== 'paper' };
  // the system's, or a character theme (it lays its colours over the classic theme of its brightness; the shell cannot
  // tell which without the theme itself — the system's brightness is the best guess)
  return systemDark ? { ground: grounds.dark, dark: true } : { ground: grounds.light, dark: false };
}

/** A pack folder's name / a file in it: one plain path segment. */
export const safeSegment = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 120 && s !== '.' && s !== '..' && !/[\\/:*?"<>|\0]/.test(s);

export interface ShellPack { id: string; dir: string; intro: string; logoAt: number | null; shortFrom: number; maxSeconds: number }

/** The pack `id` in the first root that has it (the built-in ones first): a video pack whose film is there, or null. */
export function resolvePack(id: string, roots: string[]): ShellPack | null {
  if (!safeSegment(id)) return null;
  for (const root of roots) {
    const dir = path.join(root, id);
    let j: any;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, 'opening.json'), 'utf8')); } catch { continue; }
    if (j?.kind !== 'video' || !safeSegment(j.intro) || !fs.existsSync(path.join(dir, j.intro))) return null;
    return { id, dir, intro: j.intro, ...filmTimes(j) };
  }
  return null;
}

/** The address the opening page plays a pack's file from. */
export const packFileUrl = (id: string, file: string) => `${OPENING_SCHEME}://pack/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;

const MEDIA: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/**
 * Parse a single `Range: bytes=` header against a file size (server/src/index.ts `parseRange`, the same rules): null
 * for the whole file, 'unsatisfiable' for a range outside it, else inclusive [start, end].
 */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || !size || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; } else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** cw-opening://pack/<id>/<file> → that media file of that pack, or null (anything else is not served). */
export function packFilePath(url: string, roots: string[]): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${OPENING_SCHEME}:` || u.hostname !== 'pack') return null;
  let parts: string[];
  try { parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (parts.length !== 2 || !parts.every(safeSegment) || !MEDIA[path.extname(parts[1]).toLowerCase()]) return null;
  for (const root of roots) {
    const p = path.join(root, parts[0], parts[1]);
    if (path.dirname(path.dirname(p)) !== path.resolve(root)) continue;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* the next root */ }
  }
  return null;
}

/** The response for one request of the opening page (protocol.handle): the file, a range of it (a video seeks), or 404. */
export function packResponse(req: { url: string; headers: { get(name: string): string | null } }, roots: string[]): Response {
  const p = packFilePath(req.url, roots);
  if (!p) return new Response('not found', { status: 404 });
  let size: number;
  try { size = fs.statSync(p).size; } catch { return new Response('not found', { status: 404 }); }
  const type = MEDIA[path.extname(p).toLowerCase()];
  const range = parseRange(req.headers.get('range'), size);
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const body = (opts?: { start: number; end: number }) => Readable.toWeb(fs.createReadStream(p, opts)) as unknown as ReadableStream;
  if (range) {
    return new Response(body(range), { status: 206, headers: { 'Content-Type': type, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(range.end - range.start + 1), 'Accept-Ranges': 'bytes' } });
  }
  return new Response(body(), { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
}
