import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BotStore } from './store.js'; import { AuditLog } from './audit.js'; import { Inbox } from './inbox.js';
import { BotThreads, KICKOFF_TAG, kickoffText, threadPrompt, avatarFor } from './thread.js';
import { BOT_TEMPLATES } from './templates.js';
import type { Bot } from '../protocol.js';

/** a pool whose runners keep what was sent and the gate they had at each send */
function fakePool() {
  const p: any = { runners: new Map(), opened: [] as any[] };
  p.open = (params: any) => {
    const cur = params.sessionId ? p.runners.get(params.sessionId) : undefined;
    if (cur && cur.state !== 'closed') return cur;
    const r: any = new EventEmitter();
    r.sessionId = params.sessionId ?? `s_${p.opened.length}`; r.state = 'idle'; r.params = params; r.sent = [] as string[]; r.gatesAtSend = [] as unknown[];
    r.info = { agent: 'claude' }; r.gated = !!params.gated; r.botRole = params.gated ? params.botRole : undefined;
    r.send = (text: string) => { r.sent.push(text); r.gatesAtSend.push(r.gate); };
    r.close = async () => { r.state = 'closed'; };
    p.opened.push(params); p.runners.set(r.sessionId, r);
    return r;
  };
  p.get = (id: string) => p.runners.get(id);
  return p;
}

const bot = (p: Partial<Bot> = {}): Bot => ({ id: 'b1', name: '晨报', charter: { role: '每天一页纸', sources: [] }, cwd: process.cwd(), tier: 'balanced', policy: { rules: [] }, budget: {}, routines: [], outputs: [{ kind: 'inbox' }], createdAt: 0, updatedAt: 0, ...p });
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 5_000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error('timed out waiting'); await settle(10); } };

