// The settings map (spec 2026-09-28 §5.7): five groups of pages plus a collapsed 高级, every searchable word, and
// the aliases that keep the old flat section ids working. Pure data + pure functions — SettingsModal.tsx supplies
// the controls (`EntryId` → control) and the page parts (`BodyId` → component); both maps are typed against the
// unions below, so a row or part without a renderer does not compile. catalog.test.ts holds the old window's
// contents as the contract: nothing it had may go missing.
import type { IconName } from '@/ui/icons';
import { INLINE_DIFFS_LABEL, TERMS } from '@/ui/terms';

export type SettingsGroupId = 'common' | 'model' | 'ext' | 'connect' | 'data' | 'advanced';
export const SETTINGS_GROUPS: { id: SettingsGroupId; l: string }[] = [
  { id: 'common', l: '常用' },
  { id: 'model', l: '模型' },
  { id: 'ext', l: '扩展' },
  { id: 'connect', l: '连接' },
  { id: 'data', l: '数据' },
  { id: 'advanced', l: '高级' },
];

/** One setting row (a meta.json key). */
export type EntryId =
  | 'ui.defaultMode' | 'autoContinueOnReset' | 'ui.showThinking' | 'ui.diffMode' | 'ui.inlineDiffs' | 'ui.workbench' | 'ui.autoSave'
  | 'ui.notifications' | 'ui.closeToTray' | 'ui.confirmExit' | 'ui.softwareRender' | 'orchestra.maxParallel'
  | 'ui.theme' | 'ui.fontSize' | 'ui.density' | 'ui.cjkFont' | 'ui.reduceMotion';

/** One part of a page: a component with its own requests (a list, a form, a status block). */
export type BodyId =
  | 'account' | 'engine' | 'models' | 'providers' | 'proxy' | 'gateway'
  | 'mcp' | 'mcpCatalog' | 'mcpJson' | 'plugins' | 'skills' | 'skillsBackup' | 'agents' | 'subagents' | 'memory'
  | 'remote' | 'peers' | 'hosts' | 'im' | 'library' | 'secrets'
  | 'hooks' | 'env' | 'tools' | 'diagnostics' | 'update' | 'raw';

export interface EntryMeta {
  id: EntryId;
  label: string;
  /** one sentence: what happens when you change it */
  hint?: string;
  /** extra search words (old labels, English, synonyms) */
  keywords?: string;
  /** heading of the card the row sits in */
  block?: string;
  /** low-frequency: under the page's 更多选项 */
  more?: boolean;
  /** small badge after the label (进阶) */
  tag?: string;
}
export interface TabMeta { id: string; l: string; bodies: BodyId[]; more?: BodyId[]; keywords?: string }
export interface SectionMeta {
  id: string;
  l: string;
  ic: IconName;
  group: SettingsGroupId;
  /** in the collapsed 高级 list */
  advanced?: boolean;
  /** the lead line under the page title */
  desc: string;
  keywords?: string;
  entries?: EntryMeta[];
  bodies?: BodyId[];
  /** parts under 更多选项 */
  more?: BodyId[];
  /** a page of two halves (MCP + 插件, 其它 Agent + 子代理): the parts live in the tabs */
  tabs?: TabMeta[];
}

