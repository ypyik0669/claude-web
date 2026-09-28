import { describe, expect, it } from 'vitest';
import { byTokens, fmtCost, sumCosts } from './cost';

describe('cost display: unknown is never $0', () => {
  it('fmtCost', () => {
    expect(fmtCost(1.5)).toBe('$1.50');
    expect(fmtCost(0)).toBe('$0');
    expect(fmtCost(0, true)).toBe('费用未知');
    expect(fmtCost(0, 3)).toBe('费用未知');
    // part known, part unknown: the known part is a lower bound
    expect(fmtCost(1.5, 2)).toBe('≥ $1.50');
    expect(fmtCost(1.5, 0)).toBe('$1.50');
  });
  it('sumCosts counts unknown results instead of adding zeros', () => {
    const items = [
      { kind: 'result', costUsd: 0.25 },
      { kind: 'result', costUsd: 0, costUnknown: true },
      { kind: 'user' },
      { kind: 'result', costUsd: 0.5 },
    ];
    expect(sumCosts(items)).toEqual({ cost: 0.75, unknown: 1 });
    expect(sumCosts([])).toEqual({ cost: 0, unknown: 0 });
  });
  it('byTokens: rows with an unknown cost are not pushed to the bottom', () => {
    const rows: [string, { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }][] = [
      ['claude', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, costUsd: 5 }],
      ['deepseek', { input: 1000, output: 100, cacheRead: 5000, cacheWrite: 0, costUsd: 0 }],
    ];
    expect(rows.sort(byTokens).map(([k]) => k)).toEqual(['deepseek', 'claude']);
  });
});
