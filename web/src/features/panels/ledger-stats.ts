import type { LedgerEntry } from '@shared';
import { hitRate } from '@/model/tokens';
import { tr } from '@/i18n';

/** Share of the prompt served from cache: cacheRead / (uncached input + cacheRead + cacheWrite). */
export { hitRate };

export type LedgerSource = 'all' | 'session';

/** Rows of one ledger source: every row is a conversation's turn. */
export function pickRows(rows: LedgerEntry[], _source: LedgerSource): { rows: LedgerEntry[]; dropped: number } {
  return { rows, dropped: 0 };
}

/** Display name of the profile a row ran on: no id = the Claude account; an id no longer in the list = a deleted profile. */
export function profileName(providers: readonly { id: string; name: string }[], id?: string): string {
  if (!id) return tr('Claude 账号');
  return providers.find((p) => p.id === id)?.name ?? tr('已删除的供应商');
}

export interface HitRow { provider: string; model: string; calls: number; input: number; cacheRead: number; cacheWrite: number; hit: number }

/**
 * Cache hit rate per (provider profile × model); rows without any prompt tokens (API retries, failed calls) say
 * nothing about caching.
 */
export function hitRates(rows: LedgerEntry[], providerName: (id?: string) => string): HitRow[] {
  const m = new Map<string, HitRow>();
  for (const r of rows) {
    if (!r.input && !r.cacheRead && !r.cacheWrite) continue;
    const provider = providerName(r.providerId);
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
