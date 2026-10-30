// One full server per data dir: `<dataDir>/server.lock` names the server that serves it. Two servers on one dir (the
// headless duty service and the desktop app) would race on meta.json, tick the schedules twice and poll the IM
// gateways twice. The duty server yields: it refuses to start while another live server holds the lock, and steps
// down when one asks (`<dataDir>/server.yield`) or when the lock stops naming it. An app / dev server asks a duty
// server to yield and takes over; beside another app it starts anyway (a warning), as before.
//
// Live means: the pid runs AND the lock was written after this boot (a pid from before a reboot may now be any
// program) AND — since a server that died without cleanup may have its pid handed to another program long before a
// reboot — a ready lock's port still answers with its nonce, and a lock not ready yet is younger than
// STARTING_STALE_MS. A process is only ever killed once its port answered /api/health with the lock's nonce — never a pid this
// can't confirm is that claude-web.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const LOCK_FILE = 'server.lock';
/** the duty entry's note of a lock that looked dead once (dutyMayStart): it is taken only on a second look */
export const SUSPECT_FILE = 'server.lock.suspect';
/** …at least this long after the first (the duty loop starts the entry every 30 s) */
export const SUSPECT_MIN_MS = 25_000;
export const YIELD_FILE = 'server.yield';
/** the duty server's exit code when another server holds the dir (EX_TEMPFAIL); its loop backs off and tries again */
export const BUSY_EXIT = 75;
/** how long an app waits for a ready duty server to step down before it stops it */
export const YIELD_WAIT_MS = 10_000;
/** …and for one still starting (it steps down as soon as its startup is done) */
export const YIELD_WAIT_STARTING_MS = 60_000;
/** how often a duty server looks for a yield request */
export const YIELD_POLL_MS = 2_000;
/** a lock still not ready after this long is a server that died while starting (its pid may be another program's now) */
export const STARTING_STALE_MS = 5 * 60_000;
/** SIGTERM, then SIGKILL after this */
export const KILL_GRACE_MS = 3_000;

export type ServerKind = 'duty' | 'app';
export interface ServerLock {
  pid: number; kind: ServerKind; port: number; startedAt: number;
  /** false until the server listens (then `port` is real) */
  ready?: boolean;
  /** proves the process on `port` is the one that wrote this lock: /api/health?lock=<nonce> answers lock: true */
  nonce?: string;
}

/** the side effects, injectable for tests */
export interface LockEnv {
  pid: number;
  isAlive(pid: number): boolean;
  /** when this machine booted (ms) */
  bootTime(): number;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** stops the process (SIGTERM, then SIGKILL after a grace) */
  kill(pid: number): Promise<void>;
  /** the server on lock.port answers as the claude-web that wrote this lock */
  confirm(lock: ServerLock): Promise<boolean>;
  log(msg: string): void;
}

export const pidAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } // EPERM = alive, not ours
};
export const bootTime = () => Date.now() - os.uptime() * 1000;

/**
 * GET http://127.0.0.1:<port>/api/health?lock=<nonce> → lock: true. Whole answer within `timeoutMs` (a server that
 * trickles bytes doesn't hold it open), at most 64 KB; anything else is no.
 */
export function probeLock(lock: ServerLock, timeoutMs = 1500): Promise<boolean> {
  if (!lock.nonce || !(lock.port > 0)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (!v) req.destroy();
      resolve(v);
    };
    const deadline = setTimeout(() => done(false), timeoutMs);
    const req = http.get({ host: '127.0.0.1', port: lock.port, path: `/api/health?lock=${encodeURIComponent(lock.nonce!)}`, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 65_536) done(false); });
      res.on('end', () => { let ok = false; try { ok = JSON.parse(body)?.lock === true; } catch { /* not JSON */ } done(ok); });
      res.on('error', () => done(false));
      res.on('close', () => done(false)); // after 'end' this is a no-op
    });
    req.on('timeout', () => done(false));
    req.on('error', () => done(false));
  });
}

