import { describe, expect, it, vi } from 'vitest';
import type { Bot, InboxItem, InboxProposal, Routine } from '../protocol.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { selfToolNames, botSelfTools, botSelfServer, BOT_SELF_TOOL_NAMES, type BotSelfDeps } from './self-mcp.js';
import { selfServerName } from './runtime-hooks.js';
import { botFields, routineOf, ruleOf } from './shape.js';

const baseBot = (): Bot => ({
  id: 'b1', name: 'Scout', cwd: '/w', tier: 'balanced', charter: { role: 'watch', sources: [] },
  policy: { rules: [{ cls: 'send', level: 'ask' }] }, budget: { dailyUsd: 1 }, routines: [], outputs: [{ kind: 'inbox' }],
  createdAt: 1, updatedAt: 1, threadId: 't1',
});

function fake(over: Partial<BotSelfDeps> = {}, start: Partial<Bot> = {}) {
  let bot = { ...baseBot(), ...start };
  const events: { text: string; icon?: string; detail?: string }[] = [];
  const d: BotSelfDeps = {
    get: () => bot,
    edit: vi.fn(async (_id: string, fn: (b: Bot) => Bot) => { bot = fn(bot); return bot; }),
    runNow: vi.fn(async () => {}),
    remember: vi.fn(async () => {}),
    propose: vi.fn(async (_id: string, p: InboxProposal, title: string) => ({ id: 'i1', kind: 'proposal', botId: 'b1', at: 1, title, proposal: p }) as InboxItem),
    event: vi.fn(async (_id: string, text: string, icon, detail?: string) => { events.push({ text, icon, detail }); }),
    ...over,
  };
  const tools = botSelfTools('b1', () => 't1', d);
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return (await t.handler(args as any, {} as any)) as { content: { type: string; text: string }[]; isError?: boolean };
  };
  return { d, call, events, bot: () => bot };
}

