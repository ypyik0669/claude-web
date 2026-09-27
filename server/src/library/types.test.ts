import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isNotInstalled } from './types.js';

describe('isNotInstalled', () => {
  it('is true for a real spawn ENOENT', async () => {
    const err = await new Promise<unknown>((resolve) => {
      const c = spawn('definitely-not-a-real-binary-cw-xyz', [], { windowsHide: true });
      c.on('error', resolve);
    });
    expect(isNotInstalled(err)).toBe(true);
  });

  it('is false for an RPC / HTTP error that merely mentions ENOENT', () => {
    expect(isNotInstalled(new Error("thread/list failed: ENOENT: no such file or directory, open 'C:\\x\\rollout.jsonl'"))).toBe(false);
    expect(isNotInstalled({ code: -32603, message: 'ENOENT: rollout missing' })).toBe(false);
  });

  it('is false for a non-spawn ENOENT (a file the agent could not open)', () => {
    expect(isNotInstalled(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT', syscall: 'open' }))).toBe(false);
  });
});
