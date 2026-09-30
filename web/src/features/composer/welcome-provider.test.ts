import { describe, expect, it } from 'vitest';
import { needsModel, welcomeProvider } from './welcome-provider';

describe('the start page provider when nothing is picked', () => {
  it('the last one used, while still usable', () => {
    expect(welcomeProvider({ last: 'p1', def: 'p2', loggedIn: true, usable: ['p1', 'p2'] })).toBe('p1');
    expect(welcomeProvider({ last: 'gone', def: 'p2', loggedIn: true, usable: ['p2'] })).toBe('p2');
  });
  it('the default, then the account', () => {
    expect(welcomeProvider({ last: null, def: 'p2', usable: ['p1', 'p2'] })).toBe('p2');
    expect(welcomeProvider({ last: null, usable: ['p1'] })).toBe('claude'); // login not known yet: the account
    expect(welcomeProvider({ last: null, loggedIn: true, usable: ['p1'] })).toBe('claude');
  });
  it('logged out with a provider to use: never the account (it would answer 「Not logged in」)', () => {
    expect(welcomeProvider({ last: 'claude', loggedIn: false, usable: ['p1', 'p2'] })).toBe('p1');
    expect(welcomeProvider({ last: null, loggedIn: false, usable: ['p1'] })).toBe('p1');
    expect(welcomeProvider({ last: 'claude', loggedIn: true, def: 'p1', usable: ['p1'] })).toBe('claude'); // picked last time, still fine
    expect(welcomeProvider({ last: null, loggedIn: false, usable: [] })).toBe('claude'); // nothing else: the send asks for a model
  });
  it('a send needs a model first only on the logged-out account', () => {
    expect(needsModel({ provider: 'claude', foreignAgent: false, loggedIn: false })).toBe(true);
    expect(needsModel({ provider: 'claude', foreignAgent: false })).toBe(false); // not known: let it go
    expect(needsModel({ provider: 'p1', foreignAgent: false, loggedIn: false })).toBe(false);
    expect(needsModel({ provider: 'claude', foreignAgent: true, loggedIn: false })).toBe(false); // Codex's own login
  });
});
