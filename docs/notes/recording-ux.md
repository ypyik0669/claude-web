# 照官方桌面版录屏改的界面：信息栏 / 标题栏工具 / 一行输入框 / 菜单 / 运行行（2026-10-16，用户要求）

用户发了一段官方 Claude Code 桌面版的录屏，要「直接借鉴 ui 和 ux」。spec：`docs/superpowers/specs/2026-10-16-recording-ux-design.md`。
只照录屏里看得见的样子和官方公开文档做，不反编译、不拷官方代码（用户要过用逆向工具，拒绝了：官方条款禁止，而且 claude-web 是公开发布的）。

## 信息栏（`web/src/features/info/`）

- 对话右边一列 288px 的卡片：环境 / 上下文 / 连接器 / 改动 / 后台任务。放在 `ChatTile` 里（每个对话自己一列），不是右侧面板的一个标签。
  结构：`.chat-split > .chat-main + aside.info-col > section.info-card[data-card]`。
- 手机不进这层：`phone.css` 依赖 `.chat-tile > .sess-head + .chat` 的平铺结构，`mobile` 时直接渲染原来那几块。
- 窄了自己让开：`ResizeObserver` 看 `.chat-split`，宽度 < 560 + 288 就不画（右侧面板开着时常见）。这时标题栏的「+N −M」要回来、ⓘ 不算按下：
  `SessionHeader` 拿的是 `infoShown`（真的画出来了），不是设置值（验证时抓到：窄窗格里改动数哪儿都看不到）。开关是设置 `ui.infoPanel`
  （默认开，标题栏 ⓘ 和 设置 → 外观 都能关）；关掉后标题栏的「+N −M」回来（信息栏开着时它在「改动」卡里）。
- 卡片顺序 / 折叠存 `ui.infoCards`（`info-model.ts` 的 `normInfoLayout`：未知的丢掉、新卡补在后面，上下文默认折叠）。拖抓手换位置，
  标题上 Alt+↑↓ 也能挪。
- 上下文卡：`session.contextUsage` 的 `full`（SDK `getContextUsage`），**只在展开时取一次、点「刷新」再取**，一轮结束不取（2026-10-23 起环 / 状态条 / 这张卡都不在每轮结束问引擎，见「界面改版 阶段 3」的「上下文小环不问引擎」；A5 曾加过「卡开着时每轮结束再取」，已撤回，spec 9416dfe）。2026-10-24（A5）：每个对话上一次的结果放在模块内存 `ctxCache`（本次运行，不进 meta.json / localStorage），展开时立刻显示、脚注「更新中…」再取。颜色按分类固定（`info-model` 的 `toneOf`：Messages 蓝、System tools 橙、MCP tools 青、Skills 黄、其余灰；`.ctx-t-*` / `--ctx-*` 由主题的蓝红黄绿混出来），已用的按大小排。**回答可能没有 `kind`**（SDK 类型写着有；当时的 ccb 引擎就没有，已删），以前 Free space / Autocompact buffer 都被当成已用；`kindOf` 在没有 `kind` 时看 `isDeferred` 和这两行固定的名字。
  - **2026-10-24 上下文卡（stage A 的 A5）**。现象（用户截图）：卡慢；同一类在不同对话里颜色不一样；1M 窗口时 Autocompact buffer 显示 333k / 33.3%（官方桌面版 33k / 4.7%）。
    根因：慢 = 每次展开都 `full` 数一遍（CLI 要发十几～二十几个 `count_tokens`，几秒到十几秒）；颜色 = 按出现顺序给调色板序号 `sw-0…7`；333k 见下。
    做法：前端见上一条（`ctxCache` 先显示、`toneOf` 固定颜色、已用按大小排、buffer / free / deferred 在最后，条和行同一套颜色；**不**每轮结束自动再取）。
    buffer 的数字是 CLI 报的，前端不自己改数字（当时在我们的 ccb 引擎 cw.7 里改，引擎已删；现在只用官方二进制的数）。
    验证：`info-model.test.ts`（固定颜色、排序、未知类名灰、没有 `kind` 的回答）；ui-smoke `parity-a` 段：卡里的行（有的话——ui-smoke 不起引擎，通常没有明细）不出现 `sw-0…7`，样式表里也没有这些规则，
    五个 `.ctx-t-*` 算出来是五种不透明的颜色；真机（`scripts/demo-up.cjs` 的假上游）浅色 / 深色 / 字符画主题都看过。
    **坑：spec 里写的「`model` vs `runtimeModel` 两个窗口不同」不是 333k 的原因**——真正的原因是用户 `~/.claude/settings.json` 的 env `CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000`：
    卡的窗口按 1M 算（不看这个上限），阈值却按它算（700k − 20k − 13k = 667k），buffer = 1M − 667k = 333k（两个名字解析出来都是 1M，和 model / runtimeModel 无关）；真的自动压缩在 650k 触发。查这类数字先看 settings.json 的 env。
    另外 `--ctx-*` 不在对比度测试里（`contrast.test.ts` 只读 tokens.css / styles.css 的主题块）；~~已关的对话卡上还显示缓存和「刷新」，点了静默失败~~——总审查 M3 修了：「刷新」只在对话开着（`info-model` 的 `ctxLive` / `ctxCanRefresh`：idle / running / waiting）且不在数时出现，已关的只显示上次的结果和「N 分钟前更新」。
