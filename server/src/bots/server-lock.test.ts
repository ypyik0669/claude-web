import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { acquireServerLock, readLock, releaseLock, watchYield, writeLock, LOCK_FILE, YIELD_FILE, YIELD_WAIT_MS, type LockEnv } from './server-lock.js';
import { dutyStartCommand } from './duty.js';

describe('server.lock: one server per data dir', () => {
  let dir: string; let t: number; let alive: Set<number>; let killed: number[];
  const env = (pid: number, extra: Partial<LockEnv> = {}): LockEnv => ({
    pid, isAlive: (p) => alive.has(p), now: () => t, sleep: async (ms) => { t += ms; }, kill: (p) => { killed.push(p); alive.delete(p); }, log: () => {}, ...extra,
  });
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-slock-')); t = 1000; alive = new Set([1, 2]); killed = []; });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a duty server refuses a dir another live server holds, and takes a free one', async () => {
    writeLock(dir, { pid: 2, kind: 'app', port: 5555, startedAt: 1 });
    expect(await acquireServerLock(dir, 'duty', 3090, env(1))).toMatchObject({ ok: false, holder: { pid: 2, kind: 'app' } });
    expect(readLock(dir)?.pid).toBe(2);
    writeLock(dir, { pid: 2, kind: 'duty', port: 3090, startedAt: 1 });
    expect((await acquireServerLock(dir, 'duty', 3090, env(1))).ok).toBe(false);
  });

  it('a lock whose pid is dead is free', async () => {
    writeLock(dir, { pid: 99, kind: 'app', port: 5555, startedAt: 1 });
    expect(await acquireServerLock(dir, 'duty', 3090, env(1))).toMatchObject({ ok: true, lock: { pid: 1, kind: 'duty', port: 3090 } });
    expect(readLock(dir)).toMatchObject({ pid: 1, kind: 'duty' });
    releaseLock(dir, 1);
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });

  it('an app asks the duty server to yield and takes over once its lock is gone', async () => {
    writeLock(dir, { pid: 2, kind: 'duty', port: 3090, startedAt: 1 });
    let asked = false;
    // the duty server sees server.yield on its next look, shuts down and removes its lock
    const sleep = async (ms: number) => { t += ms; if (fs.existsSync(path.join(dir, YIELD_FILE))) { asked = true; releaseLock(dir, 2); } };
    const got = await acquireServerLock(dir, 'app', 0, env(1, { sleep }));
    expect(asked).toBe(true);
    expect(got).toMatchObject({ ok: true, yielded: { pid: 2 } });
    expect(killed).toEqual([]);
    expect(readLock(dir)).toMatchObject({ pid: 1, kind: 'app' });
    expect(fs.existsSync(path.join(dir, YIELD_FILE))).toBe(false);
  });

  it('a duty server that does not step down in time is killed', async () => {
    writeLock(dir, { pid: 2, kind: 'duty', port: 3090, startedAt: 1 });
    const t0 = t;
    const got = await acquireServerLock(dir, 'app', 0, env(1));
    expect(t - t0).toBeGreaterThanOrEqual(YIELD_WAIT_MS);
    expect(killed).toEqual([2]);
    expect(got.ok).toBe(true);
    expect(readLock(dir)?.pid).toBe(1);
  });

  it('beside another live app an app starts anyway and leaves its lock alone', async () => {
    writeLock(dir, { pid: 2, kind: 'app', port: 5555, startedAt: 1 });
    const log = vi.fn();
    expect((await acquireServerLock(dir, 'app', 0, env(1, { log }))).ok).toBe(true);
    expect(log).toHaveBeenCalled();
    expect(readLock(dir)?.pid).toBe(2);
    expect(killed).toEqual([]);
  });

  it('a yield request newer than the duty server\'s start makes it step down; an older one does not', async () => {
    fs.writeFileSync(path.join(dir, YIELD_FILE), '{}');
    const onYield = vi.fn();
    const stop = watchYield(dir, Date.now() + 60_000, onYield, 10);
    await new Promise((r) => setTimeout(r, 60));
    expect(onYield).not.toHaveBeenCalled();
    stop();
    const since = Date.now() - 1000;
    const stop2 = watchYield(dir, since, onYield, 10);
    fs.writeFileSync(path.join(dir, YIELD_FILE), '{}');
    await vi.waitFor(() => expect(onYield).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 40));
    expect(onYield).toHaveBeenCalledTimes(1);
    stop2();
  });

  it('the command that starts the duty service again, per platform', () => {
    expect(dutyStartCommand('win32')).toBe('schtasks /Run /TN "ClaudeWebDuty"');
    expect(dutyStartCommand('darwin', 501)).toBe('launchctl kickstart -k gui/501/app.claude-web.duty');
    expect(dutyStartCommand('linux')).toBe('systemctl --user start claude-web-duty');
  });
});
