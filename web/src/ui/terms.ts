// User-facing vocabulary (spec 2026-09-28 §5.12). One place defines what the interface calls things, so the words
// the code uses (session, workspace, pane, dock, effort, ultracode, profile, engine, ACP, handoff…) never leak
// into default screens. Protocol values, meta.json keys, command ids and shortcut ids are NOT renamed — only
// the labels. Raw values stay available for tooltips (`effortTitle`) so long-time users can still map them.
import type { EffortLevel, PermissionMode } from '@shared';
import type { WorkbenchTab } from '@/model/layout';
import { getLocale, tr, trAs } from '@/i18n';

/** Implementation word → interface word. */
export const TERMS = {
  session: tr('对话'),
  workspace: tr('项目'),
  tile: tr('标签页'),
  pane: tr('分屏'),
  dock: tr('右侧面板'),
  effort: tr('智能程度'),
  ultracode: tr('深度编排'),
  provider: tr('供应商'),
  engine: tr('运行内核'),
  agents: tr('其它 Agent'),
  handoff: tr('交给其它 Agent 继续'),
  trajectory: tr('步骤视图'),
  artifacts: tr('生成的文件'),
  worktree: tr('独立副本（worktree）'),
  steer: tr('立即插话'),
  workbench: tr('显示工作台工具'),
} as const;

export interface ModeTerm { label: string; desc: string; recommended?: boolean; danger?: boolean }

/** Permission modes: what happens, not what the mechanism is called. Order = menu order. */
export const PERMISSION_MODES: Record<PermissionMode, ModeTerm> = {
  default: { label: tr('每步询问'), desc: tr('改文件、运行命令之前都先问你'), recommended: true },
  acceptEdits: { label: tr('自动改文件'), desc: tr('直接改文件；运行命令之前问你') },
  plan: { label: tr('只做计划'), desc: tr('先读代码、写方案，你点头后才动手') },
  auto: { label: tr('自动判断'), desc: tr('Claude 自己判断哪些操作需要问你') },
  dontAsk: { label: tr('只做已允许的'), desc: tr('不弹确认；没事先允许的操作一律跳过') },
  bypassPermissions: { label: tr('完全放开'), desc: tr('什么都不问直接执行，操控电脑和网页脚本也不问。只在可以随便弄坏的环境里用'), danger: true },
};
export const PERMISSION_MODE_ORDER = Object.keys(PERMISSION_MODES) as PermissionMode[];
/** Shift+Tab's next mode: round the safe ones (a dangerous mode is only ever picked from the menu). */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const safe = PERMISSION_MODE_ORDER.filter((m) => !PERMISSION_MODES[m].danger);
  return safe[(safe.indexOf(mode) + 1) % safe.length] ?? 'default';
}
/** Short label per mode (chips, selects). */
export const MODE_LABEL = Object.fromEntries(PERMISSION_MODE_ORDER.map((m) => [m, PERMISSION_MODES[m].label])) as Record<PermissionMode, string>;

/** Effort levels as an intelligence scale. `ultra` exists only for Codex. */
export const EFFORT_LABEL: Record<EffortLevel, string> = { low: tr('快'), medium: tr('均衡'), high: tr('深入'), xhigh: tr('更深'), max: tr('极限'), ultra: tr('超限') };
export const EFFORT_DESC: Record<EffortLevel, string> = {
  low: tr('最快，适合简单问答和小改动'),
  medium: tr('速度与质量兼顾'),
  high: tr('复杂改动更稳，速度适中'),
  xhigh: tr('想得更久，适合难排查的问题'),
  max: tr('最长的思考，慢、费额度'),
  ultra: tr('最深推理，最慢'),
};
/** After the 智能程度 caption: the strength goes out as the model's own parameter, or through the prompt. */
export const EFFORT_MODE_NOTE = { native: tr('（原生）'), prompt: tr('（通过提示词）') } as const;
/** Tooltip of the prompt way. */
export const EFFORT_PROMPT_TITLE = tr('这个模型没有思考强度参数，通过提示词告诉它想多深');
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
  desc: tr('大任务用：它先拆成几块，分给几个子代理同时做，你在「后台」看进度。小问题别开，更慢、更费额度'),
  title: tr('{ultracode}（ultracode）：给大任务用。打开后说一件大一点的事（比如「把登录模块重构一下，顺便补测试」），它会先拆成几块，分给几个子代理同时做，最后汇总给你；进度在「后台」看。想得最深，更慢、更费额度。对整个对话生效，再点一次关掉', { ultracode: TERMS.ultracode }),
  /** said once when it is switched on: what to do next */
  on: tr('{ultracode}已打开：说一件大一点的事，它会拆开分给几个子代理同时做，进度在「后台」看', { ultracode: TERMS.ultracode }),
  /** the composer's placeholder while it is on */
  placeholder: tr('说一件大一点的事，比如「把登录模块重构一下，顺便补测试」——它会分给几个子代理同时做'),
} as const;

