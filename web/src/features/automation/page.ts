// The automation page (redesign phase 7, spec §5.9): 定时任务 · 目标 · 编排 on one page over the main area, reached
// from the sidebar's 自动化. Pure — AutomationPage.tsx draws it, state.ts opens / closes it.
import type { LayoutAction } from '@/model/layout';
import type { IconName } from '@/ui/icons';

/** The page's title. It is set in the heading face, so ui/heading-text.ts lists it. */
export const AUTOMATION_TITLE = '自动化';

export const AUTOMATION_TABS = ['schedules', 'goals', 'orchestra'] as const;
export type AutomationTab = (typeof AUTOMATION_TABS)[number];

/** Each tab: its name, one line on what it is for (the old sidebar menu said the same), and the 新建 button's words. */
export const AUTOMATION_TAB_INFO: Record<AutomationTab, { label: string; icon: IconName; desc: string; newLabel: string }> = {
  schedules: { label: '定时任务', icon: 'tasks', desc: '按时间自动开对话、跑提示词', newLabel: '新建定时任务' },
  goals: { label: '目标', icon: 'goals', desc: '定一个目标，让 Claude 一轮轮做到完成', newLabel: '新目标' },
  orchestra: { label: '编排', icon: 'orchestra', desc: '把一件事拆给几个 Agent：分工、审批、比选', newLabel: '新建工作流' },
};

/**
 * Clicks from anywhere to a tab: the sidebar's 自动化 opens the page on the tab shown last, so the tab itself is
 * one more click only when it is another one (spec §4.2: ≤ 2).
 */
export function tabClicks(tab: AutomationTab, last: AutomationTab): number {
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
