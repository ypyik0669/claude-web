// 开场动画包: the built-in ones (read-only, they come with the app) and the user's (<data dir>/openings/<id>/), listed
// for 设置 › 外观 › 开场和背景, served to the app (the backdrop's loop, the cards' posters, 试放一次's film / page) and
// added from a folder, from one video file, from GitHub (kept aside until the user, who has seen the author and the
// licence, says yes) or by the opening-pack skill (drafts in openings/.drafts/<id>/, played in a window for it — a trial
// run — and saved when the user likes them). The desktop shell plays the opening itself before the server is up
// (desktop/src/opening-pack.ts); this is everything after that.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { OpeningGithubOffer, OpeningInfo, OpeningTrialResult } from '../protocol.js';
import { tr } from '../i18n/index.js';
import { PACK_FILE, PACK_ID, RESERVED_IDS, WEB_ENTRY_MAX, mainFile, packFiles, packIdFor, readPack, safeFile } from './pack.js';
import { parseGithubUrl, rawUrlOk, readGithubPack } from './github.js';

/** One media file of a pack may be at most this big (a 12 s 4K film is well under it). */
export const PACK_FILE_MAX = 256 * 1024 * 1024;
/** A pack read from GitHub waits this long for the user's yes. */
export const OFFER_MS = 15 * 60_000;
/** A trial run gets this long to answer (the pack plays up to 12 s, then the logo, in a window). */
export const TRIAL_MS = 40_000;
const DRAFTS = '.drafts';

export interface TrialRequest { id: string; pack: OpeningInfo; html: string }

export class OpeningService extends EventEmitter {
  private offers = new Map<string, { dir: string; idFrom: string; timer: NodeJS.Timeout }>();
  private hosts = new Map<object, (r: TrialRequest) => void>();
  private waiting = new Map<string, { key: object; resolve: (r: OpeningTrialResult | null) => void; timer: NodeJS.Timeout }>();

  constructor(private o: { builtinDir: string | null; userDir: string; fetch?: typeof fetch; goingOut?: () => Promise<unknown> }) { super(); }

  private roots(): { dir: string; builtin: boolean }[] {
    return [...(this.o.builtinDir ? [{ dir: this.o.builtinDir, builtin: true }] : []), { dir: this.o.userDir, builtin: false }];
  }

