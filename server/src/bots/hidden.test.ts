import { describe, it, expect } from 'vitest';
import { GENERATOR_PREFIX, isBotSession } from './hidden.js';

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
