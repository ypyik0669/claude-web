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
    // the repo bundles both engines: ccb (version from its package.json) and the SDK's claude binary
    const claude = info.runtime === 'claude' ? info : info.fallback;
    if (claude?.path && !claude.path.endsWith('.js')) expect(claude.version).toBe('2.1.281');
  });
});

describe('spawnClaude runs a JS engine with the spawn guard in front', () => {
  it('command "node" → our node runtime, `--require <preload>` before the engine entry, windowsHide', () => {
    const saved = { log: process.env.CW_SPAWN_LOG, dir: process.env.CLAUDE_WEB_DIR };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-spawnclaude-'));
    const entry = path.join(dir, 'ccb', 'cli-node.js');
    try {
      process.env.CW_SPAWN_LOG = '1'; // a plain node gets the guard only with spawn logging on (Electron always)
      process.env.CLAUDE_WEB_DIR = dir;
      spawnClaude({ command: 'node', args: [entry, '--output-format', 'stream-json'], env: {} });
      const s = spawns.pop()!;
      expect(s.cmd).toBe(process.execPath);
      expect(s.args[0]).toBe('--require');
      expect(s.args[1]).toMatch(/spawn-guard-[0-9a-f]{10}\.cjs$/);
      expect(s.args.slice(2)).toEqual([entry, '--output-format', 'stream-json']);
      expect(s.opts.windowsHide).toBe(true);
      spawnClaude({ command: path.join(dir, 'claude.exe'), args: ['--x'], env: {} }); // a native binary: untouched
      expect(spawns.pop()!.args).toEqual(['--x']);
    } finally {
      if (saved.log === undefined) delete process.env.CW_SPAWN_LOG; else process.env.CW_SPAWN_LOG = saved.log;
      if (saved.dir === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = saved.dir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
