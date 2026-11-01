// Every way into the sidebar's functions, as ids the components put on their elements (`data-id`, checked with
// `satisfies` at compile time) — and where each entry point of the old sidebar went (spec 2026-09-28 §4.2).
// entries.test.ts checks the table itself (every old entry resolves, every id has a reason); only
// scripts/ui-smoke.cjs proves the ids are rendered: it parses PLACES and must find every id in its place in the DOM.
import type { PanelId } from '@/model/layout';
import { tr } from '@/i18n';

/**
 * Top: the brand row and the navigation. At desktop width the icon rail (features/rail/) has the sidebar's switch,
 * the sections (对话 · 后台 · 自动化 · 扩展) and ···; the sidebar keeps 新对话 and 搜索. A phone has them all in its drawer
 * (no 对话 / ··· there: the drawer is the conversation list, the panels are in each header's ···).
 */
export const TOP = ['app-menu', 'collapse', 'back', 'forward', 'new', 'search', 'chat', 'background', 'automation', 'extensions', 'more'] as const;
/**
 * 自动化 opens the automation page (redesign phase 7, `features/automation/`): these are its tabs (定时任务 · 目标 ·
 * 编排), the same ids as `AUTOMATION_TABS` there. The phase-4 menu they used to be in is gone.
 */
export const AUTOMATION = ['schedules', 'goals', 'orchestra'] as const;
/** Sections of the list, in order. */
export const SECTIONS = ['attention', 'pinned', 'custom', 'projects', 'other', 'peers'] as const;
/** The 项目 / 对话 header row. */
export const PROJECTS_HEAD = ['view', 'add-project'] as const;
/**
 * The 显示 menu (stage C3): the old funnel's filters (the box, 来源, 机器, 显示已归档, 选择) plus how the list is grouped,
 * ordered and how much of each group shows; the user's own sections; 恢复默认 / 查看全部.
 */
export const VIEW = ['query', 'source', 'machine', 'group-by', 'sort-by', 'archived', 'per-group', 'select', 'new-section', 'reset', 'all', 'library'] as const;
/** A section of the user's own: its header (a drop target), its menu, the × on its rows. */
export const CUSTOM = ['custom-section', 'custom-rename', 'custom-delete', 'custom-out'] as const;
/** A project's ··· / right-click menu; `add-project` on a folder outside every project. */
export const PROJECT_MENU = ['new-here', 'worktree', 'terminal', 'move-top', 'move-up', 'move-down', 'edit', 'rename', 'explorer', 'vscode', 'remove', 'make-project'] as const;
/** A conversation row's ··· / right-click menu (shown by capability; `handoff` = 在本机继续, only for a conversation on another machine). */
export const ROW_MENU = ['open-tab', 'open-split', 'resume', 'pin', 'explorer', 'vscode', 'stop', 'reference', 'rename', 'fork', 'archive', 'handoff', 'handoff-peer', 'native-cli', 'copy-id', 'delete', 'section-add', 'section-out'] as const;
/** On the rows themselves. */
export const ROW = ['status', 'kids', 'more', 'less', 'select-bar', 'select-section'] as const;
/** The account row at the bottom and its popover. */
export const ACCOUNT = ['account', 'quota', 'connection', 'today', 'theme', 'usage', 'settings', 'config', 'ascii-themes', 'appearance', 'shortcuts', 'palette'] as const;

export type TopId = (typeof TOP)[number];
export type AutomationId = (typeof AUTOMATION)[number];
export type SectionId = (typeof SECTIONS)[number];
export type ProjectsHeadId = (typeof PROJECTS_HEAD)[number];
export type ViewId = (typeof VIEW)[number];
export type CustomId = (typeof CUSTOM)[number];
export type ProjectMenuId = (typeof PROJECT_MENU)[number];
export type RowMenuId = (typeof ROW_MENU)[number];
export type RowId = (typeof ROW)[number];
export type AccountId = (typeof ACCOUNT)[number];

/**
 * The panels whose content the sidebar reaches — 自动化 → the page's 目标 / 编排 tabs (the same GoalsPanel /
 * OrchestraPanel the right panel shows; 定时任务 is a view, not a panel), the account popover → 用量 / 配置中心.
 * `workbench/panel-entries.ts` counts them as the sidebar's 2-click entries (`sidebarAutomation` / `accountMenu`), so
 * both tables use the same ids.
 */
export const AUTOMATION_PANELS = { goals: 'goals', orchestra: 'orchestra' } as const satisfies Partial<Record<AutomationId, PanelId>>;
export const ACCOUNT_PANELS = { usage: 'usage', config: 'config' } as const satisfies Partial<Record<AccountId, PanelId>>;

export const PLACES = {
  top: TOP, automation: AUTOMATION, section: SECTIONS, head: PROJECTS_HEAD, view: VIEW, custom: CUSTOM,
  project: PROJECT_MENU, row: ROW, rowMenu: ROW_MENU, account: ACCOUNT,
} as const;
export type Place = keyof typeof PLACES;

