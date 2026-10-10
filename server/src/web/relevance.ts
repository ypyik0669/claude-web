import type { SearchHit } from './engines/types.js';

/**
 * Do these results answer the query that was asked? Bing's HTML page, fetched by a program, often does not: measured
 * 2026-10-10 from this app, without a market parameter it returned pages about something else entirely (a query
 * about a test library → a help page about cloud storage), and with one it frequently matched only the first word
 * ("sqlite fts5 trigram tokenizer chinese" → the SQLite home page, ten times) — HTTP 200, a normal-looking result
 * list, no challenge page to detect. A model handed that takes it for the state of the web.
 *
 * So the results are checked against the words of the query, lexically (no model, no network):
 *   `unrelated` — none of the query's words occurs in any title / snippet / address;
 *   `weak`      — a query of three or more words, and the results know at most one of them;
 *   `ok`        — anything else (including a query with no usable words: it cannot be judged).
 * Deliberately lenient: a real result list repeats the query's words all over; this only has to catch a list that
 * does not.
 */
export type Relevance = 'ok' | 'weak' | 'unrelated';

const STOP = new Set(['the', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was', 'be', 'how', 'what', 'why', 'when', 'where', 'which', 'who', 'with', 'my', 'do', 'does', 'did', 'it', 'as', 'at', 'by', 'from', 'vs', 'not', 'can', 'you', 'your', 'this', 'that', 'into', 'about']);

/** Han ideographs and kana: text without spaces between words. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;

/** The words a result list should know: Latin words and numbers as written, CJK runs as overlapping pairs. */
export function queryTokens(query: string): string[] {
  const out = new Set<string>();
  // search operators are not words: `site:github.com "exact phrase" -minus`
  const q = query.toLowerCase().replace(/\b(site|inurl|intitle|filetype|lang):/g, ' ').replace(/["“”'()[\]{}|]/g, ' ');
  for (const m of q.matchAll(/[a-z0-9][a-z0-9._+#-]*/g)) {
    const w = m[0].replace(/[._+#-]+$/, '');
    if (w.length >= 2 && !STOP.has(w)) out.add(w);
  }
  let run = '';
  const flush = () => {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
    run = '';
  };
  for (const ch of q) { if (CJK.test(ch)) run += ch; else flush(); }
  flush();
  return [...out];
}

/** How many of `tokens` occur anywhere in the results. */
export function coverage(tokens: string[], hits: SearchHit[]): number {
  if (!tokens.length || !hits.length) return 0;
  const hay = hits.map((h) => `${h.title} ${h.snippet} ${safeDecode(h.url)}`).join('\n').toLowerCase();
  return tokens.filter((t) => hay.includes(t)).length;
}

export function relevance(query: string, hits: SearchHit[]): Relevance {
  const tokens = queryTokens(query);
  if (!tokens.length || !hits.length) return 'ok';
  const covered = coverage(tokens, hits);
  if (covered === 0) return 'unrelated';
  return tokens.length >= 3 && covered < 2 ? 'weak' : 'ok';
}

/** An address as it reads (`%E4%B8%AD` → the character): a CJK word in a URL counts. */
function safeDecode(url: string): string {
  try { return decodeURIComponent(url); } catch { return url; }
}
