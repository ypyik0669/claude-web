import { describe, it, expect, beforeEach, afterEach, vi, onTestFinished } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BotService, tierModel, clientSessionParams, type BotServiceDeps } from './service.js';
import type { BotDraft, InboxItem } from '../protocol.js';

function fakePool() {
  const p: any = new EventEmitter(); p.runners = new Map();
  p.open = (params: any) => {
    const r: any = new EventEmitter(); r.sessionId = params.sessionId ?? `s_${p.runners.size}`; r.state = 'idle'; r.params = params;
    r.info = { agent: 'claude' }; r.gated = !!params.gated;
    r.send = () => { if (!p.hang) setTimeout(() => r.emit('message', { type: 'result', is_error: false, result: 'ok' }), 0); };
    r.interrupt = vi.fn(async () => {}); r.close = async () => {};
    p.runners.set(r.sessionId, r); return r;
  };
  p.get = (id: string) => p.runners.get(id);
  return p;
}
const fakeMeta = (settings: Record<string, unknown> = {}) => ({ settings: () => settings });
const draft = (p: Partial<BotDraft['bot']> = {}): BotDraft['bot'] => ({ name: 'x', charter: { role: 'r', sources: [] }, cwd: process.cwd(), tier: 'cheap', policy: { rules: [] }, budget: {}, routines: [], outputs: [{ kind: 'inbox' }], ...p });
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 15_000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error('timed out waiting'); await settle(10); } };

