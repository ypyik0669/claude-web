import { decodeEntities, inlineText } from '../entities.js';
import { httpUrl, type ParsedPage, type SearchHit } from './types.js';

/**
 * Bing's HTML result page → results. Organic results are `<li class="b_algo">` inside `<ol id="b_results">`: the
 * title link is in the `<h2>`, the snippet in a `<p>` under `.b_caption` (class `b_lineclamp…` on most).
 * Regex over the raw HTML on purpose: no HTML parser ships with the app, and the blocks are flat.
 */
export function parseBing(html: string): ParsedPage {
  const results: SearchHit[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<li\b[^>]*\bclass="b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = m[1];
    const link = /<h2[^>]*>\s*<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = resolveBingUrl(decodeEntities(link[1]));
    const title = inlineText(link[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet: snippetOf(block) });
  }
  if (results.length) return { state: 'ok', results };
  // the result list is there and says nothing matched (`b_no`), or just has no organic entry
  if (/\bid="b_results"/i.test(html) && !looksLikeWall(html)) return { state: 'empty', results };
  return { state: 'blocked', results };
}

/** A challenge instead of a result page (Bing serves these to clients it takes for bots). */
function looksLikeWall(html: string): boolean {
  return /\b(b_captcha|captcha-container|cf-turnstile|challenge-form)\b/i.test(html) || /One last step|verify you are (a )?human|请完成以下验证|最后一步/i.test(html);
}

function snippetOf(block: string): string {
  const clamp = /<p\b[^>]*\bclass="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
  if (clamp) return inlineText(clamp[1]);
  const caption = /<div\b[^>]*\bclass="b_caption[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
  if (caption) return inlineText(caption[1]);
  const any = /<div\b[^>]*\bclass="b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
  return any ? inlineText(any[1]) : '';
}

/**
 * The real target of a Bing result link. Bing wraps them: `https://www.bing.com/ck/a?…&u=a1<base64url of the URL>&…`
 * (`a1` = the scheme marker). Null for Bing's own pages and for anything that is not an http(s) address.
 */
export function resolveBingUrl(raw: string): string | null {
  if (!raw || raw.startsWith('/') || raw.startsWith('#')) return null;
  const u = /[?&]u=([A-Za-z0-9_-]+)/.exec(raw)?.[1];
  if (u && u.length > 2 && /^a\d/.test(u)) {
    try {
      const target = httpUrl(Buffer.from(u.slice(2), 'base64url').toString('utf8'));
      if (target) return target;
    } catch { /* not a wrapped link after all */ }
  }
  const direct = httpUrl(raw);
  if (!direct) return null;
  const host = new URL(direct).hostname.toLowerCase();
  return host === 'bing.com' || host.endsWith('.bing.com') ? null : direct;
}
