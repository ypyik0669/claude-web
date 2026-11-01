# 界面换新（2026-10-10）

spec 和实施记录：`docs/superpowers/specs/2026-10-10-ui-refresh/design.md`（§12 逐阶段记了做了什么、和设计不一样的地方、没验的）；调研和定方向用的静态稿在同一个目录。功能、入口、协议都没动，换的是外观、动效和手机上的交互。**下面和前面各节冲突的地方，以这一节为准**（末尾有清单）。

- **样式文件和顺序**（`main.tsx` 里的 import 顺序就是层叠顺序，同选择器后写的生效）：`styles.css`（开头 `@import './tokens.css'`）→ `styles/chat.css`（消息、步骤行、回合、代码块、改动卡）→ `composer.css`（输入框、发送键、流光、状态页签）→ `floating.css`（菜单、分段控件、toast、审批卡、右侧面板开合）→ `extras.css`（排队卡、终端按键条）→ `scroll-fade.css`（滚动边缘渐隐，见文末「质感」）→ `review-phone.css` → `phone.css`（手机：头部、输入卡、审批卡、点击区、安全区）→ `phone-sheet.css`（底部抽屉、侧栏抽屉）→ `phone-menus.css`（操作单）→ `corners.css`（超椭圆圆角）。`styles.css` 里被后面几份整条盖掉的旧规则还在；改某个面的样子先看后面那份。导出对话（`model/export.ts`）内联的是 tokens + styles + chat + composer + floating。
- **令牌**（`web/src/tokens.css`）：浅色暖纸（`--bg #fefdfc`、外壳底 `--bg-1 #f7f6f2`）、深色暖黑（`#1b1a18` / `#12110f`），强调色亮橙。**`--accent` 只做填充**（它在白底上只有 2.7:1），当文字、图标用 `--accent-text`；加主题要写 `--accent-text` 和 `--accent-fg`，`ui/contrast.test.ts` 会查。圆角 `--r-xs 4 · sm 6 · row 8 · md 10 · lg 12 · xl 16 · bubble 20 · 2xl 24 · pill`，外壳 `--shell-gap`（8，紧凑密度 4）和 `--r-card`。**阴影令牌自带 1px 的环**（`--elev-1/2/3`、`--elev-composer`）：浮起来的东西不再写 border。时长 `--dur-instant 80 · fast 120 · base 180 · slow 240 · slower 320 · page 480`，缓动 `--ease-out / in-out / in / sheet / pop`。淡底色 `--fill-subtle`（无描边的输入框、垫在卡片上的容器）。字号是整数的一套（`--fs-micro 11 … --fs-display 31`），中文只用 400 / 600 两个字重。
- **外壳**：侧栏没有底色和边线，直接坐在 `--bg-1` 上；中栏的每个窗格、右侧面板、设置页的内容区、自动化页是圆角卡片，之间留 `--shell-gap`。`PaneLayer` 的 `GAP`、`tab-row.ts` 的 `SHELL_GAP`（8）和 `CAPTION_W`（142，系统按钮三个各 46 + 4）要和样式表一致。手机上没有缝、没有圆角（整屏）。
- **字体**：Inter Variable、JetBrains Mono Variable 经 fontsource 打进包；中文正文用系统字体；首页问候语和各页标题用 `CW Heading`（思源宋体 600 裁出来的 97 个字，16 KB）。**改了标题文字要重新裁**：字符串清单在 `ui/heading-text.ts` 的 `HEADING_STRINGS`，`npx tsx scripts/subset-heading-font.ts`，`heading-text.test.ts` 会拦住缺字。带用户输入的标题（设置搜索）不用标题字。许可证在 `web/public/licenses/`。
- **图标**：形状来自 Lucide，但没有运行时依赖：`web/src/ui/icon-map.json`（我们的名字 → Lucide 的名字）经 `node scripts/gen-icons.mjs` 生成 `icons.generated.ts`；`<Icon name size />` 的用法没变，线宽由 `strokeFor(size)` 定。加图标 = map 里加一行再跑脚本。
- **桌面标题栏**：Windows 上系统按钮的底是透明的（`titleBarOverlay.color: '#00000000'`，Win 11 + Electron 44 实测），浮在右上角那张卡片上。`setTitleBarColors(bg, fg, overlay, height)`：`bg` 是外壳底色（新窗口的背景），`overlay` 是按钮区域的底色，`height` 是按钮区域的高度；Linux 走退路（`html.desktop.linux`），macOS 红绿灯 `y: 27`——这两个都没在真机上看过。
  - **按钮区域的高度 = 上面的缝 + 它下面那一行的高度**（`tab-row.ts` 的 `captionRow()` / `captionHeight()`，`App` 随颜色一起报，`main.ts` 夹在 32–80、新窗口先用 60）：头部行（会话头、首页顶行、自动化页、默认右侧面板的标签行、设置页的拖动条）60，工作台工具下的分组栏 / 标签条 48。固定 40 时 − □ × 比那一行的图标高 14px；现在高 4px，而且区域不伸到那一行下面。**别改成完全对齐的 68**：会压到下一行顶上 8px（面板正文的标题行 ×、分组栏下面的标签条），点偏就是关窗口。所以右上角那一行让出右边 142px 就够；任何**不在那一行里**、却画在窗口右上角 138 × 60 以内的可点东西都会被系统按钮盖住（图片查看器的工具栏就是，已让出 150px）。挪到按钮下面的标签行（`.stacked`）、图标栏、设置页的拖动条用 `--h-head` 当上边距。
  - 看带真实系统按钮的样子：开一个 `titleBarStyle: 'hidden'` + `titleBarOverlay` 的窗口加载页面、给 `<html>` 加 `desktop win`，用 `desktopCapturer.getSources({types:['window']})` 按窗口标题只截它自己（`capturePage` 截不到系统按钮）。URL 走环境变量。
