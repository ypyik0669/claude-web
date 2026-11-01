# 会话内核：canonical / 热切换 / 交接（阶段 11，2026-09-04）

- **`server/src/session/canonical.ts`**：规范时间线，写 `~/.claude-web/canonical/<sid>.jsonl`。只留跨进程 / 跨机器用得上的东西：用户消息、助手正文、工具调用（归一名 + 输入 + 结果摘要）、系统提示、用量、供应商切换。**thinking 一律丢弃**（带 `signature`，换个供应商 / 账号就失效）。（历史：原来是为了在 Claude 和 Codex 等别的 agent 之间交接，2026-11-01 其它 agent 删了，见「只留 Claude」。）
- **用户消息谁都不回显**：SDK 不会把用户那条发回来，所以在 hub 的 `session.send` 里直接记进 canonical，别指望从消息流里捞（给窗口看的回显是单独的 `sent` 事件，不进 canonical，见「已踩的坑」第二条）。
- **供应商热切换 = 用户看不见的重启**：CLI 进程的 env 在 spawn 后不可变，`session.setProvider` 是停子进程 → 用新 env 重开 → 从最后一个 uuid 原生 resume（`session/swap.ts` 的 `swapProvider`）。会话 id、标题、历史、面板全不变，只插一条系统行；切换记进 canonical（用量按时间段算供应商靠它）。
- **交接到 Claude 走 Agent SDK 的 `SessionStore.load()`**（受支持的 API，返回的 entries 会被物化成临时 JSONL 让子进程 resume），不要去伪造 `~/.claude/projects` 的文件。`handoff.ts` 的 `renderBriefing()` 写简报（已决定什么 / 磁盘现状 / 试过失败的方案 / 当前目标，并明说推理过程没带过来），`toClaudeEntries()` 额外保证 parentUuid 链不断。现在的用处：其它电脑上的对话「在本机继续」（`swap.ts` 的 `handOverToClaude`）、对话库里 claude.ai 记录「接着聊」、编排。