- 改动卡的「建 PR」是给 Claude 发一句话（提交、推送、`gh pr create`），只在空闲时能点；已有 PR 就是链接（`usePrs`）。
- 后台任务卡：`useBackground` 里在跑的，秒数每秒走，停止走 `session.stopTask`。

## 标题栏工具和 ⋮

- ⓘ 之后是 终端、审阅（`files` 面板）、浏览器、文件（`explorer`）——各自打开右侧面板对应标签，再点一次关面板。`data-tool` 是面板 id。
  别的机器上的对话没有审阅 / 文件（文件在那台机器上）。
- ⋮ 顶上加了 旁聊（Ctrl+;）、后台任务（在跑的数量）、保持电脑唤醒（只有桌面版；`SessionMeta.keepAwake`，这个对话在跑时
  `reportKeepAwake` 的第三个参数让它保持唤醒；`pool` 的 state 事件调 `recheck()`）。

## 输入框

- 对话里（不是首页、不是手机）：框里一行 `+ · 文字 · 麦克风 · 插话 · 发送`，权限 / 模型 / 子代理 / 强度 / 上下文小环在框下面一行
  （`ComposerUnder`，`.composer-under.cb`——带 `.cb` 是为了沿用那些 chip 的样式和容器查询）。
- 框里一行是 CSS 做的：`.composer-box.one-line` 是 flex，`.composer-bar` `display: contents`，按 `order` 排 `+`、textarea、右边按钮。
  `display: contents` 的元素量不出尺寸，ui-smoke 量 `.composer-box` 和 `.composer-under`。
- 首页的输入框没动（项目 / 分支 chip 在框里，ui-smoke 一大段测它）。
- **和官方不一样的地方**：官方是 Enter 发送、Ctrl+Enter 排到后面。我们一直是「在跑时 Enter 排队、插话按钮马上说」，很多测试和停靠的
  权限卡都靠它，所以没换：加了 **Ctrl+Enter = 插话**（纯文字时），占位字写明「Enter 排到这一轮之后，Ctrl+Enter 马上插话」。
- Ctrl+U = 添加文件或图片（只在输入框里，和 Shift+Tab 一样由输入框自己处理；`SHORTCUTS` 里有一行 `attach` 给速查表）。

## statusLine（已删，2026-10-18）

- 曾经把用户 `~/.claude/settings.json` 里 `statusLine` 命令的输出画在输入框上方（`session.statusLine`、设置 `ui.statusLine`）。
  用户看了说「这些都拿掉，没有意义的」——模型、分支、额度、上下文这些界面里本来就有。整块删了（服务端运行器、ANSI 解析、设置项、样式）；
  meta.json 里留着的 `ui.statusLine` 没人读，无害。别再加回来，要加先问。
- 当时踩过的坑（万一再做）：`tput sgr0` 写 `ESC ( B ESC [ m`，字符集那段也要丢；`38:2::R:G:B` 按 `;` 分组、组里按 `:` 分；
  脚本留后台进程占着 stdout 时 `close` 等不到，`exit` 后 150ms 就取输出；Windows 上 Git Bash 别拿成 System32 的 bash.exe（WSL）。

## 模型菜单和 + 菜单

