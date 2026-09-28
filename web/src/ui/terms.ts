// User-facing vocabulary (spec 2026-09-28 §5.12). One place defines what the interface calls things, so the words
// the code uses (session, workspace, pane, dock, effort, ultracode, profile, engine, ACP, handoff…) never leak
// into default screens. Protocol values, meta.json keys, command ids and shortcut ids are NOT renamed — only
// the labels. Raw values stay available for tooltips (`effortTitle`) so long-time users can still map them.
import type { EffortLevel, PermissionMode } from '@shared';
import type { WorkbenchTab } from '@/model/layout';

/** Implementation word → interface word. */
export const TERMS = {
  session: '对话',
  workspace: '项目',
  tile: '标签页',
  pane: '分屏',
  dock: '右侧面板',
  effort: '智能程度',
  ultracode: '深度编排',
  provider: '供应商',
  engine: '运行内核',
  agents: '其它 Agent',
  handoff: '交给其它 Agent 继续',
  trajectory: '步骤视图',
  artifacts: '生成的文件',
  worktree: '独立副本（worktree）',
  steer: '立即插话',
  workbench: '显示工作台工具',
} as const;

export interface ModeTerm { label: string; desc: string; recommended?: boolean; danger?: boolean }

/** Permission modes: what happens, not what the mechanism is called. Order = menu order. */
export const PERMISSION_MODES: Record<PermissionMode, ModeTerm> = {
  default: { label: '每步询问', desc: '改文件、运行命令之前都先问你', recommended: true },
  acceptEdits: { label: '自动改文件', desc: '直接改文件；运行命令之前问你' },
  plan: { label: '只做计划', desc: '先读代码、写方案，你点头后才动手' },
  auto: { label: '自动判断', desc: 'Claude 自己判断哪些操作需要问你' },
  dontAsk: { label: '只做已允许的', desc: '不弹确认；没事先允许的操作一律跳过' },
  bypassPermissions: { label: '完全放开', desc: '什么都不问直接执行。只在可以随便弄坏的环境里用', danger: true },
};
export const PERMISSION_MODE_ORDER = Object.keys(PERMISSION_MODES) as PermissionMode[];
/** Short label per mode (chips, selects). */
export const MODE_LABEL = Object.fromEntries(PERMISSION_MODE_ORDER.map((m) => [m, PERMISSION_MODES[m].label])) as Record<PermissionMode, string>;

/** Effort levels as an intelligence scale. `ultra` exists only for Codex. */
export const EFFORT_LABEL: Record<EffortLevel, string> = { low: '快', medium: '均衡', high: '深入', xhigh: '更深', max: '极限', ultra: '超限' };
export const EFFORT_DESC: Record<EffortLevel, string> = {
  low: '最快，适合简单问答和小改动',
  medium: '速度与质量兼顾',
  high: '复杂改动更稳，速度适中',
  xhigh: '想得更久，适合难排查的问题',
  max: '最长的思考，慢、费额度',
  ultra: '最深推理，最慢',
};
/** Label for an effort value; unknown / empty values fall back to the scale's name. */
export function effortLabel(level: string | null | undefined): string {
  return level && level in EFFORT_LABEL ? EFFORT_LABEL[level as EffortLevel] : TERMS.effort;
}
/** Tooltip that keeps the raw value for people who know the old names. */
export function effortTitle(level: string | null | undefined, note?: string): string {
  const head = level && level in EFFORT_LABEL ? `${TERMS.effort}：${EFFORT_LABEL[level as EffortLevel]}（effort: ${level}）· ${EFFORT_DESC[level as EffortLevel]}` : `${TERMS.effort}（effort）`;
  return note ? `${head}\n${note}` : head;
}

export const ULTRACODE = {
  label: TERMS.ultracode,
  desc: '最深思考 + 自动拆成并行子任务，更慢、更费额度',
  title: `${TERMS.ultracode}（ultracode）：最深思考 + 自动拆成并行子任务，更慢、更费额度。对整个对话生效`,
} as const;

/**
 * Where 「显示工作台工具」 lives in the settings window (the 通用 page since the settings regroup, redesign phase 6;
 * features/settings/catalog.test.ts checks it against the settings map). The one-time notice below follows.
 */
export const WORKBENCH_SETTING_PATH = '设置 → 通用';
/** One-time toast for people who knew the old screen and land on the simplified one (ui.simplifiedNotice). */
export const SIMPLIFIED_NOTICE = `界面已简化；需要分屏 / 标签 / 面板图标栏可在 ${WORKBENCH_SETTING_PATH} 打开「${TERMS.workbench}」`;

/** The connection to the server is down (the main area's banner, the account row). */
export const DISCONNECTED = '连接断开，正在重连…';

/**
 * Empty states say one thing the same way (spec §5.8): 「还没有 X。Y 之后会出现在这里。」 — with at most one button next
 * to it. `subject` names what appears when that is not X itself (「…打开一个对话之后，它的改动会出现在这里。」).
 */
export interface EmptyTerm { what: string; when: string; subject?: string }
export function emptyText(e: EmptyTerm): string {
  return `还没有${e.what}。${e.when}之后${e.subject ? `，${e.subject}` : ''}会出现在这里。`;
}
export const EMPTY = {
  // the right panel
  reviewNoChat: { what: '打开对话', when: '打开一个对话', subject: '它的改动' },
  reviewSession: { what: '改动', when: 'Claude 改了文件' },
  reviewUncommitted: { what: '未提交的改动', when: '项目里的文件有了改动' },
  reviewStaged: { what: '暂存的改动', when: '在「未提交的改动」里暂存文件' },
  filesNoChat: { what: '打开对话', when: '打开一个对话', subject: '它所在项目的文件' },
  artifacts: { what: '生成的文件', when: 'Claude 新建了文件' },
  tasksNoChat: { what: '打开对话', when: '打开一个对话', subject: '它的子代理、后台任务和计划' },
  tasks: { what: '子代理或后台任务', when: 'Claude 派出子代理、在后台跑命令' },
  // the automation page
  schedules: { what: '定时任务', when: '设好时间和提示词' },
  scheduleRuns: { what: '运行记录', when: '定时任务跑过一次' },
  goals: { what: '目标', when: '用「新目标」或在输入框里输入 /goal 设定一个' },
  workflows: { what: '工作流', when: '新建一个或从模板开始' },
  orchestraRuns: { what: '运行记录', when: '运行一个工作流' },
  // the start page
  recent: { what: '对话', when: '发出第一个任务' },
  archived: { what: '归档的对话', when: '归档一个对话' },
} as const satisfies Record<string, EmptyTerm>;

/**
 * Palette / rail label for toggling a right-panel tab, from what the toggle will do (`panelToggleEffect`): the
 * terminal is only hidden (its process keeps running), other panels close their tab — except the fixed tabs of the
 * default right panel, which are hidden too (`keepAlive` false: nothing keeps running, so no 后台 note).
 */
export function panelToggleLabel(effect: 'show' | 'hide' | 'remove', title: string, keepAlive = true): string {
  return effect === 'show' ? `打开${title}面板` : effect === 'hide' ? `隐藏${title}面板${keepAlive ? '（继续在后台运行）' : ''}` : `关闭${title}面板`;
}

/** The per-session views that used to be the 8 workbench tabs (spec §4.2). */
export const WORKBENCH_VIEW_LABEL: Record<WorkbenchTab, string> = {
  live: '对话',
  changes: '改动',
  git: 'Git',
  files: '文件',
  search: '搜索',
  schedules: '定时任务',
  artifacts: TERMS.artifacts,
  board: 'Issue 与 PR',
};
