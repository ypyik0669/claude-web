// The settings map (界面改版 2026-11 阶段 2, spec #ia 「设置 · 4 组 14 页」): four groups of pages — 账号 · 应用 ·
// Claude Code · 高级 — every searchable word, the aliases that keep the old section ids working, and what left the
// settings (MCP / 插件 / Skills → 自定义, 值班 Bot → 自动化 › Bot › 设置) so an old id or a search still lands there.
// Pure data + pure functions — SettingsModal.tsx supplies the controls (`EntryId` → control) and the page parts
// (`BodyId` → component); both maps are typed against the unions below, so a row or part without a renderer does not
// compile. catalog.test.ts holds the old windows' contents as the contract: nothing they had may go missing.
import type { IconName } from '@/ui/icons';
import type { ExtensionTab } from '@/features/extensions/page';
import { INLINE_DIFFS_LABEL, TERMS } from '@/ui/terms';
import { tr, trAs } from '@/i18n';

export type SettingsGroupId = 'account' | 'app' | 'code' | 'advanced';
export const SETTINGS_GROUPS: { id: SettingsGroupId; l: string }[] = [
  { id: 'account', l: tr('账号') },
  { id: 'app', l: tr('应用') },
  { id: 'code', l: 'Claude Code' },
  { id: 'advanced', l: tr('高级') },
];

/** One setting row (a meta.json key). */
export type EntryId =
  | 'ui.defaultMode' | 'autoContinueOnReset' | 'ui.showThinking' | 'ui.viewMode' | 'ui.infoPanel' | 'ui.sidebarFolded' | 'ui.backdropMotion' | 'ui.backdropInChat' | 'ui.welcomeLayout' | 'ui.autoArchivePr' | 'vcs.gitlabHosts' | 'vcs.resolveOnReply' | 'sessions.mcp' | 'ui.nodegraphHint' | 'claude.desktopSkills' | 'worktree.dir' | 'worktree.prefix' | 'ui.promptSuggestions' | 'ui.diffMode' | 'ui.inlineDiffs' | 'ui.workbench' | 'ui.autoSave'
  | 'ui.notifications' | 'ui.closeToTray' | 'ui.confirmExit' | 'ui.softwareRender' | 'orchestra.maxParallel'
  | 'ai.thinkingLanguage'
  | 'ui.language' | 'ui.theme' | 'ui.zoom' | 'ui.fontSize' | 'ui.density' | 'ui.cjkFont' | 'ui.reduceMotion' | 'ui.haptics'
  | 'ui.opening.pack' | 'ui.opening.when' | 'ui.opening.length' | 'ui.opening.sound' | 'ui.opening.keep'
  | 'bots.concurrency' | 'bots.globalBudgetUsd' | 'bots.defaultProvider' | 'bots.defaultTier' | 'bots.duty.service' | 'bots.loginItem' | 'bots.unleashAll';

/** One part of a page: a component with its own requests (a list, a form, a status block). */
export type BodyId =
  | 'account' | 'engine' | 'usage' | 'models' | 'providers' | 'proxy' | 'gateway'
  | 'agents' | 'subagents' | 'memory'
  | 'remote' | 'anywhere' | 'peers' | 'hosts' | 'im' | 'web' | 'library' | 'secrets' | 'privacy'
  | 'hooks' | 'localEnv' | 'env' | 'tools' | 'diagnostics' | 'update' | 'raw' | 'customCss' | 'openings';

export interface EntryMeta {
  id: EntryId;
  label: string;
  /** one sentence: what happens when you change it */
  hint?: string;
  /** the same sentence without keyboard words (Ctrl+O, 按 Tab…), for phones (spec #phone 问题 8) */
  touchHint?: string;
  /** extra search words (old labels, English, synonyms) */
  keywords?: string;
  /** heading of the card the row sits in */
  block?: string;
  /** low-frequency: under the page's 更多选项 */
  more?: boolean;
  /** small badge after the label (进阶) */
  tag?: string;
  /** the control goes under the label, the full width of the card (开场动画's cards) */
  wide?: boolean;
  /** on a page with tabs: the tab the row is on */
  tab?: string;
}
export interface TabMeta { id: string; l: string; bodies: BodyId[]; more?: BodyId[]; keywords?: string }
export interface SectionMeta {
  id: string;
  l: string;
  ic: IconName;
  group: SettingsGroupId;
  /** a page of the 高级 group: implementation words may show (wording.test.ts) */
  advanced?: boolean;
  /** the lead line under the page title */
  desc: string;
  keywords?: string;
  entries?: EntryMeta[];
  bodies?: BodyId[];
  /** parts under 更多选项 */
  more?: BodyId[];
  /** a page of several halves (模型: 来源 · 路由 · 模型; Agents: 其它 Agent · 子代理): the parts live in the tabs */
  tabs?: TabMeta[];
}