describe('BotThreads', () => {
  let root: string; let store: BotStore; let inbox: Inbox; let audit: AuditLog; let pool: any; let threads: BotThreads;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-thread-'));
    store = new BotStore(root); inbox = new Inbox(store); audit = new AuditLog(store); pool = fakePool();
    threads = new BotThreads({ store, inbox, audit, pool, defaultProvider: () => 'relay-1', modelFor: () => 'smart-auto' });
  });
  afterEach(async () => { await settle(50); fs.rmSync(root, { recursive: true, force: true }); });

  it('start opens a gated thread and sends exactly one hidden kickoff, with the gate set before it', async () => {
    const b = bot(); await store.save(b);
    const sid = await threads.start(b);
    expect(pool.opened[0]).toMatchObject({ cwd: b.cwd, permissionMode: 'default', providerId: 'relay-1', model: 'smart-auto', gated: true, botId: 'b1', botRole: 'thread' });
    expect(pool.opened[0].sessionId).toBeUndefined();
    expect(pool.opened[0].drivenBy).toBeUndefined();
    const r = pool.get(sid);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatch(new RegExp(`^<${KICKOFF_TAG}>[\\s\\S]*</${KICKOFF_TAG}>$`));
    expect(typeof r.gatesAtSend[0]).toBe('function');
    expect(threads.isThread(sid)).toBe('b1');
  });

  it('ensure reuses the gated runner, and closes and reopens a live ungated one', async () => {
    const b = bot({ threadId: 'T1' }); await store.save(b);
    // an ungated runner of the thread (from before its meta was recorded)
    const stale: any = new EventEmitter(); stale.sessionId = 'T1'; stale.state = 'idle'; stale.info = { agent: 'claude' }; stale.gated = false;
    let closed = 0; stale.close = async () => { closed++; stale.state = 'closed'; };
    pool.runners.set('T1', stale);
    const r = await threads.ensure(b);
    expect(closed).toBe(1);
    expect(r).not.toBe(stale);
    expect(r.gated).toBe(true); expect(typeof r.gate).toBe('function');
    expect(pool.opened[0]).toMatchObject({ sessionId: 'T1', gated: true, botRole: 'thread' });
    const again = await threads.ensure(b);
    expect(again).toBe(r);
    expect(pool.opened).toHaveLength(1);
  });

  it('withEvents prepends what happened since the last message once; a second call adds nothing', async () => {
    const b = bot({ threadId: 'T1' }); await store.save(b);
    await threads.ensure(b);
    await store.setThreadState('b1', { deliveredAt: Date.now() - 60_000 });
    const item = await inbox.add({ kind: 'approval', botId: 'b1', title: 'git push', thread: true });
    await store.appendTimeline('b1', { id: `item:${item.id}`, botId: 'b1', at: Date.now(), kind: 'approval', itemId: item.id });
    const first = threads.withEvents('T1', '你好');
    expect(first).toMatch(/^<cw-bot-events>\n- \d+:\d\d 等你批准：git push\n<\/cw-bot-events>\n\n你好$/);
    expect(threads.withEvents('T1', '再说一句')).toBe('再说一句');
    await until(() => (store.threadState('b1').deliveredAt ?? 0) > Date.now() - 5_000);
    expect(threads.withEvents('other', 'x')).toBe('x');
  });

  it('onApproval lets the approved call through the thread gate once and sends a hidden 「已批准」', async () => {
    const b = bot({ threadId: 'T1' }); await store.save(b);
    const r = await threads.ensure(b);
    const call = { requestId: 'q', sessionId: 'T1', toolName: 'Bash', input: { command: 'git push' } };
    expect((await r.gate(call)).behavior).toBe('deny');
    const item = inbox.list('b1').find((i) => i.kind === 'approval')!;
    expect(item).toMatchObject({ thread: true, sessionId: 'T1' });
    expect(item.routineId).toBeUndefined();
    await threads.onApproval(item, true);
    expect(r.sent.at(-1)).toMatch(/^<cw-bot-continue>已批准[\s\S]*<\/cw-bot-continue>$/);
    expect((await r.gate(call)).behavior).toBe('allow');
    expect((await r.gate(call)).behavior).toBe('deny'); // once
  });

  it('onApproval waits for a busy thread to go idle before it sends', async () => {
    const b = bot({ threadId: 'T1' }); await store.save(b);
    const r = await threads.ensure(b);
    r.state = 'running';
    await threads.onApproval({ id: 'i1', kind: 'approval', botId: 'b1', at: 0, title: 'x', thread: true, toolName: 'Bash', input: { command: 'x' } }, false);
    expect(r.sent).toHaveLength(0);
    r.state = 'idle'; r.emit('state', 'idle');
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toMatch(/^<cw-bot-continue>[\s\S]*拒绝[\s\S]*<\/cw-bot-continue>$/);
  });

  it('a result in the thread becomes its last line; the runner state is its activity', async () => {
    const b = bot({ threadId: 'T1' }); await store.save(b);
    const r = await threads.ensure(b);
    const lines: string[] = []; threads.on('line', (id) => lines.push(id));
    r.state = 'running';
    expect(threads.activity('b1')).toBeTruthy();
    r.emit('message', { type: 'result', is_error: false, result: '搞定了。\n紧急 2 条' });
    await until(() => lines.length > 0);
    expect(lines).toEqual(['b1']);
    expect(store.threadState('b1').lastLine?.text).toBe('搞定了。');
    r.state = 'idle';
    expect(threads.activity('b1')).toBeUndefined();
  });

  it('kickoff: A–D on a card without a template; the template name with one; the routines of a bot that has some', () => {
    const plain = kickoffText(bot());
    expect(plain).toContain('AskUserQuestion');
    for (const s of ['每天早上给我一页纸', '盯一个仓库的 PR 和 CI', '整理收件箱', '盯价格或消息', '帮我写东西']) expect(plain).toContain(s);
    const t = BOT_TEMPLATES.find((x) => x.id === 'pr')!;
    expect(kickoffText(bot(), t)).toContain(`我按『${t.name}』来`);
    expect(kickoffText(bot({ routines: [{ id: 'r1', name: '早间简报', prompt: 'x', enabled: true, acceptance: { kind: 'none' }, onFail: 'inbox', cron: '0 8 * * *' }] }))).toContain('早间简报');
  });

  it('threadPrompt promises the bot tools only when the conversation has them', () => {
    const b = bot({ title: '晨报员' });
    const withTools = threadPrompt(b, { tools: true });
    expect(withTools).toContain('晨报员');
    expect(withTools).toContain('mcp__cw-bot__propose_policy');
    expect(withTools).toContain('<cw-bot-events>');
    expect(threadPrompt(b, { tools: false })).not.toContain('mcp__cw-bot__');
  });

  it('avatarFor is stable per name and in the stored format', () => {
    expect(avatarFor('晨报')).toBe(avatarFor(' 晨报 '));
    expect(avatarFor('晨报')).toMatch(/^shape:(\d|1[01])\|color:\d\|seed:\d+$/);
  });
});
