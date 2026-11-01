# 环境与对话：跨对话工具 / 任务 chip / 选机器 / worktree 设置 / 文件右键 / 本机环境变量 / 深链接（2026-10-16）

五期「赶上官方桌面版」路线的第 4 期。spec：`docs/superpowers/specs/2026-10-16-sessions-env-design.md`。依据：官方
`desktop.md`、`worktrees.md`、`cross-session-messaging.md`（code.claude.com/docs，`.md` 才抓得到正文）。

## 跨对话工具（`server/src/sessions-mcp/`）

- **进程内 MCP**：SDK 的 `createSdkMcpServer` + `tool`（zod v4），工具在本进程里跑，挨着 pool 和 library——不用起子进程、
  不用发 token。runner 建 query 时 `mcpServers.sessions`（开关 `sessions.mcp`，默认开；`setSessionsDeps` 在 index.ts
  接 library / pool）。
- 工具：`list_sessions`（不含自己、不含联邦对话，最近的 20 个）、`read_session`（最近 N 轮的用户消息和最后的回答，不含工具）、
  `send_to_session`、`rename_session`、`archive_session`、`suggest_task`。除 archive 外都进 `allowedTools`
  （`SESSIONS_ALLOWED`）；archive 走这个对话自己的权限模式（官方也是归档前才问）。
- 投递：消息包成 `<cw-from session="…" title="…">…</cw-from>`；接收方在跑就等这一轮结束再发（`deliver.ts` 的
  `sendWhenIdle`，30 分钟放弃）；没开着的对话 `pool.open` 重新拉起（供应商 / 权限模式按 meta 恢复）。归档的、别的机器上的不投。
- 前端：`decodeAttachments` 认出整条消息是 `<cw-from>` → `UserItem.from`，气泡顶上「来自『标题』」，点了跳过去。
  只认**整条**都是标记的消息，别人正文里引用的不算。
- 真机实测（haiku，2026-10-16）：官方二进制 list → read → send 一次通过。（历史：ccb 把 MCP 工具包在 `ExecuteExtraTool` 里、
  runner 为它放行的分支已随 ccb 删掉，见「只留 Claude」。）

- **项目范围（阶段 F2）**：项目页「跨对话工具只看见本项目的对话」= `Workspace.sessionsScope: 'project'`。`SessionsDeps.projectOf(id)` / `restricted(selfId)`（index.ts 用 `meta/project.ts` 的 `projectOf`：meta.workspaceId，否则主文件夹 == cwd / groupCwd）；`scopeSessions()` 过滤 list 和 `find`（读 / 发 / 改名 / 归档别的项目的对话都报「找不到」）；`list_sessions` 也可以自己传 `scope: 'project'`。不在任何项目里的对话只看得见同样不在项目里的。

## 任务 chip

- `suggest_task { title, prompt, worktree? }` 立刻返回；卡片 `features/chat/tools/TaskChip.tsx`（注册表 standalone）。
  「在新对话里做」：旁边分屏、同一目录、是仓库且 worktree 不为 false 时开 worktree（名字 `task-chip-model.ts`：标题的
  ASCII slug，中文标题用 `task-MMDD-HHMM`），发 prompt。会话 meta `taskStarted`（工具 id → 新对话）/ `taskDismissed`。

## 新对话选机器

- 欢迎页项目 chip 左边的机器 chip（`MachineChip.tsx`，只在有 peer 时出现，`peers.list`）。选了 peer：目录只从那台机器的对话
  用过的里选（本机的对话框看不到那边的盘）、不显示分支 chip、@ 补全关、本机文件附件不让发（图片可以）。
- `session.open` 的 `params.peer` → `federation/rewrite.ts` 的 `planRoute` 直接转发给那台、`outbound` 去掉 `peer`，回来的
  id 照常加 `peer_<id>~`。带 sessionId 又带别的 peer → 拒绝。发过去的只有 cwd / 权限模式 / worktree：本机的供应商、模型、能力开关
  在那边没有意义，用那台机器自己的默认。没在两台真机上跑过。

## worktree 位置与分支前缀

- 设置（新对话 → 更多选项）`worktree.dir` / `worktree.prefix`，都空 = 照旧交给 CLI 的 `--worktree`（`.claude/worktrees/<名>`，
  分支 `worktree-<名>`，CLI 自己处理 `.worktreeinclude`）。任一有值：hub 的 `session.open` 自己 `git worktree add`（位置
  `<dir>/<仓库名>-<名>`，分支 `<前缀><名>`），拷 `.worktreeinclude`，以 worktree 为 cwd 开对话，会话 meta `groupCwd` = 仓库根。
- `.worktreeinclude`（`git/worktree-include.ts`）：让 git 做匹配——`ls-files --others --ignored --exclude-standard` 和
  `--exclude-from=.worktreeinclude` 两次的交集，所以只拷「列出了且被忽略」的文件，被跟踪的永远不拷。
- wording 闸：「worktree」只能以 `TERMS.worktree` 出现；占位文字和文件名进了 `WORKTREE_CODE` 例外表。

## 文件右键菜单

- `features/files/FileMenu.tsx`：`fileMenuProps(path, sessionId)` 撒到元素上，`<FileMenu/>` 在 App 挂一次。加到下一条消息
  （`MENTION_EVENT` → 输入框加 `@相对路径`）、用 VS Code / Cursor / Zed 打开（`shell.editors` 只列装了的：`where`/`which`，
  mac 再看 /Applications）、在资源管理器 / 访达中显示（`shell.open` 的 `reveal`：Windows `explorer /select,"…"` 要
  `windowsVerbatimArguments`）、复制路径。远端对话只有复制。接在 FileLink、改动卡、审阅文件头；文件树有自己的右键菜单，没动。

