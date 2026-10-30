// One full server per data dir: `<dataDir>/server.lock` names the server that serves it. Two servers on one dir (the
// headless duty service and the desktop app) would race on meta.json, tick the schedules twice and poll the IM
// gateways twice. The duty server yields: it refuses to start while another live server holds the lock, and steps
// down when one asks (`<dataDir>/server.yield`). An app / dev server asks a duty server to yield and takes over; beside
// another app it starts anyway (a warning), as before. A lock whose pid is dead is free (same host: process.kill(pid, 0)).
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_FILE = 'server.lock';
export const YIELD_FILE = 'server.yield';
/** the duty server's exit code when another server holds the dir (EX_TEMPFAIL); its loop backs off and tries again */
export const BUSY_EXIT = 75;
/** how long an app waits for a duty server to step down before it kills it */
export const YIELD_WAIT_MS = 10_000;
/** how often a duty server looks for a yield request */
export const YIELD_POLL_MS = 2_000;

export type ServerKind = 'duty' | 'app';
export interface ServerLock { pid: number; kind: ServerKind; port: number; startedAt: number }

/** the side effects, injectable for tests */
export interface LockEnv {
  pid: number;
  isAlive(pid: number): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  kill(pid: number): void;
  log(msg: string): void;
}

export const pidAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } // EPERM = alive, not ours
};

export const processLockEnv = (): LockEnv => ({
  pid: process.pid,
  isAlive: pidAlive,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  kill: (pid) => { try { process.kill(pid); } catch { /* gone */ } },
  log: (msg) => console.log(msg),
});

export function readLock(dir: string): ServerLock | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8'));
    return j && typeof j.pid === 'number' && j.pid > 0 ? (j as ServerLock) : null;
  } catch { return null; }
}

/** atomic: a reader never sees half a lock */
export function writeLock(dir: string, lock: ServerLock) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const tmp = `${file}.${lock.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock));
  fs.renameSync(tmp, file);
}

/** removes the lock only if it is still ours */
export function releaseLock(dir: string, pid: number) {
  try { if (readLock(dir)?.pid === pid) fs.rmSync(path.join(dir, LOCK_FILE), { force: true }); } catch { /* gone */ }
}

/** the server's real port, once it listens (an app starts on PORT 0) */
export function setLockPort(dir: string, pid: number, port: number) {
  const cur = readLock(dir);
  if (cur?.pid === pid && cur.port !== port) { try { writeLock(dir, { ...cur, port }); } catch { /* best effort */ } }
}

/** the lock of another live process, or null when the dir is free */
export function liveHolder(dir: string, env: Pick<LockEnv, 'pid' | 'isAlive'>): ServerLock | null {
  const lock = readLock(dir);
  return lock && lock.pid !== env.pid && env.isAlive(lock.pid) ? lock : null;
}

export type Acquired = { ok: true; lock: ServerLock; yielded?: ServerLock } | { ok: false; holder: ServerLock };

/**
 * At startup, before any port or service opens. A duty server refuses a dir another live server holds. An app asks a
 * live duty server to yield, waits up to YIELD_WAIT_MS for its lock to go, kills it if it is still there, then takes the
 * lock; beside another live app it takes the lock anyway and warns.
 */
export async function acquireServerLock(dir: string, kind: ServerKind, port: number, env: LockEnv): Promise<Acquired> {
  const holder = liveHolder(dir, env);
  let yielded: ServerLock | undefined;
  if (holder && kind === 'duty') return { ok: false, holder };
  if (holder?.kind === 'duty') {
    yielded = holder;
    env.log(`[server] asking the duty server (pid ${holder.pid}) to step down`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, YIELD_FILE), JSON.stringify({ by: env.pid, at: env.now() }));
    const end = env.now() + YIELD_WAIT_MS;
    const gone = () => readLock(dir)?.pid !== holder.pid || !env.isAlive(holder.pid);
    while (!gone() && env.now() < end) await env.sleep(250);
    if (!gone()) { env.log(`[server] the duty server (pid ${holder.pid}) did not step down; stopping it`); env.kill(holder.pid); }
    try { fs.rmSync(path.join(dir, YIELD_FILE), { force: true }); } catch { /* raced */ }
  }
  const lock: ServerLock = { pid: env.pid, kind, port, startedAt: env.now() };
  if (holder && !yielded) {
    // a second app / dev server: starts as before, and leaves the first one's lock alone (a duty server started while
    // that one runs must still step aside)
    env.log(`[server] another claude-web (pid ${holder.pid}) is also serving ${dir}; starting anyway`);
    return { ok: true, lock };
  }
  writeLock(dir, lock);
  return { ok: true, lock, ...(yielded ? { yielded } : {}) };
}

/**
 * The duty server: calls onYield once when a yield request newer than `since` appears (a cheap stat every interval).
 * Returns the stop function.
 */
export function watchYield(dir: string, since: number, onYield: () => void, intervalMs = YIELD_POLL_MS): () => void {
  const file = path.join(dir, YIELD_FILE);
  const timer = setInterval(() => {
    let m = 0;
    try { m = fs.statSync(file).mtimeMs; } catch { return; }
    if (m < since) return;
    clearInterval(timer);
    onYield();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
