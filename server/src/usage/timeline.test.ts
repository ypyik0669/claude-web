import { describe, expect, it } from 'vitest';
import { providerTimeline } from './timeline.js';
import type { ProviderType } from '../protocol.js';

const profiles: Record<string, { type: ProviderType; name: string }> = { ds: { type: 'openai', name: 'DeepSeek 中转' }, gem: { type: 'gemini', name: 'Gemini' } };
const resolve = (id: string) => profiles[id];

describe('providerTimeline (which profile answered a turn at time t)', () => {
  it('no switches: the session\'s profile throughout; none = the Claude account', () => {
    expect(providerTimeline([], 'ds', resolve).at(5)).toEqual({ type: 'openai', name: 'DeepSeek 中转' });
    expect(providerTimeline([], undefined, resolve).at(5)).toEqual({ name: 'Claude 账号' });
    expect(providerTimeline([], 'claude', resolve).at(5)).toEqual({ name: 'Claude 账号' });
  });
  it('a deleted profile is not the Claude account', () => {
    expect(providerTimeline([], 'gone', resolve).at(5)).toEqual({ name: '已删除的供应商' });
  });
  it('switches split the session by time; before the first switch = its recorded "from"', () => {
    const tl = providerTimeline([{ t: 100, providerId: 'gem', providerName: 'Gemini', fromProviderId: 'claude' }, { t: 200, providerId: 'ds', providerName: 'DeepSeek 中转', fromProviderId: 'gem' }], 'ds', resolve);
    expect(tl.at(50)).toEqual({ name: 'Claude 账号' });
    expect(tl.at(150)).toEqual({ type: 'gemini', name: 'Gemini' });
    expect(tl.at(250)).toEqual({ type: 'openai', name: 'DeepSeek 中转' });
  });
  it('an old mark without "from": turns before it are 未知供应商 (not guessed); a deleted profile keeps its recorded name', () => {
    const tl = providerTimeline([{ t: 100, providerId: 'old', providerName: '旧中转' }], 'old', resolve);
    expect(tl.at(50)).toEqual({ name: '未知供应商' });
    expect(tl.at(150)).toEqual({ name: '旧中转（已删除）' });
  });
  it('a switch to the Claude account (no providerId)', () => {
    const tl = providerTimeline([{ t: 100, providerName: 'Claude 账号', fromProviderId: 'ds' }], undefined, resolve);
    expect(tl.at(50)).toEqual({ type: 'openai', name: 'DeepSeek 中转' });
    expect(tl.at(150)).toEqual({ name: 'Claude 账号' });
  });
  it('the key changes when the attribution would', () => {
    const a = providerTimeline([], 'ds', resolve).key;
    expect(providerTimeline([], 'ds', resolve).key).toBe(a);
    expect(providerTimeline([], 'gem', resolve).key).not.toBe(a);
    expect(providerTimeline([{ t: 1, providerId: 'gem', providerName: 'Gemini' }], 'gem', resolve).key).not.toBe(providerTimeline([], 'gem', resolve).key);
  });
});
