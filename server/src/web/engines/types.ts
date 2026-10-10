export interface SearchHit { title: string; url: string; snippet: string }

/**
 * What a result page turned out to be. `blocked`: the engine answered, but not with results — a CAPTCHA, a
 * script-rendered shell, a "bots use this too" page — so `auto` moves on to the next engine. `empty`: a real page
 * that says nothing matched.
 */
export interface ParsedPage { state: 'ok' | 'empty' | 'blocked'; results: SearchHit[] }

/** Only http(s) results are worth handing to an agent (a `javascript:` or relative link is not a place to go). */
export function httpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}
