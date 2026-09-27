import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import chokidar from 'chokidar';
import type { FsEntry, FsOpenResult, FsStat } from '../protocol.js';

const execFileAsync = promisify(execFile);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface ChangedFile {
  path: string;
  ops: number;
  tools: string[];
  lastTs?: string;
}

const TEXT_MAX = 4 * 1024 * 1024;

/** Cheap binary sniff: NUL byte in the first 8KB. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export class FilesService extends EventEmitter {
  private watchers = new Map<string, { w: any; refs: number }>();

  // ---------- phase 3: editor & file operations ----------
  async stat(p: string): Promise<FsStat> {
    const st = await fs.stat(p);
    let binary: boolean | undefined;
    if (st.isFile() && st.size < TEXT_MAX) {
      const fh = await fs.open(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(8192, st.size));
        await fh.read(buf, 0, buf.length, 0);
        binary = looksBinary(buf);
      } finally { await fh.close(); }
    }
    return { path: p, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, binary };
  }

  async open(p: string): Promise<FsOpenResult> {
    const st = await fs.stat(p);
    if (st.isDirectory()) throw new Error('是目录');
    const buf = await fs.readFile(p);
    const binary = looksBinary(buf);
    if (binary) return { text: '', mtime: st.mtimeMs, size: st.size, binary: true };
    const truncated = buf.length > TEXT_MAX;
    return { text: (truncated ? buf.subarray(0, TEXT_MAX) : buf).toString('utf8'), mtime: st.mtimeMs, size: st.size, binary: false, truncated };
  }

  /** Write text; refuses when the file changed on disk after `expectMtime` (the editor then offers reload / overwrite). */
  async write(p: string, text: string, expectMtime?: number): Promise<{ mtime: number }> {
    if (expectMtime !== undefined) {
      const st = await fs.stat(p).catch(() => null);
      if (st && Math.abs(st.mtimeMs - expectMtime) > 1) {
        const e: any = new Error('文件在磁盘上已被修改');
        e.code = 'CONFLICT';
        e.mtime = st.mtimeMs;
        throw e;
      }
    }
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, text, 'utf8');
    const st = await fs.stat(p);
    return { mtime: st.mtimeMs };
  }

  async mkdir(p: string) { await fs.mkdir(p, { recursive: true }); }

  async create(p: string, text = '') {
    if (await fs.stat(p).catch(() => null)) throw new Error('已存在同名文件');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, text, 'utf8');
  }

  async rename(from: string, to: string) {
    if (await fs.stat(to).catch(() => null)) throw new Error('目标已存在');
    await fs.rename(from, to);
  }

  async copy(from: string, to: string) {
    if (await fs.stat(to).catch(() => null)) throw new Error('目标已存在');
    await fs.cp(from, to, { recursive: true });
  }

  /** Move to the OS recycle bin (Windows: PowerShell + VisualBasic FileIO; macOS: Finder; Linux: gio). Falls back to rm. */
  async trash(paths: string[]) {
    if (!paths.length) return;
    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName Microsoft.VisualBasic',
        ...paths.map((p) => {
          const esc = p.replace(/'/g, "''");
          return `if (Test-Path -LiteralPath '${esc}' -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${esc}','OnlyErrorDialogs','SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${esc}','OnlyErrorDialogs','SendToRecycleBin') }`;
        }),
      ].join('; ');
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
      return;
    }
    if (process.platform === 'darwin') {
      const list = paths.map((p) => `POSIX file "${appleScriptEscape(p)}"`).join(', ');
      await execFileAsync('osascript', ['-e', `tell application "Finder" to delete {${list}}`]);
      return;
    }
    try {
      await execFileAsync('gio', ['trash', ...paths]);
    } catch {
      for (const p of paths) await fs.rm(p, { recursive: true, force: true });
    }
  }

  /** Watch a directory (depth 1) or file; ref-counted per path. Emits ('changed', {path, type}). */
  async watch(p: string) {
    const cur = this.watchers.get(p);
    if (cur) { cur.refs++; return; }
    const st = await fs.stat(p);
    // a concurrent watch() of the same path may have registered while we awaited stat — don't leak a second watcher
    const raced = this.watchers.get(p);
    if (raced) { raced.refs++; return; }
    const w = chokidar.watch(p, { ignoreInitial: true, depth: st.isDirectory() ? 0 : undefined, ignored: (x: string) => x.includes(`${path.sep}.git${path.sep}`) || x.endsWith(`${path.sep}.git`) });
    w.on('all', (type: string, file: string) => this.emit('changed', { path: file, type }));
    // 'error' without a listener throws and takes the server down (EPERM when a watched dir is deleted on Windows)
    w.on('error', (e: unknown) => console.error('[files] watch error:', (e as Error)?.message ?? e));
    this.watchers.set(p, { w, refs: 1 });
  }
  async unwatch(p: string) {
    const cur = this.watchers.get(p);
    if (!cur) return;
    if (--cur.refs > 0) return;
    this.watchers.delete(p);
    await cur.w.close();
  }

  /** Files touched by Edit/Write tools in a session transcript. */
  async changed(file: string): Promise<ChangedFile[]> {
    const m = new Map<string, ChangedFile>();
    const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"tool_use"')) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue;
        const p = b.input?.file_path ?? b.input?.notebook_path;
        if (!p) continue;
        const e: ChangedFile = m.get(p) ?? { path: p, ops: 0, tools: [] };
        e.ops++;
        if (!e.tools.includes(b.name)) e.tools.push(b.name);
        e.lastTs = rec.timestamp;
        m.set(p, e);
      }
    }
    return [...m.values()];
  }

  /** git diff for a file relative to HEAD; falls back to full content when not in a repo. */
  async diff(filePath: string) {
    const dir = path.dirname(filePath);
    try {
      const { stdout: root } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, windowsHide: true });
      const cwd = root.trim();
      const { stdout } = await execFileAsync('git', ['diff', '--no-color', 'HEAD', '--', filePath], { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      if (stdout.trim()) return { kind: 'diff' as const, text: stdout };
      // untracked?
      const { stdout: st } = await execFileAsync('git', ['status', '--porcelain', '--', filePath], { cwd, windowsHide: true });
      if (st.startsWith('??')) return { kind: 'new' as const, text: await fs.readFile(filePath, 'utf8') };
      return { kind: 'unchanged' as const, text: '' };
    } catch {
      const text = await fs.readFile(filePath, 'utf8').catch(() => '');
      return { kind: 'content' as const, text };
    }
  }

  async list(dir: string): Promise<FsEntry[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: FsEntry[] = [];
    for (const e of entries) {
      if (e.name === '.git') continue;
      let isDir = e.isDirectory();
      let size: number | undefined, mtime: number | undefined;
      const symlink = e.isSymbolicLink();
      try {
        const st = await fs.stat(path.join(dir, e.name));
        isDir = st.isDirectory();
        if (!isDir) { size = st.size; mtime = st.mtimeMs; }
      } catch { /* dangling link */ }
      out.push({ name: e.name, dir: isDir, size, mtime, symlink: symlink || undefined });
    }
    return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }

  async read(p: string) {
    const st = await fs.stat(p);
    if (st.size > 2 * 1024 * 1024) throw new Error('file too large');
    return fs.readFile(p, 'utf8');
  }

  /** Save an exported conversation HTML under ~/.claude-web/exports and return its path. */
  async saveExport(name: string, html: string): Promise<string> {
    const dir = path.join(dataDir(), 'exports');
    await fs.mkdir(dir, { recursive: true });
    const safe = name.replace(/[<>:"/\\|?* -]/g, '_').slice(0, 80) || 'conversation';
    const file = path.join(dir, `${safe}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.html`);
    await fs.writeFile(file, html, 'utf8');
    return file;
  }
}

/** Escape for an AppleScript double-quoted string literal: backslashes first, then quotes. */
export function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function dataDir() {
  return process.env.CLAUDE_WEB_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.claude-web');
}

export const ATTACH_MAX_BYTES = 200 * 1024 * 1024;

/** Resolve the on-disk destination for an upload; rejects traversal and absolute paths. */
export function attachmentPath(sessionId: string, rel: string): string {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) throw new Error('bad session id');
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((seg) => seg === '..' || seg === '' || /^[A-Za-z]:$/.test(seg))) throw new Error('bad path');
  const root = path.join(dataDir(), 'attachments', sessionId);
  const dest = path.resolve(root, clean);
  if (!dest.startsWith(root + path.sep) && dest !== root) throw new Error('bad path');
  return dest;
}
