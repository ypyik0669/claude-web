import { describe, expect, it } from 'vitest';
import { LedgerService } from './ledger.js';
import type { LedgerEntry, ProviderType } from '../protocol.js';

const types: Record<string, ProviderType> = { gem: 'gemini', oai: 'openai', grk: 'grok', ant: 'anthropic', gw: 'gateway' };
function ledger() {
  const l = new LedgerService((id) => types[id]);
  const rows: LedgerEntry[] = [];
  l.record = (e) => { rows.push(e); };
  return { l, rows };
}
const result = (model: string, u: Record<string, number>, cost = 1.23) => ({ type: 'result', is_error: false, duration_ms: 10, total_cost_usd: cost, num_turns: 1, usage: u, modelUsage: { [model]: {} } });

describe('LedgerService.observe', () => {
  it('Gemini-type (ccb) sessions: input_tokens already holds the cached part — counted once', () => {
    const { l, rows } = ledger();
    l.observe('s', result('gemini-2.5-pro', { input_tokens: 20_000, output_tokens: 10, cache_read_input_tokens: 15_000 }), 'gem');
    expect(rows[0]).toMatchObject({ input: 5_000, cacheRead: 15_000, output: 10 });
  });
  it('other types keep input as reported (ccb subtracts the hit itself)', () => {
    const { l, rows } = ledger();
    l.observe('s', result('deepseek-v4', { input_tokens: 5_000, output_tokens: 10, cache_read_input_tokens: 15_000 }), 'oai');
    l.observe('s', result('claude-sonnet-4-5', { input_tokens: 5_000, output_tokens: 10, cache_read_input_tokens: 15_000 }), 'ant');
    expect(rows.map((r) => r.input)).toEqual([5_000, 5_000]);
  });
  it('ccb\'s Claude-priced cost is dropped for non-Anthropic profiles and non-Claude models', () => {
    const { l, rows } = ledger();
    l.observe('s', result('deepseek-v4', { input_tokens: 1, output_tokens: 1 }), 'oai');
    l.observe('s', result('grok-4', { input_tokens: 1, output_tokens: 1 }), 'grk');
    l.observe('s', result('gemini-2.5-pro', { input_tokens: 1, output_tokens: 1 }), 'gem');
    l.observe('s', result('gpt-5.6', { input_tokens: 1, output_tokens: 1 }), 'gw'); // a gateway profile that reports a GPT model
    l.observe('s', result('claude-opus-4-5', { input_tokens: 1, output_tokens: 1 }), 'ant');
    l.observe('s', result('claude-opus-4-5', { input_tokens: 1, output_tokens: 1 }));
    expect(rows.map((r) => r.costUsd)).toEqual([0, 0, 0, 0, 1.23, 1.23]);
  });
  it('cache writes are recorded', () => {
    const { l, rows } = ledger();
    l.observe('s', result('claude-opus-4-5', { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 7 }));
    expect(rows[0]).toMatchObject({ input: 3, cacheRead: 10, cacheWrite: 7 });
  });
});
