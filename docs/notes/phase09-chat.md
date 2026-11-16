# 对话渲染与 composer（阶段 9，2026-09-04）

- **一轮 = 一条竖向时间线**（`ChatView` 的 `Steps`）。三态必须互不相同：完成 = 空心勾、进行中 = 呼吸方块 + 计时、待执行 = 灰色空心圆（`stepState()`）。（界面改版阶段 5：完成的回合把它折成一行摘要、点开才是这条线；多了第四态「等你确认」= 黄色盾牌，见「界面改版 阶段 5」。）折叠态就是这条线，点节点展开该步的卡片（`ToolCard` 的 `bare` 模式只渲染 body，头和导轨由时间线画）。
- 工具折叠态是**单行**：图标 + 动词 + 目标（路径取 basename，全路径在 title 里）+ 右侧耗时。运行中的秒数：agent 持续发 `tool_progress` 就用它（Claude），不发就用 `startedAt` 的墙上时间自己数（ACP / Codex），否则会一直停在 `0s`。
- **composer 上方钉一行** `RunCard`（正在做什么 · 已跑多久 · 第几步 · 停止），像标签一样贴在输入框上沿（阶段 3）。原来的 `ContextRow`（工作目录 · 分支 · worktree · agent 名）并进了会话头的灰字（`workbench/repo-context.ts` 的 `useRepoContext`）。`StatusStrip` 只留 RunCard 说不出来的东西：卡住、失败、限流、排队 —— 别把「运行中」重复两遍。输入框下面原来的统计栏（轮数 / token / 缓存 / 费用…）收进了输入框右下角的上下文小环（见「界面改版 阶段 3」）。
- `conv.turnStartedAt` 在用户消息落地时打点、`result` 时清空，RunCard 从它开始计时。
- **`applyTranscript(c, msgs, {live})`**：点开一个**正在跑**的会话时不能把最后那个工具扫成 `done`，否则一条还在执行的命令会顶着绿勾，`runningTool` 也被清掉（表现为「思考中」但其实在编译）。`live` 由 `SessionSummary.live` 判断，同时用 transcript 里用户消息的时间戳回填 `turnStartedAt`。
- **模型 / effort 的唯一真相是 `server/src/models/catalog.ts`**：版本化显示名（`Fable 5.1` 不是 `Fable`）、每个模型自己的 effort 档位、别名、`supportsUltracode`、未核实的标 `unverified`。运行时优先用 agent 自报的列表（`info.models` / `model/list`），catalog 只补显示名和档位。`SessionInfoSnapshot.models[].supportsEffort / supportedEffortLevels` 现在真的被前端读了：Gemini 不出 effort chip。
- **ultracode 不是 effort 等级**：Claude 侧它是「xhigh + 动态工作流编排」的会话级布尔（`CLAUDE_CODE_EFFORT_LEVEL` 不接受这个值），做成模型菜单顶部独立的「深度编排」开关（`session.setUltracode`，只对 `supportsUltracode` 的模型出现），不是「智能程度」分段控件里的一档；Codex 侧的 `ultra` 才是 effort 枚举里真实存在的一档（分段里的「超限」），effort 传给 Claude 前要把 `ultra` 降成 `max`。

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
  1602 个片段 11.3 秒（另一次 1154 个 6.3 秒，每 16 ms 一批）。新开对话第一句要 ~20 秒，其中 ~15 秒是起引擎进程（没细查）。
  片段到达是一阵一阵的：有一次 65 阵、阵间隔最长 1.4 秒——那次是上游，不是我们：关掉缓存垫片（`cacheShim: false`）A/B，两边都平稳。