/** Name + search words of every page part. */
export const BODY_INFO: Record<BodyId, { l: string; keywords: string }> = {
  account: { l: tr('登录状态'), keywords: tr('login 登录 claude.ai 账号 auth 订阅 api 提供方 上下文窗口 context window 1M 200K 自动压缩 auto-compact 压缩') },
  engine: { l: tr('运行内核'), keywords: tr('engine ccb claude-web-engine claude-code-best 官方 二进制 版本 更新 doctor 配置目录 引擎 插件数') },
  usage: { l: tr('用量与账本'), keywords: tr('usage ledger cost token 用量 账本 费用 花费 缓存命中 按模型 按项目 按天') },
  models: { l: tr('模型列表'), keywords: tr('model 模型 启用 隐藏 收藏 星标 opus sonnet haiku effort 智能程度 刷新 按档案') },
  providers: { l: tr('供应商列表'), keywords: tr('provider api key base url 中转 openai gemini grok anthropic 缓存 cache 默认 档案 测试连接 上下文窗口 context window 1M 200K 自动压缩 auto-compact 压缩') },
  proxy: { l: tr('网络代理'), keywords: tr('proxy 代理 梯子 vpn clash v2ray http_proxy https_proxy 系统代理 pac 地区 region 403 连不上 超时') },
  gateway: { l: tr('网关与分组'), keywords: tr('gateway 网关 故障转移 failover 转换 多账号 额度 轮询 round robin 成员') },
  agents: { l: tr('其它 Agent 列表'), keywords: tr('agent codex gemini qwen kimi opencode acp 安装 登录 启动参数 配置文件 配置中心 自定义') },
  subagents: { l: tr('Claude 子代理列表'), keywords: tr('subagent 子代理 agents md') },
  memory: { l: tr('记忆开关与注入'), keywords: tr('memory 记忆 跨 agent mcp sqlite 遗忘 清空 注入') },
  web: { l: tr('搜索与内置浏览器'), keywords: tr('web search browser 搜索 浏览器 联网 上网 网页 bing duckduckgo google yahoo baidu 百度 brave 密钥 截图 登录状态') },
  remote: { l: tr('手机访问'), keywords: tr('remote lan phone mobile 手机 局域网 配对 配对码 二维码 qr 设备 吊销 端口 在外面也能用 外网 anywhere 在哪都能用 配对链接 不让电脑睡眠 睡眠 休眠 keep awake 直连 慢速转发') },
  anywhere: { l: tr('牵线服务器与最近连接'), keywords: tr('anywhere 在外面也能用 牵线 broker mqtt stun ice webrtc 打洞 转发 relay 手机页面 壳 shell github pages 最近连接 连接记录') },
  peers: { l: tr('其它电脑'), keywords: tr('其它机器 其它电脑 跨机器 联邦 peer federation 加入 重新配对') },
  hosts: { l: tr('SSH 隧道'), keywords: tr('ssh 隧道 tunnel 远程主机 端口转发 免密') },
  im: { l: tr('机器人列表'), keywords: tr('telegram discord slack 飞书 feishu lark 钉钉 dingtalk 企业微信 wecom 微信 机器人 bot im 网关 配对 IM 机器人') },
  library: { l: tr('来源与索引'), keywords: tr('session library codex opencode 导入 索引 加入 移出 重建 claude.ai 数据导出 export zip 对话库 会话库') },
  secrets: { l: tr('API Key 存储'), keywords: tr('secret keychain credential dpapi 钥匙串 加密 密钥') },
  privacy: { l: tr('隐私中心'), keywords: tr('privacy 隐私 厂商 能看到什么 请求记录 审计 audit 脱敏 留在本机') },
  hooks: { l: tr('Hooks 列表'), keywords: tr('hook 钩子 事件 matcher') },
  localEnv: { l: tr('本机环境变量（加密）'), keywords: tr('env 环境变量 加密 密钥 secret database token 本机 终端 terminal') },
  env: { l: tr('其它环境变量'), keywords: tr('env 环境变量 brave web search artifacts langfuse sentry voice 语音 settings.json') },
  tools: { l: tr('命令行工具检测'), keywords: tr('git gh node python uv docker ripgrep 工具 检测 cli CLI 工具') },
  diagnostics: { l: tr('诊断包'), keywords: tr('diagnostic log bundle 日志 诊断包 导出') },
  update: { l: tr('应用更新'), keywords: tr('update version release 更新 版本 检查更新') },
  raw: { l: tr('settings.json 原文'), keywords: tr('settings json raw 原文 user project local 编辑') },
  customCss: { l: tr('自定义样式'), keywords: tr('custom css 自定义样式 样式表 皮肤 美化 stylesheet userstyle 进度条') },
  openings: { l: tr('动画包'), keywords: tr('opening pack import folder video 开场 动画包 导入 文件夹 视频 opening.json 许可') },
};

