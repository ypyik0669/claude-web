# 后台：在跑的子代理和工作流（2026-10-12）

spec 和实施记录：`docs/superpowers/specs/2026-10-12-background-office-design.md`，计划 `docs/superpowers/plans/2026-10-12-background-office.md`。用户要「和 Claude Code desktop 一样能看到后端子代理在跑」，样子照一段「代理办公室」视频（brainstorm 时定了：办公室 + 指挥台，整页 + 右侧面板缩小版，跟着主题，停止只停这一轮，所有子代理和后台命令都算）。

**2026-11-20 起「在跑」是「列表 / 网吧」两种看法**：页的左栏（`BackgroundSide`）、卡片（`AgentCards`）、任务 chip、从左栏打开的「某次跑完的运行」
（`runId` / `reopenRun`）都删了，页标题一律「自动化」。以「界面改版（2026-11）自动化」为准，下面讲到这些的地方是旧的。

- **数据全来自 SDK 流**：`task_started`（`task_type`：`local_workflow` + `workflow_name` / `local_agent` + `subagent_type`、`is_backgrounded` / `local_bash`）→ `task_progress` → `task_updated` → `task_notification`。**工作流的进度不在 sdk.d.ts 里**：官方二进制在 `task_progress` 上带 `workflow_progress`，是完整列表（不是增量）：`{type:'workflow_phase', index, title}` 和 `{type:'workflow_agent', index, label, phaseIndex, phaseTitle, agentId?, model, state: 'start'|'progress'|'done'|'error', queuedAt, startedAt?, tokens?, toolCalls?, lastToolName?, lastToolSummary?, durationMs?, cached?, error?, promptPreview, …}`（读它的 bundle 和本机 60 个跑完的工作流核对的）；`start` 没有 `startedAt` 是排队。状态变化时立刻发，只有进度时约 1 秒一次。跑完写 `<对话目录>/workflows/<runId>.json`（含 `workflowProgress`、`phases`、`taskId`），每个子代理的 transcript 在 `<对话目录>/subagents/workflows/<runId>/agent-<agentId>.jsonl`；`<对话目录>` = transcript 去掉 `.jsonl`（`runtime/transcript-file.ts` 的 `findClaudeTranscript`）。
- **服务端 `server/src/background/`**：`registry.ts`（纯：一条消息 → 登记表 + 动态；`ambient` / `skip_transcript` 的任务不算；子代理按出现顺序拿颜色 1…10；动态文字一行、≤ 140 字；快照不带 `promptPreview`）、`disk.ts`（跑完的工作流、子代理 transcript；`runId` / `agentId` 先过正则）、`service.ts`（`BackgroundService`：订阅 pool 的 `message` / `state`，`closed` / `error` / `starting`（重开进程）时把还在跑的标成「已停止 · 进程结束了」；每个对话第一次变化立刻推、之后 1 秒最多一次 `background.changed`（整份这个对话的快照）；结束的对话留 24 小时、最多 50 个）。请求 `background.list / history / run / transcript`，停止沿用 `session.stopTask`。联邦：list 只给本机，其余三个转发。
- **停止只停这一轮**：runner 的 SDK 选项 `perTaskStopAffordance: true`。没声明时 CLI 按「用户没有别的办法停后台任务」处理，打断会连后台工作流一起杀（以前就是这样）。phase 25 在两个运行内核上实测：`session.interrupt` 之后工作流的子代理请求还开着，`session.stopTask` 才停掉。强制停止（8 s 不回 → 重开进程）仍会带走后台任务。
- **我们的引擎要 cw.3**（fork 的 `CLAUDE-WEB.md`「后台」一节）：cw.2 只发 `task_started`（名字还是 `workflow`），没有 `workflow_progress`；而且只要有后台任务在跑，这一轮的 `result` 一直扣到它们跑完——输入框整段工作流都是「运行中」，按停止 8 秒等不到 result 就杀进程、后台全没了。cw.3 按官方的形状发进度、一轮答完就发 result（工作流的结束由通知自己开一轮）、跑完写官方格式的 `workflows/<runId>.json`。和官方不一样的两处：runId 是任务 id（`w` + 8 位，`disk.ts` 的 `RUN_ID` 两种都认），工作流子代理的 transcript 平铺在 `subagents/agent-<id>.jsonl`（`findAgentFile()` 先找这里）。
- **有后台任务的进程不回收**：runner 记着这个进程还在跑的任务（`background_tasks_changed` 是电平信号，`task_started` / `task_notification` 兜底，重开进程清空），`hasBackgroundWork()` 为真时 pool 的 `reap()` 跳过它——以前闲置 30 分钟会把正在跑的工作流一起关掉，它的结果（CLI 用一个 task notification 自己开一轮）永远等不到。
- **前端 `web/src/features/background/`**：`state.ts`（小 zustand + `registerPage('background')`，连上 / 重连时 `background.list`；`window.__cwBackground.inject(session)` / `open(sid)` 是调试入口，ui-smoke 用它）、`model.ts`（纯：胶囊文字、计数、状态词）、`office-layout.ts`（纯：等距 2:1 投影，每个阶段一排工位、「子代理」一排、后台命令在后墙角的机器位，一排最多 6 个、一个阶段最多 24 个，多的立一块「还有 N 个」）、`Office` / `CommandGraph`（2026-10-25 起是共用的节点图，见「节点图」笔记 node-graph.md；数据在纯函数 `graph-data.ts`：卡片 id 主对话 `main`、工作流 `wf|<taskId>`、阶段 `wf|<taskId>|p<index>`、代理 `<taskId>|<agentKey>`、后台命令 `shell|<taskId>`，线 id `from>to`；在跑 strong、失败 error 不带光点、完成 normal、排队 / 停了 dashed；只有代理卡片能点，打开抽屉；整页最多画 40 个代理、右侧面板 16 个，在跑的先画）/ `AgentCards` / `EventFeed` / `Character`（只收 props，不碰 store）、`BackgroundPage`（整页，懒加载）/ `BackgroundSide`（分区侧栏：在跑 · 结束了 · 这个对话跑过的工作流）/ `AgentDrawer`（点角色：`background.transcript` → `applyTranscript` → `ItemList`，在跑时 3 秒重读）/ `BackgroundPill`（输入框上方）/ `WorkflowLive`（对话里 Workflow 卡片顶上，脚本折进「脚本」；回合折起来时 Workflow 卡片在折叠里，还在跑的工作流由 `TurnView` 在回答下面再画一份 `onlyRunning`）。右侧面板「任务」的「子代理 / 后台调用树」只在没有后台数据时（其它 agent）才画。
- **样式** `styles/background.css`（办公室、角色、关系图、卡片、动态）+ `styles/background-page.css`（页面布局、抽屉、胶囊、Workflow 卡片、任务面板），`main.tsx` 里排在 `shell.css`（以前的 `rail.css`）后面。颜色 `--agent-1..10`（每个主题对 `--bg` / `--bg-1` ≥ 3:1，`contrast.test.ts` 查），办公室表面 `--office-*`（浅色和 paper 是白天，其余是夜里）。角色上的字是 `color-mix(var(--c) 70%, var(--ink-1))`（纯色只保证 3:1）。页面标题是对话名（用户的字），不用标题字体。
- **侧栏菜单不压图标栏**（图标栏 2026-11 删了，`minLeft` 留着：菜单不伸出侧栏左边）：「项目」漏斗的菜单右对齐会一直伸到窗口左边、盖住图标栏（图标栏多了「后台」之后，「自动化」正好在它下面，ui-smoke 点不到）。`useAnchoredMenu` 给 `placeFixed` 传 `minLeft` = 侧栏左边缘 + 4。
- **踩过的坑**：官方二进制的工作流子代理请求**可能带着父对话的上下文**（判断「这是哪个子代理的请求」要看最后一条用户消息，不能看全部）；子代理请求不一定是流式的。本机开发 shell 继承了已安装桌面版的 `CLAUDE_WEB_DIST`（指向 `Program Files\Claude Web\resources\app.asar\web\dist`），自己起 server 截图时要 `env -u CLAUDE_WEB_DIST`，不然页面是「web/dist not built」。
- **调试 / 验证**：`node server/ws-phase25.mjs`（e2e 默认列表里，自己起 server，`PHASE25_RUNTIMES=ccb,claude`）：真运行内核 + 假 Anthropic 上游（主对话回 Workflow 工具调用、子代理回固定文字、带 SLOW 的子代理请求一直挂着），两个运行内核各跑一遍（24 项 × 2，含下面「跑过的」那 5 项）：发起工作流的那一轮在工作流跑着时就结束、工作流结束后通知自己开一轮、阶段和子代理、走完、动态、读子代理对话、history / run、停止这一轮后工作流还在、stopTask 停掉、关进程后标成停止。ui-smoke 的「background」一段用注入的快照。截图：`window.__cwBackground.inject(...)` + `open(sid)`。
- **停止 ≠ 失败**（2026-10-13）：子代理多了 `stopped` 状态（工作流被停 / 进程结束时没跑完的那些：灰色暂停徽章、半透明、进度条停在原处）；任务结束后晚到的进度列表不会把它们改回在跑。跑完文件的 `error` 是整段堆栈，只取第一行，用户停掉的（`status: 'killed'`）不显示原因。对话里被「停止」截断的步骤是「已停止」不是「失败」（`ToolUseBlock.stopped`，CLI 的 `[Request interrupted by user…]` 变成一行「已中断」），`result.errors` 里的 `[ede_diagnostic]` 不显示。
- **前台的步骤不进后台**：官方 2.1.283 把这一轮前台跑的长命令（`local_bash`、`is_backgrounded: false`）和子代理自己的前台步骤也报成任务；登记表先扣着（`held`），被挪到后台（`task_updated patch.is_backgrounded`）才出现。这一轮的前台子代理照样算。
- 子代理对话里，官方套在提示词外面的「[Workflow harness — computed task]」框架在抽屉里去掉（`unwrapHarness`）。
- **一轮进行中结束的后台任务，流上没有 `task_notification`**（2026-10-17 用户报告「后台 · 19 条命令」）：CLI 把这种结束通知当附件塞进这一轮
  （transcript 里 `queue-operation` enqueue 之后马上 remove），只在下一轮才处理的那种才走流。`BackgroundService.reconcile()` 每 5 秒读有在跑任务的
  对话的 transcript 新增部分，只认 `"queue-operation"` 行里的 `<task-notification>`，补上结束。详见「照官方桌面版录屏改的界面」第二轮。

