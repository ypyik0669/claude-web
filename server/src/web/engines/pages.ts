import { resolveBingUrl } from './bing.js';
import { resolveDuckDuckGoUrl } from './duckduckgo.js';
import { httpUrl, type ParsedPage, type SearchHit } from './types.js';

/**
 * A search engine's result page, read in the built-in browser (a real page: the engine's scripts ran, the user's
 * cookies and address are behind it) — the way browser agents search. Measured 2026-10-10 from one network: the same
 * DuckDuckGo that rate-limits a program's request after two answered a real page 24 times out of 24; Google asked a
 * real page for a CAPTCHA, Bing answered it with pages about something else. So which engine works is a matter of
 * where the user is, and the page has to be judged: a challenge is told apart from results, and from "nothing found".
 *
 * The window reads the page generically (page-agent.js `results`: links that are headings, with the text around
 * them) and hands the raw list over; what is specific to an engine is here, where it can be tested: the address of
 * its result page, how its links are wrapped, which links are its own, and what its challenge looks like.
 */
export type PageEngineId = 'duckduckgo' | 'bing' | 'google' | 'yahoo' | 'baidu';
export const PAGE_ENGINES: readonly PageEngineId[] = ['duckduckgo', 'bing', 'google', 'yahoo', 'baidu'];

/** One link the page listed: as the page had it (`href` resolved by the browser), `alt` = a real address the page kept beside a wrapped link. */
export interface RawCandidate { title: string; href: string; snippet?: string; alt?: string }
/** `failed`: the page could not be loaded at all (the browser's own reason, e.g. ERR_CONNECTION_RESET) — the engine is out of reach from here. */
export interface RawSearchPage { url: string; title: string; text: string; candidates: RawCandidate[]; failed?: string }

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
const KANA = /[\u3040-\u30ff]/;

/** Where each engine is; the variable points it elsewhere (tests, a mirror) — the same ones the fetched pages use. */
const HOME: Record<PageEngineId, [variable: string, address: string]> = {
  duckduckgo: ['CW_DDG_URL', 'https://html.duckduckgo.com'],
  bing: ['CW_BING_URL', 'https://www.bing.com'],
  google: ['CW_GOOGLE_URL', 'https://www.google.com'],
  yahoo: ['CW_YAHOO_URL', 'https://search.yahoo.com'],
  baidu: ['CW_BAIDU_URL', 'https://www.baidu.com'],
};

/** The page to load for a query. */
export function resultPageUrl(engine: PageEngineId, query: string, env: Record<string, string | undefined> = {}): string {
  const q = encodeURIComponent(query);
  const [variable, address] = HOME[engine];
  const at = (env[variable]?.trim() || address).replace(/\/+$/, '');
  switch (engine) {
    // the plain HTML version: no script has to run, and it is the same index
    case 'duckduckgo': return `${at}/html/?q=${q}`;
    case 'bing': return `${at}/search?q=${q}&setmkt=${HAN.test(query) && !KANA.test(query) ? 'zh-CN' : 'en-US'}`;
    case 'google': return `${at}/search?q=${q}&hl=${KANA.test(query) ? 'ja' : HAN.test(query) ? 'zh-CN' : 'en'}`;
    case 'yahoo': return `${at}/search?p=${q}`;
    case 'baidu': return `${at}/s?wd=${q}`;
  }
}

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Google's own pages (the search itself, settings, sign-in, help) — not its products, which are results like any other. */
function googleOwn(u: URL): boolean {
  const h = u.hostname.toLowerCase();
  if (/^(accounts|support|policies|myaccount|consent)\.google\./.test(h)) return true;
  if (!/^(www\.)?google\.[a-z.]+$/.test(h)) return false;
  return /^\/(search|url|preferences|advanced_search|setprefs|sorry|webhp|intl|imgres|maps)?(\/|$)/.test(u.pathname) || u.pathname === '/';
}

/**
 * The address a listed link leads to; null for the engine's own pages, ads, and anything that is not http(s).
 * Engines wrap their links: Bing in `/ck/a?…u=a1<base64>`, DuckDuckGo in `/l/?uddg=<encoded>`, Google sometimes in
 * `/url?q=`, Yahoo in `r.search.yahoo.com/…/RU=<encoded>/RK=…`; Baidu's `/link?url=…` cannot be opened up, but the
 * result block usually carries the real address (`alt`).
 */