/** Name + search words of every page part. */
export const BODY_INFO: Record<BodyId, { l: string; keywords: string }> = {
  account: { l: '登录状态', keywords: 'login 登录 claude.ai 账号 auth 订阅 api 提供方' },
  engine: { l: '运行内核', keywords: 'engine ccb claude-code-best 官方 二进制 版本 更新 doctor 配置目录 引擎 插件数' },
  models: { l: '模型列表', keywords: 'model 模型 启用 隐藏 收藏 星标 opus sonnet haiku effort 智能程度 刷新 按档案' },
  providers: { l: '供应商列表', keywords: 'provider api key base url 中转 openai gemini grok anthropic 缓存 cache 默认 档案 测试连接' },
  proxy: { l: '网络代理', keywords: 'proxy 代理 梯子 vpn clash v2ray http_proxy https_proxy 系统代理 pac 地区 region 403 连不上 超时' },
  gateway: { l: '网关与分组', keywords: 'gateway 网关 故障转移 failover 转换 多账号 额度 轮询 round robin 成员' },
  mcp: { l: '已配置的 MCP', keywords: 'mcp server 当前会话 已配置 移除 连接状态' },
  mcpCatalog: { l: 'MCP 目录', keywords: 'mcp 目录 catalog registry 注册表 健康检查 health 安装' },
  mcpJson: { l: '手动添加（JSON）', keywords: 'mcp json add-json 手动 添加 stdio' },
  plugins: { l: '插件列表', keywords: 'plugin marketplace 插件 市场 安装 卸载 启用' },
  skills: { l: 'Skills 列表与安装', keywords: 'skill 技能 安装 github 新建 编辑 删除' },
  skillsBackup: { l: 'Skills 备份', keywords: 'skill 备份 backup tar 恢复 restore' },
  agents: { l: '其它 Agent 列表', keywords: 'agent codex gemini qwen kimi opencode acp 安装 登录 启动参数 配置中心 自定义' },
  subagents: { l: 'Claude 子代理列表', keywords: 'subagent 子代理 agents md' },
  memory: { l: '记忆开关与注入', keywords: 'memory 记忆 跨 agent mcp sqlite 遗忘 清空 注入' },
  remote: { l: '手机访问', keywords: 'remote lan phone mobile 手机 局域网 配对 配对码 二维码 qr 设备 吊销 端口' },
  peers: { l: '其它电脑', keywords: '其它机器 其它电脑 跨机器 联邦 peer federation 加入 重新配对' },
  hosts: { l: 'SSH 隧道', keywords: 'ssh 隧道 tunnel 远程主机 端口转发 免密' },
  im: { l: '机器人列表', keywords: 'telegram discord slack 飞书 feishu lark 钉钉 dingtalk 企业微信 wecom 微信 机器人 bot im 网关 配对' },
  library: { l: '来源与索引', keywords: 'session library codex opencode 导入 索引 加入 移出 重建' },
  secrets: { l: 'API Key 存储', keywords: 'secret keychain credential dpapi 钥匙串 加密 密钥' },
  hooks: { l: 'Hooks 列表', keywords: 'hook 钩子 事件 matcher' },
  env: { l: '其它环境变量', keywords: 'env 环境变量 brave web search artifacts langfuse sentry voice 语音 settings.json' },
  tools: { l: '命令行工具检测', keywords: 'git gh node python uv docker ripgrep 工具 检测 cli' },
  diagnostics: { l: '诊断包', keywords: 'diagnostic log bundle 日志 诊断包 导出' },
  update: { l: '应用更新', keywords: 'update version release 更新 版本 检查更新' },
  raw: { l: 'settings.json 原文', keywords: 'settings json raw 原文 user project local 编辑' },
};

