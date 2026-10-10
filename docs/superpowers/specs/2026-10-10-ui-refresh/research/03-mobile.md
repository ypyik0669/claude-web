# 03 · 手机端调研：编码 Agent 类应用的移动体验

调研日期 2026-10-10。只读调研，没有改仓库、没有下载或运行任何安装包、没有登录任何账号。

**标注约定**

- `[V]` = 已核实，后面括号里是来源（仓库内文件路径 / URL / Mobbin 截图链接）。
- `[I]` = 推断（根据已核实的事实或通用知识推出来的，没有直接读到）。
- claudecodeui 的文件路径都相对于 `https://github.com/siteboon/claudecodeui/blob/main/`，读的是 2026-10-09 的 `main`（v1.37.4 之后）。
- Mobbin 截图是低清预览，文字我只写看得清的部分。

**先说三件会影响决策的事**

1. **claudecodeui 现在已经没有底部 tab bar 了。** 2026-04-10 的 PR #632「remove mobile bottom nav…」把它删了，改成会话头里的一排胶囊 tab `[V]`（`https://github.com/siteboon/claudecodeui/pull/632`，提交 `a8dab0edcf`）。业主印象里的「底部导航」是 4 月以前的版本。下面两种都写清楚了，包括它为什么被删。
2. **claudecodeui 没有下拉刷新、没有滑动手势、没有触感反馈。** 它明确用 CSS 关掉了浏览器下拉刷新 `[V]`（`src/index.css`：`html, body { overflow: hidden; overscroll-behavior-y: contain; }`，注释写明是为了「disables the browser pull-to-refresh gesture」）。它的「方便」来自别的地方：键盘处理、大触控目标、bottom sheet 菜单、终端快捷键条、一行式工具调用。
3. **没看到的东西**：claudecodeui README 里的截图 / GIF 我没有打开（没有下载图片文件），仓库里有 `public/screenshots/mobile-chat.png`，它很可能还是删底部导航之前截的 `[I]`。Kimi、豆包在 Mobbin 里没有收录，T3 Chat 手机网页和 opencode 官方 web 在手机上的表现都没找到一手资料，这几项下面不写结论。

---

## 1. siteboon/claudecodeui（CloudCLI UI）—— 主要参照

仓库现状：13,988 star，最近一次 push 2026-10-09，React + Tailwind + lucide 图标，自托管（`npx @cloudcli-ai/cloudcli`）`[V]`（GitHub API `repos/siteboon/claudecodeui`、`README.md`）。README 关于手机只有一句「Responsive design: Works across desktop, tablet, and mobile」，没有专门讲手机交互，细节全在源码里 `[V]`（`README.md`）。

### 1.1 导航模型

**现在（2026-04 之后）：抽屉 + 头部胶囊 tab，没有底部栏** `[V]`

- 断点：`window.innerWidth < 768` 算手机（`src/shared/hooks/useDeviceSettings.ts`）。
- 整个应用是一个 `fixed inset-0 flex` 的壳，`bottom` 绑在 `var(--keyboard-height, 0px)` 上（`src/modules/project-workspace/ProjectWorkspaceShell.tsx`）。
- 头部 `WorkspaceHeader` 在手机上是**两行**（`flex-col gap-1.5`，桌面 `sm:flex-row`）：
  - 第一行：☰（`MobileMenuButton`，20px 图标，`p-1.5 rounded-lg active:scale-95`）· 供应商 logo 16px · 会话标题（`text-sm font-semibold`，下面一行 11px 灰字项目名）· 断线时才出现的琥珀色小胶囊。
  - 第二行：`PillBar`（`role="tablist"`），可横向滚动（`overflow-x-auto overscroll-x-contain scrollbar-hide`），溢出时左右各一段 48px 的渐隐，切换 tab 后把激活项 `scrollIntoView`。
  - 文件：`src/modules/project-workspace/WorkspaceHeader.tsx`、`WorkspaceTabs.tsx`、`src/shared/ui/PillBar.tsx`。
- tab 顺序和图标（lucide）：Chat `MessageSquare` · Shell `Terminal` · Files `Folder` · Git `GitBranch` ·（开了才有）Browser `MonitorPlay` · Tasks `ClipboardCheck` · 竖线分隔后是插件 tab（`WorkspaceTabs.tsx`）。
- 激活态：胶囊 `bg-background shadow-sm ring-1 ring-border/50`，图标描边 2.2（未激活 1.8）；**手机上只有激活的那一个显示文字，其它只剩图标**（`isActive ? 'inline max-w-28' : 'hidden'`，`lg:inline` 才全显示）。胶囊高 32px（`h-8 px-2.5`），容器 `rounded-lg bg-muted/50 p-[3px]`。
- 头部样式：`border-b border-border/60 bg-background/95 backdrop-blur-sm px-3 py-1.5`，PWA 里靠 `.pwa-header-safe` 处理顶部安全区。
- 切 tab 不卸载聊天：Chat 用 `block/hidden` 切换，其它 tab 条件渲染（`src/modules/project-workspace/WorkspaceMain.tsx`）。

**以前（2026-04 之前）：悬浮玻璃底部 tab bar** `[V]`（`src/components/app/MobileNav.tsx` @ `621853cbfb`，已删除）

- 位置：`fixed bottom-0 left-0 right-0 z-50 px-3 pb-[max(8px,env(safe-area-inset-bottom))]`，一个离屏幕边缘 12px 的悬浮条，不是贴边的整条栏。
- 外观：`nav-glass mobile-nav-float rounded-2xl border border-border/30`。玻璃底 = 背景色 70% 不透明（暗色 55%）+ `backdrop-filter: blur(20px) saturate(1.8)`（暗色 24px / 1.6）；阴影 `0 -1px 20px` + 1px 环。这几个 token 还留在 `src/index.css`（`--nav-glass-*`、`--mobile-nav-height: 52px`、`.mobile-nav-float`）。
- tab：Chat / Shell / Files / Git，TaskMaster 装了加 Tasks，有启用的插件再加一个「More」（`Ellipsis`），点开是向上弹的小菜单。
- 每个 tab：图标在上、10px 文字在下，`flex-1 rounded-xl px-3 py-2 active:scale-95`。激活态：文字和图标变 `text-primary`，背后一层 `bg-primary/8`（暗色 `/12`）的圆角底，图标从 18px 变 20px、描边 1.8 → 2.4，文字不透明度 60% → 100%，过渡 200ms。
- **输入框聚焦时整条栏滑出屏幕**：`isInputFocused ? 'translate-y-full' : 'translate-y-0'`，`transition-transform duration-300 ease-in-out`。
- `onTouchStart` 里 `preventDefault()` 后直接切换，不等 click。

**为什么删** `[V]`（PR #632 正文）

- 底部栏逼着很多页面带一段只为它存在的底部留白（`pb-mobile-nav`），「reducing usable vertical space and creating inconsistent layout behavior」。
- 删掉后「Navigation model is simpler and more consistent (sidebar/menu driven instead of dual nav paradigms)」。
- 同一个 PR 还删了消息流里的「Thinking…」气泡（只留输入框上方的状态条），并把 tooltip 改成 portal + 触屏长按可见。

### 1.2 侧栏 / 会话列表（手机）

- 抽屉：`fixed inset-0 z-50`，面板 `w-[85vw] max-w-sm bg-card border-r`，`-translate-x-full → translate-x-0`，`transition-transform duration-150 ease-out`；背板 `bg-background/60 backdrop-blur-sm`，点一下或 `touchstart` 就关。**没有跟手滑动。** 关着时只是 `invisible opacity-0`，侧栏不卸载。`[V]`（`src/modules/project-workspace/ProjectSidebarRegion.tsx`）
- ☰ 按钮同时挂 `onTouchEnd` 和 `onClick`，touchend 触发后 350ms 内吞掉随后的 click，防止一次点按开两次。`[V]`（`src/modules/project-workspace/hooks/useMobileMenuHandlers.ts`）
- 手机版抽屉头：刷新按钮（32px 方形 `rounded-lg bg-muted/50`，转圈的 `RefreshCw`，**是按钮不是下拉**）· 新建项目（`bg-primary/90`）· 搜索框 `h-10 rounded-xl`，无边框、聚焦时 2px 光环（`.nav-search-input`）。PWA 模式顶部多 16px。`[V]`（`src/modules/sidebar/SidebarHeader.tsx`、`src/index.css`）
- 会话行（手机用紧凑版）：一张小卡 `p-2 mx-3 my-0.5 rounded-md bg-card border active:scale-[0.98]`；左边 20px 的供应商 logo 小方块，标题 `text-sm` 单行截断，右边是「在跑就转圈、否则相对时间（11px）」，第二行一个消息数徽标，最右一个 32px 的 `⋯`。选中 `bg-primary/5 border-primary/20`。`[V]`（`src/modules/sidebar/SidebarSessionItem.tsx`）
- 行左侧外沿一个 8px 的脉动圆点，三种颜色：琥珀 = 需要你处理，紫 = 回合结束但后台任务还在跑，绿 = 最近活跃。`[V]`（同上）
- **`⋯` 打开的是 bottom sheet，不是下拉菜单**：从底部滑入（`translateY(100%) → 0`，220ms，`cubic-bezier(0.22, 1, 0.36, 1)`），`rounded-t-2xl`，底部 `pb-safe-area-inset-bottom`；顶上一条 40×4px 的灰色小横条（纯装饰，`aria-hidden`，不能拖）；标题区是 logo + 会话名 + 「Claude session」；下面每行 `min-h-12 rounded-xl px-4 py-3`、20px 图标：Rename session / Copy session id / Archive or delete session（红字）/ Cancel（`min-h-11`）。改名输入框写死 `fontSize: 16px`，注释是「16px keeps iOS Safari from zooming the viewport on focus」。`[V]`（`SidebarSessionItem.tsx`、`tailwind.config.js` 的 `bottom-sheet-content-show`）
- 批量选择：进入后整行变复选框，在跑的会话锁住不能勾。`[V]`（同上）
- 抽屉底部（手机）：`paddingBottom: env(safe-area-inset-bottom)`；Report issue / Discord / Settings 三行各 `h-10 rounded-xl bg-muted/40`，前面一个 28px 的图标小方块。`[V]`（`src/modules/sidebar/SidebarFooter.tsx`）
- 分隔线是两端渐隐的 1px 线（`.nav-divider`：`linear-gradient(90deg, transparent, …20%, …80%, transparent)`），不是通栏实线。`[V]`（`src/index.css`）

