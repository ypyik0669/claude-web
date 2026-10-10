import { describe, expect, it } from 'vitest';
import { ENGINE_SEARCH_TOOL, engineSearchOff, userPickedSearchAdapter } from './engine-search.js';

describe('the engine\'s own WebSearch', () => {
  it('is taken away on our engine (default backend: a hosted Tavily proxy) and left on the official binary', () => {
    expect(ENGINE_SEARCH_TOOL).toBe('WebSearch');
    expect(engineSearchOff({ engine: 'ccb', userChoice: false })).toBe(true);
    expect(engineSearchOff({ engine: 'claude', userChoice: false })).toBe(false);
    // a backend the user picked is theirs to use
    expect(engineSearchOff({ engine: 'ccb', userChoice: true })).toBe(false);
    expect(engineSearchOff({ engine: 'claude', userChoice: true })).toBe(false);
  });

  it('the user picked a backend: the variable in the environment or in a settings file\'s env, or the setting itself', () => {
    expect(userPickedSearchAdapter(undefined, {}, [])).toBe(false);
    expect(userPickedSearchAdapter(undefined, { WEB_SEARCH_ADAPTER: 'exa' }, [])).toBe(true);
    expect(userPickedSearchAdapter(undefined, { WEB_SEARCH_ADAPTER: '' }, [])).toBe(false);
    expect(userPickedSearchAdapter(undefined, {}, [{ env: { WEB_SEARCH_ADAPTER: 'bing' } }])).toBe(true);
    expect(userPickedSearchAdapter(undefined, {}, [{ theme: 'dark' }, { webSearchAdapter: 'brave' }])).toBe(true);
    // settings that say nothing about it, or say it in a shape that is not one
    expect(userPickedSearchAdapter(undefined, {}, [{ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } }, { env: 'not an object' }, { webSearchAdapter: '' }])).toBe(false);
  });
});
