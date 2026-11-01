import { describe, expect, it } from 'vitest';
import type { Provider } from '../protocol.js';
import { chatProbeArgs, providerEnv } from './service.js';

describe('chatProbeArgs (测试连接)', () => {
  it('runs one turn that leaves no conversation behind', () => {
    const args = chatProbeArgs('claude-sonnet-5');
    expect(args).toContain('--no-session-persistence');
    expect(args.slice(0, 2)).toEqual(['-p', 'Reply with exactly: ok']);
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });
});

describe('providerEnv (anthropic, prompt caching)', () => {
  const ant = (patch: Partial<Provider> = {}): Provider => ({ id: 'a', name: 'a', type: 'anthropic', baseUrl: 'https://relay.example', apiKey: 'k', createdAt: 0, ...patch });
  it('1-hour TTL is opt-in per profile (ENABLE_PROMPT_CACHING_1H, read by the official binary)', () => {
    expect(providerEnv(ant()).ENABLE_PROMPT_CACHING_1H).toBeUndefined();
    expect(providerEnv(ant({ cache1h: true })).ENABLE_PROMPT_CACHING_1H).toBe('1');
  });
  it('a plain Anthropic profile: base URL and bearer token, nothing else', () => {
    const env = providerEnv(ant());
    expect(env).toEqual({ CLAUDE_WEB_PLAIN_UA: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'k' });
  });
});

describe('fitError (session.setProvider guard)', () => {
  it('a missing profile is refused, with the reason', async () => {
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
      expect(svc.fitError(anth.id, 'claude')).toBeNull();
      expect(svc.fitError('claude', 'claude')).toBeNull();
      expect(svc.fitError('nope', 'claude')).toMatch(/不存在/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('another Claude account (claude-account)', () => {
  const token = 'sk-ant-oat01-' + 'A'.repeat(70);
  it('its env: the token the CLI takes for a subscription, and nothing of a relay that would win over it', () => {
    const env = providerEnv({ id: 'a', name: 'w', type: 'claude-account', baseUrl: '', apiKey: token, createdAt: 0 } as Provider);
    expect(env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: '' });
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });
  it('saved with the account models; refreshing keeps them; the token is checked for its shape; Claude takes it', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { MetaStore } = await import('../meta/store.js');
    const { ProviderService, accountModels } = await import('./service.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-acct-'));
    const prev = process.env.CLAUDE_WEB_DIR;
    process.env.CLAUDE_WEB_DIR = dir;
    try {
      const meta = new MetaStore(path.join(dir, 'meta.json'));
      const svc = new ProviderService(meta);
      const p = await svc.upsert({ name: '工作号', type: 'claude-account', apiKey: token, baseUrl: 'https://ignored' });
      const { models, modelNames } = accountModels();
      expect(models).toContain('claude-opus-5-5');
      expect(meta.provider(p.id)).toMatchObject({ baseUrl: '', models, modelNames });
      expect(p.apiKey).not.toContain('AAAAAAAAAA');
      expect((await svc.refreshModels([p.id]))[0]).toMatchObject({ ok: true, count: models.length });
      expect(await svc.probe(p.id, undefined, { listOnly: true })).toMatchObject({ ok: true, models });
      expect(await svc.probe(undefined, { type: 'claude-account', apiKey: 'sk-relay-123' }, { listOnly: true })).toMatchObject({ ok: false });
      expect(svc.fitError(p.id, 'claude')).toBeNull();
      expect(svc.forSession(p.id)).toMatchObject({ type: 'claude-account', apiKey: token });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = prev;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
