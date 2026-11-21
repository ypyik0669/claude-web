// The optional local model for semantic PII (after Magpie internal/pii, MIT): AstrLink Guard (QuantumNous/astrlink-guard,
// Apache-2.0), a 37 MB int8 token classifier for Chinese and English that finds what the rules cannot — a name or an
// address in free text, a password with nothing around it to say so.
//
// Off by default. Nothing ships with the app: the files are downloaded on demand into `<data dir>/privacy-model/<rev>`
// from Hugging Face at the revision their SHA-256 were pinned at (a file that does not match is deleted, never used),
// and the model runs through `onnxruntime-node`, which is NOT a dependency of the app — the same download fetches it
// from the npm registry at pinned versions into `<data dir>/privacy-model/runtime` (runtime.ts), and it is loaded lazily
// with a dynamic import from there (or from next to the app / NODE_PATH if the user installed one). Without it the
// switch stays off. Loaded on the first request that needs it, let go after 10 idle minutes; results are cached by
// text (a conversation's history is re-sent every turn).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tr } from '../../i18n/index.js';
import type { PrivacyCategory, PrivacyModelStatus } from '../types.js';
import { zhTrim } from '../zhname.js';
import { Tokenizer, type Token } from './tokenizer.js';
import { fetchVerified } from './download.js';
import { OrtRuntime, type RuntimeOptions } from './runtime.js';

export interface PinnedFile { path: string; size: number; sha256: string }

export const GUARD_REV = '7216b6a3b897ef903d4b1ba367ae6fb95b0fa5e4';
export const GUARD_BASE = 'https://huggingface.co/QuantumNous/astrlink-guard/resolve/';
export const GUARD_FILES: PinnedFile[] = [
  { path: 'int8/model_int8.onnx', size: 330781, sha256: '0a070d3113615e33ba3b84d6bd486f663a377c04c4b056e7381732179f51832a' },
  { path: 'int8/model_int8.onnx_data', size: 37124608, sha256: '0ba34216ceead01e0ae2dfd8e46d52b67e7aee80b04f722d9b758613a91c0067' },
  { path: 'int8/tokenizer.json', size: 1502881, sha256: '0cf3b235ef125658015a6c8026a5fe6f28088bf825101a990ec18a10200feef4' },
];

/** The model's BIO tags, by output index. */
export const LABELS = ['O',
  'B-email', 'I-email', 'B-phone', 'I-phone', 'B-account', 'I-account',
  'B-payment_card', 'I-payment_card', 'B-ip_address', 'I-ip_address',
  'B-url', 'I-url', 'B-common_secret', 'I-common_secret',
  'B-private_address', 'I-private_address', 'B-private_date', 'I-private_date',
  'B-private_person', 'I-private_person'];

/** The model's kinds as privacy categories (accounts, IPs, URLs and dates have no category: not used). */
export const KIND_CATEGORY: Record<string, PrivacyCategory | undefined> = {
  email: 'email', phone: 'phone', payment_card: 'bank_card', common_secret: 'password', private_address: 'address', private_person: 'name',
};

/** Under this a span is dropped whatever the user's threshold. */
export const FLOOR = 0.5;
const MAX_POS = 512;
const WINDOW = MAX_POS - 2;
const OVERLAP = 128;
const IDLE_MS = 10 * 60_000;
const CACHE = 4000;

export interface ModelSpan { start: number; end: number; kind: string; score: number }

/** The network: token ids (with <s> / </s>) in, logits [ids.length × labels] out. */
export type Logits = (ids: number[]) => Promise<Float32Array>;

/** Read BIO tags into spans (a B tag, or an I tag of another kind, starts one; O ends it); a span's score is its least token's. */
export function decode(toks: Token[], lab: number[], prob: number[]): ModelSpan[] {
  const spans: ModelSpan[] = [];
  let cur = -1;
  toks.forEach((t, j) => {
    if (t.start === t.end) return;
    const tag = LABELS[lab[j]] ?? 'O';
    if (tag === 'O') { cur = -1; return; }
    const kind = tag.slice(2);
    if (tag[0] === 'B' || cur < 0 || spans[cur].kind !== kind) { spans.push({ start: t.start, end: t.end, kind, score: prob[j] }); cur = spans.length - 1; return; }
    spans[cur].end = t.end;
    spans[cur].score = Math.min(spans[cur].score, prob[j]);
  });
  return spans.filter((s) => s.score >= FLOOR);
}

