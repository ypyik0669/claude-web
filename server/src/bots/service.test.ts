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
    r.send = () => setTimeout(() => r.emit('message', { type: 'result', is_error: false, result: 'ok' }), 0);
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
});
