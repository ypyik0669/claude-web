import { describe, expect, it } from 'vitest';
import { profileFitError, providerTypesFor } from './catalog.js';

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
