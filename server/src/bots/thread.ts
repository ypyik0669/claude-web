// 值班 Bot, chat-first (plan 2026-10-31 A, T6): a bot's main conversation — the one the user talks to. A gated Claude
// conversation (the bot's policy gate answers every tool call, like a routine run's) that a person reads: the bot's own
// tools (bot-self MCP) and its system-prompt section come from runtime-hooks; this file opens it, says the hidden first
// words (kickoff), tells it what happened since the user last spoke (<cw-bot-events>), and carries an approval answered
// on a card back into it.
import { EventEmitter } from 'node:events';
import type { AgentDriver } from '../agents/types.js';
import type { RunnerPool } from '../runtime/pool.js';
import type { Bot, BotRun, BotTemplate, InboxItem, OpenSessionParams } from '../protocol.js';
import type { BotStore } from './store.js';
import type { Inbox } from './inbox.js';
import type { AuditLog } from './audit.js';
import { makeGate, type GateHandle } from './policy/gate.js';
import { policyLine } from './pipeline.js';
import { eventsBlock, systemEntry } from './timeline.js';
import { serverSend } from './tags.js';
import { BOT_SELF_PREFIX } from './runtime-hooks.js';
import { getLocale, tr } from '../i18n/index.js';

export const KICKOFF_TAG = 'cw-bot-kickoff';
/** a hidden message the server sends into the thread (an answered approval); the reducer hides the whole message */
export const CONTINUE_TAG = 'cw-bot-continue';

export interface BotThreadsDeps {
  store: BotStore; inbox: Inbox; audit: AuditLog;
  pool: Pick<RunnerPool, 'open' | 'get'>;
  defaultProvider(): string | undefined;
  modelFor(b: Bot): string | undefined;
}

/** FNV-1a + a murmur finaliser over the trimmed, lowercased name — the same face the web draws for a bot without one */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
/** `shape:<0-11>|color:<0-9>|seed:<n>` from the name (web/src/features/bots/avatar-model.ts avatarOf) */
export function avatarFor(name: string): string {
  const h = hash(name.trim().toLowerCase());
  return `shape:${h % 12}|color:${Math.floor(h / 12) % 10}|seed:${(h >>> 8) % 1000}`;
}

