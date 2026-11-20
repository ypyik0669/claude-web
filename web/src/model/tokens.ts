import { tr } from '@/i18n';
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
/** How long a provider keeps a prompt cache by default (Anthropic's 5 minutes). */
export const CACHE_TTL_MS = 5 * 60_000;

/** 「12 分钟」「2 小时 5 分」 */
function gapText(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 60 ? tr('{m} 分钟', { m }) : tr('{h} 小时 {m} 分', { h: Math.floor(m / 60), m: m % 60 });
}

/**
 * Why a big turn read almost nothing from the cache, when it can be told: the conversation sat longer than the cache
 * lives (2026-10-14, a user's friend: 「缓存都是0%，这是出啥问题了吗」 — turns of 211K at full price after a pause).
 */
export function coldCache(usage: unknown, idleMs: number | undefined): { text: string; title: string } | null {
  const u = sdkInput(usage);
  if (!u || !u.cacheKnown || !idleMs || idleMs <= CACHE_TTL_MS) return null;
  const all = inputTotal(u);
  if (all < 20_000 || hitRate(u) >= 0.05) return null;
  const gap = gapText(idleMs);
  return {
    text: tr('隔了 {gap}，缓存已过期', { gap }),
    title: tr('距上一轮结束 {gap}，超过了提示缓存的有效期（一般 5 分钟），这一轮把整段上下文按全价重新读了一遍。常常隔很久才回来的话，可以在 设置 → 模型 → 来源 → 编辑 里打开「1 小时提示缓存」（官方运行内核或经模型网关时有效；写入贵一些，一小时内都能命中）。', { gap }),
  };
}

export function usageParts(usage: unknown, fmt: (n: number) => string): { text: string; title?: string }[] {
  const u = sdkInput(usage);
  if (!u) return [];
  const all = inputTotal(u);
  const breakdown = tr('输入 {all}：从缓存读 {cacheRead} · 写进缓存 {cacheWrite} · 没走缓存 {input}', { all: fmt(all), cacheRead: fmt(u.cacheRead), cacheWrite: fmt(u.cacheWrite), input: fmt(u.input) });
  const out: { text: string; title?: string }[] = [{ text: `↑${fmt(all)} ↓${fmt(u.output)}`, title: tr("{breakdown}\n输出 {output}", { breakdown, output: fmt(u.output) }) }];
  if (all > 0 && u.cacheKnown) {
    out.push({ text: tr('缓存 {pct}', { pct: pct(hitRate(u)) }), title: tr("缓存命中：这一轮的输入有 {pct} 是从缓存读的（按便宜得多的价格算）\n{breakdown}", { pct: pct(hitRate(u)), breakdown }) });
  }
  return out;
}
