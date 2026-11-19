# 节点图（spec 2026-10-24 D，2026-10-25）

spec：`docs/superpowers/specs/2026-10-24-desktop-parity-design.md` 的 D 节；计划 `docs/superpowers/plans/2026-10-25-stage-d-node-graph.md`。
样子照用户的一段 mp4（「Access settings」：一条红色发光的公开路径，下拉框把 read 改成 Admin，线变灰虚线、右上角变成「No open paths」）。
对照图：`docs/images/node-graph-sample.png`（ui-smoke 的 `ux-node-graph-sample.png` 复制来的；改成 Admin 之后那帧是 `ux-node-graph-sample-ok.png`）。

## 在哪

- `web/src/ui/node-graph/`
  - `schema.ts`：格式校验 + 补默认值（`parseNodeGraph` / `normalizeNodeGraph`），报错带路径（`edges[2].to: …`）。组件只收规范化后的 `NodeGraphData`。
  - `marks.ts`：下拉框的选择 → 线样式（`edgeStyles`）、状态标签（`badgeView`）、「把改动发给 Claude」那句话（`changeSentence`）、哪些线有光点（`pulses`）。
  - `layout.ts`：拓扑分列 `layers`（从 orchestra 挪来）、卡片尺寸、贝塞尔线、标签宽度、拖动偏移。
  - `viewport.ts`：适应窗口（含全屏的 `fullFit`）、以指针为中心缩放、百分比、方向键 `PAN_KEYS`、入场时间表、`motionOn`（减少动效或超过 150 张不动）。
  - `mermaid-flow.ts`：Mermaid flowchart → 节点图。
  - `NodeGraph.tsx` + `node-graph.css`：组件；`index.tsx` 的 `LazyNodeGraph` 懒加载它；`motion.ts` 是实时的减少动效 hook；`sample.ts` 是 mp4 的那张图（ui-smoke 里有一份 JSON 拷贝，两边要一样）。
  - `ZoomBar.tsx`（`−  N%  +  适应窗口`，传了 `onFullscreen` 才有「全屏查看」）、`PanZoom.tsx`（同一套画布和手势给任意图片用）、`svg-size.ts`：见下面「全屏查看」。
- 三处用法：后台指挥台 `features/background/CommandGraph.tsx`（数据 `graph-data.ts`，见「后台」笔记）；编排执行图 `features/orchestra/Graph.tsx`（数据 `orch-graph.ts`，见「多 agent 编排」笔记）；对话里的 ```` ```nodegraph ```` 代码块 `features/chat/NodegraphBlock.tsx`（`CodeBlock` 收完才画，流式时照常显示代码）和 `MermaidBlock` 的「节点图 / 原图」切换。

## 格式

结构见 `sample.ts`：`{ title?, subtitle?, badge?, nodes: [{ id, title, subtitle?, icon?, rows?: [{ id?, label, value, options? }], list?: { title, items }, state?, x?, y? }], edges?: [{ id?, from, to, fromRow?, label?, style?, pulse? }] }`。

- 只有 `nodes[].id / title`、`edges[].from / to` 必填。线样式 `normal | strong | error | dashed`，默认 normal。
- 线的默认 id 是 `from>to`，重复的加 `#2`、`#3`；行的默认 id 是 `r<序号>`；`fromRow` 可以写行 id 也可以写 label。
- `options` 可以是字符串或 `{ value, label?, marks? }`；`value` 不在 options 里就补到第一个。`marks` 是「线 id → 样式」，只能指向存在的线（所以要变样式的线得写 id）。
- `badge`：字符串原样显示；`{ count?: 样式（默认 error）, text: '… {n} …', okText }` 数那种样式的线，0 条时显示 okText，改下拉框会跟着变。
- 不认识的键忽略。上限（review D3，常量在 `schema.ts`）：源码 256 KB（JSON.parse 之前就拒）、500 张卡片、2000 条线、每张卡 30 行、每行 30 个选项（这几个超了就报错）；列表 50 项（多的变成一行「…还有 N 项」）、每项 5 个标签（多的丢掉）；显示的文字超过 200 字截成「…」（id 不截，线和 marks 要靠它对上）；x / y 夹在 ±20000。
- 同一个 value 写两次只留第一个；没写 id 的行是 `r<序号>`，跟别的行写明的 id 撞了就变 `r<序号>_2`。
- id 可以是 `constructor` / `__proto__` / `toString`（review D1）：按 id 存的表一律 `dict()`（`Object.create(null)`），读用 `own()`（`Object.hasOwn`），别再用 `{}` 和 `in`。

