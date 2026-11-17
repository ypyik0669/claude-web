// 粘贴文件 / 文件夹 (2026-11-17, user report: a file copied in Explorer, Ctrl+V in the box — nothing happened; the
// box only took pasted pictures and long text).
//
// A paste is decided while its event lasts — after the handler returns, its DataTransfer is empty — so the Files and
// file system entries are taken first (`snapshotPaste`), then `planPaste` says whether the box takes it as files
// (preventDefault) or leaves it to the text rules (long text → an attachment, the rest goes in as typed). The files are
// then sorted out (`resolvePaste`) into:
//   dropped     what a drop from the system would have given (`expandDataTransfer`): pictures and files to upload; a
//               folder the page can walk (the plain browser, when Chromium hands a file system entry) expanded the same
//   refs        the desktop app: a folder — or a file the page was handed no contents for — by its path on this disk,
//               NOT uploaded: the server runs on this computer, Claude reads it where it is (like 添加到对话)
//   unreadable  the plain browser: things it was handed but cannot read (a folder Chromium gave no entry for)
// Composer.tsx turns `dropped` into its pictures / uploads the way a drop does (`splitDropped`), and `refs` into
// `<attached kind="folder|file" path>` attachments (`addPathRefs`).

import { expandEntries, type DroppedFile, type ExpandedFiles } from '@/model/attachments';
import type { AttachmentRef } from '@shared';

/** A pasted path as the desktop shell describes it (desktop/src/clipboard-files.ts). */
export interface ClipPath { path: string; name: string; dir: boolean; size?: number }

/** What of a FileSystemEntry this reads (expandEntries walks the rest). */
export interface EntryLike { readonly isFile: boolean; readonly isDirectory: boolean; readonly name: string }

/** One file of a paste, taken while the event lasts. `path`: its path on this disk (desktop app), else ''. */
export interface PastedItem { file: File | null; entry: EntryLike | null; path: string }
export interface PasteSnapshot { text: string; items: PastedItem[] }

/** The parts of a ClipboardEvent's clipboardData read here. */
export interface ClipboardDataLike {
  readonly items?: ArrayLike<{ readonly kind: string; getAsFile(): File | null; webkitGetAsEntry?(): unknown }> | null;
  readonly files?: ArrayLike<File> | null;
  getData(format: string): string;
}

/** The desktop shell's part (window.desktop): a File's path, what paths are / the clipboard's own files. */
export interface PasteShell {
  pathForFile?(f: File): string;
  clipboardFiles?(paths?: string[]): Promise<ClipPath[]>;
}

/** Take what a paste holds while its event lasts. */
export function snapshotPaste(dt: ClipboardDataLike, shell?: PasteShell): PasteSnapshot {
  let text = '';
  try { text = dt.getData('text/plain') || ''; } catch { /* no text */ }
  const pathOf = (f: File | null): string => {
    if (!f || !shell?.pathForFile) return '';
    try { return shell.pathForFile(f) || ''; } catch { return ''; }
  };
  const items: PastedItem[] = [];
  const list = Array.from(dt.items ?? []).filter((it) => it.kind === 'file');
  if (list.length) {
    for (const it of list) {
      const file = it.getAsFile();
      let entry: EntryLike | null = null;
      try { entry = (it.webkitGetAsEntry?.() as EntryLike | null | undefined) ?? null; } catch { /* not a file system entry */ }
      if (file || entry) items.push({ file, entry, path: pathOf(file) });
    }
  } else {
    for (const f of Array.from(dt.files ?? [])) items.push({ file: f, entry: null, path: pathOf(f) });
  }
  return { text, items };
}

/**
 * What the box does with a paste:
 * - 'files': files from the disk — Explorer's / Finder's file list (CF_HDROP): each has a path (desktop app) or a file
 *   system entry (browser) — even with text beside them; or files the page was handed with no text (a screenshot)
 * - 'text': text, also with a picture beside it (Office puts its cells / words as both: the words win)
 * - 'ask': the page sees nothing, in the desktop app — the shell reads the clipboard's file list itself (nothing would
 *   be pasted anyway, so the event is not held up)
 * - 'none': leave it to the browser
 */
export type PastePlan = 'files' | 'text' | 'ask' | 'none';
export function planPaste(s: PasteSnapshot, canAsk: boolean): PastePlan {
  if (s.items.some((i) => i.entry || i.path)) return 'files';
  if (s.text.trim()) return 'text';
  if (s.items.length) return 'files';
  if (s.text) return 'text';
  return canAsk ? 'ask' : 'none';
}

