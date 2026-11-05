// 后台 (spec 2026-10-12-background-office-design.md): every conversation's background as the server keeps it, and
// the page over the main area. A small store of its own, like the automation page's; nothing goes into store/index.ts.
import { create } from 'zustand';
import type { BgSession, ServerEvent } from '@shared';
import { hideSheet, setBgStopNote, useStore } from '@/store';
import { ws } from '@/ws/client';
import { closeOtherPages, registerPage } from '@/features/sections/pages';
import { markPageOpened } from '@/features/automation/state';
import { hasLive, reopenRun, sortSessions, stopNote } from './model';
import { tr } from '@/i18n';

export interface BgDrawer { sessionId: string; taskId: string; agentKey: string; runId?: string }

interface BackgroundState {
  open: boolean;
  /** opened at least once: the page stays mounted from then on (hidden, never unmounted) */
  seen: boolean;
  /** the server's background of every conversation that has had any (since it started; ended ones for a day) */
  sessions: Record<string, BgSession>;
  /** the conversation the page shows */
  selected?: string;
  /** one task of it in the office / graph (a workflow card's 打开), or all of them */
  taskId?: string;
  /** a finished run read from disk (the sidebar's history) in place of the live tasks */
  runId?: string;
  /** an agent's own conversation, open at the page's side */
  drawer?: BgDrawer;
}

export const useBackground = create<BackgroundState>(() => ({ open: false, seen: false, sessions: {} }));

/** The conversation to show when none was asked for: one with something running, else the latest. */
function defaultSelection(): string | undefined {
  const s = useBackground.getState();
  if (s.selected && s.sessions[s.selected]) return s.selected;
  const active = useStore.getState().activeId;
  if (active && s.sessions[active]) return active;
  return sortSessions(Object.values(s.sessions))[0]?.sessionId;
}

/** Show the page — on a conversation (and one of its tasks), or the one shown last. Returns true: it is on screen. */
export function openBackground(sessionId?: string, taskId?: string): boolean {
  closeOtherPages('background');
  if (!useBackground.getState().open) markPageOpened();
  const selected = sessionId ?? defaultSelection();
  useBackground.setState((s) => ({
    open: true,
    seen: true,
    selected,
    taskId: sessionId ? taskId : s.taskId,
    runId: reopenRun({ asked: sessionId, selected, was: s.selected, runId: s.runId, sessions: s.sessions }),
    drawer: sessionId && s.drawer?.sessionId !== sessionId ? undefined : s.drawer,
  }));
  if (useStore.getState().mobile) { useStore.setState({ sidebarOpen: false }); hideSheet(); }
  return true;
}

export function closeBackground(): void {
  if (useBackground.getState().open) useBackground.setState({ open: false });
}

export function selectBackground(sessionId: string, o: { taskId?: string; runId?: string } = {}): void {
  useBackground.setState((s) => ({ selected: sessionId, taskId: o.taskId, runId: o.runId, drawer: s.drawer?.sessionId === sessionId ? s.drawer : undefined }));
}

export function openAgent(d: BgDrawer): void { useBackground.setState({ drawer: d }); }
export function closeAgent(): void { useBackground.setState({ drawer: undefined }); }

export function stopTask(sessionId: string, taskId: string): void {
  void ws.request({ kind: 'session.stopTask', sessionId, taskId }).catch((e: any) => useStore.getState().toast(tr('停止失败：{message}', { message: e?.message ?? e })));
}

/** Whether a conversation has background work running (the composer's pill, the 停止 note). */
export const useBgSession = (sessionId: string | undefined) => useBackground((s) => (sessionId ? s.sessions[sessionId] : undefined));
export const bgLive = (sessionId: string | undefined) => hasLive(sessionId ? useBackground.getState().sessions[sessionId] : undefined);

registerPage('background', { isOpen: () => useBackground.getState().open, close: closeBackground, subscribe: (fn) => useBackground.subscribe(fn) });

let installed = false;

/** App mounts this once: the list on every (re)connect, then each conversation's pushes. */
export function installBackground(): void {
  if (installed) return;
  installed = true;
  const refresh = () => {
    void ws.request<BgSession[]>({ kind: 'background.list' }).then((list) => {
      const sessions: Record<string, BgSession> = {};
      for (const s of list ?? []) sessions[s.sessionId] = s;
      useBackground.setState({ sessions });
    }).catch(() => { /* an older server: no 后台 */ });
  };
  ws.on((e: ServerEvent) => {
    if (e.kind === 'hello') { refresh(); return; }
    if (e.kind !== 'background.changed') return;
    // nothing left (the server pruned its ended tasks): the conversation leaves the page and the 网吧
    if (!e.session.tasks.length) {
      useBackground.setState((s) => {
        if (!(e.session.sessionId in s.sessions)) return s;
        const { [e.session.sessionId]: _gone, ...rest } = s.sessions;
        return { sessions: rest };
      });
      return;
    }
    useBackground.setState((s) => ({ sessions: { ...s.sessions, [e.session.sessionId]: e.session } }));
  });
  refresh();
  setBgStopNote((sid) => stopNote(useBackground.getState().sessions[sid]));
  // ui-smoke / debugging: put a conversation's background in without a CLI (the server's next push replaces it)
  (window as any).__cwBackground = {
    inject: (session: BgSession) => useBackground.setState((s) => ({ sessions: { ...s.sessions, [session.sessionId]: session } })),
    state: () => useBackground.getState(),
    open: openBackground,
  };
}