const GENERAL: EntryMeta[] = [
  { id: 'ui.defaultMode', block: '新对话', label: '默认权限', hint: 'Claude 改文件、运行命令之前要不要先问你。每个对话里也能随时改。', keywords: 'permission mode 权限 新会话默认权限模式 每步询问 自动' },
  { id: 'autoContinueOnReset', block: '新对话', label: '额度用完后自动继续', hint: '被限流时，等到额度重置再自动发出上一条消息。', keywords: 'rate limit quota 限流 额度 额度恢复后自动继续' },
  { id: 'ui.showThinking', block: '对话显示', label: '显示思考过程', hint: '展开模型回答之前的推理内容。关掉更清爽。', keywords: 'thinking reasoning 思考' },
  { id: 'ui.diffMode', block: '对话显示', label: '改动的显示方式', hint: '审阅改动时 diff 的默认样式。', keywords: 'diff split unified 并排 内联 默认 diff 视图 上下对照 左右并排' },
  { id: 'ui.inlineDiffs', block: '对话显示', label: INLINE_DIFFS_LABEL, hint: '每一步改了什么直接在对话里展开。关着时（默认）点那一步，或回合末尾的「改动了 N 个文件」查看。', keywords: 'diff inline expand edit 展开 改动 大 diff 内联 默认展开' },
  { id: 'ui.workbench', block: '工作台', label: TERMS.workbench, tag: '进阶', hint: '一直显示分屏标签条、分组栏和右侧面板图标栏。关着时它们只在用到时出现（Ctrl+D 分屏、开第二个标签页），快捷键和 Ctrl K 照常可用。添加供应商、在模型菜单里换模型都不需要打开它。', keywords: 'workbench 工作台 分屏 分组 标签 停靠 图标栏 single pane layout 单窗格模式 界面' },
  { id: 'ui.autoSave', block: '工作台', label: '编辑器自动保存', hint: '停止输入 0.8 秒后写回磁盘；关掉后用 Ctrl+S 保存。', keywords: 'editor autosave monaco 保存' },
  { id: 'ui.notifications', block: '提醒与窗口', label: '桌面通知', hint: '对话需要你确认，或者任务完成时提醒你。', keywords: 'notification 通知' },
  { id: 'ui.closeToTray', block: '提醒与窗口', label: '关闭窗口时留在托盘', hint: '桌面版：关掉最后一个窗口不退出，任务在后台继续跑，从托盘图标回来。', keywords: 'tray minimize close 托盘 最小化' },
  { id: 'ui.confirmExit', block: '提醒与窗口', label: '退出前确认', hint: '有运行中的对话或没保存的文件时先问一句。', keywords: 'quit exit close 退出 关闭 确认' },
  { id: 'ui.softwareRender', more: true, label: '软件渲染（桌面版）', hint: '显卡驱动异常导致黑屏 / 闪烁时打开，重启后生效。', keywords: 'gpu render 黑屏 闪烁 disable-gpu 显卡' },
  { id: 'orchestra.maxParallel', more: true, label: '编排并发上限', hint: '一次编排里同时执行的任务 / 比选数（等你审批的不占名额）。', keywords: 'orchestra workflow parallel 编排 并发 多 agent' },
];

const APPEARANCE: EntryMeta[] = [
  { id: 'ui.theme', block: '显示', label: '主题', hint: '跟随系统会按操作系统的深浅色切换。', keywords: 'theme dark light 深色 浅色 暗色 亮色 system 跟随系统' },
  { id: 'ui.fontSize', block: '显示', label: '字号', hint: '整个界面的字号（像素）。', keywords: 'font size 字体大小' },
  { id: 'ui.density', block: '显示', label: '密度', hint: '紧凑模式减少行高与内边距。', keywords: 'density compact 紧凑 宽松' },
  { id: 'ui.cjkFont', more: true, label: '中文字体', hint: '优先用于中日韩文字的字体。', keywords: 'cjk font 中文 字体 雅黑 苹方' },
  { id: 'ui.reduceMotion', block: '显示', label: '减少动画', hint: '关掉界面里的过渡与动画。', keywords: 'motion animation 动画 过渡' },
];

