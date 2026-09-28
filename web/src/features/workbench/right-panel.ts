// Opening things in the right panel (redesign phase 2, spec §5.6): the requests the 审阅 / 文件 tabs pick up (which
// scope, which file, which mode) and the one function the header ···, the palette and the 改动 button call for a
// per-session view. A small store of its own, like the orchestra's — nothing here goes into store/index.ts.
import { create } from 'zustand';
import { parsePeerId } from '@shared';
import { useStore } from '@/store';
import { currentChatTile, type PanelId } from '@/model/layout';
import { openAutomation } from '@/features/automation/state';
import { viewTarget, type ExplorerMode, type ReviewIntent } from './panel-entries';
import type { WbView } from './wb-views';

interface RightPanelState {
  /** the last request for the review; `n` grows so asking for the same thing twice still applies */
  review: (ReviewIntent & { n: number }) | null;
  explorer: { mode: ExplorerMode; n: number } | null;
  /** how many files the right panel's review lists right now (its tab shows the number, like the mock's 「审阅 3」) */
  reviewCount: number;
}
export const useRightPanel = create<RightPanelState>(() => ({ review: null, explorer: null, reviewCount: 0 }));
let seq = 0;

// The functions below are the right panel's public entry points (the sidebar, the composer, the palette and the
// header call them): keep their signatures stable.

/**
 * Bring a panel to the front of the right panel (mounting it if needed; `true` when it is on screen). On a phone the
 * right panel is the bottom drawer (redesign phase 7, spec §5.11): the same panels, the same state — it slides up.
 */
export function showPanel(panel: PanelId): boolean {
  useStore.getState().dispatchLayout({ t: 'dock.show', panel });
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
 * The scheduled tasks (定时任务; the sidebar's automation entry, 任务's link and the like): the automation page on its
 * 定时任务 tab (redesign phase 7) — a desktop and a phone alike, with or without a conversation. Returns whether they
 * are on screen (always, now; the signature is kept for the callers).
 */
export function openSchedules(): boolean {
  return openAutomation('schedules');
}

/**
 * Goals' progress (after `/goal`, a goal's 查看…): the right panel's 目标 on a desktop; on a phone the automation
 * page's 目标 tab — the drawer is too small for the execution graph and the live spec (review 7 M11). One rule for
 * every caller.
 */
export function showGoals(): boolean {
  return useStore.getState().mobile ? openAutomation('goals') : showPanel('goals');
}

/**
 * A per-session view (the old workbench tab row) from the header ··· or the palette. The right panel (the bottom
 * drawer on a phone) shows it for that conversation (its tile is brought forward, which is what the right panel
 * follows, and goes back to the conversation itself); 定时任务 is the automation page; a conversation on another
 * machine gets it in place as before (`viewTarget`). `at`: the conversation's tile — default: the current one.
 */
export function openSessionView(view: WbView, at?: { paneId: string; tileId: string }): void {
  const s = useStore.getState();
  const cur = at ?? currentChatTile(s.layout);
  const tile = cur && s.layout.groups.flatMap((g) => g.panes[cur.paneId]?.tiles ?? []).find((t) => t.id === cur.tileId);
  const target = viewTarget(view, { mobile: s.mobile, remote: tile?.kind === 'chat' && !!tile.sessionId && !!parsePeerId(tile.sessionId) });
  // this machine's scheduled tasks need no conversation (a layout saved with the old in-place view goes back to it)
  if (target.to === 'automation') {
    if (cur && tile?.kind === 'chat' && tile.wb === view) s.dispatchLayout({ t: 'tile.patch', paneId: cur.paneId, tileId: cur.tileId, patch: { wb: 'live' } });
    openAutomation(target.tab);
    return;
  }
  if (!cur || tile?.kind !== 'chat' || !tile.sessionId) { s.toast('先打开一个对话'); return; }
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
