# claude-web

本机 Web 版 Claude Code。一个 Node 进程（`server/`）用 `@anthropic-ai/claude-agent-sdk` 驱动 Claude Code，
通过一条 WebSocket（`/ws`）把所有 SDK 消息推给 React 前端（`web/`）。设计文档：`docs/superpowers/specs/`。

## 跑起来

```
npm install
npm run build        # 构建 web/dist
npm start            # http://127.0.0.1:3090
npm run dev          # 开发：server tsx watch + vite :5173（代理 /ws 到 3090）
```

## 笔记怎么用

各功能的设计决定、踩过的坑、调试办法都在 `docs/notes/`（下面的索引），**按需读，别一次全读**：
动哪块代码，先读对应的那一篇（文件名和标题都能 grep，比如 `grep -l 停靠卡 docs/notes/*.md`）。
笔记之间互相引用时用的是标题（「界面改版 阶段 4」之类），在索引里找。
新的经验写进对应的笔记，不要再往这个文件里加长段落——这个文件每一轮都会整份进上下文，
以前它涨到 375 KB，在 20 万上下文的模型上会让自动压缩反复失败（「Autocompact is thrashing」）。

## 必读规则（跨模块）

- **reducer 是唯一真源**（`web/src/model/conversation.ts`），改它先跑 `npm test -w web`。
- **SDK 不回显用户消息**：发送方自己 push；别的窗口的回显走 `sent` 事件（`cw_echo`）。
- 新的 UI 状态（草稿、开关、设置）存 meta.json（`settings.set`），**别用 localStorage**——桌面版每次启动 origin 都变。
- 原生对话框一律 `web/src/ui/dialog.tsx` 的 `dlg.*`；菜单用 `useAnchoredMenu` / `composer/Popover` / `useDropdown`，别自己挂 window 监听。
- zustand 选择器必须返回稳定引用（别 `?? []`、`.filter()`、`({…})`），`store/selectors.test.ts` 会查。
- 文本框的 Enter / Escape 先问 `ui/ime.ts` 的 `imeComposing()`。
- **用户看得见的字都走 `tr('中文')`**（中文原文是 key，英文在旁边的 `en.ts`；界面语言默认跟着电脑，设置 → 外观 → 语言可换）。新加 / 改字后 `node scripts/i18n/extract.mjs --check`，`npm test` 的覆盖测试会拦漏翻；README 的图用 `node scripts/readme-shots.cjs --lang en|zh` 重拍。细节在 `i18n` 笔记。
- 用户看得见的字：叫「对话」不叫「会话」；不出现 档案 / 引擎 / 窗格 / 停靠 / effort / ultracode / ACP；空状态走 `terms.ts` 的 `EMPTY`。`wording.test.ts` 会拦。
- 子进程 spawn 显式写 `windowsHide: true`；新加带 sessionId 的请求要进联邦路由表（`federation/rewrite.ts`）。
- 停靠面板 / 右侧面板 / 分区页**不卸载**，只 `hidden`（终端 pty、xterm 缓冲、表单状态）。
- 改文件用 Edit / Write，或把脚本写成文件再跑：bash 里 `node -e "…"` 的反引号会被当命令替换，heredoc 会吃反斜杠。仓库是 LF（`.gitattributes`）。
- 测试：`npm run typecheck`、`npm test`、`npm run build:all`、`npm run e2e`（自带临时 HOME，不花 token）、`node scripts/ui-smoke.cjs`（Electron，任何 console 错误都算失败）。真机验证用临时 `CLAUDE_WEB_DIR` / HOME，别碰用户自己的 `~/.claude-web`。官网 `site/` 有自己的依赖：`npm install` 后跑一次 `npm run site:install`（根的 `typecheck` / `test` 也查 `site/`）。
- 本机开发 shell 继承了 `CLAUDE_CODE_ENTRYPOINT=sdk-cli`、已装桌面版的 `CLAUDE_WEB_DIST` 、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`、`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`、`CLAUDE_WEB_THINKING_DISPLAY`、`CLAUDE_WEB_CONTEXT_WINDOWS` / `CLAUDE_WEB_MODEL_CAPS`、`ELECTRON_RUN_AS_NODE`（会让 `npx electron` 退回 Node，`ui-smoke` 整个跑不起来），测指纹 / 自己起 server / 跑 `npm test`（`session-runner.test.ts` 会挂三条）/ `ui-smoke` 时 `env -u` 掉。还有 `CLAUDE_WEB_ENGINES`、`CLAUDE_WEB_SIDECARS`、`ANTHROPIC_BASE_URL` 等，最省事是全去掉：`env $(env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|ELECTRON_RUN_AS_NODE)' | sed 's/^/-u /') npm test`。
- 提交身份固定 `ypyik0669`；引擎（ccb fork）发版、应用发版的步骤在 `engine-providers` / `macos-ci` 两篇里。

