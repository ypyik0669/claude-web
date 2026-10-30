import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Bot, BotLoad, BotRun, InboxAnswer, InboxItem, Routine, RunTrigger } from '../protocol.js';
import { nextCron } from '../schedules/cron.js';
import { missedRun } from '../schedules/catch-up.js';
import { atomicWrite } from '../agent-config/backup.js';
import { runRoutine, type PipelineDeps, type RunOptions } from './pipeline.js';
import { recordApproval, recordCorrection, demoteRule, TRUST_THRESHOLD } from './policy/trust.js';
import { scopeKey } from './policy/rules.js';
import { summarize, targetOf } from './policy/classify.js';
import { allowScope, routineOf } from './shape.js';
import { callKey } from './policy/gate.js';
import type { ApprovedCall } from './types.js';
import { tr } from '../i18n/index.js';
import { bootTime } from './server-lock.js';

export interface SchedulerDeps extends PipelineDeps {
  /** how many runs may be in flight at once, across all bots */
  concurrency(): number;
  /** settings: the day's spend cap over every bot */
  globalBudgetUsd(): number | undefined;
  /** the model a run of this bot asks for when the bot names none (its tier on a routing provider); undefined = the provider's */
  modelFor?(bot: Bot): string | undefined;
}
export type ResumeInfo = NonNullable<RunOptions['resume']>;
/**
 * resume: the conversation to go on with; `approved` is filled when the job starts and takes the conversation's
 * pending approvals from `<bot>/resumes.json` (a retry_up retry reuses them)
 */
interface Job { botId: string; routineId: string; trigger: RunTrigger; resume?: { sessionId: string; approved?: ApprovedCall[] }; retried?: boolean }
interface Slot { job: Job; ctl: AbortController; done: Promise<void> }
interface Lease { pid: number; host: string; at: number; instance?: string }

export const TICK_MS = 30_000;
/** a lease not refreshed for three ticks belongs to a server that is gone */
export const LEASE_STALE_MS = 3 * TICK_MS;
/** a lease on this host unrefreshed this long is free even if its pid runs (a reused pid, or a hung server) */
export const LEASE_DEAD_MS = 10 * LEASE_STALE_MS;
/** `<lock>.take` guards a takeover; one left behind by a crash mid-take is cleared after this */
export const TAKE_STALE_MS = 30_000;
const DAY = 24 * 3600_000;
const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const pidAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code !== 'ESRCH'; } // EPERM = alive, not ours
};
/** the schedulers of this process not stopped yet (two in one process share a pid: the lease's instance tells them apart) */
const liveInstances = new Set<string>();
/** a refresh of the lease that fails to write: held on through this many in a row, and at least LEASE_STALE_MS */
export const LEASE_WRITE_TRIES = 3;

/**
 * Runs the bots' routines (spec §3–§5): a 30 s tick puts due routines on a FIFO queue, which runs under a concurrency
 * cap with at most one run per bot (the gate's per-day counts rely on it). Budgets are checked before a run opens a
 * conversation. Inbox answers feed trust and resume the run that asked. stopAll is the hard stop.
 * Only the holder of `<botsRoot>/scheduler.lock` runs anything — the desktop app and the duty service may share a dir.
 * Events: 'run' (BotRun), 'bots' (something about a bot changed), 'load' (BotLoad), 'tick' (a tick ran on duty).
 */
