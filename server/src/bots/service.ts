// 值班 Bot: the server's face for bots. Owns the one BotStore / Inbox / AuditLog / BotScheduler of its data dir,
// answers the `bots.*` requests, raises the events the hub broadcasts, and pushes inbox items / reports to IM chats.
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { AuditRow, Bot, BotDraft, BotLoad, BotOutput, BotRun, BotStatus, BotTemplate, BotTier, BotTimelineEntry, InboxAnswer, InboxItem, OpenSessionParams } from '../protocol.js';
import type { AgentDriver } from '../agents/types.js';
import type { RunnerPool } from '../runtime/pool.js';
import type { MemoryService } from '../memory/service.js';
import type { LedgerService } from '../usage/ledger.js';
import type { MetaStore } from '../meta/store.js';
import { BotStore } from './store.js';
import { Inbox } from './inbox.js';
import { AuditLog } from './audit.js';
import { BotScheduler, LEASE_STALE_MS } from './scheduler.js';
import { ledgerCost } from './pipeline.js';
import { BOT_TEMPLATES, fromTemplate } from './templates.js';
import { BotThreads, avatarFor, threadPrompt } from './thread.js';
import { entryForItem, entryForRun, systemEntry } from './timeline.js';
import { botRuntime, setBotRuntime, type BotRuntime } from './runtime-hooks.js';
import { botSelfServer, type BotSelfDeps } from './self-mcp.js';
import { allowScope, botFields } from './shape.js';
import fs from 'node:fs';
import { atomicWrite } from '../agent-config/backup.js';
import { tr } from '../i18n/index.js';
import { refusePeerUnc } from '../meta/folder-check.js';

const TIERS: unknown[] = ['cheap', 'balanced', 'best'];
const AVATAR = /^shape:(\d|1[01])\|color:\d\|seed:\d+$/;
/** a bot's tier as a 智能路由 strategy (a virtual model): only meaningful on a routing group's provider */
export function tierModel(tier: BotTier): string {
  return tier === 'cheap' ? 'smart-free' : tier === 'best' ? 'smart-performance' : 'smart-auto';
}

type ImButton = { id: string; label: string; danger?: boolean };
/** what kind of provider a conversation would run on: a 智能路由 group (tiers are its strategies), Claude (the account or an Anthropic-style profile: 'opus' is its strongest), or anything else (its own default model) */
export type ProviderKind = 'routing' | 'claude' | 'other';

export interface BotServiceDeps {
  dataDir: string;
  pool: Pick<RunnerPool, 'open' | 'get'>;
  memory: Pick<MemoryService, 'search' | 'write'>;
  ledger: Pick<LedgerService, 'rowsFor'>;
  meta: Pick<MetaStore, 'settings'>;
  im?: {
    sendTo(gatewayId: string, chatId: string, text: string, buttons?: ImButton[]): Promise<void>;
    onCallback(prefix: string, h: (parts: string[], ctx?: { gatewayId: string; chatId: string }) => Promise<string>): void;
    /** `/stop` in a chat: the bots that report there stop too */
    onStop?(h: (gatewayId: string, chatId: string) => Promise<string | undefined>): void;
  };
  /** undefined providerId = the default a new conversation gets; absent = 'other' */
  providerKind?(providerId: string | undefined): ProviderKind;
}

/** `gated` / `botId` / `botRole` are server-set (a bot's run or thread): a request from a window never gets to set them */
export function clientSessionParams(p: OpenSessionParams): OpenSessionParams {
  if (!('gated' in p) && !('botId' in p) && !('botRole' in p)) return p;
  const { gated: _drop, botId: _bot, botRole: _role, ...rest } = p;
  return rest;
}

/**
 * A bot's folder and its file outputs from another machine (a federation peer) may not be network paths: the bot's
 * conversation works in that folder and appends to those files (workspaces.add refuses the same, refusePeerUnc).
 */
export function refusePeerUncBot(b: unknown, fromPeer: boolean): void {
  if (!fromPeer || !b || typeof b !== 'object') return;
  const x = b as { cwd?: unknown; outputs?: unknown };
  refusePeerUnc(x.cwd, true);
  if (Array.isArray(x.outputs)) for (const o of x.outputs) if (o && typeof o === 'object') refusePeerUnc((o as { path?: unknown }).path, true);
}

