import { describe, expect, it, vi } from 'vitest';

/** Every query() the runner starts: end / fail its message stream, push a message into it, react to interrupt(). */
interface FakeQuery { options: any; end: () => void; fail: (e: Error) => void; push: (m: any) => void; onInterrupt?: () => void; flags: any[] }
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
    const h: FakeQuery = { options, end: () => { ended = true; settle(); }, fail: (e) => { err = e; settle(); }, push: (m) => { buf.push(m); settle(); }, flags: [] };
    const q: any = {
      initializationResult: async () => ({}),
      supportedCommands: async () => [],
      supportedModels: async () => cli.models,
      supportedAgents: async () => [],
      mcpServerStatus: async () => [],
      [Symbol.asyncIterator]: () => ({ next }),
      return: async () => { h.end(); return { value: undefined, done: true }; },
      setModel: async () => { throw new Error('unsupported'); },
      interrupt: async () => { h.onInterrupt?.(); },
      applyFlagSettings: async (f: any) => { h.flags.push(f); },
    };
    queries.push(h);
    return q;
  },
}));
const eng = vi.hoisted(() => ({ kind: 'claude' as 'claude' | 'ccb' }));
/** what the CLI answers to supportedModels() (the account's list) */
const cli = vi.hoisted(() => ({ models: [] as any[] }));
vi.mock('../claude-exe.js', () => ({ resolveEngine: (rt?: 'claude' | 'ccb') => ({ file: 'claude', kind: rt ?? eng.kind }), spawnClaude: () => null }));
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
    const r = new SessionRunner({ sessionId: 'b', cwd: process.cwd() } as any);
    await tick();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      queries[0].fail(new Error('process exited with code 1'));
      await tick();
      expect(r.state).toBe('error');
      // the reason reaches server.log (a window that missed the state event used to leave no trace anywhere)
      expect(logged.mock.calls.flat().join(' ')).toMatch(/\[session b\] process failed: 对话进程退出了（退出码 1）[\s\S]*原文：process exited with code 1/);
    } finally {
      logged.mockRestore();
    }
    // the refusal says why, in the user's words (the original kept under it), and what to do
    expect(() => r.send('hi')).toThrow(/出错退出了：对话进程退出了（退出码 1）[^\n]*\n原文：process exited with code 1\n再发一次会重新打开它/);
    expect(r.state).toBe('error');
    await r.close();
  });

  it('a conversation whose folder is gone says so, not the SDK\'s "executable … failed to launch"', async () => {
    queries.length = 0;
    const gone = (await import('node:path')).join((await import('node:os')).tmpdir(), `cw-gone-${Date.now()}`);
    const r = new SessionRunner({ sessionId: 'g', cwd: gone } as any);
    await tick();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      queries[0].fail(new Error('Claude Code executable at D:\\Claude Web\\cli-node.js exists but failed to launch.'));
      await tick();
    } finally {
      logged.mockRestore();
    }
    expect(r.info.error).toContain(`找不到这个对话的项目文件夹：${gone}`);
    expect(() => r.send('hi')).toThrow(/没能启动：找不到这个对话的项目文件夹/);
    expect(() => r.send('hi')).not.toThrow(/测试连接/); // the provider is not the problem
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

describe('SessionRunner on a conversation that never ran a turn (user report: switching provider before the first message)', () => {
  // Claude Code writes the transcript with the first message: an id with no JSONL cannot be --resume'd
  // ("No conversation found with session ID"), it has to be started anew on the same id
  const withConfigDir = async (fn: (dir: string) => Promise<void>) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-claude-cfg-'));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try { await fn(dir); } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reopening an id with no transcript starts a new conversation on that id instead of resuming', async () => {
    await withConfigDir(async () => {
      queries.length = 0;
      const r = new SessionRunner({ sessionId: 'fresh-1', cwd: '/x' } as any);
      await tick();
      expect(queries[0].options.resume).toBeUndefined();
      expect(queries[0].options.sessionId).toBe('fresh-1');
      expect(r.sessionId).toBe('fresh-1');
      await r.close();
    });
  });

  it('an id whose transcript exists (in any project folder) is resumed', async () => {
    await withConfigDir(async (dir) => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.mkdirSync(path.join(dir, 'projects', 'C--work-app'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'projects', 'C--work-app', 'fresh-2.jsonl'), '{}\n');
      queries.length = 0;
      const r = new SessionRunner({ sessionId: 'fresh-2', cwd: '/x' } as any);
      await tick();
      expect(queries[0].options.resume).toBe('fresh-2');
      expect(queries[0].options.sessionId).toBeUndefined();
      await r.close();
    });
  });

  it('a restart before the first message starts anew on the same id; after a message it resumes', async () => {
    await withConfigDir(async () => {
      queries.length = 0;
      const r = new SessionRunner({ cwd: '/x' } as any); // a new conversation from the welcome page
      await tick();
      const id = r.sessionId;
      await r.setModel('opus'); // the fake rejects setModel → the runner restarts its process
      await tick();
      expect(queries).toHaveLength(2);
      expect(queries[1].options.resume).toBeUndefined();
      expect(queries[1].options.sessionId).toBe(id);
      r.send('hi'); // the CLI now writes the transcript
      await r.setModel('sonnet');
      await tick();
      expect(queries).toHaveLength(2); // mid-turn: the restart waits for the turn's result
      queries[1].push({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, modelUsage: {}, usage: {}, session_id: id, uuid: 'u1' });
      await tick();
      expect(queries).toHaveLength(3);
      expect(queries[2].options.resume).toBe(id);
      await r.close();
    });
  });
});

