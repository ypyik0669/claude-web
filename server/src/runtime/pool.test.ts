import { describe, expect, it, vi } from 'vitest';

// A stand-in runner: no child process, state driven by the test.
vi.mock('./session-runner.js', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeRunner extends EventEmitter {
    id: string;
    sessionId: string;
    state = 'starting';
    cwd: string;
    info: any;
    lastActivity = Date.now();
    closeCalls = 0;
    params: any;
    constructor(params: any) {
      super();
      this.id = this.sessionId = params.sessionId ?? `new-${Math.random()}`;
      this.cwd = params.cwd;
      this.params = params;
      this.info = { sessionId: this.sessionId };
    }
    setState(s: string) {
      this.state = s;
      this.emit('state', s);
    }
    getHistory() { return []; }
    getPendingPermissions() { return []; }
    async close() {
      this.closeCalls++;
      await new Promise((r) => setTimeout(r, 5));
      this.setState('closed');
    }
  }
  return { SessionRunner: FakeRunner };
});

// other agents: no process either
vi.mock('../agents/acp-driver.js', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeAcp extends EventEmitter {
    id: string; sessionId: string; state = 'starting'; info: any; lastActivity = Date.now();
    constructor(kind: string, _launch: unknown, params: any) { super(); this.id = this.sessionId = params.sessionId ?? `acp-${Math.random()}`; this.info = { sessionId: this.sessionId, agent: kind }; }
    getHistory() { return []; }
    getPendingPermissions() { return []; }
    async close() { this.state = 'closed'; }
  }
  return { AcpDriver: FakeAcp };
});

const { RunnerPool, idleTtlFor, MAX_IDLE_CLAUDE } = await import('./pool.js');

const pool = () => new RunnerPool({ forSession: () => undefined } as any);

describe('RunnerPool', () => {
  it('a closing runner does not evict the runner that replaced it', async () => {
    const p = pool();
    const a: any = p.open({ sessionId: 's1', cwd: '/x' });
    const closing = p.close('s1');
    // reopened while the old process is still shutting down
    const b: any = p.open({ sessionId: 's1', cwd: '/x' });
    expect(b).not.toBe(a);
    await closing;
    expect(p.get('s1')).toBe(b);
  });

  it('does not broadcast the replaced runner\'s shutdown as the new runner\'s state', async () => {
    const p = pool();
    const states: string[] = [];
    p.on('state', (_sid: string, s: string) => states.push(s));
    const a: any = p.open({ sessionId: 's2', cwd: '/x' });
    a.setState('error');
    const b: any = p.open({ sessionId: 's2', cwd: '/x' });
    expect(b).not.toBe(a);
    expect(a.closeCalls).toBe(1); // the errored runner is cleaned up
    await new Promise((r) => setTimeout(r, 20));
    expect(states).toEqual(['error']);
    expect(p.get('s2')).toBe(b);
  });

  it('drops a runner re-keyed by init when it closes', () => {
    const p = pool();
    const a: any = p.open({ cwd: '/x' });
    a.sessionId = 'real-id';
    a.emit('info', { sessionId: 'real-id' });
    expect(p.get('real-id')).toBe(a);
    a.setState('closed');
    expect(p.get('real-id')).toBeUndefined();
  });

  it('idle TTL follows the profile\'s cache retention: long-retention providers keep the process (a resume rebuilds the prompt prefix)', () => {
    const MIN = 60_000;
    expect(idleTtlFor(undefined)).toBe(30 * MIN);
    expect(idleTtlFor({ type: 'openai' } as any)).toBe(120 * MIN);
    expect(idleTtlFor({ type: 'grok' } as any)).toBe(120 * MIN);
    expect(idleTtlFor({ type: 'gemini' } as any)).toBe(30 * MIN);
    expect(idleTtlFor({ type: 'gateway' } as any)).toBe(30 * MIN);
    expect(idleTtlFor({ type: 'anthropic' } as any)).toBe(30 * MIN);
    expect(idleTtlFor({ type: 'anthropic', cache1h: true } as any)).toBe(65 * MIN);
    // the long TTL is part of the cache optimisation: a profile that switched the shim off is back to 30 min
    expect(idleTtlFor({ type: 'openai', cacheShim: false } as any)).toBe(30 * MIN);
    expect(idleTtlFor({ type: 'grok', cacheShim: false } as any)).toBe(30 * MIN);
  });

  it('at most MAX_IDLE_CLAUDE idle Claude processes: beyond that the least recently used go first', () => {
    const p = pool();
    const now = Date.now();
    const rs: any[] = [];
    for (let i = 0; i < MAX_IDLE_CLAUDE + 3; i++) {
      const r: any = p.open({ sessionId: `cap-${i}`, cwd: '/x' });
      r.state = 'idle';
      r.lastActivity = now - (100 - i) * 1000; // cap-0 is the oldest
      rs.push(r);
    }
    const busy: any = p.open({ sessionId: 'cap-busy', cwd: '/x' });
    busy.state = 'running';
    busy.lastActivity = now - 999_000; // running ones never count / never go
    (p as any).reap();
    expect(rs.filter((r) => r.closeCalls).map((r) => r.sessionId)).toEqual(['cap-0', 'cap-1', 'cap-2']);
    expect(busy.closeCalls).toBe(0);
  });

  it('the reaper uses the per-session TTL', () => {
    const p = new RunnerPool({ forSession: (id?: string) => (id === 'oai' ? { type: 'openai' } : undefined) } as any);
    const long: any = p.open({ sessionId: 'long', cwd: '/x', providerId: 'oai' });
    const plain: any = p.open({ sessionId: 'plain', cwd: '/x' });
    for (const r of [long, plain]) { r.state = 'idle'; r.lastActivity = Date.now() - 45 * 60_000; }
    (p as any).reap();
    expect(plain.closeCalls).toBe(1);
    expect(long.closeCalls).toBe(0);
  });

  it('closeAll survives a runner whose close rejects', async () => {
    const p = pool();
    const a: any = p.open({ sessionId: 's3', cwd: '/x' });
    const b: any = p.open({ sessionId: 's4', cwd: '/x' });
    a.close = async () => { throw new Error('boom'); };
    await expect(p.closeAll()).resolves.toBeUndefined();
    expect(b.closeCalls).toBe(1);
  });
});

