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
- **供应商档案**（`Provider`，存 `~/.claude-web/meta.json`，不写 `~/.claude/settings.json`）：`server/src/providers/service.ts` 的 `providerEnv()` 按类型映射成 env（anthropic → `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（Bearer）+ `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL`；openai → `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `CLAUDE_CODE_USE_OPENAI=1`；gemini / grok 同理），`session-runner.ts` 只注入到那个会话的进程；本进程的 `ANTHROPIC_*` 等 env 会被清掉以免混入。会话用的档案记在 `SessionMeta.providerId`，resume / fork 沿用。wire 上 `apiKey` 一律打码。
- **中转指纹（api.super-nb.me 实测）**：只放行官方 Claude Code 构建发的 `/messages`。三处判据都踩过：① User-Agent 里不能有 SDK 附加的 `agent-sdk/x.y.z`（来自 env `CLAUDE_AGENT_SDK_VERSION`，`spawnClaude` 见到 `CLAUDE_WEB_PLAIN_UA` 就删掉）；② `CLAUDE_CODE_ENTRYPOINT` 必须是 CLI 默认的 `cli`（`sdk-ts`/`claude-web` 都 400「请求可能被第三方中转改写」）；③ 必须带 Claude Code 的主系统提示（Agent SDK 默认是**空**系统提示，runner 显式传 `systemPrompt: {type:'preset', preset:'claude_code'}`）。ccb 本身的请求形状（UA 2.8.4、不同的系统提示和工具表）过不了这种指纹，所以 `ProviderService.probe()` 除了 `/v1/models` 还真跑一轮 `-p`：ccb 被拒就自动把档案 `runtime` 切到 `claude` 并提示。
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

## 结构

- `server/src/protocol.ts` — 前后端共享协议类型（web 通过 `@shared` 别名引用）
- `server/src/runtime/session-runner.ts` — 一个活动会话 = 一个 SDK query（streaming input，跨轮）
- `server/src/sessions/service.ts` — 会话列表/历史（SDK listSessions 等）+ chokidar 监听
- `server/src/config/service.ts` — 插件/MCP/skills/agents/hooks/auth，调 `claude <子命令>`
- `web/src/model/conversation.ts` — 纯函数 reducer，SDK 消息 → 消息树
- `web/src/store/index.ts` — zustand，所有 WS 事件在这里进 reducer
