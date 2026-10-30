// 值班 Bot (spec 2026-10-30-duty-bots-design): the bots, their inbox, runs and load as the server keeps them, and the
// Bot page over the main area. A small store of its own, like the 后台 page's; nothing goes into store/index.ts.
import { create } from 'zustand';
import type { AuditRow, Bot, BotDraft, BotGenerated, BotLoad, BotRun, BotStatus, BotTemplate, InboxAnswer, InboxItem, ServerEvent } from '@shared';
import { hideSheet, useStore } from '@/store';
import { ws } from '@/ws/client';
import { closeOtherPages, registerPage } from '@/features/sections/pages';
import { markPageOpened } from '@/features/automation/state';
import { tr } from '@/i18n';

export type BotTab = 'routines' | 'runs' | 'policy' | 'memory' | 'self';

export interface BotsState {
  open: boolean;
  /** opened at least once: the page stays mounted from then on (hidden, never unmounted) */
  seen: boolean;
  bots: BotStatus[];
  /** the bot the detail shows */
  selected?: string;
  tab: BotTab;
  /** the inbox (pending ones, and whatever done ones the server sent) */
  inbox: InboxItem[];
  /** how many of `inbox` are not done — kept with it so a selector reads a number */
  pending: number;
  /** each bot's runs, newest first (at most RUNS_KEEP) */
  runs: Record<string, BotRun[]>;
  load: BotLoad;
  /** the create flow is showing */
  creating: boolean;
  /** the template the create flow opens on (a starter card on the empty page), else it opens on the three entries */
  createTemplate?: string;
  templates: BotTemplate[];
  /** a phone shows the inbox tab (its first screen); opening the page on a bot turns it off */
  phoneInbox: boolean;
}

const RUNS_KEEP = 200;
const EMPTY_LOAD: BotLoad = { running: 0, queued: 0, todayUsd: 0, weekEstimateUsd: 0, concurrency: 0 };

export const useBots = create<BotsState>(() => ({
  open: false, seen: false, bots: [], tab: 'routines', inbox: [], pending: 0, runs: {}, load: EMPTY_LOAD, creating: false, templates: [], phoneInbox: true,
}));

const pendingOf = (inbox: InboxItem[]) => inbox.filter((i) => !i.done).length;

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

/** Show the page — on a bot, or as it was left. Returns true: it is on screen. */
export function openBots(id?: string): boolean {
  closeOtherPages('bots');
  if (!useBots.getState().open) markPageOpened();
  // a phone opens on the inbox (its first screen) unless it is opened on a bot
  const mobile = useStore.getState().mobile;
  useBots.setState((s) => ({ open: true, seen: true, selected: id ?? s.selected, phoneInbox: id ? false : mobile ? true : s.phoneInbox }));
  if (mobile) { useStore.setState({ sidebarOpen: false }); hideSheet(); }
  return true;
}

export function closeBots(): void {
  if (useBots.getState().open) useBots.setState({ open: false });
}

/** Show a bot — on a phone that leaves the inbox tab for it. */
export function selectBot(id: string): void { useBots.setState({ selected: id, phoneInbox: false }); }

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

export function setBotTab(tab: BotTab): void { useBots.setState({ tab }); }

/** An edit of a bot. No local copy changes: the server answers with bots.changed. Resolves false when it failed. */
export async function updateBot(id: string, patch: Partial<Bot>): Promise<boolean> {
  try { await ws.request({ kind: 'bots.update', id, patch }); return true; } catch (e) { useStore.getState().toast(tr('保存失败：{message}', { message: msg(e) })); return false; }
}

/** Open the create flow — on a template's preview when one is given. */
export function startCreate(templateId?: string): void { useBots.setState({ creating: true, createTemplate: templateId }); }

/** Create a bot from a reviewed draft. The new bot, or null when it failed (toasted). */
export async function createBot(draft: BotDraft['bot']): Promise<BotStatus | null> {
  try {
    const bot = await ws.request<BotStatus>({ kind: 'bots.create', bot: draft });
    if (bot?.id) useBots.setState((s) => ({ selected: bot.id, bots: s.bots.some((b) => b.id === bot.id) ? s.bots : [...s.bots, bot] }));
    return bot ?? null;
  } catch (e) { useStore.getState().toast(tr('创建失败：{message}', { message: msg(e) })); return null; }
}

/** One sentence → a draft (the server asks a model). Null when it failed (toasted). */
export async function generate(text: string, cwd: string): Promise<BotGenerated | null> {
  try {
    const d = await ws.request<BotGenerated>({ kind: 'bots.generate', text, cwd });
    if (!d || typeof d !== 'object') throw new Error(tr('没有拿到草案'));
    return d;
  } catch (e) { useStore.getState().toast(tr('生成失败：{message}', { message: msg(e) })); return null; }
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
    }
  });
  refresh();
  // ui-smoke / debugging: put bots / inbox / runs in without a server (the server's next push replaces them)
  (window as any).__cwBots = {
    inject: (p: { bots?: BotStatus[]; inbox?: InboxItem[]; runs?: BotRun[]; load?: BotLoad }) => {
      if (p.bots) useBots.setState({ bots: p.bots });
      if (p.inbox) setInbox(p.inbox);
      for (const r of p.runs ?? []) upsertRun(r);
      if (p.load) useBots.setState({ load: p.load });
    },
    state: () => useBots.getState(),
    open: openBots,
  };
}
