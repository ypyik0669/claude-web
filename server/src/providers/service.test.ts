import { describe, expect, it } from 'vitest';
import type { Provider } from '../protocol.js';
import { openaiBase, providerEnv } from './service.js';

const prov = (baseUrl: string): Provider => ({ id: 'p', name: 'p', type: 'openai', baseUrl, apiKey: 'k', createdAt: 0 });

describe('openaiBase', () => {
  it('appends /v1 to a bare relay host (what users paste)', () => {
    expect(openaiBase('https://relay.example/')).toBe('https://relay.example/v1');
    expect(openaiBase('https://relay.example')).toBe('https://relay.example/v1');
  });
  it('keeps an explicit version segment', () => {
    expect(openaiBase('https://relay.example/v1/')).toBe('https://relay.example/v1');
    expect(openaiBase('https://ark.example/api/v3')).toBe('https://ark.example/api/v3');
    expect(openaiBase('https://g.example/v1beta')).toBe('https://g.example/v1beta');
  });
  it('leaves an empty base empty (the CLI default applies)', () => {
    expect(openaiBase('')).toBe('');
  });
});

describe('providerEnv (openai)', () => {
  it('sessions get the versioned base URL, not the bare host', () => {
    expect(providerEnv(prov('https://www.aizhongzhuan.cc/')).OPENAI_BASE_URL).toBe('https://www.aizhongzhuan.cc/v1');
  });
});

describe('providerEnv (anthropic, prompt caching)', () => {
  const ant = (patch: Partial<Provider> = {}): Provider => ({ id: 'a', name: 'a', type: 'anthropic', baseUrl: 'https://relay.example', apiKey: 'k', createdAt: 0, ...patch });
  it('1-hour TTL is opt-in per profile (ENABLE_PROMPT_CACHING_1H, read by the official binary)', () => {
    expect(providerEnv(ant()).ENABLE_PROMPT_CACHING_1H).toBeUndefined();
    expect(providerEnv(ant({ cache1h: true })).ENABLE_PROMPT_CACHING_1H).toBe('1');
    // a gateway profile is not an Anthropic profile: its members decide
    expect(providerEnv({ ...ant({ cache1h: true }), type: 'gateway' }).ENABLE_PROMPT_CACHING_1H).toBeUndefined();
  });
  it('the shim never applies to Anthropic-type env even if a shim were attached', () => {
    const env = providerEnv({ ...ant(), shim: { base: 'http://127.0.0.1:1/gateway/~p/a', key: 'cws-x' } }, 'claude', { sessionKey: 's' });
    expect(env).toEqual({ CLAUDE_WEB_PLAIN_UA: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'k' });
  });
});