- **动效的规矩**：只动 `transform` / `opacity` / 颜色（发送键、流光、状态页签另有几个写在 `.composer` 上的变量）；**只有眼前实时发生的才有进场动画**（`ChatView` 的 `ArrivalCtx`：加载历史、重载、换对话、往上翻都不播；键盘或脚本打开的菜单带 `data-kb` 也不播）；「减少动画」和系统的减少动态效果下什么都不动，转圈的加载标记除外（`.spinner` / `.spin` 仍 1.2s 一圈）。
- **退场是一份 inert 的副本**（`ui/ghost.ts`）：菜单、审批卡、操作单本身照旧立即卸载（关闭路径、焦点归还、一次一个菜单都没变），真实指针关闭时原位留一份副本淡出：`.menu.leaving`（约 200ms）、`.pdock-out`（不带 `.pdock`）、`.as-layer.as-leaving`（最多 320ms）。**数 `.menu` 个数的代码和测试要避开这段时间**（手机上用 `.as-layer:not(.as-leaving) .menu`）。
- **新组件 / 模块**：`ui/Segmented.tsx`（带滑块的分段控件：智能程度、设置里的两三选一、手机审阅的换行 / 横滚）；`ui/Toasts.tsx` + `toast-stack.ts`；`composer/send-state.ts`（发送键的四个状态，同一个按钮换 `data-state`）；`chat/run-status.ts`（状态页签的文字、步数、钟面计时 `0:34`）；`model/turn.ts` 的 `groupSteps()`（相邻的同类已完成步骤合成一行）；`chat/step-view.ts`、`fold-phase.ts`、`count-up.ts`、`stream-fade.ts`；`chat/QueueCards.tsx`（排队的消息，从 StatusStrip 里搬出来的）；`ui/haptics.ts`（设置 `ui.haptics`）。
- **手机**（≤ 760px）：
  - 会话头是悬浮的圆钮（☰ · 标题 · `+N −M` · ···），直接压在对话上面时下沿渐隐；每个可点的东西点击区 ≥ 44px（`::after` 撑大，`phone.css` 开头）。
  - 右侧面板是能拖的底部抽屉：`store.sheetDetent`（`half` 62% / `full` 92%），`ui/sheet-snap.ts`（松手落哪一档）+ `ui/phone-sheet.ts`（拖动，直接改 `transform`）。**还是同一个 `.rpanel`，终端不重挂。**
  - 侧栏抽屉跟手：`ui/drawer-gesture.ts` + `ui/phone-drawer.ts`；右滑开始时先把侧栏挂上（`usePhoneDrawer.held`），松手决定打开才置 `sidebarOpen`。完全打开时不能有 `transform`（里面的菜单是 fixed）。
  - 所有锚定菜单是底部操作单：`ui/ActionSheet.tsx`，`Popover` / `MenuHost`（`useAnchoredMenu`）/ 模型菜单 / 项目菜单在 `store.mobile` 时把原来的菜单根元素原样包进去、portal 到 `<body>`；内容和 `data-*` 不变。对话行长按 500ms 开同一张单（`ui/long-press.ts`），行尾的 ··· 在手机上常显。
  - 系统返回手势关最上面一层：`ui/back-layer.ts` 的 `pushBackLayer(close)`，每层占一条 history 记录；只在手机宽度的浏览器里启用。
  - 点对话里的一步，详情在抽屉里打开（不原地展开）；审批卡按钮各占一行、允许一次在最上；终端上方一排按键（`panels/term-keys.ts`）；审阅有换行 / 横滚，提交收成一个按钮。
  - 手机壳（`web/src/shell/shell.css`）换了同一套颜色，自己抄了十几个原色（不引 tokens.css，要小），不带字体。
