# 其它 agent 的配置中心 实现计划（子项目 5）

spec：`docs/superpowers/specs/2026-09-28-agent-config-center-design.md`

## 实测的 CLI 形状（2026-09-28，本机只读 / 临时 HOME）

| agent | 版本 | MCP 子命令 | 备注 |
| --- | --- | --- | --- |
| Codex | 0.155.0-alpha.16 | `codex mcp list --json` / `add <name> [--env K=V]… -- <cmd> <args…>` / `add <name> --url <u> [--bearer-token-env-var V]` / `remove <name>` | 同名 add 直接覆盖；remove 不存在的名字 exit 0 + `No MCP server named`；**没有自定义 header 参数**；只支持 stdio 与 streamable HTTP（无 SSE）；home = `CODEX_HOME` 或 `~/.codex` |
| Gemini | 0.41.2 | `gemini mcp add -s user [-t stdio\|sse\|http] [-e K=V]… [-H "K: V"]… <name> <cmdOrUrl> [args…]` / `remove -s user <name>` / `list` | `list` 会逐个连接服务器测状态（慢、会起进程），所以列表直接读 `settings.json`；http 写成 `{url, type:"http"}`；home = `GEMINI_CLI_HOME`（替换 home 目录，下面再 `.gemini`）；模型键 `model.name`，审批 `general.defaultApprovalMode`（default / auto_edit / plan） |
| Qwen | 未安装；读 npm 包 `@qwen-code/qwen-code@0.24.6` 的 bundle | 与 Gemini 同形（`-s` 默认 user，http 写成 `httpUrl`，支持 `--`） | 目录 = `QWEN_HOME` 或 `~/.qwen`；模型键 `model.name` |
| OpenCode | 1.14.33 | `opencode mcp add` 是**交互式**向导（无参数），没有 remove | MCP 改为结构化编辑 `opencode.json(c)` 的 `mcp` 键；全局目录 `$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode` |

## 任务

1. **定点编辑与备份**（`server/src/agent-config/edit.ts`、`backup.ts`，测试 `edit.test.ts`、`backup.test.ts`）
   - `setTomlTopLevel(text, key, value)`：只改首个表头之前的那一行，其它行（含注释）原样；`undefined` 删除该键。
   - `appendTomlTable(text, path, obj)`：在文件末尾追加一个表（Codex header 用）。
   - `setJsonPath(text, path, value)`：jsonc-parser 的 `modify/applyEdits`，保留注释与格式。
   - `BackupStore`：`<dataDir>/config-backups/<agent>/<ts>-<file>` + `index.jsonl`；`writeChecked()` 写前备份、写后重新解析，失败回滚；`restore(id)` 先备份当前再覆盖。
2. **CLI 执行**（`cli.ts`）：`resolveSpawn` 解析 `.cmd` 垫片，env = 进程 env + 该 agent 的 `agents.<kind>.env`，60 s 超时，非零退出码 / 已知失败文本 → throw。
3. **Adapter**（`codex.ts`、`gemini.ts`（Gemini / Qwen 共用）、`opencode.ts`，测试 `adapters.test.ts` 用记录 argv 的假 CLI）：`files(cwd)`、`mcpList()`、`mcpAdd(spec)`、`mcpRemove(name)`、`settings()`、`setSetting(key, value)`。
4. **服务 + WS**（`service.ts`、`handlers.ts`、`types.ts`）：`agentConfig.list / get / claudeMcp / mcp.add / mcp.remove / mcp.sync / set / createFile / backups / restore`。hub 只加一行分发，protocol.ts 只加 `export type *` 与联合类型一行。
5. **界面**（`web/src/features/settings/AgentConfigPanel.tsx`）：CLI Agents 卡片多一个「配置中心」按钮，展开出说明文件 / MCP / 设置字段 / 备份四块；MCP 同步对话框（来源：Claude 的 MCP 或手填，勾选目标）。
6. **端到端** `server/ws-phase17.mjs`：临时 HOME + 假 `codex` / `gemini`（node 脚本 + npm 形状的 `.cmd` 垫片，放 PATH 最前），自己起一个 server；加入 `scripts/e2e.mjs`。
7. 文档：CLAUDE.md 小节、README 使用说明；截图验证。

## 裁决

- **列表读文件、写走 CLI（Gemini / Qwen）**：`gemini mcp list` 会真的连接每个服务器（起 stdio 进程、发 HTTP），既慢又有副作用；列表改为只读解析 `settings.json`。Codex 的 `mcp list --json` 是纯读，照常走 CLI。代价：Gemini 扩展（extensions）带来的 MCP 不在列表里。
- **Codex 自定义 header**：CLI 没有参数，先 `codex mcp add --url`，再对 `[mcp_servers.<name>.http_headers]` 做结构化追加（有备份与回滚）。`Authorization: Bearer <x>` 同样按 header 写入（`--bearer-token-env-var` 需要的是环境变量名而不是值）。Codex 不支持 SSE，同步时明确报失败。
- **OpenCode 的 MCP 走文件编辑**：`opencode mcp add` 是交互式向导，headless 用不了，也没有 remove。
- **CLI 改写前也备份**：spec 只要求直接编辑前备份；CLI 会重写整个文件（Codex 会把内联表展开），所以任何写操作前都备份一次，恢复入口统一。
- **只做用户级 MCP**：Codex 只有全局；Gemini / Qwen 的项目级 `.gemini/settings.json` 会被 git 带走，默认不碰。
- **Qwen 的设置字段只列 `model.name`**：本机没装，只从 bundle 确认了这一个键；审批模式等不开放。
- **同步不覆盖同名**：目标已存在同名服务器时默认报失败，勾选「覆盖」才重写（Codex / Gemini 的 add 本身会静默覆盖）。
- **密钥不回显**：列表里 env / header 的值一律 `••••••`；从 Claude 同步时由服务端按名字读取原配置，值不经过前端。
- TOML 定点改只支持单行的顶层键（本次开放的四个键都是单行字符串）；键的值若是多行结构就报错不改。
