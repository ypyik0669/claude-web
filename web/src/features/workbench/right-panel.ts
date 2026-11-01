// Opening things in the right panel (redesign phase 2, spec §5.6): the requests the 审阅 / 文件 tabs pick up (which
// scope, which file, which mode) and the one function the header ···, the palette and the 改动 button call for a
// per-session view. A small store of its own, like the orchestra's — nothing here goes into store/index.ts.
import { create } from 'zustand';
import { parsePeerId } from '@shared';
import { useStore } from '@/store';
import { currentChatTile, type PanelId } from '@/model/layout';
import { openAutomation } from '@/features/automation/state';
import { blockRemoteOpen } from '@/features/remote-guard';
import { viewTarget, type ExplorerMode, type ReviewIntent } from './panel-entries';
import type { WbView } from './wb-views';
import { openUrl } from '@/features/browser/state';
import { tr } from '@/i18n';
import { samePath } from '@/features/paths';

interface RightPanelState {
  /** the last request for the review; `n` grows so asking for the same thing twice still applies */
  review: (ReviewIntent & { n: number }) | null;
  explorer: { mode: ExplorerMode; n: number } | null;
  /** how many files the right panel's review lists right now (its tab shows the number, like the mock's 「审阅 3」) */
  reviewCount: number;
  /** an in-place 改动 view (a conversation whose views stay in place): the file a change card asked for (only that conversation's in-place review takes it) */
  inPlace: { sessionId: string; path?: string; n: number } | null;
  /** files previewed in 文件 (beside the tree, like the official app's file pane); `active` is the one in front */
  preview: { files: PreviewFile[]; active: string | null };
}
export interface PreviewFile { id: string; path: string; line?: number }
export const useRightPanel = create<RightPanelState>(() => ({ review: null, explorer: null, reviewCount: 0, inPlace: null, preview: { files: [], active: null } }));
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

/** Open an address in the right panel's 浏览器 (a new tab unless the one in front is still empty). */
export function openInBrowser(url: string): void {
  openUrl(url);
  showPanel('browser');
}

/** 审阅 on a scope / commit / file, or its full Git view. */
export function openReview(intent: ReviewIntent = {}): void {
  if (showPanel('files')) useRightPanel.setState({ review: { ...intent, n: ++seq } });
}

/** 文件 on the tree, the search, or this conversation's generated files. */
export function openExplorer(mode: ExplorerMode): void {
  if (showPanel('explorer')) useRightPanel.setState({ explorer: { mode, n: ++seq } });
}

/** At most this many previews stay mounted (each text one is a Monaco editor); the oldest goes first. */
const MAX_PREVIEWS = 8;
/** The right panel is widened to this when a preview first opens beside the tree (never narrowed). */
const PREVIEW_WIDTH = 760;

/**
 * Open a file in 文件's preview (the right panel, next to the tree) — the same file again just comes to the front
 * (at `line` when given). On a phone the right panel is a bottom drawer: the file opens in place as a doc tab
 * (a whole screen beats a drawer for reading a file).
 */
export function previewFile(path: string, line?: number): void {
  const s = useStore.getState();
  if (s.mobile) { s.openTile({ id: `d${Date.now().toString(36)}`, kind: 'doc', path, ...(line ? { line } : {}) }, 'tab'); return; }
  const { files } = useRightPanel.getState().preview;
  if (!files.length && s.layout.dock.width < PREVIEW_WIDTH) s.dispatchLayout({ t: 'dock.set', patch: { width: PREVIEW_WIDTH } });
  showPanel('explorer');
  const had = files.find((f) => samePath(f.path, path));
  const it: PreviewFile = had ? { ...had, line } : { id: `p${Date.now().toString(36)}${++seq}`, path, line };
  const next = had ? files.map((f) => (f.id === had.id ? it : f)) : [...files, it].slice(-MAX_PREVIEWS);
  useRightPanel.setState({ preview: { files: next, active: it.id } });
}

/** Close a preview; the one next to it (or before it) comes to the front. */
export function closePreview(id: string): void {
  const { files, active } = useRightPanel.getState().preview;
  const i = files.findIndex((f) => f.id === id);
  if (i < 0) return;
  const next = files.filter((f) => f.id !== id);
  useRightPanel.setState({ preview: { files: next, active: active === id ? (next[i] ?? next[i - 1])?.id ?? null : active } });
}

export function activatePreview(id: string): void {
  useRightPanel.setState((st) => ({ preview: { ...st.preview, active: id } }));
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
  if (!cur || tile?.kind !== 'chat' || !tile.sessionId) { s.toast(tr('先打开一个对话')); return; }
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
 * opened — where 改动 opens is `viewTarget`'s call: the right panel (on a phone the bottom drawer, redesign phase 7);
 * a view in place (`at`: its tile) where `viewTarget` says so; a conversation on another machine has its files
 * there — a note says so.
 */
export function openChangedFile(sessionId: string, path?: string, at?: { paneId: string; tileId: string }): void {
  if (blockRemoteOpen(sessionId, path)) return;
  // where 改动 opens is `viewTarget`'s call (the same as ··· → 改动), not this card's
  const target = viewTarget('changes', { mobile: useStore.getState().mobile, remote: false });
  if (target.to === 'tile') {
    openSessionView('changes', at);
    useRightPanel.setState({ inPlace: { sessionId, path, n: ++seq } });
    return;
  }
  openReview({ ...((target.to === 'panel' && target.review) || { scope: 'session' }), path });
}