## 跑完的任务一分钟后离开（2026-11-05，用户报告：跑完的卡片和网吧里坐着的人一多就卡）

- `BackgroundService.pruneEnded()`（每 5 秒，`list()` 前也跑）：结束（完成 / 失败 / 停止）超过 `KEEP_TASK_MS`（60 秒）的任务从快照里去掉——
  一分钟够网吧的结账走完、卡片上看清「完成 / 失败」。磁盘上的工作流记录和子代理 transcript 不动，历史照样能看。
- 一个对话的任务全没了：服务端丢掉它，并推一次 `tasks: []` 的空快照；前端 `installBackground` 收到空快照就把这个对话从 `sessions` 里删掉
  （页面侧栏「结束了」里也就没有它了）。`KEEP_ENDED_MS` 的一天上限仍在，只是现在基本用不到。
- 测试：`service.test.ts`「an ended task leaves the snapshot after a minute」。

## 跑过的：回头看跑完的工作流、子代理和后台命令（2026-11-19）

后台页标题右边一个「在跑 / 跑过的」切换。「跑过的」是**所有对话**跑完的工作流、子代理、后台命令，全从磁盘读，**不进实时快照**
（上面 11-05 的 `pruneEnded` 一分钟清掉照旧）。方案在改版提案 Artifact 的 `#history`；这一版在现在的界面上单独做。

