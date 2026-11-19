// The automation page (redesign phase 7, spec §5.9): 定时任务 · 目标 · 编排 on one page over the main area, reached
// from the sidebar's 自动化. Pure — AutomationPage.tsx draws it, state.ts opens / closes it.
import type { LayoutAction } from '@/model/layout';
import type { IconName } from '@/ui/icons';
import { tr } from '@/i18n';

/** The page's title. It is set in the heading face, so ui/heading-text.ts lists it. */
export const AUTOMATION_TITLE = tr('自动化');
/** One line under it: what the five tabs have in common. */
export const AUTOMATION_DESC = tr('不用你盯着也会跑的东西');

export const AUTOMATION_TABS = ['schedules', 'goals', 'orchestra'] as const;
export type AutomationTab = (typeof AUTOMATION_TABS)[number];

/**
 * 自动化 as one page with five tabs (redesign 2026-11 stage 1): the old 后台 page is 运行中, the Bot page is Bot, the
 * automation page's own three stay. Three pages behind them, each with its own store (features/automation/family.tsx
 * draws the tab row over each and remembers the last one); the ids are the sidebar's (sidebar/entries.ts AUTOMATION).
 */
export const FAMILY_TABS = ['running', 'schedules', 'bots', 'goals', 'orchestra'] as const;
export type FamilyTab = (typeof FAMILY_TABS)[number];
/** Which page a tab is: the background page, the Bot page, or the automation page on one of its own tabs. */
export type FamilyPage = 'background' | 'bots' | 'automation';
export const familyPage = (t: FamilyTab): FamilyPage => (t === 'running' ? 'background' : t === 'bots' ? 'bots' : 'automation');
export const FAMILY_TAB_INFO: Record<FamilyTab, { label: string; icon: IconName; title: string }> = {
  running: { label: tr('运行中'), icon: 'office', title: tr('在跑的子代理、工作流和后台命令；3D 网吧也在这里') },
  schedules: { label: tr('定时任务'), icon: 'tasks', title: tr('按时间自动开对话、跑提示词') },
  bots: { label: tr('Bot'), icon: 'bot', title: tr('住在你电脑里的值班队友') },
  goals: { label: tr('目标'), icon: 'goals', title: tr('定一个目标，让 Claude 一轮轮做到完成') },
  orchestra: { label: tr('编排'), icon: 'orchestra', title: tr('把一件事拆给几个 Agent：分工、审批、比选') },
};

/** Each tab: its name, one line on what it is for (the old sidebar menu said the same), and the 新建 button's words. */
export const AUTOMATION_TAB_INFO: Record<AutomationTab, { label: string; icon: IconName; desc: string; newLabel: string }> = {
  schedules: { label: tr('定时任务'), icon: 'tasks', desc: tr('按时间自动开对话、跑提示词'), newLabel: tr('新建定时任务') },
  goals: { label: tr('目标'), icon: 'goals', desc: tr('定一个目标，让 Claude 一轮轮做到完成'), newLabel: tr('新目标') },
  orchestra: { label: tr('编排'), icon: 'orchestra', desc: tr('把一件事拆给几个 Agent：分工、审批、比选'), newLabel: tr('新建工作流') },
};

/**
 * Clicks from anywhere to a tab: the sidebar's 自动化 opens the page on the tab shown last, so the tab itself is
 * one more click only when it is another one (spec §4.2: ≤ 2).
 */
export function tabClicks(tab: FamilyTab, last: FamilyTab): number {
  return tab === last ? 1 : 2;
}

/**
 * The page lies over the main area; it gets out of the way when the main area is sent somewhere: a conversation or
 * a tile opened / brought forward (the sidebar, the palette, a notification, 新对话 — even when that tile is already
 * in front), a split, another group. Not for what happens beside it (the right panel, the sidebar), a split being
 * resized, focus moving, or a tile updating its own title / url / view in the background.
 */
const NAVIGATES = new Set<LayoutAction['t']>([
  'tile.open', 'tile.activate', 'tile.close', 'tile.next', 'tile.move', 'session.assign',
  'pane.split', 'pane.close', 'pane.jump', 'pane.cycle', 'pane.zoom', 'pane.preset',
  'group.new', 'group.activate', 'group.next', 'group.close', 'group.add', 'group.remove',
]);
export const closesAutomation = (a: LayoutAction): boolean => NAVIGATES.has(a.t);
