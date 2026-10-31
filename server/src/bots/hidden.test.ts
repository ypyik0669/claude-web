import { describe, it, expect } from 'vitest';
import { GENERATOR_PREFIX, isBotSession, refuseOnThread } from './hidden.js';

describe('isBotSession: what stays out of the conversation lists', () => {
  it('a conversation recorded as a bot’s (its thread, a run, internal work) is hidden', () => {
    expect(isBotSession({ botRole: 'thread', botId: 'b1' })).toBe(true);
    expect(isBotSession({ botRole: 'internal' })).toBe(true);
    expect(isBotSession({ botId: 'b1' })).toBe(true);
  });
  it('a phase-1 generator conversation, known only by its first prompt or title, is hidden', () => {
    expect(isBotSession({}, { firstPrompt: `${GENERATOR_PREFIX}。只输出一个 json`, title: 'x' })).toBe(true);
    expect(isBotSession(undefined, { title: `${GENERATOR_PREFIX}…` })).toBe(true);
  });
  it('a normal conversation is shown', () => {
    expect(isBotSession({}, { firstPrompt: '帮我看看这个 bug', title: '修 bug' })).toBe(false);
    expect(isBotSession(undefined)).toBe(false);
    expect(isBotSession({ chatOnly: true }, { title: '' })).toBe(false);
  });
});

describe('refuseOnThread: a bot thread keeps its provider, agent and machine', () => {
  const isThread = (id: string) => id === 't1';
  it('setProvider / switchAgent / handoff.start on a thread are refused', () => {
    for (const kind of ['session.setProvider', 'session.switchAgent', 'handoff.start']) expect(() => refuseOnThread({ kind, sessionId: 't1' }, isThread), kind).toThrow(/Bot/);
  });
  it('the same on another conversation, or anything else on a thread, goes on', () => {
    expect(() => refuseOnThread({ kind: 'session.setProvider', sessionId: 's2' }, isThread)).not.toThrow();
    expect(() => refuseOnThread({ kind: 'session.send', sessionId: 't1' }, isThread)).not.toThrow();
  });
  it('a fork / rewind of a thread (session.open fork / resumeAt, library.fork) is refused: the copy would run ungated', () => {
    expect(() => refuseOnThread({ kind: 'session.open', params: { sessionId: 't1', fork: true } }, isThread)).toThrow(/Bot/);
    expect(() => refuseOnThread({ kind: 'session.open', params: { sessionId: 't1', resumeAt: 'u1' } }, isThread)).toThrow(/Bot/);
    expect(() => refuseOnThread({ kind: 'library.fork', sessionId: 't1' }, isThread)).toThrow(/Bot/);
  });
  it('a plain open of a thread, or a fork of another conversation, goes on', () => {
    expect(() => refuseOnThread({ kind: 'session.open', params: { sessionId: 't1' } }, isThread)).not.toThrow();
    expect(() => refuseOnThread({ kind: 'session.open', params: { sessionId: 's2', fork: true } }, isThread)).not.toThrow();
    expect(() => refuseOnThread({ kind: 'library.fork', sessionId: 's2' }, isThread)).not.toThrow();
  });
});
