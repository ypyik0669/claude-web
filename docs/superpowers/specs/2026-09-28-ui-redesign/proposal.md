# Claude Web 界面改版方案（只改 UI，不改功能）

> 2026-09-28 · 范围：`web/`（React 前端）＋少量文案。服务端协议、会话能力、数据格式一律不动。
> 效果图：`mock-home.png` / `mock-session.png` / `mock-settings.png` / `mock-composer.png`（对应同名 `.html`，纯静态，1440×900）。
> 现状截图：`current-welcome.png` / `current-session.png` / `current-settings.png`。

## 用户确认（2026-09-28）与定案修改

用户看过四张效果图后回复「可以」。以下几点是定案，优先于正文：

1. **模型菜单保持平铺**：用户明确要 AiMaMi 那种「档案 / 模型」平铺、可搜索的列表（已实现于 `web/src/features/models/ModelMenu.tsx`、`menu.ts`）。`mock-composer.png` 里把「其它来源」做成二级菜单（`super-nb 中转 › 12 个模型`）的画法**不采用**；改为在现有平铺菜单顶部加「智能程度」分段控件与「深度编排」开关，其余（搜索、收藏、最近、每个档案一节、刷新全部、管理模型…）保持。
2. **功能一个不删**：§4.2 去向表是硬约束；每个阶段的验收都要对照它。
3. **不卸载原则**：面板 / 终端 / 编辑器只用 `hidden` / CSS 切换（CLAUDE.md 阶段 2、8 的坑）。
4. 每阶段必须通过：`npm run typecheck`、`npm test`、`npm run build:all`、`node scripts/e2e.mjs`、`node scripts/ui-smoke.cjs`（零 console 错误），并截 1440×900 亮 / 暗 + 760 宽三张图与 mock 对照。

---

## 0. 一页结论

1. **对话上方的 5 行外框（顶栏 / 分组栏 / 标签条 / 会话头 / 8 个工作台标签，约 175px）合成 1 行 52px 会话头**：标题 · 项目 · 分支，右侧只有「改动 +19 −4」、终端、右侧面板、`···` 四个按钮。
2. **分屏、标签、分组「用到才出现」**：单会话时看不见；按 Ctrl+D 分屏或开第二个标签后自动出现；设置里「显示工作台工具」一键恢复现在的全部密度。快捷键一个不改。
3. **输入框 8 个 chip 收成 4 个入口**：`+`（附件 + 会话能力）· 项目/分支 · 模型（引擎、供应商档案、模型、effort、ultracode 合一）· 权限（6 种模式用一句话讲后果）。永远一行。
4. **11 个停靠面板 + 8 个工作台标签 → 一个右侧面板（审阅 / 文件 / 终端 / 任务）+ 一个「自动化」页（定时 / 目标 / 编排）**，其余进命令面板和设置。一个都不删。
5. **侧栏像 Codex**：新对话 / 搜索 / 自动化 三个入口 + 「需要你」+ 按项目分组的对话列表；来源 / 机器 / 归档 / 多选收进一个筛选菜单；额度和设置放到底部账户行。
6. **对话渲染说人话**：一轮工具调用折成一行「已处理 1 分 42 秒 · 读了 4 个文件 · 改了 2 个 · 运行 2 条命令 ›」，回合末尾一张「改动了 2 个文件」卡片，点「审阅」开右侧 diff。权限请求停靠在输入框上方。
7. **设置 24 个平铺分区 → 5 组 14 项 + 折叠的「高级」**，全窗打开（Linear / Codex 式），每页「常用在上，更多选项折叠」。
8. **视觉只改令牌取值**：亮色改成纯白主区 + 浅灰侧栏、主按钮用墨色（Codex / ChatGPT 做法），橙色只留给品牌和焦点；默认主题从 `dark` 改成「跟随系统」。
9. 分 8 个阶段交付，每阶段独立可发，验收指标见 §8。

---

## 1. 参考调研

### 1.1 Mobbin（关键几张）

