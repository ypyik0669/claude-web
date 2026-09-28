import { describe, expect, it } from 'vitest';
import { busyInCheckout, liveSessions, normPath } from './branch-guard';

describe('switching the welcome page\'s branch asks first when conversations work in that checkout (review 3 #2)', () => {
  const root = 'C:/work/todo-api';
  it('running / waiting / starting conversations in the root or below count; idle ones and other repos do not', () => {
    expect(busyInCheckout(root, [
      { cwd: 'C:\\work\\todo-api', state: 'running' },
      { cwd: 'c:\\WORK\\todo-api\\packages\\x', state: 'waiting' },
      { cwd: 'C:/work/todo-api', state: 'starting' },
      { cwd: 'C:/work/todo-api', state: 'idle' },
      { cwd: 'C:/work/todo-api', state: 'history' },
      { cwd: 'C:/work/todo-api' },
      { cwd: 'C:/work/todo-api-2', state: 'running' }, // a sibling with the same prefix
      { cwd: 'C:/work/other', state: 'running' },
    ])).toBe(3);
  });
  it('a Claude Code worktree under the root is its own checkout', () => {
    expect(busyInCheckout(root, [{ cwd: 'C:/work/todo-api/.claude/worktrees/task-1', state: 'running' }])).toBe(0);
  });
  it('no repo → nothing to guard', () => {
    expect(busyInCheckout(null, [{ cwd: 'C:/x', state: 'running' }])).toBe(0);
  });
  it('normPath', () => expect(normPath('C:\\A\\b\\')).toBe('c:/a/b'));

  it('liveSessions: the server list (runners in other windows / IM / schedules) overlaid with this window, remote ones left out', () => {
    const list = [
      { sessionId: 'a', cwd: 'C:/r', live: 'running' },
      { sessionId: 'b', cwd: 'C:/r', live: 'idle' },
      { sessionId: 'peer_x~c', cwd: 'C:/r', live: 'running', peer: { id: 'x' } },
    ];
    const open = { b: { cwd: 'C:/r', state: 'running' }, d: { cwd: 'C:/r', state: 'starting' }, 'peer_x~e': { cwd: 'C:/r', state: 'running' } };
    const users = liveSessions(list, open);
    expect(users).toHaveLength(3);
    expect(busyInCheckout('C:/r', users)).toBe(3); // a (another window), b (this window is fresher), d (not listed yet)
  });
});