- 模型菜单的行有 1–9 的号，搜索框空着时按数字直接选（`flat` 的顺序，收藏 / 最近也算）。代价：搜索不能以数字开头（「4o」要打「gpt-4o」），
  官方菜单没有搜索框，所以没这个问题；选错了能马上换回来，就照官方。
- 「智能程度 ›」一行打开旁边强度 chip 的菜单（`EffortChip` 的 `openSignal`，和子代理那行一样的做法）。
- 快速模式：CLI 在 init / result 里报 `fast_mode_state`（和 `fast_mode_disabled_reason`）才有这一行；`not_first_party`（中转）和
  `disabled_by_env` 永远不画。开关走 `session.fastMode` → `applyFlagSettings({ fastMode })`。
- 官方的「更多模型 ›」没做：我们的列表本来就全列出来，还能搜。
- + 菜单：斜杠命令（往框里放一个 `/`，命令列表就出来）、连接器 ›（这个对话的 MCP 服务器逐个开关，`session.toggleMcp` →
  `toggleMcpServer`，然后重新拿 `mcpServerStatus`；对话没在跑时只能看）。新 id 在 `PLUS_ID` / `MODEL_MENU_ID`，reach 表的
  `when: 'live' | 'fast'`。

## 对话里

- 运行行（`RunCard`）：Claude 标记转着（`.pip.spark`，3 秒一圈，减少动效时不动），后面是模型名。
- 计划卡（`TodoBody`）：发丝边框、行间细线；进行中是转的弧、待办是虚线圈、完成是勾 + 删除线。右侧任务面板里的计划不加框。
- 计划在对话最底下（2026-10-18，用户：「放在最下面，和 claude 桌面端一样」）：`ChatView` 的 `PlanDock`，取最后一轮里主 agent
  最后一次 TodoWrite（`model/turn.ts` 的 `turnPlan`；子代理自己的计划不算），画在所有轮之后；步骤里的 TodoWrite 还是一行。
  更早的轮的计划不放到底下。
- 回复下面的操作多了「分叉」（`forkAt(sessionId, it.uuid)`，从这条回复之后）和「2 分钟前」（7 天以上显示日期）。
- 浏览器的空白页列出对话目录 `.claude/launch.json` 里的开发服务器（`preview.list`，在跑的带地址），▶ 启动并打开（`preview.start`，
  第 5 期的 `PreviewService`）。别的机器上的对话不列。每行写出 ▶ 会跑的命令（别人仓库的 launch.json 就是别人的命令）。
  `PreviewService` 的键按 `rootKey`：Windows 上路径不分大小写（同一个文件夹大小写写法不同，以前算两个项目，第二个启动报端口被占）。
- 官方「文件」面板的「打开的文件会显示在这里」没做：我们打开的文件是窗格里的标签，不在面板里。

## 测试

- 单元：`info-model.test.ts`、`keep-awake.test.ts`（`also` / `recheck`）、`preview/service.test.ts`（`list`）。
- ui-smoke 的 `recording-ux` 段：信息栏五张卡、上下文折叠存设置、ⓘ 开关、标题栏三个工具、⋮ 顶上两项、框下一行的位置、+ 菜单在对话里的
  reach、斜杠命令、模型菜单的号和强度 ›。截图脚本的做法：demo 数据 + 离屏 Electron（见 `scripts/readme-shots.cjs`）。

## 第二轮（2026-10-17：用户的截图、反馈、第二段录屏、GitHub issue #3–#9）

### 修掉的 bug（根因）

- （历史）**大图片 / 截图失败「Could not load the "sharp" module」**：当时的 ccb 引擎把 sharp 的 JS 打进了包、原生的 `@img/sharp-<平台>` 没跟着发，
  所以根 package.json 加了 `sharp`（0.34.5），`electron-builder.yml` 的 asarUnpack 加了 `sharp` 和 `@img`。ccb 已删（「只留 Claude」），这两处还在，是否还需要没查。