/** The model over a whole text: windows of 510 tokens overlapping by 128, each token labelled by the window it is furthest inside. */
export async function findIn(tok: Tokenizer, logits: Logits, text: string): Promise<ModelSpan[]> {
  const toks = tok.encode(text);
  const n = toks.length;
  if (!n) return [];
  const k = LABELS.length;
  const lab = new Array<number>(n).fill(0);
  const prob = new Array<number>(n).fill(0);
  const margin = new Array<number>(n).fill(-1);
  for (let start = 0; ; start += WINDOW - OVERLAP) {
    const end = Math.min(start + WINDOW, n);
    const ids = [0, ...toks.slice(start, end).map((t) => t.id), 2];
    const lg = await logits(ids);
    for (let i = 0; i < end - start; i++) {
      const j = start + i;
      const mg = Math.min(i, end - start - 1 - i);
      if (mg <= margin[j]) continue;
      const row = lg.subarray((i + 1) * k, (i + 2) * k);
      let best = 0, mx = row[0];
      for (let c = 1; c < k; c++) if (row[c] > mx) { best = c; mx = row[c]; }
      let sum = 0;
      for (let c = 0; c < k; c++) sum += Math.exp(row[c] - mx);
      margin[j] = mg; lab[j] = best; prob[j] = 1 / sum;
    }
    if (end === n) break;
  }
  return decode(toks, lab, prob);
}

/** Download one pinned file to `dest`: streamed to `.part`, size and SHA-256 checked, then renamed; a mismatch is deleted. */
export function fetchPinned(url: string, dest: string, f: PinnedFile, o: { signal?: AbortSignal; onBytes?: (n: number) => void; fetchImpl?: typeof fetch } = {}): Promise<void> {
  return fetchVerified(url, dest, { size: f.size, sha256: f.sha256 }, o);
}

/**
 * onnxruntime-node: the one downloaded into the data dir (`own`, the entry file) first, else one the user installed
 * next to the app / on NODE_PATH. Imported fresh each time it is asked for (Node caches the module itself).
 */
export async function loadOrt(own?: string | null): Promise<any> {
  return import(pathToFileURL(own ?? createRequire(import.meta.url).resolve('onnxruntime-node')).href);
}

function ortResolvable(): boolean {
  try { createRequire(import.meta.url).resolve('onnxruntime-node'); return true; } catch { return false; }
}

export interface ModelOptions {
  files?: PinnedFile[];
  base?: string;
  rev?: string;
  fetchImpl?: typeof fetch;
  /** onnxruntime: loaded lazily (tests give a fake) */
  runtime?: () => Promise<any>;
  /** is the runtime there (without loading it) */
  runtimeAvailable?: () => boolean;
  /** the network itself (tests): skips onnxruntime entirely */
  logits?: (dir: string) => Promise<Logits>;
  /** the downloadable onnxruntime (registry, pinned packages, fetch — tests give a fake registry) */
  ort?: RuntimeOptions;
  /** is onnxruntime-node resolvable from the app's own folders (tests: false) */
  appRuntime?: () => boolean;
}

/** A download failure in words a user can act on (network / server / disk); our own messages pass through. */
export function downloadError(e: any): string {
  const msg = String(e?.message ?? e);
  const code = String(e?.code ?? e?.cause?.code ?? '');
  const http = /^HTTP (\d+)/.exec(msg);
  if (http) return tr('下载服务器返回了错误（HTTP {status}），稍后再试', { status: http[1] });
  if (code === 'ENOSPC') return tr('磁盘空间不够，空出一些再下载');
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') return tr('数据目录里的文件写不进去（{code}），可能被别的程序占着', { code });
  if (e?.code === 'EGRESS_DENIED') return msg;
  if (msg === 'fetch failed' || /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR)/.test(code) || /terminated|other side closed/i.test(msg)) {
    return tr('连不上下载服务器，检查网络，或在设置里配好网络代理后再试');
  }
  return msg;
}

/** The local model: its files, the download, and running it. `dir` null: unavailable (no data dir). */
export class PrivacyModel {
  readonly id = 'astrlink-guard';
  readonly name = 'AstrLink Guard';
  private files: PinnedFile[];
  private dl: { ac: AbortController; done: number; total: number } | null = null;
  private error = '';
  private loaded: { tok: Tokenizer; logits: Logits; release?: () => void } | null = null;
  private loading: Promise<NonNullable<PrivacyModel['loaded']>> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private cache = new Map<string, ModelSpan[]>();
  private onChange: (() => void) | null = null;
  private runtimeKnown: boolean | null = null;
  readonly ort: OrtRuntime;

