import { fmtMs, fmtTok } from '@/util';
import { fmtCost, sumCosts } from '@/model/cost';
import { hitRate, pct } from '@/model/tokens';

/**
 * The composer's old stats bar (「1 轮 ↑253K ↓1.8K 缓存 100%」) — spec §4.2: the context ring in the composer's
 * bottom-right corner, the numbers on hover. Pure.
 */

/** `inp` = uncached input, `cache` = read from the cache, `write` = written to the cache. */
export interface Totals { turns: number; inp: number; out: number; cache: number; write: number; cost: number; costUnknown: number }

type Item = { kind: string; meta?: unknown; usage?: unknown; costUsd?: number; costUnknown?: boolean };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite?: number };

export function sessionTotals(items: readonly Item[]): Totals {
  let inp = 0, out = 0, cache = 0, write = 0, turns = 0;
  for (const it of items) {
    if (it.kind === 'assistant' && it.usage) { const u = it.usage as Usage; inp += u.input; out += u.output; cache += u.cacheRead; write += u.cacheWrite ?? 0; }
    if (it.kind === 'user' && !it.meta) turns++;
  }
  const { cost, unknown } = sumCosts(items);
  return { turns, inp, out, cache, write, cost, costUnknown: unknown };
}

export type RingLevel = 'quiet' | 'note' | 'strong' | 'err';

/**
 * null = no occupancy reported (ACP agents…): no ring at all — an empty circle reads as a radio button or a spinner.
 * quiet < 60 % (a faint ring), note ≥ 60 % (the spec's threshold: the percentage shows), strong ≥ 80 % (ink, bold),
 * err ≥ 95 %. No yellow: spec §6.4 keeps it for 「需要你」.
 */
export function ringLevel(pct: number | undefined): RingLevel | null {
  if (pct === undefined || !Number.isFinite(pct)) return null;
  if (pct < 60) return 'quiet';
  return pct >= 95 ? 'err' : pct >= 80 ? 'strong' : 'note';
}

/**
 * What sits in the composer's corner: the ring, only once the context is filling up (≥ 60 %, spec §5.4) — on a
 * desktop as on a phone (final review I3: the always-on ring / unlabelled stats icon was one control too many on the
 * default page). The numbers of the old stats bar are always reachable: the header's ··· 「本对话用量」 opens the
 * same card here.
 */
export function meterMode(pct: number | undefined): 'ring' | null {
  const level = ringLevel(pct);
  return level !== null && level !== 'quiet' ? 'ring' : null;
}

export function usageLines(t: Totals, o: { lastMs?: number; context?: { percentage: number; totalTokens: number; maxTokens: number; model?: string }; tasks?: number }): [string, string][] {
  const lines: [string, string][] = [
    ['轮数', String(t.turns)],
    ['输入 / 输出', `↑${fmtTok(t.inp + t.cache + t.write)} ↓${fmtTok(t.out)}`],
  ];
  // same formula as the line under each answer and the ledger (cache writes count as input)
  if (t.cache > 0) lines.push(['缓存命中', pct(hitRate({ input: t.inp, cacheRead: t.cache, cacheWrite: t.write }))]);
  if (t.cost > 0 || t.costUnknown > 0) lines.push(['费用', fmtCost(t.cost, t.costUnknown)]);
  if (o.lastMs) lines.push(['上一轮用时', fmtMs(o.lastMs)]);
  if (o.context) lines.push(['上下文', `${o.context.percentage}% · ${fmtTok(o.context.totalTokens)} / ${fmtTok(o.context.maxTokens)}`]);
  if (o.tasks) lines.push(['后台任务', `${o.tasks} 个运行中`]);
  return lines;
}
