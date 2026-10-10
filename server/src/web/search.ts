import { parseBing } from './engines/bing.js';
import { parseDuckDuckGo } from './engines/duckduckgo.js';
import { httpUrl, type ParsedPage, type SearchHit } from './engines/types.js';
import { relevance } from './relevance.js';

/**
 * Web search for every agent, without an API key: Bing's and DuckDuckGo's HTML result pages, fetched with this
 * process's `fetch` — which already goes through the user's proxy (net/proxy.ts). Tavily and Brave are there for
 * people who have a key. `auto` tries them in turn: a keyed engine first when its key is set, then Bing, then
 * DuckDuckGo; an engine that refuses (a CAPTCHA, an HTTP error, a bad key, a timeout) is skipped, and left out for a
 * while so the next search does not wait for it again.
 *
 * Bing answers a program with HTTP 200 and results that often have little to do with the query (relevance.ts):
 * its results are checked against the query's words. Unrelated ones are not handed on; ones that know only one word
 * of a longer query are kept as a last resort (`weak`) while the next engine is asked.
 */
export type EngineId = 'bing' | 'duckduckgo' | 'tavily' | 'brave';
export type EngineSetting = 'auto' | EngineId;
export const ENGINES: { id: EngineSetting; label: string; needsKey: boolean }[] = [
  { id: 'auto', label: '自动（Bing → DuckDuckGo）', needsKey: false },
  { id: 'bing', label: 'Bing', needsKey: false },
  { id: 'duckduckgo', label: 'DuckDuckGo', needsKey: false },
  { id: 'tavily', label: 'Tavily', needsKey: true },
  { id: 'brave', label: 'Brave Search', needsKey: true },
];
const LABEL: Record<EngineId, string> = { bing: 'Bing', duckduckgo: 'DuckDuckGo', tavily: 'Tavily', brave: 'Brave Search' };
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
export interface SearchDeps {
  fetch?: typeof fetch;
  /** base URLs can be pointed elsewhere for tests: CW_BING_URL, CW_DDG_URL, CW_TAVILY_URL, CW_BRAVE_URL */
  env?: Record<string, string | undefined>;
  keys?: { tavily?: string; brave?: string };
  timeoutMs?: number;
  cooldown?: Cooldown;
  now?: () => number;
}

export const DEFAULT_COUNT = 8;
export const MAX_COUNT = 20;
const TIMEOUT_MS = 12_000;
/** An engine that answered with a refusal (a challenge page, 429, 5xx) is asked again after this… */
export const REFUSED_COOLDOWN_MS = 60_000;
/** …one that could not be reached at all (blocked network, timeout) after this. */
export const UNREACHABLE_COOLDOWN_MS = 5 * 60_000;
const UNRELATED = '返回的结果和搜索词对不上（它有时这样回答不是浏览器发出的请求）';

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

interface Ctx { fetch: typeof fetch; env: Record<string, string | undefined>; keys: { tavily?: string; brave?: string }; signal: AbortSignal; count: number }

async function page(engine: EngineId, url: string, ctx: Ctx, query: string, parse: (html: string) => ParsedPage): Promise<SearchHit[]> {
  const res = await ctx.fetch(url, { headers: { ...BROWSER_HEADERS, 'Accept-Language': acceptLanguage(query) }, redirect: 'follow', signal: ctx.signal });
  // DuckDuckGo answers 202 with its "bots use DuckDuckGo too" page when asked too often
  if (res.status !== 200) throw new EngineRefused(engine, res.status === 202 || res.status === 429 ? `HTTP ${res.status}（请求太频繁，被限流了）` : `HTTP ${res.status}`, true);
  const parsed = parse(await res.text());
  if (parsed.state === 'blocked') throw new EngineRefused(engine, '没有返回结果页（可能要求验证，或者把这次请求当成了机器人）', true);
  return parsed.results;
}

const RUN: Record<EngineId, (query: string, ctx: Ctx) => Promise<SearchHit[]>> = {
  bing: (q, ctx) => page('bing', `${base(ctx.env, 'CW_BING_URL', 'https://www.bing.com')}/search?q=${encodeURIComponent(q)}&setmkt=${bingMarket(q)}`, ctx, q, parseBing),
  duckduckgo: (q, ctx) => page('duckduckgo', `${base(ctx.env, 'CW_DDG_URL', 'https://html.duckduckgo.com')}/html/?q=${encodeURIComponent(q)}`, ctx, q, parseDuckDuckGo),
  async tavily(q, ctx) {
    if (!ctx.keys.tavily) throw new EngineRefused('tavily', '还没有填 API Key');
    const res = await ctx.fetch(`${base(ctx.env, 'CW_TAVILY_URL', 'https://api.tavily.com')}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.keys.tavily}` },
      body: JSON.stringify({ query: q, max_results: ctx.count, search_depth: 'basic' }),
      signal: ctx.signal,
    });
    const j = await json('tavily', res);
    return hits((j?.results ?? []) as unknown[], (r) => ({ title: r.title, url: r.url, snippet: r.content }));
  },
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

/** The engines `auto` tries, in order. */
export function autoOrder(keys: { tavily?: string; brave?: string } = {}): EngineId[] {
  return [...(keys.tavily ? (['tavily'] as const) : []), ...(keys.brave ? (['brave'] as const) : []), 'bing', 'duckduckgo'];
}

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
  for (const engine of auto ? autoOrder(keys) : [setting]) {
    if (opts.signal?.aborted) throw new Error('搜索被取消了');
    const resting = auto ? cooldown?.get(engine) : undefined;
    if (resting && resting.until > now()) { refused.push(`${LABEL[engine]}：${resting.why}（刚失败过，过一会儿再试它）`); continue; }
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS);
    const ctx: Ctx = { fetch: deps.fetch ?? fetch, env: deps.env ?? process.env, keys, count, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout };
    try {
      const results = (await RUN[engine](q, ctx)).slice(0, count);
      cooldown?.delete(engine);
      if (!results.length) { empty ??= engine; continue; } // nothing matched there: another engine may still know something
      const fit = engine === 'bing' ? relevance(q, results) : 'ok';
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
      const why = known ? e.message.slice(LABEL[engine].length + 1) : timeout.aborted ? '超时' : reason(e);
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
