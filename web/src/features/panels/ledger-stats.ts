import type { LedgerEntry } from '@shared';
import { hitRate } from '@/model/tokens';

/** Share of the prompt served from cache: cacheRead / (uncached input + cacheRead + cacheWrite). */
export { hitRate };

export type LedgerSource = 'all' | 'session' | 'gateway';

/**
 * Rows of one ledger source. A session through the model gateway or the cache shim has both its own `result`
 * rows (per turn) and gateway rows (per call) for the same traffic, so 「全部」 drops the gateway / shim rows of
 * any session whose own rows are in the list; gateway rows of other clients (or sessions outside the window) stay.
 */
export function pickRows(rows: LedgerEntry[], source: LedgerSource): { rows: LedgerEntry[]; dropped: number } {
  if (source === 'session') return { rows: rows.filter((r) => r.kind !== 'gateway'), dropped: 0 };
  if (source === 'gateway') return { rows: rows.filter((r) => r.kind === 'gateway'), dropped: 0 };
  const sessions = new Set(rows.filter((r) => r.kind !== 'gateway' && r.sessionId).map((r) => r.sessionId));
  const out = rows.filter((r) => r.kind !== 'gateway' || !r.sessionId || !sessions.has(r.sessionId));
  return { rows: out, dropped: rows.length - out.length };
}

/** Display name of the profile a row ran on: no id = the Claude account; an id no longer in the list = a deleted profile. */
export function profileName(providers: readonly { id: string; name: string }[], id?: string): string {
  if (!id) return 'Claude 账号';
  return providers.find((p) => p.id === id)?.name ?? '已删除的供应商';
}

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