describe('SessionRunner: the engine follows the model, effort on ccb, per-turn cost', () => {
  const xy = { id: 'xy', name: 'XY', type: 'anthropic', baseUrl: 'https://relay.invalid', apiKey: 'k', models: ['claude-sonnet-4-6', 'claude-opus-5-5', 'gpt-image-2'], modelMap: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-4-6', haiku: 'claude-sonnet-4-6' } } as any;
  const result = (cost: number, models: Record<string, number>) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: cost, modelUsage: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: v, contextWindow: 1, maxOutputTokens: 1 }])), usage: {}, session_id: 'e1', uuid: 'u' });

  it('claude-opus-5-5 on an Anthropic-format relay starts on the official binary; switching to it from ccb restarts the process', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const a = new SessionRunner({ sessionId: 'e1', cwd: '/x', model: 'claude-opus-5-5' } as any, xy);
      await tick();
      expect(a.info.runtime).toBe('claude');
      expect(queries[0].options.env.CLAUDE_CODE_DISABLE_THINKING).toBeUndefined();
      await a.close();
      const b = new SessionRunner({ sessionId: 'e2', cwd: '/x', model: 'claude-sonnet-4-6' } as any, xy);
      await tick();
      expect(b.info.runtime).toBe('ccb');
      await b.setModel('claude-opus-5-5');
      await tick();
      expect(queries).toHaveLength(3); // a restart, not the in-process setModel
      expect(b.info.runtime).toBe('claude');
      expect(b.info.model).toBe('claude-opus-5-5');
      await b.close();
    } finally {
      eng.kind = 'claude';
    }
  });

  it('a conversation with a ccb-only flag stays on ccb, with thinking off for that model', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const a = new SessionRunner({ sessionId: 'e3', cwd: '/x', model: 'opus', features: { proactive: true } } as any, xy);
      await tick();
      expect(a.info.runtime).toBe('ccb');
      expect(queries[0].options.env.CLAUDE_CODE_DISABLE_THINKING).toBe('1');
      await a.close();
    } finally {
      eng.kind = 'claude';
    }
  });

  it('effort on our engine changes in the running process (applyFlagSettings), no restart, even mid-turn', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const a = new SessionRunner({ sessionId: 'e4', cwd: '/x', model: 'claude-sonnet-4-6', effort: 'low' } as any, xy);
      await tick();
      expect(queries[0].options.effort).toBe('low');
      a.send('hi');
      await a.setEffort('max');
      await tick();
      expect(queries).toHaveLength(1);
      expect(queries[0].flags).toEqual([{ effortLevel: 'max', ultracode: false }]);
      expect(a.info.effort).toBe('max');
      queries[0].push(result(0.1, { 'claude-sonnet-4-6': 0.1 }));
      await tick();
      expect(queries).toHaveLength(1); // the turn ending does not restart it either
      expect(a.info.supportsUltracode).toBe(true); // claude-web-engine: --ultracode / the ultracode setting
      expect(a.info.models?.map((m) => m.value)).toEqual(['claude-sonnet-4-6', 'claude-opus-5-5']); // no image model
      await a.setEffort('ultra'); // Codex's own rung: max on Claude
      expect(queries[0].flags.at(-1)).toEqual({ effortLevel: 'max', ultracode: false });
      await a.close();
    } finally {
      eng.kind = 'claude';
    }
  });

  it('深度编排 on our engine: a setting, no restart; picking a level while it is on leaves it in the same call; a restart keeps it (--ultracode)', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const a = new SessionRunner({ sessionId: 'u1', cwd: '/x', model: 'claude-sonnet-4-6' } as any, xy);
      await tick();
      await a.setUltracode(true);
      expect(queries[0].flags).toEqual([{ ultracode: true }]);
      expect(a.info.ultracode).toBe(true);
      await (a as any).respawn();
      await tick();
      expect(queries).toHaveLength(2);
      expect(queries[1].options.extraArgs.ultracode).toBeNull(); // → --ultracode
      await a.setEffort('low');
      expect(queries[1].flags).toEqual([{ effortLevel: 'low', ultracode: false }]);
      expect(a.info.ultracode).toBe(false);
      await (a as any).respawn();
      await tick();
      expect('ultracode' in queries[2].options.extraArgs).toBe(false);
      await a.close();
    } finally {
      eng.kind = 'claude';
    }
  });

  it('深度编排 picked before the conversation starts (welcome page, a reopen) starts the engine with --ultracode', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const a = new SessionRunner({ sessionId: 'u2', cwd: '/x', model: 'claude-sonnet-4-6', ultracode: true } as any, xy);
      await tick();
      expect(queries[0].options.extraArgs.ultracode).toBeNull(); // → --ultracode
      expect(a.info.ultracode).toBe(true);
      await a.close();
    } finally {
      eng.kind = 'claude';
    }
  });

  it('深度编排 picked before the start on the official binary: `/effort ultracode` goes just before the first message (not at open)', async () => {
    queries.length = 0;
    const a = new SessionRunner({ sessionId: 'o2', cwd: '/x', model: 'claude-opus-5-5', ultracode: true } as any);
    await tick();
    expect(a.info.ultracode).toBe(true);
    expect('ultracode' in queries[0].options.extraArgs).toBe(false); // the official binary has no --ultracode
    const sent = vi.spyOn(a, 'send');
    expect(sent).not.toHaveBeenCalled();
    a.send('hi');
    expect(sent.mock.calls.map((c) => c[0])).toEqual(['hi', '/effort ultracode']); // the outer call, then the command it sends first
    a.send('again');
    expect(sent.mock.calls.map((c) => c[0])).toEqual(['hi', '/effort ultracode', 'again']);
    await a.close();
    // picking a level before the first message leaves it (and sends that level instead)
    const b = new SessionRunner({ sessionId: 'o3', cwd: '/x', model: 'claude-opus-5-5', ultracode: true } as any);
    await tick();
    await b.setEffort('low');
    const sentB = vi.spyOn(b, 'send');
    b.send('hi');
    expect(sentB.mock.calls.map((c) => c[0])).toEqual(['hi']);
    await b.close();
  });

  it('the official binary still changes effort with /effort', async () => {
    queries.length = 0;
    const a = new SessionRunner({ sessionId: 'o1', cwd: '/x', model: 'claude-opus-5-5' } as any);
    await tick();
    const sent = vi.spyOn(a, 'send');
    await a.setEffort('high');
    expect(sent).toHaveBeenCalledWith('/effort high');
    expect(queries[0].flags).toEqual([]);
    await a.close();
  });

  it('a model whose native parameter was refused: recorded on the provider, shown as the prompt way, the message not passed on', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const p = { id: 'ox', name: 'OX', type: 'openai', baseUrl: 'https://relay.invalid', apiKey: 'k', models: ['gpt-x', 'o3-mini'] } as any;
      const a = new SessionRunner({ sessionId: 'cap1', cwd: '/x', model: 'o3-mini' } as any, p);
      const recorded: [string, string][] = [];
      a.onPromptOnly = (pid, model) => recorded.push([pid, model]);
      const seen: any[] = [];
      a.on('message', (m) => seen.push(m));
      await tick();
      expect(a.info.models?.find((m) => m.value === 'o3-mini')?.effortMode).toBe('native');
      queries[0].push({ type: 'system', subtype: 'cw_capability', model: 'o3-mini', capability: 'native_effort', supported: false, param: 'reasoning_effort', status: 400, session_id: 'cap1', uuid: 'u' });
      await tick();
      expect(recorded).toEqual([['ox', 'o3-mini']]);
      expect(a.info.models?.find((m) => m.value === 'o3-mini')?.effortMode).toBe('prompt');
      expect(seen.some((m) => m.subtype === 'cw_capability')).toBe(false);
      await (a as any).respawn();
      await tick();
      expect(JSON.parse(queries[1].options.env.CLAUDE_WEB_MODEL_CAPS)['o3-mini']).toMatchObject({ native: false });
      await a.close();
    } finally {
      eng.kind = 'claude';
    }
  });

  it('tells the engine what each model can do; every model offers 智能程度 (native or through the prompt) and 深度编排', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const ds = { id: 'ds', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.invalid', apiKey: 'k', models: ['deepseek-flash', 'gpt-4o', 'gpt-image-2'], modelEfforts: { 'deepseek-flash': { levels: ['low', 'high', 'max'], default: 'high' } } } as any;
      const a = new SessionRunner({ sessionId: 'caps1', cwd: '/x', model: 'deepseek-flash' } as any, ds);
      await tick();
      const caps = JSON.parse(queries[0].options.env.CLAUDE_WEB_MODEL_CAPS);
      expect(caps['deepseek-flash']).toEqual({ levels: ['low', 'high', 'max'], default: 'high', reasoning: true });
      expect(caps['gpt-4o']).toBeUndefined();
      const byId = Object.fromEntries((a.info.models ?? []).map((m) => [m.value, m]));
      expect(byId['deepseek-flash']).toMatchObject({ supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'], effortMode: 'native' });
      expect(byId['gpt-4o']).toMatchObject({ supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], effortMode: 'prompt' });
      expect(a.info.supportsUltracode).toBe(true);
      await a.close();
    } finally {
      eng.kind = 'claude';
    }
  });

  it('the account\'s list (aliases): the official binary keeps the CLI\'s own answer; our engine reads each alias as its model', async () => {
    const five = ['low', 'medium', 'high', 'xhigh', 'max'];
    cli.models = [
      { value: 'default', displayName: 'Default', description: '', supportsEffort: true, supportedEffortLevels: five },
      { value: 'opus', displayName: 'Opus', description: '', supportsEffort: true, supportedEffortLevels: five },
      { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false },
    ];
    try {
      queries.length = 0;
      const byId = (r: SessionRunner) => Object.fromEntries((r.info.models ?? []).map((m) => [m.value, m]));
      const off = new SessionRunner({ sessionId: 'al1', cwd: '/x' } as any);
      await tick();
      expect(byId(off).opus).toMatchObject({ supportsEffort: true, supportedEffortLevels: five, effortMode: 'native' });
      expect(byId(off).default).toMatchObject({ supportsEffort: true, effortMode: 'native' });
      expect(byId(off).haiku).toMatchObject({ supportsEffort: false });
      await off.close();
      eng.kind = 'ccb';
      const ours = new SessionRunner({ sessionId: 'al2', cwd: '/x' } as any);
      await tick();
      expect(byId(ours).opus).toMatchObject({ supportsEffort: true, effortMode: 'native' });
      expect(byId(ours).default).toMatchObject({ supportsEffort: true, effortMode: 'native' });
      await ours.close();
    } finally {
      cli.models = [];
      eng.kind = 'claude';
    }
  });

  it('each result carries its own turn’s cost (the CLI reports running totals)', async () => {
    queries.length = 0;
    const a = new SessionRunner({ sessionId: 'e5', cwd: '/x' } as any);
    const seen: any[] = [];
    a.on('message', (m) => { if (m.type === 'result') seen.push({ cost: m.total_cost_usd, models: Object.keys(m.modelUsage) }); });
    await tick();
    queries[0].push(result(0.4, { 'claude-opus-5-5': 0.4 }));
    queries[0].push(result(0.9, { 'claude-opus-5-5': 0.4, 'claude-haiku-4-5-20251001': 0.5 }));
    await tick();
    expect(seen.map((s) => +s.cost.toFixed(6))).toEqual([0.4, 0.5]);
    expect(seen[1].models).toEqual(['claude-haiku-4-5-20251001']);
    await a.close();
  });
});