- **踩过的坑**：
  - **toast 不能放在底部**：底部是输入框、状态页签和审批卡；界面冒烟实测一条报错的 toast 正好压在审批卡的按钮上，真实鼠标点不到。现在在主栏顶上、会话头下面，而且不接收点击（文字因此不能选中）。
  - **同一个任务里先 `history.back()` 再 `pushState`，Chromium 会把新压的那条丢掉**（关侧栏和开抽屉在同一次提交里时，抽屉就没有自己的记录了，下一次返回会离开页面）。`back-layer.ts` 把历史记录的对齐推迟到稍后一步统一做，自己的 `go()` 还在路上时不压新的；深度从 `history.state.cwLayer` 读。测试用的假 history 在「遍历途中 pushState」时直接抛错。
  - **`:is()` 的优先级取参数里最高的那个**：`.app.mobile :is(.icon-btn, .cb .mm-anchor > .chip)` 是 (0,5,0)，会把绝对定位的按钮改回 relative。大范围的手机规则用 `:where()`。
  - **`getBoundingClientRect` 含进场动画的位移**：审批卡上移进场时量到的底边比落定后低。界面冒烟里量位置前先等它落定；别在组件里用它判断刚挂载的东西在哪。
  - **冷却 600ms 的那几条冒烟检查余量很小**：`key()` 自己睡 200ms，再加两次 `js()` 就接近 600 了；页面一慢就过线。要「紧接着」就用 `waitFor` 等到上一步的结果出现，别用固定的 `sleep`。
  - **Windows 上写文件偶发 `UNKNOWN: unknown error, open …`**（别的进程正读着它：杀毒、另一个测试进程）。改文件的脚本里重试几次。
  - **`corner-shape: superellipse()`** 在 Electron 44（Chromium 152）里可用，阴影环跟着形状走；只给了大面（`corners.css`）。不支持的浏览器忽略它。
  - 跑界面冒烟时电脑睡了，驱动会停在半路、最后报「driver finished in time」（实测过一次，中间隔了约 50 分钟）；重跑即可。
- **界面冒烟这次改过的断言**：收起侧栏后中栏左边是 8 不是 0；1440 场景面板宽 432、正文顶 ≤ 61；手机会话头允许有 `+N −M`；手机输入行高度上限 40；手机审批卡「允许一次」在「拒绝」上面（`a.bottom <= r.top + 1`）；量审批卡位置前等 450ms；「排队那一下之后紧跟的 Enter」改成等「改用排队的这段话拒绝」按钮出现再按。
- **前面各节里不再成立的说法**：
  - 「图标全部手写：`icons.tsx` 一个 `PATHS` 表」→ 生成的表，见上。亮 / 暗两套的颜色值、`--primary` 之外的那些具体色号 → 以 `tokens.css` 为准。
  - 「右侧面板打开时列宽有 240ms 过渡」→ 列宽一步到位，面板卡片自己滑入 260ms；关闭时淡出 150ms（`data-rp-closing`，`dock-closing.ts`），这期间 `.rpanel` 的宽度还没归零。
  - toast 在右下角 → 主栏顶部居中。
  - RunCard 是「贴在输入框上沿的一行」→ 状态页签（类名仍是 `.run-card`），停止按钮是 `button.rc-stop`，计时是钟面。
  - 排队的消息在 StatusStrip 里（`.queue-list` / `.queue-item`）→ `QueueCards`（`.queue-cards` / `.queue-card`）。
  - 手机：「会话头只有 ☰ · 标题 · ···」→ 还有 `+N −M`；「抽屉 78vh、没有拖动条、不能拖」→ 两档、有把手、能拖；「侧栏抽屉 84vw / 320」→ 86vw / 380；「工具行点开就是原地展开」→ 进抽屉；「断线是一条 24px 的细条」→ 手机上是琥珀色小胶囊；「手机上右侧面板的菜单是锚定菜单」→ 操作单。
  - 设置里的 `.sp-seg` 是 `Segmented`（根元素类名 `segmented sp-seg`）；`[data-id="pair-switch"]` 现在是包在它外面的一层。
  - 终端面板的根元素是 `.term-wrap`，xterm 挂在里面的 `.term` 上。

