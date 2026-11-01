# 对话渲染与 composer（阶段 9，2026-09-04）

- **一轮 = 一条竖向时间线**（`ChatView` 的 `Steps`）。三态必须互不相同：完成 = 空心勾、进行中 = 呼吸方块 + 计时、待执行 = 灰色空心圆（`stepState()`）。（界面改版阶段 5：完成的回合把它折成一行摘要、点开才是这条线；多了第四态「等你确认」= 黄色盾牌，见「界面改版 阶段 5」。）折叠态就是这条线，点节点展开该步的卡片（`ToolCard` 的 `bare` 模式只渲染 body，头和导轨由时间线画）。
- 工具折叠态是**单行**：图标 + 动词 + 目标（路径取 basename，全路径在 title 里）+ 右侧耗时。运行中的秒数：agent 持续发 `tool_progress` 就用它（Claude），不发就用 `startedAt` 的墙上时间自己数（以前的 ACP / Codex 是这样；Claude 有的工具也只报开始），否则会一直停在 `0s`。
- **composer 上方钉一行** `RunCard`（正在做什么 · 已跑多久 · 第几步 · 停止），像标签一样贴在输入框上沿（阶段 3）。原来的 `ContextRow`（工作目录 · 分支 · worktree · agent 名）并进了会话头的灰字（`workbench/repo-context.ts` 的 `useRepoContext`）。`StatusStrip` 只留 RunCard 说不出来的东西：卡住、失败、限流、排队 —— 别把「运行中」重复两遍。输入框下面原来的统计栏（轮数 / token / 缓存 / 费用…）收进了输入框右下角的上下文小环（见「界面改版 阶段 3」）。
- `conv.turnStartedAt` 在用户消息落地时打点、`result` 时清空，RunCard 从它开始计时。
- **`applyTranscript(c, msgs, {live})`**：点开一个**正在跑**的会话时不能把最后那个工具扫成 `done`，否则一条还在执行的命令会顶着绿勾，`runningTool` 也被清掉（表现为「思考中」但其实在编译）。`live` 由 `SessionSummary.live` 判断，同时用 transcript 里用户消息的时间戳回填 `turnStartedAt`。
- **模型 / effort 的唯一真相是 `server/src/models/catalog.ts`**：版本化显示名（`Fable 5.1` 不是 `Fable`）、每个模型自己的 effort 档位、别名、`supportsUltracode`、未核实的标 `unverified`。运行时优先用 CLI 自报的列表（`info.models` / `model/list`），catalog 只补显示名和档位。`SessionInfoSnapshot.models[].supportsEffort / supportedEffortLevels` 现在真的被前端读了：不支持 effort 的模型不出 effort chip。
- **ultracode 不是 effort 等级**：Claude 侧它是「xhigh + 动态工作流编排」的会话级布尔（`CLAUDE_CODE_EFFORT_LEVEL` 不接受这个值），做成模型菜单顶部独立的「深度编排」开关（`session.setUltracode`，只对 `supportsUltracode` 的模型出现），不是「智能程度」分段控件里的一档。（历史：Codex 的 `ultra` effort 档随 Codex 删了。）

## 流式卡顿：每个片段一次整页渲染（2026-10-19 用户报告，DeepSeek 思考时尤其卡）

- 现象：中转后台早跑完了，界面还在一个字一个字地追。DeepSeek flash 一个 token 一个 delta、每秒一两百个；每个 `stream_event` 都是一次
  `bump` → 整个对话重渲染。实测（`3d0e1b96`，92 条，用户的设置：显示思考过程 + 详细视图）：5 秒的输出要 49.6 秒才画完（每秒 20 次渲染）。
- 修法三层：
  1. `store/index.ts`：`stream_event` 直接 `applyMessage` 进 `conv`（原地改），`unrendered` 记下会话，一帧（`requestAnimationFrame`）只 bump 一次
     （`renderStreamed`，同时 `streamed` +1）。别的任何 bump 都会顺带画出已到的片段（`bump` 里 `unrendered.delete`）。窗口隐藏时没有帧：片段先在 `conv` 里，
     下一帧或下一条整消息时一起画。
  2. `ChatView.tsx`：`TurnView` 是 `memo(sameTurn)`（比 turn.id / last / live / version，不比 Turn 对象——`groupTurns` 每次都新建）；
     更早的轮拿 `settled = version - streamed`（流式片段只写最后一轮；后台子代理写进更早一轮的片段等它下一条整消息再出现）。
     `WaitingCtx` 的 Set 内容没变就复用旧引用——新 Set 会让每一轮的每一步都重渲染（context 消费者不受 memo 拦）。
  3. `Markdown.tsx`：流式且超过 2000 字时按 `settledCuts`（`stream-fade.ts`）切块，不再变的块各自 memo，只有最后一块每帧重解析；结束后整段解析一次（和以前一样）。
     不在列表项 / 缩进 / 引用 / 表格行前切，所以中间带空行的列表流式时会显示成几段列表。