// 对话 (spec mock 「设置弹窗」): the old 通用 page's conversation half — what a new conversation starts with, what the
// conversation shows, conversations talking to each other, PR / MR
const CONVERSATION: EntryMeta[] = [
  { id: 'ui.defaultMode', block: tr('新对话'), label: tr('默认权限'), hint: tr('Claude 改文件、运行命令之前要不要先问你。每个对话里也能随时改。'), keywords: tr('permission mode 权限 新会话默认权限模式 每步询问 自动 通用') },
  { id: 'autoContinueOnReset', block: tr('新对话'), label: tr('额度用完后自动继续'), hint: tr('被限流时，等到额度重置再自动发出上一条消息。'), keywords: tr('rate limit quota 限流 额度 额度恢复后自动继续') },
  { id: 'worktree.dir', block: tr('新对话'), label: tr('{worktree}放在哪', { worktree: TERMS.worktree }), hint: tr('留空：放在项目自己的 .claude 文件夹里（Claude Code 的默认）。填一个文件夹：新的放到那里，名字是「项目名-任务名」。项目根目录的 {file} 里列出、又被 git 忽略的文件（比如 .env）会拷进去。', { file: '.worktreeinclude' }), keywords: tr('worktree location folder 位置 目录 独立副本 .worktreeinclude') },
  { id: 'worktree.prefix', more: true, block: tr('新对话'), label: tr('{worktree}分支前缀', { worktree: TERMS.worktree }), hint: tr('留空：用 Claude Code 的默认前缀（框里灰色的那个）。比如填 claude/，分支就叫 claude/任务名。'), keywords: tr('worktree branch prefix 分支 前缀 独立副本') },
  { id: 'claude.desktopSkills', block: tr('新对话'), label: tr('用官方桌面版下载的 Anthropic 技能'), hint: tr('这台电脑装了官方 Claude 桌面版的话，它为你的账号下载的技能（Excel、PDF、Word、PPT 等）在这里的对话里也能用，在官方 App 里开始的对话接着聊时不会再「Unknown skill」。改了之后新开的对话生效。'), keywords: tr('skills anthropic-skills xlsx pdf docx pptx desktop 技能 官方 桌面版') },
  { id: 'ui.nodegraphHint', block: tr('新对话'), label: tr('让 Claude 画可交互的节点图'), hint: tr('告诉 Claude 这里能把 nodegraph 代码块显示成能拖、能改的节点图，适合画流程、依赖、权限和架构。改了之后新开或重新启动的对话生效。'), keywords: tr('node graph diagram flowchart mermaid 节点图 流程图 架构图') },
  { id: 'ui.viewMode', block: trAs('显示', 'Display'), label: tr('查看模式'), hint: tr('普通：做完的回合收成一行。显示思考：回合照样收起，思考过程展开。详细：每一步和思考全部展开。Ctrl+O 随时切换。'), touchHint: tr('普通：做完的回合收成一行。显示思考：回合照样收起，思考过程展开。详细：每一步和思考全部展开。'), keywords: tr('view mode thinking verbose 查看 详细 思考 展开 Ctrl+O') },
  { id: 'ui.showThinking', block: trAs('显示', 'Display'), label: tr('显示思考过程'), hint: tr('展开模型回答之前的推理内容。关掉更清爽。'), keywords: tr('thinking reasoning 思考') },
  { id: 'ui.promptSuggestions', block: trAs('显示', 'Display'), label: tr('下一句提示'), hint: tr('每轮结束后，在空的输入框里用灰字猜你下一句想说什么，按 Tab 采用。改了之后新开的对话生效。'), touchHint: tr('每轮结束后，在空的输入框里用灰字猜你下一句想说什么。改了之后新开的对话生效。'), keywords: tr('prompt suggestion next 提示 建议 下一句 Tab') },
  { id: 'ui.diffMode', block: trAs('显示', 'Display'), label: tr('改动的显示方式'), hint: tr('审阅改动时 diff 的默认样式。'), keywords: tr('diff split unified 并排 内联 默认 diff 视图 上下对照 左右并排') },
  { id: 'ui.inlineDiffs', block: trAs('显示', 'Display'), label: INLINE_DIFFS_LABEL, hint: tr('每一步改了什么直接在对话里展开。关着时（默认）点那一步，或回合末尾的「改动了 N 个文件」查看。'), keywords: tr('diff inline expand edit 展开 改动 大 diff 内联 默认展开') },
  { id: 'ui.infoPanel', block: trAs('显示', 'Display'), label: tr('对话右边的信息栏'), hint: tr('环境、上下文用量、连接器、改动和后台任务一栏摆在对话右边；对话头上的 ⓘ 按钮也能开关。窗口太窄时自动让开。'), keywords: tr('info panel column context connectors changes background 信息栏 上下文 连接器 改动 后台') },
  { id: 'ui.welcomeLayout', block: trAs('显示', 'Display'), label: tr('新对话页的输入框'), hint: tr('框下一行：和官方 App 一样，代码 / 聊天、电脑、文件夹、分支和权限在输入框下面，模型在右边。框里：这些都放在输入框里面。'), keywords: tr('welcome composer layout chips under new conversation 输入框 新对话 首页 布局') },
  { id: 'sessions.mcp', block: tr('对话之间'), label: tr('对话之间可以互相看和留言'), hint: tr('Claude 能列出这台电脑上的其它对话、读它们在做什么、给它们发消息、建议另开一个对话做的事；归档别的对话之前会先问你。改了之后新开的对话生效。'), keywords: tr('sessions cross session message 跨对话 其它对话 留言 任务 task chip') },
  { id: 'ui.autoArchivePr', block: tr('PR 与 MR'), label: tr('PR 合并或关闭后自动归档对话'), hint: tr('对话分支的 PR 合并或关闭、对话也没在跑时，把对话归档（从侧栏收起，随时能找回）。'), keywords: tr('pr pull request archive merge 归档 合并 自动') },
  { id: 'vcs.gitlabHosts', block: tr('PR 与 MR'), label: tr('自建 GitLab 的地址'), hint: tr('一行一个（比如 git.example.com）。这些地址上的仓库，对话上方显示 MR 和流水线。gitlab.com 不用填。下面可以给每个地址存一个访问令牌；装了 glab 并登录过的不用存。'), keywords: tr('gitlab mr merge request pipeline token glab 自建 令牌 流水线') },
  { id: 'vcs.resolveOnReply', block: tr('PR 与 MR'), label: tr('回复评论后顺手标为已解决'), hint: tr('自动处理评论推送后，在评论下回复「已在某次提交修改」的同时把这条讨论标为已解决。'), keywords: tr('pr review comment resolve thread 评论 解决 回复') },
  { id: 'orchestra.maxParallel', more: true, label: tr('编排并发上限'), hint: tr('一次编排里同时执行的任务 / 比选数（等你审批的不占名额）。'), keywords: tr('orchestra workflow parallel 编排 并发 多 agent') },
];

