// A project's extra folders (stage C2): stored on the workspace as `folders` (never the main `path`), read with
// `folders ?? []` — old meta.json files need no migration. Pure.
import path from 'node:path';
import { tr } from '../i18n/index.js';

const key = (p: string, caseless: boolean) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseless ? s.toLowerCase() : s;
};

/**
 * A project's main folder as `workspaces.add` takes it: a full path (returned as given), or an error saying what is
 * wrong. An empty or relative one is refused before `path.resolve` would turn it into the server's own working
 * directory — a script's `addWorkspace('')` added the server's folder as a project (2026-11-21). On Windows a full
 * path has a drive letter (`C:\…`) or is a share (`\\host\share`): `\foo` / `/foo` would hang off whatever drive the
 * server runs on. Not trimmed: the hub's refusePeerUnc looked at this very string (` \\host` must not become a share).
 */
export function projectPath(p: unknown, platform: NodeJS.Platform = process.platform): string {
  if (typeof p !== 'string' || !p.trim()) throw new Error(tr('项目文件夹的路径不能为空'));
  const full = platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p) : path.posix.isAbsolute(p);
  if (!full) throw new Error(tr('项目文件夹要用完整路径，不是：{p}', { p: p.slice(0, 300) }));
  return p;
}

export const sameDir = (a: string, b: string, caseless = process.platform === 'win32') => !!a && !!b && key(a, caseless) === key(b, caseless);

export function normFolders(main: string, folders: unknown, o: { caseless?: boolean; resolve?: (p: string) => string } = {}): string[] {
  const caseless = o.caseless ?? process.platform === 'win32';
  const resolve = o.resolve ?? ((p: string) => path.resolve(p));
  if (!Array.isArray(folders)) return [];
  const seen = new Set<string>([key(main, caseless)]);
  const out: string[] = [];
  for (const f of folders) {
    if (typeof f !== 'string' || !f.trim()) continue;
    const p = resolve(f.trim());
    const k = key(p, caseless);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/**
 * A conversation's own extra folders (添加文件夹 in the + menu, SessionMeta.extraDirs) as stored and as read back:
 * absolute paths only, each once (Windows: whatever the case / slashes), never the conversation's own folder. Written
 * as given (the hub checked each exists): no resolving, so what the user picked is what the card shows.
 */
export function ownDirs(cwd: string, dirs: unknown, caseless = process.platform === 'win32'): string[] {
  if (!Array.isArray(dirs)) return [];
  // (either platform's idea of absolute: a record is read on whatever machine; the hub checked it on this one)
  const abs = dirs.filter((d): d is string => typeof d === 'string' && (path.win32.isAbsolute(d.trim()) || path.posix.isAbsolute(d.trim())));
  return normFolders(cwd, abs, { caseless, resolve: (p) => p });
}

/**
 * session.setExtraDirs: the conversation's own folders as they will be stored (`dirs`), and what in the request is not
 * one of them yet (`added`, junk included) — only those are checked against the disk, so a folder deleted since it was
 * added can still be removed.
 */
export function extraDirsChange(cwd: string, recorded: unknown, requested: readonly unknown[], caseless = process.platform === 'win32'): { dirs: string[]; added: unknown[] } {
  const before = ownDirs(cwd, recorded, caseless);
  const added = requested.filter((d) => typeof d !== 'string' || !before.some((b) => sameDir(b, d, caseless)));
  return { dirs: ownDirs(cwd, requested, caseless), added };
}

/**
 * Every folder a conversation in `cwd` works in besides it — the SDK's additionalDirectories, Codex's writable roots:
 * the groups in order (the project's extra folders, the conversation's own, the project's files folder), each folder
 * once, never `cwd` itself.
 */
export function workDirs(cwd: string, groups: readonly (readonly string[])[], caseless = process.platform === 'win32'): string[] {
  return normFolders(cwd, groups.flat(), { caseless, resolve: (p) => p });
}

/** The extra folders a conversation in `cwd` gets: only in a project's main folder (as the page's `projectFor`). */
export function projectFolders(cwd: string, workspaces: readonly { path: string; folders?: unknown }[], caseless = process.platform === 'win32'): string[] {
  if (!cwd) return [];
  const w = workspaces.find((x) => sameDir(cwd, x.path, caseless));
  return w ? normFolders(w.path, w.folders, { caseless, resolve: (p) => p }) : [];
}
