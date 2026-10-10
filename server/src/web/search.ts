import { parseBing } from './engines/bing.js';
import { parseDuckDuckGo } from './engines/duckduckgo.js';
import { PAGE_ENGINES, readResultPage, resultPageUrl, type PageEngineId, type RawSearchPage } from './engines/pages.js';
import { httpUrl, type ParsedPage, type SearchHit } from './engines/types.js';
import { relevance } from './relevance.js';

/**
 * Web search for every agent, without an API key — the way browser agents do it: the engine's result page is opened
 * in the built-in browser (a real page, with the user's cookies and address behind it) and read there
 * (engines/pages.ts). `auto` tries DuckDuckGo, Bing, Yahoo and Baidu in turn; Google is there to be chosen (it asks
 * many networks for a CAPTCHA, which the user can do in the browser). An engine that refuses (a challenge, an error,
 * a timeout) is skipped, and left out for a while so the next search does not wait for it again.
 *
 * With no desktop window hosting the browser (the web app, a phone) the result pages of Bing and DuckDuckGo are
 * fetched by this process instead — through the user's proxy (net/proxy.ts), but as a program, which both engines
 * treat worse: measured 2026-10-10, DuckDuckGo rate-limited it after two requests where it answered a real page 24
 * times out of 24. Brave's API is there for people who have a key.
 *
 * Whatever the way, results are checked against the query's words (relevance.ts): Bing answers some networks with
 * HTTP 200 and a normal-looking list about something else. Unrelated ones are not handed on; ones that know only one
 * word of a longer query are kept as a last resort (`weak`) while the next engine is asked.
 */
export type EngineId = PageEngineId | 'brave';
export type EngineSetting = 'auto' | EngineId;
/** `browser`: only in the built-in browser (there is no way to fetch its page as a program). */
export const ENGINES: { id: EngineSetting; label: string; needsKey: boolean; browser?: boolean }[] = [
  { id: 'auto', label: '自动（DuckDuckGo → Bing → Yahoo → 百度）', needsKey: false },
  { id: 'duckduckgo', label: 'DuckDuckGo', needsKey: false },
  { id: 'bing', label: 'Bing', needsKey: false },
  { id: 'google', label: 'Google', needsKey: false, browser: true },
  { id: 'yahoo', label: 'Yahoo', needsKey: false, browser: true },
  { id: 'baidu', label: '百度', needsKey: false, browser: true },
  { id: 'brave', label: 'Brave Search（API，要密钥）', needsKey: true },
];
const LABEL: Record<EngineId, string> = { duckduckgo: 'DuckDuckGo', bing: 'Bing', google: 'Google', yahoo: 'Yahoo', baidu: '百度', brave: 'Brave Search' };
const isPageEngine = (e: EngineId): e is PageEngineId => (PAGE_ENGINES as readonly string[]).includes(e);
export const engineLabel = (id: string) => LABEL[id as EngineId] ?? id;

/** Anything that is not one of ours reads as `auto` (a setting written by a newer or older version). */
export function engineSetting(v: unknown): EngineSetting {
  return ENGINES.some((e) => e.id === v) ? (v as EngineSetting) : 'auto';
}

/** `weak`: the best there was, but the results know little of the query — the model is told to check them. */
export interface SearchOutcome { engine: EngineId; results: SearchHit[]; weak?: boolean }
export interface SearchOptions { count?: number; engine?: EngineSetting; signal?: AbortSignal }
/** Engines `auto` leaves out until a time, after they failed to answer (per process; a named engine is always asked). */
export type Cooldown = Map<EngineId, { until: number; why: string }>;
/** Load a result page in the built-in browser and hand back what it lists. Throws when the window cannot (no answer, a failed load). */
export type BrowserSearch = (engine: PageEngineId, url: string, signal: AbortSignal) => Promise<RawSearchPage>;
export interface SearchDeps {
  fetch?: typeof fetch;
  /** base URLs can be pointed elsewhere (tests, a mirror): CW_DDG_URL, CW_BING_URL, CW_GOOGLE_URL, CW_YAHOO_URL, CW_BAIDU_URL, CW_BRAVE_URL */
  env?: Record<string, string | undefined>;
  keys?: { brave?: string };
  /** set when a desktop window hosts the browser: result pages are read there */
  browser?: BrowserSearch;
  /** the window did not answer a result page in time: whoever supplies `browser` may want to leave it alone for a while */
  onBrowserSilent?: () => void;
  /** one fetch by this process */
  timeoutMs?: number;
  /** one result page in the browser */
  browserTimeoutMs?: number;
  cooldown?: Cooldown;
  now?: () => number;
}

