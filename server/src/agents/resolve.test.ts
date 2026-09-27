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
});
