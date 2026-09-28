import { describe, expect, it } from 'vitest';
import { cacheParentFor } from './cache-key.js';

describe('cacheParentFor (prompt-cache route key of an opened session)', () => {
  const recorded: Record<string, string> = { 'fork-1': 'root' };
  const rec = (id: string) => recorded[id];
  it('a new session / a plain resume of a session with no record: its own id (undefined = the runner uses its id)', () => {
    expect(cacheParentFor({})).toBeUndefined();
    expect(cacheParentFor({ sessionId: 's1' }, rec)).toBeUndefined();
  });
  it('a fork routes under its parent — the prefix is the parent\'s', () => {
    expect(cacheParentFor({ sessionId: 'root', fork: true }, rec)).toBe('root');
    expect(cacheParentFor({ sessionId: 'root', resumeAt: 'u1' }, rec)).toBe('root');
  });
  it('a fork of a fork keeps the root; a fork reopened later keeps the key it was created with', () => {
    expect(cacheParentFor({ sessionId: 'fork-1', fork: true }, rec)).toBe('root');
    expect(cacheParentFor({ sessionId: 'fork-1' }, rec)).toBe('root');
  });
  it('an explicit cacheParentId wins', () => {
    expect(cacheParentFor({ sessionId: 'fork-1', cacheParentId: 'x' }, rec)).toBe('x');
  });
});
