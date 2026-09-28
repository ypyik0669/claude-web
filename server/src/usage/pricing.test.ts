import { describe, expect, it } from 'vitest';
import { markUnknownCost, trustsCliCost } from './pricing.js';

const result = (models: string[], cost = 1.5) => ({ type: 'result', total_cost_usd: cost, modelUsage: Object.fromEntries(models.map((m) => [m, {}])) }) as any;

describe('markUnknownCost (a result message before anyone shows its cost)', () => {
  it('non-Anthropic profiles: ccb\'s Claude-priced number becomes 0 + cost_unknown', () => {
    for (const t of ['openai', 'gemini', 'grok'] as const) {
      const m = markUnknownCost(result(['deepseek-v4']), t);
      expect(m).toMatchObject({ total_cost_usd: 0, cost_unknown: true });
    }
  });
  it('any non-Claude model in the turn (a gateway profile serving gpt-*) is unknown too', () => {
    expect(markUnknownCost(result(['claude-haiku-4-5', 'gpt-5.6']), 'gateway')).toMatchObject({ total_cost_usd: 0, cost_unknown: true });
  });
  it('Claude models on the account / Anthropic / gateway profiles keep their cost', () => {
    expect(markUnknownCost(result(['claude-opus-4-5']), undefined)).toMatchObject({ total_cost_usd: 1.5 });
    expect(markUnknownCost(result(['claude-opus-4-5']), undefined).cost_unknown).toBeUndefined();
    expect(markUnknownCost(result(['claude-opus-4-5', 'claude-haiku-4-5']), 'anthropic').total_cost_usd).toBe(1.5);
    expect(markUnknownCost(result(['claude-opus-4-5']), 'gateway').total_cost_usd).toBe(1.5);
  });
  it('other messages pass untouched', () => {
    const a = { type: 'assistant', message: {} };
    expect(markUnknownCost(a as any, 'openai')).toBe(a);
  });
  it('trustsCliCost', () => {
    expect(trustsCliCost('openai', 'claude-opus-4-5')).toBe(false);
    expect(trustsCliCost(undefined, 'gpt-5')).toBe(false);
    expect(trustsCliCost(undefined, '')).toBe(true);
  });
});
