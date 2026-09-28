import type { LedgerEntry } from '@shared';

/** Share of the prompt served from cache: cacheRead / (uncached input + cacheRead + cacheWrite). */
export const hitRate = (b: { input: number; cacheRead: number; cacheWrite: number }) => {
  const all = b.input + b.cacheRead + b.cacheWrite;
  return all ? b.cacheRead / all : 0;
};

export interface HitRow { provider: string; model: string; calls: number; input: number; cacheRead: number; cacheWrite: number; hit: number }

/**
 * Cache hit rate per (provider profile × model). Gateway / cache-shim rows count under the member that
 * answered; rows without any prompt tokens (API retries, failed calls) say nothing about caching.
 */
export function hitRates(rows: LedgerEntry[], providerName: (id?: string) => string): HitRow[] {
  const m = new Map<string, HitRow>();
  for (const r of rows) {
    if (!r.input && !r.cacheRead && !r.cacheWrite) continue;
    const provider = r.gateway?.member ?? providerName(r.gateway?.memberId ?? r.providerId);
    const model = r.model || '-';
    const k = `${provider}\u0000${model}`;
    const h = m.get(k) ?? m.set(k, { provider, model, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, hit: 0 }).get(k)!;
    h.calls++;
    h.input += r.input;
    h.cacheRead += r.cacheRead;
    h.cacheWrite += r.cacheWrite;
  }
  const out = [...m.values()];
  for (const h of out) h.hit = hitRate(h);
  return out.sort((a, b) => b.input + b.cacheRead + b.cacheWrite - (a.input + a.cacheRead + a.cacheWrite));
}
