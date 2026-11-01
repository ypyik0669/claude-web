import { PERMISSION_MODE_ORDER, PERMISSION_MODES } from '@/ui/terms';
import { CAPABILITIES } from './capabilities';
import { BAR_ID, EFFORT_MENU_ID, MODEL_MENU_ID, PLUS_ID, PROJECT_MENU_ID, idSel } from './ids';
import { tr } from '@/i18n';

/**
 * Where every control of the old composer went (spec §4.2, the 「输入框：…」 rows; phase 3 acceptance: 原「功能」6
 * 项、agent 选择、档案、effort、ultracode 全部可达). `sel` is a selector inside the place's container, built from the
 * same id tables the components render with (ids.ts, CAPABILITIES, PERMISSION_MODE_ORDER). reach.test.ts checks the
 * table against those tables; ui-smoke opens every place and queries every selector (window.__cwComposerReach).
 */
export type ComposerPlace = 'plus' | 'project' | 'model' | 'depth' | 'permission' | 'bar' | 'meter';

export interface ReachEntry {
  was: string;
  place: ComposerPlace;
  sel: string;
  /**
   * only present in some states: a running turn (插话), a browser with speech recognition (mic), a conversation with
   * a context filling up (≥ 60 %: the ring — its card is also the header ··· 「本对话用量」, final review I3), a
   * conversation (not the welcome page: 连接器 ›), Claude's fast mode reported by the CLI (first-party accounts), a model list longer than five (更多模型 ›)
   */
  when?: 'running' | 'speech' | 'usage' | 'live' | 'fast' | 'manyModels';
}

/** The element each place lives in (after its chip is clicked). */
export const PLACE_CONTAINER: Record<ComposerPlace, string> = {
  plus: '.menu.plus-menu',
  project: '.menu.dirmenu',
  model: '.menu.mm',
  depth: '.menu.depth-menu',
  permission: '.menu.perm-menu',
  bar: '.composer-bar',
  meter: '.cb',
};
/** What to click to open the place (none: always on screen). */
export const PLACE_OPENER: Partial<Record<ComposerPlace, string>> = {
  plus: '.cb .plus',
  project: '.dirpick',
  model: '.mm-anchor > button.chip',
  depth: '.cb .depth-chip',
  permission: '.cb .perm-chip',
};

const OLD_FEATURE_NAME: Record<string, string> = { chrome: 'Claude in Chrome', computerUse: 'Computer Use', brief: 'Brief' };
const OLD_MODE_NAME: Record<string, string> = { default: tr('每次询问'), acceptEdits: tr('自动接受编辑'), plan: tr('计划模式'), auto: tr('自动模式'), dontAsk: tr('不询问'), bypassPermissions: tr('完全权限') };

export const COMPOSER_REACH: ReachEntry[] = [
  // `+` (the old paperclip + the 「功能」 dropdown)
  { was: tr('添加图片 / 文件'), place: 'plus', sel: idSel(PLUS_ID.files) },
  { was: tr('拖入文件夹（现在也能点）'), place: 'plus', sel: idSel(PLUS_ID.folder) },
  { was: tr('引用到输入框（会话菜单）'), place: 'plus', sel: idSel(PLUS_ID.reference) },
  ...CAPABILITIES.map((c): ReachEntry => ({ was: tr('功能 · {key}', { key: OLD_FEATURE_NAME[c.key] ?? c.key }), place: 'plus', sel: idSel(c.key) })),
  { was: tr('/goal 目标'), place: 'plus', sel: idSel(PLUS_ID.goal) },
  { was: tr('斜杠命令'), place: 'plus', sel: idSel(PLUS_ID.slash) },
  { was: tr('连接器'), place: 'plus', sel: idSel(PLUS_ID.connectors), when: 'live' },
  // the welcome page's directory chip and its 「…」
  { was: tr('选择目录（最近的目录）'), place: 'project', sel: '[data-dir]' },
  { was: tr('… 浏览文件夹'), place: 'project', sel: idSel(PROJECT_MENU_ID.browse) },
  { was: tr('worktree 会话（侧栏菜单）'), place: 'project', sel: idSel(PROJECT_MENU_ID.worktree) },
  // the model menu: profile, model, refresh, manage — and the chip next to it (place `depth`): effort, ultracode
  { was: tr('供应商档案 / 模型'), place: 'model', sel: '[data-sec="builtin"] .mm-row' },
  { was: tr('+ 添加供应商档案…'), place: 'model', sel: idSel(MODEL_MENU_ID.addProvider) },
  { was: 'effort', place: 'depth', sel: idSel(EFFORT_MENU_ID.effort) },
  { was: 'ultracode', place: 'depth', sel: idSel(EFFORT_MENU_ID.ultracode) },
  { was: tr('刷新全部模型'), place: 'model', sel: idSel(MODEL_MENU_ID.refresh) },
  { was: tr('管理模型…'), place: 'model', sel: idSel(MODEL_MENU_ID.manage) },
  { was: tr('强度 ›'), place: 'model', sel: idSel(MODEL_MENU_ID.effort) },
  { was: tr('快速模式'), place: 'model', sel: idSel(MODEL_MENU_ID.fast), when: 'fast' },
  { was: tr('更多模型 ›'), place: 'model', sel: idSel(MODEL_MENU_ID.more), when: 'manyModels' },
  // permission: all six modes
  ...PERMISSION_MODE_ORDER.map((m) => ({ was: tr('权限 · {label}', { label: OLD_MODE_NAME[m] ?? PERMISSION_MODES[m].label }), place: 'permission' as const, sel: `[data-mode="${m}"]` })),
  // the row itself
  { was: tr('语音输入'), place: 'bar', sel: idSel(BAR_ID.mic), when: 'speech' },
  { was: tr('插话'), place: 'bar', sel: idSel(BAR_ID.steer), when: 'running' },
  { was: tr('发送 / 中断'), place: 'bar', sel: idSel(BAR_ID.send) },
  // the stats bar under the composer (a conversation with context usage)
  { was: tr('统计栏（轮数 / token / 缓存 / 费用 / 上轮 / 上下文 / 后台任务）'), place: 'meter', sel: idSel(BAR_ID.meter), when: 'usage' },
];
