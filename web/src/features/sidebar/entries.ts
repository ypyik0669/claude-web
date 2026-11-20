// Every way into the sidebar's functions, as ids the components put on their elements (`data-id`, checked with
// `satisfies` at compile time) — and where each entry point of the old sidebar went (spec 2026-09-28 §4.2).
// entries.test.ts checks the table itself (every old entry resolves, every id has a reason); only
// scripts/ui-smoke.cjs proves the ids are rendered: it parses PLACES and must find every id in its place in the DOM.
import type { PanelId } from '@/model/layout';
import { tr } from '@/i18n';

/**
 * Top: the brand row and the five entries (redesign 2026-11 stage 1: no icon rail any more). The brand mark is the
 * application menu, then the sidebar's switch and ← →; under them 新对话 · 搜索 · Artifacts · 自动化 · 自定义 (自定义
 * keeps the id of the 扩展 page it opens). A phone's drawer has the same entries under a search box.
 */
export const TOP = ['app-menu', 'collapse', 'back', 'forward', 'new', 'search', 'artifacts', 'automation', 'extensions'] as const;
/**
 * 自动化 opens one page with five tabs (stage 1: 后台 and Bot moved in) — 运行中 · 定时任务 · Bot · 目标 · 编排, the same
 * ids as `FAMILY_TABS` in features/automation/page.ts.
 */
export const AUTOMATION = ['running', 'schedules', 'bots', 'goals', 'orchestra'] as const;
/** Sections of the list, in order. */
export const SECTIONS = ['attention', 'pinned', 'custom', 'projects', 'other', 'peers'] as const;
/**
 * The 项目 / 对话 header row: 打开文件夹, and 显示 where no group header carries it (redesign 2026-11 stage 3: a
 * desktop's 显示 is on each project / folder / date header — the flat list has none — and on a phone this is the
 * list's one ≡).
 */
export const PROJECTS_HEAD = ['view', 'add-project'] as const;
/** A project / folder / date header (stage 3, 图 7): on hover 显示 and ＋ (a new conversation there). */
export const GROUP_HEAD = ['group-view', 'new-here'] as const;
/**
 * The 显示 menu (stage 3, 图 7): six rows — 分组方式 › · 排序 › · 显示 › · 新建分区 · 恢复默认 · 查看全部; 显示 › holds
 * 已归档的对话, 其它 Agent 的对话, 每组, 来源 › (with 管理来源 at its end) and 机器 › (when another machine has
 * conversations). The stage C menu's filter box went to 搜索 and the list's / filter (`row:filter`), 选择多个 to Shift +
 * click and the row menu's 选择 (`rowMenu:select`).
 */
export const VIEW = ['group-by', 'sort-by', 'show', 'archived', 'other-agents', 'per-group', 'source', 'machine', 'library', 'new-section', 'reset', 'all'] as const;
/** A section of the user's own: its header (a drop target), its menu, the × on its rows. */
export const CUSTOM = ['custom-section', 'custom-rename', 'custom-delete', 'custom-out'] as const;
/**
 * A project's right-click menu (a phone: a long press on its header), and a folder's (stage 3: its header shows 显示
 * and ＋ like a project's, 设为项目 moved into the menu — still written out on the header while there is no project).
 */
export const PROJECT_MENU = ['new-here', 'worktree', 'terminal', 'move-top', 'move-up', 'move-down', 'edit', 'rename', 'explorer', 'vscode', 'remove', 'make-project'] as const;
/** A conversation row's ··· / right-click menu (shown by capability); 选择 starts the multi-select with this row. */
export const ROW_MENU = ['open-tab', 'open-split', 'resume', 'pin', 'select', 'kids', 'explorer', 'vscode', 'stop', 'reference', 'rename', 'fork', 'archive', 'handoff', 'handoff-peer', 'native-cli', 'copy-id', 'delete', 'section-add', 'section-out'] as const;
/** In the list: on the rows themselves, and the filter box / opens at its top (stage 3). */
export const ROW = ['status', 'kids', 'more', 'less', 'select-bar', 'select-section', 'filter'] as const;
/**
 * The account row at the bottom and its menu (stage 1: eight rows — 设置 · 用量与账本 · 语言 › · 主题 › · 键盘快捷键 ·
 * 帮助与反馈 › · 更新内容 · 登录 / 退出; 字符画主题 / 外观 are in 主题 ›).
 */
