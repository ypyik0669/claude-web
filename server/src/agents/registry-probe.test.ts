import { afterEach, describe, expect, it, vi } from 'vitest';

// every `<agent> --version` probe goes through execFile: count them instead of starting real CLIs
const calls: string[] = [];
/** how the fake CLI answers: per call, a version (installed) or an error (not installed), after a delay */
let answer: (call: number, cmd: string) => { version?: string; fail?: boolean; ms?: number } = () => ({ version: 'v1.2.3' });
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
      calls.push([cmd, ...args].join(' '));
      const a = answer(calls.length, [cmd, ...args].join(' '));
      setTimeout(() => (a.fail ? cb(new Error('ENOENT')) : cb(null, { stdout: `${a.version}\n`, stderr: '' })), a.ms ?? 30);
      return {} as any;
    },
  };
});

const { AgentRegistry } = await import('./types.js');
const meta = { settings: () => ({}) } as any;
// every command "is on PATH" (the probes above then decide installed / not) — independent of this machine
const everywhere = { onPath: (c: string) => `/fake/bin/${c}`, bundled: () => null, refreshPath: async () => [] };
const Reg = AgentRegistry;
class TestRegistry extends Reg { constructor(m: any, loc: any = everywhere) { super(m, loc); } }
const codex = (list: { kind: string; installed: boolean; version: string }[]) => list.find((x) => x.kind === 'codex')!;
const isCodex = (cmd: string) => /codex/.test(cmd);

