import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// every way claude-exe can start a process, recorded; the sync ones are the event-loop blockers
type Answer = { out?: string; err?: Error };
let answer: (cmd: string, args: string[]) => Answer = () => ({ out: '' });
const syncCalls: string[] = [];
const asyncCalls: string[] = [];
const spawns: { cmd: string; args: string[]; opts: any }[] = [];
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const later = (a: Answer, cb: (e: Error | null, out?: string, err?: string) => void) => setTimeout(() => (a.err ? cb(a.err, '', '') : cb(null, a.out ?? '', '')), 5);
  return {
    ...real,
    execSync: (cmd: string) => { syncCalls.push(cmd); const a = answer(cmd, []); if (a.err) throw a.err; return a.out ?? ''; },
    exec: (cmd: string, _o: unknown, cb: any) => { asyncCalls.push(cmd); later(answer(cmd, []), cb); return {} as any; },
    execFile: (file: string, args: string[], _o: unknown, cb: any) => { asyncCalls.push([file, ...args].join(' ')); later(answer(file, args), cb); return {} as any; },
    spawn: (cmd: string, args: string[], opts: any) => { spawns.push({ cmd, args, opts }); return { pid: 1 } as any; },
  };
});
const { globalRoot, globalRootAsync, versionOf, engineInfo, spawnClaude, resetLookups, LOOKUP_FAIL_TTL_MS } = await import('./claude-exe.js');

describe('claude-exe lookups: successes kept, failures kept only LOOKUP_FAIL_TTL_MS', () => {
  let now = 0;
  beforeEach(() => { resetLookups(); now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); });
  afterEach(() => { syncCalls.length = 0; asyncCalls.length = 0; vi.restoreAllMocks(); });

  it('is about a minute: long enough that a broken npm does not stall every connection, short enough to recover', () => {
    expect(LOOKUP_FAIL_TTL_MS).toBe(60_000);
  });

  it('`<binary> --version`: a timeout is remembered for a minute, then retried; a version for good', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ver-'));
    const exe = path.join(dir, 'fake-claude.exe');
    fs.writeFileSync(exe, 'x');
    try {
      answer = () => ({ err: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
      expect(await versionOf(exe)).toBeUndefined();
      now += 1_000;
      expect(await versionOf(exe)).toBeUndefined(); // no second 20 s wait right away
      expect(asyncCalls).toHaveLength(1);
      answer = () => ({ out: '2.1.281 (Claude Code)\n' });
      now += LOOKUP_FAIL_TTL_MS;
      expect(await versionOf(exe)).toBe('2.1.281');
      now += 10 * 60_000;
      expect(await versionOf(exe)).toBe('2.1.281');
      expect(asyncCalls).toHaveLength(2);
      expect(syncCalls).toEqual([]); // never a synchronous process
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('`npm root -g`: sync and async lookups share one memo; a failure / empty answer is kept a minute', async () => {
    answer = () => ({ err: new Error('npm not found') });
    expect(globalRoot()).toBeNull();
    now += 1_000;
    expect(globalRoot()).toBeNull();
    expect(await globalRootAsync()).toBeNull();
    expect(syncCalls.length + asyncCalls.length).toBe(1);
    answer = () => ({ out: '  \n' }); // empty counts as a failure too
    now += LOOKUP_FAIL_TTL_MS;
    expect(await globalRootAsync()).toBeNull();
    answer = () => ({ out: 'C:/npm/node_modules\n' });
    now += LOOKUP_FAIL_TTL_MS;
    expect(await globalRootAsync()).toBe('C:/npm/node_modules');
    now += 60 * 60_000;
    expect(globalRoot()).toBe('C:/npm/node_modules');
    expect(syncCalls).toHaveLength(1);
    expect(asyncCalls).toHaveLength(2);
  });

  it('engine.info never blocks the event loop: no synchronous process, the answer is a promise', async () => {
    answer = (cmd, args) => (args[0] === '--version' ? { out: '2.1.281 (Claude Code)\n' } : { out: 'C:/npm/node_modules\n' });
    const p = engineInfo();
    expect(p).toBeInstanceOf(Promise);
    const info = await p;
    expect(syncCalls).toEqual([]);
    expect(info.path).toBeTruthy();
    // the SDK's official claude binary, nothing next to it
    expect(info.version).toBe('2.1.281');
    expect(info).not.toHaveProperty('fallback');
    expect(info).not.toHaveProperty('runtime');
  });
});

describe('spawnClaude', () => {
  it('runs the binary as given, windowsHide; a third-party session loses the SDK markers', () => {
    spawnClaude({ command: '/x/claude', args: ['--x'], env: { A: '1', CLAUDE_AGENT_SDK_VERSION: '1' } });
    let s = spawns.pop()!;
    expect(s.cmd).toBe('/x/claude');
    expect(s.args).toEqual(['--x']);
    expect(s.opts.windowsHide).toBe(true);
    expect(s.opts.env).toMatchObject({ A: '1', CLAUDE_AGENT_SDK_VERSION: '1' });
    spawnClaude({ command: '/x/claude', args: [], env: { CLAUDE_WEB_PLAIN_UA: '1', CLAUDE_AGENT_SDK_VERSION: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'x' } });
    s = spawns.pop()!;
    expect(s.opts.env).not.toHaveProperty('CLAUDE_WEB_PLAIN_UA');
    expect(s.opts.env).not.toHaveProperty('CLAUDE_AGENT_SDK_VERSION');
    expect(s.opts.env).not.toHaveProperty('CLAUDE_AGENT_SDK_CLIENT_APP');
  });
});