export const processLockEnv = (): LockEnv => ({
  pid: process.pid,
  isAlive: pidAlive,
  bootTime,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  kill: async (pid) => {
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
    for (let t = 0; t < KILL_GRACE_MS && pidAlive(pid); t += 100) await new Promise((r) => setTimeout(r, 100));
    if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  },
  confirm: (lock) => probeLock(lock),
  log: (msg) => console.log(msg),
});

/**
 * duty.log over `max` bytes becomes `<file>.1` (replacing the old one). The duty entry calls it on every start (every
 * 30 s while the app is open); where the log is held open (Windows: the cmd's redirect) the rename fails and the vbs
 * rotates it between runs instead.
 */
export function rotateLog(file: string, max = 1024 * 1024) {
  try { if (fs.statSync(file).size > max) fs.renameSync(file, `${file}.1`); } catch { /* none, or held open */ }
}

/** this process's own lock nonce (for /api/health), once it has taken the lock */
let ownNonce: string | undefined;
export function lockNonce(): string | undefined { return ownNonce; }

export function readLock(dir: string): ServerLock | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8'));
    return j && typeof j.pid === 'number' && j.pid > 0 ? (j as ServerLock) : null;
  } catch { return null; }
}

/** a lock this process may treat as a live server's: another pid, written since boot, still running */
export function isLive(lock: ServerLock | null, env: Pick<LockEnv, 'pid' | 'isAlive' | 'bootTime'>): lock is ServerLock {
  return !!lock && lock.pid !== env.pid && typeof lock.startedAt === 'number' && lock.startedAt >= env.bootTime() && env.isAlive(lock.pid);
}

/**
 * isLive, confirmed: a ready lock (port + nonce) counts only when its port answers as that server (asked twice, a
 * second apart, so a busy server isn't judged dead on one slow answer); a lock not ready yet only while younger than
 * STARTING_STALE_MS.
 */
export async function isLiveConfirmed(lock: ServerLock | null, env: Pick<LockEnv, 'pid' | 'isAlive' | 'bootTime' | 'now' | 'sleep' | 'confirm'>): Promise<boolean> {
  if (!isLive(lock, env)) return false;
  if (lock.ready && lock.port > 0 && lock.nonce) {
    if (await env.confirm(lock)) return true;
    await env.sleep(1000);
    return env.confirm(lock);
  }
  return env.now() - lock.startedAt < STARTING_STALE_MS;
}