// 通知与窗口: the old 通用 page's other half — reminders, the window, the workbench
const WINDOW: EntryMeta[] = [
  { id: 'ui.notifications', block: tr('通知'), label: tr('桌面通知'), hint: tr('对话需要你确认，或者任务完成时提醒你。'), keywords: tr('notification 通知 提醒 通用') },
  { id: 'ui.closeToTray', block: tr('窗口'), label: tr('关闭窗口时留在托盘'), hint: tr('桌面版：关掉最后一个窗口不退出，任务在后台继续跑，从托盘图标回来。'), keywords: tr('tray minimize close 托盘 最小化') },
  { id: 'ui.confirmExit', block: tr('窗口'), label: tr('退出前确认'), hint: tr('有运行中的对话或没保存的文件时先问一句。'), keywords: tr('quit exit close 退出 关闭 确认') },
  { id: 'ui.sidebarFolded', block: tr('窗口'), label: tr('侧栏的项目和文件夹默认收起'), hint: tr('打开时只露出标题；你点开的那几个会一直开着，当前对话所在的也会打开。搜索时全部展开。'), keywords: tr('sidebar folders projects collapse expand 侧栏 折叠 收起 展开 项目 文件夹') },
  { id: 'ui.workbench', block: tr('工作台'), label: TERMS.workbench, tag: tr('进阶'), hint: tr('一直显示分屏标签条、分组栏和右侧面板图标栏。关着时它们只在用到时出现（Ctrl+D 分屏、开第二个标签页），快捷键和 Ctrl K 照常可用。添加供应商、在模型菜单里换模型都不需要打开它。'), touchHint: tr('一直显示分屏标签条、分组栏和右侧面板图标栏。关着时它们只在用到时出现。添加供应商、在模型菜单里换模型都不需要打开它。'), keywords: tr('workbench 工作台 分屏 分组 标签 停靠 图标栏 single pane layout 单窗格模式 界面') },
  { id: 'ui.autoSave', block: tr('工作台'), label: tr('编辑器自动保存'), hint: tr('停止输入 0.8 秒后写回磁盘；关掉后用 Ctrl+S 保存。'), touchHint: tr('停止输入 0.8 秒后写回磁盘；关掉后要自己保存。'), keywords: tr('editor autosave monaco 保存') },
  { id: 'ui.softwareRender', more: true, label: tr('软件渲染（桌面版）'), hint: tr('显卡驱动异常导致黑屏 / 闪烁时打开，重启后生效。'), keywords: tr('gpu render 黑屏 闪烁 disable-gpu 显卡') },
];

const MODEL_ENTRIES: EntryMeta[] = [
  { id: 'ai.thinkingLanguage', tab: 'models', block: tr('思考'), label: tr('思考用的语言'), hint: tr('让模型用这种语言思考。只改思考过程，回答还是跟着你说的语言。DeepSeek 等模型会照做；Claude 显示的思考是官方生成的摘要，多半仍是英文。对话空闲时会重启一次进程，下一轮生效；每个对话的 ··· 菜单里也能单独改。'), keywords: tr('thinking reasoning language 思考 推理 语言 中文 英文 日语 思考语言') },
];

