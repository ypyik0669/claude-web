/**
 * A Claude result's `total_cost_usd` and `modelUsage` are the RUNNING totals of the CLI process ("read the latest result
 * rather than summing across results", sdk.d.ts), while `usage` is the turn's own. Everything downstream — the
 * conversation's cost, the ledger, goals, IM, orchestra — adds results up per turn, so a $2.42 conversation showed
 * $17.42 and every ledger row named the first model of the conversation (2026-10-01, real relays).
 *
 * `turnShare` rewrites a result in place to its own turn's share and keeps the process total in `session_cost_usd`.
 * A total that went DOWN started over (a respawned process, /clear): the new total is the turn's share. A zeroed
 * result (forced stop, crash, startup error) leaves the running totals alone.
 */
export interface RunningTotals {
  cost: number;
  models: Record<string, Record<string, number>>;
}

const NUMERIC = ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'costUSD'] as const;

export function turnShare<T extends { type?: string; total_cost_usd?: number; modelUsage?: Record<string, any>; session_cost_usd?: number }>(m: T, totals: RunningTotals): T {
  if (m.type !== 'result') return m;
  const cost = Number(m.total_cost_usd ?? 0);
  const usage = m.modelUsage ?? {};
  if (!cost && !Object.keys(usage).length) return m; // zeroed: nothing to learn, nothing to subtract
  const restarted = cost < totals.cost - 1e-9;
  m.session_cost_usd = cost;
  m.total_cost_usd = restarted ? cost : Math.max(0, cost - totals.cost);
  const share: Record<string, any> = {};
  const next: RunningTotals['models'] = {};
  for (const [model, u] of Object.entries(usage)) {
    const prev = restarted ? undefined : totals.models[model];
    const d: Record<string, any> = { ...u };
    let grew = false;
    for (const k of NUMERIC) {
      if (typeof u?.[k] !== 'number') continue;
      d[k] = prev && u[k] >= (prev[k] ?? 0) ? u[k] - (prev[k] ?? 0) : u[k];
      if (d[k] > 0) grew = true;
    }
    next[model] = Object.fromEntries(NUMERIC.filter((k) => typeof u?.[k] === 'number').map((k) => [k, u[k]]));
    if (grew) share[model] = d;
  }
  m.modelUsage = share;
  totals.cost = cost;
  totals.models = restarted ? next : { ...totals.models, ...next };
  return m;
}