### 1.3 输入框（手机）

结构在 `src/modules/chat/composer/ChatComposer.tsx` + `PromptInput.tsx` `[V]`：

- 外壳：手机上 `px-2 pb-2`；表单是**一张卡**：`rounded-xl border border-border/50 bg-card/80 shadow-sm backdrop-blur-sm`，聚焦时 `border-primary/30 ring-1 ring-primary/15 shadow-md`。
- 文本框：`px-4 py-2 text-sm leading-6`，手机最高 `40vh`（桌面 300px），自动长高。
- 下面一行工具（`border-t border-border/30 px-3 py-2`，`flex-wrap`）：
  - 左：回形针（附件，32px ghost 图标钮）· 麦克风（有语音服务才出现）· **token 小胶囊**（`h-8 rounded-lg border`，20px 蓝底小方块里一个 `Activity` 图标 + 「12.3K」，手机上不显示「tokens」字样，点开是明细）· 斜杠命令按钮（`MessageSquare` 图标，右上角 16px 圆徽标是命令数）· 清空（`X`，手机隐藏）。
  - 右：定时发送 · 模型 / 档位菜单 · **权限模式钮**（32px 方形图标钮，按模式换图标和颜色：default `Hand` 灰、auto `Bot` 蓝、acceptEdits `Smile` 绿、bypassPermissions `AlertTriangle` 橙、plan `ClipboardList` 主色）· 发送（手机上 `h-10 w-10 rounded-lg`）。
- **发送键是多态的**：空闲 = 发送（`SendHorizonal`）；在跑且输入框空 = 停止（实心方块）；在跑且有字 = 排队（向上箭头，提示「Enter to queue your next message」）；正在录音 = 「停止录音并直接发送」；转写中 = 转圈并禁用。`[V]`（`ChatComposer.tsx` 的 `PromptInputSubmit` 那段）
- 排队的那条消息显示成输入框上方一张虚线边的小卡（「QUEUED · Will send when this finishes」，带编辑 / 删除）。`[V]`（`QueuedMessageCard.tsx`）
- 「Enter 发送」之类的提示文字只在 `lg` 以上显示，手机不占地方。`[V]`（`ChatComposer.tsx`）
- **状态页签**：回合进行中，输入框左上沿贴一个 32px 高的小页签（上圆角、无下边框，和输入框连成一体）：脉动圆点 + 流光文字（「Thinking… / Processing… / Analyzing…」每 4 秒换一个）+ 已用时间；右上沿另一个页签是 Stop。进场 320ms（先模糊后清晰、轻微过冲），退场 220ms。`[V]`（`ActivityIndicator.tsx`、`src/index.css` 的 `chat-activity-enter/exit`）
- 斜杠命令菜单：窗口宽 < 640px 时 `left: 16px; right: 16px`，底边钉在输入框上方，最高 `min(54vh, …)`；按来源分组，每组一种颜色的 28px 图标小方块（常用 = 琥珀星、内置 = 天蓝、Skills = 翠绿、项目 = 靛蓝、用户 = 玫红），行内是等宽命令名 + 一行截断的说明。`[V]`（`CommandMenu.tsx`）
- 模型 / 权限菜单：portal 到 `body`，`position: fixed`，用 `right/bottom` 锚定在触发钮上方并向左上长，`maxWidth` 随屏幕缩；`rounded-xl border bg-popover p-1 shadow-xl`。**手机上也是浮层菜单，不是 bottom sheet。** `[V]`（`ComposerMenuPrimitives.tsx`、`hooks/useComposerMenuAnchor.ts`）
- `@` 文件提及：输入框上方一个 `max-h-48 rounded-xl bg-card/95 backdrop-blur-md` 的列表，行 `px-4 py-3`。`[V]`（`ChatComposer.tsx`）
- 语音：`MediaRecorder` 录音 → 上传 `/api/voice/transcribe` → 文字放进输入框；按钮三态（麦克风 / 红色方块 / 转圈）。`[V]`（`VoiceInputButton.tsx`、`hooks/useVoiceInput.ts`）
- 图片：回形针选文件、粘贴、拖放都走同一套附件；附件显示在文本框上方的灰底条里。`[V]`（`ChatComposer.tsx`）

### 1.4 键盘、安全区、触控

- viewport：`width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content`。`[V]`（`index.html`）
- 键盘：监听 `visualViewport` 的 `resize`，把 `window.innerHeight - visualViewport.height` 写进 `--keyboard-height`，整个壳的 `bottom` 跟着抬。只监听 resize，没处理 `offsetTop`。`[V]`（`src/modules/project-workspace/hooks/useVisualViewportKeyboardOffset.ts`）
- 安全区：`:root` 里把四个 `env(safe-area-inset-*)` 存成变量；`display-mode: standalone` 时给 `#root` 加上、左、右内边距；另外用 JS 给 `body` 加 `pwa-mode` 类做兜底；Tailwind 里有 `safe-area-inset-bottom` 这个间距名。`[V]`（`src/index.css`、`tailwind.config.js`）
- 触控（`@media (max-width: 768px)`）：`* { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }`，按钮 `user-select: none`，`.mobile-touch-target { min-height: 44px; min-width: 44px }`。`[V]`（`src/index.css`）
- 触屏上（`hover: none` 且 `pointer: coarse`）把 hover 样式全部中和掉，并且**把「悬停才出现」的按钮强制常显**（`.group-hover\:opacity-100 { opacity: 1 !important }`）；按压反馈保留（`active:scale-[0.98]`）。`[V]`（`src/index.css`）
- `prefers-reduced-motion: reduce` 时全局把动画和过渡压到 0.01ms。`[V]`（`src/index.css`）
- 一个值得注意的点：聊天输入框字号是 14px（`text-sm`），iOS 本来会在聚焦时放大页面，它靠 `maximum-scale=1.0` 压住了 `[I]`；改名输入框则单独写了 16px `[V]`。

### 1.5 聊天渲染（窄屏）

- 内容列 `max-w-[54.25rem] px-4 space-y-3`。`[V]`（`src/modules/chat/transcript/ChatMessagesPane.tsx`）
- 用户消息：右对齐气泡 `rounded-2xl rounded-br-md border border-border/60 bg-muted/60 px-3 py-2`，手机上不显示头像；正文用衬线体 Merriweather。助手消息：通栏、没有气泡，`prose prose-sm font-serif`。`[V]`（`transcript/MessageComponent.tsx`）
- 性能：`.chat-message { content-visibility: auto; contain-intrinsic-size: auto 180px }`，外加按需挂载的 `LazyMessageRow`。`[V]`（`src/index.css`、`transcript/LazyMessageRow.tsx`）
- 代码在聊天里**一律换行不横滚**：`.chat-message pre, .chat-message code { white-space: pre-wrap !important; word-break: break-all; }`。`[V]`（`src/index.css`）
- 回到底部：离底部超过 50px 时，输入框正上方居中出现一个 32px 的圆形箭头钮（`absolute -top-11`）。没有「N 条新消息」计数。`[V]`（`src/modules/chat/ChatInterface.tsx`、`hooks/useChatSessionState.ts` 的 `isNearBottom`）
- 往上滚到顶自动加载更早的消息，另有「Load all」。`[V]`（`ChatMessagesPane.tsx`）

**工具调用**（`src/modules/chat/tools/`，设计说明在 `tools/README.md`）`[V]`

- 两种基本形态：一行式 `OneLineDisplay`（Bash / Read / Grep / Glob…）和可展开的 `CollapsibleDisplay`（Edit / Write / TodoWrite / 计划…），都只有一条 2px 的左边线做强调（按类别着色：编辑 = 琥珀、bash = 绿、搜索 = 灰、todo = 紫、计划 = 靛蓝），**没有四边的盒子**。
- Bash：一个深色小胶囊（`rounded bg-gray-900 px-2.5 py-1`）里绿色等宽字，前面一个不可选中的 `$`，默认单行截断。
- Read：`Read / 文件名`，只显示 basename，点了打开文件。
- **连续的同类调用合并成一行**：`▸ [图标] Edit  x4  / 预览  +12 −3`（`rounded-r-md bg-muted/25 px-3 py-2`），点开才逐条显示。`[V]`（`transcript/ToolGroupContainer.tsx`）
- 成功的结果大多不显示（`hideOnSuccess`），只有出错才出红框。
- 行内 diff：11px 等宽、行高 18px、`whitespace-pre-wrap`；左侧 24px 的 `+ / −` 槽；红绿底色很淡（`bg-red-50/50`、`bg-green-50/50`）；头部一行是可点的文件路径 + 一个「Diff / New / Patch」小徽标。`[V]`（`tools/ToolDiffViewer.tsx`）
- 思考默认折叠，快捷设置里有「显示思考」开关。`[V]`（`MessageComponent.tsx`、`src/modules/quick-settings-panel/QuickSettingsContent.tsx`）

### 1.6 权限请求 / 提问