## 笔记索引

| 笔记 | 原标题 | 内容 |
| --- | --- | --- |
| [pitfalls](docs/notes/pitfalls.md) | 已踩的坑 | SDK 的老坑：spawn ENOENT、用户消息回显、assistant 拆条、子代理 jsonl、canUseTool |
| [mirasim](docs/notes/mirasim.md) | 从 Mirasim 借鉴的功能（2026-09-02） | 额度环、meta.json、分叉、插话、worktree 会话 |
| [engine-providers](docs/notes/engine-providers.md) | 引擎（单运行时）与供应商档案 | 运行内核（ccb fork / 官方二进制）、引擎发版、供应商档案的 env 映射、中转指纹、settings.json 的 env 覆盖 |
| [phase01-render](docs/notes/phase01-render.md) | 渲染与对话交互（阶段 1，2026-09-03） | reducer、uuid 锚点、工具卡片注册表、健康信号、附件、代码块 |
| [phase02-layout](docs/notes/phase02-layout.md) | 工作台布局（阶段 2，2026-09-03） | 分组 / 窗格 / 标签、拖放、多窗口、＋菜单被裁、组名、标题栏留空 |
| [phase03-files-git](docs/notes/phase03-files-git.md) | 文件 / Git / 编辑器（阶段 3，2026-09-03） | 文件 / 搜索 / Git 服务、Monaco、Doc tile |
| [phase04-config](docs/notes/phase04-config.md) | 配置中心 / 自动化 / 打磨（阶段 4，2026-09-03） | 设置、对话框、密钥、Skills、MCP、定时任务、账本、诊断 |
| [phase05-agents](docs/notes/phase05-agents.md) | 多 agent（阶段 5，2026-09-03） | AgentDriver、Codex / ACP 协议、归一成 SDK 消息、Windows 垫片、shot.cjs 用法 |
| [phase06-remote-im](docs/notes/phase06-remote-im.md) | 远程 / 手机 / IM（阶段 6，2026-09-03） | 远程监听、配对、SSH 隧道、手机布局、IM 网关 |
| [remote-anywhere](docs/notes/remote-anywhere.md) | 手机在外面也能连（2026-10-01，已删除 2026-10-31） | 删了什么、为什么、留下了什么（VPS / 站点是上游的，不用管） |
| [phase07-board-goal](docs/notes/phase07-board-goal.md) | 看板 / 目标 / Android（阶段 7，2026-09-03） | Issue/PR 看板、目标（Goal）、Android |
| [phase08-tokens-dock](docs/notes/phase08-tokens-dock.md) | 设计令牌 / 图标 / 停靠面板（阶段 8，2026-09-04） | 令牌分层、焦点环、PANELS 表、停靠面板不卸载 |
| [phase09-chat](docs/notes/phase09-chat.md) | 对话渲染与 composer（阶段 9，2026-09-04） | 回合时间线、RunCard、applyTranscript live、模型 catalog、ultracode、流式卡顿（按帧渲染 / 测量脚本） |
| [phase10-browser-tile](docs/notes/phase10-browser-tile.md) | 内嵌浏览器（阶段 10，2026-09-04） | 窗格里的浏览器标签 |
| [phase11-canonical](docs/notes/phase11-canonical.md) | 会话内核：canonical / 热切换 / 交接（阶段 11，2026-09-04） | canonical 时间线、热切换、交接 |
| [phase12-memory](docs/notes/phase12-memory.md) | 跨 agent 共享记忆（阶段 12，2026-09-04） | memory.db、FTS5 与中文、MCP 注入 |
| [library](docs/notes/library.md) | 统一会话库（2026-09-27） | 对话库来源表、id 规则、索引、Codex/OpenCode 的坑、watchTree |
| [gateway](docs/notes/gateway.md) | 模型网关（2026-09-28） | 网关分层、透传保字节、故障转移、协议坑 |
| [gateway-ui](docs/notes/gateway-ui.md) | 上游页：来源卡片 + 筛选（2026-10-26） | 来源卡片 / 筛选、详情模块、旧 tab 去向、添加来源向导、隐私中心挂载点、Esc 由内到外 |
| [routing](docs/notes/routing.md) | 智能路由（2026-10-26，spec 统一模型来源 §7） | 路由组 = 网关组、策略即虚拟模型、候选硬过滤 / 打分、亲和、§7.3 换候选规则、预算、「自动 → 实际」、RoutingDetail |
| [agent-config](docs/notes/agent-config.md) | 其它 agent 的配置中心（2026-09-28） | Codex/Gemini/Qwen/OpenCode 配置编辑、备份、CLI 的坑 |
| [federation](docs/notes/federation.md) | 跨机器会话 / 联邦（2026-09-28） | peer 连接、id 前缀、路由表、防环、远端文件保护 |
| [orchestra](docs/notes/orchestra.md) | 多 agent 编排（2026-09-28） | 编排引擎、worktree / 比选、不毁用户的东西、竞态 |
| [models](docs/notes/models.md) | 多模型管理（2026-09-28） | 拉模型列表、统一菜单、会话内切换路由、子代理模型（含别家的模型）、挑要用的模型、Codex 报的列表、DeepSeek V4 窗口、改供应商对在跑的对话生效、思考用的语言 |
| [ui-redesign-0-1](docs/notes/ui-redesign-0-1.md) | 界面改版 阶段 0–1：令牌 / 文案 / 外框按需出现（2026-09-28） | 令牌 / 对比度测试、术语表、外框按需出现、会话头、桌面标题栏、外框控件计数 |
| [ui-redesign-2-right-panel](docs/notes/ui-redesign-2-right-panel.md) | 界面改版 阶段 2：右侧面板（2026-09-28） | 右侧面板：固定标签、审阅、文件、标签行、ui-smoke 段 |
| [ui-redesign-3-composer](docs/notes/ui-redesign-3-composer.md) | 界面改版 阶段 3：输入框 + 模型 / 权限菜单（2026-09-28） | 输入框一行、+ 菜单、项目 / 分支 / 权限 chip、模型菜单、上下文小环、没在跑的对话的 chip |
| [ui-redesign-4-sidebar](docs/notes/ui-redesign-4-sidebar.md) | 界面改版 阶段 4：侧栏（2026-09-28） | 侧栏结构、行状态、需要你、筛选 / 多选、菜单规则、入口表 |
| [ui-redesign-5-chat](docs/notes/ui-redesign-5-chat.md) | 界面改版 阶段 5：对话渲染（2026-09-29） | 回合折叠、改动文件卡、停靠的权限卡与防误触、消息操作、目标细条 |
| [ui-redesign-6-settings](docs/notes/ui-redesign-6-settings.md) | 界面改版 阶段 6：设置重组（2026-09-28） | 设置表 catalog、旧 id、全窗页与焦点、wording 闸 |
| [ui-redesign-7-home](docs/notes/ui-redesign-7-home.md) | 界面改版 阶段 7：首页 / 首次引导 / 自动化页 / 手机（2026-09-29） | 首页、入门清单、首次引导、自动化页、手机底部抽屉、断线条、空状态、文案闸 |
| [quick-connect](docs/notes/quick-connect.md) | 首次使用：接一个模型 / Agent 检测（2026-09-30） | 快速连接、模型挑选、接一个模型对话框、Agent 检测 |
| [provider-routing](docs/notes/provider-routing.md) | 供应商：IM / 定时任务 / 其它 Agent（2026-09-30 用户报告） | 对话池里定供应商、IM 供应商、Codex 经垫片 |
| [proxy-external](docs/notes/proxy-external.md) | 网络代理 / 外部写入的对话 / Codex 读取（2026-09-30 用户报告） | 网络代理、外部写入的对话实时显示、Codex 读历史 |
| [engine-switch-cost](docs/notes/engine-switch-cost.md) | 引擎切换 / 费用 / 切换竞态（2026-10-01～02，真中转实测） | leaf 修复、费用按轮、ccb thinking 绕行、切换竞态、终端接着聊、Codex 镜像同步 |
| [effort-ultracode](docs/notes/effort-ultracode.md) | 思考强度 / 深度编排 / 自动判断在所有模型上（2026-10-08） | 各接口的强度参数、CLAUDE_WEB_MODEL_CAPS、被拒记录、自动判断 |
| [prompt-cache](docs/notes/prompt-cache.md) | 提示缓存（2026-09-28） | 用量统计修正、费用未知、网关缓存键、缓存垫片、闲置回收 |
| [desktop](docs/notes/desktop.md) | 桌面版（desktop/） | Electron 壳、打包、应用自动更新 |
| [macos-ci](docs/notes/macos-ci.md) | macOS / CI（2026-09-27） | mac 打包、发版收尾、CI、没有 Mac 时怎么验 |
| [robustness](docs/notes/robustness.md) | 子进程窗口 / 前端健壮性（2026-09-28） | 停止、终端是 shell、spawn guard、错误边界、zustand 选择器、ui-smoke 用法 |
| [ui-refresh](docs/notes/ui-refresh.md) | 界面换新（2026-10-10） | 样式文件顺序、令牌、外壳、字体、图标、标题栏、动效、手机交互、质感：发丝边 / 弹簧 / 滚动渐隐 / 暗色字重（10-16） |
| [i18n](docs/notes/i18n.md) | 界面语言：中文和英文（2026-10-15，用户要求） | tr() 约定、语言怎么定、四份英文目录、加一句字的流程、i18n-smoke、README 截图脚本、坑 |
| [claude-accounts](docs/notes/claude-accounts.md) | 其它 Claude 账号（2026-10-15，用户要求） | claude-account 档案、setup-token 令牌、runner 走账号那条路、添加对话框、真机验证 |
| [custom-css](docs/notes/custom-css.md) | 自定义样式 custom.css 与 DOM 钩子（2026-10-15，GitHub issue #2） | custom.css 加载 / 热更新、钩子约定、计划进度条 |
| [chat-input](docs/notes/chat-input.md) | 对话与输入：旁聊 / 下一句提示 / 查看模式 / @文件 / 快捷键（2026-10-16） | side_question、CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION、ui.viewMode、fs.findFiles、官方快捷键对照、桌面版无麦克风 |
| [review-pr](docs/notes/review-pr.md) | 审阅与 PR：diff 行评论 / 代码审查卡 / PR 监控条（2026-10-16） | DiffView comments、CLAUDE_CODE_REPORT_FINDINGS 与 ReportFindings、vcs.prForBranch / autoMerge、自动修 CI、自动归档 |
| [sessions-env](docs/notes/sessions-env.md) | 环境与对话：跨对话工具 / 任务 chip / 选机器 / worktree 设置 / 文件右键 / 本机环境变量 / 深链接（2026-10-16） | sessions MCP（进程内）、ccb 的 ExecuteExtraTool、<cw-from>、新对话选机器、.worktreeinclude、shell.editors、local-env.json、claude-web:// |
| [pages](docs/notes/pages.md) | 页面与入口：总览栏 / 定时任务补跑 / 预览服务器 / 更新内容 / 只聊天 / 跨对话生成文件 / 快捷键（2026-10-16） | MissionPanel 的待审 / 落地中、missedRun、.claude/launch.json 与 preview_*、app.changelog、tools: [] + strictMcpConfig、artifacts.list、Ctrl+/ |
| [recording-ux](docs/notes/recording-ux.md) | 照官方桌面版录屏改的界面（2026-10-16，用户要求） | 信息栏、标题栏工具 / ⋮、一行输入框 + 框下一行、Ctrl+Enter 插话、statusLine（已删）、模型菜单数字 / 快速模式、+ 菜单连接器、运行行、计划卡、浏览器空白页的开发服务器；第二轮（10-17）：sharp、官方技能插件、队列里的后台结束、改名被写回、SDK 列表漏长首句、logo、动态背景、☰ ← →、钉住 / 朗读；第三轮：Claude 思考为空（thinking.display）、思考标题 / 四点、对话统计条、☰ 叠放、手机标题 |
| [import](docs/notes/import.md) | 从其它工具导入（2026-10-17，用户要求） | Hermes / CC Switch / Codex / OpenCode / Continue / IDE 的供应商和 MCP、只读、key 不上 wire、Mirasim 读不了 |
| [zoom](docs/notes/zoom.md) | 界面缩放（2026-10-10 用户要求：台式机分辨率高，界面看着小） | 桌面版页面缩放 |
| [rail-sections-web](docs/notes/rail-sections-web.md) | 图标栏 / 分区 / 联网（2026-10-10，界面第二轮） | 图标栏、分区页、扩展页、强度按钮、浏览器标签、web MCP |
| [search-computer](docs/notes/search-computer.md) | 搜索在内置浏览器里 / 网页上的鼠标键盘 / 操控电脑（2026-10-10，用户要求） | 浏览器里搜索、browser_computer、操控电脑（computer MCP）、控制台 / 网络 / 页面结构 / 等待 / 标签 / 视口工具（共用调试器） |
| [ego-lite](docs/notes/ego-lite.md) | ego lite 作为 Agent 的第一浏览器（2026-10-26，用户要求） | ego-browser 命令、round-NN.mjs + import()、CW_WEB_BROWSER、alwaysLoad 与 ccb 的 ExecuteExtraTool、退回内置浏览器、假 ego-browser 测试 |
| [plugins-sync-share](docs/notes/plugins-sync-share.md) | 插件 / 同步 / 远程共享（2026-10-26，spec 统一模型来源 §4.3、§8） | 来源定义 JSON、可执行插件的子进程隔离与权限批准、pluginSources / runHook 接入点、签名远程目录、同步文件（scrypt + AES-GCM、逐项合并、凭据冲突两份都留）、共享密钥（share 密钥组、只收窄的规则、日 / 周 / 月额度、LAN 监听） |
| [background](docs/notes/background.md) | 后台：在跑的子代理和工作流（2026-10-12） | 后台：子代理 / 工作流的数据来源、服务端、前端、调试 |
| [cafe](docs/notes/cafe.md) | 后台 · 网吧（2026-10-13） | 等距像素网吧、角色格式、捏角色的 skill 和工具、模拟与渲染 |
| [ascii-themes](docs/notes/ascii-themes.md) | 字符画主题与过程动画（2026-10-22，用户要求） | 主题包、data-ascii、16 个过程 / 帧表、ProcessGlyph、Worker 背景的沙箱和看门狗、安静区、十套内置、theme-check 脚本、ascii-theme skill 与试跑、设置页画廊、截图办法 |
| [site](docs/notes/site.md) | 官网（2026-10-22） | site/ 的 Astro 站、文案与覆盖测试、语言跳转、按系统的下载按钮、版本数据、首次加载预算、Pages 发布 |
| [node-graph](docs/notes/node-graph.md) | 节点图（spec 2026-10-24 D） | ui/node-graph 共用组件；nodegraph 格式、marks / 状态标签；后台指挥台、编排执行图、对话代码块与 Mermaid 切换；动效与 150 张上限；ui.nodegraphHint |
| [free-sources](docs/notes/free-sources.md) | 免费来源与托管程序（2026-10-26，spec「统一模型来源」切片 4） | 来源目录三层与签名远程目录、ChannelDriver 注册表、channels.add 一步添加、Kilo 免 key、modelFilter、CLIProxyAPI / Magpie 的下载校验 / 回退 / 运行 / 连接已有 |
| [security-audit](docs/notes/security-audit.md) | 安全审计（2026-10-31，用户要求） | SEC-01～20 待修清单：DNS rebinding、插件沙箱、手机壳信任根、转发前向保密、局域网明文、联邦、插件市场 / 下载校验、密钥进命令行；状态表 |
| [screen-recording](docs/notes/screen-recording.md) | 录屏（阶段 E3，2026-10-25） | + 菜单录屏、自己的选择框、主进程只放行选中的源、录制格式与上限、抽关键帧、录下 Claude 的操作 |