describe('AgentRegistry version probes', () => {
  afterEach(() => { calls.length = 0; answer = () => ({ version: 'v1.2.3' }); vi.restoreAllMocks(); });

  it('runs one probe per agent however many callers ask at once', async () => {
    const reg = new TestRegistry(meta);
    const probed = reg.defs().filter((d) => !d.builtin && d.command).length;
    // what a (re)connecting client triggers: library detect + agents.list + library sources, concurrently
    const [a] = await Promise.all([reg.list(), reg.list(), reg.list()]);
    expect(calls).toHaveLength(probed);
    expect(codex(a)).toMatchObject({ installed: true, version: 'v1.2.3' });
  });

  it('serves later calls from the cache; refresh re-probes', async () => {
    const reg = new TestRegistry(meta);
    await reg.list();
    const first = calls.length;
    await reg.list();
    await reg.list();
    expect(calls).toHaveLength(first);
    await reg.list(true);
    expect(calls).toHaveLength(first * 2);
  });

  it('an installed agent is re-probed after PROBE_TTL_MS', async () => {
    const reg = new TestRegistry(meta);
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    await reg.list();
    const first = calls.length;
    spy.mockReturnValue(now + AgentRegistry.PROBE_TTL_MS - 1000);
    await reg.list();
    expect(calls).toHaveLength(first);
    spy.mockReturnValue(now + AgentRegistry.PROBE_TTL_MS + 1000);
    await reg.list();
    expect(calls).toHaveLength(first * 2);
  });

  it('"not installed" is kept only MISS_TTL_MS (≤ 60 s): installing an agent shows up within a minute', async () => {
    expect(AgentRegistry.MISS_TTL_MS).toBeGreaterThanOrEqual(30_000);
    expect(AgentRegistry.MISS_TTL_MS).toBeLessThanOrEqual(60_000);
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    let codexThere = false;
    const reg2 = new TestRegistry(meta, { ...everywhere, onPath: (c: string) => (c === 'codex' && !codexThere ? null : `/fake/bin/${c}`) });
    expect(codex(await reg2.list())).toMatchObject({ installed: false });
    const probesOf = () => calls.filter(isCodex).length;
    expect(probesOf()).toBe(0); // nothing on PATH: no process started at all
    codexThere = true; // the user installs codex
    answer = () => ({ version: 'v2' });
    spy.mockReturnValue(now + AgentRegistry.MISS_TTL_MS - 1000);
    expect(codex(await reg2.list())).toMatchObject({ installed: false }); // still the cached miss
    spy.mockReturnValue(now + AgentRegistry.MISS_TTL_MS + 1000);
    expect(codex(await reg2.list())).toMatchObject({ installed: true, version: 'v2' });
    expect(probesOf()).toBe(1);
  });

  it('a probe started before refresh / invalidate cannot overwrite the newer result', async () => {
    const reg = new TestRegistry(meta);
    // the first (stale) probe is slow and says "old"; the one after refresh is fast and says "new"
    answer = (n, cmd) => (isCodex(cmd) ? (calls.filter(isCodex).length === 1 ? { version: 'old', ms: 200 } : { version: 'new', ms: 10 }) : { version: 'x', ms: 1 });
    const stale = reg.list();
    await new Promise((r) => setTimeout(r, 20));
    expect(codex(await reg.list(true))).toMatchObject({ version: 'new' });
    await stale; // lands after the refresh
    const before = calls.length;
    expect(codex(await reg.list())).toMatchObject({ version: 'new' }); // served from cache, not "old"
    expect(calls).toHaveLength(before);

    // same through invalidate()
    answer = (n, cmd) => (isCodex(cmd) ? (calls.filter(isCodex).length === 3 ? { version: 'old2', ms: 200 } : { version: 'new2', ms: 10 }) : { version: 'x', ms: 1 });
    reg.invalidate();
    const stale2 = reg.list();
    await new Promise((r) => setTimeout(r, 20));
    reg.invalidate();
    expect(codex(await reg.list())).toMatchObject({ version: 'new2' });
    await stale2;
    expect(codex(await reg.list())).toMatchObject({ version: 'new2' });
  });

  it('found but --version fails or times out: installed, with the reason (not 「未安装」 plus an 安装 button)', async () => {
    answer = (_n, cmd) => (isCodex(cmd) ? { fail: true } : { version: 'v1' });
    const c = codex(await new TestRegistry(meta).list()) as any;
    expect(c).toMatchObject({ installed: true, version: '', path: '/fake/bin/codex' });
    expect(c.probeError).toMatch(/找到了 codex.*--version/);
    expect(c.installNeeds).toBeUndefined();
  });

  it('not on PATH: says so, and names the missing install tool', async () => {
    const reg = new TestRegistry(meta, { ...everywhere, onPath: (c: string) => (c === 'codex' || c === 'npm' ? null : `/fake/bin/${c}`) });
    const c = codex(await reg.list()) as any;
    expect(c).toMatchObject({ installed: false, installNeeds: { name: 'Node.js' } });
    expect(c.probeError).toMatch(/PATH 里没有 codex/);
  });

  it('a Codex shipped by the desktop app / IDE extension counts, and sessions start that file', async () => {
    const file = 'C:/Users/u/AppData/Local/OpenAI/Codex/bin/abc/codex.exe';
    const reg = new TestRegistry(meta, { ...everywhere, onPath: (c: string) => (c === 'codex' ? null : `/fake/bin/${c}`), bundled: (k: string) => (k === 'codex' ? { file, from: 'Codex 桌面版' } : null) });
    const c = codex(await reg.list()) as any;
    expect(c).toMatchObject({ installed: true, version: 'v1.2.3', path: file, from: 'Codex 桌面版' });
    expect(c.login).toBe(`"${file}" login`); // the terminal cannot find `codex` either
    expect(calls.some((x) => x.includes(file))).toBe(true);
    expect(reg.launch('codex').command).toBe(file);
    // a command of the user's own is never swapped for the bundled copy
    const own = new TestRegistry({ settings: () => ({ agents: { codex: { command: 'my-codex' } } }) }, { ...everywhere, onPath: () => null, bundled: () => ({ file, from: 'x' }) });
    expect(own.launch('codex').command).toBe('my-codex');
    expect(codex(await own.list())).toMatchObject({ installed: false });
  });

  it('「重新检测」 also re-reads PATH (an agent installed after the app started)', async () => {
    const refreshes: boolean[] = [];
    const reg = new TestRegistry(meta, { ...everywhere, refreshPath: async (force: boolean) => { refreshes.push(force); return []; } });
    await reg.list();
    await reg.list(true);
    expect(refreshes).toContain(true);
  });
});

describe('the reason a found agent did not answer --version', () => {
  it('a Node crash: the Error line, not the source line or the stack; a timeout says so', async () => {
    const { versionError } = await import('./types.js');
    const stderr = [
      'node:internal/modules/cjs/loader:1383',
      '  const err = new Error(message);',
      '              ^',
      '',
      "Error: Cannot find module 'C:/x/launch.cjs'",
      'Require stack:',
      '- C:/y/codex.js',
      '    at Function._resolveFilename (node:internal/modules/cjs/loader:1383:15)',
    ].join('\n');
    expect(versionError(Object.assign(new Error('Command failed'), { stderr, stdout: '' }), 'codex')).toMatch(/失败：Error: Cannot find module/);
    expect(versionError(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }), 'opencode')).toMatch(/没有回答/);
  });
});
