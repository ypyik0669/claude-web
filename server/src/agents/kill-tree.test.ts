import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { descendantsOf, killTree } from './kill-tree.js';

describe('descendantsOf (a `ps -A -o pid= -o ppid=` snapshot)', () => {
  const table = [
    '    1     0',
    '  100     1',
    '  101   100', // child
    '  102   100', // child
    '  103   101', // grandchild
    '  104   103', // great-grandchild
    '  200     1', // unrelated
    '  201   200',
    '',
  ].join('\n');

  it('lists children before grandchildren and nothing outside the tree', () => {
    expect(descendantsOf(100, table)).toEqual([101, 102, 103, 104]);
    expect(descendantsOf(101, table)).toEqual([103, 104]);
    expect(descendantsOf(104, table)).toEqual([]);
    expect(descendantsOf(999, table)).toEqual([]);
  });

  it('skips a header and garbage lines, and survives a cycle', () => {
    expect(descendantsOf(5, '  PID  PPID\n    6     5\nnot a line\n    5     6\n    7     7\n')).toEqual([6]);
  });
});

describe('killTree', { timeout: 45_000 }, () => {
  const files: string[] = [];
  afterEach(async () => { await Promise.all(files.splice(0).map((f) => fs.rm(f, { force: true }))); });

  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (ok: () => boolean | Promise<boolean>, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end;) { if (await ok()) return true; await new Promise((r) => setTimeout(r, 100)); }
    return ok();
  };

  // a launcher (node) whose real program (a grandchild) outlives it unless the whole tree is killed
  it('kills the grandchild a launcher started, not only the launcher', async () => {
    const pidFile = path.join(os.tmpdir(), `cw-killtree-${process.pid}-${Date.now()}.txt`);
    files.push(pidFile);
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const launcher = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', windowsHide: true }); setInterval(() => {}, 1000)`;
    const child = spawn(process.execPath, ['-e', launcher], { stdio: 'ignore', windowsHide: true });
    let gc = NaN;
    expect(await waitFor(async () => Number.isFinite(gc = Number(await fs.readFile(pidFile, 'utf8').catch(() => 'x'))), 15_000)).toBe(true);
    expect(alive(gc)).toBe(true);

    await killTree(child, 500);
    expect(await waitFor(() => child.exitCode !== null || child.signalCode !== null, 15_000)).toBe(true);
    expect(await waitFor(() => !alive(gc), 20_000)).toBe(true);
  });

  it('is a no-op for a process that has already exited', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => child.on('exit', r));
    await expect(killTree(child)).resolves.toBeUndefined();
  });
});