/** 'HH:mm' local time inside [from, to) — `to` before `from` wraps past midnight */
export function inQuiet(q: Bot['quiet'], now = new Date()): boolean {
  if (!q?.from || !q.to || q.from === q.to) return false;
  const cur = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return q.from < q.to ? cur >= q.from && cur < q.to : cur >= q.from || cur < q.to;
}

/** One store / inbox per data dir in the process: Inbox serialises its writes only within one instance. */
interface Shared { store: BotStore; inbox: Inbox; audit: AuditLog; refs: number }
const shared = new Map<string, Shared>();
const dirKey = (d: string) => (process.platform === 'win32' ? path.resolve(d).toLowerCase() : path.resolve(d));
function acquire(dir: string): Shared {
  let s = shared.get(dirKey(dir));
  if (!s) {
    const store = new BotStore(dir);
    s = { store, inbox: new Inbox(store), audit: new AuditLog(store), refs: 0 };
    shared.set(dirKey(dir), s);
  }
  s.refs++;
  return s;
}

export const MANAGER_ID = 'manager';
const QUIET_FLUSH_MS = 60_000;
/** a thread approval not answered within a day expires (expireThreadApprovals) */
export const THREAD_APPROVAL_MS = 24 * 3600_000;

/** `<botsRoot>/stop.request.json`: a stop asked for in a window of a server not on duty; the holder carries it out */
export const STOP_REQUEST = 'stop.request.json';
interface StopRequest { botIds: string[] | '*'; at: number; by: number }
/** `<botsRoot>/held.json`: IM pushes held over quiet hours, per bot (they survive a restart) */
const HELD_FILE = 'held.json';

/**
 * Tier -> model (deviation from the plan, approved): a tier names a 智能路由 strategy (`tierModel`) only on a provider
 * that is the routing group; anywhere else `smart-*` would be refused. On Claude (the account, an Anthropic or
 * claude-account profile) 'best' is 'opus' and the other tiers keep the default; any other provider keeps its own
 * default model. A bot that names a model keeps it.
 */
/** Events: 'changed' (BotStatus[]), 'run' (BotRun), 'inbox' (InboxItem), 'load' (BotLoad), 'timeline' (BotTimelineEntry). */
export class BotService extends EventEmitter {
  private store: BotStore;
  private inbox: Inbox;
  private audits: AuditLog;
  private scheduler: BotScheduler;
  /** IM pushes held during a bot's quiet hours, per bot */
  private held = new Map<string, string[]>();
  private quietTimer?: NodeJS.Timeout;
  private released = false;
  private readonly onItem = (item: InboxItem) => {
    this.emit('inbox', item);
    try { this.deliverItem(item); } catch (e) { console.warn('[bots] IM delivery failed:', e); }
    // a new approval / draft / proposal gets its card on the bot's timeline (an answer is drawn live from the item)
    if (!item.done && !this.carded.has(item.id)) {
      this.carded.add(item.id);
      const e = entryForItem(item);
      if (e) void this.addEntry(e).then(() => this.changed());
    }
  };
  /** inbox items whose timeline card this service already wrote */
  private carded = new Set<string>();
  /** the bot's own conversation */
  readonly threads: BotThreads;
  /** what each bot's own conversation has cost so far, read from the ledger after each of its replies and every tick */
  private threadCost = new Map<string, number>();
  /** what a bot's main conversation gets at each process start (runtime-hooks) */
  private readonly runtime: BotRuntime = {
    selfServer: (id, self) => botSelfServer(id, self, this.selfDeps),
    threadPrompt: (id, o) => threadPrompt(this.must(id), o),
  };
  /** the bot-self tools' way in: the same leased edits, runs, inbox and memory as the windows' */
  private readonly selfDeps: BotSelfDeps = {
    get: (id) => this.store.get(id),
    edit: (id, fn) => this.edit(id, fn),
    runNow: (id, routineId) => this.runNow(id, routineId),
    remember: async (id, text) => { this.d.memory.write({ scope: 'bot', key: id, text, sourceAgent: 'bot' }); },
    propose: async (id, proposal, title) => { await this.acting(); this.must(id); return this.inbox.add({ kind: 'proposal', botId: id, title, proposal }); },
    event: async (id, text, icon, detail) => { await this.addEntry(systemEntry(id, text, icon ?? 'bot', detail)); this.changed(); },
  };
  /** threadOpen giving a bot its first conversation: one at a time per bot (two windows must not make two) */
  private opening = new Map<string, Promise<string>>();
  private watcher?: fs.FSWatcher;
  /** requestStop's read-merge-write, one at a time in this process */
  private stopChain: Promise<unknown> = Promise.resolve();
  private taking = false;

