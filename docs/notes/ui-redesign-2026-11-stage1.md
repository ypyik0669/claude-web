# 界面改版（2026-11）阶段 1：外壳（2026-11-19）

方案：私有 Artifact「Claude Web 新界面」第 7 版（#ia 入口表、#pages、#phone、#plan 阶段 1、#decided）。方向是做减法：
阶段 1 去掉图标栏、侧栏顶上五个入口、后台和 Bot 并进自动化；阶段 2 设置弹窗化；阶段 3 侧栏照图 7 重做；阶段 4
首页 / 对话 / 手机做减法。四个阶段一起发一版，每个阶段真机验过、审过再往下走。**这一篇和「图标栏 / 分区 / 联网」
冲突的地方以这一篇为准。**

## 结构

- **图标栏删了**：`features/rail/`（`Rail.tsx`、`rail-model.ts` 和它的测试）、`RAIL_WIDTH`、`ui.railPins`（不再读，
  meta.json 里留着也无所谓）都没了。`styles/rail.css` 改名 `styles/shell.css`（`main.tsx` 里的位置不变），里面只剩外壳
  的样式；`styles.css` / `floating.css` 里 `- var(--rail, 0px)` 的残留一并去掉。三个分区侧栏 `AutomationSide` /
  `ExtensionsSide` / `ModelHubSide` 也删了——侧栏永远是对话列表（`App` 里 `.sb-sect` 只有一个）。
- **侧栏顶上**：桌面 `[logo ▾] [⧉] … [← →]`（⧉ 收起侧栏仍是悬停 / 聚焦才显示），下面五行：新对话 · 搜索 · Artifacts ·
  自动化 · 自定义（`sidebar/entries.ts` 的 `TOP`）。手机抽屉：logo + Claude Web + ×，一个搜索框（打开命令面板，
  `data-id="search"`，输入框样式但是个按钮）+ 四行（没有「搜索」那一行；「派活」并进新对话——手机的新对话页本来就能
  选电脑和项目）。Ctrl B 收起整个侧栏；收起后「展开侧栏」（`SidebarReveal`）是对话头 / 页头的第一个按钮，桌面也有了。
- **品牌 logo = 应用菜单**（`sidebar/AppMenu.tsx`，从 rail 挪过来，菜单内容不变）：桌面版弹原生菜单
  `desktop.showAppMenu(x, y)`（坐标乘 `--zoom`），浏览器里是网页菜单（`.sb-brand-anchor` 里的 `AppMenu`）。
- **账号行**在侧栏底部，所有宽度都有（以前桌面的头像在图标栏底下）：额度环里的头像（`data-id="connection"`）· 名字 ·
  一行额度 · ⚙（右键在右侧面板开配置中心）。**账号菜单八行**：设置 · 用量与账本（右边「今日 $x」，`data-id="today"`）·
  语言 › · 主题 › · 键盘快捷键（手机没有）· 帮助与反馈 › · 更新内容 · 登录 / 退出。三个 › **在原地展开**（`SubRow`，
  同一时间只开一个），不往右飞出：全局只能有一个锚定菜单，飞出的子菜单会把账号菜单关掉。配置中心、命令面板两行去掉了。

## 自动化 = 三个页一排标签

- `sections/frame.ts` 是「页的家族」登记表：`registerPageFrame(name, { title, desc, Tabs, Side? })`。`OverPage` 见到登记过
  的 name 就画家族的标题和一排标签，页自己的标题和说明挪到标签下面那行（`.fam-sub`）；有 `Side` 的页在桌面上左边多一栏
  （`.over-cols > .over-side`），手机上用页自己的标签。
- `automation/family.tsx` 把 `automation`（定时任务 · 目标 · 编排）、`background`（运行中）、`bots`（Bot）登记成一家：
  `FamilyTabs`（`.fam-tabs .ft[data-id]`：running · schedules · bots · goals · orchestra，数字：在跑的、定时任务个数、
  Bot 收件箱、「n 等你」）。**后台页、Bot 页的组件一行没改**（并行的「跑过的子代理」在改后台页的内容，合并时不会撞）；
  运行中的对话列表从分区侧栏变成页里的左栏（`Side = BackgroundSide`；11-20 去掉了，见「界面改版（2026-11）自动化」）。
- **记住上次的标签**：`family.tsx` 订阅三个页的小 store（谁 `open` 了就记下谁），侧栏「自动化」= `openFamily()` 回到上次
  那个（默认运行中）。`panel-entries` 的点击数：上次那个标签 1 下，别的 2 下（`tabClicks`）。
