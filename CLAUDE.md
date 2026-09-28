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

## 已踩的坑

- **SDK 自带 spawn 在 Windows 上 ENOENT**：`@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` 直接 `child_process.spawn` 没问题，
  但 SDK 内部的 spawn 报 ENOENT。解决：`options.spawnClaudeCodeProcess` 自定义 spawn（见 `server/src/claude-exe.ts`）。
- **SDK 不回显用户消息**：前端发送时自己往对话里 push 一条 user item。
- **一条 API 消息会拆成多条 `assistant` 事件**（同一个 `message.id`，每个 content block 一条），reducer 按 id 合并（`web/src/model/conversation.ts`）。
- **子代理对话不在主 jsonl 里**：`<session-id>/subagents/agent-<id>.jsonl`，用 SDK `getSubagentMessages` 按需加载；agentId 从 Agent 工具的 result 文本里正则取。
- **AskUserQuestion / ExitPlanMode 都走 `canUseTool`**：回答 = `{behavior:'allow', updatedInput:{...input, answers}}`。
- **effort 没有运行时控制接口**：改 effort 走 `/effort <level>` 命令发进对话。
- `web/tsconfig.json` 不能用 `baseUrl`（TS 5.9 移除），`paths` 必须是相对路径。

## 从 Mirasim 借鉴的功能（2026-09-02）

- **额度环**：`server/src/usage/limits.ts` 读 `~/.claude/.credentials.json` 的 OAuth token 调 `api.anthropic.com/api/oauth/usage`（CLI 的 `/usage` 同源）。该接口 429 很积极：缓存 4 分钟，429 后退避 15 分钟，别加轮询。
- **工作区 / 置顶 / 归档 / 定时任务 / UI 设置** 存在 `~/.claude-web/meta.json`（`server/src/meta/store.ts`），Claude Code 本身不持久化这些。
- **分叉**：走 SDK `forkSession(id, {upToMessageId})` 先复制 transcript 拿到新 id 再 resume；不要用 `--fork-session`，那条路的新 id 要到第一轮才知道。
- **插话**：SDK user message 加 `priority: 'now'`。
- **worktree 会话**：`extraArgs: { worktree: name }`。
- 浏览器占用 Ctrl+N，新会话快捷键是 Alt+N；命令面板 Ctrl+K。

## 引擎（单运行时）与供应商档案