- 位置：输入框**上方**，出现时顶替状态页签（`hasPendingPermissions` 时不画 `ActivityIndicator`）。`[V]`（`ChatComposer.tsx`）
- 普通权限卡：`rounded-lg border bg-card px-4 py-3`，盾牌图标 + 「Permission required  Tool: `Bash`」，下一行「Allow rule: `Bash(npm test:*)`」，`<details>`「View tool input」（展开后 `max-h-40` 可滚动的 `pre`）。按钮靠右一排，都是 `h-8 px-3 text-sm`：Deny（描边）/ Allow & remember（描边）/ Allow once（实心主按钮）。`[V]`（`composer/PermissionRequestsBanner.tsx`、`composer/Confirmation.tsx`）
- 「Allow & remember」会把**所有匹配同一条规则的待处理请求一起放行**。`[V]`（`PermissionRequestsBanner.tsx` 的 `matchingRequestIds`）
- AskUserQuestion：**整个输入框被换成提问卡**（`!hasQuestionPanel &&` 才渲染输入框）。卡片 `rounded-2xl shadow-lg`，顶上 2px 渐变线；多题时有「1/3」计数和一排 3px 高的进度段（可点跳题）；选项是 `rounded-lg border px-3 py-2` 的整行按钮，行首一个数字键帽；固定带一项「Other」可填字；选项区 `max-h-48` 可滚。`[V]`（`tools/InteractiveRenderers/AskUserQuestionPanel.tsx`、`ChatComposer.tsx`）
- 退出计划模式不走这个横幅，在消息流里的计划卡上处理。`[V]`（`PermissionRequestsBanner.tsx` 的过滤）
- 评价：按钮只有 32px 高、靠右挤成一排，在手机上并不好按——这一点别照抄，下面第 2 节 ChatGPT 的做法更好 `[I]`。

### 1.7 终端（手机）

- **快捷键条**：屏幕底部一条可横向滚动的浮条（`md:hidden`，`rounded-lg border bg-card/95 backdrop-blur-sm`）：粘贴 · Esc · Tab · ⇧Tab · CTRL · ALT · ↑ ↓ ← → · Ctrl+C · 滚到底。CTRL / ALT 是「粘滞」的：点一下亮起，作用于下一个字符后自动熄灭。每个键 `onPointerDown` 里 `preventDefault()`，所以点它们**不会让软键盘收起**。`[V]`（`src/modules/shell/TerminalShortcutsPanel.tsx`）
- **CLI 的编号选项变成按钮**：终端里出现「1. Yes / 2. No」这类提示时，底部浮出一排蓝色按钮「1. Yes」「2. …」和一个 Esc，点了直接把数字发进去。`[V]`（`src/modules/shell/Shell.tsx`，`cliPromptOptions`）
- **选择、缩放、惯性**（自己实现的）：长按 600ms 进入选择，出现两个 22px 的蓝色拖柄和一个「Copy / Select All」浮动菜单；双指捏合改字号（8–48px）；xterm 自己没有惯性，它补了一套（每帧摩擦 0.95）；选择时不弹键盘。`[V]`（`src/modules/shell/utils/mobileTerminalSelection.ts`）

### 1.8 Git / 文件 / 编辑器 / 设置（手机）

- Git 改动行在手机上更紧凑（`px-2 py-1.5 text-xs`），「丢弃」按钮带文字不只是图标；点文件原地展开 diff（最高 600px 的展开动画），头上一个**「换行 / 横滚」切换**（只在手机出现）。`[V]`（`src/modules/git-panel/changes/FileChangeItem.tsx`、`GitDiffViewer.tsx`）
- 提交区在手机上默认收成**一个主按钮**「Commit N files ⌄」，点了才展开说明输入框。`[V]`（`src/modules/git-panel/changes/CommitComposer.tsx`）
- 文件树的菜单挂在 `onContextMenu` 上。`[V]`（`src/modules/file-tree/FileContextMenu.tsx`）iOS Safari 长按不一定触发这个事件，手机上可能够不着 `[I]`。
- 代码编辑器在手机上是浮层全屏（`isFloating = isMobile || poppedOut`）。`[V]`（`src/modules/code-editor/EditorSidebar.tsx`）
- 设置在手机上是全屏页，顶部一排横向胶囊导航，关闭钮 40px，内容区 `pb-safe-area-inset-bottom`。`[V]`（`src/modules/settings/Settings.tsx`、`SettingsSidebar.tsx`）

### 1.9 快捷设置抽屉

- 屏幕右边缘一个小把手（`fixed right-0`，`rounded-l-md p-2`，里面一个 `‹`）。点一下开关；**按住上下拖可以挪位置**（超过 5px 才算拖，位置按视口百分比 10–90 存 localStorage，拖的时候锁住页面滚动）。`[V]`（`src/modules/quick-settings-panel/QuickSettingsHandle.tsx`、`hooks/useQuickSettingsDrag.ts`）
- 面板 256px 宽，从右滑入 150ms，背板 `bg-background/80 backdrop-blur-sm`；两个 tab：Settings（深色模式、语言、显示原始参数、显示思考、Ctrl+Enter 发送、语音）和 Commands（点一条斜杠命令 → 填进输入框并收起面板）。`[V]`（`QuickSettingsPanelView.tsx`、`QuickSettingsContent.tsx`、`QuickSettingsTabs.tsx`）
- 评价：一个常驻的边缘把手会挡内容，claude-web 已经把这些放进了账户菜单和 `+`，不建议照搬 `[I]`。

### 1.10 通知、PWA、连接状态、更新

- manifest：`display: standalone`，`orientation: portrait-primary`，白色主题，72–512 的 maskable 图标。`[V]`（`public/manifest.json`）
- Service Worker：只预缓存 manifest；HTML 永远走网络，`/assets/` 缓存优先，`/api/` 和 `/ws` 不拦；离线时回一个「Offline」页。`[V]`（`public/sw.js`）
- **Web Push**：`push` 事件里 `showNotification`，`tag` = `会话 id:事件码`、`renotify: true`；`notificationclick` 先找已开的窗口 `focus()` 再 `postMessage({type: 'notification:navigate', sessionId})`，没有窗口就 `openWindow('/session/<id>')`。前端用 VAPID 公钥 `pushManager.subscribe`。`[V]`（`public/sw.js`、`src/modules/settings/hooks/useWebPush.ts`）
- 可分别开关三类事件：需要你操作（actionRequired）/ 结束（stop）/ 出错（error），另有提示音。`[V]`（`src/modules/settings/tabs/NotificationsSettingsTab.tsx`）
- 回合在后台结束时给页面标题加 `[Done] `，回到页面 2 秒后去掉。`[V]`（`src/modules/chat/utils/pageTitleNotification.ts`）
- 断线：标题旁一个琥珀色小胶囊（`WifiOff` + 「Reconnecting」，`rounded-full border-amber-500/30 bg-amber-500/10 text-xs`），连着的时候什么都不画；有一个常驻的 `aria-live` 区域给读屏。`[V]`（`src/modules/project-workspace/WorkspaceConnectionStatus.tsx`）
- 更新：抽屉底部一张 44px 高的蓝色小卡（`ArrowUpCircle` + 脉动点 + 版本名 + 「update available」），点开是带更新日志、升级命令和「N 秒后刷新」倒计时的对话框；另有「已更新但没重启」的琥珀色提示。`[V]`（`src/modules/sidebar/SidebarFooter.tsx`、`src/modules/version-upgrade/VersionUpgradeModal.tsx`）

### 1.11 视觉语言

- 字体：界面 Encode Sans，聊天正文 Merriweather（衬线）。`[V]`（`index.html`、`tailwind.config.js`）
- 圆角：基准 `--radius: 0.5rem`（lg 8 / md 6 / sm 4），手机上的卡片、sheet、输入大量用 `rounded-xl`（12）和 `rounded-2xl`（16）。`[V]`（`src/index.css` 及上面各组件）
- 颜色：亮色是暖纸色底 `hsl(44 22% 96%)` + 纯白卡片 + 蓝色主色 `hsl(221.2 83.2% 53.3%)`；暗色底 `hsl(0 0% 8%)`、卡片 12%、主色 `hsl(217.2 91.2% 59.8%)`。`darkMode: ['class']`。`[V]`（`src/index.css`、`tailwind.config.js`）
- 描边普遍带透明度（`border-border/50`、`/60`、`/30`），表面多用半透明 + `backdrop-blur`。这是它看起来不「盒子」的主要原因 `[I]`。
- 图标：lucide，14–20px，描边 1.8，激活时 2.2–2.4。`[V]`（`WorkspaceTabs.tsx`、已删的 `MobileNav.tsx`）
- 动效：默认 150ms `cubic-bezier(0.4, 0, 0.2, 1)`，hover 100ms、active 50ms，bottom sheet 220ms `cubic-bezier(0.22, 1, 0.36, 1)`，主题切换时颜色 200ms。`[V]`（`src/index.css`、`tailwind.config.js`）

### 1.12 它没有的东西

在我读过的文件里（外壳、头部、侧栏、输入框、消息、工具、Git、文件树、编辑器、设置、终端、`index.css`）没有：跟手滑动开关抽屉、行上的左滑操作、下拉刷新、`navigator.vibrate`、安装引导、角标 API、bottom sheet 的档位和拖动 `[V]`（见上列文件）。全仓库范围是推断 `[I]`。

---

## 2. 其它产品

### 2.1 Happy（slopus/happy）—— 原生 App（Expo），也有 web

24,074 star，MIT，iOS + Android + web，端到端加密中继，多人同看一个会话 `[V]`（GitHub API、`README.md`）。下面的路径相对于 `packages/happy-app/sources/`。