- 侧栏「自动化」上的数字 = Bot 收件箱 + 等你审批的编排（`useAutomationWaiting`）；三个页任一在前面它就亮（`.on`）。
- 3D 网吧还是运行中这一页里的东西；「列表 / 网吧」的切换 11-20 做了（见「界面改版（2026-11）自动化」）。

## 页面外壳

- **一条左边线**：标题、标签、说明和内容列从同一个左边开始（方案里的页都是左对齐）；窄页的内容列最宽 860，页头的按钮
  停在列的右边缘（`.over-head.narrow .over-head-in { max-width: 860px }`）。以前窄页在卡片里居中：同一家族在窄标签（定时
  任务）和满宽标签（运行中）之间标题会左右跳；自定义页的标题和标签对不齐（页头里的 × 参与居中，标签行不参与）；
  Windows 上窄页把页头右边距改回 30px，× 跑到系统按钮底下。现在窄页头和别的页头一样右边留 `--caption-w`。
- 手机上页头不放说明（`.over-sub` 藏起来，放不下），按钮的字一行写完、至少 44×44，Artifacts 的「已发布的文件」只剩图标。

## 别的入口去了哪（#ia）

- 扩展 → **自定义**（`EXTENSIONS_TITLE = trAs('自定义', 'Customize')`）：侧栏一行，连接器 · Skills · 插件是页自己的标签。
- 模型 → **设置 › 模型**：模型那几页顶上一条「来源、账号、路由和用量都在模型看板里 [打开模型看板]」（`.sp-hub-link`）；
  模型菜单的「管理来源」、设置 › 模型网关的「打开上游」直接 `openHub('sources')`——以前的 `openGateway()` 打开的是已经
  不画的 GatewayPage，点了没反应。看板合进设置是阶段 2。
- 图标栏 ··· 的面板：总览 → 需要你 + 自动化 › 运行中；用量与账本 → 账号菜单；共享记忆 → 设置；Issue 与 PR / Android →
  对话头 ⋯（Android 是新加的一行，远程对话没有）；配置中心 → 自定义 + 设置 › 高级（⚙ 右键也行）。
- **命令面板认旧名字**：`palette/moved.ts` 的 `MOVED`（新地方 + `old` 旧名字，进「前往」组，`goTo()` 打开）和
  `PANEL_OLD_NAMES`（面板命令的 keywords）；`palette/filter.ts` 的 `nameHit` 也查 keywords。`moved.test.ts` 查每个旧名字
  都找得到、每个目标都存在。
- `entries.ts`：`TOP` 换成新的九个；`AUTOMATION` 五个标签；`ACCOUNT` 去掉 config / palette，加 language / help /
  whats-new；`ACCOUNT_PANELS` 只剩 usage；`LEGACY` 加了图标栏的每一项（`图标栏 · …`），`ADDED` 记了新入口。

## Artifacts 页

`features/artifacts/`：整页（`OverPage name="arts"`），每次打开读一次 `artifacts.list`（服务端早就有，原来给「文件 ›
生成的文件」用）；超过一种文件时按类型分标签；卡片：打开（文档标签页）· 来自哪个对话 · 发布。空状态
`EMPTY.artifactsPage`。方案里完整的 Artifacts 库（自己的索引、预览、分享、其它电脑）以后的版本做。`ArtifactsPage` 是
lazy 的，首屏入口 1 800 165 字节（上限 1 900 000）。

## 数字

- 顶层入口 6（侧栏五个 + 账号行；方案的 11 → 6）。
- 外框控件计数（「界面改版 阶段 0–1」的口径）：演示数据（3 个项目）下 29，其中侧栏 13，明细记在那一篇。

## 标题字

`heading-text.ts` 加了 自动化 / 自定义 / Artifacts / 模型看板，`npx tsx scripts/subset-heading-font.ts` 重切了
`cw-heading.woff2`（29 条、106 个字）。二进制，合并时冲突就合完 `heading-text.ts` 再切一次。

## 手机体检

`scripts/lib/phone-audit.cjs`（页面里跑的代码，不驱动界面），ui-smoke 的 `phone-audit` 段：390×844 / 360×780 /
430×932 × 浅 / 深。

- 本阶段的屏全部规则：抽屉、账号单、自动化每个标签的页头和标签行、自定义的页头和标签行、Artifacts。规则：点按区 44×44
  （中心左右上下 21px 处都要落在控件自己身上——padding、`::after` 的隐形圈都算；落到裁剪框外的点不算），输入框 ≥ 16px，
  页面不横向滚，控件不伸出窗口（自己会横滑的盒子里不算），中心没被别的东西盖住。对话、新对话页和各页正文先查除 44 以外
  的（44 是阶段 4 的事）；运行中（列表、网吧和它的 ⋯、跑过的）和定时任务的行 11-20 起也查全部规则（见「界面改版（2026-11）自动化」）。