- **只有一个运行时**：`server/src/claude-exe.ts` 的 `resolveEngine()` 优先 ccb（npm 包 `claude-code-best` 的 `dist/cli-node.js`，根 package.json 内置，也认全局安装），找不到时静默退回 SDK 自带的官方 claude.exe。`engineInfo()` 给配置中心显示版本。`CLAUDE_WEB_RUNTIME=claude` 或档案的 `runtime:'claude'` 可强制官方二进制。ccb 是 JS，SDK 用 `node` 起它；Electron 里没有 `node`，`spawnClaude` 映射成 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`。
- ccb 是官方的超集：完整实现 stream-json + control 协议，只缺 `supported_commands` / `supported_models` / `commands_changed`（runner 从 `initializationResult()` 的 `commands`/`models` 兜底）；共用 `~/.claude`（登录、settings、会话 jsonl、subagents）。
- **供应商档案**（`Provider`，存 `~/.claude-web/meta.json`，不写 `~/.claude/settings.json`）：`server/src/providers/service.ts` 的 `providerEnv()` 按类型映射成 env（anthropic → `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（Bearer）+ `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL`；openai → `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `CLAUDE_CODE_USE_OPENAI=1`（base 补 `/v1`）；gemini → `CLAUDE_CODE_USE_GEMINI=1` + `GEMINI_API_KEY` + `GEMINI_BASE_URL`（补 `/v1beta`，ccb 请求 `<base>/models/<id>:streamGenerateContent`）+ 三个 `GEMINI_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`（缺的用 defaultModel / 第一个模型补齐：ccb 的 Gemini 客户端遇到没映射的 haiku/sonnet/opus 直接抛错）；grok → `CLAUDE_CODE_USE_GROK=1` + `GROK_API_KEY` + `GROK_BASE_URL`（OpenAI SDK，补 `/v1`）+ `GROK_DEFAULT_*_MODEL`（缺的走 ccb 自带的 grok 默认）。**不设 `GEMINI_MODEL` / `GROK_MODEL`**：ccb 对每个请求都返回它们，会让会话内换模型失效；不带 haiku/sonnet/opus 字样的模型 id 原样透传。ccb 选提供方看 `getAPIProvider()`：settings 的 `modelType` 优先，其次 `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY/OPENAI/GEMINI/GROK`，都没有就是 Anthropic——没开关的 gemini / grok 档案会静默走 Anthropic 默认通道（踩过）；用户 `~/.claude/settings.json` 里写了 `modelType` 会压过这些开关。官方二进制没有这些通道，所以这三种类型只在 ccb 上可用（`profileFitError`）。），`session-runner.ts` 只注入到那个会话的进程；本进程的 `ANTHROPIC_*` / `OPENAI_*` / `GEMINI_*` / `GROK_*` / `XAI_*` / `CLAUDE_CODE_USE_*` env 会被清掉以免混入。会话用的档案记在 `SessionMeta.providerId`，resume / fork 沿用。wire 上 `apiKey` 一律打码。
- **中转指纹（api.super-nb.me 实测）**：只放行官方 Claude Code 构建发的 `/messages`。三处判据都踩过：① User-Agent 里不能有 SDK 附加的 `agent-sdk/x.y.z`（来自 env `CLAUDE_AGENT_SDK_VERSION`，`spawnClaude` 见到 `CLAUDE_WEB_PLAIN_UA` 就删掉）；② `CLAUDE_CODE_ENTRYPOINT` 必须是 CLI 默认的 `cli`（`sdk-ts`/`claude-web` 都 400「请求可能被第三方中转改写」）；③ 必须带 Claude Code 的主系统提示（Agent SDK 默认是**空**系统提示，runner 显式传 `systemPrompt: {type:'preset', preset:'claude_code'}`）。ccb 本身的请求形状（UA 2.8.4、不同的系统提示和工具表）过不了这种指纹，所以 `ProviderService.probe()` 除了 `/v1/models` 还真跑一轮 `-p`：ccb 被拒就自动把档案 `runtime` 切到 `claude` 并提示。
- **中转还卡最低 CLI 版本**（2026-09-27 实测 super-nb 要求 ≥ 2.1.280）：官方二进制来自 `@anthropic-ai/claude-agent-sdk-<平台>`，版本跟 SDK 走（SDK 0.3.x ↔ Claude Code 2.1.x），被拒时报「客户端版本过低」就升级 SDK。
- 注意本机开发 shell 继承了 `CLAUDE_CODE_ENTRYPOINT=sdk-cli`（因为在 Claude Code 里跑），测指纹要用 `env -u` 或显式赋值，别被继承值骗了。
- 会话级开关 `SessionFeatures`（`--chrome`、`--computer-use-mcp`、`--proactive`、`--brief`、`--channels`、`CLAUDE_CODE_COORDINATOR_MODE`）在 `session-runner.ts` 的 `featureArgs()/featureEnv()`。
- Langfuse / Artifacts / Web Search 等配置仍是 `~/.claude/settings.json` 的 `env`；配置中心「供应商 / 环境」tab 下半段编辑。
- ccb 里 `local-jsx` 类型的命令（/goal 面板、/artifacts 列表、/poor、/voice、/buddy 等）是 TUI 专属，headless 发不了；对应能力靠工具（Goal / Artifact / Workflow）或终端面板兜底。

## 渲染与对话交互（阶段 1，2026-09-03）

- **reducer 是唯一真源**：`web/src/model/conversation.ts` 纯函数，`web/src/model/__fixtures__/tools.jsonl` 是用 `server/ws-capture.mjs` 录的真实流（Read 文本+图片 / Glob / Grep / Bash / WebFetch / TodoWrite），`conversation.test.ts` 回放它。改 reducer 先跑 `npm test -w web`。
- **发送时客户端铸 uuid**（`SendParams.uuid` → `SDKUserMessage.uuid`），本地回显 id 就是 transcript uuid，编辑重发 / 重跑 = `openSession({sessionId, resumeAt: findChainUuidBefore()})` 再发。ccb 不回显 `user_message_uuid`，但 uuid 会落到 jsonl，够用。
- **工具输出优先用 `tool_use_result`（`result.structured`）**：SDK 的 `sdk-tools.d.ts` 有每个工具的 Output 形状（`structuredPatch` 带行号、`FileReadOutput` 的图片 base64、`GrepOutput.mode`…）。ccb 的 GrepOutput 用 `numLines` 而不是 `numMatches`，卡片两个都认。
- 工具卡片在 `web/src/features/chat/tools/registry.tsx` 注册（图标 / 分类 / 头部文案 / Body）；`mcp__*` 和未知工具走 `GenericBody`（键值网格 + JsonTree + 图片）。Steps 折叠的分类计数也从注册表取。
- 健康信号（`model/health.ts`）：卡死判定是客户端计时（15s 无事件、3 分钟无模型调用）；错误分类 `classifyError()` 输入 `api_retry.error` / `result.terminal_reason` / HTTP 状态 / 文本；限流 `rate_limit_event` → `conv.rateLimit`，`settings.autoContinueOnReset` 打开时到 `resetsAt+5s` 自动重发上一条（store 里的 `armAutoContinue`）。
- **Agent SDK 默认空系统提示**，runner 传 `systemPrompt: {type:'preset', preset:'claude_code'}`（也是过中转指纹的必要条件）。
- 桌面模式 `PORT=0`，origin 每次变 → 草稿 / 评分 / 思考开关 / diff 模式都进 meta.json（`drafts.*`、`feedback.*`、`settings.set`），不要用 localStorage 存这些。
- 附件：`POST /api/attachments?sessionId=&rel=`（token 同 `/ws`）存到 `~/.claude-web/attachments/<sid>/`，消息文本后追加 `<attached kind name path size />` 标记，模型自己 Read；`decodeAttachments()` 在渲染时把标记解成芯片。超过 3000 字 / 60 行的粘贴自动变成 `kind="text"` 内联附件。
- 代码高亮用 lowlight（同步，流式重渲染友好），KaTeX / Mermaid 全部懒加载；`.hljs-*` 颜色映射到每个主题的 `--hl-*` 变量。
- `scripts/shot.cjs`：用 Electron 给页面截图（`npx electron scripts/shot.cjs <url> out.png "<js>"`），本机 Chrome 扩展连的是别的机器时靠它看 UI。
- `server/ws-phase1.mjs`：附件上传 / uuid 锚点 / contextUsage / 评分草稿 / 分叉 / 导出 的端到端检查。

## 工作台布局（阶段 2，2026-09-03）

- **三层模型**：分组（Group）→ 窗格（Pane，二叉分割树，最多 6 个）→ 标签（Tile：chat / doc / diff / term / panel）。纯函数在 `web/src/model/layout.ts`（`layoutReducer` + `layoutRects` + `presetTree` + `migrateLegacy`），`layout.test.ts` 覆盖不变量；组件在 `web/src/features/workbench/`。
- **`activeId` 是派生值**（焦点窗格的活动 chat tile），由 `dispatchLayout` 写回；`panels` 也是 `dock.tabs` 的投影。老代码继续读 `activeId` 没问题，但对话内组件要用 `useScopedSession()` / `useScopedSessionId()` / `usePaneCtx()` 取**自己所在窗格**的会话，别再 `useStore.getState().activeId`。
- **窗格永不卸载**：`PaneLayer` 把所有窗格绝对定位，分屏 / 拖动 / 缩放只改矩形（zoom 时其它窗格 `visibility:hidden`），所以 xterm 缓冲、滚动位置、草稿都保得住。`PaneLayer` 用 `useLayoutEffect` 先量尺寸再挂 tile，否则 0×0 时 Composer 自适应高度会读到假的 scrollHeight 并一直卡在 280px。
- 布局存 localStorage `cw.layout.v2:<winId>`（`?win=` 参数，桌面多窗口各一份），首次启动从 `cw.panels/cw.rp/cw.collapsed` 迁移；`ui.singleWindow` 等 UI 开关走 meta.json `settings.set`。
- 快捷键唯一来源 `workbench/shortcuts.ts`（桌面菜单加速器 `desktop/src/main.ts` 抄它的 desktop 列，浏览器用 `matchBrowserKey`），命令统一走 `workbench/commands.ts` 的 `runCommand(id)`。桌面里 Ctrl 系组合由菜单触发，浏览器绑 Alt 系避开 Chrome 占用。
- 拖放是原生 HTML5：侧栏会话行 `application/x-cw-session`、标签 `application/x-cw-tile`、停靠标签 `application/x-cw-panel`；`dnd.ts` 的 `zoneAt()` 用边缘 25% 判定分屏方向。
- 多窗口：Electron `wins: Map<winId, BrowserWindow>`，`window-state.json` v2 存每个窗口的 bounds；**分组迁移不走 IPC**，同源 `BroadcastChannel('cw.workbench')`（`workbench/windows.ts`）offer/ack，源窗口收到 ack 才删；通知点击广播 `desktop:focusSession`，持有该会话的窗口响应，都没有时 main 窗口 claim。
- `scripts/shot.cjs` 的 argv 里任何带冒号的 token（比如 `'cw.layout.v2:main'`）都会让 Electron 当成 URL 直接退出 127，JS 里别写冒号字面量。

## 文件 / Git / 编辑器（阶段 3，2026-09-03）

- 服务端三个新服务：`server/src/files/service.ts`（`fs.open/write/mkdir/create/rename/copy/trash/watch`，`write` 带 `expectMtime` 冲突检测；回收站在 Windows 走 PowerShell 的 `Microsoft.VisualBasic.FileIO`，macOS 走 Finder，Linux 走 `gio trash`）、`server/src/search/service.ts`（ripgrep `--json`；rg 优先用 ccb 自带的 `dist/vendor/ripgrep/<arch>-<platform>/rg`，没有再找 `@vscode/ripgrep` / PATH）、`server/src/git/service.ts`（porcelain v2 解析、`classifyGitError()` 把 stderr 归成 15 类并配修复提示，`GitCommandError` 在 hub 里编码成 `message\n\n[kind] hint`，客户端 `GitView` 解析回来给「一键修复」按钮）。
- `GET /api/file?path=&token=` 直出本地文件（图片 / PDF / 媒体预览用，支持 Range），CSP sandbox。
- 编辑器是 Monaco 0.56：`web/src/features/editor/monaco.ts` 懒加载，worker 用 exports 映射写法 `monaco-editor/editor/editor.worker.js?worker`（`esm/vs/...` 路径会被 exports 的 `./*` 规则映射错）。主题从 CSS 变量算出来，切主题时 MutationObserver 重定义。每个路径一个 model（多个 tile 共享），tile 关闭只 dispose editor。
- Doc tile：自动保存（`ui.autoSave`，默认开，停手 0.8s）、`fs.watch` 检测磁盘变更（干净时静默重载，脏时横幅二选一）、Ctrl+S、未保存关闭确认（store `dirtyDocs` + `closeTile`）。同一路径的 doc / diff tile 在同一窗格内去重（`tile.open` 里比较归一化路径）。
- 会话 tile 的工作台标签：改动（会话触碰的文件）/ Git（`GitView`：分支切换新建、拉推 fetch、暂存 / 取消 / 丢弃、提交 amend、历史（点开提交 diff）、worktree 列表新建删除、stash）/ 文件（`FileTree`：git 徽章、右键菜单、内联新建重命名、F2、回收站）/ 搜索（`SearchView`：大小写 / 全词 / 正则 / include / exclude，替换可逐行排除）。
- 后台 fetch：`git.watch` 过的仓库每 5 分钟 `fetch --prune`，`.git/HEAD|index|refs` 变化广播 `git.changed`。
- `server/ws-phase3.mjs`：文件操作 / 冲突检测 / 搜索替换 / 回收站 / git 只读 的端到端检查。

## 配置中心 / 自动化 / 打磨（阶段 4，2026-09-03）

- **设置窗**（Ctrl+,）`web/src/features/settings/SettingsModal.tsx`：分区 + 全文搜索（每条设置有 label / hint / keywords），`openSettings({section, query, reveal})` 可以直接跳到某一条并高亮。简单开关用 `ui.*` 键存 meta.json；复杂分区复用 `ConfigPanel` 里 export 出来的组件。停靠面板里的「配置中心」保留（侧栏「设置」右键）。
- **外观**：`ui.theme`（含 `system` 跟随系统）、`ui.fontSize`、`ui.density`、`ui.cjkFont`、`ui.reduceMotion` 由 `features/settings/ui-settings.ts` 的 `applyUiSettings()` 写到 `<html>` 的 data 属性 / CSS 变量；`setTheme` 同时写 `ui.theme`，localStorage 只当缓存。
- **原生对话框全部换成 `web/src/ui/dialog.tsx`**（`dlg.confirm / prompt / alert` 返回 Promise，`DialogHost` 挂在 App）。新代码别再用 `window.confirm/prompt`（Electron 下会抢焦点、样式也不对）。
- **密钥**：`server/src/secrets/service.ts`，Windows 走 DPAPI（PowerShell `ProtectedData`，CurrentUser），macOS 走 `security` 钥匙串，其它平台只做 base64 标记。meta.json 里的 `apiKey` 形如 `enc:dpapi:…`；`ProviderService.warm()` 启动时把全部密钥解密进内存，`forSession()` 仍是同步的。换机器 / 换用户后解不开会报错要求重输。
- **Skills**：`server/src/skills/service.ts` 支持 `owner/repo`、`owner/repo/子目录`、GitHub tree 链接、本地路径；仓库根没有 SKILL.md 时递归两层装所有带 SKILL.md 的文件夹。`remove` 只允许 skills 目录下的路径。备份用系统自带 `tar`。
- **MCP**：`McpCatalog.tsx` 内置约 27 个常用服务器配置（stdio / http / sse，标注需要的 env 与 OAuth），官方注册表搜索走 `registry.modelcontextprotocol.io/v0/servers`（`mcp.registry`），健康检查解析 `claude mcp list` 输出（`mcp.health`）。OAuth 授权仍需在会话里 `/mcp`（TUI 交互）。
- **定时任务**：`server/src/schedules/cron.ts` 自写 5 字段 cron（列表 / 范围 / 步长 / 名称 / @daily 等），`nextCron()` 本地时间；`Schedule.cron` 优先于 `everyMinutes`；每次运行记到 `meta.scheduleRuns`（上限 300，含 30 分钟内的结果摘要）；`freshSession` 每次新开会话；6 个模板在 `SCHEDULE_TEMPLATES`。改 cron / 间隔 / 启用状态时 hub 重新算 `nextRunAt`。
- **账本**：`server/src/usage/ledger.ts` 订阅 pool 的每条消息，每个 `result` 记一行到 `~/.claude-web/ledger.jsonl`（延迟 `duration_api_ms`、缓存读写、费用、失败原因），`api_retry` 也记；用量面板「账本」tab 有柱状图 / 表 / CSV 导出。
- **Mission Control**：停靠面板 `mission`（Ctrl+Shift+M）按「需要你 / 运行中 / 出错 / 空闲」分列所有活动会话，卡片上直接允许 / 拒绝权限、中断、跳转。
- **桌面壳**：`electron-updater`（GitHub Releases，`electron-builder.yml` 的 `publish`，开发模式直接报「不检查更新」）；退出守卫统计运行中会话 + 待处理权限 + 未保存文件，`ui.confirmExit` / `ui.closeToTray` 可关；`flags.json` 里的 `softwareRender` 在 `ready` 前 `disableHardwareAcceleration()`，GPU 进程连挂两次自动写标记重启；`ui.softwareRender` 设置通过 `desktop.setFlags` 同步。
- 诊断包：`diag.bundle` → `~/.claude-web/diagnostics/<ts>/`（info.json、server.log / main.log 尾部、脱敏 meta.json 与 settings.json）+ tar。
- `server/ws-phase4.mjs`：skills / tools / secrets 迁移 / cron / 账本 / 诊断 / 注册表 的端到端检查。首次运行引导只在没有任何工作区时出现。

## 多 agent（阶段 5，2026-09-03）

- **接口**：`server/src/agents/types.ts` 的 `AgentDriver`（send / interrupt / respondPermission / setModel / close / getHistory…），`SessionRunner`（Claude）、`CodexDriver`（`codex app-server`，JSON-RPC v2）、`AcpDriver`（Gemini / Qwen / Kimi / 任何 ACP agent）都实现它；`RunnerPool.open()` 按 `params.agent` 挑驱动。`AGENT_DEFS` 是内置表，用户在 `meta.settings.agents` 里覆盖命令 / 参数 / env / 模型 / 启用，自定义 ACP agent 的 kind 是 `acp:<id>`。
- **一切都归一成 SDK 消息**：`agents/normalize.ts` 的 `MessageSynth` 把外部 agent 的事件合成 `system/init`、`stream_event`（message_start → content_block_* → message_stop）、`assistant`（tool_use）、`user`（tool_result + `tool_use_result`）、`result`（usage / cost）和 `rate_limit_event`，前端 reducer / 工具卡片 / 健康信号 / 账本 / Mission Control 零改动。ACP 的 `plan` 变 TodoWrite 卡片；工具名用 `mapToolName()` 映射到最近的 Claude 工具以复用卡片。
- **协议要点**：ACP `initialize{protocolVersion:1}` → `session/new` → `session/prompt`（流式 `session/update` 通知），权限走 agent 发来的 `session/request_permission`（options 的 kind 是 allow_once / reject_once…），`session/load` 只有 `agentCapabilities.loadSession` 才能用；Codex 是 `initialize` + `initialized` 通知 → `thread/start|resume` → `turn/start`，审批是 `item/commandExecution/requestApproval` 等服务端请求，`turn/steer` 做插话，`thread/tokenUsage/updated` 算 usage。形状以 `codex app-server generate-ts` 生成的 TS 为准（不要猜）。权限模式映射：default → `untrusted`，acceptEdits/auto → `on-request`，bypass → `never` + `danger-full-access`。
- **Windows 下 `gemini` / `codex` 是 npm 的 `.cmd` 垫片**，直接 `spawn('gemini')` ENOENT。`agents/resolve.ts` 的 `resolveSpawn()` 在 PATH 上找到垫片、解析出里面的 JS 入口后用 node 直接起（进程可 kill、Electron 里用 `ELECTRON_RUN_AS_NODE`），其它 `.cmd` 退回 `cmd.exe /d /s /c`；`JsonRpcProcess.kill()` 在 Windows 用 `taskkill /t` 杀整棵树。
- Codex 的 `config.toml` 里的模型可能是这个账号用不了的（ChatGPT 套餐会 400），驱动启动后对照 `model/list`，不在列表就换成默认并发系统提示。Gemini 没登录时 `session/new` 报 API key 缺失：驱动会尝试非交互的 `authenticate`，不行就把 `login` 命令写进错误里；设置 → CLI Agents 的「登录 / 安装」按钮会开一个终端 tile 并把命令敲进去（`Tile.term.cmd`）。
- 外部 agent 的会话记录在 `~/.claude-web/agents/<sessionId>.jsonl`，首行是 `cw.meta`（agent / cwd / title / nativeSessionId / model）；`sessions.list` 把它们和 Claude 的 jsonl 合并（`SessionSummary.agent`），`session.open` 恢复时从头部推断 agent。`append()` 在头部不存在时不写（否则会出现没有 cwd 的「幽灵会话」把侧栏搞崩）。
- 调试真实 agent：`CW_RPC_DEBUG=1` 起 server 会把每条 JSON-RPC 收发打到 stderr；`node server/ws-agent-probe.mjs <agent> "<prompt>"` 单独驱动一个会话并打印所有事件；`node server/ws-phase5.mjs [port] [token] [--real]` 是端到端检查（mock ACP agent 在 `src/agents/__mocks__/`，`--real` 才碰真 gemini / codex，没登录的会 SKIP）。`agents.list` 的版本探测缓存 10 分钟、同一 agent 同时只探一次（`AgentRegistry.probe()`；opencode 的 `--version` 自带 4 个 PowerShell AVX 检测），`refresh:true` 强制重探。
- `scripts/shot.cjs` 现在把渲染进程的 console 错误写进 `<out>.log`；多个截图别并行跑（窗口互相遮挡时 `capturePage` 是黑图）。显示器休眠 / 锁屏时 `capturePage` 抛 `UnknownVizError`，用 `SHOT_OFFSCREEN=1` 走离屏渲染。
  - **传进去的 JS 必须是一行**：Windows 的命令行带不了换行，多行脚本只有第一行会到达 Electron（而且不报错）。
  - 完整 URL 走 `SHOT_URL` 环境变量，argv 第一位随便填个 `127.0.0.1:3090` 占位；out 路径是第二位，别搞错顺序。
  - 驱动页面用 `window.__store`（`main.tsx` 里挂的调试入口）：`__store.getState().loadHistory(sid)` / `openInPane(sid,'replace')` / `setTheme('nord')` / `dispatchLayout(...)` / `openSettings({section})` 比找按钮点可靠得多。
  - `server/ws-demo-session.mjs` 造一个带工具调用的 mock 会话，`server/ws-demo-running.mjs` 把一个会话停在**回合进行中**（用来截运行态）。都用 mock ACP agent，不花模型 token；截完记得删会话和 `acp:demo` / `acp:slow` 这两个临时 agent。
- 打包后的桌面版有单实例锁，想在**不打扰用户已经开着的那个**的情况下冷启动验证：`electron-builder --config.directories.output=dist-desktop-p12` 换个输出目录，然后 `"…/Claude Web.exe" --user-data-dir=<临时目录>` 起第二个实例，端口在那个目录的 `server.log` 里。

## 远程 / 手机 / IM（阶段 6，2026-09-03）

- **第二个监听器**：`server/src/remote/service.ts` 的 `RemoteService` 在 `remote.enabled` 时用同一个 HTTP handler + upgrade 在 `0.0.0.0:<remote.port>`（默认 3091）再起一个 `http.Server`；socket 打上 `cwRemote` 标记，`authOk()` 对远程连接**必须**有令牌（主令牌或设备令牌），本地回环没配主令牌才放行。停止时要 `closeAllConnections()`，否则 `server.close()` 会等 keep-alive / ws 连接永远不返回。
- **配对**：`remote.pairCode` 出 6 位码（10 分钟、5 次尝试、单次有效），QR 里是 `http://<局域网 IP>:<port>/pair#<code>`；`/pair` 页面 `POST /api/pair {code,name}` 换到 32 字节设备令牌（meta.json 只存 sha256），页面写 `localStorage.cw.token` 并跳 `/`。前端 `authToken()`（`web/src/ws/client.ts`）优先 URL `?token=`（桌面壳）再 localStorage；`/api/file`、附件上传都走它，服务端也认 `cw_token` cookie。设备表可改名 / 吊销（令牌缓存同步清）。
- 局域网 IP 排序：`refreshPrimary()` 用 UDP `connect(8.8.8.8:53)` 拿默认路由的源地址放到最前（Windows 上 VMware / WSL 的虚拟网卡名字不可靠，光靠名字过滤会把 `192.168.208.1` 排第一）。
- **SSH 隧道**：`server/src/remote/tunnel.ts` 用系统 `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remotePort> target`（`BatchMode=yes` 免密），轮询本地端口可连才算 `up`（最多 20s），失败把 stderr 最后一行给 UI；`startCommand` 会先 `ssh target "<cmd>"` 跑一次（15s 超时）。主机存 `meta.remoteHosts`，UI 在设置 → 远程 / 手机；连上后新窗口打开 `http://127.0.0.1:<local>/?token=`。
- **手机布局**：`App` 用 `matchMedia('(max-width: 760px)')` 切 `.app.mobile`：侧栏变抽屉（`drawer-open` + 背板，点会话自动收起），停靠面板隐藏，顶栏只留 ☰ / 标题 / 命令面板。PWA：`/manifest.webmanifest` 由服务端直出，`web/public/sw.js` 只做 network-first（安装用，不做离线），只在非 localhost、非桌面壳注册；图标 `web/public/icon-*.png` 用 `scripts/icons.cjs`（Electron 离屏渲染 svg）生成。
- **IM 网关**：`server/src/im/` — `ImAdapter` 接口（start / stop / send(chatId, text, {buttons}) + 'message' 事件），Telegram（Bot API 长轮询，inline keyboard → callback_query）、Discord（Gateway ws，intents 含 MESSAGE_CONTENT，按钮是 components，交互用 type 6 回执）、Slack（Socket Mode：`apps.connections.open` 拿 ws，events_api / interactive 信封要 ack；频道里只响应 @提及）、钉钉（Stream 模式 `gateway/connections/open` → ws，`ping` 要回，回复走消息里的 `sessionWebhook`，过期后用 robot API）、飞书（`@larksuiteoapi/node-sdk` 的 `WSClient` 长连接 + `EventDispatcher`，按钮是 interactive card → `card.action.trigger`）、企业微信（群机器人 webhook，只能推送）。微信没有开放接口，不做。
- `ImRouter`：每个 (网关, 聊天) 绑定一个会话（`meta.imBindings`）；未授权用户只回一次提示（1 小时），`/pair <配对码>` 加入 `allowUsers`；命令 `/new /sessions /use /status /stop /allow /deny /mode /model /verbose /help`，其它 `/xxx` 原样转给会话；`result` → 回最后一段 assistant 文本 + 用时 / 费用；权限请求 → 带 允许 / 拒绝 按钮（`perm:<requestId>:allow`），AskUserQuestion → 选项按钮（`ask:<id>:<i>`），ExitPlanMode → 开始执行 / 继续讨论。密钥字段用 `SecretService.protect` 存成 `enc:`，wire 上打码 `••••••`，回传打码值不覆盖。
- `server/src/im/router.test.ts` 用假 adapter / pool 覆盖路由逻辑；`server/ws-phase6.mjs` 端到端跑远程监听 + 配对 + 设备令牌 + 隧道失败路径 + IM 配置。
- vitest 只认 `src/**/*.test.ts`；server 的 `tsconfig` 现在排除测试与 `__mocks__`，不然 `npm run build` 会把测试编译进 `dist/` 然后 vitest 连 dist 里的副本一起跑（mock 路径不存在 → 超时）。

## 看板 / 目标 / Android（阶段 7，2026-09-03）

- **Issue / PR 看板**：`server/src/vcs/service.ts`，仓库从 `origin` 解析（https / ssh / git@，GitLab 嵌套 group），也可以显式传 `repo: owner/repo[@host]` 或 URL（看板右上角可切换，存 localStorage `cw.board.repo:<cwd>`）。鉴权只用 CLI 拿 token（`gh auth token -h <host>` / `glab config get token`，或 env GH_TOKEN / GITLAB_TOKEN），之后全部走 fetch：GitHub PR 列表用 GraphQL 一次拿齐 reviewDecision / checks / 增删行，其余 REST；GitLab 走 v4。PR 检出：`git fetch origin +pull/N/head:refs/remotes/origin/pr-N` 再 checkout 或 `worktreeAdd`，然后开会话把「审查」提示发过去。会话 tile 的「看板」标签（`WorkbenchTab 'board'`）。
- **目标（Goal 房间）**：ccb 的 `/goal` 是 TUI 内存态（Stop hook + 150 轮上限，不落盘），headless 用不了，所以 `server/src/goals/service.ts` 自己实现：目标 = 一句话 objective + 活规格（Markdown，随时改，下一轮提示生效）+ 绑定会话；启动时把 `GOAL_PROTOCOL`（要求最后一行 `GOAL_STATUS: complete|blocked — 原因|continue`）+ 目标 + 规格发给会话，每个 `result` 后解析状态：continue → 1.5s 后自动发「继续」；complete / blocked / 会话出错 / 连续 3 轮无工具且回复相同（卡住）/ 轮数或 token 预算用尽 → 停。证据从流里收：Edit/Write 文件、Bash 命令（含 `git commit` → commit、测试命令 → test，并回填 tool_result 成败）、TodoWrite → 执行图步骤。存 `meta.goals`，事件 `goals.changed`。UI：停靠面板「目标」（执行图 / 活规格 / 证据三个 tab），输入框里 `/goal <目标>` 直接创建并启动。任何 agent 驱动都能跑目标。
- **Android 预览**（可选）：`server/src/android/service.ts` 找 adb（ANDROID_HOME / SDK 默认路径 / PATH），`exec-out screencap -p` 截图（PNG 头里读宽高），`input tap/swipe/keyevent/text`，安装 APK、列第三方包并 `monkey` 启动、`logcat -d -t`，`emulator -avd` 分离启动。面板「Android」每 0.9s 轮询截图，点击 = tap，拖动 = swipe。本机没 adb，只验证了「未安装」路径。
- `server/ws-phase7.mjs`：看板对 `anthropics/claude-code` 只读（需要 `gh auth login`）、目标用 mock ACP agent 跑完整回合（mock 回显提示词，里面就带 `GOAL_STATUS: complete`，所以一轮即完成）、android 状态。`web/src/store` 里的 `PanelId` 现在是 `model/layout` 的别名，加面板只改 layout.ts + Dock 的三张表 + TopBar/命令面板/TabStrip 的列表。

## 设计令牌 / 图标 / 停靠面板（阶段 8，2026-09-04）

- **令牌是分层的**：主题只定义十来个原色，语义层全部用 `color-mix(in oklab, var(--fg) N%, transparent)` 从里面派生 —— 表面 `--surface-0..3/-elev`、描边 `--edge-subtle/default/strong`、叠加 `--layer-hover/selected/active`、文字 `--ink-1..5`、圆角 `--r-sm..2xl/pill`、阴影 `--elev-1..3`、时长 `--dur-1..4`、缓动 `--ease-out/in-out`、字号 `--fs-micro..xl`、状态 `--ok/warn/err/info/ctl-on`。**加一个主题只要写那十几个原色**，别再往规则里写死颜色或圆角。旧名 `--bg/--fg/--line` 还在但只作兼容，新代码别用。
- 焦点环统一：全局 `:focus{outline:none}` + `:focus-visible{outline:2px solid var(--focus-ring)}`，删掉了散落的 15 处 `outline:none`。`.icon-btn` 有固定 28×28 盒子（`.xs` 22px），命中区不再等于字形宽度。
- `.sub` 是**独立的类**，不再只在 `.row` 里生效；`.row .sub` 只额外加单行省略。设置页那种成段的说明文字靠它。
- **图标全部手写**：`web/src/ui/icons.tsx` 一个 `PATHS` 表，24×24 网格、stroke 1.75、`currentColor`，`<Icon name size />`。没有图标库依赖。原来约 175 处内联 Unicode/emoji 已经换掉；`server` 的 `AGENT_DEFS.icon` 存的是图标名不是字形。
- **面板表只有一份**：`web/src/model/layout.ts` 的 `PANELS`（id/title/icon/rail）导出 `PANEL_IDS/PANEL_TITLES/PANEL_ICONS`，Dock / TopBar / 命令面板 / TabStrip 全从这里取。加面板 = 往 `PANELS` 加一行 + `PanelBody` 加一个 case。
- **停靠面板只有一条渲染分支**：最小化靠 CSS（`.dock.min` 收成图标轨）+ `[hidden]`，**绝不卸载面板**，否则终端 pty、xterm 缓冲、表单状态全丢。注意 `.dock-panel{display:flex}` 会盖掉 UA 的 `[hidden]`，所以显式写了 `.dock-panel[hidden]{display:none}`。
- `deriveActive()` 会**越过**前面的浏览器 / 文档 / 终端标签往后找会话：停靠面板（文件 / Git / 记忆 / 任务）读的是 `activeId`，不这样做的话把浏览器标签切到前面，右边整排面板就空了。

## 对话渲染与 composer（阶段 9，2026-09-04）

- **一轮 = 一条竖向时间线**（`ChatView` 的 `Steps`）。三态必须互不相同：完成 = 空心勾、进行中 = 呼吸方块 + 计时、待执行 = 灰色空心圆（`stepState()`）。折叠态就是这条线，点节点展开该步的卡片（`ToolCard` 的 `bare` 模式只渲染 body，头和导轨由时间线画）。
- 工具折叠态是**单行**：图标 + 动词 + 目标（路径取 basename，全路径在 title 里）+ 右侧耗时。运行中的秒数：agent 持续发 `tool_progress` 就用它（Claude），不发就用 `startedAt` 的墙上时间自己数（ACP / Codex），否则会一直停在 `0s`。
- **composer 上方钉两行**：`RunCard`（正在做什么 · 已跑多久 · 第几步 · 停止）和 `ContextRow`（工作目录 · 分支 ↑↓•改动 · worktree · 非 Claude 的 agent 名）。`StatusStrip` 只留 RunCard 说不出来的东西：卡住、失败、限流、排队 —— 别把「运行中」重复两遍。
- `conv.turnStartedAt` 在用户消息落地时打点、`result` 时清空，RunCard 从它开始计时。
- **`applyTranscript(c, msgs, {live})`**：点开一个**正在跑**的会话时不能把最后那个工具扫成 `done`，否则一条还在执行的命令会顶着绿勾，`runningTool` 也被清掉（表现为「思考中」但其实在编译）。`live` 由 `SessionSummary.live` 判断，同时用 transcript 里用户消息的时间戳回填 `turnStartedAt`。
- **模型 / effort 的唯一真相是 `server/src/models/catalog.ts`**：版本化显示名（`Fable 5.1` 不是 `Fable`）、每个模型自己的 effort 档位、别名、`supportsUltracode`、未核实的标 `unverified`。运行时优先用 agent 自报的列表（`info.models` / `model/list`），catalog 只补显示名和档位。`SessionInfoSnapshot.models[].supportsEffort / supportedEffortLevels` 现在真的被前端读了：Gemini 不出 effort chip。
- **ultracode 不是 effort 等级**：Claude 侧它是「xhigh + 动态工作流编排」的会话级布尔（`CLAUDE_CODE_EFFORT_LEVEL` 不接受这个值），做成 effort chip 旁边独立的 pill（`session.setUltracode`）；Codex 侧的 `ultra` 才是 effort 枚举里真实存在的一档，effort 传给 Claude 前要把 `ultra` 降成 `max`。

## 内嵌浏览器（阶段 10，2026-09-04）

- `Tile` 加了 `{kind:'browser'; url}`。桌面端 `webviewTag: true` 渲染 `<webview>`（`will-attach-webview` 里把我们的 preload 摘掉、`did-attach-webview` 里拒绝弹窗）；浏览器端降级成受限 iframe，**被 `X-Frame-Options` 拒绝的站点就是一片空白，这是浏览器行为不是 bug**，底部一直提示「用右上角在系统浏览器打开」。
- 地址栏的 `normalise()` 认 `localhost:3000`、`:3000`、裸域名，都不像就当搜索词丢给 Google。

## 会话内核：canonical / 热切换 / 交接（阶段 11，2026-09-04）

- **`server/src/session/canonical.ts`**：所有 agent（含 Claude）的规范时间线，写 `~/.claude-web/canonical/<sid>.jsonl`。只留能跨 provider 的东西：用户消息、助手正文、工具调用（归一名 + 输入 + 结果摘要）、系统提示、用量。**thinking 一律丢弃** —— Claude 的 thinking 带 `signature`、Codex 的 reasoning 带 `encrypted_content`，跨 provider 必然失效（OpenAI 自己的 `/import` 也是降级成纯文本）。
- **用户消息谁都不回显**：SDK 和外部驱动都不会把用户那条发回来，所以在 hub 的 `session.send` 里直接记进 canonical，别指望从消息流里捞。
- **供应商热切换 = 用户看不见的重启**：CLI 进程的 env 在 spawn 后不可变，`session.setProvider` 是停子进程 → 用新 env 重开 → 从最后一个 uuid 原生 resume。会话 id、标题、历史、面板全不变，只插一条系统行。
- **交接到 Claude 走 Agent SDK 的 `SessionStore.load()`**（受支持的 API，返回的 entries 会被物化成临时 JSONL 让子进程 resume），不要去伪造 `~/.claude/projects` 的文件。`handoff.ts` 的 `renderBriefing()` 是给所有 agent 的通用地板（已决定什么 / 磁盘现状 / 试过失败的方案 / 当前目标，并明说推理过程没带过来），`toClaudeEntries()` 额外保证 parentUuid 链不断。
- 明确不做：不写 Codex 的 rollout 文件与 `state_5.sqlite`（无官方 API，升级即碎）；不尝试携带任何 reasoning。

## 跨 agent 共享记忆（阶段 12，2026-09-04）

- **`node:sqlite` 里已经编译了 FTS5**，不用加依赖（实测过）。库在 `~/.claude-web/memory.db`，scope = global / project(cwd) / session，kind = decision / constraint / fact / deadend / preference / note。
- **FTS5 不分词中文**，整句会变成一个 token，`"最小化"*` 永远匹配不上句子中间。`hasCjk()` 把中文查询走 LIKE 回退（`service.test.ts` 有回归用例）。项目检索永远把 global 一起带上；project key 做过大小写与分隔符归一。
- **注入方式三条，一条都不改用户自己的配置文件**（`memory/launcher.ts` 一处收口）：Claude 走 Agent SDK 的 `mcpServers`；ACP agent 走 `session/new` 的 `mcpServers`（agent 拒绝就退回不带它重开一次并提示）；Codex 走 `-c mcp_servers.memory.*` 覆盖，**`-c` 是全局 flag 必须排在 `app-server` 子命令前面**，而且只对真的含 `app-server` 的 argv 动手（自定义命令 / 测试替身原样放行）。值按 TOML 解析，所以 Windows 路径要 JSON 引号，不能裸写。总开关是设置里的 `memory.mcp`（设置 → 共享记忆），下次开会话生效。
- 打包后 MCP 入口在 asar 里：`ELECTRON_RUN_AS_NODE=1` 起 Electron 二进制读 `app.asar/server/dist/memory/mcp.js` 是可以的（实测握手通过）。
- 自动萃取只收「死路 / 决定 / 约束」，每个会话最多 12 条；相同文本在同一 scope 里视为同一条（只加命中数）。
- `server/ws-phase12.mjs` 用**真的 JSON-RPC over stdio** 驱动 MCP server（agent 怎么调它就怎么调），断言 UI 写的 agent 能读到、agent 写的 UI 能读到。

## 统一会话库（2026-09-27）

- **一个入口**：`server/src/library/service.ts` 的 `LibraryService` 把 Claude + 各 agent 自己的会话记录合成一个列表 / 读取 / 搜索面；`sessions.list`、`sessions.search`、`transcript.load`、`session.open` 都走它。来源实现 `SessionSource`（`library/types.ts`），每个来源一个文件：

  | 来源 | 列表 / 读取 | rename | archive | delete | fork | 续聊 |
  | --- | --- | --- | --- | --- | --- | --- |
  | Claude（`claude-source.ts`） | SDK `listSessions` / transcript | ✓（SDK） | ✓（只记在 meta.json，Claude Code 没有归档标记） | ✓ | ✓（SDK `forkSession`） | ✓ |
  | Codex（`codex-source.ts`） | `codex app-server` 的 `thread/list`、`thread/turns/list` | `thread/name/set` | `thread/archive`/`unarchive` | `thread/delete` | `thread/fork` | `thread/resume` |
  | OpenCode（`opencode-source.ts`） | `opencode serve` 的 `GET /project` + `GET /session` + `/session/:id/message` | — | — | CLI `opencode session delete` | — | ACP `session/load` |
  | ACP agent（`acp-source.ts`） | 只有声明 `sessionCapabilities.list` 的才能列（`session/list`），无 read | — | — | — | — | 看 `loadSession` |

  能力只来自**官方接口**；没有就是只读，不改 agent 的数据文件。库专用后台进程（app-server / `opencode serve`）每来源一个、`LazyRpc` 闲置 5 分钟退出，不和会话进程共用。
- **id 规则**：Claude 保持原 UUID；其它 `<agent>-<原生 id>`（`codex-…`、`opencode-…`、`gemini-|qwen-|kimi-…`），自定义 ACP agent `acp:<name>` → `acp_<name 里的 - 转成 ~>-<原生 id>`。不含冒号。前缀表和 `parseLibraryId` 在 `protocol.ts`（web 共用）。续聊时 `prepareResume()` 给它建一个 `imported:true` 的头指向原生 id，驱动走原生 resume，新轮次写回 agent 自己的记录。
- **加入是可选的**：除 Claude 外默认不加入；检测只看 `AgentRegistry` 版本探测 + 数据目录（`~/.codex/sessions`、`~/.local/share/opencode`、`%LOCALAPPDATA%\opencode`），**不启动任何进程**。`library.discovered {kinds}` 在连接时和 `agents.list {refresh:true}` 后推送，侧栏出「加入 / 以后再说」。状态存 meta `settings['library.joined' | 'library.dismissed']`。移出 = 关掉该来源进程 + 从列表和索引里去掉（agent 数据不动）。
- **删除先备份**：完整历史导出到 `<dataDir>/library-trash/<id>.json`（`dataDir()` 跟随 `CLAUDE_WEB_DIR`），写成功才调来源的 delete，导出失败就不删；启动时清理 30 天前的备份。界面二次确认，批量默认归档。
- **索引**：`<dataDir>/library.db`（FTS5），每会话正文摘录上限 20 000 字，中文走 LIKE（同 memory 的 `hasCjk`）；首轮索引完成前搜索退回旧的 transcript 扫描。`agent:codex`、`in:<目录片段>` 是查询前缀。
- **踩过的坑**：
  - **来源遇到暂时性失败必须 throw**（不能返回空），否则 service 会以为「没有会话」、把索引和缓存清掉；只有「没装」/「版本不支持」才返回空。service 保留上次缓存并在 `SourceStatus.error` 里带出错误。
  - **Codex `Thread.source` 不只是字符串**：`"cli"|"vscode"|"exec"|"appServer"|{custom}|{subAgent:…}`，`subAgent` 里又是 `"review"|"compact"|{thread_spawn:{parent_thread_id,…}}|…`。响应是 `{data, nextCursor, backwardsCursor}`（不是 `threads` / `turns`），以 `codex app-server generate-ts` 为准。
  - **Codex `thread/list` 默认只返回当前 provider 的线程**：真机上 690 个里只列出 399 个；要传 `modelProviders: []`。而且带 `[]` 时子代理线程的 `parentThreadId` 是 null，父线程只在 `source.subAgent.thread_spawn.parent_thread_id` 里（`parentOf()` 兜底，否则 277 个子线程平铺在顶层）。
  - **OpenCode 的 `/doc` 只写了 2 个路径**（`/auth`、`/log`），能力没法从 OpenAPI 探测，改为解析 `opencode session --help`（Windows 冷启动约 10 秒，超时 60 秒、失败下次重试）。**`GET /session` 只返回 serve 自己 cwd 所在项目的会话**（从 claude-web 仓库起是 0 条），要先 `GET /project` 再逐个带 `x-opencode-directory`（URI 编码）头去取。
  - **Windows 上 Python 文本模式写文件会把 LF 变成 CRLF**：仓库有 `.gitattributes`（`eol=lf`），改文件用 Edit/Write 或二进制写；提交前 `git diff -w --ignore-cr-at-eol --stat` 应该和 `git diff --stat` 一样。
- `server/ws-phase13.mjs`：mock Codex（`agents/__mocks__/codex-server.mjs`，`CW_MOCK_RPC_LOG` 记录收到的请求）+ `MOCK_ACP_LIST=1` 的 mock ACP，端到端验证加入前不列、加入后列出并折叠子线程、分页读、搜索、改名、删除备份、`codex-` 会话续聊走 `thread/resume`、`library.sources` 状态。
- 真机验证（2026-09-27，只读 + 一个自建的测试线程）：Codex 717 条（`~/.codex/sessions` 721 个 jsonl + archived 42，部分没有线程记录）、OpenCode 11 条、Claude 119 条；首轮全量索引约 150 秒（约 850 个会话），之后中文搜索 ~150 ms。测真机时用临时 `CLAUDE_WEB_DIR` 起一个独立 server，别碰用户自己的 `~/.claude-web`。

## 模型网关（2026-09-28）

- **位置**：`server/src/gateway/`，挂在主 HTTP handler 最前面（`gateway.handle(req,res,url)` 只认 `/gateway/…`）。`socket.cwRemote` 或非回环地址一律 404（远程监听器共用同一个 handler）。鉴权 `x-api-key` / `Bearer` / `x-goog-api-key` / `?key=` 任一，`timingSafeEqual` 比对；密钥 `cwg-…` 存 meta `gateway.key`（`enc:`），wire 上只有 `keyMasked`，`gateway.revealKey` 按需取明文给「复制」。组存 `meta.gatewayGroups`，成员运行态（冷却 / 停用 / 最近错误）只在内存（`failover.ts` 的 `MemberStates`），事件 `gateway.changed`（只在状态真的变了时发，不是每个请求）。
- **分层**：`ir.ts`（中间表示 + 流事件 `start/text/tool/args/usage/end/error`，块按顺序）→ 每协议一个文件（`anthropic.ts` / `openai-chat.ts` / `openai-responses.ts`（只有入口）/ `gemini.ts`：parseRequest / renderRequest / parseResponse / renderResponse / StreamParser / StreamRenderer / renderError）→ `convert.ts` 路由表（`isPassthrough` / `TRANSLATIONS` 六个方向，其余 400）。thinking / reasoning 一律丢。
- **透传是命根子**（Claude Code → 网关 → 用户的中转，中转查 UA / 系统提示 / entrypoint）：上游用 `node:http(s)` 而**不是 fetch**（undici 会自己加 `accept-encoding` / `sec-fetch-mode` / `accept-language` 并自动解压）。请求头按 `rawHeaders` 的原顺序原大小写转发，只去掉 hop-by-hop（含 `Connection` 里列出的字段）、cookie、`x-cw-*`；成员密钥**原位**替换第一个凭据头的值（客户端用 `x-api-key` 就发 `x-api-key`，用 Bearer 就发 Bearer），多余的凭据头删掉。`accept-encoding` 里的 `zstd` 只在本机 zlib 能解（`createZstdDecompress`）时保留，否则嗅 usage 会读到乱码。改模型只替换**顶层** `model` 字段的字节（`replaceTopLevelString`，小 JSON 扫描器），模型不变时请求体原样。响应状态 / 头 / 字节原样回，usage 从解压副本里嗅（`UsageSniffer`）。网关档案给 Claude 的 env 与 anthropic 档案相同（`CLAUDE_WEB_PLAIN_UA` + `CLAUDE_CODE_ENTRYPOINT=cli`），否则经网关透传到中转也会被指纹拒。
- **故障转移**：拿到 2xx 响应头后还要等第一块 body 才向客户端写头（**流式**首字节 60s，`FIRST_BYTE_MS`；非流式要等整段生成完，给 10 分钟 `NONSTREAM_MS`），所以「200 后卡住」也能切换；写了头就不再切换，上游半路断开 → 透传直接断，转换流补一个协议内的 error 事件。429 / 402 / 额度文本（`QUOTA_RE`，含中文「额度 / 余额」）→ 按 `retry-after` / `anthropic-ratelimit-*-reset`（取 remaining=0 的那个）/ `x-ratelimit-reset-*`（`6m0s` 这种时长）冷却，没有就 60s×2^n 上限 30 分钟；5xx / 529 / 网络 / 超时 → 冷却 15s；401/403 → 停用到用户点「恢复」或改组；其它 4xx 原样回、不切换。全员冷却 → 429/503 带 `retry-after`；原样回的上游错误保留 `retry-after` / `request-id` / `*-ratelimit-*` 头。**并发**：每次尝试记 `sentAt`，成员在它发出之后已被别的请求打入冷却，就只更新错误文本、不加退避次数，冷却也只按上游响应头给的时长延长（不拿自己的退避猜测再抬一档）（否则 N 个并发 429 一次把退避推到 30 分钟上限）；成功也只在 `sentAt` 晚于最近一次失败时才清冷却。`count_tokens` 的成败不改成员状态，失败时回估算。**客户端断开**：`waitDrain` 在 signal 已经 abort / socket 已毁时立即返回（abort 事件不会再触发，旧实现会永远挂住），账本记 499 `ok:false`，成员不冷却。成功响应带 `x-cw-gateway-member`（URI 编码的档案名）和 `x-cw-gateway-switches`。
- **会话接入**：`ProviderType` 加 `gateway`（`Provider.gatewayGroupId`）；`ProviderService.forSession()` 通过 `gatewayEndpoint` 钩子把 baseUrl / apiKey 填成 `http://127.0.0.1:<port>/gateway/<组>` + 网关密钥（端口在 listen 后写进 `gateway.port`，桌面版每次都变，所以只在开会话时算）。`providerEnv(p, agent)`：Claude 同 anthropic；Codex → `OPENAI_*` + `CW_GATEWAY_KEY`；ACP agent → `GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY` + OpenAI 那两个。**账号登录会盖过 env**，所以 `providers.agentLaunch()`（`RunnerPool.open` 用）另外：Codex 在 `app-server` 前插 `-c model_providers.cwgw.{name,base_url,env_key="CW_GATEWAY_KEY",wire_api="responses"}` + `-c model_provider="cwgw"`，档案有默认模型时再加 `-c model="…"`（`gateway/agents.ts`，不碰 `~/.codex/config.toml`），且 `codex-driver` 的「模型不在 model/list 就换默认」对网关会话不生效（网关背后的模型不在 ChatGPT 列表里）；Gemini CLI 的缓存 Google 登录（用户 settings 的 `security.auth.selectedType`）优先于 `GEMINI_API_KEY`，而 ACP `authenticate` 会改用户 settings 还清掉缓存凭据，所以改用 `GEMINI_CLI_SYSTEM_SETTINGS_PATH` 指向一份「系统设置副本 + `selectedType: gemini-api-key`」（系统设置覆盖用户设置），写在 `<dataDir>/gateway/`（原子写：临时文件 + rename，Windows EPERM/EBUSY 重试），**只对 gemini 这个 kind**；Qwen Code 等只注入 env，OAuth 登录下可能不走网关。网关 401 且来的不是 `cwg-` 密钥时错误里提示「agent 没有用网关密钥」。组里有 `runtime:'claude'` 的 Anthropic 成员时，网关档案默认也用官方二进制（`endpoint().runtime`，档案显式设置优先）；「测试」按钮的请求不带 Claude Code 指纹，结果里有说明。
- **协议坑**：OpenAI 的 `prompt_tokens` 含缓存，IR（同 Anthropic）分开记；o 系列 / gpt-5 只收 `max_completion_tokens`；Chat 流要 `stream_options.include_usage` 才有 usage；Chat 的 `tool` 消息只收文本（`string | text part[]`），tool_result 里的图片放到紧随的 `user` 消息（`[tool result image for <id>]` + image_url）；Claude 新模型不收 temperature + top_p 同时出现，转 Anthropic 时只留 temperature；Codex 的 `custom` 工具（apply_patch 自由格式）转成只有 `input` 字符串参数的函数，回程再变回 `custom_tool_call`；Gemini 的 `parameters` 只收 OpenAPI 子集（`sanitizeSchema` 去 `$schema/additionalProperties/const…`，`["string","null"]` → `nullable`），genai SDK 发的 `OBJECT/STRING` 要转小写；Gemini 3 对历史里没有 `thoughtSignature` 的 functionCall 报 400，转换时补 `skip_thought_signature_validator`（此值未在官方文档核实）；Gemini 的调用 id 可选，按名字 + 顺序配对 functionResponse。
- **账本**：`LedgerEntry.kind:'gateway'` + `gateway{group,inbound,member,outbound,upstreamStatus,switches,firstByteMs,stream}`，`sessionId` 取 Claude Code 的 `x-claude-code-session-id` 头。经网关的 Claude 会话会同时有 `result` 行和网关行，账本「来源」过滤分开看。
- **已知限制**：不走系统代理（node:http 不认 `HTTPS_PROXY`）；只开放 spec 的 6 个转换方向（Gemini 入 → OpenAI、Responses → Gemini 返回 400）；Codex 的 `-c model_providers` 与 Gemini 的系统设置覆盖只按官方文档 / 安装包源码核对过，没用真 agent 跑。
- 测试：`gateway/convert.test.ts`（六个方向的请求 / 非流式 / 流式序列）、`failover.test.ts`（冷却 / 轮询 / 映射 / 透传保字节保头）、`review.test.ts` + `service.test.ts`（假上游：客户端中途断开、并发 429、非流式长生成、529→下一个、429+retry-after、401 停用、400 不切、首字节超时、流开始后不切、全员冷却、cwRemote 404）；`server/ws-phase16.mjs` 起一个 Anthropic 形状（首个请求 529）+ 一个 OpenAI 形状的假上游跑全链路。调试：`curl -H "x-api-key: <网关密钥>" http://127.0.0.1:<port>/gateway/<组>/v1/models` 看组能否鉴权 / 列出模型；响应头 `x-cw-gateway-member` 看走了谁。