export const DEFAULT_COUNT = 8;
export const MAX_COUNT = 20;
const TIMEOUT_MS = 12_000;
/**
 * A result page in the browser. The window bounds a page itself (search-page.ts: about 18 s for one that never
 * finishes, and one that cannot be loaded comes back as `failed`), and reads three at a time; so this much later
 * with no answer at all it is the window that is not answering, not the engine.
 */
export const BROWSER_TIMEOUT_MS = 40_000;
/** An engine that answered with a refusal (a challenge page, 429, 5xx) is asked again after this… */
export const REFUSED_COOLDOWN_MS = 60_000;
/** …one that could not be reached at all (blocked network, timeout) after this. */
export const UNREACHABLE_COOLDOWN_MS = 5 * 60_000;
const UNRELATED = '返回的结果和搜索词对不上';

/**
 * The engine answered, but not with results (or did not answer): `auto` goes on to the next one.
 * `again`: worth asking again soon (a challenge, a busy server) — as opposed to a missing or wrong key, or results
 * that do not match this particular query.
 */
export class EngineRefused extends Error {
  constructor(readonly engine: EngineId, why: string, readonly again = false) {
    super(`${LABEL[engine]}：${why}`);
    this.name = 'EngineRefused';
  }
}

// What a desktop browser sends for a page load. Bing answers a client without these with a script-rendered shell.
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

const KANA = /[\u3040-\u30ff]/;
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;

/** Results in the language the question was asked in. */
export function acceptLanguage(query: string): string {
  if (KANA.test(query)) return 'ja,en;q=0.8';
  return HAN.test(query) ? 'zh-CN,zh;q=0.9,en;q=0.8' : 'en-US,en;q=0.9';
}

/**
 * Bing needs a market named: without one a scripted request got results for some other query altogether (measured
 * 2026-10-10). Only a few markets answer with the plain HTML list at all — en-US and zh-CN did; ja-JP, en-GB and
 * zh-HK came back as a script-rendered shell — so it is one of those two.
 */
export function bingMarket(query: string): string {
  return HAN.test(query) && !KANA.test(query) ? 'zh-CN' : 'en-US';
}

const base = (env: Record<string, string | undefined>, key: string, fallback: string) => (env[key]?.trim() || fallback).replace(/\/+$/, '');

interface Ctx { fetch: typeof fetch; env: Record<string, string | undefined>; keys: { brave?: string }; signal: AbortSignal; count: number }

async function page(engine: EngineId, url: string, ctx: Ctx, query: string, parse: (html: string) => ParsedPage): Promise<SearchHit[]> {
  const res = await ctx.fetch(url, { headers: { ...BROWSER_HEADERS, 'Accept-Language': acceptLanguage(query) }, redirect: 'follow', signal: ctx.signal });
  // DuckDuckGo answers 202 with its "bots use DuckDuckGo too" page when asked too often
  if (res.status !== 200) throw new EngineRefused(engine, res.status === 202 || res.status === 429 ? `HTTP ${res.status}（请求太频繁，被限流了）` : `HTTP ${res.status}`, true);
  const parsed = parse(await res.text());
  if (parsed.state === 'blocked') throw new EngineRefused(engine, '没有返回结果页（可能要求验证，或者把这次请求当成了机器人）', true);
  return parsed.results;
}

