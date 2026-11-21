import { describe, expect, it } from 'vitest';
import { needsModel, startPick, welcomeProvider } from './welcome-provider';

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

// 2026-11-21 (packaged build, nine relays, no Claude login): the sidebar's ＋ opened the conversation with nothing and
// the server put it on the account — startPick is the start page's choice for every other way in
describe('a new conversation opened anywhere starts where the start page would (startPick)', () => {
  const base = { agents: ['claude', 'codex'], usable: ['p1', 'p2'], usableFor: (_agent: string, id: string) => id === 'cx' };
  const last = (provider: string | null, model: string | null = null, agent: string | null = null) => ({ provider, model, agent });
  it('relays only, logged out: the relay used last with its model — never the account', () => {
    expect(startPick({ ...base, last: last('p2', 'm2', 'claude'), loggedIn: false })).toEqual({ providerId: 'p2', model: 'm2' });
    // nothing remembered (the desktop app's storage is new on every start): the default, else the first usable one
    expect(startPick({ ...base, last: last(null), loggedIn: false, def: 'p2' })).toEqual({ providerId: 'p2' });
    expect(startPick({ ...base, last: last(null), loggedIn: false })).toEqual({ providerId: 'p1' });
  });
  it('logged in with the account picked last: still the account (over a default), with its model', () => {
    expect(startPick({ ...base, last: last('claude', 'opus', 'claude'), loggedIn: true, def: 'p1' })).toEqual({ providerId: 'claude', model: 'opus' });
    expect(startPick({ ...base, last: last('claude', '', 'claude'), loggedIn: true })).toEqual({ providerId: 'claude' });
  });
  it('another provider than the one remembered starts on its own default model (never the old model id)', () => {
    expect(startPick({ ...base, last: last('gone', 'm9', 'claude'), loggedIn: true, def: 'p1' })).toEqual({ providerId: 'p1' });
    expect(startPick({ ...base, last: last('claude', 'opus', 'claude'), loggedIn: false })).toEqual({ providerId: 'p1' });
  });
  it('nothing usable while logged out: the account — which is where the caller asks for a model', () => {
    const p = startPick({ ...base, usable: [], last: last('p1', 'm1'), loggedIn: false });
    expect(p).toEqual({ providerId: 'claude' });
    expect(needsModel({ provider: p.providerId, foreignAgent: false, loggedIn: false })).toBe(true);
  });
  it('another agent started last: that agent, on its provider while it can use it, else its own login', () => {
    expect(startPick({ ...base, last: last('cx', 'gpt-x', 'codex'), loggedIn: false })).toEqual({ providerId: 'cx', model: 'gpt-x', agent: 'codex' });
    expect(startPick({ ...base, last: last('claude', 'gpt-y', 'codex'), loggedIn: false })).toEqual({ providerId: 'claude', model: 'gpt-y', agent: 'codex' });
    expect(startPick({ ...base, last: last('p1', 'gpt-x', 'codex') })).toEqual({ providerId: 'claude', agent: 'codex' }); // p1 is not one it can use
    // an agent this machine does not have: Claude, and never that agent's model
    expect(startPick({ ...base, agents: ['claude'], last: last('p1', 'gpt-x', 'codex'), loggedIn: true })).toEqual({ providerId: 'p1' });
  });
});