## 其它 agent 的配置中心（2026-09-28）

- **位置**：`server/src/agent-config/`，每个 agent 一个 adapter（`codex.ts`、`gemini.ts`（Gemini / Qwen 共用，`Flavor` 区分）、`opencode.ts`），`service.ts` 汇总 + 打码，`handlers.ts` 处理 `agentConfig.*`（hub 里只有一行 `isAgentConfigRequest` 分发）。UI 是设置 → CLI Agents 卡片上的「配置中心」（`web/src/features/settings/AgentConfigPanel.tsx`，表单纯函数在 `agent-config-form.ts`）。
- **能用 CLI 就用 CLI**（形状以本机 `--help` 实测为准，见 `docs/superpowers/plans/2026-09-28-agent-config.md`）：Codex `codex mcp list --json | add <n> [--env K=V] -- <cmd…> | add <n> --url | remove`；Gemini / Qwen `mcp add -s user -t <t> [-e] [-H] <n> <cmdOrUrl> [args…]` / `mcp remove -s user`。OpenCode 的 `mcp add` 是交互向导且没有 remove，所以改 `opencode.json(c)` 的 `mcp` 键。CLI 用 agent 配置里的命令 + env，经 `resolveSpawn` 跑（`.cmd` 垫片同样解包）。
- **踩过的坑**：`gemini mcp list` 会**真的连接**每个服务器（起 stdio 进程），所以 Gemini / Qwen 的列表直接读 `settings.json`；Codex / Gemini 的 `remove` 不存在的名字 exit 0（只打一行 not found），要看输出判失败；Codex `add` 同名直接覆盖、会重排整个文件（内联表展开），而且**没有 header 参数、不支持 SSE** —— header 在 CLI add 之后用 `appendTomlTable` 追加 `[mcp_servers.<n>.http_headers]`；Gemini http 写 `{url, type:'http'}`、Qwen 写 `{httpUrl}`，裸 `url` 是 SSE。
- **Gemini / Qwen 的 `mcp add` 会吞参数**（真 gemini-cli 0.41.2 实测）：yargs 在**任何位置**都认自己的选项，`docker run -e X --timeout 5 --trust img` 里的 `-e X --timeout 5 --trust` 会被当成 gemini 的选项吃掉；所以命令写成 `… <name> <command> -- <args…>`。另外 gemini 的 `-e K=V` 是 `split('=')` 取前两段，`TOKEN=abc==` 会存成 `abc`（Qwen 没这个 bug）。adapter 在 CLI 之后重新读 settings.json 与 spec 比对 command/args/env/url/headers，不一致就在同一把锁里用 `setJsonPath` 改正（`guard` 的 `fix` 回调），改正失败整体回滚。`fake-cli.mjs` 的 gemini 分支照这个行为模仿。
- **家目录**：Codex `CODEX_HOME` 或 `~/.codex`；Gemini `GEMINI_CLI_HOME` 是**替换 home**（下面再 `.gemini`）；Qwen `QWEN_HOME` 就是 `.qwen` 目录本身；OpenCode `$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`（Windows 也是）。都从「进程 env + agent 配置的 env」里取。
- **定点编辑**（`edit.ts`）：TOML 用自写的行级编辑（smol-toml 只负责解析和转义，它没有保留注释的写回），只改首个表头之前那一行、保留行尾注释；JSON / JSONC 用 jsonc-parser 的 `modify/applyEdits`。每次编辑都重新解析并与「只改了这个键」的期望对比，不一致就抛错不写。设置项只接受 adapter 字段表里的键（enum 校验值）。
- **备份**（`backup.ts`）：`<dataDir>/config-backups/<agent>/<ts>-<file>` + `index.jsonl`，每 agent 保留 100 份，另外**每个文件第一次被改之前的那份永久保留**（`first: true`，不参与 prune）；目录 0700、文件 0600（POSIX）。`writeChecked`（直接编辑）和 `guard`（包住 CLI 调用，CLI 失败也校验）都是「按规范化路径加异步锁 → 按字节备份 → 临时文件 + rename 原子写（Windows EPERM/EBUSY 重试）→ 重新解析 → 失败按字节回滚（原来没有就删掉）」；`restore` 先备份当前文件。文件原本不存在就没有备份。定点编辑保留 BOM 和其它行各自的换行符。
  - `atomicWrite` 先 `realpath`：**符号链接保持是链接**（dotfiles 管理的 `config.toml` 不会被换成普通文件），临时文件建在真实目标旁边，权限位取原文件（新文件 0600）；回滚走同一个函数。
  - 不是合法 UTF-8 的文件拒绝定点编辑（「文件不是 UTF-8 编码，未修改」），否则解码再编码会改掉别处的字节。
  - Windows 上目标被别的进程占着，rename 重试耗尽后报「文件被占用（可能有 agent 正在运行），请关闭后重试」，并删掉为这次没发生的写入建的备份条目。