- **三种记录从哪来**（`server/src/background/history.ts`，形状都是对着本机真 transcript 和两个运行内核 phase 25 实测核对的）：
  - 工作流：`<对话目录>/workflows/<runId>.json`（`runItem`）：标题 `workflowName`，没有就 `summary`；`status` 只认 completed / running / failed，
    其它（killed…）算停止；`failed` = `workflowProgress` 里 `state: 'error'` 的子代理数；结束 = `startTime + durationMs`。
  - 单独的子代理：主 transcript 里 assistant 的 `tool_use`，名字 `Agent`（老 CLI 叫 `Task`）。前台的结果行带
    `toolUseResult {status, agentId, agentType, totalDurationMs, totalTokens, totalToolUseCount}`；后台的是
    `{isAsync: true, status: 'async_launched', agentId, resolvedModel}`，结束等 `<task-notification>`（`<task-id>` 就是 agentId，
    `<status>` completed / failed / killed，`<usage>` 里 total_tokens / tool_uses / duration_ms）。
  - 后台命令：`Bash` / `PowerShell` 的结果行有 `toolUseResult.backgroundTaskId` 才算，结束也靠通知。前台命令、`isSidechain` 的行不算。
  - 通知出现在三种行里：`queue-operation`（enqueue / remove 各一份）、user 消息、`attachment` 的 `queued_command`；同一条会重复——
    按「状态 + summary 的哈希」去重，后来的不同结果覆盖前面的。tool_result 是错误：带 interrupt 的算停止，其它算失败。
  - 一直没等到结束的：实时登记表里还在跑（`isRunning`）就不列，否则按 transcript 最后一行的时间记成「已停止」。
- **索引**：每个 transcript 记 size / mtime / 读到哪（`pos`），变长了只从 `pos` 往后读（4 MiB 一块，尾巴的半行留到下一块），变短了从头重读；
  超过 64 MiB 的单行跳过。逐行**先在字节上判断**：行头 64 KB 里得是 `{"type":"user|assistant|attachment|queue-operation|system"`
  之一、再有候选标记（`"name":"Agent"` 等），才解码 JSON。分页：按开始时间新的在前，游标 `${startedAt}:${id}`；文件按 mtime 新到旧扫，
  某个文件的 mtime + 5 分钟已经早于第 limit 条的开始时间就停（行的开始不会晚于它所在文件的 mtime）。文件列表缓存 5 秒（往下滑一秒一页）。
  过滤：`only`（类型）、`q`（标题 / summary / 命令 / agentType / 目录名里的词）、`also`（前端把标题对得上 q 的对话 id 带过来）、`sessionId`。
