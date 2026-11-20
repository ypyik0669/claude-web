// 开场动画 · the shell's side: which opening a start shows (设置 › 外观 › 开场和背景, read from meta.json before the
// server is up), where its pack is, and the files of that pack served to the opening page on cw-opening://.
//
// A pack is a folder with an opening.json (界面改版方案 第 7 版 #opening): the built-in ones travel with the app
// (desktop/openings, `resources/openings` when packaged), the user's are in <data dir>/openings/<id>/ (the server
// imports them: server/src/openings). `kind: "video"` (a film) or `kind: "web"` (one self-contained index.html, run in a
// sandboxed frame of the opening page). The drawn scenes (点火 / 星图 / 字符雨) and 网吧开门 have no folder: 网吧开门's
// script (three.js and the cafe) is built into the web app's dist (web/vite.opening.config.ts) and served from here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { OPENING_SCHEME, filmTimes, isDrawnKind, type DrawnKind } from './opening';

export type OpeningWhen = 'always' | 'daily' | 'never';
/** The built-in video pack, the default opening. */
export const DEFAULT_PACK = 'claude-web-chan';
/** 点火: the opening drawn without a video (no pack folder). 星图 / 字符雨 are the other two drawn scenes. */
export const IGNITE_ID = 'ignite';
/** 网吧开门: the 3D cafe (no pack folder: its script is web/dist/opening/cafe-opening.js). */
export const CAFE_ID = 'cafe';
/** The cafe's script, inside the web app's dist. */
export const CAFE_SCRIPT = path.join('opening', 'cafe-opening.js');
/** A web pack's page may be at most this big (everything in it: images and sounds as data: URIs). */
export const WEB_ENTRY_MAX = 8 * 1024 * 1024;

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

/**
 * The opening settings (`ui.opening.*`) with their defaults (web/src/features/opening/model.ts has the same): Claude
 * Web 娘, every start, full, with sound.
 */
export function openingSettings(s: Record<string, unknown>): { pack: string; when: OpeningWhen; full: boolean; sound: boolean } {
  const pack = s['ui.opening.pack'];
  const when = s['ui.opening.when'];
  return {
    pack: typeof pack === 'string' && pack ? pack : DEFAULT_PACK,
    when: when === 'daily' || when === 'never' ? when : 'always',
    full: s['ui.opening.length'] !== 'short',
    sound: s['ui.opening.sound'] !== false,
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

export type ShellPack =
  | { kind: 'video'; id: string; dir: string; intro: string; logoAt: number | null; shortFrom: number; maxSeconds: number }
  | { kind: 'web'; id: string; dir: string; entry: string; maxSeconds: number };

/** The pack `id` in the first root that has it (the built-in ones first): a video pack whose film / a web pack whose page is there, or null. */
export function resolvePack(id: string, roots: string[]): ShellPack | null {
  if (!safeSegment(id)) return null;
  for (const root of roots) {
    const dir = path.join(root, id);
    let j: any;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, 'opening.json'), 'utf8')); } catch { continue; }
    if (j?.kind === 'web') {
      const entry = j.entry === undefined ? 'index.html' : j.entry;
      if (!safeSegment(entry) || !/\.html?$/i.test(entry) || !fs.existsSync(path.join(dir, entry))) return null;
      return { kind: 'web', id, dir, entry, maxSeconds: filmTimes({ maxSeconds: j.maxSeconds }).maxSeconds };
    }
    if (j?.kind !== 'video' || !safeSegment(j.intro) || !fs.existsSync(path.join(dir, j.intro))) return null;
    return { kind: 'video', id, dir, intro: j.intro, ...filmTimes(j) };
  }
  return null;
}

/** A web pack's page (at most WEB_ENTRY_MAX), or null. */
export function readWebEntry(p: Extract<ShellPack, { kind: 'web' }>): string | null {
  try {
    const f = path.join(p.dir, p.entry);
    if (fs.statSync(f).size > WEB_ENTRY_MAX) return null;
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
}

/**
 * What a fancy start plays for the chosen pack: a drawn scene, 网吧开门 (its script built — else 点火), a pack found in
 * a root (else 点火: removed, or a half copy). `why` is for main.log when it is not what was chosen.
 */
export function chooseOpening(pack: string, o: { roots: string[]; cafeScript: string | null }):
  | { kind: DrawnKind; why?: string }
  | { kind: 'cafe' }
  | { kind: 'video' | 'web'; pack: ShellPack } {
  if (isDrawnKind(pack)) return { kind: pack };
  if (pack === CAFE_ID) return o.cafeScript ? { kind: 'cafe' } : { kind: 'ignite', why: 'the cafe script is not built' };
  const p = resolvePack(pack, o.roots);
  return p ? { kind: p.kind, pack: p } : { kind: 'ignite', why: `pack ${pack} missing` };
}

/** The web app's dist folder (packaged: inside app.asar; from source: web/dist) — where the cafe's script is. */
export const cafeScriptPath = (webDist: string): string | null => {
  const f = path.join(webDist, CAFE_SCRIPT);
  try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
};

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

/** cw-opening://app/cafe-opening.js → the cafe's script (the only file of the app served there), or null. */
export function appFilePath(url: string, cafeScript: string | null): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${OPENING_SCHEME}:` || u.hostname !== 'app' || u.pathname !== '/cafe-opening.js') return null;
  return cafeScript;
}

/**
 * The response for one request of the opening page (protocol.handle): a pack's file, a range of it (a video seeks),
 * the cafe's script, or 404.
 */
export function packResponse(req: { url: string; headers: { get(name: string): string | null } }, roots: string[], cafeScript: string | null = null): Response {
  const script = appFilePath(req.url, cafeScript);
  if (script) {
    try { return new Response(fs.readFileSync(script), { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } }); } catch { return new Response('not found', { status: 404 }); }
  }
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
