import { describe, expect, it } from 'vitest';
import { contextWindowFor, contextWindowSource, knownContextWindow, listedContext, officialWindow } from './context-window.js';

describe('context windows (provider settings → each engine)', () => {
  it('拉满 by name: Claude 1M (Haiku 200K), GPT 272K, Gemini ~1M; unknown = the engine default', () => {
    expect(knownContextWindow('claude-opus-5-5')).toBe(1_000_000);
    expect(knownContextWindow('anthropic/claude-sonnet-5')).toBe(1_000_000);
    expect(knownContextWindow('opus')).toBe(1_000_000);
    expect(knownContextWindow('claude-haiku-4-5')).toBe(200_000);
    expect(knownContextWindow('gpt-5.6-sol')).toBe(272_000);
    expect(knownContextWindow('gpt-6-astra')).toBe(272_000);
    expect(knownContextWindow('gemini-3-pro')).toBe(1_048_576);
    expect(knownContextWindow('deepseek-chat')).toBe(128_000);
    // V4: what api.deepseek.com's own list says (2026-10-19 — on the 128K guess deepseek-v4.1-flash through a relay
    // compacted every 1.5–2 minutes, the cache hit 26–33%; set to 1M: 201 calls, prompts to 272K, hit 97%)
    expect(knownContextWindow('deepseek-v4.1-flash')).toBe(1_048_576);
    expect(knownContextWindow('DeepSeek-V4.1-Flash')).toBe(1_048_576);
    expect(knownContextWindow('deepseek-v4-pro')).toBe(1_048_576);
    expect(knownContextWindow('deepseek-flash')).toBe(1_048_576);
    expect(knownContextWindow('deepseek/deepseek-v4-flash')).toBe(1_048_576);
    expect(knownContextWindow('deepseek-reasoner')).toBe(128_000);
    expect(knownContextWindow('deepseek-v3.2')).toBe(128_000);
    expect(knownContextWindow('deepseek-prover-v2')).toBe(128_000); // not V4 Pro
    expect(knownContextWindow('some-local-model')).toBeUndefined();
  });

  it('what the user set > what the model list said > the name', () => {
    const p = { contextWindows: { 'gpt-6-astra': 400_000 }, modelContext: { 'gpt-6-astra': 300_000, 'mystery': 64_000 } };
    expect(contextWindowFor(p, 'gpt-6-astra')).toBe(400_000);
    expect(contextWindowSource(p, 'gpt-6-astra')).toBe('set');
    expect(contextWindowFor(p, 'mystery')).toBe(64_000);
    expect(contextWindowSource(p, 'mystery')).toBe('list');
    expect(contextWindowFor(p, 'claude-opus-5-5[1m]')).toBe(1_000_000);
    expect(contextWindowSource(p, 'nothing-known')).toBe('engine');
  });

  it('the official binary: [1m] for a Claude model over 200K, an earlier compaction for anything smaller than it assumes', () => {
    expect(officialWindow(1_000_000, 'claude-opus-5-5')).toEqual({ suffix: true });
    expect(officialWindow(400_000, 'claude-opus-5-5')).toEqual({ suffix: true, compactWindow: 400_000 });
    expect(officialWindow(200_000, 'claude-haiku-4-5')).toEqual({ suffix: false });
    expect(officialWindow(128_000, 'deepseek-chat')).toEqual({ suffix: false, compactWindow: 128_000 });
    expect(officialWindow(1_000_000, 'claude-opus-5-5[1m]')).toEqual({ suffix: false });
    expect(officialWindow(undefined, 'claude-opus-5-5')).toEqual({ suffix: false });
  });

  it('the sizes model lists declare, under their many names', () => {
    expect(listedContext({ id: 'a', context_length: 131072 })).toBe(131072);
    expect(listedContext({ id: 'a', max_input_tokens: 1_000_000 })).toBe(1_000_000);
    expect(listedContext({ name: 'models/gemini', inputTokenLimit: 1048576 })).toBe(1048576);
    expect(listedContext({ id: 'a', top_provider: { context_length: 200000 } })).toBe(200000);
    expect(listedContext({ id: 'a', context_window: '272000' })).toBe(272000);
    expect(listedContext({ id: 'a', context_length: 4096 })).toBeUndefined();
    expect(listedContext('a')).toBeUndefined();
  });
});