## 画法

卡片是 HTML（绝对定位），线是同一个变换层里的一张 SVG（`.ng-layer > svg.ng-edges`）。原因：下拉框（`ui/Select`）、文字省略号、Tab 焦点都用现成的 HTML；发光（一条粗的半透明路径）、光点（`<animateMotion>`）、标签（圆角 rect + text）全在 SVG 里。尺寸常量只在 `layout.ts`，通过 `--ng-head-h` 等变量传给 CSS，只有一个来源。颜色全用令牌（`--accent` 是 strong，`--err` 是 error）。

## 动效规则

- 入场（卡片一张接一张淡入、线从起点画出来）只在「刚到」时放：对话里是实时到达的块（`ArrivalCtx`），后台 / 编排是打开视图时。
- 减少动效（设置 `ui.reduceMotion` → `<html data-reduce-motion>`，或系统的 prefers-reduced-motion）和超过 150 张卡片：什么都不动（`data-motion="off"`，不渲染 `<animateMotion>`，CSS 把动画和过渡都关掉）；超过 300 条线也关。
- 滚出屏幕（IntersectionObserver）：`data-offscreen`，光点不渲染、CSS 动画暂停。
- 光点只在 strong / error 线上，`pulse: false` 可以关掉；后台和编排里失败的线都关了（不再有东西在流动）。

## 交互

拖卡片、拖空白处平移、滚轮缩放（用 A3 的 `wheelZoom`：Shift 或到了上下限就不拦，页面照常滚）、`−  N%  +` 和「适应窗口」按钮（对话里还有「全屏查看」）、画布或卡片有焦点时 `+` `-` `0` 和方向键平移、双击空白恢复布局。只有能选的卡片是 Tab 站（别的 `tabIndex=-1`）；用键盘把焦点移到画面外的卡片会平移过去（`panToShow`，只在 `:focus-visible` 时）。

**嵌在会滚的地方**（对话回复、编排面板，`embedded`，review D5）：点过 / 聚焦过这张图之后滚轮才缩放，之前滚轮留给页面。

**高度跟宽度走**（review D4 / D5，`useColumnFit` + `viewport.ts` 的 `fitHeight`）：先按栏宽定比例（对话 `chatFit`：(宽 − 32) / 图宽，夹在 60%–100%；编排 `ORCH_FIT`：50%–100%），再按这个比例定高度（对话 200–560，编排 160–420），所以卡片下面没有空带。有标题 / 状态标签时适应窗口在上面留 56px（标签不压卡片），下面留 44px 给缩放按钮。比例到了下限还放不下就从左上角开始（`start`），自己平移。没被用户动过时，尺寸一变就重新适应。卡片点击用 pointerup 判断（移动不到 4px 才算点），拖动的结尾不会误选。拖动结果和选择都不保存（spec 说的「不保存」）。

## 全屏查看（GitHub issue #17，2026-11-19）

用户的图是十几张表的关联图，在回复里按栏宽压到 60% 还放不下（右边被截掉），字也小。