describe('SessionRunner: the account through a relay of the user’s own (settings.json env)', () => {
  it('runs on the official binary (a client-checking relay refuses ccb); with a ccb-only flag on ccb, without the claude.ai alias table', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-relay-'));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.invalid', ANTHROPIC_AUTH_TOKEN: 'x' } }));
    const was = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const a = new SessionRunner({ sessionId: 'r1', cwd: '/x' } as any);
      await tick();
      expect(a.info.runtime).toBe('claude');
      await a.close();
      const b = new SessionRunner({ sessionId: 'r2', cwd: '/x', features: { proactive: true } } as any);
      await tick();
      expect(b.info.runtime).toBe('ccb');
      expect(queries[1].options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined(); // claude-sonnet-5 isn't on that relay
      await b.close();
      const c = new SessionRunner({ sessionId: 'r3', cwd: '/x', model: 'claude-opus-5-5', features: { proactive: true } } as any);
      await tick();
      expect(c.info.runtime).toBe('ccb');
      expect(queries[2].options.env?.CLAUDE_CODE_DISABLE_THINKING).toBe('1');
      await c.close();
    } finally {
      eng.kind = 'claude';
      if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cliSaid: what the CLI wrote to stderr, for the error message', () => {
  it('the last lines, warnings left out', async () => {
    const { cliSaid } = await import('./session-runner.js');
    expect(cliSaid("Warning: no stdin data received in 3s\nerror: unknown option '--session-mirror'\n")).toBe("error: unknown option '--session-mirror'");
    expect(cliSaid('a\r\nb\r\nc\r\nd\r\n')).toBe('b · c · d');
    expect(cliSaid('')).toBe('');
  });
});

