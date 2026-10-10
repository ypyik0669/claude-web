import { decodeEntities, inlineText } from '../entities.js';
import { httpUrl, type ParsedPage, type SearchHit } from './types.js';

/**
 * html.duckduckgo.com's result page → results. Each result has `<a class="result__a" href="//duckduckgo.com/l/?uddg=
 * <the URL, percent-encoded>&rut=…">title</a>` and `<a class="result__snippet">`. Ads are results too
 * (`result--ad`), their `uddg` pointing at duckduckgo.com/y.js: left out.
 */
export function parseDuckDuckGo(html: string): ParsedPage {
  const results: SearchHit[] = [];
  const seen = new Set<string>();
  // one chunk per title link: the snippet that belongs to it comes before the next title
  const chunks = html.split(/(?=<a\b[^>]*\bclass="[^"]*\bresult__a\b)/i).slice(1);
  for (const chunk of chunks) {
    const link = /^<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    if (!link) continue;
    const url = resolveDuckDuckGoUrl(decodeEntities(link[1]));
    const title = inlineText(link[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    const snippet = /<a\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    results.push({ title, url, snippet: snippet ? inlineText(snippet[1]) : '' });
  }
  if (results.length) return { state: 'ok', results };
  if (/\bclass="[^"]*\bno-results\b/i.test(html)) return { state: 'empty', results };
  // "Unfortunately, bots use DuckDuckGo too" (the anomaly page), or anything else that is not a result list
  return { state: 'blocked', results };
}

/** `//duckduckgo.com/l/?uddg=<encoded>` → the address; null for ads and DuckDuckGo's own pages. */
export function resolveDuckDuckGoUrl(raw: string): string | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw, 'https://duckduckgo.com'); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) {
    const target = u.pathname === '/l/' ? httpUrl(u.searchParams.get('uddg') ?? '') : null;
    if (!target) return null;
    const th = new URL(target).hostname.toLowerCase();
    return th === 'duckduckgo.com' || th.endsWith('.duckduckgo.com') ? null : target;
  }
  return httpUrl(u.href);
}