export function unwrapResultUrl(engine: PageEngineId, href: string, alt?: string): string | null {
  switch (engine) {
    case 'duckduckgo': return resolveDuckDuckGoUrl(href);
    case 'bing': return resolveBingUrl(href);
    case 'google': {
      const direct = httpUrl(href);
      if (!direct) return null;
      const u = new URL(direct);
      if (/^(www\.)?google\.[a-z.]+$/.test(u.hostname.toLowerCase()) && u.pathname === '/url') {
        const target = httpUrl(u.searchParams.get('q') ?? u.searchParams.get('url') ?? '');
        return target && !googleOwn(new URL(target)) ? target : null;
      }
      return googleOwn(u) ? null : direct;
    }
    case 'yahoo': {
      const direct = httpUrl(href);
      if (!direct) return null;
      const u = new URL(direct);
      const h = u.hostname.toLowerCase();
      if (h === 'r.search.yahoo.com') {
        const ru = /\/RU=([^/]+)\//.exec(u.pathname)?.[1];
        let target: string | null = null;
        try { target = ru ? httpUrl(decodeURIComponent(ru)) : null; } catch { target = null; }
        return target && !under(hostOf(target), 'search.yahoo.com') ? target : null;
      }
      return under(h, 'search.yahoo.com') || h === 'help.yahoo.com' || h === 'legal.yahoo.com' || h === 'login.yahoo.com' ? null : direct;
    }
    case 'baidu': {
      const real = alt ? httpUrl(alt) : null;
      if (real && hostOf(real) !== 'www.baidu.com') return real;
      const direct = httpUrl(href);
      if (!direct) return null;
      const u = new URL(direct);
      // its own pages are www.baidu.com/<anything but the redirect>; Baike, Zhidao, Tieba… are results
      if (u.hostname.toLowerCase() === 'www.baidu.com' || u.hostname.toLowerCase() === 'baidu.com') return u.pathname === '/link' ? direct : null;
      return direct;
    }
  }
}

const CHALLENGE_URL: Record<PageEngineId, RegExp> = {
  duckduckgo: /duckduckgo\.com\/(anomaly|challenge)/i,
  bing: /bing\.com\/(turing|captcha)/i,
  google: /google\.[a-z.]+\/sorry\b|consent\.google\./i,
  yahoo: /(guce|consent)\.yahoo\.com/i,
  baidu: /wappass\.baidu\.com|\/static\/captcha/i,
};
/** Words of a challenge page, whoever serves it (a page of real results is long and says none of these up front). */
const CHALLENGE_TEXT = /unusual traffic|not a robot|are you a (robot|human)|verify (that )?you('re| are) (a )?human|bots use duckduckgo too|complete the (following )?challenge|one last step|captcha|verifying your request|automated queries|异常流量|安全验证|人机验证|请完成(以下)?验证|访问验证|验证码/i;
const NOTHING_FOUND = /no results|did not match any|no more results|we did not find|没有找到|未找到|找不到和|抱歉.{0,12}(没有|未)/i;

/** What the page turned out to be: a result list, a page that says nothing matched, or something else (a challenge, a shell). */
export function readResultPage(engine: PageEngineId, page: RawSearchPage, count: number): ParsedPage {
  const results: SearchHit[] = [];
  const seen = new Set<string>();
  for (const c of page.candidates) {
    if (results.length >= count) break;
    const url = unwrapResultUrl(engine, c.href, c.alt);
    const title = oneLine(c.title, 300);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: snippetOf(c, title, url) });
  }
  const head = `${page.title}\n${page.text.slice(0, 1200)}`;
  const challenged = CHALLENGE_URL[engine].test(page.url) || (results.length < 3 && CHALLENGE_TEXT.test(head));
  if (challenged) return { state: 'blocked', results: [] };
  if (results.length) return { state: 'ok', results };
  return { state: NOTHING_FOUND.test(page.text) ? 'empty' : 'blocked', results };
}

const oneLine = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\s*/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The text around a title, without the title itself (the page's block holds both) — and without what result pages put
 * between the two: the result's address as displayed (`www.site.com/docs`, `https://site.com > docs > page`) and a
 * machine-readable date. Neither tells the reader anything the `url` does not.
 */
function snippetOf(c: RawCandidate, title: string, url: string): string {
  let s = oneLine(c.snippet, 900);
  const at = s.indexOf(title);
  if (at >= 0) s = `${s.slice(0, at)} ${s.slice(at + title.length)}`;
  s = oneLine(s, 900);
  const host = hostOf(url).replace(/^www\./, '');
  const shown = host ? new RegExp(`^(https?://)?(www\\.)?${escapeRe(host)}\\S*(\\s+[\\u203a\\u00bb>]\\s+\\S+)*\\s*`, 'i') : null;
  for (let i = 0; i < 3; i++) {
    const before = s;
    if (shown) s = s.replace(shown, '');
    s = s.replace(ISO_DATE, '');
    if (s === before) break;
  }
  return oneLine(s, 360);
}