## 本机环境变量

- 设置 → 环境变量 第一块。存 `<dataDir>/local-env.json`（名字 → `enc:…`，SecretService），**不进 meta.json 的 settings**：
  settings 会发给所有客户端（含配对的手机），Linux 上 `enc:plain:` 只是 base64。列表只给名字，值要 `env.reveal`。
- 作用：runner 的 `featureEnv` 最底层（供应商的变量和对话自己的 `features.env` 都盖过它）、终端 pty。选模型 / 账号的
  名字（`ANTHROPIC_*`、`CLAUDE_CODE_*`、`CLAUDE_WEB_*`、`CW_*` 等；`OPENAI_*` / `GEMINI_*` 还在拒绝表里）存的时候就拒。新开的对话 / 终端生效。

## 深链接

- `desktop/src/deep-link.ts`：`claude-web://new?folder=&q=&peer=`（folder 必须是存在的目录、q 截 1 万字、peer 名字白名单字符）、
  `claude-web://session/<id>`。主进程存 `pendingLink`，页面 ready 时 `desktop:deepLink:take` 取一次，之后的链接发 nudge 再取。
  `electron-builder.yml` 的 `protocols` 让安装包注册；**只有打包版 `setAsDefaultProtocolClient`**（开发运行会把系统的链接抢过来）。
  `new` 只预填新对话页，从不自动发送。**桌面版里没真点过链接**（只有解析的单测）；设置里的示例行没做。

## 分屏快捷

`Ctrl+\` 关聚焦的分屏（只剩一个时不动）；侧栏 Ctrl/Cmd+点击在旁边分屏打开（以前是开新标签）。

## 坑

- bash 里 `node -e "…"` 写带反引号的注释 / 模板串会被 shell 执行掉（这期两次）：改用 Write / Edit 或脚本文件。
- 测试里 mock 了 SDK 的地方（`session-runner.test.ts`）要补 `createSdkMcpServer` / `tool`，否则开了 sessions 工具就崩。

## 独立验证查出、已修（2026-10-16）

- 深链接的 folder 是网络路径（`\host\share`）时，光是问「这个目录在不在」Windows 就会去 SMB 登录那台机器，把 NTLM 哈希交出去：
  `localFolder()` 先挡掉网络路径和相对路径，`isDir` 根本不会被问到。
- 「worktree 放在哪」填相对路径或 `~`：以前原样拼接，worktree 建进了仓库里；现在 `resolveWorktreeDir` 展开 `~`，不是本机完整路径就报错。
- 任务 chip 在别的机器的对话里点「在新对话里做」开到了本机：现在带上那台机器；同名任务的 worktree 名字带建议 id 的尾巴，不会撞。
- 本机环境变量：`__proto__` / `constructor` 之类不是变量名；Windows 上 `PATH` 和 `Path` 是同一个，第二种写法拒绝。
- 跨对话：同一个对话 10 分钟内最多收 10 条别的对话发来的消息（两个对话互相「告诉对方」会无限互答）；定时任务的对话不投递。
- 已知风险（没改）：发送方的权限模式比接收方严时，消息会在接收方更宽的权限下执行——接收方本来就是用户自己开的对话。

## 阶段 E：WSL 里的对话（2026-10-25）

- **`SessionEnv`**（`{ kind: 'wsl', distro }`）写进 meta（`env`），pool 恢复对话时读回来；新对话「选机器」的值是一个字符串：
  `''` 本机 / `wsl:<distro>` / peer id（`composer/machine.ts`）。
- **runner**：spawn 钩子换成 `wsl/spawn.ts`：`wsl.exe -d <d> --cd <linux cwd> -- claude <同样的 CLI 参数>`（参数里的 Windows
  路径换成 /mnt/…）。跑的是**发行版自己装的官方 CLI**，用它自己的登录；不走供应商（WSL 的 NAT 下
  127.0.0.1 不通）。WSLENV 列出 runner 额外加的变量。
- **注入的 MCP**（记忆、联网、操控电脑……）是 Windows 程序：经互通用 /mnt 路径启动，参数保持 Windows 路径，env 用 `WSLENV …/u`。
  互通关了就去掉它们，`info.wsl.dropped` 列出来，输入框下面一行灰字说明。
- **检查**：`sh -lc` 打印 home、`command -v claude`、互通状态。真机上 `command -v claude` 会找到 `/mnt/c/…/nodejs/claude`
  ——WSL 把 Windows 的 PATH 接在后面，那是 Windows 安装的 npm 垫片，发行版里跑不了：`/mnt/` 开头的一律算没装。
- **对话记录**在发行版里（`\wsl.localhost\<d>\home\…\.claude\projects`）：`addTranscriptRoot` 加额外根，启动时把有 WSL 对话
  的发行版都加上；历史也从那里读。
- **文件 / Git / 终端**：`\wsl.localhost\<d>` / `\wsl$\<d>` 进 FilesService 的允许根；git 对这些路径加 `-c safe.directory=*`
  （文件属主是 Linux 用户）；终端 `wsl: { distro }` → `wsl.exe -d <d> --cd <path>`；「在终端中继续」→
  `wsl.exe -d <d> --cd <linux cwd> -- claude --resume <id>`。
- **安装**：`wsl.installCommand` 只返回命令原文，用户在确认框看见后才 `wsl.install { confirmed: true }`；没有 confirmed 拒绝。
- 联邦：带 WSL env 的 session.open 不转给 peer；peer 发来的 `wsl.*` 拒绝。
