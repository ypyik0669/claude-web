import { describe, expect, it } from 'vitest';
import { engineSearchAdapter, userPickedSearchAdapter } from './engine-search.js';

describe('the engine\'s own WebSearch backend (WEB_SEARCH_ADAPTER)', () => {
  it('our engine: Bing on a provider or a relay, the API\'s server-side search on claude.ai', () => {
    expect(engineSearchAdapter({ engine: 'ccb', provider: true, relay: false, userChoice: false })).toBe('bing');
    // the account, when it is really a relay from settings.json: its endpoint is not Anthropic's
    expect(engineSearchAdapter({ engine: 'ccb', provider: false, relay: true, userChoice: false })).toBe('bing');
    expect(engineSearchAdapter({ engine: 'ccb', provider: true, relay: true, userChoice: false })).toBe('bing');
    expect(engineSearchAdapter({ engine: 'ccb', provider: false, relay: false, userChoice: false })).toBe('api');
  });

  it('nothing is set when the user chose a backend, and never for the official binary', () => {
    for (const provider of [true, false]) for (const relay of [true, false]) {
      expect(engineSearchAdapter({ engine: 'ccb', provider, relay, userChoice: true })).toBeUndefined();
      for (const userChoice of [true, false]) expect(engineSearchAdapter({ engine: 'claude', provider, relay, userChoice })).toBeUndefined();
    }
  });

  it('the user\'s choice: the variable in this process\'s environment or a settings file\'s env, or the engine\'s own setting', () => {
    expect(userPickedSearchAdapter('/p', {}, [])).toBe(false);
    expect(userPickedSearchAdapter('/p', {}, [{ env: { ANTHROPIC_BASE_URL: 'https://relay.example' }, model: 'opus' }])).toBe(false);
    expect(userPickedSearchAdapter('/p', { WEB_SEARCH_ADAPTER: 'exa' }, [])).toBe(true);
    expect(userPickedSearchAdapter('/p', { WEB_SEARCH_ADAPTER: '' }, [])).toBe(false);
    expect(userPickedSearchAdapter('/p', {}, [{}, { env: { WEB_SEARCH_ADAPTER: 'brave' } }])).toBe(true); // a project's settings count too
    expect(userPickedSearchAdapter('/p', {}, [{ webSearchAdapter: 'tavily' }])).toBe(true); // what the engine's /web-tools panel writes
    expect(userPickedSearchAdapter('/p', {}, [{ env: 'not an object' }, { env: null }])).toBe(false);
  });
});