- **「Unknown skill: anthropic-skills:xlsx」**：官方桌面版把 Anthropic 的技能（xlsx / pdf / docx / pptx…）作为插件 `anthropic-skills` 下到
  `%APPDATA%\Claude\local-agent-mode-sessions\skills-plugin\<账号>\<id>\`（mac `~/Library/Application Support/Claude/…`），在那边开始的对话
  拿到这里接着聊，列表里有这些名字，CLI 却没加载。`runtime/desktop-skills.ts` 找最新的那个目录，作为本地插件给 SDK（和网吧的插件一起），
  设置 `claude.desktopSkills` 可关。只读用户自己的下载，不拷贝。实测 init 里列出了 `anthropic-skills:*`。
- **「后台 · 19 条命令」不在跑也占着**：后台命令 / 子代理在**一轮进行中**结束时，CLI 把结束通知直接塞给模型（transcript 里一行
  `queue-operation` enqueue + `<task-notification>`，紧接着 remove），**流上不发 `task_notification`**——只有等到下一轮才处理的那种才发。
  登记表就一直「在跑」，pool 还因为它留着进程。`BackgroundService` 每 5 秒对有在跑任务的对话读 transcript 新增的部分（只认
  `"queue-operation"` 行，别的行里引用的不算；从第一次有后台任务时的文件末尾开始读），把结束补上。
- **改了名过一会又变回去**：CLI 进程把标题记在内存里，`reAppendSessionMetadata` 时只从文件尾部一段里刷新——改名那一行被一长轮挤出这一段后，
  就把旧标题写回去。官方二进制有 `rename_session` 控制请求（`Query.renameSession`，runner 的 `renameLive`）；它失败时（当时的 ccb 引擎没有这个请求）hub 的 `renameKept` 把新名字记在
  `SessionMeta.pendingTitle`，列表显示它，进程结束后再写一次。
- **对话名变成了对话里最后一句话（2026-10-30 用户报告，重启也一样）**：另一个原因，和上一条无关。SDK 的 `listSessions` /
  `getSessionInfo` 只读头尾各 64 KB，标题取 `customTitle || aiTitle || lastPrompt || summary || firstPrompt`——改名那一行被后面的长轮挤出尾部
  64 KB 后，名字就退成**最后一句话**（本机 71 个改过名的对话里 3 个已经这样，「网站设计」显示成「/model」）；没改过名、也没有 AI 标题的对话，
  名字也会随最后一句话一直变。修法（`sessions/titles.ts`）：自己读整个 transcript 里**最后一条** `custom-title` / `ai-title`，按文件记
  「读到哪了」只读追加的部分（文件变短就从头读），记录存在 `<数据目录>/session-titles.json`；没读过的文件在后台读一遍（本机 254 个文件、
  4.8 GB 的目录约 8 秒），读完再通知列表刷新。名字的顺序（`rowTitle`）：改的名 → AI 标题 → 第一句话，**不用最后一句话**。`list()` 和
  `info()`（分叉起名也走它）都用它。`pendingTitle` 仍然最优先（hub 里）。验证：`titles.test.ts`；`.probe` 脚本对真目录：三个对话的名字回来了。
- **Mirasim 里看不到这边的对话 / 列表里少对话**：SDK 的 `listSessions` 只读每个 transcript 头尾各 64 KB；第一句很长（贴了截图——base64
  在开头写两遍：queue-operation 行和 user 行）、尾部又没有标题类的行（`custom-title` / `ai-title` / `summary` / `last-prompt`，CLI 正常
  退出才写，进程被杀就没有）的对话，**整个不列出来**（实测）。我们的列表另外扫目录补上（`sessions/unlisted.ts`，按大小 + mtime 缓存）；进程
  结束时 SDK 还列不出的，补一行 CLI 正常退出会写的 `last-prompt`，别的用 SDK 读历史的应用（Mirasim）也看得到了。同一个原因让 issue #9 的
  目录成了「(未知目录)」：`cwdFromTranscript` 往后读找第一个 `"cwd"`，进程在跑时用 runner 的 cwd 兜底。Mirasim 自己的代码是混淆过的，没去读。
- 账号菜单被「扩展」等整页盖住：图标栏 z-index 3，整页 6；`.rail:has(.menu)` 升到 40（模态框 50 以下）。
- 侧栏搜索只匹配标题和文件夹名（#7）；项目 / 文件夹默认收起、当前对话所在的打开（#3，设置 `ui.sidebarFolded`）；按供应商的模型列表可折叠
  （#4）；settings.json 指向中转时内置 Claude 叫「Claude Code · 中转 host」（#5 #6，`config.auth` 带 `relay`）；没标题的新对话标签叫
  「新对话」（#8）。
- 「工具调用常失败」：扫了本机 4 天 2235 次调用、76 次失败——三分之一是「文件读过之后被改了，要重读」（编辑工具的正常保护），其余是普通的命令
  错误；系统性的只有上面的 sharp 和技能两条。

### 新加的界面

- logo 是**用户自己给的那张**（黑色超椭圆底 + 白色「r / b」+ 橙点 `#ff5a1f`；第三轮用户说「不要擅自换」——第二轮我自己画的 c/w 已撤掉）：
  按原图量出的尺寸重画成矢量（超椭圆 n≈4.5）。`web/public/icon.svg` 是唯一源，`node scripts/icons.cjs`
  （sharp）出 PWA / 桌面 / 官网的图；侧栏内联画同样的形状（`ui/AppLogo.tsx`）。