- `resolveSpawn` 走 `cmd.exe /c` 兜底时**拒绝含 `%` 或换行的参数**：cmd 在引号里也会展开 `%VAR%`，换行直接截断命令，没法靠转义解决。这会影响经 cmd.exe 起的**自定义 agent**（非 npm JS 垫片的 `.cmd` / `.bat`）：参数里有 `%` 会直接报错，要改用不含 `%` 的值或直接指向 exe。报错只给参数序号和 `=` 左边的键名，不带参数原文（可能是密钥）。
- **密钥**：wire 上 env / header 值一律 `••••••`，URL 的 userinfo 和 query 值、args 里 `--token=… / --api-key … / --password=…` 以及 `GITHUB_TOKEN=…` 这类名字像密钥的 `NAME=value`（docker `-e`）也打码；回传含打码值的 spec 会被拒绝；从 Claude 同步传的是名字（`{claude: name}`），服务端读 `~/.claude.json`（user、`projects[cwd]` 的 local）和 `<cwd>/.mcp.json`（project）拿原值；`validateSpec` 拒绝打码值、非法名称（只允许 `[A-Za-z0-9_-]`，否则 TOML 路径 / argv 会出事）。
- 冷启动的 `agents.list` 版本探测可能要十几秒（`opencode --version` 冷启动约 10 s），`infos()` 等 3 s 后退回 `findOnPath` 判断是否安装，面板不被卡住。
- 调试：`server/src/agent-config/__mocks__/fake-cli.mjs` 扮演 codex / gemini / qwen（`--as=<kind>` 或 `CW_FAKE_AS`），`CW_FAKE_CLI_LOG` 记录每次 argv；`server/ws-phase17.mjs` **自己起一个 server**（CLI 是在 server 的 PATH 上找的），把 npm 形状的 `.cmd` 垫片放在临时 bin 目录并加到 PATH 最前。本机真 CLI 只读实测过 help；测真 CLI 的写操作一律用临时 `CODEX_HOME` / `GEMINI_CLI_HOME`。