describe('SessionRunner: a hand-over to Claude on ccb (no session mirror)', () => {
  it('ccb gets no sessionStore (the SDK would pass --session-mirror, unknown to ccb) and the briefing as its first message; the official binary keeps the entries', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const a = new SessionRunner({ sessionId: 'h-ccb-1', cwd: '/x', resumeEntries: [{ type: 'user' }], briefing: 'BRIEFING' } as any);
      await tick();
      expect(queries[0].options.sessionStore).toBeUndefined();
      expect(queries[0].options.resume).toBeUndefined();
      expect(queries[0].options.sessionId).toBe('h-ccb-1');
      expect(a.state).toBe('running'); // the briefing went in
      await a.close();
      eng.kind = 'claude';
      const b = new SessionRunner({ sessionId: 'h-off-1', cwd: '/x', resumeEntries: [{ type: 'user' }], briefing: 'BRIEFING' } as any);
      await tick();
      expect(queries[1].options.sessionStore).toBeDefined();
      expect(queries[1].options.resume).toBe('h-off-1');
      await b.close();
    } finally {
      eng.kind = 'claude';
    }
  });
});

describe('SessionRunner: a turn written from a terminal while the conversation sits idle here', () => {
  it('wroteElsewhere: its own prompts and the last one on disk at start are known; another one is not', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ext-'));
    const was = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    const proj = path.join(dir, 'projects', 'C--x');
    fs.mkdirSync(proj, { recursive: true });
    const f = path.join(proj, 'ext-1.jsonl');
    const line = (uuid: string, text: string) => JSON.stringify({ type: 'user', uuid, parentUuid: null, message: { role: 'user', content: text } }) + '\n';
    fs.writeFileSync(f, line('old', 'from before'));
    try {
      queries.length = 0;
      const r = new SessionRunner({ sessionId: 'ext-1', cwd: '/x' } as any);
      await tick();
      r.lastActivity = 0; // long quiet
      expect(r.wroteElsewhere()).toBe(false); // what was on disk when it started
      r.send('mine', undefined, false, 'u-mine');
      queries[0].push({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, modelUsage: {}, usage: {}, session_id: 'ext-1', uuid: 'r' });
      await tick();
      fs.appendFileSync(f, line('u-mine', 'mine'));
      r.lastActivity = 0;
      expect(r.wroteElsewhere()).toBe(false); // its own prompt
      fs.appendFileSync(f, line('cli-1', 'typed in a terminal'));
      expect(r.wroteElsewhere()).toBe(true);
      r.lastActivity = Date.now();
      expect(r.wroteElsewhere()).toBe(false); // not while its own lines may still be landing
      await r.close();
    } finally {
      if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // the official binary writes its own idea of the leaf when it exits; closed because a terminal took the conversation
  // over, that line (the web's last answer) landed after the terminal's turn and the next resume branched it off
  it("yieldToOutside: the leaf the exiting process writes does not bury the terminal's turn", async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ext-'));
    const was = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    const proj = path.join(dir, 'projects', 'C--x');
    fs.mkdirSync(proj, { recursive: true });
    const f = path.join(proj, 'ext-2.jsonl');
    const put = (...rows: object[]) => fs.appendFileSync(f, rows.map((x) => JSON.stringify(x) + '\n').join(''));
    const leaf = (uuid: string) => ({ type: 'last-prompt', lastPrompt: 'q', leafUuid: uuid, sessionId: 'ext-2' });
    put({ type: 'user', uuid: 'w1', parentUuid: null, message: { role: 'user', content: 'web question' } }, { type: 'assistant', uuid: 'w2', parentUuid: 'w1' }, leaf('w2'));
    try {
      queries.length = 0;
      const r = new SessionRunner({ sessionId: 'ext-2', cwd: '/x' } as any);
      await tick();
      put({ type: 'user', uuid: 't1', parentUuid: 'w2', message: { role: 'user', content: 'terminal question' } }, leaf('w2'), { type: 'assistant', uuid: 't2', parentUuid: 't1' });
      const close = r.close.bind(r);
      r.close = async () => { put(leaf('w2'), { type: 'cost-state', sessionId: 'ext-2' }); await close(); }; // the exit flush
      await r.yieldToOutside();
      const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows.at(-1)).toMatchObject({ type: 'last-prompt', leafUuid: 't2' });
      expect(r.state).toBe('closed');
    } finally {
      if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('after a turn on the official binary the file points at that turn while the process sits idle', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ext-'));
    const was = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    const proj = path.join(dir, 'projects', 'C--x');
    fs.mkdirSync(proj, { recursive: true });
    const f = path.join(proj, 'ext-3.jsonl');
    const put = (...rows: object[]) => fs.appendFileSync(f, rows.map((x) => JSON.stringify(x) + '\n').join(''));
    put({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'one' } }, { type: 'assistant', uuid: 'a1', parentUuid: 'u1' }, { type: 'last-prompt', lastPrompt: 'one', leafUuid: 'a1', sessionId: 'ext-3' });
    try {
      queries.length = 0;
      const r = new SessionRunner({ sessionId: 'ext-3', cwd: '/x' } as any);
      await tick();
      r.send('two', undefined, false, 'u2');
      // what the official binary writes for that turn: the leaf at submit (the entry before the answer), then the answer
      put({ type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'two' } }, { type: 'last-prompt', lastPrompt: 'two', leafUuid: 'u2', sessionId: 'ext-3' }, { type: 'assistant', uuid: 'a2', parentUuid: 'u2' });
      queries[0].push({ type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null, session_id: 'ext-3' });
      queries[0].push({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, modelUsage: {}, usage: {}, session_id: 'ext-3', uuid: 'r2' });
      await tick();
      await new Promise((res) => setTimeout(res, 1800));
      const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows.at(-1)).toMatchObject({ type: 'last-prompt', leafUuid: 'a2' });
      await r.close();
    } finally {
      if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SessionRunner: init during the first turn after a resume', () => {
  it('stays running (the CLI says init as that turn starts)', async () => {
    queries.length = 0;
    const r = new SessionRunner({ cwd: '/x' } as any);
    await tick();
    expect(r.state).toBe('idle');
    r.send('hi');
    queries[0].push({ type: 'system', subtype: 'init', session_id: r.sessionId, model: 'm', tools: [], mcp_servers: [] });
    await tick();
    expect(r.state).toBe('running');
    expect(r.info.state).toBe('running');
    queries[0].push({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, modelUsage: {}, usage: {}, session_id: r.sessionId, uuid: 'x' });
    await tick();
    expect(r.state).toBe('idle');
    await r.close();
  });
});

describe('SessionRunner: the user\'s settings files under a provider conversation', () => {
  it('puts the provider\'s token back on top through a --settings file, removed when the conversation closes', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-flag-'));
    const was = { cfg: process.env.CLAUDE_CONFIG_DIR, data: process.env.CLAUDE_WEB_DIR };
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'cfg');
    process.env.CLAUDE_WEB_DIR = path.join(dir, 'data');
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'old-token', ANTHROPIC_API_KEY: 'old-key' } }));
    try {
      queries.length = 0;
      const provider = { id: 'p1', name: 'relay', type: 'anthropic', baseUrl: 'https://relay.invalid', apiKey: 'provider-token', models: [] } as any;
      const r = new SessionRunner({ sessionId: 'f1', cwd: dir } as any, provider);
      await tick();
      const file = queries[0].options.settings;
      expect(typeof file).toBe('string'); // a path: the inline JSON would put the key on the command line
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ env: { ANTHROPIC_AUTH_TOKEN: 'provider-token', ANTHROPIC_API_KEY: '' } });
      await r.close();
      expect(fs.existsSync(file)).toBe(false);
      // an account conversation keeps the user's own relay config: nothing on top
      const a = new SessionRunner({ sessionId: 'f2', cwd: dir } as any);
      await tick();
      expect(queries[1].options.settings).toBeUndefined();
      await a.close();
    } finally {
      if (was.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was.cfg;
      if (was.data === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = was.data;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SessionRunner: what a send accepted', () => {
  it('is emitted as sent — the same user message the CLI is given, with its uuid and attachment markers', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 's1', cwd: '/x' } as any);
    await tick();
    const sent: any[] = [];
    r.on('sent', (m) => sent.push(m));
    r.send('手机上问的', undefined, false, 'u-phone', [{ kind: 'file', name: 'a.txt', path: '/x/a.txt' } as any]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'user', uuid: 'u-phone', session_id: 's1' });
    expect(sent[0].message.content).toContain('手机上问的');
    expect(sent[0].message.content).toContain('<attached kind="file" name="a.txt" path="/x/a.txt" />');
    await r.close();
  });
});