- 一个 scope 匹配多个元素时都查（页头 + 标签行）。早先只查 `querySelector` 的第一个，标签行一直没被查到。
- 不合格时写出差在哪边、那边落到了什么（`small: ['… 76×44 (↓ 新 Bot)']`）。
- 查出来修过的：抽屉行尾 ⋯、区标题按钮、页头按钮到 44；手机输入框一律 16px，同时去掉 viewport 的 `maximum-scale=1`
  （安卓能双指缩放了）；抽屉里 +6 −1 从 11px 到 12px；手机标签行下面留 4px——Bot 页的 ＋ 是 34px 按钮加 44px 隐形圈
  （`phone.css`），圈爬到了「目标」标签的底边上。

## 坑

- **锚定菜单「一滚就关」现在只看锚点动没动**（`sidebar/menus.tsx` 的 `useAnchoredMenu`）：账号行搬进侧栏以后桌面上的
  对话列表矮了一截，ui-smoke 侧栏段（假数据多）的分区菜单打不开、行菜单的「加入分区」点不到——右键前的
  `scrollIntoView`（`scroll` 事件晚一帧才到，菜单已经开了）和新建分区插在上面时浏览器的 scroll anchoring 都会发
  `scroll`，菜单刚开就被关掉。现在记着上次摆放时锚点的位置，`scroll` 里锚点没动就不关；手动滚列表照样关。复现：
  列表能滚的窗口里，同一拍里先把最后一行滚进来再右键——修之前菜单没了，修之后还在。
- 侧栏收起时 logo（应用菜单）也一起不见（方案：收起就全收）；ui-smoke 里点 ☰ 之前要先把侧栏打开（以前 ☰ 在图标栏上，
  侧栏收起也看得见）。
- **Git Bash 的 heredoc 会吃反斜杠**（`\'` 变成 `'`，CLAUDE.md 也写了）：带反斜杠的改动脚本用 Write 写成文件再跑。
- **ui-smoke 的 `click` 是真鼠标事件**（先量位置、命中检查），点不到隐藏的东西；页常驻只 `hidden`，每个页头都有自己的
  「展开侧栏」，`document.querySelector('.sb-reveal')` 可能拿到隐藏页里那个——要开侧栏就 `setState({ sidebarOpen: true })`。
- **临时 HOME 里没有 Claude 登录**：账号菜单的 `expired` / `logout` 两项看不到，PLACES 全找到的检查会缺。ui-smoke 用
  开场分支那份（合 main 时留下的，11-20）：额度那步之后临时假一个「登录着、已过期」，用订阅挡住 `auth.changed`，看完马上
  换回去。三个分支各修过一份，合并时只留这一份。
- **桌面开场的 logo 落在哪**（和「人设版开场与背景」叠在一起以后，11-20）：开场最后把 logo 飞到 `LOGO_TARGET`，原来是
  图标栏第一个按钮（26/34）。图标栏没了，现在对着侧栏左上角的 logo：Windows 28/34、Mac 99/34（侧栏那一行让出红绿灯），
  `logoTarget(process.platform)`；ui-smoke 的 right-panel-desktop 段两种排法各量一次。侧栏收起时应用里没有 logo，开场
  照样落在那个角上再淡掉。
- 自动化的入口打开的是**上次的标签**：测试里点完侧栏「自动化」要等的是「家族里某个页」（`.over-page.in-family`），想要
  哪个标签再点哪个，别直接等 `.auto-page`（上一步开过后台页的话打开的是运行中）。

## 和方案不一样的地方（留给后面）

- ~~「列表 / 网吧」切换没做~~：11-20 做了，连同手机上网吧的工具进 ⋯、手机定时任务的行（下面最后一条里的两样），见「界面改版（2026-11）自动化」。
- 抽屉搜索框写「搜索对话和命令」：命令面板还搜不到 Artifacts。
- 自定义的标签顺序（方案是 Skills 在前）和「Artifact 类型」标签留给阶段 2。
- 账号菜单的子菜单原地展开，不是往右飞出；今日费用写在「用量与账本」那一行右边。
- 手机抽屉的行尾仍是 ⋯ 和时间（方案：只留状态、长按出菜单）；定时任务行名字被按钮挤、连接器分类折行、网吧工具条互相
  压住——都在方案的手机问题表里，阶段 3 / 4 做。
