import { describe, expect, it } from 'vitest';
import { markUnknownCost, trustsCliCost } from './pricing.js';

const result = (models: string[], cost = 1.5) => ({ type: 'result', total_cost_usd: cost, modelUsage: Object.fromEntries(models.map((m) => [m, {}])) }) as any;

describe('markUnknownCost (a result message before anyone shows its cost)', () => {
  it('a non-Claude model in the turn (a relay serving deepseek-*) is unknown', () => {
    expect(markUnknownCost(result(['deepseek-v4']), 'anthropic')).toMatchObject({ total_cost_usd: 0, cost_unknown: true });
    expect(markUnknownCost(result(['claude-haiku-4-5', 'gpt-5.6']), 'anthropic')).toMatchObject({ total_cost_usd: 0, cost_unknown: true });
  });
  it('Claude models on the account / Anthropic profiles / another account keep their cost', () => {
    expect(markUnknownCost(result(['claude-opus-4-5']), undefined)).toMatchObject({ total_cost_usd: 1.5 });
    expect(markUnknownCost(result(['claude-opus-4-5']), undefined).cost_unknown).toBeUndefined();
    expect(markUnknownCost(result(['claude-opus-4-5', 'claude-haiku-4-5']), 'anthropic').total_cost_usd).toBe(1.5);
    expect(markUnknownCost(result(['claude-opus-4-5']), 'claude-account').total_cost_usd).toBe(1.5);
  });
  it('other messages pass untouched', () => {
    const a = { type: 'assistant', message: {} };
    expect(markUnknownCost(a as any, 'anthropic')).toBe(a);
  });
  it('trustsCliCost', () => {
    expect(trustsCliCost('anthropic', 'claude-opus-4-5')).toBe(true);
    expect(trustsCliCost('anthropic', 'deepseek-v4')).toBe(false);
    expect(trustsCliCost(undefined, 'gpt-5')).toBe(false);
    expect(trustsCliCost(undefined, '')).toBe(true);
  });
});