## 跨机器会话 / 联邦（2026-09-28）

- **联邦在服务端做**：`server/src/federation/`。每台加入的机器是一个 `PeerClient`（`peer-client.ts`）：到对方 `/ws?token=<设备令牌>&peer=<本机 serverId>` 的普通客户端连接，30s ws ping（pong 往返就是延迟，10s 无 pong 断开），断线 1s→30s 指数退避。加入 = 本机代为 `POST <url>/api/pair` 兑换配对码（和手机同一个接口），令牌 `SecretService.protect` 后存 `meta.peers`；SSH 方式不存令牌，每次连接 `TunnelManager.open(host)` 后用主机配置里的 token 连 `127.0.0.1:<本地端口>`。`meta.serverId` 首次启动生成。
- **id**：远端会话 = `peer_<peerId>~<远端 id>`，**权限请求的 requestId 也加同样的前缀**（`permission.resolved` / `permission.respond` 只带 requestId，不加没法路由）。`parsePeerId()` 在 `federation/types.ts`，protocol.ts `export *`，web 的 `isImportedSessionId / nativeSessionId` 先 `localId()` 剥前缀（远端的 `codex-…` 会话照样走 `library.read` 分页）。
- **hub 只加了一个钩子**：处理请求前 `federation.route(req, {via, local})`，返回 undefined 就照常 `handle()`。路由表在 `rewrite.ts` 的 `planRoute()`：FORWARD（session.* / permission.respond / transcript.* / library.read|rename|fork …）去前缀转发、回包加前缀；SPLIT（library.archive / delete）按机器拆开再合并结果；LOCAL（草稿 / 评分 / 置顶 meta 等本机 UI 状态）留在本机；其它带 peer id 的一律拒绝。`sessions.list` / `sessions.search` 合并：每 peer 5s 上限、30s 缓存、对方 `sessions.changed` / `library.changed` 失效；离线时返回上次缓存并标 `peer.offline`（前端置灰、`effectiveCaps` 全只读）。
- **防环**：`RequestEnvelope.via` 是经过的 serverId 链，自己在链上 → 拒绝；带 via 来的请求（= 来自 peer）只拿本机列表，碰到本机的 peer id 直接拒绝（不做多跳）；远端列表里已带 `peer` 的行丢掉。`hello` 带 `serverId`，对方 serverId 等于自己 = 把本机加成了 peer，立即撤销。
- **踩过的坑：两台互为 peer 会事件回声**。A 收到 B 的 `sessions.changed` 转播给自己的客户端，其中就有 B 的 PeerClient，B 再转回来……无限弹。所以 peer 连接用 `?peer=` 自报身份，hub `broadcast(e, fromPeer)` 不把「从 peer 来的事件」发给 peer 连接；`rewriteEvent()` 另外丢弃所有已带 `peer_` 的事件做双保险。
- **令牌失效判定**：upgrade 失败时服务端直接 `socket.destroy()`，拿不到 401。借现有接口：`/api/health` 通 + `GET /api/file?token=<令牌>` 返回 403 → `unauthorized`（不再重连，等「重新配对」）；400 = 令牌有效（参数不对）。注意 `RemoteService.revoke()` 不踢已建立的连接，吊销要等下次断线才体现。
- **交接到本机**：`peers.handover {sessionId, agent, cwd}` → 通过 peer 用 `library.read` 逐页读完整历史 → `swapAgent()` 的 imported 分支（= `handOverImported`：新本机会话 + 简报），cwd 由用户选（远端路径在本机多半不存在）。
- **路由表要覆盖前端所有带 sessionId 的请求**（`rewrite.test.ts` 有一条逐个列举的用例）：`memory.search/write` 是 LOCAL（记忆库在本机，sessionId 只是 scope 键），`usage.session / files.changed / files.diff` 是 FORWARD（transcript 和文件在那台机器上）；`memory.harvest`、`session.setProvider/switchAgent` 拒绝，前端对远端会话隐藏对应按钮（MemoryPanel 的「从会话提取」、EngineSwitcher 变只读徽章）。新增带 sessionId 的请求时记得往表里放。
- **前端判断「是不是远端会话」只看 id**（`features/peers.ts` 的 `sessionPeer()` = `parsePeerId`，机器名从列表取、取不到用 peerId）：分叉后 / 布局恢复时列表还没到，按列表判断会误判成本机，然后在本机对远端路径跑 FileTree / GitView / `git.watch`。ContextRow 对远端会话只显示「机器名 · 目录名」、不发 git / fs；终端面板不用远端 cwd；composer 拒绝基于路径的附件（图片和粘贴仍可）。
- **自己加自己 / serverId 冲突**：`peers.add` 兑换配对码**之前**先 `GET /api/health?nonce=<随机>`。未鉴权的 health 只给 `serverIdHash`（serverId 的哈希）和 `selfProof = sha256(nonce + 本进程 bootId)`，serverId / bootId 原文只给带有效令牌的请求（`FederationService.healthInfo()`）。哈希相同且 selfProof 与自己算的一致 = 本机（拒绝，不留孤儿设备令牌）；哈希相同但 proof 不同 = 拷贝了 `~/.claude-web`（`SERVER_ID_CONFLICT`，提示删 meta.json 的 serverId）。老版本对端 health 不带这些时靠 hello 兜底，并用 `revokeDevice` 吊销刚兑换的本机设备。**PeerClient 的错误文案用哨兵常量 `SELF_PEER` / `SERVER_ID_CONFLICT` 做 `===` 比较**，别用 `includes('本机')`（冲突文案里也有「本机」）。
- **远端会话里的文件路径不能在本机打开**：同一个路径在本机是另一份文件（编辑器还会自动保存进去）。工具卡片的路径（`FileLink`，含 Alt+点击的详情面板）、消息里的附件芯片、「产物」标签、详情面板的文件视图都先过 `features/remote-guard.ts` 的 `blockRemoteOpen()`（纯逻辑在 `peers.ts` 的 `remoteOpenBlock()`），远端时只提示「文件在机器 X 上」。命令面板对远端会话不给「在资源管理器 / VS Code 打开目录」。新增从会话上下文打开文件的入口时也要过它。
- `hostChanged(hostId, prev)` 只在 token / target / sshPort / remotePort / identityFile 变了才重连并关隧道（`CONNECTION_FIELDS`），改名、改 startCommand 不断连。
- **peer 连接的判定**：`fromPeer = via 非空 || 连接带 ?peer=`；来自 peer 的请求不能碰 `peers.*`、只拿本机列表、不多跳。SSH 方式 peer 令牌失效后不会自己好：`remote.hosts.set` 会对骑在这个主机上的 peer `hostChanged()` 重连，界面也有「重试」（`peers.retry`）。
- 已知限制：附件存本机（`/api/attachments`），发给远端会话时对方读不到路径（composer 已拦）；远端的文件 / Git / 搜索不做（ChatTile 对远端会话只留 对话 / 产物 标签）；`sessions.search` 合并时一个慢 peer 会把整次搜索拖到 5s 上限；SSH peer 每次重连都会 `TunnelManager.open()`，主机配了 `startCommand` 就会在远端重跑一次。
- 调试：`node server/ws-phase15.mjs [port] [token]` 自己用临时 HOME 起第二个 server B（开远程监听、mock ACP 造会话），A 配对加入后测列表合并 / 打开发送 / 权限往返 / 交接 / 防环 / 吊销→令牌失效→重新配对 / B 下线；`CW_DEBUG=1` 打印两边收到的帧；失败时脚本自己打印 B 的日志尾部，`scripts/e2e.mjs` 对失败 / 超时（默认 300s，`E2E_PHASE_TIMEOUT_MS`）的 phase 重印完整输出和 A 的日志尾部。add / repair 之后用 `onlineIn()` 轮询 `peers.list` 到 online，别信单个等待窗口。单测：`federation/*.test.ts`（`peer-client.test.ts` 用进程内假服务器）。

