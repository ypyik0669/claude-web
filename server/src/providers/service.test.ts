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