- 新对话页的动态背景（第二段录屏）：`features/home/AsciiField.tsx`（canvas，15 fps，看不见时不画，减少动效时静止，设置 `ui.welcomeBackdrop`），
  数学在 `ascii-noise.ts`。（2026-10-24 这个「字场」删了，设置换成 外观 → 背景动画，见第五轮末尾。）
- 新对话页的输入框：框里一行，框下一行是 代码 / 聊天（官方标题栏的 chat / code：这里就是「只聊天」）、电脑、文件夹、分支、权限，右边模型
  （设置 `ui.welcomeLayout`，`inbox` 放回框里；ui-smoke 的首页那一大段用 `inbox`，新布局有自己的一条检查）。
- ☰（图标栏最上面）：桌面版弹出原生应用菜单（`desktop:appMenu` → `Menu.getApplicationMenu().popup`，新加「前往」：后退 / 前进），浏览器里是
  `rail/AppMenu.tsx`。← →：`workbench/nav-history.ts`（纯逻辑 `nav-model.ts`），看过的对话的历史，新对话页也算一个位置；Alt+← / Alt+→、
  macOS 菜单 ⌘[ ⌘]（Windows 的菜单项只显示不注册，不然按一次走两步）、鼠标侧键。
- 回复下面的「钉住」（`SessionMeta.pinnedMsgs`，信息栏「钉住的回复」卡，点一下滚过去并闪一下）和「朗读」（`speechSynthesis`，按文字判断中英）。
- 模型菜单的「更多模型 ›」：一个供应商超过 6 个模型时只先列 5 个（当前的那个总在），其余在这一行后面（`foldMenu`）。
- 对话里的子代理颜色跟着主题的强调色（10 档深浅，`.chat-tile` / `.composer` 里覆盖 `--agent-N`）；后台页面还是彩色角色。
- 截图 / 演示脚本和长期开着的演示服务器都用 `C:\work` 下的演示项目——**两个不能同时跑**（后一个的清理会删掉前一个的文件夹）。
- 独立验证后补的（b7c570c）：Alt+← / Alt+→ 不在任何文本框里生效（macOS 的 Option+← 是按词移动光标）；后台补结束只认真正 `type` 为
  `queue-operation` 的行，超过 32 MB 的一行直接跨过去；`last-prompt` 之前文件没以换行结尾就先补一个换行；进程结束后的两种补写都先确认
  `pool.stateOf` 是空或 `closed`，server 中途退出留下的 `pendingTitle` 在下次启动时写回。官方技能插件改成加载一个**镜像**
  （`<dataDir>/runtime/plugins/anthropic-skills`，同名，技能是指向官方目录的 junction / 符号链接），去掉只在官方 App 里才有工具的那些
  （`APP_ONLY`：内置浏览器、Chrome、操控电脑、记忆、docs、定时任务、引导…）；清理镜像时先 `lstat`，链接只 unlink / rmdir，绝不递归进去。

## 第三轮（2026-10-17：用户截图 + 一段录屏）