/**
 * Where 「显示工作台工具」 lives in the settings window (the 通用 page since the settings regroup, redesign phase 6;
 * features/settings/catalog.test.ts checks it against the settings map). The one-time notice below follows.
 */
export const WORKBENCH_SETTING_PATH = tr('设置 → 通用');
/** One-time toast for people who knew the old screen and land on the simplified one (ui.simplifiedNotice). */
export const SIMPLIFIED_NOTICE = tr('界面已简化；需要分屏 / 标签 / 面板图标栏可在 {WORKBENCH_SETTING_PATH} 打开「{workbench}」', { WORKBENCH_SETTING_PATH, workbench: TERMS.workbench });

/** The connection to the server is down (the main area's banner, the account row). */
export const DISCONNECTED = tr('连接断开，正在重连…');

/**
 * 「用 Claude 账号登录」 (the first-run wizard, the start page's notice, the 接一个模型 dialog): a terminal tab runs
 * `claude auth login` — the subscription route; everyone else connects a model with an API key instead.
 */
export const LOGIN_IN_TERMINAL = tr('终端里在运行 claude auth login：按提示登录 Claude 账号，登录好回到这里。没有 Claude 订阅（或所在地区连不上 Anthropic）就用「接一个模型」填中转站或其它厂商的 API Key');
/** the command the 「在终端登录」 buttons run in a terminal tab (the terminal is a shell) */
export const CLAUDE_LOGIN_CMD = 'claude auth login';

/**
 * Empty states say one thing the same way (spec §5.8): 「还没有 X。Y 之后会出现在这里。」 — with one or two buttons next
 * to it. `subject` names what appears when that is not X itself (「…打开一个对话之后，它的改动会出现在这里。」).
 */