/** What this process can do by itself: the two engines whose result page can be fetched as a program, and Brave's API. */
const RUN: Partial<Record<EngineId, (query: string, ctx: Ctx) => Promise<SearchHit[]>>> = {
  bing: (q, ctx) => page('bing', `${base(ctx.env, 'CW_BING_URL', 'https://www.bing.com')}/search?q=${encodeURIComponent(q)}&setmkt=${bingMarket(q)}`, ctx, q, parseBing),
  duckduckgo: (q, ctx) => page('duckduckgo', `${base(ctx.env, 'CW_DDG_URL', 'https://html.duckduckgo.com')}/html/?q=${encodeURIComponent(q)}`, ctx, q, parseDuckDuckGo),
  async brave(q, ctx) {
    if (!ctx.keys.brave) throw new EngineRefused('brave', '还没有填 API Key');
    const res = await ctx.fetch(`${base(ctx.env, 'CW_BRAVE_URL', 'https://api.search.brave.com')}/res/v1/web/search?q=${encodeURIComponent(q)}&count=${ctx.count}`, {
      headers: { accept: 'application/json', 'x-subscription-token': ctx.keys.brave },
      signal: ctx.signal,
    });
    const j = await json('brave', res);
    return hits((j?.web?.results ?? []) as unknown[], (r) => ({ title: r.title, url: r.url, snippet: r.description }));
  },
};

/** A keyed engine's answer. Its error text can quote the request, never the key: only the status and its own message. */
async function json(engine: EngineId, res: Response): Promise<any> {
  const text = await res.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new EngineRefused(engine, `API Key 不对或没有权限（HTTP ${res.status}）`);
    const said = typeof j?.detail?.error === 'string' ? j.detail.error : typeof j?.error?.detail === 'string' ? j.error.detail : typeof j?.error === 'string' ? j.error : typeof j?.message === 'string' ? j.message : '';
    throw new EngineRefused(engine, `HTTP ${res.status}${said ? ` ${said.slice(0, 160)}` : ''}`, res.status === 429 || res.status >= 500);
  }
  if (!j || typeof j !== 'object') throw new EngineRefused(engine, '返回的不是 JSON', true);
  return j;
}

function hits(rows: unknown[], pick: (r: any) => { title: unknown; url: unknown; snippet: unknown }): SearchHit[] {
  const out: SearchHit[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const p = pick(row);
    const url = typeof p.url === 'string' ? httpUrl(p.url) : null;
    if (!url) continue;
    const text = (v: unknown) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '');
    out.push({ title: text(p.title) || url, url, snippet: text(p.snippet) });
  }
  return out;
}

/**
 * The engines `auto` tries, in order. In the built-in browser DuckDuckGo comes first (it answers a real page from
 * most places) and Google is left out (a CAPTCHA on many networks, and by then another has answered); fetched as a
 * program it is Bing first, because DuckDuckGo rate-limits programs quickly.
 */
export function autoOrder(keys: { brave?: string } = {}, o: { browser?: boolean } = {}): EngineId[] {
  return [...(keys.brave ? (['brave'] as const) : []), ...(o.browser ? (['duckduckgo', 'bing', 'yahoo', 'baidu'] as const) : (['bing', 'duckduckgo'] as const))];
}

export const NEEDS_BROWSER = '要用桌面版 Claude Web 的内置浏览器来搜（现在没有桌面窗口连着）';
/** The window was there when the search began and stopped answering part-way. */
const BROWSER_GONE = '要用内置浏览器来搜，而它这次没有应答';
const challenged = (url: string) => `要求验证，或者没有给出结果页。可以用 browser_open 打开 ${url} ，请用户在内置浏览器里完成验证后再搜`;

export function clampCount(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(1, v));
}