export interface PasteResult { dropped: ExpandedFiles; refs: ClipPath[]; unreadable: string[] }

/** A File the page may not be able to read: what Chromium hands for a pasted folder (no size, no type, no extension). */
export function suspectFolder(f: File): boolean {
  return f.size === 0 && !f.type && !/\.[^.\\/]+$/.test(f.name);
}

/** Whether a File's contents can be read (a folder's cannot; neither can a file that is gone or locked). */
export async function readable(f: File): Promise<boolean> {
  if (suspectFolder(f)) return false;
  try { await f.slice(0, 1).arrayBuffer(); return true; } catch { return false; }
}

/** Sort a paste's files out (see the top of this file). */
export async function resolvePaste(items: readonly PastedItem[], shell?: PasteShell, max = 500): Promise<PasteResult> {
  const files: DroppedFile[] = [];
  const refs: ClipPath[] = [];
  const unreadable: string[] = [];
  const walk: EntryLike[] = [];
  const ask = shell?.clipboardFiles ? (p?: string[]) => shell.clipboardFiles!(p) : undefined;
  const empty: ExpandedFiles = { files: [], folders: [], truncated: false };
  // the desktop app: what each path is (a File does not say whether it is a folder); nothing handed to the page at
  // all: the clipboard's own file list, every one by its path (there are no contents to upload)
  const paths = items.map((i) => i.path).filter(Boolean);
  let known = new Map<string, ClipPath>();
  if (ask && (paths.length || !items.length)) {
    const got = await ask(paths.length ? paths : undefined).catch(() => [] as ClipPath[]);
    if (!items.length) return { dropped: empty, refs: dedupe(got), unreadable };
    known = new Map(got.map((c) => [c.path, c]));
  }
  for (const it of items) {
    const c = it.path ? known.get(it.path) : undefined;
    // the desktop app: a folder by its path
    if (c?.dir) { refs.push(c); continue; }
    // a folder the page can walk: the browser (or a network folder the shell would not look at) — like a dropped one
    if (it.entry?.isDirectory) { walk.push(it.entry); continue; }
    // a file: uploaded like a dropped one (the shell said it is a file, or its first byte reads)
    if (it.file && (c || await readable(it.file))) { files.push({ file: it.file, rel: it.file.name }); continue; }
    if (it.file || it.entry) unreadable.push(it.file?.name ?? it.entry!.name);
  }
  if (!walk.length) return { dropped: { files: files.slice(0, max), folders: [], truncated: files.length > max }, refs: dedupe(refs), unreadable };
  const walked = await expandEntries(walk, Math.max(0, max - files.length));
  return { dropped: { files: [...files, ...walked.files].slice(0, max), folders: walked.folders, truncated: walked.truncated || files.length > max }, refs: dedupe(refs), unreadable };
}

function dedupe(list: readonly ClipPath[]): ClipPath[] {
  const seen = new Set<string>();
  return list.filter((c) => !seen.has(c.path) && !!seen.add(c.path));
}

/** A drop's / paste's files: lone pictures go in as pictures (sent inline), the rest is uploaded on send. */
export function splitDropped(files: readonly DroppedFile[]): { images: DroppedFile[]; rest: DroppedFile[] } {
  const images = files.filter((d) => !d.rel.includes('/') && d.file.type.startsWith('image/'));
  return { images, rest: files.filter((d) => !images.includes(d)) };
}

/** A path reference as an attachment: `<attached kind="folder|file" name path size />`, the model reads it in place. */
export function pathRefAttachment(c: ClipPath): AttachmentRef {
  return { kind: c.dir ? 'folder' : 'file', name: c.name, path: c.path, ...(c.size !== undefined ? { size: c.size } : {}) };
}

/** The box's attachments with these path references added (one already there is not added again). */
export function addPathRefs(atts: readonly AttachmentRef[], refs: readonly ClipPath[]): AttachmentRef[] {
  const have = new Set(atts.map((a) => a.path).filter(Boolean));
  return [...atts, ...refs.filter((c) => !have.has(c.path)).map(pathRefAttachment)];
}

/** An attachment that is a reference by path (a pasted folder / file in the desktop app), not uploaded or inline. */
export function isPathRef(a: AttachmentRef): boolean {
  return (a.kind === 'folder' || a.kind === 'file') && !!a.path && a.text === undefined;
}
