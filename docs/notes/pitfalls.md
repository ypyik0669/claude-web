# 已踩的坑

- **SDK 自带 spawn 在 Windows 上 ENOENT**：`@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` 直接 `child_process.spawn` 没问题，
  但 SDK 内部的 spawn 报 ENOENT。解决：`options.spawnClaudeCodeProcess` 自定义 spawn（见 `server/src/claude-exe.ts`）。
- **SDK 不回显用户消息**：前端发送时自己往对话里 push 一条 user item（id = 客户端铸的 uuid）。别的窗口（手机、另一个窗口）、IM、定时任务、目标的「继续」发的那条以前只在重开对话后才看得到（2026-10-08 用户报告：手机上问的，电脑上只显示回答）：现在每个驱动的 `send()` 发一个 `sent` 事件（SDK 形状的 user 消息，带 uuid），pool 转发、hub 作为 `session.event` 广播并加 `cw_echo: true`；reducer 的 `applyUser` 遇到 `cw_echo` 且已有同 uuid 的条目（发送的那个窗口）就跳过，插话（`priority:'now'`）不重置回合计时。`sent` 不走 `message` 流：canonical 在 hub 里自己记用户消息，账本 / IM / 目标只读 agent 的流。
- **一条 API 消息会拆成多条 `assistant` 事件**（同一个 `message.id`，每个 content block 一条），reducer 按 id 合并（`web/src/model/conversation.ts`）。
- **子代理对话不在主 jsonl 里**：`<session-id>/subagents/agent-<id>.jsonl`，用 SDK `getSubagentMessages` 按需加载；agentId 从 Agent 工具的 result 文本里正则取。
- **AskUserQuestion / ExitPlanMode 都走 `canUseTool`**：回答 = `{behavior:'allow', updatedInput:{...input, answers}}`。
- **effort 没有运行时控制接口**：改 effort 走 `/effort <level>` 命令发进对话。
- `web/tsconfig.json` 不能用 `baseUrl`（TS 5.9 移除），`paths` 必须是相对路径。

## 只发一张图片 → 之后每一轮都 400（2026-10-17 用户截图）

- `SessionRunner.send()` 以前总是在 content 末尾放 `{type:'text', text}`，只发图片时就是 `[image, {type:'text', text:''}]`。接口不收空文字块，
  引擎还会给最后一块加 `cache_control`：`messages.N.content.1.text: cache_control cannot be set for empty text blocks` /
  `text content blocks must be non-empty`。这条消息进了 transcript，**之后每一轮都带着它重发，对话就再也用不了**（截图里一连串 400）。
- 修法三处：`send()` 只有图片时不加文字块；`transcript-file.ts` 的 `dropEmptyText()`（现名 `dropEmptyBlocks()`，见下一节）在 resume 前（还没有进程拿着文件）把 user / assistant
  消息里的空文字块去掉（全空的消息换成 `…`），经临时文件 rename，没东西可修时不碰文件；进程还活着时它内存里有这段历史，
  所以结果是这两种 400 之一时 runner 标 `respawnPending`，这一轮结束后重开进程（resume 读修过的文件）。前端 `classifyError` 新增 `history`
  「对话记录有误」，提示点重试。
- 独立验证后改的：`dropEmptyText` **只在这种 400 之后**的那次重开前跑（`repairEmptyText`；它整个读文件，42 MB 要 0.4 s，每次 resume 都跑会卡住服务端）；
  读之前和 rename 之前各对一次大小和 mtime，变了就不写（同一个对话开在终端里时，那边追加的行会被盖掉）。已经卡住的老对话：再发一次会先 400 一次，
  然后自动修好重开，点重试就通。`content: ""` 字符串、tool_result 里嵌的空文字不修（没见过它们引起这个错）。

## 别家模型的空思考 → 换到 Claude 后每一轮都 400（2026-10-19 用户截图，P1）

- 对话一直跑在 deepseek-v4.1-flash（Anthropic 格式的供应商）上，它偶尔回 `{type:'thinking', thinking:' '}`（只有空白、**没有签名**），
  DeepSeek 自己收得下；换到 claude-opus-5-5 后接口拒整段历史：`messages.179.content.0.thinking: each thinking block must contain
  non-whitespace thinking`。分叉会把这些块原样复制过去。Claude 自己的空思考（display omitted）**带签名**，是合法的，不能删。
  DeepSeek 的 327 个思考块全都没签名，第一次 400 只报了空的那个——没签名的也会被拒，见下面「去掉空的之后还不够」。
- 修法：`dropEmptyText` 改名 `dropEmptyBlocks`，也去掉「没签名、只有空白」的思考块；预检正则改成 `"(?:text|thinking)":"(?:\s|\\[nrt])*"`
  （以前认不出文件里转义成 `\n` 的换行）。触发时机（都是没有我们的进程拿着文件的时候）：这种 400 之后（runner 的 `repairEmptyBlocks`，
  和空文字同一条路）；`setModel` 要重开进程时；`swap.ts` 换供应商（`swapProviderNow` 换了供应商、`openOnProvider` 用另一个供应商打开没在跑的对话）。
  同一个供应商里进程内 `setModel` 成功的切换，历史在进程内存里，只能靠那次 400 → 重开。前端 `classifyError` 把这句也算 `history`。
- 用户那两个对话（`5b7b91f6…` / `16bbc467…`）是手工修的，备份在同目录 `*.jsonl.bak-2026-10-19T08-19-10-948Z`。
  用真文件（27.9 MB）跑 `dropEmptyBlocks`：改 2 条消息、510 ms，结果和手工修的逐字节一致，再跑一次不改。