export async function search(query: string, opts: SearchOptions = {}, deps: SearchDeps = {}): Promise<SearchOutcome> {
  const q = query.trim();
  if (!q) throw new Error('搜索词是空的');
  const count = clampCount(opts.count);
  const setting = opts.engine ?? 'auto';
  const auto = setting === 'auto';
  const keys = deps.keys ?? {};
  const now = deps.now ?? Date.now;
  const cooldown = deps.cooldown;
  const refused: string[] = [];
  let empty: EngineId | null = null;
  let weak: SearchOutcome | null = null;
  /** the window stopped answering during this search: the rest is fetched by this process */
  let browser = deps.browser;
  for (const engine of auto ? autoOrder(keys, { browser: !!browser }) : [setting]) {
    if (opts.signal?.aborted) throw new Error('搜索被取消了');
    const resting = auto ? cooldown?.get(engine) : undefined;
    if (resting && resting.until > now()) { refused.push(`${LABEL[engine]}：${resting.why}（刚失败过，过一会儿再试它）`); continue; }
    const own = RUN[engine];
    let timeout: AbortSignal | null = null;
    const within = (ms: number) => {
      timeout = AbortSignal.timeout(ms);
      return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    };
    try {
      let results: SearchHit[] | null = null;
      if (browser && isPageEngine(engine)) {
        const url = resultPageUrl(engine, q, deps.env ?? process.env);
        let raw: RawSearchPage | null = null;
        try { raw = await browser(engine, url, within(deps.browserTimeoutMs ?? BROWSER_TIMEOUT_MS)); } catch (e) {
          if (opts.signal?.aborted) throw e;
          // the window, not the engine: it is gone, said it cannot, or did not answer in time. This process does
          // what it can for the rest of the search, and the engine is not held to blame.
          const silent = !!(timeout as AbortSignal | null)?.aborted;
          browser = undefined;
          timeout = null;
          if (silent) deps.onBrowserSilent?.();
          if (!own) throw new EngineRefused(engine, `内置浏览器没有完成这次搜索（${silent ? '没有在限定时间内应答' : reason(e)}）`);
        }
        if (raw) {
          // the page itself could not be loaded: the engine is out of reach from here, like a failed fetch
          if (raw.failed) throw new Error(raw.failed);
          const parsed = readResultPage(engine, raw, count);
          if (parsed.state === 'blocked') throw new EngineRefused(engine, challenged(url), true);
          results = parsed.results;
        }
      }
      if (!results) {
        if (!own) { refused.push(`${LABEL[engine]}：${deps.browser ? BROWSER_GONE : NEEDS_BROWSER}`); continue; }
        const signal = within(deps.timeoutMs ?? TIMEOUT_MS);
        results = (await own(q, { fetch: deps.fetch ?? fetch, env: deps.env ?? process.env, keys, count, signal })).slice(0, count);
      }
      cooldown?.delete(engine);
      if (!results.length) { empty ??= engine; continue; } // nothing matched there: another engine may still know something
      const fit = engine === 'brave' ? 'ok' : relevance(q, results);
      if (fit === 'unrelated') throw new EngineRefused(engine, UNRELATED);
      if (fit === 'weak') {
        if (!auto) return { engine, results, weak: true };
        weak ??= { engine, results, weak: true };
        continue;
      }
      return { engine, results };
    } catch (e) {
      if (opts.signal?.aborted) throw new Error('搜索被取消了');
      const known = e instanceof EngineRefused;
      const why = known ? e.message.slice(LABEL[engine].length + 1) : (timeout as AbortSignal | null)?.aborted ? '超时' : reason(e);
      refused.push(`${LABEL[engine]}：${why}`);
      // not reached at all (a blocked network costs the whole timeout every time), or told to come back later
      if (!known) cooldown?.set(engine, { until: now() + UNREACHABLE_COOLDOWN_MS, why });
      else if (e.again) cooldown?.set(engine, { until: now() + REFUSED_COOLDOWN_MS, why });
    }
  }
  if (weak) return weak;
  if (empty) return { engine: empty, results: [] };
  throw new Error(`搜索没有成功。${refused.join('；')}`);
}

/** A fetch failure in a few words: undici hides the reason in `cause` ("fetch failed" says nothing). */
function reason(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  return String(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? e).slice(0, 160);
}
