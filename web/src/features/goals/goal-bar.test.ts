import { describe, expect, it } from 'vitest';
import type { Goal } from '@shared';
import { goalBarFor } from './goal-bar';

const goal = (p: Partial<Goal>): Goal => ({ id: 'g', objective: '把 README 翻成英文', spec: '', cwd: '/w', status: 'active', turnsExecuted: 2, maxTurns: 50, tokensUsed: 0, tokenBudget: null, createdAt: 1, updatedAt: 1, steps: [], evidence: [], ...p });

describe('goalBarFor (the thin bar on top of a conversation a goal is driving)', () => {
  it('the active goal bound to this conversation, on the round it is working on', () => {
    expect(goalBarFor([goal({ sessionId: 's1' })], 's1')).toEqual({ id: 'g', objective: '把 README 翻成英文', round: 3, maxTurns: 50 });
  });
  it('nothing for other conversations, and nothing once the goal stopped', () => {
    expect(goalBarFor([goal({ sessionId: 's2' })], 's1')).toBeNull();
    for (const status of ['draft', 'paused', 'complete', 'blocked', 'max_turns'] as const) expect(goalBarFor([goal({ sessionId: 's1', status })], 's1')).toBeNull();
    expect(goalBarFor([], 's1')).toBeNull();
    expect(goalBarFor([goal({ sessionId: 's1' })], '')).toBeNull();
  });
  it('two active goals on one conversation → the newest', () => {
    const a = goal({ id: 'a', sessionId: 's1', updatedAt: 10, objective: 'old' });
    const b = goal({ id: 'b', sessionId: 's1', updatedAt: 20, objective: 'new', turnsExecuted: 0 });
    expect(goalBarFor([a, b], 's1')).toMatchObject({ id: 'b', round: 1 });
  });
});