- **导航**：首页有底部 tab，会话是压栈页面。tab 是 Sessions / Settings 两个，有收件箱时是 Inbox / Sessions / Settings 三个；图标是 Ionicons 的 `code-slash` / `settings` / `mail`，激活用实心版本。原生端是一个**悬浮的玻璃胶囊**（高 60px，宽 68% 且不超过 320px，全圆角），激活项背后一个 68px 的「透镜」滑块；**手指按住可以在条上横向拖着换 tab**；每次切换一次轻触感。web 端退化成带上边线的普通栏、10px 文字。`[V]`（`components/TabBar.tsx`）
- 会话页的子路由：`session/[id]/changes`、`files`、`file`、`info`、`message/[messageId]`——改动、文件、单条消息都是单独一屏。`[V]`（`app/(app)/session/`）
- **会话列表**：行可**左滑归档**（`Swipeable`，只在原生端），**长按**弹操作表，web 上右键同一个菜单；状态点 + 未读点（看完后延迟一小会儿才消失）；状态文字里有「需要权限」；已归档和「电脑离线」的行变淡；列表末尾一个「显示 / 隐藏已归档」的开关行；新建是悬浮按钮（`FAB.tsx`）。`[V]`（`components/FlatSessionRow.tsx`、`SessionsList.tsx`、`StatusDot.tsx`）
- **聊天**：倒置的 FlashList（最新在下，键盘弹起时不跳）；一轮里的工具调用收成一个「工作组」，默认折叠，**有待批准的权限时自动展开**。`[V]`（`components/ChatList.tsx`）
- **权限**：按钮直接长在那次工具调用下面（`PermissionFooter`）。Claude：Yes / Yes, allow all edits / Yes, for this tool / No, and tell Claude what to do。Codex：Yes / Yes for session / Stop and explain。答完之后按钮不消失：选中的那个保持高亮，其余变淡，等于留了一条记录。`[V]`（`components/tools/PermissionFooter.tsx`、`ToolView.tsx`）
- **输入框**：附件条、`@` / `/` 自动补全（选中一项一次轻触感）、权限模式选择（先收键盘再开选择器）、麦克风、停止；输入框上方一行连接状态（色点 + 文字 + 各 CLI 的 ✓/✗）；上下文快满时的警告。`[V]`（`components/AgentInput.tsx`）
- **语音**：实时语音助手（不是听写），有独立的状态条和声纹条。`[V]`（`realtime/RealtimeVoiceSession.tsx`、`components/VoiceAssistantStatusBar.tsx`、`VoiceBars.tsx`）
- **触感**：三种——轻触、成功、失败（`expo-haptics`）；**web 版三个函数都是空的**。`[V]`（`components/haptics.ts`、`haptics.web.ts`）
- web 版还会在有待批准的权限时改 favicon 和标题。`[V]`（`components/web/FaviconPermissionIndicator.tsx`、`sync/webTabTitle.ts`）
- 推送：仓库里有 `utils/notificationRouting.ts`，具体触发条件没细读 `[I]`。
- 注意：Nimbalyst 那篇横评说 Happy「只有 iOS、闭源、基本只读」，和仓库对不上（MIT、有 Android、有完整的批准按钮），那篇是竞品自己写的，不可信 `[V]`（`https://nimbalyst.com/blog/best-mobile-apps-for-claude-code-2026/` 对比 Happy 仓库）。

### 2.2 官方 Claude App（含 Claude Code Remote Control）

