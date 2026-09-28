import { FEATURE_KEYS, plusSections } from './capabilities';

/**
 * Where every control of the old composer went (spec §4.2, the 「输入框：…」 rows; phase 3 acceptance: 原「功能」6
 * 项、agent 选择、档案、effort、ultracode 全部可达). `id` is the `data-id` / `data-mode` the new control carries in
 * the DOM — ui-smoke clicks through the same ids, reach.test.ts checks them against the menus' own tables.
 */
export type ComposerPlace = 'plus' | 'project' | 'model' | 'permission' | 'bar' | 'meter';

export const COMPOSER_REACH: { was: string; place: ComposerPlace; id: string }[] = [
  // `+` (the old paperclip + the 「功能」 dropdown)
  { was: '添加图片 / 文件', place: 'plus', id: 'files' },
  { was: '拖入文件夹（现在也能点）', place: 'plus', id: 'folder' },
  { was: '引用到输入框（会话菜单）', place: 'plus', id: 'reference' },
  { was: '功能 · Claude in Chrome', place: 'plus', id: 'chrome' },
  { was: '功能 · Computer Use', place: 'plus', id: 'computerUse' },
  { was: '功能 · 协调者模式', place: 'plus', id: 'coordinator' },
  { was: '功能 · 主动模式', place: 'plus', id: 'proactive' },
  { was: '功能 · Brief', place: 'plus', id: 'brief' },
  { was: '功能 · 频道', place: 'plus', id: 'channels' },
  { was: '/goal 目标', place: 'plus', id: 'goal' },
  // the welcome page's directory chip and its 「…」
  { was: '选择目录（最近的目录）', place: 'project', id: 'recent' },
  { was: '… 浏览文件夹', place: 'project', id: 'browse' },
  { was: 'worktree 会话（侧栏菜单）', place: 'project', id: 'worktree' },
  // the model menu: agent, profile, model, effort, ultracode, refresh, manage
  { was: 'Claude Code / 其它 agent 选择', place: 'model', id: 'agent' },
  { was: '+ 添加供应商档案…', place: 'model', id: 'add-provider' },
  { was: '管理 agent…', place: 'model', id: 'agents' },
  { was: '供应商档案 / 模型', place: 'model', id: 'model' },
  { was: 'effort', place: 'model', id: 'effort' },
  { was: 'ultracode', place: 'model', id: 'ultracode' },
  { was: '刷新全部模型', place: 'model', id: 'refresh' },
  { was: '管理模型…', place: 'model', id: 'manage' },
  // permission: all six modes + the default for new conversations
  { was: '权限 · 每次询问', place: 'permission', id: 'default' },
  { was: '权限 · 自动接受编辑', place: 'permission', id: 'acceptEdits' },
  { was: '权限 · 计划模式', place: 'permission', id: 'plan' },
  { was: '权限 · 自动模式', place: 'permission', id: 'auto' },
  { was: '权限 · 不询问', place: 'permission', id: 'dontAsk' },
  { was: '权限 · 完全权限', place: 'permission', id: 'bypassPermissions' },
  // the row itself
  { was: '语音输入', place: 'bar', id: 'mic' },
  { was: '插话', place: 'bar', id: 'steer' },
  { was: '发送 / 中断', place: 'bar', id: 'send' },
  // the stats bar under the composer
  { was: '统计栏（轮数 / token / 缓存 / 费用 / 上轮 / 上下文 / 后台任务）', place: 'meter', id: 'usage' },
];

/** The ids the + menu renders (attachments, capabilities, channels, goal) — from the menu's own tables. */
export function plusIds(): string[] {
  const s = plusSections({ claude: true, live: false });
  return [...s.attach.map((a) => a.id), ...FEATURE_KEYS, 'channels', 'goal'];
}

/** The model menu's controls (ModelMenu renders these as data-id / section kinds). */
export const MODEL_MENU_IDS = ['agent', 'add-provider', 'agents', 'model', 'effort', 'ultracode', 'refresh', 'manage'] as const;
export const PROJECT_MENU_IDS = ['recent', 'browse', 'worktree'] as const;
export const BAR_IDS = ['mic', 'steer', 'send'] as const;
