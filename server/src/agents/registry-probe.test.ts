import { afterEach, describe, expect, it, vi } from 'vitest';

// every `<agent> --version` probe goes through execFile: count them instead of starting real CLIs
const calls: string[] = [];
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
      calls.push([cmd, ...args].join(' '));
      setTimeout(() => cb(null, { stdout: 'v1.2.3\n', stderr: '' }), 30); // a probe takes a while, like a real CLI start
      return {} as any;
    },
  };
});

const { AgentRegistry } = await import('./types.js');
const meta = { settings: () => ({}) } as any;

describe('AgentRegistry version probes', () => {
  afterEach(() => { calls.length = 0; });

  it('runs one probe per agent however many callers ask at once', async () => {
    const reg = new AgentRegistry(meta);
    const probed = reg.defs().filter((d) => !d.builtin && d.command).length;
    // what a (re)connecting client triggers: library detect + agents.list + library sources, concurrently
    const [a] = await Promise.all([reg.list(), reg.list(), reg.list()]);
    expect(calls).toHaveLength(probed);
    expect(a.find((x) => x.kind === 'codex')).toMatchObject({ installed: true, version: 'v1.2.3' });
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

  it('re-probes after the TTL', async () => {
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
    spy.mockRestore();
  });
});
