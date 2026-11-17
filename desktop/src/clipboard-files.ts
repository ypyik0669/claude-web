// 粘贴文件 / 文件夹 (2026-11-17): the files on the system clipboard, for the composer's Ctrl+V.
//
// Chromium hands a paste of files copied in Explorer / Finder to the page as File objects, and `webUtils.getPathForFile`
// (preload) turns each into its path — the whole list, on every system. What the page cannot tell from a File is
// whether it is a folder (it cannot read one), so the page sends those paths here and gets back what each one is.
// When the page was handed no File at all, the shell reads the clipboard itself. Electron 44's clipboard is the async,
// web-shaped one (`read()` → ClipboardItem[]; the old `readBuffer(format)` is gone): a file list shows up as the MIME
// type `text/uri-list` (Chromium reports one for CF_HDROP / a Finder copy), and the platform's own formats as
// `electron application/osclipboard;format="<name>"`. Tried in this order:
//   any      `text/uri-list` (file:// URLs, one per line — every file of the copy)
//   Windows  `FileNameW` (CFSTR_FILENAMEW: UTF-16LE, NUL-terminated). Explorer puts only the FIRST file of a copy
//            there; CF_HDROP has them all but is a standard format id with no name to ask for.
//   macOS    `NSFilenamesPboardType` (a property list of every path), else `public.file-url` (one file:// URL)
//   Linux    `text/uri-list`, else `x-special/gnome-copied-files` (file:// URLs; gnome's first line is copy / cut)

import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openablePath } from './ipc-guard';

/** At most this many paths are looked at for one paste. */
export const MAX_CLIP_PATHS = 100;

/** One file or folder of a paste, as the composer shows it. */
export interface ClipPath { path: string; name: string; dir: boolean; size?: number }

/** The parts of Electron's `clipboard` this reads (its ClipboardItem: `types`, and `getType` → a Blob). */
export interface ClipboardReader {
  read(): Promise<readonly { readonly types: readonly string[]; getType(type: string): Promise<unknown> }[]>;
}

/** `FileNameW`: UTF-16LE text, NUL-separated (and -terminated). */
export function parseFileNameW(buf: Buffer | undefined | null): string[] {
  if (!buf?.length) return [];
  return buf.toString('utf16le').split('\0').map((s) => s.trim()).filter(Boolean);
}

const XML_ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    if (e[0] !== '#') return XML_ENTITY[e.toLowerCase()] ?? _m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
  });
}

/** `NSFilenamesPboardType`: `<plist><array><string>/path</string>…</array></plist>`. */
export function parseFilenamesPlist(xml: string | undefined | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1]).trim()).filter(Boolean);
}

/** file:// URLs, one per line (a uri-list's `#` comments and gnome's leading `copy` / `cut` are not URLs). */
export function parseFileUrls(text: string | undefined | null, platform: NodeJS.Platform): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.replace(/\0/g, '').trim();
    if (!/^file:\/\//i.test(s)) continue;
    try {
      const p = fileURLToPath(s, { windows: platform === 'win32' });
      // a folder's URL ends with a slash; a root (`/`, `C:\`) keeps its own
      out.push(/^([A-Za-z]:)?[\\/]$/.test(p) ? p : p.replace(/[\\/]+$/, ''));
    } catch { /* not a local file URL */ }
  }
  return out;
}

/** `electron application/osclipboard;format="FileNameW"` → `FileNameW` (quotes optional, any case); null for a MIME type. */
export function rawFormatName(type: string): string | null {
  const m = /^electron application\/osclipboard\s*;\s*format\s*=\s*"?([^"]*)"?\s*$/i.exec(type);
  return m ? m[1] : null;
}

async function bytesOf(v: unknown): Promise<Buffer | null> {
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (v && typeof (v as Blob).arrayBuffer === 'function') return Buffer.from(await (v as Blob).arrayBuffer());
  return null;
}

/** The paths of the files on the system clipboard (see the top of this file); [] when there are none. */
export async function clipboardPaths(cb: ClipboardReader, platform: NodeJS.Platform): Promise<string[]> {
  let items: Awaited<ReturnType<ClipboardReader['read']>>;
  try { items = await cb.read(); } catch { return []; }
  for (const it of items ?? []) {
    const types = Array.isArray(it?.types) ? it.types : [];
    const raw = new Map<string, string>();
    for (const t of types) { const n = rawFormatName(t); if (n !== null) raw.set(n.toLowerCase(), t); }
    const read = async (type: string | undefined): Promise<Buffer | null> => {
      if (!type) return null;
      try { return await bytesOf(await it.getType(type)); } catch { return null; }
    };
    const urls = (b: Buffer) => parseFileUrls(b.toString('utf8'), platform);
    const tries: [type: string | undefined, parse: (b: Buffer) => string[]][] = [[types.find((t) => t.toLowerCase() === 'text/uri-list'), urls]];
    if (platform === 'win32') tries.push([raw.get('filenamew'), parseFileNameW]);
    else if (platform === 'darwin') tries.push([raw.get('nsfilenamespboardtype'), (b) => parseFilenamesPlist(b.toString('utf8'))], [raw.get('public.file-url'), urls]);
    else tries.push([raw.get('text/uri-list'), urls], [raw.get('x-special/gnome-copied-files'), urls]);
    for (const [type, parse] of tries) {
      const b = await read(type);
      const list = b?.length ? parse(b) : [];
      if (list.length) return list;
    }
  }
  return [];
}

/** The last part of a path, either slash (a drive root keeps the whole: `C:\`). */
export function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

type Stat = (p: string) => { isDirectory(): boolean; size: number };

/**
 * What each path is: a folder or a file (with its size). Local absolute paths only (`openablePath`: a network path
 * would make Windows connect and hand over the user's credentials); gone / unreadable ones and repeats are left out.
 */
export function describePaths(paths: readonly unknown[], stat: Stat = statSync): ClipPath[] {
  const out: ClipPath[] = [];
  const seen = new Set<string>();
  for (const p of paths.slice(0, MAX_CLIP_PATHS)) {
    if (!openablePath(p) || seen.has(p)) continue;
    seen.add(p);
    try {
      const s = stat(p);
      const dir = s.isDirectory();
      out.push({ path: p, name: baseName(p), dir, ...(dir ? {} : { size: s.size }) });
    } catch { /* gone, or not ours to read */ }
  }
  return out;
}

/**
 * The `desktop:clipboard:files` answer: the paths the page got for the files it was handed (`given`, the full list),
 * or — none given — the clipboard's own list, each described.
 */
export async function pastedFiles(given: unknown, cb: ClipboardReader, platform: NodeJS.Platform, stat: Stat = statSync): Promise<ClipPath[]> {
  const list = Array.isArray(given) ? given.filter((p): p is string => typeof p === 'string' && !!p) : [];
  return describePaths(list.length ? list : await clipboardPaths(cb, platform), stat);
}