- 把录下来的帧按原时间喂给页面（`stream-replay.js`，`fetch("/rec.json")`，录音放进被测的 dist 目录）：旧页面 6.3 秒的输出落后 131 秒、11.3 秒的落后 138 秒；
  新页面最后一个片段到了 0.04 秒内就画出来。用户的设置下（显示思考 + 详细视图）流式时每帧 p50 21 ms / p90 60–75 ms，约每秒 15 次重画：
  多半是浏览器给一大段增长的思考文字排版（profile 里 `(program)` 39%，React 提交阶段的自动滚动读 `scrollHeight` 把排版算在它头上）。
  试过：更早的轮 `content-visibility: auto`（p90 75→59 ms）、关掉文字淡入（p90 63 ms），都只是一点点，没改。

## 一跑任务程序和整台电脑都卡（2026-11-17 用户报告）

10-19 那次只量了 92 条的短对话、只看对话本身。这次是长对话 + 默认界面（信息栏、右侧面板、停靠面板都挂着）+ 在跑的任务：
- **服务端整份重列对话**：跑着的一轮每几秒写一次 transcript → `sessions.changed`（800 ms 去抖）→ 每个窗口 `sessions.list` →
  `SessionService.list()` 的缓存被写清掉 → SDK `listSessions({limit: 2000})` 把所有 transcript 再读一遍。开发机 270 个对话一次
  1.7–3 秒、1.2–1.6 秒 CPU（`getSessionInfo` 读一个是 22–50 ms）：一轮任务里 server 大半时间在重读磁盘，事件循环卡着还拖慢
  流式事件的转发。现在：transcript 写入只记 `dirty`，下一次 `list()` 用 `getSessionInfo` 只重读这几行（SDK 不列的长首句对话走
  `summaryFromFile`）、缓存保留；新对话 / 项目目录变化 / 删除 / 分叉 / 改名才整份重列（`bump`）。整份重列期间来的写入留在
  `dirty` 里，结果照样存下（`structGen` 只在 bump 时动——忙的时候几乎每次 2 秒的重列都会撞上一次写入，按旧的 `gen` 判断就永远存不住）。
  后台读完标题以后也不再整份重列，只把名字补到缓存的行上。
- **前端每帧重渲染整片界面**：`renderStreamed` 每帧给 `open[id]` 换一个新对象，订阅整个对象的组件全都跟着每秒重画 60 次——
  `ChatTile`（整个格子：会话头、Composer、信息栏）、`useScopedSession()` 的 ~20 个用户（Composer、右侧面板 / 停靠面板里隐藏着
  但不卸载的配置、任务、终端、用量、记忆、连接器、技能、定时任务、浏览器、审阅、文件）、每条用户消息的 `UserActions`
  （每帧还 `isLastPrompt` 扫一遍全部消息）、信息栏的每张卡、侧栏 / 首页的行；其中会话头和信息栏的每张卡（不管是哪张）每帧都
  `sessionDiffStat` 走一遍全部工具调用、把每个 Write 的内容按行切开，`ReviewView` / `TasksPanel` / `TrajectoryView` /
  文件里「本对话的文件」每帧 `walkTools`。现在：`store/streamed.ts` 的 `onlyStreamed(a, b)`（只有 `version` / `streamed` 同步
  变了）+ `useSettledOpen`：`useScopedSession()` / `useActive()` / `useSettledSession(id)` 在只有流式帧时返回旧对象（zustand
  不重渲染），整条消息、状态、权限请求等任何别的变化照常；真要每帧画字的只有 `ChatView`（`useScopedSessionLive()`）。
  `RunCard` / `StatusStrip` 本来就有 1 秒的计时器，直接读原地改的 `conv`，最多晚 1 秒。`ChatTile` 只订阅「开着没有」和 `cwd`。
  `model/diffstat.ts` 的 `cachedDiffStat(conv, settledVersion)`：按 conv 对象 + settled 版本缓存，所有调用方共用一份。
- **不画的消息也在换版本**：思考时的 `thinking_tokens` / `stream_event` / `tool_progress` 和一堆界面不画的 system 子类型每条都
  走 `applyMessage` → 新 `open[id]` → 上面那些订阅者全跟着动。现在 `conversation.ts` 的 `isLightMessage(m)`（`DRAWN_SYSTEM` 是
  会画出来的 system 子类型白名单，新加会画的子类型要进这张表）为真的消息在 store 里原地改、记进 `unrendered`、等下一帧一起
  `renderStreamed`，和流式文字走同一条路（只算 streamed 帧）。
