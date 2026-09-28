import { describe, expect, it } from 'vitest';
import { isAuthAnswer } from './auth';

describe('which config.auth replies update the account row (re-review N1)', () => {
  it('a boolean loggedIn is an answer — signed in or not', () => {
    expect(isAuthAnswer({ loggedIn: true, email: 'a@example.invalid' })).toBe(true);
    expect(isAuthAnswer({ loggedIn: false })).toBe(true);
  });
  it('nothing else is: an empty reply, an engine error, a malformed value', () => {
    expect(isAuthAnswer(null)).toBe(false);
    expect(isAuthAnswer(undefined)).toBe(false);
    expect(isAuthAnswer({})).toBe(false);
    expect(isAuthAnswer({ error: 'spawn ENOENT' })).toBe(false);
    expect(isAuthAnswer({ loggedIn: 'yes' })).toBe(false);
    expect(isAuthAnswer('logged in')).toBe(false);
  });
});