## 结构

- `server/src/protocol.ts` — 前后端共享协议类型（web 通过 `@shared` 别名引用）
- `server/src/runtime/session-runner.ts` — 一个活动会话 = 一个 SDK query（streaming input，跨轮）
- `server/src/sessions/service.ts` — 会话列表/历史（SDK listSessions 等）+ chokidar 监听
- `server/src/config/service.ts` — 插件/MCP/skills/agents/hooks/auth，调 `claude <子命令>`
- `web/src/model/conversation.ts` — 纯函数 reducer，SDK 消息 → 消息树
- `web/src/store/index.ts` — zustand，所有 WS 事件在这里进 reducer
- `server/src/web/` — 联网：搜索、`web` MCP 服务器、给内置浏览器派活；浏览器本身在 `web/src/features/browser/`
- `server/src/computer/` — 操控电脑（Windows）：`computer` MCP 服务器、授权闸、PowerShell helper、向用户要授权的接口；对话里的文字和授权卡在 `web/src/features/computer/` 和 `chat/PermissionCards.tsx`
- `web/src/features/rail/`、`web/src/features/sections/` — 图标栏和分区页
- `server/src/background/`、`web/src/features/background/` — 后台：在跑的子代理、工作流、后台命令（登记表、卡片、关系图）
- `server/src/characters/`、`web/src/features/cafe/` — 网吧：角色格式（`core/`，web 经 `@characters`）、角色库、捏角色的工具和 skill、Canvas 网吧
