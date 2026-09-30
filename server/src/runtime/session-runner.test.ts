import { describe, expect, it, vi } from 'vitest';

/** Every query() the runner starts: end / fail its message stream, push a message into it, react to interrupt(). */
interface FakeQuery { options: any; end: () => void; fail: (e: Error) => void; push: (m: any) => void; onInterrupt?: () => void }
const queries: FakeQuery[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: any }) => {
    const buf: any[] = [];
    let ended = false;
    let err: Error | null = null;
    let waiter: { res: (r: IteratorResult<any>) => void; rej: (e: Error) => void } | null = null;
    const settle = () => {
      if (!waiter) return;
      const w = waiter;
      if (err) { waiter = null; w.rej(err); } else if (buf.length) { waiter = null; w.res({ value: buf.shift(), done: false }); } else if (ended) { waiter = null; w.res({ value: undefined, done: true }); }
    };
    const next = () => new Promise<IteratorResult<any>>((res, rej) => { waiter = { res, rej }; settle(); });
    const h: FakeQuery = { options, end: () => { ended = true; settle(); }, fail: (e) => { err = e; settle(); }, push: (m) => { buf.push(m); settle(); } };
    const q: any = {
      initializationResult: async () => ({}),
      supportedCommands: async () => [],
      supportedModels: async () => [],
      supportedAgents: async () => [],
      mcpServerStatus: async () => [],
      [Symbol.asyncIterator]: () => ({ next }),
      return: async () => { h.end(); return { value: undefined, done: true }; },
      setModel: async () => { throw new Error('unsupported'); },
      interrupt: async () => { h.onInterrupt?.(); },
    };
    queries.push(h);
    return q;
  },
}));
const eng = vi.hoisted(() => ({ kind: 'claude' as 'claude' | 'ccb' }));
vi.mock('../claude-exe.js', () => ({ resolveEngine: () => ({ file: 'claude', kind: eng.kind }), spawnClaude: () => null }));
vi.mock('../memory/launcher.js', () => ({ claudeMcpServer: () => ({}) }));

const { SessionRunner } = await import('./session-runner.js');
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('SessionRunner', () => {
  it('a claude.ai-login session on ccb resolves models like the official Claude Code; other sessions are untouched', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const a = new SessionRunner({ sessionId: 'm1', cwd: '/x', model: 'fable' } as any);
      await tick();
      expect(queries[0].options.model).toBe('claude-fable-5-1'); // ccb has no fable alias
      expect(queries[0].options.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-5-5');
      expect(queries[0].options.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-5');
      expect(queries[0].options.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
      expect(a.info.model).toBe('fable'); // the chip keeps what the user picked
      await a.close();
      // no model: nothing passed — ccb's default follows the opus variable
      const b = new SessionRunner({ sessionId: 'm2', cwd: '/x' } as any);
      await tick();
      expect(queries[1].options.model).toBeUndefined();
      expect(queries[1].options.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-5-5');
      await b.close();
      // the user's own variable wins
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-4-8';
      try {
        const c = new SessionRunner({ sessionId: 'm3', cwd: '/x', model: 'opus' } as any);
        await tick();
        expect(queries[2].options.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-8');
        expect(queries[2].options.model).toBe('opus');
        await c.close();
      } finally {
        delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      }
      // a provider session keeps its provider's mapping
      const d = new SessionRunner({ sessionId: 'm4', cwd: '/x' } as any, { id: 'p1', name: 'relay', type: 'anthropic', baseUrl: 'https://relay.invalid', apiKey: 'k', models: [] } as any);
      await tick();
      expect(queries[3].options.env.ANTHROPIC_DEFAULT_OPUS_MODEL).not.toBe('claude-opus-5-5');
      await d.close();
      // the official binary resolves its own aliases
      eng.kind = 'claude';
      const e = new SessionRunner({ sessionId: 'm5', cwd: '/x', model: 'fable' } as any);
      await tick();
      expect(queries[4].options.model).toBe('fable');
      expect(queries[4].options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
      await e.close();
    } finally {
      eng.kind = 'claude';
    }
  });

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

describe('SessionRunner prompt-cache routing (cache shim)', () => {
  const prov = { id: 'ds', name: 'DS', type: 'openai', baseUrl: 'https://relay/v1', apiKey: 'sk', createdAt: 0, shim: { base: 'http://127.0.0.1:9/gateway/~p/ds', key: 'cws-x' } } as any;
  const baseOf = (i: number) => queries[i].options.env.OPENAI_BASE_URL as string;
  it('a new session keys the cache on its own id', async () => {
    queries.length = 0;
    const r = new SessionRunner({ cwd: '/x' } as any, prov);
    await tick();
    expect(baseOf(0)).toBe(`http://127.0.0.1:9/gateway/~p/ds/k/${r.sessionId}/v1`);
    await r.close();
  });
  it('a hub fork (new id up front, cacheParentId = parent) routes on the parent and logs under its own id; a respawn keeps both', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'fork-1', cacheParentId: 'parent-1', cwd: '/x' } as any, prov);
    await tick();
    expect(baseOf(0)).toBe('http://127.0.0.1:9/gateway/~p/ds/k/parent-1/s/fork-1/v1');
    await r.setModel('m2'); // → respawn
    await tick();
    expect(baseOf(1)).toBe('http://127.0.0.1:9/gateway/~p/ds/k/parent-1/s/fork-1/v1');
    await r.close();
  });
  it('an SDK fork (id only known at init) routes on the parent and does not name a placeholder id', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'parent-2', fork: true, cwd: '/x' } as any, prov);
    await tick();
    expect(baseOf(0)).toBe('http://127.0.0.1:9/gateway/~p/ds/k/parent-2/v1');
    await r.close();
  });
});