- **本机真数据**（2116 条、几百个 transcript）：冷启动第一页约 1 秒，之后 6 ms；整段 43 页 8.3 秒；堆 11 MB。
- **踩过的坑**：
  - 引擎的调试行（`api-request-blob` / `api-request-shape` / `prompt_snapshot`）整段引用请求，里面也有 `"name":"Agent"`，不按行的 type 拦掉会把
    别人的工具调用当成自己的，还慢（131 MB 从 711 ms 降到 257 ms 主要靠这个和只在行头找标记）。
  - `"tool_use"` 也匹配 `"stop_reason":"tool_use"`，要找工具名本身。user 行的 `cwd` 在 `message` 后面，行头里不一定有，从解析后的对象拿。
  - **V8 的切片字符串**：从一大行里截出来的短字符串会把整行留在内存（真数据上 RSS 679 MB）。要留下的字符串用 `flat()` 拷一份，
    通知去重用 FNV 哈希当键，状态用常量。
  - 网吧回放条的播放图标看不见：`.office button { color: inherit }` 盖掉了，要显式给颜色。横幅 `left: 50%` + translate 会只有一半宽，
    改成 `left / right: 12px; width: fit-content; margin: 0 auto`。抽屉不能占网格的一列（会把图挤小），在 `.hx-detail` 里叠在上面。
  - 关系图里子代理卡片带「行」会很高，整张图缩到 25%：`backgroundGraph` 加了 `terse`（每张卡片一行：状态 + 时长，不要行）和 `maxCards`（150）。
  - 新的临时 HOME 截图会先弹首次引导、界面是英文：`settings.set` 写 `onboarded: true`、`ui.language: 'zh'`。
- **请求** `background.historyAll {before?, limit?（默认 50，最多 200）, only?, q?, also?, sessionId?}` → `{items, next?}`。联邦：带别的机器的
  `sessionId` 就转发过去，回来的 `id` / `sessionId` 加上 `peer_<id>~` 前缀；不带 sessionId 只看本机。
- **前端** `web/src/features/background/`：
  - `state.ts`：`view: 'live' | 'history'`、`historySeen`（第一次切过去才挂载，之后只 `hidden`）、`openHistory(pick?)`、`setBgView`；抽屉多了
    `task` / `from: 'history'`（读一次跑完的运行里的子代理对话）。
  - `history-state.ts`（列表、q 防抖 250 ms、`loadRecent` 最近三条、`taskOfRow`：工作流走 `background.run`，子代理 / 命令现场拼一个任务）、
    `history-model.ts`（纯函数：按天分组、状态词、时长、`taskAt` / `sessionAt`——某一刻的样子：`startedAt` 之前排队、`endedAt` 之前在跑、
    之后是最后的状态；`appear` 让还没排上队的不出现，网吧用）。
  - `replay.ts`：一次只演一场（`where: 'graph' | 'cafe'`），rAF 时钟约 15 次 / 秒推给界面，10× / 60× / 120×（默认 60×），播到头再按从头来。
  - `HistoryView`（左列表右详情；桌面没选时自动打开最新一条；切过来就重新取；开着时有在跑的任务结束，1.5 秒后把最新一页合进来
    ——`refreshHistory` / `mergeFirstPage`，往下翻过的页不丢，不打断正在取的那一页）、`HistoryDetail`（统计、
    关系图、回放条、命令原文）、`HistoryTree`（手机：竖排阶段 + 子代理）、`ReplayBar`、`RecentRuns`（网吧空着时列最近三条，可以直接
    「回放」进网吧）。`Office` 多了 `replay` 属性：只画回放的那一个对话、顶上一条「回放：…」横幅 + 回放条，网管和停止按钮不出现。
- **调试**：`window.__cwBackground.history()` / `.openHistory(id?)` / `.replay.{state, seek(ms), play, pause, speed(x), stop}`。
  造数据：在临时 HOME 的 `.claude/projects/<目录>/` 里写 transcript 和 `<sid>/workflows/w….json`（ui-smoke 的 seed 有一个最小的 `wsmoke0001`）。
- **测试**：`history.test.ts`、`service.test.ts`（在跑的不列）、`federation/rewrite.test.ts`、`history-model.test.ts`；phase 25 每个运行内核多 5 项
  （工作流那一行、一个对话 + 一种类型、真发一个子代理并读回它的对话、真跑一条后台命令等通知结束）；ui-smoke 的 background 段：
  空网吧的「刚跑完的」、按天的列表、详情的关系图、回放按原来的时间走、切回「在跑」。
