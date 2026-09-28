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

/** A panel toggle on a phone, where the right panel is not drawn (spec §5.11; the bottom drawer comes in phase 7). */
export const PHONE_NO_PANEL = `手机上没有${TERMS.dock}：改动 / Git / 文件在对话右上角的 ··· 里`;
/** `openSchedules()` on a phone with no conversation open (with one, the list opens in its place). */
export const PHONE_SCHEDULES_NO_CHAT = '手机上的定时任务在对话右上角的 ··· 里：先打开一个对话';
/** `openSchedules()` on a phone whose current conversation is on another machine (its ··· has no scheduled tasks). */
export const PHONE_SCHEDULES_REMOTE = '这个对话在另一台机器上：打开一个本机的对话，再从右上角的 ··· 打开定时任务';
/** 详情 (a tool row, an attachment chip) on a phone: no right panel; a step opens in place in the conversation. */
export const PHONE_NO_INSPECTOR = `手机上没有${TERMS.dock}：点对话里的这一步就能展开它的输入和结果`;

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

/** Chat rendering (redesign phase 5, spec §5.3): a step blocked on the user (yellow = 「需要你」, §6.4). */
export const WAITING_FOR_YOU = '等你确认';
/** Under a card docked above the composer: the composer is where a different instruction goes (sending it = deny with those words). */
export const DOCK_HINT = {
  tool: (agent: string) => `也可以直接在下面输入，告诉 ${agent} 换个做法`,
  plan: () => '也可以直接在下面输入修改意见',
  ask: (agent: string) => `也可以直接在下面输入，不回答这些问题，直接告诉 ${agent}`,
} as const;
/** The composer's placeholder while a card is docked above it (a plan is approved by a click or Ctrl+Enter only). */
export const DOCK_PLACEHOLDER = {
  tool: (agent: string) => `告诉 ${agent} 换个做法（发送 = 拒绝并说明）· 空着按 Enter = 允许一次`,
  plan: () => '写下修改意见后按 Enter 发出 · 批准请点「批准并开始」或按 Ctrl+Enter',
  ask: (agent: string) => `直接回复 ${agent}（发送 = 不回答这些问题）`,
} as const;
/** The send slot while a card is docked and the box has words. */
export const DOCK_SEND = { tool: '拒绝并发送', plan: '要求修改', ask: '跳过并发送' } as const;
/** On the card, when the box already had words before it came: Enter queues them as before (review I3). */
export const DOCK_CARRIED = '输入框里的话是这张卡出现前写的：按 Enter 照常排队发送，不会当成回答';
/** On the card, once those words were queued: its secondary button takes them back as the answer (Enter keeps its usual meaning). */
export const DOCK_REQUEUED = { tool: '那段话已排队发送；想用它拒绝这次操作，点右边的按钮', plan: '那段话已排队发送；想把它当修改意见，点右边的按钮', ask: '那段话已排队发送；想跳过提问、改发这段话，点右边的按钮' } as const;
/** The card's secondary button after words were queued: take the queued message back and answer with it. */
export const DOCK_DENY_QUEUED = { tool: '改用排队的这段话拒绝', plan: '改用排队的这段话要求修改', ask: '改用排队的这段话回复' } as const;
/** Words and attachments while a card is docked: a deny carries words only (review M2). */
export const DOCK_BLOCKED = '附件不能随拒绝一起发出：先处理上面的卡片，或者移除附件';
/** The setting that opens every change in the conversation again (`ui.inlineDiffs`; off by default since phase 5). */
export const INLINE_DIFFS_LABEL = '在对话里直接展开改动';
