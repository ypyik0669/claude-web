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

## 结构

- `server/src/protocol.ts` — 前后端共享协议类型（web 通过 `@shared` 别名引用）
- `server/src/runtime/session-runner.ts` — 一个活动会话 = 一个 SDK query（streaming input，跨轮）
- `server/src/sessions/service.ts` — 会话列表/历史（SDK listSessions 等）+ chokidar 监听
- `server/src/config/service.ts` — 插件/MCP/skills/agents/hooks/auth，调 `claude <子命令>`
- `web/src/model/conversation.ts` — 纯函数 reducer，SDK 消息 → 消息树
- `web/src/store/index.ts` — zustand，所有 WS 事件在这里进 reducer
