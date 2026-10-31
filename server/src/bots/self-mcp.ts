// 值班 Bot, chat-first (plan 2026-10-31 A, T5): the tools through which a bot's own conversation sets the bot up — its
// name, title, picture and charter, its routines, what to remember — and asks for a policy change. An in-process MCP
// server (like sessions-mcp/tools.ts). The main conversation's policy gate lets exactly these tools (BOT_SELF_TOOLS)
// through without grading (audited, one row a call; a routine run grades them like any tool), and the self-guard
// doesn't see them: so nothing here ever writes the policy or the budget.
// propose_policy only puts a card in front of the user; bot_profile takes only its own four fields.
import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { Bot, BotTimelineEntry, InboxItem, InboxProposal, Routine } from '../protocol.js';
import { describeCron, nextCron } from '../schedules/cron.js';
import { tr } from '../i18n/index.js';
import { BOT_SELF_SERVER } from './runtime-hooks.js';
import { allowScope, botFields, routineOf, ruleOf, untilPassed } from './shape.js';
import { MAX_FAILURES } from './pipeline.js';

export interface BotSelfDeps {
  get(botId: string): Bot | undefined;
  /** BotService.update with the lease; throws 另一个 claude-web 正在值班 */
  edit(botId: string, fn: (b: Bot) => Bot): Promise<Bot>;
  runNow(botId: string, routineId: string): Promise<void>;
  /** MemoryService.write scope 'bot', key botId */
  remember(botId: string, text: string): Promise<void>;
  propose(botId: string, p: InboxProposal, title: string): Promise<InboxItem>;
  event(botId: string, text: string, icon: BotTimelineEntry['icon'], detail?: string): Promise<void>;
}

/**
 * The tools botSelfTools registers, as the model calls them: the thread's gate lets exactly these through (a self-mcp
 * test keeps the list in step with the tools). Kept in runtime-hooks, which imports nothing, so the gate can read it
 * without an import cycle (self-mcp → shape → pipeline → gate).
 */
export { BOT_SELF_TOOL_NAMES, BOT_SELF_TOOLS } from './runtime-hooks.js';

/** the shortest interval a bot may give itself (the generator's minimum too) */
export const MIN_EVERY = 15;
const AVATAR = /^shape:(\d|1[01])\|color:\d\|seed:\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** where a routine ends, kept as the prompt's last line: the run reads it, and an update replaces it */
const FOOTER = /\n*\[until: [^\]\n]*\]\s*$/;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 'forever' or a real YYYY-MM-DD; anything else (a missing one too) is refused */
function untilOf(v: unknown): string {
  if (v === 'forever' || v === '一直') return 'forever';
  if (typeof v === 'string' && DATE.test(v.trim()) && Number.isFinite(Date.parse(v.trim()))) return v.trim();
  throw new Error(tr('必须写结束日期或明确写『一直』'));
}
const footerOf = (prompt: string): string | undefined => /\[until: ([^\]\n]*)\]\s*$/.exec(prompt)?.[1];
const withFooter = (prompt: string, until: string) => `${prompt.replace(FOOTER, '').trimEnd()}\n\n[until: ${until}]`;

function cadenceOf(r: Pick<Routine, 'cron' | 'everyMinutes'>, until?: string): string {
  const how = r.cron ? describeCron(r.cron) : r.everyMinutes ? tr('每 {n} 分钟', { n: r.everyMinutes }) : tr('只在手动运行时');
  if (!until) return how;
  return `${how} · ${until === 'forever' ? tr('一直运行') : tr('到 {date} 为止', { date: until })}`;
}
/** a bot-made cron fires at least MIN_EVERY minutes apart: the gaps between its next fires (minutes repeat each hour, so a burst shows) */
function cronOk(cron: string | undefined): string | undefined {
  if (!cron) return undefined;
  let t: Date;
  try { t = nextCron(cron, new Date()); } catch { throw new Error(tr('Bot 设置不对：{field}', { field: 'cron' })); }
  for (let i = 0; i < 24; i++) {
    const n = nextCron(cron, t);
    if (n.getTime() - t.getTime() < MIN_EVERY * 60_000) throw new Error(tr('这个 cron 太密了：两次之间至少 {n} 分钟', { n: MIN_EVERY }));
    t = n;
  }
  return cron;
}
function everyOf(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_EVERY) throw new Error(tr('间隔至少 {n} 分钟', { n: MIN_EVERY }));
  return v;
}

