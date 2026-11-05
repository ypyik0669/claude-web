# 其它 agent 的配置中心（2026-09-28）

- **位置**：`server/src/agent-config/`，每个 agent 一个 adapter（`codex.ts`、`gemini.ts`（Gemini / Qwen 共用，`Flavor` 区分）、`opencode.ts`），`service.ts` 汇总 + 打码，`handlers.ts` 处理 `agentConfig.*`（hub 里只有一行 `isAgentConfigRequest` 分发）。UI 是设置 → Agents 与子代理 → 其它 Agent 卡片上的「配置中心」（`web/src/features/settings/AgentConfigPanel.tsx`，表单纯函数在 `agent-config-form.ts`）。
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
- **接入页的「各 Agent 的配置文件」**（2026-10-28）：`selections.ts` 把 `registry.ts`（7 个 agent 的模型 / 强度键）和 `drift.ts` 接上 `agentConfig.selections / selection.apply|reapply|accept|restore`。记录在 `<dataDir>/agent-selections.json`：每个 agent 我们最后写的值（`expected`）+ 第一次写之前的还原点；没被我们写过的 agent 没有记录、永远不算漂移。WSL 孪生只读，取 `WslService` 已 check 过、知道 home 的发行版（不额外起 wsl.exe）。
- **Claude 订阅桥**（`channels/drivers/claude-bridge*.ts`，参考 Magpie claudebridge）：目录项 `claude-bridge`，加了才起 127.0.0.1 随机端口 + 随机 key 的 Anthropic 端点，供应商档案指过去（channelLinks 的 `engine: 'claude-bridge'` 让 ProviderDriver 不重复列）。每个请求起一次 `claude -p` stream-json（`--tools ''`、空 MCP、`--setting-sources project` + 空临时目录、`--settings` 清 ANTHROPIC_*），env 是白名单；`loopRisk` 每次都查（代理指向自己端口、managed settings 的本地 BASE_URL / apiKeyHelper → 508）。并发 2（超出 429）、空闲 2 分钟 / 整体 10 分钟超时、客户端断开就杀。只支持纯文字：带 tools 的请求 400。测试用 `claude-bridge.fake-cli.mjs`。
  - Windows 上 `claude` 是 npm 的 `.cmd` 垫片，经 cmd.exe 跑：JSON 参数（`--mcp-config` / `--settings`）写成运行目录里的文件再传路径，
    spawn 带 `windowsVerbatimArguments: via === 'cmd'`。只用假 CLI 测不出来，2026-10-28 用真 CLI（2.1.306）跑通了普通和流式各一次。

## 在界面里登录 Codex（2026-11-05，用户要求：设置里的「登录」只是开终端敲 codex login）

- `server/src/agents/codex-login.ts`：起一个短命的 `codex app-server`（跟对话用同一个命令，`registry.launch('codex')`），走它自己的账号接口：
  `account/read`（谁登录着：`{account:{type:'chatgpt',email,planType}}` / `apiKey` / `null`）、`account/login/start`
  （`{type:'chatgpt'}` → `authUrl`，Codex 自己在 1455 端口收回调；`{type:'chatgptDeviceCode'}` → `userCode` + `verificationUrl`）、
  通知 `account/login/completed {loginId, success, error}`、`account/login/cancel`、`account/logout`。令牌仍在 `~/.codex/auth.json`，claude-web 不存。
  协议从 `codex app-server generate-json-schema --out <dir>` 生成的 `v2/LoginAccount*.json` 查到（0.163）。
- 登录成功 → `askModels('codex', true)` 立刻重新要模型列表（套餐变了列表就变）；退出也一样。
- 请求 `agents.codex.account / login.begin / login.status / login.cancel / logout`；联邦里一律拒绝（另一台机器不能登录 / 退出这台的 Codex）。
- 界面：`settings/CodexLoginDialog.tsx`（`openCodexLogin()`，App 里挂一次 `CodexLoginHost`）；入口 = 设置 → CLI Agent 的 Codex「登录」，
  和模型菜单里 Codex 那一节标题右边的「登录 / 换账号」（只在 Codex 用自己的登录时出现）。
- 真机：本机 Codex 0.163 读到 `plan: free`（所以 `model/list` 只有三个），`login/start` 回 auth.openai.com 的地址，cancel 正常。
