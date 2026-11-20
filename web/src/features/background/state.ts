// 后台 (spec 2026-10-12-background-office-design.md): every conversation's background as the server keeps it, and
// the page over the main area. A small store of its own, like the automation page's; nothing goes into store/index.ts.
import { create } from 'zustand';
import type { BgSession, BgTask, ServerEvent } from '@shared';
import { hideSheet, setBgStopNote, useStore } from '@/store';
import { ws } from '@/ws/client';
import { closeOtherPages, registerPage } from '@/features/sections/pages';
import { markPageOpened } from '@/features/automation/state';
import { hasLive, sortSessions, stopNote } from './model';
import { RUN_VIEW_KEY, runViewOf, type RunView } from './run-list';
import { pickHistory, useHistory } from './history-state';
import { pauseReplay, playPause, seekReplay, setReplaySpeed, stopReplay, useReplay } from './replay';
import { tr } from '@/i18n';

/** `task`: a finished run's (跑过的, or the cafe replaying one) — not in the live snapshot; `from: 'history'` is the
 *  跑过的 page's own drawer (the live list and cafe leave it alone). */
export interface BgDrawer { sessionId: string; taskId: string; agentKey: string; task?: BgTask; from?: 'history' }

/** 在跑 (every conversation's work now: the list or the cafe) or 跑过的 (every conversation's finished work). */
export type BgView = 'live' | 'history';

interface BackgroundState {
  open: boolean;
  /** opened at least once: the page stays mounted from then on (hidden, never unmounted) */
  seen: boolean;
  view: BgView;
  /** 跑过的 was shown at least once: mounted from then on, like the page */
  historySeen: boolean;
  /** a phone looking at the cafe (⋯ › 网吧): for this visit only — a phone opens 运行中 on the list (saves battery) */
  phoneCafe: boolean;
  /** the server's background of every conversation that has had any (since it started; ended ones for a day) */
  sessions: Record<string, BgSession>;
  /** the conversation the page was opened on (the composer's pill, a workflow card): the cafe follows its zone */
  selected?: string;
  /** one task of it (a workflow card's 在「后台」里看) */
  taskId?: string;
  /** asked for at this moment (`openBackground(sessionId)`): the list brings that conversation's group into view */
  focusAt?: number;
  /** an agent's own conversation, open at the page's side */
  drawer?: BgDrawer;
}

export const useBackground = create<BackgroundState>(() => ({ open: false, seen: false, view: 'live', historySeen: false, phoneCafe: false, sessions: {} }));

/** The conversation to show when none was asked for: one with something running, else the latest. */
function defaultSelection(): string | undefined {
  const s = useBackground.getState();
  if (s.selected && s.sessions[s.selected]) return s.selected;
  const active = useStore.getState().activeId;
  if (active && s.sessions[active]) return active;
  return sortSessions(Object.values(s.sessions))[0]?.sessionId;
}

/** Show the page — on a conversation (and one of its tasks), or as it was last. Returns true: it is on screen. */
export function openBackground(sessionId?: string, taskId?: string): boolean {
  closeOtherPages('background');
  if (!useBackground.getState().open) markPageOpened();
  const selected = sessionId ?? defaultSelection();
  useBackground.setState((s) => ({
    open: true,
    seen: true,
    // a conversation asked for (the pill, a card's 在「后台」里看) is its present
    view: sessionId ? 'live' : s.view,
    selected,
    taskId: sessionId ? taskId : s.taskId,
    focusAt: sessionId ? Date.now() : s.focusAt,
    drawer: sessionId && s.drawer?.sessionId !== sessionId ? undefined : s.drawer,
  }));
  if (useStore.getState().mobile) { useStore.setState({ sidebarOpen: false }); hideSheet(); }
  return true;
}

/**
 * 列表 or 网吧 as shown now. A desktop remembers the choice in meta.json (`background.view`, default 列表); a phone
 * starts each visit on the list and shows the cafe only after ⋯ › 网吧 (the 3D scene is what drains a battery). A run
 * replayed in the cafe (跑过的 › 在网吧里回放, 刚跑完的 › 回放) shows the cafe while it plays, whatever was chosen.
 */
export function useRunView(): RunView {
  const mobile = useStore((s) => s.mobile);
  const saved = useStore((s) => s.settings[RUN_VIEW_KEY]);
  const phoneCafe = useBackground((s) => s.phoneCafe);
  const replaying = useReplay((s) => s.show?.where === 'cafe');
  if (replaying) return 'cafe';
  return mobile ? (phoneCafe ? 'cafe' : 'list') : runViewOf(saved);
}

/** The 列表 / 网吧 switch (a desktop's segment, a phone's ⋯). Back to the list ends a replay in the cafe. */
export function setRunView(v: RunView): void {
  if (v === 'list' && useReplay.getState().show?.where === 'cafe') stopReplay();
  const st = useStore.getState();
  if (st.mobile) { useBackground.setState({ phoneCafe: v === 'cafe' }); return; }
  if (runViewOf(st.settings[RUN_VIEW_KEY]) !== v || st.settings[RUN_VIEW_KEY] === undefined) void st.setSetting(RUN_VIEW_KEY, v);
}

/** The page on 跑过的 (the cafe's 看全部跑过的 / a row of 刚跑完的: that row open). */
export function openHistory(pick?: string): void {
  openBackground();
  setBgView('history');
  if (pick) pickHistory(pick);
}

export function setBgView(view: BgView): void {
  useBackground.setState((s) => ({ view, historySeen: s.historySeen || view === 'history', drawer: s.drawer && (s.drawer.from === 'history') !== (view === 'history') ? undefined : s.drawer }));
}

export function closeBackground(): void {
  // (a phone's cafe was for that visit: the next one starts on the list again)
  if (useBackground.getState().open) useBackground.setState({ open: false, phoneCafe: false });
  // nobody is watching it any more
  pauseReplay();
}

/** A conversation picked in the cafe (a zone, a person): the page's own conversation from now on. */
export function selectBackground(sessionId: string, o: { taskId?: string } = {}): void {
  useBackground.setState((s) => ({ view: 'live', selected: sessionId, taskId: o.taskId, drawer: s.drawer?.sessionId === sessionId && s.drawer.from !== 'history' ? s.drawer : undefined }));
}

export function openAgent(d: BgDrawer): void { useBackground.setState({ drawer: d }); }
export function closeAgent(): void { useBackground.setState({ drawer: undefined }); }

/** Back to a conversation from the page: in front if it is open here, else loaded. */
export function openChat(sessionId: string): void {
  closeBackground();
  const st = useStore.getState();
  if (st.open[sessionId]) st.openInPane(sessionId, 'replace');
  else void st.loadHistory(sessionId);
}

/** A conversation's name as the sidebar shows it. */
export function useTitleOf(sessionId: string | undefined): string {
  return useStore((s) => {
    if (!sessionId) return '';
    const x = s.sessions.find((v) => v.sessionId === sessionId);
    return x?.customTitle || x?.title || tr('对话');
  });
}

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
    // 跑过的: the list's state, and the replay's clock (screenshots and ui-smoke put a replay at a moment)
    history: () => useHistory.getState(),
    openHistory,
    replay: { state: () => useReplay.getState(), seek: seekReplay, play: playPause, pause: pauseReplay, speed: setReplaySpeed, stop: stopReplay },
  };
}