- 结果（同一测量）：落后 44.7 秒 → 0.05 秒；默认设置下每秒 60 帧、主线程 60% 空闲。展开思考时每帧还要 ~30 ms，多半是浏览器给一大段增长的文字排版 / 绘制。
- 怎么测：起一个临时 HOME 的 server，Electron 里用 preload 抓住页面自己的 WebSocket，把假的 `stream_event` 帧按固定速率喂给它的 `onmessage`，
  量 store version 变化次数和最后一帧比理想时间晚多少；CDP `Profiler` 抓 CPU profile，按函数名 / React 组件汇总。
  隐藏窗口里 `capturePage` / `executeJavaScript` 会卡住：用 `offscreen: true` + `backgroundThrottling: false`。页面要 `?token=`（`CLAUDE_WEB_TOKEN`）。

## 用真 DeepSeek 输出测流式（2026-10-19，装好之后）

- 真机录一轮（aizhongzhuan.cc 2 的 deepseek-v4.1-flash，会话是新开的；见 pitfalls 里分叉脚本的做法）：进程已经起着时，5.2 秒后开始出字，
  1602 个片段 11.3 秒（另一次 1154 个 6.3 秒，每 16 ms 一批）。新开对话第一句要 ~20 秒，其中 ~15 秒是起 CLI 进程（没细查）。
  片段到达是一阵一阵的：有一次 65 阵、阵间隔最长 1.4 秒——那次是上游，不是我们：关掉缓存垫片（当时的 `cacheShim`，已随别家格式删了）A/B，两边都平稳。
- 把录下来的帧按原时间喂给页面（`stream-replay.js`，`fetch("/rec.json")`，录音放进被测的 dist 目录）：旧页面 6.3 秒的输出落后 131 秒、11.3 秒的落后 138 秒；
  新页面最后一个片段到了 0.04 秒内就画出来。用户的设置下（显示思考 + 详细视图）流式时每帧 p50 21 ms / p90 60–75 ms，约每秒 15 次重画：
  多半是浏览器给一大段增长的思考文字排版（profile 里 `(program)` 39%，React 提交阶段的自动滚动读 `scrollHeight` 把排版算在它头上）。
  试过：更早的轮 `content-visibility: auto`（p90 75→59 ms）、关掉文字淡入（p90 63 ms），都只是一点点，没改。

## 对话里的代码块直接运行（2026-10-20，阶段 E）

- `chat/CodeBlock.tsx` 的 `run` prop 只由对话正文提供（`Markdown` 里 `CodeRunCtx` 从 `ChatView` 的 `TurnView` / `ItemList`
  传下来）；工具卡、子代理详情、旁聊不传，所以那里的代码块没有运行按钮。语言白名单和 `server/src/tools/run-code.ts`
  的 `RUNNABLE` 保持一致：bash / sh / zsh / shell / cmd / bat / powershell / ps1 / pwsh / python / python3 / py /
  javascript / js / node。
- `code.run` 在 hub 里先 `localWindowOnly`：手机、远程监听器、联邦 peer 直接拒绝；确认框是前端 `dlg.confirm`，文案说明
  「以你的身份在本机执行」。cwd 优先取运行中会话的 `info.cwd`，否则用请求里的绝对路径（存在且是目录），再否则进程目录。
- 服务端 30 秒超时、输出上限 64 KB；超时 / 超量都杀进程树（Windows `taskkill /pid <pid> /T /F`，其它 `SIGKILL`），
  结果带 `timedOut` / `truncated`，前端在代码块下面显示 stdout / stderr / 退出码 / 耗时。
- 运行不会写进会话记录；长任务还是用终端窗格。测试在 `server/src/tools/run-code.test.ts`。