const APPEARANCE: EntryMeta[] = [
  { id: 'ui.language', block: trAs('显示', 'Display'), label: tr('语言'), hint: tr('界面用中文还是英文。默认跟随这台电脑的语言；改了会重新加载界面。'), keywords: tr('language locale english chinese 语言 中文 英文 English') },
  { id: 'ui.theme', block: trAs('显示', 'Display'), label: tr('主题'), hint: tr('跟随系统会按操作系统的深浅色切换。'), keywords: tr('theme dark light 深色 浅色 暗色 亮色 system 跟随系统') },
  { id: 'ui.backdropMotion', block: trAs('显示', 'Display'), label: tr('背景动画'), hint: tr('新对话页的背景会动：字符画主题放它自己的背景，其它主题放飘动的字。关掉就是静止的纯色；系统开了「减少动态效果」时也是静止的。'), keywords: tr('background backdrop animation motion ascii welcome 背景 动画 动态 字符 新对话') },
  { id: 'ui.backdropInChat', block: trAs('显示', 'Display'), label: tr('对话里的淡背景'), hint: tr('用字符画主题时，对话后面也垫一层很淡、很慢的背景；关掉就是纯色。'), keywords: tr('background backdrop ascii theme conversation dim 背景 字符画 主题 对话 淡') },
  // not a meta.json key: the desktop shell keeps it (flags.json) — it has to be known before a window's first paint
  { id: 'ui.zoom', block: trAs('显示', 'Display'), label: tr('界面缩放'), hint: tr('把整个界面一起放大或缩小：屏幕分辨率高、东西看着小的时候调大。桌面版会记住；网页版请用浏览器自己的缩放。'), keywords: tr('zoom scale dpi 4k hidpi 缩放 放大 缩小 分辨率 高分屏 太小 看不清 大小 比例') },
  { id: 'ui.fontSize', block: trAs('显示', 'Display'), label: tr('字号'), hint: tr('整个界面的字号（像素）。'), keywords: tr('font size 字体大小') },
  { id: 'ui.density', block: trAs('显示', 'Display'), label: tr('密度'), hint: tr('紧凑模式减少行高与内边距。'), keywords: tr('density compact 紧凑 宽松') },
  { id: 'ui.cjkFont', more: true, label: tr('中文字体'), hint: tr('优先用于中日韩文字的字体。'), keywords: tr('cjk font 中文 字体 雅黑 苹方') },
  { id: 'ui.reduceMotion', block: trAs('显示', 'Display'), label: tr('减少动画'), hint: tr('关掉界面里的过渡与动画。'), keywords: tr('motion animation 动画 过渡') },
  { id: 'ui.haptics', block: trAs('显示', 'Display'), label: tr('触感反馈'), hint: tr('在支持的手机上，发送、批准、长按出菜单时轻震一下。打开「减少动画」时不震。'), keywords: tr('haptic vibrate 震动 振动 触感 手机') },
  // 开场和背景 (界面改版方案 第 7 版 #opening): the desktop shell reads these from meta.json before the server is up
  { id: 'ui.opening.pack', block: tr('开场和背景'), wide: true, label: tr('开场动画'), hint: tr('桌面版打开时放。Claude Web 娘是一段 10 秒的开场片，点火不用视频；也能放自己的视频。'), keywords: tr('opening intro splash animation video 开场 开场动画 启动 动画 视频 Claude Web 娘 看板娘 点火') },
  { id: 'ui.opening.when', block: tr('开场和背景'), label: tr('什么时候放'), hint: tr('其它时候是 1.6 秒的老开场；不放就只显示标志。网页版打开时不放。'), keywords: tr('opening when daily every 开场 每天 每次 第一次 不放') },
  { id: 'ui.opening.length', block: tr('开场和背景'), label: tr('长度'), hint: tr('Claude Web 娘完整约 13 秒、简短约 6 秒；点火完整约 4 秒、简短约 2 秒。'), keywords: tr('opening length short full 开场 长度 简短 完整 时长') },
  { id: 'ui.opening.sound', block: tr('开场和背景'), label: tr('声音'), hint: tr('默认关。开场左下角的小喇叭也能开，下次还记得。'), keywords: tr('opening sound audio mute 开场 声音 音乐 静音 喇叭') },
  { id: 'ui.opening.keep', block: tr('开场和背景'), label: tr('放完留作背景'), hint: tr('她站着的那段循环垫在应用后面，只从首页和空白处透出来；浅色主题换成火星。窗口最小化或切到别的程序时停下。'), keywords: tr('opening background backdrop loop opacity 开场 背景 循环 浓淡 透明度 火星 留作背景') },
];

// 值班 Bot (spec 2026-10-30-duty-bots-design 「设置 → Bot」): not on a settings page any more — 自动化 › Bot › 设置
// draws these rows (bots/BotSettings.tsx) with the same controls; the settings search still finds them, live, with
// that place as their crumb. Not all meta.json keys: 值班服务 registers a system service, 开机自启 is the desktop
// shell's login item, 放开全部 flips every bot.
export const BOT_ENTRIES: EntryMeta[] = [
  { id: 'bots.concurrency', block: tr('值班 Bot'), label: tr('同时运行几个 Bot'), hint: tr('超出的排队等着，前面的跑完再开始。'), keywords: tr('bot concurrency parallel 并发 同时 排队 值班') },
  { id: 'bots.globalBudgetUsd', block: tr('值班 Bot'), label: tr('全部 Bot 每天的预算（美元）'), hint: tr('所有 Bot 当天加起来花到这个数就停下，第二天再跑。留空或 0：不设总预算，只看每个 Bot 自己的。'), keywords: tr('bot budget cost usd money 预算 费用 花钱 上限 值班') },
  { id: 'bots.defaultProvider', block: tr('值班 Bot'), label: tr('默认来源'), hint: tr('Bot 7×24 小时跑，默认走 API / 网关来源，不用 Claude 订阅登录（2026-04 起条款可能禁止这样用订阅，有封号风险）'), keywords: tr('bot provider source gateway api subscription 供应商 来源 网关 订阅 值班') },
  { id: 'bots.defaultTier', block: tr('值班 Bot'), label: tr('新 Bot 的默认档位'), hint: tr('省钱用最便宜的模型，最强用最好的；每个 Bot 自己还能改。'), keywords: tr('bot tier model cheap balanced best 档位 模型 省钱 均衡 最强 值班') },
  { id: 'bots.duty.service', block: tr('值班 Bot'), label: tr('不开窗口也值班'), hint: tr('把服务注册成这台电脑的后台服务，登录后自动运行，窗口全关了 Bot 也照常跑。第一次启动可能要 1–2 分钟；开 / 关后以系统里的后台服务 / 计划任务为准。'), keywords: tr('bot duty service headless background autostart 值班 后台 服务 计划任务 开机') },
  { id: 'bots.loginItem', block: tr('值班 Bot'), label: tr('开机自启（桌面版）'), hint: tr('登录电脑后桌面版自己在托盘里启动。配合「关闭窗口时留在托盘」，关掉窗口 Bot 也继续值班。'), keywords: tr('bot login item startup tray 开机 自启 托盘 值班') },
  { id: 'bots.unleashAll', block: tr('值班 Bot'), label: tr('放开全部 Bot'), hint: tr('一次关掉所有 Bot 的限制（总管除外）：发送、付款、删除都不再先问你；只有停止和审计还在。「收回」恢复原来的规则。'), keywords: tr('bot unleash gate limit 放开 无闸 收回 限制 全自动 值班') },
];

