// Every way into the sidebar's functions, as ids the components put on their elements (`data-id`, checked with
// `satisfies` at compile time) — and where each entry point of the old sidebar went (spec 2026-09-28 §4.2).
// entries.test.ts checks the table itself (every old entry resolves, every id has a reason); only
// scripts/ui-smoke.cjs proves the ids are rendered: it parses PLACES and must find every id in its place in the DOM.
import type { PanelId } from '@/model/layout';

/** Top: brand row + three navigation rows. */
export const TOP = ['collapse', 'new', 'search', 'automation'] as const;
/**
 * 自动化 opens the automation page (redesign phase 7, `features/automation/`): these are its tabs (定时任务 · 目标 ·
 * 编排), the same ids as `AUTOMATION_TABS` there. The phase-4 menu they used to be in is gone.
 */
export const AUTOMATION = ['schedules', 'goals', 'orchestra'] as const;
/** Sections of the list, in order. */
export const SECTIONS = ['attention', 'pinned', 'projects', 'other', 'peers'] as const;
/** The 项目 header row. */
export const PROJECTS_HEAD = ['filter', 'add-project'] as const;
/** The funnel menu: everything that used to be chips, the filter box and 选择 above the list. */
export const FILTER = ['query', 'source', 'machine', 'archived', 'select', 'library'] as const;
/** A project's ··· / right-click menu; `add-project` on a folder outside every project. */
export const PROJECT_MENU = ['new-here', 'worktree', 'terminal', 'rename', 'explorer', 'vscode', 'remove', 'make-project'] as const;
/** A conversation row's ··· / right-click menu (shown by capability). */
export const ROW_MENU = ['open-tab', 'open-split', 'resume', 'pin', 'explorer', 'vscode', 'stop', 'reference', 'rename', 'fork', 'archive', 'handoff', 'native-cli', 'copy-id', 'delete'] as const;
/** On the rows themselves. */
export const ROW = ['status', 'kids', 'more', 'less', 'select-bar'] as const;
/** The account row at the bottom and its popover. */
export const ACCOUNT = ['account', 'quota', 'connection', 'today', 'theme', 'usage', 'settings', 'config', 'appearance', 'shortcuts', 'palette'] as const;
/** The light, dismissable hint. */
export const HINT = ['library-join', 'library-later'] as const;

export type TopId = (typeof TOP)[number];
export type AutomationId = (typeof AUTOMATION)[number];
export type SectionId = (typeof SECTIONS)[number];
export type ProjectsHeadId = (typeof PROJECTS_HEAD)[number];
export type FilterId = (typeof FILTER)[number];
export type ProjectMenuId = (typeof PROJECT_MENU)[number];
export type RowMenuId = (typeof ROW_MENU)[number];
export type RowId = (typeof ROW)[number];
export type AccountId = (typeof ACCOUNT)[number];
export type HintId = (typeof HINT)[number];

/**
 * The panels whose content the sidebar reaches — 自动化 → the page's 目标 / 编排 tabs (the same GoalsPanel /
 * OrchestraPanel the right panel shows; 定时任务 is a view, not a panel), the account popover → 用量 / 配置中心.
 * `workbench/panel-entries.ts` counts them as the sidebar's 2-click entries (`sidebarAutomation` / `accountMenu`), so
 * both tables use the same ids.
 */
export const AUTOMATION_PANELS = { goals: 'goals', orchestra: 'orchestra' } as const satisfies Partial<Record<AutomationId, PanelId>>;
export const ACCOUNT_PANELS = { usage: 'usage', config: 'config' } as const satisfies Partial<Record<AccountId, PanelId>>;

export const PLACES = {
  top: TOP, automation: AUTOMATION, section: SECTIONS, head: PROJECTS_HEAD, filter: FILTER,
  project: PROJECT_MENU, row: ROW, rowMenu: ROW_MENU, account: ACCOUNT, hint: HINT,
} as const;
export type Place = keyof typeof PLACES;

