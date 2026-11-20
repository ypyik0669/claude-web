# 界面改版 2026-11 阶段 4：首页 / 对话 / 右侧面板 / 手机对话页（2026-11-20）

方案：#pages 首页 /「输入框下面这一行」/ 右侧面板 / 对话头，#phone 对话页（问题 1、2、4、5、6、7、10、16），plan 阶段 4。样式都在
`web/src/styles/redesign-chat.css`（`main.tsx` 里最后加载，同一个选择器这里赢）。

## 首页（`workbench/Welcome.tsx`）

- 只剩：Claude Web 自己的标志（`AppLogo`，不是橙色星号）· 「今天想做点什么？」· 输入框和它下面那一行。下面不叠东西：
  - 三条建议（`home/model.ts` 的 `STARTERS`：讲讲结构 / 找 bug / 补测试）**只在输入框里的项目还没有对话时**出现：Composer 用
    `onProject` 把当前项目（cwd + 机器）报给 Welcome，`projectHasConversations()` 看会话列表（`isWithin` cwd，或 meta 的
    `groupCwd`）。列表没到之前不算（`store.sessionsListed`，`refreshSessions` 第一次回来才置 true），不然开机一闪。
  - 入门清单**只在第一次**：`firstTime()` = 列表到了、本机一个对话都没有。之后清单不再出现（它里面没做完的步骤也就不提醒了）。
  - 没模型 / 没登录的提示（`EngineNotice`）照旧，只在真的没模型时。
  - `HomeLists`（最近任务 / 定时任务 / 已归档）删了——侧栏有（`home/model.ts` 里给它用的 `homeRows` / `homeTabs` /
    `waitingText` 等一起删了，`agoText` 留着给定时任务页）；首页的导入提示（「把 Codex 等工具里的对话也列在这里？」）删了，只剩
    侧栏那条。**注意**：侧栏那条仍按 `sidebar/newcomer.ts` 的 `hintReady()` 等清单做完 / 关掉（最多 3 天），清单现在只在第一次
    出现，这个等待其实可以去掉——那是侧栏（阶段 3）的文件，没动，写在报告里了。
  - 输入框下面留给「东西搬到哪了」（`home/MovedNotice.tsx`，合并后由发版那边挂）。
- 背景默认不动：`home/letter-flow.ts` 的 `backdropOn()` 没设置 = 关（只有明确选过的旧 `ui.welcomeBackdrop` 字流 / 字场 / true 还算开）；
  外观 › 背景动画 照旧能开。开场的「放完留作背景」默认**不变**：`opening/model.ts` 的 `keepOn` 改用 `backdropOff()`（只有明确关掉
  背景动画才跟着关），一行，是开场那边的文件。
- 手机：标志和问候在上，建议一条一行在中间，输入框沉到底（拇指够得着），`order` 排的。

## 输入框下面这一行（`composer/ComposerBar.tsx` 的 `ComposerUnder`，`Composer.tsx` 组装）

- 新对话：文件夹 · 分支 · 权限 … 模型 · 子代理 · 思考强度。「本机」**只在有别的机器（联邦 peer）或 WSL 时**并进文件夹，写成
  「本机 · acme-shop」一项（`.cb-where`；`MachineChip` 的 `hideWhenAlone`；WSL 发行版在欢迎页挂载时静默列一次 `loadWsl(false)`）。
- 对话里：权限 · 缓存命中 · 速度 · 步数 · 轮数（`ConvStatsLine`）· 模型 · 子代理 · 思考强度 · 小环。
  - 窄的时候数字从末尾掉（先轮数、再步数）：`.conv-stats` 是 `direction: rtl` + 固定一行高，放不下的折到看不见的第二行；
    `@container (max-width: 680px)` 时「缓存命中」写「缓存」。
  - chip 永远带字（用户：「都写字」）：老规则在窄行里藏 `.opt` 文字，这一行里全部放回；只有模型名会缩。整行连模型名缩到 6em 都放不下时，
    右边一组整组换到第二行（`data-wrap`）。量的是两组里**每个 chip 自己的宽度 + 间距**（不是组的盒子：换行后组被拉满一整行，
    量盒子就永远回不来——第一版就是这样，分屏里换了行再也不回一行）、模型名还能缩到 6em 的量；每次渲染和 ResizeObserver 都量。
  - 「发送后继续」删了（没在跑的对话 chip 照旧能选，发送时按它重开）。
