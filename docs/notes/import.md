# 从其它工具导入（2026-10-17，用户要求）

用户转来一句反馈「我的意思是 Hermes 的配置迁移到你的项目」，要求「适配所有的，比如上一个任务的 Mirasim，这次的 Hermes，还有其他所有 IDE 或者 agents」。

## 是什么

- 入口两个：设置 → 供应商 的「从其它工具导入…」（`ConfigPanel.tsx` 的 `ProviderProfiles`，先勾供应商），扩展 → 连接器 的同名按钮（`Connectors.tsx`，先勾 MCP）。同一个对话框 `web/src/features/providers/ImportDialog.tsx`：按工具分组，每行一个供应商或 MCP 服务器，已经有的标「已有」不能勾，其余默认勾上（只勾打开它的那一类）。
- 请求：`import.scan`（只给名字、地址 / 命令行、有没有 key、模型数、是否已有——**key 不上 wire**）、`import.run { keys }`（服务端重新扫一遍，按 key 导入；导入的供应商随后拉一次模型列表再回答）。都在 `GOES_OUT`。
  「已有哪些 MCP」只读 `~/.claude.json` 的 `mcpServers` 名字（`ConfigService.mcpUserNames`）——别用 `config.mcp()`：它跑 `claude mcp list`，会把每个服务器都起一遍检查，负载高时超过 15 s，对话框一直空着（ui-smoke 抓到的）。
- 导到哪：供应商 → `ProviderService.upsert`（key 照常加密存）；MCP → `ConfigService.mcpAdd(name, json, 'user')`，也就是 `claude mcp add-json -s user`（所有项目可用，新对话起生效）。同名的 MCP、同类型 + 同地址（`sameBase`：大小写、结尾 `/`、结尾 `/v1` 不算不同）+ 同 key 的供应商算「已有」，跳过，不覆盖。
- **只出 Anthropic 格式的供应商**（2026-11-01「只留 Claude」）：下面的读取器仍认得各工具里 OpenAI / Gemini / Grok 格式的配置（`FoundProvider.type`），但 `scanAll` 只交出 MCP 和 `type: 'anthropic'` 的供应商（`Usable`），别的格式不进对话框。CLIProxyAPI / Magpie 两个来源随模型网关一起删了。

## 来源（`server/src/import/scan.ts` 的 `SOURCES`，全部只读）

| 来源 | 读什么 |
| --- | --- |
| Hermes Agent | `~/.hermes/config.yaml`（`model.base_url/default/provider`、`custom_providers`、`mcp_servers`）+ `~/.hermes/.env`（`OPENROUTER_API_KEY` 等，按 `KNOWN` 表配上默认地址）；`HERMES_HOME` 可改目录。**本机没装 Hermes，格式按它公开的文档写，测试用的是自造的样例。** |
| CC Switch | `~/.cc-switch/cc-switch.db` 的 `providers`（Claude 的 env、Codex 的 auth + toml、Gemini 的 env、OpenCode / Hermes 的 OpenAI 兼容配置）和 `mcp_servers`。**复制到临时目录再开**：库常带热日志（`-journal`），只读打开也会就地回滚（`attempt to write a readonly database`）。 |
| Codex | `~/.codex/config.toml` 的 `model_providers`（key 取 `experimental_bearer_token` / `env_key` 指的环境变量 / `auth.json` 的 `OPENAI_API_KEY`）和 `mcp_servers` |
| OpenCode | `~/.config/opencode/opencode.json(c)` 的 `provider`（`options.baseURL/apiKey`，`{env:X}` 展开）和 `mcp`（命令和参数在一个数组里）；`~/.local/share/opencode/auth.json` 里登录过的内置供应商 |
| Continue | `~/.continue/config.yaml` / `config.json` 的 `models`（provider / apiKey / apiBase）和 `mcpServers` |
| Cursor / Windsurf / Kiro / Claude Desktop / Gemini CLI / Qwen Code | 各自的 `mcpServers` 文件 |
| VS Code / Cline / Roo Code | `Code/User/mcp.json` 的 `servers`、settings 的 `mcp.servers`；Cline / Roo 在 globalStorage 下的 MCP 设置 |
| Zed / Goose | `context_servers`（`command: { path, args }`）/ `extensions`（stdio / sse） |
| Ollama | 在跑就读 `/api/tags`（800ms 超时）；是 OpenAI 兼容格式，现在会被 `scanAll` 滤掉（读取器还在） |
| Mirasim / Cherry Studio | **读不了**：Mirasim 把设置加密（`secret-key.enc`）存在 IndexedDB，Cherry Studio 存在浏览器数据库。只报「在，但读不出来」，对话框里请用户从它的设置里复制地址和 key 用「快速添加」。没有逆向它们。 |

只写了地址的（Cursor、Claude Desktop）路径以 `/sse` 结尾就按 SSE 导入，写了 `type` / `transport` 的照写的。MCP 的各种写法统一成 `{command,args,env}` 或 `{type:'http'|'sse',url,headers}`（`mcpOf`），`disabled:true` / `enabled:false` 的不要。

2026-10-30（用户报告：装了 Pencil 桌面应用，连接器只认出 VS Code 插件那份）：
- 加了 VS Code Insiders、VSCodium、Trae / Trae CN、Antigravity（`~/.gemini/antigravity/mcp_config.json` + 它的 User 目录）、LM Studio（`~/.lmstudio/mcp.json`）；Cline / Roo 在 `editorUsers()` 列的每个 VS Code 系编辑器的 globalStorage 里都找。
- **Pencil**：它的插件把 MCP 写进 Codex / Gemini / Claude Code / Kiro 等的配置，命令指向插件目录里**带版本号**的 exe（`…/highagency.pencildev-0.6.49-universal/out/mcp-server-windows-x64.exe --app antigravity`），插件一升级旧目录就没了——本机实测这些路径全都不在了。Pencil 另外在 `~/.pencil/mcp/<app>/out/mcp-server-<os>-<arch>` 留一份不带版本的，`pencil` 来源读这个（参数 `--app <app>`，有几份就叫 `pencil-<app>`）。这是从本机目录推出来的布局，不是 Pencil 的文档。
- 命令是绝对路径、文件却不在的 MCP 标 `missing`，导入框写「程序不在了」，默认不勾（`commandMissing`）。已经导进来的可以在连接器里编辑（见「配置中心 / 自动化 / 打磨」的「编辑已装的 MCP」）。

## 测试

- `server/src/import/scan.test.ts`：临时 HOME 里按各工具的格式造文件（Hermes yaml + .env、cc-switch 的 SQLite（检查原文件字节不变）、Codex toml + 环境变量 key、OpenCode、Cursor 带注释的 JSONC、Claude Desktop、Zed、Mirasim / Cherry 的目录），以及 ImportService：scan 里没有 key、已有的跳过、失败的带原因、扫描后消失的报 gone。
- ui-smoke `settings:import`：打开对话框、读完、页面里没有 key、取消能关。
- 真机：本机跑过扫描（cc-switch 3 个供应商 + MCP、Codex / OpenCode / Gemini / Kiro / VS Code 的 MCP，Mirasim / Cherry 标为读不了），输出里没有 key。