  constructor(private d: BotServiceDeps) {
    super();
    const sh = acquire(d.dataDir);
    this.store = sh.store; this.inbox = sh.inbox; this.audits = sh.audit;
    this.scheduler = new BotScheduler({
      store: this.store, audit: this.audits, inbox: this.inbox,
      open: (p) => d.pool.open(p),
      memories: (botId, q) => d.memory.search({ scope: 'bot', botId, q, limit: 8 }).map((m) => m.text),
      costOf: async (sid) => ledgerCost(await d.ledger.rowsFor(sid)),
      defaultProvider: () => this.defaultProvider(),
      concurrency: () => { const n = Number(d.meta.settings()['bots.concurrency'] ?? 2); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2; },
      globalBudgetUsd: () => { const g = d.meta.settings()['bots.globalBudgetUsd']; return typeof g === 'number' && g > 0 ? g : undefined; },
      modelFor: (bot) => this.modelFor(bot.tier, bot.providerId),
    });
    this.scheduler.on('run', (run: BotRun) => {
      this.emit('run', run); this.deliverRun(run);
      // a finished run: its card on the timeline (the id is the run's, so a re-emitted run replaces it)
      const routine = this.store.get(run.botId)?.routines.find((r) => r.id === run.routineId);
      const e = entryForRun(run, routine?.name ?? run.routineId);
      if (e) void this.addEntry(e).then(() => this.changed());
    });
    this.scheduler.on('bots', () => {
      if (this.scheduler.canAct() && !this.store.get(MANAGER_ID)) void this.ensureManager().catch((e) => console.warn('[bots] cannot create the manager:', e));
      this.emit('changed', this.list());
    });
    this.scheduler.on('ended', (botId: string, name: string) => {
      void this.addEntry(systemEntry(botId, tr('例行「{name}」到期，已停', { name }), 'routine')).then(() => this.changed());
    });
    this.scheduler.on('load', (l: BotLoad) => this.emit('load', l));
    this.scheduler.on('tick', () => {
      void this.takeStopRequest(); void this.refreshThreadCosts();
      void this.expireThreadApprovals().catch((e) => console.warn('[bots] cannot close expired approvals:', e));
    });
    // the last holder may have held (or flushed) IM pushes since this server read held.json
    this.scheduler.on('claimed', () => { this.held = this.readHeld(); });
    this.held = this.readHeld();
    this.inbox.on('item', this.onItem);
    this.threads = new BotThreads({
      store: this.store, inbox: this.inbox, audit: this.audits, pool: d.pool,
      defaultProvider: () => this.defaultProvider(),
      modelFor: (bot) => this.modelFor(bot.tier, bot.providerId),
    });
    this.threads.on('line', (botId: string) => { void this.refreshThreadCost(botId).finally(() => this.changed()); });
    this.threads.on('activity', () => this.changed());
    this.threads.on('timeline', (e: BotTimelineEntry) => { this.emit('timeline', e); this.changed(); });
    setBotRuntime(this.runtime);
    d.im?.onCallback('bots', (parts, ctx) => this.onImCallback(parts, ctx));
    d.im?.onStop?.((g, c) => this.onImStop(g, c));
  }

  async start(): Promise<void> {
    try { if (await this.scheduler.claim()) await this.ensureManager(); } catch (e) { console.warn('[bots] start:', e); }
    this.scheduler.start();
    if (!this.watcher) {
      try {
        this.watcher = fs.watch(this.d.dataDir, (_e, f) => { if (!f || String(f) === STOP_REQUEST) void this.takeStopRequest(); });
        this.watcher.on('error', () => { /* the tick still checks */ });
      } catch (e) { console.warn('[bots] cannot watch for stop requests (the tick still checks):', e); }
    }
    void this.takeStopRequest();
    if (!this.quietTimer) { this.quietTimer = setInterval(() => void this.flushQuiet(), QUIET_FLUSH_MS); this.quietTimer.unref(); }
  }
  stop(): void {
    this.scheduler.stop();
    this.watcher?.close(); this.watcher = undefined;
    if (this.quietTimer) clearInterval(this.quietTimer);
    this.quietTimer = undefined;
    if (this.released) return;
    this.released = true;
    this.inbox.off('item', this.onItem);
    if (botRuntime() === this.runtime) setBotRuntime(null);
    const k = dirKey(this.d.dataDir); const s = shared.get(k);
    if (s && --s.refs <= 0) shared.delete(k);
  }

