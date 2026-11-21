// 打开文件夹… (desktop:pickDir, 2026-11-21): where the system's folder dialog opens.
//
// With no defaultPath Windows opens the folder it remembered for this exe (the one shown when a dialog of it was last
// answered); when that folder is gone it first pops up 「Location is not available — … is unavailable」 and only then
// the dialog. So:
//   - a page names a start (the folder beside the current project, the project itself…): the dialog opens in it. A
//     start that is gone opens at the nearest folder above it that is still there (a deleted project: its parent); one
//     with nothing left (a drive or stick that is gone) at the home folder — whatever Windows remembered is likely gone
//     with it.
//   - no start: the system's own place, which is handy (where the last pick was) — unless the folder of the last pick
//     made here is gone, then the nearest folder above it (else home). Windows' own record cannot be read cheaply (a
//     binary PIDL in HKCU\…\Explorer\ComDlg32\LastVisitedPidlMRU), so the shell keeps the last pick as a stand-in
//     (`<userData>/folder-dialog.json`); before the first pick here, or when the last pick is still there, the system
//     decides as before.
// A start comes from the page, so only a local absolute path of this system is taken — never a network path (touching
// one makes Windows connect and hand that machine the user's NTLM credentials), a device path or an address — of
// bounded length, and it must turn out to be a folder on the disk. Electron opens the dialog *inside* a defaultPath that
// is a folder (IFileDialog::SetFolder, the "Folder" box empty: 选择文件夹 right away picks that folder).

import fs from 'node:fs';
import path from 'node:path';
import { openablePath } from './ipc-guard';

/** The longest start path taken from a page. */
export const START_MAX = 1024;
/** How many folders up a gone start is followed before giving up on it. */
export const START_UP = 64;
/** How long finding the start may take (a mapped drive that is gone can hang a stat for many seconds): then the system's own place. */
export const START_MS = 1500;
/** The shell's record of the last folder picked (in userData). */
export const LAST_PICK_FILE = 'folder-dialog.json';

/**
 * A start folder as a page may name one: a local absolute path of this system — a drive letter on Windows (`C:\…`),
 * `/…` elsewhere — no longer than START_MAX; never a network / device path, an address with a scheme, a relative path.
 * Normalised (slashes, `..`). Null for anything else.
 */
export function startPath(p: unknown, platform: NodeJS.Platform = process.platform): string | null {
  if (!openablePath(p) || p.length > START_MAX) return null;
  const win = platform === 'win32';
  if (win ? !/^[A-Za-z]:[\\/]/.test(p) : !p.startsWith('/')) return null;
  return (win ? path.win32 : path.posix).resolve(p);
}

/** A folder on the disk (anything that cannot be read as one: no). */
export const diskIsDir = (p: string): Promise<boolean> => fs.promises.stat(p).then((s) => s.isDirectory(), () => false);

/** `p` when it is a folder, else the nearest folder above it that is (at most START_UP steps up); null when none is. */
export async function nearestDir(p: string, isDir: (p: string) => Promise<boolean>, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const dirname = (platform === 'win32' ? path.win32 : path.posix).dirname;
  let cur = p;
  for (let i = 0; i <= START_UP; i++) {
    if (await isDir(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

export interface StartAsk {
  /** what the page asked for (desktop:pickDir's `start`): anything */
  start: unknown;
  /** the folder the last pick here returned (readLastPick), if any */
  last?: unknown;
  /** the user's home folder: where a start / last pick with nothing left of it opens */
  home: string;
  isDir?: (p: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
}

async function findStart(a: StartAsk): Promise<string | undefined> {
  const platform = a.platform ?? process.platform;
  const isDir = a.isDir ?? diskIsDir;
  const start = startPath(a.start, platform);
  if (start) return (await nearestDir(start, isDir, platform)) ?? a.home;
  // no start (or one not taken): the system's own place, unless the last pick here is gone
  const last = startPath(a.last, platform);
  if (!last || (await isDir(last))) return undefined;
  const up = (platform === 'win32' ? path.win32 : path.posix).dirname(last);
  return (up !== last ? await nearestDir(up, isDir, platform) : null) ?? a.home;
}

/**
 * The folder dialog's defaultPath (see the top of this file); undefined = leave it to the system. Gives up after `ms`
 * (undefined then).
 */
export function dialogStart(a: StartAsk, ms = START_MS): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((res) => { timer = setTimeout(() => res(undefined), ms); timer.unref?.(); });
  return Promise.race([findStart(a).catch(() => undefined), late]).finally(() => clearTimeout(timer));
}

/** The last pick recorded in `file` (whatever it holds: dialogStart checks it). */
export async function readLastPick(file: string): Promise<unknown> {
  try { return (JSON.parse(await fs.promises.readFile(file, 'utf8')) as { last?: unknown } | null)?.last; } catch { return undefined; }
}

/** Records a pick (failing quietly: it only steers where the next dialog opens). */
export async function saveLastPick(file: string, picked: string): Promise<void> {
  try { await fs.promises.writeFile(file, JSON.stringify({ last: picked })); } catch { /* ignore */ }
}
