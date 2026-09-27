import { describe, expect, it, vi } from 'vitest';

/** Every query() the runner starts, with a handle to end its message stream. */
const queries: { options: any; end: () => void; fail: (e: Error) => void }[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: any }) => {
    let finish: (r: IteratorResult<any>) => void = () => {};
    let reject: (e: Error) => void = () => {};
    const done = new Promise<IteratorResult<any>>((res, rej) => { finish = res; reject = rej; });
    const q: any = {
      initializationResult: async () => ({}),
      supportedCommands: async () => [],
      supportedModels: async () => [],
      supportedAgents: async () => [],
      mcpServerStatus: async () => [],
      [Symbol.asyncIterator]: () => ({ next: () => done }),
      return: async () => { finish({ value: undefined, done: true }); return { value: undefined, done: true }; },
      setModel: async () => { throw new Error('unsupported'); },
      interrupt: async () => {},
    };
    queries.push({ options, end: () => finish({ value: undefined, done: true }), fail: (e) => reject(e) });
    return q;
  },
}));
vi.mock('../claude-exe.js', () => ({ resolveEngine: () => ({ file: 'claude', kind: 'claude' }), spawnClaude: () => null }));
vi.mock('../memory/launcher.js', () => ({ claudeMcpServer: () => ({}) }));

const { SessionRunner } = await import('./session-runner.js');
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('SessionRunner', () => {
  it('respawn keeps the session alive and re-applies feature flags / worktree', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'a', cwd: '/x', features: { chrome: true }, worktree: 'wt' } as any);
    const states: string[] = [];
    r.on('state', (s) => states.push(s));
    await tick();
    await r.setModel('opus'); // setModel fails → respawn
    await tick();
    expect(queries).toHaveLength(2);
    expect(queries[1].options.extraArgs).toEqual({ chrome: null, worktree: 'wt' });
    // the old query ending must not be reported as the session closing
    expect(states).not.toContain('closed');
    expect(r.state).toBe('idle');
    await r.close();
  });

  it('refuses to send into a dead query instead of hanging in "running"', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'b', cwd: '/x' } as any);
    await tick();
    queries[0].fail(new Error('process exited with code 1'));
    await tick();
    expect(r.state).toBe('error');
    expect(() => r.send('hi')).toThrow(/error/);
    expect(r.state).toBe('error');
    await r.close();
  });

  it('a permission request whose signal is already aborted resolves immediately', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'c', cwd: '/x' } as any);
    const ac = new AbortController();
    ac.abort();
    const res = await queries[0].options.canUseTool('Bash', { command: 'ls' }, { signal: ac.signal });
    expect(res.behavior).toBe('deny');
    expect(r.getPendingPermissions()).toHaveLength(0);
    await r.close();
  });
});