export const ACCOUNT = ['account', 'quota', 'connection', 'today', 'expired', 'login', 'logout', 'settings', 'usage', 'language', 'theme', 'ascii-themes', 'appearance', 'shortcuts', 'help', 'whats-new'] as const;
/** The light, dismissable hint. */
export const HINT = ['library-join', 'library-later'] as const;

export type TopId = (typeof TOP)[number];
export type AutomationId = (typeof AUTOMATION)[number];
export type SectionId = (typeof SECTIONS)[number];
export type ProjectsHeadId = (typeof PROJECTS_HEAD)[number];
export type GroupHeadId = (typeof GROUP_HEAD)[number];
export type ViewId = (typeof VIEW)[number];
export type CustomId = (typeof CUSTOM)[number];
export type ProjectMenuId = (typeof PROJECT_MENU)[number];
export type RowMenuId = (typeof ROW_MENU)[number];
export type RowId = (typeof ROW)[number];
export type AccountId = (typeof ACCOUNT)[number];
export type HintId = (typeof HINT)[number];

/**
 * The panels whose content the sidebar reaches — 自动化 → the page's 目标 / 编排 tabs (the same GoalsPanel /
 * OrchestraPanel the right panel shows; 定时任务 is a view, not a panel), the account menu → 用量与账本.
 * `workbench/panel-entries.ts` counts them as the sidebar's 2-click entries (`sidebarAutomation` / `accountMenu`), so
 * both tables use the same ids.
 */
export const AUTOMATION_PANELS = { goals: 'goals', orchestra: 'orchestra' } as const satisfies Partial<Record<AutomationId, PanelId>>;
export const ACCOUNT_PANELS = { usage: 'usage' } as const satisfies Partial<Record<AccountId, PanelId>>;

export const PLACES = {
  top: TOP, automation: AUTOMATION, section: SECTIONS, head: PROJECTS_HEAD, groupHead: GROUP_HEAD, view: VIEW, custom: CUSTOM,
  project: PROJECT_MENU, row: ROW, rowMenu: ROW_MENU, account: ACCOUNT, hint: HINT,
} as const;
export type Place = keyof typeof PLACES;