## 多 agent 编排（2026-09-28）

- **引擎**：`server/src/orchestra/service.ts` 的 `OrchestraService`，依赖全部经 `OrchDeps` 注入（会话打开器、`OrchGit`、GoalService、工作流存储、可用 agent、并发上限、通知），单测用假会话 / 假 git（`service.test.ts`）；纯逻辑（校验、环检测、分层、模板变量、裁判判词）在 `dag.ts`。真正的依赖在 `runtime.ts`：开会话走和 hub `session.open` 相同的路径（canonical、默认供应商、外部 agent 标题），发送走 `expandSessionRefs`。hub 只有一行分发（`isOrchestraRequest` → `handlers.ts`）+ 两行广播；协议类型在 `orchestra/types.ts`，protocol.ts `export *`。
- **每个任务节点就是普通会话**：侧栏 / Mission Control / 权限 / 账本零改动。提示词第一行加 `[编排 <运行名> · <节点名>]`，外部 agent 的会话头标题写成「编排 · …」。完成判定 = 第一个 `result`。`untilDone`：先用同一条 `open()` 开会话（默认供应商 / features / canonical），`expand()` 展开引用，再 `goals.create({sessionId})` + `start`（GoalService 看到已有 runner 就复用）；目标 complete → done，blocked / max_turns / **paused / 被删 / 会话关闭** → failed（不然会永远 running）。
- **会话事件按 id 在 pool 层订阅**（`runtime.ts` 的 `poolWatch`），不挂在 runner 实例上：热切换供应商 / agent 会换 runner、先发一个 `closed`。**只有 swap 路径明确宣告的 close 才可能是交接**：`session/swap.ts` 关旧 runner 前 `pool.emit('swapping', id)`，watch 收到后 3 秒内同 id 有活 runner 才算接手（节点上提示「会话被热切换…需要在会话里继续」）；没有宣告的 close 立刻算数——用户从侧栏重开同一个会话不是节点的会话在继续。
- **worktree 任务合并失败** → failed + `mergePending`，节点上有「重新合并」（`orchestra.node.remerge`：再提交、同样的检查、成功后下游重排）；文案「处理冲突后点重新合并，或手动 git merge <分支>」。合并守卫（`merging` 计数）一直持有到节点状态落定（合并 + 清理 / 回到 waiting），中间不能取消。比选的候选全部提交完才切 `waiting` 并通知（`sealing` 标记期间不可选）；胜者会话还在跑时拒绝选择（前端按钮同样禁用）。
- **清理 / 孤儿**：`inspect` 先 `worktree prune`，链接不通时 `worktree repair` 再看；接不上 = 「git 链接已断」，和「有未提交改动」分开报。删除运行记录没清理的目录在面板底部「遗留 worktree」里列出（`orchestra.orphans.list`），删除前 `orphan()` 确认 git 链接完好且干净，分支保留。worktree 目录名各段超长时截断 + 4 位 hash（Windows 路径长度），`worktree add` 在 Windows 带 `-c core.longpaths=true`；add 失败时删掉它刚建、仍停在 base 的分支和半成品目录。
- 编排在 worktree 里开的会话写 `SessionMeta.groupCwd = run.cwd`，侧栏分组优先用它（不然会落到「其它目录」）。GoalService 的 `sendWhenReady` 发送前再确认目标仍是 `active`。
- **取消 / 重试的竞态**：每个 `await` 之后都检查「这个 NodeRun 还是不是当前那个」，不是就关掉刚开的会话、删掉刚建的目标；`send()` 带 `isCancelled`，等会话 ready 期间被取消就不发。`cancel` 对还在 starting 的会话直接 close（没有回合可 interrupt，ready 后提示词会照发）。用户动作（续跑 / 重试 / 选胜者 / 取消 / 删除）有每个 run 一把锁，双击第二下报「正在处理」；前端 `orchAct(key, req)` 请求期间按钮禁用。
- **提示词注入**：用户输入、上游输出、审批意见里的 `<session-ref` 一律转义成 `&lt;session-ref`（`defuseRefs`），只有 `renderPrompt` 自己为截断输出生成的引用会被 `expandSessionRefs` 展开。
- **调度**：每次状态变化 `tick()`；并发上限按 **run** 计（`orchestra.maxParallel`，默认 3，审批等待不占名额）；上游 failed / skipped / cancelled → 下游 skipped，但不相关的分支继续跑，全部终态后 run 才落 failed。运行时冻结一份 `run.workflow`，改模板不影响正在跑的。
- **worktree / 比选**：放在仓库**外面** `<dataDir>/worktrees/<仓库名>-<路径 hash8>/<runId>-<nodeId>-<agentSlug>[-attemptN]`，分支 `cw/<runId>/<nodeId>-<agentSlug>[-attemptN]`（`acp:x` 的冒号不能进路径和 ref，`agentSlug()`；放仓库里会被测试运行器 / 构建扫到，所以也不再写 `.git/info/exclude`）。候选结束时**自动 `git add -A && commit`** 并记下提交（`candidate.head`），`diff --stat base...branch` 用三点。
- **铁律：不毁用户的东西**（`orchestra/git.ts` 注释写着）。合并前 `rev-parse --git-path` 查 MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD / rebase-merge / rebase-apply（linked worktree 有自己的 gitdir，所以必须 `--git-path`，不能拼 `.git/`），有任何一个 → 拒绝（kind `busy`）；暂存区非空 → 拒绝（`dirty`）；合并失败时**只有「合并前没有、合并后有 MERGE_HEAD」才 `merge --abort`**（审查实测过：无条件 abort 会把用户解决到一半的 merge 撤掉）。比选合并失败 → 节点回到 `waiting`，什么都不删，用户处理后可以再选。选胜者时先对胜者再 `commitAll` 并刷新 diffStat。删除一律走 `drop()`：worktree 脏 → 保留；分支要么已合并进基线（`-d`），要么仍停在编排记下的提交（`-D`，落选候选），否则保留并写进 `nodeRun.note`。`worktreeAdd` 遇到同名目录 / 分支直接报错，**从不删**；重试 / 续跑换 `-attemptN` 新名字，旧的进 `nodeRun.retained`。删除运行记录时可选 `cleanup`，同样规则，保留的列表返回给 UI。合并串行（`mergeChain`），合并期间拒绝取消（`merging` 计数）。
- **踩过的坑**：**Windows 删不掉还被进程当 cwd 的目录**——mock agent 进程的 cwd 就是 worktree，`worktree remove` 后目录残留；所以删之前先 `pool.close()` 候选会话，git 注销后 `fs.rm` 再带 `maxRetries`。`orchestra/git.test.ts` 用真 git 临时仓库跑（用户 merge 中途、rebase / cherry-pick、暂存区、冲突后只 abort 自己的、基线脏、子目录、linked worktree），每个用例要起十几个 git 进程，Windows 并发跑全套时要 60 秒超时。`.orch-canvas svg {position:absolute}` 会把卡片里的图标 svg 也甩到左上角，只能写 `> svg`。前端冷启动时 `agents.list` 的版本探测要好几秒，`orchestra.templates` 依赖它，别和工作流 / 运行列表放进同一个 `Promise.all`。
- **持久化**：工作流在 `meta.workflows`；运行记录 `<dataDir>/orchestra/<runId>.json`，每次变化按 run 串行写（tmp + rename）。启动时 `running|waiting` 的 run → 节点 failed「服务重启中断」，`resume` 把非 done 节点重置为 pending（会话 id 历史保留）。
- **前端**：停靠面板「编排」（`features/orchestra/`）；独立的小 zustand store（`state.ts`，不往 `store/index.ts` 加东西），`installOrchestra()` 在 App 里装一次：订阅 `orchestra.changed`，节点进入 waiting 时 toast + 桌面通知；Mission Control 的「需要你」列读 `waitingOf(full)`（审批可以直接点通过）。执行图布局是纯函数 `graph-layout.ts`（注意别叫 `graph.ts`：和 `Graph.tsx` 在 Windows 上只差大小写，tsc 报 TS1149）。IM：`ImRouter.announce(sessionIds, …)` 只推给**绑定了该 run 任一会话**的聊天（没有绑定的 run 不会退回网关默认聊天——现在没有「默认聊天」这个概念，要在 IM 里审批就先把聊天绑到这个 run 的某个会话）；按钮 id 是短 token `orch:<8 hex>:a|r`（Telegram callback_data ≤ 64 字节），token → (run, node) 只在内存里，重启后按钮失效、提示去面板；`OrchImBridge.handle` 还要求点按钮的聊天绑定的会话属于这个 run，只认 `a` / `r`。`callbackHandlers` 的第二个参数带 `{gatewayId, chatId, sessionId}`。删除运行记录广播 `orchestra.changed {run, removed:true}`。
- **调试**：`server/ws-phase14.mjs` 用两个 mock ACP agent（`acp:orch-a/b`，`MOCK_ACP_TAG` 区分内容）+ 临时 git 仓库跑「任务 → 审批 → 任务 → 比选」，断言会话创建、审批阻塞、模板带上游输出与审批意见、worktree 命名、diff、`--no-ff` 合并、清理，外加驳回路径和环校验。mock agent 收到 `WRITE:<文件>` 会在会话 cwd 里写这个文件（内容 = `MOCK_ACP_TAG`）。

