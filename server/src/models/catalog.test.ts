import { describe, expect, it } from 'vitest';
import { claudeFamilyMap, modelCaps, modelLabel, modelVersion, nearestLevel, pickChatModel, profileFitError, providerTypesFor } from './catalog.js';

describe('which profile types can drive a Claude conversation', () => {
  it('Anthropic-format endpoints and other Claude accounts', () => {
    expect(providerTypesFor('claude').sort()).toEqual(['anthropic', 'claude-account']);
    expect(profileFitError('claude', 'anthropic')).toBeNull();
    expect(profileFitError('claude', 'claude-account')).toBeNull();
    expect(profileFitError('claudeai', 'anthropic')).toMatch(/claudeai.*anthropic/);
  });
});

describe('Claude aliases follow the official Claude Code', () => {
  it('labels name what the alias runs', () => {
    expect(modelLabel('claude', 'opus')).toBe('Opus 5.5');
    expect(modelLabel('claude', 'sonnet')).toBe('Sonnet 5');
    expect(modelLabel('claude', 'fable')).toBe('Fable 5.1');
    expect(modelLabel('claude', 'claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelLabel('claude', 'claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });
});

describe('picking a default model from an endpoint list', () => {
  it('versions leave dates and sizes out', () => {
    expect(modelVersion('claude-sonnet-4-5-20250929')).toEqual([4, 5]);
    expect(modelVersion('claude-3-5-haiku-20241022')).toEqual([3, 5]);
    expect(modelVersion('glm-4.6')).toEqual([4, 6]);
  });
  it('Sonnet first, the newest of the family; then Opus, any Claude; never an embedding / image model', () => {
    expect(pickChatModel(['claude-3-7-sonnet-20250219', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'deepseek-chat'])).toBe('claude-sonnet-4-5-20250929');
    expect(pickChatModel(['claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001'])).toBe('claude-opus-4-5-20251101');
    expect(pickChatModel(['claude-haiku-4-5-20251001', 'text-embedding-3-small'])).toBe('claude-haiku-4-5-20251001');
    expect(pickChatModel(['babbage-002', 'text-embedding-ada-002'])).toBe('babbage-002');
    expect(pickChatModel(['text-embedding-ada-002', 'whisper-1'])).toBeUndefined();
    expect(pickChatModel([])).toBeUndefined();
  });
  it('haiku / sonnet / opus from a list; a family the endpoint lacks borrows a neighbour', () => {
    expect(claudeFamilyMap(['claude-opus-4-1-20250805', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-3-5-haiku-20241022', 'claude-haiku-4-5-20251001'])).toEqual({ opus: 'claude-opus-4-5-20251101', sonnet: 'claude-sonnet-4-5-20250929', haiku: 'claude-haiku-4-5-20251001' });
    expect(claudeFamilyMap(['claude-sonnet-4-5-20250929'])).toEqual({ opus: 'claude-sonnet-4-5-20250929', sonnet: 'claude-sonnet-4-5-20250929', haiku: 'claude-sonnet-4-5-20250929' });
    expect(claudeFamilyMap(['deepseek-chat'])).toEqual({});
  });
});

describe('what each model can do with thinking strength', () => {
  it('nearestLevel: closest, a tie goes up', () => {
    expect(nearestLevel('medium', ['low', 'high', 'max'])).toBe('high');
    expect(nearestLevel('xhigh', ['low', 'high', 'max'])).toBe('max');
    expect(nearestLevel('low', ['high'])).toBe('high');
    expect(nearestLevel('high', ['low', 'high'])).toBe('high');
  });

  it('levels declared by the model list win', () => {
    const p = { type: 'anthropic' as const, modelEfforts: { 'claude-x': { levels: ['low', 'high'] as ('low' | 'high')[], default: 'high' as const } } };
    expect(modelCaps(p, 'claude-x')).toEqual({ levels: ['low', 'high'], default: 'high', reasoning: true });
  });

  it('Fable is Claude; Opus / Sonnet 4.6 and Sonnet 4.5 have no xhigh (the catalog)', () => {
    expect(modelCaps(undefined, 'claude-opus-5-5')).toMatchObject({ levels: ['low', 'medium', 'high', 'xhigh', 'max'], reasoning: true });
    expect(modelCaps({ type: 'anthropic' }, 'claude-fable-5-1').levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(modelCaps({ type: 'anthropic' }, 'claude-sonnet-4-6').levels).toEqual(['low', 'medium', 'high', 'max']);
    expect(modelCaps({ type: 'anthropic' }, 'claude-opus-4-6-20260101').levels).toEqual(['low', 'medium', 'high', 'max']);
    expect(modelCaps({ type: 'anthropic' }, 'claude-sonnet-4-5').levels).toEqual(['low', 'medium', 'high', 'max']);
    expect(modelCaps({ type: 'anthropic' }, 'claude-opus-4-7').levels).toContain('xhigh');
  });

  it('a model the table does not know: all five levels, not marked as reasoning', () => {
    expect(modelCaps({ type: 'anthropic' }, 'glm-4.6')).toEqual({ levels: ['low', 'medium', 'high', 'xhigh', 'max'], reasoning: false });
  });

  it('the account\'s aliases are the models they stand for', () => {
    for (const alias of ['default', 'opus', 'sonnet', 'haiku', 'fable', 'best', 'opus[1m]']) {
      expect(modelCaps(undefined, alias), alias).toMatchObject({ reasoning: true });
    }
  });
});