  /**
   * The server quitting: aborts only this server's own runs (recorded as stopped) and gives the lease back. Never a stop
   * request — a server not on duty quitting must not stop the runs of the one that is.
   */
  async shutdown(): Promise<void> {
    try { await this.scheduler.stopAll(); } finally { this.stop(); await this.scheduler.settled(); }
  }

  private defaultProvider(): string | undefined {
    const v = this.d.meta.settings()['bots.defaultProvider'];
    return typeof v === 'string' && v ? v : undefined;
  }
  /** a tier on a routing provider is its strategy; 'best' on Claude is opus; otherwise the provider's own default */
  private modelFor(tier: BotTier, providerId: string | undefined): string | undefined {
    const kind = this.d.providerKind?.(providerId || this.defaultProvider()) ?? 'other';
    if (kind === 'routing') return tierModel(tier);
    if (kind === 'claude' && tier === 'best') return 'opus';
    return undefined;
  }

  /** writes need the lease: another server on this dir would overwrite them (bot.json / inbox.json) */
  private async acting(): Promise<void> {
    if (this.scheduler.canAct() || (await this.scheduler.claim())) return;
    throw new Error(tr('另一个 claude-web 正在值班，请在那边操作'));
  }
  private must(id: string): Bot {
    const b = this.store.get(id);
    if (!b) throw new Error(tr('没有这个 Bot'));
    return b;
  }
  private changed() { this.emit('changed', this.list()); }

  /** 总管 (spec §2): built in, not deletable, does no work of its own in phase 1 */
  private async ensureManager() {
    if (this.store.get(MANAGER_ID)) return;
    const now = Date.now();
    await this.store.save({
      id: MANAGER_ID, name: tr('总管'), manager: true,
      charter: { role: tr('接我随口说的事，转给合适的 Bot；没有合适的就提议新建一个。'), sources: [] },
      cwd: os.homedir(), tier: 'balanced', policy: { rules: [] }, budget: { dailyUsd: 1 }, routines: [], outputs: [{ kind: 'inbox' }],
      createdAt: now, updatedAt: now,
    });
  }