- **按钮放哪**：`ZoomBar` 的「适应窗口」后面（`zoom` 图标，四个角），只在传了 `onFullscreen` 时有。对话里的 ```` ```nodegraph ```` 块和 Mermaid 的「节点图」视图传；**后台指挥台、编排执行图不传**：它们的卡片点了要在旁边打开东西（agent 的对话、步骤详情），盖住整个窗口就看不到结果，而且每秒拿新数据重画、右侧面板里的 compact 版按钮本来就挤。Mermaid 的「原图」视图没有缩放按钮，在同一个右下角单放一个（`.mmd-tools`），每张画出来的 Mermaid 图都有，不只是能切换的流程图。
- **查看层是图片查看器那一套**：`ui/Viewer.tsx`（`.viewer` 深色层 + `.viewer-bar` + `.viewer-stage`）从 `ImageViewer` 里抽出来的共用外框，`ImageViewer` 也搬上来了。颜色是 `--viewer-*` 令牌，哪个主题都是深色灯箱。portal 到 `<body>`（对话区的 overflow 裁不到），z 100；卡片上下拉框的 `.menu.cm`（1000）、`dlg.*`（200）、手机操作单（150）在它上面。桌面版 Windows 的 − □ × 是页面画的 `.win-ctl`（2100），照样在最上面，工具栏右边让出 `--caption-w`。
- **画法**：`features/chat/GraphFullscreen.tsx` 在查看层里另画一张同样的 NodeGraph：`height="100%"`（`height` 现在也收 CSS 长度）、`fullFit()`（打开时整张图适配窗口：最小 25%，再放不下就从左上角开始；最大 125%；上面给标题 / 状态标签留 64、下面给缩放按钮留 56），不是 `embedded`，滚轮直接缩放；拖动、按钮、键盘都是 NodeGraph 自己的。下拉框和回复里那张共用 picks：全屏里改了，关掉后回复里也是新的，「把改动发给 Claude」照常出现。桌面上画布四周露一圈深色边（左右下 16px、上 8px，像图片查看器里的图），按在边上关闭；手机上铺满、没有圆角，缩放按钮 40px。
- **回复里那张不卸载、不重画**：`NodegraphBlock` / `MermaidBlock` 把它 `useMemo` 成同一个元素，开关查看层时 React 连 render 都跳过（picks 变了才重画），缩放、平移、拖过的卡片都还在。
- **Mermaid 原图**：`MermaidFullscreen`（在 `MermaidBlock.tsx` 里）用新 id 再 `mermaid.render` 一次——同一份 SVG 插两份 id 会重复，箭头 marker 和 `#id` 样式都去找第一份。尺寸从 viewBox 读（`svg-size.ts`，读不到按 800×600），放进 `PanZoom`：NodeGraph 的画布、拖动、滚轮、`ZoomBar`、`+ − 0` 和方向键、双击适应，内容换成任意图片。
- **Esc**（纯逻辑 `ui/viewer-esc.ts` 的 `viewerTakesEsc`）：window 捕获阶段收，先问 `imeComposing()`；有菜单开着（`anchoredMenuOpen()`，或屏幕上有不在淡出的 `.menu`——卡片上的下拉框先关自己）、`.dialog-bg` 盖在上面、或者它不是最后一个 `.viewer` 时不管；否则 `preventDefault` + `stopImmediatePropagation` 再关，下面谁都看不到这一下（输入框的 Esc 会中断运行中的对话、App 的全局 Esc 会关设置页）。手机底部抽屉 / 侧栏抽屉本来就认 `.viewer`（`OVER_SHEET` / `OVER_APP`），侧栏多选的 `OVER_SIDEBAR` 也加了 `.viewer`（焦点掉到 `<body>` 时不会一下退两样）。手机浏览器里系统返回手势也关它（`pushBackLayer`）。
- **焦点**：打开时（layout effect，首帧前）记下要还回去的地方——`onFullscreen` 把按钮本身交出来（Safari 点按钮不给焦点，靠 `document.activeElement` 会丢）；焦点进画布 `.ng-viewport`（`+ − 0` 方向键马上能用；图片查看器给层本身，`tabIndex=-1`）。Tab 在层里转圈（`ui/focus-trap.ts` 的 `trapTab`）。关闭时还给按钮（`preventScroll`，对话不跳），焦点已经被别处拿走就不抢。按深色边关闭的那一下要 `preventDefault()`：关闭（和还焦点）发生在 mousedown 里，它的默认动作随后又把焦点挪到 `<body>`（实测，图片查看器同理）。键盘打开的没有淡入（`data-kb`），减少动效下全局规则把淡入也关了。
- **portal 的事件**：React 会把 portal 里的事件按组件树冒泡给渲染它的对话，所以层根上拦掉 click / dblclick / auxclick / contextmenu / wheel / keydown（全屏时按 `?` 不会在下面开快捷键表，Alt+W 不会关标签）。**mousedown / pointerdown 不拦**：卡片下拉框（Popover）靠 document 上的 mousedown 判断「按在外面」来关。
- **图片查看器跟着变的**：Esc 先问输入法、只关它自己；焦点进层、关后还回去；手机返回手势关它；← → 0 1 + − 改在层的 onKeyDown 上收（以前挂 window）；工具栏的 `.grow` 以前没样式、按钮全挤在左边，现在计数在左、按钮在右、× 在右上角；浅色主题下悬停按钮字变成深色看不见，修了；手机上工具栏换行，× 是 44px。
- 测试：`viewport.test.ts`（`fullFit`：一张 2000×900 的宽图在回复里卡在 60%，全屏是 92%）、`viewer-esc.test.ts`、`svg-size.test.ts`、`NodeGraph.test.tsx`（没传 `onFullscreen` 就没有按钮）。真机看：对话里的大图点「全屏查看」→ 适配窗口、拖 / 滚轮 / − + / 适应窗口、Esc 关、焦点回按钮；卡片下拉框开着按 Esc 只关下拉框；手机宽度下 × 够大、返回手势关。