## 质感（2026-10-16）

spec `docs/superpowers/specs/2026-10-16-texture-design.md`，计划 `docs/superpowers/plans/2026-10-16-texture.md`。参考了 open-claude-ui（MIT，手写的近似实现，不是官方代码）的观感，按我们自己的令牌重写；颜色原语一个没动。

- **发丝边**：`--hairline` 是 1px，`@media (resolution >= 2x)` 下 0.5px，同时 `--e-k: 1.4` 把三条 `--edge-*` 的强度乘上去（细了一半，淡了就看不见）。样式里画线一律 `var(--hairline) solid var(--edge-…)` / `0 0 0 var(--hairline) var(--edge-…)`；`texture.test.ts` 拦 `1px solid var(--edge-` 和 `0 0 0 1px var(--edge-`。手机壳 `shell/` 不吃 tokens.css，不受这条约束。Windows 150% 缩放不是 2x，仍是 1px。
- **环**：`--elev-*` 的第一段是 `--ring-1`（贴着外壳的卡片）/ `--ring-2`（浮起来的）。浅色（light、paper）是外环；暗色（默认、dracula、nord、tokyo-night）是 `inset` 白色内高光 + 黑色外环，写在 `:root:not([data-theme='light']):not([data-theme='paper'])` 里——**新加浅色主题要加进这个排除列表**。`--elev-2/3` 多了一层短的接触阴影。
- **弹簧**：`--spring-bouncy`（开关、分段滑块、发送键图标）/ `--spring-snappy`（菜单、`.ctx-card`、toast、审批卡进场、步骤 pop）/ `--spring-gentle`（右侧面板滑入、手机抽屉和操作单落位），各带 `-dur`。由 `web/src/ui/springs.ts`（阻尼振子解析解）生成 `linear()`，`npx tsx scripts/gen-springs.ts` 写进 tokens.css 的 `springs:begin/end` 标记区，`--check` / `springs.test.ts` 拦手改或过期；不支持 `linear()` 时是 cubic-bezier 退路。落定阈值 1%（0.2% 时要 400–540ms，尾巴看不出来但菜单还在缩放，ui-smoke 量位置会量到半路）。退场动画没换：`Dock.tsx` 按名字等 `fl-rp-out`。`--ease-pop` 现在是 `--spring-snappy` 的别名。
- **按下**：`--press: scale(0.98)`，`.btn` / `.icon-btn` / `.chip.starter` / 代码块按钮 / 消息操作 / 输入框（`--cmp-press`）都用它。后台的大卡片 `bg-card` 仍是 0.985。
- **滚动渐隐** `styles/scroll-fade.css`：scroll-driven animation 在元素自己的滚动时间线上把注册属性 `--sf-t / --sf-b` 在 0 和 `--fade` 之间动，`mask-image` 读它们（顶 / 底各 7 个缓出停点）。不能滚时时间线不活动 → 都是 0 → 不渐隐。坑：
  - 选择器列表必须是 `:where(…)`：`:is()` 取最高的那项（`.cmdk .list`）的权重，后面的 `.chat { --fade: 16px }` 和 `.welcome` 的组合动画会被它盖掉（写成 `:is` 时首页的 `fadein` 就没了）。
  - 元素本来有 `animation` 的要把它和 `sf-top / sf-bottom` 写在一起（`.welcome` 那样，`animation-timeline: auto, scroll(self), scroll(self)`）；`.menu` 一族有 `fl-menu-in`，没套。
  - 系统的减少动态效果（`prefers-reduced-motion`）下渐隐照常：`animation-duration: 0.01ms` 对滚动时间线无害（按比例换算）。应用里的「减少动画」开关不一样：`html[data-reduce-motion='1'] * { animation: none }` 连渐隐一起关掉。
  - 有粘性条时不渐隐：对话的查找栏、侧栏的筛选 / 多选条在顶部渐隐带里会被洗白，`:has()` 命中时 `--fade: 0px`。
  - 两种减少动画下弹簧都退成 80ms 的 `--ease-out`（`--spring-*` / `--spring-*-dur` 在两个块里覆盖），开关和发送键不再 260ms 带超调。
  - 'Inter Dark' 正体和斜体都要声明：只有正体时 `<em>` 被浏览器拿正体伪斜（不会往下找 Inter Variable 的斜体）。
  - 遮罩会把滚动条两端也淡掉，接受。