describe('RunnerPool: prompt-cache key of a reopened session', () => {
  it('a session reopened from anywhere (goals, IM, schedules, hot switch) keeps the key recorded for it', () => {
    const recorded: Record<string, any> = { 'fork-1': { cacheKey: 'root' } };
    const p = new RunnerPool({ forSession: () => undefined, meta: { sessionMeta: (id: string) => recorded[id] ?? {} } } as any);
    expect((p.open({ sessionId: 'fork-1', cwd: 'C:/x' }) as any).params.cacheParentId).toBe('root');
    expect((p.open({ sessionId: 'plain', cwd: 'C:/x' }) as any).params.cacheParentId).toBeUndefined();
    expect((p.open({ sessionId: 'other', cwd: 'C:/x', cacheParentId: 'explicit' }) as any).params.cacheParentId).toBe('explicit');
  });
});

describe('RunnerPool: the provider when the caller does not name one (IM, schedules, goals, hand-overs)', () => {
  const setup = (o: { recorded?: Record<string, any>; settings?: Record<string, unknown>; agents?: Record<string, any>; providers?: Record<string, { type: string }> } = {}) => {
    const recorded: Record<string, any> = { ...(o.recorded ?? {}) };
    const writes: [string, any][] = [];
    const providers = o.providers ?? { relay: { type: 'openai' }, claudeRelay: { type: 'anthropic' } };
    const meta = {
      sessionMeta: (id: string) => recorded[id] ?? {},
      setSessionMeta: async (id: string, patch: any) => { writes.push([id, patch]); recorded[id] = { ...recorded[id], ...patch }; },
      settings: () => o.settings ?? {},
      provider: (id: string) => (providers[id] ? { id, name: `P-${id}`, ...providers[id] } : undefined),
    };
    // the table the server really uses: Codex takes openai / gateway, Claude everything
    const fitError = (id: string | undefined, agent: string) => (!id || id === 'claude' ? null : !providers[id] ? 'missing' : agent === 'codex' && providers[id].type !== 'openai' ? 'unfit' : null);
    const agents = { config: (k: string) => o.agents?.[k] ?? {}, launch: () => ({ command: 'x', args: [], env: {}, def: { name: 'X', protocol: 'acp', login: '' } }) };
    const seen: (string | undefined)[] = [];
    const p = new RunnerPool({ forSession: (id: string | undefined) => { seen.push(id); return undefined; }, fitError, meta, agentLaunch: () => ({ env: {}, args: [] }) } as any, agents as any);
    return { p, seen, writes, recorded };
  };

  it('a new Claude session gets the default provider (settings → 供应商 「设为默认」), and it is recorded', () => {
    const { p, seen, writes } = setup({ settings: { defaultProviderId: 'relay' } });
    const r: any = p.open({ cwd: 'C:/x' });
    expect(seen).toEqual(['relay']);
    expect(writes).toEqual([[r.sessionId, { providerId: 'relay' }]]);
  });

  it('no default, or one that no longer exists / cannot be used: the account, nothing recorded', () => {
    for (const settings of [{}, { defaultProviderId: 'gone' }]) {
      const { p, seen, writes } = setup({ settings });
      p.open({ cwd: 'C:/x' });
      expect(seen).toEqual([undefined]);
      expect(writes).toEqual([]);
    }
  });

  it('a resume keeps the provider it was recorded with, whatever the default is now', () => {
    const { p, seen, writes } = setup({ recorded: { s1: { providerId: 'claudeRelay' } }, settings: { defaultProviderId: 'relay' } });
    p.open({ sessionId: 's1', cwd: 'C:/x' });
    expect(seen).toEqual(['claudeRelay']);
    expect(writes).toEqual([]);
  });

  it('a resume with nothing recorded stays on the account (the default is for new conversations)', () => {
    const { p, seen } = setup({ settings: { defaultProviderId: 'relay' } });
    p.open({ sessionId: 'old', cwd: 'C:/x' });
    expect(seen).toEqual([undefined]);
  });

  it('…unless the account is known to be logged out: then the default provider, recorded (it failed "Not logged in")', () => {
    const { p, seen, writes } = setup({ settings: { defaultProviderId: 'claudeRelay' } });
    p.accountLoggedOut = () => true;
    p.open({ sessionId: 'cli-made', cwd: 'C:/x' });
    expect(seen).toEqual(['claudeRelay']);
    expect(writes).toEqual([['cli-made', { providerId: 'claudeRelay' }]]);
  });

  it('an explicit provider always wins — the account included', () => {
    const { p, seen, writes } = setup({ settings: { defaultProviderId: 'relay' }, recorded: { s1: { providerId: 'relay' } } });
    p.open({ cwd: 'C:/x', providerId: 'claude' });
    p.open({ sessionId: 's1', cwd: 'C:/x', providerId: 'claudeRelay' });
    expect(seen).toEqual(['claude', 'claudeRelay']);
    expect(writes).toEqual([]); // the caller (hub, swap) records what it asked for
  });

  it('another agent: its own 「用哪个供应商」 (settings → Agents), never Claude\'s default; a provider it cannot use is ignored', () => {
    const launches: (string | undefined)[] = [];
    const mk = (agents: Record<string, any>) => {
      const s = setup({ settings: { defaultProviderId: 'claudeRelay' }, agents });
      (s.p as any).providers.agentLaunch = (id: string | undefined) => { launches.push(id); return { env: {}, args: [] }; };
      (s.p as any).transcripts = {};
      return s;
    };
    const a = mk({ codex: { providerId: 'relay' } });
    const r: any = a.p.open({ cwd: 'C:/x', agent: 'codex' });
    expect(launches.pop()).toBe('relay');
    expect(r.info).toMatchObject({ providerId: 'relay', providerName: 'P-relay' });
    expect(a.writes).toEqual([[r.sessionId, { providerId: 'relay' }]]);
    mk({}).p.open({ cwd: 'C:/x', agent: 'codex' });
    expect(launches.pop()).toBeUndefined(); // its own login, not Claude's default
    mk({ codex: { providerId: 'claudeRelay' } }).p.open({ cwd: 'C:/x', agent: 'codex' });
    expect(launches.pop()).toBeUndefined();
  });

  it('a session handed to an agent that cannot use its recorded provider gets that agent\'s default', () => {
    const s = setup({ recorded: { s1: { providerId: 'claudeRelay' } }, agents: { codex: { providerId: 'relay' } } });
    const launches: (string | undefined)[] = [];
    (s.p as any).providers.agentLaunch = (id: string | undefined) => { launches.push(id); return { env: {}, args: [] }; };
    (s.p as any).transcripts = {};
    s.p.open({ sessionId: 's1', cwd: 'C:/x', agent: 'codex' });
    expect(launches).toEqual(['relay']);
    expect(s.recorded.s1.providerId).toBe('relay');
    expect(s.p.defaultProviderFor('codex')).toBe('relay');
    expect(s.p.defaultProviderFor('claude')).toBeUndefined();
  });
});
