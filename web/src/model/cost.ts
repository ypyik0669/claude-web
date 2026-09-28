import { fmtUsd } from '@/util';

/**
 * Cost of a turn / a bucket. Only Claude models on Claude-type profiles have a real price (server: usage/pricing.ts);
 * everything else reaches us as `costUsd: 0` + `costUnknown` — show 「费用未知」, never `$0`.
 * `unknown`: a flag, or how many of the summed calls had no price (then the known part is a lower bound).
 */
export function fmtCost(usd: number | undefined, unknown?: boolean | number): string {
  const n = typeof unknown === 'number' ? unknown : unknown ? 1 : 0;
  if (!n) return fmtUsd(usd);
  return usd ? `≥ ${fmtUsd(usd)}` : '费用未知';
}

/** Sum of the result items' cost; results with an unknown price are counted, not added as zeros. */
export function sumCosts(items: readonly { kind: string; costUsd?: number; costUnknown?: boolean }[]): { cost: number; unknown: number } {
  let cost = 0;
  let unknown = 0;
  for (const it of items) {
    if (it.kind !== 'result') continue;
    if (it.costUnknown) unknown++;
    else cost += it.costUsd ?? 0;
  }
  return { cost, unknown };
}

type Tok = { input: number; output: number; cacheRead: number; cacheWrite: number };
const tokens = (b: Tok) => b.input + b.output + b.cacheRead + b.cacheWrite;
/** Sort usage buckets by tokens: sorting by cost sinks every model whose price is unknown. */
export const byTokens = (a: [string, Tok], b: [string, Tok]) => tokens(b[1]) - tokens(a[1]);
export const tokensOf = tokens;