- 代码 / 聊天 不在这一行了：在 ＋ 菜单的「只聊天」，开着时框里有可删的标签。
- `ui.welcomeLayout: 'inbox'`（chip 在框里的老布局）还留着给桌面；ui-smoke 的种子 meta.json 用的就是它，测「下一行」要先
  `setSetting('ui.welcomeLayout', 'under')`。

## 上下文小环（`composer/ContextMeter.tsx`、`stats.ts`）

- 只要知道占用就有环，**永远写百分比**；< 60% 淡（`quiet`），60% 起深一点（`note`），80% 起加粗（`strong`），95% 起红（`err`）。
- 卡片（悬停 / 聚焦 / 点击）= `usageCard()`：「上下文 n%」+ 已用 / 窗口 + 一根条，然后 输入 / 输出、缓存命中、速度、轮数 · 步数、
  费用、上一轮用时、后台任务，最后一句「快满时 Claude Code 会自动压缩」。这一行窄时丢掉的数字这里都有。
- 手机：点环出底部单（`.ctx-sheet`，`PHONE_SHEET_ID.ctxSheet`），同样的内容。
- 会话头 ⋯ › 更多 ›「本对话用量」还在（`showUsageCard`）：不报占用的 agent 没有环，也能看到卡片。

## 手机的「模型 · 强度」单（`models/ModelMenu.tsx`）

- 手机这一行是 项目 · 权限 ·「模型 · 强度」（一颗 chip）· 小环。点开是一张单：标题「模型和思考强度」、模型列表、**五档分段**
  （`effortSeg`：`.mm-seg [data-level]`，44px，深度编排一行）、子代理一行（`subagentRow`）。没有单独的「强度 ›」行。
- 子代理 chip 在手机上挂在 `ComposerUnder` 的 `offstage`（不显示），模型单最后一行打开的就是它的单。
- 单里不出现 < 12px 的字（问题 2：类型标签 / 窗口 12px，行号 `.mm-num` 藏掉），行和按钮 44–48px（问题 1）。

## 右侧面板（`workbench/Dock.tsx` 的 `PanelPicker`）

- 一次显示一个。五个固定标签删了，左上角一个下拉：任务 · 终端 · 改动 · 浏览器 · 文件（带键位）、这个对话的 Artifacts、已打开的
  其它面板（每个带 ×）、更多面板。点外面 / Esc 关，焦点回下拉；用键盘在「已打开」里关掉一个，焦点移到下一行（没了就关菜单、回下拉——
  老「更多」re-review M-b 的做法搬过来）。
- `model/layout.ts`：`CORE_PANELS = tasks, terminal, files, browser, explorer`（= 对话头工具的顺序），`files` 的标题「审阅」改「改动」
  （命令面板仍能用「审阅」搜到：`palette/moved.ts` 的 `PANEL_OLD_NAMES`）；新面板 `artifacts`（extra 层）。
- Artifacts 面板（`panels/ArtifactsPanel.tsx`）：`useArtifacts` 按这个对话 + `isArtifactPath()`（和 `server/src/library/artifacts.ts`
  的 KINDS 同一张扩展名表）过滤，一行一个，点开是 Doc 标签；远端对话 `blockRemoteOpen`；底部「所有对话的 Artifacts」进整页。
- 宽屏、面板关着时信息栏照旧（信息栏的逻辑没动）。「显示工作台工具」的老面板（图标标签、能拖）不变。
- 手机底部面板：同一个 Dock。下拉写全名、44px（问题 16）；拉到顶 = 全屏（`--sheet-share: 1`，圆角去掉）；往下拉关（原来就有）；
  把手条 44px 高（它是按钮：点一下半高 ⇄ 全高，是点按目标）；提交按钮本来就在底部（`review-phone.css` 折叠的「提交 N 个文件」）。