describe('agentLaunch (gemini profile)', () => {
  it('Gemini CLI gets the profile key / base URL / model and the API-key auth override; other ACP agents get nothing', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { MetaStore } = await import('../meta/store.js');
    const { ProviderService } = await import('./service.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-agentlaunch-'));
    const prev = process.env.CLAUDE_WEB_DIR;
    process.env.CLAUDE_WEB_DIR = dir;
    try {
      const meta = new MetaStore(path.join(dir, 'meta.json'));
      const svc = new ProviderService(meta);
      const p = await meta.upsertProvider({ name: 'g', type: 'gemini', baseUrl: 'https://g.example', apiKey: 'AIza-test', defaultModel: 'gemini-3-pro' });
      const l = svc.agentLaunch(p.id, 'acp', 'gemini');
      expect(l.env).toMatchObject({ GEMINI_API_KEY: 'AIza-test', GOOGLE_GEMINI_BASE_URL: 'https://g.example', GEMINI_MODEL: 'gemini-3-pro' });
      expect(l.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toContain(dir);
      expect(svc.agentLaunch(p.id, 'acp', 'qwen')).toEqual({ env: {}, args: [] });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prev;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('fitError (session.setProvider guard)', () => {
  it('refuses a profile the agent / engine cannot use, with the reason', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { MetaStore } = await import('../meta/store.js');
    const { ProviderService } = await import('./service.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-fit-'));
    try {
      const meta = new MetaStore(path.join(dir, 'meta.json'));
      const svc = new ProviderService(meta);
      const anth = await meta.upsertProvider({ name: 'a', type: 'anthropic', baseUrl: 'https://a', apiKey: 'k' });
      const oai = await meta.upsertProvider({ name: 'o', type: 'openai', baseUrl: 'https://o', apiKey: 'k' });
      const oaiOfficial = await meta.upsertProvider({ name: 'oo', type: 'openai', baseUrl: 'https://o', apiKey: 'k', runtime: 'claude' });
      expect(svc.fitError(anth.id, 'codex')).toMatch(/Codex/);
      expect(svc.fitError(oai.id, 'codex')).toBeNull();
      expect(svc.fitError(anth.id, 'claude')).toBeNull();
      expect(svc.fitError(oaiOfficial.id, 'claude')).toMatch(/官方/);
      expect(svc.fitError(undefined, 'codex')).toBeNull();
      expect(svc.fitError('claude', 'claude')).toBeNull();
      expect(svc.fitError('nope', 'claude')).toMatch(/不存在/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('providerEnv (gemini / grok through ccb)', () => {
  const p = (o: Partial<Provider>): Provider => ({ id: 'p', name: 'p', type: 'gemini', baseUrl: '', apiKey: 'k', createdAt: 0, ...o });
  it('gemini: switches ccb to its Gemini provider with the variables that provider reads', () => {
    const env = providerEnv(p({ type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', defaultModel: 'gemini-3-pro', modelMap: { haiku: 'gemini-3-flash' } }));
    expect(env.CLAUDE_CODE_USE_GEMINI).toBe('1');
    expect(env.GEMINI_API_KEY).toBe('k');
    expect(env.GEMINI_BASE_URL).toBe('https://generativelanguage.googleapis.com/v1beta'); // ccb appends /models/<id>:streamGenerateContent
    // every family is mapped (ccb throws on an unmapped haiku/sonnet/opus); the default fills the gaps
    expect(env).toMatchObject({ GEMINI_DEFAULT_HAIKU_MODEL: 'gemini-3-flash', GEMINI_DEFAULT_SONNET_MODEL: 'gemini-3-pro', GEMINI_DEFAULT_OPUS_MODEL: 'gemini-3-pro' });
    // GEMINI_MODEL pins every request (in-session model switches would do nothing)
    expect(env.GEMINI_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
  it('gemini: a versioned base URL is kept, an empty one left to the default; no default model → the best listed chat model', () => {
    expect(providerEnv(p({ baseUrl: 'https://relay.example/v1beta/' })).GEMINI_BASE_URL).toBe('https://relay.example/v1beta');
    const env = providerEnv(p({ models: ['gemini-3-flash', 'gemini-3-pro', 'imagen-4'] }));
    expect(env.GEMINI_BASE_URL).toBeUndefined();
    expect(env.GEMINI_DEFAULT_SONNET_MODEL).toBe('gemini-3-pro');
    // nothing it recognises: the first chat model, never an embedding
    expect(providerEnv(p({ models: ['text-embedding-004', 'learnlm-2'] })).GEMINI_DEFAULT_SONNET_MODEL).toBe('learnlm-2');
  });
  it('grok: switches ccb to its Grok provider (OpenAI-style base with /v1, GROK_API_KEY, family defaults)', () => {
    const env = providerEnv(p({ type: 'grok', baseUrl: 'https://api.x.ai', apiKey: 'xai-k', defaultModel: 'grok-5', modelMap: { haiku: 'grok-5-mini' } }));
    expect(env.CLAUDE_CODE_USE_GROK).toBe('1');
    expect(env.GROK_API_KEY).toBe('xai-k');
    expect(env.GROK_BASE_URL).toBe('https://api.x.ai/v1');
    expect(env).toMatchObject({ GROK_DEFAULT_HAIKU_MODEL: 'grok-5-mini', GROK_DEFAULT_SONNET_MODEL: 'grok-5', GROK_DEFAULT_OPUS_MODEL: 'grok-5' });
    expect(env.GROK_MODEL).toBeUndefined();
    expect(providerEnv(p({ type: 'grok' })).GROK_BASE_URL).toBeUndefined();
  });
  it('openai: no OPENAI_MODEL (ccb sends it for every request: the model menu and the family map would do nothing); families default to the default model', () => {
    const env = providerEnv(p({ type: 'openai', baseUrl: 'https://relay.example', defaultModel: 'deepseek-v4.1-flash', modelMap: { haiku: 'glm-5.3-flash' } }));
    expect(env.CLAUDE_CODE_USE_OPENAI).toBe('1');
    expect(env.OPENAI_MODEL).toBeUndefined();
    expect(env).toMatchObject({
      OPENAI_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash', OPENAI_SMALL_FAST_MODEL: 'glm-5.3-flash',
      OPENAI_DEFAULT_SONNET_MODEL: 'deepseek-v4.1-flash', OPENAI_DEFAULT_OPUS_MODEL: 'deepseek-v4.1-flash',
    });
    // no default and no map: the first listed model rather than ccb's built-in claude → gpt-4o / o3 table
    const bare = providerEnv(p({ type: 'openai', baseUrl: 'https://relay.example', models: ['qwen3.8-max', 'kimi-k3'] }));
    expect(bare).toMatchObject({ OPENAI_DEFAULT_HAIKU_MODEL: 'qwen3.8-max', OPENAI_DEFAULT_SONNET_MODEL: 'qwen3.8-max', OPENAI_DEFAULT_OPUS_MODEL: 'qwen3.8-max' });
    expect(bare.OPENAI_MODEL).toBeUndefined();
  });
  it('only one ccb provider switch per type', () => {
    const flags = (t: Provider['type']) => Object.keys(providerEnv(p({ type: t, baseUrl: 'https://x' }))).filter((k) => /^CLAUDE_CODE_USE_/.test(k));
    expect(flags('openai')).toEqual(['CLAUDE_CODE_USE_OPENAI']);
    expect(flags('gemini')).toEqual(['CLAUDE_CODE_USE_GEMINI']);
    expect(flags('grok')).toEqual(['CLAUDE_CODE_USE_GROK']);
    expect(flags('anthropic')).toEqual([]);
  });
});