  statusOf(bot: Bot): BotStatus {
    const pending = this.inbox.list(bot.id);
    const state: BotStatus['state'] = bot.paused ? 'paused'
      : pending.some((i) => i.kind === 'approval') ? 'attention'
      : this.scheduler.isRunning(bot.id) ? 'running'
      : this.scheduler.isQueued(bot.id) ? 'queued' : 'idle';
    const trust: BotStatus['trust'] = {};
    for (const [k, v] of Object.entries(this.store.trust(bot.id))) trust[k] = { approvals: v.approvals, lastAt: v.lastAt };
    const todayUsd = this.scheduler.todayUsd(bot.id), weekUsd = this.scheduler.weekUsd(bot.id);
    const thread = this.store.threadState(bot.id);
    const runs = this.store.runs(bot.id, 20).filter((r) => r.endedAt && !r.skipped).sort((a, b) => b.endedAt! - a.endedAt!);
    const last = runs[0];
    // the last line: the bot's own last reply, or a run's conclusion if that came later
    let lastLine = thread.lastLine;
    const said = last?.ok && last.said ? last.said.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 80) : undefined;
    if (said && last.endedAt! > (lastLine?.at ?? 0)) lastLine = { text: said, at: last.endedAt! };
    const unseen = this.store.timeline(bot.id).filter((e) => e.at > (thread.seenAt ?? 0)).length;
    const running = this.scheduler.runningRoutine(bot.id);
    const activity = running ? tr('在跑例行「{name}」', { name: bot.routines.find((r) => r.id === running)?.name ?? running }) : this.threads.activity(bot.id);
    const b = bot.budget;
    const error: BotStatus['error'] = b.dailyUsd !== undefined && todayUsd >= b.dailyUsd ? { reason: tr('预算用完'), next: tr('明早 0 点恢复') }
      : b.weeklyUsd !== undefined && weekUsd >= b.weeklyUsd ? { reason: tr('本周预算用完'), next: tr('在 Bot 资料里调高预算') }
      : last && last.ok === false && !last.handoff ? { reason: last.error || tr('上次运行没有成功') } : undefined;
    const threadUsd = this.threadCost.get(bot.id);
    return {
      ...bot, state, todayUsd, weekUsd, pendingInbox: pending.length, trust, unseen,
      ...(lastLine ? { lastLine } : {}), ...(activity ? { activity } : {}), ...(error ? { error } : {}), ...(threadUsd !== undefined ? { threadUsd } : {}),
    };
  }
  list(): BotStatus[] { return this.store.list().map((b) => this.statusOf(b)); }
  get(id: string): BotStatus { return this.statusOf(this.must(id)); }

  async create(draft: BotDraft['bot']): Promise<BotStatus> {
    await this.acting();
    await this.ensureManager();
    const now = Date.now();
    // a draft without a (valid) tier gets the settings' default for new bots
    if (draft && typeof draft === 'object' && !TIERS.includes((draft as { tier?: unknown }).tier)) draft = { ...draft, tier: this.defaultTier() };
    const bot = await this.store.save({ ...botFields(draft), id: this.store.newId(), createdAt: now, updatedAt: now });
    this.changed();
    return this.statusOf(bot);
  }
  /** read-modify-write in the bot.json lock; the id, the manager flag and createdAt are not the client's to change */
  private async edit(id: string, fn: (b: Bot) => Bot): Promise<BotStatus> {
    await this.acting();
    this.must(id);
    const b = await this.store.update(id, (cur) => ({ ...fn(cur), id: cur.id, manager: cur.manager, createdAt: cur.createdAt }));
    if (!b) throw new Error(tr('没有这个 Bot'));
    this.changed();
    return this.statusOf(b);
  }
  update(id: string, patch: Partial<Bot>): Promise<BotStatus> {
    return this.edit(id, (b) => {
      // only a bot's own fields, checked, merged into the stored bot around what the scheduler owns (shape.ts)
      // (a key cleared in the request is gone: the fields replace the stored ones whole)
      return { ...botFields(patch, b), id: b.id, createdAt: b.createdAt, updatedAt: b.updatedAt };
    });
  }
  pause(id: string, paused: boolean) { return this.edit(id, (b) => ({ ...b, paused })); }
  unleash(id: string, on: boolean) { return this.edit(id, (b) => ({ ...b, policy: { ...b.policy, unleashed: on } })); }
  async remove(id: string): Promise<void> {
    await this.acting();
    if (this.must(id).manager) throw new Error(tr('总管不能删除'));
    await this.scheduler.stopBot(id);
    await this.inbox.removeBot(id);
    if (this.held.delete(id)) this.saveHeld();
    await this.store.remove(id);
    this.changed();
  }

  runNow(id: string, routineId: string): Promise<void> { this.must(id); return this.scheduler.runNow(id, routineId); }
  /**
   * The hard stops (spec §5, always work): on duty they stop at once; otherwise they are written to stop.request.json
   * for the server on duty, which carries them out (it watches the dir and checks every tick).
   */
  async stopBot(id: string): Promise<{ requested: true; note: string } | null> {
    if (this.scheduler.canAct()) { await this.scheduler.stopBot(id); return null; }
    return this.requestStop([id]);
  }
  async stopAll(): Promise<{ requested: true; note: string } | null> {
    if (this.scheduler.canAct()) { await this.scheduler.stopAll({ hard: true }); return null; }
    return this.requestStop('*');
  }
  private requestStop(ids: string[] | '*') {
    const run = this.stopChain.then(() => this.writeStopRequest(ids));
    this.stopChain = run.catch(() => {});
    return run;
  }
  private async writeStopRequest(ids: string[] | '*') {
    const file = path.join(this.d.dataDir, STOP_REQUEST);
    let cur: StopRequest | undefined;
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none pending */ }
    const before = Array.isArray(cur?.botIds) ? cur.botIds : [];
    const botIds: StopRequest['botIds'] = ids === '*' || cur?.botIds === '*' ? '*' : [...new Set([...before, ...ids])];
    await atomicWrite(file, JSON.stringify({ botIds, at: Date.now(), by: process.pid } satisfies StopRequest));
    return { requested: true as const, note: tr('已请正在值班的 claude-web 停下') };
  }
  /** the holder: a stop asked for elsewhere is taken (the file removed) first, then done */
  private async takeStopRequest() {
    if (this.taking || !this.scheduler.canAct()) return;
    const file = path.join(this.d.dataDir, STOP_REQUEST);
    this.taking = true;
    try {
      let req: StopRequest;
      try { req = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
      try { fs.rmSync(file, { force: true }); } catch { /* raced */ }
      // left by a window of an earlier holder's time (a dead one): not for the runs this holder started
      const at = typeof req.at === 'number' ? req.at : 0;
      if (at < Date.now() - LEASE_STALE_MS || at < this.scheduler.holdingSince()) return;
      if (req.botIds === '*') await this.scheduler.stopAll({ hard: true });
      else if (Array.isArray(req.botIds)) for (const id of req.botIds) if (typeof id === 'string') await this.scheduler.stopBot(id);
    } catch (e) { console.warn('[bots] stop request:', e); } finally { this.taking = false; }
  }

  inboxList(botId?: string, includeDone = false): InboxItem[] { return this.inbox.list(botId, includeDone); }

  /**
   * A thread approval left a day unanswered is closed (「已过期」): answered later it would run a step out of its
   * moment (and spawn the conversation's process to do it). Every tick on duty, and before an answer.
   */
  async expireThreadApprovals(now = Date.now()): Promise<InboxItem[]> {
    if (!this.scheduler.canAct()) return [];
    return this.inbox.closeApprovals((i) => !!i.thread && now - i.at >= THREAD_APPROVAL_MS, tr('已过期'));
  }

  /** checked before anything is written; the item's 'item' event reaches the windows as bots.inbox */
  async inboxAnswer(a: InboxAnswer): Promise<InboxItem> {
    const asked = this.inbox.get(a.id);
    if (asked && !asked.done && asked.thread && asked.kind === 'approval' && a.answer !== 'archive' && Date.now() - asked.at >= THREAD_APPROVAL_MS) {
      await this.acting();
      await this.expireThreadApprovals();
      throw new Error(tr('这个请求已经过期（超过 24 小时），没有执行：要做的话，在对话里再跟它说一次'));
    }
    // the scope is checked before anything is written: a bad one leaves the item pending
    // and it must name where it applies (a payment one: up to how much) — see allowScope
    if (a.answer === 'approve_scope' && a.scope !== undefined) a = { ...a, scope: allowScope(a.scope, 'scope', this.inbox.get(a.id)?.cls) };
    await this.acting();
    // an approval's call is on disk (resumes.json) before the item reads as answered
    const open = this.inbox.get(a.id);
    // an approval from the bot's own conversation resumes no run (it goes on in the conversation, below)
    const pre = open && !open.done && !open.thread ? await this.scheduler.persistApproval(open, a) : undefined;
    let item: InboxItem;
    try { item = await this.inbox.answer(a); } catch (e) {
      if (open) await this.scheduler.unpersistApproval(open, a, pre);
      throw e;
    }
    try { await this.scheduler.onInboxAnswer(item, a, pre); } catch (e) {
      // what the answer should start didn't happen (the lease went, a write failed): the item is pending again, so an
      // approval is never spent without its effect
      await this.scheduler.unpersistApproval(item, a, pre);
      await this.inbox.reopen(item.id).catch(() => {});
      throw e;
    }
    if (item.thread && item.kind === 'approval' && a.answer !== 'archive') {
      // the answer stands whatever happens to the conversation (closed, another process): the card shows it
      await this.threads.onApproval(item, a.answer === 'approve' || a.answer === 'approve_scope').catch((e) => console.warn(`[bots] cannot carry an answer into ${item.botId}'s conversation:`, e));
    }
    if (a.answer === 'archive') this.changed(); // the others: the scheduler's 'bots'
    return item;
  }

  runs(botId?: string, routineId?: string, limit = 50): BotRun[] {
    limit = Math.min(500, Math.max(1, Math.floor(Number(limit) || 50)));
    const all = botId ? this.store.runs(botId, routineId ? 2000 : limit) : this.store.list().flatMap((b) => this.store.runs(b.id, limit));
    return all.filter((r) => !routineId || r.routineId === routineId).sort((a, b) => b.at - a.at).slice(0, limit);
  }
  audit(botId: string, runId: string): AuditRow[] { return this.store.audit(botId, runId); }

  // ---------- the bot's own conversation (chat-first) ----------
  /**
   * 新 Bot: a template's bot (its routines kept: the bot only confirms them) or a bare one, then its conversation,
   * opened with the hidden kickoff — the bot speaks first. A conversation that fails to open leaves the bot without
   * one; threadOpen makes it later.
   */
  async startBot(p: { name: string; avatar?: string; templateId?: string; cwd: string }): Promise<BotStatus> {
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (!name) throw new Error(tr('Bot 设置不对：{field}', { field: 'name' }));
    const template = p.templateId ? BOT_TEMPLATES.find((t) => t.id === p.templateId) : undefined;
    if (p.templateId && !template) throw new Error(tr('没有这个模板'));
    const base: BotDraft['bot'] = template ? fromTemplate(template.id, p.cwd)!
      : { name, charter: { role: '', sources: [] }, cwd: p.cwd, tier: undefined as unknown as BotTier, policy: { rules: [], signOff: true }, budget: { dailyUsd: 2 }, routines: [], outputs: [{ kind: 'inbox' }] };
    const avatar = typeof p.avatar === 'string' && AVATAR.test(p.avatar) ? p.avatar : avatarFor(name);
    const created = await this.create({ ...base, name, avatar });
    await this.giveThread(created.id, template);
    const now = Date.now();
    await this.addEntry(systemEntry(created.id, tr('已创建 {name}', { name }), 'bot'));
    // the user is looking at it: its first line is not news
    await this.store.setThreadState(created.id, { seenAt: now });
    this.changed();
    return this.statusOf(this.must(created.id));
  }
  /** a new conversation for the bot, its id stored as threadId; one at a time per bot */
  private giveThread(id: string, template?: BotTemplate): Promise<string> {
    const going = this.opening.get(id);
    if (going) return going;
    const run = (async () => {
      await this.acting();
      const sessionId = await this.threads.start(this.must(id), template);
      await this.edit(id, (x) => ({ ...x, threadId: sessionId }));
      return sessionId;
    })().finally(() => this.opening.delete(id));
    this.opening.set(id, run);
    return run;
  }
  /** the bot's conversation, open and gated; a bot from before it had one (phase 1) gets one now, its kickoff naming its routines */
  async threadOpen(id: string): Promise<{ sessionId: string }> {
    const bot = this.must(id);
    if (!bot.threadId) return { sessionId: await this.giveThread(id) };
    return { sessionId: (await this.threads.ensure(bot)).sessionId };
  }
  /** session.open on a bot's conversation (hub): the gated runner, whatever the window asked for */
  openThread(botId: string): Promise<AgentDriver> { return this.threads.ensure(this.must(botId)); }
  timeline(id: string, before?: number, limit?: number): BotTimelineEntry[] {
    this.must(id);
    const n = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 300)));
    return this.store.timeline(id, { ...(typeof before === 'number' && Number.isFinite(before) ? { before } : {}), limit: n });
  }
  /** the user looked at the bot: what came before now is seen */
  async seen(id: string): Promise<void> {
    this.must(id);
    await this.store.setThreadState(id, { seenAt: Date.now() });
    this.changed();
  }
  /** timeline.jsonl is written without the lease (store.ts): the thread may live on a server not on duty */
  private async addEntry(e: BotTimelineEntry): Promise<void> {
    if (!this.store.get(e.botId)) return;
    try { await this.store.appendTimeline(e.botId, e); } catch (err) { console.warn(`[bots] cannot write ${e.botId}'s timeline:`, err); return; }
    this.emit('timeline', e);
  }
  private async refreshThreadCost(botId: string): Promise<boolean> {
    const id = this.store.get(botId)?.threadId;
    if (!id) return false;
    try {
      const usd = ledgerCost(await this.d.ledger.rowsFor(id)).usd;
      if (this.threadCost.get(botId) === usd) return false;
      this.threadCost.set(botId, usd);
      return true;
    } catch { return false; }
  }
  private async refreshThreadCosts() {
    let any = false;
    for (const b of this.store.list()) if (await this.refreshThreadCost(b.id)) any = true;
    if (any) this.changed();
  }

  /** settings bots.defaultTier (省钱 / 均衡 / 最强 for new bots), else balanced */
  private defaultTier(): BotTier {
    const v = this.d.meta.settings()['bots.defaultTier'];
    return TIERS.includes(v) ? v as BotTier : 'balanced';
  }
  templates(): BotTemplate[] { return BOT_TEMPLATES; }
  load(): BotLoad { return this.scheduler.load(); }

  // ---------- IM ----------
  private imOutputs(bot: Bot) { return bot.outputs.filter((o): o is Extract<BotOutput, { kind: 'im' }> => o.kind === 'im'); }
  /** only the server on duty pushes, holds or flushes (held.json is its file) */
  private push(bot: Bot, text: string, buttons?: ImButton[]) {
    const outs = this.imOutputs(bot);
    if (!outs.length || !this.d.im || !this.scheduler.canAct()) return;
    if (inQuiet(bot.quiet)) {
      const h = this.held.get(bot.id) ?? [];
      h.push(text.split('\n')[0]);
      this.held.set(bot.id, h);
      this.saveHeld();
      return;
    }
    for (const o of outs) void this.d.im.sendTo(o.gatewayId, o.chatId, text, buttons).catch((e) => console.warn(`[bots] cannot push to ${o.gatewayId}:`, e?.message ?? e));
  }
  private readHeld(): Map<string, string[]> {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.d.dataDir, HELD_FILE), 'utf8'));
      return new Map(Object.entries(j).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).map(String)]));
    } catch { return new Map(); }
  }
  private saveHeld() {
    if (!this.scheduler.canAct()) return;
    void atomicWrite(path.join(this.d.dataDir, HELD_FILE), JSON.stringify(Object.fromEntries(this.held))).catch((e) => console.warn('[bots] cannot save held IM pushes:', e));
  }
  /** a new inbox item of a bot with an IM output; approvals get 批准 / 拒绝 buttons */
  private deliverItem(item: InboxItem) {
    // only the server on duty pushes (two services can share one Inbox in a process)
    if (item.done || !this.scheduler.canAct()) return;
    const bot = this.store.get(item.botId);
    if (!bot) return;
    const text = `【${bot.name}】${item.title}${item.body ? `\n${item.body.slice(0, 1500)}` : ''}`;
    const buttons = item.kind === 'approval' ? [{ id: `bots:approve:${item.id}`, label: tr('批准') }, { id: `bots:reject:${item.id}`, label: tr('拒绝'), danger: true }] : undefined;
    this.push(bot, text, buttons);
  }
  /** a bot that reports only to IM (no inbox output) gets its run's report there; with an inbox output the item carries it */
  private deliverRun(run: BotRun) {
    if (!run.endedAt || run.skipped || !run.ok || !run.said) return;
    const bot = this.store.get(run.botId);
    if (!bot || bot.outputs.some((o) => o.kind === 'inbox')) return;
    const routine = bot.routines.find((r) => r.id === run.routineId);
    this.push(bot, `【${bot.name} · ${routine?.name ?? run.routineId}】\n${run.said}`);
  }
  /** after a bot's quiet hours: what was held goes out as one message */
  async flushQuiet() {
    if (!this.scheduler.canAct()) return;
    for (const [botId, lines] of [...this.held]) {
      const bot = this.store.get(botId);
      if (!bot) { this.held.delete(botId); continue; }
      if (inQuiet(bot.quiet)) continue;
      this.held.delete(botId);
      this.saveHeld();
      const shown = lines.slice(-20);
      this.push(bot, `【${bot.name}】${tr('夜里有 {n} 条', { n: lines.length })}\n${shown.map((l) => `- ${l}`).join('\n')}`);
    }
  }
  /** `/stop` in a chat that is some bots' IM output: the hard stop for those bots (handed to the server on duty if need be) */
  private async onImStop(gatewayId: string, chatId: string): Promise<string | undefined> {
    const bots = this.store.list().filter((b) => this.imOutputs(b).some((o) => o.gatewayId === gatewayId && o.chatId === chatId));
    if (!bots.length) return undefined;
    for (const b of bots) await this.stopBot(b.id);
    return tr('已停下 {n} 个 Bot：{names}', { n: bots.length, names: bots.map((b) => b.name).join('、') });
  }
  private async onImCallback(parts: string[], ctx?: { gatewayId: string; chatId: string }): Promise<string> {
    const [act, id] = parts;
    const item = id ? this.inbox.get(id) : undefined;
    if (!item) return tr('收件箱里没有这一条');
    const bot = this.store.get(item.botId);
    // only the chat the bot reports to answers for it
    if (!bot || (ctx && !this.imOutputs(bot).some((o) => o.gatewayId === ctx.gatewayId && o.chatId === ctx.chatId))) return tr('这个聊天不能处理这一条');
    if (act === 'approve') { await this.inboxAnswer({ id, answer: 'approve' }); return tr('已批准'); }
    if (act === 'reject') { await this.inboxAnswer({ id, answer: 'reject' }); return tr('已拒绝'); }
    return tr('不认识的操作');
  }
}