const yyyymmdd = (t: number) => { const d = new Date(t); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
const cadence = (r: Bot['routines'][number]) => (r.cron ? `cron ${r.cron}` : r.everyMinutes ? `每 ${r.everyMinutes} 分钟` : '只在手动运行时');

/**
 * The bot's section of its main conversation's system prompt (runtime-hooks threadPrompt), read at every process
 * start. `tools`: the conversation has the bot-self tools and AskUserQuestion (a 只聊天 / lean-tools one has none). For
 * the model only, so not translated; it is told to speak the user's language.
 */
export function threadPrompt(bot: Bot, o: { tools?: boolean; server?: string } = {}): string {
  const tools = o.tools !== false;
  const t = (n: string) => `mcp__${o.server ?? BOT_SELF_PREFIX}__${n}`;
  const c = bot.charter;
  return [
    '# 你是谁',
    `你是「${bot.name}」${bot.title ? `，职位：${bot.title}` : ''}。你是用户的值班 Bot：用户不在的时候你按例行接着干活，用户在的时候你在这个对话里和他聊。`,
    `职责：${c.role || '还没定——和用户聊出来，再定下来'}`,
    c.audience ? `服务对象：${c.audience}` : '',
    c.sources.length ? `只用这些来源：${c.sources.join('、')}` : '',
    c.report ? `报告格式：${c.report}` : '',
    c.done ? `完成条件：${c.done}` : '',
    bot.routines.length ? `现有的例行：${bot.routines.map((r) => `「${r.name}」（${cadence(r)}${r.enabled ? '' : '，已关闭'}${r.selfMade ? '' : '，用户建的：你不能改'}）`).join('、')}` : '现在还没有例行。',
    '',
    '# 怎么说话',
    '- 像同事一样说话：简短、直接、具体，不客套，不说「作为 AI」。',
    `- 用用户说话的语言回答；用户还没说过话时用${getLocale() === 'en' ? '英文' : '中文'}。`,
    tools ? '- 要用户在几个选项里挑的时候，用 AskUserQuestion 工具问，选项用 A / B / C / D 开头（每个问题最多 4 个选项，「其它」会自动加上）。' : '- 要用户在几个选项里挑的时候，把选项用 A / B / C … 列出来。',
    '',
    '# 管好你自己',
    ...(tools ? [
      `- 名字、职位、头像、职责用 ${t('bot_profile')} 改；例行用 ${t('routine_create')} / routine_update / routine_pause / routine_delete / routine_test；要记住的事用 ${t('remember')}。改完时间线上会出一行，用户看得见。`,
      '- 每条例行都要有结束日期，或者用户明确说了「一直」（until 写 forever）。没问清楚就先问，别替用户定。',
      `- 策略（哪些事你可以不问就做）是用户的：你改不了。想改就用 ${t('propose_policy')} 提议，用户在卡片上确认后才生效。`,
    ] : [
      '- 这个对话没有工具：名字、例行和策略请用户在 Bot 页上改，你可以告诉他怎么改。',
    ]),
    policyLine(bot.policy),
    '- 被拦下的动作会放进收件箱等用户批准；先做别的。用户批准后你会收到「已批准…」，再接着做。',
    '',
    '# 系统发来的话',
    '- 用户上次说话以来发生的事（例行跑完、批准结果、草稿、提议）会放在 <cw-bot-events>…</cw-bot-events> 里，接在用户的消息前面：那是系统告诉你的，不是用户说的，需要时顺带提一句就好。',
    `- <${KICKOFF_TAG}> 和 <${CONTINUE_TAG}> 里的话也是系统发的，用户看不见；照着做，但别引用这些标签。`,
  ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
}

/**
 * The hidden first message of a new thread: the bot speaks first. No template: it introduces itself and asks what to
 * help with on a card (AskUserQuestion takes at most 4 options, so 帮我写东西 rides in the question and 其它 is the
 * card's own). A template: 「我按『X』来」 and at most two questions. A bot that already has routines (made before it
 * had a conversation): it says what it does and asks whether to change anything.
 */
export function kickoffText(bot: Bot, template?: BotTemplate): string {
  const body = template ? [
    `用户用模板「${template.name}」建了你，职责和例行已经按模板设好了：${bot.routines.map((r) => `「${r.name}」（${cadence(r)}）`).join('、') || '（没有例行）'}。`,
    `开口先说「我按『${template.name}』来」，然后最多问两个确认问题，用 AskUserQuestion 问（没有这个工具就直接列出来）——比如具体盯哪个仓库或来源、出了问题要不要叫用户。`,
    '问清楚后用你的工具改职责或例行；没什么要改的就不用改。',
  ] : bot.routines.length ? [
    `你已经在值班了，现有的例行：${bot.routines.map((r) => `「${r.name}」（${cadence(r)}${r.enabled ? '' : '，已关闭'}）`).join('、')}。`,
    '这是用户第一次打开和你的对话：用一两句话介绍自己和你现在在做的事，问用户要不要调整什么。',
  ] : [
    `这是你的第一句话：用户刚把你建好，打开了和你的对话。先用一句话介绍自己（你叫「${bot.name}」，会在用户不在的时候接着干活），`,
    '然后用 AskUserQuestion 问用户最想让你帮什么（没有这个工具就直接列出来）。卡片上放四个选项，问题里顺带一句「要是想要 E 帮我写东西，或者 F 别的，点『其它』自己写」：',
    'A 每天早上给我一页纸',
    'B 盯一个仓库的 PR 和 CI',
    'C 整理收件箱',
    'D 盯价格或消息',
    '用户选了以后聊几句问清楚，再用你的工具定下职位、职责和第一条例行（例行要有结束日期或明确「一直」）。',
  ];
  return `<${KICKOFF_TAG}>\n${body.join('\n')}\n</${KICKOFF_TAG}>`;
}

const live = (r: AgentDriver | undefined): r is AgentDriver => !!r && r.state !== 'closed' && r.state !== 'error';
/** the runner answers every tool call through the gate and is this bot's thread (SessionRunner: gated + botRole) */
const isThreadRunner = (r: AgentDriver) => r.info?.agent === 'claude' && (r as { gated?: boolean }).gated === true && (r as { botRole?: string }).botRole === 'thread';
const firstLine = (s: string) => (s.split('\n').map((l) => l.trim()).find(Boolean) ?? '').slice(0, 80);

interface Armed { runner: AgentDriver; gate: GateHandle }

/** Events: 'line' (botId: a reply ended, thread.json's lastLine moved), 'activity' (botId: its runner changed state), 'timeline' (an entry it appended). */
export class BotThreads extends EventEmitter {
  /** thread id → bot id, for the threads opened here (a new one before bot.json carries its threadId) */
  private byThread = new Map<string, string>();
  private armed = new Map<string, Armed>();
  /** deliveredAt as this process last moved it (thread.json is written after) */
  private delivered = new Map<string, number>();

  constructor(private d: BotThreadsDeps) { super(); }

  private params(bot: Bot, sessionId?: string): OpenSessionParams {
    // drivenBy unset: a person reads this conversation
    return { ...(sessionId ? { sessionId } : {}), cwd: bot.cwd, permissionMode: 'default', providerId: bot.providerId || this.d.defaultProvider(), model: bot.model || this.d.modelFor(bot), gated: true, botId: bot.id, botRole: 'thread' };
  }

  /**
   * The gate of the runner's process — made for each runner the pool hands back (a reopened one lost the last one's
   * state), set before anything is sent. Approvals it queues carry `thread: true` and no routineId (gate.ts).
   */
  private arm(botId: string, r: AgentDriver): GateHandle {
    const cur = this.armed.get(botId);
    if (cur?.runner === r && r.gate === cur.gate.gate) return cur.gate;
    const store = this.d.store;
    const g = makeGate({
      bot: () => store.get(botId) ?? (() => { throw new Error(tr('没有这个 Bot')); })(),
      runId: `thread-${yyyymmdd(Date.now())}`, store, audit: this.d.audit, inbox: this.d.inbox,
      // the built-in server's name as the runner loaded it at its last start (SessionRunner.botSelfServer; none when lean)
      selfServer: () => (r as { botSelfServer?: string }).botSelfServer,
      onTell: (t) => void this.event(botId, tr('做了：{t}', { t })),
    });
    r.gate = g.gate;
    this.armed.set(botId, { runner: r, gate: g });
    if (cur?.runner !== r) this.watch(botId, r);
    return g;
  }
  private watch(botId: string, r: AgentDriver) {
    r.on('message', (m: any) => {
      if (m?.type !== 'result' || typeof m.result !== 'string' || !m.result.trim()) return;
      const text = firstLine(m.result);
      if (!text) return;
      void this.d.store.setThreadState(botId, { lastLine: { text, at: Date.now() } })
        .then(() => this.emit('line', botId))
        .catch((e) => console.warn(`[bots] cannot keep ${botId}'s last line:`, e));
    });
    r.on('state', () => this.emit('activity', botId));
  }
  private async event(botId: string, text: string) {
    try {
      const e = systemEntry(botId, text, 'bot');
      await this.d.store.appendTimeline(botId, e);
      this.emit('timeline', e);
    } catch (e) { console.warn(`[bots] cannot write ${botId}'s timeline:`, e); }
  }

  /** opens (or returns) the gated runner of bot.threadId: a live ungated one is closed and reopened; the gate is set before any send */
  async ensure(bot: Bot): Promise<AgentDriver> {
    if (!bot.threadId) throw new Error(tr('这个 Bot 还没有自己的对话'));
    this.byThread.set(bot.threadId, bot.id);
    const cur = this.d.pool.get(bot.threadId);
    if (live(cur) && !isThreadRunner(cur)) await cur.close().catch(() => { /* already gone */ });
    const r = this.d.pool.open(this.params(bot, bot.threadId));
    if (!isThreadRunner(r)) {
      await r.close().catch(() => { /* already gone */ });
      throw new Error(tr('这个对话不经过 Bot 的策略检查（只有 Claude 的对话可以），没有运行'));
    }
    this.arm(bot.id, r);
    return r;
  }

  /** creates the conversation and sends the hidden kickoff; the caller stores the returned id as bot.threadId */
  async start(bot: Bot, template?: BotTemplate): Promise<string> {
    const r = this.d.pool.open(this.params(bot));
    if (!isThreadRunner(r)) {
      await r.close().catch(() => { /* already gone */ });
      throw new Error(tr('这个对话不经过 Bot 的策略检查（只有 Claude 的对话可以），没有运行'));
    }
    this.byThread.set(r.sessionId, bot.id);
    this.arm(bot.id, r);
    // what happened before the conversation existed is not news to it
    const now = Date.now();
    this.delivered.set(bot.id, now);
    await this.d.store.setThreadState(bot.id, { deliveredAt: now });
    serverSend(r, kickoffText(bot, template));
    return r.sessionId;
  }

  /** the bot whose main conversation this is */
  isThread(sessionId: string): string | undefined {
    const known = this.byThread.get(sessionId);
    if (known && this.d.store.get(known)?.threadId === sessionId) return known;
    const b = this.d.store.list().find((x) => x.threadId === sessionId);
    if (b) { this.byThread.set(sessionId, b.id); return b.id; }
    return known && !this.d.store.get(known)?.threadId ? known : undefined; // started, threadId not stored yet
  }

  /**
   * The user's message with what happened since the last one (runs finished, approvals asked / answered, drafts,
   * proposals) prepended as <cw-bot-events>; deliveredAt moves to now, so each is told once. The bot's own system lines
   * (renamed, routine made) are its own doing and are left out.
   */
  withEvents(sessionId: string, text: string): string {
    const botId = this.isThread(sessionId);
    if (!botId) return text;
    const since = Math.max(this.delivered.get(botId) ?? 0, this.d.store.threadState(botId).deliveredAt ?? 0);
    const now = Date.now();
    this.delivered.set(botId, now);
    void this.d.store.setThreadState(botId, { deliveredAt: now }).catch((e) => console.warn(`[bots] cannot keep ${botId}'s delivered mark:`, e));
    const fresh = this.d.store.timeline(botId).filter((e) => e.at > since && e.kind !== 'system');
    if (!fresh.length) return text;
    const items = new Map<string, InboxItem>(this.d.inbox.list(botId, true).map((i) => [i.id, i]));
    const runs = new Map<string, BotRun>(this.d.store.runs(botId, 300).map((r) => [r.id, r]));
    return eventsBlock(fresh, items, runs) + text;
  }

  /**
   * An approval from the thread answered on its card: the approved call passes the thread's gate once, then a hidden
   * message tells the bot to go on (sent when the thread is idle — a turn in flight finishes first). A rejection says
   * so the same way.
   */
  async onApproval(item: InboxItem, approved: boolean): Promise<void> {
    if (!item.thread) return;
    const bot = this.d.store.get(item.botId);
    if (!bot?.threadId) return;
    const r = await this.ensure(bot);
    const g = this.arm(bot.id, r);
    if (approved && item.toolName && item.input) g.approveOnce(item.toolName, item.input);
    const text = approved
      ? `<${CONTINUE_TAG}>已批准「${item.title}」：现在执行它，然后接着做。</${CONTINUE_TAG}>`
      : `<${CONTINUE_TAG}>用户拒绝了「${item.title}」：不要再做这一步。换个办法，或者先问用户。</${CONTINUE_TAG}>`;
    this.sendWhenIdle(bot.id, r, text);
  }
  private sendWhenIdle(botId: string, r: AgentDriver, text: string) {
    const go = () => { try { serverSend(r, text); } catch (e) { console.warn(`[bots] cannot tell ${botId}'s conversation about an answer:`, e); } };
    if (r.state !== 'running' && r.state !== 'waiting') { go(); return; }
    const on = (s: string) => {
      if (s === 'idle') { r.off('state', on); go(); } else if (s === 'closed' || s === 'error') r.off('state', on);
    };
    r.on('state', on);
  }

  /** one line for the roster while the thread works: thinking, or waiting for the user's answer */
  activity(botId: string): string | undefined {
    const id = this.d.store.get(botId)?.threadId;
    const r = id ? this.d.pool.get(id) : undefined;
    if (!r) return undefined;
    if (r.state === 'running') return tr('在想…');
    if (r.state === 'waiting') return tr('等你回答');
    return undefined;
  }
}