describe('SessionRunner Stop (interrupt)', () => {
  const result = (extra: any = {}) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: 's', uuid: 'r1', ...extra });
  const collect = (r: any) => { const msgs: any[] = []; r.on('message', (m: any) => msgs.push(m)); return msgs; };

  it('a CLI that ends the turn itself is not touched', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'stop-1', cwd: '/x' } as any);
    await tick();
    const msgs = collect(r);
    r.send('hi');
    queries[0].onInterrupt = () => queries[0].push(result());
    await r.interrupt();
    expect(msgs.filter((m) => m.type === 'result')).toHaveLength(1);
    expect(msgs[0].terminal_reason).toBeUndefined(); // the CLI's own result, not ours
    expect(queries).toHaveLength(1); // no respawn
    expect(r.state).toBe('idle');
    await r.close();
  });

  it('a CLI that does not unwind: the turn is ended here and the process restarted on the same conversation', async () => {
    queries.length = 0;
    const grace = SessionRunner.STOP_GRACE_MS;
    SessionRunner.STOP_GRACE_MS = 40;
    try {
      const r = new SessionRunner({ sessionId: 'stop-2', cwd: '/x' } as any);
      await tick();
      const msgs = collect(r);
      r.send('hi'); // the fake never answers, and interrupt() changes nothing
      await r.interrupt();
      const results = msgs.filter((m) => m.type === 'result');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'aborted_forced', session_id: 'stop-2' });
      expect(String(results[0].result)).toMatch(/强制/);
      expect(queries).toHaveLength(2);
      expect(queries[1].options.resume).toBe('stop-2');
      // the old process's late output no longer reaches the conversation
      queries[0].push(result({ uuid: 'late' }));
      await tick();
      expect(msgs.some((m) => m.uuid === 'late')).toBe(false);
      await r.close();
    } finally {
      SessionRunner.STOP_GRACE_MS = grace;
    }
  });

  it('Stop on an idle conversation neither waits nor restarts anything', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'stop-3', cwd: '/x' } as any);
    await tick();
    const t = Date.now();
    await r.interrupt();
    expect(Date.now() - t).toBeLessThan(500);
    expect(queries).toHaveLength(1);
    await r.close();
  });
});

describe('SessionRunner env: a local endpoint bypasses the system proxy', () => {
  it('NO_PROXY / no_proxy get the loopback hosts when the base URL is local, keeping what the user had', async () => {
    queries.length = 0;
    const prov = { id: 'ds', name: 'DS', type: 'openai', baseUrl: 'https://relay/v1', apiKey: 'sk', createdAt: 0, shim: { base: 'http://127.0.0.1:9/gateway/~p/ds', key: 'cws-x' } } as any;
    process.env.HTTPS_PROXY = 'http://proxy.invalid:7890';
    process.env.NO_PROXY = 'corp.example';
    try {
      const r = new SessionRunner({ cwd: '/x' } as any, prov);
      await tick();
      const env = queries[0].options.env;
      for (const k of ['NO_PROXY', 'no_proxy']) {
        const hosts = String(env[k]).split(',');
        expect(hosts).toEqual(expect.arrayContaining(['corp.example', '127.0.0.1', 'localhost', '::1']));
      }
      await r.close();
    } finally {
      delete process.env.HTTPS_PROXY;
      delete process.env.NO_PROXY;
    }
  });
});