describe('bot-self tools', () => {
  it('selfToolNames (what the thread gate passes) is exactly the registered tools, on the given server', () => {
    const names = botSelfTools('b1', () => 't1', fake().d).map((t) => `mcp__cw-bot-0123456789ab__${t.name}`).sort();
    expect([...selfToolNames('cw-bot-0123456789ab')].sort()).toEqual(names);
  });

  it('the in-process server answers tools/list with every tool, alwaysLoad (one schema the SDK cannot convert fails the whole list, and the engine drops the server)', async () => {
    const cfg = botSelfServer('b1', () => 't1', fake().d, 'cw-bot-0123456789ab') as { instance: { connect(t: unknown): Promise<void> } };
    // a bare MCP transport: one JSON-RPC request in, its answer out
    const answer = new Promise<any>((resolve) => {
      const t: Record<string, unknown> = { start: async () => {}, close: async () => {}, send: async (m: unknown) => resolve(m) };
      void cfg.instance.connect(t).then(() => (t.onmessage as (m: unknown) => void)({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    });
    const r = await answer;
    expect(r.error).toBeUndefined();
    expect(r.result.tools.map((x: { name: string }) => x.name).sort()).toEqual([...BOT_SELF_TOOL_NAMES].sort());
    for (const x of r.result.tools) expect(x._meta?.['anthropic/alwaysLoad']).toBe(true);
  });

  it('selfServerName: cw-bot-<12 hex>, made once per bots dir and kept; a bad stored one is replaced', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-selfname-'));
    try {
      const a = selfServerName(dir);
      expect(a).toMatch(/^cw-bot-[0-9a-f]{12}$/);
      expect(selfServerName(dir)).toBe(a);
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-selfname-'));
      try { expect(selfServerName(other)).not.toBe(a); } finally { fs.rmSync(other, { recursive: true, force: true }); }
      fs.writeFileSync(path.join(dir, 'self-server.json'), JSON.stringify({ name: 'cw-bot' }));
      expect(selfServerName(dir)).toMatch(/^cw-bot-[0-9a-f]{12}$/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('routine_create without until is refused', async () => {
    const f = fake();
    const r = await f.call('routine_create', { name: 'n', prompt: 'p', everyMinutes: 30 });
    expect(r.isError).toBe(true);
    expect(f.d.edit).not.toHaveBeenCalled();
  });

  it('routine_create: a selfMade routine with the end in its prompt, and an event', async () => {
    const f = fake();
    const r = await f.call('routine_create', { name: 'Check mail', prompt: 'look', everyMinutes: 30, until: '2026-12-31' });
    expect(r.isError).toBeFalsy();
    expect(f.d.edit).toHaveBeenCalled();
    const rt = f.bot().routines[0];
    expect(rt.selfMade).toBe(true);
    expect(rt.everyMinutes).toBe(30);
    expect(rt.prompt).toContain('2026-12-31');
    expect(f.events[0].icon).toBe('routine');
    expect(f.events[0].text).toContain('Check mail');
    expect(f.events[0].detail).toBeTruthy();
  });

  it('the first routine brings the 规矩 card (once): the user sees what the bot may do on its own', async () => {
    const f = fake();
    await f.call('routine_create', { name: 'A', prompt: 'p', everyMinutes: 30, until: 'forever' });
    await f.call('routine_create', { name: 'B', prompt: 'p', everyMinutes: 30, until: 'forever' });
    expect(f.d.propose).toHaveBeenCalledTimes(1);
    expect(f.d.propose).toHaveBeenCalledWith('b1', { type: 'rules' }, expect.any(String));
  });

  it('routine_create: under 15 minutes, a bad date, or over maxRoutines is refused', async () => {
    const f = fake();
    expect((await f.call('routine_create', { name: 'n', prompt: 'p', everyMinutes: 5, until: 'forever' })).isError).toBe(true);
    expect((await f.call('routine_create', { name: 'n', prompt: 'p', everyMinutes: 30, until: 'someday' })).isError).toBe(true);
    const g = fake({}, { maxRoutines: 0 });
    const r = await g.call('routine_create', { name: 'n', prompt: 'p', everyMinutes: 30, until: 'forever' });
    expect(r.isError).toBe(true);
  });

  it('routine_update / pause / test / delete write events; test calls runNow', async () => {
    const f = fake();
    await f.call('routine_create', { name: 'A', prompt: 'p', cron: '0 9 * * *', until: 'forever' });
    const id = f.bot().routines[0].id;
    expect((await f.call('routine_update', { id, name: 'B', until: '2027-01-01' })).isError).toBeFalsy();
    expect(f.bot().routines[0].name).toBe('B');
    expect(f.bot().routines[0].prompt).toContain('2027-01-01');
    expect(f.bot().routines[0].prompt).not.toContain('forever');
    expect(f.bot().routines[0].selfMade).toBe(true);
    await f.call('routine_pause', { id, paused: true });
    expect(f.bot().routines[0].enabled).toBe(false);
    await f.call('routine_test', { id });
    expect(f.d.runNow).toHaveBeenCalledWith('b1', id);
    await f.call('routine_delete', { id });
    expect(f.bot().routines).toHaveLength(0);
    expect(f.events).toHaveLength(5);
    expect((await f.call('routine_pause', { id: 'nope', paused: true })).isError).toBe(true);
  });

  it('until is a field of the routine (kept by an update; a bad one refused by routineOf)', async () => {
    const f = fake();
    await f.call('routine_create', { name: 'A', prompt: 'p', everyMinutes: 30, until: '2026-12-31' });
    const id = f.bot().routines[0].id;
    expect(f.bot().routines[0].until).toBe('2026-12-31');
    await f.call('routine_update', { id, name: 'B' });
    expect(f.bot().routines[0].until).toBe('2026-12-31');
    await f.call('routine_update', { id, until: 'forever' });
    expect(f.bot().routines[0].until).toBe('forever');
    expect(() => routineOf({ name: 'n', prompt: 'p', until: '2026-02-30' }, new Map())).toThrow();
    expect(() => routineOf({ name: 'n', prompt: 'p', until: 'someday' }, new Map())).toThrow();
    // the user turning an ended routine back on (end unchanged) means it: the old end goes
    const ended = { ...f.bot().routines[0], enabled: false, until: '2020-01-01' };
    expect(routineOf({ ...ended, enabled: true }, new Map([[id, ended]])).until).toBeUndefined();
    expect(routineOf({ ...ended, enabled: true, until: '2099-01-01' }, new Map([[id, ended]])).until).toBe('2099-01-01');
  });

  it('a cron firing less than 15 minutes apart is refused, create and update', async () => {
    const f = fake();
    for (const cron of ['* * * * *', '*/5 * * * *', '0,10 9 * * *']) {
      const r = await f.call('routine_create', { name: 'n', prompt: 'p', cron, until: 'forever' });
      expect(r.isError, cron).toBe(true);
      expect(r.content[0].text).toContain('15');
    }
    expect(f.bot().routines).toHaveLength(0);
    expect((await f.call('routine_create', { name: 'n', prompt: 'p', cron: '*/15 * * * *', until: 'forever' })).isError).toBeFalsy();
    const id = f.bot().routines[0].id;
    expect((await f.call('routine_update', { id, cron: '*/2 * * * *' })).isError).toBe(true);
    expect(f.bot().routines[0].cron).toBe('*/15 * * * *');
  });

  it("the user's routines can't be updated, paused or deleted by the bot (testing one is fine)", async () => {
    const user: Routine = { id: 'u1', name: 'Mine', prompt: 'p', enabled: true, everyMinutes: 60, acceptance: { kind: 'none' }, onFail: 'inbox' };
    const f = fake({}, { routines: [user] });
    for (const [name, args] of [['routine_update', { id: 'u1', name: 'X' }], ['routine_pause', { id: 'u1', paused: true }], ['routine_delete', { id: 'u1' }]] as const) {
      const r = await f.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.content[0].text).toContain('Mine');
    }
    expect(f.bot().routines).toEqual([user]);
    expect(f.d.edit).not.toHaveBeenCalled();
    expect((await f.call('routine_test', { id: 'u1' })).isError).toBeFalsy();
  });

  it('a routine the scheduler stopped for failures stays off: only the user turns it back on', async () => {
    const stopped: Routine = { id: 's1', name: 'Flaky', prompt: 'p', enabled: false, failures: 3, everyMinutes: 60, acceptance: { kind: 'none' }, onFail: 'inbox', selfMade: true };
    const f = fake({}, { routines: [stopped] });
    const r = await f.call('routine_pause', { id: 's1', paused: false });
    expect(r.isError).toBe(true);
    expect(f.bot().routines[0]).toMatchObject({ enabled: false, failures: 3 });
    // an ended one needs a new end first
    const g = fake({}, { routines: [{ ...stopped, failures: 0, until: '2020-01-01' }] });
    expect((await g.call('routine_pause', { id: 's1', paused: false })).isError).toBe(true);
    expect(g.bot().routines[0].enabled).toBe(false);
  });

  it('bot_profile changes name / title / charter but never policy or budget', async () => {
    const f = fake();
    const r = await f.call('bot_profile', { name: 'Ranger', title: 'Inbox lead', charter: { role: 'triage' }, policy: { rules: [{ cls: 'send', level: 'do', scope: { unlimited: true } }] }, budget: { dailyUsd: 999 } });
    expect(r.isError).toBeFalsy();
    const b = f.bot();
    expect(b.name).toBe('Ranger');
    expect(b.title).toBe('Inbox lead');
    expect(b.charter.role).toBe('triage');
    expect(b.policy).toEqual(baseBot().policy);
    expect(b.budget).toEqual(baseBot().budget);
    expect(b.threadId).toBe('t1');
    expect(f.events.some((e) => e.text.includes('Ranger'))).toBe(true);
  });

  it('propose_policy creates a proposal and does not edit the bot', async () => {
    const f = fake();
    const r = await f.call('propose_policy', { rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1'] } }], why: 'daily report' });
    expect(r.isError).toBeFalsy();
    expect(f.d.propose).toHaveBeenCalledWith('b1', { type: 'policy', rules: [{ cls: 'send', level: 'do', scope: { channels: ['C1'] } }], why: 'daily report' }, expect.any(String));
    expect(f.d.edit).not.toHaveBeenCalled();
    expect(f.bot().policy).toEqual(baseBot().policy);
    // a wider rule with no place is refused before a card is made
    expect((await f.call('propose_policy', { rules: [{ cls: 'send', level: 'do' }], why: 'x' })).isError).toBe(true);
    expect(f.d.propose).toHaveBeenCalledTimes(1);
  });

  it('remember stores and writes an event', async () => {
    const f = fake();
    await f.call('remember', { text: 'the user likes short reports' });
    expect(f.d.remember).toHaveBeenCalledWith('b1', 'the user likes short reports');
    expect(f.events[0].icon).toBe('memory');
  });

  it('an edit failing on the lease comes back as isError with that text', async () => {
    const f = fake({ edit: vi.fn(async () => { throw new Error('另一个 claude-web 正在值班'); }) });
    const r = await f.call('bot_profile', { name: 'X' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('另一个 claude-web 正在值班');
    expect(f.events).toHaveLength(0);
  });
});

describe('shape: the new bot fields', () => {
  it('title / notify / pinned / hidden are taken; threadId is kept from the stored bot, never the request', () => {
    const f = botFields({ title: 'Lead', notify: true, pinned: true, hidden: false, threadId: 'evil' }, baseBot());
    expect(f).toMatchObject({ title: 'Lead', notify: true, pinned: true, hidden: false, threadId: 't1' });
    expect(botFields({ name: 'n', cwd: '/w', charter: { role: 'r' }, routines: [], outputs: [], threadId: 'evil' }).threadId).toBeUndefined();
    expect(() => botFields({ pinned: 'yes' }, baseBot())).toThrow();
  });
  it('ruleOf is exported', () => {
    expect(ruleOf({ cls: 'read', level: 'do', scope: { unlimited: true } })).toEqual({ cls: 'read', level: 'do', scope: { unlimited: true } });
  });
});
