import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BotStore } from './store.js'; import { AuditLog } from './audit.js'; import { Inbox } from './inbox.js';
import { BotScheduler, LEASE_DEAD_MS, LEASE_STALE_MS, type SchedulerDeps } from './scheduler.js';
import type { Bot, Routine } from '../protocol.js';

function fakeRunner(delayMs = 0, calls: { toolName: string; input: Record<string, unknown> }[] = [], isError = false) {
  const r: any = new EventEmitter(); r.sessionId = `s_${Math.random().toString(36).slice(2, 8)}`; r.state = 'idle'; r.sent = [];
  r.info = { agent: 'claude' }; r.gated = true;
  r.send = (t: string) => { r.sent.push(t); r.timer = setTimeout(async () => { for (const c of calls) await r.gate?.({ requestId: 'q', sessionId: r.sessionId, toolName: c.toolName, input: c.input }); r.emit('message', { type: 'result', is_error: isError, result: 'ok' }); }, delayMs); };
  r.interrupt = vi.fn(async () => {}); r.close = async () => { clearTimeout(r.timer); };
  return r;
}
const routine = (p: Partial<Routine> = {}): Routine => ({ id: 'r1', name: '晨报', prompt: 'x', enabled: true, everyMinutes: 60, acceptance: { kind: 'none' }, onFail: 'inbox', ...p });
const bot = (id: string, routines: Routine[], p: Partial<Bot> = {}): Bot => ({ id, name: id, charter: { role: 'r', sources: [] }, cwd: process.cwd(), tier: 'balanced', policy: { rules: [] }, budget: {}, routines, outputs: [], createdAt: 0, updatedAt: 0, ...p });

