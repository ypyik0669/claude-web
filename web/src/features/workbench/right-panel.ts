// Opening things in the right panel (redesign phase 2, spec §5.6): the requests the 审阅 / 文件 tabs pick up (which
// scope, which file, which mode) and the one function the header ···, the palette and the 改动 button call for a
// per-session view. A small store of its own, like the orchestra's — nothing here goes into store/index.ts.
import { create } from 'zustand';
import { parsePeerId } from '@shared';
import { useStore } from '@/store';
import { currentChatTile, type PanelId } from '@/model/layout';
import { PHONE_NO_PANEL } from '@/ui/terms';
import { viewTarget, type ExplorerMode, type ReviewIntent } from './panel-entries';
import type { WbView } from './wb-views';

interface RightPanelState {
  /** the last request for the review; `n` grows so asking for the same thing twice still applies */
  review: (ReviewIntent & { n: number }) | null;
  explorer: { mode: ExplorerMode; n: number } | null;
  /** how many files the review lists right now (its tab shows the number, like the mock's 「审阅 3」) */
  reviewCount: number;
}
export const useRightPanel = create<RightPanelState>(() => ({ review: null, explorer: null, reviewCount: 0 }));
let seq = 0;

/** Bring a panel to the front of the right panel. A phone draws none: it says where things are instead. */
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
