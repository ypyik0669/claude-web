import { describe, expect, it } from 'vitest';
import { OFFICIAL_ALIAS_TARGETS, ccbAccountEnv, ccbModel, modelCaps, modelLabel, nearestLevel, profileFitError, providerTypesFor, webCapsEnv } from './catalog.js';

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

  it('a Claude 5 model ccb would send a thinking budget to runs on the official binary (claude-opus-5-5 400s on ccb)', async () => {
    const { preferredRuntime, ccbMisthinks } = await import('./catalog.js');
    for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-sonnet-5-5[1m]', 'anthropic/claude-opus-5.5', 'claude-haiku-5-20261001']) expect(ccbMisthinks(id)).toBe(true);
    for (const id of ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022', 'claude-fable-5-1', 'deepseek-v4', 'gpt-5.6', '', undefined]) expect(ccbMisthinks(id)).toBe(false);
    const xy = { type: 'anthropic' as const, defaultModel: 'claude-sonnet-4-6', modelMap: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-4-6', haiku: 'claude-sonnet-4-6' } };
    expect(preferredRuntime(xy, 'claude-opus-5-5')).toBe('claude');
    expect(preferredRuntime(xy, 'opus')).toBe('claude'); // the alias goes through the family map
    expect(preferredRuntime(xy, 'claude-sonnet-4-6')).toBeUndefined();
    expect(preferredRuntime(xy, '')).toBeUndefined(); // no model: the profile's default (sonnet-4-6)
    expect(preferredRuntime({ ...xy, defaultModel: undefined }, '')).toBe('claude'); // ccb's default follows the opus map
    expect(preferredRuntime({ ...xy, runtime: 'ccb' }, 'claude-opus-5-5')).toBe('ccb'); // an explicit pin stands
    expect(preferredRuntime({ type: 'gateway' }, 'claude-opus-5-5')).toBe('claude');
    expect(preferredRuntime({ type: 'openai' }, 'claude-opus-5-5')).toBe('ccb'); // the official binary has no OpenAI format
    expect(preferredRuntime(xy)).toBeUndefined(); // no model asked: the profile's own pin (fit checks, menus)
  });
});

describe('pickChatModel: the newest GPT, and the lower-case id of a duplicate', () => {
  it('gpt-6.x over gpt-5.x; deepseek before gpt-4o; DeepSeek-V4.1-Flash loses to deepseek-v4.1-flash', async () => {
    const { pickChatModel } = await import('./catalog.js');
    expect(pickChatModel(['gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-image-2', 'gpt-6.1-mini'])).toBe('gpt-6.1-sol');
    expect(pickChatModel(['gpt-4o', 'deepseek-v4'])).toBe('deepseek-v4');
    expect(pickChatModel(['DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash'])).toBe('deepseek-v4.1-flash');
  });
});