export interface EmptyTerm { what: string; when: string; subject?: string; /** stage E4: said as is instead of the template */ line?: string }
/** English nouns come capitalised from the catalogs (they are also headings): in the middle of a sentence they are not. */
const inSentence = (s: string) => (getLocale() === 'en' && /^[A-Z][a-z]/.test(s) && !/^(Claude|Codex|Git|GitHub)\b/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
export function emptyText(e: EmptyTerm): string {
  if (e.line) return e.line;
  const what = inSentence(e.what);
  return e.subject ? tr('还没有{what}。{when}之后，{subject}会出现在这里。', { what, when: e.when, subject: e.subject }) : tr('还没有{what}。{when}之后会出现在这里。', { what, when: e.when });
}
export const EMPTY = {
  // the right panel
  reviewNoChat: { what: tr('打开对话'), when: tr('打开一个对话'), subject: tr('它的改动') },
  reviewSession: { what: tr('改动'), when: tr('Claude 改了文件') },
  reviewUncommitted: { what: tr('未提交的改动'), when: tr('项目里的文件有了改动') },
  reviewStaged: { what: tr('暂存的改动'), when: tr('在「未提交的改动」里暂存文件') },
  filesNoChat: { what: tr('打开对话'), when: tr('打开一个对话'), subject: tr('它所在项目的文件') },
  // stage E4: 本对话的文件 with none yet; a conversation without a folder
  filesSession: { what: tr('文件'), when: tr('Claude 读文件或改文件'), line: tr('Claude 读过和改过的文件会显示在这里') },
  filesNoFolder: { what: tr('打开的文件夹'), when: tr('打开一个文件夹'), subject: tr('文件夹里的文件') },
  artifacts: { what: tr('生成的文件'), when: tr('Claude 新建了文件') },
  tasksNoChat: { what: tr('打开对话'), when: tr('打开一个对话'), subject: tr('它的子代理、后台任务和计划') },
  tasks: { what: tr('子代理或后台任务'), when: tr('Claude 派出子代理、在后台跑命令') },
  // 后台
  background: { what: tr('在跑的子代理'), when: tr('对话里派出子代理、跑工作流或后台命令') },
  // the Bot page
  bots: { what: tr('Bot'), when: tr('新建一个 Bot'), line: tr('还没有 Bot。从晨报、PR 巡检、收件箱分拣里挑一个开始') },
  // the automation page
  schedules: { what: tr('定时任务'), when: tr('设好时间和提示词') },
  scheduleRuns: { what: tr('运行记录'), when: tr('定时任务跑过一次') },
  goals: { what: tr('目标'), when: tr('用「新目标」或在输入框里输入 /goal 设定一个') },
  workflows: { what: tr('工作流'), when: tr('新建一个或从模板开始') },
  workflowOpen: { what: tr('打开的工作流'), when: tr('在左边选一个工作流或新建一个') },
  orchestraRuns: { what: tr('运行记录'), when: tr('运行一个工作流') },
  orphans: { what: tr('遗留的独立副本'), when: tr('删除运行记录时没清理它的独立副本') },
  // the built-in browser's 管理允许的网站…
  allowedSites: { what: tr('允许的网站'), when: tr('在授权卡上选「总是允许这个网站」') },
  // the start page
  recent: { what: tr('对话'), when: trAs('发出第一个任务', 'you send your first task') },
  archived: { what: tr('归档的对话'), when: tr('归档一个对话') },
} as const satisfies Record<string, EmptyTerm>;

/**
 * Palette / rail label for toggling a right-panel tab, from what the toggle will do (`panelToggleEffect`): the
 * terminal is only hidden (its process keeps running), other panels close their tab — except the fixed tabs of the
 * default right panel, which are hidden too (`keepAlive` false: nothing keeps running, so no 后台 note).
 */
export function panelToggleLabel(effect: 'show' | 'hide' | 'remove', title: string, keepAlive = true): string {
  return effect === 'show' ? tr('打开{title}面板', { title }) : effect === 'hide' ? tr('隐藏{title}面板{v}', { title, v: keepAlive ? tr('（继续在后台运行）') : '' }) : tr('关闭{title}面板', { title });
}

/** The per-session views that used to be the 8 workbench tabs (spec §4.2). */
export const WORKBENCH_VIEW_LABEL: Record<WorkbenchTab, string> = {
  live: tr('对话'),
  changes: tr('改动'),
  git: 'Git',
  files: tr('文件'),
  search: tr('搜索'),
  schedules: tr('定时任务'),
  artifacts: TERMS.artifacts,
  board: tr('Issue 与 PR'),
};

/** Chat rendering (redesign phase 5, spec §5.3): a step blocked on the user (yellow = 「需要你」, §6.4). */
export const WAITING_FOR_YOU = tr('等你确认');
/** Under a card docked above the composer: the composer is where a different instruction goes (sending it = deny with those words). */
export const DOCK_HINT = {
  tool: (agent: string) => tr('也可以直接在下面输入，告诉 {agent} 换个做法', { agent }),
  plan: () => tr('也可以直接在下面输入修改意见'),
  ask: (agent: string) => tr('也可以直接在下面输入，不回答这些问题，直接告诉 {agent}', { agent }),
  access: (agent: string) => tr('也可以直接在下面输入，不允许，并告诉 {agent} 为什么', { agent }),
} as const;
/** The composer's placeholder while a card is docked above it (a plan is approved by a click or Ctrl+Enter only). */
export const DOCK_PLACEHOLDER = {
  tool: (agent: string) => tr('告诉 {agent} 换个做法（发送 = 拒绝并说明）· 空着按 Enter = 允许一次', { agent }),
  plan: () => tr('写下修改意见后按 Enter 发出 · 批准请点「批准并开始」或按 Ctrl+Enter'),
  ask: (agent: string) => tr('直接回复 {agent}（发送 = 不回答这些问题）', { agent }),
  access: (agent: string) => tr('告诉 {agent} 为什么不行（发送 = 不允许并说明）· 允许请点卡片上的按钮', { agent }),
  /** A script card (ego lite, or a script in the built-in browser): allowed only with a click, so no Enter part. */
  click: (agent: string) => tr('告诉 {agent} 换个做法（发送 = 拒绝并说明）', { agent }),
} as const;
/** The send slot while a card is docked and the box has words. */
export const DOCK_SEND = { tool: tr('拒绝并发送'), plan: tr('要求修改'), ask: tr('跳过并发送'), access: tr('不允许并发送') } as const;
/** On the card, when the box already had words before it came: Enter queues them as before (review I3). */
export const DOCK_CARRIED = tr('输入框里的话是这张卡出现前写的：按 Enter 照常排队发送，不会当成回答');
/** The card's secondary button after words were queued: take the queued message back and answer with it. */
export const DOCK_DENY_QUEUED = { tool: tr('改用排队的这段话拒绝'), plan: tr('改用排队的这段话要求修改'), ask: tr('改用排队的这段话回复'), access: tr('改用排队的这段话拒绝') } as const;
/**
 * On the card, once those words were queued: its secondary button takes them back as the answer (Enter keeps its
 * usual meaning). The button by name — in a narrow card it is not to the right of anything (review M-8).
 */
export const DOCK_REQUEUED = {
  tool: tr('那段话已排队发送；想用它拒绝这次操作，点卡片上的「{tool}」', { tool: DOCK_DENY_QUEUED.tool }),
  plan: tr('那段话已排队发送；想把它当修改意见，点卡片上的「{plan}」', { plan: DOCK_DENY_QUEUED.plan }),
  ask: tr('那段话已排队发送；想跳过提问、改发这段话，点卡片上的「{ask}」', { ask: DOCK_DENY_QUEUED.ask }),
  access: tr('那段话已排队发送；想用它拒绝这次请求，点卡片上的「{access}」', { access: DOCK_DENY_QUEUED.access }),
} as const;
/** The card's status line (`aria-live`, announced after its title): what an empty Enter does on it (review M-6). */
export const DOCK_STATUS = { tool: tr('空着按 Enter 允许一次'), ask: tr('选好后空着按 Enter 提交回答'), plan: tr('批准请按 Ctrl+Enter'), access: tr('允许请点卡片上的「允许操控」，按键不会允许') } as const;
/** The status line of a script card (ego lite, or a script in the built-in browser): allowed only with a click. */
export const DOCK_STATUS_CLICK = tr('运行脚本请点卡片上的「允许一次」，按键不会允许');
/** An Enter the card did not take (review M-6): in its first moments (`DOCK_COOLDOWN_MS`), or an empty Enter on a plan. */
export const DOCK_ENTER_IGNORED = { soon: tr('卡片刚出现，这次 Enter 没有生效：看清楚后再按'), plan: tr('批准请按 Ctrl+Enter'), access: tr('允许操控电脑要点卡片上的「允许操控」：按键不会允许') } as const;
/** Words and attachments while a card is docked: a deny carries words only (review M2). */
export const DOCK_BLOCKED = tr('附件不能随拒绝一起发出：先处理上面的卡片，或者移除附件');
/** The setting that opens every change in the conversation again (`ui.inlineDiffs`; off by default since phase 5). */
export const INLINE_DIFFS_LABEL = tr('在对话里直接展开改动');