  constructor(private root: string | null, private o: ModelOptions = {}) {
    this.files = o.files ?? GUARD_FILES;
    this.ort = new OrtRuntime(root, o.ort);
  }

  listen(fn: () => void) { this.onChange = fn; }
  private changed() { try { this.onChange?.(); } catch { /* the page catches up on the next push */ } }

  dir(): string | null { return this.root ? path.join(this.root, (this.o.rev ?? GUARD_REV).slice(0, 12)) : null; }
  private fileOf(f: PinnedFile) { return path.join(this.dir()!, path.basename(f.path)); }
  size(): number { return this.files.reduce((a, f) => a + f.size, 0); }

  runtime(): boolean {
    if (this.o.logits) return true;
    if (this.o.runtimeAvailable) return this.o.runtimeAvailable();
    return this.ort.installed() || (this.runtimeKnown ??= (this.o.appRuntime ?? ortResolvable)());
  }

  /** The runtime has to be fetched along with the model (none usable here, and one is pinned for this platform). */
  private needsRuntime(): boolean { return !this.runtime() && this.ort.supported(); }

  /** Every file on disk at its size, and checked when it was downloaded (`.ok` beside it holds its hash). */
  installed(): boolean {
    if (!this.dir()) return false;
    return this.files.every((f) => {
      try { return fs.statSync(this.fileOf(f)).size === f.size && fs.readFileSync(`${this.fileOf(f)}.ok`, 'utf8').trim() === f.sha256; } catch { return false; }
    });
  }

  /**
   * Why it cannot run on this computer right now, or null when it can (in memory already, or every file checked and a
   * runtime to load it with): 'files' — never downloaded here, or deleted since (a copy of the data folder that left
   * privacy-model/ out); 'runtime' — onnxruntime missing; 'downloading' — on its way. No file is read once it is loaded.
   */
  missing(): 'files' | 'runtime' | 'downloading' | null {
    if (this.loaded) return null;
    const files = this.installed();
    if (files && this.runtime()) return null;
    if (this.dl) return 'downloading';
    return files ? 'runtime' : 'files';
  }

  status(): PrivacyModelStatus {
    return {
      id: this.id, name: this.name, size: this.size(), runtime: this.runtime(), installed: this.installed(),
      ...(this.ort.supported() ? { runtimeSize: this.ort.size() } : {}),
      ...(this.ort.installed() ? { runtimeOwn: true } : {}),
      ...(this.dl ? { downloading: { done: this.dl.done, total: this.dl.total } } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.loaded ? { loaded: true } : {}),
    };
  }

  /**
   * Start the download in the background (no-op while one runs): onnxruntime first when this machine has none usable,
   * then the model's files. Resolves when it is done or failed. Picked up without a restart: the runtime is imported
   * lazily from its folder on the first request that needs the model.
   */
  download(): Promise<void> {
    const dir = this.dir();
    if (!dir) return Promise.reject(new Error(tr('没有数据目录，下载不了')));
    if (this.dl) return Promise.resolve();
    const ac = new AbortController();
    const withRuntime = this.needsRuntime();
    const total = this.size() + (withRuntime ? this.ort.size() : 0);
    this.dl = { ac, done: 0, total };
    this.error = '';
    this.changed();
    let last = 0;
    const progress = (done: number) => { if (this.dl) this.dl.done = done; if (Date.now() - last > 500) { last = Date.now(); this.changed(); } };
    const run = async () => {
      let base = 0;
      if (withRuntime) {
        await this.ort.install({ signal: ac.signal, onBytes: progress });
        this.runtimeKnown = null;
        base = this.ort.size();
        this.changed();
      }
      for (const f of this.files) {
        const dest = this.fileOf(f);
        const ok = (() => { try { return fs.statSync(dest).size === f.size && fs.readFileSync(`${dest}.ok`, 'utf8').trim() === f.sha256; } catch { return false; } })();
        if (!ok) {
          await fs.promises.rm(`${dest}.ok`, { force: true }).catch(() => {});
          await fetchPinned(`${this.o.base ?? GUARD_BASE}${this.o.rev ?? GUARD_REV}/${f.path}`, dest, f, {
            signal: ac.signal, fetchImpl: this.o.fetchImpl,
            onBytes: (n) => progress(base + n),
          });
          await fs.promises.writeFile(`${dest}.ok`, f.sha256, 'utf8');
        }
        base += f.size;
        if (this.dl) this.dl.done = base;
      }
    };
    return run().catch((e: any) => { this.error = ac.signal.aborted ? tr('已取消') : downloadError(e); }).finally(() => { this.dl = null; this.changed(); });
  }