export const SETTINGS_SECTIONS: SectionMeta[] = [
  // 账号
  { id: 'account', l: tr('账号与登录'), ic: 'user', group: 'account', desc: tr('Claude 账号的登录状态。用第三方接口或中转站请去「模型 › 来源」。'), keywords: tr('引擎与账号 engine account login 登录 账号'), bodies: ['account'], more: ['engine'] },
  { id: 'usage', l: tr('用量与账本'), ic: 'gauge', group: 'account', desc: tr('这个对话和所有对话用了多少 token、花了多少钱，每一次调用记在账本里。'), keywords: tr('usage ledger 用量 账本 费用 成本 token'), bodies: ['usage'] },
  // 应用
  { id: 'appearance', l: tr('外观'), ic: 'sun', group: 'app', desc: tr('主题、字号、界面密度，还有开场动画和背景。'), keywords: tr('appearance theme 主题 开场'), entries: APPEARANCE, bodies: ['openings', 'customCss'] },
  { id: 'window', l: tr('通知与窗口'), ic: 'bell', group: 'app', desc: tr('什么时候提醒你，关窗口、退出时怎么办，界面要显示多少工具。'), keywords: tr('通用 界面 notification window tray 窗口 通知 interface'), entries: WINDOW },
  { id: 'remote', l: tr('手机与远程'), ic: 'device', group: 'app', desc: tr('在手机上接着用，把其它电脑上的对话接到这里，或者在聊天软件里给 Claude 派活。'), keywords: tr('远程 / 手机 remote phone 手机 远程 手机与其它电脑 IM 机器人 IM 网关'), bodies: ['remote', 'peers', 'im'], more: ['anywhere', 'hosts'] },
  { id: 'secrets', l: tr('隐私与密钥'), ic: 'lock', group: 'app', desc: tr('供应商的 API Key 怎么存在本机，厂商能看到你的哪些东西。'), keywords: tr('secret 密钥 加密 privacy 隐私'), bodies: ['secrets', 'privacy'] },
  // Claude Code
  { id: 'conversation', l: trAs('对话', 'Conversations'), ic: 'chat', group: 'code', desc: tr('新对话的默认做法，和对话里显示多少东西。'), keywords: tr('通用 会话 general session conversation'), entries: CONVERSATION },
  {
    id: 'model', l: trAs('模型', 'Models'), ic: 'cloud', group: 'code', desc: tr('用哪些来源（Claude 账号、中转站、API），几个来源怎么组成一个入口，模型菜单里出现哪些模型。'), keywords: tr('model 模型 供应商 provider 模型网关 gateway effort 智能程度 来源 路由'), entries: MODEL_ENTRIES,
    tabs: [
      { id: 'sources', l: trAs('来源', 'Sources'), bodies: ['providers', 'proxy'], keywords: tr('供应商 provider 中转 api key 来源 网络代理') },
      { id: 'routing', l: tr('路由'), bodies: ['gateway'], keywords: tr('模型网关 gateway 网关 故障转移 路由 分组') },
      { id: 'models', l: trAs('模型', 'Models'), bodies: ['models'], keywords: tr('模型与智能程度 model effort 智能程度 模型列表') },
    ],
  },
  { id: 'web', l: tr('联网与浏览器'), ic: 'web', group: 'code', desc: tr('让 Agent 能搜索、能打开网页：用什么搜索，在哪个浏览器里打开。'), keywords: tr('web 联网 上网 搜索 浏览器 search browser'), bodies: ['web'] },
  {
    id: 'agents', l: tr('Agents 与子代理'), ic: 'agent', group: 'code', desc: tr('其它编程 Agent（Codex、Gemini CLI…）的安装、登录与启动参数，以及 Claude 自己的子代理。'), keywords: tr('agent agents 子代理'),
    tabs: [
      { id: 'cli', l: TERMS.agents, bodies: ['agents'], keywords: 'CLI Agents codex gemini qwen kimi' },
      { id: 'subagents', l: tr('Claude 子代理'), bodies: ['subagents'], keywords: tr('subagent Claude 子代理') },
    ],
  },
  { id: 'memory', l: tr('记忆与对话库'), ic: 'memory', group: 'code', desc: tr('所有 Agent 共用的一份记忆（做过的决定、约束、踩过的坑），和并进侧栏、搜索的其它 Agent 的历史对话。'), keywords: tr('memory 记忆 共享记忆 library 会话库 对话库 历史'), bodies: ['memory', 'library'] },
  // 高级
  { id: 'env', l: trAs('环境变量', 'Environment variables'), ic: 'config', group: 'advanced', advanced: true, desc: tr('本机环境变量加密保存，只给这个应用开的对话和终端；下面的「其它环境变量」写进 ~/.claude/settings.json，命令行里的 Claude Code 也读。供应商的地址和密钥不在这里。'), keywords: tr('env 环境变量 配置中心'), bodies: ['localEnv', 'env'] },
  { id: 'hooks', l: tr('Hooks 与 settings.json'), ic: 'bolt', group: 'advanced', advanced: true, desc: tr('Claude Code 在某些事件时运行的命令（只读列表，来自 settings.json 和插件），和 settings.json 原文（用户 / 项目 / 本机）。'), keywords: tr('hook 钩子 settings json raw 原文 配置中心'), bodies: ['hooks', 'raw'] },
  { id: 'diagnostics', l: tr('诊断与更新'), ic: 'refresh', group: 'advanced', advanced: true, desc: tr('出问题时打一个诊断包，看当前版本和更新，查本机装了哪些命令行工具。'), keywords: tr('diagnostic 诊断 日志 update 更新 版本 tools cli 工具'), bodies: ['diagnostics', 'update', 'tools'] },
];

