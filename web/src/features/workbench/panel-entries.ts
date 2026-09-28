// Where every right-panel panel and every per-session view is reached in the default (quiet) UI — redesign phase 2,
// spec §4.2 / §5.6. The right panel's 「更多」 menu is built from MORE_PANELS, the header ··· views and the palette
// route through `viewTarget`; `panel-entries.test.ts` asserts that nothing is more than 2 clicks away. The click
// counts are a declared table: `scripts/ui-smoke.cjs` walks the same entries in the DOM (the palette opens every
// panel, every ··· view lands where `viewTarget` says, the header's terminal button, a tool row's 详情).
import { PANELS, panelToggleEffect, type Dock, type PanelId } from '@/model/layout';
import { panelToggleLabel } from '@/ui/terms';
import type { ReviewScope } from './review-model';
import { WB_VIEWS, viewCommands, viewsFor, type WbView } from './wb-views';

export type EntryVia = 'changesButton' | 'terminalButton' | 'toolDetail' | 'panelButton' | 'headerMore' | 'palette' | 'panelMore';

/** Clicks from a conversation with the right panel closed. */
export const ENTRY_CLICKS: Record<EntryVia, number> = {
  changesButton: 1, // the session header's 「+N −M」 → 审阅
  terminalButton: 1, // the session header's terminal button → 终端
  toolDetail: 1, // a tool row's 详情 → 详情
  panelButton: 2, // the session header's right-panel button → one of the fixed tabs
  headerMore: 2, // the session header's ··· → an item
  palette: 2, // the sidebar's 搜索 (command palette) → an item; every panel is listed there
  panelMore: 3, // right-panel button → 「更多」 → an item (2 once the panel is open)
};

export const minClicks = (entries: EntryVia[]) => Math.min(...entries.map((e) => ENTRY_CLICKS[e]));

/** The default right panel's 「更多」 menu: the extra tier, opened as temporary tabs. */
export const MORE_PANELS = PANELS.filter((p) => p.tier === 'extra');

/** What the file view opens on. */
export type ExplorerMode = 'tree' | 'search' | 'artifacts';
/** What the review opens on: a scope, a commit, a file to scroll to, or the full Git view. */
export interface ReviewIntent { scope?: ReviewScope; rev?: string; path?: string; git?: boolean }

export type ViewTarget = { to: 'tile' } | { to: 'panel'; panel: PanelId; review?: ReviewIntent; explorer?: ExplorerMode };

/**
 * Where a per-session view (the old workbench tab row) opens. On a desktop the right panel took them over: 改动 →
 * 审阅 on this conversation's files, Git → 审阅's full Git view, 文件 / 搜索 / 生成的文件 → 文件, Issue 与 PR → a
 * temporary tab. 定时任务 stays an in-place view until the automation page (phase 7). A phone has no right panel and
 * a conversation on another machine has its files there, so both keep the in-place views.
 */
export function viewTarget(view: WbView, o: { mobile: boolean; remote: boolean }): ViewTarget {
  if (o.mobile || o.remote) return { to: 'tile' };
  switch (view) {
    case 'changes': return { to: 'panel', panel: 'files', review: { scope: 'session' } };
    case 'git': return { to: 'panel', panel: 'files', review: { git: true } };
    case 'files': return { to: 'panel', panel: 'explorer', explorer: 'tree' };
    case 'search': return { to: 'panel', panel: 'explorer', explorer: 'search' };
    case 'artifacts': return { to: 'panel', panel: 'explorer', explorer: 'artifacts' };
    case 'board': return { to: 'panel', panel: 'board' };
    case 'schedules': return { to: 'tile' };
  }
}

/**
 * Where a view is offered, read from the same tables the menus are built from: the header ··· grid renders
 * `viewsFor(remote)` and the palette `viewCommands(remote)` (`s.<view>`) — drop a view from either and this shrinks.
 */
export function viewEntries(view: WbView, remote = false): EntryVia[] {
  const out: EntryVia[] = [];
  if (viewsFor(remote).some((v) => v.id === view)) out.push('headerMore');
  if (viewCommands(remote).some((c) => c.view === view)) out.push('palette');
  return out;
}

/** The palette's label for a panel: what toggling it does right now (only a panel with a live process runs on). */
export function panelCommandLabel(dock: Dock, p: (typeof PANELS)[number], workbench: boolean): string {
  return panelToggleLabel(panelToggleEffect(dock, p.id, workbench), p.title, !!p.keepAlive);
}

/** How a panel is reached in the default UI (see ENTRY_CLICKS). */
export function panelEntries(id: PanelId): EntryVia[] {
  const p = PANELS.find((x) => x.id === id);
  if (!p) return [];
  const out: EntryVia[] = ['palette'];
  if (p.tier === 'core') out.push('panelButton');
  if (p.tier === 'extra') out.push('panelMore');
  if (id === 'files') out.push('changesButton');
  if (id === 'terminal') out.push('terminalButton');
  if (id === 'inspector') out.push('toolDetail');
  // a panel a header ··· view opens (审阅, 文件, Issue 与 PR)
  if (WB_VIEWS.some((v) => { const t = viewTarget(v.id, { mobile: false, remote: false }); return t.to === 'panel' && t.panel === id; })) out.push('headerMore');
  return out;
}
