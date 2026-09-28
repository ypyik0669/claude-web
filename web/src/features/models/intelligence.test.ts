import { describe, expect, it } from 'vitest';
import type { Provider } from '@shared';
import { effortCaption, effortSegments, modelChipText } from './intelligence';

describe('智能程度 segmented control (effort → words)', () => {
  it('one segment per level the model supports, in order, with the spec words', () => {
    const s = effortSegments(['low', 'medium', 'high', 'xhigh', 'max'], 'high', 'high');
    expect(s.map((x) => x.label)).toEqual(['快', '均衡', '深入', '更深', '极限']);
    expect(s.filter((x) => x.on).map((x) => x.level)).toEqual(['high']);
  });
  it('a model without xhigh has four segments; Codex has 超限', () => {
    expect(effortSegments(['low', 'medium', 'high', 'max'], null, 'high').map((x) => x.label)).toEqual(['快', '均衡', '深入', '极限']);
    expect(effortSegments(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'ultra').at(-1)).toMatchObject({ label: '超限', on: true });
  });
  it('nothing chosen = the default level is the one lit', () => {
    expect(effortSegments(['low', 'medium', 'high'], undefined, 'medium').find((x) => x.on)?.level).toBe('medium');
    expect(effortSegments(['low', 'medium', 'high'], undefined).some((x) => x.on)).toBe(false);
  });
  it('the tooltip keeps the raw value (effort: high) for long-time users', () => {
    const s = effortSegments(['high'], 'high', 'high');
    expect(s[0].title).toContain('effort: high');
  });
  it('no levels (Gemini) = no control', () => expect(effortSegments([], null)).toEqual([]));

  it('caption: the current level, whether it is the default, and what it means', () => {
    expect(effortCaption('high', 'high')).toBe('深入（默认）：复杂改动更稳，速度适中');
    expect(effortCaption('low', 'high')).toBe('快：最快，适合简单问答和小改动');
    expect(effortCaption(undefined, 'medium')).toBe('均衡（默认）：速度与质量兼顾');
    expect(effortCaption(undefined, undefined)).toBe('');
  });
});

const prov = (id: string, o: Partial<Provider> = {}): Provider => ({ id, name: id, type: 'anthropic', baseUrl: 'https://x', apiKey: '…', createdAt: 0, ...o });

describe('model chip text: `模型 · 档位`', () => {
  const base = { providers: [prov('super-nb', { defaultModel: 'claude-opus-5' })], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const };
  it('Claude login: model name · level (the default level when none is set)', () => {
    expect(modelChipText({ ...base, efforts: [...base.efforts], agent: 'claude', model: 'claude-sonnet-5', defaultEffort: 'high' })).toEqual({ main: 'Sonnet 5', suffix: '深入' });
    expect(modelChipText({ ...base, efforts: [...base.efforts], agent: 'claude', model: '', effort: 'low', defaultEffort: 'high' })).toEqual({ main: '默认模型', suffix: '快' });
  });
  it('a provider profile is prefixed: `super-nb / Opus 5`-style (the model id as the profile lists it)', () => {
    expect(modelChipText({ ...base, efforts: [...base.efforts], agent: 'claude', providerId: 'super-nb', model: 'claude-opus-5', effort: 'high' })).toEqual({ main: 'super-nb / claude-opus-5', suffix: '深入' });
  });
  it('another agent on its own login: `Codex 5.6 Sol · 均衡`', () => {
    expect(modelChipText({ ...base, efforts: ['low', 'medium', 'high'], agent: 'codex', agentName: 'Codex', model: 'gpt-5.6-sol', defaultEffort: 'medium' })).toEqual({ main: 'Codex 5.6 Sol', suffix: '均衡' });
    expect(modelChipText({ ...base, efforts: ['low', 'medium'], agent: 'codex', agentName: 'Codex', model: '', agentDefault: 'gpt-5.6-luna' })).toEqual({ main: 'Codex 5.6 Luna', suffix: undefined });
    expect(modelChipText({ ...base, efforts: [], agent: 'gemini', agentName: 'Gemini CLI', model: '' })).toEqual({ main: 'Gemini CLI', suffix: undefined });
  });
  it('深度编排 replaces the level; no effort levels → no suffix', () => {
    expect(modelChipText({ ...base, efforts: [...base.efforts], agent: 'claude', model: 'claude-opus-5', effort: 'high', ultracode: true }).suffix).toBe('深度编排');
    // the agent's name is not repeated when the model name already says it
    expect(modelChipText({ ...base, efforts: [], agent: 'gemini', agentName: 'Gemini CLI', model: 'gemini-3-pro' })).toEqual({ main: 'Gemini 3 Pro', suffix: undefined });
  });
  it('no implementation words on the chip', () => {
    const t = modelChipText({ ...base, efforts: [...base.efforts], agent: 'claude', model: 'claude-opus-5', effort: 'xhigh', ultracode: false });
    expect(`${t.main} ${t.suffix}`).not.toMatch(/effort|ultracode|档案|引擎/i);
  });
});
