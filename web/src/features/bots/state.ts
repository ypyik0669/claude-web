// 值班 Bot (spec 2026-10-30-duty-bots-design): the bots, their inbox, runs and load as the server keeps them, and the
// Bot page over the main area. A small store of its own, like the 后台 page's; nothing goes into store/index.ts.
import { create } from 'zustand';
import type { AuditRow, Bot, BotLoad, BotRun, BotStatus, BotTemplate, BotTimelineEntry, InboxAnswer, InboxItem, ServerEvent } from '@shared';
import { hideSheet, useStore } from '@/store';
import { ws } from '@/ws/client';
import { closeOtherPages, registerPage } from '@/features/sections/pages';
import { markPageOpened } from '@/features/automation/state';
import { tr } from '@/i18n';
import { soleBot } from './roster-model';

export type BotProfileSection = 'profile' | 'computer' | 'routines' | 'policy' | 'memory' | 'usage';

export interface BotsState {
  open: boolean;
  /** opened at least once: the page stays mounted from then on (hidden, never unmounted) */
  seen: boolean;
  bots: BotStatus[];
  /** the bot whose conversation shows */
  selected?: string;
  /** the middle column: the selected bot's conversation, or the New Bot page */
  view: 'thread' | 'new';
  /** the profile column (right) is showing; hidden, never unmounted */
  profileOpen: boolean;
  /** the profile section it was left on (scrolled back into view when it opens again) */
  profileSection: BotProfileSection;
  /** a phone shows one of these at a time (all three stay mounted) */
  phoneScreen: 'roster' | 'thread' | 'profile';
  /** each bot's timeline (system events, run / approval / draft / proposal cards), oldest first */
  timeline: Record<string, BotTimelineEntry[]>;
  /** the inbox (pending ones, and whatever done ones the server sent) */
  inbox: InboxItem[];
  /** how many of `inbox` are not done — kept with it so a selector reads a number */
  pending: number;
  /** each bot's runs, newest first (at most RUNS_KEEP) */
  runs: Record<string, BotRun[]>;
  load: BotLoad;
  templates: BotTemplate[];
}

const RUNS_KEEP = 200;
const EMPTY_LOAD: BotLoad = { running: 0, queued: 0, todayUsd: 0, weekEstimateUsd: 0, concurrency: 0 };

export const useBots = create<BotsState>(() => ({
  open: false, seen: false, bots: [], view: 'thread', profileOpen: false, profileSection: 'profile', phoneScreen: 'roster', timeline: {},
  inbox: [], pending: 0, runs: {}, load: EMPTY_LOAD, templates: [],
}));

/** what waits for a decision (a run's finding is its card in the bot's conversation, not something to decide) */
const pendingOf = (inbox: InboxItem[]) => inbox.filter((i) => !i.done && i.kind !== 'finding').length;

/** Replace the inbox (and its count) in one go. */
function setInbox(inbox: InboxItem[]): void { useBots.setState({ inbox, pending: pendingOf(inbox) }); }

/** An item the server pushed: the same id replaces, a new one goes first. */
function upsertInbox(item: InboxItem): void {
  const cur = useBots.getState().inbox;
  const i = cur.findIndex((x) => x.id === item.id);
  setInbox(i >= 0 ? cur.map((x, k) => (k === i ? item : x)) : [item, ...cur]);
}

/** A run the server pushed: the same id replaces, a new one goes first; a bot keeps its latest RUNS_KEEP. */
function upsertRun(run: BotRun): void {
  useBots.setState((s) => {
    const cur = s.runs[run.botId] ?? [];
    const i = cur.findIndex((x) => x.id === run.id);
    const next = i >= 0 ? cur.map((x, k) => (k === i ? run : x)) : [run, ...cur].slice(0, RUNS_KEEP);
    return { runs: { ...s.runs, [run.botId]: next } };
  });
}

