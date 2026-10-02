import { describe, expect, it } from 'vitest';
import { turnShare, type RunningTotals } from './turn-cost.js';

const result = (cost: number, models: Record<string, { in: number; out: number; usd: number }>) => ({
  type: 'result',
  total_cost_usd: cost,
  modelUsage: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, { inputTokens: v.in, outputTokens: v.out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: v.usd, contextWindow: 200_000, maxOutputTokens: 32_000 }])),
}) as any;

describe('turnShare: a result becomes its own turn’s share of the CLI’s running totals', () => {
  it('the series from a real conversation that switched models every turn adds up to the last total, not to the sum', () => {
    const t: RunningTotals = { cost: 0, models: {} };
    const a = turnShare(result(0.416245, { 'claude-fable-5': { in: 10, out: 5, usd: 0.416245 } }), t);
    const b = turnShare(result(0.8382025, { 'claude-fable-5': { in: 10, out: 5, usd: 0.416245 }, 'claude-opus-5': { in: 20, out: 7, usd: 0.4219575 } }), t);
    const c = turnShare(result(0.87421375, { 'claude-fable-5': { in: 10, out: 5, usd: 0.416245 }, 'claude-opus-5': { in: 20, out: 7, usd: 0.4219575 }, 'claude-haiku-4-5-20251001': { in: 30, out: 2, usd: 0.03601125 } }), t);
    expect(a.total_cost_usd).toBeCloseTo(0.416245, 9);
    expect(b.total_cost_usd).toBeCloseTo(0.4219575, 9);
    expect(c.total_cost_usd).toBeCloseTo(0.03601125, 9);
    expect(a.total_cost_usd + b.total_cost_usd + c.total_cost_usd).toBeCloseTo(0.87421375, 9);
    expect(c.session_cost_usd).toBeCloseTo(0.87421375, 9);
    // the ledger names a row by its first modelUsage key: only the model that ran this turn is left
    expect(Object.keys(b.modelUsage)).toEqual(['claude-opus-5']);
    expect(Object.keys(c.modelUsage)).toEqual(['claude-haiku-4-5-20251001']);
    expect(c.modelUsage['claude-haiku-4-5-20251001']).toMatchObject({ inputTokens: 30, outputTokens: 2, contextWindow: 200_000 });
  });

  it('a failed turn that cost nothing is $0 with no model', () => {
    const t: RunningTotals = { cost: 0, models: {} };
    turnShare(result(0.5, { m: { in: 1, out: 1, usd: 0.5 } }), t);
    const failed = turnShare({ ...result(0.5, { m: { in: 1, out: 1, usd: 0.5 } }), is_error: true }, t);
    expect(failed.total_cost_usd).toBe(0);
    expect(failed.modelUsage).toEqual({});
  });

  it('a total that went down started over (respawned process, /clear): that total is the turn', () => {
    const t: RunningTotals = { cost: 0, models: {} };
    turnShare(result(2, { m: { in: 100, out: 10, usd: 2 } }), t);
    const fresh = turnShare(result(0.3, { m: { in: 15, out: 2, usd: 0.3 } }), t);
    expect(fresh.total_cost_usd).toBeCloseTo(0.3, 9);
    expect(fresh.modelUsage.m).toMatchObject({ inputTokens: 15, costUSD: 0.3 });
    const next = turnShare(result(0.5, { m: { in: 25, out: 3, usd: 0.5 } }), t);
    expect(next.total_cost_usd).toBeCloseTo(0.2, 9);
    expect(next.modelUsage.m).toMatchObject({ inputTokens: 10, outputTokens: 1 });
  });

  it('a zeroed result (forced stop, startup error) leaves the running totals alone', () => {
    const t: RunningTotals = { cost: 0, models: {} };
    turnShare(result(1, { m: { in: 10, out: 1, usd: 1 } }), t);
    const zero = turnShare({ type: 'result', total_cost_usd: 0, modelUsage: {} } as any, t);
    expect(zero.total_cost_usd).toBe(0);
    expect(turnShare(result(1.25, { m: { in: 12, out: 2, usd: 1.25 } }), t).total_cost_usd).toBeCloseTo(0.25, 9);
  });

  it('not a result: untouched', () => {
    const m = { type: 'assistant', total_cost_usd: 3 } as any;
    expect(turnShare(m, { cost: 1, models: {} }).total_cost_usd).toBe(3);
  });
});
