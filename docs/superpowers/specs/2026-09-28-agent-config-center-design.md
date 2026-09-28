# 其它 agent 的配置中心 设计（子项目 5）

日期：2026-09-28 · 状态：用户授权一次性实施

## 目标

在 claude-web 里管理 Claude 以外的 agent 的配置（对应 AiMaMi 的配置管理）：MCP 服务器、项目 / 全局说明文件、模型与常用选项，并能把一份 MCP 配置同步到多个 agent。

## 约束

- **优先官方 CLI**：有子命令的一律走子命令（`codex mcp list/add/remove`、`gemini mcp list/add/remove`、`qwen mcp …`、`opencode mcp …` 以本机 `--help` 实测为准，不存在就不开放）。
- 没有 CLI 的配置项才直接编辑配置文件，且：只改用户点名的那个键（TOML / JSON 结构化读写，保留其余内容与注释能保留则保留），写前备份到 `<dataDir>/config-backups/<agent>/<ts>-<file>`，写后重新解析校验失败就回滚。
- 说明文件（`AGENTS.md`、`GEMINI.md`、`QWEN.md` 等，全局与项目级）是用户文档，直接用现有 Monaco doc tile 打开编辑即可。
- 测试不碰真实 `~/.codex`、`~/.gemini`：所有路径跟随 HOME / 各 agent 的 home 环境变量（`CODEX_HOME` 等），测试用临时 HOME + 假 CLI。

## 设计

- `server/src/agent-config/`：每个 agent 一个 `AgentConfigAdapter { kind; detect(); files(cwd?) → {label, path, exists}[]; mcpList(); mcpAdd(spec); mcpRemove(name); settings(): 字段表 + 当前值; setSetting(key, value) }`。首批：Codex（`~/.codex/config.toml`：model、model_reasoning_effort、approval_policy、sandbox_mode；MCP 走 `codex mcp`）、Gemini（`~/.gemini/settings.json`：model、theme 之类不做，只做 model / mcpServers 走 `gemini mcp`）、Qwen（同 Gemini 形状）、OpenCode（`opencode.json`，MCP 若无 CLI 则结构化编辑 `mcp` 键）。字段表只列实测存在的键。
- **MCP 同步**：选一个 Claude 的 MCP 服务器（`claude mcp list` 已有）或目录里的条目，勾选目标 agent → 逐个 adapter `mcpAdd`，结果逐行报告成功 / 失败原因；stdio / http 两种，env 与 header 支持，密钥类值不回显。
- WS：`agentConfig.list`（每个 agent 的检测状态、文件、MCP、设置）、`agentConfig.mcp.add/remove/sync`、`agentConfig.set`、`agentConfig.backups`、`agentConfig.restore`。

## 界面

设置 → CLI Agents 每个 agent 卡片展开出「配置」：说明文件（全局 / 当前工作区，点开进 doc tile，不存在可一键创建）、MCP 列表（增删、从 Claude 同步）、设置字段（下拉 / 输入，改动即写并提示已备份）、备份列表（恢复）。

## 测试

- 单元：TOML / JSON 定点修改保留其它内容、备份与回滚、每个 adapter 用假 CLI（记录 argv 的脚本）断言命令形状。
- 端到端 `server/ws-phase17.mjs`：临时 HOME + 假 `codex` / `gemini` 可执行（放 PATH 前面），走一遍 list / add / sync / set / restore。加入 `scripts/e2e.mjs` 默认列表。
