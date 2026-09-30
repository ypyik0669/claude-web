import { describe, expect, it } from 'vitest';
import { OFFICIAL_ALIAS_TARGETS, ccbAccountEnv, ccbModel, modelLabel, profileFitError, providerTypesFor } from './catalog.js';

describe('which profile types can drive an agent', () => {
  it('per agent', () => {
    expect(providerTypesFor('claude').sort()).toEqual(['anthropic', 'gateway', 'gemini', 'grok', 'openai']);
    expect(providerTypesFor('codex')).toEqual(['openai', 'gateway']);
    expect(providerTypesFor('gemini')).toEqual(['gemini', 'gateway']);
    expect(providerTypesFor('qwen')).toEqual(['openai', 'gateway']);
    expect(providerTypesFor('acp:mine')).toEqual(['openai', 'gateway']);
  });
  it('an incompatible type is an error with the reason', () => {
    expect(profileFitError('codex', 'anthropic')).toMatch(/Codex.*anthropic/);
    expect(profileFitError('codex', 'openai')).toBeNull();
    expect(profileFitError('gemini', 'openai')).not.toBeNull();
  });
  it('the official Claude Code binary only speaks Anthropic: openai / gemini / grok need ccb', () => {
    expect(profileFitError('claude', 'openai', 'ccb')).toBeNull();
    expect(profileFitError('claude', 'openai', 'claude')).toMatch(/官方/);
    expect(profileFitError('claude', 'grok', 'claude')).not.toBeNull();
    expect(profileFitError('claude', 'anthropic', 'claude')).toBeNull();
    expect(profileFitError('claude', 'gateway', 'claude')).toBeNull();
    expect(profileFitError('codex', 'openai', 'claude')).toBeNull(); // runtime only matters for Claude sessions
  });
});

describe('Claude aliases follow the official Claude Code', () => {
  it('labels name what the alias runs, and ccb is aligned to it', () => {
    expect(modelLabel('claude', 'opus')).toBe('Opus 5.5');
    expect(modelLabel('claude', 'sonnet')).toBe('Sonnet 5');
    expect(modelLabel('claude', 'fable')).toBe('Fable 5.1');
    expect(modelLabel('claude', 'claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelLabel('claude', 'claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(ccbAccountEnv()).toEqual({ ANTHROPIC_DEFAULT_OPUS_MODEL: OFFICIAL_ALIAS_TARGETS.opus, ANTHROPIC_DEFAULT_SONNET_MODEL: OFFICIAL_ALIAS_TARGETS.sonnet, ANTHROPIC_DEFAULT_HAIKU_MODEL: OFFICIAL_ALIAS_TARGETS.haiku });
    expect(ccbModel('fable')).toBe('claude-fable-5-1');
    expect(ccbModel('best')).toBe('claude-fable-5-1');
    expect(ccbModel('fable[1m]')).toBe('claude-fable-5-1[1m]');
    expect(ccbModel('opus')).toBe('opus');
    expect(ccbModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(ccbModel(undefined)).toBeUndefined();
  });
});

describe('picking a default model from an endpoint list', () => {
  it('versions leave dates and sizes out', async () => {
    const { modelVersion } = await import('./catalog.js');
    expect(modelVersion('claude-sonnet-4-5-20250929')).toEqual([4, 5]);
    expect(modelVersion('claude-3-5-haiku-20241022')).toEqual([3, 5]);
    expect(modelVersion('glm-4.6')).toEqual([4, 6]);
  });
  it('Claude first, the newest of the family; then the coding families; never an embedding / image model', async () => {
    const { pickChatModel } = await import('./catalog.js');
    expect(pickChatModel(['claude-3-7-sonnet-20250219', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'deepseek-chat', 'gpt-4o'])).toBe('claude-sonnet-4-5-20250929');
    expect(pickChatModel(['dall-e-3', 'deepseek-chat', 'deepseek-reasoner', 'text-embedding-3-small'])).toBe('deepseek-chat');
    expect(pickChatModel(['glm-4.5', 'glm-4.5-air', 'glm-4.6', 'glm-4v'])).toBe('glm-4.6');
    expect(pickChatModel(['babbage-002', 'text-embedding-ada-002'])).toBe('babbage-002');
    expect(pickChatModel(['text-embedding-ada-002', 'whisper-1'])).toBeUndefined();
    expect(pickChatModel([])).toBeUndefined();
  });
  it('haiku / sonnet / opus from a list; a family the endpoint lacks borrows a neighbour', async () => {
    const { claudeFamilyMap } = await import('./catalog.js');
    expect(claudeFamilyMap(['claude-opus-4-1-20250805', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-3-5-haiku-20241022', 'claude-haiku-4-5-20251001'])).toEqual({ opus: 'claude-opus-4-5-20251101', sonnet: 'claude-sonnet-4-5-20250929', haiku: 'claude-haiku-4-5-20251001' });
    expect(claudeFamilyMap(['claude-sonnet-4-5-20250929'])).toEqual({ opus: 'claude-sonnet-4-5-20250929', sonnet: 'claude-sonnet-4-5-20250929', haiku: 'claude-sonnet-4-5-20250929' });
    expect(claudeFamilyMap(['deepseek-chat'])).toEqual({});
  });
});

describe('the runtime a Claude session on a provider asks for', () => {
  it('OpenAI / Gemini / Grok: ccb, whatever the provider was pinned to (the official binary has no such format)', async () => {
    const { preferredRuntime } = await import('./catalog.js');
    for (const type of ['openai', 'gemini', 'grok'] as const) {
      expect(preferredRuntime({ type, runtime: 'claude' })).toBe('ccb');
      expect(preferredRuntime({ type })).toBe('ccb');
    }
    expect(preferredRuntime({ type: 'anthropic', runtime: 'claude' })).toBe('claude'); // super-nb: its pin stands
    expect(preferredRuntime({ type: 'anthropic' })).toBeUndefined();
    expect(preferredRuntime({ type: 'gateway', runtime: 'claude' })).toBe('claude');
  });
});