| 产品 · 界面 | 关键做法 | 我们借什么 |
| --- | --- | --- |
| [ChatGPT · Codex 首页](https://mobbin.com/screens/0ef48bf9-722a-48f6-b1b9-fe3f3d23eadf) | 一句大标题「What should we code next?」+ 输入框；仓库 / 分支 / 版本数 chip 在输入框**里面**左下；下面 Tasks / Code reviews / Archive 三个 tab；首次用户给 3 张「Start your first task」卡片 | 首页结构、项目/分支 chip 的位置、首次起手建议 |
| [ChatGPT · Codex 任务列表](https://mobbin.com/screens/3ea958c5-65ac-4b75-a9df-22946baec8af) | 每行只有：标题 / 「Just now · 仓库名」/ 右侧 `+28 −0` | 最近任务行、侧栏行的信息量上限 |
| [ChatGPT · Codex 任务详情](https://mobbin.com/screens/ee06bf6f-a0da-41c4-b491-ad03fd4d00c6) | 顶部一行：返回 · 标题 · 「日期 · 仓库 · 分支 · +28 −0」，右侧 Archive / Share / Create PR；左窄栏对话（Worked for 2m 13s → Summary → Testing → File (1) 卡片），右侧 Diff / Logs | 会话头只留一行、回合摘要、改动文件卡、右侧审阅 |
| [Cursor · Agents 首页](https://mobbin.com/screens/3e9be807-fe11-423c-a766-d73994198e72) | 侧栏只有 New Agent / Automations / Dashboard + 按日期的列表；输入框上方仓库 / 分支，里面「Codex 5.3 High」一个 chip 同时表达模型和强度 | 侧栏三个入口；模型 + 强度合成一个 chip |
| [Cursor · 模型菜单](https://mobbin.com/screens/5086a06b-e76b-49ad-a5e4-c2100759b758) | 模型名直接带强度（High / Extra High / Fast），顶部开关「Use Multiple Models」「Long-running」 | 智能程度放进模型菜单，特殊模式用开关 |
| [Cursor · 对话 + Git 审阅](https://mobbin.com/screens/c4183cfb-6761-4cbc-9b05-79d0eb1e5990) | 对话里「3 Files Changed」卡片；右侧 Setup / Secrets / Git / Desktop / Terminal 一排 tab | 右侧面板 = 少量 tab，而不是一墙图标 |
| [Claude Code（web）新对话](https://mobbin.com/screens/ae4ac3c3-864d-4eb8-874e-f5080ef7969a) | 仓库 chip + 分支 chip 贴在输入框下沿；侧栏 New session / Scheduled / 项目筛选 / Today | 同一家族的做法，用户熟悉 |
| [Claude · 首页](https://mobbin.com/screens/d72b17b4-df91-4813-8e5d-a04d20041570) | 模型 chip 写成「Sonnet 4.6 Adaptive」：模型 + 思考模式一个 chip；侧栏 Starred / Recents，行里只有标题 | chip 文案「Sonnet 5 · 深入」 |
| [Devin · 首页](https://mobbin.com/screens/60fffda0-a851-467d-8f72-1173012b320d) · [模式菜单](https://mobbin.com/screens/3563ed9d-b08f-4d5d-b8a4-9204bd55ff83) · [会话 + PR](https://mobbin.com/screens/a64ad467-233e-4ea6-af04-2fa11fe00e37) | 「Get started 5 of 6」入门清单；模式菜单每项一句话（Fast Mode：2.5x faster, 2x more expensive）；右侧 Worklog / Changes / PR | 首页入门清单；菜单项「名字 + 一句后果」 |
| [Grok · 模式菜单](https://mobbin.com/screens/5df7b658-498f-4145-b78d-0fe9d6460441) | Auto / Fast / Expert / Heavy，每个一行说明（Thinks hard / Team of Experts） | effort 的人话档位 |
| [Notion AI · 模型菜单](https://mobbin.com/screens/58188761-2d93-43a2-be51-df5fee96707a) · [输入框设置](https://mobbin.com/screens/0317bced-be59-439c-a6b9-9032b93835b4) | 「Auto」在最上，下面才是具体模型；输入框里一个开关「Can make changes」表达权限 | 权限用后果描述 |
| [Mistral Le Chat · + 菜单](https://mobbin.com/screens/0e571bd8-628d-46c6-98ea-22e4967be84b) | `+` 里：上传、Connectors、Tools（勾选开关） | 会话能力（Chrome / Computer Use…）进 `+` |
| [Higgsfield · 审批卡](https://mobbin.com/screens/b6741ae3-c1f1-4335-bb72-530bea496619) · [Cofounder · 问题卡](https://mobbin.com/screens/52d55c74-ed5e-4f4f-adbf-40715cb4bb66) | 需要用户决定时，卡片**停靠在输入框上方**：Always allow / Stop / Approve | 权限请求 / AskUserQuestion 的位置 |
| [Obvious · 折叠步骤](https://mobbin.com/screens/a31477d3-ad05-4e0c-a96a-3e4c45e4c627) · [Perplexity · 步骤行](https://mobbin.com/screens/405936f5-0954-4a8c-bcc1-28f10dc31f4c) | 「Wrapped up 2 actions ›」「Ran through 5 things ›」一行灰字，可展开 | 回合摘要行 |
| [Linear · 设置](https://mobbin.com/screens/8720abc2-c855-44ee-911d-bc15fc1707eb) · [通知渠道](https://mobbin.com/screens/915c51c8-1e36-47d7-a8e9-a2c33bcc98f2) | 全窗设置，「← Back to app」；导航按组（Issues / Projects / Features / Administration）；内容 660px 居中，分节标题 + 卡片 + 行；行尾显示状态并可钻取 | 设置页骨架 |
| [ChatGPT · 设置](https://mobbin.com/screens/396e6b9f-9eaf-4a3b-94a6-bc2a8f898331) · [Personalization](https://mobbin.com/screens/47599d93-678e-4c46-8671-e79968010205) | 8 个 tab，每页 5–7 行；页底「Advanced ▾」折叠 | 每页「更多选项」折叠 |
| [Mintlify · 命令面板](https://mobbin.com/screens/7c7ad31f-9dfe-4be7-83d7-6002fe31d4d0) · [Vapi](https://mobbin.com/screens/593d7acd-2e16-4365-bcd6-02ce52f48f3b) | 分组结果 + 底部键位提示 | 命令面板承接进阶入口 |

> Raycast 是 macOS 原生应用，Mobbin 的 web / iOS 库里搜不到，命令面板用上面两个 web 产品代替。

### 1.2 Codex 桌面 app（官方文档）

- 侧栏：New chat、Search、Scheduled、Plugins、Pull requests，下面 Pinned、按项目分组的对话（[Features](https://learn.chatgpt.com/docs/features)）。
- `+` 菜单：Files and folders、Attach Google Chrome、Goal（Set a goal to keep pursuing）、Plan mode —— **会话能力就放在 `+` 里**，和我们要做的一样（同上）。
- 审阅面板：范围切换 Unstaged / Staged / Commit / Branch / Last turn；整体、单文件、单 hunk 三级的 Stage / Revert；行内评论（[Code review](https://learn.chatgpt.com/docs/code-review?surface=app)）。
- 每个对话选 Local / Worktree / Cloud 模式；终端按对话隔离；Cmd+Option+B 开关审阅面板（[Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)、[入门指南](https://getpushtoprod.substack.com/p/complete-beginners-guide-to-openais)）。

**共性**：主区只有「对话 + 输入框」；模型 / 强度 / 模式都在输入框里用一两个 chip；「改动」是一个带数字的按钮，点开才是 diff；设置全窗、分组、短。

---

## 2. 现状诊断：新手吃力在哪

截图：`current-session.png`（会话页）、`current-welcome.png`（新会话）、`current-settings.png`（设置）。

### 2.1 入口太多、层级太深

| # | 问题 | 位置 |
| --- | --- | --- |
| 1 | 对话上面叠了 **5 行外框**（约 175px）：全局顶栏 → 分组栏 → 窗格标签条 → 会话头 → 8 个工作台标签 + 「对话/轨迹」切换。新手第一眼看不出哪一行是「我的对话」 | `features/topbar/TopBar.tsx`、`features/workbench/GroupBar.tsx`、`features/workbench/TabStrip.tsx`、`features/workbench/tiles/ChatTile.tsx`（`SessionHeader`、`WB_TABS`） |
| 2 | 顶栏一排 **10 个无文字图标**：7 个 `rail` 面板（总览、目标、编排、记忆、任务、文件改动、终端）+ 面板菜单 + 停靠开关 + 命令面板。图标是手绘抽象符号（旗子、脑、表盘），不 hover 看不懂 | `TopBar.tsx`（`PANELS.filter(p => p.rail)`）、`model/layout.ts` 的 `PANELS` |
| 3 | 默认会话页可点的「外框控件」约 **50 个**（侧栏 13、顶栏 12、分组 3、标签条 6、会话头 6、工作台标签 10、输入框 7），Codex 同类页面约 12 个 | 同上 |
| 4 | 单窗格、单标签时依然显示窗格编号「1」、分屏 / 缩放按钮、分组栏 | `TabStrip.tsx`（`pane-idx`、`splitRight/splitDown`）、`Workbench.tsx`（只有 `ui.singleWindow` 能关，且藏在设置里） |
| 5 | 同一件事有多个入口、状态也各不相同：「改动」既是工作台标签又是停靠面板；「任务」停靠面板里其实是定时任务；「配置中心」停靠面板和设置窗重复；侧栏「设置」右键又是停靠面板 | `ChatTile.tsx` `WB_TABS`、`workbench/Dock.tsx`、`features/sidebar/Sidebar.tsx`（设置行 `onContextMenu`） |
| 6 | 侧栏顶部 4 个导航 + 永远显示的键位（`Alt N` / `Ctrl K` / `Ctrl ,`）+ 来源 chip 行 + 机器 chip 行 + 筛选框 + 「选择」按钮，列表还没开始就占了半屏 | `Sidebar.tsx`（`sb-nav`、`sb-sources`、`sb-search`） |
| 7 | 侧栏底部月亮图标写着「主题 / 设置」，点了却打开命令面板 | `Sidebar.tsx` `sb-foot` |

### 2.2 输入框：开关一排，折两行

| # | 问题 | 位置 |
| --- | --- | --- |
| 8 | 首页输入框底栏 **11 个控件**：`+`、选择目录、`…`、麦克风、Claude Code、功能、默认模型、effort、ultracode、每次询问、发送 —— 1440 宽下也折成两行（见 `current-welcome.png`） | `features/composer/Composer.tsx`（`welcome ?` 分支） |
| 9 | 「引擎（agent）」「供应商档案」「模型」「effort」「ultracode」是 5 个概念、4 个控件，其实回答的是同一个问题：**用哪个脑子、想多深** | 同上 + `features/models/ModelMenu.tsx`、`workbench/EngineSwitcher.tsx` |
| 10 | 「功能」下拉里是 Chrome、Computer Use、协调者、主动模式、Brief、频道（要手填 `plugin:name@marketplace`） —— 高级能力默认暴露给所有人 | `Composer.tsx` `featOpen` 菜单 |
| 11 | 输入框上下还夹着 3 条状态：`StatusStrip` / `RunCard` / `ContextRow`，下面还有一行 `1 轮 ↑253K ↓1.8K 缓存 100%` 统计 | `Composer.tsx` 渲染顺序、`.statusbar` |

### 2.3 术语

界面上直接出现的实现词（统计 `web/src/**/*.tsx` 里的字符串字面量与 JSX 文本，含 title 提示）：`档案` 28 处、`worktree` 27、`窗格` 19、`引擎` 13、`交接` 10、`停靠` 8、`effort` 5（另有 effort chip 本身把值 `high` / `xhigh` 原样显示）、`ultracode` 5、`ACP` 5、`轨迹` 3。典型：

- `ultracode：xhigh + 动态工作流编排（会话级，不是一个 effort 等级）`（`Composer.tsx` 的 title）
- 权限模式「完全权限 / 不询问 / 自动模式」不说后果（`MODE_LABEL`，`Composer.tsx` 第 26 行）
- 首页「Claude Web 引擎 v… ·（官方 Claude Code）· 已登录 … · N 个供应商」（`workbench/Welcome.tsx` `EngineStatus`）
- 引导第 4 步教的是「工作台标签」「窗格」「停靠面板」（`features/onboarding/Onboarding.tsx`）

### 2.4 默认值与首次路径

| # | 问题 | 位置 |
| --- | --- | --- |
| 12 | 主题默认 `dark`，不跟随系统 | `settings/SettingsModal.tsx`（`ui.theme` `def="dark"`） |
| 13 | 亮色主题没有覆盖 `--green/--red/--yellow`，沿用暗色的 `#5fb381` 等，浅底上对比度约 2.4:1，`+15 −1` 这种数字看不清；辅助文字 `--fg-3 #b0aca3` 约 2.2:1 | `styles.css` `:root[data-theme='light']` |
| 14 | 引导 4 步（引擎与登录 → 工作区 → 外观 → 完成），「外观」一步对新手没价值；完成后首页没有任何「下一步」提示 | `Onboarding.tsx` |
| 15 | 设置 **24 个平铺分区**，「settings.json」「Hooks」「诊断」「CLI 工具」和「外观」同级；「界面」里混着单窗格模式和托盘；「会话」里混着 GPU 软件渲染和编排并发 | `SettingsModal.tsx` `useSections()` |
| 16 | 导出按钮用的是字符 `↗` 而不是图标，破坏了自己的图标规范 | `ChatTile.tsx` 第 106 行 |

### 2.5 视觉噪音

- 边框多：每个 chip、每个按钮、每个面板都有 1px 描边（`.chip { border: 1px solid var(--edge-default) }`），加上 `--edge-default` 是 15% 的前景色，整屏都是线。
- 强调色泛滥：橙色同时用于发送按钮、活动标签、焦点窗格外框、toggle、「默认」徽章、警告 chip —— 真正需要注意的（等确认）反而不突出。
- 亮色主题是米黄底（`#faf9f5`）+ 米黄侧栏，层级靠微弱的色差区分，和 Codex 的「纯白纸面 + 浅灰侧栏」相比显旧、显脏。

---

## 3. 设计原则

1. **一屏一个焦点。** 主区永远是「对话 + 输入框」。其它东西要么在侧栏，要么在需要时从右侧滑出，要么在命令面板里。
2. **渐进披露，不删功能。** 默认只露新手要的 20%；进阶能力收进 `+` 菜单、`···` 菜单、右侧面板、命令面板和设置的「高级」。所有快捷键原样保留，大神不需要鼠标去找。
3. **说后果，不说实现。** 界面文案回答「会发生什么」，不是「这是什么机制」。实现词只留在 tooltip 和设置的高级区。
4. **状态就地显示。** 运行、等你确认、出错、改了多少行，显示在它所属的那一行 / 那张卡上，不靠顶栏徽章和底部统计数字。
5. **安静的外观。** 少线、少色、少图标；强调色只留给「需要你」和品牌；主操作用墨色。

---

## 4. 信息架构

### 4.1 三层

| 层 | 用户看到什么 | 包含 |
| --- | --- | --- |
| **L0 默认可见** | 打开就在 | 侧栏（新对话 / 搜索 / 自动化 / 需要你 / 项目与对话 / 账户行）、会话头一行、对话、输入框四个入口 |
| **L1 一次点击** | 需要时出现 | 右侧面板（审阅 / 文件 / 终端 / 任务）、模型菜单、`+` 菜单、权限菜单、`···` 会话菜单、筛选菜单、账户弹层（额度 / 用量） |
| **L2 进阶** | 打开「显示工作台工具」或用快捷键 / 命令面板 | 分组、分屏、多标签、停靠图标栏、总览（Mission Control）、记忆面板、Android、看板、布局预设、新窗口、设置「高级」 |

### 4.2 全部功能去向表（保证一个不丢）

| 现在的入口 | 改版后 | 层 |
| --- | --- | --- |
| 侧栏「新会话」 | 侧栏「新对话」（Alt N / 桌面 Ctrl N 不变） | L0 |
| 侧栏「命令 / 搜索」 | 侧栏「搜索」（Ctrl K 打开命令面板，默认在搜对话） | L0 |
| 侧栏「设置」 | 底部账户行的齿轮（Ctrl , 不变） | L0 |
| 侧栏「用量」、停靠「用量」 | 点账户行 → 弹层（额度环明细 + 今日费用）→「用量与账本」全窗页 | L1 |
| 顶栏额度环 | 账户行里的小环 +「已用 34%」 | L0 |
| 来源 chip、机器 chip、显示归档、多选 | 侧栏「项目」标题右侧的筛选菜单（来源 / 机器 / 显示已归档 / 选择多个）；多选也支持 Ctrl/Shift 点击 | L1 |
| 「运行中」分组 | 行尾转圈（不再单独成组） | L0 |
| Mission Control「需要你」列 | 侧栏「需要你」分组（只在有待确认时出现） | L0 |
| 置顶 / 工作区 / 其它目录 / 其它机器 | 置顶 / **项目** / 其它文件夹（折叠）/ 其它电脑（按机器分组，保持现状） | L0 |
| 会话库发现横幅 | 保留，侧栏底部一张可关闭的卡片 | L0（条件） |
| 「已连接」 | 只在断线时，主区顶部一条「连接断开，正在重连…」 | L0（条件） |
| 顶栏分组名 + 「N 运行中」 | 删除（侧栏已有） | — |
| 顶栏 7 个面板图标 + 面板菜单 | 见下方停靠面板行；进阶模式下保留图标栏 | L1/L2 |
| 停靠开关 Ctrl+J | 会话头「右侧面板」按钮（快捷键不变） | L0 |
| 分组栏（分组、布局预设、新窗口） | 有 ≥2 个分组或开「显示工作台工具」时才显示；快捷键不变 | L2 |
| 标签条（窗格号、标签、+、分屏、缩放、关闭） | 窗格里 ≥2 个标签、或组里 ≥2 个窗格时才显示 | L2 |
| 会话头：目录 / 标题 / 分支 | 会话头：标题 + 灰字「项目 · 分支 · worktree 徽标」 | L0 |
| `EngineSwitcher`（换档案 / 交给其它 agent） | 换档案 → 模型菜单；交给其它 agent → `···`「交给其它 Agent 继续…」 | L1 |
| 分叉、导出 ↗、会话菜单、结束进程 | `···`：从这里分叉、导出为 HTML、重命名、置顶、归档、删除、交给其它 Agent、结束进程、在资源管理器 / VS Code 打开、步骤视图（原「轨迹」）、本对话用量 | L1 |
| 「恢复」按钮 | 输入框占位「发送即可继续这个对话」（已有逻辑），`···` 里也有 | L0 |
| 工作台标签：对话 | 默认视图 | L0 |
| 工作台标签：改动 + Git | 右侧面板「审阅」（范围：未提交 / 已暂存 / 本对话改过的文件 / 某次提交；暂存、还原、提交；分支 / 拉推 / stash / worktree 在该页 `···` 里打开完整 Git 视图） | L1 |
| 工作台标签：文件 + 搜索 | 右侧面板「文件」（顶部搜索框，切换「文件名 / 内容 / 替换」） | L1 |
| 工作台标签：定时 | 侧栏「自动化」→ 定时任务 | L1 |
| 工作台标签：产物 | 回合末「改动的文件」卡 + 右侧面板「文件」顶部「本对话生成的文件」分组 | L0/L1 |
| 工作台标签：看板 | `···`「Issue 与 PR」→ 右侧面板临时 tab | L1 |
| 停靠：总览 | 侧栏「需要你」+ 命令面板「总览」；进阶模式下仍是面板 | L0/L2 |
| 停靠：目标 | 创建：`+`「设定一个目标」或 `/goal`；进度：对话顶部一条目标条；列表：自动化页「目标」 | L1 |
| 停靠：编排 | 自动化页「编排」 | L1 |
| 停靠：任务（子代理 / 后台命令） | 右侧面板「任务」 | L1 |
| 停靠：文件改动 | 右侧面板「审阅」 | L1 |
| 停靠：终端 | 右侧面板「终端」+ 会话头终端按钮 | L1 |
| 停靠：详情（inspector） | 点工具行「详情」时右侧面板临时出现「详情」tab | L1 |
| 停靠：记忆 | 设置「共享记忆」+ 命令面板「记忆」；进阶模式面板 | L1/L2 |
| 停靠：配置中心 | 与设置合并（停靠版只在进阶模式保留） | L2 |
| 停靠：Android | 命令面板 / 进阶模式面板 | L2 |
| 输入框：Claude Code / 其它 agent 选择 | 模型菜单「其它来源」 | L1 |
| 输入框：功能（Chrome、Computer Use、协调者、主动、Brief、频道） | `+` 菜单「这次对话可以…」「进阶」 | L1 |
| 输入框：模型 / 供应商档案 | 模型菜单 | L0 chip |
| 输入框：effort | 模型菜单「智能程度」 | L1 |
| 输入框：ultracode | 模型菜单「深度编排」开关 | L1 |
| 输入框：权限 | 权限 chip（新文案） | L0 chip |
| 输入框：选择目录 / `…` | 项目 chip（最近项目 + 打开文件夹… + 「在独立副本里运行（worktree）」开关） | L0 chip |
| `ContextRow`（目录 / 分支 / worktree / agent） | 并入会话头灰字 | L0 |
| `RunCard` | 保留，贴在输入框上沿；等确认时被权限卡替代 | L0 |
| `StatusStrip`（卡住 / 失败 / 限流 / 排队） | 保留，同位置 | L0 |
| 统计栏（轮数、token、缓存、费用、上下文 %） | 上下文 ≥ 60% 时输入框右下角小环；其余进 `···`「本对话用量」 | L0（条件）/L1 |
| 消息操作（复制 / 赞 / 踩 / 分享本轮） | 悬停出现 | L1 |
| 设置 24 个分区 | 见 §5.7 映射表 | — |

---

## 5. 逐区域方案

### 5.1 侧栏（`mock-home.png` 左侧）

```
[✳ Claude Web]                 [⊟]
 ✎ 新对话                   Alt N      ← 键位灰字，hover 才加深
 ⌕ 搜索                    Ctrl K
 ◷ 自动化
需要你                                   ← 只在有待确认时出现
 ● 给 todo-api 补测试        待确认
项目                        [⚲][＋]      ← 筛选菜单 / 打开文件夹
 ▢ claude-web
    设计令牌重构                 ◌      ← 运行中：转圈
    修复模型菜单白屏         +42 −7      ← 完成：改动行数
    侧栏折叠状态会丢            2 天     ← 其它：时间
    再显示 9 个
 ▢ todo-api …
 ▢ blog                            6    ← 折叠的项目只显示数量
──────────────────────────────────
(Y) YPY  ◔ Max 套餐 · 已用 34%     [⚙]
```

- 行只有 **标题 + 一个右侧状态**（优先级：等确认 > 出错 > 运行中 > 改动行数 > 时间）。非 Claude 的 agent 用灰字「Codex」而不是图标；子任务数改成行首的展开箭头。
- 每个项目默认显示 5 条，「再显示 N 个」。折叠状态沿用 `layout.sidebar.sections`。
- 「工作区」对用户改名「项目」（数据结构、meta.json 键名不变）。
- 空状态：「还没有项目。打开一个文件夹，Claude 就在里面工作。」+ 一个主按钮。
- 宽度默认 260（现在 264），拖拽逻辑不变。

### 5.2 会话头（`mock-session.png` 顶部）

一行 52px：`标题（双击改名）` · 灰字 `▢ todo-api  ⑂ fix/complete-todo  [worktree]` ——右侧：

| 按钮 | 作用 |
| --- | --- |
| `+19 −4`（有改动才出现） | 打开右侧面板「审阅」；没有改动时不显示 |
| 终端图标 | 打开右侧面板「终端」 |
| 右侧面板图标 | 开关右侧面板（Ctrl+J） |
| `···` | 会话菜单（见 §4.2） |

侧栏收起时，最左加一个展开侧栏按钮。单会话时这就是对话上方唯一的一行；分屏后每个窗格各有一行会话头，标签条只在多标签时出现在它上面。

### 5.3 主对话区与消息渲染

- 阅读列宽 620–720px 居中；用户消息右对齐浅灰气泡（`--user-bg`），助手正文无底色，正文 14.5px / 行高 1.7。
- **回合摘要**：完成的回合把 `Steps` 时间线折成一行：`› 已处理 1 分 42 秒 · 读了 4 个文件 · 改了 2 个 · 运行 2 条命令`。点击展开成现在的时间线（三态节点不变）。**运行中的回合默认展开**，完成后自动折叠。统计来自新的纯函数 `turnSummary()`（`model/conversation.ts`），对 `__fixtures__/tools.jsonl` 回放测试。
- **改动文件卡**：回合末尾，有 Edit / Write 时出现：`改动了 2 个文件 +18 −3 [审阅]` + 每个文件一行（路径灰色前缀 + 行数）。点文件 = 右侧审阅面板定位到该文件；内联大 diff 不再默认展开（设置里可以改回）。
- **权限请求停靠在输入框上方**（`PermissionCards.tsx` 的渲染位置从消息流移到 composer 上方）：`Claude 想运行一条命令` · 命令块 · 目录；按钮 `拒绝` / `总是允许`（有 suggestions 时）/ `允许一次 ↵`（主按钮）。提示「也可以直接在下面输入，告诉 Claude 换个做法」—— 输入框此时发送 = 拒绝并附理由（现在卡片里的「拒绝理由」输入框合并进主输入框，行为不变）。AskUserQuestion / ExitPlanMode 同样停靠。消息流里在对应步骤节点显示黄色「等你确认」。
- 消息操作（复制 / 分叉 / 重跑 / 评分）悬停才出现。
- 思考块默认折叠成「思考了 12 秒 ›」。
- 目标（Goal）运行时，对话顶部一条细条：`目标：把 README 翻成英文 · 第 3 轮 · 查看`。

### 5.4 输入框（`mock-composer.png`）

```
┌──────────────────────────────────────────────────────────────┐
│ 描述一个任务，或者问个问题                                     │
│ (+) ▢ claude-web ▾  ⑂ main ▾        Sonnet 5 · 深入 ▾  ⛨ 每步询问 ▾  🎙 (↑) │
└──────────────────────────────────────────────────────────────┘
```

- **左**：`+`、项目 chip、分支 chip（后两个只在首页；会话里项目 / 分支在会话头）。
- **右**：模型 chip、权限 chip、麦克风、发送 / 停止。运行中且有输入时发送位变成「插话」+ 停止（现有逻辑）。
- chip 去掉描边，只在 hover / 打开时有底色；圆角 pill；高 30px。
- 打开的会话能力显示成输入框里可删除的小标签：`[🌐 控制浏览器 ×]`。
- 上下文 ≥ 60% 时右下角出现小环（hover 显示 `上下文 72% · 145K / 200K`）。
- 1440 / 1024 / 760 宽下都保证一行；更窄时项目 / 分支 chip 只剩图标。

**`+` 菜单**：添加文件或图片 · 添加文件夹 · 引用另一个对话 ─ 这次对话可以…：控制浏览器（Claude in Chrome）· 操控电脑（Computer Use）· 设定一个目标 › ─ 进阶：协调者模式 · 主动模式 · Brief、频道…。会话能力是**开会话时生效**的参数：在已运行的对话里，这一组显示当前状态并标「新对话时生效」。只对 Claude 显示的项目（`!foreign`）保持现在的条件。

**权限菜单**（6 种全留，映射 `MODE_LABEL`）：

| 模式 | 现文案 | 新文案 | 一句话 |
| --- | --- | --- | --- |
| `default` | 每次询问 | **每步询问**（推荐） | 改文件、运行命令之前都先问你 |
| `acceptEdits` | 自动接受编辑 | **自动改文件** | 直接改文件；运行命令之前问你 |
| `plan` | 计划模式 | **只做计划** | 先读代码、写方案，你点头后才动手 |
| `auto` | 自动模式 | **自动判断** | Claude 自己判断哪些操作需要问你 |
| `dontAsk` | 不询问 | **只做已允许的** | 不弹确认；没事先允许的操作一律跳过 |
| `bypassPermissions` | 完全权限 | **完全放开**（警示色） | 什么都不问直接执行。只在可以随便弄坏的环境里用 |

### 5.5 模型选择

一个菜单回答「用哪个脑子、想多深」（`ModelMenu.tsx` 扩展，数据仍来自 `features/models/menu.ts` + `server/src/models/catalog.ts`）：

1. 搜索框（现有）。
2. **智能程度**：分段控件，只显示当前模型支持的档位（`effortLevels()` / `supportedEffortLevels`）。文案映射：`low` 快 · `medium` 均衡 · `high` 深入 · `xhigh` 更深 · `max` 极限 · `ultra`（仅 Codex）超限。下面一句说明当前档位（「深入（默认）：复杂改动更稳，速度适中」）。tooltip 保留原值 `effort: high` 给老用户。不支持 effort 的 agent（Gemini）整段不显示。
3. **深度编排**开关（= ultracode，仅 `supportsUltracode`）：「最深思考 + 自动拆成并行子任务，更慢、更费额度」。
4. **Claude 账号**：模型行 + 右侧 catalog 的 `hint`（最强，慢、贵 / 复杂任务 / 日常编码 / 快、便宜）。收藏 / 最近保留在最上（现有 `favorite`）。
5. **其它来源**：每个供应商档案一行（`12 个模型 ›` 二级展开）、每个其它 agent 一行（Codex、Gemini CLI…，未安装 / 未登录灰字说明）。会话里选另一个 agent = 现在的「交接」，弹同样的确认。
6. 底部：`管理模型与供应商…`（跳设置）+ 刷新。

chip 文案：`模型名 · 档位`（如 `Sonnet 5 · 深入`）；非默认档案时前缀档案名：`super-nb / Opus 5 · 深入`；非 Claude agent：`Codex 5.6 Sol · 均衡`。

### 5.6 右侧面板（原停靠面板收纳）

- **一个会话一个右侧面板**，4 个固定 tab：**审阅 · 文件 · 终端 · 任务**，外加按需出现的临时 tab（详情 / Issue 与 PR / 记忆）。默认关闭；用户点「改动」按钮、文件卡、终端按钮、`···` 才打开。宽 440，可拖。
- **审阅**（合并 `FilesPanel` + `GitView` 的 status / diff 部分，见 `mock-session.png` 右侧）：范围下拉（未提交的改动 / 已暂存 / 本对话改过的文件 / 某次提交），文件级折叠 diff（上下对照 / 左右并排跟随 `ui.diffMode`），`全部还原` / `全部暂存`、单文件还原 / 在编辑器打开，底部提交说明 + `提交`。分支、拉推、stash、worktree 列表在该 tab 的 `···` → 打开完整 Git 视图（现 `GitView` 原样）。
- **文件**：`FileTree` + `SearchView`，顶部一个搜索框。
- **终端**：`TerminalPanel`，按会话目录；绝不卸载（沿用 `[hidden]` 规则）。
- **任务**：子代理、后台命令、TodoWrite 计划（`TasksPanel` 的会话部分）。定时任务移到自动化页。
- **进阶模式**：打开「显示工作台工具」后，右侧仍是现在的停靠面板 + 图标栏，11 个面板全部可钉。
- 实现上：`model/layout.ts` 的 `PANELS` 每项加 `tier: 'inspector' | 'page' | 'pro'`，`Dock.tsx` 按 tier 决定默认模式下是否出现，所有渲染分支不变（避免卸载）。

### 5.7 设置（`mock-settings.png`）

全窗打开（替换侧栏 + 主区，左上「← 返回」/ Esc 关闭），左栏分组导航 + 顶部搜索，内容 660px 居中；每页「分节标题 + 卡片 + 行」，行 = 标题 + 一句后果 + 右侧控件；页底「更多选项」折叠低频项。

| 新分组 · 分区 | 来自现在的分区 / 条目 |
| --- | --- |
| **常用 · 通用** | 会话（默认权限、额度恢复后自动继续）、界面（显示思考过程、默认 diff 视图、单窗格模式 → 反转为「显示工作台工具」、编辑器自动保存、桌面通知、托盘、退出确认）；更多选项：软件渲染、编排并发上限 |
| 常用 · 外观 | 外观（主题默认改「跟随系统」、字号、密度、中文字体、减少动画） |
| 常用 · 账号与登录 | 引擎与账号（`Overview`）：登录状态在最上；引擎版本 / ccb / 官方内核放进「更多选项」 |
| **模型 · 模型与智能程度** | 模型（`ModelsSection`） |
| 模型 · 供应商 | 供应商 / 环境 的上半段（`ProviderProfiles`） |
| 模型 · 模型网关 | 模型网关 |
| **扩展 · MCP 与插件** | MCP（`McpCatalog` + `Mcp`）+ 插件（`Plugins`），两个 tab |
| 扩展 · Skills | Skills |
| 扩展 · Agents 与子代理 | CLI Agents（`AgentsSection`）+ Claude 子代理，两个 tab |
| 扩展 · 共享记忆 | 共享记忆 |
| **连接 · 手机与其它电脑** | 远程 / 手机（含 SSH 隧道、其它机器） |
| 连接 · IM 机器人 | IM 网关 |
| **数据 · 会话库** | 会话库 |
| 数据 · 密钥 | 密钥 |
| **高级**（默认折叠） | Hooks、环境变量（`EnvEditor`，从供应商页拆出）、CLI 工具、诊断、更新（版本号同时显示在左下角）、settings.json |

- 搜索仍覆盖每一条 entry（label / hint / keywords），结果显示「分组 › 分区」面包屑；折叠的「高级」和「更多选项」也搜得到。
- `openSettings({section})` 的旧 id（`interface`、`session`、`engine`、`providers`、`mcp`、`plugins`、`agents`、`subagents`、`raw`…）通过别名表跳到新位置，外部调用点不用改。
- 左栏行尾显示状态（已登录 / 2 个供应商 / 网关 关 / 5 个 MCP），像 Linear 的「Desktop · Disabled」。

### 5.8 空状态与首次引导（`mock-home.png`）

- **首页**：大标题「今天想做点什么？」（去掉按时间的问候和衬线体）→ 输入框（项目 chip 预选上次项目）→ 4 个起手建议（讲讲这个项目的结构 / 找一个 bug 并修好 / 给最近的改动补测试 / 先出方案再动手 —— 点了只是填进输入框，不自动发送）→ 入门清单（可关闭）→「最近任务 / 定时任务 / 已归档」三个 tab 的列表（每行：标题 · 项目 · 时间 · 右侧状态或 `+42 −7`）。
- **入门清单**（`settings['onboarding.checklist']` 存进度，meta.json）：选一个项目 ✓ · 发出第一个任务 ✓ · 审阅一次改动 · 试试 Ctrl K。全部完成或点 × 后永久消失。
- **`EngineStatus` 只在有问题时出现**：未登录且没有供应商 →「还没登录 Claude。[在终端登录] 或 [添加供应商]」；引擎缺失 → 同理。正常时什么都不显示。
- **引导弹窗从 4 步减到 2 步**：① 登录（已登录直接跳过）② 选一个项目文件夹。外观跟随系统，不再单独一步；「就绪」页的快捷键说明改到入门清单里按需出现。
- 其它空状态统一句式「还没有 X。Y 之后会出现在这里。」+ 最多一个按钮（审阅面板没有改动、任务面板没有子代理、自动化页没有定时任务…）。

### 5.9 自动化 / 编排 / 会话库 / 总览

- 侧栏「自动化」→ 主区全宽页，三个 tab：**定时任务**（`SchedulesView` + 模板 + 历史）· **目标**（`GoalsPanel` 列表，点开进入对应对话）· **编排**（`OrchestraPanel`）。新建按钮在右上。
- 会话库：日常入口就是侧栏「搜索」（命令面板里搜对话，走 `sessions.search`），来源开关在筛选菜单，加入 / 移出在设置「会话库」。
- 总览：侧栏「需要你」解决 80% 的场景（有东西等你确认就出现，点一下跳到那张卡）；完整四列看板留在命令面板「总览」和进阶模式。

### 5.10 进阶模式（分屏 / 标签 / 分组）

- 新 UI 设置 `ui.workbench`（显示工作台工具），**取代** `ui.singleWindow`（取反迁移）。
- 可见性是一个纯函数 `chromeVisibility(layout, settings)`（放 `model/layout.ts`，加进 `layout.test.ts`）：
  - `groupBar = settings.workbench || groups.length > 1`
  - `tabStrip(pane) = settings.workbench || pane.tiles.length > 1 || paneCount > 1`
  - `dockRail = settings.workbench`
- 快捷键全保留：Ctrl+D 分屏后因为 `paneCount > 1`，标签条自动出现；关掉最后一个分屏又自动消失。
- 升级迁移：已有用户如果当前布局有 >1 个分组 / 窗格或停靠面板开着，首次加载时把 `ui.workbench` 设为 true，保证老用户界面不突变。

### 5.11 移动端（≤ 760px）

- 顶部一行：`☰` · 标题 · `···`（原来是顶栏 + 标签条 + 会话头 + 工作台标签 4 行，见 `docs/images/mobile.png`）。
- 输入框只留 `+` · 模型 chip · 发送；权限在模型 chip 旁变成图标；项目 / 分支在会话头。
- 右侧面板变成底部抽屉（审阅 / 文件 / 终端 / 任务），从 `···` 或「改动」按钮打开。
- 权限卡全宽、固定在输入框上方；按钮一行放不下时「允许一次」独占一行。
- 侧栏抽屉内容与桌面一致；统计栏、标签条、分组栏在手机上永远不显示。

### 5.12 术语表（新建 `web/src/ui/terms.ts`，一处定义，全局引用）

| 实现词 | 界面用词 | 备注 |
| --- | --- | --- |
| 会话 session | 对话 | 代码、协议、meta.json 不改 |
| 工作区 workspace | 项目 | |
| tile / 标签 | 标签页 | 进阶模式才出现 |
| pane / 窗格 | 分屏 | 进阶模式才出现 |
| dock / 停靠面板 | 右侧面板 | |
| effort | 智能程度（快 / 均衡 / 深入 / 更深 / 极限 / 超限） | tooltip 保留原值 |
| ultracode | 深度编排 | tooltip 保留原词 |
| 供应商档案 provider profile | 供应商 | |
| 引擎 / ccb / 官方二进制 | 不出现；设置「账号与登录 › 更多选项」叫「运行内核」 | |
| CLI Agents / ACP | 其它 Agent；ACP 只出现在「添加自定义 Agent」表单 | |
| 交接 handoff | 交给其它 Agent 继续 | |
| 轨迹 trajectory | 步骤视图 | |
| 产物 artifacts | 生成的文件 | |
| worktree | 独立副本（worktree） | |
| 插话 steer | 立即插话 | |
| 权限模式 | 见 §5.4 表 | |

---

## 6. 视觉规范

原则：**只改 `styles.css` 里的主题原色和少数派生比例 + 组件结构**，不新增第二套令牌体系。

### 6.1 亮色主题原色（`:root[data-theme='light']`）

| 令牌 | 现在 | 改为 | 说明 |
| --- | --- | --- | --- |
| `--bg`（= `--surface-0`，主区） | `#faf9f5` | `#ffffff` | 纸面白 |
| `--bg-1`（侧栏 / 卡片底） | `#f4f2ec` | `#f8f8f7` | 中性浅灰，去掉米黄 |
| `--bg-2`（inset / hover） | `#ecebe4` | `#f1f1ef` | |
| `--bg-3`（禁用 / 头像） | `#e1dfd6` | `#e7e7e4` | |
| `--bg-elev` | `#fffefb` | `#ffffff` | |
| `--fg`（`--ink-1`） | `#1f1e1b` | `#1b1b1a` | |
| `--fg-1`（`--ink-2`） | `#4d4a44` | `#474744` | |
| `--fg-2`（`--ink-3`） | `#85817a` | `#6b6b66` | 次要文字，白底 5.4:1 |
| `--fg-3`（`--ink-4`） | `#b0aca3`（白底 2.2:1） | `#8e8e88` | 占位 / 时间 / 键位，白底 3.3:1 |
| `--user-bg` | `#efece3` | `#f2f2f0` | |
| `--green` | 未覆盖（沿用暗色 `#5fb381`，2.4:1） | `#187a42` | 白底 5.4:1 |
| `--red` | 未覆盖（`#e0655c`） | `#cf4439` | 白底 4.6:1 |
| `--yellow` | 未覆盖（`#d9a441`） | `#9a6412` | 「需要你」专用，白底 5.0:1 |
| `--blue` | 未覆盖（`#6ea3f0`） | `#2f6feb` | |
| `--accent` | `#d97757` | 不变 | 角色收窄：品牌标、焦点环、选中指示 |
| **新增** `--primary` / `--primary-fg` | — | `var(--fg)` / `#ffffff` | 主按钮、发送、开关「开」 |

### 6.2 暗色主题（`:root` 默认块）

`--bg #1a1a19` · `--bg-1 #151514`（侧栏更深，和主区拉开）· `--bg-2 #232322` · `--bg-3 #2e2e2c` · `--fg #ececea` · `--fg-1 #b9b9b4` · `--fg-2 #8a8a84` · `--fg-3 #5f5f5a` · `--user-bg #262625` · `--primary #ececea` / `--primary-fg #1a1a19`；状态色保持现值。其它主题（dracula / nord / tokyo-night / paper）只需补 `--primary`，缺省回退 `var(--accent)`。

### 6.3 派生层（所有主题共用，`derived` 块）

| 令牌 | 现在 | 改为 | 理由 |
| --- | --- | --- | --- |
| `--edge-subtle` | fg 8% | fg 7% | 少线 |
| `--edge-default` | fg 15% | fg 12% | |
| `--layer-hover` | fg 7% | fg 5% | hover 更轻 |
| `--layer-selected` | fg 13% | fg 8% | 选中行不再像按下 |
| `--r-md / lg / xl / 2xl` | 6 / 8 / 10 / 14 | 8 / 10 / 14 / 22 | 输入框 22、卡片 14、按钮 8、chip pill |
| `--fs-base / --fs-body` | 13 / 14 | 13.5 / 14.5 | 对话行高 `1.55 → 1.7` |
| **新增** `--sp-1…8` | — | 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 | 统一间距，替换散落的 px |
| `--font` | Inter, -apple-system, Segoe UI, PingFang SC, Microsoft YaHei… | Inter, **Segoe UI Variable Text**, Segoe UI, PingFang SC, **Microsoft YaHei UI**, Microsoft YaHei… | Windows 11 上拉丁字母更清晰 |
| 首页问候 | `--serif` 32px | 无衬线 30px / 400 | Codex 式 |

### 6.4 组件密度规则

- **尺寸**：会话头 / 侧栏顶 52px；侧栏导航行 34、对话行 32；chip 30；按钮 30（小号 26）；图标 16（chip 内 15）。
- **图标密度**：会话头右侧 ≤ 4 个；列表行右侧 ≤ 1 个状态符号；图标一律 `Icon`，禁止字符图标（`↗`、`…`、`⚡`）。
- **描边**：chip、ghost 按钮无描边；卡片、输入框、次按钮用 `--edge-default`；分隔线用 `--edge-subtle`。
- **颜色语义**：黄色只给「需要你」；红色只给出错 / 删除 / 完全放开；绿 / 红数字只给 diff；橙色不再用于按钮。
- **动效**：沿用 `--dur-*`；右侧面板滑入 `--dur-3`；回合折叠 `--dur-2`。

---

## 7. 分阶段实施（每阶段独立可发）

| 阶段 | 内容 | 主要改动文件 | 验收 |
| --- | --- | --- | --- |
| **0 令牌与文案**（1–2 天） | 亮 / 暗原色、`--primary`、圆角、`--sp-*`、字体栈；默认主题 → 跟随系统；新建 `ui/terms.ts`，替换 `MODE_LABEL`、effort / ultracode 文案；`↗` 换图标 | `web/src/styles.css`、`features/settings/SettingsModal.tsx`（`ui.theme` 默认值）、`features/settings/ui-settings.ts`、`web/src/ui/terms.ts`（新）、`features/composer/Composer.tsx`、`features/workbench/tiles/ChatTile.tsx` | 6 个主题截图无错位；亮色正文 / 次要文字 / diff 数字对比度 AA；`npm run typecheck`、`npm test -w web` 通过 |
| **1 外框按需出现 + 会话头合一**（3–4 天） | `chromeVisibility()`；`GroupBar` / `TabStrip` 条件渲染；`TopBar` 退役（额度移走、图标栏只在进阶模式）；`SessionHeader` 改一行，`WB_TABS` 删除；`ui.singleWindow` → `ui.workbench` 迁移 | `model/layout.ts`（+ `layout.test.ts`）、`features/workbench/Workbench.tsx`、`TopBar.tsx`、`GroupBar.tsx`、`TabStrip.tsx`、`Pane.tsx`、`tiles/ChatTile.tsx`、`app/App.tsx`、`workbench/commands.ts`、`workbench/shortcuts.ts` | 单会话时对话上方只有 1 行（≤ 52px）；Ctrl+D 后标签条自动出现、关掉后消失；`shortcuts.test.ts` 全部通过；旧 `cw.layout.v2:*` 存档可加载 |
| **2 右侧面板**（3–4 天） | `Dock` 默认模式只显示 审阅 / 文件 / 终端 / 任务 + 临时 tab；`ReviewView`（`FilesPanel` + `GitView` status/diff/commit）；`FilesView`（`FileTree` + `SearchView`）；`PANELS.tier` | `workbench/Dock.tsx`、`workbench/GitView.tsx`、`panels/FilesPanel.tsx`、`workbench/FileTree.tsx`、`workbench/SearchView.tsx`、`panels/TasksPanel.tsx`、`panels/TerminalPanel.tsx`、`model/layout.ts` | 对照 §4.2，原 8 个工作台标签 + 11 个停靠面板每项 ≤ 2 次点击可达（`PANELS` 每项必须有 `tier`，单测断言）；切 tab 不卸载终端（xterm 缓冲保留） |
| **3 输入框 + 模型 / 权限菜单**（3–4 天） | 拆 `Composer`：`ComposerBar` / `PlusMenu` / `PermissionChip` / `ProjectChip`（工作区里刚出现了 `features/composer/DirPicker.tsx`，合入后直接复用）；模型菜单加「智能程度」「深度编排」「其它来源」；`RunCard` 贴输入框上沿；统计栏移入 `···` | `features/composer/*`、`features/models/ModelMenu.tsx`、`features/models/menu.ts`（+ `menu.test.ts`）、`features/chat/RunCard.tsx`、`features/chat/StatusStrip.tsx` | 1440 / 1024 / 760 宽下输入框控件一行不折行；原「功能」6 项、agent 选择、档案、effort、ultracode 全部可达；effort 文案映射有单测 |
| **4 侧栏**（2–3 天） | 三个导航 + 「需要你」+ 项目分组 + 行尾单状态；筛选菜单（来源 / 机器 / 归档 / 多选）；账户行（额度环 + 设置） | `features/sidebar/Sidebar.tsx`、`sidebar/filter.ts`（+ `filter.test.ts`）、`sidebar/session-actions.tsx`、`sidebar/caps.ts`、`topbar/TopBar.tsx`（`UsageRings` 移出） | 默认侧栏无 chip 行；等确认 / 出错 / 运行中都在行尾；`filter.test.ts`、`caps.test.ts` 通过 |
| **5 对话渲染**（3 天） | `turnSummary()` 纯函数；回合折叠；改动文件卡；权限 / 提问卡停靠到输入框上方；消息操作 hover | `model/conversation.ts`（+ `conversation.test.ts` 回放 `tools.jsonl`）、`features/chat/ChatView.tsx`、`ToolCard.tsx`、`PermissionCards.tsx`、`MessageActions.tsx` | 摘要数字与 fixture 一致；运行中回合展开、完成后折叠；`applyTranscript(..., {live})` 行为不变；权限允许 / 拒绝 / 总是允许三条路径手测通过 |
| **6 设置重组**（2–3 天） | `Section` 加 `group` / `advanced`；全窗布局；合并 MCP + 插件、Agents + 子代理；旧 section id 别名；每页「更多选项」 | `features/settings/SettingsModal.tsx`、`settings/*Section.tsx`、`panels/ConfigPanel.tsx`（拆出 `EnvEditor`） | 可见一级分区 ≤ 15；单测：旧版全部 entry id ⊆ 新 sections，旧 section id 都能被 `openSettings` 解析 |
| **7 首页 / 引导 / 自动化页 / 移动端**（3 天） | 新首页；入门清单；引导 2 步；`AutomationPage`（定时 + 目标 + 编排）；手机布局 | `workbench/Welcome.tsx`、`onboarding/Onboarding.tsx`、`features/automation/AutomationPage.tsx`（新，复用 `SchedulesView` / `GoalsPanel` / `OrchestraPanel`）、`app/App.tsx`、`styles.css` 移动端段 | 临时 `HOME` + `CLAUDE_WEB_DIR` 冷启动：打开 → 发出第一条消息 ≤ 3 步；手机宽度下对话上方 chrome ≤ 1 行 |

每阶段都用 `scripts/shot.cjs` 截 1440×900 亮 / 暗、760 宽三张图，与 `redesign/mock-*.png` 并排比对后再合并。

---

## 8. 验收标准（整体）

**量化指标**

| 指标 | 现在 | 目标 |
| --- | --- | --- |
| 对话上方外框行数 / 高度 | 5 行 / ≈175px | 1 行 / 52px |
| 默认会话页可点外框控件（不含列表行） | ≈ 50 | ≤ 16（效果图为 15） |
| 首页输入框底栏控件 | 11 个，折两行 | 7 个（其中 chip 4 个），一行 |
| 设置一级分区 | 24 个平铺 | 14 个分 5 组 + 折叠「高级」 |
| 默认界面可见的实现词（effort / ultracode / 窗格 / 停靠 / 引擎 / ACP / 档案） | 多处 | 0（tooltip 与设置高级区除外） |
| 亮色主题文字对比度 | diff 数字 ≈ 2.4:1，辅助文字 ≈ 2.2:1 | 正文 ≥ 7:1，次要与状态色 ≥ 4.5:1，辅助 ≥ 3:1 |

**可用性测试**（5 名没用过的人，不给说明）：① 在某个项目里让 Claude 改一个文件；② 看它改了什么；③ 允许它运行一条命令；④ 换一个更快的模型；⑤ 停止运行；⑥ 切到深色主题。每项 ≤ 2 次点击完成、成功率 ≥ 80%、不出现「这是什么意思」的提问。

**专家回归**：`shortcuts.ts` 里每个快捷键行为不变（`shortcuts.test.ts`）；`npm run e2e`（phase 3/4/5/6/11/12，走 WS 不依赖 DOM）全绿；打开「显示工作台工具」后界面能力与改版前一致（分组 / 分屏 / 11 个面板 / 布局预设 / 多窗口）。

---

## 9. 风险与兼容

- **老用户肌肉记忆**：§5.10 的迁移规则保证已经在用分屏 / 分组 / 停靠面板的人升级后界面不变；更新说明里放一张「东西去哪了」对照图（§4.2 精简版）。
- **不卸载原则**：右侧面板、终端、编辑器仍然只用 `hidden` / CSS 切换，沿用 `PaneLayer` / `Dock` 的规矩；可见性函数只决定「外框」是否渲染，不决定内容是否挂载。
- **权限卡换位置**：卡片从消息流移到输入框上方后，多条并发请求要排队显示（一次一张，右上角「还有 2 条」），Mission Control / IM 网关的响应路径不变。
- **会话能力只在开会话时生效**：`+` 菜单在运行中的对话里要明确标注「新对话时生效」，避免用户以为开关失灵。
- **文案改名**：`terms.ts` 一处定义；协议、meta.json 键、命令 id、快捷键 id 全部不改，避免 IM 命令（`/mode` 等）和脚本受影响。

---

## 10. 附：文件清单

- `proposal.md` —— 本文
- `mock-home.html` / `.png` —— 首页 / 新对话（侧栏、输入框、起手建议、入门清单、最近任务）
- `mock-session.html` / `.png` —— 对话进行中（会话头、回合摘要、改动文件卡、运行中步骤、停靠的权限卡、模型 chip、右侧审阅面板）
- `mock-settings.html` / `.png` —— 重组后的设置（分组导航、通用页）
- `mock-composer.html` / `.png` —— 输入框改前 / 改后对比 + 模型菜单、`+` 菜单、权限菜单
- `current-welcome.png` / `current-session.png` / `current-settings.png` —— 现状截图（对照用）
