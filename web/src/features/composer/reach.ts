import { PERMISSION_MODE_ORDER, PERMISSION_MODES } from '@/ui/terms';
import { CAPABILITIES } from './capabilities';
import { BAR_ID, MODEL_MENU_ID, PLUS_ID, PROJECT_MENU_ID, idSel } from './ids';

/**
 * Where every control of the old composer went (spec §4.2, the 「输入框：…」 rows; phase 3 acceptance: 原「功能」6
 * 项、agent 选择、档案、effort、ultracode 全部可达). `sel` is a selector inside the place's container, built from the
 * same id tables the components render with (ids.ts, CAPABILITIES, PERMISSION_MODE_ORDER). reach.test.ts checks the
 * table against those tables; ui-smoke opens every place and queries every selector (window.__cwComposerReach).
 */
export type ComposerPlace = 'plus' | 'project' | 'model' | 'permission' | 'bar' | 'meter';

export interface ReachEntry {
  was: string;
  place: ComposerPlace;
  sel: string;
  /**
   * only present in some states: a running turn (插话), a browser with speech recognition (mic), a conversation with
   * something to count — a turn or a reported occupancy (the ring / stats icon), the + menu's 「Brief、频道…」 expanded
   */
  when?: 'running' | 'speech' | 'usage' | 'more';
}

/** The element each place lives in (after its chip is clicked). */
export const PLACE_CONTAINER: Record<ComposerPlace, string> = {
  plus: '.menu.plus-menu',
  project: '.menu.dirmenu',
  model: '.menu.mm',
  permission: '.menu.perm-menu',
  bar: '.composer-bar',
  meter: '.composer-bar',
};
/** What to click to open the place (none: always on screen). */
export const PLACE_OPENER: Partial<Record<ComposerPlace, string>> = {
  plus: '.cb .plus',
  project: '.dirpick',
  model: '.mm-anchor > button.chip',
  permission: '.cb .perm-chip',
};

const OLD_FEATURE_NAME: Record<string, string> = { chrome: 'Claude in Chrome', computerUse: 'Computer Use', coordinator: '协调者模式', proactive: '主动模式', brief: 'Brief' };
const OLD_MODE_NAME: Record<string, string> = { default: '每次询问', acceptEdits: '自动接受编辑', plan: '计划模式', auto: '自动模式', dontAsk: '不询问', bypassPermissions: '完全权限' };

export const COMPOSER_REACH: ReachEntry[] = [
  // `+` (the old paperclip + the 「功能」 dropdown)
  { was: '添加图片 / 文件', place: 'plus', sel: idSel(PLUS_ID.files) },
  { was: '拖入文件夹（现在也能点）', place: 'plus', sel: idSel(PLUS_ID.folder) },
  { was: '引用到输入框（会话菜单）', place: 'plus', sel: idSel(PLUS_ID.reference) },
  ...CAPABILITIES.map((c): ReachEntry => ({ was: `功能 · ${OLD_FEATURE_NAME[c.key] ?? c.key}`, place: 'plus', sel: idSel(c.key), when: c.key === 'brief' ? 'more' : undefined })),
  { was: '功能 · 频道', place: 'plus', sel: idSel(PLUS_ID.channels), when: 'more' },
  { was: '（展开 Brief、频道）', place: 'plus', sel: idSel(PLUS_ID.more) },
  { was: '/goal 目标', place: 'plus', sel: idSel(PLUS_ID.goal) },
  // the welcome page's directory chip and its 「…」
  { was: '选择目录（最近的目录）', place: 'project', sel: '[data-dir]' },
  { was: '… 浏览文件夹', place: 'project', sel: idSel(PROJECT_MENU_ID.browse) },
  { was: 'worktree 会话（侧栏菜单）', place: 'project', sel: idSel(PROJECT_MENU_ID.worktree) },
  // the model menu: agent, profile, model, effort, ultracode, refresh, manage
  { was: 'Claude Code / 其它 agent 选择', place: 'model', sel: '[data-sec^="agent:"]' },
  { was: '供应商档案 / 模型', place: 'model', sel: '[data-sec="builtin"] .mm-row' },
  { was: '+ 添加供应商档案…', place: 'model', sel: idSel(MODEL_MENU_ID.addProvider) },
  { was: '管理 agent…', place: 'model', sel: idSel(MODEL_MENU_ID.agents) },
  { was: 'effort', place: 'model', sel: idSel(MODEL_MENU_ID.effort) },
  { was: 'ultracode', place: 'model', sel: idSel(MODEL_MENU_ID.ultracode) },
  { was: '刷新全部模型', place: 'model', sel: idSel(MODEL_MENU_ID.refresh) },
  { was: '管理模型…', place: 'model', sel: idSel(MODEL_MENU_ID.manage) },
  // permission: all six modes
  ...PERMISSION_MODE_ORDER.map((m) => ({ was: `权限 · ${OLD_MODE_NAME[m] ?? PERMISSION_MODES[m].label}`, place: 'permission' as const, sel: `[data-mode="${m}"]` })),
  // the row itself
  { was: '语音输入', place: 'bar', sel: idSel(BAR_ID.mic), when: 'speech' },
  { was: '插话', place: 'bar', sel: idSel(BAR_ID.steer), when: 'running' },
  { was: '发送 / 中断', place: 'bar', sel: idSel(BAR_ID.send) },
  // the stats bar under the composer (a conversation with context usage)
  { was: '统计栏（轮数 / token / 缓存 / 费用 / 上轮 / 上下文 / 后台任务）', place: 'meter', sel: idSel(BAR_ID.meter), when: 'usage' },
];