  cancel() { this.dl?.ac.abort(); }

  /** Delete the model's files and the downloaded runtime (one installed by hand next to the app is not touched). */
  async remove() {
    this.cancel();
    // a running download's last write must land before the folders go
    while (this.dl) await new Promise((r) => setTimeout(r, 20));
    this.unload();
    this.error = '';
    const dir = this.dir();
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    await this.ort.remove();
    this.runtimeKnown = null;
    this.changed();
  }

  private unload() {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    try { this.loaded?.release?.(); } catch { /* gone anyway */ }
    this.loaded = null;
    this.cache.clear();
  }

  private async load(): Promise<NonNullable<PrivacyModel['loaded']>> {
    if (this.loaded) return this.loaded;
    return (this.loading ??= (async () => {
      // yield first: a failure before any await would otherwise run `finally` (loading = null) before `??=` stores
      // this rejected promise — and every later load would get that old failure until a restart
      await null;
      try {
        if (!this.installed()) throw new Error(tr('本地模型还没下载'));
        const dir = this.dir()!;
        const tok = new Tokenizer(JSON.parse(await fs.promises.readFile(path.join(dir, 'tokenizer.json'), 'utf8')));
        let logits: Logits;
        let release: (() => void) | undefined;
        if (this.o.logits) logits = await this.o.logits(dir);
        else {
          let ort: any;
          if (!this.runtime()) throw new Error(tr('运行库还没下载，本地模型跑不了'));
          try { ort = await (this.o.runtime ? this.o.runtime() : loadOrt(this.ort.resolve())); } catch (e: any) {
            throw new Error(tr('运行库加载失败：{why}', { why: String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 300) }));
          }
          const O = ort.default?.InferenceSession ? ort.default : ort;
          const session = await O.InferenceSession.create(path.join(dir, 'model_int8.onnx'), { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
          release = () => { void session.release?.(); };
          logits = async (ids) => {
            const n = ids.length;
            const feeds: Record<string, any> = {};
            for (const name of session.inputNames as string[]) {
              const fill = /mask/i.test(name) ? 1n : /type/i.test(name) ? 0n : null;
              const data = BigInt64Array.from(fill === null ? ids.map((x) => BigInt(x)) : new Array(n).fill(fill));
              feeds[name] = new O.Tensor('int64', data, [1, n]);
            }
            const out = await session.run(feeds);
            return out[session.outputNames[0]].data as Float32Array;
          };
        }
        this.loaded = { tok, logits, release };
        this.error = '';
        this.changed();
        return this.loaded;
      } catch (e: any) {
        this.error = String(e?.message ?? e);
        this.changed();
        throw e;
      } finally { this.loading = null; }
    })());
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { this.unload(); this.changed(); }, IDLE_MS);
    this.idle.unref?.();
  }

  /**
   * What the model finds in each text, at or above `minScore`, as privacy categories (names trimmed of a title or the
   * words they ran into). Throws when it cannot run — the caller refuses the request (the user asked for the model).
   */
  async find(texts: string[], minScore: number): Promise<{ start: number; end: number; category: PrivacyCategory }[][]> {
    const m = await this.load();
    this.touch();
    const out: { start: number; end: number; category: PrivacyCategory }[][] = [];
    for (const t of texts) {
      const key = crypto.createHash('sha1').update(t).digest('base64');
      let spans = this.cache.get(key);
      if (!spans) {
        // a failure while running is shown on the model's card like a load failure: a request that goes on with the
        // rules alone (no type needs the model) leaves no other trace of it
        try { spans = await findIn(m.tok, m.logits, t); } catch (e: any) { this.error = String(e?.message ?? e); this.changed(); throw e; }
        this.cache.set(key, spans);
        if (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!);
      } else { this.cache.delete(key); this.cache.set(key, spans); }
      const got: { start: number; end: number; category: PrivacyCategory }[] = [];
      for (const s of spans) {
        const category = KIND_CATEGORY[s.kind];
        if (!category || s.score < Math.max(FLOOR, minScore)) continue;
        let [a, b] = [s.start, s.end];
        if (category === 'name') [a, b] = zhTrim(t, a, b);
        // a span's edges may sit on whitespace the tokenizer folded in
        while (a < b && /\s/.test(t[a])) a++;
        while (b > a && /\s/.test(t[b - 1])) b--;
        if (b > a) got.push({ start: a, end: b, category });
      }
      out.push(got);
    }
    return out;
  }
}
