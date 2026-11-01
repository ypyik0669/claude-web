import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSpawn } from './resolve.js';

// npm's cmd-shim for a bin without a .js extension (opencode-ai's `bin/opencode`), verbatim shape
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-ai\\bin\\fake" %*',
  '',
].join('\r\n');

describe.skipIf(process.platform !== 'win32')('resolveSpawn (Windows .cmd shims)', () => {
  let dir: string;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const setup = (entryText: string) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resolve-'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'fake-ai', 'bin'), { recursive: true });
    const entry = path.join(dir, 'node_modules', 'fake-ai', 'bin', 'fake');
    fs.writeFileSync(entry, entryText);
    const shim = path.join(dir, 'fake.cmd');
    fs.writeFileSync(shim, NPM_SHIM);
    return { entry, shim };
  };

  it('unwraps an extensionless entry with a node shebang to `node <entry>`', () => {
    const { entry, shim } = setup('#!/usr/bin/env node\nconsole.log(1)\n');
    const r = resolveSpawn(shim, ['serve']);
    expect(r.via).toBe('node-shim');
    expect(r.args).toEqual([entry, 'serve']);
  });

  it('leaves a non-node extensionless entry to cmd.exe', () => {
    const { shim } = setup('#!/bin/sh\necho 1\n');
    expect(resolveSpawn(shim, ['serve']).via).toBe('cmd');
  });

  // the DeepSeek Harness desktop app ships exactly this shim: an ESM entry inside app.asar, run by its own Electron
  // binary — plain node cannot read a .asar archive, so unwrapping it would start nothing at all
  it('leaves a shim entry inside app.asar to cmd.exe', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resolve-asar-'));
    const bin = path.join(dir, 'resources', 'runtime', 'cli', 'bin');
    const entry = path.join(dir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, 'export {};\n');
    fs.mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, 'dsh.cmd');
    fs.writeFileSync(shim, [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
      'exit /b %errorlevel%',
    ].join('\r\n'));
    const r = resolveSpawn(shim, ['--profile', 'acp']);
    expect(r.via).toBe('cmd');
    expect(r.command).toMatch(/cmd\.exe$/i);
    expect(r.args[r.args.length - 1]).toContain('--profile acp');
  });

  it('refuses arguments cmd.exe would expand or split (`%VAR%`, newlines) instead of passing them mangled', () => {
    const { shim } = setup('#!/bin/sh\necho 1\n');
    expect(() => resolveSpawn(shim, ['--token=%USERPROFILE%'])).toThrow(/%/);
    // the message names the argument, never its value (it may be a secret)
    let msg = '';
    try { resolveSpawn(shim, ['serve', '--api-key=s3cr%t']); } catch (e: any) { msg = e.message; }
    expect(msg).toContain('第 2 个参数');
    expect(msg).toContain('--api-key');
    expect(msg).not.toContain('s3cr');
    try { resolveSpawn(shim, ['pa%ss']); } catch (e: any) { msg = e.message; }
    expect(msg).toContain('第 1 个参数');
    expect(msg).not.toContain('pa%ss');
    expect(() => resolveSpawn(shim, ['a\nb'])).toThrow(/换行/);
    expect(resolveSpawn(shim, ['50 percent', 'x"y']).via).toBe('cmd');
  });

  it('an empty argument survives cmd.exe as its own argument (`--tools ""`), not swallowed', () => {
    const { shim } = setup('#!/bin/sh\necho 1\n');
    const r = resolveSpawn(shim, ['--tools', '', '--strict-mcp-config']);
    expect(r.args[r.args.length - 1]).toContain('--tools "" --strict-mcp-config');
  });
});

describe.skipIf(process.platform !== 'win32')('resolveSpawn puts the spawn guard in front of a node-shim entry', () => {
  let dir: string;
  const saved = { log: process.env.CW_SPAWN_LOG, dir: process.env.CLAUDE_WEB_DIR };
  afterEach(() => {
    if (saved.log === undefined) delete process.env.CW_SPAWN_LOG; else process.env.CW_SPAWN_LOG = saved.log;
    if (saved.dir === undefined) delete process.env.CLAUDE_WEB_DIR; else process.env.CLAUDE_WEB_DIR = saved.dir;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('`--require <preload>` before the entry, the agent args after it', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resolve-guard-'));
    fs.mkdirSync(path.join(dir, 'node_modules', 'fake-ai', 'bin'), { recursive: true });
    const entry = path.join(dir, 'node_modules', 'fake-ai', 'bin', 'fake');
    fs.writeFileSync(entry, '#!/usr/bin/env node\nconsole.log(1)\n');
    const shim = path.join(dir, 'fake.cmd');
    fs.writeFileSync(shim, NPM_SHIM);
    process.env.CW_SPAWN_LOG = '1'; // a plain node gets the guard only with spawn logging on (Electron always)
    process.env.CLAUDE_WEB_DIR = path.join(dir, 'cw');
    const r = resolveSpawn(shim, ['serve']);
    expect(r.via).toBe('node-shim');
    expect(r.args[0]).toBe('--require');
    expect(r.args[1]).toMatch(/spawn-guard-[0-9a-f]{10}\.cjs$/);
    expect(r.args.slice(2)).toEqual([entry, 'serve']);
  });
});