/** The pages without implementation words (the wording gate's scope) and the 高级 group's. The nav shows all four groups. */
export const VISIBLE_SECTIONS = SETTINGS_SECTIONS.filter((s) => !s.advanced);
export const ADVANCED_SECTIONS = SETTINGS_SECTIONS.filter((s) => s.advanced);
export const DEFAULT_SECTION = 'conversation';

/**
 * Old ids whose page got another name or was merged into another (the 2026-09 window's flat ids, and stage 2's
 * regroup of 常用 / 模型 / 扩展 / 连接 / 数据 / 高级 into 4 groups); the other old ids are still page ids. A part
 * that now shares a page opens that page scrolled to it (`body`).
 */
export const LEGACY_SECTIONS: Record<string, { section: string; tab?: string; more?: boolean; body?: BodyId }> = {
  general: { section: 'conversation' },
  session: { section: 'conversation' },
  interface: { section: 'window' },
  engine: { section: 'account', more: true, body: 'engine' },
  models: { section: 'model', tab: 'models' },
  providers: { section: 'model', tab: 'sources' },
  gateway: { section: 'model', tab: 'routing' },
  subagents: { section: 'agents', tab: 'subagents' },
  im: { section: 'remote', body: 'im' },
  library: { section: 'memory', body: 'library' },
  raw: { section: 'hooks', body: 'raw' },
  update: { section: 'diagnostics', body: 'update' },
  tools: { section: 'diagnostics', body: 'tools' },
};

/** Where something that left the settings lives now: a tab of 自定义, or 自动化 › Bot › 设置 (a row of it to show). */
export type AwayTarget =
  | { to: 'extensions'; tab: ExtensionTab; json?: boolean }
  | { to: 'bots'; reveal?: string };

/**
 * The pages that left the settings (spec #ia: 「MCP 与插件、Skills → 自定义，设置里不再重复一份」; Bot 的几项 →
 * 自动化 › Bot › 设置): an old id opens their new place, the search lists them as jumps there.
 */
export const AWAY_SECTIONS: Record<string, { l: string; ic: IconName; keywords: string; crumb: string; target: AwayTarget; hidden?: boolean }> = {
  mcp: { l: tr('MCP 与插件'), ic: 'mcp', keywords: tr('mcp server 连接器 已配置 目录 catalog registry 注册表 健康检查 当前会话 移除'), crumb: tr('自定义 › 连接器'), target: { to: 'extensions', tab: 'connectors' } },
  plugins: { l: tr('插件'), ic: 'puzzle', keywords: tr('plugin plugins marketplace 插件 市场 安装 卸载 启用 配置中心'), crumb: tr('自定义 › 插件'), target: { to: 'extensions', tab: 'plugins' } },
  // the connector directory's 「用配置手动添加…」 opened the settings MCP page's JSON form by this id
  'mcp-json': { l: tr('手动添加（JSON）'), ic: 'mcp', keywords: tr('mcp json add-json 手动 添加 stdio 配置'), crumb: tr('自定义 › 连接器'), target: { to: 'extensions', tab: 'connectors', json: true } },
  skills: { l: 'Skills', ic: 'skill', keywords: tr('skill 技能 安装 github 新建 编辑 删除 备份 backup tar 恢复 restore'), crumb: tr('自定义 › Skills'), target: { to: 'extensions', tab: 'skills' } },
  bots: { l: tr('值班 Bot'), ic: 'bot', keywords: tr('bot 值班 duty 预算 并发 放开'), crumb: tr('自动化 › Bot › 设置'), target: { to: 'bots' }, hidden: true },
};
/** The crumb of the rows that moved to 自动化 › Bot › 设置. */
export const BOTS_CRUMB = AWAY_SECTIONS.bots.crumb;

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

/** What `openSettings` takes (store/index.ts); `tab` picks a tab of a page with tabs. */
export interface SettingsAsk { section?: string; tab?: string; query?: string; reveal?: string }

export function findSection(id: string | undefined): SectionMeta | undefined {
  return id ? SETTINGS_SECTIONS.find((s) => s.id === id) : undefined;
}
export function groupLabel(g: SettingsGroupId): string {
  return SETTINGS_GROUPS.find((x) => x.id === g)?.l ?? '';
}
/** Every row on a settings page, with the page it is on. */
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
/** The rows a page (or one of its tabs) shows: a row with a `tab` only on that tab. */
export function entriesOn(section: SectionMeta, tab?: string): EntryMeta[] {
  const t = activeTab(section, tab);
  return (section.entries ?? []).filter((e) => !e.tab || e.tab === t?.id);
}
/** The parts a target shows (更多选项 included). */
export function targetBodies(t: SettingsTarget): BodyId[] {
  const s = findSection(t.section);
  if (!s) return [];
  const tab = activeTab(s, t.tab);
  return tab ? [...tab.bodies, ...(tab.more ?? [])] : [...(s.bodies ?? []), ...(s.more ?? [])];
}

