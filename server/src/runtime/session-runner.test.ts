import { describe, expect, it, vi } from 'vitest';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/** Every query() the runner starts: end / fail its message stream, push a message into it, react to interrupt(). */
interface FakeQuery { options: any; end: () => void; fail: (e: Error) => void; push: (m: any) => void; onInterrupt?: () => void; flags: any[]; sides: any[]; sideAnswer?: any; toggles: [string, boolean][]; mcp?: any[]; usage?: any }
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
    const h: FakeQuery = { options, end: () => { ended = true; settle(); }, fail: (e) => { err = e; settle(); }, push: (m) => { buf.push(m); settle(); }, flags: [], sides: [], toggles: [] };
    const q: any = {
      initializationResult: async () => ({}),
      supportedCommands: async () => [],
      supportedModels: async () => cli.models,
      supportedAgents: async () => [],
      mcpServerStatus: async () => h.mcp ?? [],
      // what the context holds now (fitBeforeSwitch asks); nothing said: an empty answer, as before
      getContextUsage: async () => h.usage,
      toggleMcpServer: async (name: string, enabled: boolean) => { h.toggles.push([name, enabled]); },
      [Symbol.asyncIterator]: () => ({ next }),
      return: async () => { h.end(); return { value: undefined, done: true }; },
      setModel: async () => { throw new Error('unsupported'); },
      interrupt: async () => { h.onInterrupt?.(); },
      applyFlagSettings: async (f: any) => { h.flags.push(f); },
      askSideQuestion: async (question: string, opts: any) => { h.sides.push({ question, opts }); return h.sideAnswer ?? null; },
    };
    queries.push(h);
    return q;
  },
  // 跨对话工具 builds an in-process MCP server: here only its shape matters
  createSdkMcpServer: (o: any) => ({ type: 'sdk', name: o.name, instance: {} }),
  tool: (name: string) => ({ name }),
}));
const eng = vi.hoisted(() => ({ kind: 'claude' as 'claude' | 'ccb' }));
/** what the CLI answers to supportedModels() (the account's list) */
const cli = vi.hoisted(() => ({ models: [] as any[] }));
vi.mock('../claude-exe.js', () => ({ resolveEngine: (rt?: 'claude' | 'ccb') => ({ file: 'claude', kind: rt ?? eng.kind }), spawnClaude: () => null }));
vi.mock('../memory/launcher.js', () => ({ claudeMcpServer: () => ({}) }));
// stage E5: a WSL conversation spawns wsl.exe (only spawn is caught; the rest of child_process stays real)
const spawned = vi.hoisted(() => [] as { cmd: string; args: string[]; opts: any }[]);
vi.mock('node:child_process', async (orig) => {
  const real: any = await orig();
  const { EventEmitter } = await import('node:events');
  return { ...real, spawn: (cmd: string, args: string[], opts: any) => { spawned.push({ cmd, args, opts }); const c: any = new EventEmitter(); c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {}; return c; } };
});

// E-minor: a \\wsl.localhost path never reaches the real disk here (it would wake WSL's file server, seconds per touch,
// or fail on a machine without WSL): every fs call on one answers "not there" at once, as for a folder with no settings
const wslTouches = vi.hoisted(() => ({ n: 0 }));
const isWslPath = vi.hoisted(() => (p: unknown) => typeof p === 'string' && /^[\\/]{2}wsl(\.localhost|\$)[\\/]/i.test(p));
const enoent = vi.hoisted(() => (p: string) => Object.assign(new Error('ENOENT: no such file or directory, ' + p), { code: 'ENOENT' }));
vi.mock('node:fs', async (orig) => {
  const real: any = await orig();
  const sync = ['existsSync', 'statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'accessSync', 'realpathSync', 'openSync'];
  const out: any = { ...real };
  for (const k of sync) out[k] = (p: any, ...a: any[]) => { if (isWslPath(p)) { wslTouches.n++; if (k === 'existsSync') return false; throw enoent(p); } return real[k](p, ...a); };
  out.promises = { ...real.promises };
  for (const k of ['stat', 'lstat', 'readFile', 'readdir', 'access', 'realpath', 'open']) out.promises[k] = (p: any, ...a: any[]) => { if (isWslPath(p)) { wslTouches.n++; return Promise.reject(enoent(p)); } return real.promises[k](p, ...a); };
  return { ...out, default: out };
});
vi.mock('node:fs/promises', async (orig) => {
  const real: any = await orig();
  const out: any = { ...real };
  for (const k of ['stat', 'lstat', 'readFile', 'readdir', 'access', 'realpath', 'open']) out[k] = (p: any, ...a: any[]) => { if (isWslPath(p)) { wslTouches.n++; return Promise.reject(enoent(p)); } return real[k](p, ...a); };
  return { ...out, default: out };
});

const { SessionRunner } = await import('./session-runner.js');
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('SessionRunner', () => {
  it('stage E5: a WSL conversation runs the distro\'s own claude through wsl.exe, in its Linux folder', async () => {
    queries.length = 0;
    spawned.length = 0;
    const r = new SessionRunner({ sessionId: 'wsl1', cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\p', env: { kind: 'wsl', distro: 'Ubuntu' } } as any);
    await tick();
    const o = queries[0].options;
    expect(o.pathToClaudeCodeExecutable).toBe('claude');
    o.spawnClaudeCodeProcess({ command: 'claude', args: ['-p'], env: {}, cwd: 'x' });
    expect(spawned[0].cmd).toBe('wsl.exe');
    expect(spawned[0].args).toEqual(['-d', 'Ubuntu', '--cd', '/home/me/p', '--exec', 'sh', '-lc', 'exec claude "$@"', 'claude', '-p']);
    expect(spawned[0].opts.windowsHide).toBe(true);
    expect(r.info.wsl).toEqual({ distro: 'Ubuntu', dropped: [] });
    await r.close();
    expect(wslTouches.n).toBeGreaterThan(0); // the runner did look at the folder — through the stub, not the real disk
  });

  it('extra project folders go to the SDK as additionalDirectories; none → the option is absent', async () => {
    queries.length = 0;
    const a = new SessionRunner({ sessionId: 'dirs1', cwd: '/proj' } as any, undefined, { additionalDirectories: ['/lib', '/docs'] });
    await tick();
    expect(queries[0].options.additionalDirectories).toEqual(['/lib', '/docs']);
    expect(queries[0].options.cwd).toBe('/proj');
    await a.close();
    queries.length = 0;
    const b = new SessionRunner({ sessionId: 'dirs2', cwd: '/proj' } as any);
    await tick();
    expect('additionalDirectories' in queries[0].options).toBe(false);
    await b.close();
  });

  it('a claude.ai-login session on ccb resolves models like the official Claude Code; other sessions are untouched', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const a = new SessionRunner({ sessionId: 'm1', cwd: '/x', model: 'fable' } as any);
      await tick();
      // ccb has no fable alias; the account's family default (1M, A7) keeps its [1m]
      expect(queries[0].options.model).toBe('claude-fable-5-1[1m]');
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
        expect(queries[2].options.model).toBe('opus[1m]');
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
      expect(queries[4].options.model).toBe('fable[1m]');
      expect(queries[4].options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
      await e.close();
    } finally {
      eng.kind = 'claude';
    }
  });

  it('another Claude account: the account path (its aliases on ccb, its own model list) with that account\'s token, nothing of a relay in between', async () => {
    eng.kind = 'ccb';
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-relay-from-the-environment';
    process.env.ANTHROPIC_BASE_URL = 'https://relay.invalid';
    try {
      queries.length = 0;
      const acct = { id: 'acc2', name: '工作号', type: 'claude-account', baseUrl: '', apiKey: 'sk-ant-oat01-' + 'x'.repeat(60), models: ['claude-opus-5-5'] } as any;
      const r = new SessionRunner({ sessionId: 'acc-1', cwd: '/x', model: 'fable' } as any, acct);
      await tick();
      const env = queries[0].options.env;
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(acct.apiKey);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('');
      expect(env.ANTHROPIC_BASE_URL).toBe('');
      // the account's own alias table on ccb, as for the ~/.claude login
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-5-5');
      expect(queries[0].options.model).toBe('claude-fable-5-1[1m]'); // its family picks: none, so 1M (A7)
      // the chip names the account it runs on
      expect(r.info).toMatchObject({ providerId: 'acc2', providerName: '工作号' });
      // no relay windows / caps tables for it: the account's are the CLI's own
      expect(env.CLAUDE_WEB_CONTEXT_WINDOWS).toBeUndefined();
      expect(env.CLAUDE_WEB_MODEL_CAPS).toBeUndefined();
      await r.close();
    } finally {
      eng.kind = 'claude';
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      delete process.env.ANTHROPIC_BASE_URL;
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
    expect(queries[1].options.extraArgs).toEqual({ chrome: null, worktree: 'wt', 'thinking-display': 'summarized' });
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

  it('ccb wraps an MCP tool in ExecuteExtraTool: allowed when the tool inside is, asked otherwise', async () => {
    const { SESSIONS_ALLOWED, setSessionsDeps } = await import('../sessions-mcp/tools.js');
    setSessionsDeps({ list: async () => [], read: async () => [], stateOf: () => undefined, deliver: async () => {}, rename: async () => {}, archive: async () => {} });
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'xt', cwd: '/x' } as any);
    await tick();
    setSessionsDeps(null);
    expect(queries[0].options.mcpServers.sessions).toMatchObject({ type: 'sdk', name: 'sessions' });
    const allowed = queries[0].options.allowedTools as string[];
    const inner = 'mcp__sessions__list_sessions';
    expect(allowed).toEqual(expect.arrayContaining(SESSIONS_ALLOWED));
    expect(allowed).not.toContain('mcp__sessions__archive_session');
    const ok = await queries[0].options.canUseTool('ExecuteExtraTool', { tool_name: inner, params: { limit: 5 } }, { signal: new AbortController().signal });
    expect(ok).toEqual({ behavior: 'allow', updatedInput: { tool_name: inner, params: { limit: 5 } } });
    expect(r.getPendingPermissions()).toHaveLength(0);
    // archive_session (or anything not on the list) still asks
    void queries[0].options.canUseTool('ExecuteExtraTool', { tool_name: 'mcp__sessions__archive_session', params: { id: 'a' } }, { signal: new AbortController().signal });
    expect(r.getPendingPermissions()).toHaveLength(1);
    await r.close();
  });
});

// 2026-10-19 user report: a DeepSeek conversation compacted every 1.5–2 minutes (cache hit 26–33%) on a guessed 128K
// window; setting 1M in settings did nothing to the conversation already running — its process had the old env
describe('SessionRunner: the provider saved in settings', () => {
  const prov = { id: 'ds', name: 'DS', type: 'anthropic', baseUrl: 'https://relay', apiKey: 'sk', createdAt: 0, models: ['deepseek-v4.1-flash'] } as any;
  it('a change reaches the next process (once the turn is done); the same settings again restart nothing', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'w-1', cwd: '/x', model: 'deepseek-v4.1-flash' } as any, prov);
    await tick();
    await r.reprovide({ ...prov });
    await tick();
    expect(queries).toHaveLength(1);
    await r.reprovide({ ...prov, contextWindows: { 'deepseek-v4.1-flash': 1_000_000 } });
    await tick();
    expect(queries).toHaveLength(2);
    await r.reprovide({ ...prov, id: 'other', contextWindows: { 'deepseek-v4.1-flash': 5 } }); // not its provider
    await tick();
    expect(queries).toHaveLength(2);
    await r.close();
  });

  it('idle but with background subagents running: the restart waits until they are back (it would kill them)', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'w-2', cwd: '/x', model: 'deepseek-v4.1-flash' } as any, prov);
    await tick();
    r.send('go');
    queries[0].push({ type: 'system', subtype: 'task_started', task_id: 'bg1', session_id: 'w-2', uuid: 's1' });
    queries[0].push({ type: 'result', subtype: 'success', session_id: 'w-2', uuid: 'r1', is_error: false, result: 'waiting for them' });
    await tick();
    expect(r.hasBackgroundWork()).toBe(true);
    await r.reprovide({ ...prov, contextWindows: { 'deepseek-v4.1-flash': 1_000_000 } });
    await tick();
    expect(queries).toHaveLength(1); // not now
    // the subagent is back; its notification's turn ends → now
    queries[0].push({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed', session_id: 'w-2', uuid: 's2' });
    queries[0].push({ type: 'result', subtype: 'success', session_id: 'w-2', uuid: 'r2', is_error: false, result: 'all back' });
    await tick();
    await tick();
    expect(queries).toHaveLength(2);
    await r.close();
  });
});

