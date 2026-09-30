import { describe, expect, it } from 'vitest';
import { PRESETS, anthropicBase, cleanBase, explainProbe, quickPlan, relayName, uniqueName } from './quick';

const relay = PRESETS.find((p) => p.id === 'relay')!;
const deepseek = PRESETS.find((p) => p.id === 'deepseek')!;
const gemini = PRESETS.find((p) => p.id === 'gemini')!;
const CLAUDE_RELAY = ['claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'deepseek-chat', 'text-embedding-3-small'];

describe('quick connect: the address people paste', () => {
  it('bare host, no scheme, full endpoint URL → a base', () => {
    expect(cleanBase(' relay.example.com/ ')).toBe('https://relay.example.com');
    expect(cleanBase('https://relay.example.com/v1/chat/completions')).toBe('https://relay.example.com/v1');
    expect(cleanBase('https://relay.example.com/v1/messages/')).toBe('https://relay.example.com/v1');
    expect(cleanBase('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(cleanBase('127.0.0.1:3299/v1/chat/completions')).toBe('http://127.0.0.1:3299/v1'); // local: plain http
    expect(cleanBase('192.168.1.5:3000')).toBe('http://192.168.1.5:3000');
    expect(cleanBase('localhost:8080')).toBe('http://localhost:8080');
    expect(cleanBase('')).toBe('');
    expect(anthropicBase('https://relay.example.com/v1/')).toBe('https://relay.example.com'); // the CLI adds /v1/messages
  });
  it('names: the relay host; taken names get a number', () => {
    expect(relayName('https://www.aizhongzhuan.cc/v1')).toBe('aizhongzhuan.cc');
    expect(relayName('api.example.com')).toBe('example.com');
    expect(uniqueName('DeepSeek', ['DeepSeek', 'DeepSeek 2'])).toBe('DeepSeek 3');
    expect(uniqueName('Kimi', [])).toBe('Kimi');
  });
});

describe('quick connect: the plan from the model list', () => {
  it('a relay with Claude models → Claude format, every family mapped, default its sonnet', () => {
    expect(quickPlan(relay, 'auto', 'https://r.example/v1', CLAUDE_RELAY)).toEqual({
      type: 'anthropic', baseUrl: 'https://r.example', defaultModel: 'claude-sonnet-4-5-20250929',
      modelMap: { opus: 'claude-opus-4-5-20251101', sonnet: 'claude-sonnet-4-5-20250929', haiku: 'claude-haiku-4-5-20251001' },
    });
  });
  it('a relay without Claude → OpenAI format on its best chat model; the format can be forced', () => {
    expect(quickPlan(relay, 'auto', 'https://r.example', ['dall-e-3', 'deepseek-chat', 'glm-4.6'])).toEqual({ type: 'openai', baseUrl: 'https://r.example', defaultModel: 'deepseek-chat' });
    expect(quickPlan(relay, 'openai', 'https://r.example', CLAUDE_RELAY)).toMatchObject({ type: 'openai', defaultModel: 'claude-sonnet-4-5-20250929' });
    // Claude format forced on a relay without Claude models: the three families all on the one model
    expect(quickPlan(relay, 'anthropic', 'https://r.example/v1', ['deepseek-chat'])).toEqual({ type: 'anthropic', baseUrl: 'https://r.example', defaultModel: 'deepseek-chat', modelMap: { haiku: 'deepseek-chat', sonnet: 'deepseek-chat', opus: 'deepseek-chat' } });
  });
  it('vendors keep their fixed endpoint; Gemini prefers a pro model', () => {
    expect(quickPlan(deepseek, 'auto', '', ['deepseek-chat', 'deepseek-reasoner'])).toEqual({ type: 'openai', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' });
    expect(quickPlan(gemini, 'auto', '', ['gemini-3-flash', 'gemini-3-pro', 'text-embedding-004'])).toEqual({ type: 'gemini', baseUrl: '', defaultModel: 'gemini-3-pro' });
  });
});

describe('quick connect: a failed check in plain words', () => {
  it('wrong key / no balance / wrong address / unreachable', () => {
    expect(explainProbe({ ok: false, status: 401, error: 'invalid key' }, 'list')).toMatch(/API Key 不对/);
    expect(explainProbe({ ok: false, error: '无效的令牌' }, 'list')).toMatch(/API Key 不对/);
    expect(explainProbe({ ok: false, chat: { ok: false, model: 'm', error: 'HTTP 402 insufficient balance' } }, 'chat')).toMatch(/余额不足/);
    expect(explainProbe({ ok: false, status: 404, error: 'Not Found' }, 'list')).toMatch(/地址不对/);
    expect(explainProbe({ ok: false, error: 'getaddrinfo ENOTFOUND relay.example' }, 'list')).toMatch(/连不上/);
    expect(explainProbe({ ok: false, error: '连接超时（20s）' }, 'list')).toMatch(/超时/);
    expect(explainProbe({ ok: false, error: 'D8950000:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long' }, 'list')).toMatch(/不是 https/);
    expect(explainProbe({ ok: true, models: [] }, 'list')).toMatch(/没有读到任何模型/);
    expect(explainProbe({ ok: false, chat: { ok: false, model: 'x-1', error: 'HTTP 400 model x-1 does not exist' } }, 'chat')).toMatch(/模型 x-1 用不了/);
  });
  it('every preset has a name; vendors have a fixed endpoint or their own type', () => {
    for (const p of PRESETS) {
      expect(p.name).toBeTruthy();
      if (p.type === 'openai') expect(p.baseUrl).toMatch(/^https:\/\//);
    }
  });
});
