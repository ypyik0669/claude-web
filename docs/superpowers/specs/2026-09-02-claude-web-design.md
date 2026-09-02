# claude-web 设计文档

日期：2026-09-02

## 目标

把本机的 Claude Code CLI（v2.1.258）完整搬到浏览器里，UI 极简、功能齐全。
单人、本机使用（127.0.0.1），直接复用 `~/.claude` 下的登录态、插件、MCP、hooks、skills、会话历史。
终端里开的会话和网页里开的会话是同一批文件，互相可见、可互相 resume。

参考对象：deepseek-harness 的本地 web（三栏布局、对话/轨迹双视图、状态栏统计）和 Claude Desktop（多面板同时可见）。

## 非目标

- 多用户 / 远程鉴权 / HTTPS
- 云端会话（claude.ai/code）
- 修改 Claude Code 本体

## 三层能力覆盖

| 层 | 覆盖内容 | 实现 |
|---|---|---|
| 对话运行时 | 流式回复、thinking、工具调用、子代理、后台任务、权限弹窗、AskUserQuestion、计划模式、/slash 命令、skills、hooks、MCP 工具、模型/effort/权限模式切换、中断、resume/fork | `@anthropic-ai/claude-agent-sdk` `query()`，streaming-input 模式，一个 query 跨多轮 |
| 管理面 | 插件安装/启停/市场、MCP 增删查/状态、登录状态、后台 agents、doctor | 调 `claude plugin|mcp|auth|agents|doctor` 子命令 + 直接读 `~/.claude` 配置文件 |
| 兜底 | 任何以上没覆盖的交互式命令（/login OAuth 流程、/theme 等） | 内嵌 xterm.js 终端跑 `claude`（node-pty，可选依赖，装不上就隐藏该面板） |

## 架构

单仓库 `C:\Users\YPY\claude-web`，一个 Node 22 进程：

```
claude-web/
  package.json            # workspaces: server, web
  server/                 # TypeScript, tsx 直跑
    src/index.ts          # http + 静态文件 + WebSocket /ws，默认 127.0.0.1:3090
    src/ws/protocol.ts    # 客户端/服务端消息类型（server 和 web 共享，web 通过 path alias 引用）
    src/ws/hub.ts         # 连接管理、消息路由
    src/runtime/session-runner.ts   # 一个活动会话 = 一个 SDK query（streaming input）
    src/runtime/permission-bridge.ts# canUseTool -> WS 请求 -> 等网页回复
    src/runtime/runner-pool.ts      # sessionId -> runner，多会话并行
    src/sessions/registry.ts        # 扫描 ~/.claude/projects/*/*.jsonl，chokidar 监听变化
    src/sessions/transcript.ts      # jsonl -> 规范化消息树（含 subagents/、tool-results/）
    src/sessions/tasks.ts           # ~/.claude/tasks/<session>/ 后台任务
    src/config/*.ts                 # plugins / mcp / skills / agents / hooks / auth / settings
    src/usage/aggregate.ts          # 从 jsonl 的 message.usage 汇总 token/成本
    src/terminal/pty.ts             # 可选：node-pty
  web/                    # React 18 + Vite + TS + Zustand，纯 CSS 变量，无 Tailwind
    src/app/App.tsx                 # 三栏 AppFrame，可拖拽宽度
    src/store/*.ts                  # zustand：sessions / activeSession / panels / config / usage
    src/ws/client.ts                # 自动重连 WS，请求-响应 + 事件订阅
    src/features/sidebar/           # 项目 -> 会话 树，搜索，新建，重命名，删除，fork
    src/features/chat/              # 消息流、流式渲染、markdown、thinking 折叠、工具卡片
    src/features/trajectory/        # 轨迹视图：每轮的工具调用表格/时间线
    src/features/composer/          # 输入框：/ 命令面板、@ 文件、图片粘贴、队列
    src/features/panels/tasks/      # 子代理/后台任务树，点开看子代理完整对话
    src/features/panels/files/      # 本会话改动文件列表 + diff
    src/features/panels/usage/      # 会话级 + 全局用量
    src/features/panels/config/     # 插件/MCP/Skills/Hooks/Agents/登录
    src/features/panels/terminal/   # xterm.js 兜底
    src/features/dialogs/           # 权限请求、AskUserQuestion、ExitPlanMode 审批
```

### 运行时数据流