## 多模型管理（2026-09-28）

- **拉模型列表**：`ProviderService.refreshModels(ids?)`（请求 `providers.refreshModels`）对档案并发（上限 4）调 `probeProvider()`——只 GET `/v1/models`（或该类型的等价接口），**从不发对话**。成功写 `models` + `modelsAt` 并清 `modelsError`；失败只写 `modelsError`、**保留旧列表**（中转挂一小时不能把菜单清空）。gateway 档案跳过。`upsertProvider` 里值为 `null` 的可选字段会被删掉（`modelsError: null` 就是清错），新增字段要加进那张清理表。启动后 5 秒 `autoRefreshModels()`（unref 定时器）刷新 `needsModelRefresh()` 为真的档案：有 key、非 gateway、从没拉过或超过 24 小时。`providers.probe` 成功时也记 `modelsAt`。
- **统一菜单**是纯函数 `web/src/features/models/menu.ts`（`buildModelMenu` / `filterMenu` / `chipLabel` / `modelTable`，`menu.test.ts` 覆盖）。兼容性 `compatibleTypes(agent)`：claude → 全部类型；gemini → gemini / gateway；codex 与其它 ACP → openai / gateway（和 server `providerEnv` / `agentLaunch` 实际接得上的一致，`agentLaunch` 为此补了 Gemini CLI 用 gemini 类型档案）。网关档案的模型 = 组成员模型 + 成员固定模型 + 默认模型 + modelMap 非通配键，与 `GatewayService.serveModels` 同口径（前端从 `gateway.status` 自己算）。
- **键**：`ui.disabledModels` / `ui.favoriteModels` 用 `<providerId>:<model>`；官方 Claude 登录沿用历史的**裸模型 id**，其它 agent 自带的模型是 `<agent>:<model>`（老设置页就这么写的，别改）。`ui.recentModels` 是 `recentKey()`：`<providerId>:<model>`，官方 Claude 是 `claude:<model>`，其它 agent 自己的登录是 `@<agent>:<model>`（否则 Codex 的「默认模型」会出现在 Claude 的最近里）。
- **会话内切换**：路由是纯函数 `models/route.ts` 的 `routePick()`（`route.test.ts`）：同档案 → `session.setModel`；别的档案 → `session.setProvider {providerId, model}`。「默认模型」项在客户端解析成具体值（Claude 账号 → `default`，外部 agent → 它配置的默认模型，没有就报错让用户选；档案 → 它的 `defaultModel`）。服务端 `swapProvider` **换了档案又没给 model 时不继承旧模型**（旧档案的模型 id 在新端点多半不存在），同档案重启才沿用。`session.setProvider` 先用 `ProviderService.fitError()` 校验 agent / 档案类型 / 实际引擎（`@catalog` 的 `providerTypesFor` / `profileFitError`，前端菜单用同一张表）；`swapProvider` / `swapAgent` 自己在内部按 sessionId 走 `withSessionLock` 串行（federation 交接等绕过 hub 的路径也受保护；锁不可重入，别在锁内再调它们）；`session.open` 带显式 providerId 时同样先过 `fitError`（欢迎页、定时任务、IM、编排新建会话都走这里），前端切换期间芯片禁用。只有切换成功（或确认框点了确定）才记入最近。
- **不可用 ≠ 不兼容**：agent 接不了的类型直接不列；能接但眼下用不了的整节灰显并写原因——Claude 会话跑在官方二进制上（档案强制 `runtime:'claude'`，或 ccb 不在时的静默回退，前端按 `engine.info` 的 runtime / fallback 推断，见 `effectiveRuntime()`）时的 openai / gemini / grok 档案；网关没启用或组不存在的网关档案（`gateway.status` 没到之前不判定）。
- 后台写回（`refreshModels`、`probe`）一律 `upsertProvider(…, {mustExist:true})`：刷新途中删掉的档案不会被写回复活。200 但空列表不覆盖旧的非空列表（记 `modelsError`）。`CW_NO_MODEL_REFRESH=1` 关掉启动刷新（`scripts/e2e.mjs` 设了）。外部 agent 会话现在也记 `SessionMeta.providerId`（resume 沿用）并由 pool 往 info 里写 `providerId/providerName`，芯片才能显示 `档案 / 模型`。远端（`peer_`）会话锁定为只换模型。
- **踩过的坑**：① 菜单挂在窗格里会被 `.pane{overflow:hidden}` 裁掉，所以 `ModelChip` 把菜单 portal 到 body、按锚点算 fixed 坐标（纯函数 `models/place.ts`：哪边空间大开哪边、高度取可用空间且 ≥120、不超视口；ResizeObserver 盯锚点、composer、pane，分屏拖动和输入框变高都跟着走）。② 通用的 `.menu button{width:100%}` 会把行尾星标按钮撑到 500px、把模型名挤成 0 宽；星标的规则都写成 `.menu.mm .mm-star` 抬优先级。③ `width:max-content` 的弹层里 `flex:1`（basis 0%）的子项在 Chromium 下贡献 0 宽，名字列要 `flex:1 1 auto`。④ shot.cjs 的 JS 里别写 `{section:'models'}` 这种带冒号的字面量（Electron 当 URL 退出），用 `Object.fromEntries`；打开会话后布局存进了截图用的 Electron profile，下一张欢迎页截图要换 `?win=`。
- **调试**：`server/ws-phase16.mjs` 末尾的假上游对 `GET /v1/models` 返回列表，断言每个档案的结果、写回、失败保留、gateway 跳过、只发了 GET。单测 `server/src/providers/refresh.test.ts` 用 node:http 假 `/v1/models`（按 key 决定行为，数并发峰值）。

