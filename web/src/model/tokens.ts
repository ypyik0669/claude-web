/** Input tokens as the APIs count them apart: uncached, read from the cache, written to the cache. */
export interface InputTokens { input: number; cacheRead: number; cacheWrite: number }

/** Everything the model read as input. */
export const inputTotal = (u: InputTokens) => u.input + u.cacheRead + u.cacheWrite;

/**
 * Share of the input served from the cache — one formula for the ledger, the 本对话用量 card and the line under each
 * answer (the card used to leave cache writes out and read higher than the ledger for the same conversation).
 */
export const hitRate = (u: InputTokens) => {
  const all = inputTotal(u);
  return all ? u.cacheRead / all : 0;
};

export const pct = (r: number) => `${Math.round(r * 100)}%`;

/** An SDK `usage` object (a turn's result) as InputTokens; null when it is not one. */
export function sdkInput(u: unknown): (InputTokens & { output: number; cacheKnown: boolean }) | null {
  if (!u || typeof u !== 'object') return null;
  const x = u as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input: n(x.input_tokens),
    cacheRead: n(x.cache_read_input_tokens),
    cacheWrite: n(x.cache_creation_input_tokens),
    output: n(x.output_tokens),
    // an endpoint that reports no cache fields at all: no rate (0 % would claim the cache missed)
    cacheKnown: 'cache_read_input_tokens' in x || 'cache_creation_input_tokens' in x,
  };
}

/**
 * The token part of the line under an answer: 「↑12K ↓1.2K」 (all the input, cache reads and writes included — the
 * old line left the writes out) and 「缓存 93%」, each with a tooltip that breaks the input down.
 */
export function usageParts(usage: unknown, fmt: (n: number) => string): { text: string; title?: string }[] {
  const u = sdkInput(usage);
  if (!u) return [];
  const all = inputTotal(u);
  const breakdown = `输入 ${fmt(all)}：从缓存读 ${fmt(u.cacheRead)} · 写进缓存 ${fmt(u.cacheWrite)} · 没走缓存 ${fmt(u.input)}`;
  const out: { text: string; title?: string }[] = [{ text: `↑${fmt(all)} ↓${fmt(u.output)}`, title: `${breakdown}\n输出 ${fmt(u.output)}` }];
  if (all > 0 && u.cacheKnown) {
    out.push({ text: `缓存 ${pct(hitRate(u))}`, title: `缓存命中：这一轮的输入有 ${pct(hitRate(u))} 是从缓存读的（按便宜得多的价格算）\n${breakdown}` });
  }
  return out;
}
