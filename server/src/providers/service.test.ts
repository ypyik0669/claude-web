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