describe('what each model can do (same rules as the engine: claude-web-engine effortPlan)', () => {
  const ds = {
    type: 'openai' as const,
    modelEfforts: { 'deepseek-flash': { levels: ['low', 'high', 'max'] as ('low' | 'high' | 'max')[], default: 'high' as const } },
  };

  it('nearestLevel: closest, a tie goes up', () => {
    expect(nearestLevel('medium', ['low', 'high', 'max'])).toBe('high');
    expect(nearestLevel('xhigh', ['low', 'high', 'max'])).toBe('max');
    expect(nearestLevel('low', ['high'])).toBe('high');
    expect(nearestLevel('high', ['low', 'high'])).toBe('high');
  });

  it('levels declared by the list win; native while not recorded as refused', () => {
    expect(modelCaps(ds, 'deepseek-flash')).toEqual({ levels: ['low', 'high', 'max'], default: 'high', reasoning: true, native: true });
    expect(modelCaps({ ...ds, promptEffortModels: ['deepseek-flash'] }, 'deepseek-flash').native).toBe(false);
  });

  it('a model without the parameter: five levels through the prompt', () => {
    expect(modelCaps({ type: 'openai' }, 'gpt-4o')).toEqual({ levels: ['low', 'medium', 'high', 'xhigh', 'max'], reasoning: false, native: false });
  });

  it('the table: Claude, OpenAI reasoning models, DeepSeek, Gemini, grok-3-mini', () => {
    expect(modelCaps(undefined, 'claude-opus-5-5')).toMatchObject({ levels: ['low', 'medium', 'high', 'xhigh', 'max'], reasoning: true, native: true });
    expect(modelCaps({ type: 'anthropic' }, 'claude-3-7-sonnet')).toMatchObject({ reasoning: true, native: true });
    expect(modelCaps({ type: 'openai' }, 'o3-mini')).toMatchObject({ levels: ['low', 'medium', 'high'], native: true });
    expect(modelCaps({ type: 'openai' }, 'deepseek-v4-pro')).toMatchObject({ levels: ['low', 'high', 'max'], default: 'high', native: true });
    expect(modelCaps({ type: 'gemini' }, 'gemini-3-pro')).toMatchObject({ levels: ['low', 'high'], native: true });
    expect(modelCaps({ type: 'gemini' }, 'gemini-2.5-flash')).toMatchObject({ levels: ['low', 'medium', 'high', 'xhigh', 'max'], native: true });
    expect(modelCaps({ type: 'grok' }, 'grok-3-mini')).toMatchObject({ levels: ['low', 'high'], native: true });
    expect(modelCaps({ type: 'grok' }, 'grok-4')).toMatchObject({ native: false });
  });

  it('a non-Claude model on a Claude-format relay: native only when the list declares levels', () => {
    expect(modelCaps({ type: 'anthropic' }, 'glm-4.6').native).toBe(false);
    expect(modelCaps({ type: 'anthropic', modelEfforts: { 'glm-4.6': { levels: ['low', 'high'] } } }, 'glm-4.6').native).toBe(true);
  });

  it('a reasoning model on a Claude-format relay gets the budget (native); through the model gateway only Claude does', () => {
    expect(modelCaps({ type: 'anthropic' }, 'deepseek-chat')).toMatchObject({ reasoning: true, native: true });
    expect(modelCaps({ type: 'gateway' }, 'gpt-5')).toMatchObject({ native: false });
    expect(modelCaps({ type: 'gateway' }, 'deepseek-chat')).toMatchObject({ native: false });
    expect(modelCaps({ type: 'gateway' }, 'claude-sonnet-4-6')).toMatchObject({ native: true });
  });

  it('Fable is Claude; Opus / Sonnet 4.6 and Sonnet 4.5 have no xhigh (the catalog)', () => {
    expect(modelCaps({ type: 'anthropic' }, 'claude-fable-5-1')).toMatchObject({ native: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(modelCaps({ type: 'anthropic' }, 'claude-sonnet-4-6').levels).toEqual(['low', 'medium', 'high', 'max']);
    expect(modelCaps({ type: 'anthropic' }, 'claude-opus-4-6-20260101').levels).toEqual(['low', 'medium', 'high', 'max']);
    expect(modelCaps({ type: 'anthropic' }, 'claude-sonnet-4-5').levels).toEqual(['low', 'medium', 'high', 'max']);
    expect(modelCaps({ type: 'anthropic' }, 'claude-opus-4-7').levels).toContain('xhigh');
  });

  it('the account\'s aliases are the models they stand for', () => {
    for (const alias of ['default', 'opus', 'sonnet', 'haiku', 'fable', 'best', 'opus[1m]']) {
      expect(modelCaps(undefined, alias), alias).toMatchObject({ native: true, reasoning: true });
    }
  });

  it('the engine variable: a model of another format gets {native:false} — no levels, no "reasons" (no DeepSeek-style switches)', () => {
    const relay = { type: 'openai' as const };
    const env = JSON.parse(webCapsEnv(relay, ['claude-sonnet-4-6', 'gemini-3-pro', 'deepseek-flash', 'gpt-4o']));
    expect(env['claude-sonnet-4-6']).toEqual({ native: false });
    expect(env['gemini-3-pro']).toEqual({ native: false });
    expect(env['deepseek-flash']).toMatchObject({ reasoning: true });
    expect(env['gpt-4o']).toBeUndefined();
    expect(JSON.parse(webCapsEnv({ type: 'gateway' }, ['gpt-5']))['gpt-5']).toEqual({ native: false });
    expect(JSON.parse(webCapsEnv({ type: 'anthropic' }, ['claude-sonnet-4-6']))['claude-sonnet-4-6']).toEqual({ levels: ['low', 'medium', 'high', 'max'], reasoning: true });
  });

  it('the engine variable: only what we know (an unknown model keeps the engine on its own name rules)', () => {
    const env = JSON.parse(webCapsEnv({ ...ds, promptEffortModels: ['gpt-x'] }, ['deepseek-flash', 'gpt-4o', 'gpt-x']));
    expect(env['deepseek-flash']).toEqual({ levels: ['low', 'high', 'max'], default: 'high', reasoning: true });
    expect(env['gpt-4o']).toBeUndefined();
    expect(env['gpt-x']).toEqual({ native: false });
  });
});