/** Each entry point of the sidebar before the redesign → where it is now (`place:id`). */
export const LEGACY: { old: string; now: `${Place}:${string}`[] }[] = [
  { old: '收起侧栏 (Ctrl+B)', now: ['top:collapse'] },
  { old: '新会话 (Alt N)', now: ['top:new'] },
  { old: '命令 / 搜索 (Ctrl K)', now: ['top:search'] },
  { old: '设置 (Ctrl ,)', now: ['account:settings'] },
  { old: '设置 · 右键：在右侧面板打开配置中心', now: ['account:config'] },
  { old: '用量（右侧面板）', now: ['account:usage'] },
  { old: '额度环 + 明细', now: ['account:quota'] },
  { old: '连接状态点 / 重连中…', now: ['account:connection'] },
  { old: '显示已归档（底部开关）', now: ['filter:archived'] },
  { old: '主题 / 设置（底部月亮 → 命令面板）', now: ['account:theme', 'account:appearance', 'account:palette'] },
  { old: '会话库发现横幅：加入 X', now: ['hint:library-join'] },
  { old: '会话库发现横幅：以后再说', now: ['hint:library-later'] },
  { old: '来源 chip 行', now: ['filter:source'] },
  { old: '机器 chip 行', now: ['filter:machine'] },
  { old: '筛选会话…（输入框）', now: ['filter:query'] },
  { old: '选择（多选）/ 全选 / 批量归档 / 批量删除', now: ['filter:select', 'row:select-bar'] },
  { old: '「运行中」分组', now: ['row:status'] },
  { old: '置顶分组', now: ['section:pinned'] },
  { old: '工作区 · 添加工作区', now: ['head:add-project'] },
  { old: '工作区 ··· · 在这里新建会话', now: ['project:new-here'] },
  { old: '工作区 ··· · 新建 worktree 会话', now: ['project:worktree'] },
  { old: '工作区 ··· · 在这里开终端', now: ['project:terminal'] },
  { old: '工作区 ··· · 重命名', now: ['project:rename'] },
  { old: '工作区 ··· · 在资源管理器打开', now: ['project:explorer'] },
  { old: '工作区 ··· · 在 VS Code 打开', now: ['project:vscode'] },
  { old: '工作区 ··· · 移除工作区', now: ['project:remove'] },
  { old: '其它目录 · 设为工作区', now: ['section:other', 'project:make-project'] },
  { old: '其它机器分组', now: ['section:peers'] },
  { old: '展开更多（剩 N）', now: ['row:more'] },
  { old: '+N 子任务', now: ['row:kids'] },
  { old: '会话 ··· · 在新标签打开', now: ['rowMenu:open-tab'] },
  { old: '会话 ··· · 在右侧分屏打开', now: ['rowMenu:open-split'] },
  { old: '会话 ··· · 恢复运行', now: ['rowMenu:resume'] },
  { old: '会话 ··· · 置顶 / 取消置顶', now: ['rowMenu:pin'] },
  { old: '会话 ··· · 在资源管理器打开', now: ['rowMenu:explorer'] },
  { old: '会话 ··· · 在 VS Code 打开', now: ['rowMenu:vscode'] },
  { old: '会话 ··· · 结束进程', now: ['rowMenu:stop'] },
  { old: '会话 ··· · 引用到输入框', now: ['rowMenu:reference'] },
  { old: '会话 ··· · 重命名', now: ['rowMenu:rename'] },
  { old: '会话 ··· · 分叉', now: ['rowMenu:fork'] },
  { old: '会话 ··· · 归档 / 取消归档', now: ['rowMenu:archive'] },
  { old: '会话 ··· · 交给其它 Agent 继续', now: ['rowMenu:handoff'] },
  { old: '会话 ··· · 在原生 CLI 打开', now: ['rowMenu:native-cli'] },
  { old: '会话 ··· · 复制 ID', now: ['rowMenu:copy-id'] },
  { old: '会话 ··· · 删除…', now: ['rowMenu:delete'] },
];

/** Where the spec's new L0 / L1 entries live (§4.2 / §5.1), beyond the old ones. */
export const ADDED: `${Place}:${string}`[] = ['top:automation', 'automation:schedules', 'automation:goals', 'automation:orchestra', 'section:attention', 'section:projects', 'head:filter', 'account:account', 'account:today', 'account:shortcuts', 'filter:library', 'row:less'];

export function resolves(ref: `${Place}:${string}`): boolean {
  const [place, id] = ref.split(':') as [Place, string];
  return !!PLACES[place] && (PLACES[place] as readonly string[]).includes(id);
}