## 桌面版（desktop/）

```
npm run desktop         # 编译 server/web/desktop 后用源码起 Electron
npm run build:desktop   # electron-builder → dist-desktop/ClaudeWeb-<ver>-win-x64.exe (NSIS) + ClaudeWeb-<ver>-portable.exe
```

- 壳只做四件事：`utilityProcess.fork(server/dist/index.js)`（PORT=0 自选端口 + 随机 token）、BrowserWindow 加载 `http://127.0.0.1:<port>/?token=…`、托盘/菜单/通知、`window.desktop` 桥（preload）。
- **utilityProcess 里 `process.send` 不存在**，server 用 `process.parentPort.postMessage({type:'ready'})` 报告端口；别给它设 `ELECTRON_RUN_AS_NODE`（会让它拒绝 Chromium 参数直接退出）。
- 前端通过 `web/src/desktop.ts` 判断是否在桌面壳里：选目录 / 打开路径 / 通知 / 菜单快捷键都走桥，浏览器模式退回原逻辑。`html.desktop` 类让顶栏成为可拖动标题栏，右侧留 150px 给系统窗口按钮。
- 打包后原生二进制在 `app.asar.unpacked`：`resolveClaudeExe()` 和 node-pty 加载都做了路径修正。
- 日志：`%APPDATA%\claude-web\server.log`、`main.log`。
- electron-builder 只打包**根 package.json 的 dependencies**（workspace 子包的不算），所以 server 的运行时依赖在根 package.json 里也列了一份；`npmRebuild: false`，node-pty 用自带 prebuilds（本机没有 VS Build Tools，rebuild 会失败）。
- 调试打包后的 server：设 `CLAUDE_WEB_TOKEN=xxx` 起 `electron .`，然后浏览器开 `http://127.0.0.1:<port>/?token=xxx`（端口看 server.log）。

## macOS / CI（2026-09-27）

- **mac 包只能在 mac 上打**：`.github/workflows/release.yml` 用 `macos-latest`（arm64）+ `macos-15-intel`（x64）分别构建。不能在 arm 机器上交叉打 x64：npm 只装本机 CPU 的 SDK 二进制，ccb 的 ripgrep 也是 postinstall 按 `process.arch` 下载的。推 `v*` tag 才发布到 Releases，`workflow_dispatch` 只产出 artifact。仓库是私有的，electron-updater 在未带 token 的客户端上拿不到更新。
- 未签名（`identity: null`）：用户首次要右键打开或 `xattr -cr`。`scripts/after-pack.cjs` 给 unpacked 里的 `spawn-helper` / SDK `claude` / `rg` 补 +x；`TerminalService` 运行时也会补 `spawn-helper`。
- **Finder 启动的 app 只有 `/usr/bin:/bin:/usr/sbin:/sbin`**：`desktop/src/main.ts` 的 `fixPosixPath()` 在 fork server 之前用 `$SHELL -ilc` 取 PATH 并补 Homebrew / `~/.local/bin`。
- mac 标题栏：`titleBarOverlay` 只在非 mac 用；mac 用系统红绿灯 + `trafficLightPosition`，preload 给 `<html>` 加 `mac/win/linux` 类，`styles.css` 的 `html.desktop.mac` 规则把左侧让出 84px。mac 菜单 Cmd+Tab 被系统占用，分组切换用 Ctrl+Tab。
- `fs.pickDir`：Windows PowerShell / mac `osascript choose folder` / Linux `zenity`。
- **CI**（`.github/workflows/ci.yml`，win/mac/linux）：`npm run typecheck`、`npm test`、`npm run build:all`、`npm run e2e`。`scripts/e2e.mjs` 用临时 HOME + `CLAUDE_WEB_DIR` 起 server，跑 phase 3/4/5/6/11/12/13/14/15/16/17（mock agent / 假上游，不花 token；每个 phase 默认 300 s 上限，`E2E_PHASE_TIMEOUT_MS` 可调，失败时打印该 phase 全部输出和 server 日志尾部）；CI 额外带 `GH_TOKEN` 跑 phase7；phase1 要真 Claude，手动跑。

## 子进程窗口 / 前端健壮性（2026-09-28）

- **桌面版一直弹 PowerShell / cmd 窗口**：server 跑在 Electron utilityProcess 里，ccb、npm 垫片的 agent（gemini / opencode / codex 的 JS 入口）跑在 Electron-as-node 里——Electron 是 GUI 子系统程序，**这些进程都没有控制台**，它们起的任何控制台程序（git、reg、cmd、powershell、where…）只要没带 `windowsHide` 就各开一个可见窗口。我们自己的调用早就带了；弹窗来自子进程自己的 spawn：ccb 周期性 `reg query HKLM/HKCU\SOFTWARE\Policies\ClaudeCode`、`where.exe`、`git`，opencode 的 `--version` 每次 4 个 PowerShell/pwsh AVX 检测（版本探测一被触发就是一串 PowerShell 窗口）。真 `node.exe` 是控制台程序，`windowsHide` 给它一个隐藏控制台，孙进程继承，所以网页版（`npm start`）不弹。
- **修法 = spawn guard**（`server/src/runtime/spawn-guard.ts`）：一份 CommonJS 源码，两处运行——server 进程内（`index.ts` 的**第一个 import** `runtime/spawn-guard-install.ts`，ESM 按 import 顺序求值，后面模块在加载时 `promisify(execFile)` 拿到的也是补过的）；Electron-as-node 子进程里作为 `--require` 预加载（写到 `<dataDir>/runtime/spawn-guard-<hash>.cjs`，不放 src/ 是因为 tsx、tsc 产物、asar 三种布局下都要是磁盘上的纯 JS；`nodeRuntime().args` 统一加，`spawnClaude` / `runClaudeCli` / `resolveSpawn` 的 node-shim 都走它）。补丁把 child_process 的 spawn/exec/execFile/fork 及 Sync 版的 `windowsHide` 缺省成 true（显式 `false` 保留），保留 `util.promisify.custom`，再 `syncBuiltinESMExports()` 让 ESM 具名导入也生效（ccb 是 ESM）。新写的调用仍然要显式写 `windowsHide: true`。
- **`CW_SPAWN_LOG=1`**：server stderr 每次 spawn 一行 + 每分钟汇总；JSONL（命令、脱敏参数、调用栈前几帧、pid、进程角色）写到 `CW_SPAWN_LOG_FILE`（默认 `<dataDir>/spawn-log.jsonl`），开了日志时子进程也会被注入 guard 并写同一个文件。测频率：`node scripts/ui-smoke.cjs --idle 180 --live [--activity]` → `spawn-summary.json`。
- 降下来的重复调用：agent 版本探测（每个连接 3 路并发、每路各探一次 → 同时只探一次 + 10 分钟缓存）、`engine.info`（每次连接都同步跑 `npm root -g` + `claude.exe --version`，堵事件循环几秒 → 找到内置的就不跑 `npm root -g`，版本按文件 + mtime 缓存）、git status（`rev-parse` 按 cwd 缓存 60 s、`status --show-stash` 省掉 `stash list`，一次 status 3 个进程 → 1 个）、会话 tile 的 git 徽章（以前任何仓库的 git.changed / fs.changed 都让**每个** tile 重跑 status → 只认自己仓库的事件，400 ms 合并）、`config.auth`（欢迎页每次挂载都起一次引擎 → 30 s 共享）、`claude mcp list`（设置 → MCP 挂载时并发两次且每次拉起所有 MCP server → 15 s 共享，增删 server 清掉）。实测（临时 HOME，装了 codex/gemini/opencode/qwen/kimi）：启动到稳定 99 → 40 个进程（PowerShell 24 → 4），会话在后台干活时 19 → 6.7 个/分钟，纯空闲 0 个/分钟。
- **首页输入框弹「文件夹下拉」**：欢迎页目录 chip 里藏了个 `opacity:0; position:absolute; inset:0` 的原生 `<select>`，而 `.dirpick` 没有 `position:relative`，于是它铺满了整个 `.composer-inner`，点输入框其实点在 select 上。改成 `features/composer/DirPicker.tsx`：只有点 chip 才弹、自己的 portal 菜单（`.menu.dirmenu`，`placeMenu` 定位在 chip 下方，↑↓ Esc），浏览文件夹在菜单里。其它 chip 里的透明 select 都在 `.chip{position:relative}` 里，ui-smoke 会检查 composer 里没有比所在 chip 大的 select。
- **错误边界**（`web/src/ui/ErrorBoundary.tsx`）：App 根、侧栏、工作台、每个 tile（`Tile.tsx`）、每个停靠面板（`PanelBody`）、设置窗每个分区和每个条目、模型菜单 / 目录菜单、各个浮层（设置、命令面板、对话框…，`floating` 变体浮在角落，不落进 `.app` 的 grid）。只在该区域显示「这里出错了」+ 摘要 + 重试（重挂子树，`resetKeys` 变了也自动重置）+ 复制错误信息，并 `client.log` 发到 server（`[web error] <区域>: …` 进 stderr / 桌面版 server.log，每连接每分钟 20 条）。**开发开关**：控制台 `__cwCrash('设置 · 模型')` 让区域名包含该文本的边界下次渲染时抛错（`''` = 全部）。
- **zustand 选择器必须返回稳定引用**：`useStore((s) => s.x ?? [])`、`.filter()`、`({…})` 每次都是新值 → 无限重渲染（React #185 白屏，设置 → 模型就是这么白的）。用模块级常量（`?? NONE`）、选原值再 `useMemo`、或 `useShallow`。`web/src/store/selectors.test.ts` 静态扫描所有选择器防回归。
- **ResizeObserver 回调里改被观察元素的尺寸**（xterm `fit()`、输入框 autosize）会让 Chromium 报 `ResizeObserver loop completed with undelivered notifications` console 错误：回调里 `requestAnimationFrame` 再做。
- **`scripts/ui-smoke.cjs`**（Electron 驱动，任何 console 错误 / 警告都算失败）：`npm run build:all && node scripts/ui-smoke.cjs [--out <dir>] [--show] [--keep]`。用 node 跑时自己建临时 HOME（种一个 git 仓库 + 一个 Claude 会话，让欢迎页有最近目录）、起 `server/dist`、再用 Electron 跑同一个文件；分区 id 从 `SettingsModal.tsx` 解析、面板从 `layout.ts` 的 `PANELS` 解析，所以加分区 / 面板不用改脚本。检查：欢迎页点输入框落在 textarea 且能打字、目录 chip 菜单、模型菜单、每个设置分区、每个停靠面板、种子会话、错误边界探针（`__cwCrash` + 重试 + server 日志里有 `[web error]`）。截图 `ux-*.png` 和 `ui-smoke.json` 在 `--out`（默认 `%TEMP%\cw-ui-smoke`）。选项全走 env 传给 Electron（argv 带冒号会被当 URL），默认离屏渲染（`--show` 才弹窗口）；`ELECTRON_DISABLE_SECURITY_WARNINGS` 关掉 Electron 的开发期 CSP 提示（打包后本来就没有）。`--url "<带 token 的地址>"` 可以对已经在跑的 server 做只读检查（不打字存草稿、不开终端面板、不改 onboarded、不跑崩溃探针）。

## 结构

- `server/src/protocol.ts` — 前后端共享协议类型（web 通过 `@shared` 别名引用）
- `server/src/runtime/session-runner.ts` — 一个活动会话 = 一个 SDK query（streaming input，跨轮）
- `server/src/sessions/service.ts` — 会话列表/历史（SDK listSessions 等）+ chokidar 监听
- `server/src/config/service.ts` — 插件/MCP/skills/agents/hooks/auth，调 `claude <子命令>`
- `web/src/model/conversation.ts` — 纯函数 reducer，SDK 消息 → 消息树
- `web/src/store/index.ts` — zustand，所有 WS 事件在这里进 reducer