export const SETTINGS_SECTIONS: SectionMeta[] = [
  // 常用
  { id: 'general', l: '通用', ic: 'settings', group: 'common', desc: '新对话的默认行为、提醒方式，以及界面要显示多少工具。', keywords: '界面 会话 interface session', entries: GENERAL },
  { id: 'appearance', l: '外观', ic: 'sun', group: 'common', desc: '主题、字号和界面密度。', keywords: 'appearance theme 主题', entries: APPEARANCE },
  { id: 'account', l: '账号与登录', ic: 'user', group: 'common', desc: 'Claude 账号的登录状态。用第三方接口或中转站请去「供应商」。', keywords: '引擎与账号 engine account login 登录 账号', bodies: ['account'], more: ['engine'] },
  // 模型
  { id: 'models', l: '模型与智能程度', ic: 'artifact', group: 'model', desc: '模型菜单里出现哪些模型、哪些置顶，以及每个模型能调的智能程度。', keywords: 'model 模型 effort', bodies: ['models'] },
  { id: 'providers', l: '供应商', ic: 'cloud', group: 'model', desc: '第三方接口或中转站：地址、密钥和默认模型。每个对话可以在模型菜单里换用。', keywords: '供应商 / 环境 provider 中转 api key', bodies: ['providers', 'proxy'] },
  { id: 'gateway', l: '模型网关', ic: 'gateway', group: 'model', desc: '把几个供应商组成一个本机入口：一个额度用完自动换下一个，不同协议之间自动转换。', keywords: 'gateway 网关', bodies: ['gateway'] },
  // 扩展
  {
    id: 'mcp', l: 'MCP 与插件', ic: 'mcp', group: 'ext', desc: '给 Claude 接上外部工具和数据源（MCP），或安装插件市场里的插件。', keywords: 'mcp plugin 插件',
    tabs: [
      { id: 'servers', l: 'MCP 服务器', bodies: ['mcp', 'mcpCatalog'], more: ['mcpJson'], keywords: 'mcp server 服务器' },
      { id: 'plugins', l: '插件', bodies: ['plugins'], keywords: 'plugin plugins 插件' },
    ],
  },
  { id: 'skills', l: 'Skills', ic: 'skill', group: 'ext', desc: '可复用的工作方法：从 GitHub 安装、新建、编辑。', keywords: 'skill 技能', bodies: ['skills'], more: ['skillsBackup'] },
  {
    id: 'agents', l: 'Agents 与子代理', ic: 'agent', group: 'ext', desc: '其它编程 Agent（Codex、Gemini CLI…）的安装、登录与启动参数，以及 Claude 自己的子代理。', keywords: 'agent agents 子代理',
    tabs: [
      { id: 'cli', l: TERMS.agents, bodies: ['agents'], keywords: 'CLI Agents codex gemini qwen kimi' },
      { id: 'subagents', l: 'Claude 子代理', bodies: ['subagents'], keywords: 'subagent Claude 子代理' },
    ],
  },
  { id: 'memory', l: '共享记忆', ic: 'memory', group: 'ext', desc: '所有 Agent 共用的一份记忆：做过的决定、约束、踩过的坑。', keywords: 'memory 记忆', bodies: ['memory'] },
  // 连接
  { id: 'remote', l: '手机与其它电脑', ic: 'device', group: 'connect', desc: '在手机上接着用，或者把其它电脑上的对话接到这里。', keywords: '远程 / 手机 remote phone 手机 远程', bodies: ['remote', 'peers'], more: ['hosts'] },
  { id: 'im', l: 'IM 机器人', ic: 'chat', group: 'connect', desc: '在 Telegram、飞书、钉钉等聊天软件里给 Claude 派活、批准操作。', keywords: 'IM 网关 im bot 机器人', bodies: ['im'] },
  // 数据
  { id: 'library', l: '对话库', ic: 'archive', group: 'data', desc: '把 Codex、OpenCode 等其它 Agent 的历史对话并进侧栏和搜索。', keywords: 'library 会话库 对话库 历史', bodies: ['library'] },
  { id: 'secrets', l: '密钥', ic: 'lock', group: 'data', desc: '供应商的 API Key 怎么存在本机。', keywords: 'secret 密钥 加密', bodies: ['secrets'] },
  // 高级
  { id: 'hooks', l: 'Hooks', ic: 'bolt', group: 'advanced', advanced: true, desc: 'Claude Code 在某些事件时运行的命令（只读列表，来自 settings.json 和插件）。', keywords: 'hook 钩子', bodies: ['hooks'] },
  { id: 'env', l: '环境变量', ic: 'config', group: 'advanced', advanced: true, desc: '写进 ~/.claude/settings.json 的 env，所有对话生效；留空表示不设置。供应商的地址和密钥不在这里。', keywords: 'env 环境变量', bodies: ['env'] },
  { id: 'tools', l: 'CLI 工具', ic: 'keyboard', group: 'advanced', advanced: true, desc: '本机装了哪些命令行工具（git、gh、node…），Claude 用得上的都在这里检测。', keywords: 'tools cli 工具', bodies: ['tools'] },
  { id: 'diagnostics', l: '诊断', ic: 'info', group: 'advanced', advanced: true, desc: '出问题时打一个诊断包：日志尾部和脱敏后的配置。', keywords: 'diagnostic 诊断 日志', bodies: ['diagnostics'] },
  { id: 'update', l: '更新', ic: 'refresh', group: 'advanced', advanced: true, desc: '当前版本与更新。', keywords: 'update 更新 版本', bodies: ['update'] },
  { id: 'raw', l: 'settings.json', ic: 'copy', group: 'advanced', advanced: true, desc: '直接编辑 Claude Code 的 settings.json（用户 / 项目 / 本机）。', keywords: 'settings json raw 原文', bodies: ['raw'] },
];