const charterShape = z.object({
  role: z.string().max(2000).optional(), audience: z.string().max(500).optional(), sources: z.array(z.string().max(500)).max(30).optional(),
  report: z.string().max(1000).optional(), done: z.string().max(1000).optional(),
});
const cadence = {
  cron: z.string().max(100).optional().describe('5-field cron, local time (e.g. "0 9 * * 1-5")'),
  everyMinutes: z.number().int().min(MIN_EVERY).optional().describe(`every N minutes, at least ${MIN_EVERY}`),
  until: z.string().max(20).optional().describe('when it stops: a date YYYY-MM-DD, or "forever" only when the user said so'),
  notify: z.string().max(200).optional().describe('who / where to tell about a run; kept in the prompt'),
};

/** The tools, exported for tests (their handlers are called directly); botSelfServer serves them. */
export function botSelfTools(botId: string, _self: () => string, d: BotSelfDeps) {
  const bot = () => { const b = d.get(botId); if (!b) throw new Error(tr('没有这个 Bot')); return b; };
  const routine = (id: string) => { const r = bot().routines.find((x) => x.id === id); if (!r) throw new Error(tr('没有这个例行：{id}', { id })); return r; };
  /** a routine the bot made itself: the user's own routines are the user's to change */
  const own = (id: string) => {
    const r = routine(id);
    if (!r.selfMade) throw new Error(tr('「{name}」是用户自己建的例行，你不能改、停或删它：想怎么改，跟用户说，请用户在 Bot 页上改', { name: r.name }));
    return r;
  };
  const safe = <A>(fn: (a: A) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>) => async (a: A) => {
    try { return await fn(a); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  };
  /** one routine replaced in the stored bot (it must still be there under the lock) */
  const editRoutine = (id: string, fn: (r: Routine, prevs: Map<string, Routine>) => Routine) => d.edit(botId, (b) => {
    const prevs = new Map(b.routines.map((r) => [r.id, r]));
    const prev = prevs.get(id);
    if (!prev) throw new Error(tr('没有这个例行：{id}', { id }));
    return { ...b, routines: b.routines.map((r) => (r.id === id ? fn(r, prevs) : r)) };
  });
  const promptOf = (prompt: string, notify?: string) => (notify?.trim() ? `${prompt.trimEnd()}\n\n${tr('结果告诉：{who}', { who: notify.trim() })}` : prompt);
  const opts = { alwaysLoad: true } as const;

  return [
    tool('bot_profile', 'Change how you appear and what you are for: your name, your title (one line under the name), your picture and your charter. Your policy and budget are not here: ask for a policy change with propose_policy.', {
      name: z.string().min(1).max(60).optional(),
      title: z.string().max(80).optional(),
      avatar: z.string().max(60).optional().describe('shape:<0-11>|color:<0-9>|seed:<n>'),
      charter: charterShape.optional(),
    }, safe(async (a: { name?: string; title?: string; avatar?: string; charter?: Record<string, unknown> }) => {
      // only these four: a policy / budget / routines key in the arguments is never passed on
      const patch: Record<string, unknown> = {};
      for (const k of ['name', 'title', 'avatar', 'charter'] as const) if (a[k] !== undefined) patch[k] = a[k];
      if (!Object.keys(patch).length) return fail(tr('没有要改的'));
      if (typeof patch.avatar === 'string' && !AVATAR.test(patch.avatar)) return fail(tr('Bot 设置不对：{field}', { field: 'avatar' }));
      const before = bot();
      const after = await d.edit(botId, (b) => {
        const f = botFields(patch, b);
        return { ...b, name: f.name, title: f.title, avatar: f.avatar, charter: f.charter };
      });
      if (after.name !== before.name) await d.event(botId, tr('已改名为 {name}', { name: after.name }), 'rename');
      if (after.title !== before.title) await d.event(botId, after.title ? tr('职位改为 {title}', { title: after.title }) : tr('已去掉职位'), 'profile');
      if (after.avatar !== before.avatar) await d.event(botId, tr('已换头像'), 'profile');
      if (patch.charter) await d.event(botId, tr('已更新职责'), 'profile', JSON.stringify(after.charter, null, 2).slice(0, 2000));
      return text(tr('已更新'));
    }), opts),

    tool('routine_create', `Create a routine: work you do on a schedule. Every routine needs an end: a date, or "forever" only when the user asked for it. At least ${MIN_EVERY} minutes apart (a cron too).`, {
      name: z.string().min(1).max(80), prompt: z.string().min(1).max(8000).describe('what to do each run'), ...cadence,
    }, safe(async (a: { name: string; prompt: string; cron?: string; everyMinutes?: number; until?: string; notify?: string }) => {
      const until = untilOf(a.until);
      const every = everyOf(a.everyMinutes);
      const cron = cronOk(a.cron);
      let made: Routine | undefined;
      await d.edit(botId, (b) => {
        if (b.manager) throw new Error(tr('总管不做例行'));
        if (b.routines.length >= (b.maxRoutines ?? 20)) throw new Error(tr('例行已满（最多 {n} 个）', { n: b.maxRoutines ?? 20 }));
        made = { ...routineOf({ name: a.name.trim(), prompt: withFooter(promptOf(a.prompt, a.notify), until), cron, everyMinutes: every, until }, new Map()), selfMade: true };
        return { ...b, routines: [...b.routines, made] };
      });
      await d.event(botId, tr('已创建例行 ⏲ {name}', { name: made!.name }), 'routine', cadenceOf(made!, until));
      return text(tr('已创建例行 {name}（{id}）：{how}', { name: made!.name, id: made!.id, how: cadenceOf(made!, until) }));
    }), opts),

    tool('routine_update', 'Change one of the routines you made (the user’s own routines are theirs to change): anything left out stays as it is. Giving cron drops everyMinutes and the other way round.', {
      id: z.string().min(1).max(40), name: z.string().min(1).max(80).optional(), prompt: z.string().min(1).max(8000).optional(), ...cadence,
    }, safe(async (a: { id: string; name?: string; prompt?: string; cron?: string; everyMinutes?: number; until?: string; notify?: string }) => {
      const cur = own(a.id);
      const until = a.until !== undefined ? untilOf(a.until) : cur.until ?? footerOf(cur.prompt);
      const every = everyOf(a.everyMinutes);
      const cron = cronOk(a.cron);
      const newCadence = a.cron !== undefined || a.everyMinutes !== undefined;
      let next: Routine | undefined;
      await editRoutine(a.id, (r, prevs) => {
        const base = a.prompt !== undefined ? promptOf(a.prompt, a.notify) : a.notify !== undefined ? promptOf(r.prompt.replace(FOOTER, ''), a.notify) : r.prompt;
        const prompt = until ? withFooter(base, until) : base;
        next = routineOf({ ...r, name: a.name?.trim() ?? r.name, prompt, ...(newCadence ? { cron, everyMinutes: every } : {}), ...(until ? { until } : {}) }, prevs);
        return next;
      });
      await d.event(botId, tr('已修改例行 ⏲ {name}', { name: next!.name }), 'routine', cadenceOf(next!, until));
      return text(tr('已修改例行 {name}：{how}', { name: next!.name, how: cadenceOf(next!, until) }));
    }), opts),

    tool('routine_pause', 'Pause or resume one of the routines you made. A routine stopped after failing again and again only the user can turn back on.', {
      id: z.string().min(1).max(40), paused: z.boolean(),
    }, safe(async (a: { id: string; paused: boolean }) => {
      const cur = own(a.id);
      if (!a.paused && !cur.enabled && (cur.failures ?? 0) >= MAX_FAILURES) {
        return fail(tr('「{name}」连续失败后被停下了，只有用户能重新打开：告诉用户出了什么问题', { name: cur.name }));
      }
      if (!a.paused && untilPassed(cur.until, Date.now())) return fail(tr('「{name}」已经到期：先用 routine_update 定一个新的结束日期（问过用户），再恢复', { name: cur.name }));
      // the bot never lifts the failure stop: `failures` is not handed back, so routineOf keeps a stopped one off
      await editRoutine(a.id, (r, prevs) => routineOf({ ...r, failures: undefined, enabled: !a.paused }, prevs));
      const line = a.paused ? tr('已暂停例行 ⏲ {name}', { name: cur.name }) : tr('已恢复例行 ⏲ {name}', { name: cur.name });
      await d.event(botId, line, 'routine');
      return text(line);
    }), opts),

    tool('routine_delete', 'Delete one of the routines you made (the user’s own routines are theirs to delete).', {
      id: z.string().min(1).max(40),
    }, safe(async (a: { id: string }) => {
      const cur = own(a.id);
      await d.edit(botId, (b) => ({ ...b, routines: b.routines.filter((r) => r.id !== a.id) }));
      const line = tr('已删除例行 ⏲ {name}', { name: cur.name });
      await d.event(botId, line, 'routine');
      return text(line);
    }), opts),

    tool('routine_test', 'Run one of your routines once now, to try it. The run shows in your timeline when it ends.', {
      id: z.string().min(1).max(40),
    }, safe(async (a: { id: string }) => {
      const cur = routine(a.id);
      await d.runNow(botId, a.id);
      const line = tr('试运行例行 ⏲ {name}', { name: cur.name });
      await d.event(botId, line, 'routine');
      return text(line);
    }), opts),

    tool('remember', 'Remember something for later runs and conversations (a preference, a fact about the work).', {
      text: z.string().min(1).max(2000),
    }, safe(async (a: { text: string }) => {
      const t = a.text.trim();
      if (!t) return fail(tr('没有要记的'));
      await d.remember(botId, t);
      await d.event(botId, tr('已记住：{text}', { text: short(t) }), 'memory', t);
      return text(tr('已记住'));
    }), opts),

    tool('propose_policy', 'Ask the user to change your policy (what you may do without asking). You cannot change it yourself: this puts a card in front of the user, and nothing changes until they accept it. A rule that lets more run must say where (domains, channels or recipients), or set unlimited.', {
      rules: z.array(z.object({
        cls: z.enum(['read', 'write_local', 'browser', 'send', 'pay', 'delete', 'install']),
        level: z.enum(['do', 'do_tell', 'ask', 'deny']),
        scope: z.record(z.string(), z.unknown()).optional(),
      })).min(1).max(20),
      why: z.string().min(1).max(1000),
    }, safe(async (a: { rules: unknown[]; why: string }) => {
      // a rule that lets more run must name where, like an adopted trust_up (ruleOf alone takes a scope-less one)
      const rules = a.rules.map((r) => {
        const rule = ruleOf(r);
        if (rule.level !== 'deny' && !rule.scope) allowScope({}, 'rules.scope', rule.cls);
        return rule;
      });
      bot();
      await d.propose(botId, { type: 'policy', rules, why: a.why.trim() }, tr('想修改策略：{why}', { why: short(a.why.trim()) }));
      return text(tr('已发给用户确认，确认前不生效'));
    }), opts),
  ];
}

/** The bot's own server (runtime-hooks: registered as BotRuntime.selfServer). `self()` is its conversation's id. */
export function botSelfServer(botId: string, self: () => string, d: BotSelfDeps): McpServerConfig {
  return createSdkMcpServer({ name: BOT_SELF_SERVER, version: '1.0.0', tools: botSelfTools(botId, self, d) });
}
