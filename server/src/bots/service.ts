// 值班 Bot: the server's face for bots. Owns the one BotStore / Inbox / AuditLog / BotScheduler of its data dir,
// answers the `bots.*` requests, raises the events the hub broadcasts, and pushes inbox items / reports to IM chats.
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import type { AuditRow, Bot, BotDraft, BotGenerated, BotLoad, BotOutput, BotRun, BotStatus, BotTemplate, BotTier, InboxAnswer, InboxItem, OpenSessionParams } from '../protocol.js';
import type { RunnerPool } from '../runtime/pool.js';
import type { MemoryService } from '../memory/service.js';
import type { LedgerService } from '../usage/ledger.js';
import type { MetaStore } from '../meta/store.js';
import { BotStore } from './store.js';
import { Inbox } from './inbox.js';
import { AuditLog } from './audit.js';
import { BotScheduler } from './scheduler.js';
import { generateBot } from './generate.js';
import { BOT_TEMPLATES } from './templates.js';
import { botFields } from './shape.js';
import fs from 'node:fs';
import { atomicWrite } from '../agent-config/backup.js';
import { tr } from '../i18n/index.js';

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
  memory: Pick<MemoryService, 'search'>;
  ledger: Pick<LedgerService, 'rowsFor'>;
  meta: Pick<MetaStore, 'settings'>;
  im?: {
    sendTo(gatewayId: string, chatId: string, text: string, buttons?: ImButton[]): Promise<void>;
    onCallback(prefix: string, h: (parts: string[], ctx?: { gatewayId: string; chatId: string }) => Promise<string>): void;
  };
  /** undefined providerId = the default a new conversation gets; absent = 'other' */
  providerKind?(providerId: string | undefined): ProviderKind;
}

/** `gated` is server-set (a bot's run): a request from a window never gets to set it */
export function clientSessionParams(p: OpenSessionParams): OpenSessionParams {
  if (!('gated' in p)) return p;
  const { gated: _drop, ...rest } = p;
  return rest;
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
/** Events: 'changed' (BotStatus[]), 'run' (BotRun), 'inbox' (InboxItem), 'load' (BotLoad). */
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
  };
  private watcher?: fs.FSWatcher;
  private taking = false;

  constructor(private d: BotServiceDeps) {
    super();
    const sh = acquire(d.dataDir);
    this.store = sh.store; this.inbox = sh.inbox; this.audits = sh.audit;
    this.scheduler = new BotScheduler({
      store: this.store, audit: this.audits, inbox: this.inbox,
      open: (p) => d.pool.open(p),
      memories: (botId, q) => d.memory.search({ scope: 'bot', botId, q, limit: 8 }).map((m) => m.text),
      costOf: async (sid) => (await d.ledger.rowsFor(sid)).reduce((a, r) => a + (r.costUsd ?? 0), 0),
      defaultProvider: () => this.defaultProvider(),
      concurrency: () => { const n = Number(d.meta.settings()['bots.concurrency'] ?? 2); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2; },
      globalBudgetUsd: () => { const g = d.meta.settings()['bots.globalBudgetUsd']; return typeof g === 'number' && g > 0 ? g : undefined; },
      modelFor: (bot) => this.modelFor(bot.tier, bot.providerId),
    });
    this.scheduler.on('run', (run: BotRun) => { this.emit('run', run); this.deliverRun(run); });
    this.scheduler.on('bots', () => {
      if (this.scheduler.canAct() && !this.store.get(MANAGER_ID)) void this.ensureManager().catch((e) => console.warn('[bots] cannot create the manager:', e));
      this.emit('changed', this.list());
    });
    this.scheduler.on('load', (l: BotLoad) => this.emit('load', l));
    this.scheduler.on('tick', () => void this.takeStopRequest());
    this.held = this.readHeld();
    this.inbox.on('item', this.onItem);
    d.im?.onCallback('bots', (parts, ctx) => this.onImCallback(parts, ctx));
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
    const k = dirKey(this.d.dataDir); const s = shared.get(k);
    if (s && --s.refs <= 0) shared.delete(k);
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
    return { ...bot, state, todayUsd: this.scheduler.todayUsd(bot.id), weekUsd: this.scheduler.weekUsd(bot.id), pendingInbox: pending.length, trust };
  }
  list(): BotStatus[] { return this.store.list().map((b) => this.statusOf(b)); }
  get(id: string): BotStatus { return this.statusOf(this.must(id)); }

  async create(draft: BotDraft['bot']): Promise<BotStatus> {
    await this.acting();
    await this.ensureManager();
    const now = Date.now();
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
    if (this.scheduler.canAct()) { await this.scheduler.stopAll(); return null; }
    return this.requestStop('*');
  }
  private async requestStop(ids: string[] | '*') {
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
      if (req.botIds === '*') await this.scheduler.stopAll();
      else if (Array.isArray(req.botIds)) for (const id of req.botIds) if (typeof id === 'string') await this.scheduler.stopBot(id);
    } catch (e) { console.warn('[bots] stop request:', e); } finally { this.taking = false; }
  }

  inboxList(botId?: string, includeDone = false): InboxItem[] { return this.inbox.list(botId, includeDone); }
  /** checked before anything is written; the item's 'item' event reaches the windows as bots.inbox */
  async inboxAnswer(a: InboxAnswer): Promise<InboxItem> {
    await this.acting();
    const item = await this.inbox.answer(a);
    try { await this.scheduler.onInboxAnswer(item, a); } catch (e) {
      // what the answer should start didn't happen (the lease went, a write failed): the item is pending again, so an
      // approval is never spent without its effect
      await this.inbox.reopen(item.id).catch(() => {});
      throw e;
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

  /** one sentence → a draft, on the strongest model the default provider has */
  generate(text: string, cwd: string): Promise<BotGenerated> {
    return generateBot({ open: (p) => this.d.pool.open(p), defaultProvider: () => this.defaultProvider(), model: () => this.modelFor('best', undefined) }, text, cwd);
  }
  templates(): BotTemplate[] { return BOT_TEMPLATES; }
  load(): BotLoad { return this.scheduler.load(); }

  // ---------- IM ----------
  private imOutputs(bot: Bot) { return bot.outputs.filter((o): o is Extract<BotOutput, { kind: 'im' }> => o.kind === 'im'); }
  private push(bot: Bot, text: string, buttons?: ImButton[]) {
    const outs = this.imOutputs(bot);
    if (!outs.length || !this.d.im) return;
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