/**
 * Where an `openSettings` ask goes when it is not a settings page any more (an old id of MCP / 插件 / Skills, a row of
 * 值班 Bot) — undefined when it is one. A section / reveal that is a settings page or row wins.
 */
export function awayTarget(o: SettingsAsk | null | undefined): AwayTarget | undefined {
  if (o?.reveal) {
    if (allEntries().some(({ entry }) => entry.id === o.reveal)) return undefined;
    if (BOT_ENTRIES.some((e) => e.id === o.reveal)) return { to: 'bots', reveal: o.reveal };
  }
  const id = o?.section;
  if (!id || findSection(id) || LEGACY_SECTIONS[id]) return undefined;
  return AWAY_SECTIONS[id]?.target;
}

/**
 * `openSettings({section, tab, reveal})` → the page to show. `reveal` (an entry id) wins and opens 更多选项 when the
 * entry is in there; old section ids go through LEGACY_SECTIONS; anything unknown opens 对话.
 */
export function resolveSettingsTarget(o: SettingsAsk | null | undefined): SettingsTarget {
  if (o?.reveal) {
    const hit = allEntries().find(({ entry }) => entry.id === o.reveal);
    if (hit) return { section: hit.section.id, ...(hit.entry.tab ? { tab: hit.entry.tab } : {}), reveal: hit.entry.id, ...(hit.entry.more ? { more: true } : {}) };
  }
  const id = o?.section;
  const sec = findSection(id);
  if (sec) {
    const tab = o?.tab && sec.tabs?.some((t) => t.id === o.tab) ? o.tab : undefined;
    return { section: sec.id, ...(tab ? { tab } : {}) };
  }
  if (id && LEGACY_SECTIONS[id]) return { ...LEGACY_SECTIONS[id] };
  return { section: DEFAULT_SECTION };
}

/** What 更多选项 holds on a page (or one of its tabs), for the line next to it. */
export function moreHint(section: SectionMeta, tab?: string): string {
  const t = activeTab(section, tab);
  const entries = entriesOn(section, tab).filter((e) => e.more).map((e) => e.label);
  const bodies = (t ? t.more ?? [] : section.more ?? []).map((b) => BODY_INFO[b].l);
  return [...entries, ...bodies].join('、');
}

export type SettingsHit =
  | { kind: 'entry'; section: SectionMeta; entry: EntryMeta; crumb: string }
  /** a row that moved out of the settings (值班 Bot): live here too, its crumb opens where it lives */
  | { kind: 'away-entry'; entry: EntryMeta; crumb: string; target: AwayTarget }
  | { kind: 'page'; section: SectionMeta; tab?: TabMeta; body?: BodyId; more?: boolean; title: string; crumb: string }
  /** a page that moved out of the settings: a jump to its new place */
  | { kind: 'away'; id: string; title: string; ic: IconName; crumb: string; target: AwayTarget };

function crumbOf(section: SectionMeta, tab?: TabMeta, more?: boolean): string {
  return [groupLabel(section.group), section.l, tab?.l, more ? tr('更多选项') : undefined].filter(Boolean).join(' › ');
}

/**
 * Full-text search over every row (label / hint / keywords / id) and every page, tab and part — 更多选项 included —
 * and over what moved out (自定义's MCP / 插件 / Skills, 自动化 › Bot's rows). All words of the query must match. A part
 * that is in plain view once its page / tab opens is not listed again when that page / tab matched too.
 */
export function searchSettings(query: string): SettingsHit[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const match = (...parts: (string | undefined)[]) => { const text = parts.filter(Boolean).join(' ').toLowerCase(); return words.every((w) => text.includes(w)); };
  const hits: SettingsHit[] = [];
  for (const section of SETTINGS_SECTIONS) {
    const g = groupLabel(section.group);
    for (const entry of section.entries ?? []) {
      const tab = entry.tab ? section.tabs?.find((t) => t.id === entry.tab) : undefined;
      if (match(entry.label, entry.hint, entry.keywords, entry.id, entry.block, section.l, tab?.l, g)) hits.push({ kind: 'entry', section, entry, crumb: crumbOf(section, tab, entry.more) });
    }
  }
  for (const entry of BOT_ENTRIES) {
    if (match(entry.label, entry.hint, entry.keywords, entry.id, entry.block)) hits.push({ kind: 'away-entry', entry, crumb: BOTS_CRUMB, target: { to: 'bots', reveal: entry.id } });
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
  for (const [id, a] of Object.entries(AWAY_SECTIONS)) {
    if (!a.hidden && match(a.l, a.keywords, a.crumb)) hits.push({ kind: 'away', id, title: a.l, ic: a.ic, crumb: a.crumb, target: a.target });
  }
  return hits;
}

/** The small status at the end of a nav row (Linear's 「Desktop · Disabled」): only what is known. */
export function navStatus(o: { loggedIn?: boolean | null }): Record<string, string> {
  const out: Record<string, string> = {};
  if (o.loggedIn === true) out.account = tr('已登录');
  else if (o.loggedIn === false) out.account = tr('未登录');
  return out;
}

/** Words of a keyboard (spec #phone 问题 8: phones show none): a row's touchHint must not have them. */
export const KEYBOARD_WORDS = /\b(?:Ctrl|Alt|Shift|Cmd)\b|按 ?Tab|\bEnter\b|⌘/;
