// 开场动画包: the built-in ones (read-only, they come with the app) and the user's (<data dir>/openings/<id>/), listed
// for 设置 › 外观 › 开场和背景, served to the app (the backdrop's loop, the cards' posters, 试放一次's film) and added
// from a folder or from one video file. The desktop shell plays the opening itself before the server is up
// (desktop/src/opening-pack.ts); this is everything after that.
import fs from 'node:fs';
import path from 'node:path';
import type { OpeningInfo } from '../protocol.js';
import { tr } from '../i18n/index.js';
import { PACK_FILE, PACK_ID, packFiles, packIdFor, readPack, safeFile } from './pack.js';

/** One media file of a pack may be at most this big (a 12 s 4K film is well under it). */
export const PACK_FILE_MAX = 256 * 1024 * 1024;

export class OpeningService {
  constructor(private o: { builtinDir: string | null; userDir: string }) {}

  private roots(): { dir: string; builtin: boolean }[] {
    return [...(this.o.builtinDir ? [{ dir: this.o.builtinDir, builtin: true }] : []), { dir: this.o.userDir, builtin: false }];
  }

  private readFolder(dir: string, id: string, builtin: boolean): OpeningInfo | null {
    let json: unknown;
    try { json = JSON.parse(fs.readFileSync(path.join(dir, PACK_FILE), 'utf8')); } catch { return null; }
    const p = readPack(json, id, builtin);
    if ('error' in p) return null;
    // a pack whose film is missing is no pack (a half-finished copy)
    try { if (!fs.statSync(path.join(dir, p.intro)).isFile()) return null; } catch { return null; }
    return p;
  }

  /** Every usable pack, the built-in ones first; a user's folder with a built-in one's name is not listed twice. */
  list(): OpeningInfo[] {
    const out: OpeningInfo[] = [];
    const seen = new Set<string>();
    for (const r of this.roots()) {
      let names: string[] = [];
      try { names = fs.readdirSync(r.dir).sort(); } catch { continue; }
      for (const n of names) {
        if (!PACK_ID.test(n) || seen.has(n)) continue;
        const p = this.readFolder(path.join(r.dir, n), n, r.builtin);
        if (p) { out.push(p); seen.add(n); }
      }
    }
    return out;
  }

  /** The pack `id` (first root that has it), or null. */
  get(id: string): (OpeningInfo & { dir: string }) | null {
    if (!PACK_ID.test(id)) return null;
    for (const r of this.roots()) {
      const dir = path.join(r.dir, id);
      const p = this.readFolder(dir, id, r.builtin);
      if (p) return { ...p, dir };
    }
    return null;
  }

  /** The path of a file the pack uses (its film, loop, poster) — nothing else of the folder is served. */
  file(id: string, name: string): string | null {
    const p = this.get(id);
    if (!p || !safeFile(name) || !packFiles(p).includes(name)) return null;
    const f = path.join(p.dir, name);
    try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
  }

  private taken(): Set<string> {
    const s = new Set<string>();
    for (const r of this.roots()) { try { for (const n of fs.readdirSync(r.dir)) s.add(n.toLowerCase()); } catch { /* none yet */ } }
    return s;
  }

  private checkSize(file: string) {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { throw new Error(tr('找不到文件：{file}', { file })); }
    if (!st.isFile()) throw new Error(tr('不是文件：{file}', { file }));
    if (st.size > PACK_FILE_MAX) throw new Error(tr('{file} 太大了（超过 256 MB）', { file: path.basename(file) }));
  }

  /** 从文件夹导入: a folder with an opening.json → a copy under openings/ (the files the pack uses, and the json). */
  async importFolder(src: string): Promise<OpeningInfo> {
    if (typeof src !== 'string' || !path.isAbsolute(src)) throw new Error(tr('要一个文件夹的完整路径'));
    let json: unknown;
    try { json = JSON.parse(await fs.promises.readFile(path.join(src, PACK_FILE), 'utf8')); } catch (e: any) {
      throw new Error(e?.code === 'ENOENT' ? tr('这个文件夹里没有 opening.json，不是动画包') : tr('opening.json 读不了：{error}', { error: e?.message ?? e }));
    }
    const probe = readPack(json, 'probe', false);
    if ('error' in probe) throw new Error(probe.error);
    for (const f of packFiles(probe)) this.checkSize(path.join(src, f));
    const id = packIdFor(path.basename(src), this.taken());
    await this.write(id, async (dir) => {
      for (const f of packFiles(probe)) await fs.promises.copyFile(path.join(src, f), path.join(dir, f));
      await fs.promises.writeFile(path.join(dir, PACK_FILE), JSON.stringify(json, null, 2));
    });
    return this.get(id)!;
  }

  /** 自己的视频: one video file → a pack of its own (the logo takes over where the film ends, at most 12 s in). */
  async addVideo(file: string): Promise<OpeningInfo> {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error(tr('要一个视频文件的完整路径'));
    const ext = path.extname(file).toLowerCase();
    if (!['.mp4', '.webm', '.mov'].includes(ext)) throw new Error(tr('只认 mp4 / webm / mov 的视频'));
    this.checkSize(file);
    const name = path.basename(file, path.extname(file)).slice(0, 60) || tr('自己的视频');
    const id = packIdFor(name, this.taken());
    const intro = `intro${ext}`;
    await this.write(id, async (dir) => {
      await fs.promises.copyFile(file, path.join(dir, intro));
      await fs.promises.writeFile(path.join(dir, PACK_FILE), JSON.stringify({ name, kind: 'video', intro, maxSeconds: 12 }, null, 2));
    });
    return this.get(id)!;
  }

  /** Into a temporary folder first: a copy that fails half-way leaves no half pack behind. */
  private async write(id: string, fill: (dir: string) => Promise<void>) {
    await fs.promises.mkdir(this.o.userDir, { recursive: true });
    const tmp = path.join(this.o.userDir, `.tmp-${id}-${process.pid}-${Date.now()}`);
    await fs.promises.mkdir(tmp);
    try {
      await fill(tmp);
      await fs.promises.rename(tmp, path.join(this.o.userDir, id));
    } catch (e) {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  /** A pack the user added (the built-in ones cannot be removed). */
  async remove(id: string): Promise<boolean> {
    if (!PACK_ID.test(id)) return false;
    const p = this.get(id);
    if (!p || p.builtin) return false;
    await fs.promises.rm(p.dir, { recursive: true, force: true });
    return true;
  }
}