  private readFolder(dir: string, id: string, builtin: boolean): OpeningInfo | null {
    let json: unknown;
    try { json = JSON.parse(fs.readFileSync(path.join(dir, PACK_FILE), 'utf8')); } catch { return null; }
    const p = readPack(json, id, builtin);
    if ('error' in p) return null;
    // a pack whose film / page is missing is no pack (a half-finished copy)
    try { if (!fs.statSync(path.join(dir, mainFile(p))).isFile()) return null; } catch { return null; }
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
        if (!PACK_ID.test(n) || seen.has(n) || RESERVED_IDS.has(n)) continue;
        const p = this.readFolder(path.join(r.dir, n), n, r.builtin);
        if (p) { out.push(p); seen.add(n); }
      }
    }
    return out;
  }

  /** The pack `id` (first root that has it), or null. */
  get(id: string): (OpeningInfo & { dir: string }) | null {
    if (!PACK_ID.test(id) || RESERVED_IDS.has(id)) return null;
    for (const r of this.roots()) {
      const dir = path.join(r.dir, id);
      const p = this.readFolder(dir, id, r.builtin);
      if (p) return { ...p, dir };
    }
    return null;
  }

  /** The path of a file the pack uses (its film / page, loop, poster) — nothing else of the folder is served. */
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

  private builtinIds(): Set<string> {
    const s = new Set<string>();
    if (this.o.builtinDir) { try { for (const n of fs.readdirSync(this.o.builtinDir)) s.add(n.toLowerCase()); } catch { /* none */ } }
    return s;
  }

  private checkSize(file: string, max = PACK_FILE_MAX) {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { throw new Error(tr('找不到文件：{file}', { file })); }
    if (!st.isFile()) throw new Error(tr('不是文件：{file}', { file }));
    if (st.size > max) throw new Error(tr('{file} 太大了（超过 {mb} MB）', { file: path.basename(file), mb: Math.round(max / 1048576) }));
  }

  private limitOf(p: OpeningInfo, file: string) { return p.kind === 'web' && file === p.entry ? WEB_ENTRY_MAX : PACK_FILE_MAX; }

  /** 从文件夹导入: a folder with an opening.json → a copy under openings/ (the files the pack uses, and the json). */
  async importFolder(src: string): Promise<OpeningInfo> {
    if (typeof src !== 'string' || !path.isAbsolute(src)) throw new Error(tr('要一个文件夹的完整路径'));
    let json: unknown;
    try { json = JSON.parse(await fs.promises.readFile(path.join(src, PACK_FILE), 'utf8')); } catch (e: any) {
      throw new Error(e?.code === 'ENOENT' ? tr('这个文件夹里没有 opening.json，不是动画包') : tr('opening.json 读不了：{error}', { error: e?.message ?? e }));
    }
    const probe = readPack(json, 'probe', false);
    if ('error' in probe) throw new Error(probe.error);
    for (const f of packFiles(probe)) this.checkSize(path.join(src, f), this.limitOf(probe, f));
    const id = packIdFor(path.basename(src), this.taken());
    await this.write(id, async (dir) => {
      for (const f of packFiles(probe)) await fs.promises.copyFile(path.join(src, f), path.join(dir, f));
      await fs.promises.writeFile(path.join(dir, PACK_FILE), JSON.stringify(json, null, 2));
    });
    this.emit('changed');
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
    this.emit('changed');
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

  /** A pack the user added, and its draft (the built-in ones cannot be removed). */
  async remove(id: string): Promise<boolean> {
    if (!PACK_ID.test(id)) return false;
    let gone = false;
    const draft = path.join(this.o.userDir, DRAFTS, id);
    if (fs.existsSync(draft)) { await fs.promises.rm(draft, { recursive: true, force: true }); gone = true; }
    const p = this.get(id);
    if (p && !p.builtin) { await fs.promises.rm(p.dir, { recursive: true, force: true }); gone = true; }
    if (gone) this.emit('changed');
    return gone;
  }

  // ---- 从 GitHub 安装 ----

  /**
   * Read a pack from a GitHub address and download the files it uses into a folder kept aside (not listed, not
   * played): what the user is asked about — its name, author, licence, the repository's licence, where it is from.
   */
  async githubInspect(url: string): Promise<OpeningGithubOffer> {
    const t = parseGithubUrl(url);
    if (!t) throw new Error(tr('要一个 github.com 上的地址：仓库，或仓库里放动画包的那个文件夹'));
    await this.o.goingOut?.().catch(() => {});
    const gh = await readGithubPack(t, { fetch: this.o.fetch });
    const probe = readPack(gh.json, 'probe', false);
    if ('error' in probe) throw new Error(probe.error);
    const want = packFiles(probe).map((name) => {
      const f = gh.files.find((x) => x.name === name);
      if (!f) throw new Error(tr('opening.json 里写的 {file} 不在这个文件夹里', { file: name }));
      const max = this.limitOf(probe, name);
      if (f.size > max) throw new Error(tr('{file} 太大了（超过 {mb} MB）', { file: name, mb: Math.round(max / 1048576) }));
      return f;
    });
    await fs.promises.mkdir(this.o.userDir, { recursive: true });
    const token = randomUUID();
    const dir = path.join(this.o.userDir, `.tmp-gh-${token}`);
    await fs.promises.mkdir(dir);
    try {
      for (const f of want) await this.download(f.download, path.join(dir, f.name), this.limitOf(probe, f.name));
      await fs.promises.writeFile(path.join(dir, PACK_FILE), JSON.stringify(gh.json, null, 2));
    } catch (e) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    const idFrom = t.path ? t.path.split('/').pop()! : t.repo;
    const timer = setTimeout(() => { void this.githubCancel(token); }, OFFER_MS);
    timer.unref?.();
    this.offers.set(token, { dir, idFrom, timer });
    return { token, info: probe, source: gh.source, owner: gh.owner, ...(gh.repoLicense ? { repoLicense: gh.repoLicense } : {}), files: want.map(({ name, size }) => ({ name, size })), bytes: want.reduce((a, f) => a + f.size, 0) };
  }

  /** One file from GitHub, at most `max` bytes (a file that grows past what it said is cut off and refused). */
  private async download(url: string, to: string, max: number) {
    if (!rawUrlOk(url)) throw new Error(tr('GitHub 给的下载地址不对'));
    const f = this.o.fetch ?? fetch;
    const r = await f(url, { headers: { 'user-agent': 'claude-web' }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!r.ok || !r.body) throw new Error(tr('下载 {file} 失败（{status}）', { file: path.basename(to), status: r.status }));
    let n = 0;
    const cap = new Transform({ transform(chunk: Buffer, _e, cb) { n += chunk.length; cb(n > max ? new Error(tr('{file} 太大了（超过 {mb} MB）', { file: path.basename(to), mb: Math.round(max / 1048576) })) : null, chunk); } });
    await pipeline(Readable.fromWeb(r.body as any), cap, fs.createWriteStream(to));
  }

  /** The user said yes: the pack moves in under a folder name of its own. */
  async githubInstall(token: string): Promise<OpeningInfo> {
    const o = this.offers.get(String(token));
    if (!o) throw new Error(tr('这次安装已经过期了，再从 GitHub 安装一次'));
    this.offers.delete(String(token));
    clearTimeout(o.timer);
    const id = packIdFor(o.idFrom, this.taken());
    await fs.promises.rename(o.dir, path.join(this.o.userDir, id));
    this.emit('changed');
    return this.get(id)!;
  }

  /** The user said no (or the offer ran out): its files go. */
  async githubCancel(token: string): Promise<void> {
    const o = this.offers.get(String(token));
    if (!o) return;
    this.offers.delete(String(token));
    clearTimeout(o.timer);
    await fs.promises.rm(o.dir, { recursive: true, force: true }).catch(() => {});
  }

  // ---- the opening-pack skill: drafts ----

  private draftDir(id: string) { return path.join(this.o.userDir, DRAFTS, id); }

  /**
   * Keep a web pack draft (the same id replaces it): its page and an opening.json. A new draft takes its folder name
   * from its name, never a built-in pack's nor an id of the app's; the id it answers with is the one to draft again.
   */
  saveDraft(d: { id?: unknown; name?: unknown; author?: unknown; license?: unknown; maxSeconds?: unknown; html?: unknown }): OpeningInfo & { dir: string } {
    if (typeof d.html !== 'string' || !d.html.trim()) throw new Error(tr('要 html：index.html 的全部内容（字符串）'));
    if (Buffer.byteLength(d.html) > WEB_ENTRY_MAX) throw new Error(tr('index.html 太大了（超过 8 MB）'));
    const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 60) : '';
    if (!name) throw new Error(tr('要 name：这个开场叫什么'));
    const builtin = this.builtinIds();
    let id = typeof d.id === 'string' ? d.id.trim().toLowerCase() : '';
    if (id && (!PACK_ID.test(id) || RESERVED_IDS.has(id) || builtin.has(id))) throw new Error(tr('id「{id}」不能用：小写字母、数字、点、横线，不能是内置开场的', { id }));
    if (!id) {
      const taken = new Set([...builtin, ...this.taken()]);
      try { for (const n of fs.readdirSync(path.join(this.o.userDir, DRAFTS))) taken.add(n); } catch { /* none yet */ }
      id = packIdFor(name, taken);
    }
    const json: Record<string, unknown> = { name, kind: 'web', entry: 'index.html' };
    if (typeof d.author === 'string' && d.author.trim()) json.author = d.author.trim().slice(0, 80);
    if (typeof d.license === 'string' && d.license.trim()) json.license = d.license.trim().slice(0, 60);
    if (typeof d.maxSeconds === 'number' && Number.isFinite(d.maxSeconds) && d.maxSeconds > 0) json.maxSeconds = Math.min(12, d.maxSeconds);
    const dir = this.draftDir(id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, body] of [[PACK_FILE, JSON.stringify(json, null, 2)], ['index.html', d.html]] as const) {
      fs.writeFileSync(path.join(dir, `${f}.tmp`), body);
      fs.renameSync(path.join(dir, `${f}.tmp`), path.join(dir, f));
    }
    const p = this.readFolder(dir, id, false);
    if (!p) throw new Error(tr('草稿没存好'));
    return { ...p, draft: true, dir };
  }

  /** A draft (or, `saved`, a saved web pack): its info and its page. */
  draft(id: string, saved = false): { info: OpeningInfo; html: string } | null {
    if (!PACK_ID.test(id)) return null;
    const read = (dir: string, draft: boolean) => {
      const p = this.readFolder(dir, id, false);
      if (!p || p.kind !== 'web') return null;
      try { return { info: { ...p, ...(draft ? { draft: true } : {}) }, html: fs.readFileSync(path.join(dir, mainFile(p)), 'utf8') }; } catch { return null; }
    };
    const d = read(this.draftDir(id), true);
    if (d || !saved) return d;
    const p = this.get(id);
    return p && !p.builtin ? read(p.dir, false) : null;
  }

  /** The drafts, newest first. */
  drafts(): OpeningInfo[] {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(this.o.userDir, DRAFTS)); } catch { return []; }
    const out: { p: OpeningInfo; at: number }[] = [];
    for (const n of names) {
      if (!PACK_ID.test(n)) continue;
      const dir = this.draftDir(n);
      const p = this.readFolder(dir, n, false);
      if (!p) continue;
      let at = 0;
      try { at = fs.statSync(path.join(dir, PACK_FILE)).mtimeMs; } catch { /* gone */ }
      out.push({ p: { ...p, draft: true }, at });
    }
    return out.sort((a, b) => b.at - a.at).map((x) => x.p);
  }

  /** The draft becomes a saved pack (replacing a saved one of the user's with the same id). */
  async publishDraft(id: string): Promise<OpeningInfo> {
    const from = this.draftDir(String(id));
    if (!PACK_ID.test(String(id)) || !fs.existsSync(path.join(from, PACK_FILE))) throw new Error(tr('没有这个草稿：{id}（先用 opening_draft）', { id }));
    if (this.builtinIds().has(id)) throw new Error(tr('「{id}」是内置开场的名字，换一个 id 再存', { id }));
    const to = path.join(this.o.userDir, id);
    await fs.promises.rm(to, { recursive: true, force: true });
    await fs.promises.rename(from, to);
    this.emit('changed');
    const p = this.get(id);
    if (!p) throw new Error(tr('存好的开场读不出来：{id}', { id }));
    return p;
  }

  // ---- trial runs in a window ----

  /** A window that can play trials (the most recent one asked first). */
  setHost(key: object, on: boolean, send?: (r: TrialRequest) => void) {
    if (on && send) { this.hosts.delete(key); this.hosts.set(key, send); } else this.dropConnection(key);
  }

  dropConnection(key: object) {
    this.hosts.delete(key);
    for (const [id, w] of this.waiting) if (w.key === key) { clearTimeout(w.timer); this.waiting.delete(id); w.resolve(null); }
  }

  hasHost() { return this.hosts.size > 0; }

  /** Play a draft in a window: what it saw, or null (no window, it went away, or it took too long). */
  trial(pack: OpeningInfo, html: string, ms = TRIAL_MS): Promise<OpeningTrialResult | null> {
    let host: [object, (r: TrialRequest) => void] | null = null;
    for (const e of this.hosts) host = e;
    if (!host) return Promise.resolve(null);
    const [key, send] = host;
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(null); }, ms);
      this.waiting.set(id, { key, resolve, timer });
      try { send({ id, pack, html }); } catch { clearTimeout(timer); this.waiting.delete(id); resolve(null); }
    });
  }

  /** A window's answer to a trial. False: nothing of that connection is waiting for it. */
  trialResult(key: object, id: string, r: Partial<OpeningTrialResult>): boolean {
    const w = this.waiting.get(id);
    if (!w || w.key !== key) return false;
    clearTimeout(w.timer);
    this.waiting.delete(id);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    w.resolve({
      ...(r.end === 'done' || r.end === 'cut' || r.end === 'skip' ? { end: r.end } : {}),
      ...(num(r.at) !== undefined ? { at: num(r.at) } : {}),
      errors: Array.isArray(r.errors) ? r.errors.map((e) => String(e).slice(0, 600)).slice(0, 30) : [],
      ...(num(r.avgMs) !== undefined ? { avgMs: num(r.avgMs) } : {}),
      ...(num(r.maxMs) !== undefined ? { maxMs: num(r.maxMs) } : {}),
      ...(num(r.frames) !== undefined ? { frames: num(r.frames) } : {}),
      ...(typeof r.png === 'string' && r.png.length < 6_000_000 ? { png: r.png } : {}),
      ...(typeof r.note === 'string' ? { note: r.note.slice(0, 500) } : {}),
    });
    return true;
  }
}
