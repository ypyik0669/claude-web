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
const codex = (list: { kind: string; installed: boolean; version: string }[]) => list.find((x) => x.kind === 'codex')!;
const isCodex = (cmd: string) => /codex/.test(cmd);

describe('AgentRegistry version probes', () => {
  afterEach(() => { calls.length = 0; answer = () => ({ version: 'v1.2.3' }); vi.restoreAllMocks(); });

  it('runs one probe per agent however many callers ask at once', async () => {
    const reg = new AgentRegistry(meta);
    const probed = reg.defs().filter((d) => !d.builtin && d.command).length;
    // what a (re)connecting client triggers: library detect + agents.list + library sources, concurrently
    const [a] = await Promise.all([reg.list(), reg.list(), reg.list()]);
    expect(calls).toHaveLength(probed);
    expect(codex(a)).toMatchObject({ installed: true, version: 'v1.2.3' });
  });

  it('serves later calls from the cache; refresh re-probes', async () => {
    const reg = new AgentRegistry(meta);
    await reg.list();
    const first = calls.length;
    await reg.list();
    await reg.list();
    expect(calls).toHaveLength(first);
    await reg.list(true);
    expect(calls).toHaveLength(first * 2);
  });

  it('an installed agent is re-probed after PROBE_TTL_MS', async () => {
    const reg = new AgentRegistry(meta);
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
    const reg = new AgentRegistry(meta);
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    answer = (_n, cmd) => (isCodex(cmd) ? { fail: true } : { version: 'v1' });
    expect(codex(await reg.list())).toMatchObject({ installed: false });
    const probesOf = () => calls.filter(isCodex).length;
    expect(probesOf()).toBe(1);
    answer = () => ({ version: 'v2' }); // the user installs codex
    spy.mockReturnValue(now + AgentRegistry.MISS_TTL_MS - 1000);
    expect(codex(await reg.list())).toMatchObject({ installed: false }); // still the cached miss
    spy.mockReturnValue(now + AgentRegistry.MISS_TTL_MS + 1000);
    expect(codex(await reg.list())).toMatchObject({ installed: true, version: 'v2' });
    expect(probesOf()).toBe(2);
  });

  it('a probe started before refresh / invalidate cannot overwrite the newer result', async () => {
    const reg = new AgentRegistry(meta);
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
});
