import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonRpcProcess } from './jsonrpc.js';
import { isNodeScript } from './resolve.js';

const exitOf = (rpc: JsonRpcProcess) => new Promise<unknown>((r) => rpc.once('exit', r));

describe('JsonRpcProcess', () => {
  it('rejects requests made after the process exited instead of hanging', async () => {
    const rpc = new JsonRpcProcess(process.execPath, ['-e', 'process.exit(0)']);
    await exitOf(rpc);
    await expect(rpc.request('ping', {}, 0)).rejects.toThrow(/退出/);
  });

  it('survives writes to a child that already closed stdin (EPIPE)', async () => {
    // closes stdin immediately but stays alive a moment, so our writes hit a dead pipe
    const rpc = new JsonRpcProcess(process.execPath, ['-e', 'process.stdin.destroy(); setTimeout(() => {}, 300)']);
    const p = rpc.request('x', 'y'.repeat(256 * 1024), 0).catch(() => 'rejected');
    for (let i = 0; i < 20; i++) rpc.notify('spam', 'z'.repeat(64 * 1024));
    await exitOf(rpc);
    expect(await p).toBe('rejected');
  });

  it('emits exit once for a missing binary', async () => {
    const rpc = new JsonRpcProcess(path.join(os.tmpdir(), 'definitely-not-here-cw'), []);
    let n = 0;
    rpc.on('exit', () => { n++; });
    await new Promise((r) => setTimeout(r, 300));
    expect(n).toBe(1);
    expect(rpc.exited).toBe(true);
  });
});

describe('isNodeScript', () => {
  it('detects npm-style node shebangs', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-shebang-'));
    try {
      await fs.writeFile(path.join(dir, 'a'), '#!/usr/bin/env node\nconsole.log(1)\n');
      await fs.writeFile(path.join(dir, 'b'), '#!/bin/sh\nexec foo\n');
      expect(isNodeScript(path.join(dir, 'a'))).toBe(true);
      expect(isNodeScript(path.join(dir, 'b'))).toBe(false);
      expect(isNodeScript(path.join(dir, 'missing'))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
