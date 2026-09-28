// Opening things in the right panel (redesign phase 2, spec §5.6): the requests the 审阅 / 文件 tabs pick up (which
// scope, which file, which mode) and the one function the header ···, the palette and the 改动 button call for a
// per-session view. A small store of its own, like the orchestra's — nothing here goes into store/index.ts.
import { create } from 'zustand';
import { parsePeerId } from '@shared';
import { useStore } from '@/store';
import { currentChatTile, workbenchOn, type PanelId } from '@/model/layout';
import { PHONE_NO_PANEL, PHONE_SCHEDULES_NO_CHAT, PHONE_SCHEDULES_REMOTE } from '@/ui/terms';
import { blockRemoteOpen } from '@/features/remote-guard';
import { viewTarget, type ExplorerMode, type ReviewIntent } from './panel-entries';
import type { WbView } from './wb-views';

interface RightPanelState {
  /** the last request for the review; `n` grows so asking for the same thing twice still applies */
  review: (ReviewIntent & { n: number }) | null;
  explorer: { mode: ExplorerMode; n: number } | null;
  /** a request to unfold 任务's scheduled tasks (its `n`; 0 = none yet) */
  schedules: number;
  /** how many files the right panel's review lists right now (its tab shows the number, like the mock's 「审阅 3」) */
  reviewCount: number;
  /** a phone's in-place 改动 view: the file a change card asked for (only that conversation's in-place review takes it) */
  inPlace: { sessionId: string; path?: string; n: number } | null;
}
export const useRightPanel = create<RightPanelState>(() => ({ review: null, explorer: null, schedules: 0, reviewCount: 0, inPlace: null }));
let seq = 0;

// The functions below are the right panel's public entry points (the sidebar, the composer, the palette and the
// header call them): keep their signatures stable.

/**
 * Bring a panel to the front of the right panel (mounting it if needed; `true` when it is on screen). A phone
 * draws none: it says where things are instead and returns `false`.
 */
export function showPanel(panel: PanelId): boolean {
  const st = useStore.getState();
  if (st.mobile) { st.toast(PHONE_NO_PANEL); return false; }
  st.dispatchLayout({ t: 'dock.show', panel });
  return true;
}

/** 审阅 on a scope / commit / file, or its full Git view. */
export function openReview(intent: ReviewIntent = {}): void {
  if (showPanel('files')) useRightPanel.setState({ review: { ...intent, n: ++seq } });
}

/** 文件 on the tree, the search, or this conversation's generated files. */
export function openExplorer(mode: ExplorerMode): void {
  if (showPanel('explorer')) useRightPanel.setState({ explorer: { mode, n: ++seq } });
}

/**
 * The scheduled tasks (定时任务; the sidebar's automation entry and the like). Returns whether they are on screen.
 *  - desktop, default look: 任务 with its scheduled tasks unfolded (they sit folded at its bottom);
 *  - desktop, 「显示工作台工具」: 任务 — its list is already on top, so no request is left behind (one would unfold
 *    the fold later, when the setting is turned off);
 *  - phone (no right panel): the current conversation shows them in place (its ··· view); with no conversation, or
 *    one on another machine, a hint that says how to get there, and `false`.
 */
export function openSchedules(): boolean {
  const s = useStore.getState();
  if (s.mobile) {
    const cur = currentChatTile(s.layout);
    const tile = cur && s.layout.groups.flatMap((g) => g.panes[cur.paneId]?.tiles ?? []).find((t) => t.id === cur.tileId);
    const sid = tile?.kind === 'chat' ? tile.sessionId : null;
    if (!cur || !sid) { s.toast(PHONE_SCHEDULES_NO_CHAT); return false; }
    if (parsePeerId(sid)) { s.toast(PHONE_SCHEDULES_REMOTE); return false; }
    openSessionView('schedules', cur);
    return true;
  }
  if (!showPanel('tasks')) return false;
  if (!workbenchOn(s.settings)) useRightPanel.setState({ schedules: ++seq });
  return true;
}

/**
 * A per-session view (the old workbench tab row) from the header ··· or the palette. On a desktop the right panel
 * shows it for that conversation (its tile is brought forward, which is what the right panel follows, and goes back
 * to the conversation itself); on a phone, and for a conversation on another machine, it replaces the conversation
 * in place as before (`viewTarget`). `at`: the conversation's tile — default: the current conversation.
 */
export function openSessionView(view: WbView, at?: { paneId: string; tileId: string }): void {
  const s = useStore.getState();
  const cur = at ?? currentChatTile(s.layout);
  const tile = cur && s.layout.groups.flatMap((g) => g.panes[cur.paneId]?.tiles ?? []).find((t) => t.id === cur.tileId);
  if (!cur || tile?.kind !== 'chat' || !tile.sessionId) { s.toast('先打开一个对话'); return; }
  const target = viewTarget(view, { mobile: s.mobile, remote: !!parsePeerId(tile.sessionId) });
  s.dispatchLayout({ t: 'tile.activate', paneId: cur.paneId, tileId: cur.tileId });
  if (target.to === 'tile') {
    s.dispatchLayout({ t: 'tile.patch', paneId: cur.paneId, tileId: cur.tileId, patch: { wb: view } });
    return;
  }
  if (tile.wb !== 'live') s.dispatchLayout({ t: 'tile.patch', paneId: cur.paneId, tileId: cur.tileId, patch: { wb: 'live' } });
  if (target.review) openReview(target.review);
  else if (target.explorer) openExplorer(target.explorer);
  else showPanel(target.panel);
}

/**
 * A turn's 「改动了 N 个文件」 card (redesign phase 5): 审阅 on this conversation's changes, scrolled to `path` and
 * opened. A desktop uses the right panel; a phone (no right panel) opens the conversation's own 改动 view in place
 * (`at`: its tile) and scrolls that; a conversation on another machine has its files there — a note says so.
 */
export function openChangedFile(sessionId: string, path?: string, at?: { paneId: string; tileId: string }): void {
  if (blockRemoteOpen(sessionId, path)) return;
  const s = useStore.getState();
  if (s.mobile) {
    openSessionView('changes', at);
    useRightPanel.setState({ inPlace: { sessionId, path, n: ++seq } });
    return;
  }
  openReview({ scope: 'session', path });
}