describe('BotScheduler', { timeout: 30_000 }, () => {
  let root: string; let store: BotStore; let inbox: Inbox; let audit: AuditLog; let runners: any[]; let conc: number;
  const deps = (mk: () => any = () => fakeRunner()): SchedulerDeps => ({ store, audit, inbox, open: () => { const r = mk(); runners.push(r); return r; }, memories: () => [], costOf: async () => ({ usd: 1 }), defaultProvider: () => undefined, concurrency: () => conc, globalBudgetUsd: () => undefined });
  const live: BotScheduler[] = [];
  const sched = (d: SchedulerDeps) => { const s = new BotScheduler(d); live.push(s); return s; };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-sched-')); store = new BotStore(root); inbox = new Inbox(store); audit = new AuditLog(store); runners = []; conc = 2; });
  afterEach(async () => { for (const s of live.splice(0)) { await s.stopAll(); s.stop(); } await settle(); fs.rmSync(root, { recursive: true, force: true }); });
  const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  /** polls until `ok()` (file I/O on Windows is slow; fixed sleeps flake) */
  const until = async (ok: () => boolean, ms = 15_000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error('timed out waiting'); await settle(10); } };
  const idle = (s: BotScheduler) => until(() => { const l = s.load(); return l.running === 0 && l.queued === 0; });

  it('a due routine runs once per tick and gets a next time; a paused bot does not', async () => {
    await store.save(bot('a', [routine({ nextRunAt: 10 })]));
    await store.save(bot('b', [routine({ nextRunAt: 10 })], { paused: true }));
    const s = sched(deps());
    await s.tick(20); await until(() => runners.length === 1); await idle(s);
    expect(store.get('a')!.routines[0].nextRunAt).toBeGreaterThan(20);
    await s.tick(21); await idle(s);
    expect(runners).toHaveLength(1);
  });

  it('the queue honours the concurrency cap and the load bar counts it', async () => {
    conc = 1;
    await store.save(bot('a', [routine({ id: 'r1', nextRunAt: 1 })]));
    await store.save(bot('b', [routine({ id: 'r1', nextRunAt: 1 })]));
    const s = sched(deps(() => fakeRunner(50)));
    await s.tick(5);
    expect(s.load()).toMatchObject({ running: 1, queued: 1, concurrency: 1 });
    await idle(s);
    expect(runners).toHaveLength(2);
    expect(s.load()).toMatchObject({ running: 0, queued: 0 });
  });

  it('one run per bot at a time: its other due routine waits in the queue, then runs', async () => {
    conc = 3;
    await store.save(bot('a', [routine({ id: 'r1', nextRunAt: 1 }), routine({ id: 'r2', nextRunAt: 1 })]));
    const s = sched(deps(() => fakeRunner(50)));
    await s.tick(5);
    expect(s.load()).toMatchObject({ running: 1, queued: 1 });
    await idle(s);
    expect(store.runs('a').map((r) => r.routineId).sort()).toEqual(['r1', 'r2']);
  });

  it('a bot over its daily budget opens no conversation, records a skipped run and is told once a day', async () => {
    const due = Date.now() - 1000; // on time: a week-old nextRunAt would be dropped as missed
    await store.save(bot('a', [routine({ id: 'r1', nextRunAt: due }), routine({ id: 'r2', nextRunAt: due })], { budget: { dailyUsd: 0.5 } }));
    await store.addRun({ id: 'old', botId: 'a', routineId: 'r1', at: Date.now() - 1000, trigger: 'cron', costUsd: 0.6, ok: true });
    const s = sched(deps());
    await s.tick(Date.now()); await idle(s); await s.tick(Date.now() + 1); await idle(s);
    expect(runners).toHaveLength(0);
    const skipped = store.runs('a').filter((r) => r.error === '超出预算');
    expect(skipped.length).toBe(2);
    expect(skipped.every((r) => r.skipped && !r.costUsd)).toBe(true);
    expect(inbox.list('a').filter((i) => i.title.includes('预算'))).toHaveLength(1);
  });

  it('the global budget stops every bot', async () => {
    await store.save(bot('a', [routine({ nextRunAt: Date.now() - 1000 })]));
    await store.save(bot('b', [routine({ nextRunAt: Date.now() - 1000 })]));
    await store.addRun({ id: 'old', botId: 'b', routineId: 'r1', at: Date.now() - 1000, trigger: 'cron', costUsd: 2, ok: true });
    const s = sched({ ...deps(), globalBudgetUsd: () => 1.5 });
    await s.tick(Date.now()); await until(() => store.runs('a').length > 0); await idle(s);
    expect(runners).toHaveLength(0);
    expect(store.runs('a')[0]).toMatchObject({ skipped: true, error: '超出预算' });
  });

  it("a resumed run's cost (the conversation's total so far) is counted only for what it added", async () => {
    await store.save(bot('a', [routine()]));
    const now = Date.now();
    await store.addRun({ id: 'x1', botId: 'a', routineId: 'r1', at: now - 3000, trigger: 'cron', sessionId: 'S', costUsd: 1 });
    await store.addRun({ id: 'x2', botId: 'a', routineId: 'r1', at: now - 2000, trigger: 'resume', sessionId: 'S', costUsd: 1.5 });
    await store.addRun({ id: 'x3', botId: 'a', routineId: 'r1', at: now - 1000, trigger: 'cron', sessionId: 'T', costUsd: 0.25 });
    const s = sched(deps());
    expect(s.todayUsd('a', now)).toBeCloseTo(1.75);
  });

  it('a routine with no schedule is not written back every tick', async () => {
    await store.save(bot('a', [routine({ everyMinutes: undefined })]));
    const at = store.get('a')!.updatedAt;
    const s = sched(deps());
    await settle(5); await s.tick(5); await s.tick(6);
    expect(store.get('a')!.updatedAt).toBe(at);
  });

  it('an approved step over budget waits for the budget (named in the inbox), then runs', async () => {
    await store.save(bot('a', [routine()], { budget: { dailyUsd: 0.5 } }));
    await store.addRun({ id: 'old', botId: 'a', routineId: 'r1', at: Date.now() - 1000, trigger: 'cron', costUsd: 0.6, ok: true });
    const s = sched(deps());
    const ap = await inbox.add({ kind: 'approval', botId: 'a', routineId: 'r1', sessionId: 'sX', title: 't', toolName: 'Bash', input: { command: 'git push' }, cls: 'send' });
    await s.onInboxAnswer(ap, { id: ap.id, answer: 'approve' });
    await until(() => inbox.list('a').some((i) => i.title.includes('git push'))); await idle(s);
    expect(runners).toHaveLength(0);
    await s.tick(Date.now()); await idle(s);
    expect(runners).toHaveLength(0);
    expect(inbox.list('a').filter((i) => i.title.includes('预算'))).toHaveLength(1);
    await store.update('a', (b) => ({ ...b, budget: { dailyUsd: 10 } }));
    await s.tick(Date.now()); await until(() => runners.length === 1); await idle(s);
    expect(runners[0].sent[0]).toContain('已经批准');
  });

  it('stopAll during an answer: the approved resume is not queued', async () => {
    await store.save(bot('a', [routine()]));
    const s = sched(deps());
    await s.claim();
    const ap = await inbox.add({ kind: 'approval', botId: 'a', routineId: 'r1', sessionId: 'sX', title: 't', toolName: 'Bash', input: { command: 'git push' }, cls: 'send' });
    const p = s.onInboxAnswer(ap, { id: ap.id, answer: 'approve' });
    await s.stopAll(); await p; await settle();
    expect(runners).toHaveLength(0);
    expect(s.load().queued).toBe(0);
  });

  it('stopAll({ hard }) stops running runs (interrupted, recorded as stopped, no retry) and empties the queue', async () => {
    conc = 1;
    await store.save(bot('a', [routine({ id: 'r1', nextRunAt: 1, onFail: 'retry_up' })]));
    await store.save(bot('b', [routine({ id: 'r1', nextRunAt: 1 })]));
    const s = sched(deps(() => fakeRunner(10_000)));
    await s.tick(5); await until(() => runners[0]?.sent.length === 1);
    expect(s.load()).toMatchObject({ running: 1, queued: 1 });
    await s.stopAll({ hard: true });
    expect(runners[0].interrupt).toHaveBeenCalled();
    expect(s.load()).toMatchObject({ running: 0, queued: 0 });
    await settle();
    expect(runners).toHaveLength(1);
    expect(store.runs('a')[0]).toMatchObject({ ok: false, error: '被停下了' });
  });

  it('retry_up retries a failed run once right away; resume picks it up from the checkpoint next tick', async () => {
    await store.save(bot('a', [routine({ nextRunAt: 1, onFail: 'retry_up' })]));
    await store.save(bot('b', [routine({ nextRunAt: 1, onFail: 'resume' })]));
    const s = sched(deps(() => fakeRunner(0, [], true)));
    await s.tick(5); await idle(s);
    const by = (id: string) => store.runs(id).map((r) => r.trigger);
    expect(by('a')).toEqual(['cron', 'cron']);
    expect(by('b')).toEqual(['cron']);
    await s.tick(6); await idle(s);
    expect(by('b').sort()).toEqual(['cron', 'resume']);
    expect(by('a')).toHaveLength(2);
  });

  it('approve resumes the run with that call allowed; the third approval proposes an upgrade; reject keeps the class at ask', async () => {
    await store.save(bot('a', [routine({ nextRunAt: 1 })], { policy: { rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1'] } }] } }));
    const push = { toolName: 'ExecuteExtraTool', input: { tool_name: 'mcp__slack__send_message', params: { channel: 'C9', text: 'hi' } } };
    // every run asks twice: after an approval the resumed run gets the first call through (approveOnce) and queues the second again
    const s = sched(deps(() => fakeRunner(0, [push, push])));
    const item = () => inbox.list('a').find((i) => i.kind === 'approval' && !i.done)!;
    await s.tick(5); await until(() => !!item()); await idle(s);
    for (let i = 0; i < 3; i++) { const it = item(); await inbox.answer({ id: it.id, answer: 'approve' }); await s.onInboxAnswer(it, { id: it.id, answer: 'approve' }); await until(() => !!item()); await idle(s); }
    expect(runners.length).toBeGreaterThanOrEqual(4);
    expect(runners[1].sent[0]).toContain('已经批准');
    expect(inbox.list('a').find((i) => i.kind === 'proposal')?.proposal).toEqual({ type: 'trust_up', cls: 'send', scope: { channels: ['C9'] } });
    const it = item(); await inbox.answer({ id: it.id, answer: 'reject' }); await s.onInboxAnswer(it, { id: it.id, answer: 'reject' });
    expect(store.trust('a')['send|channel:C9']).toBeUndefined();
    expect(store.get('a')!.policy.rules).toEqual([{ cls: 'send', level: 'do', scope: { channels: ['C1'] } }]);
  });

  it('rejecting something a rule let through demotes exactly that rule', async () => {
    const rule = { cls: 'send' as const, level: 'do' as const, scope: { channels: ['C1'] } };
    await store.save(bot('a', [routine()], { policy: { rules: [rule, { cls: 'send', level: 'do', scope: { channels: ['C2'] } }] } }));
    const input = { tool_name: 'mcp__slack__send_message', params: { channel: 'C1', text: 'hi' } };
    await audit.add({ runId: 'run1', botId: 'a', toolName: 'ExecuteExtraTool', cls: 'send', level: 'do', basis: 'rule', summary: 's', result: 'allowed', scope: 'channel:C1', rule });
    const s = sched(deps());
    const f = await inbox.add({ kind: 'finding', botId: 'a', runId: 'run1', title: '做了', toolName: 'ExecuteExtraTool', input, cls: 'send' });
    await s.onInboxAnswer(f, { id: f.id, answer: 'reject' });
    expect(store.get('a')!.policy.rules).toEqual([{ cls: 'send', level: 'do', scope: { channels: ['C2'] } }]);
  });

  it('an opaque target never earns trust', async () => {
    await store.save(bot('a', [routine()]));
    const s = sched(deps());
    for (let i = 0; i < 3; i++) {
      const ap = await inbox.add({ kind: 'approval', botId: 'a', routineId: 'r1', sessionId: 'sX', title: 't', toolName: 'Bash', input: { command: 'curl -d @- "$URL"' }, cls: 'send' });
      await s.onInboxAnswer(ap, { id: ap.id, answer: 'approve' });
    }
    expect(store.trust('a')).toEqual({});
    expect(inbox.list('a').some((i) => i.kind === 'proposal')).toBe(false);
  });

  it('approve_scope adds a scoped do-rule, adopt a routine proposal adds a self-made routine', async () => {
    await store.save(bot('a', [routine()]));
    const s = sched(deps());
    const ap = await inbox.add({ kind: 'approval', botId: 'a', routineId: 'r1', sessionId: 'sX', title: 't', toolName: 'Bash', input: { command: 'git push' }, cls: 'send' });
    await s.onInboxAnswer(ap, { id: ap.id, answer: 'approve_scope', scope: { domains: ['github.com'] } });
    expect(store.get('a')!.policy.rules).toEqual([{ cls: 'send', level: 'do', scope: { domains: ['github.com'] } }]);
    const pr = await inbox.add({ kind: 'proposal', botId: 'a', title: 'p', proposal: { type: 'routine', routine: routine({ id: 'r9', name: '周报' }) } });
    await s.onInboxAnswer(pr, { id: pr.id, answer: 'adopt' });
    expect(store.get('a')!.routines.map((r) => [r.id, r.selfMade])).toEqual([['r1', undefined], ['r9', true]]);
  });

  describe('restarts and waits lose nothing', () => {
    const gitPush = { toolName: 'Bash', input: { command: 'git push' } };
    const overBudget = async () => {
      await store.save(bot('a', [routine()], { budget: { dailyUsd: 0.5 } }));
      await store.addRun({ id: 'old', botId: 'a', routineId: 'r1', at: Date.now() - 1000, trigger: 'cron', costUsd: 0.6, ok: true, endedAt: Date.now() - 500 });
    };
    it('an approval blocked by the budget survives a new scheduler (resumes.json), then runs once the budget allows', async () => {
      await overBudget();
      const s1 = sched(deps());
      const ap = await inbox.add({ kind: 'approval', botId: 'a', routineId: 'r1', sessionId: 'sX', title: 't', ...gitPush, cls: 'send' });
      await s1.onInboxAnswer(ap, { id: ap.id, answer: 'approve' });
      await until(() => inbox.list('a').some((i) => i.title.includes('预算'))); await idle(s1);
      expect(runners).toHaveLength(0);
      s1.stop(); // the server goes away
      await store.update('a', (b) => ({ ...b, budget: { dailyUsd: 10 } }));
      const s2 = sched(deps());
      await s2.tick(Date.now()); // takes the lease: the pending resume is queued for the next tick
      await s2.tick(Date.now()); await until(() => runners.length === 1); await idle(s2);
      expect(runners[0].sent[0]).toContain('已经批准');
      expect(store.pendingResumes('a')).toEqual([]);
    });

    it('a second approval for the same conversation rides along with the first: one resumed run, both calls let through', async () => {
      await overBudget();
      const mail = { toolName: 'ExecuteExtraTool', input: { tool_name: 'mcp__slack__send_message', params: { channel: 'C9', text: 'hi' } } };
      const s = sched(deps(() => fakeRunner(0, [gitPush, mail])));
      const a1 = await inbox.add({ kind: 'approval', botId: 'a', routineId: 'r1', sessionId: 'sX', title: 't1', ...gitPush, cls: 'send' });
      const a2 = await inbox.add({ kind: 'approval', botId: 'a', routineId: 'r1', sessionId: 'sX', title: 't2', ...mail, cls: 'send' });
      await inbox.answer({ id: a1.id, answer: 'approve' }); await s.onInboxAnswer(a1, { id: a1.id, answer: 'approve' });
      await inbox.answer({ id: a2.id, answer: 'approve' }); await s.onInboxAnswer(a2, { id: a2.id, answer: 'approve' });
      await idle(s);
      expect(store.pendingResumes('a')[0].approved).toHaveLength(2);
      await store.update('a', (b) => ({ ...b, budget: { dailyUsd: 10 } }));
      await s.tick(Date.now()); await until(() => runners.length === 1); await idle(s);
      expect(runners).toHaveLength(1);
      // both calls went through on the resumed run: nothing new asked
      expect(inbox.list('a').filter((i) => i.kind === 'approval' && !i.done)).toHaveLength(0);
    });

    it('taking the lease closes the runs a dead holder left open; an onFail resume routine is picked up again', async () => {
      await store.save(bot('a', [routine({ id: 'r1', onFail: 'resume' })]));
      await store.save(bot('b', [routine({ id: 'r1', onFail: 'inbox' })]));
      await store.addRun({ id: 'r1-x', botId: 'a', routineId: 'r1', at: Date.now() - 5000, trigger: 'cron' });
      await store.addRun({ id: 'r1-y', botId: 'b', routineId: 'r1', at: Date.now() - 5000, trigger: 'cron' });
      const s = sched(deps());
      await s.tick(Date.now()); await idle(s);
      expect(store.runs('a').find((r) => r.id === 'r1-x')).toMatchObject({ ok: false, error: '中断（服务重启）' });
      expect(store.runs('b').find((r) => r.id === 'r1-y')).toMatchObject({ ok: false, error: '中断（服务重启）' });
      await s.tick(Date.now()); await until(() => runners.length === 1); await idle(s);
      expect(store.runs('a').map((r) => r.trigger)).toContain('resume');
      expect(store.runs('b')).toHaveLength(1);
    });

    it('a server quitting mid-run (the duty server yielding to the app) hands the run over: the next holder closes it, resumes an onFail resume routine and runs a cut-short cron occurrence once', async () => {
      const due = Date.now() - 1000;
      await store.save(bot('a', [routine({ id: 'r1', onFail: 'resume', nextRunAt: due })]));
      await store.save(bot('b', [routine({ id: 'r1', onFail: 'inbox', nextRunAt: due })]));
      const s1 = sched(deps(() => fakeRunner(10_000)));
      await s1.tick(Date.now()); await until(() => runners.length === 2);
      await s1.stopAll(); s1.stop(); // shutdown, not the user's stop
      for (const id of ['a', 'b']) expect(store.runs(id)[0]).toMatchObject({ ok: false, handoff: true, error: '中断（让给另一个 claude-web）' });
      expect(store.runs('a')[0].endedAt).toBeUndefined();
      const s2 = sched(deps());
      await s2.tick(Date.now()); await idle(s2); // takes the lease: closes them
      for (const id of ['a', 'b']) expect(store.runs(id).find((r) => r.trigger === 'cron')!.endedAt).toBeGreaterThan(0);
      await s2.tick(Date.now()); await until(() => runners.length === 4); await idle(s2);
      expect(store.runs('a').map((r) => r.trigger)).toContain('resume');
      expect(store.runs('b').filter((r) => r.trigger === 'cron' && r.ok)).toHaveLength(1);
      await s2.tick(Date.now()); await idle(s2);
      expect(runners).toHaveLength(4); // once
    });

    it('a hard stop (the user) hands nothing over', async () => {
      await store.save(bot('b', [routine({ id: 'r1', nextRunAt: Date.now() - 1000 })]));
      const s1 = sched(deps(() => fakeRunner(10_000)));
      await s1.tick(Date.now()); await until(() => runners.length === 1);
      await s1.stopAll({ hard: true }); s1.stop();
      expect(store.runs('b')[0]).toMatchObject({ ok: false, error: '被停下了' });
      expect(store.runs('b')[0].handoff).toBeUndefined();
      const s2 = sched(deps());
      await s2.tick(Date.now()); await idle(s2); await s2.tick(Date.now()); await idle(s2);
      expect(runners).toHaveLength(1);
    });

    it('a queued cron run keeps its due time until it starts: a restart before then still runs it', async () => {
      conc = 1;
      const due = Date.now() - 1000;
      await store.save(bot('a', [routine({ id: 'r1', nextRunAt: due })]));
      await store.save(bot('b', [routine({ id: 'r1', nextRunAt: due })]));
      const s1 = sched(deps(() => fakeRunner(10_000)));
      await s1.tick(Date.now()); await until(() => runners.length === 1);
      expect(s1.load()).toMatchObject({ running: 1, queued: 1 });
      const waiting = s1.isQueued('a') ? 'a' : 'b';
      expect(store.get(waiting)!.routines[0].nextRunAt).toBe(due); // queued, not advanced
      await s1.stopAll(); s1.stop(); // the server goes away before it started
      const s2 = sched(deps());
      await s2.tick(Date.now()); await until(() => store.runs(waiting).some((r) => r.endedAt)); await idle(s2);
      expect(store.get(waiting)!.routines[0].nextRunAt).toBeGreaterThan(Date.now());
    });

    it('a bot paused (or a routine turned off) while its run waited in the queue: skipped, not failed', async () => {
      conc = 1;
      await store.save(bot('x', [routine({ id: 'r1', nextRunAt: 1 })]));
      await store.save(bot('a', [routine({ id: 'r1', nextRunAt: 1 })]));
      await store.save(bot('b', [routine({ id: 'r1', nextRunAt: 1 })]));
      const s = sched(deps(() => fakeRunner(200)));
      await s.tick(5);
      expect(s.load()).toMatchObject({ running: 1, queued: 2 });
      const [p, o] = ['x', 'a', 'b'].filter((id) => s.isQueued(id));
      await store.update(p, (b) => ({ ...b, paused: true }));
      await store.update(o, (b) => ({ ...b, routines: b.routines.map((r) => ({ ...r, enabled: false })) }));
      await idle(s);
      expect(runners).toHaveLength(1);
      expect(store.runs(p)[0]).toMatchObject({ skipped: true, ok: true, error: 'Bot 已暂停，这次没有运行' });
      expect(store.runs(o)[0]).toMatchObject({ skipped: true, ok: true, error: '例行已关闭，这次没有运行' });
      expect(store.get(o)!.routines[0].failures ?? 0).toBe(0);
    });

    it('the hard stop of a bot closes its open approvals and its approved steps waiting to resume', async () => {
      await overBudget();
      const s = sched(deps());
      const a1 = await inbox.add({ kind: 'approval', botId: 'a', routineId: 'r1', sessionId: 'sX', title: 't1', ...gitPush, cls: 'send' });
      const open = await inbox.add({ kind: 'approval', botId: 'a', routineId: 'r1', sessionId: 'sX', title: 't2', toolName: 'Bash', input: { command: 'npm publish' }, cls: 'send' });
      await s.onInboxAnswer(a1, { id: a1.id, answer: 'approve' }); await idle(s);
      expect(store.pendingResumes('a')).toHaveLength(1);
      await s.stopBot('a');
      expect(store.pendingResumes('a')).toEqual([]);
      expect(inbox.list('a', true).find((i) => i.id === open.id)?.done).toMatchObject({ answer: 'archive', note: expect.any(String) });
      await store.update('a', (b) => ({ ...b, budget: { dailyUsd: 10 } }));
      await s.tick(Date.now()); await s.tick(Date.now()); await idle(s);
      expect(runners).toHaveLength(0);
    });
  });

  describe('lease: one scheduler per data dir', () => {
    const lockFile = () => path.join(root, 'scheduler.lock');
    const staleLease = (instance: string) => fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() - LEASE_STALE_MS - 1000, instance }));

    it("taking the lease over reloads the bots from disk first: the last holder's changes stay, no catch-up storm", async () => {
      const now = Date.now();
      await store.save(bot('a', [routine({ nextRunAt: now - 1000 })]));
      const storeB = new BotStore(root); const inboxB = new Inbox(storeB); // B: loaded at startup, then only watched
      const sA = sched(deps());
      await sA.tick(now); await until(() => runners.length === 1); await idle(sA);
      await store.update('a', (b) => ({ ...b, policy: { rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1'] } }] } }));
      const nextA = store.get('a')!.routines[0].nextRunAt!;
      expect(nextA).toBeGreaterThan(now);
      expect(storeB.get('a')!.routines[0].nextRunAt).toBe(now - 1000); // B's copy is stale
      sA.stop(); staleLease('A'); // A is gone; its lease went stale
      const sB = sched({ ...deps(), store: storeB, inbox: inboxB });
      await sB.tick(now + 5000); await idle(sB);
      expect(runners).toHaveLength(1); // nothing caught up
      const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'a', 'bot.json'), 'utf8'));
      expect(onDisk.routines[0].nextRunAt).toBe(nextA);
      expect(onDisk.policy.rules).toEqual([{ cls: 'send', level: 'do', scope: { channels: ['C1'] } }]);
      expect(inboxB.list('a').length).toBe(inbox.list('a').length);
    });

    it('a non-holder writes nothing for an inbox answer', async () => {
      await store.save(bot('a', [routine()], { policy: { rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1'] } }] } }));
      const s1 = sched(deps()); const s2 = sched(deps());
      expect(await s1.claim()).toBe(true);
      expect(s2.canAct()).toBe(false);
      const pr = await inbox.add({ kind: 'proposal', botId: 'a', title: 'p', proposal: { type: 'trust_up', cls: 'send', scope: { channels: ['C9'] } } });
      const before = fs.readFileSync(path.join(root, 'a', 'bot.json'), 'utf8');
      await expect(s2.onInboxAnswer(pr, { id: pr.id, answer: 'adopt' })).rejects.toThrow('另一个 claude-web 正在值班');
      expect(fs.readFileSync(path.join(root, 'a', 'bot.json'), 'utf8')).toBe(before);
      expect(s1.canAct()).toBe(true);
    });

    it('two schedulers taking over a stale lease at once: exactly one holds; a .take left by a crash is cleared', async () => {
      staleLease('gone');
      const a = sched(deps()); const b = sched(deps());
      const got = await Promise.all([a.claim(), b.claim()]);
      expect(got.filter(Boolean)).toHaveLength(1);
      expect(fs.existsSync(`${lockFile()}.take`)).toBe(false);
      staleLease('gone2');
      fs.writeFileSync(`${lockFile()}.take`, '');
      const old = (Date.now() - 60_000) / 1000; fs.utimesSync(`${lockFile()}.take`, old, old);
      const c = sched(deps());
      expect(await c.claim()).toBe(true);
    });

    it('two schedulers on one dir: only the lease holder runs routines; manual runs on the other are refused', async () => {
      await store.save(bot('a', [routine({ nextRunAt: 1 })]));
      const s1 = sched(deps()); const s2 = sched(deps());
      await s1.tick(5);
      await store.save({ ...store.get('a')!, routines: [routine({ nextRunAt: 1 })] });
      await s2.tick(6); await settle();
      expect(runners).toHaveLength(1);
      expect(store.get('a')!.routines[0].nextRunAt).toBe(1); // the non-holder touches nothing
      await expect(s2.runNow('a', 'r1')).rejects.toThrow('另一个 claude-web 正在值班');
      expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ pid: process.pid, host: os.hostname() });
    });

    it('losing the lease aborts the runs in flight (recorded as stopped, no retry) and empties the queue', async () => {
      conc = 1;
      await store.save(bot('a', [routine({ id: 'r1', nextRunAt: 1, onFail: 'retry_up' })]));
      await store.save(bot('b', [routine({ id: 'r1', nextRunAt: 1 })]));
      const s = sched(deps(() => fakeRunner(10_000)));
      await s.tick(5); await until(() => runners[0]?.sent.length === 1);
      expect(s.load()).toMatchObject({ running: 1, queued: 1 });
      // another server took the lease (this one stalled past LEASE_STALE_MS, say): a live process (the parent stands in)
      fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, host: os.hostname(), at: Date.now(), instance: 'other' }));
      expect(await s.claim()).toBe(false);
      await idle(s);
      expect(runners[0].interrupt).toHaveBeenCalled();
      await settle();
      expect(runners).toHaveLength(1);
      expect(store.runs('a')[0]).toMatchObject({ ok: false, error: '被停下了' });
      expect(store.runs('b')).toEqual([]);
    });

    it('a refresh that fails to write (lease not taken by anyone) keeps holding and does not abort the runs in flight; given up only after several failures spanning the stale time', async () => {
      await store.save(bot('a', [routine({ id: 'r1', nextRunAt: 1 })]));
      const s = sched(deps(() => fakeRunner(10_000)));
      await s.tick(5); await until(() => runners[0]?.sent.length === 1);
      // the lock path can't be written (a directory now): the lease names nobody else
      fs.rmSync(lockFile(), { force: true }); fs.mkdirSync(lockFile());
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(await s.claim()).toBe(true);
        expect(await s.claim()).toBe(true);
        expect(await s.claim()).toBe(true); // three in a row, but not yet LEASE_STALE_MS apart
        expect(s.canAct()).toBe(true);
        (s as any).writeFailSince = Date.now() - LEASE_STALE_MS - 1;
        expect(await s.claim()).toBe(false);
        await settle();
        expect(runners[0].interrupt).not.toHaveBeenCalled();
        expect(s.isRunning('a')).toBe(true);
      } finally { warn.mockRestore(); fs.rmSync(lockFile(), { recursive: true, force: true }); }
    });

    it('a stale lease (not refreshed for 3 ticks) or one of a dead process is taken over', async () => {
      await store.save(bot('a', [routine({ nextRunAt: 1 })]));
      fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() - LEASE_STALE_MS - 1000, instance: 'other' }));
      const s = sched(deps());
      await s.tick(5); await until(() => runners.length === 1); await idle(s); // polled: a fixed sleep flaked under a loaded CPU
      expect(runners).toHaveLength(1);
      s.stop();
      expect(fs.existsSync(lockFile())).toBe(false); // released on stop

      fs.writeFileSync(lockFile(), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), at: Date.now(), instance: 'dead' }));
      const s3 = sched(deps());
      expect(await s3.claim()).toBe(true);
      const fresh = sched(deps());
      expect(await fresh.claim()).toBe(false);
    });

    it('on this host a live process keeps its lease while it may be busy; a lease of another host is free once stale', async () => {
      fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, host: os.hostname(), at: Date.now() - 5 * LEASE_STALE_MS, instance: 'busy' }));
      const s = sched(deps());
      expect(await s.claim()).toBe(false);
      fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, host: 'other-host', at: Date.now() - LEASE_STALE_MS / 2, instance: 'far' }));
      expect(await s.claim()).toBe(false);
      fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, host: 'other-host', at: Date.now() - LEASE_STALE_MS - 1000, instance: 'far' }));
      expect(await s.claim()).toBe(true);
    });

    it('pid reuse: a lease of this host from before the boot, or unrefreshed for LEASE_DEAD_MS, is free though its pid runs', async () => {
      const s = sched(deps());
      const boot = Date.now() - os.uptime() * 1000;
      fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, host: os.hostname(), at: boot - 60_000, instance: 'before-boot' }));
      expect(await s.claim()).toBe(true);
      s.stop();
      const s2 = sched(deps());
      fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.ppid, host: os.hostname(), at: Date.now() - LEASE_DEAD_MS - 1000, instance: 'hung' }));
      expect(await s2.claim()).toBe(true);
    });
  });
});