export class BotScheduler extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private queue: Job[] = [];
  /** key = botId: one run per bot */
  private running = new Map<string, Slot>();
  /** runs to resume from their checkpoint on the next tick (onFail 'resume') */
  private nextTick: Job[] = [];
  private budgetTold = new Set<string>();
  private holding = false;
  /** when this scheduler last took the lease (a stop request written before it is not for it) */
  private heldSince = 0;
  /** bumped by stopAll: a tick or an answer that started before it queues nothing */
  private epoch = 0;
  /** which scheduler wrote the lease (two in one process share a pid) */
  private readonly instance = randomBytes(6).toString('hex');
  private readonly lockFile: string;
  /** failed lease writes in a row while holding, and when the first of them was */
  private writeFails = 0;
  private writeFailSince = 0;

  constructor(private d: SchedulerDeps) {
    super();
    liveInstances.add(this.instance);
    // the store's root: the dir of any bot id's parent (BotStore keeps its root private)
    this.lockFile = path.join(path.dirname(d.store.dir('scheduler')), 'scheduler.lock');
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.timedTick(), TICK_MS);
    this.timer.unref();
    void this.timedTick();
  }
  /** the timer's tick, kept so a shutdown can wait for it (it writes bot.json / the lease) */
  private inflight: Promise<void> = Promise.resolve();
  private timedTick() {
    const p = this.tick().catch((e) => console.warn('[bots] tick failed:', e));
    this.inflight = p;
    return p;
  }
  /** resolves once the timer's tick in flight (if any) is done */
  settled(): Promise<void> { return this.inflight; }
  stop() {
    liveInstances.delete(this.instance);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.queue = []; this.nextTick = [];
    if (this.holding) { this.holding = false; try { if (this.readLease()?.instance === this.instance) fs.rmSync(this.lockFile, { force: true }); } catch { /* gone */ } }
  }

  // ---------- lease ----------
  private readLease(): Lease | undefined {
    try { return JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) as Lease; } catch { return undefined; }
  }
  /** a run of this bot is in flight / waiting in the queue (BotStatus.state) */
  isRunning(botId: string): boolean { return this.running.has(botId); }
  isQueued(botId: string): boolean { return this.queue.some((j) => j.botId === botId); }
  /** whether this scheduler is the one on duty: the service checks it before marking an inbox answer done */
  canAct(): boolean { return this.holding; }
  /** when this scheduler took the lease; 0 = it doesn't hold it */
  holdingSince(): number { return this.holding ? this.heldSince : 0; }

  /**
   * Takes or refreshes the lease; true when this scheduler holds it. Exclusive: `<lock>.take` (created with 'wx')
   * guards check → write → re-read, so two servers finding a stale lease can't both take it. Taking it over first
   * re-reads the bots and the inbox from disk: the last holder changed them while this one only watched.
   */
  async claim(retry = true): Promise<boolean> {
    const take = `${this.lockFile}.take`;
    let fh: fsp.FileHandle;
    try { fh = await fsp.open(take, 'wx'); } catch (e: any) {
      if (e?.code === 'EEXIST') {
        let stale = false;
        try { stale = Date.now() - fs.statSync(take).mtimeMs > TAKE_STALE_MS; } catch { stale = retry; /* just removed: try again */ }
        if (stale && retry) { try { fs.rmSync(take, { force: true }); } catch { /* raced */ } return this.claim(false); }
      } else console.warn('[bots] cannot take the scheduler lease:', e);
      // someone else is taking it right now: keep holding only while the lease still names us
      return this.setHolding(this.holding && this.readLease()?.instance === this.instance);
    }
    try {
      const cur = this.readLease();
      const now = Date.now();
      const mine = cur?.instance === this.instance;
      // on this host the process tells: a live one keeps its lease while it may just be busy — but not a lease from
      // before this boot (its pid may now be any program) nor one unrefreshed for LEASE_DEAD_MS (a reused pid, or a
      // hung server); another host's lease is free once it went unrefreshed for three ticks
      const free = !cur || typeof cur.at !== 'number' || (cur.host === os.hostname()
        ? (cur.at < bootTime() || now - cur.at > LEASE_DEAD_MS || (cur.pid === process.pid ? !liveInstances.has(String(cur.instance)) : !pidAlive(cur.pid)))
        : now - cur.at > LEASE_STALE_MS);
      if (!mine && !free) return this.setHolding(false);
      try {
        await atomicWrite(this.lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), at: now, instance: this.instance }));
      } catch (e) {
        console.warn('[bots] cannot write the scheduler lease:', e);
        // a transient failure (a locked file, a full disk for a moment) while nobody else has the lease: keep holding,
        // try again next tick — given up only after LEASE_WRITE_TRIES in a row spanning more than LEASE_STALE_MS
        if (this.holding && (mine || !cur)) {
          if (!this.writeFails++) this.writeFailSince = now;
          if (this.writeFails < LEASE_WRITE_TRIES || now - this.writeFailSince <= LEASE_STALE_MS) return true;
        }
        return this.setHolding(false);
      }
      this.writeFails = 0;
      return this.setHolding(this.readLease()?.instance === this.instance);
    } finally {
      await fh.close().catch(() => {});
      try { fs.rmSync(take, { force: true }); } catch { /* gone */ }
    }
  }
  private async setHolding(v: boolean): Promise<boolean> {
    if (v && !this.holding) {
      await this.d.store.reload(); await this.d.inbox.reload(); this.heldSince = Date.now();
      this.holding = true;
      try { await this.recover(); } catch (e) { console.warn('[bots] recovering after taking the lease:', e); }
      this.emit('claimed');
      return true;
    }
    if (!v && this.holding) {
      this.queue = []; this.nextTick = [];
      // confirmed lost — the lease names another instance and is fresh (not just a refresh we failed to write): nothing
      // of ours may keep running beside the new holder's, so every run in flight is aborted (recorded as stopped)
      const cur = this.readLease();
      if (cur && cur.instance !== this.instance && typeof cur.at === 'number' && Date.now() - cur.at <= LEASE_STALE_MS) for (const s of this.running.values()) s.ctl.abort();
      this.emit('load', this.load());
    }
    this.holding = v;
    return v;
  }
  /**
   * Taking the lease: what the last holder left — its runs that never ended (it died) are closed as interrupted and,
   * for an onFail 'resume' routine, resumed next tick; approved steps waiting for their resume (resumes.json) are
   * queued again.
   */
  private async recover() {
    const now = Date.now();
    for (const bot of this.d.store.list()) {
      for (const p of this.d.store.pendingResumes(bot.id)) {
        if (!this.nextTick.some((j) => j.resume?.sessionId === p.sessionId)) this.nextTick.push({ botId: bot.id, routineId: p.routineId, trigger: 'resume', resume: { sessionId: p.sessionId } });
      }
      if (this.running.has(bot.id)) continue;
      for (const r of this.d.store.runs(bot.id, 2000)) {
        if (r.endedAt || r.skipped) continue;
        await this.d.store.addRun({ ...r, ok: false, error: tr('中断（服务重启）'), endedAt: now });
        const routine = bot.routines.find((x) => x.id === r.routineId);
        if (routine?.onFail === 'resume' && routine.enabled && !bot.paused && !this.nextTick.some((j) => j.botId === bot.id && j.routineId === routine.id)) {
          this.nextTick.push({ botId: bot.id, routineId: routine.id, trigger: 'resume', retried: true });
        }
      }
    }
  }
  /** the approved call joins its conversation's pending resume, once: false when it was already there (a duplicate) */
  private addResume(botId: string, routineId: string, sessionId: string, call: ApprovedCall): Promise<boolean> {
    const k = callKey(call.toolName, call.input);
    return this.d.store.updateResumes(botId, (cur) => {
      const i = cur.findIndex((p) => p.sessionId === sessionId);
      if (i < 0) return { next: [...cur, { sessionId, routineId, approved: [call], at: Date.now() }], out: true };
      if (cur[i].approved.some((a) => callKey(a.toolName, a.input) === k)) return { next: cur, out: false };
      const next = [...cur]; next[i] = { ...cur[i], approved: [...cur[i].approved, call] };
      return { next, out: true };
    });
  }
  private dropResumeCall(botId: string, sessionId: string, call: ApprovedCall) {
    const k = callKey(call.toolName, call.input);
    return this.d.store.updateResumes(botId, (cur) => ({
      next: cur.map((p) => (p.sessionId === sessionId ? { ...p, approved: p.approved.filter((a) => callKey(a.toolName, a.input) !== k) } : p)).filter((p) => p.approved.length),
      out: undefined,
    }));
  }
  /** the run that carries a conversation's approvals starts: they leave resumes.json */
  private takeResume(botId: string, sessionId: string): Promise<ApprovedCall[] | undefined> {
    return this.d.store.updateResumes(botId, (cur) => {
      const p = cur.find((x) => x.sessionId === sessionId);
      return { next: cur.filter((x) => x !== p), out: p?.approved };
    });
  }

  /** read-modify-write inside the store's bot.json lock, so a run's write-back in flight isn't lost */
  private async mutate(botId: string, fn: (b: Bot) => Bot | undefined): Promise<void> { await this.d.store.update(botId, fn); }
  private notHolder(): never { throw new Error(tr('另一个 claude-web 正在值班，请在那边操作')); }

  nextRunAt(r: Routine, from: number): number | undefined {
    try { if (r.cron) return nextCron(r.cron, new Date(from)).getTime(); } catch { return undefined; }
    if (r.everyMinutes) return from + Math.max(1, r.everyMinutes) * 60_000;
    return undefined;
  }

  /**
   * A run's cost is the conversation's ledger total so far (costOf), so a resumed run's number includes the runs
   * before it in that conversation: each run counts only what it added.
   */
  private costSince(botId: string, since: number) {
    const runs = [...this.d.store.runs(botId, 2000)].sort((a, b) => a.at - b.at);
    const seen = new Map<string, number>();
    let sum = 0;
    for (const r of runs) {
      const c = r.costUsd ?? 0;
      let add = c;
      if (r.sessionId) { const before = seen.get(r.sessionId) ?? 0; add = Math.max(0, c - before); seen.set(r.sessionId, Math.max(before, c)); }
      if (r.at >= since) sum += add;
    }
    return sum;
  }
  todayUsd(botId: string, now = Date.now()) { const d = new Date(now); d.setHours(0, 0, 0, 0); return this.costSince(botId, d.getTime()); }
  weekUsd(botId: string, now = Date.now()) { return this.costSince(botId, now - 7 * DAY); }

  load(): BotLoad {
    const bots = this.d.store.list();
    return {
      running: this.running.size, queued: this.queue.length,
      todayUsd: bots.reduce((a, b) => a + this.todayUsd(b.id), 0),
      weekEstimateUsd: bots.reduce((a, b) => a + this.weekUsd(b.id), 0),
      concurrency: this.d.concurrency(),
    };
  }

  private overBudget(bot: Bot, now: number): boolean {
    const b = bot.budget;
    if (b.dailyUsd !== undefined && this.todayUsd(bot.id, now) >= b.dailyUsd) return true;
    if (b.weeklyUsd !== undefined && this.weekUsd(bot.id, now) >= b.weeklyUsd) return true;
    const g = this.d.globalBudgetUsd();
    return g !== undefined && this.d.store.list().reduce((a, x) => a + this.todayUsd(x.id, now), 0) >= g;
  }

  async tick(now = Date.now()) {
    const epoch = this.epoch;
    if (!(await this.claim())) { this.emit('load', this.load()); return; }
    const resumes = this.nextTick; this.nextTick = [];
    for (const j of resumes) this.push(j);
    let changedAny = false;
    for (const { id } of this.d.store.list()) {
      // one bad bot.json (a hand edit, an old shape) costs that bot its tick, not the others theirs
      try { await this.mutate(id, (bot) => {
        let changed = false;
        const routines = bot.routines.map((r) => ({ ...r }));
        for (const r of routines) {
          if (!r.enabled || bot.paused) continue;
          if (r.nextRunAt === undefined) {
            const next = this.nextRunAt(r, now);
            if (next !== undefined) { r.nextRunAt = next; changed = true; }
            continue;
          }
          if (r.nextRunAt > now) continue;
          if (missedRun(r.nextRunAt, now) === 'drop') { r.nextRunAt = this.nextRunAt(r, now); changed = true; continue; }
          // queued, not advanced: its next time is set when it starts (exec), so a restart before then runs it still
          if (this.epoch === epoch && this.holding) this.push({ botId: bot.id, routineId: r.id, trigger: 'cron' });
        }
        if (changed) changedAny = true;
        return changed ? { ...bot, routines } : undefined;
      }); } catch (e) { console.warn(`[bots] tick skipped ${id}:`, e); }
    }
    this.emit('tick');
    if (changedAny) this.emit('bots');
    this.pump();
  }

  /** queues a run; a manual one throws when that routine is already running or queued, or another server is on duty */
  enqueue(botId: string, routineId: string, trigger: RunTrigger, resume?: { sessionId: string }) {
    if (!this.holding) { if (trigger === 'manual' || trigger === 'resume') this.notHolder(); return; }
    const busy = this.running.get(botId)?.job.routineId === routineId || this.queue.some((j) => j.botId === botId && j.routineId === routineId);
    if (busy && trigger === 'manual') throw new Error(tr('这条例行正在运行'));
    if (busy && trigger !== 'resume') return;
    // a resume waits behind the run that asked (one run per bot); a conversation already waiting to be resumed takes
    // this approval along (resumes.json), so it isn't queued twice
    if (resume && [...this.queue, ...this.nextTick].some((j) => j.resume?.sessionId === resume.sessionId && !j.resume.approved)) return;
    this.queue.push({ botId, routineId, trigger, resume });
    this.pump();
  }
  /** the UI's 「现在跑」 */
  async runNow(botId: string, routineId: string) {
    if (!(await this.claim())) this.notHolder();
    this.enqueue(botId, routineId, 'manual');
  }

  /** a due routine: skipped when already running / queued; a resume of a conversation already queued is one job */
  private push(j: Job) {
    if (j.resume && this.queue.some((q) => q.resume?.sessionId === j.resume!.sessionId && !q.resume.approved)) return;
    const busy = this.running.get(j.botId)?.job.routineId === j.routineId || this.queue.some((q) => q.botId === j.botId && q.routineId === j.routineId);
    if (!busy || j.trigger === 'resume') this.queue.push(j);
  }

  private pump() {
    if (!this.holding) return;
    for (let i = 0; i < this.queue.length && this.running.size < this.d.concurrency();) {
      const job = this.queue[i];
      if (this.running.has(job.botId)) { i++; continue; } // that bot's other routines wait their turn
      this.queue.splice(i, 1);
      const ctl = new AbortController();
      const slot: Slot = { job, ctl, done: Promise.resolve() };
      this.running.set(job.botId, slot);
      slot.done = this.exec(job, ctl.signal)
        .catch((e) => { console.warn(`[bots] run of ${job.botId}/${job.routineId} failed:`, e); return undefined; })
        .then((run) => {
          this.running.delete(job.botId);
          if (run) this.afterRun(job, run, ctl.signal.aborted);
          this.emit('load', this.load());
          this.pump();
        })
        .catch((e) => console.warn('[bots] after a run:', e));
    }
    this.emit('load', this.load());
  }

  private async exec(job: Job, signal: AbortSignal): Promise<BotRun | undefined> {
    let bot = this.d.store.get(job.botId);
    let routine = bot?.routines.find((r) => r.id === job.routineId);
    if (!bot || !routine) return undefined;
    const now = this.d.now?.() ?? Date.now();
    // a cron run's next time is set as it starts (or is skipped), not when it was queued
    if (job.trigger === 'cron') {
      await this.mutate(bot.id, (b) => {
        const i = b.routines.findIndex((r) => r.id === job.routineId);
        const r = b.routines[i];
        if (i < 0 || r.nextRunAt === undefined || r.nextRunAt > now) return undefined;
        const routines = [...b.routines]; routines[i] = { ...r, nextRunAt: this.nextRunAt(r, Math.max(now, r.nextRunAt)) };
        return { ...b, routines };
      });
      bot = this.d.store.get(job.botId) ?? bot;
      routine = bot.routines.find((r) => r.id === job.routineId) ?? routine;
    }
    // paused / turned off while it waited in the queue: an approved step waits on; anything else is skipped, not failed
    if (bot.paused || !routine.enabled) {
      if (job.resume) {
        if (!this.nextTick.some((j) => j.resume?.sessionId === job.resume!.sessionId)) this.nextTick.push(job);
        return undefined;
      }
      const run: BotRun = { id: `${routine.id}-${now.toString(36)}`, botId: bot.id, routineId: routine.id, at: now, trigger: job.trigger, skipped: true, ok: true, error: bot.paused ? tr('Bot 已暂停，这次没有运行') : tr('例行已关闭，这次没有运行') };
      await this.d.store.addRun(run);
      this.emit('run', run); this.emit('bots');
      return run;
    }
    if (this.overBudget(bot, now)) {
      if (job.resume) {
        // an approved step isn't thrown away: it waits for the budget (in resumes.json too), retried every tick; told once a day
        const resume = job.resume;
        if (!this.nextTick.some((j) => j.resume?.sessionId === resume.sessionId)) this.nextTick.push(job);
        const told = `${bot.id}|${dayKey(now)}|${resume.sessionId}`;
        const calls = resume.approved ?? this.d.store.pendingResumes(bot.id).find((p) => p.sessionId === resume.sessionId)?.approved ?? [];
        if (!this.budgetTold.has(told) && calls.length) {
          this.budgetTold.add(told);
          await this.d.inbox.add({ kind: 'finding', botId: bot.id, routineId: routine.id, sessionId: resume.sessionId, title: tr('「{name}」的预算用完了，已批准的「{summary}」等预算够了再做', { name: bot.name, summary: calls.map((c) => summarize(c.toolName, c.input)).join('」「') }) });
        }
        this.emit('bots');
        return undefined;
      }
      const run: BotRun = { id: `${routine.id}-${now.toString(36)}`, botId: bot.id, routineId: routine.id, at: now, trigger: job.trigger, skipped: true, ok: false, error: tr('超出预算') };
      await this.d.store.addRun(run);
      const told = `${bot.id}|${dayKey(now)}`;
      if (!this.budgetTold.has(told)) {
        this.budgetTold.add(told);
        await this.d.inbox.add({ kind: 'finding', botId: bot.id, routineId: routine.id, title: tr('「{name}」的预算用完了，今天不再运行', { name: bot.name }) });
      }
      this.emit('run', run); this.emit('bots');
      return run;
    }
    if (job.resume && !job.resume.approved) {
      // the approvals leave resumes.json as their run starts; none left = another job already took them
      const approved = await this.takeResume(bot.id, job.resume.sessionId);
      if (!approved?.length) return undefined;
      job.resume = { sessionId: job.resume.sessionId, approved };
    }
    const effective = bot.model ? bot : { ...bot, model: this.d.modelFor?.(bot) };
    const resume = job.resume?.approved ? { sessionId: job.resume.sessionId, approved: job.resume.approved } : undefined;
    const { run } = await runRoutine(this.d, effective, routine, job.trigger, { signal, ...(resume ? { resume } : {}) });
    this.emit('run', run); this.emit('bots');
    return run;
  }

  /** onFail: retry_up = one immediate retry (phase 1 has no tier routing: same settings); resume = from the checkpoint next tick */
  private afterRun(job: Job, run: BotRun, stopped: boolean) {
    if (!this.holding || stopped || run.ok !== false || run.skipped || job.retried) return;
    const routine = this.d.store.get(job.botId)?.routines.find((r) => r.id === job.routineId);
    if (!routine?.enabled) return; // turned off after too many failures
    if (routine.onFail === 'retry_up') this.queue.push({ botId: job.botId, routineId: job.routineId, trigger: job.trigger, ...(job.resume ? { resume: job.resume } : {}), retried: true });
    else if (routine.onFail === 'resume') this.nextTick.push({ botId: job.botId, routineId: job.routineId, trigger: 'resume', retried: true });
  }

  /**
   * The hard stop for one bot: drop its queued runs, abort its run (kills scripts, interrupts + closes the conversation),
   * and close its open approvals and approved steps waiting to resume — a later approve doesn't start a stopped bot again.
   */
  async stopBot(botId: string) {
    this.queue = this.queue.filter((j) => j.botId !== botId);
    this.nextTick = this.nextTick.filter((j) => j.botId !== botId);
    const s = this.running.get(botId);
    s?.ctl.abort();
    this.emit('load', this.load());
    await s?.done;
    await this.closeWaiting([botId]);
  }
  /**
   * The hard stop (spec §5): always works — empties the queue and aborts every run; nothing gets paused. `hard`
   * (the user's stop) also closes the open approvals and the steps waiting to resume; a server shutting down keeps them
   * for the next holder.
   */
  async stopAll(o: { hard?: boolean } = {}) {
    this.epoch++;
    this.queue = []; this.nextTick = [];
    const slots = [...this.running.values()];
    for (const s of slots) s.ctl.abort();
    this.emit('load', this.load());
    await Promise.all(slots.map((s) => s.done));
    if (o.hard) await this.closeWaiting(this.d.store.list().map((b) => b.id));
  }
  private async closeWaiting(botIds: string[]) {
    const ids = new Set(botIds);
    try {
      await this.d.inbox.closeApprovals((i) => ids.has(i.botId), tr('运行已停下，这一条不再执行'));
      for (const id of ids) if (this.d.store.get(id)) await this.d.store.updateResumes(id, () => ({ next: [], out: undefined }));
    } catch (e) { console.warn('[bots] closing what waited on a stopped bot:', e); }
    this.emit('bots');
  }

  /** an approval this answer would resume: its call (else undefined) */
  private approvedCall(item: InboxItem, a: InboxAnswer) {
    const { cls, toolName, input } = item;
    if ((a.answer === 'approve' || a.answer === 'approve_scope') && item.kind === 'approval' && cls && toolName && input && item.routineId && item.sessionId) return { toolName, input };
    return undefined;
  }
  /**
   * Before the item is marked done: the approved call goes into resumes.json, so a crash between the two never loses
   * an approval the inbox already shows as answered. `fresh` = it was not there yet (onInboxAnswer counts trust on it).
   */
  async persistApproval(item: InboxItem, a: InboxAnswer): Promise<{ fresh: boolean } | undefined> {
    const call = this.approvedCall(item, a);
    if (!call) return undefined;
    if (!(await this.claim())) this.notHolder();
    if (!this.d.store.get(item.botId)) return undefined;
    return { fresh: await this.addResume(item.botId, item.routineId!, item.sessionId!, call) };
  }
  /** takes back what persistApproval added (the answer did not land) */
  async unpersistApproval(item: InboxItem, a: InboxAnswer, pre: { fresh: boolean } | undefined) {
    const call = this.approvedCall(item, a);
    if (call && pre?.fresh) await this.dropResumeCall(item.botId, item.sessionId!, call).catch(() => {});
  }

  /** `pre`: persistApproval already put the call in resumes.json */
  async onInboxAnswer(item: InboxItem, a: InboxAnswer, pre?: { fresh: boolean }) {
    if (a.answer === 'archive') return;
    const epoch = this.epoch;
    // a non-holder writes nothing (its bots / inbox may be stale); claim() may reload them, so read the bot after
    if (!(await this.claim())) this.notHolder();
    const bot = this.d.store.get(item.botId);
    if (!bot) return;
    const { cls, toolName, input } = item;
    if ((a.answer === 'approve' || a.answer === 'approve_scope') && item.kind === 'approval' && cls && toolName && input && item.routineId && item.sessionId) {
      const target = targetOf(cls, toolName, input);
      const key = scopeKey(undefined, target);
      if (a.answer === 'approve_scope' && a.scope) {
        const scope = allowScope(a.scope, 'scope', cls);
        // idempotent: an answer retried after a failure doesn't add the rule twice
        const same = JSON.stringify({ cls, level: 'do', scope });
        await this.mutate(bot.id, (b) => (b.policy.rules.some((r) => JSON.stringify({ cls: r.cls, level: r.level, scope: r.scope }) === same) ? undefined : { ...b, policy: { ...b.policy, rules: [...b.policy.rules, { cls, level: 'do', scope }] } }));
      }
      let fresh = true;
      if (this.epoch === epoch) {
        // on disk before it is queued: a restart, a budget wait or a new holder of the lease doesn't lose it
        const call = { toolName, input };
        fresh = pre ? pre.fresh : await this.addResume(bot.id, item.routineId, item.sessionId, call);
        try { this.enqueue(bot.id, item.routineId, 'resume', { sessionId: item.sessionId }); } catch (e) {
          if (fresh && !pre) await this.dropResumeCall(bot.id, item.sessionId, call).catch(() => {});
          throw e;
        }
      } else if (pre) fresh = pre.fresh;
      // trust counts an approval only once its effect (the resume) is under way: a retried answer isn't counted twice;
      // a failure to record it costs one count, never the approval
      // a second item for a call already approved and waiting (a duplicate) earns no second count
      if (a.answer === 'approve' && fresh) {
        try {
          const r = recordApproval(this.d.store.trust(bot.id), cls, key, Date.now(), target.amount);
          await this.d.store.setTrust(bot.id, r.trust);
          if (r.propose && r.scope) {
            await this.d.inbox.add({ kind: 'proposal', botId: bot.id, routineId: item.routineId, title: tr('「{cls}」到「{key}」已连续批准 {n} 次，以后直接做？', { cls, key, n: TRUST_THRESHOLD }), proposal: { type: 'trust_up', cls, scope: r.scope } });
          }
        } catch (e) { console.warn(`[bots] cannot record the approval of ${item.id}:`, e); }
      }
    } else if (a.answer === 'reject' && cls && toolName && input) {
      const key = scopeKey(undefined, targetOf(cls, toolName, input));
      await this.d.store.setTrust(bot.id, recordCorrection(this.d.store.trust(bot.id), cls, key));
      // a queued approval was let through by no rule: the class stays at ask. Something that ran is demoted at the
      // exact rule that let it through (from the audit).
      if (item.kind !== 'approval' && item.runId) {
        const row = this.d.store.audit(bot.id, item.runId).find((r) => r.result === 'allowed' && r.cls === cls && r.toolName === toolName && r.scope === key && r.rule);
        const rule = row?.rule;
        if (rule) await this.mutate(bot.id, (b) => ({ ...b, policy: demoteRule(b.policy, rule) }));
      }
    } else if (a.answer === 'adopt' && item.proposal) {
      const p = item.proposal;
      // a proposal is a bot's own writing: checked like a window's edit before it lands
      const scope = p.type === 'trust_up' ? allowScope(p.scope, 'scope', p.cls) : undefined;
      const routine = p.type === 'routine' ? { ...routineOf(p.routine, new Map()), selfMade: true } : undefined;
      await this.mutate(bot.id, (b) => {
        if (scope && p.type === 'trust_up') return { ...b, policy: { ...b.policy, rules: [...b.policy.rules, { cls: p.cls, level: 'do', scope }] } };
        if (!routine || b.manager || b.routines.length >= (b.maxRoutines ?? 20) || b.routines.some((r) => r.id === routine.id)) return undefined;
        return { ...b, routines: [...b.routines, routine] };
      });
    } else if (a.answer === 'send' && item.kind === 'draft') {
      await this.d.inbox.add({ kind: 'finding', botId: bot.id, runId: item.runId, title: tr('已标记为可发送：{title}', { title: item.title }), ...(item.body ? { body: item.body } : {}) });
    }
    this.emit('bots');
  }
}