## 坑

- 共用外框的纯逻辑叫 `viewer-esc.ts`，别叫 `viewer.ts`：和 `Viewer.tsx` 只差大小写，Windows 不分大小写，`import './Viewer'` 可能解析到 `viewer.ts`。
- 懒加载：后台面板和编排都在 boot 包里，所以组件 + CSS 是单独的 chunk（`LazyNodeGraph`）。boot 的上限 1 900 000 字节现在由 `web/vite.config.ts` 的 `boot-chunk-size` 插件在构建时拦、`shell/assets.test.ts` 再查一遍（`web/dist/index.html` 是手机壳的，原来的首屏检查看不到 boot；review X1，修完 1 761 095 B）。`NodegraphBlock` / `MermaidBlock` 自己已经是懒加载的，直接 import `NodeGraph`。
- `ui/` 里不能碰 store，减少动效只能读 `ui/input-intent` 的 `reducedMotion`（加 MutationObserver 跟着变）。
- 后台 / 编排每秒用新的 graph 对象重画（时间在走）：重新适应窗口只看卡片 id 拼成的 `nodeKey`，并且用户缩放 / 平移过就不再自动适应；拖过的偏移也按 id 保留。
- 隐藏的面板量出来是 0×0：等有尺寸才适应窗口。
- `.ng` 是 `overflow: clip`，不是 hidden：hidden 仍是滚动容器，焦点落到画面外的卡片时浏览器会把它滚过去，之后平移和指针位置就对不上了（review D6）。
- 坏 JSON 不 `console.warn`（ui-smoke 遇到 warning 就算失败），只在代码下面显示「这张图格式有误」和出错的位置。
- `orch-graph.ts` 用到的 `labels.ts` 读 store，单测里要 `vi.mock('./labels')`；`NodeGraph.test.tsx` 要 mock `@/ui/Select`（它经 Popover 拉进 store）。

## Mermaid 转换

支持：头 `flowchart|graph [LR|RL|TD|TB|BT]`；形状 `[ ]` `( )` `([ ])` `[[ ]]` `[( )]` `(( ))` `{ }` `{{ }}` `[/ /]` `[\ \]` `> ]`、带引号的文字（`<br>` 变空格）；`:::cls`；连线 `-->` `---` `--x` `--o` `<-->`（normal）、`-.->` `-.-`（dashed）、`==>` `===`（strong）；标签 `-->|t|`、`-- t -->`、`-. t .->`、`== t ==>`；链 `A --> B --> C`；`&`；`;` 分句。跳过 `%%` `subgraph` `end` `classDef` `class` `style` `linkStyle` `click` `direction` `accTitle` `accDescr`（subgraph 里的节点照样画）——只认「关键字 + 空格 + 不是连线」的写法，叫 class / style / click 的节点照样是节点。「节点图」视图外面有 ErrorBoundary。任何一行不认识（比如 `A@{ shape: … }`）→ 只显示原图，没有切换按钮。方向一律从左到右。

## 给 Claude 的提示

`server/src/runtime/nodegraph-hint.ts` 的一段英文说明拼进 `session-runner.ts` 的 `systemPrompt.append`。设置「新对话 → 让 Claude 画可交互的节点图」（`ui.nodegraphHint`，默认开）；进程启动时读，改了之后新开或重新启动的对话生效；只聊天 / 精简（`bare`）的对话不加，IM、定时任务、编排开的对话也不加（`OpenSessionParams.drivenBy`，回复不是先在 Claude Web 里看的）。示例 JSON 是 `NODEGRAPH_EXAMPLE`，web 的 `ui/node-graph/hint-example.test.ts` 读这个文件、过一遍 `normalizeNodeGraph`（以前的示例 fromRow 指着别的卡片的行，自己的格式都不收；review D2）。e2e：`server/ws-phase34.mjs`（假上游记下系统提示：默认有 ```` ```nodegraph ````，关掉后没有）。
