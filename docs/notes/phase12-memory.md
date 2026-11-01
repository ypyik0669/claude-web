# 跨 agent 共享记忆（阶段 12，2026-09-04）

现在只有 Claude，记忆是对话之间共用的（见「只留 Claude」）。

- **`node:sqlite` 里已经编译了 FTS5**，不用加依赖（实测过）。库在 `~/.claude-web/memory.db`，scope = global / project(cwd) / session，kind = decision / constraint / fact / deadend / preference / note。
- **FTS5 不分词中文**，整句会变成一个 token，`"最小化"*` 永远匹配不上句子中间。`hasCjk()` 把中文查询走 LIKE 回退（`service.test.ts` 有回归用例）。项目检索永远把 global 一起带上；project key 做过大小写与分隔符归一。
- **注入不改用户自己的配置文件**（`memory/launcher.ts` 一处收口）：Claude 走 Agent SDK 的 `mcpServers`（只给我们起的进程）。总开关是设置里的 `memory.mcp`（设置 → 共享记忆），下次开会话生效。（历史：以前还有 ACP agent 的 `session/new` `mcpServers` 和 Codex 的 `-c mcp_servers.*` 两条，随「只留 Claude」删了。）
- **交给 agent 的服务器名是 `claude-web-memory`，不是 `memory`**（2026-10-19 用户报告）。`memory` 是官方 `@modelcontextprotocol/server-memory` 装上后的名字（我们自己的连接器目录里就有这一项），而宿主传进去的同名服务器会顶掉用户配置里的：Claude 的 SDK `mcpServers` 按名字覆盖（当时的 Codex `-c mcp_servers.memory.*` 更糟——逐字段并进用户那条）。结果是连接器页显示「已连接」，对话里拿到的却是我们的。选了「我们换个没人用的名字」而不是「检测到冲突才改名」：后者要读用户的配置（~/.claude.json、.mcp.json，当时还有别的 agent 的），而 app 里没有任何地方按服务器名认我们的工具（没有 allow 列表、工具卡注册表也不认 `mcp__memory__*`），改名只动 `launcher.ts` 一处（`MEMORY_MCP_NAME`）。代价：工具名变成 `mcp__claude-web-memory__memory_search`，以前对 `mcp__memory__…` 点过「总是允许」的要再允许一次。用户自己那条 `memory` 不用改，现在两边各用各的。
- 打包后 MCP 入口在 asar 里：`ELECTRON_RUN_AS_NODE=1` 起 Electron 二进制读 `app.asar/server/dist/memory/mcp.js` 是可以的（实测握手通过）。
- 自动萃取只收「死路 / 决定 / 约束」，每个会话最多 12 条；相同文本在同一 scope 里视为同一条（只加命中数）。
- `server/ws-phase12.mjs` 用**真的 JSON-RPC over stdio** 驱动 MCP server（agent 怎么调它就怎么调），断言 UI 写的 agent 能读到、agent 写的 UI 能读到。
