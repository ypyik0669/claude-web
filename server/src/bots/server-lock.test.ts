import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { acquireServerLock, dutyMayStart, liveHolder, probeLock, reclaimFromDuty, rotateLog, SUSPECT_MIN_MS, STARTING_STALE_MS, readLock, releaseLock, setLockReady, watchYield, writeLock, LOCK_FILE, YIELD_FILE, YIELD_WAIT_MS, YIELD_WAIT_STARTING_MS, type LockEnv, type ServerLock } from './server-lock.js';
import { dutyStartCommand } from './duty.js';

describe('server.lock: one server per data dir', () => {
  let dir: string; let t: number; let alive: Set<number>; let killed: number[]; let confirmed: boolean;
  const BOOT = 500;
  const env = (pid: number, extra: Partial<LockEnv> = {}): LockEnv => ({
    pid, isAlive: (p) => alive.has(p), bootTime: () => BOOT, now: () => t, sleep: async (ms) => { t += ms; },
    kill: async (p) => { killed.push(p); alive.delete(p); }, confirm: async () => confirmed, log: () => {}, ...extra,
  });
  const lock = (p: Partial<ServerLock>): ServerLock => ({ pid: 2, kind: 'app', port: 5555, startedAt: 600, ready: true, nonce: 'n', ...p });
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-slock-')); t = 1000; alive = new Set([1, 2]); killed = []; confirmed = true; });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a duty server refuses a dir another live server holds, and takes a free one', async () => {
    writeLock(dir, lock({ kind: 'app' }));
    expect(await acquireServerLock(dir, 'duty', 3090, env(1))).toMatchObject({ ok: false, holder: { pid: 2, kind: 'app' } });
    expect(readLock(dir)?.pid).toBe(2);
    writeLock(dir, lock({ kind: 'duty' }));
    expect((await acquireServerLock(dir, 'duty', 3090, env(1))).ok).toBe(false);
  });

  it('a lock whose pid is dead is free; the new lock has a nonce and is not ready until it listens', async () => {
    writeLock(dir, lock({ pid: 99 }));
    const got = await acquireServerLock(dir, 'duty', 3090, env(1));
    expect(got).toMatchObject({ ok: true, held: true, lock: { pid: 1, kind: 'duty', port: 3090, ready: false } });
    expect(readLock(dir)?.nonce).toMatch(/^[0-9a-f]{24}$/);
    setLockReady(dir, 1, 4321);
    expect(readLock(dir)).toMatchObject({ pid: 1, port: 4321, ready: true });
    releaseLock(dir, 1);
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });

  it('pid reuse: a lock written before this boot is dead though its pid runs — never waited on, never killed', async () => {
    writeLock(dir, lock({ pid: 2, kind: 'duty', startedAt: BOOT - 1 })); // pid 2 is alive: some other program now
    expect(await acquireServerLock(dir, 'duty', 3090, env(1))).toMatchObject({ ok: true, held: true });
    fs.rmSync(path.join(dir, LOCK_FILE));
    writeLock(dir, lock({ pid: 2, kind: 'duty', startedAt: BOOT - 1 }));
    const t0 = t;
    const got = await acquireServerLock(dir, 'app', 0, env(1));
    expect(got).toMatchObject({ ok: true, held: true }); expect((got as any).yielded).toBeUndefined();
    expect(t - t0).toBe(0);
    expect(killed).toEqual([]);
    expect(fs.existsSync(path.join(dir, YIELD_FILE))).toBe(false);
  });

  it('an app asks the duty server to yield and takes over once its lock is gone', async () => {
    writeLock(dir, lock({ kind: 'duty' }));
    let asked = false;
    // the duty server sees server.yield on its next look, shuts down and removes its lock
    const sleep = async (ms: number) => { t += ms; if (fs.existsSync(path.join(dir, YIELD_FILE))) { asked = true; releaseLock(dir, 2); } };
    const got = await acquireServerLock(dir, 'app', 0, env(1, { sleep }));
    expect(asked).toBe(true);
    expect(got).toMatchObject({ ok: true, held: true, yielded: { pid: 2 } });
    expect(killed).toEqual([]);
    expect(readLock(dir)).toMatchObject({ pid: 1, kind: 'app' });
    expect(fs.existsSync(path.join(dir, YIELD_FILE))).toBe(false);
  });

  it('a ready duty server that does not step down is stopped after 10 s — only once its port confirms it', async () => {
    writeLock(dir, lock({ kind: 'duty', ready: true }));
    const t0 = t;
    const got = await acquireServerLock(dir, 'app', 0, env(1));
    expect(t - t0).toBeGreaterThanOrEqual(YIELD_WAIT_MS);
    expect(t - t0).toBeLessThan(YIELD_WAIT_STARTING_MS);
    expect(killed).toEqual([2]);
    expect(got.ok).toBe(true);
    expect(readLock(dir)?.pid).toBe(1);
  });

  it('a duty server still starting gets up to 60 s; one that cannot be confirmed is never killed — the app takes the lock over', async () => {
    writeLock(dir, lock({ kind: 'duty', ready: false }));
    confirmed = false;
    const t0 = t;
    const got = await acquireServerLock(dir, 'app', 0, env(1));
    expect(t - t0).toBeGreaterThanOrEqual(YIELD_WAIT_STARTING_MS);
    expect(killed).toEqual([]);
    expect(got).toMatchObject({ ok: true, held: true });
    expect(readLock(dir)).toMatchObject({ pid: 1, kind: 'app' });
  });

  it('pid reuse since boot: a ready lock whose port does not answer is dead (asked twice) — the duty server and the app take the dir', async () => {
    writeLock(dir, lock({ pid: 2, kind: 'app', ready: true })); // the app died uncleanly; pid 2 is another program now
    confirmed = false;
    expect(await liveHolder(dir, env(1))).toBeNull();
    expect(await acquireServerLock(dir, 'duty', 3090, env(1))).toMatchObject({ ok: true, held: true });
    writeLock(dir, lock({ pid: 2, kind: 'app', ready: true }));
    expect(await acquireServerLock(dir, 'app', 0, env(1))).toMatchObject({ ok: true, held: true });
    expect(readLock(dir)?.pid).toBe(1);
    expect(killed).toEqual([]);
    // one slow answer is not death
    writeLock(dir, lock({ pid: 2, kind: 'app', ready: true }));
    let asks = 0;
    expect(await liveHolder(dir, env(1, { confirm: async () => ++asks > 1 }))).toMatchObject({ pid: 2 });
    confirmed = true;
    expect(await liveHolder(dir, env(1))).toMatchObject({ pid: 2 });
  });

  it('a lock not ready yet counts while it is younger than STARTING_STALE_MS, not after', async () => {
    writeLock(dir, lock({ pid: 2, kind: 'duty', ready: false, port: 0, startedAt: 900 }));
    confirmed = false;
    expect(await liveHolder(dir, env(1))).toMatchObject({ pid: 2 });
    t = 900 + STARTING_STALE_MS;
    expect(await liveHolder(dir, env(1))).toBeNull();
    expect(await acquireServerLock(dir, 'duty', 3090, env(1))).toMatchObject({ ok: true, held: true });
  });

  it('beside another live app an app starts anyway and leaves its lock alone', async () => {
    writeLock(dir, lock({ kind: 'app' }));
    const log = vi.fn();
    expect(await acquireServerLock(dir, 'app', 0, env(1, { log }))).toMatchObject({ ok: true, held: false });
    expect(log).toHaveBeenCalled();
    expect(readLock(dir)?.pid).toBe(2);
    expect(killed).toEqual([]);
  });

  it('two servers taking a free dir at once: exactly one holds it (exclusive create)', async () => {
    const [a, b] = await Promise.all([acquireServerLock(dir, 'duty', 1, env(1)), acquireServerLock(dir, 'duty', 2, env(2))]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('the duty server steps down on a yield request newer than its start, or when the lock stops naming it; not on an older one', async () => {
    fs.writeFileSync(path.join(dir, YIELD_FILE), '{}');
    writeLock(dir, lock({ pid: 7 }));
    const onYield = vi.fn();
    const stop = watchYield(dir, Date.now() + 60_000, 7, onYield, 10);
    await new Promise((r) => setTimeout(r, 60));
    expect(onYield).not.toHaveBeenCalled();
    stop();
    const stop2 = watchYield(dir, Date.now() - 1000, 7, onYield, 10);
    fs.writeFileSync(path.join(dir, YIELD_FILE), '{}');
    await vi.waitFor(() => expect(onYield).toHaveBeenCalledTimes(1));
    stop2();
    fs.rmSync(path.join(dir, YIELD_FILE));
    const other = vi.fn();
    const stop3 = watchYield(dir, Date.now() + 60_000, 7, other, 10);
    writeLock(dir, lock({ pid: 8 }));
    await vi.waitFor(() => expect(other).toHaveBeenCalledTimes(1));
    stop3();
  });

  it('probeLock: yes only from a server that answers lock: true for the nonce; no port / no answer is no', async () => {
    const srv = http.createServer((req, res) => res.end(JSON.stringify({ ok: true, lock: !!req.url?.includes('lock=good') })));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    try {
      expect(await probeLock(lock({ port, nonce: 'good' }))).toBe(true);
      expect(await probeLock(lock({ port, nonce: 'bad' }))).toBe(false);
      expect(await probeLock(lock({ port: 0, nonce: 'good' }))).toBe(false);
    } finally { await new Promise((r) => srv.close(r)); }
    expect(await probeLock(lock({ port, nonce: 'good' }), 300)).toBe(false);
  });

  it('probeLock: a server that trickles bytes, sends over 64 KB or drops the connection is a no within the deadline', async () => {
    const timers: NodeJS.Timeout[] = [];
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.includes('trickle')) { res.write('{'); timers.push(setInterval(() => res.write(' '), 100)); return; }
      if (req.url?.includes('big')) { const chunk = ' '.repeat(16_384); timers.push(setInterval(() => res.write(chunk), 5)); return; }
      if (req.url?.includes('drop')) { res.write('{"lock":'); setTimeout(() => res.destroy(), 50); return; }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    const within = async (nonce: string) => {
      const t0 = Date.now();
      const v = await Promise.race([probeLock(lock({ port, nonce }), 600), new Promise((r) => setTimeout(() => r('hung'), 5000))]);
      return { v, ms: Date.now() - t0 };
    };
    try {
      const trickle = await within('trickle');
      expect(trickle.v).toBe(false); expect(trickle.ms).toBeLessThan(2000);
      expect((await within('big')).v).toBe(false);
      expect((await within('drop')).v).toBe(false);
    } finally { for (const t of timers) clearInterval(t); srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
  });

  it('a stale lock replaced by a live one between the check and the unlink is left alone', async () => {
    writeLock(dir, lock({ pid: 99, kind: 'app' })); // dead
    const isAlive = (p: number) => {
      // another server takes the dir right after the stale lock was judged
      if (p === 99 && readLock(dir)?.pid === 99) writeLock(dir, lock({ pid: 2, kind: 'app', nonce: 'fresh' }));
      return alive.has(p);
    };
    expect(await acquireServerLock(dir, 'duty', 3090, env(1, { isAlive }))).toMatchObject({ ok: false, holder: { pid: 2 } });
    expect(readLock(dir)).toMatchObject({ pid: 2, nonce: 'fresh' });
  });

  it('dutyMayStart: a lock that does not answer is taken only on a second look >= 25 s later; one that answers again clears it', async () => {
    writeLock(dir, lock({ pid: 2, kind: 'app', ready: true })); // pid 2 runs, its port is silent (a stall, or another program)
    confirmed = false;
    expect(await dutyMayStart(dir, env(1))).toMatchObject({ start: false, holder: { pid: 2 } }); // first look
    t += 5_000;
    expect((await dutyMayStart(dir, env(1))).start).toBe(false); // too soon
    t += SUSPECT_MIN_MS;
    expect((await dutyMayStart(dir, env(1))).start).toBe(true); // the next start of the duty loop
    // the app recovers between the two looks: its stall is forgotten
    t += 1_000;
    expect((await dutyMayStart(dir, env(1))).start).toBe(false);
    confirmed = true;
    expect((await dutyMayStart(dir, env(1))).start).toBe(false);
    confirmed = false; t += SUSPECT_MIN_MS * 2;
    expect((await dutyMayStart(dir, env(1))).start).toBe(false); // a first look again
    // a dead pid / no lock: at once
    writeLock(dir, lock({ pid: 99 }));
    expect((await dutyMayStart(dir, env(1))).start).toBe(true);
  });

  it('reclaimFromDuty: an app finds a live duty server on its lock, asks it to step down and takes the lock back; a lock of another app is left alone', async () => {
    const own = lock({ pid: 1, kind: 'app', nonce: 'app', port: 3090 });
    writeLock(dir, own);
    expect(await reclaimFromDuty(dir, own, env(1))).toBe(false); // ours
    writeLock(dir, lock({ pid: 2, kind: 'duty', nonce: 'duty' })); // the duty server took it while the app stalled
    let asked = false;
    const sleep = async (ms: number) => { t += ms; if (fs.existsSync(path.join(dir, YIELD_FILE))) { asked = true; releaseLock(dir, 2); } };
    expect(await reclaimFromDuty(dir, own, env(1, { sleep }))).toBe(true);
    expect(asked).toBe(true);
    expect(readLock(dir)).toMatchObject({ pid: 1, nonce: 'app' });
    expect(fs.existsSync(path.join(dir, YIELD_FILE))).toBe(false);
    expect(killed).toEqual([]);
    writeLock(dir, lock({ pid: 2, kind: 'app', nonce: 'other' }));
    expect(await reclaimFromDuty(dir, own, env(1))).toBe(false);
    expect(readLock(dir)?.nonce).toBe('other');
    fs.rmSync(path.join(dir, LOCK_FILE)); // gone: taken
    expect(await reclaimFromDuty(dir, own, env(1))).toBe(true);
    expect(readLock(dir)?.nonce).toBe('app');
  });

  it('rotateLog: over the cap the log becomes .1 (replacing the old one); under it, or missing, nothing happens', () => {
    const f = path.join(dir, 'duty.log');
    rotateLog(f, 10);
    fs.writeFileSync(f, 'short'); rotateLog(f, 10);
    expect(fs.readFileSync(f, 'utf8')).toBe('short');
    fs.writeFileSync(`${f}.1`, 'older');
    fs.writeFileSync(f, 'x'.repeat(11)); rotateLog(f, 10);
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.readFileSync(`${f}.1`, 'utf8')).toBe('x'.repeat(11));
  });

  it('setLockReady says whether the lock still names this process', () => {
    writeLock(dir, lock({ pid: 1, ready: false, port: 0, nonce: 'mine' }));
    expect(setLockReady(dir, 1, 4000)).toBe(true);
    expect(readLock(dir)).toMatchObject({ pid: 1, ready: true, port: 4000 });
    writeLock(dir, lock({ pid: 2, nonce: 'theirs' })); // an app took the dir over
    expect(setLockReady(dir, 1, 4000)).toBe(false);
    expect(readLock(dir)).toMatchObject({ pid: 2, nonce: 'theirs' });
  });

  it('the command that starts the duty service again, per platform', () => {
    expect(dutyStartCommand('win32')).toBe('schtasks /Run /TN "ClaudeWebDuty"');
    expect(dutyStartCommand('darwin', 501)).toBe('launchctl kickstart -k gui/501/app.claude-web.duty');
    expect(dutyStartCommand('linux')).toBe('systemctl --user start claude-web-duty');
  });
});
