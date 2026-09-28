import { describe, expect, it } from 'vitest';
import type { Provider } from '@shared';
import { routePick, switchedNote } from './route';
import type { ModelMenuItem } from './menu';

const prov = (id: string, o: Partial<Provider> = {}): Provider => ({ id, name: id, type: 'openai', baseUrl: 'https://x', apiKey: '…', createdAt: 0, ...o });
const providers = [prov('a', { defaultModel: 'a-default' }), prov('b'), prov('c', { defaultModel: 'c-default' })];
const item = (providerId: string, model: string, o: Partial<ModelMenuItem> = {}): ModelMenuItem => ({ key: `${providerId}:${model}`, providerId, providerName: providerId, model, display: model || '默认模型', label: model, favorite: false, recent: false, compatible: true, current: false, isDefault: !model, ...o });
const ctx = (o: Partial<Parameters<typeof routePick>[1]> = {}) => ({ agent: 'claude' as const, currentProvider: 'a', currentModel: 'm1', remote: false, busy: false, providers, ...o });

describe('routePick (in-session model menu)', () => {
  it('same profile, a model → setModel; the current one → nothing', () => {
    expect(routePick(item('a', 'm2'), ctx())).toEqual({ kind: 'setModel', model: 'm2' });
    expect(routePick(item('a', 'm1'), ctx())).toEqual({ kind: 'none' });
  });
  it('same profile, its default entry → the profile default model; none set → an error, not a guess', () => {
    expect(routePick(item('a', ''), ctx())).toEqual({ kind: 'setModel', model: 'a-default' });
    expect(routePick(item('b', ''), ctx({ currentProvider: 'b' }))).toMatchObject({ kind: 'error', message: expect.stringContaining('b') });
  });
  it('the Claude login default → `default`', () => {
    expect(routePick(item('claude', ''), ctx({ currentProvider: 'claude' }))).toEqual({ kind: 'setModel', model: 'default' });
  });
  it('a foreign agent default entry → its configured default, else an error that points at the agent settings', () => {
    expect(routePick(item('claude', ''), ctx({ agent: 'codex', currentProvider: 'claude', agentDefault: 'gpt-5.6-sol' }))).toEqual({ kind: 'setModel', model: 'gpt-5.6-sol' });
    const r = routePick(item('claude', ''), ctx({ agent: 'codex', currentProvider: 'claude' }));
    expect(r).toMatchObject({ kind: 'error' });
    expect((r as { message: string }).message).toMatch(/agent/);
    expect((r as { message: string }).message).not.toMatch(/档案/);
  });
  it('another profile → setProvider with the picked model', () => {
    expect(routePick(item('b', 'x'), ctx())).toEqual({ kind: 'setProvider', providerId: 'b', model: 'x', confirm: false });
  });
  it('another profile default entry → its default model, or none at all (never the old model)', () => {
    expect(routePick(item('c', ''), ctx())).toEqual({ kind: 'setProvider', providerId: 'c', model: 'c-default', confirm: false });
    expect(routePick(item('b', ''), ctx())).toEqual({ kind: 'setProvider', providerId: 'b', model: undefined, confirm: false });
    expect(routePick(item('claude', ''), ctx())).toEqual({ kind: 'setProvider', providerId: undefined, model: undefined, confirm: false });
  });
  it('switching profile while a turn runs asks first', () => {
    expect(routePick(item('b', 'x'), ctx({ busy: true }))).toMatchObject({ kind: 'setProvider', confirm: true });
    expect(routePick(item('a', 'm2'), ctx({ busy: true }))).toEqual({ kind: 'setModel', model: 'm2' }); // same profile: no restart
  });
  it('a remote session only changes models (its profiles live on that machine)', () => {
    expect(routePick(item('claude', 'm9'), ctx({ remote: true }))).toEqual({ kind: 'setModel', model: 'm9' });
  });
  it('an unavailable entry is refused with its reason', () => {
    expect(routePick(item('b', 'x', { unavailable: '网关未启用' }), ctx())).toEqual({ kind: 'error', message: '网关未启用' });
  });
  it("another agent's model = a hand-over to that agent (the same confirm as ···), on the picked model", () => {
    expect(routePick(item('claude', 'gpt-5.6-sol', { agent: 'codex' }), ctx())).toEqual({ kind: 'handover', agent: 'codex', model: 'gpt-5.6-sol' });
    expect(routePick(item('claude', '', { agent: 'codex', isDefault: true }), ctx())).toEqual({ kind: 'handover', agent: 'codex', model: undefined });
  });
  it('a remote session is not handed over from the model menu (···: 交给本机的 Agent 继续)', () => {
    expect(routePick(item('claude', 'x', { agent: 'codex' }), ctx({ remote: true }))).toMatchObject({ kind: 'error' });
  });
  it('the item of the current agent is not a hand-over', () => {
    expect(routePick(item('claude', 'm2', { agent: 'claude' }), ctx({ currentProvider: 'claude' }))).toEqual({ kind: 'setModel', model: 'm2' });
  });
});

describe('switchedNote (prompt cache does not follow a model / provider change)', () => {
  it('says the next turn re-bills the whole context — only when there is context to re-bill', () => {
    expect(switchedNote('GPT-5', true)).toBe('已切换到 GPT-5（提示缓存不跨模型 / 供应商，下一轮会按全价重新计费全部上下文）');
    expect(switchedNote('GPT-5', false)).toBe('已切换到 GPT-5');
  });
});
