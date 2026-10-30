// 值班 Bot (spec 2026-10-30-duty-bots-design): the bots, their inbox, runs and load as the server keeps them, and the
// Bot page over the main area. A small store of its own, like the 后台 page's; nothing goes into store/index.ts.
import { create } from 'zustand';
import type { BotLoad, BotRun, BotStatus, BotTemplate, InboxAnswer, InboxItem, ServerEvent } from '@shared';
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
  templates: BotTemplate[];
}

const RUNS_KEEP = 200;
const EMPTY_LOAD: BotLoad = { running: 0, queued: 0, todayUsd: 0, weekEstimateUsd: 0, concurrency: 0 };

export const useBots = create<BotsState>(() => ({
  open: false, seen: false, bots: [], tab: 'routines', inbox: [], pending: 0, runs: {}, load: EMPTY_LOAD, creating: false, templates: [],
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
  useBots.setState((s) => ({ open: true, seen: true, selected: id ?? s.selected }));
  if (useStore.getState().mobile) { useStore.setState({ sidebarOpen: false }); hideSheet(); }
  return true;
}

export function closeBots(): void {
  if (useBots.getState().open) useBots.setState({ open: false });
}

export function selectBot(id: string): void { useBots.setState({ selected: id }); }

/** The inbox badge: how many items wait for an answer. */
export const useInboxPending = () => useBots((s) => s.pending);

const msg = (e: any) => e?.message ?? String(e);

export async function answerInbox(a: InboxAnswer): Promise<void> {
  try { await ws.request({ kind: 'bots.inbox.answer', answer: a }); } catch (e) { useStore.getState().toast(tr('处理失败：{message}', { message: msg(e) })); }
}

export async function runNow(botId: string, routineId: string): Promise<void> {
  try { await ws.request({ kind: 'bots.runNow', id: botId, routineId }); } catch (e) { useStore.getState().toast(tr('运行失败：{message}', { message: msg(e) })); }
}

export async function stopAll(): Promise<void> {
  try { await ws.request({ kind: 'bots.stopAll' }); } catch (e) { useStore.getState().toast(tr('停止失败：{message}', { message: msg(e) })); }
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