- **Claude 的思考一直是空的**（别家模型有）：接口的 `thinking.display` 在现在的 Claude 模型上默认 `omitted`，思考块只有签名。官方二进制被 SDK 调时只发
  `{type:'adaptive'}`（`-p` 打印模式下它甚至明确发 `omitted`）。用假端点记录请求体查实（`$TEMP/req-spy-server.cjs` 的做法：
  `ANTHROPIC_BASE_URL` 指本机、回 401、只记 `anthropic-beta` 和除 messages/system/tools 以外的字段）。修法：官方二进制加
  `--thinking-display summarized`（`session-runner.ts` 的 extraArgs；`noThinking` 时、启动模型不是 Claude 时不加）。只给 Claude：中转后面的 DeepSeek / Kimi 这类
  Anthropic 格式接口可能不认这个字段。`redact-thinking-2026-02-12` 那个 beta 只在交互式终端发，不是原因。（历史：当时 ccb 引擎另走 `CLAUDE_WEB_THINKING_DISPLAY`，已删。）
- 思考行的标题用摘要里的粗体小标题（`chat/thinking-title.ts`：在想时取最后一个，想完取第一个），用时放在后面；正在做的那一步是四个点轮流亮
  （`WorkDots`，强调色，减少动效时不动）。
- 输入框下面一行中间：这个对话的「几轮 · 几步 · tok/s · 缓存命中」（`model/conv-stats.ts` + `composer/ConvStatsLine.tsx`，按每轮的 result 加总）。
  第四轮用户说「要的是 tok/s，不是 token——token 最右边那个圆环已经有了」：去掉了 token 总数。tok/s = 全部输出 token ÷ 模型时间；
  引擎报的 `duration_api_ms` 是这个进程的累计值，服务端 `turnShare` 把它换成每一轮自己的（`RunningTotals.apiMs`，变小了就是换了进程），
  账本也存每轮的；历史轮从账本带上 `duration_api_ms`；一轮没有模型时间（以前别的 agent 是这样）或者是旧账本里的累计值（比整轮还长）就用整轮的时间。
  放不下的整项藏掉（换行到被裁掉的第二行）。
  0.2.8 用户报「tok/s 怎么没有」：在新对话页开的对话一直不出统计条。原因是选择器取的 `conv.items`——reducer 原地 push、只把 `version`
  加一，数组还是同一个，`useMemo` 永远不重算（从历史打开的对话是整份换掉，所以那边好的）。改成取 open 条目、按 `version` 重算；
  `store/selectors.test.ts` 加了一条，组件里直接选 `conv` / `conv.items` 会被拦。
- 欢迎页背景：字在内容列（`.home-col`）附近渐隐、里面只留一点，整体更暗（`AsciiField` 的 `calm()`）。
- 第四轮（用户：「背景还是有一点丑」，又给了一段官方录屏）：改成满屏很暗的细小字母数字（每格都有一层底 `FIELD_BASE`，斜向的亮带 `bandLevel` 叠上去），
  字偶尔跳变；**每次点击页面放出一圈涟漪**（`rippleLevel`：主题强调色的小圆盘张开成环、淡出，1.3 s），没有鼠标悬停高亮了。
  纯函数在 `ascii-noise.ts`，有测试（2026-10-24 删字场时 `rippleLevel` / `bandLevel` 一起删了，只留字流用的 `makeNoise`）。
  **画法要省**（独立验证测出：每帧逐个 fillText 一万多个字，1440×900 下占主线程约八成）：字常驻在一张离屏层上，每帧只重画闪烁的 0.8%；
  亮度是一张每 2×2 格一个像素的小图（`MASK`），每帧 `copy` 层 + `destination-in` 遮罩两次 drawImage；只有涟漪照到的格子用 fillText。
  平时 8 fps、有涟漪时 20 fps。无头 Chromium（软件渲染）1440×900 下主线程约 14%，帧内 JS 约 3 ms。