- **外框没有栏**：左上一个圆形 ☰，右上一个胶囊里放「新对话」和「···」，都是悬浮在内容上的圆钮，没有带底边线的头部。`[V]`（[聊天页](https://mobbin.com/screens/d2824d70-82e1-43d2-8610-83eb95917bdd)、[暗色聊天页](https://mobbin.com/screens/ed3e4d7f-e3e5-44e8-a0ad-649a958ce5fa)）
- **输入框是一张大圆角卡，两行**：上面一行占位字「Reply to Claude」；下面一行左边圆形 `+`、一个胶囊「Sonnet 4.6 Low」（模型 + 档位合在一个 chip 里），右边麦克风和一个黑色圆形的语音模式钮；打了字之后黑钮变成橙色的发送箭头。`[V]`（[空输入](https://mobbin.com/screens/e4c51fae-e8b6-4e42-8a4c-23d1ec12b06a)、[有字](https://mobbin.com/screens/e2a4b72b-3db9-411b-8027-2ff699f9878a)）
- 额度提示是**嵌在输入卡顶部的一条**（「Limit reached · Resets Tuesday at 12:00am · Upgrade」），不是另起一个横幅。`[V]`（同上第一张）
- 回复下面一排小图标：复制 · 分享 · 朗读 · 赞 · 踩 · 重试。助手消息没有气泡。`[V]`（[聊天页](https://mobbin.com/screens/d2824d70-82e1-43d2-8610-83eb95917bdd)）
- 模型选择是 **bottom sheet**：顶上小横条 + 圆形关闭钮 + 居中标题「Select model」，每行模型名 + 一句说明，选中打勾，不可用的置灰并说明；最下面单独一行「Effort · Low ›」。`[V]`（[模型 sheet](https://mobbin.com/screens/4ab17aa5-d88b-457a-bc61-9265cd914d0c)）
- 抽屉：左边整屏滑出，主内容被推到右边露一条；里面只有 Chats / Projects / Artifacts 三项大字，左下头像，右下黑色胶囊「+ New chat」。`[V]`（[抽屉](https://mobbin.com/screens/9931f156-6697-4542-87dc-dfb04695c5cf)）
- 语音：一个大胶囊「Push to talk」，上面气泡提示「Hold to speak, release to send」。`[V]`（[按住说话](https://mobbin.com/screens/f191a932-d66b-4694-9996-84691bab8420)）
- **Remote Control**（`https://code.claude.com/docs/en/remote-control`）`[V]`：
  - 手机 App 里点导航里的 **Code** 进会话列表；Remote Control 会话显示「电脑图标 + 在线时的绿点」。
  - 连接：终端里显示会话 URL，按空格出二维码；`/mobile` 出下载 App 的二维码。
  - 推送两个开关：**Push when Claude decides**（主动通知）和 **Push when actions required**（权限请求和提问）。你正在那台电脑的终端里打字或聚焦时不推；可以用 `CLAUDE_CLIENT_PRESENCE_FILE` 扩展成「人在电脑前就不推」。
  - 笔记本睡眠或断网后自动重连；server 模式断网约 10 分钟后退出。
  - 手机上 `/model`、`/effort` 要带参数（没有选择器），`/mcp` 返回文字摘要。
  - Mobbin 没有收录 Code tab 的截图，界面细节没法写。

### 2.3 ChatGPT App（含 Codex）

- 外框同样是悬浮圆钮：左上 ☰，右上胶囊里「新对话 + ···」。输入框是一条全圆角胶囊：`+` ·「Ask ChatGPT」· 麦克风 · 黑色圆形语音钮；带附件时 `+` 挪到卡片外左下，卡片里上面是缩略图（右上角一个 ×）。`[V]`（[聊天页](https://mobbin.com/screens/fcc6d071-3fdf-46a3-9af5-2ee465d1e471)、[带图](https://mobbin.com/screens/d8d4a30b-c619-479d-84a0-6e489148adf1)）
- 抽屉是整屏列表：顶上搜索和头像，Projects 分区，Recents 分区（置顶的行尾一个图钉），右下黑色胶囊「Chat」。`[V]`（[抽屉](https://mobbin.com/screens/ab1d0c55-4180-4ad4-b9b6-5a21242092f1)）
- **Codex 新线程**：头部「New thread」下面一行灰字是电脑名（`…-MacBook-Pro.local`）；正中「What should we work on?」和一个模式切换「Chat ⌃」；输入卡顶上一个可删除的上下文 chip「Documents ×」，下面一行：`+` · 手掌图标「Default」（审批模式）·「5.5 Medium」（模型 + 档位）· 麦克风 · 黑色圆形发送。`[V]`（[新线程](https://mobbin.com/screens/e4db4d80-04d0-4144-a46e-bb64ae3f6d4b)）
- **Codex 的审批卡——这次调研里最值得抄的一张**：输入框的位置整个换成一张卡。最上面一句完整的人话问题（「Do you want to allow Quick Look to render the DOCX preview for visual verification outside the sandbox?」），下面一条灰底单行命令，然后是**两整行可点的选项**「Approve」「Always approve」（中间一条细线），最底下一行是铅笔图标 +「Tell Codex what to do」输入位 + 右边一个「Deny」胶囊。也就是：允许是整行大目标，拒绝和「告诉它该怎么做」合在一行。`[V]`（[审批卡](https://mobbin.com/screens/72c4abcc-2f9c-4126-9775-ab4d4c3cc9ef)）
- **Codex 的过程显示**：一轮里的命令收成一行灰字「Ran 2 commands ›」「Ran 4 commands ›」，正在跑的是「Running qlmanage -t -s 1200… ›」；结束后更早的内容折成「18 previous messages ›」，只留最后的回答，回答里的文件是带 ↗ 的链接。`[V]`（[审批卡同图](https://mobbin.com/screens/72c4abcc-2f9c-4126-9775-ab4d4c3cc9ef)、[完成的线程](https://mobbin.com/screens/8ebafe46-9984-453e-a420-4c286164f015)）
- 2026-05 起的远程控制预览：手机只是遥控，执行在电脑上；需要批准时推送到手机；同一账号 + 二维码配对；电脑睡了就断。2025 年的云端 Codex 有锁屏 Live Activity，远程控制这一版没查到有 `[I]`（来源是二手报道 `https://www.verdent.ai/guides/codex-in-chatgpt-mobile`、`https://x.com/OpenAIDevs/status/1924601527898951914`）。

### 2.4 Paseo（getpaseo/paseo）

20,254 star，开源，Expo（iOS / Android / web）+ 桌面 + CLI，自托管 daemon，端到端加密中继 `[V]`（GitHub API、`README.md`）。路径相对于 `packages/app/src/`。

- 一套「自适应弹层」：桌面是对话框，手机是 bottom sheet，默认两档 **65% / 90%**，背板不透明度 0.45，带把手。`[V]`（`components/adaptive-modal-sheet.tsx`、`adaptive-modal-sheet-layout.ts`）
- 点一条工具调用 → 详情进 sheet；上下文用量、模型选择也各是一张 sheet。`[V]`（`components/tool-call-sheet.tsx`、`context-window-sheet.tsx`、`composer/agent-controls/model-sheet.tsx`）
- **在聊天记录上快速一划就收键盘**：不是「一碰就收」，而是松手时速度 ≥ 1.5 pt/ms 才收（原生的 on-drag 太敏感、interactive 在倒置列表上有问题，所以自己写了状态机）。`[V]`（`agent-stream/scroll-keyboard-dismiss/model.ts`）
- 听写 + 实时语音浮层；侧栏行支持长按拖动排序。`[V]`（`components/dictation-controls.tsx`、`realtime-voice-overlay.tsx`、`components/sidebar/use-long-press-drag-interaction.ts`）

### 2.5 Yep Anywhere（kzahel/yepanywhere）—— 和 claude-web 最像的一个

535 star，自托管 web UI，自称 mobile-first，驱动 Claude Code 和 Codex，有 web push、端到端加密中继 `[V]`（GitHub API、`README.md`）。路径相对于 `packages/client/src/`。

- **抽屉可以跟手左滑关闭**：横向位移超过 15px 才「接管」手势（避免和竖向滚动打架），抽屉跟着手指 `translateX`，松手时位移超过 50px 就关。`[V]`（`components/Sidebar.tsx` 的 `SWIPE_ENGAGE_THRESHOLD` / `SWIPE_THRESHOLD`）
- **长按 hook**：500ms、移动超过 10px 取消；同时接 `contextmenu`（桌面右键和 Android 长按走同一个回调）；长按之后的那次 click 被吞掉。`[V]`（`hooks/useLongPress.ts`）
- **审批面板**：出现后 **150ms 内按钮不可点**（`CLICK_PROTECTION_MS`，防误触）；数字键 1 / 2 / 3；面板可以折叠成一个小箭头（折叠时有「待处理」样式）；「View details」开弹窗看完整工具输入；「带理由拒绝」的草稿存 localStorage。`[V]`（`components/ToolApprovalPanel.tsx`）
- **自己画的下拉刷新**（给没有原生下拉刷新的 WebView 用）：只在滚动容器 `scrollTop ≤ 2` 时接管，下拉 18px 出指示、84px 进入「松手刷新」，输入框和内层滚动区不触发。`[V]`（`hooks/useNativePullToRefresh.ts`）
- 安装：捕获 `beforeinstallprompt` 存起来，设置里一个按钮触发；用 `display-mode: standalone` 和 `navigator.standalone` 判断是否已安装。`[V]`（`hooks/usePwaInstall.ts`）
- 一个设置项「发送后保持键盘打开」。`[V]`（`hooks/useKeepMobileKeyboardOpenAfterDelivery.ts`）
- 判定「键盘开着」的阈值：可视视口高度 < 原高度的 0.8。`[V]`（`lib/mobileKeyboardViewport.ts`）
- 仓库里有一份对同类项目的跟踪文档，可以当清单用。`[V]`（`docs/competitive/all-projects.md`、`feature-matrix.md`）

### 2.6 GitHub Mobile（Copilot coding agent）

- 底部是**悬浮的胶囊 tab bar**：Home / Inbox / Explore / Copilot，激活项有一块浅色底。`[V]`（[会话页](https://mobbin.com/screens/13e22b46-b056-463d-b90f-5dc0b39e1613)）
- 会话页：头部标题下面一行灰字仓库名，「Created just now · 1 session」，用户消息是右对齐气泡，过程是**一张步骤卡**：标题行「Planning dark theme implementation · 28s ⌄」，下面每行一个小图标 + 动作（Clone repository… / View src ›），最后一行蓝点「Working…」；底部一条「Follow up」输入。`[V]`（同上）
- 实时通知：状态有 in progress / completed / failed / cancelled，CLI 会话还有 waiting for user input / idle；需要 iOS 17.2+ 或 Android 16+，旧机型退回普通进度通知；点通知进 PR 或会话日志。`[V]`（`https://github.blog/changelog/2026-02-26-github-mobile-track-coding-agent-progress-in-real-time-with-live-notifications/`、`https://github.blog/changelog/2026-07-08-github-mobile-live-notifications-for-copilot-cli-sessions/`，经搜索摘要读到）

### 2.7 CodexMonitor（Dimillian/CodexMonitor）

- 手机布局是**五个 tab 的底部栏**：Home · Projects · Codex · Git · Log（lucide 图标 + 文字）。`[V]`（`src/features/app/components/TabBar.tsx`、`src/features/layout/components/PhoneLayout.tsx`）
- iOS 版还在做：默认连远端 daemon（Tailscale + token），终端和听写在手机上不可用。`[V]`（`README.md`「iOS Support (WIP)」）

### 2.8 其它（每个只写核实到的）

- **Manus**：
  - 新任务页很空：头部是可切换的版本名「Manus 1.6 Lite ⌄」和额度胶囊，正中一句衬线体「What can I do for you?」，底部输入卡（`+` · 连接器图标 · 麦克风 · 发送）。`[V]`（[新任务](https://mobbin.com/screens/d93a3b6d-e200-4935-b8cf-dad2fbaae1ec)）
  - 「Manus's computer」是一张整屏 sheet：上面一张文件卡显示红绿 diff，卡底一个**三段切换「Diff / Original / Modified」**；下面「Manus is using Editor · Editing file …」；一条时间轴滑块 + 上一步 / 下一步 +「● Live」；最底下一行当前步骤。`[V]`（[电脑视图](https://mobbin.com/screens/6834fa59-ee3a-4969-a6cc-c27bb0c9ad56)）
  - 完成后在输入框上方有「✓ Task completed」和一张五星评分小卡。`[V]`（[完成](https://mobbin.com/screens/ccf57738-b9af-49ed-acda-761eab298271)）
  - 首页列表顶上三个筛选胶囊 All / Favorites / Scheduled，右下圆形悬浮新建钮。`[V]`（[首页](https://mobbin.com/screens/ca888f9c-79f4-49f3-8b95-41c9dbeadcd4)）
- **Perplexity（agent 任务）**：过程是一行一步的灰字 + 小图标 + `›`（Reading… / Starting PDF generation / Writing to …），可展开出一个带「● Terminal」标题的代码块；右下一个圆形的回到底部箭头；底部输入是一条胶囊，旁边单独一个圆形新建钮。`[V]`（[步骤](https://mobbin.com/screens/b102c0f7-33cc-462b-a53a-4999064b8a67)、[并行任务](https://mobbin.com/screens/1a125ff3-7754-4b36-adb2-db05cb7b34a5)）模型选择是 sheet，选中的模型下面原地展开一个「With thinking」开关。`[V]`（[模型 sheet](https://mobbin.com/screens/ce26a9b7-6edb-4cb8-8d54-9dbbb10e5220)）
- **v0**：过程行「Thinking ›」「Saved logo ›」「Read nav ›」「Thought for 1s ›」；输入是悬浮的圆形 `+` 和一条胶囊「Ask v0…」，运行时右边是圆形停止钮。`[V]`（[v0](https://mobbin.com/screens/9ec98b14-9357-4da9-949e-52dbb1d54caf)、[v0 运行中](https://mobbin.com/screens/e180ae62-64e2-40eb-a851-dba120707fba)）
- **DeepSeek**：输入卡第二行左边两个**开关式 chip**「Think」「Search」（开着是描边加深），右边 `+`、语音、发送；占位字「Message or hold to speak」；上传中的文件 chip 显示状态字（「Uploading…」「No text extracted」红字）。`[V]`（[运行中](https://mobbin.com/screens/e3475dad-7faf-4758-9479-decc757d1a78)、[上传](https://mobbin.com/screens/e7d239b2-d41a-4830-9a5b-8df72dc47973)）
- **Gemini**：回到底部的箭头在输入框正上方居中；输入卡里 `+` · 调节图标 ·「Fast」胶囊 · 麦克风 · 发送。抽屉里有未读红点。`[V]`（[输入](https://mobbin.com/screens/d027d21d-ea39-4b6c-9a40-cc131dbb4dc8)、[抽屉](https://mobbin.com/screens/7838c98a-2cc1-4fea-824c-c2a32bbf01ad)）
- **Grok（bot）**：提问以卡片出现在消息流里，选项是带 A / B / C 标的整行；答过的折成一行「This works ✓」。`[V]`（[提问卡](https://mobbin.com/screens/d9d8ba00-9b08-4d8d-8bef-b0e655beedc9)）
- **Cursor（cursor.com/agents）**：手机浏览器可用，可装成 PWA；能带图片发任务、追加指令、看 diff、开 PR；完成通知走 Slack。页面没有描述手机界面的细节。`[V]`（`https://cursor.com/blog/agent-web`）
- **Devin**：官方 iOS App 2026-09 起内测排队；手机网页版的 Devin Review 默认停在 Changes tab（另有 Bugs / Description / Discussion / Commits）；通知可按类型开关，有通知收件箱，手机上全屏；3 月起可装 PWA。`[I]`（只读到搜索摘要，原文 `https://docs.devin.ai/release-notes/2026`）
- **Replit**：2026-07 的版本加了语音输入、在 Agent / 任务 / 预览之间**左右滑动**切换、Live Activity；推送三种：Agent 需要你、Agent 跑完、账单。`[I]`（搜索摘要，原文 `https://docs.replit.com/updates/2026/07/24/changelog`）
- **Omnara**：卖点是推送 + 一键批准、语音对话、电脑断线后把会话交给云端继续、Apple Watch。Android 上有用户反馈没有系统级通知。`[I]`（应用商店页和二手评测的搜索摘要）
- **Kibbler**：改动先以 diff 排队等批准，可成组批量接受 / 拒绝；有一个「Approvals」tab 留记录；二维码配对。`[I]`（搜索摘要，`https://kibbler.dev/`）
- **VibeTunnel**：本质是把终端搬进浏览器，README 只说「Native iOS app and responsive web interface」，iOS App 标注为未完成。`[V]`（`README.md`）
- **opencode**：官方 `opencode web` 在手机上的表现没找到文档；手机上用的多是社区客户端。未核实，不下结论。

### 2.9 横向看导航模型

| 产品 | 会话列表在哪 | 会话内切视图 | 底部栏 |
| --- | --- | --- | --- |
| claudecodeui（现在） | 左抽屉 | 头部胶囊 tab | 无（4 月删了） |
| Claude / ChatGPT / Gemini / DeepSeek | 左抽屉（整屏） | 没有多视图 | 无 |
| Happy | 首页（tab 之一） | 压栈子页面 | 只在首页，悬浮胶囊 |
| GitHub Mobile | 首页 tab | 压栈 | 全局，悬浮胶囊 |
| CodexMonitor | Projects tab | tab 之间切 | 5 个 tab |
| Manus | 首页列表 | 整屏 sheet | 无 |

结论 `[I]`：主流聊天类都是「抽屉 + 一屏对话 + 底部只有输入框」；只有把会话列表做成首页的才用底部栏，而且都是悬浮胶囊、进了会话就不再出现。会话里面长期占着底部的栏，claudecodeui 试过又删了。

---

## 3. 手机端通用模式与 Web API

claude-web 是 PWA，下面每条都写了 iOS Safari / Android Chrome 的支持情况。

**一个先决条件 `[I]`**：Service Worker、Web Push、麦克风（`getUserMedia`）、剪贴板读取都要求安全上下文（HTTPS 或 localhost）。claude-web 走局域网是 `http://192.168.x.x`，这些能力在那条路上都不可用；走手机壳（`https://claude-web-shell.github.io/`）才有。做推送和语音之前要先定这件事。

### 3.1 键盘与视口

- `interactive-widget=resizes-content`：Android Chrome 108+、Android Firefox 133+ 生效（键盘弹起时布局视口跟着缩，`dvh` 也跟着变）。**iOS Safari 到 2026-09 还没发布**，WebKit 源码里 8 月已实现，作者猜测 Safari 27.1。`[V]`（`https://www.bram.us/2026/09/11/webkit-supports-interactive-widget-and-hopefully-safari-will-too/`）
- 所以 iOS 上仍然要用 `visualViewport`：键盘弹起时只有可视视口变小、并且可能整体上移，要同时算 `height` 和 `offsetTop`，监听 `resize` 和 `scroll`。claude-web 已经这么做了 `[V]`（`web/src/app/App.tsx` 第 95–102 行，`--kb = innerHeight - vv.height - vv.offsetTop`）；claudecodeui 只算了 `height` `[V]`。
- `dvh / svh / lvh`：Safari 15.4+、Chrome 108+。它们只跟浏览器工具栏走，不跟键盘走（除非上面那个 meta 生效）。`[I]`
- VirtualKeyboard API（`navigator.virtualKeyboard`、`env(keyboard-inset-height)`）：只有 Android 上的 Chromium，iOS 没有。`[I]`
- 输入框字号 < 16px 时 iOS 聚焦会放大页面：要么 16px，要么 `maximum-scale=1`（claude-web 和 claudecodeui 都用了后者 `[V]`）。
- `enterkeyhint="send" / "done"`、`inputmode`、`autocapitalize` 两边都支持，能让软键盘的回车键显示成「发送」。`[I]`（claudecodeui 的改名框用了 `enterKeyHint="done"` `[V]`）
- 「滚动聊天记录收键盘」要有速度阈值，别一碰就收（Paseo：1.5 pt/ms）`[V]`。

### 3.2 安全区

- `viewport-fit=cover` + `env(safe-area-inset-*)`，两边都支持。需要处理的四处：独立窗口模式下的顶部（状态栏）、底部 home 条（输入框、sheet、抽屉底）、横屏的左右。`[I]`
- 有人报告 `viewport-fit` 在 Safari 26 坏了、到 9 月没修（单一来源，上真机验）。`[V]`（同上 bram.us 文章）
- claude-web 现在只有输入框底、sheet 底、断线条用了安全区 `[V]`（`web/src/styles.css` 第 1178、2153、2164 行）；会话头顶部和抽屉底部没有 `[I]`。

### 3.3 触控目标与反馈

- 目标尺寸：Apple 44pt，Material 48dp，WCAG 2.2 的底线是 24px。`[I]` claudecodeui 的 sheet 行是 48px、取消 44px `[V]`；它输入框里的图标钮只有 32px `[V]`。
- `touch-action: manipulation`（去掉双击缩放的等待）、`-webkit-tap-highlight-color: transparent`、按钮 `user-select: none`、`active:scale(0.98)`。`[V]`（claudecodeui `src/index.css`）
- 触屏上 hover 会「粘住」：用 `@media (hover: none) and (pointer: coarse)` 中和 hover 样式，并把悬停才出现的操作常显。`[V]`（同上；claude-web 已有 `@media (hover: none)` 的消息操作常显 `[V]`，`CLAUDE.md`「界面改版 阶段 5」）

### 3.4 触感

- `navigator.vibrate()`：Android Chrome 支持；**iOS 所有浏览器都不支持**（caniuse 到 26.x、27.x 都是否）。`[V]`（`https://caniuse.com/mdn-api_navigator_vibrate`，经搜索摘要）
- iOS 上有个旁门：脚本点击一个隐藏的 `<input type="checkbox" switch>` 的 label 会带出一次系统触感（17.4 / 18.0 起）。多个来源说 **iOS 26.5 起脚本触发的不灵了**，只剩用户手指真的点在开关上才有。别依赖。`[I]`（二手来源：`https://x.com/jh3yy/status/2028544698055299220`、`https://haptics.kushagragolash.dev/`）
- 结论：只在 Android 上做，10–20ms 的短震，iOS 静默。

### 3.5 Bottom sheet

- 要素：把手（约 36–40 × 4–5px）、档位（常见两档，Paseo 是 65% / 90% `[V]`）、下拉到阈值关闭、背板（0.45 `[V]`）、内容滚到顶之后继续下拉才拖动 sheet、键盘弹起时底边抬到键盘上方。
- 实现：`touch-action: none` 的把手区 + pointer 事件 + `transform: translateY`；sheet 内容区 `overscroll-behavior: contain`。动画 220ms 左右、减速曲线（claudecodeui：`cubic-bezier(0.22, 1, 0.36, 1)` `[V]`）。
- **系统返回要能关 sheet**：打开时 `history.pushState`，`popstate` 时关闭。Android 的返回键 / 返回手势和 iOS 的边缘右滑都会走到这里。`[I]`
- claude-web 现在的 sheet 是固定 78vh、没有把手、不能拖 `[V]`（`web/src/styles.css` 第 2162–2164 行的注释「No grab handle: it does not swipe」）。

### 3.6 抽屉与滑动

- 跟手滑动的阈值：横向 > 15px 且大于纵向位移才接管，松手 > 50px 或速度够快就完成（Yep Anywhere `[V]`）。
- 从屏幕最左边缘右滑：iOS Safari 标签页和独立窗口 PWA 都会把它当「后退」，所以不要做「左边缘右滑开抽屉」；可以做「在内容区任意位置右滑」并留出最左 20px 给系统。`[I]`
- 行上的左滑操作：`touch-action: pan-y` + pointer 事件，露出 1–2 个按钮；同一个操作必须在 `⋯` 或长按菜单里也有（Happy 的左滑归档就是这样 `[V]`）。
- 长按：Android 长按会触发 `contextmenu`，iOS Safari 对普通元素不可靠，所以要自己计时（500ms / 移动 10px 取消），并加 `-webkit-touch-callout: none`（Yep Anywhere `useLongPress` `[V]`）。

### 3.7 下拉刷新

- 浏览器标签页里有原生下拉刷新（Android Chrome、iOS Safari 15+），独立窗口 PWA 里 iOS 没有。`[I]`
- 应用自己有滚动容器时通常先用 `overscroll-behavior-y: contain` 关掉原生的（Safari 16+ 支持），再决定要不要自己画（claudecodeui 关了没画 `[V]`，Yep Anywhere 画了 `[V]`）。
- 对 claude-web：会话列表是 WS 推的，本来就是新的，下拉刷新的价值是「让人放心」和重连的入口 `[I]`。

### 3.8 滚动

- 回到底部的圆钮 + 离底阈值（claudecodeui 50px `[V]`；claude-web 已有 `.jump-bottom` `[V]`，`web/src/features/chat/ChatView.tsx` 第 513 行）。
- 「有新消息」：用户往上翻时新内容不拽视口，在圆钮上加个点或数字。`[I]`（Gemini、Perplexity 的圆钮没有计数 `[V]`）
- 长对话：`content-visibility: auto` + `contain-intrinsic-size`（Safari 18+、Chrome 85+）。`[V]`（claudecodeui `src/index.css`；支持版本是 `[I]`）

### 3.9 通知、角标、安装

- **Web Push**：Android Chrome 一直支持；iOS 从 16.4 起支持，但**只有加到主屏幕的 web app 才行**，而且申请权限必须由用户点按触发。`[V]`（`https://webkit.org/blog/17333/webkit-features-in-safari-26-0/` 及搜索摘要）
- Declarative Web Push（不需要 Service Worker 也能显示通知）：Safari 18.4+。`[V]`（`https://webkit.org/blog/16535/meet-declarative-web-push/`，经搜索摘要）
- 通知用 `tag` 按会话归并、`renotify: true`；点通知先找已开的窗口 `focus()` 再发消息让它跳转。`[V]`（claudecodeui `public/sw.js`）
- **Badging API**（`navigator.setAppBadge(n)`）：iOS 16.4+ 的主屏幕 web app 支持；Android 上 Chrome 不支持脚本设数字，图标上的小点由系统根据通知自动显示。`[I]`
- **安装**：Android Chrome 有 `beforeinstallprompt` 可以自己做按钮；iOS 没有任何脚本入口，只能教用户「分享 → 添加到主屏幕」。**iOS 26 起，加到主屏幕的任何网站默认都以 web app 方式打开**，不再要求 manifest。`[V]`（`https://webkit.org/blog/17333/webkit-features-in-safari-26-0/`；`beforeinstallprompt` 的用法见 Yep Anywhere `hooks/usePwaInstall.ts`）
- iOS 上主屏幕 web app 和 Safari 的存储是分开的。`[V]`（claude-web 自己的 `CLAUDE.md`「手机在外面也能连 · iOS」）
- Web Share Target（让系统分享菜单把图片 / 文字分享进应用）：只有 Android Chromium，iOS 没有。`[I]`
- 锁屏 Live Activity：只有原生 App 能做（GitHub、Replit、ChatGPT 都是原生）。PWA 的替代是同一个 `tag` 的通知反复更新。`[I]`
- Screen Wake Lock：Safari 16.4+、Chrome 84+；iOS 主屏幕 web app 里 18.4 才修好。`[I]`

### 3.10 过渡与定位

- View Transitions（同文档 `document.startViewTransition`）：Chrome 111+、Safari 18+、Firefox 144+。适合「列表 → 会话」「视图切换」这种整屏切换，记得配 `prefers-reduced-motion`。`[I]`
- CSS anchor positioning、scroll-driven animations（`animation-timeline: view()`）：Safari 26 起支持，Chrome 更早。`[V]`（`https://webkit.org/blog/17333/webkit-features-in-safari-26-0/`）
- Popover API、`<dialog>`：Safari 17+、Chrome 114+。`[I]`

---

## 4. 手机端值得做的 15 件事（按对 claude-web 的影响排序）

每条：做什么 → 具体怎么表现 → 来源。带「现状」的是 claude-web 今天的情况（来自仓库 `CLAUDE.md` 和我对 `web/` 的只读检查）。

### 1. 审批卡改成「整行大按钮 + 拒绝带输入」

- **做什么**：权限请求出现时，输入框的位置整个换成一张卡。
- **怎么表现**：
  - 第一行是一句人话的问题（「Claude 想运行一条命令」这种），下面一条单行可横滚的命令 / 路径。
  - 然后是**整行可点的选项**，每行 ≥ 48px：「允许一次」「总是允许 npm test」（有规则建议时才有第二行）。
  - 最底下一行：输入位「告诉它该怎么做」+ 右边一个「拒绝」胶囊。输入位有字时点拒绝 = 带理由拒绝。
  - 卡片出现后 150–600ms 内按钮不响应；一次一张，角上「还有 N 条」。
  - 答完卡片收起，输入框回来，焦点不动。
- **现状**：claude-web 已经有停靠卡和 600ms 冷却，「拒绝理由并进主输入框」的逻辑也在；窄屏时只有「允许一次」独占一行。差的是整行化、拒绝行和输入位合一。
- **来源**：ChatGPT Codex 审批卡（[截图](https://mobbin.com/screens/72c4abcc-2f9c-4126-9775-ab4d4c3cc9ef)）；Yep Anywhere `ToolApprovalPanel.tsx`（`CLICK_PROTECTION_MS = 150`）；claudecodeui `PermissionRequestsBanner.tsx`（「Allow & remember」一次放行同规则的全部请求）；Happy `PermissionFooter.tsx`。

### 2. 推送通知 + 点通知直达那个对话

- **做什么**：对话需要你（权限 / 提问）、跑完、出错时给手机发系统通知。
- **怎么表现**：
  - 设置里三个开关：需要你处理 / 回合结束 / 出错，各自独立。
  - 你正开着那个对话且页面可见时不发。
  - 每个对话一个 `tag`，同一对话的新通知替换旧的并重新提醒。
  - 点通知：已有窗口就切到前台并打开那个对话，没有就开新窗口到那个对话。
  - iOS 上「开启通知」按钮只在已加到主屏幕时可用，否则显示怎么加。
  - 有待处理的权限时改页面标题 / favicon；iOS 主屏幕应用上设角标数字 = 等你处理的对话数。
- **限制**：要 HTTPS，局域网 http 那条路不行；iOS 必须先加到主屏幕。
- **来源**：claudecodeui `public/sw.js`、`useWebPush.ts`、`NotificationsSettingsTab.tsx`；Claude Remote Control 的两个开关（`https://code.claude.com/docs/en/remote-control`）；Happy `FaviconPermissionIndicator.tsx`；GitHub Mobile 的状态集合。

### 3. 去掉「盒子感」：无栏头部 + 单卡输入框 + 贴在输入框上的状态页签

- **做什么**：把手机上的外框从「一条条带边线的栏」换成「内容铺满 + 悬浮的圆钮 + 一张输入卡」。
- **怎么表现**：
  - 头部没有底边线和实底：左上一个 36–40px 的圆形 ☰，右上一个胶囊装「新对话」和「···」，标题在中间；内容从它们下面滚过去，顶部一段渐隐。
  - 助手消息没有气泡和边框；用户消息是右对齐的浅色实底气泡，没有描边。
  - 输入框是一张 20–24px 圆角、带阴影的卡，**两行**：上行只有文字；下行左边 `+`、「模型 · 档位」胶囊（一个 chip）、权限图标，右边麦克风和 36–40px 的圆形发送钮。
  - 运行中：输入卡左上沿贴一个小页签「正在读 3 个文件… 42s」，右上沿一个「停止」页签，和卡片连成一体。
  - 分隔用两端渐隐的细线或留白；chip 用实底或半透明底，不用描边。
- **现状**：claude-web 已经有 RunCard 贴在输入框上沿，可以直接演变成页签；头部现在是一行带边线的栏。
- **来源**：Claude iOS（[聊天页](https://mobbin.com/screens/d2824d70-82e1-43d2-8610-83eb95917bdd)、[输入卡](https://mobbin.com/screens/e2a4b72b-3db9-411b-8027-2ff699f9878a)）；ChatGPT（[聊天页](https://mobbin.com/screens/fcc6d071-3fdf-46a3-9af5-2ee465d1e471)、[Codex 输入卡](https://mobbin.com/screens/e4db4d80-04d0-4144-a46e-bb64ae3f6d4b)）；claudecodeui `ActivityIndicator.tsx`、`PromptInput.tsx`、`.nav-divider`。

### 4. 会话内的视图切换：一排胶囊，不做常驻底部栏

- **做什么**：对话 / 审阅 / 文件 / 终端 / 任务做成会话头下面的一排胶囊。
- **怎么表现**：
  - 胶囊高 32–36px，只有当前项显示文字，其它只显示图标；放不下就横向滚动，两端渐隐，切换后把当前项滚进视野。
  - 审阅的胶囊上带改动文件数。
  - 输入框聚焦（键盘弹起）时这一排收起，把高度让给对话。
  - 切走不卸载对话和终端。
- **为什么不是底部栏**：claudecodeui 做过悬浮底部栏，因为每个页面都要为它留底部空白、还和抽屉形成两套导航，4 月删了。
- **来源**：claudecodeui `WorkspaceHeader.tsx`、`WorkspaceTabs.tsx`、`PillBar.tsx`，PR #632；旧 `MobileNav.tsx` 的「输入聚焦时滑出」。

### 5. 底部抽屉做成真的 sheet

- **做什么**：右侧面板在手机上的那个 78vh 抽屉，加把手、档位、拖动。
- **怎么表现**：
  - 顶上一条 40 × 4px 的把手，把手和标题行可拖。
  - 两档：约 60% 和 92%；从上档下拉到下档，再下拉超过约 1/4 高度就关；快速下划直接关。
  - 内容滚到顶后继续下拉才开始拖 sheet。
  - 背板 0.45，点背板关；系统返回（Android 返回键、iOS 边缘右滑）也只关 sheet。
  - 进出 220ms 减速曲线；键盘弹起时底边跟到键盘上方。
  - 终端仍然只有一份、不卸载。
- **现状**：固定 78vh、没有把手、不能拖（CSS 注释里写明了）。
- **来源**：Paseo `adaptive-modal-sheet.tsx`（65% / 90%，背板 0.45）；claudecodeui 的 sheet 动画和把手（`SidebarSessionItem.tsx`、`tailwind.config.js`）；Claude 模型 sheet（[截图](https://mobbin.com/screens/4ab17aa5-d88b-457a-bc61-9265cd914d0c)）。

### 6. 侧栏：跟手滑动、行操作进 sheet、左滑归档、三色状态点

- **做什么**：让会话列表在手机上单手可用。
- **怎么表现**：
  - 抽屉宽 85vw（上限约 380px），背板带模糊。在抽屉上左滑跟手关闭（横移 > 15px 才接管，松手 > 50px 完成）；在对话区右滑打开，避开最左 20px。
  - 行高 ≥ 44px；行尾 `⋯` 和长按（500ms）打开同一张 sheet：置顶 / 改名 / 分叉 / 归档 / 删除，每行 48px，危险项红字，最后一行取消。
  - 行上左滑露出「归档」，滑过一半松手直接归档；提供撤销 toast。
  - 行首状态点：琥珀 = 等你确认，紫 = 后台还在跑，绿 = 运行中。
  - 改名输入框 16px 字号。
- **现状**：claude-web 的行尾状态已经有「待确认 / 提问 / 出错 / 运行中」，菜单是锚定的浮层菜单。
- **来源**：Yep Anywhere `Sidebar.tsx`、`useLongPress.ts`；claudecodeui `SidebarSessionItem.tsx`、`ProjectSidebarRegion.tsx`；Happy `FlatSessionRow.tsx`（`Swipeable` + `onLongPress`）。

### 7. 工具调用压成「一行一事」，连续同类合并，详情进 sheet

- **做什么**：手机上过程信息只占最少的行。
- **怎么表现**：
  - 一步一行：小图标 + 动词 + 对象（文件只显示 basename）+ 行尾用时或 `›`，灰字、没有边框，只在左边留一条 2px 的类别色线或什么都不留。
  - 连续的同类调用合成一行「编辑 ×4 · auth.ts 等 · +12 −3」，点开才逐条显示。
  - 完成的回合折成一行「已处理 27 秒 · 读了 2 个文件 · 运行 1 条命令 ›」；点某一步，详情（输入、输出、diff）在 sheet 里打开，而不是把对话撑开。
  - 成功的结果不单独显示，失败的才露出来。
- **现状**：回合摘要和折叠 claude-web 已经有；手机上点开仍是原地展开。
- **来源**：claudecodeui `ToolGroupContainer.tsx`、`OneLineDisplay.tsx`、`tools/README.md`；ChatGPT Codex「Ran 4 commands ›」「18 previous messages ›」（[截图](https://mobbin.com/screens/8ebafe46-9984-453e-a420-4c286164f015)）；Paseo `tool-call-sheet.tsx`；Perplexity（[截图](https://mobbin.com/screens/b102c0f7-33cc-462b-a53a-4999064b8a67)）。

### 8. 发送键多态 + 排队卡

- **做什么**：一个按钮干四件事，不用找「停止」「插话」在哪。
- **怎么表现**：
  - 空闲：发送。运行中且输入框空：停止。运行中且有字：排队（图标换成向上箭头）。录音中：停止录音并直接发送。
  - 排的那条显示成输入框上方一张虚线小卡「已排队 · 这一轮结束后发送」，带编辑和删除；再排一条就是更新它。
  - 长按发送键出「立即插话 / 排队 / 定时发送」（可选）。
- **来源**：claudecodeui `ChatComposer.tsx`（`PromptInputSubmit` 的四种状态）、`QueuedMessageCard.tsx`、`ScheduleMessagePopover.tsx`。

### 9. 手机上的审阅和提交

- **做什么**：让 diff 在窄屏上能看、能批、能提交。
- **怎么表现**：
  - 文件列表一行一个：状态字母徽标 + 文件名（目录灰字在前、先省略目录）+ `+N −M`；点开原地展开。
  - diff 用 11–12px 等宽、行高 18px、红绿淡底；头上一个「换行 / 横滚」切换，默认换行。
  - 可选的三段切换「改动 / 原文 / 改后」。
  - 每个文件的「暂存」「还原」带文字，不只是图标。
  - 提交区默认收成一个主按钮「提交 3 个文件 ⌄」，点了才展开说明输入框（键盘弹起时它在键盘上方）。
- **来源**：claudecodeui `FileChangeItem.tsx`、`GitDiffViewer.tsx`、`CommitComposer.tsx`、`ToolDiffViewer.tsx`；Manus 的「Diff / Original / Modified」（[截图](https://mobbin.com/screens/6834fa59-ee3a-4969-a6cc-c27bb0c9ad56)）。

### 10. 终端：快捷键条、编号选项按钮、长按选择、捏合缩放

- **做什么**：让终端在手机上真的能用（登录、装 agent 都要靠它）。
- **怎么表现**：
  - 键盘上方一条可横向滚动的键：粘贴 · Esc · Tab · ⇧Tab · Ctrl（粘滞）· Alt（粘滞）· ↑ ↓ ← → · Ctrl+C · 滚到底；点这些键不收键盘。
  - 终端里出现编号选项时，浮出「1. Yes」「2. No」「Esc」按钮，点了直接发数字。
  - 长按 600ms 进入选择，两个拖柄 + 「复制 / 全选」；双指捏合改字号；滑动有惯性。
- **来源**：claudecodeui `TerminalShortcutsPanel.tsx`、`Shell.tsx`（`cliPromptOptions`）、`mobileTerminalSelection.ts`。

### 11. 键盘、安全区、触控的地基

- **做什么**：一次把底层细节补齐。
- **怎么表现**：
  - 安全区：独立窗口时会话头让出状态栏，抽屉底、sheet 底、输入框底让出 home 条，横屏让出左右。
  - 全局（手机）：`touch-action: manipulation`、去掉点按高亮、按钮不可选中文字、按下 `scale(0.98)`。
  - 所有可点的东西 ≥ 44px（图标可以小，点按区不能小）。
  - 在对话上快速下划收键盘（有速度阈值）；设置里一项「发送后保持键盘打开」。
  - 各种菜单和 sheet 的滚动区 `overscroll-behavior: contain`；`<html>` 上关掉原生下拉刷新。
  - 软键盘回车键显示「发送」（`enterkeyhint`），是否回车发送沿用现有设置。
- **现状**：`--kb`（含 `offsetTop`）、`interactive-widget`、`maximum-scale=1` 已经有；安全区只覆盖了三处。
- **来源**：claudecodeui `src/index.css`、`index.html`；Paseo `scroll-keyboard-dismiss/model.ts`；Yep Anywhere `useKeepMobileKeyboardOpenAfterDelivery.ts`；bram.us 关于 iOS 不支持 `interactive-widget` 的文章。

### 12. 连接状态说清楚

- **做什么**：断线、重连、电脑睡了、走慢速转发，各有一个不打扰的表示。
- **怎么表现**：
  - 断线时标题旁出现一个琥珀色小胶囊「重新连接中」，连着的时候什么都不显示；点它立即重试。
  - 电脑不在线时列表里它的对话变淡，输入框禁用并写「电脑不在线」。
  - 走慢速转发时胶囊写「慢速连接」，并说明不能预览 / 上传文件。
  - 回到前台、网络恢复时自动重连并补读。
- **现状**：claude-web 有一条 24px 的断线细条和账户行红点；手机壳已有前台 / 换网络的重拨逻辑。
- **来源**：claudecodeui `WorkspaceConnectionStatus.tsx`；Happy `FlatSessionRow.tsx`（`machineOffline` 变淡）、`AgentInput.tsx`（`connectionStatus`）；Claude Remote Control 的重连说明。

### 13. 语音输入

- **做什么**：在手机上说话比打字快。
- **怎么表现**：
  - 点麦克风开始录，输入卡里显示波形和计时；再点一下停止，文字落进输入框可改；点发送键 = 停止并直接发。
  - 或者按住说话、松手即发（提示「按住说话，松开发送」）。
  - 转写中发送键转圈并禁用；失败时麦克风上方冒一条 4 秒的红字。
- **限制**：麦克风要 HTTPS；转写要有服务（claudecodeui 是录音上传到自己的服务端）。
- **来源**：claudecodeui `useVoiceInput.ts`、`VoiceInputButton.tsx`；Claude「Push to talk」（[截图](https://mobbin.com/screens/f191a932-d66b-4694-9996-84691bab8420)）；DeepSeek「Message or hold to speak」（[截图](https://mobbin.com/screens/e3475dad-7faf-4758-9479-decc757d1a78)）。

### 14. 触感和按压反馈

- **做什么**：关键动作给一下轻震（Android），所有可点的东西给按压反馈。
- **怎么表现**：
  - `navigator.vibrate(10)`：发送、批准、切视图、长按菜单弹出、选中补全项；出错 `vibrate([10, 60, 10])`。iOS 上不做。
  - 设置里一个总开关，默认开；系统开了「减少动态效果」时关。
  - 按下缩到 0.98、50ms；松开 150ms 回弹。
- **来源**：Happy `haptics.ts` 及其调用点（`TabBar.tsx`、`AgentInput.tsx`）；caniuse `navigator.vibrate`；claudecodeui `src/index.css` 的 active 规则。

### 15. 安装引导和更新提示

- **做什么**：让人知道可以装到主屏幕，以及电脑上的版本更新了。
- **怎么表现**：
  - Android：账户菜单里一行「安装到主屏幕」，点了弹系统安装框；装好后这一行消失。
  - iOS：同一行点开是三步图示（分享 → 添加到主屏幕 → 打开）；已经在独立窗口里就不显示。配合第 2 条：没装时「开启通知」指向这里。
  - 抽屉底部一张 44px 的小卡：「有新版本 v0.1.11」，点开是更新说明；「已更新，需要重启服务」是另一种颜色。
- **来源**：Yep Anywhere `usePwaInstall.ts`；claudecodeui `SidebarFooter.tsx`、`VersionUpgradeModal.tsx`；WebKit Safari 26 说明（主屏幕 web app 默认行为）。

---

## 附：没有核实到 / 需要真机确认的

- claudecodeui README 的截图和 GIF 没看；全仓库范围「没有滑动手势 / 触感」是基于已读文件的推断。
- Happy 的推送触发条件、Omnara、Kibbler、Devin、Replit 只有二手或摘要来源。
- Kimi、豆包、T3 Chat 手机网页、opencode 官方 web：没有可用的一手资料。
- Claude App 的 Code tab 界面：Mobbin 未收录。
- iOS 26.5 起 switch 触感旁门失效、Safari 26 的 `viewport-fit` 问题：都只有少数来源，上真机验。
- 安卓 Badging、Web Share Target、View Transitions 的版本号来自通用知识，没有逐条查 caniuse。