1. 网页打开会话 → `session.open {sessionId?, cwd, model?, permissionMode?, effort?}`
2. server 起一个 `SessionRunner`：`query({ prompt: inputStream, options: { resume, cwd, model, permissionMode, includePartialMessages: true, canUseTool, hooks, settingSources: ['user','project','local'] } })`
3. SDK 吐出的每条消息（system/init、stream_event、assistant、user、result、task 进度等）原样加 `sessionId` 广播给网页；网页端的 reducer 把它们合并进消息树（按 `parent_tool_use_id` 挂到子代理下）
4. 用户发消息 → `session.send {text, images?}` → 推进 inputStream
5. 权限：`canUseTool(toolName, input, {signal})` → server 发 `permission.request {requestId, toolName, input, suggestions}` → 网页弹卡片 → `permission.respond {requestId, allow|deny, updatedInput?, message?}`。AskUserQuestion 和 ExitPlanMode 都走同一条路，网页按 toolName 渲染不同 UI。
6. 切模型/effort：SDK 没有运行时 setModel 的话，就结束当前 query，用 `resume` + 新参数重开（用户无感）。切权限模式用 `setPermissionMode`。中断用 `interrupt()`。
7. 会话列表：`registry` 扫描 jsonl，取 `ai-title`（没有就取第一条用户消息前 40 字）、`cwd`、`gitBranch`、最后时间、模型。chokidar 监听 → `sessions.changed` 推送。
8. 打开历史会话：`transcript.load` 返回规范化消息树，网页先渲染历史，再 `session.open {resume}` 接上运行时。

### 协议（WS，JSON 一行一条）

客户端 → 服务端（带 `id`，服务端回 `{id, ok, data|error}`）：
`sessions.list`、`transcript.load`、`session.open`、`session.send`、`session.interrupt`、`session.setPermissionMode`、`session.setModel`、`session.setEffort`、`session.close`、`session.rename`、`session.delete`、`session.fork`、`permission.respond`、`config.get`、`config.plugin.*`、`config.mcp.*`、`config.auth.*`、`usage.get`、`files.diff`、`terminal.*`

服务端 → 客户端（事件，无 id）：
`session.event {sessionId, message}`、`permission.request`、`sessions.changed`、`session.status {sessionId, state: idle|running|waiting_permission|error}`、`terminal.data`

## UI

极简、深色优先、系统字体 + 等宽字体，CSS 变量主题，无阴影无渐变，信息密度高。

- **顶栏**：会话标题（可改）、模型下拉、effort 下拉、权限模式下拉、后台任务计数、右侧面板开关
- **左栏**：项目（cwd）分组的会话列表，运行中的会话带绿点，搜索框，「新会话」按钮选目录
- **中栏**：`对话` / `轨迹` 两个 tab。对话流里：用户消息、assistant markdown、thinking 折叠块、工具卡片（Bash 显示命令+输出，Edit/Write 显示 diff，Read 显示路径，Agent 显示子代理入口，其它显示 JSON）、结果行（token、耗时、成本）。轨迹 tab：按轮次列出所有工具调用的表格，可搜索
- **右栏**（可同时开多个，上下堆叠）：任务树 / 文件改动 / 用量 / 配置中心 / 终端
- **底部输入框**：`/` 弹命令面板（来自 init.slash_commands + skills）、`@` 弹文件补全、Ctrl+V 贴图、Enter 发送、Shift+Enter 换行、运行中可排队
- **弹窗**：权限请求卡片（允许一次 / 总是允许 / 拒绝，附原因）、AskUserQuestion 单/多选、ExitPlanMode 计划审批

## 错误处理

- SDK 进程崩溃 → `session.status error` + 可一键 resume 重开
- WS 断线 → 客户端指数退避重连，重连后 `sessions.list` + 对每个打开的会话重新 `session.open`（runner 若还活着直接复用）
- 权限请求超时无人答 → 不超时，保持 waiting；用户关闭页面后 runner 保留 10 分钟再回收
- `claude` 子命令非零退出 → 把 stderr 原样显示在配置中心

## 测试

- server：vitest。`transcript.ts` 用真实 jsonl 样本做快照测试；`registry.ts` 用临时目录；`permission-bridge` 用假 runner
- web：vitest + testing-library 测 reducer（消息树合并、子代理挂载、流式 delta 拼接）
- 端到端：启动 server，用 Chrome 打开，发一条 "list files" 走完权限弹窗 → 看到工具卡片 → 看到结果

## 分阶段

1. 骨架：server + SDK runner + WS + 会话列表 + 打开/resume + 流式对话 + 基本工具卡片
2. 交互：权限弹窗、AskUserQuestion、计划模式审批、slash 面板、模型/effort/权限切换、中断、thinking
3. 面板：任务树 + 子代理对话、文件 diff、用量、轨迹 tab
4. 配置中心：插件 / MCP / skills / hooks / agents / 登录状态
5. 兜底终端 + 打磨