export const VISIBLE_SECTIONS = SETTINGS_SECTIONS.filter((s) => !s.advanced);
export const ADVANCED_SECTIONS = SETTINGS_SECTIONS.filter((s) => s.advanced);
export const DEFAULT_SECTION = 'general';

/**
 * Old flat-window ids whose page got another name; the other old ids are still page ids. 引擎与账号's engine rows
 * (运行内核) now sit in 账号与登录 › 更多选项, so the old id opens that and scrolls to them.
 */
export const LEGACY_SECTIONS: Record<string, { section: string; tab?: string; more?: boolean; body?: BodyId }> = {
  interface: { section: 'general' },
  session: { section: 'general' },
  engine: { section: 'account', more: true, body: 'engine' },
  plugins: { section: 'mcp', tab: 'plugins' },
  subagents: { section: 'agents', tab: 'subagents' },
};

export interface SettingsTarget {
  section: string;
  tab?: string;
  /** an entry to scroll to and highlight */
  reveal?: string;
  /** a part to scroll to */
  body?: BodyId;
  /** open 更多选项 */
  more?: boolean;
}

export function findSection(id: string | undefined): SectionMeta | undefined {
  return id ? SETTINGS_SECTIONS.find((s) => s.id === id) : undefined;
}
export function groupLabel(g: SettingsGroupId): string {
  return SETTINGS_GROUPS.find((x) => x.id === g)?.l ?? '';
}
/** Every row, with the page it is on. */
export function allEntries(): { section: SectionMeta; entry: EntryMeta }[] {
  return SETTINGS_SECTIONS.flatMap((section) => (section.entries ?? []).map((entry) => ({ section, entry })));
}
/** Every part, with where it is shown. */
export function allBodies(): { section: SectionMeta; tab?: TabMeta; body: BodyId; more: boolean }[] {
  return SETTINGS_SECTIONS.flatMap((section) => [
    ...(section.bodies ?? []).map((body) => ({ section, body, more: false })),
    ...(section.more ?? []).map((body) => ({ section, body, more: true })),
    ...(section.tabs ?? []).flatMap((tab) => [
      ...tab.bodies.map((body) => ({ section, tab, body, more: false })),
      ...(tab.more ?? []).map((body) => ({ section, tab, body, more: true })),
    ]),
  ]);
}

/** The tab a page opens on (a tabbed page without a valid tab → its first tab). */
export function activeTab(section: SectionMeta, tab?: string): TabMeta | undefined {
  if (!section.tabs?.length) return undefined;
  return section.tabs.find((t) => t.id === tab) ?? section.tabs[0];
}
/** The parts a target shows (更多选项 included). */
export function targetBodies(t: SettingsTarget): BodyId[] {
  const s = findSection(t.section);
  if (!s) return [];
  const tab = activeTab(s, t.tab);
  return tab ? [...tab.bodies, ...(tab.more ?? [])] : [...(s.bodies ?? []), ...(s.more ?? [])];
}

/**
 * `openSettings({section, reveal})` → the page to show. `reveal` (an entry id) wins and opens 更多选项 when the entry
 * is in there; old section ids go through LEGACY_SECTIONS; anything unknown opens 通用.
 */