/** Each entry point of the sidebar before the redesign → where it is now (`place:id`). */
export const LEGACY: { old: string; now: `${Place}:${string}`[] }[] = [
  { old: tr('收起侧栏 (Ctrl+B)'), now: ['top:collapse'] },
  { old: tr('新会话 (Alt N)'), now: ['top:new'] },
  { old: tr('命令 / 搜索 (Ctrl K)'), now: ['top:search'] },
  { old: tr('设置 (Ctrl ,)'), now: ['account:settings'] },
  { old: tr('设置 · 右键：在右侧面板打开配置中心'), now: ['account:config'] },
  { old: tr('用量（右侧面板）'), now: ['account:usage'] },
  { old: tr('额度环 + 明细'), now: ['account:quota'] },
  { old: tr('连接状态点 / 重连中…'), now: ['account:connection'] },
  { old: tr('显示已归档（底部开关）'), now: ['view:archived'] },
  { old: tr('主题 / 设置（底部月亮 → 命令面板）'), now: ['account:theme', 'account:appearance', 'account:palette'] },
  { old: tr('来源 chip 行'), now: ['view:source'] },
  { old: tr('机器 chip 行'), now: ['view:machine'] },
  { old: tr('筛选会话…（输入框）'), now: ['view:query'] },
  { old: tr('选择（多选）/ 全选 / 批量归档 / 批量删除'), now: ['view:select', 'row:select-bar'] },
  { old: tr('「运行中」分组'), now: ['row:status'] },
  { old: tr('置顶分组'), now: ['section:pinned'] },
  { old: tr('工作区 · 添加工作区'), now: ['head:add-project'] },
  { old: tr('工作区 ··· · 在这里新建会话'), now: ['project:new-here'] },
  { old: tr('工作区 ··· · 新建 worktree 会话'), now: ['project:worktree'] },
  { old: tr('工作区 ··· · 在这里开终端'), now: ['project:terminal'] },
  { old: tr('工作区 ··· · 重命名'), now: ['project:rename'] },
  { old: tr('工作区 ··· · 在资源管理器打开'), now: ['project:explorer'] },
  { old: tr('工作区 ··· · 在 VS Code 打开'), now: ['project:vscode'] },
  { old: tr('工作区 ··· · 移除工作区'), now: ['project:remove'] },
  { old: tr('其它目录 · 设为工作区'), now: ['section:other', 'project:make-project'] },
  { old: tr('其它机器分组'), now: ['section:peers'] },
  { old: tr('展开更多（剩 N）'), now: ['row:more'] },
  { old: tr('+N 子任务'), now: ['row:kids'] },
  { old: tr('会话 ··· · 在新标签打开'), now: ['rowMenu:open-tab'] },
  { old: tr('会话 ··· · 在右侧分屏打开'), now: ['rowMenu:open-split'] },
  { old: tr('会话 ··· · 恢复运行'), now: ['rowMenu:resume'] },
  { old: tr('会话 ··· · 置顶 / 取消置顶'), now: ['rowMenu:pin'] },
  { old: tr('会话 ··· · 在资源管理器打开'), now: ['rowMenu:explorer'] },
  { old: tr('会话 ··· · 在 VS Code 打开'), now: ['rowMenu:vscode'] },
  { old: tr('会话 ··· · 结束进程'), now: ['rowMenu:stop'] },
  { old: tr('会话 ··· · 引用到输入框'), now: ['rowMenu:reference'] },
  { old: tr('会话 ··· · 重命名'), now: ['rowMenu:rename'] },
  { old: tr('会话 ··· · 分叉'), now: ['rowMenu:fork'] },
  { old: tr('会话 ··· · 归档 / 取消归档'), now: ['rowMenu:archive'] },
  { old: tr('会话 ··· · 在原生 CLI 打开'), now: ['rowMenu:native-cli'] },
  { old: tr('会话 ··· · 复制 ID'), now: ['rowMenu:copy-id'] },
  { old: tr('会话 ··· · 删除…'), now: ['rowMenu:delete'] },
];

/** Where the spec's new L0 / L1 entries live (§4.2 / §5.1), beyond the old ones. */
export const ADDED: `${Place}:${string}`[] = ['top:app-menu', 'top:back', 'top:forward', 'top:chat', 'top:background', 'top:extensions', 'top:more', 'top:automation', 'automation:schedules', 'automation:goals', 'automation:orchestra', 'section:attention', 'section:projects', 'head:view', 'account:account', 'account:today', 'account:shortcuts', 'view:library', 'view:group-by', 'view:sort-by', 'view:per-group', 'view:new-section', 'view:reset', 'view:all', 'section:custom', 'custom:custom-section', 'custom:custom-rename', 'custom:custom-delete', 'custom:custom-out', 'row:less', 'project:move-top', 'project:move-up', 'project:move-down', 'project:edit', 'account:ascii-themes', 'rowMenu:handoff', 'rowMenu:handoff-peer', 'rowMenu:section-add', 'rowMenu:section-out', 'row:select-section'];

export function resolves(ref: `${Place}:${string}`): boolean {
  const [place, id] = ref.split(':') as [Place, string];
  return !!PLACES[place] && (PLACES[place] as readonly string[]).includes(id);
}
