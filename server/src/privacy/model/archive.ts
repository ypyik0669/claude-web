// A plugin package is untrusted input. This module turns .zip / .tar.gz bytes into a flat set of relative paths and
// writes them below one staging folder: no absolute paths, no `..`, no drive letters, no device names, no links,
// bounded entry count and bounded inflated size. Nothing here imports / executes what it extracts.
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { readZip } from '../../import/zip.js';
import { tr } from '../../i18n/index.js';

/** An absolute path in Windows or POSIX spelling (drive letter, UNC share, leading slash or backslash). */
function isAbsolutePathLike(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith('/') || p.startsWith('\\');
}

/** Any `..` segment, with either separator. */
function hasTraversal(p: string): boolean {
  return p.split(/[\\/]+/).some((s) => s === '..');
}

/** A relative path that stays under the folder it is resolved against. */
export function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  const s = p.trim();
  if (!s || s.length > 1024 || s.includes('\0')) return false;
  if (isAbsolutePathLike(s) || /^[A-Za-z]:/.test(s) || s.startsWith('~')) return false;
  if (hasTraversal(s)) return false;
  return s.split(/[\\/]+/).every((part) => part !== '.' && part.length > 0);
}

/** Resolve `rel` under `root`; throws instead of ever returning a path outside it. */
export function resolvePluginPath(root: string, rel: string): string {
  if (!isSafeRelativePath(rel)) throw new Error(tr('压缩包里的文件路径不能跳出目标目录：{path}', { path: String(rel).slice(0, 200) }));
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  const r = path.relative(base, target);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error(tr('压缩包里的文件路径不能跳出目标目录：{path}', { path: rel.slice(0, 200) }));
  return target;
}

export const PLUGIN_ARCHIVE_MAX_ENTRY = 8 * 1024 * 1024;
export const PLUGIN_ARCHIVE_MAX_TOTAL = 32 * 1024 * 1024;
export const PLUGIN_ARCHIVE_MAX_FILES = 2000;