## 快捷键

- **Ctrl 1–5 = 五个面板**：桌面版是菜单加速键（`desktop/src/main.ts`）；浏览器里 Ctrl 1–5 是切浏览器标签，页面认 **Ctrl+Shift+1–5**
  （`matchBrowserKey`，`PANEL_KEYS`），两边都认后者。页面不认普通 Ctrl+数字，所以桌面版不会处理两次。
- 分组跳转挪到 **Ctrl+Alt+1–9**：页面处理（`App.tsx` 对带 Alt 的组合放行），桌面菜单只显示（`registerAccelerator: false`）。
- **Ctrl+I = 对话信息栏**（`info.toggle`；Monaco / 终端里不抢它们自己的 Ctrl+I），桌面放行表里加了它。Ctrl+J 照旧。
- 桌面菜单的五项叫「任务面板 / 终端面板 / 改动面板 / 浏览器面板 / 文件面板」：英文目录里**同一个中文 key 在 web 和 desktop 必须同一个
  英文**（`i18n/coverage.test.ts`「the Chinese is only a key once」），web 的「任务」是 Task、「文件」是 File。终端的 Ctrl+` 留了一个
  隐藏菜单项（页面自己也认）。

## 对话头（`tiles/ChatTile.tsx` + `tiles/ConvMenu.tsx`）

- ⓘ 和面板开关进了 ⋯。右边：「+N −M」（只在信息栏不在、桌面）· 五个工具（任务 · 终端 · 改动 · 浏览器 · 文件；远端对话只有任务和
  浏览器）· ⋯。工具亮 = 面板开着、没收起、正显示它；亮着的再点关面板；面板收成图标栏时不亮，点了展开到它。
- ⋯（桌面）：重命名 · 分叉 · 导出… · 步骤视图 · 更多 | 对话信息栏（勾、Ctrl I）· Issue 与 PR · Android 屏幕 | 交给其它 Agent… |
  归档 · 删除。「更多」和「交给其它 Agent…」**原地展开**（同一个菜单里多出一段）：`useAnchoredMenu` 同时只能开一个菜单，飞出的子菜单
  会把这个关掉；阶段 3 在给侧栏菜单做飞出，接口没改，我没用。更多里：旁聊、思考语言、查看模式、本对话用量、后台任务、保持电脑唤醒、
  置顶、在资源管理器 / VS Code 打开、结束进程 / 恢复运行、引用到输入框、交给常开机器、原生 CLI、复制 ID。
- 老 ⋯ 列的「视图」（改动 / Git / 文件 / 搜索 / 生成的文件 / 定时任务 / Issue 与 PR）没了：对话头工具 + 命令面板「查看这个对话的…」，
  `panel-entries.ts` 的入口表改了（`headerTool` / `headerMore` / `panelPicker`），`panel-entries.test.ts` 仍保证每个 ≤ 2 次点击。

## 手机对话页

- 头只有 ☰ · 标题 · ⋯（工具和「+N −M」手机上不渲染）。
- ⋯ = 底部单（`ConvMenu` 的 phone 分支，挂在 `MenuHost` 里）：标题（项目 · 分支）、**六宫格** 改动 · 任务 · 终端 · 文件 · 浏览器 ·
  Artifacts（带 +N −M / 计划 n/m / 个数；点了拉起底部面板到它）、五行：重命名 · 分叉 · 导出… · 查看模式 › · 更多 ›。› 在同一张单里
  推入一页，左上「返回」。更多：思考语言、旁聊、Issue 与 PR、「最后一条回复…」「我的上一条消息…」（不长按也能拿到长按的操作）、
  交给其它 Agent ›、交给常开机器、置顶、结束进程、本对话用量、后台任务、引用、复制 ID、归档、删除。远端对话的六宫格只有任务和
  Artifacts（Artifacts 原地打开：它的文件在那台机器上）。
- 消息（`chat/MessageSheet.tsx`）：手机上不常显操作图标（问题 7）——`.msg-actions` 视觉隐藏（还在页面里给读屏 / 键盘，聚焦时显示）。
  长按 500ms（移动 > 10px 取消，吞掉随后那次 click；`contextmenu`——安卓长按、鼠标右键——也开）出单：复制 · 编辑（自己的消息）·
  重跑（最后一问 = 再问一次，否则 = 分叉出新对话）· 分叉 · 朗读。第一次在手机上看到有消息的对话时一句一次性 toast（meta.json
  `ui.hint.longPress`）。编辑走窗口事件 `cw:edit-message`，`UserRow` 打开它的内联编辑框。
- 审批卡在输入框上面、三个按钮一行一个、「允许一次」在最上：phone.css 原来就这样，没改。
- 输入框 16px（不会被 iOS 放大）、占位一行：想做点什么？/ 回复… / 或者告诉 Claude 换个做法，不提 Enter。
- 键盘提示一律不显示（问题 4）：`ui/kbd.ts`（`hasKbd` / `isKeyCombo` / `noKbd`）给拼进文字里的提示用；`App.tsx` 给 `<html>` 加
  `phone` 类，`phone.css` 的 `html.phone :is(kbd, .kbd, [data-kbd]) { display: none }`——portal 到 body 的单也管到。命令面板：键位提示
  和底栏标 `data-kbd`，手机不列「键盘快捷键」。
- 点按区（问题 1）：代码块按钮 44 × 44（代码块头跟着变高）；小环、文件夹 chip 用 `::after` 扩到 44；⋯ 单、消息单、小环单、模型单的
  行 44–48。

## 测试

- 单元：`home/model.test.ts`（三条建议、`projectHasConversations`、`firstTime`）、`letter-flow.test.ts`、`stats.test.ts`（卡片顺序）、
  `shortcuts.test.ts`（Ctrl+Shift+1–5、Ctrl+I、普通 Ctrl+1 不认）、`panel-entries.test.ts`、`right-panel.test.ts`、`ui/kbd.test.ts`、
  `wording.test.ts`（ConvMenu / MessageSheet / ArtifactsPanel 进了表，HomeLists 拿掉，PARTS 换成 ChatTile 的 `TOOLS` + `SessionHeader`）。
- `scripts/lib/phone-audit.cjs`：≤ 1px 的控件不算在屏上（视觉隐藏的是给读屏的，不然会被当成「被盖住」）。
- ui-smoke：首页（第一次 = 把 `sessions` 清空看建议和清单、`refreshSessions()` 回来后都消失）、新对话页的行序和静止背景、对话头的工具 /
  ⋯ / Ctrl+I、右侧面板的下拉（菜单内容、键位、已打开的 × 和键盘焦点、1080 / 1440 下离标题栏按钮的距离）、手机 ⋯ 单和六宫格、手机体检
  （对话、⋯ 单、模型单、底部面板 改动 / 任务、新对话页全规则含 44；390 时消息长按单、小环单；对话 / 新对话页 / 命令面板 / ＋ 菜单里
  没有键盘提示）。长按在 ui-smoke 里用 `sendInputEvent` 的 mouseDown，等 750ms 再 mouseUp（鼠标左键也算长按，方便测）。
- ui-smoke 里改过的老检查：「目录菜单开着时把窗口变窄」现在窄到 800（还是桌面）——到手机宽度时文件夹 chip 挪到框下面那一行、
  重新挂载，菜单会关；＋菜单「点外面」点的是输入框右端（首页下面没东西了，框在窗口中间，菜单往上开会盖住框的中间）；Ctrl+Shift+数字
  用页面里派发的 KeyboardEvent（`key: '!'`、`code: 'Digit1'`，和美式键盘上浏览器发的一样）；颜色比较前先关掉 transition（刚换的
  class 还在过渡中，读到的是旧颜色）。

## 没做 / 和方案不一样

- 手机新对话页没有分支：这一行按方案是 项目 · 权限 ·「模型 · 强度」，选分支本该在项目单里，还没做（手机上暂时没有切分支的入口）。
- 侧栏导入提示仍等入门清单（见上，阶段 3 的文件）。
