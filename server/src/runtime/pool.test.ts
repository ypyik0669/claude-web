import { EventEmitter } from 'node:events';
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
    opts: any;
    prefs: any[] = [];
    constructor(params: any, provider?: any, opts?: any) {
      super();
      this.id = this.sessionId = params.sessionId ?? `new-${Math.random()}`;
      this.cwd = params.cwd;
      this.params = params;
      this.opts = opts;
      this.info = { sessionId: this.sessionId, providerId: provider?.id };
    }
    async setAccountPrefs(p: any) { this.prefs.push(p); }
    setState(s: string) {
      this.state = s;
      this.emit('state', s);
    }
    getHistory() { return []; }
    getPendingPermissions() { return []; }
    bg = false;
    hasBackgroundWork() { return this.bg; }
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

const { RunnerPool, idleTtlFor, MAX_IDLE_CLAUDE, ACCOUNT_PREFS_DEBOUNCE_MS } = await import('./pool.js');

const pool = () => new RunnerPool({ forSession: () => undefined } as any);

describe('RunnerPool', () => {
  it('a conversation opened in a project folder gets the project’s extra folders (stage C2); elsewhere none', () => {
    const meta = { sessionMeta: () => ({}), settings: () => ({}), setSessionMeta: async () => {}, workspaces: () => [{ id: 'w', path: '/proj', name: 'p', addedAt: 0, order: 0, folders: ['/lib'] }] };
    const p = new RunnerPool({ forSession: () => undefined, meta } as any);
    const a: any = p.open({ cwd: '/proj' });
    expect(a.opts.additionalDirectories).toEqual(['/lib']);
    const b: any = p.open({ cwd: '/proj/sub' });
    expect(b.opts.additionalDirectories ?? []).toEqual([]);
  });

  it('project instructions: a new conversation gets them and keeps them; a resumed one only what it recorded (F-minor)', () => {
    const sm: Record<string, any> = {};
    const ws = [{ id: 'w', path: '/proj', name: 'p', addedAt: 0, order: 0, instructions: 'Use pnpm.' }];
    const meta = { sessionMeta: (id: string) => sm[id] ?? {}, settings: () => ({}), setSessionMeta: async (id: string, p: any) => { sm[id] = { ...sm[id], ...p }; }, workspaces: () => ws };
    const p = new RunnerPool({ forSession: () => undefined, meta } as any);
    const a: any = p.open({ cwd: '/proj' });
    expect(a.opts.projectInstructions).toContain('Use pnpm.');
    expect(sm[a.sessionId].projectInstructions).toBe(a.opts.projectInstructions);
    // an older conversation in the project, resumed: none
    const old: any = p.open({ sessionId: 'old', cwd: '/proj' });
    expect(old.opts.projectInstructions).toBeUndefined();
    // the instructions edited: the new one, resumed, keeps what it started with
    ws[0].instructions = 'Use npm.';
    a.setState('closed');
    const again: any = p.open({ sessionId: a.sessionId, cwd: '/proj' });
    expect(again.opts.projectInstructions).toContain('Use pnpm.');
  });

  it('F4: a conversation that is read-only here (handed off) is not reopened; a fork of it is', () => {
    const p = pool();
    p.readOnly = (id) => (id === 'gone' ? 'handed off' : null);
    expect(() => p.open({ sessionId: 'gone', cwd: '/x' })).toThrow('handed off');
    expect(() => p.open({ sessionId: 'gone', cwd: '/x', resumeAt: 'u1' } as any)).toThrow('handed off');
    expect(() => p.assertWritable('gone')).toThrow('handed off');
    expect(() => p.open({ sessionId: 'gone', cwd: '/x', fork: true } as any)).not.toThrow();
    expect(() => p.open({ sessionId: 'ok', cwd: '/x' })).not.toThrow();
  });

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

  it('an idle process with background work (a workflow, a background agent) is not reaped', () => {
    const p = pool();
    const bg: any = p.open({ sessionId: 'bg', cwd: '/x' });
    const plain: any = p.open({ sessionId: 'plain-bg', cwd: '/x' });
    for (const r of [bg, plain]) { r.state = 'idle'; r.lastActivity = Date.now() - 5 * 3600_000; }
    bg.bg = true;
    (p as any).reap();
    expect(bg.closeCalls).toBe(0);
    expect(plain.closeCalls).toBe(1);
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

  it('a provider saved in settings goes to its running conversations; one it cannot build any more fails nothing', () => {
    let broken = false;
    const p = new RunnerPool({ forSession: (id?: string) => { if (broken) throw new Error('gateway off'); return { id, type: 'anthropic', v: 2 }; } } as any);
    const on: any = p.open({ sessionId: 'on', cwd: '/x', providerId: 'ds' });
    const off: any = p.open({ sessionId: 'off', cwd: '/x', providerId: 'other' });
    for (const r of [on, off]) { r.info.providerId = r.params.providerId; r.got = []; r.reprovide = async (x: any) => { r.got.push(x); }; }
    p.providerSaved('ds');
    expect(on.got).toEqual([{ id: 'ds', type: 'anthropic', v: 2 }]);
    expect(off.got).toEqual([]);
    broken = true; // the save itself went through: it must not come back as an error
    expect(() => p.providerSaved('ds')).not.toThrow();
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
    const p = new RunnerPool({ forSession: () => undefined, meta: { sessionMeta: (id: string) => recorded[id] ?? {}, settings: () => ({}) } } as any);
    expect((p.open({ sessionId: 'fork-1', cwd: 'C:/x' }) as any).params.cacheParentId).toBe('root');
    expect((p.open({ sessionId: 'plain', cwd: 'C:/x' }) as any).params.cacheParentId).toBeUndefined();
    expect((p.open({ sessionId: 'other', cwd: 'C:/x', cacheParentId: 'explicit' }) as any).params.cacheParentId).toBe('explicit');
  });
});

describe('RunnerPool: the subagents model', () => {
  const setup = (recorded: Record<string, any>, settings: Record<string, unknown>) => {
    const writes: [string, any][] = [];
    const meta = { sessionMeta: (id: string) => recorded[id] ?? {}, settings: () => settings, setSessionMeta: async (id: string, patch: any) => { writes.push([id, patch]); } };
    return { p: new RunnerPool({ forSession: () => undefined, meta } as any), writes };
  };
  it('not said: the conversation’s own pick wherever it now runs, else the default for new conversations', async () => {
    const { crossValue } = await import('../models/subagent.js');
    const { p, writes } = setup({ a: { providerId: 'relay', subagent: { providerId: 'relay', model: 'mini' } }, b: { subagent: { providerId: 'relay', model: 'mini' } } }, { subagentModels: { relay: 'cheap', claude: 'haiku' } });
    expect((p.open({ sessionId: 'a', cwd: 'C:/x', providerId: 'relay' }) as any).params.subagentModel).toBe(crossValue('relay', 'mini'));
    // moved to the account since: still relay's mini
    expect((p.open({ sessionId: 'b', cwd: 'C:/x', providerId: 'claude' }) as any).params.subagentModel).toBe(crossValue('relay', 'mini'));
    // a new one: the old per-provider default, as a whole pick
    expect((p.open({ cwd: 'C:/x', providerId: 'relay' }) as any).params.subagentModel).toBe(crossValue('relay', 'cheap'));
    // the one default for new conversations wins over the old ones
    const g = setup({}, { subagentModel: crossValue('ds', 'deepseek-chat'), subagentModels: { relay: 'cheap' } });
    expect((g.p.open({ cwd: 'C:/x', providerId: 'relay' }) as any).params.subagentModel).toBe(crossValue('ds', 'deepseek-chat'));
    expect(writes).toEqual([]);
  });
  it('said by the caller: used and remembered for the conversation as a whole pick (a new one under the id it got), not for a fork', async () => {
    const { crossValue } = await import('../models/subagent.js');
    const { p, writes } = setup({}, {});
    const r = p.open({ cwd: 'C:/x', providerId: 'relay', subagentModel: 'mini' }) as any;
    expect(r.params.subagentModel).toBe(crossValue('relay', 'mini'));
    expect(writes).toEqual([[r.sessionId, { subagent: { providerId: 'relay', model: crossValue('relay', 'mini') } }]]);
    p.open({ sessionId: 'src', cwd: 'C:/x', fork: true, subagentModel: '' });
    expect(writes).toHaveLength(1);
  });
});

// A7: the account's 200K / 1M picks and 自动压缩 point (settings claude.contextWindows / claude.compactAt)
describe('RunnerPool: the account’s window picks and compaction point', () => {
  const setup = (settings: Record<string, unknown>) => {
    const meta = Object.assign(new EventEmitter(),{ sessionMeta: () => ({}), settings: () => settings, setSessionMeta: async () => {} });
    const providers: Record<string, any> = { relay: { id: 'relay', type: 'anthropic' }, acc2: { id: 'acc2', type: 'claude-account' } };
    const p = new RunnerPool({ forSession: (id?: string) => (id && id !== 'claude' ? providers[id] : undefined), meta } as any);
    return { p, meta, settings };
  };

  it('the own login gets the settings, read through familyWindows (junk left out); a provider / another account gets none', () => {
    const { p } = setup({ 'claude.contextWindows': { opus: 200_000, sonnet: 123, haiku: 1_000_000 }, 'claude.compactAt': 500_000 });
    expect((p.open({ cwd: 'C:/x' }) as any).opts.account).toEqual({ windows: { opus: 200_000 }, compactAt: 500_000 });
    expect((p.open({ cwd: 'C:/x', providerId: 'claude' }) as any).opts.account).toEqual({ windows: { opus: 200_000 }, compactAt: 500_000 });
    expect((p.open({ cwd: 'C:/x', providerId: 'relay' }) as any).opts.account).toBeUndefined();
    expect((p.open({ cwd: 'C:/x', providerId: 'acc2' }) as any).opts.account).toBeUndefined();
  });

  it('compactAt only when it is a number; nothing set → no windows picked', () => {
    const { p } = setup({ 'claude.compactAt': '500k' });
    expect((p.open({ cwd: 'C:/x' }) as any).opts.account).toEqual({ windows: {} });
  });

  it('a settings change reaches the running own-login conversations (setAccountPrefs), not provider ones; an unrelated save pushes nothing', () => {
    vi.useFakeTimers();
    try {
      const { p, meta, settings } = setup({});
      const own: any = p.open({ sessionId: 'own', cwd: 'C:/x' });
      const relay: any = p.open({ sessionId: 'rel', cwd: 'C:/x', providerId: 'relay' });
      const other: any = p.open({ sessionId: 'acc', cwd: 'C:/x', providerId: 'acc2' });
      meta.emit('changed'); // something else saved (a draft, a provider…)
      vi.advanceTimersByTime(ACCOUNT_PREFS_DEBOUNCE_MS);
      expect(own.prefs).toEqual([]);
      settings['claude.compactAt'] = 600_000;
      meta.emit('changed');
      vi.advanceTimersByTime(ACCOUNT_PREFS_DEBOUNCE_MS);
      expect(own.prefs).toEqual([{ windows: {}, compactAt: 600_000 }]);
      expect(relay.prefs).toEqual([]);
      expect(other.prefs).toEqual([]);
      meta.emit('changed'); // the same again
      vi.advanceTimersByTime(ACCOUNT_PREFS_DEBOUNCE_MS);
      expect(own.prefs).toHaveLength(1);
      settings['claude.contextWindows'] = { sonnet: 200_000 };
      meta.emit('changed');
      vi.advanceTimersByTime(ACCOUNT_PREFS_DEBOUNCE_MS);
      expect(own.prefs[1]).toEqual({ windows: { sonnet: 200_000 }, compactAt: 600_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  // final review I1: the account dialog saves claude.contextWindows then claude.compactAt — two meta saves, two
  // 'changed' a few ms apart. Each push could compact / restart on its own: they go out as one
  it('two quick saves (the dialog\'s windows, then its compaction point) reach a conversation as one push', () => {
    vi.useFakeTimers();
    try {
      const { p, meta, settings } = setup({});
      const own: any = p.open({ sessionId: 'own', cwd: 'C:/x' });
      settings['claude.contextWindows'] = { opus: 200_000 };
      meta.emit('changed');
      vi.advanceTimersByTime(5);
      settings['claude.compactAt'] = 150_000;
      meta.emit('changed');
      vi.advanceTimersByTime(ACCOUNT_PREFS_DEBOUNCE_MS);
      expect(own.prefs).toEqual([{ windows: { opus: 200_000 }, compactAt: 150_000 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  // final review M1: a conversation opened between the settings write and its 'changed' read the new picks — the pool
  // used to take that as already passed on, and the conversations running before never got them
  it('a conversation opened while the save is still being written does not keep the older ones from getting the change', () => {
    vi.useFakeTimers();
    try {
      const { p, meta, settings } = setup({});
      const old: any = p.open({ sessionId: 'old', cwd: 'C:/x' });
      settings['claude.compactAt'] = 600_000; // in memory; the file write (and 'changed') is still to come
      const fresh: any = p.open({ sessionId: 'new', cwd: 'C:/x' });
      expect(fresh.opts.account).toEqual({ windows: {}, compactAt: 600_000 });
      meta.emit('changed');
      vi.advanceTimersByTime(ACCOUNT_PREFS_DEBOUNCE_MS);
      expect(old.prefs).toEqual([{ windows: {}, compactAt: 600_000 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RunnerPool: the permission mode a conversation comes back in', () => {
  const setup = (recorded: Record<string, any>, settings: Record<string, unknown>) => {
    const writes: [string, any][] = [];
    const meta = { sessionMeta: (id: string) => recorded[id] ?? {}, settings: () => settings, setSessionMeta: async (id: string, patch: any) => { writes.push([id, patch]); recorded[id] = { ...recorded[id], ...patch }; } };
    return { p: new RunnerPool({ forSession: () => undefined, meta } as any), writes };
  };
  it('not said: what it last ran with, else the default for new conversations, else nothing (the CLI default)', () => {
    const { p } = setup({ a: { permissionMode: 'bypassPermissions' } }, { 'ui.defaultMode': 'acceptEdits' });
    expect((p.open({ sessionId: 'a', cwd: 'C:/x' }) as any).params.permissionMode).toBe('bypassPermissions');
    expect((p.open({ sessionId: 'b', cwd: 'C:/x' }) as any).params.permissionMode).toBe('acceptEdits');
    expect((p.open({ sessionId: 'c', cwd: 'C:/x', permissionMode: 'plan' }) as any).params.permissionMode).toBe('plan');
    expect((setup({}, { 'ui.defaultMode': 'nonsense' }).p.open({ sessionId: 'd', cwd: 'C:/x' }) as any).params.permissionMode).toBeUndefined();
  });
  // 2026-10-26 (desktop QA): a conversation opened as 每步询问 while 新对话默认权限 is 完全放开 must never come back in
  // 完全放开 — not even when its process never got as far as reporting its mode (a start that failed, a close before
  // init) and whoever reopens it says no mode (IM, schedules, goals, another window after a restart)
  it.each([
    ['default', 'bypassPermissions'],
    ['default', 'acceptEdits'],
    ['plan', 'bypassPermissions'],
    ['acceptEdits', 'plan'],
    ['bypassPermissions', 'default'],
  ] as const)('opened as %s while new conversations default to %s: a reopen without a mode keeps it', (explicit, def) => {
    const { p, writes } = setup({}, { 'ui.defaultMode': def });
    const r: any = p.open({ cwd: 'C:/x', permissionMode: explicit });
    expect(r.params.permissionMode).toBe(explicit);
    expect(writes).toContainEqual([r.sessionId, { permissionMode: explicit }]);
    r.setState('error'); // no info ever came
    const again: any = p.open({ sessionId: r.sessionId, cwd: 'C:/x' });
    expect(again).not.toBe(r);
    expect(again.params.permissionMode).toBe(explicit);
  });
  // the permission chip of a conversation that is not running asks the server this (session.resumeMode): it is what
  // open() without a mode uses, so the chip can never say 每步询问 while the next send runs in 完全放开 (2026-10-26 QA)
  it('resumeMode: the mode a resume without one gets — the record, else the default for new conversations', () => {
    const { p } = setup({ a: { permissionMode: 'bypassPermissions' }, b: { permissionMode: 'default' } }, { 'ui.defaultMode': 'default' });
    expect(p.resumeMode('a')).toBe('bypassPermissions');
    expect((p.open({ sessionId: 'a', cwd: 'C:/x' }) as any).params.permissionMode).toBe('bypassPermissions');
    const q = setup({ b: { permissionMode: 'default' } }, { 'ui.defaultMode': 'bypassPermissions' }).p;
    expect(q.resumeMode('b')).toBe('default');
    expect(q.resumeMode('never-ran')).toBe('bypassPermissions');
    expect(setup({}, {}).p.resumeMode('x')).toBeUndefined();
  });
  it('a resume with an explicit mode is recorded too, and a later one without a mode keeps it', () => {
    const { p } = setup({ old: { permissionMode: 'bypassPermissions' } }, { 'ui.defaultMode': 'bypassPermissions' });
    const r: any = p.open({ sessionId: 'old', cwd: 'C:/x', permissionMode: 'default' });
    r.setState('closed');
    expect((p.open({ sessionId: 'old', cwd: 'C:/x' }) as any).params.permissionMode).toBe('default');
  });
  it('a fork starts from the default, not from its source record', () => {
    const { p } = setup({ src: { permissionMode: 'plan' } }, {});
    expect((p.open({ sessionId: 'src', cwd: 'C:/x', fork: true }) as any).params.permissionMode).toBeUndefined();
  });
  it('the mode it runs in is recorded when it changes (a pick, the CLI leaving plan mode)', () => {
    const { p, writes } = setup({}, {});
    const r: any = p.open({ sessionId: 'a', cwd: 'C:/x', permissionMode: 'default' });
    r.emit('info', { sessionId: 'a', permissionMode: 'bypassPermissions' });
    r.emit('info', { sessionId: 'a', permissionMode: 'bypassPermissions' });
    r.emit('info', { sessionId: 'a', permissionMode: 'acceptEdits' });
    r.emit('info', { sessionId: 'a' });
    expect(writes).toEqual([['a', { permissionMode: 'default' }], ['a', { permissionMode: 'bypassPermissions' }], ['a', { permissionMode: 'acceptEdits' }]]);
  });
  it('a fork records nothing under its made-up id — under its own once the CLI gives it one', () => {
    const { p, writes } = setup({}, {});
    const r: any = p.open({ sessionId: 'src', cwd: 'C:/x', fork: true, permissionMode: 'acceptEdits' });
    r.emit('info', { sessionId: r.id, permissionMode: 'acceptEdits' });
    expect(writes).toEqual([]);
    r.emit('info', { sessionId: 'forked', permissionMode: 'acceptEdits' });
    expect(writes).toEqual([['forked', { permissionMode: 'acceptEdits' }]]);
  });
});

describe('RunnerPool: 只聊天 stays without tools, whoever reopens it', () => {
  const setup = (recorded: Record<string, any>) => {
    const writes: [string, any][] = [];
    const meta = { sessionMeta: (id: string) => recorded[id] ?? {}, settings: () => ({}), setSessionMeta: async (id: string, patch: any) => { writes.push([id, patch]); recorded[id] = { ...recorded[id], ...patch }; } };
    return { p: new RunnerPool({ forSession: () => undefined, meta } as any), writes };
  };
  it('a reopen that does not say (another conversation’s message, IM, goals, schedules) gets it from the record', () => {
    const { p } = setup({ chat: { chatOnly: true } });
    expect((p.open({ sessionId: 'chat', cwd: 'C:/x', features: { web: true } }) as any).params.features).toEqual({ web: true, chatOnly: true });
    expect((p.open({ sessionId: 'chat', cwd: 'C:/x', features: { chatOnly: false } }) as any).params.features.chatOnly).toBe(true);
    expect((p.open({ sessionId: 'other', cwd: 'C:/x' }) as any).params.features?.chatOnly).toBeUndefined();
  });
  it('recorded for a new one at once, for a fork under the id the CLI gives it — and a fork of one is one too', () => {
    const { p, writes } = setup({ src: { chatOnly: true } });
    const n: any = p.open({ cwd: 'C:/x', features: { chatOnly: true } });
    expect(writes).toEqual([[n.sessionId, { chatOnly: true }]]);
    const f: any = p.open({ sessionId: 'src', cwd: 'C:/x', fork: true });
    expect(f.params.features.chatOnly).toBe(true);
    f.emit('info', { sessionId: f.id });
    expect(writes).toHaveLength(1);
    f.emit('info', { sessionId: 'forked' });
    expect(writes[1]).toEqual(['forked', { chatOnly: true }]);
  });
  it('a non-Claude agent is never started on it (none has a mode without tools)', () => {
    const { p } = setup({ chat: { chatOnly: true } });
    (p as any).agents = { launch: () => { throw new Error('launched'); } };
    (p as any).transcripts = {};
    expect(() => p.open({ sessionId: 'chat', cwd: 'C:/x', agent: 'codex' } as any)).toThrow(/只聊天/);
  });
});

describe('RunnerPool: a bot’s conversations (值班 Bot)', () => {
  const setup = (recorded: Record<string, any> = {}) => {
    const writes: [string, any][] = [];
    const meta = { sessionMeta: (id: string) => recorded[id] ?? {}, settings: () => ({}), setSessionMeta: async (id: string, patch: any) => { writes.push([id, patch]); recorded[id] = { ...recorded[id], ...patch }; } };
    return { p: new RunnerPool({ forSession: () => undefined, meta } as any), writes, recorded };
  };
  it('a run opened for a bot is recorded as the bot’s (so the lists leave it out)', () => {
    const { p, recorded } = setup();
    const r: any = p.open({ cwd: 'C:/x', gated: true, botId: 'b1', botRole: 'run' });
    expect(recorded[r.sessionId]).toMatchObject({ botId: 'b1', botRole: 'run' });
  });
  it('a fork is recorded under the id the CLI gives it, never the placeholder', () => {
    const { p, writes } = setup();
    const f: any = p.open({ sessionId: 'src', cwd: 'C:/x', fork: true, gated: true, botId: 'b1', botRole: 'internal' });
    f.emit('info', { sessionId: f.id });
    expect(writes.filter(([id]) => id === f.id)).toEqual([]);
    f.emit('info', { sessionId: 'forked' });
    expect(writes).toContainEqual(['forked', { botId: 'b1', botRole: 'internal' }]);
  });
  it('a bot’s thread opened without the gate (IM, another conversation, goals, a fork) is refused', () => {
    const { p } = setup({ th: { botId: 'b1', botRole: 'thread' } });
    expect(() => p.open({ sessionId: 'th', cwd: 'C:/x' })).toThrow(/Bot 的对话/);
    expect(() => p.open({ sessionId: 'th', cwd: 'C:/x', fork: true })).toThrow(/Bot 的对话/);
    expect(() => p.open({ sessionId: 'TH', cwd: 'C:/x' })).toThrow(/Bot 的对话/); // the same transcript file on Windows
    expect(() => p.open({ sessionId: 'th', cwd: 'C:/x', gated: true, botId: 'b1', botRole: 'thread' })).not.toThrow();
  });
  it('a normal conversation records nothing about bots', () => {
    const { p, writes } = setup();
    p.open({ cwd: 'C:/x' });
    expect(writes.some(([, w]) => 'botId' in w || 'botRole' in w)).toBe(false);
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

// 发送前核对权限 (spec §14.4): the chip showed one mode, the resume would run in another → refuse, record nothing
describe('expectMode (compare-and-refuse before a send)', () => {
  const setup = (recorded: Record<string, any>, settings: Record<string, unknown>) => {
    const writes: [string, any][] = [];
    const meta = { sessionMeta: (id: string) => recorded[id] ?? {}, settings: () => settings, setSessionMeta: async (id: string, patch: any) => { writes.push([id, patch]); } };
    return { p: new RunnerPool({ forSession: () => undefined, meta } as any), writes };
  };
  it('a mismatch is reported with the mode it would really run in, and nothing is recorded or started', () => {
    const { p, writes } = setup({ a: { permissionMode: 'bypassPermissions' } }, { 'ui.defaultMode': 'default' });
    expect(p.modeMismatch({ sessionId: 'a', cwd: 'C:/x', expectMode: 'default' })).toBe('bypassPermissions');
    expect(writes).toEqual([]);
    expect(p.stateOf('a')).toBeUndefined();
  });
  it('no default either: the CLI default counts as default', () => {
    const { p } = setup({}, {});
    expect(p.modeMismatch({ sessionId: 'n', cwd: 'C:/x', expectMode: 'default' })).toBeNull();
    expect(p.modeMismatch({ sessionId: 'n', cwd: 'C:/x', expectMode: 'plan' })).toBe('default');
  });
  it('a match, a named mode, a fork, a resumeAt or no expectMode: go ahead', () => {
    const { p } = setup({ a: { permissionMode: 'bypassPermissions' } }, {});
    expect(p.modeMismatch({ sessionId: 'a', cwd: 'C:/x', expectMode: 'bypassPermissions' })).toBeNull();
    expect(p.modeMismatch({ sessionId: 'a', cwd: 'C:/x', expectMode: 'default', permissionMode: 'default' })).toBeNull();
    expect(p.modeMismatch({ sessionId: 'a', cwd: 'C:/x', expectMode: 'default', fork: true })).toBeNull();
    expect(p.modeMismatch({ sessionId: 'a', cwd: 'C:/x', expectMode: 'default', resumeAt: 'u1' })).toBeNull();
    expect(p.modeMismatch({ sessionId: 'a', cwd: 'C:/x' })).toBeNull();
  });
  it('a conversation already running keeps its own mode: not checked; open() never passes expectMode on', () => {
    const { p } = setup({ a: { permissionMode: 'bypassPermissions' } }, {});
    const r: any = p.open({ sessionId: 'a', cwd: 'C:/x', expectMode: 'bypassPermissions' });
    expect(r.params.expectMode).toBeUndefined();
    r.setState('idle');
    expect(p.modeMismatch({ sessionId: 'a', cwd: 'C:/x', expectMode: 'default' })).toBeNull();
  });
});