export interface PluginArchiveLimits {
  maxEntry?: number;
  maxTotal?: number;
  maxFiles?: number;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** `./foo` → `foo` (`tar -c .` writes that prefix); backslashes are separators too. */
export function normalizeArchiveName(name: string): string {
  let rel = name.replace(/\\/g, '/');
  while (rel.startsWith('./')) rel = rel.slice(2);
  return rel;
}

/** A path that may be written below the staging folder. Stricter than `isSafeRelativePath` (Windows names / ADS). */
export function isSafeArchivePath(name: string): boolean {
  const rel = normalizeArchiveName(name);
  if (!isSafeRelativePath(rel)) return false;
  if (rel.includes(':')) return false;
  for (const part of rel.split('/')) {
    if (/[. ]$/.test(part)) return false;
    if (RESERVED.test(part)) return false;
  }
  return true;
}

export const isZipBytes = (b: Buffer): boolean => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
export const isGzipBytes = (b: Buffer): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

const unsafe = (name: string) => new Error(tr('插件包里有不安全的路径：{path}', { path: name.slice(0, 200) }));
const duplicate = (name: string) => new Error(tr('插件包里有重复的文件：{path}', { path: name.slice(0, 200) }));
const tooMany = () => new Error(tr('插件包里的文件太多'));

function readZipEntries(buf: Buffer, o: Required<PluginArchiveLimits>): Map<string, Buffer> {
  const bad: string[] = [];
  let raw: Map<string, Buffer>;
  try {
    raw = readZip(buf, {
      maxEntry: o.maxEntry,
      maxTotal: o.maxTotal,
      want: (name) => {
        if (!isSafeArchivePath(name)) { bad.push(name); return false; }
        return true;
      },
    });
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(/large/i.test(msg) ? tr('插件包里的文件太大') : tr('插件包已损坏：{why}', { why: msg }));
  }
  if (bad.length) throw unsafe(bad[0]);
  if (raw.size > o.maxFiles) throw tooMany();
  const out = new Map<string, Buffer>();
  for (const [name, data] of raw) {
    const rel = normalizeArchiveName(name);
    if (out.has(rel)) throw duplicate(rel);
    out.set(rel, data);
  }
  return out;
}

const cstr = (b: Buffer, start: number, len: number): string => {
  const s = b.subarray(start, start + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
};

/** One ustar header: null at the end-of-archive block; throws 'tar checksum' / 'tar size' (the caller words it). */
function tarHeader(h: Buffer): { name: string; size: number; type: string } | null {
  if (h.every((b) => b === 0)) return null;
  const stored = parseInt(cstr(h, 148, 8).trim() || '0', 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  if (!Number.isFinite(stored) || stored !== sum) throw new Error('tar checksum');
  const prefix = cstr(h, 345, 155);
  const name = (prefix ? `${prefix}/` : '') + cstr(h, 0, 100);
  const size = parseInt(cstr(h, 124, 12).trim() || '0', 8);
  if (!Number.isFinite(size) || size < 0) throw new Error('tar size');
  return { name, size, type: h[156] === 0 ? '\0' : String.fromCharCode(h[156]) };
}

function readTarGzEntries(buf: Buffer, o: Required<PluginArchiveLimits>): Map<string, Buffer> {
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(buf, { maxOutputLength: o.maxTotal + 4 * 1024 * 1024 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === 'ERR_BUFFER_TOO_LARGE' ? tr('插件包里的文件太大') : tr('插件包已损坏：{why}', { why: (e as Error).message }));
  }
  const out = new Map<string, Buffer>();
  let off = 0;
  let total = 0;
  while (off + 512 <= tar.length) {
    let hd: ReturnType<typeof tarHeader>;
    try { hd = tarHeader(tar.subarray(off, off + 512)); } catch (e) { throw new Error(tr('插件包已损坏：{why}', { why: (e as Error).message })); }
    if (!hd) break;
    const { name, size, type } = hd;
    if (off + 512 + size > tar.length) throw new Error(tr('插件包已损坏：{why}', { why: 'tar size' }));
    off += 512;
    if (type === '5') {
      off += Math.ceil(size / 512) * 512;
      continue;
    }
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      off += Math.ceil(size / 512) * 512;
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') throw new Error(tr('插件包里有不支持的条目'));
    const rel = normalizeArchiveName(name).replace(/\/+$/, '');
    if (!rel || rel === '.') throw new Error(tr('插件包已损坏：{why}', { why: 'tar name' }));
    if (!isSafeArchivePath(rel)) throw unsafe(rel);
    if (out.has(rel)) throw duplicate(rel);
    if (out.size >= o.maxFiles) throw tooMany();
    if (size > o.maxEntry) throw new Error(tr('插件包里的文件太大'));
    total += size;
    if (total > o.maxTotal) throw new Error(tr('插件包里的文件太大'));
    out.set(rel, Buffer.from(tar.subarray(off, off + size)));
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Drop one shared top-level folder (`repo-main/plugin.json` → `plugin.json`). */
function stripCommonRoot(files: Map<string, Buffer>): Map<string, Buffer> {
  const names = [...files.keys()];
  if (!names.length || names.some((n) => !n.includes('/'))) return files;
  const root = names[0].split('/')[0];
  if (!root || !names.every((n) => n.startsWith(`${root}/`))) return files;
  return new Map(names.map((n) => [n.slice(root.length + 1), files.get(n)!]));
}

/** A package whose plugin.json sits one folder down, with other files at the root: keep that folder's subtree. */
function rootFromManifest(files: Map<string, Buffer>): Map<string, Buffer> {
  if (files.has('plugin.json')) return files;
  const candidates = [...files.keys()].filter((n) => n.endsWith('/plugin.json'));
  if (candidates.length !== 1) return files;
  const prefix = candidates[0].slice(0, -'plugin.json'.length);
  const out = new Map<string, Buffer>();
  for (const [name, data] of files) if (name.startsWith(prefix)) out.set(name.slice(prefix.length), data);
  return out;
}

/** Every file of a zip / tar.gz package, keyed by a safe relative path. Throws with a showable message. */
export function extractPluginArchive(buf: Buffer, limits: PluginArchiveLimits = {}): Map<string, Buffer> {
  const o: Required<PluginArchiveLimits> = {
    maxEntry: limits.maxEntry ?? PLUGIN_ARCHIVE_MAX_ENTRY,
    maxTotal: limits.maxTotal ?? PLUGIN_ARCHIVE_MAX_TOTAL,
    maxFiles: limits.maxFiles ?? PLUGIN_ARCHIVE_MAX_FILES,
  };
  if (isZipBytes(buf)) return rootFromManifest(stripCommonRoot(readZipEntries(buf, o)));
  if (isGzipBytes(buf)) return rootFromManifest(stripCommonRoot(readTarGzEntries(buf, o)));
  throw new Error(tr('插件包不是 zip 或 tar.gz'));
}

export interface TarStreamOptions {
  /** keep this entry (a validated relative path)? Entries not wanted are still checked, then skipped */
  want?: (rel: string) => boolean;
  /** largest single kept file */
  maxEntry?: number;
  /** all bytes after gunzip, kept or not */
  maxInflated?: number;
  maxFiles?: number;
}

/**
 * A large .tar.gz on disk (an npm package of native binaries: hundreds of MB inflated) extracted below `dir` as it is
 * read, never all in memory. The same rules as the plugin reader: every name — kept or not — must be a safe relative
 * path, links / devices refuse the whole archive, a file is written with `wx`. Returns the relative paths written.
 * Errors are worded for any archive (压缩包), not a plugin.
 */
export async function extractTarGzFile(file: string, dir: string, o: TarStreamOptions = {}): Promise<string[]> {
  const maxEntry = o.maxEntry ?? 128 * 1024 * 1024;
  const maxInflated = o.maxInflated ?? 1024 * 1024 * 1024;
  const maxFiles = o.maxFiles ?? 5000;
  const broken = (why: string) => new Error(tr('压缩包已损坏：{why}', { why }));
  const written: string[] = [];
  const seen = new Set<string>();
  let head: Buffer[] = [];
  let headLen = 0;
  // the entry being read: bytes left of its body, of its padding, and its chunks when kept
  let left = 0;
  let pad = 0;
  let keep: { rel: string; chunks: Buffer[] } | null = null;
  let inflated = 0;
  let ended = false;
  const finish = async () => {
    if (!keep) return;
    const { rel, chunks } = keep;
    keep = null;
    const target = resolvePluginPath(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(target, Buffer.concat(chunks), { flag: 'wx', mode: 0o644 });
    } catch {
      throw new Error(tr('压缩包里的文件冲突：{path}', { path: rel.slice(0, 200) }));
    }
    written.push(rel);
  };
  const gz = createReadStream(file).pipe(zlib.createGunzip());
  try {
    for await (const raw of gz as AsyncIterable<Buffer>) {
      inflated += raw.length;
      if (inflated > maxInflated) throw new Error(tr('压缩包里的文件太大'));
      let chunk = raw;
      while (chunk.length && !ended) {
        if (left > 0) {
          const n = Math.min(left, chunk.length);
          keep?.chunks.push(chunk.subarray(0, n));
          left -= n;
          chunk = chunk.subarray(n);
          if (left === 0) await finish();
          continue;
        }
        if (pad > 0) {
          const n = Math.min(pad, chunk.length);
          pad -= n;
          chunk = chunk.subarray(n);
          continue;
        }
        const n = Math.min(512 - headLen, chunk.length);
        head.push(chunk.subarray(0, n));
        headLen += n;
        chunk = chunk.subarray(n);
        if (headLen < 512) continue;
        const h = Buffer.concat(head);
        head = [];
        headLen = 0;
        let hd: ReturnType<typeof tarHeader>;
        try { hd = tarHeader(h); } catch (e) { throw broken((e as Error).message); }
        if (!hd) { ended = true; break; }
        const { name, size, type } = hd;
        left = size;
        pad = (512 - (size % 512)) % 512;
        if (type === '5' || type === 'x' || type === 'g' || type === 'L' || type === 'K') continue;
        if (type !== '0' && type !== '\0' && type !== '7') throw new Error(tr('压缩包里有不支持的条目'));
        const rel = normalizeArchiveName(name).replace(/\/+$/, '');
        if (!rel || rel === '.') throw broken('tar name');
        if (!isSafeArchivePath(rel)) throw new Error(tr('压缩包里有不安全的路径：{path}', { path: rel.slice(0, 200) }));
        if (seen.has(rel)) throw new Error(tr('压缩包里有重复的文件：{path}', { path: rel.slice(0, 200) }));
        seen.add(rel);
        if (seen.size > maxFiles) throw new Error(tr('压缩包里的文件太多'));
        if (o.want && !o.want(rel)) continue;
        if (size > maxEntry) throw new Error(tr('压缩包里的文件太大'));
        keep = { rel, chunks: [] };
        if (size === 0) await finish();
      }
    }
  } catch (e) {
    gz.destroy();
    const code = (e as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && code.startsWith('Z_')) throw broken((e as Error).message);
    throw e;
  }
  if (left > 0 || keep) throw broken('tar truncated');
  return written;
}

/** Write the extracted tree below `dir` (paths were validated above; `wx` refuses any overwrite). */
export async function writePluginTree(dir: string, files: Map<string, Buffer>): Promise<void> {
  for (const [rel, data] of files) {
    const target = resolvePluginPath(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(target, data, { flag: 'wx', mode: 0o644 });
    } catch (e) {
      throw new Error(tr('插件包里的文件冲突：{path}', { path: rel.slice(0, 200) }));
    }
  }
}