- **早先的回合每帧重算**：`TurnList` 给每个回合传同一个 `version`，`TurnView` 的 memo 全失效，600 行的长对话每帧把所有回合的
  `itemsOf` / Markdown 比一遍。现在只有最后一个回合拿 live 版本；做完的回合用 `earlierVersion()`（items 数组的身份 + 子代理签名），
  后台子代理还在跑或回合没结束时才退回 settled 版本。自动滚到底合并到一帧一次（`scrollAsked` + rAF）。
- **整个应用的样式重算**：`phone.css` 里 `.app.mobile .chat-tile > .sess-head:has(+ .chat) > *` 这种「兄弟 `:has()`」规则在桌面上
  也参与失效判断——对话区每加一个节点，Chromium 就把 ~3800 个元素的样式重算一遍（每次 ~165 ms，一秒好几次）。只在手机上用的
  `:has` 规则包进 `@media (max-width: 760px)`（不命中的 media 里的规则不参与失效），`review-phone.css` 的 `.rv-fh:has(+ …)` 同理；
  `ui/viewport.ts` 的 `MOBILE_QUERY` 和这两份 css 要一起改。查法：`CW_PERF_TRACE=1` 让 perf-busy 录一份带
  `disabled-by-default-devtools.timeline.invalidationTracking` 的 trace，统计 `StyleInvalidatorInvalidationTracking` 的选择器。
- **输入框每个按键一次强制布局**：`autosize` 读 `scrollHeight`。支持 `field-sizing: content` 的（Chromium 123+，桌面版都是）改用
  CSS（`.composer textarea:not(:placeholder-shown)`，空的时候保留一行高），JS 只在不支持时跑。
- **输入框的流光**：一块 1.5 × 长边（cqmax）的方形锥形渐变在遮罩后面转（transform）。试过改成注册的 `@property` 角度只重画一圈，
  结果更糟：属性动画每帧在主线程重算样式（实测 560–700 ms/s）。退回 transform（合成线程做），层缩到 125cqmax，`steps(80)`，
  `data-paused` 时 `animation-play-state: paused`。
- 零碎：`UserRow` 只订阅「这个对话开着没有」（布尔）；`CommandPalette` 关着时不挂 `PaletteBody`（它订阅整个 `open`）；标签条 /
  组栏 / 欢迎页 / 总览栏 / 办公室用 `useOpenSettled()`（只有流式帧时整张 map 返回旧引用）；`useArtifacts` 按 settled 版本 memo。

结果（perf-busy 默认参数，跑任务那 20 秒，同一台 i5-12450H，机器本身被别的进程占满）：脚本 687 → 190 ms/s；输入到下一帧
p50 244 ms（p95 26 秒）→ 50 ms（p95 92 ms）；页面在窗口结束后多久才回话 7.5 秒 → 0.1 秒；长任务合计 46 秒 → 2.4 秒；
WebSocket 消息以前每秒只消化 32 条（server 发 211 条，积压到任务结束后还在追，AFTER 窗口主线程仍 770 ms/s），现在全收、
任务一停就回到空闲水平。样式重算是跑任务时剩下的大头（~160 ms/s，流式文字本身的布局），离屏渲染下 GPU 进程的数字偏高。

量法：`node scripts/perf-busy.cjs`（文件头有说明；Electron 离屏 + 假上游 + 300 个对话的临时 HOME，不花 token）。坑：假上游 /
本机代理的 Node http server 默认 `keepAliveTimeout` 5 秒，CLI 复用到被关掉的 socket 会报「Request timed out」/「Connection
error」然后卡一分钟——`scripts/lib/demo.cjs` 和 perf-busy 的假上游都设了 10 分钟。

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