export function resolveSettingsTarget(o: { section?: string; reveal?: string } | null | undefined): SettingsTarget {
  if (o?.reveal) {
    const hit = allEntries().find(({ entry }) => entry.id === o.reveal);
    if (hit) return { section: hit.section.id, reveal: hit.entry.id, ...(hit.entry.more ? { more: true } : {}) };
  }
  const id = o?.section;
  if (id && findSection(id)) return { section: id };
  if (id && LEGACY_SECTIONS[id]) return { ...LEGACY_SECTIONS[id] };
  return { section: DEFAULT_SECTION };
}

/** What 更多选项 holds on a page (or one of its tabs), for the line next to it. */
export function moreHint(section: SectionMeta, tab?: string): string {
  const t = activeTab(section, tab);
  const entries = t ? [] : (section.entries ?? []).filter((e) => e.more).map((e) => e.label);
  const bodies = (t ? t.more ?? [] : section.more ?? []).map((b) => BODY_INFO[b].l);
  return [...entries, ...bodies].join('、');
}

export type SettingsHit =
  | { kind: 'entry'; section: SectionMeta; entry: EntryMeta; crumb: string }
  | { kind: 'page'; section: SectionMeta; tab?: TabMeta; body?: BodyId; more?: boolean; title: string; crumb: string };

function crumbOf(section: SectionMeta, tab?: TabMeta, more?: boolean): string {
  return [groupLabel(section.group), section.l, tab?.l, more ? '更多选项' : undefined].filter(Boolean).join(' › ');
}

/**
 * Full-text search over every row (label / hint / keywords / id) and every page, tab and part — 高级 and 更多选项
 * included. All words of the query must match. A part that is in plain view once its page / tab opens is not
 * listed again when that page / tab matched too.
 */
export function searchSettings(query: string): SettingsHit[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const match = (...parts: (string | undefined)[]) => { const text = parts.filter(Boolean).join(' ').toLowerCase(); return words.every((w) => text.includes(w)); };
  const hits: SettingsHit[] = [];
  for (const section of SETTINGS_SECTIONS) {
    const g = groupLabel(section.group);
    for (const entry of section.entries ?? []) {
      if (match(entry.label, entry.hint, entry.keywords, entry.id, entry.block, section.l, g)) hits.push({ kind: 'entry', section, entry, crumb: crumbOf(section, undefined, entry.more) });
    }
  }
  for (const section of SETTINGS_SECTIONS) {
    const pageHit = match(section.l, section.keywords, section.desc);
    if (pageHit) hits.push({ kind: 'page', section, title: section.l, crumb: crumbOf(section) });
    const containers: { tab?: TabMeta; bodies: BodyId[]; more: BodyId[]; hit: boolean }[] = section.tabs
      ? section.tabs.map((tab) => ({ tab, bodies: tab.bodies, more: tab.more ?? [], hit: match(tab.l, tab.keywords) }))
      : [{ bodies: section.bodies ?? [], more: section.more ?? [], hit: pageHit }];
    for (const c of containers) {
      if (c.tab && c.hit) hits.push({ kind: 'page', section, tab: c.tab, title: c.tab.l, crumb: crumbOf(section, c.tab) });
      for (const [body, more] of [...c.bodies.map((b) => [b, false] as const), ...c.more.map((b) => [b, true] as const)]) {
        if (!more && c.hit) continue; // already in view on the page / tab that matched
        const info = BODY_INFO[body];
        if (match(info.l, info.keywords)) hits.push({ kind: 'page', section, tab: c.tab, body, ...(more ? { more: true } : {}), title: info.l, crumb: crumbOf(section, c.tab, more) });
      }
    }
  }
  return hits;
}

/** The small status at the end of a nav row (Linear's 「Desktop · Disabled」): only what is known. */
export function navStatus(o: { loggedIn?: boolean | null; providers?: number; gatewayEnabled?: boolean | null }): Record<string, string> {
  const out: Record<string, string> = {};
  if (o.loggedIn === true) out.account = '已登录';
  else if (o.loggedIn === false) out.account = '未登录';
  if (o.providers) out.providers = String(o.providers);
  if (o.gatewayEnabled === true) out.gateway = '开';
  else if (o.gatewayEnabled === false) out.gateway = '关';
  return out;
}
