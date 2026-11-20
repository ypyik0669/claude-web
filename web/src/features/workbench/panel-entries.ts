// Where every right-panel panel and every per-session view is reached in the default (quiet) UI — redesign phase 2,
// spec §4.2 / §5.6, and redesign 2026-11 stage 4: the header's five tools, the panel's picker (built from CORE_PANELS
// and MORE_PANELS), the header's ⋯ and the palette, whose views route through `viewTarget`; `panel-entries.test.ts`
// asserts that nothing is more than 2 clicks away. The click counts are a declared table: `scripts/ui-smoke.cjs` walks
// the same entries in the DOM (the palette opens every panel, the header's tools, the picker, a tool row's 详情).
import { PANELS, panelToggleEffect, type Dock, type PanelId } from '@/model/layout';
import { panelToggleLabel } from '@/ui/terms';
import type { ReviewScope } from './review-model';
import { viewCommands, type WbView } from './wb-views';
import { ACCOUNT_PANELS, AUTOMATION_PANELS } from '@/features/sidebar/entries';

export type EntryVia = 'changesButton' | 'headerTool' | 'toolDetail' | 'headerMore' | 'palette' | 'panelPicker' | 'sidebarAutomation' | 'accountMenu';

/** Clicks from a conversation with the right panel closed. */
export const ENTRY_CLICKS: Record<EntryVia, number> = {
  changesButton: 1, // the session header's 「+N −M」 → 改动 (while the info column is not showing it)
  headerTool: 1, // the session header's five tools (redesign 2026-11): 任务 · 终端 · 改动 · 浏览器 · 文件
  toolDetail: 1, // a tool row's 详情 → 详情
  headerMore: 2, // the session header's ⋯ → an item (对话信息栏, Issue 与 PR, Android 屏幕…)
  palette: 2, // the sidebar's 搜索 (command palette) → an item; every panel is listed there
  panelPicker: 3, // a header tool → the panel's picker → an item (2 once the panel is open)
  sidebarAutomation: 2, // the sidebar's 自动化 → one of its five tabs, 目标 / 编排 among them (1 when it is the tab shown last)
  accountMenu: 2, // the sidebar's account row → 用量与账本 (sidebar/entries.ts ACCOUNT_PANELS)
};

/** The panels the header's ⋯ opens itself (ConvMenu.tsx: Issue 与 PR, Android 屏幕). */
export const HEADER_MORE_PANELS: readonly PanelId[] = ['board', 'android'];

const SIDEBAR_AUTOMATION: readonly PanelId[] = Object.values(AUTOMATION_PANELS);
const ACCOUNT_MENU: readonly PanelId[] = Object.values(ACCOUNT_PANELS);

export const minClicks = (entries: EntryVia[]) => Math.min(...entries.map((e) => ENTRY_CLICKS[e]));

/** The right panel picker's 「更多面板」: the extra tier (this conversation's Artifacts sit right under the five). */
export const MORE_PANELS = PANELS.filter((p) => p.tier === 'extra');

/** What the file view opens on. */
export type ExplorerMode = 'tree' | 'search' | 'artifacts';
/** What the review opens on: a scope, a commit, a file to scroll to, or the full Git view. */
export interface ReviewIntent { scope?: ReviewScope; rev?: string; path?: string; git?: boolean }

export type ViewTarget = { to: 'tile' } | { to: 'automation'; tab: 'schedules' } | { to: 'panel'; panel: PanelId; review?: ReviewIntent; explorer?: ExplorerMode };

/**
 * Where a per-session view (the old workbench tab row) opens. The right panel took them over (on a phone it is the
 * bottom drawer): 改动 → 审阅 on this conversation's files, Git → 审阅's full Git view, 文件 / 搜索 / 生成的文件 →
 * 文件, Issue 与 PR → a temporary tab. 定时任务 are this machine's, not the conversation's: the automation page. A
 * conversation on another machine has its files there, so it keeps the in-place views. (`mobile` no longer changes
 * the answer since the drawer; kept so callers need not change.)
 */
export function viewTarget(view: WbView, o: { mobile: boolean; remote: boolean }): ViewTarget {
  if (view === 'schedules') return { to: 'automation', tab: 'schedules' };
  if (o.remote) return { to: 'tile' };
  switch (view) {
    case 'changes': return { to: 'panel', panel: 'files', review: { scope: 'session' } };
    case 'git': return { to: 'panel', panel: 'files', review: { git: true } };
    case 'files': return { to: 'panel', panel: 'explorer', explorer: 'tree' };
    case 'search': return { to: 'panel', panel: 'explorer', explorer: 'search' };
    case 'artifacts': return { to: 'panel', panel: 'explorer', explorer: 'artifacts' };
    case 'board': return { to: 'panel', panel: 'board' };
  }
}

/**
 * Where a view is offered (redesign 2026-11): 改动 and 文件 are two of the header's five tools; Issue 与 PR is a row of
 * the header's ⋯; every view is in the palette (`viewCommands(remote)`, `s.<view>` — drop one there and this
 * shrinks); 定时任务 is also 自动化's. A conversation on another machine: only what the palette offers for it.
 */
export function viewEntries(view: WbView, remote = false): EntryVia[] {
  const out: EntryVia[] = [];
  if (!remote && (view === 'changes' || view === 'files')) out.push('headerTool');
  if (!remote && view === 'board') out.push('headerMore');
  if (viewCommands(remote).some((c) => c.view === view)) out.push('palette');
  // 自动化 → 定时任务: the automation page, with or without a conversation, on a desktop and a phone
  if (view === 'schedules') out.push('sidebarAutomation');
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
  if (p.tier === 'core') out.push('headerTool');
  if (p.tier === 'extra') out.push('panelPicker');
  if (id === 'files') out.push('changesButton');
  if (id === 'inspector') out.push('toolDetail');
  if (SIDEBAR_AUTOMATION.includes(id)) out.push('sidebarAutomation');
  if (ACCOUNT_MENU.includes(id)) out.push('accountMenu');
  if (HEADER_MORE_PANELS.includes(id)) out.push('headerMore');
  return out;
}