// 2026-10-19 user: 「子代理设置什么样，那就会派什么子代理，硬绑定，不要用户在提示词还要另外 trigger」
describe('SessionRunner: a subagent model picked → the work is delegated', () => {
  it('the system prompt tells the main model to use subagents only when one is picked; 只聊天 never', async () => {
    const appended = (i: number): string => queries[i].options.systemPrompt.append ?? '';
    queries.length = 0;
    const same = new SessionRunner({ sessionId: 'sp-0', cwd: '/x' } as any);
    await tick();
    expect(appended(0)).not.toContain('# Subagents');
    await same.close();
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'sp-1', cwd: '/x', subagentModel: 'claude-haiku-4-5' } as any);
    await tick();
    expect(appended(0)).toContain('# Subagents');
    expect(appended(0)).toContain('(claude-haiku-4-5)');
    await r.close();
    // a pick that cannot be reached (its provider gone): the subagents stay on the main model — no section either
    queries.length = 0;
    const gone = new SessionRunner({ sessionId: 'sp-3', cwd: '/x', subagentModel: 'cw-x:nope:deepseek-v4.1-flash' } as any);
    await tick();
    expect(queries[0].options.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(appended(0)).not.toContain('# Subagents');
    await gone.close();
    queries.length = 0;
    const chat = new SessionRunner({ sessionId: 'sp-2', cwd: '/x', subagentModel: 'claude-haiku-4-5', features: { chatOnly: true } } as any);
    await tick();
    expect(appended(0)).not.toContain('# Subagents');
    await chat.close();
  });
});

// 2026-10-22: the per-step reminder hook tripped the API's safety classifier on Opus 5.5 / Fable 5.1 — the system
// prompt carries the language, and no hook is handed to the SDK any more
describe('SessionRunner: 思考用的语言 — the system prompt only', () => {
  it('no hooks are handed out, with or without a language', async () => {
    queries.length = 0;
    const off = new SessionRunner({ sessionId: 'th-0', cwd: '/x' } as any);
    await tick();
    expect(queries[0].options.hooks).toBeUndefined();
    await off.close();
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'th-1', cwd: '/x' } as any, undefined, { thinkingLanguage: 'zh-CN' });
    await tick();
    expect(queries[0].options.hooks).toBeUndefined();
    await r.close();
  });
});