/** exclusive create: false when a lock is already there */
function createLock(dir: string, lock: ServerLock): boolean {
  fs.mkdirSync(dir, { recursive: true });
  let fd: number;
  try { fd = fs.openSync(path.join(dir, LOCK_FILE), 'wx', 0o600); } catch (e: any) {
    if (e?.code === 'EEXIST') return false;
    throw e;
  }
  try { fs.writeSync(fd, JSON.stringify(lock)); } finally { fs.closeSync(fd); }
  return true;
}
/** replaces whatever lock is there (an app taking over from a duty server it asked to yield) — atomic */
export function writeLock(dir: string, lock: ServerLock) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const tmp = `${file}.${lock.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** removes the lock only if it is still ours */
export function releaseLock(dir: string, pid: number) {
  try { if (readLock(dir)?.pid === pid) fs.rmSync(path.join(dir, LOCK_FILE), { force: true }); } catch { /* gone */ }
}

/**
 * The server listens: its real port (an app starts on PORT 0), ready. False when the lock no longer names this
 * process (an app took it over meanwhile — read again after the write, which may have raced it): the caller steps
 * down, as the yield poll would.
 */
export function setLockReady(dir: string, pid: number, port: number): boolean {
  const cur = readLock(dir);
  if (cur?.pid !== pid) return false;
  try { writeLock(dir, { ...cur, port, ready: true }); } catch { /* best effort */ }
  const after = readLock(dir);
  return after?.pid === pid && after.nonce === cur.nonce;
}

/** the lock of another live process (confirmed: isLiveConfirmed), or null when the dir is free */
export async function liveHolder(dir: string, env: Pick<LockEnv, 'pid' | 'isAlive' | 'bootTime' | 'now' | 'sleep' | 'confirm'>): Promise<ServerLock | null> {
  const lock = readLock(dir);
  return (await isLiveConfirmed(lock, env)) ? lock : null;
}

export type Acquired = { ok: true; lock: ServerLock; held: boolean; yielded?: ServerLock } | { ok: false; holder: ServerLock };

/**
 * Takes the lock exclusively ('wx'); a lock there that is not live (dead pid, from before the boot, a ready one whose
 * port doesn't answer, one not ready for STARTING_STALE_MS, unreadable for over a second) is removed and the create tried once more. Returns the live holder when it can't.
 */
async function claim(dir: string, lock: ServerLock, env: LockEnv): Promise<ServerLock | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createLock(dir, lock)) return null;
    // a lock being written right now reads as nothing for a moment
    let cur = readLock(dir);
    for (let i = 0; !cur && i < 10 && fs.existsSync(path.join(dir, LOCK_FILE)); i++) { await env.sleep(100); cur = readLock(dir); }
    if (await isLiveConfirmed(cur, env)) return cur;
    // only the stale lock just judged: another server may have replaced it since (then that one is read next round)
    const again = readLock(dir);
    const seen = cur as ServerLock | null;
    const same = seen && again && again.pid === seen.pid && again.startedAt === seen.startedAt && again.nonce === seen.nonce;
    if (same || (!seen && !again)) { try { fs.rmSync(path.join(dir, LOCK_FILE), { force: true }); } catch { /* raced */ } }
  }
  const cur = readLock(dir);
  return (await isLiveConfirmed(cur, env)) ? cur : readLock(dir) ?? { pid: -1, kind: 'app', port: 0, startedAt: 0 };
}

/**
 * At startup, before any port or service opens. A duty server refuses a dir another live server holds. An app asks a
 * live duty server to yield and waits for its lock to go (up to 60 s while it is still starting, 10 s once ready);
 * one that stays is stopped only if its port confirms it is that claude-web, otherwise the app takes the lock over and
 * the duty server steps down on its own (its poll sees the lock no longer names it). Beside another live app an app
 * starts anyway, holding no lock, and warns.
 */
export async function acquireServerLock(dir: string, kind: ServerKind, port: number, env: LockEnv): Promise<Acquired> {
  const lock: ServerLock = { pid: env.pid, kind, port, startedAt: env.now(), ready: false, nonce: randomBytes(12).toString('hex') };
  const holder = await claim(dir, lock, env);
  if (!holder) { ownNonce = lock.nonce; return { ok: true, lock, held: true }; }
  if (kind === 'duty') return { ok: false, holder };
  if (holder.kind !== 'duty') {
    env.log(`[server] another claude-web (pid ${holder.pid}) is also serving ${dir}; starting anyway`);
    return { ok: true, lock, held: false };
  }
  await askDutyToYield(dir, holder, env);
  // what is there now is the duty server's (gone, stopped or about to step down): ours replaces it
  if (await claim(dir, lock, env)) writeLock(dir, lock);
  ownNonce = lock.nonce;
  return { ok: true, lock, held: true, yielded: holder };
}

/**
 * An app asks a live duty server to step down (server.yield) and waits for its lock to go (up to 60 s while it is
 * still starting, 10 s once ready); one that stays is stopped only if its port confirms it is that claude-web.
 */
async function askDutyToYield(dir: string, holder: ServerLock, env: LockEnv) {
  env.log(`[server] asking the duty server (pid ${holder.pid}) to step down`);
  fs.writeFileSync(path.join(dir, YIELD_FILE), JSON.stringify({ by: env.pid, at: env.now() }));
  const start = env.now();
  const gone = () => { const cur = readLock(dir); return cur?.pid !== holder.pid || !isLive(cur, env); };
  const waited = () => env.now() - start >= (readLock(dir)?.ready ? YIELD_WAIT_MS : YIELD_WAIT_STARTING_MS);
  while (!gone() && !waited()) await env.sleep(250);
  if (!gone()) {
    const cur = readLock(dir) ?? holder;
    if (await env.confirm(cur)) {
      env.log(`[server] the duty server (pid ${holder.pid}) did not step down; stopping it`);
      await env.kill(holder.pid);
    } else env.log(`[server] the duty server (pid ${holder.pid}) did not step down and could not be confirmed; taking the data dir over (it steps down on its own)`);
  }
  try { fs.rmSync(path.join(dir, YIELD_FILE), { force: true }); } catch { /* raced */ }
}

/**
 * An app's look at the lock (watchLock, every YIELD_POLL_MS). A duty server can take the dir while this app runs:
 * its entry judged the app dead (an event loop stalled past the probe, twice 30 s apart), or this app started beside
 * another one without the lock. A live duty server named there is asked to step down and the lock taken back; a lock
 * that is gone or dead is taken back too. Another live app's is left alone. True when it took the lock (back).
 */
export async function reclaimFromDuty(dir: string, own: ServerLock, env: LockEnv): Promise<boolean> {
  const cur = readLock(dir);
  if (cur?.pid === own.pid && cur.nonce === own.nonce) return false;
  if (isLive(cur, env)) {
    if (cur.kind !== 'duty') return false;
    env.log(`[server] the duty server (pid ${cur.pid}) took the data dir while this server ran; taking it back`);
    await askDutyToYield(dir, cur, env);
  }
  const now = readLock(dir);
  if (now && now.pid !== own.pid && now.kind !== 'duty' && isLive(now, env)) return false; // another app got there first
  writeLock(dir, own);
  ownNonce = own.nonce;
  return true;
}

/** the app's side of the yield: reclaimFromDuty every interval (one at a time); `own` is the lock as it is now (port, ready). Returns the stop function. */
export function watchLock(dir: string, own: () => ServerLock, env: LockEnv, intervalMs = YIELD_POLL_MS): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    reclaimFromDuty(dir, own(), env).catch((e) => env.log(`[server] checking the data dir's lock: ${e}`)).finally(() => { busy = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The duty entry, before it loads the server: start, or not (holder: who serves the dir). A lock whose pid is gone /
 * from before the boot is free at once. One whose pid runs but doesn't answer (isLiveConfirmed says no) is dead only
 * on a second look at least SUSPECT_MIN_MS after the first (the next start of the duty loop) — an app whose event loop
 * stalled for a few seconds isn't taken over.
 */