/** Merge entries into a bot's timeline: the same id replaces in place, the rest go in by time (oldest first). */
function mergeTimeline(cur: BotTimelineEntry[], add: BotTimelineEntry[]): BotTimelineEntry[] {
  const byId = new Map(cur.map((e) => [e.id, e] as const));
  for (const e of add) byId.set(e.id, e);
  // a Map keeps the first insertion's place, and the sort is stable: equal times keep their order
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

/** Timeline entries the server pushed or sent: a bot's array changes only when one of its entries came. */
function upsertTimeline(entries: BotTimelineEntry[]): void {
  if (!entries.length) return;
  useBots.setState((s) => {
    const by: Record<string, BotTimelineEntry[]> = {};
    for (const e of entries) (by[e.botId] ??= []).push(e);
    const timeline = { ...s.timeline };
    for (const [botId, add] of Object.entries(by)) timeline[botId] = mergeTimeline(timeline[botId] ?? [], add);
    return { timeline };
  });
}

/** A bot's fields as known here, before the server's bots.changed says the same. */
function patchBot(id: string, patch: Partial<BotStatus>): void {
  useBots.setState((s) => (s.bots.some((b) => b.id === id) ? { bots: s.bots.map((b) => (b.id === id ? { ...b, ...patch } : b)) } : {}));
}

/** Show the page — on a bot, or as it was left. Returns true: it is on screen. */
export function openBots(id?: string): boolean {
  closeOtherPages('bots');
  if (!useBots.getState().open) markPageOpened();
  // a phone opens on the roster (its first screen) unless it is opened on a bot — or there is only one bot besides
  // the manager: then straight into its conversation (no roster of one)
  const mobile = useStore.getState().mobile;
  const to = id ?? (mobile ? soleBot(useBots.getState().bots) : undefined);
  useBots.setState((s) => ({ open: true, seen: true, selected: to ?? s.selected, ...(to ? { view: 'thread' as const, phoneScreen: 'thread' as const } : mobile ? { phoneScreen: 'roster' as const } : {}) }));
  if (mobile) { useStore.setState({ sidebarOpen: false }); hideSheet(); }
  return true;
}

export function closeBots(): void {
  if (useBots.getState().open) useBots.setState({ open: false });
}

/** The New Bot page in the middle column (the roster's ＋); on a phone it is the screen after the roster. */
export function showNewBot(): void {
  openBots();
  useBots.setState({ view: 'new', profileOpen: false, phoneScreen: 'thread' });
}

/** Show / hide the profile column (a phone: its own screen). `section` scrolls to that part and is remembered. */
export function showProfile(on: boolean, section?: BotProfileSection): void {
  const mobile = useStore.getState().mobile;
  useBots.setState((s) => ({
    profileOpen: on,
    ...(section ? { profileSection: section } : {}),
    ...(mobile ? { phoneScreen: on ? 'profile' as const : s.phoneScreen === 'profile' ? 'thread' as const : s.phoneScreen } : {}),
  }));
}

/** A phone's screen: the roster, the conversation (or the New Bot page), the profile. */
export function setPhoneScreen(phoneScreen: BotsState['phoneScreen']): void {
  useBots.setState({ phoneScreen, ...(phoneScreen === 'profile' ? { profileOpen: true } : phoneScreen === 'roster' ? { profileOpen: false } : {}) });
}

/** The inbox badge: how many items wait for an answer. */
export const useInboxPending = () => useBots((s) => s.pending);

const msg = (e: any) => e?.message ?? String(e);

export async function answerInbox(a: InboxAnswer): Promise<void> {
  try { await ws.request({ kind: 'bots.inbox.answer', answer: a }); } catch (e) { useStore.getState().toast(tr('处理失败：{message}', { message: msg(e) })); }
}

/** Start a routine now, quietly: null when it started, else why not. */
export async function startRun(botId: string, routineId: string): Promise<string | null> {
  try { await ws.request({ kind: 'bots.runNow', id: botId, routineId }); return null; } catch (e) { return msg(e); }
}

/** Start a routine now; a failure is toasted. True when it started. */
export async function runNow(botId: string, routineId: string): Promise<boolean> {
  const err = await startRun(botId, routineId);
  if (err !== null) useStore.getState().toast(tr('运行失败：{message}', { message: err }));
  return err === null;
}

/** A stop's answer: null when this server stopped it; `requested` when it is not the one on duty and only asked it to. */
type StopReply = { requested?: boolean; note?: string } | null;

async function stop(req: { kind: 'bots.stopAll' } | { kind: 'bots.stop'; id: string }): Promise<void> {
  try {
    const r = await ws.request<StopReply>(req);
    // only asked: say so — the runs stop when the claude-web on duty reads the request
    if (r?.requested) useStore.getState().toast(r.note || tr('已请正在值班的 claude-web 停下'), true);
  } catch (e) { useStore.getState().toast(tr('停止失败：{message}', { message: msg(e) })); }
}

export function stopAll(): Promise<void> { return stop({ kind: 'bots.stopAll' }); }

/** Stop one bot's runs (running and queued). */
export function stopBot(id: string): Promise<void> { return stop({ kind: 'bots.stop', id }); }

export async function pauseBot(id: string, paused: boolean): Promise<void> {
  try { await ws.request({ kind: 'bots.pause', id, paused }); } catch (e) { useStore.getState().toast(tr('操作失败：{message}', { message: msg(e) })); }
}

export async function deleteBot(id: string): Promise<void> {
  try { await ws.request({ kind: 'bots.delete', id }); } catch (e) { useStore.getState().toast(tr('删除失败：{message}', { message: msg(e) })); }
}

/** 放开全部 (every gate off except stop and audit) / 收回. */
export async function unleashBot(id: string, on: boolean): Promise<void> {
  try { await ws.request({ kind: 'bots.unleash', id, on }); } catch (e) { useStore.getState().toast(tr('操作失败：{message}', { message: msg(e) })); }
}

/** An edit of a bot. No local copy changes: the server answers with bots.changed. Resolves false when it failed. */
export async function updateBot(id: string, patch: Partial<Bot>): Promise<boolean> {
  try { await ws.request({ kind: 'bots.update', id, patch }); return true; } catch (e) { useStore.getState().toast(tr('保存失败：{message}', { message: msg(e) })); return false; }
}

// ---- the bot's own conversation (chat-first redesign) ----

/** A page of a bot's timeline: the newest page replaces what is here; an older one (`before`) is merged in front. Quiet on failure. */
export async function loadTimeline(id: string, before?: number): Promise<void> {
  try {
    const list = await ws.request<BotTimelineEntry[]>({ kind: 'bots.timeline.list', id, ...(before !== undefined ? { before } : {}) });
    if (!Array.isArray(list)) return;
    if (before === undefined) useBots.setState((s) => ({ timeline: { ...s.timeline, [id]: mergeTimeline([], list) } }));
    else upsertTimeline(list.map((e) => ({ ...e, botId: id })));
  } catch { /* an older server: no timeline */ }
}

/** The user has seen the bot's conversation: the server keeps that, the count here goes to 0 now. */
export async function markSeen(id: string): Promise<void> {
  patchBot(id, { unseen: 0 });
  try { await ws.request({ kind: 'bots.thread.seen', id }); } catch { /* the next bots.changed says it again */ }
}

/**
 * Show a bot's main conversation: the server opens (or makes) it, this window opens it as a conversation that is not
 * put in the layout (the thread column shows it), then it is marked seen and its timeline loaded.
 * The conversation id, or null when it failed (toasted).
 */
export async function openThread(id: string): Promise<string | null> {
  let sessionId: string;
  try {
    const r = await ws.request<{ sessionId: string }>({ kind: 'bots.thread.open', id });
    if (!r?.sessionId) throw new Error(tr('没有拿到对话'));
    sessionId = r.sessionId;
  } catch (e) { useStore.getState().toast(tr('打开失败：{message}', { message: msg(e) })); return null; }
  const bot = useBots.getState().bots.find((b) => b.id === id);
  // a phase-1 bot got its conversation just now: known here before the server's bots.changed says so
  if (bot && bot.threadId !== sessionId) patchBot(id, { threadId: sessionId });
  useBots.setState({ selected: id, view: 'thread', phoneScreen: 'thread' });
  // the bot's own conversation (the server's meta says so too, but this window read it before the bot was made): only
  // here are the server's hidden blocks hidden
  useStore.setState((s) => (s.sessionMeta[sessionId]?.botRole === 'thread' ? {} : { sessionMeta: { ...s.sessionMeta, [sessionId]: { ...s.sessionMeta[sessionId], botId: id, botRole: 'thread' } } }));
  try { await useStore.getState().openSession({ sessionId, cwd: bot?.cwd ?? '' }, 'none'); }
  catch (e) { useStore.getState().toast(tr('打开失败：{message}', { message: msg(e) })); return null; }
  await markSeen(id);
  await loadTimeline(id);
  return sessionId;
}

/** A new bot: the server makes it and its conversation (the bot speaks first), then that conversation opens. Null when it failed (toasted). */
export async function startBot(p: { name: string; avatar?: string; templateId?: string; cwd: string }): Promise<BotStatus | null> {
  let made: BotStatus | null;
  try { made = await ws.request<BotStatus>({ kind: 'bots.start', ...p }); } catch (e) { useStore.getState().toast(tr('创建失败：{message}', { message: msg(e) })); return null; }
  if (!made?.id) return null;
  const bot = made;
  useBots.setState((s) => ({ bots: s.bots.some((b) => b.id === bot.id) ? s.bots : [...s.bots, bot] }));
  await openThread(bot.id);
  return bot;
}

/** A bot's latest runs from the server (replacing what the pushes collected so far). Quiet when the server has none. */
export async function loadRuns(botId: string): Promise<void> {
  try {
    const list = await ws.request<BotRun[]>({ kind: 'bots.runs.list', botId, limit: RUNS_KEEP });
    if (Array.isArray(list)) useBots.setState((s) => ({ runs: { ...s.runs, [botId]: list.slice(0, RUNS_KEEP) } }));
  } catch { /* an older server: the pushes are all there is */ }
}

/** One run's audit rows (every tool call the gate saw). Throws when the server can't answer. */
export async function loadAudit(botId: string, runId: string): Promise<AuditRow[]> {
  const rows = await ws.request<AuditRow[]>({ kind: 'bots.runs.audit', botId, runId });
  return Array.isArray(rows) ? rows : [];
}

registerPage('bots', { isOpen: () => useBots.getState().open, close: closeBots, subscribe: (fn) => useBots.subscribe(fn) });

let installed = false;

/** App mounts this once: everything on every (re)connect, then the server's pushes. */
export function installBots(): void {
  if (installed) return;
  installed = true;
  // an older server has no bots: every request just fails quietly
  const refresh = () => {
    void ws.request<BotStatus[]>({ kind: 'bots.list' }).then((bots) => useBots.setState({ bots: bots ?? [] })).catch(() => {});
    void ws.request<InboxItem[]>({ kind: 'bots.inbox.list' }).then((items) => setInbox(items ?? [])).catch(() => {});
    void ws.request<BotLoad>({ kind: 'bots.load' }).then((load) => { if (load) useBots.setState({ load }); }).catch(() => {});
    void ws.request<BotTemplate[]>({ kind: 'bots.templates' }).then((templates) => useBots.setState({ templates: templates ?? [] })).catch(() => {});
  };
  ws.on((e: ServerEvent) => {
    switch (e.kind) {
      case 'hello': refresh(); return;
      case 'bots.changed': useBots.setState({ bots: e.bots }); return;
      case 'bots.run': upsertRun(e.run); return;
      case 'bots.inbox': upsertInbox(e.item); return;
      case 'bots.load': useBots.setState({ load: e.load }); return;
      case 'bots.timeline': upsertTimeline([e.entry]); return;
    }
  });
  refresh();
  // ui-smoke / debugging: put bots / inbox / runs / timeline in without a server (the server's next push replaces them)
  (window as any).__cwBots = {
    inject: (p: { bots?: BotStatus[]; inbox?: InboxItem[]; runs?: BotRun[]; load?: BotLoad; timeline?: BotTimelineEntry[] }) => {
      if (p.bots) useBots.setState({ bots: p.bots });
      if (p.inbox) setInbox(p.inbox);
      for (const r of p.runs ?? []) upsertRun(r);
      if (p.load) useBots.setState({ load: p.load });
      if (p.timeline) upsertTimeline(p.timeline);
    },
    state: () => useBots.getState(),
    open: openBots,
  };
}