- 第五轮（用户：「有点单调，自己设计一个有意思特别的」）：新的默认背景 **字流**（`features/home/LetterFlow.tsx` + 纯函数 `letter-flow.ts`，有测试）——
  字母像水里的墨顺着一股会慢慢转向的水流飘（`current()`：噪声给方向和速度），每个字拖一小段淡出的尾巴（每帧用背景色盖一层
  `TRAIL_FADE`，见下面「拖尾不能往透明擦」），一段时间后淡出、在别处重生；鼠标经过会把字拨开（`PART_R`）；点一下溅出一圈主题色的字（`splash`）；**在输入框里打的字会
  从光标处飘出来**（主题色、先大后小、几秒后褪成普通的字汇进水流；输入法提交的中文也会，听 `compositionend`；光标位置用一个看不见、排版和输入框一样的镜像层量：光标前的文字 + 一个标记，标记在哪光标就在哪，自动换行和滚动都对得上；
  只量最后一行宽度的老办法在换行后会从第一行末尾冒出来）。镜像层每次都要把光标前的全部文字排一遍版：放到按键那一帧画完之后
  （`requestAnimationFrame` → `setTimeout 0`），光标前超过 `MIRROR_MAX`（4000 字）就不量了、从框顶中间出来——不然 10 万字时每个键慢 300 ms
  （独立验证测出；改后按 keydown → rAF → setTimeout 量：10 万字时字流 / 关 p50 20 / 18 ms）。按**生效的**主题（`store.theme`，跟随系统时系统一切换也算）重建，画布是不透明的，颜色必须跟着换。
  内容列附近淡一些。
  设置 `ui.welcomeBackdrop` 从开关改成三选一 字流 / 字场（上一版）/ 关（`backdropStyle()`：旧的 `false` = 关；`Seg` 加了 `norm`）。
  2026-10-24（用户：「就做动画或者无在外观里面设置就好」）：三选一去掉，换成 外观 → **背景动画** 开 / 关（`ui.backdropMotion`，默认开，`letter-flow.ts` 的 `backdropOn()`；没设过时旧的 `ui.welcomeBackdrop` 是 `'off'` / `false` 仍算关，不写迁移；设置页的开关用 `Toggle` 的 `read` 显示同一个结果）；字场（`AsciiField.tsx`）和 `Seg` 的 `norm` 删了。
  调参记录：拖尾 0.16 太长（字被拖成一串「]]]]]」），0.34 又太散像灰尘，0.24 + 每 1700 px² 一个字 + 墨色 0.36 合适。
  普通的字从一张一次画好的字模（每个字一格）贴上去，不逐个排字；主题色的字（打的、溅的，任何文字）才用 fillText。20 fps。
  **拖尾不能往透明擦**（独立验证测出）：`destination-out` 在 8 位透明度里擦不到 0，一分钟后整页蒙一层 2/255 的灰；改成每帧用面板自己的背景色
  （往上找第一个有背景的祖先，每秒重读）盖 0.24，残留只差背景一两级。每个字往回补画几个影子的办法试过，画的次数翻六倍，太重。
  量法：有 GPU 的 Chromium 窗口放到屏幕外（`--window-position=-3000,-3000`），CDP TaskDuration：1440×860 字流约 25%（脚本 6.6%）、字场约 18%、关 0.2%；
  按键到画出来 40 ms 左右，和关掉时一样。`.home-col` 的位置每 0.5 s 才量一次（每帧量会在打字时强制排版）。
  无头 Chromium 量出来的占用大头是软件栅格化（脚本只占 4–9%），Electron 里有 GPU。ui-smoke 的「Brief / 频道」原来点完输入框立刻查菜单关没关，
  菜单有退场动画，主线程忙时还在：改成等最多 2 s（它要验证的是会关，不是瞬间关）。
- logo 换回用户给的那张（见上面「第二轮」里的那条）。
- 界面 bug：
  - 图标栏顶上的 ☰ 和收起侧栏并排放不下（☰ 被窗口左边切掉一半），改成上下叠放。
  - 欢迎页框下一行太挤、权限和模型按钮重叠，改成右边那组换到第二行。
  - 手机上标题压在右边的圆按钮上（iOS Safari，用户截图），我在 Chromium 和 Playwright WebKit 里都没复现。做了两层防护：
    - 标题区 `contain: paint`，按钮在上层；目标细条加上裁剪；
    - 手机壳的 iframe 用 `width:1px; min-width:100%`，防止 iOS 把 iframe 按内容撑宽。
  - 手机欢迎页横向滚动的建议按钮在边上渐隐，不再被硬切。
  - 扫描工具：`$TEMP/pw/sweep.cjs` / `sweep2.cjs`（Playwright Chromium，几种宽度、两种主题，报出屏、互相压、硬切的字），`$TEMP/pw/phone.cjs`（WebKit，iPhone 尺寸）。
- 子代理可以用任何供应商的模型：见 `models` 笔记「子代理用别家的模型」。
- 从其它工具导入：见 `import` 笔记。