export async function dutyMayStart(dir: string, env: Pick<LockEnv, 'pid' | 'isAlive' | 'bootTime' | 'now' | 'sleep' | 'confirm'>): Promise<{ start: boolean; holder?: ServerLock }> {
  const file = path.join(dir, SUSPECT_FILE);
  const clear = () => { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } };
  const lock = readLock(dir);
  if (!isLive(lock, env)) { clear(); return { start: true }; }
  if (await isLiveConfirmed(lock, env)) { clear(); return { start: false, holder: lock }; }
  const key = `${lock.pid}|${lock.startedAt}|${lock.nonce ?? ''}`;
  let seen: { key?: string; at?: number } | null = null;
  try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first look */ }
  if (seen?.key === key && typeof seen.at === 'number' && env.now() - seen.at >= SUSPECT_MIN_MS) { clear(); return { start: true }; }
  if (seen?.key !== key) { try { fs.writeFileSync(file, JSON.stringify({ key, at: env.now() })); } catch { /* next time */ } }
  return { start: false, holder: lock };
}

/**
 * The duty server: calls onYield once when a yield request newer than `since` appears, or the lock no longer names
 * this process (an app took it over). A cheap stat / read every interval. Returns the stop function.
 */
export function watchYield(dir: string, since: number, pid: number, onYield: () => void, intervalMs = YIELD_POLL_MS): () => void {
  const file = path.join(dir, YIELD_FILE);
  const timer = setInterval(() => {
    let asked = false;
    try { asked = fs.statSync(file).mtimeMs >= since; } catch { /* none */ }
    if (!asked) { const cur = readLock(dir); asked = !!cur && cur.pid !== pid; }
    if (!asked) return;
    clearInterval(timer);
    onYield();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