describe('SessionRunner: 联网', () => {
  /** A config folder of our own: the developer's ~/.claude/settings.json must not decide these. */
  const withConfig = async (settings: Record<string, unknown>, fn: (dir: string) => Promise<void>) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-websearch-'));
    const was = { cfg: process.env.CLAUDE_CONFIG_DIR, adapter: process.env.WEB_SEARCH_ADAPTER, kind: eng.kind };
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'cfg');
    delete process.env.WEB_SEARCH_ADAPTER;
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify(settings));
    try {
      queries.length = 0;
      await fn(dir);
    } finally {
      eng.kind = was.kind;
      if (was.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was.cfg;
      if (was.adapter === undefined) delete process.env.WEB_SEARCH_ADAPTER; else process.env.WEB_SEARCH_ADAPTER = was.adapter;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const adapterOf = async (params: any, provider?: any) => {
    const r = new SessionRunner(params, provider);
    await tick();
    const env = queries[queries.length - 1].options.env;
    await r.close();
    return env?.WEB_SEARCH_ADAPTER;
  };
  const openaiProvider = { id: 'ds', name: 'DS', type: 'openai', baseUrl: 'https://relay/v1', apiKey: 'sk', createdAt: 0, shim: { base: 'http://127.0.0.1:9/gateway/~p/ds', key: 'cws-x' } };

  it('our engine\'s own WebSearch keeps the backend it picks itself: nothing is set for it, on the account or on a provider', async () => {
    await withConfig({}, async (dir) => {
      eng.kind = 'ccb';
      expect(await adapterOf({ sessionId: 'w1', cwd: dir })).toBeUndefined();
      expect(await adapterOf({ sessionId: 'w2', cwd: dir }, openaiProvider)).toBeUndefined();
      eng.kind = 'claude';
      expect(await adapterOf({ sessionId: 'w3', cwd: dir })).toBeUndefined();
    });
  });

  it('…and what the user chose reaches it as it is: their environment, the conversation\'s env', async () => {
    await withConfig({}, async (dir) => {
      eng.kind = 'ccb';
      process.env.WEB_SEARCH_ADAPTER = 'exa';
      expect(await adapterOf({ sessionId: 'u1', cwd: dir })).toBe('exa');
      delete process.env.WEB_SEARCH_ADAPTER;
      expect(await adapterOf({ sessionId: 'u2', cwd: dir, features: { env: { WEB_SEARCH_ADAPTER: 'brave' } } })).toBe('brave');
    });
  });

  it('the `web` MCP server goes to the CLI next to the memory one, with the search pre-allowed — once the server is listening', async () => {
    const { configureWebMcp } = await import('../web/launcher.js');
    await withConfig({}, async (dir) => {
      const before = new SessionRunner({ sessionId: 'm1', cwd: dir } as any);
      await tick();
      expect(queries[0].options.mcpServers).toEqual({}); // (the memory launcher is mocked away in this file)
      expect(queries[0].options.allowedTools).toBeUndefined();
      await before.close();
      configureWebMcp({ url: 'http://127.0.0.1:45678', token: 'x'.repeat(64) }, dir);
      try {
        const r = new SessionRunner({ sessionId: 'm2', cwd: dir } as any);
        await tick();
        const o = queries[1].options;
        expect(Object.keys(o.mcpServers)).toEqual(['web']);
        expect(o.mcpServers.web.env).toMatchObject({ CW_WEB_URL: 'http://127.0.0.1:45678', CW_SESSION_ID: 'm2' });
        expect(JSON.stringify(o.mcpServers)).not.toContain('x'.repeat(64)); // this object ends up on the CLI's command line
        expect(o.allowedTools).toEqual(['mcp__web__web_search']);
        await r.close();
      } finally {
        configureWebMcp(null, dir);
      }
    });
  });
});
