import { describe, expect, it } from 'vitest';
import type { Provider } from '@shared';
import { subagentLabel } from './subagent-label';
import { crossValue } from '../../../../server/src/models/subagent';

const P = (id: string, type: Provider['type'], extra: Partial<Provider> = {}) => ({ id, name: `N-${id}`, type, baseUrl: 'https://x.invalid', models: [], ...extra }) as Provider;

describe('subagent model label', () => {
  const providers = [P('relay', 'anthropic'), P('ds', 'anthropic'), P('acct', 'claude-account')];
  it('the chip names the provider when it is not the conversation’s own', () => {
    expect(subagentLabel({ providers, providerId: 'relay', model: crossValue('ds', 'deepseek-chat') })).toBe('N-ds / deepseek-chat');
    expect(subagentLabel({ providers, providerId: 'ds', model: crossValue('ds', 'deepseek-chat') })).toBe('deepseek-chat');
    // a value from before (a plain id): the conversation's own provider
    expect(subagentLabel({ providers, providerId: 'ds', model: 'deepseek-chat' })).toBe('deepseek-chat');
    expect(subagentLabel({ providers, providerId: 'relay', model: crossValue('claude', 'claude-haiku-4-5'), builtin: [{ value: 'claude-haiku-4-5', displayName: 'Haiku' }] })).toBe('Claude 账号 / Haiku');
    expect(subagentLabel({ providers, providerId: 'claude', model: crossValue('claude', 'claude-haiku-4-5'), builtin: [{ value: 'claude-haiku-4-5', displayName: 'Haiku' }] })).toBe('Haiku');
  });
  it('no model = the main model', () => expect(subagentLabel({ providers, providerId: 'relay', model: '' })).toBe('同主模型'));
});