describe('SessionRunner: 思考用的语言', () => {
  const appended = (i: number): string => queries[i].options.systemPrompt.append ?? '';
  it('the setting / the conversation’s pick go into the system prompt; a change restarts once, the same one nothing', async () => {
    const { setThinkingLanguageSetting } = await import('./session-runner.js');
    queries.length = 0;
    const off = new SessionRunner({ sessionId: 'tl-0', cwd: '/x' } as any);
    await tick();
    expect(appended(0)).not.toContain('Thinking language');
    await off.close();
    setThinkingLanguageSetting('ja');
    try {
      queries.length = 0;
      const r = new SessionRunner({ sessionId: 'tl-1', cwd: '/x' } as any);
      await tick();
      expect(appended(0)).toContain('日本語 (Japanese)');
      await r.refreshThinkingLanguage(); // the same instruction: no restart
      await tick();
      expect(queries).toHaveLength(1);
      await r.refreshThinkingLanguage('fr'); // this conversation's own pick
      await tick();
      expect(queries).toHaveLength(2);
      expect(appended(1)).toContain('Français (French)');
      await r.refreshThinkingLanguage('off');
      await tick();
      expect(queries).toHaveLength(3);
      expect(appended(2)).not.toContain('Thinking language');
      await r.close();
      // picked when it opens (pool: SessionMeta.thinkingLanguage)
      queries.length = 0;
      const own = new SessionRunner({ sessionId: 'tl-2', cwd: '/x' } as any, undefined, { thinkingLanguage: 'ko' });
      await tick();
      expect(appended(0)).toContain('한국어 (Korean)');
      setThinkingLanguageSetting('de'); // the conversation keeps its own
      await own.refreshThinkingLanguage();
      await tick();
      expect(queries).toHaveLength(1);
      await own.close();
    } finally { setThinkingLanguageSetting(''); }
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

  it('下一句提示: on by default — the option and the CLI’s own switch; off leaves both out', async () => {
    const { setPromptSuggestions } = await import('./session-runner.js');
    queries.length = 0;
    const a = new SessionRunner({ sessionId: 'ps-1', cwd: '/x' } as any);
    await tick();
    expect(queries[0].options.promptSuggestions).toBe(true);
    expect(queries[0].options.env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe('1');
    expect(queries[0].options.env?.CLAUDE_CODE_REPORT_FINDINGS).toBe('1'); // 代码审查卡
    await a.close();
    setPromptSuggestions(false);
    try {
      queries.length = 0;
      const b = new SessionRunner({ sessionId: 'ps-2', cwd: '/x' } as any);
      await tick();
      expect(queries[0].options.promptSuggestions).toBe(false);
      expect(queries[0].options.env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBeUndefined();
      await b.close();
    } finally { setPromptSuggestions(true); }
  });

  it('预览服务器: the tools are there, only logs / stop pre-allowed; a project with launch.json is told to verify', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { setPreviewDeps, PREVIEW_ALLOWED } = await import('../preview/tools.js');
    const { PreviewService } = await import('../preview/service.js');
    setPreviewDeps({ service: new PreviewService(), open: async () => {} });
    const withLaunch = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pv-'));
    fs.mkdirSync(path.join(withLaunch, '.claude'));
    fs.writeFileSync(path.join(withLaunch, '.claude', 'launch.json'), '{ "configurations": [{ "name": "web", "program": "s.js" }] }');
    const without = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-pv-'));
    try {
      queries.length = 0;
      const a = new SessionRunner({ sessionId: 'pv-1', cwd: withLaunch } as any);
      await tick();
      const o = queries[0].options;
      expect(o.mcpServers.preview).toMatchObject({ type: 'sdk', name: 'preview' });
      expect(o.allowedTools).toEqual(expect.arrayContaining(PREVIEW_ALLOWED));
      expect(o.allowedTools).not.toContain('mcp__preview__preview_start');
      expect(o.systemPrompt.append).toMatch(/preview_start/);
      await a.close();
      queries.length = 0;
      const b = new SessionRunner({ sessionId: 'pv-2', cwd: without } as any);
      await tick();
      // (the ```nodegraph hint, spec D4, is appended to every conversation by default — only the verify part must be missing)
      expect(queries[0].options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
      expect(queries[0].options.systemPrompt.append ?? '').not.toMatch(/preview_start|launch\.json/);
      await b.close();
      // spec D4: the ```nodegraph hint follows ui.nodegraphHint, read when a process starts
      const { setNodegraphHint } = await import('./session-runner.js');
      expect(queries[0].options.systemPrompt.append).toMatch(/```nodegraph/);
      setNodegraphHint(false);
      queries.length = 0;
      const c = new SessionRunner({ sessionId: 'pv-3', cwd: without } as any);
      await tick();
      expect(queries[0].options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
      await c.close();
      setNodegraphHint(true);
    } finally {
      setPreviewDeps(null);
      fs.rmSync(withLaunch, { recursive: true, force: true });
      fs.rmSync(without, { recursive: true, force: true });
    }
  });

  it('只聊天: no tools at all — none of the engine’s, none of ours, none from the user’s settings', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'chat-1', cwd: '/x', features: { chatOnly: true } } as any);
    await tick();
    const o = queries[0].options;
    expect(o.tools).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toEqual({});
    expect(o.allowedTools).toBeUndefined();
    expect(o.plugins).toBeUndefined();
    await r.close();
    queries.length = 0;
    const normal = new SessionRunner({ sessionId: 'chat-2', cwd: '/x' } as any);
    await tick();
    expect(queries[0].options.tools).toBeUndefined();
    await normal.close();
  });

  it('the ```nodegraph hint only where a person reads the replies in Claude Web (review D-minor)', async () => {
    const hintOf = async (p: Record<string, unknown>) => {
      queries.length = 0;
      const r = new SessionRunner({ cwd: '/x', ...p } as any);
      await tick();
      const t = String(queries[0].options.systemPrompt?.append ?? '');
      await r.close();
      return /```nodegraph/.test(t);
    };
    expect(await hintOf({ sessionId: 'ng-1' })).toBe(true);
    expect(await hintOf({ sessionId: 'ng-2', features: { chatOnly: true } })).toBe(false);
    for (const drivenBy of ['im', 'schedule', 'orchestra']) expect(await hintOf({ sessionId: `ng-${drivenBy}`, drivenBy }), drivenBy).toBe(false);
  });

  // 2026-10-22: a fresh conversation on a Gemini-web / WorkBuddy group sent 177 KB on its first turn. Narrowing the
  // engine's tools also takes its tool search away, so every MCP tool (the account's claude.ai connectors, the user's
  // settings, ours) was inlined — more than the full set. No MCP and no plugins: 62 KB.
  it('a sidecar-only gateway (leanTools): the core tools and nothing from MCP servers or plugins', async () => {
    queries.length = 0;
    const lean = { id: 'gw', name: '默认', type: 'anthropic', baseUrl: 'http://127.0.0.1:1/default', apiKey: 'k', createdAt: 0, models: [], leanTools: true } as any;
    const r = new SessionRunner({ sessionId: 'lean-1', cwd: '/x', subagentModel: 'claude-haiku-4-5' } as any, lean);
    await tick();
    const o = queries[0].options;
    expect(o.tools).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'TodoWrite']);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toEqual({});
    expect(o.plugins).toBeUndefined();
    // there is no Agent tool to hand work to
    expect(JSON.stringify(o.systemPrompt)).not.toMatch(/subagent/i);
    await r.close();
  });

  // two catch-ups at once each restarted the process: two engines resuming one conversation (verifier, 2026-10-22)
  it('reloadTranscript: one restart at a time, and not quiet while it runs', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'reload-1', cwd: '/x' } as any);
    await tick();
    expect(queries).toHaveLength(1);
    (r as any).state = 'idle';
    (r as any).lastActivity = 0;
    expect(r.quiet()).toBe(true);
    const a = r.reloadTranscript();
    const b = r.reloadTranscript();
    expect(b).toBe(a);
    expect(r.quiet()).toBe(false);
    await a;
    await tick();
    expect(queries).toHaveLength(2);
    await r.close();
  });

  // a send waited 11 s for nothing while a dev server ran in the background (verifier, 2026-10-22)
  it('settling: what ends soon on its own — not background work', async () => {
    const r = new SessionRunner({ sessionId: 'settle-1', cwd: '/x' } as any);
    await tick();
    (r as any).state = 'idle';
    (r as any).lastActivity = Date.now();
    expect(r.quiet()).toBe(false);
    expect(r.settling()).toBe(true);
    (r as any).state = 'starting';
    expect(r.settling()).toBe(true);
    (r as any).bgLive.add('task-1');
    expect(r.settling()).toBe(false);
    (r as any).bgLive.clear();
    (r as any).state = 'idle';
    (r as any).lastActivity = 0;
    expect(r.quiet()).toBe(true);
    expect(r.settling()).toBe(false);
    (r as any).state = 'running';
    expect(r.settling()).toBe(false);
    await r.close();
  });

  it('本机环境变量 reach the conversation, under its own variables', async () => {
    const { setLocalEnv } = await import('./local-env.js');
    setLocalEnv({ DATABASE_URL: 'pg://local', CLAUDE_CODE_REPORT_FINDINGS: 'never' });
    try {
      queries.length = 0;
      const r = new SessionRunner({ sessionId: 'env-1', cwd: '/x', features: { env: { DATABASE_URL: 'pg://session' } } } as any);
      await tick();
      expect(queries[0].options.env?.DATABASE_URL).toBe('pg://session');
      expect(queries[0].options.env?.CLAUDE_CODE_REPORT_FINDINGS).toBe('1'); // a reserved name never gets in
      await r.close();
      queries.length = 0;
      const b = new SessionRunner({ sessionId: 'env-2', cwd: '/x' } as any);
      await tick();
      expect(queries[0].options.env?.DATABASE_URL).toBe('pg://local');
      await b.close();
    } finally { setLocalEnv({}); }
  });

  it('旁聊: asks the engine with the side chat so far, and the conversation hears nothing of it', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'side-1', cwd: '/x' } as any);
    await tick();
    const msgs = collect(r);
    queries[0].sideAnswer = { response: 'the answer', synthetic: false };
    const hist = [{ question: 'a', response: 'b' }];
    expect(await r.askSide('why?', hist)).toEqual({ text: 'the answer', synthetic: false });
    expect(queries[0].sides).toEqual([{ question: 'why?', opts: { history: hist } }]);
    queries[0].sideAnswer = null;
    expect(await r.askSide('again?', [])).toEqual({ text: null });
    expect(msgs).toEqual([]);
    expect(r.state).toBe('idle');
    await r.close();
  });

  it('快速模式: what the CLI reports (init, result) is the info; switching is a flag setting', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'fast-1', cwd: '/x' } as any);
    await tick();
    expect(r.info.fastMode).toBeUndefined();
    queries[0].push({ type: 'system', subtype: 'init', session_id: 'fast-1', model: 'm', tools: [], fast_mode_state: 'off', fast_mode_disabled_reason: 'preference' });
    await tick();
    expect([r.info.fastMode, r.info.fastModeOff]).toEqual(['off', 'preference']);
    await r.setFastMode(true);
    expect(queries[0].flags).toContainEqual({ fastMode: true });
    expect(r.info.fastMode).toBe('on');
    queries[0].push({ type: 'result', subtype: 'success', session_id: 'fast-1', fast_mode_state: 'cooldown', usage: {}, total_cost_usd: 0 });
    await tick();
    expect(r.info.fastMode).toBe('cooldown');
    await r.close();
  });

  it('连接器 ›: a connector switched with the CLI’s own toggle, then its list read again', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'mcp-1', cwd: '/x' } as any);
    await tick();
    queries[0].mcp = [{ name: 'web', status: 'disabled' }];
    await r.toggleMcp('web', false);
    expect(queries[0].toggles).toEqual([['web', false]]);
    expect(r.info.mcpServers).toEqual([{ name: 'web', status: 'disabled', error: undefined, tools: undefined }]);
    await r.close();
  });

  it('a picture sent alone goes out without an empty text block (the API refuses one, on every later turn too)', async () => {
    const r = new SessionRunner({ sessionId: 'img-1', cwd: '/x' } as any);
    await tick();
    const sent: any[] = [];
    r.on('sent', (m: any) => sent.push(m));
    const img = { mediaType: 'image/png', data: 'AAAA' };
    r.send('', [img]);
    r.send('  ', [img]);
    r.send('look', [img]);
    expect(sent.map((m) => m.message.content.map((b: any) => b.type))).toEqual([['image'], ['image'], ['image', 'text']]);
    await r.close();
  });

  it('refused for an empty text block in the history: the process starts over once (its memory has the block, the file no longer)', async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'img-2', cwd: '/x' } as any);
    await tick();
    r.send('hi');
    queries[0].push({ ...result(), is_error: true, result: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.18.content.1.text: cache_control cannot be set for empty text blocks"}}' });
    await tick();
    await tick();
    expect(queries).toHaveLength(2);
    // another error: no restart
    r.send('again');
    queries[1].push({ ...result(), is_error: true, result: 'API Error: 529 overloaded' });
    await tick();
    await tick();
    expect(queries).toHaveLength(2);
    await r.close();
  });

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

  // 2026-10-19 user report: a conversation on deepseek-v4.1-flash (its answers had thinking " " with no signature),
  // switched to claude-opus-5-5 — 400 「messages.179.content.0.thinking: each thinking block must contain non-whitespace
  // thinking」 on every turn, the engine sending that history each time
  const blankThinking = async (dir: string, id: string, thinking = ' ') => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.join(dir, 'projects', 'C--work-app'), { recursive: true });
    const file = path.join(dir, 'projects', 'C--work-app', `${id}.jsonl`);
    const use = { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } };
    fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'deepseek-v4.1-flash', content: [{ type: 'thinking', thinking, signature: '' }, use] } })}\n`);
    return () => JSON.parse(fs.readFileSync(file, 'utf8').trim()).message.content.map((b: any) => b.type);
  };

  it('refused for a blank thinking block in the history: the process starts over and the resume reads the transcript without it', async () => {
    await withConfigDir(async (dir) => {
      const types = await blankThinking(dir, 'think-1');
      queries.length = 0;
      const r = new SessionRunner({ sessionId: 'think-1', cwd: '/x' } as any);
      await tick();
      expect(types()).toEqual(['thinking', 'tool_use']); // not on every resume: only after that 400
      r.send('go on');
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'think-1', uuid: 'r1', is_error: true, result: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.179.content.0.thinking: each thinking block must contain non-whitespace thinking"},"request_id":"req_011CgBFTYeFCxNiPHoaRoY5U"}' });
      await tick();
      await tick();
      expect(queries).toHaveLength(2);
      expect(queries[1].options.resume).toBe('think-1');
      expect(types()).toEqual(['tool_use']);
      await r.close();
    });
  });

  // the same conversation, once the blank ones were gone, on a real Opus turn: 「messages.3.content.0: Invalid
  // `signature` in `thinking` block」 — every DeepSeek thinking block had signature ""
  const ds = { id: 'ds', name: 'DS', type: 'anthropic', baseUrl: 'https://relay', apiKey: 'sk', createdAt: 0, models: ['deepseek-v4.1-flash', 'claude-opus-5-5'] } as any;

  it('refused for an unsigned thinking block: the resume reads the transcript without any (whatever the model is called)', async () => {
    await withConfigDir(async (dir) => {
      const types = await blankThinking(dir, 'sig-1', 'plan the gateway');
      queries.length = 0;
      const r = new SessionRunner({ sessionId: 'sig-1', cwd: '/x', model: 'relay-model-x' } as any, ds);
      await tick();
      r.send('go on');
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'sig-1', uuid: 'r1', is_error: true, result: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0: Invalid `signature` in `thinking` block"},"request_id":"req_011CgBgGgwBErAmFwvT6i2cw"}' });
      await tick();
      await tick();
      expect(queries).toHaveLength(2);
      expect(types()).toEqual(['tool_use']);
      await r.close();
    });
  });

  it('from another vendor\'s model to Claude: always another process, the unsigned thinking taken out first; between other models it stays', async () => {
    await withConfigDir(async (dir) => {
      const types = await blankThinking(dir, 'sig-2', 'plan the gateway');
      queries.length = 0;
      const r = new SessionRunner({ sessionId: 'sig-2', cwd: '/x', model: 'deepseek-v4.1-flash' } as any, ds);
      await tick();
      (r as any).q.setModel = async () => {}; // the engine could switch in place
      await r.setModel('deepseek-v4-pro');
      await tick();
      expect(queries).toHaveLength(1);
      expect(types()).toEqual(['thinking', 'tool_use']);
      await r.setModel('claude-opus-5-5');
      await tick();
      expect(queries).toHaveLength(2);
      expect(types()).toEqual(['tool_use']);
      await r.close();
    });
  });

  it('switching model takes blank blocks out before the next process resumes (no 400 first)', async () => {
    await withConfigDir(async (dir) => {
      const types = await blankThinking(dir, 'think-2');
      queries.length = 0;
      const r = new SessionRunner({ sessionId: 'think-2', cwd: '/x', model: 'sonnet' } as any);
      await tick();
      await r.setModel('opus'); // the fake rejects setModel → the runner restarts its process
      await tick();
      expect(queries).toHaveLength(2);
      expect(types()).toEqual(['tool_use']);
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

  it('Claude’s thinking comes back as text: --thinking-display on the official binary, an env var on ccb (it refuses the flag)', async () => {
    queries.length = 0;
    const a = new SessionRunner({ sessionId: 'th1', cwd: '/x', model: 'claude-opus-5-5' } as any);
    await tick();
    expect(queries[0].options.extraArgs['thinking-display']).toBe('summarized');
    expect(queries[0].options.env?.CLAUDE_WEB_THINKING_DISPLAY).toBeUndefined();
    await a.close();
    // an Anthropic-format relay of another maker's model: no field it may not know
    const ds = { id: 'ds', name: 'ds', type: 'anthropic', runtime: 'claude', baseUrl: 'https://relay.invalid', apiKey: 'k', models: ['deepseek-chat'] } as any;
    const c = new SessionRunner({ sessionId: 'th3', cwd: '/x', model: 'deepseek-chat' } as any, ds);
    await tick();
    expect('thinking-display' in queries[queries.length - 1].options.extraArgs).toBe(false);
    await c.close();
    queries.length = 1;
    eng.kind = 'ccb';
    try {
      const b = new SessionRunner({ sessionId: 'th2', cwd: '/x', model: 'claude-sonnet-4-6' } as any, xy);
      await tick();
      expect('thinking-display' in queries[1].options.extraArgs).toBe(false);
      expect(queries[1].options.env?.CLAUDE_WEB_THINKING_DISPLAY).toBe('summarized');
      await b.close();
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
      const ds = { id: 'ds', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.invalid', apiKey: 'k', models: ['deepseek-flash', 'gpt-4o', 'qwen-plus', 'gpt-image-2'], modelEfforts: { 'deepseek-flash': { levels: ['low', 'high', 'max'], default: 'high' } }, promptEffortModels: ['qwen-plus'] } as any;
      const a = new SessionRunner({ sessionId: 'caps1', cwd: '/x', model: 'deepseek-flash' } as any, ds);
      await tick();
      const caps = JSON.parse(queries[0].options.env.CLAUDE_WEB_MODEL_CAPS);
      expect(caps['deepseek-flash']).toEqual({ levels: ['low', 'high', 'max'], default: 'high', reasoning: true });
      // 2026-10-26: every model on an OpenAI-format profile gets reasoning_effort until it refuses it
      expect(caps['gpt-4o']).toEqual({ levels: ['low', 'medium', 'high'], reasoning: true });
      expect(caps['qwen-plus']).toEqual({ native: false });
      const byId = Object.fromEntries((a.info.models ?? []).map((m) => [m.value, m]));
      expect(byId['deepseek-flash']).toMatchObject({ supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'], effortMode: 'native' });
      expect(byId['gpt-4o']).toMatchObject({ supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], effortMode: 'native' });
      expect(byId['qwen-plus']).toMatchObject({ supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], effortMode: 'prompt' });
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

// 2026-10-24 review I3: the web divides the ring's context by min(window, this cap), as the engine's own count does
describe('SessionRunner: the autocompact cap goes on the session info', () => {
  it('from the user\'s settings.json env; absent when nothing sets it', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cap-'));
    const was = { cfg: process.env.CLAUDE_CONFIG_DIR, cap: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW };
    process.env.CLAUDE_CONFIG_DIR = dir;
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    try {
      const a = new SessionRunner({ sessionId: 'cap1', cwd: path.join(dir, 'proj') } as any);
      await tick();
      expect(a.info.compactWindow).toBeUndefined();
      await a.close();
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000' } }));
      const b = new SessionRunner({ sessionId: 'cap2', cwd: path.join(dir, 'proj') } as any);
      await tick();
      expect(b.info.compactWindow).toBe(700_000);
      await b.close();
    } finally {
      if (was.cfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was.cfg;
      if (was.cap !== undefined) process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = was.cap;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A7 (2026-10-24 user: 「有时候新对话还是 Opus 5.5 200k」; settings.json had CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000)
describe('SessionRunner: the account’s 200K / 1M picks and the 自动压缩 point', () => {
  /** A config folder (the "HOME" the engine reads settings.json from) and a data folder of our own. */
  const withHome = async (settingsEnv: Record<string, string> | null, fn: (dir: string) => Promise<void>) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-a7-'));
    const keys = ['CLAUDE_CONFIG_DIR', 'CLAUDE_WEB_DIR', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;
    const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'cfg');
    process.env.CLAUDE_WEB_DIR = path.join(dir, 'data');
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    if (settingsEnv) fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ env: settingsEnv }));
    const kind = eng.kind;
    try {
      queries.length = 0;
      await fn(dir);
    } finally {
      eng.kind = kind;
      for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const flagEnv = async (file: string | undefined) => {
    if (!file) return undefined;
    const fs = await import('node:fs');
    return JSON.parse(fs.readFileSync(file, 'utf8')).env;
  };
  const acct = (extra: Record<string, unknown> = {}) => ({ id: 'acc2', name: '工作号', type: 'claude-account', baseUrl: '', apiKey: 'sk-ant-oat01-' + 'x'.repeat(60), models: [], ...extra }) as any;

  it('the own login, nothing picked: a 1M family gets [1m] on both engines (ccb keeps it), the window is 1M', async () => {
    await withHome(null, async (dir) => {
      for (const kind of ['claude', 'ccb'] as const) {
        eng.kind = kind;
        queries.length = 0;
        const r = new SessionRunner({ sessionId: `a7-1-${kind}`, cwd: dir, model: 'claude-opus-5-5' } as any, undefined, { account: { windows: {} } });
        await tick();
        expect(queries[0].options.model).toBe('claude-opus-5-5[1m]');
        expect(r.info.contextWindow).toBe(1_000_000);
        await r.close();
      }
    });
  });

  it('the own login, Opus picked at 200K: `opus[1m]` goes out as `opus`, the window is 200K', async () => {
    await withHome(null, async (dir) => {
      const r = new SessionRunner({ sessionId: 'a7-2', cwd: dir, model: 'opus[1m]' } as any, undefined, { account: { windows: { opus: 200_000 } } });
      await tick();
      expect(queries[0].options.model).toBe('opus');
      expect(r.info.contextWindow).toBe(200_000);
      await r.close();
    });
  });

  it('haiku and `default` stay as they are (haiku is 200K; default is whatever the plan says: no window)', async () => {
    await withHome(null, async (dir) => {
      const h = new SessionRunner({ sessionId: 'a7-3', cwd: dir, model: 'claude-haiku-4-5' } as any, undefined, { account: { windows: {} } });
      await tick();
      expect(queries[0].options.model).toBe('claude-haiku-4-5');
      expect(h.info.contextWindow).toBe(200_000);
      await h.close();
      const d = new SessionRunner({ sessionId: 'a7-4', cwd: dir, model: 'default' } as any, undefined, { account: { windows: {} } });
      await tick();
      expect(queries[1].options.model).toBe('default');
      expect(d.info.contextWindow).toBeUndefined();
      await d.close();
    });
  });

  it('a claude-account profile reads its own family picks: Sonnet at 200K has no [1m]; Opus (not picked) does', async () => {
    await withHome(null, async (dir) => {
      const p = acct({ contextWindows: { sonnet: 200_000 } });
      const s = new SessionRunner({ sessionId: 'a7-5', cwd: dir, model: 'claude-sonnet-5' } as any, p);
      await tick();
      expect(queries[0].options.model).toBe('claude-sonnet-5');
      expect(s.info.contextWindow).toBe(200_000);
      await s.close();
      const o = new SessionRunner({ sessionId: 'a7-6', cwd: dir, model: 'claude-opus-5-5' } as any, p);
      await tick();
      expect(queries[1].options.model).toBe('claude-opus-5-5[1m]');
      expect(o.info.contextWindow).toBe(1_000_000);
      await o.close();
    });
  });

  it('the subagents’ model on the account gets the same treatment', async () => {
    await withHome(null, async (dir) => {
      const r = new SessionRunner({ sessionId: 'a7-7', cwd: dir, model: 'claude-opus-5-5', subagentModel: 'claude-sonnet-5' } as any, undefined, { account: { windows: { opus: 200_000 } } });
      await tick();
      expect(queries[0].options.model).toBe('claude-opus-5-5');
      expect(queries[0].options.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-sonnet-5[1m]');
      await r.close();
    });
  });

  it('the own login through a relay of the user’s (settings.json env): its model names stay as they were (no [1m] it never got before)', async () => {
    await withHome({ ANTHROPIC_BASE_URL: 'https://relay.invalid', ANTHROPIC_AUTH_TOKEN: 'x' }, async (dir) => {
      const r = new SessionRunner({ sessionId: 'a7-relay', cwd: dir, model: 'claude-opus-5-5' } as any, undefined, { account: { windows: {} } });
      await tick();
      expect(queries[0].options.model).toBe('claude-opus-5-5');
      expect(r.info.contextWindow).toBe(200_000);
      await r.close();
    });
  });

  it('an API provider is never touched by the account picks', async () => {
    await withHome(null, async (dir) => {
      // the provider says 200K, the account picks would say 1M: the provider's window, no [1m]
      const p = { id: 'p1', name: 'relay', type: 'anthropic', baseUrl: 'https://relay.invalid', apiKey: 'k', models: ['claude-opus-5-5'], contextWindows: { 'claude-opus-5-5': 200_000 } } as any;
      const r = new SessionRunner({ sessionId: 'a7-8', cwd: dir, model: 'claude-opus-5-5' } as any, p, { account: { windows: { opus: 1_000_000 } } });
      await tick();
      expect(queries[0].options.model).toBe('claude-opus-5-5');
      expect(r.info.contextWindow).toBe(200_000);
      await r.close();
      // …and the other way round: the provider's 1M Claude gets its [1m] whatever the account picked
      queries.length = 0;
      const big = new SessionRunner({ sessionId: 'a7-8b', cwd: dir, model: 'claude-opus-5-5' } as any, { ...p, contextWindows: {} }, { account: { windows: { opus: 200_000 } } });
      await tick();
      expect(queries[0].options.model).toBe('claude-opus-5-5[1m]');
      expect(big.info.contextWindow).toBe(1_000_000);
      await big.close();
    });
  });

  it('the account’s 自动压缩 point beats settings.json (700000) through --settings; unset, settings.json stays', async () => {
    await withHome({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000' }, async (dir) => {
      for (const kind of ['claude', 'ccb'] as const) {
        eng.kind = kind;
        queries.length = 0;
        const r = new SessionRunner({ sessionId: `a7-9-${kind}`, cwd: dir, model: 'claude-opus-5-5' } as any, undefined, { account: { windows: {}, compactAt: 500_000 } });
        await tick();
        const o = queries[0].options;
        expect(o.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
        expect((await flagEnv(o.settings))?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
        expect(r.info.compactWindow).toBe(500_000);
        await r.close();
      }
      // nothing set: the key is not written, the user's 700000 is what the engine gets
      queries.length = 0;
      const n = new SessionRunner({ sessionId: 'a7-10', cwd: dir, model: 'claude-opus-5-5' } as any, undefined, { account: { windows: {} } });
      await tick();
      expect(queries[0].options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(queries[0].options.settings).toBeUndefined();
      expect(n.info.compactWindow).toBe(700_000);
      await n.close();
      // another Claude account's own compactAt: the provider path (settingsOverride) carries it the same way
      queries.length = 0;
      const a = new SessionRunner({ sessionId: 'a7-11', cwd: dir, model: 'claude-opus-5-5' } as any, acct({ compactAt: 450_000 }));
      await tick();
      expect(queries[0].options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('450000');
      expect((await flagEnv(queries[0].options.settings))?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('450000');
      expect(a.info.compactWindow).toBe(450_000);
      await a.close();
    });
  });

  // final review M4 (was: a value past the window was left out — and the user's settings.json won again, which the
  // editor's 「设了就以这里为准」 says it does not): past the window it is capped at the window; under 50K it is left out
  it('a value past the window is capped at the window, over settings.json (Opus at 200K, 500000 set, settings.json 700000 / 150000 → 200000)', async () => {
    for (const fromSettings of ['700000', '150000']) {
      await withHome({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: fromSettings }, async (dir) => {
        const r = new SessionRunner({ sessionId: `a7-12-${fromSettings}`, cwd: dir, model: 'claude-opus-5-5' } as any, undefined, { account: { windows: { opus: 200_000 }, compactAt: 500_000 } });
        await tick();
        expect(queries[0].options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
        expect((await flagEnv(queries[0].options.settings))?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
        expect(r.info.compactWindow).toBe(200_000);
        await r.close();
      });
    }
  });

  it('a value under 50K is ignored (nothing of ours: settings.json stays)', async () => {
    await withHome({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' }, async (dir) => {
      const r = new SessionRunner({ sessionId: 'a7-12-small', cwd: dir, model: 'claude-opus-5-5' } as any, undefined, { account: { windows: { opus: 200_000 }, compactAt: 30_000 } });
      await tick();
      expect(queries[0].options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(queries[0].options.settings).toBeUndefined();
      expect(r.info.compactWindow).toBe(150_000);
      await r.close();
    });
  });

  it('a provider’s compactAt: written on both engines; too small → not written; with the official binary’s own earlier point the smaller one wins', async () => {
    await withHome(null, async (dir) => {
      const base = { id: 'p1', name: 'relay', type: 'anthropic', baseUrl: 'https://relay.invalid', apiKey: 'k', models: ['claude-opus-5-5'] };
      const run = async (p: any, kind: 'claude' | 'ccb') => {
        eng.kind = kind;
        queries.length = 0;
        const r = new SessionRunner({ sessionId: `a7-p-${Math.random()}`, cwd: dir, model: 'claude-opus-5-5' } as any, p);
        await tick();
        const env = queries[0].options.env;
        const info = { ...r.info };
        await r.close();
        return { env, info };
      };
      for (const kind of ['claude', 'ccb'] as const) {
        const ok = await run({ ...base, compactAt: 400_000 }, kind);
        expect(ok.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('400000');
        expect(ok.info.compactWindow).toBe(400_000);
        expect(ok.info.contextWindow).toBe(1_000_000);
        const small = await run({ ...base, compactAt: 30_000 }, kind);
        expect(small.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      }
      // official binary, window set to 400K (it compacts there on its own): 300K is earlier → 300K; 600K is past the window → 400K
      const w = { ...base, runtime: 'claude', contextWindows: { 'claude-opus-5-5': 400_000 } };
      expect((await run({ ...w, compactAt: 300_000 }, 'claude')).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('300000');
      expect((await run({ ...w, compactAt: 600_000 }, 'claude')).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('400000');
    });
  });

  // final review M6: the official binary will not compact under 100K whatever the variable says (engine-providers:
  // 50K set → 100K, 120K → 120K); the ring and the context card say where it really compacts. ccb takes the value as is
  it('the official binary’s 100K floor goes on the info (60K set → 100K); ccb keeps 60K', async () => {
    await withHome(null, async (dir) => {
      const p = { id: 'p1', name: 'relay', type: 'anthropic', baseUrl: 'https://relay.invalid', apiKey: 'k', models: ['claude-opus-5-5'], compactAt: 60_000 } as any;
      const seen: Record<string, { env?: string; info?: number }> = {};
      for (const kind of ['claude', 'ccb'] as const) {
        eng.kind = kind;
        queries.length = 0;
        // the provider says which engine (an Anthropic relay's Claude prefers the official binary otherwise)
        const r = new SessionRunner({ sessionId: `a7-m6-${kind}`, cwd: dir, model: 'claude-opus-5-5' } as any, { ...p, runtime: kind });
        await tick();
        expect(r.info.runtime).toBe(kind);
        seen[kind] = { env: queries[0].options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, info: r.info.compactWindow };
        await r.close();
      }
      expect(seen).toEqual({ claude: { env: '60000', info: 100_000 }, ccb: { env: '60000', info: 60_000 } });
    });
  });

  it('setAccountPrefs on a live conversation: a new compaction point changes the plan key → it restarts once idle; the same again restarts nothing', async () => {
    await withHome(null, async (dir) => {
      const r = new SessionRunner({ sessionId: 'a7-13', cwd: dir, model: 'claude-opus-5-5' } as any, undefined, { account: { windows: {} } });
      await tick();
      await r.setAccountPrefs({ windows: {}, compactAt: 600_000 });
      await tick();
      expect(queries).toHaveLength(2);
      expect(queries[1].options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('600000');
      await r.setAccountPrefs({ windows: {}, compactAt: 600_000 });
      await tick();
      expect(queries).toHaveLength(2);
      // mid-turn: not now — once the turn is over
      r.send('go');
      await r.setAccountPrefs({ windows: {}, compactAt: 300_000 });
      await tick();
      expect(queries).toHaveLength(2);
      queries[1].push({ type: 'result', subtype: 'success', session_id: 'a7-13', uuid: 'r1', is_error: false, result: 'done' });
      await tick();
      await tick();
      expect(queries).toHaveLength(3);
      expect(queries[2].options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('300000');
      await r.close();
    });
  });

  it('setAccountPrefs: Opus moved to 200K → the model goes out without [1m] and the window on the info follows (emitted)', async () => {
    await withHome(null, async (dir) => {
      const r = new SessionRunner({ sessionId: 'a7-14', cwd: dir, model: 'claude-opus-5-5' } as any, undefined, { account: { windows: {} } });
      await tick();
      const infos: any[] = [];
      r.on('info', (i) => infos.push({ ...i }));
      await r.setAccountPrefs({ windows: { opus: 200_000 } });
      await tick();
      expect(r.info.contextWindow).toBe(200_000);
      expect(infos.some((i) => i.contextWindow === 200_000)).toBe(true);
      // the fake engine has no in-process setModel: another process, on the plain id
      expect(queries).toHaveLength(2);
      expect(queries[1].options.model).toBe('claude-opus-5-5');
      await r.close();
    });
  });

  /** An own-login Opus conversation that has run a turn (so it has a transcript), idle, its context holding `used`. */
  const ranTurn = async (id: string, used: number) => {
    const r = new SessionRunner({ sessionId: id, cwd: '/x', model: 'claude-opus-5-5' } as any, undefined, { account: { windows: {} } });
    await tick();
    const sent: string[] = [];
    r.on('sent', (m: any) => sent.push(typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content)));
    r.send('hi');
    queries[0].push({ type: 'result', subtype: 'success', session_id: id, uuid: 'r0', is_error: false, result: 'ok' });
    await tick();
    queries[0].usage = { totalTokens: used };
    return { r, sent };
  };

  it('setAccountPrefs shrinking the window under a conversation that does not fit: /compact on the current window first, then the change', async () => {
    await withHome(null, async () => {
      const { r, sent } = await ranTurn('a7-fit-1', 500_000);
      const done = r.setAccountPrefs({ windows: { opus: 200_000 } });
      await tick();
      expect(sent).toEqual(['hi', '/compact']);
      expect(queries).toHaveLength(1); // nothing restarted while it compacts
      expect(r.info.contextWindow).toBe(1_000_000);
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'a7-fit-1', uuid: 'r1', is_error: false, result: 'compacted' });
      await done;
      await tick();
      expect(r.info.contextWindow).toBe(200_000);
      expect(queries).toHaveLength(2); // the fake engine has no in-process setModel: another process, on the plain id
      expect(queries[1].options.model).toBe('claude-opus-5-5');
      await r.close();
    });
  });

  it('…when it fits (under FIT_SHARE of the new window), no compaction', async () => {
    await withHome(null, async () => {
      const { r, sent } = await ranTurn('a7-fit-2', 100_000);
      await r.setAccountPrefs({ windows: { opus: 200_000 } });
      await tick();
      expect(sent).toEqual(['hi']);
      expect(queries).toHaveLength(2);
      expect(queries[1].options.model).toBe('claude-opus-5-5');
      await r.close();
    });
  });

  it('…the window growing never compacts', async () => {
    await withHome(null, async () => {
      const r = new SessionRunner({ sessionId: 'a7-fit-3', cwd: '/x', model: 'claude-opus-5-5' } as any, undefined, { account: { windows: { opus: 200_000 } } });
      await tick();
      const sent: string[] = [];
      r.on('sent', (m: any) => sent.push(String(m.message.content)));
      r.send('hi');
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'a7-fit-3', uuid: 'r0', is_error: false, result: 'ok' });
      await tick();
      queries[0].usage = { totalTokens: 190_000 };
      await r.setAccountPrefs({ windows: {} });
      await tick();
      expect(sent).toEqual(['hi']);
      expect(queries[1].options.model).toBe('claude-opus-5-5[1m]');
      await r.close();
    });
  });

  it('…made mid-turn: nothing until the turn is over, then the compaction, then the change', async () => {
    await withHome(null, async () => {
      const { r, sent } = await ranTurn('a7-fit-4', 500_000);
      r.send('more');
      await r.setAccountPrefs({ windows: { opus: 200_000 } });
      await tick();
      expect(sent).toEqual(['hi', 'more']);
      expect(r.info.contextWindow).toBe(1_000_000);
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'a7-fit-4', uuid: 'r1', is_error: false, result: 'ok' });
      await tick();
      expect(sent).toEqual(['hi', 'more', '/compact']);
      expect(queries).toHaveLength(1);
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'a7-fit-4', uuid: 'r2', is_error: false, result: 'compacted' });
      await tick();
      await tick();
      expect(r.info.contextWindow).toBe(200_000);
      expect(queries).toHaveLength(2);
      expect(queries[1].options.model).toBe('claude-opus-5-5');
      await r.close();
    });
  });

  it('…changed back while it compacts: the later call wins, nothing restarts', async () => {
    await withHome(null, async () => {
      const { r, sent } = await ranTurn('a7-fit-5', 500_000);
      const first = r.setAccountPrefs({ windows: { opus: 200_000 } });
      await tick();
      expect(sent).toEqual(['hi', '/compact']);
      await r.setAccountPrefs({ windows: {} });
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'a7-fit-5', uuid: 'r1', is_error: false, result: 'compacted' });
      await first;
      await tick();
      expect(r.info.contextWindow).toBe(1_000_000);
      expect(queries).toHaveLength(1);
      await r.close();
    });
  });

  // final review I1: the account dialog's two saves used to arrive ms apart — both passed the busy check while
  // asking for the context usage, and both sent /compact
  it('two setAccountPrefs in a row that shrink the window: one /compact, then one restart on the latest picks', async () => {
    await withHome(null, async () => {
      const { r, sent } = await ranTurn('a7-i1-1', 500_000);
      const a = r.setAccountPrefs({ windows: { opus: 200_000 } });
      const b = r.setAccountPrefs({ windows: { opus: 200_000 }, compactAt: 150_000 });
      await tick();
      expect(sent).toEqual(['hi', '/compact']);
      expect(queries).toHaveLength(1);
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'a7-i1-1', uuid: 'r1', is_error: false, result: 'compacted' });
      await Promise.all([a, b]);
      await tick();
      expect(sent).toEqual(['hi', '/compact']);
      expect(r.info.contextWindow).toBe(200_000);
      expect(queries).toHaveLength(2);
      expect(queries[1].options.model).toBe('claude-opus-5-5');
      expect(queries[1].options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('150000');
      await r.close();
    });
  });

  // …and without a shrink: the first switched the model in the process (setModel), the second restarted for its plan
  // key; the first's setModel failing then restarted again while that restart ran — two engine processes
  it('two setAccountPrefs in a row without a shrink: at most one restart', async () => {
    await withHome(null, async (dir) => {
      const r = new SessionRunner({ sessionId: 'a7-i1-2', cwd: dir, model: 'claude-opus-5-5' } as any, undefined, { account: { windows: { opus: 200_000 } } });
      await tick();
      const a = r.setAccountPrefs({ windows: {} });
      const b = r.setAccountPrefs({ windows: {}, compactAt: 600_000 });
      await Promise.all([a, b]);
      await tick();
      await tick();
      expect(queries).toHaveLength(2);
      expect(queries[1].options.model).toBe('claude-opus-5-5[1m]');
      expect(queries[1].options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('600000');
      await r.close();
    });
  });

  it('respawn() while another is under way joins it: one new process', async () => {
    await withHome(null, async (dir) => {
      const r = new SessionRunner({ sessionId: 'a7-i1-3', cwd: dir, model: 'claude-opus-5-5' } as any, undefined, { account: { windows: {} } });
      await tick();
      await Promise.all([r.respawn(), r.respawn()]);
      await tick();
      expect(queries).toHaveLength(2);
      await r.close();
    });
  });

  it('setModel to a smaller window still compacts first (fitBeforeSwitch unchanged)', async () => {
    await withHome(null, async () => {
      const { r, sent } = await ranTurn('a7-fit-6', 500_000);
      const done = r.setModel('claude-haiku-4-5');
      await tick();
      expect(sent).toEqual(['hi', '/compact']);
      expect(queries).toHaveLength(1);
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'a7-fit-6', uuid: 'r1', is_error: false, result: 'compacted' });
      await done;
      await tick();
      expect(r.info.model).toBe('claude-haiku-4-5');
      expect(r.info.contextWindow).toBe(200_000);
      expect(queries).toHaveLength(2);
      await r.close();
    });
  });

  it('setModel: the window on the info follows the model', async () => {
    await withHome(null, async (dir) => {
      const r = new SessionRunner({ sessionId: 'a7-15', cwd: dir, model: 'claude-opus-5-5' } as any, undefined, { account: { windows: {} } });
      await tick();
      expect(r.info.contextWindow).toBe(1_000_000);
      await r.setModel('claude-haiku-4-5');
      await tick();
      expect(r.info.contextWindow).toBe(200_000);
      await r.close();
    });
  });

  /** A claude-account Opus conversation (Opus left at 1M) that has run a turn, idle, its context holding `used`. */
  const ranAccountTurn = async (id: string, used: number) => {
    const p = acct();
    const r = new SessionRunner({ sessionId: id, cwd: '/x', model: 'claude-opus-5-5' } as any, p);
    await tick();
    const sent: string[] = [];
    r.on('sent', (m: any) => sent.push(typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content)));
    r.send('hi');
    queries[0].push({ type: 'result', subtype: 'success', session_id: id, uuid: 'r0', is_error: false, result: 'ok' });
    await tick();
    queries[0].usage = { totalTokens: used };
    return { r, sent, p };
  };

  // final review I2: the profile path went straight to a restart — the new 200K process could not even read 500K
  it('a claude-account profile saved with Opus 1M → 200K under a conversation that does not fit: /compact first, then the restart', async () => {
    await withHome(null, async () => {
      const { r, sent, p } = await ranAccountTurn('a7-i2-1', 500_000);
      const done = r.reprovide({ ...p, contextWindows: { opus: 200_000 } });
      await tick();
      expect(sent).toEqual(['hi', '/compact']);
      expect(queries).toHaveLength(1);
      expect(r.info.contextWindow).toBe(1_000_000);
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'a7-i2-1', uuid: 'r1', is_error: false, result: 'compacted' });
      await done;
      await tick();
      expect(r.info.contextWindow).toBe(200_000);
      expect(queries).toHaveLength(2);
      expect(queries[1].options.model).toBe('claude-opus-5-5');
      await r.close();
    });
  });

  it('…saved mid-turn: nothing until the turn is over, then the compaction, then the restart', async () => {
    await withHome(null, async () => {
      const { r, sent, p } = await ranAccountTurn('a7-i2-2', 500_000);
      r.send('more');
      await r.reprovide({ ...p, contextWindows: { opus: 200_000 } });
      await tick();
      expect(sent).toEqual(['hi', 'more']);
      expect(r.info.contextWindow).toBe(1_000_000);
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'a7-i2-2', uuid: 'r1', is_error: false, result: 'ok' });
      await tick();
      expect(sent).toEqual(['hi', 'more', '/compact']);
      expect(queries).toHaveLength(1);
      queries[0].push({ type: 'result', subtype: 'success', session_id: 'a7-i2-2', uuid: 'r2', is_error: false, result: 'compacted' });
      await tick();
      await tick();
      expect(r.info.contextWindow).toBe(200_000);
      expect(queries).toHaveLength(2);
      expect(queries[1].options.model).toBe('claude-opus-5-5');
      await r.close();
    });
  });

  it('a claude-account profile saved with a new compactAt reaches its running conversation (reprovide)', async () => {
    await withHome(null, async (dir) => {
      const p = acct();
      const r = new SessionRunner({ sessionId: 'a7-16', cwd: dir, model: 'claude-opus-5-5' } as any, p);
      await tick();
      await r.reprovide({ ...p, compactAt: 500_000 });
      await tick();
      expect(queries).toHaveLength(2);
      expect(queries[1].options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
      await r.close();
    });
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
  /** What a conversation's engine is told about its own WebSearch: the backend (env) and whether the tool is taken away. */
  const searchOf = async (params: any, provider?: any) => {
    const r = new SessionRunner(params, provider);
    await tick();
    const o = queries[queries.length - 1].options;
    await r.close();
    return { adapter: o.env?.WEB_SEARCH_ADAPTER, off: o.disallowedTools };
  };
  const openaiProvider = { id: 'ds', name: 'DS', type: 'openai', baseUrl: 'https://relay/v1', apiKey: 'sk', createdAt: 0, shim: { base: 'http://127.0.0.1:9/gateway/~p/ds', key: 'cws-x' } };

  it('our engine\'s own WebSearch is taken away (its default backend is a hosted Tavily proxy: searching is the web tools\'); the official binary\'s is left', async () => {
    await withConfig({}, async (dir) => {
      eng.kind = 'ccb';
      expect(await searchOf({ sessionId: 'w1', cwd: dir })).toEqual({ adapter: undefined, off: ['WebSearch'] });
      expect(await searchOf({ sessionId: 'w2', cwd: dir }, openaiProvider)).toEqual({ adapter: undefined, off: ['WebSearch'] });
      eng.kind = 'claude';
      expect(await searchOf({ sessionId: 'w3', cwd: dir })).toEqual({ adapter: undefined, off: undefined });
    });
  });

  it('…unless the user chose a backend for it themselves: their environment, the conversation\'s env, a settings file — then it is theirs, as they set it', async () => {
    await withConfig({}, async (dir) => {
      eng.kind = 'ccb';
      process.env.WEB_SEARCH_ADAPTER = 'exa';
      expect(await searchOf({ sessionId: 'u1', cwd: dir })).toEqual({ adapter: 'exa', off: undefined });
      delete process.env.WEB_SEARCH_ADAPTER;
      expect(await searchOf({ sessionId: 'u2', cwd: dir, features: { env: { WEB_SEARCH_ADAPTER: 'brave' } } })).toEqual({ adapter: 'brave', off: undefined });
      // the project's own settings file
      const fs = await import('node:fs');
      const path = await import('node:path');
      fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ webSearchAdapter: 'bing' }));
      expect((await searchOf({ sessionId: 'u3', cwd: dir })).off).toBeUndefined();
      fs.rmSync(path.join(dir, '.claude'), { recursive: true, force: true });
      expect((await searchOf({ sessionId: 'u4', cwd: dir })).off).toEqual(['WebSearch']);
    });
    // the user's settings.json: the setting the engine's own panel writes, or the variable in its env
    await withConfig({ webSearchAdapter: 'brave' }, async (dir) => {
      eng.kind = 'ccb';
      expect((await searchOf({ sessionId: 'u5', cwd: dir })).off).toBeUndefined();
    });
    await withConfig({ env: { WEB_SEARCH_ADAPTER: 'exa' } }, async (dir) => {
      eng.kind = 'ccb';
      expect((await searchOf({ sessionId: 'u6', cwd: dir })).off).toBeUndefined();
    });
  });

  it('操控电脑: a conversation with it on is handed the `computer` server, its tools not asked about one by one (Windows); the engine\'s own flag is never passed', async () => {
    const { configureComputerMcp } = await import('../computer/launcher.js');
    await withConfig({}, async (dir) => {
      configureComputerMcp({ url: 'http://127.0.0.1:45679', token: 'y'.repeat(64) }, dir);
      try {
        const off = new SessionRunner({ sessionId: 'c1', cwd: dir } as any);
        await tick();
        expect(Object.keys(queries[0].options.mcpServers)).not.toContain('computer');
        expect(queries[0].options.allowedTools ?? []).not.toContain('mcp__computer__screenshot');
        await off.close();
        const on = new SessionRunner({ sessionId: 'c2', cwd: dir, features: { computerUse: true } } as any);
        await tick();
        const o = queries[1].options;
        // `--computer-use-mcp` starts the engine's stand-alone MCP mode: a conversation given it exits at once
        expect(Object.keys(o.extraArgs ?? {})).not.toContain('computer-use-mcp');
        if (process.platform === 'win32') {
          expect(o.mcpServers.computer.env).toMatchObject({ CW_COMPUTER_ASK_URL: 'http://127.0.0.1:45679', CW_SESSION_ID: 'c2' });
          expect(JSON.stringify(o.mcpServers)).not.toContain('y'.repeat(64)); // this object ends up on the CLI's command line
          // all of them, request_access too: the user's yes is asked for by this app (computer/access.ts), in any permission mode
          expect(o.allowedTools).toEqual(expect.arrayContaining(['mcp__computer__request_access', 'mcp__computer__screenshot', 'mcp__computer__left_click', 'mcp__computer__type']));
          expect(o.allowedTools.every((t: string) => t.startsWith('mcp__computer__'))).toBe(true);
        } else {
          // Windows only for now: elsewhere the switch hands out nothing
          expect(Object.keys(o.mcpServers)).not.toContain('computer');
          expect(o.allowedTools ?? []).toEqual([]);
        }
        await on.close();
      } finally {
        configureComputerMcp(null, dir);
      }
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
        // ego_browser and browser_eval too: the server asks about them on its own card, so Claude's prompt would be a second one
        expect(o.allowedTools).toEqual(['mcp__web__web_search', 'mcp__web__ego_browser_guide', 'mcp__web__ego_browser', 'mcp__web__browser_open', 'mcp__web__browser_read', 'mcp__web__browser_find', 'mcp__web__browser_click', 'mcp__web__browser_type', 'mcp__web__browser_press_key', 'mcp__web__browser_scroll', 'mcp__web__browser_back', 'mcp__web__browser_screenshot', 'mcp__web__browser_computer', 'mcp__web__browser_console', 'mcp__web__browser_network', 'mcp__web__browser_snapshot', 'mcp__web__browser_wait', 'mcp__web__browser_tabs', 'mcp__web__browser_viewport', 'mcp__web__browser_hover', 'mcp__web__browser_drag', 'mcp__web__browser_select', 'mcp__web__browser_eval', 'mcp__web__character_guide', 'mcp__web__character_draft', 'mcp__web__character_save', 'mcp__web__character_list', 'mcp__web__theme_guide', 'mcp__web__theme_draft', 'mcp__web__theme_get', 'mcp__web__theme_save', 'mcp__web__theme_list']);
        await r.close();
      } finally {
        configureWebMcp(null, dir);
      }
    });
  });
});

describe('the subagents model (the composer 子代理 chip)', () => {
  it('goes to the process as CLAUDE_CODE_SUBAGENT_MODEL; a change restarts it, the same pick does not', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const p = { id: 'p1', name: 'relay', type: 'openai', baseUrl: 'https://relay.invalid', apiKey: 'k', models: ['gpt-big', 'gpt-mini'] } as any;
      const r = new SessionRunner({ sessionId: 'sub1', cwd: '/x', model: 'gpt-big', subagentModel: 'gpt-mini' } as any, p);
      await tick();
      expect(queries[0].options.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('gpt-mini');
      // the official binary puts an agent's own model (Explore: inherit) first unless forced (2026-10-19, real run)
      expect(queries[0].options.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBe('1');
      expect(r.info.subagentModel).toBe('gpt-mini');
      await r.setSubagentModel('');
      await tick();
      expect(queries).toHaveLength(2);
      expect(queries[1].options.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
      expect(queries[1].options.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBeUndefined();
      expect(r.info.subagentModel).toBeUndefined();
      await r.setSubagentModel('');
      await tick();
      expect(queries).toHaveLength(2);
      await r.close();
    } finally {
      eng.kind = 'claude';
    }
  });

  // 2026-10-30 user report: the workflow cards said the main model (routego/gpt-6.1-sol) while the picked DeepSeek ran
  it('a workflow\'s agents are reported on the subagent model they really run on; without a pick, as the engine says', async () => {
    eng.kind = 'ccb';
    try {
      queries.length = 0;
      const p = { id: 'p1', name: 'relay', type: 'openai', baseUrl: 'https://relay.invalid', apiKey: 'k', models: ['gpt-big', 'gpt-mini'] } as any;
      const progress = () => ({ type: 'system', subtype: 'task_progress', task_id: 'w1', session_id: 'wf-1', uuid: `p${Math.random()}`, workflow_progress: [{ type: 'workflow_phase', index: 1, title: 'x' }, { type: 'workflow_agent', index: 1, label: 'impl', model: 'gpt-big', state: 'progress' }] });
      const seen: any[] = [];
      const r = new SessionRunner({ sessionId: 'wf-1', cwd: '/x', model: 'gpt-big', subagentModel: 'gpt-mini' } as any, p);
      r.on('message', (m: any) => { if (m.workflow_progress) seen.push(m.workflow_progress[1].model); });
      await tick();
      queries[0].push(progress());
      await tick();
      expect(seen).toEqual(['gpt-mini']);
      await r.close();
      const plain = new SessionRunner({ sessionId: 'wf-2', cwd: '/x', model: 'gpt-big' } as any, p);
      const seen2: any[] = [];
      plain.on('message', (m: any) => { if (m.workflow_progress) seen2.push(m.workflow_progress[1].model); });
      await tick();
      queries.at(-1)!.push(progress());
      await tick();
      expect(seen2).toEqual(['gpt-big']);
      await plain.close();
    } finally {
      eng.kind = 'claude';
    }
  });

  it('the official binary: a Claude with a 1M window gets its [1m], like the main model', async () => {
    queries.length = 0;
    const p = { id: 'p2', name: 'relay', type: 'anthropic', runtime: 'claude', baseUrl: 'https://relay.invalid', apiKey: 'k', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'] } as any;
    const a = new SessionRunner({ sessionId: 'sub2', cwd: '/x', model: 'claude-opus-5-5', subagentModel: 'claude-sonnet-5-5' } as any, p);
    await tick();
    expect(queries[0].options.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-sonnet-5-5[1m]');
    await a.close();
    const b = new SessionRunner({ sessionId: 'sub3', cwd: '/x', model: 'claude-opus-5-5', subagentModel: 'claude-haiku-4-5-20251001' } as any, p);
    await tick();
    expect(queries[1].options.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-haiku-4-5-20251001');
    await b.close();
  });

  it('a model of another provider: the engine’s base URL for its request format becomes the split route, whatever the conversation runs on', async () => {
    const { setSplitHook } = await import('../gateway/split.js');
    const { crossValue, subAlias } = await import('../models/subagent.js');
    const asked: any[][] = [];
    const targets: Record<string, any> = { ds: { type: 'openai' }, an: { type: 'anthropic' }, acct: { type: 'claude-account', token: 'sk-ant-oat01-other' } };
    setSplitHook({ endpoint: (main, sub, model) => { asked.push([main, sub, model]); return 'http://127.0.0.1:1/gateway/~s/t/k/cwx-k'; }, target: (id) => targets[id] ?? null });
    const ROUTE = 'http://127.0.0.1:1/gateway/~s/t/k/cwx-k';
    const run = async (p: any, model: string, pick: string) => {
      queries.length = 0;
      asked.length = 0;
      const r = new SessionRunner({ sessionId: `sx-${Math.random()}`, cwd: '/x', model, subagentModel: pick } as any, p);
      await tick();
      const env = queries[0].options.env;
      await r.close();
      return env;
    };
    const savedBase = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      // an Anthropic-format provider: its requests keep the engine's own key, the alias keeps the readable name
      const anth = { id: 'p3', name: 'relay', type: 'anthropic', runtime: 'claude', baseUrl: 'https://relay.invalid', apiKey: 'k', models: ['claude-opus-5-5'] } as any;
      let env = await run(anth, 'claude-opus-5-5', crossValue('ds', 'deepseek-chat'));
      expect(asked).toEqual([[{ base: 'https://relay.invalid' }, { kind: 'provider', providerId: 'ds' }, 'deepseek-chat']]);
      expect(env.ANTHROPIC_BASE_URL).toBe(ROUTE);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('k');
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('cw-sub/deepseek-chat');
      // …with this machine's login for the subagents: the engine keeps the login, the route puts the key on
      env = await run(anth, 'claude-opus-5-5', crossValue('claude', 'claude-haiku-4-5'));
      expect(asked).toEqual([[{ base: 'https://relay.invalid', rekey: 'k' }, { kind: 'account' }, 'claude-haiku-4-5']]);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      // …with another account's: its token goes to the route
      await run(anth, 'claude-opus-5-5', crossValue('acct', 'claude-opus-5-5'));
      expect(asked[0][1]).toEqual({ kind: 'account', token: 'sk-ant-oat01-other' });
      // the account (no provider): Anthropic itself behind the route, its login untouched
      env = await run(undefined, 'claude-opus-5-5', crossValue('ds', 'deepseek-chat'));
      expect(asked[0][0]).toEqual({ base: 'https://api.anthropic.com' });
      expect(env.ANTHROPIC_BASE_URL).toBe(ROUTE);
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      // the same provider's model: no route, the plain id
      env = await run(anth, 'claude-opus-5-5', crossValue('p3', 'claude-opus-5-5'));
      expect(asked).toHaveLength(0);
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-opus-5-5[1m]');
      eng.kind = 'ccb';
      // an OpenAI-format provider: OPENAI_BASE_URL, a hex alias (no family word for the engine's mapping to catch)
      const oa = { id: 'p4', name: 'oa', type: 'openai', baseUrl: 'https://oa.invalid', apiKey: 'k', models: ['gpt-big'] } as any;
      env = await run(oa, 'gpt-big', crossValue('an', 'claude-haiku-4-5'));
      expect(asked[0][0].base).toMatch(/^https:\/\/oa\.invalid/);
      expect(env.OPENAI_BASE_URL).toBe(ROUTE);
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe(subAlias('claude-haiku-4-5', 'other'));
      // a Gemini one without a base URL: Google's default is where its requests go on to
      const gm = { id: 'p5', name: 'gm', type: 'gemini', baseUrl: '', apiKey: 'k', models: ['gemini-2.5-pro'] } as any;
      env = await run(gm, 'gemini-2.5-pro', crossValue('ds', 'deepseek-chat'));
      expect(asked[0][0]).toEqual({ base: 'https://generativelanguage.googleapis.com/v1beta' });
      expect(env.GEMINI_BASE_URL).toBe(ROUTE);
      // this machine's login or another account under an OpenAI-format conversation: not joined, the main model
      for (const pick of [crossValue('claude', 'claude-haiku-4-5'), crossValue('acct', 'claude-opus-5-5')]) {
        env = await run(oa, 'gpt-big', pick);
        expect(asked).toHaveLength(0);
        expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
      }
    } finally {
      eng.kind = 'claude';
      setSplitHook(null);
      if (savedBase !== undefined) process.env.ANTHROPIC_BASE_URL = savedBase;
    }
  });

  it('the account through the user’s own relay (settings.json env): the route passes its requests on to that relay; our base URL goes over theirs through --settings, their token stays theirs', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { setSplitHook } = await import('../gateway/split.js');
    const { crossValue } = await import('../models/subagent.js');
    const ROUTE = 'http://127.0.0.1:1/gateway/~s/t/k/cwx-k';
    const asked: any[][] = [];
    setSplitHook({ endpoint: (main, sub, model) => { asked.push([main, sub, model]); return ROUTE; }, target: (id) => (id === 'ds' ? { type: 'openai' } : null) });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-own-relay-'));
    const was = { cfg: process.env.CLAUDE_CONFIG_DIR, data: process.env.CLAUDE_WEB_DIR, base: process.env.ANTHROPIC_BASE_URL };
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'cfg');
    process.env.CLAUDE_WEB_DIR = path.join(dir, 'data');
    delete process.env.ANTHROPIC_BASE_URL;
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://kiro.invalid/api', ANTHROPIC_AUTH_TOKEN: 'user-token', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5' } }));
    try {
      for (const kind of ['claude', 'ccb'] as const) {
        eng.kind = kind;
        queries.length = 0;
        asked.length = 0;
        const r = new SessionRunner({ sessionId: `own-${kind}`, cwd: dir, model: 'claude-opus-5-5', subagentModel: crossValue('ds', 'deepseek-v4.1') } as any);
        await tick();
        expect(asked).toEqual([[{ base: 'https://kiro.invalid/api' }, { kind: 'provider', providerId: 'ds' }, 'deepseek-v4.1']]);
        const o = queries[0].options;
        expect(o.env.ANTHROPIC_BASE_URL).toBe(ROUTE);
        expect(o.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('cw-sub/deepseek-v4.1');
        expect(o.env.ANTHROPIC_AUTH_TOKEN).not.toBe('user-token'); // the engine reads the user's token from their settings itself
        expect(JSON.parse(fs.readFileSync(o.settings, 'utf8'))).toEqual({ env: { ANTHROPIC_BASE_URL: ROUTE } });
        await r.close();
        expect(fs.existsSync(o.settings)).toBe(false);
      }
      // the relay only in this process's environment: the plain variable is enough, nothing written
      eng.kind = 'claude';
      fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), '{}');
      process.env.ANTHROPIC_BASE_URL = 'https://env-relay.invalid';
      queries.length = 0;
      asked.length = 0;
      const e = new SessionRunner({ sessionId: 'own-env', cwd: dir, model: 'claude-opus-5-5', subagentModel: crossValue('ds', 'deepseek-v4.1') } as any);
      await tick();
      expect(asked[0][0]).toEqual({ base: 'https://env-relay.invalid' });
      expect(queries[0].options.env.ANTHROPIC_BASE_URL).toBe(ROUTE);
      expect(queries[0].options.settings).toBeUndefined();
      await e.close();
    } finally {
      eng.kind = 'claude';
      setSplitHook(null);
      for (const [k, v] of [['CLAUDE_CONFIG_DIR', was.cfg], ['CLAUDE_WEB_DIR', was.data], ['ANTHROPIC_BASE_URL', was.base]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SessionRunner: 项目说明 (stage F2)', () => {
  it("the project's instructions are appended to the system prompt; none, nothing", async () => {
    queries.length = 0;
    const r = new SessionRunner({ sessionId: 'pi-1', cwd: '/x' } as any, undefined, { projectInstructions: '# Project instructions (App)\nUse pnpm.' });
    await tick();
    expect(queries[0].options.systemPrompt.append ?? '').toContain('Use pnpm.');
    await r.close();
    queries.length = 0;
    const plain = new SessionRunner({ sessionId: 'pi-2', cwd: '/x' } as any);
    await tick();
    expect(queries[0].options.systemPrompt.append ?? '').not.toContain('Project instructions');
    await plain.close();
  });
});

describe('值班 Bot gate', () => {
  const call = (r: SessionRunner, toolName: string, input: Record<string, unknown>) => (r as any).onCanUseTool(toolName, input, { signal: new AbortController().signal }) as Promise<PermissionResult>;
  it('a gate that answers is used and nothing is emitted', async () => {
    const r = new SessionRunner({ sessionId: 'g1', cwd: '/x' } as any);
    const seen: unknown[] = []; r.on('permission', (e) => seen.push(e));
    r.gate = async (ev) => (ev.toolName === 'Bash' ? { behavior: 'allow', updatedInput: ev.input } : null);
    expect(await call(r, 'Bash', { command: 'ls' })).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(seen).toEqual([]);
    expect(r.getPendingPermissions()).toEqual([]);
  });
  it('a gate that says null falls through to the usual card', async () => {
    const r = new SessionRunner({ sessionId: 'g2', cwd: '/x' } as any);
    r.gate = async () => null;
    const p = call(r, 'Edit', { file_path: '/a' });
    await new Promise((res) => setTimeout(res, 0));
    const pend = r.getPendingPermissions();
    expect(pend).toHaveLength(1);
    r.respondPermission(pend[0].requestId, { behavior: 'deny', message: 'no' });
    expect(await p).toMatchObject({ behavior: 'deny' });
  });
  it('a gate that throws also falls through', async () => {
    const r = new SessionRunner({ sessionId: 'g3', cwd: '/x' } as any);
    r.gate = async () => { throw new Error('boom'); };
    const p = call(r, 'Edit', { file_path: '/a' });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.getPendingPermissions()).toHaveLength(1);
    r.respondPermission(r.getPendingPermissions()[0].requestId, { behavior: 'allow' });
    expect((await p).behavior).toBe('allow');
  });
});
