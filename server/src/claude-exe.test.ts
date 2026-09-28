import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// execSync is what `npm root -g` and `<claude.exe> --version` run through
let execSyncImpl: (cmd: string) => string = () => '';
const execCalls: string[] = [];
const spawns: { cmd: string; args: string[]; opts: any }[] = [];
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execSync: (cmd: string) => { execCalls.push(cmd); return execSyncImpl(cmd); },
    spawn: (cmd: string, args: string[], opts: any) => { spawns.push({ cmd, args, opts }); return { pid: 1 } as any; },
  };
});
const { globalRoot, versionOf, spawnClaude } = await import('./claude-exe.js');

describe('claude-exe lookups remember successes only', () => {
  afterEach(() => { execCalls.length = 0; });

  it('`<binary> --version`: a timeout is not remembered, a version is', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ver-'));
    const exe = path.join(dir, 'fake-claude.exe');
    fs.writeFileSync(exe, 'x');
    try {
      execSyncImpl = () => { throw Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
      expect(versionOf(exe)).toBeUndefined();
      execSyncImpl = () => '2.1.281 (Claude Code)\n';
      expect(versionOf(exe)).toBe('2.1.281');
      expect(versionOf(exe)).toBe('2.1.281');
      expect(execCalls).toHaveLength(2); // the failure was retried, the success reused
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('`npm root -g`: a failure (or empty answer) is not remembered, a path is', () => {
    execSyncImpl = () => { throw new Error('npm not found'); };
    expect(globalRoot()).toBeNull();
    execSyncImpl = () => '  \n';
    expect(globalRoot()).toBeNull();
    execSyncImpl = () => 'C:\npm\node_modules\n';
    expect(globalRoot()).toBe('C:\npm\node_modules');
    expect(globalRoot()).toBe('C:\npm\node_modules');
    expect(execCalls).toHaveLength(3);
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
