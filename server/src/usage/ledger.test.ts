import { describe, expect, it } from 'vitest';
import { LedgerService } from './ledger.js';
import type { LedgerEntry, ProviderType } from '../protocol.js';

const types: Record<string, ProviderType> = { oai: 'anthropic', ant: 'anthropic', acct: 'claude-account' };
function ledger() {
  const l = new LedgerService((id) => types[id]);
  const rows: LedgerEntry[] = [];
  l.record = (e) => { rows.push(e); };
  return { l, rows };
}
const result = (model: string, u: Record<string, number>, cost = 1.23) => ({ type: 'result', is_error: false, duration_ms: 10, total_cost_usd: cost, num_turns: 1, usage: u, modelUsage: { [model]: {} } });

describe('LedgerService.observe', () => {
  it('input is kept as reported', () => {
    const { l, rows } = ledger();
    l.observe('s', result('deepseek-v4', { input_tokens: 5_000, output_tokens: 10, cache_read_input_tokens: 15_000 }), 'oai');
    l.observe('s', result('claude-sonnet-4-5', { input_tokens: 5_000, output_tokens: 10, cache_read_input_tokens: 15_000 }), 'ant');
    expect(rows.map((r) => r.input)).toEqual([5_000, 5_000]);
  });
  it('the CLI\'s Claude-priced cost is dropped for non-Claude models', () => {
    const { l, rows } = ledger();
    l.observe('s', result('deepseek-v4', { input_tokens: 1, output_tokens: 1 }), 'oai');
    l.observe('s', result('gpt-5.6', { input_tokens: 1, output_tokens: 1 }), 'ant');
    l.observe('s', result('claude-opus-4-5', { input_tokens: 1, output_tokens: 1 }), 'ant');
    l.observe('s', result('claude-opus-4-5', { input_tokens: 1, output_tokens: 1 }), 'acct');
    l.observe('s', result('claude-opus-4-5', { input_tokens: 1, output_tokens: 1 }));
    expect(rows.map((r) => r.costUsd)).toEqual([0, 0, 1.23, 1.23, 1.23]);
    expect(rows.map((r) => !!r.costUnknown)).toEqual([true, true, false, false, false]);
  });
  it('a result already marked cost_unknown (the runner) stays unknown', () => {
    const { l, rows } = ledger();
    l.observe('s', { ...result('claude-opus-4-5', { input_tokens: 1, output_tokens: 1 }, 0), cost_unknown: true });
    expect(rows[0]).toMatchObject({ costUsd: 0, costUnknown: true });
  });
  it('the end-of-turn marker a provider switch emits is not a call: no row', () => {
    const { l, rows } = ledger();
    l.observe('s', { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_swap', total_cost_usd: 0, usage: {}, modelUsage: {} });
    l.observe('s', { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', total_cost_usd: 0.1, usage: { input_tokens: 5 }, modelUsage: { 'claude-opus-4-5': {} } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, model: 'claude-opus-4-5' });
  });
  it('cache writes are recorded', () => {
    const { l, rows } = ledger();
    l.observe('s', result('claude-opus-4-5', { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 7 }));
    expect(rows[0]).toMatchObject({ input: 3, cacheRead: 10, cacheWrite: 7 });
  });
});