/** Each entry point of the sidebar before the redesign → where it is now (`place:id`). */
export const LEGACY: { old: string; now: `${Place}:${string}`[] }[] = [
  { old: tr('收起侧栏 (Ctrl+B)'), now: ['top:collapse'] },
  { old: tr('新会话 (Alt N)'), now: ['top:new'] },
  { old: tr('命令 / 搜索 (Ctrl K)'), now: ['top:search'] },
  { old: tr('设置 (Ctrl ,)'), now: ['account:settings'] },
  { old: tr('设置 · 右键：在右侧面板打开配置中心'), now: ['account:settings'] },
  { old: tr('用量（右侧面板）'), now: ['account:usage'] },
  { old: tr('额度环 + 明细'), now: ['account:quota'] },
  { old: tr('连接状态点 / 重连中…'), now: ['account:connection'] },
  { old: tr('显示已归档（底部开关）'), now: ['view:archived'] },
  { old: tr('主题 / 设置（底部月亮 → 命令面板）'), now: ['account:theme', 'account:appearance', 'top:search'] },
  { old: tr('会话库发现横幅：加入 X'), now: ['hint:library-join'] },
  { old: tr('会话库发现横幅：以后再说'), now: ['hint:library-later'] },
  { old: tr('来源 chip 行'), now: ['view:source'] },
  { old: tr('机器 chip 行'), now: ['view:machine'] },
  { old: tr('筛选会话…（输入框）'), now: ['top:search', 'row:filter'] },
  { old: tr('选择（多选）/ 全选 / 批量归档 / 批量删除'), now: ['rowMenu:select', 'row:select-bar'] },
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
  { old: tr('+N 子任务'), now: ['row:kids', 'rowMenu:kids'] },
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
  { old: tr('会话 ··· · 交给其它 Agent 继续'), now: ['rowMenu:handoff'] },
  { old: tr('会话 ··· · 在原生 CLI 打开'), now: ['rowMenu:native-cli'] },
  { old: tr('会话 ··· · 复制 ID'), now: ['rowMenu:copy-id'] },
  { old: tr('会话 ··· · 删除…'), now: ['rowMenu:delete'] },
  // the icon rail (structure round 2 → redesign 2026-11 stage 1): what it held, where it is now. Its ··· panels that
  // left the sidebar altogether (总览, 共享记忆, Issue 与 PR, Android, 配置中心, 网吧) are in features/palette/moved.ts
  { old: tr('图标栏 · ☰ 应用菜单'), now: ['top:app-menu'] },
  { old: tr('图标栏 · 收起 / 展开侧栏'), now: ['top:collapse'] },
  { old: tr('图标栏 · 对话'), now: ['top:new', 'section:projects'] },
  { old: tr('图标栏 · 后台'), now: ['top:automation', 'automation:running'] },
  { old: tr('图标栏 · 自动化'), now: ['top:automation', 'automation:schedules', 'automation:goals', 'automation:orchestra'] },
  { old: tr('图标栏 · Bot'), now: ['top:automation', 'automation:bots'] },
  { old: tr('图标栏 · 模型'), now: ['account:settings'] },
  { old: tr('图标栏 · 扩展'), now: ['top:extensions'] },
  { old: tr('图标栏 · 更多 · 用量与账本'), now: ['account:usage'] },
  { old: tr('图标栏 · 设置'), now: ['account:settings'] },
  { old: tr('图标栏 · 账号'), now: ['account:account', 'account:quota'] },
  { old: tr('账号菜单 · 字符画主题… / 外观与主题…'), now: ['account:theme', 'account:ascii-themes', 'account:appearance'] },
  // the stage C 显示 menu (one long menu on the 项目 row) → 图 7 (redesign 2026-11 stage 3): six rows on every project /
  // folder header, the choices in submenus; what was not a way of showing the list went where it belongs
  { old: tr('显示 · 筛选对话…（菜单里的输入框）'), now: ['top:search', 'row:filter'] },
  { old: tr('显示 · 分组方式 / 排序（原地展开）'), now: ['groupHead:group-view', 'view:group-by', 'view:sort-by'] },
  { old: tr('显示 · 显示已归档的对话 / 其它 agent 的对话 / 每组'), now: ['view:show', 'view:archived', 'view:other-agents', 'view:per-group'] },
  { old: tr('显示 · 来源 / 机器'), now: ['view:source', 'view:machine'] },
  { old: tr('显示 · 选择多个…'), now: ['rowMenu:select', 'row:select-bar'] },
  { old: tr('显示 · 管理对话来源…'), now: ['view:library'] },
  { old: tr('工作区 ··· 按钮（项目标题上）'), now: ['project:new-here', 'groupHead:new-here'] },
  { old: tr('其它目录 · 设为工作区（文件夹标题上的钉子）'), now: ['project:make-project'] },
];

/** Where the spec's new L0 / L1 entries live (§4.2 / §5.1), beyond the old ones. */
export const ADDED: `${Place}:${string}`[] = ['top:back', 'top:forward', 'top:artifacts', 'automation:running', 'automation:schedules', 'automation:bots', 'automation:goals', 'automation:orchestra', 'section:attention', 'section:projects', 'head:view', 'account:account', 'account:today', 'account:shortcuts', 'account:language', 'account:help', 'account:whats-new', 'view:library', 'view:group-by', 'view:sort-by', 'view:other-agents', 'view:per-group', 'view:new-section', 'view:reset', 'view:all', 'section:custom', 'custom:custom-section', 'custom:custom-rename', 'custom:custom-delete', 'custom:custom-out', 'row:less', 'project:move-top', 'project:move-up', 'project:move-down', 'project:edit', 'account:ascii-themes', 'account:expired', 'account:login', 'account:logout', 'rowMenu:handoff-peer', 'rowMenu:section-add', 'rowMenu:section-out', 'row:select-section', 'view:show', 'groupHead:group-view', 'groupHead:new-here', 'rowMenu:select', 'row:filter'];

export function resolves(ref: `${Place}:${string}`): boolean {
  const [place, id] = ref.split(':') as [Place, string];
  return !!PLACES[place] && (PLACES[place] as readonly string[]).includes(id);
}
