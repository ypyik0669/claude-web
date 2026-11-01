# 渲染与对话交互（阶段 1，2026-09-03）

- **reducer 是唯一真源**：`web/src/model/conversation.ts` 纯函数，`web/src/model/__fixtures__/tools.jsonl` 是用 `server/ws-capture.mjs` 录的真实流（Read 文本+图片 / Glob / Grep / Bash / WebFetch / TodoWrite），`conversation.test.ts` 回放它。改 reducer 先跑 `npm test -w web`。
- **发送时客户端铸 uuid**（`SendParams.uuid` → `SDKUserMessage.uuid`），本地回显 id 就是 transcript uuid，编辑重发 / 重跑 = `openSession({sessionId, resumeAt: findChainUuidBefore()})` 再发。uuid 会落到 jsonl（当时的 ccb 不回显 `user_message_uuid`，靠的就是这个）。
- **工具输出优先用 `tool_use_result`（`result.structured`）**：SDK 的 `sdk-tools.d.ts` 有每个工具的 Output 形状（`structuredPatch` 带行号、`FileReadOutput` 的图片 base64、`GrepOutput.mode`…）。卡片 `numLines` / `numMatches` 两个都认（`numLines` 是当时 ccb 的 GrepOutput 用的，老对话里还有）。
- 工具卡片在 `web/src/features/chat/tools/registry.tsx` 注册（图标 / 分类 / 头部文案 / Body）；`mcp__*` 和未知工具走 `GenericBody`（键值网格 + JsonTree + 图片）。Steps 折叠的分类计数也从注册表取。
- 健康信号（`model/health.ts`）：卡死判定是客户端计时（15s 无事件、3 分钟无模型调用）。`conv.lastModelCallAt` 是整个对话的，不按轮清零：早于 `turnStartedAt` 的不算这一轮的；这一轮一次模型回复都没有时从 `turnStartedAt` 算 3 分钟，报 `no_reply`（「N 分钟还没收到模型的任何回复，供应商「X」可能没有响应」）——以前上游从头到尾不回时界面只有一个一直走的计时器（2026-09-30 用户报告）。错误分类 `classifyError()` 输入 `api_retry.error` / `result.terminal_reason` / HTTP 状态 / 文本；限流 `rate_limit_event` → `conv.rateLimit`，`settings.autoContinueOnReset` 打开时到 `resetsAt+5s` 自动重发上一条（store 里的 `armAutoContinue`）。
- **Agent SDK 默认空系统提示**，runner 传 `systemPrompt: {type:'preset', preset:'claude_code'}`（也是过中转指纹的必要条件）。
- 桌面模式 `PORT=0`，origin 每次变 → 草稿 / 评分 / 思考开关 / diff 模式都进 meta.json（`drafts.*`、`feedback.*`、`settings.set`），不要用 localStorage 存这些。
- 附件：`POST /api/attachments?sessionId=&rel=`（token 同 `/ws`）存到 `~/.claude-web/attachments/<sid>/`，消息文本后追加 `<attached kind name path size />` 标记，模型自己 Read；`decodeAttachments()` 在渲染时把标记解成芯片。超过 3000 字 / 60 行的粘贴自动变成 `kind="text"` 内联附件。
- 代码高亮用 lowlight（同步，流式重渲染友好），KaTeX / Mermaid 全部懒加载；`.hljs-*` 颜色映射到每个主题的 `--hl-*` 变量。
- **代码块有内容却显示为空**（2026-10-09 用户转述别人的截图：头部「12 行」，下面空白；这里复现不出来，怀疑是浏览器扩展 / 网页翻译改了 DOM）：`CodeBlock` 在文字停下 0.8 s 后量自己（`features/chat/code-blank.ts`：DOM 里没字 / 有字却不占位置 / 字和底色一样），`MutationObserver` 盯着外面对它的改动再量；有问题先重画一次（`<pre key>`），还不行改成纯文本（`.code-plain`），最后在 server.log 记一条 `[web warn] 代码块: …`（问题、怎么恢复的、语言、行数、字数、页面翻译的标记、外来标签 / 属性的名字、浏览器——不带代码本身，每个页面最多 5 条）。ui-smoke 的 chat-turns 一段把一个代码块从 React 外面清空，断言它回来了、server.log 有这一行。
- `scripts/shot.cjs`：用 Electron 给页面截图（`npx electron scripts/shot.cjs <url> out.png "<js>"`），本机 Chrome 扩展连的是别的机器时靠它看 UI。
- `server/ws-phase1.mjs`：附件上传 / uuid 锚点 / contextUsage / 评分草稿 / 分叉 / 导出 的端到端检查。
- **用户自己跑的命令**（2026-11-01 用户报告：气泡里露出 `<bash-input>…<bash-stdout>…`）：官方桌面版代码块的运行按钮、终端的 `!` 把命令和输出写成一条普通 user 消息（2.1.309 三个标签连在一行）。`parseShellRun` 只认整条消息是这些标签的，得到 `UserItem.shell`，`text` 是命令；`ShellRunCard` 画成回复一侧的框，没有「编辑 / 重跑」（会把命令当提问发出去）。它仍算一轮的开始：Claude 会接着回答。
- **斜杠命令**（同上）：`commandText` 把整条是 `<command-*>` / `<local-command-*>` 的消息还原成 `/名字 参数` 或输出。标签顺序有两种：技能是 `<command-message>` 在前（算用户发的，开一轮），本地命令如 `/compact` 是 `<command-name>` 在前（meta，留在原来的轮里，和 `sessions/history.ts` 的 `TAG_META` 一致，别只改一边）。`<local-command-caveat>` 是说给模型听的，空输出也没东西可看，这两种不进列表。