- **去掉空的之后还不够**（同一天，装好后在真接口上测）：分叉那个对话发一轮 Opus，回 ``messages.3.content.0: Invalid `signature` in `thinking` block``。
  DeepSeek 的 325 个思考块全是 `signature: ""`；Anthropic 先查空白（所以先报的是 179），再查签名。当时的引擎（ccb，已删）只在 ant 用户的模型回退时
  去掉签名块（`stripSignatureBlocks`），普通换模型不管。现在 `dropEmptyBlocks(file, { unsigned: true })` 把没签名的思考块也去掉（Claude 的思考总带签名，
  `redacted_thinking` 不动）：runner 里「下一个模型是 Claude」（`toClaude`：账号；供应商按 `providerModelId` 认；`cw-x:<供应商>:<模型>` 按模型名）
  或者接口报了这个 400（`repairUnsigned`，不管模型叫什么）时用；从别家模型 `setModel` 到 Claude 一律重开进程（进程内换的话第一轮必 400）；
  `swap.ts` 换到 Claude（账号 / claude-account / 默认模型是 Claude 的供应商）时用。代价：这些对话里 DeepSeek 那几轮的思考过程从历史里没了。
  直接用 Claude 打开一个带别家思考的旧对话（没有切换这一步）还是会先 400 一次，自动清掉、点重试就通——不想每次 resume 都读整个文件。
- 真接口验证：`5b7b91f6` 的分叉（33 万 token 历史），第一轮 400 → 重试 OK；用户两个对话按 unsigned 清掉（备份 `*.bak-unsigned-2026-10-19T13-44-06-426Z`）后，
  新分叉第一轮就 OK。分叉 / 真机脚本的做法：自己起一个 server（`meta.json` 只拷 providers 到临时 `CLAUDE_WEB_DIR`，真 HOME 用账号登录），
  `session.open { sessionId, fork: true, permissionMode: "plan" }`，跑完删掉分叉的 jsonl。

## 每步询问的对话第二轮变成完全放开？（2026-10-26 桌面版 QA）

- 现象：`ui.defaultMode = bypassPermissions`，一个对话显式按 `default` 打开，第一轮 Claude 问了，第二轮什么卡都没出、页面脚本直接跑了，
  meta 里记成 `bypassPermissions`。
- 查下来：**同一个 CLI 进程**（`~/.claude/sessions/<pid>.json` 只有一个，jsonl 两轮之间没有重开），第二轮的用户行带 `permissionMode:"bypassPermissions"`。
  活着的进程只有 `setPermissionMode` 能改模式：`session.setPermissionMode`（输入框的权限菜单；Shift+Tab 跳过危险模式，到不了完全放开）或 IM `/mode`。
  这台机器没有 IM / 手机 / 联邦，只可能是窗口（菜单，或 CDP 脚本）发了 `session.setPermissionMode`（同一天 2b8065b0 那次用户确认是自己点的）。脚本重放（打开 default → OPEN-GO →
  允许一次 / 带 suggestions 的总是允许 → SCRIPT-GO）两次都留在 default，meta 第一时间就记了 `default`，第二轮出服务器的脚本卡。
  标签当时看着是 每步询问，多半是还没收到 info；现在标签和服务器一致（`info.permissionMode`）。
- 顺手补的真漏洞：pool 以前只在进程**报**模式（info）时才记 `SessionMeta.permissionMode`。进程没起来 / init 前就关了的对话没有记录，
  之后不带模式的重开（IM、定时任务、目标、重启后别的窗口）就退回 `ui.defaultMode`——每步询问打开的会以完全放开回来。
  现在 `pool.open` 收到调用方说的模式（不是分叉）就当场记下。恢复已有对话时显式给了和记录不同的模式、而进程在 init 前就失败的，记录也已经换成新模式（之后不带模式的重开用新模式，不再回到旧记录）。测试：`pool.test.ts`「opened as … a reopen without a mode keeps it」五组对称情况；
  前端 `store.test.ts` / `reopen.test.ts` 锁住「显式 default 不是没设」。

## 换到中转再换回账号：每一轮都 Invalid `signature`，重试也没用（2026-10-30 用户截图）

- 对话在账号上跑 Opus，切到中转 aizhongzhuan.cc（它回的模型名是 `claude-opus-5.5`），再切回「Claude 账号」：每轮 400
  ``messages.27.content.0: Invalid `signature` in `thinking` block``，提示「已经自动去掉了：点重试」，重试还是同一个错。
- 原因：中转的思考块**有签名**，只是它自己的格式（解 base64 后开头不是官方的 `08 04 12`），官方验不过。上面那条的 `unsigned` 只去掉**没签名**的，
  这些全留着——自动修复什么都没改。签名只在签发它的地方有效，同名模型、不同供应商也不行。
- 修法：① `swap.ts` 换到 Claude 时（`cleanForAnotherProvider`）按 canonical 里记的供应商切换（`providerSwitches` → `providerAt`）判断每条助手消息是
  哪个供应商写的，**不是目标供应商写的**消息里的思考块（含 `redacted_thinking`）全去掉，目标自己的留着（`dropEmptyBlocks` 的 `foreign`）；
  ② runner 收到这个 400（认不出是谁签的）→ `allThinking`：历史里的思考块全去掉，重试一定通。代价：被去掉那几轮的思考过程不在历史里了。
- 真数据（这台机器的那个对话的副本）：123 个官方签名的留下，6 个中转的去掉。测试：`transcript-file.test.ts` 的 `foreign` / `allThinking`、`swap.test.ts` 的 `providerAt`。
