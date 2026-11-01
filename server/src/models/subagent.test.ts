import { describe, expect, it } from 'vitest';
import { crossPick, crossValue, fullPick, providerKey, subagentModelFor, subagentTarget, withSubagentDefault } from './subagent.js';

describe('subagent model', () => {
  it('a pick is kept whatever the conversation moves to; a plain one is made full with the provider it was made for', () => {
    const settings = { subagentModels: { p1: 'cheap', claude: 'haiku' } };
    expect(subagentModelFor({ recorded: { providerId: 'p1', model: 'mid' }, settings, providerId: 'p1' })).toBe(crossValue('p1', 'mid'));
    // moved to another provider: still the same model of p1
    expect(subagentModelFor({ recorded: { providerId: 'p1', model: 'mid' }, settings, providerId: 'claude' })).toBe(crossValue('p1', 'mid'));
    expect(subagentModelFor({ recorded: { providerId: 'claude', model: crossValue('p2', 'x') }, settings, providerId: 'p9' })).toBe(crossValue('p2', 'x'));
    // '' is a pick too: the same as the main model, over any default
    expect(subagentModelFor({ recorded: { providerId: 'p1', model: '' }, settings, providerId: 'p1' })).toBe('');
  });
  it('new conversations: the one global default, else the old per-provider one made full', () => {
    expect(subagentModelFor({ settings: { subagentModel: crossValue('p2', 'x'), subagentModels: { p1: 'cheap' } }, providerId: 'p1' })).toBe(crossValue('p2', 'x'));
    expect(subagentModelFor({ settings: { subagentModel: '', subagentModels: { p1: 'cheap' } }, providerId: 'p1' })).toBe('');
    expect(subagentModelFor({ settings: { subagentModels: { p1: 'cheap', claude: 'haiku' } }, providerId: 'p1' })).toBe(crossValue('p1', 'cheap'));
    expect(subagentModelFor({ settings: { subagentModels: { claude: 'haiku' } }, providerId: undefined })).toBe(crossValue('claude', 'haiku'));
    expect(subagentModelFor({ settings: {}, providerId: 'p9' })).toBe('');
  });
  it('fullPick / subagentTarget', () => {
    expect(fullPick('', 'p1')).toBe('');
    expect(fullPick('m', undefined)).toBe(crossValue('claude', 'm'));
    expect(fullPick(crossValue('p2', 'm'), 'p1')).toBe(crossValue('p2', 'm'));
    expect(subagentTarget('', 'p1')).toBeNull();
    expect(subagentTarget(crossValue('p1', 'm'), 'p1')).toBe('m');
    expect(subagentTarget(crossValue('claude', 'haiku'), undefined)).toBe('haiku');
    expect(subagentTarget('haiku', 'p1')).toBe('haiku'); // an old plain value: the conversation's own
    expect(subagentTarget(crossValue('p2', 'm'), 'p1')).toBeNull(); // another provider's model: the main model
    expect(subagentTarget(crossValue('p2', 'm'), undefined)).toBeNull();
  });
  it('defaults (old map): set and removed per provider; junk ignored', () => {
    expect(providerKey(undefined)).toBe('claude');
    expect(withSubagentDefault({ a: 'x', b: 3 }, 'p1', 'm')).toEqual({ a: 'x', p1: 'm' });
    expect(withSubagentDefault({ a: 'x', p1: 'm' }, 'p1', '')).toEqual({ a: 'x' });
  });
});

