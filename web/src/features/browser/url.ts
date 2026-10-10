// The built-in browser's address field and its list of recent sites (structure round 2, spec §4). Pure.

/** Words typed into the address field are searched here (reachable without a proxy from most places). */
export const SEARCH_URL = 'https://www.bing.com/search?q=';

/**
 * What was typed into the address field, as an address: an address stays one; `localhost:3000`, `:3000` and an IP are
 * this machine or the LAN (http); a bare domain gets https; anything else is words to search for.
 */
export function addressToUrl(input: string): string {
  const t = input.trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(about:blank|file:\/\/)/i.test(t)) return t;
  if (/^:\d{2,5}(\/|$)/.test(t)) return `http://localhost${t}`;
  if (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t) || /^\[[0-9a-f:]+\](:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|\?|#|$)/.test(t)) return `https://${t}`;
  return `${SEARCH_URL}${encodeURIComponent(t)}`;
}

/** `github.com` for `https://www.github.com/a/b` — a tab's fallback title, a recent site's name. */
export function siteOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./i, '') || url;
  } catch { return url; }
}

/** One letter to stand for a site (its tile in the recent list, a tab with no title yet). */
export function siteLetter(url: string): string {
  const s = siteOf(url).replace(/^(localhost|127\.0\.0\.1)(:\d+)?$/, 'L');
  const ch = Array.from(s)[0] ?? '?';
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}

/** A steady hue per site, so the same site's tile is the same colour every time. */
export function siteHue(url: string): number {
  const s = siteOf(url);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Whether the address is one the page can be asked to load (never `javascript:` and the like). */
export function loadable(url: string): boolean {
  return /^(https?:\/\/|about:blank$)/i.test(url.trim());
}

/**
 * The sandbox of the web version's iframe. A page of another origin keeps its own origin (its cookies and storage
 * work). A document that would share OURS does not — the app's own address, or about:blank, which inherits it: with
 * scripts and our origin together it could reach into the app around it (Chromium warns about exactly this pair).
 */
export function frameSandbox(url: string, own: string): string {
  let origin: string | null = null;
  try {
    const u = new URL(url.trim());
    origin = /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch { origin = null; }
  return origin && origin !== own ? 'allow-scripts allow-same-origin allow-forms allow-popups' : 'allow-scripts allow-forms allow-popups';
}

export interface RecentSite { url: string; title: string; at: number }
export const RECENT_KEY = 'ui.browser.recent';
export const MAX_RECENT = 12;

export function readRecent(v: unknown): RecentSite[] {
  if (!Array.isArray(v)) return [];
  const out: RecentSite[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    if (typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) continue;
    out.push({ url: r.url.slice(0, 2000), title: typeof r.title === 'string' ? r.title.slice(0, 200) : '', at: typeof r.at === 'number' ? r.at : 0 });
  }
  return out.slice(0, MAX_RECENT);
}

/**
 * A page was visited: it goes to the front; one entry per site (the last page seen there), searches are not sites.
 * Null: nothing to record (not a web page, or the list would not change).
 */
export function pushRecent(list: RecentSite[], visit: RecentSite): RecentSite[] | null {
  if (!/^https?:\/\//i.test(visit.url) || visit.url.startsWith(SEARCH_URL)) return null;
  const site = siteOf(visit.url);
  const first = list[0];
  if (first && first.url === visit.url && first.title === visit.title) return null;
  return [visit, ...list.filter((r) => siteOf(r.url) !== site)].slice(0, MAX_RECENT);
}
