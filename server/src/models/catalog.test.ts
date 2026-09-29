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