- **暗色字重**：`fonts.css` 的 `'Inter Dark'` 是同一份 Inter 文件声明两段字重（350–380、501–900），暗色主题的 `--font` 把它排在 `'Inter Variable'` 前面。请求 400 → 400–500 里没有面 → 往下取 350–380 夹到 380；600 → 501–900。中文落到雅黑等 CJK 字体时请求的还是 400，不会掉到 Light。**所以样式里别写 `font-weight: 500`**（暗色下会变成 380），`texture.test.ts` 拦。URL 写的是 `../../node_modules/@fontsource-variable/inter/files/…`，构建后和 fontsource 自己那份是同一个哈希文件，不多一份。导出的对话没有这份字体，`--font` 的下一项接上。
- **圆角**：`--r-bubble` 18（用户气泡、toast，36px 高的 toast 仍是整圆）；新 `--r-composer` 20（输入框外框）；`--r-2xl` 24 留给审批卡、对话框、抽屉顶边。
- **行内图标**：`:where(svg) { vertical-align: -0.125em }`，零权重，flex 行不受影响，任何已有规则都赢它。
- `texture.test.ts` 还会用 postcss 解析每一份样式表：tokens.css 里一行跑出注释外的字只有构建才报，单元测试不拦，这次就是这么漏的。
- **验证 2x**：Electron 离屏窗口不认 `force-device-scale-factor`；用两倍大小的窗口 + `webContents.setZoomFactor(2)` 能让 `devicePixelRatio` 和 `resolution` 媒体查询都变成 2x，但 Windows 会把窗口夹到屏幕大小，布局会挤——只看线和渐隐，别看布局。**Chromium 按 host 记住这个缩放**（Electron 默认 profile 的 `%APPDATA%ElectronPreferences`），之后对 127.0.0.1 跑的 ui-smoke 会整页放大、大面积失败：测完 `setZoomFactor(1)` 或清掉那条记录。

## 表单控件：不用系统自带的样子（2026-10-28，用户报告「模型 → 设置」一堆系统控件）

- **下拉**一律 `ui/Select.tsx`（可以直接包 `<option>`）；`<select>` 一个都不留。
- **开关**一律 `ui/Switch.tsx`：`Switch`（`role="switch"` 按钮，`hub` 属性在模型页用绿色 `hub-switch`，否则是 `toggle`）、`SwitchLine`（字在左、开关在右的一整行）、`SwitchChip`（夹在一行别的控件中间的「字 + 小开关」）。它们是 `<label>` 包按钮，点字也能切。`<input type="checkbox">` 只留给「从列表里勾几项」（导入预览、模型挑选），全局 `accent-color: var(--accent)`。
- **文本框**：应用里用 `field`（`input.field` / `textarea.field`），「用量与隐私」页里用 `input`（`.hub-page .input`）。`label.field > textarea.field` 自动占满一行。
- （历史）那时还给模型网关的旧「上游」页、路由弹窗、插件市场换过控件；这些页面 2026-11-01 删了（「只留 Claude」）。`styles/gateway.css` / `gateway-sources.css` 还在 `main.tsx` 里引着，多半已无人用，清样式时可以一起看。
- 模型页的设置行：`hub-setrow` + `hub-setlabel`（左字右控件）；整行宽的框用 `hub-setrow hub-setrow-stack`（字在上、框、按钮在右下）。
- 查漏：`node .superpowers/scan-controls.cjs` 列出所有裸 `<input>/<select>/<textarea>`（不在仓库里的话照着写一个：按大括号配对找标签）。（当时的截图脚本 `.superpowers/hub-shot-theme.cjs` 会滚动 设置 / 隐私 / 路由 并打开智能路由弹窗，路由那部分已不适用。）