describe('BotService', { timeout: 30_000 }, () => {
  let root: string; let svc: BotService; let pool: any; let im: any; const extra: BotService[] = [];
  const make = (p: Partial<BotServiceDeps> = {}) => new BotService({ dataDir: root, pool, memory: { search: () => [] } as any, ledger: { rowsFor: async () => [{ costUsd: 0.5 }] } as any, meta: fakeMeta({ 'bots.concurrency': 2 }) as any, im, ...p });
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-botsvc-')); pool = fakePool();
    im = { sendTo: vi.fn(async () => {}), handlers: new Map(), onCallback: (p: string, h: any) => im.handlers.set(p, h) };
    svc = make({ providerKind: () => 'routing' });
    await svc.start();
  });
  afterEach(async () => {
    for (const s of [svc, ...extra.splice(0)]) { await s.stopAll().catch(() => {}); s.stop(); }
    await settle();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('start creates the manager; it cannot be deleted', async () => {
    expect(svc.list().map((b) => b.id)).toEqual(['manager']);
    expect(svc.get('manager').manager).toBe(true);
    await expect(svc.remove('manager')).rejects.toThrow();
    expect(svc.list().map((b) => b.id)).toEqual(['manager']);
  });

  it('create / update / pause / unleash return statuses with state and cost', async () => {
    const b = await svc.create(draft());
    expect(b.state).toBe('idle'); expect(b.todayUsd).toBe(0);
    expect((await svc.pause(b.id, true)).state).toBe('paused');
    expect((await svc.unleash(b.id, true)).policy.unleashed).toBe(true);
    expect((await svc.update(b.id, { name: 'y' })).name).toBe('y');
  });

  it('a draft without a valid tier gets bots.defaultTier (else balanced); a valid one is kept', async () => {
    const settings: Record<string, unknown> = { 'bots.concurrency': 2, 'bots.defaultTier': 'best' };
    (svc as any).d.meta = fakeMeta(settings);
    expect((await svc.create(draft({ tier: undefined as any }))).tier).toBe('best');
    expect((await svc.create(draft({ tier: 'nope' as any }))).tier).toBe('best');
    expect((await svc.create(draft({ tier: 'cheap' }))).tier).toBe('cheap');
    settings['bots.defaultTier'] = 'bogus';
    expect((await svc.create(draft({ tier: undefined as any }))).tier).toBe('balanced');
  });

  it('edits go through the store lock: two concurrent updates both land', async () => {
    const b = await svc.create(draft());
    await Promise.all([svc.update(b.id, { name: 'n2' }), svc.pause(b.id, true), svc.unleash(b.id, true)]);
    const now = svc.get(b.id);
    expect(now).toMatchObject({ name: 'n2', paused: true });
    expect(now.policy.unleashed).toBe(true);
    const disk = JSON.parse(fs.readFileSync(path.join(root, b.id, 'bot.json'), 'utf8'));
    expect(disk).toMatchObject({ name: 'n2', paused: true, policy: { unleashed: true } });
  });

  it('update cannot change the id or turn a bot into the manager', async () => {
    const b = await svc.create(draft());
    const u = await svc.update(b.id, { id: 'other', manager: true } as any);
    expect(u.id).toBe(b.id); expect(u.manager).toBeFalsy();
  });

  it('delete removes the bot and its inbox items', async () => {
    const b = await svc.create(draft());
    await (svc as any).inbox.add({ kind: 'finding', botId: b.id, title: 't' });
    await svc.remove(b.id);
    expect(svc.list().map((x) => x.id)).toEqual(['manager']);
    expect(svc.inboxList(undefined, true)).toEqual([]);
    expect(fs.existsSync(path.join(root, b.id))).toBe(false);
  });

  it('runNow runs gated through the pool with the tier model and records cost from the ledger', async () => {
    const b = await svc.create(draft({ tier: 'best', routines: [{ id: 'r1', name: 'n', prompt: 'p', enabled: true, everyMinutes: 60, acceptance: { kind: 'none' }, onFail: 'inbox' }] }));
    const runs: any[] = []; svc.on('run', (r) => runs.push(r));
    await svc.runNow(b.id, 'r1');
    await until(() => runs.some((r) => r.endedAt));
    const params = [...pool.runners.values()][0].params;
    expect(params.model).toBe(tierModel('best'));
    expect(params.gated).toBe(true);
    expect(runs.at(-1)).toMatchObject({ ok: true, costUsd: 0.5 });
    expect(svc.get(b.id).todayUsd).toBe(0.5);
  });

  it('a provider without routing gets no tier model (the provider picks)', async () => {
    const s2root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-botsvc2-'));
    const s2 = new BotService({ dataDir: s2root, pool, memory: { search: () => [] } as any, ledger: { rowsFor: async () => [] } as any, meta: fakeMeta() as any, providerKind: () => 'other' });
    try {
      await s2.start();
      const b = await s2.create(draft({ tier: 'cheap', routines: [{ id: 'r1', name: 'n', prompt: 'p', enabled: true, acceptance: { kind: 'none' }, onFail: 'inbox' }] }));
      const runs: any[] = []; s2.on('run', (r) => runs.push(r));
      await s2.runNow(b.id, 'r1');
      await until(() => runs.some((r) => r.endedAt));
      expect([...pool.runners.values()].at(-1).params.model).toBeUndefined();
    } finally { await s2.stopAll(); s2.stop(); await settle(); fs.rmSync(s2root, { recursive: true, force: true }); }
  });

  it('stop / stopAll go to the scheduler', async () => {
    const sch = (svc as any).scheduler;
    const stopBot = vi.spyOn(sch, 'stopBot'); const stopAll = vi.spyOn(sch, 'stopAll');
    await svc.stopBot('manager'); await svc.stopAll();
    expect(stopBot).toHaveBeenCalledWith('manager'); expect(stopAll).toHaveBeenCalled();
  });

  it('answering an inbox item marks it done, feeds the scheduler and pushes the item', async () => {
    const b = await svc.create(draft());
    const item = await (svc as any).inbox.add({ kind: 'finding', botId: b.id, title: 't' });
    const sch = (svc as any).scheduler; const fed = vi.spyOn(sch, 'onInboxAnswer');
    const pushed: InboxItem[] = []; svc.on('inbox', (i) => pushed.push(i));
    const done = await svc.inboxAnswer({ id: item.id, answer: 'archive' });
    expect(done.done?.answer).toBe('archive');
    expect(fed).toHaveBeenCalledWith(expect.objectContaining({ id: item.id }), { id: item.id, answer: 'archive' });
    expect(pushed.at(-1)).toMatchObject({ id: item.id, done: { answer: 'archive' } });
  });

  it('a server not on duty answers nothing and leaves inbox.json and bot.json alone', async () => {
    const b = await svc.create(draft());
    const item = await (svc as any).inbox.add({ kind: 'approval', botId: b.id, title: 't' });
    const other = make(); extra.push(other);
    await other.start();
    const inboxBefore = fs.readFileSync(path.join(root, 'inbox.json'), 'utf8');
    const botBefore = fs.readFileSync(path.join(root, b.id, 'bot.json'), 'utf8');
    for (const answer of ['approve', 'reject', 'archive', 'send', 'adopt', 'approve_scope'] as const) {
      await expect(other.inboxAnswer({ id: item.id, answer })).rejects.toThrow(/另一个 claude-web/);
    }
    await expect(other.update(b.id, { name: 'z' })).rejects.toThrow(/另一个 claude-web/);
    await expect(other.pause(b.id, true)).rejects.toThrow(/另一个 claude-web/);
    await expect(other.remove(b.id)).rejects.toThrow(/另一个 claude-web/);
    await expect(other.create(draft())).rejects.toThrow(/另一个 claude-web/);
    expect(fs.readFileSync(path.join(root, 'inbox.json'), 'utf8')).toBe(inboxBefore);
    expect(fs.readFileSync(path.join(root, b.id, 'bot.json'), 'utf8')).toBe(botBefore);
  });

  it('an IM output gets new inbox items pushed with approve / reject buttons, and the callback answers', async () => {
    const b = await svc.create(draft({ routines: [{ id: 'r1', name: 'n', prompt: 'p', enabled: true, acceptance: { kind: 'none' }, onFail: 'inbox' }], outputs: [{ kind: 'im', gatewayId: 'tg', chatId: 'c1' }] }));
    const item = await (svc as any).inbox.add({ kind: 'approval', botId: b.id, routineId: 'r1', sessionId: 's', title: 'git push', toolName: 'Bash', input: { command: 'git push' }, cls: 'send' });
    await settle(0);
    expect(im.sendTo).toHaveBeenCalledWith('tg', 'c1', expect.stringContaining('git push'), [expect.objectContaining({ id: `bots:approve:${item.id}` }), expect.objectContaining({ id: `bots:reject:${item.id}`, danger: true })]);
    // another chat cannot answer it
    expect(await im.handlers.get('bots')(['reject', item.id], { gatewayId: 'tg', chatId: 'other' })).not.toContain('拒');
    expect(svc.inboxList(b.id, true)[0].done).toBeUndefined();
    expect(await im.handlers.get('bots')(['reject', item.id], { gatewayId: 'tg', chatId: 'c1' })).toContain('拒');
    expect(svc.inboxList(b.id, true)[0].done?.answer).toBe('reject');
  });

  it('quiet hours hold IM pushes, then send one summary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 0, 1, 12, 0));
    onTestFinished(() => { vi.useRealTimers(); });
    const b = await svc.create(draft({ outputs: [{ kind: 'im', gatewayId: 'tg', chatId: 'c1' }], quiet: { from: '00:00', to: '23:59' } }));
    await (svc as any).inbox.add({ kind: 'finding', botId: b.id, title: 'late' });
    await (svc as any).inbox.add({ kind: 'finding', botId: b.id, title: 'later' });
    await settle(0);
    expect(im.sendTo).not.toHaveBeenCalled();
    await svc.update(b.id, { quiet: undefined });
    await (svc as any).flushQuiet();
    expect(im.sendTo).toHaveBeenCalledTimes(1);
    expect(im.sendTo.mock.calls[0][2]).toContain('2');
    expect(im.sendTo.mock.calls[0][2]).toContain('later');
  });

  it('client session params lose the server-only gated flag', () => {
    const p = clientSessionParams({ cwd: '/p', gated: true } as any);
    expect('gated' in p).toBe(false);
    const q = { cwd: '/p' } as any;
    expect(clientSessionParams(q)).toBe(q);
  });
  const rt = (id: string, p: Record<string, unknown> = {}) => ({ id, name: id, prompt: 'p', enabled: true, everyMinutes: 60, acceptance: { kind: 'none' }, onFail: 'inbox', ...p }) as any;

  it('only a real bot shape is accepted: arrays must be arrays, a bad cron or path is refused, nothing is written', async () => {
    const b = await svc.create(draft({ routines: [rt('r1')] }));
    const before = fs.readFileSync(path.join(root, b.id, 'bot.json'), 'utf8');
    await expect(svc.update(b.id, { routines: null } as any)).rejects.toThrow(/routines/);
    await expect(svc.update(b.id, { routines: [rt('r1', { cron: 'not a cron' })] })).rejects.toThrow(/cron/);
    await expect(svc.update(b.id, { routines: [rt('r1', { everyMinutes: 0.5 })] })).rejects.toThrow(/everyMinutes/);
    await expect(svc.update(b.id, { outputs: [{ kind: 'file', path: 'rel/x.md' }] })).rejects.toThrow(/outputs/);
    await expect(svc.update(b.id, { outputs: [{ kind: 'mail' }] } as any)).rejects.toThrow(/outputs/);
    await expect(svc.update(b.id, { cwd: 'relative' })).rejects.toThrow(/cwd/);
    await expect(svc.update(b.id, { tier: 'huge' } as any)).rejects.toThrow(/tier/);
    await expect(svc.update(b.id, { budget: { dailyUsd: -1 } })).rejects.toThrow(/budget/);
    await expect(svc.update(b.id, { charter: { role: 'r', sources: 'x' } } as any)).rejects.toThrow(/sources/);
    await expect(svc.update(b.id, { policy: { rules: {} } } as any)).rejects.toThrow(/rules/);
    await expect(svc.create({ ...draft(), routines: null } as any)).rejects.toThrow(/routines/);
    expect(fs.readFileSync(path.join(root, b.id, 'bot.json'), 'utf8')).toBe(before);
  });

  it('status fields and server-owned keys are not stored; policy.unleashed only moves through unleash', async () => {
    const b = await svc.create({ ...draft({ policy: { rules: [], unleashed: true } }), state: 'running', todayUsd: 9, trust: { x: 1 } } as any);
    expect(b.policy.unleashed).toBeFalsy();
    await svc.update(b.id, { ...svc.get(b.id), name: 'n2', policy: { rules: [], unleashed: true } } as any);
    const disk = JSON.parse(fs.readFileSync(path.join(root, b.id, 'bot.json'), 'utf8'));
    expect(disk.name).toBe('n2');
    for (const k of ['state', 'todayUsd', 'weekUsd', 'pendingInbox', 'trust']) expect(disk).not.toHaveProperty(k);
    expect(disk.policy.unleashed).toBeUndefined();
    await svc.unleash(b.id, true);
    await svc.update(b.id, { policy: { rules: [] } });
    expect(svc.get(b.id).policy.unleashed).toBe(true);
  });

  it('a routine id that is not a plain name gets one from the server', async () => {
    const b = await svc.create(draft({ routines: [rt('../x'), rt('')] }));
    for (const r of b.routines) expect(r.id).toMatch(/^[\w-]+$/);
    expect(new Set(b.routines.map((r) => r.id)).size).toBe(2);
  });

  it('the manager gets no routines', async () => {
    await expect(svc.update('manager', { routines: [rt('r1')] })).rejects.toThrow(/routines/);
  });

  it('edits merge around what the scheduler owns: a routine the pipeline turned off stays off, run times stay', async () => {
    const b = await svc.create(draft({ charter: { role: 'role', audience: 'a', sources: ['s'] }, routines: [rt('r1'), rt('r2')] }));
    const seen = svc.get(b.id).routines; // what a window has before the pipeline writes
    await (svc as any).store.update(b.id, (x: any) => ({ ...x, routines: x.routines.map((r: any) => (r.id === 'r1' ? { ...r, enabled: false, failures: 3, lastRunAt: 7, nextRunAt: 99 } : r)) }));
    await svc.update(b.id, { routines: seen.map((r) => (r.id === 'r2' ? { ...r, name: 'R2' } : r)) });
    let now = svc.get(b.id);
    expect(now.routines[0]).toMatchObject({ id: 'r1', enabled: false, failures: 3, lastRunAt: 7, nextRunAt: 99 });
    expect(now.routines[1].name).toBe('R2');
    // a window that saw it turned off turns it on again: failures reset
    await svc.update(b.id, { routines: now.routines.map((r) => (r.id === 'r1' ? { ...r, enabled: true } : r)) });
    now = svc.get(b.id);
    expect(now.routines[0]).toMatchObject({ enabled: true, failures: 0, lastRunAt: 7 });
    // charter merges field by field
    await svc.update(b.id, { charter: { audience: 'b' } } as any);
    expect(svc.get(b.id).charter).toMatchObject({ role: 'role', audience: 'b', sources: ['s'] });
  });

  it('a stop asked for in a server not on duty stops the run on the one on duty', async () => {
    pool.hang = true;
    const b = await svc.create(draft({ routines: [rt('r1')] }));
    const runs: any[] = []; svc.on('run', (r) => runs.push(r));
    await svc.runNow(b.id, 'r1');
    await until(() => (svc as any).scheduler.isRunning(b.id) && pool.runners.size > 0);
    const other = make(); extra.push(other);
    await other.start();
    const res = await other.stopAll();
    expect(res).toMatchObject({ requested: true });
    await until(() => runs.some((r) => r.endedAt && r.error));
    expect(svc.load().running).toBe(0);
    await until(() => !fs.existsSync(path.join(root, 'stop.request.json')));
  });

  it('deleting a bot tells the windows its inbox items are gone', async () => {
    const b = await svc.create(draft());
    const item = await (svc as any).inbox.add({ kind: 'finding', botId: b.id, title: 't' });
    const pushed: any[] = []; svc.on('inbox', (i) => pushed.push(i));
    await svc.remove(b.id);
    expect(pushed).toEqual([expect.objectContaining({ id: item.id, done: expect.objectContaining({ answer: 'archive' }) })]);
  });

  it('an answer whose effect fails is taken back: the approval stays pending', async () => {
    const b = await svc.create(draft());
    const item = await (svc as any).inbox.add({ kind: 'finding', botId: b.id, title: 't' });
    vi.spyOn((svc as any).scheduler, 'onInboxAnswer').mockRejectedValueOnce(new Error('boom'));
    await expect(svc.inboxAnswer({ id: item.id, answer: 'approve' })).rejects.toThrow('boom');
    expect(svc.inboxList(b.id)[0].done).toBeUndefined();
  });

  it('held IM pushes survive a restart (held.json)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 0, 1, 12, 0));
    onTestFinished(() => { vi.useRealTimers(); });
    const b = await svc.create(draft({ outputs: [{ kind: 'im', gatewayId: 'tg', chatId: 'c1' }], quiet: { from: '00:00', to: '23:59' } }));
    await (svc as any).inbox.add({ kind: 'finding', botId: b.id, title: 'late' });
    await until(() => fs.existsSync(path.join(root, 'held.json')));
    expect(JSON.parse(fs.readFileSync(path.join(root, 'held.json'), 'utf8'))[b.id]).toHaveLength(1);
  });

  it('runs() clamps the limit', () => {
    expect(() => svc.runs(undefined, undefined, -5)).not.toThrow();
    expect(() => svc.runs(undefined, undefined, 1e9)).not.toThrow();
  });
  it('a stale copy (failures 0) of a routine stopped for failures cannot revive it', async () => {
    const b = await svc.create(draft({ routines: [rt('r1'), rt('r2')] }));
    const stale = svc.get(b.id).routines.map((r) => ({ ...r, failures: 0 }));
    await (svc as any).store.update(b.id, (x: any) => ({ ...x, routines: x.routines.map((r: any) => (r.id === 'r1' ? { ...r, enabled: false, failures: 3 } : r)) }));
    await svc.update(b.id, { routines: stale.map((r) => (r.id === 'r2' ? { ...r, name: 'R2' } : r)) });
    expect(svc.get(b.id).routines[0]).toMatchObject({ enabled: false, failures: 3 });
    expect(svc.get(b.id).routines[1].name).toBe('R2');
  });

  it('selfMade is not the client\'s, and an omitted onFail keeps the stored one', async () => {
    const b = await svc.create(draft({ routines: [rt('r1', { onFail: 'retry_up', selfMade: true })] }));
    expect(b.routines[0].selfMade).toBeUndefined();
    const { onFail: _o, ...r } = svc.get(b.id).routines[0];
    await svc.update(b.id, { routines: [r as any] });
    expect(svc.get(b.id).routines[0].onFail).toBe('retry_up');
  });

  it('scopes are checked all the way down', async () => {
    const b = await svc.create(draft());
    for (const scope of [{ domains: 'x.com' }, { domains: [''] }, { channels: [1] }, { maxAmount: -1 }, { perDay: Infinity }, { until: 'soon' }, { unlimited: 'yes' }, { other: 1 }]) {
      await expect(svc.update(b.id, { policy: { rules: [{ cls: 'send', level: 'do', scope }] } } as any)).rejects.toThrow(/scope/);
      await expect(svc.update(b.id, { policy: { rules: [], autoPilot: { on: true, scope } } } as any)).rejects.toThrow(/scope/);
    }
    const u = await svc.update(b.id, { policy: { rules: [{ cls: 'browser', level: 'do', scope: { domains: ['X.com'], perDay: 3 } }] } });
    expect(u.policy.rules[0].scope).toEqual({ domains: ['x.com'], perDay: 3 });
  });

  it('approve_scope with a bad scope is refused and the item stays pending', async () => {
    const b = await svc.create(draft({ routines: [rt('r1')] }));
    const item = await (svc as any).inbox.add({ kind: 'approval', botId: b.id, routineId: 'r1', sessionId: 's', title: 't', toolName: 'Bash', input: { command: 'git push' }, cls: 'send' });
    await expect(svc.inboxAnswer({ id: item.id, answer: 'approve_scope', scope: { domains: 'x' } as any })).rejects.toThrow(/scope/);
    expect(svc.inboxList(b.id)[0].done).toBeUndefined();
    expect(svc.get(b.id).policy.rules).toEqual([]);
  });

  it('a scope that lets more run must name where it applies; a payment one up to how much; deny rules take any scope', async () => {
    const b = await svc.create(draft({ routines: [rt('r1')] }));
    for (const scope of [{ perDay: 5 }, {}, { maxAmount: 10 }, { until: Date.now() + 1000 }, { domains: [], channels: [] }, { unlimited: false, perDay: 1 }]) {
      for (const level of ['do', 'do_tell', 'ask'] as const)
        await expect(svc.update(b.id, { policy: { rules: [{ cls: 'send', level, scope }] } } as any), JSON.stringify(scope)).rejects.toThrow(/where it applies|写明用在哪里/);
      await expect(svc.update(b.id, { policy: { rules: [], autoPilot: { on: true, scope } } } as any)).rejects.toThrow(/where it applies|写明用在哪里/);
    }
    await expect(svc.update(b.id, { policy: { rules: [{ cls: 'pay', level: 'do', scope: { domains: ['api.stripe.com'] } }] } })).rejects.toThrow(/maximum amount|上限金额/);
    expect((await svc.update(b.id, { policy: { rules: [{ cls: 'pay', level: 'do', scope: { domains: ['api.stripe.com'], maxAmount: 50 } }] } })).policy.rules).toHaveLength(1);
    expect((await svc.update(b.id, { policy: { rules: [{ cls: 'send', level: 'deny', scope: { perDay: 5 } }] } })).policy.rules[0].scope).toEqual({ perDay: 5 });
    expect((await svc.update(b.id, { policy: { rules: [{ cls: 'pay', level: 'do', scope: { unlimited: true } }] } })).policy.rules[0].scope).toEqual({ unlimited: true });
    expect((await svc.update(b.id, { policy: { rules: [], autoPilot: { on: true, scope: { channels: ['C1'], perDay: 2 } } } })).policy.autoPilot?.scope).toEqual({ channels: ['C1'], perDay: 2 });

    // approve_scope: refused, the item stays pending, no rule lands
    const send = await (svc as any).inbox.add({ kind: 'approval', botId: b.id, routineId: 'r1', sessionId: 's', title: 't', toolName: 'Bash', input: { command: 'git push' }, cls: 'send' });
    await expect(svc.inboxAnswer({ id: send.id, answer: 'approve_scope', scope: { perDay: 5 } })).rejects.toThrow(/where it applies|写明用在哪里/);
    const pay = await (svc as any).inbox.add({ kind: 'approval', botId: b.id, routineId: 'r1', sessionId: 's', title: 't', toolName: 'Bash', input: { command: 'curl https://api.stripe.com/v1/charges -d amount=5' }, cls: 'pay' });
    await expect(svc.inboxAnswer({ id: pay.id, answer: 'approve_scope', scope: { domains: ['api.stripe.com'] } })).rejects.toThrow(/maximum amount|上限金额/);
    expect(svc.inboxList(b.id).filter((i) => i.kind === 'approval' && !i.done)).toHaveLength(2);
    expect(svc.get(b.id).policy.rules.some((r) => r.level === 'do' && r.cls === 'send')).toBe(false);
    // and the scheduler refuses it on its own too (an answer that reached it some other way)
    await expect((svc as any).scheduler.onInboxAnswer(send, { id: send.id, answer: 'approve_scope', scope: { perDay: 5 } })).rejects.toThrow(/where it applies|写明用在哪里/);
  });

  it('an adopted routine proposal is checked like an edit', async () => {
    const b = await svc.create(draft());
    const bad = await (svc as any).inbox.add({ kind: 'proposal', botId: b.id, title: 'p', proposal: { type: 'routine', routine: rt('r9', { cron: 'nope' }) } });
    await expect(svc.inboxAnswer({ id: bad.id, answer: 'adopt' })).rejects.toThrow(/cron/);
    expect(svc.inboxList(b.id).some((i) => i.id === bad.id)).toBe(true);
    const ok = await (svc as any).inbox.add({ kind: 'proposal', botId: b.id, title: 'p', proposal: { type: 'routine', routine: rt('r9', { failures: 7, lastRunAt: 5 }) } });
    await svc.inboxAnswer({ id: ok.id, answer: 'adopt' });
    expect(svc.get(b.id).routines[0]).toMatchObject({ id: 'r9', selfMade: true });
    expect(svc.get(b.id).routines[0].failures).toBeUndefined();
  });

  it('an approval retried after its effect failed counts for trust once', async () => {
    const b = await svc.create(draft({ routines: [rt('r1')] }));
    const item = await (svc as any).inbox.add({ kind: 'approval', botId: b.id, routineId: 'r1', sessionId: 's', title: 't', toolName: 'ExecuteExtraTool', input: { tool_name: 'mcp__slack__send_message', params: { channel: 'C9', text: 'hi' } }, cls: 'send' });
    const sch = (svc as any).scheduler;
    vi.spyOn(sch, 'enqueue').mockImplementationOnce(() => { throw new Error('boom'); }).mockImplementation(() => {});
    await expect(svc.inboxAnswer({ id: item.id, answer: 'approve' })).rejects.toThrow('boom');
    expect(Object.keys((svc as any).store.trust(b.id))).toHaveLength(0);
    await svc.inboxAnswer({ id: item.id, answer: 'approve' });
    const t = Object.values((svc as any).store.trust(b.id)) as any[];
    expect(t).toHaveLength(1); expect(t[0].approvals).toBe(1);
  });

  it('a stop request older than the holder\'s lease is ignored and removed', async () => {
    pool.hang = true;
    const b = await svc.create(draft({ routines: [rt('r1')] }));
    await svc.runNow(b.id, 'r1');
    await until(() => (svc as any).scheduler.isRunning(b.id));
    const file = path.join(root, 'stop.request.json');
    fs.writeFileSync(file, JSON.stringify({ botIds: '*', at: Date.now() - 10 * 60_000, by: 1 }));
    await (svc as any).takeStopRequest();
    expect(fs.existsSync(file)).toBe(false);
    expect((svc as any).scheduler.isRunning(b.id)).toBe(true);
  });
});
