# 04 · 开源与非主流 agent UI 调研（给 claude-web 改版用）

调研日期：2026-10-10。方法：WebSearch / WebFetch 读官网与文档；`raw.githubusercontent.com` 直接读源码里的 CSS 变量、keyframes、组件 className；能取到的产品截图逐张看过。
标注：**[V]** = 已核实（后面给 URL 或文件路径）；**[I]** = 推断（没有一手证据，或只看了截图 / 只看了 CSS 没看到运行效果）。

没有运行任何安装包，没有登录任何账号。截图都是静态图，**动效的“观感”一律是从源码数值推出来的，不是亲眼看到的**（下文凡描述动画过程处，数值是 [V]，观感是 [I]）。

---

## 一、crow5 是什么

**结论：就是字面上的 “Crow5”——一款国产桌面 AI 编程 / 办公 agent 客户端（crow5.com），不是语音识别错的 Crush / Craft / CrewAI。而且它的桌面端几乎可以确定是 opencode 桌面版的换皮分支。**

证据：

- **[V]** 官网 https://www.crow5.com/ 标题「Crow5 — 做软件有想法就够了」，自称 NZSK 逆转时空集团的 AGI 品牌，页脚运营主体成都奈特麦格科技有限公司；提供 macOS / Windows / Linux(DEB) 安装包（当前 v1.3.25），内测邀请码制。卖点：多 Agent 协同、500+ Skills、200+ 模型、Build / Plan 两种模式、「代码时光机」本地快照。
- **[V]** 安装包文件名 `Crow5_1.3.25_x64-setup.exe` / `_universal.dmg` / `_amd64.deb`（同页下载链接）。**[I]** 这是 Tauri 打包器的命名格式；opencode 桌面版早期是 Tauri 壳（现在 dev 分支的 `packages/desktop/README.md` 写的是 “built with Electron”，[V]），Crow5 多半是从 Tauri 时期分出去的。这一条只是旁证，主要证据是下面两条。
- **[V]** 官网截图 `assets/img/skills-panel.jpg` 里的设置弹窗左栏是「桌面：通用 / 快捷按钮 / 快捷键；服务器：状态 / 连接服务 / 技能 / 提供商 / 模型」，输入框占位符是「随便问点什么...」。opencode 的中文语言包 `packages/app/src/i18n/zh.ts` 里逐字相同：`"settings.section.desktop": "桌面"`、`"settings.section.server": "服务器"`、`"settings.tab.general": "通用"`、`"settings.tab.shortcuts": "快捷键"`、`"settings.providers.title": "提供商"`、`"settings.models.title": "模型"`、`"prompt.placeholder.simple": "随便问点什么..."`（https://github.com/anomalyco/opencode/blob/dev/packages/app/src/i18n/zh.ts ）。
- **[V]** 截图里消息底部的落款「Build · gpt-5.4 · 59秒」、输入框下的「Plan ▾ / 模型 ▾ / 默认 ▾ / 盾牌」一排 chip、右侧「0 更改 | 所有文件」两个 tab，都是 opencode 桌面版的结构（agent = Build / Plan，variant = 默认）。
- **[V]** Skills 面板里列的 `guard / setup-deploy / browse / cso / office-hours / qa / design-consultation / design-review` 是 gstack（Garry Tan 的 Claude Code skill 包）的技能名；第三方仓库 `TheQin0630/Agent-Flow` 的 `docs/crow5_skills_workflow.md` 也把「Crow5 的 4 套核心技能 qa / qa-only / browse / office-hours」当引用对象。
- 排除项：`kh0pper/crow`（自托管 MCP 平台，24 star）、YC 的 Crow（usecrow.ai，嵌入式 copilot）、`Lijianpeng-Arch/crow5`（一个“由 Crow5 多 Agent 协同构建”的数字人 demo，1 star）都不是界面范例。

所以老板点名的参照物 = **opencode 桌面版的骨架 + Crow5 自己加的三样东西**。真正值得看的是这三样（截图逐张看过，下面是所见 [V]，行为是 [I]）：

1. **首页是“应用启动台”而不是空输入框**（`assets/img/desktop-welcome.png`）。居中一句大标题「让对话代替操作，Crow5帮你轻松驾驭各类AI Agent」+ 一行灰字副标题，下面按「创作 / 知识 / 办公 / 开发」四组排开 iOS 风格的渐变圆角方块图标（约 76px、圆角约 18px、每个一种渐变色 + 白色线性图标，下面一行 12px 标签）：绘画 / 写作 / PPT / 海报 / 封面生成 / 视频 / 音乐；知识库 / 问答 / 总结 / 课程学习 / 翻译 / 论文助手；笔记 / 文件 / 表格 / 会议纪要 / 邮件助手 / 审合同 / 财务助手 / AI 秘书 / OCR / 爬取分析 / AI 项目管理 / 日程；做方案 / 做产品 / Code / 部署上线。组标题是「▍-- 创作 --」这种带竖条的小字。
2. **最左一条 72px 的项目栏**：每个项目是一个彩色字母方块（圆角约 8px，底色和字母色成对：黄绿 M、蓝 C、紫 N、品红 L…），当前项目外面一圈白色描边；栏底是一列功能图标（应用宫格 / 运行 / 调试 / Git / 数据库 / 终端 / 设置 / 帮助）。第二列才是「项目名 + 路径 + 新建任务 + 会话列表」，运行中的会话行首是一个点阵 spinner，其余是一条短横。这两列是 opencode 原有的。
3. **「多 Agent 协同指挥台」**（`assets/img/multi-agent-mode.png`）——Crow5 最原创的界面。标题栏右上角「MULTI-AGENT」+ 5 个圆形 agent 开关；右侧浮出一张面板：
   - 顶部状态行「● 正在拆解任务与分工」+ 一个总开关；
   - 主 Agent 卡「莱因哈特 [总控]」，右上角绿色在线点，一句话状态「已完成任务拆解，正在组织执行」，下面嵌一个任务框「拆解目标并制定协同分工 — done · low」（右侧是状态 · 强度）；
   - 子 Agent 卡沿一条竖线挂在主卡下面，像树：「艾米莉亚 [质量与验收] · 正在向主 Agent 汇报 · review · medium」「蕾姆 [主线研发] · doing · low」；
   - 「待召唤区」是一个 2 列网格的“板凳席”：马里奥 [并行实现]、春丽 [架构支援]、绫波丽 [排障与性能]、赵云 [集成与交付]、春日… [界面与交互]，每张卡 = 像素风头像 + 琥珀色描边的角色标签 + 两行职责说明；右上角提示「未召唤子 Agent · 点将台」；
   - 对话区里每个子 agent 的发言是一段带头的块「Emilia（艾米莉亚）智能体 · 测试与验收」，头下面一排紫色 chip「已启用技能 · 本轮未调用：QA 测试修复 / QA 仅报告 / 浏览器验证」；
   - 输入框发送键左边并排两个小头像 = 这一轮点了哪些 agent。
   - v1.3.25 更新日志：多 Agent 协同只在 Build 模式可用，Plan 模式只留主 Agent 规划 [V]。
4. 另外：输入框上方右侧悬一个胶囊按钮「→ Auto Drive：智能分析中」（`multi-agent-ide.png`）；Plan chip 是琥珀色底，Build chip 是中性色带 ∞ 图标——**模式用颜色区分**。

对 claude-web 的含义：Crow5 的视觉本身不比 opencode 好（深灰底 + 细描边，同样偏“方”），老板看中的多半是 **①启动台式首页的“有东西可点”、②彩色项目方块带来的辨识度、③把多 agent 画成“有角色、有状态的人”**。这三点都在第四节的点子里。

---

## 二、产品逐个看

### A. 编码 agent 的桌面 GUI

#### A1. opencode 桌面版 / Web（anomalyco/opencode，MIT，21 万 star）——动效细节最考究，Crow5 的母体

技术 [V `packages/ui/package.json`]：SolidJS + `@kobalte/core` 无头组件 + `motion` + `shiki` + `@pierre/diffs`；组件样式主要是手写 CSS（`data-component` / `data-slot` 选择器，一个组件一个 .css），Tailwind 只当工具类用。桌面壳现在是 Electron。

**布局** [V 截图 + i18n]：项目栏（字母方块）→ 会话列表 → 对话 → 右侧三个 tab「Session / Review / Context」。Review 的范围有四档：`Session changes / Git changes / Branch changes / Last turn changes`，Unified / Split 切换，`Expand all / Collapse all`，超大 diff 显示「Diff too large to render · Limit: N changed lines」+「Render anyway」，选中行会生成「lines 12-18」的引用（https://github.com/anomalyco/opencode/blob/dev/packages/ui/src/i18n/en.ts ）。

**视觉语言** [V] `packages/ui/src/styles/theme.css`：
- 字体：`--font-family-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`；等宽 `ui-monospace, SFMono-Regular, Menlo…`（仓库里另带 `Inter.ttf` 和 `JetBrainsMonoNerdFontMono-Regular.woff2`，供设置里选）。
- 字号只有四档：13 / 14 / 16 / 20px；行高 130% / 150% / 180%；`--letter-spacing-tight: -0.16px`、`tightest: -0.32px`；字重只用 400 / 500。
- 圆角偏小：`--radius-xs 2px / sm 4px / md 6px / lg 8px / xl 10px`。
- **描边全部用 box-shadow 画**：`--shadow-xs-border: 0 0 0 1px var(--border-base), 0 1px 2px -1px rgba(19,16,16,.04), 0 1px 2px 0 rgba(19,16,16,.06), 0 1px 3px 0 rgba(19,16,16,.08)`；选中态 `--shadow-xs-border-select` 是「3px 淡蓝晕 + 1px 实蓝线 + 三层投影」；浮层 `--shadow-lg-border-base` 是 1px 线 + 五层由近到远的投影（36px/80px 到 1.2px/2.7px）。
- 颜色：表面全是带透明度的黑（`--surface-base: rgba(0,0,0,.031)`、hover `.059`），品牌色是一种黄绿 `--surface-brand-base: #dcde8d`；`light-dark()` 写阴影。
- 图标：自绘一套（`components/icon.tsx`）；文件类型图标是一整套 svg（`assets/icons/file-types/*.svg`，带 `_light` 变体，[I] 看命名是 Material Icon Theme）。

**最值得抄的是它的“状态文字动效系统”**，每个都是独立小组件，数值如下 [V]：

| 组件 | 触发 | 过程 | 结束态 | 源码 |
| --- | --- | --- | --- | --- |
| `TextShimmer` | `active=true`（工具在跑 / 在思考） | 文字叠两层：底层正常色；上层 `color: transparent` + `background-clip: text`，背景是「90° 线性渐变高光（中心 `--text-strong`，两侧各 5.2ch 渐隐）+ 一层 `--text-weak` 实底」，`background-size: 360% 100%`，`background-position` 从 100% 扫到 0%，**1200ms linear infinite**；多段文字用 `--text-shimmer-index × 45ms` 的负延迟错相 | `active=false` 时上层先用 **220ms ease-out** 淡出，220ms 后才停动画（不会突然“定格”） | `packages/ui/src/components/text-shimmer.{css,tsx}` |
| `TextReveal` | 一个标签的文字换了（“Exploring” → “Making edits”） | 新旧两个 span 叠在同一格。新字从上方落下（`translateY(-travel) → 0`），旧字向下离开；**不是整体淡入淡出，而是用 mask 擦除**：`mask-image: linear-gradient(to top, white 33%, transparent calc(33% + 17%))`、`mask-size: 100% 300%`，`mask-position` 从 `0 0%` 走到 `0 100%`；**450ms**，曲线 `cubic-bezier(0.34, 1.08, 0.64, 1)`（略过冲）；容器宽度同时用 450ms `cubic-bezier(0.34,1,0.64,1)` 过渡 | 新字就位，容器宽度贴合新字 | `text-reveal.css` |
| `ToolStatusTitle` | 一步从“进行中”变“完成”（Exploring → Explored） | 进行态 / 完成态两个标签同格交叉：opacity 240ms、`filter: blur(0.9px)`（2px×0.45）192ms、`translateY(0.03em)` 192ms，全 ease-out；宽度 480ms `cubic-bezier(0.22, 1, 0.36, 1)` | 完成态文字变 `--text-strong`（比进行态更深）| `packages/session-ui/src/components/tool-status-title.css` |
| `ToolCountSummary` | 折叠摘要里多了一类计数（“3 reads” 后面冒出 “, 2 searches”） | 新项用 `grid-template-columns: 0fr → 1fr` 把自己“挤”出来（480ms 同上曲线），同时 opacity 280ms、`blur(2px) → 0` 320ms、`scale(.985) → 1`、`translateY(.06em) → 0`；分隔逗号单独从 `max-width:0; translateX(-.08em)` 展开 | 一行里自然排开，旁边的字被平滑推走，不跳 | `tool-count-summary.css` |
| `AnimatedNumber` | 数字变了 | 每一位是一条 0–9 的竖条，`transform: translateY(-N em)` 滚到目标位，**560ms `cubic-bezier(0.22,1,0.36,1)`**；每位上下各 18% 用 mask 渐隐（像里程表窗口）；位数变化时容器宽度同曲线过渡；`font-variant-numeric: tabular-nums` | 新数字 | `animated-number.css` |
| `Spinner` | 运行中 | 不是转圈：15×15 viewBox 里 4×4 个 3×3 圆角方点（`rx=1`），四角隐藏，外圈 8 个在 0.15↔0.35 之间呼吸，中间 4 个在 0.4↔1 之间呼吸；**每个点的周期是 1–2s 的随机值、延迟是 0–1.5s 的随机值**，所以像一小块在闪的像素 | — | `spinner.tsx` + `styles/animations.css` |
| 新会话欢迎语 | 挂载 | `.fade-up-text`：每行 `translateY(5px) → 0` + 淡入，**0.4s ease-out**，第 n 个子元素延迟 n×0.1s | — | `animations.css` |

配套的**状态词表** [V]（`en.ts`）：`Thinking` / `Thinking - {{topic}}` / `Gathering thoughts` / `Considering next steps` / `Planning next steps` / `Exploring → Explored` / `Searching the codebase` / `Searching the web` / `Making edits` / `Running commands` / `Delegating work`；重试行 `retrying in {{seconds}}s - attempt #{{attempt}}`；回合尾部 `{{count}} Changed files` + `Show more changes (N)`；步骤开关 `Show steps / Hide steps`。——**它不显示工具名，显示“正在干什么”的人话，而且人话切换时有专门的换字动画**。

**滚动跟随规则** [V] `packages/ui/src/hooks/create-auto-scroll.tsx`：
- 距底 < 10px 算“在底部”（`bottomThreshold ?? 10`）。
- 只有**向上**的滚轮（`deltaY < 0`）才取消跟随；并且滚轮落在带 `data-scrollable` 的嵌套滚动区（工具输出、代码块）里时**不算**离开底部。
- 自己调 `scrollTo` 后 1500ms 内、位置差 < 2px 的 scroll 事件认作“自己滚的”，不当成用户操作（解决“内容还在长，scroll 事件晚到，被误判成用户上滚”）。
- 跟随时用 `scrollTop = scrollHeight` 直接赋值，**不用 smooth**（注释：避免内容还在长时出现“追赶”动画）。

#### A2. Craft Agents（craft-ai-agents/craft-agents-oss，Apache-2.0，7.2k star）——“把会话当邮件收件箱”，视觉最不“方”

**布局** [V 截图 https://github.com/user-attachments/assets/3f1f2fe8-7cf6-4487-99ff-76f6c8c0a3fb ]：三栏，像邮件客户端。
- 左栏导航：New Chat 按钮（白底浮起）；All Chats 下面是**状态**子项——Backlog / Todo / Needs Review / Done / Cancelled / Someday（每个一个小图标：虚线圈、空心圈、小人、紫色实心勾、灰叉、火箭），再下面 Flagged（橙旗）；然后 Sources / Skills / Settings；左下角工作区切换。
- 中栏会话列表：标题就是当前状态名（“Done”），按日期分组（“JAN 16” 小号大写字）；每行 = 状态图标 + 两行标题 + 一个权限模式小徽标（“Auto”，紫色淡底）+ 相对时间；选中行是带 1px 环形阴影的圆角卡。
- 右栏对话：三栏其实是**三块浮在浅灰底上的白色圆角面板**（面板之间露出底色，面板自己靠 ring-shadow 立起来）。用户消息右对齐、浅灰圆角气泡；助手回合折成一行「› [115] Research Claude Agent SDK docs · 9 errors」（步数徽标 + 最后一步的描述 + 错误数）；计划是一张带绿色表头条的卡（“Plan”）；输入框上方左侧单独悬一个权限模式 chip（“Auto ▾”），输入框是一张大圆角卡：左下角 回形针 / 数据源 / 工作目录 chip，右下角 模型 ▾ + 圆形发送键。
- README [V]：会话状态流 `Todo → In Progress → Needs Review → Done` 可自定义；`SHIFT+TAB` 循环三种权限模式（Explore 只读 / Ask to Edit / Auto）；`Cmd+1/2/3` 聚焦 侧栏 / 列表 / 对话；一个回合的全部文件改动在“VS Code 风格的多文件 diff 窗口”里看；`craftagents://` 深链。

**视觉语言** [V] `apps/electron/src/renderer/index.css`、`apps/electron/resources/docs/themes.md`：
- **6 原色主题**：只定义 `background / foreground / accent / info / success / destructive`，其余全派生。亮色 `--background: oklch(0.98 0.003 265)`、`--foreground: oklch(0.185 0.01 270)`、`--accent: oklch(0.62 0.13 293)`（紫）、`--info: oklch(0.75 0.16 70)`（琥珀）、`--success: oklch(0.55 0.17 145)`、`--destructive: oklch(0.58 0.24 28)`；暗色 `--background: oklch(0.145 0.015 270)`、`--foreground: oklch(0.95 0.01 270)`。
- 派生：`--foreground-1.5 … -95` 一整条 `color-mix(in srgb, var(--foreground) N%, var(--background))` 灰阶；`--border: oklch(from var(--foreground) l c h / 0.05)`、`--input: … / 0.1`、`--ring: … / 0.25`；状态文字色 `color-mix(in oklab, var(--success) 50%, var(--foreground))`（“往前景色拉一半”，保证可读）。
- **颜色带语义**：紫 = 品牌 + Auto 模式；琥珀 = 警告 + Ask 模式；绿 = 已连接 / 勾。
- **阴影当描边**：`--shadow-minimal: rgba(fg,0.06) 0 0 0 1px, rgba(0,0,0,.06) 0 1px 1px -0.5px, rgba(0,0,0,.06) 0 3px 3px -1.5px`；`.shadow-strong` 再加 6/12/24px 三层；暗色把 `--shadow-border-opacity` 从 0.08 提到 0.15、blur 从 0.06 提到 0.12。
- **聚焦面板的渐变描边**：`.shadow-panel-focused::before` 用 `padding:1px` + mask-composite 画一圈 1px 线，`linear-gradient(to bottom, rgba(fg,0.1), rgba(fg,0.3))`——上浅下深，像有顶光；没聚焦的面板文字降到 `--foreground-dimmed`（80%）、用户气泡从 5% 降到 3%。
- 字体：`system-ui…`，等宽 `JetBrains Mono`；`--font-size-base: 15px`（比常见的 13–14 大）。
- 每个工作区可以有自己的主题（15 套预设 json：catppuccin / dracula / nord / tokyo-night / rose-pine / pierre…）；“Scenic mode” = 全窗背景图 + 面板毛玻璃。

**动效** [V]：
- **全屏浮层打开时主界面“后退”**（`apps/electron/src/renderer/lib/animations.ts`）：`scaleBackValues = { scale: 0.92, y: 20, borderRadius: 16 }`；进入 `duration 0.4s, ease [0.16, 1, 0.3, 1]`（expo-out），退出 `0.3s, [0.7, 0, 0.84, 0]`（expo-in）。
- **“岛”式批注入场**（`packages/ui/src/components/annotations/island-motion.ts`）：选中文字后冒出的小工具条，从 `scale 0.25` 起，沿**指针刚才的移动方向**飞入；距离 = 指针速度(px/s) × 0.065，夹在 20–132px 之间（没有指针数据时 44px、90°）。
- Spinner：SpinKit 的 3×3 方格，`1em` 见方、`gap .08em`、`1.3s ease-in-out`，九格按对角线 0–0.4s 错开（`index.css` 约 980 行）。
- 乐观 UI 的微光：还没被后端确认的消息盖一层 `linear-gradient(90deg, transparent, fg/0.06, transparent)`，`1.5s ease-in-out infinite`。
- Toast：`scale(0.75) → 1` + 淡入。

#### A3. T3 Code（pingdotgg/t3code，MIT，2.6 万 star）——只读了 CSS，没看到截图

技术 [V] `apps/web/package.json`：Base UI + Tailwind 4 + lucide + tiptap（输入框）+ `@pierre/diffs` + `@pierre/trees` + `@formkit/auto-animate`。同时有桌面（Electron）、Web、iOS / Android。支持 Codex / Claude Code / Cursor / OpenCode 等。

`apps/web/src/index.css` 里几处很讲究 [V]：
- **输入框的“接缝”**：`--shadow-composer: 0 12px 28px -18px rgb(0 0 0 / 40%)`（一个被负扩散收进去的软投影，只在底下露一点）；输入框上面可以贴“附着横幅”、下面可以贴“上下文条”，接缝处用 `linear-gradient(to bottom, transparent 0 1rem, rgb(0 0 0 / 18%) 1rem, transparent calc(1rem + 10px))` 画 10px 的内阴影，让三块看起来是叠在一起的一个物体。滑入用 `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`。
- **`live-tool-shine`**：运行中的工具名上扫一道 4.5rem 宽的高光，`2.2s steps(30) infinite`——用 `steps(30)` 而不是 linear，一秒只重绘约 14 次。
- **只在可见时播放**：所有常驻动画写成 `animation-play-state: var(--visible-animation-state, paused)`，由 JS 在元素进入视口时把变量设成 running（长对话里几十个 spinner 不会一起烧 CPU）。
- 状态点：`status-pulse`（1 ↔ 0.5，`steps(6)`）和 `status-ping`（先 `scale .75 → 2` 爆开再隐身，注释写“点击后立刻有反馈”）。
- 控件高光：`--inset-shadow-control-highlight: 0 1px rgb(255 255 255 / 16%)`（按钮顶部一条 1px 内高光）、按下 `0 1px rgb(0 0 0 / 8%)`。
- 滚动区上下边缘用 mask 渐隐，虚拟列表另有一套保留滚动条通道不透明的 mask。
- 主色 `--primary: oklch(0.488 0.217 264)`（蓝紫），底 `zinc-25 = oklch(99.2% 0 0)`，`--radius: 0.625rem`，字体系统栈。

#### A4. Superset（superset-sh/superset，1.5 万 star，Elastic License 2.0）——终端优先 + 这次看到的最清楚的 diff 侧栏

[V 截图 `apps/marketing/public/images/readme/diff-viewer.png`] 深色。
- 中间 diff 面板：表头「Changes」+ 一排切换（unified / split、评论气泡、眼睛、布局、×）；分节「UNSTAGED 3」；文件头「…omponents/RevenueChart.tsx −3 +18 ↗ ⧉ [橙色方点] ☐ Viewed」；split diff 里**新增行左边一条 4px 实心绿条、删除行左边一条红色虚线条**，行内词级高亮是更深一档的同色底。
- 右栏三个 tab「Files | Changes 3 | Review」；下面「⑂ migrate-billing-stripe from main ▾」「All changes ▾ · 3 files +131 −3」；文件树按目录分组（目录行右侧是文件数），文件行右侧「+18 −3」+ 一个状态小方块（橙点 = 修改、绿加号 = 新增）；「Unstaged 3」标题行右侧 撤销全部 / 全部暂存 两个图标。
- 顶部一排 agent 启动器「Claude / Codex / OpenCode / Superset CLI」（各自品牌图标），右上角「Set Run ⌘G」。
- README [V]：侧栏每个 agent 有“工作中”指示，完成时**提示音 + Dock 角标**；`⌘I` 在终端旁边开一个富文本提示编辑器（多行、@ 文件）；浏览器面板的 **Design 模式：点选页面元素 → 带着这个元素的上下文给 agent 发修改请求**；Pull requests → Code 里选 diff 行发反馈。
- 动效 token [V] `packages/ui/src/motion.css`：`shimmer 2s linear infinite`、`block-fade 320ms ease-out`（流式新块淡入）、`thinking-pulse 1.8s`（0.35 ↔ 0.9）、`spin-slow 3.6s`。其余是原样的 shadcn neutral（`--radius: 0.625rem`、全灰阶 oklch），等宽 SF Mono。用 `streamdown` + `use-stick-to-bottom` + `@pierre/diffs`。

#### A5. Vibe Kanban（BloopAI/vibe-kanban，Apache-2.0，2.8 万 star）

[V 截图 `packages/public/vibe-kanban-screenshot-workspace.png`] 浅色、很“平”（基本没有阴影，靠三档灰底分区）。
- 左：Workspaces 列表，行 = 标题 + 相对时间，右侧「▪4 +134 −2」（文件数 + 增删）；当前行左边一条橙色竖条（品牌色 `--brand: 25 82% 54%`）。
- 中：窄列对话。工具步骤是**单行、无卡片**：图标 + 命令 / 路径（`npm run build 2>&1 | tail -80`、`Read medusa/src/pages/Agent.tsx`、`Updated Todos ⌄`）。输入框是一张卡，**卡顶有一条状态条**「2 files changed +61 −3 … ✳ ☑ ◔ Latest ▾」，卡内「Continue working on this task…」，底部「Default ▾ 📎 ✦ … Send」。
- 对话和 diff 之间浮着一根**竖向小工具条**（拖动柄 / 文件 / 复制 / 运行 / 预览 / 分支），贴在两栏的缝上。
- 右：split diff + 最右一列可折叠小节「Changes / Git（仓库卡：分支 ▾、↑1、Open pull request ▾）/ Working Branch / Terminal / Notes（Add notes about this workspace…）」。
- README [V]：diff 上留行内评论，攒起来一次发给 agent；内置浏览器带 devtools / 元素检查 / 设备模拟。
- 字体 [V]：Google Fonts 的 **IBM Plex Sans + IBM Plex Mono**；图标 **Phosphor**（`@phosphor-icons/react`）；输入框是 Lexical；文字三档 `--text-high 5% / normal 20% / low 39%` 亮度。

#### A6. Emdash（generalaction/emdash，Apache-2.0，5.9k star）

[V 截图 https://emdash.com/media/blog/public-v1-beta/v1beta.jpg ] 很克制的浅色：浅灰侧栏 + 纯白主区，窗口大圆角。
- 侧栏分「PINNED」「PROJECTS」（等宽、加大字距的小号大写灰字）；任务行 = 分支名 +「+47 −1」（绿 / 红，千以上写 `+1k`）+ **PR 状态小图标（绿 = 打开、紫 = 已合并、红 = 已关闭）** + 相对时间（25m / 21h / 12d）。任务默认名是三个随机词（floppy-squids-glow）。
- 首页是 logo + 四个大行动作「Open project / Create repository / Clone from GitHub / Add remote project」，每行 图标 + 标题 + 一句说明，第一行右侧有一个 ↵ 键帽。
- 技术 [V]：Base UI + Tailwind 4 + lucide + framer-motion；**Inter Variable + JetBrains Mono Variable**（`@fontsource-variable`，注释写“字体必须在任何测量之前加载”）；tiptap 输入框；token 用 Vanilla Extract 生成。微光 `text-shimmer-move 3s linear infinite`，从 `--em-foreground-passive` 到 `--em-foreground-muted`（**高光只比正文低一档，不用纯白**）；边缘渐隐用 `color-mix(in oklab, <surface>, transparent 50%)`（注释：oklab 插值避免 `transparent` 造成的灰雾）。

#### A7. Jean（coollabsio/jean，Apache-2.0，1.3k star）——把 worktree 当“待办”

[V 截图 `screenshots/worktrees.webp`] 深色、字很大（标题约 18px）。
- 左：Projects / Recent 两个 tab，项目行 = 字母方块 + 名字 + 右侧数量徽标，当前行琥珀色底。
- 主区顶上一排**带计数的筛选 tab**：`All 22 | Manual 6 | Issues 2 | PRs 15 | Security 0 | Mr. Robot BETA 0 | Needs testing 8 | Planned 5`；
- 每个 worktree 一行：名字 + 一组小 chip（分支、基线 `next`、PR `#11793`）+ `+633 / −0` + 紫色同步计数 + 相对时间，**最右一个彩色状态胶囊**（Planned 粉、Needs testing 黄）；有人审过的带绿色「1 review」。
- 技术 [V]：Tailwind 4 + shadcn（`--radius: 0.625rem`、单色近黑主色 `oklch(0.205 0 0)`）、`@pierre/diffs`、`ghostty-web` 终端；内置 7 种字体可选（Inter / Geist / Lato / Roboto + Fira Code / JetBrains Mono / Source Code Pro）。

#### A8. CodexMonitor（Dimillian/CodexMonitor，MIT，4.3k star，Tauri——仓库根有 `src-tauri/`）——毛玻璃 + 一张用量卡

[V 截图 `screenshot.png`] 窗口半透明压在壁纸上（macOS vibrancy），内容区是更深一层的半透明板。
- 侧栏：工作区分组（小号大写 CODEX / MEDIUM），线程行 = 彩色状态点（橙 = 进行中、绿 = 完成）+ 标题 + 相对时间，每组最多 3 条 +「More…」；**左下角一张用量卡**：「Session · Resets 3 hours 0%」+ 细进度条、「Weekly · Resets 2 hours 100%」+ 绿色进度条、「Credits: 40 credits」。
- 对话：助手消息是灰色圆角气泡、用户消息是蓝色气泡；一组步骤折成「⌃ 5 tool calls, 3 messages」，展开后是带左竖线的时间线：🧠 粗体小标题 + 正文（推理摘要）、`>_` + 等宽胶囊（命令）、`file edited: Messages.tsx`；底部「◯ 1:03 Working…」。
- 输入框：左图片、右三个圆按钮（展开 / 麦克风 / 红环停止）；下面一排 chip「gpt-5.2-codex ▾ · medium ▾ · Full access ▾」，**最右一个绿色圆环 = 上下文占用**。
- 右栏：图标分段切换（Git / 文件 / 提示词）+「DIFF ▾」；「+160 / −2」、分支、提交说明框（右上角 ✦ = AI 生成）、Commit；「UNSTAGED (4)」文件卡 = `[M]` 小方块徽标 + 文件名 + 目录 + 「+113 / −2」胶囊。

#### A9. cmux（manaflow-ai/cmux，GPL-3.0，2.8 万 star，macOS 原生终端）——“谁需要我”做得最直白

[V 截图 `docs/assets/notification-rings.png` + 文档 https://manaflow-ai-cmux.mintlify.app/features/notifications ]
- **需要你处理的分屏外面套一圈蓝色实线框**；侧栏竖排 tab 同时亮蓝点 / 未读数。
- 侧栏 tab 是三行：标题、**最后一条通知的原文**（“Interesting idea. Are you looking to: 1. …”）、`分支* · 路径`；另外还显示关联 PR 状态和监听端口。
- 顶部铃铛带未读数；`Cmd+Shift+U` 跳到最新一条未读、`Cmd+I` 打开全部待处理列表。
- 触发靠终端转义序列 OSC 9 / 99 / 777 或 `cmux notify`（agent 的 hook 里调）。
- GPL：只抄想法。

#### A10. Conductor（conductor.build，闭源，macOS）——只读了文档，没看到界面

[V] https://www.conductor.build/docs/concepts/workflow 、`/reference/diff-viewer`、`/reference/checks`：
- 每个任务 = 一个 workspace（分支 + 工作树 + 终端 + diff + 审阅路径）；可从分支 / PR / GitHub issue / Linear issue 建（`⌘⇧N`）。
- `⌘⇧D` 开 Diff Viewer；**行内评论变成输入框里的附件**，发回给写这段代码的 agent；可按提交筛选；GitHub 的 review 评论也显示在里面。
- **Checks tab**：把“合并前要看的东西”收在一处——git 状态 / PR 元数据 / CI / 部署 / GitHub 评论 / Todos；有未完成项时“阻止或不鼓励”合并。
- Conductor 会按进度推荐下一步动作：Create PR → 回应反馈 → 修 CI → Merge；归档后可从 History 恢复（连聊天记录）。
- 侧栏状态图标、检查点、Spotlight 测试的具体长相文档里没有，不写。

#### A11. Nimbalyst（原 stravu/crystal）

[V 截图 https://nimbalyst.com/_astro/feature-session-kanban.CPa-_1cP_Z1PEj87.webp ] **会话看板**：列 = BACKLOG / PLANNING / IMPLEMENTING / VALIDATING / COMPLETE（列头：彩色圆点 + 大写名 + 数量 + 折叠箭头），最左一列折成竖排的「INBOX 6」；卡片 = agent 图标 + 标题 + 灰色标签（feature / bug-fix / auth）+ 评论图标 + 时间；左边还有一份按 worktree 分组的会话树；左栏底部两个**百分比小圆环**（43% / 25%）。官网 [V]：AI 的每次编辑都先以 diff 形式出现，批准才落盘；Excalidraw / mockup / 数据模型 / 思维导图等“可视编辑器”做成扩展。

#### A12. Goose 桌面（aaif-goose/goose，Apache-2.0，5.5 万 star）

[V] `ui/desktop/src/styles/main.css`：自有字体 **Cash Sans**（Block 的品牌字体，400–700 四个字重）；lucide + Radix Icons；Tailwind 4 + `tw-animate-css`。动效：侧栏项逐个从右滑入 `translateX(20px) → 0`，`0.8s cubic-bezier(0.16, 1, 0.3, 1)`，每项错 50ms；logo 入场 `scale(.25) translate(-5px,5px) rotate(-20deg) → 原位`，`0.6s cubic-bezier(0.34, 1.56, 0.64, 1)`（回弹），`transform-origin: bottom left`；**MCP App 三种显示模式各有入场**：画中画 `scale(.85) translate(12px,-12px)` 200ms、全屏 `scale(.95)` 200ms、内联 `scale(1.03)` 180ms，都是 `cubic-bezier(0.2, 0, 0, 1)`。界面本身没看截图，不评价。

#### A13. Sculptor（imbue-ai/sculptor，MIT）

[V] `sculptor/frontend/src/styles/tokens.css`：一套干净的动效 token——`--duration-fast 100ms / normal 200ms / slow 300ms / slower 500ms`，`--ease-default: cubic-bezier(0.16, 1, 0.3, 1)`；字体 Inter + JetBrains Mono；[I] 看 `radix-overrides.css` 和 `--radius-1` / `--gray-*` 的命名是 Radix Themes。`shimmer.module.css` 的做法值得记：**用 `mask-image` 调文字自己的 alpha**（`mask-size: 400% 100%`，一条 50% 透明的暗带，`5s linear infinite`），而不是盖一层渐变——所以**彩色文字 / 语法高亮上也能用**。界面没看到，不评价。

#### A14. Cline / Kilo Code（VS Code webview）

- **检查点** [V] https://docs.cline.bot/core-workflows/checkpoints ：每次工具调用后对话里出现一行「🔖 Checkpoint ┄┄┄┄ Compare · Restore」（书签图标 + 一条点线连到两个按钮）。Compare 打开编辑器 diff；Restore 弹三选项：`Restore Files`（只还原文件，对话留着）/ `Restore Task Only`（只删之后的消息）/ `Restore Files & Task`。编辑旧消息时有「Restore All」= 还原文件再重发。
- **钉住的用户消息** [V] `apps/vscode/webview-ui/src/components/chat/task-header/StickyUserMessage.tsx`：向下滚时，最近一条用户消息缩成一条钉在顶部，点它跳回去。
- **上下文条** [V] `…/task-header/ContextWindow.tsx`：`已用 ▓▓▓░░░ 上限` 一条进度条，悬停出明细卡，旁边一个压缩按钮；点压缩先出内联确认「Compact the current task?」。
- **Kilo 的任务时间线** [V] `packages/kilo-vscode/webview-ui/src/components/chat/TaskTimeline.tsx`：任务头下面一条**横向色块条**，每个 part（文字 / 推理 / 各类工具）一根小柱，**颜色按类型、宽高按内容多少**；悬停出 tooltip，点击滚到那一步，可拖动横滚，运行时自动贴右；键盘可逐根走（`aria` 读「Bar 3 of 41: …」）。

#### A15. Zed Agent Panel（闭源无关，文档清楚）

[V] https://zed.dev/docs/ai/agent-panel ：
- 运行中再发的消息**默认排队**；队列里的可编辑 / 删除；「Steer」开关 = 在 agent 下一步插入；双击回车 = 「Send Now」打断。
- 输入框上方一条手风琴「N files · +a −b」+「Review Changes」（开一个把所有改动拼在一起的 multibuffer，逐块 Keep / Reject）。
- 左下角准星图标 = **跟随 agent**：编辑器跟着 agent 正在碰的文件跳；发送时按住 ⌘ 也会开。
- 编辑旧消息后，那条消息顶上出现「Restore Checkpoint」。
- 「New From Summary」：长线程快满时，用摘要开一个新线程。

#### A16. 一句话带过

- **1Code**（21st-dev/1code）[V README]：从任意用户气泡回滚、从任意助手消息分叉“子对话”、消息上的 **Git Activity Badges**、思考文字用渐变色；视觉是 shadcn 默认 + 主色 `228 100% 50%`（纯蓝），没有新东西。
- **opcode / Claudia**、**AionUi**（Arco Design）、**Claude Squad**（纯 TUI）：没有值得带走的界面想法。
- **Amp** [V https://ampcode.com/news/thread-map ]：Thread Map（把线程之间的 提及 / 交接 / 分叉 画成自上而下的图，回车跳进去）——官方 2025-12 推出，据第三方博客 2026-07 已下线；作为“分叉可视化”的反例记一笔：做了又撤。
- **Factory**：Mission Control 一屏看「在做哪个功能 / 哪个 worker / 在用什么工具 / 进度」[V https://docs.factory.ai/features/missions/overview ]，界面细节没拿到。
- **Kiro**：spec = requirements.md → design.md → tasks.md 三份文档，每份之间一道人工批准；tasks.md 上直接显示每条任务的实时状态 [V https://kiro.dev/docs/specs/ ]。
- **没看**：Continue、Roo Code（docs.roocode.com 现在 301 到 `roocodeinc.github.io`，没继续读）、Onlook、Void、Trae、Qoder、CodeBuddy。

### B. 通用聊天 / agent 客户端

| 产品 | 字体 | 圆角 | 值得记的 | 来源 |
| --- | --- | --- | --- | --- |
| **LobeChat / Lobe UI** | `HarmonyOS Sans` → 系统；中文 `HarmonyOS Sans SC, PingFang SC, Microsoft YaHei UI…`；等宽 `Hack` | 8 / 12(LG) / 6(SM) / 4(XS)，控件高 36 | 毛玻璃两档：`backdrop-filter: saturate(150%) blur(10px)` / `blur(36px)`；**中英文字体分两张表拼接** | [V] `lobe-ui/src/styles/theme/token/base.ts`、`customStylishStatic.ts` |
| **Cherry Studio** | 默认 `Ubuntu`（Windows 上 `Microsoft YaHei UI`），等宽 `Cascadia Code`；都留了用户覆盖变量 `--app-user-font-family` | — | 字体可在设置里换，变量兜底 | [V] `src/renderer/assets/styles/font.css` |
| **Open WebUI** | Inter（+ Vazirmatn），等宽 JetBrainsMono | Tailwind 默认 | **流式 token 淡入：`.fade-in-token { animation: fade-in-token 100ms ease-out }`**；状态描述 `translateY(-10px) → 0` 0.2s；微光 `1.5s cubic-bezier(0.7, 0, 1, 0.4)`、110° 斜角、高光只占 43%–57% | [V] `src/app.css` |
| **Jan** | Inter（品牌字 StudioFeixenSans） | 0.625rem | 主色暖橙 `oklch(0.7003 0.1611 35.09)` | [V] `web-app/src/index.css` |
| **Chorus**（meltylabs，多模型并排） | `SF Pro` / Geist Mono，另带 Monaspace 三款 | — | **多模型“合成”动画**：各家回答 `translateY(25px) scale(.6)` 淡出下沉（`synthesisPulse`），合成结果 `scale(.6) → 1.2 → 1` 弹出（`synthesisMerge`）；暖色微光 `hsl(30,47%,63%)` 5s | [V] `src/ui/App.css` |
| **Vercel ai-chatbot 模板** | Geist | — | 欢迎语两行先后上浮：`y:10 → 0`，0.5s，延迟 0.35s / 0.5s，`ease [0.22, 1, 0.36, 1]`；建议卡 `y:16 → 0` 0.4s，每张错 60ms | [V] `components/chat/greeting.tsx`、`suggested-actions.tsx` |

没看：LibreChat、AnythingLLM、Msty、Raycast AI、BoltAI、Witsy、T3 Chat、Dify / Coze 小组件、CopilotKit、Kibo UI、shadcn chat blocks（[I] 凭印象：Kibo UI 的 AI 组件后来成了 AI Elements，所以只读了后者）。

### C. 一个“事实标准”：@pierre/diffs

opencode、Superset、T3 Code、Jean、Vibe Kanban、1Code 的 `package.json` 里都有 `@pierre/diffs`（[V] 各仓库 package.json）。https://diffs.com/ [V]：基于 Shiki；CSS Grid + Shadow DOM（DOM 节点少）；split / stacked；变更标记三选一（经典 +/−、整行底色、**左侧竖条**）；行内差异可按字符或按词；`enableLineSelection`（点行号选一行、拖选范围、Shift 扩选）；**annotation 框架**（往任意行下面插自定义内容：行评论、CI 结果、accept / reject 按钮）；合并冲突三选（current / incoming / both）；跟随你的 CSS `font` / `line-height`。——claude-web 现在的 `DiffView` 是自己写的，要做“行评论 → 发给 agent”时可以直接评估它（同作者还有 `@pierre/trees` 文件树）。

---

## 三、组件库里的现成交互规格

### 3.1 Vercel AI Elements（vercel/ai-elements，Apache-2.0）——`packages/elements/src/*.tsx`

全部 [V]，文件名即组件名。基于 shadcn/ui + lucide + `motion` + `streamdown` + `use-stick-to-bottom`。

**Shimmer**（`shimmer.tsx`）
- `duration = 2`（秒）、`spread = 2`；高光半宽 = `文字长度 × spread` px（**字越多高光越宽**）。
- `bg-[length:250%_100%,auto] bg-clip-text text-transparent`；背景 = `linear-gradient(90deg, #0000 calc(50% - spread), var(--color-background), #0000 calc(50% + spread))` 叠在 `muted-foreground` 实底上；`backgroundPosition` `100% center → 0% center`，`ease: "linear", repeat: Infinity`。
- 注意高光色是 **background 色**（在灰字上“擦亮”一道），不是更亮的前景色。

**Reasoning**（`reasoning.tsx`）
- `AUTO_CLOSE_DELAY = 1000`ms。流式开始 → 自动展开（除非显式 `defaultOpen={false}`）；流式结束 → 1 秒后自动收起，**只自动收一次**（用户再点开就不管了）。
- 计时：开始流式记 `Date.now()`，结束时 `Math.ceil(ms / 1000)` 秒。
- 触发行：`BrainIcon size-4` + 文案 + `ChevronDownIcon`（展开时 `rotate-180`）；`text-muted-foreground text-sm hover:text-foreground`。
- 文案三态：流式中 `<Shimmer duration={1}>Thinking...</Shimmer>`；有时长 `Thought for {n} seconds`；没时长 `Thought for a few seconds`。
- 内容：`mt-4 text-sm text-muted-foreground`，开合用 `slide-in-from-top-2` / `slide-out-to-top-2` + `fade-out-0`。

**ChainOfThought**（`chain-of-thought.tsx`）
- 步骤三态只靠文字色：`active: text-foreground`、`complete: text-muted-foreground`、`pending: text-muted-foreground/50`。
- 每步 = `size-4` 图标（默认 `DotIcon`）+ 标题 + `text-xs` 说明；**图标下面一条 1px 竖线**：`absolute top-7 bottom-0 left-1/2 -mx-px w-px bg-border`（把相邻步骤连起来）。
- 步骤入场 `fade-in-0 slide-in-from-top-2 animate-in`；搜索结果是一排 `Badge variant="secondary" gap-1 px-2 py-0.5 text-xs font-normal`；步骤里的图片 `max-h-[22rem] rounded-lg bg-muted p-3` + `text-xs` 图注。

**Tool**（`tool.tsx`）
- 容器 `rounded-md border mb-4`；头：`WrenchIcon` + `font-medium text-sm` 名字 + 状态徽标 + chevron。
- 七种状态各一个图标：`input-streaming` 空心圆；`input-available` 时钟 `animate-pulse`；`approval-requested` 黄时钟（`text-yellow-600`）；`approval-responded` 蓝勾；`output-available` 绿勾（`text-green-600`）；`output-error` 红叉；`output-denied` 橙叉。徽标 `rounded-full text-xs gap-1.5`。
- 输入 / 输出小节标题 `text-xs uppercase tracking-wide font-medium text-muted-foreground`；输出底 `bg-muted/50`，出错 `bg-destructive/10 text-destructive`。

**Task**（`task.tsx`）：触发行同 Reasoning 的样式（`SearchIcon`）；内容 `mt-4 space-y-2 border-l-2 border-muted pl-4`（左边一条 2px 线）；文件 chip `inline-flex gap-1 rounded-md border bg-secondary px-1.5 py-0.5 text-xs`。

**Conversation**（`conversation.tsx`）
- `<StickToBottom initial="smooth" resize="smooth">`，内容 `flex flex-col gap-8 p-4`（**消息间距 32px**）。
- 回到底部按钮：`absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full`，`ArrowDownIcon size-4`，只在不在底部时渲染。
- 空状态：图标 + `font-medium text-sm` 标题 + `text-muted-foreground text-sm` 说明，整体 `gap-3 p-8`。

**Message**（`message.tsx`）
- 行宽 `max-w-[95%]`；用户消息 `ml-auto rounded-lg bg-secondary px-4 py-3`；助手消息**无底无框**，只有文字。
- 分支切换 `MessageBranch`：上一条 / 下一条**循环**（到头回到另一端），页码 `1 of 3` 是 `border-none bg-transparent text-muted-foreground shadow-none`。

**PromptInput**（`prompt-input.tsx`）
- 文本框 `field-sizing-content max-h-48 min-h-16`（64–192px，用 CSS `field-sizing` 自适应，不用 JS 量高度）。
- 回车提交前检查 `isComposing || e.nativeEvent.isComposing`（输入法）；**文本框空着按 Backspace = 删掉最后一个附件**。
- 粘贴文件、`globalDrop`（整个页面都能拖放）、`maxFiles` / `maxFileSize` 校验。
- 提交键图标随状态：就绪 `CornerDownLeftIcon`（↵）、`submitted` 转圈、`streaming` `SquareIcon`（停止）、`error` `XIcon`。

**Context**（`context.tsx`）：SVG 圆环 `viewBox 24`、`r=10`、`strokeWidth=2`、`strokeLinecap="round"`，`strokeDashoffset = 周长 × (1 − 已用比例)`；悬停卡 `min-w-60 divide-y`：顶部进度条 + `Input / Output / Reasoning / Cache` 四行 `text-xs`，底部 `bg-secondary` 一行「Total cost」。

**Queue**（`queue.tsx`）：容器 `rounded-xl border bg-background px-3 pt-2 pb-2 shadow-xs`；分节标题 `rounded-md bg-muted/40 px-3 py-2 text-sm font-medium`（折叠时 chevron `-rotate-90`）；条目 `rounded-md px-3 py-1 text-sm hover:bg-muted`，行首 `size-2.5 rounded-full border` 小圆点，说明缩进 `ml-6 text-xs`；**条目上的操作按钮平时 `opacity-0`，`group-hover:opacity-100`**。

**其它**：`Suggestion` = `rounded-full px-4` 的按钮，放在隐藏滚动条的横向 `ScrollArea` 里；`Plan` 流式时标题和说明包在 `<Shimmer>` 里；`Checkpoint` = `BookmarkIcon size-4` + 一条线 + 按钮（和 Cline 同构）；`Confirmation` 只在 `approval-requested` 时显示请求和按钮，`approval-responded` 后换成“已批准 / 已拒绝”一行；`Sources` 触发行「Used N sources」+ 展开的链接列表（`BookIcon`）。

### 3.2 assistant-ui（assistant-ui/assistant-ui，MIT）——`packages/ui/src/components/react/assistant-ui/elements/`

全部 [V]。这一批新组件的共同视觉：**卡片 `rounded-2xl`（16px）、行 `rounded-xl`、小按钮 `rounded-full h-6 px-2 text-[11px]`，没有描边，只用 `bg-foreground/[0.03–0.06]` 的极淡底和 `border-foreground/[0.06]` 的分隔线；按下 `active:scale-[0.96–0.98]`；所有动画带 `motion-reduce:` 兜底。**

- **`reasoning.tsx`**：`ANIMATION_DURATION = 200`ms。三种外观 `outline`（`rounded-lg border px-3 py-2`）/ `ghost` / `muted`（`bg-muted/50 rounded-lg`）。**流式时是“预览窗”**：内容区限高，上下各盖一条 `h-8` 的渐变（`linear-gradient(to bottom, var(--color-background), transparent)`），文字从渐变里滚过。触发行 `max-w-[75%] py-1.5 text-sm`，`active:scale-[0.98]`，时长显示成「(12s)」，`tabular-nums`。
- **`thinking-indicator.tsx`**：`size-1.5` 蓝点 `animate-pulse`（`bg-blue-500`）+ 微光标签 + 等宽耗时；**标签用 `key={label}`，每次换文案都重放 `fade-in slide-in-from-bottom-1 duration-300`**。
- **`streaming-text.tsx`**：按词渲染；每个词 `fade-in duration-500`；**最新的 2 个词染成蓝色，随后 `transition-colors duration-700` 褪回正文色**（“墨水刚落下”的效果）；行内代码 `bg-foreground/[0.06] rounded-md px-1.5 py-0.5 font-mono text-[0.85em]`；末尾一条 `h-4 w-0.5 rounded-full bg-blue-500 animate-pulse` 的光标。
- **`tool-timeline.tsx`**：触发行 `text-[13.5px]`，chevron `size-3.5 opacity-60`，旋转 `duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]`；每步 `fade-in slide-in-from-bottom-1 duration-300`；参数 chip `bg-foreground/[0.06] rounded-md px-1.5 py-0.5 font-mono text-[11px]`。
- **`tool-group.tsx`**：`max-w-sm rounded-2xl` 卡；头行可点（`hover:bg-foreground/[0.03]`），运行中 `Loader2Icon size-3.5 animate-spin`；展开体 `border-t border-foreground/[0.06]` + `fade-in slide-in-from-top-1 duration-200`。
- **`conversation-map.tsx`（对话小地图）**：对话右侧一条竖轨，每条消息一根横线。默认 `w-3`（12px）、高 `h-0.5`、色 `bg-foreground/15`；当前消息 `h-[3px] bg-foreground/90`；**鼠标进入轨道：当前那根伸到 `w-6`、其它“重要”的伸到 `w-[18px]`，悬停的那根 `w-6 bg-foreground/70`**；`transition-[width,height,background-color] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]`。悬停 120ms 后在侧边 `sideOffset=10` 弹预览卡（`w-60 rounded-2xl p-3.5`，`scale .97 → 1` + 淡入 200ms），点击跳到那条消息。短对话的线挤在一起，长对话按占比撑开（源码注释）。
- **`checkpoint-history.tsx`**：行首 `size-1.5` 圆点（当前 = 蓝，过去 = `foreground/25`）；当前行 `bg-foreground/[0.05]`；「恢复」按钮 `opacity-0`，行 hover 才出现。
- **`reviewable-diff.tsx`**：每个 hunk 右上角两个胶囊——拒绝（灰）/ 接受（`bg-emerald-500/12 text-emerald-700`，hover `/20`）；处理完的 hunk `transition-opacity duration-300` 变淡；底部一个 `h-7 rounded-full` 的总按钮。
- **`scroll-anchor.tsx`**：回到底部的胶囊 `rounded-full px-3.5 py-1.5 text-xs`，入场 `fade-in slide-in-from-bottom-2`，hover `-translate-y-px`；列表顶部 `h-6` 渐隐。
- **`background-inbox.tsx`**：后台任务列表，行 `rounded-xl px-1.5 py-2`，运行中 `Loader2Icon size-3`，完成的行出「收取」按钮。
- **`run-activity.tsx`**：一个回合的活动折成一行，显示**最后一条有文字的条目**当标题；注释写明「待决的批准和恢复控件留在折叠外面」「最终回答留在折叠外面」——和 claude-web 现在的规则一致。
- 另有 `message-queue.tsx`、`approval-card.tsx`、`subagent-list.tsx`、`agent-handoff.tsx`、`cost-meter.tsx`、`context-breakdown.tsx`、`trace-waterfall.tsx`、`number-ticker.tsx` 等，没逐个读。

**tw-shimmer**（`packages/tw-shimmer/src/index.css`）[V]——一个零 JS 的 Tailwind 4 微光工具类：
- 速度是**像素 / 秒**（默认 `--shimmer-speed: 200`），时长由轨道宽度算出 → **长短不同的文字扫过速度一样**（按固定时长做的微光，长句子会扫得飞快）。
- 默认倾角 15°；高光宽 `calc(4ch + 80px)`；两次扫过之间有停顿（`--shimmer-repeat-delay`）。
- 渐变用 17 个色标拟合正弦曲线（“4% / 17% / 33% / 50% / 67% / 83% / 96%”），边缘没有硬边。
- 基色 `currentColor`，高光亮色下是它的 20% 透明、暗色下是 `oklch(from currentColor max(0.8, l + 0.4) …)`——**自动适配任何文字色**。

### 3.3 prompt-kit（ibelick/prompt-kit）——`components/prompt-kit/*.tsx`

[V]
- **`response-stream.tsx`**：两种模式。`typewriter`：`speed`（1–100，默认 20）< 25 时一次 1 个字符，否则 `round((speed − 25) / 10)` 个；帧间隔 `max(1, round(100 / √speed))` ms（speed 20 ≈ 22ms）。`fade`：用 `Intl.Segmenter(locale, { granularity: "word" })` 切词（**中文也能正确切**），每段 `animation: fadeIn {round(1000 / √speed)}ms ease-out forwards`（speed 20 ≈ 224ms），段间延迟同上公式。
- **`chat-container.tsx`**：`<StickToBottom resize="smooth" initial="instant" role="log">`（和 AI Elements 的区别：初次进入不做滚动动画）。
- **`thinking-bar.tsx`**：左边微光「Thinking ›」（可点开），右边一个**点状下划线的文字按钮「Answer now」**（`border-b border-dotted`）——思考太久时让用户直接要答案。
- **`text-shimmer.tsx`**：默认 4s、spread 20（夹在 5–45）。
- **`loader.tsx`**：12 种加载样式的 keyframes 时长——圆环 spin、`pulse-dot 1.2s`、三点 `bounce-dots 1.4s`（每点错 160ms）、`typing 1s`（错 250ms）、`wave 1s`（错 100ms）、`wave-bars 1.2s`、`blink 1s step-end`（终端光标）、`text-blink 2s`、`shimmer 4s`、`loading-dots 1.4s`（三个点依次出现，延迟 0.2 / 0.4 / 0.6s）。

### 3.4 视觉语言对照表（都是 [V]，来自各仓库 package.json / CSS）

| 产品 | 正文字体 | 等宽 | 图标 | 基准圆角 | 分隔方式 |
| --- | --- | --- | --- | --- | --- |
| opencode | 系统栈（带 Inter） | 系统 / JetBrains Mono NF | 自绘 | 6–8px | ring-shadow |
| Craft Agents | 系统栈，15px | JetBrains Mono | — | 面板约 8–12px | ring-shadow，面板间留缝 |
| T3 Code | 系统栈 | 系统 | lucide | 10px | 细线 + 内高光 |
| Emdash | Inter Variable | JetBrains Mono Variable | lucide | — | 灰底 / 白底对比 |
| Superset | shadcn 默认 | SF Mono | lucide + react-icons | 10px | 1px 线 |
| Vibe Kanban | IBM Plex Sans | IBM Plex Mono | Phosphor | — | 三档灰底，无阴影 |
| Jean | Inter（可选 Geist 等） | JetBrains Mono 等 | — | 10px | 1px 线 |
| Goose | Cash Sans | — | lucide + Radix | — | — |
| Sculptor | Inter | JetBrains Mono | Radix | — | — |
| Lobe UI | HarmonyOS Sans | Hack | lucide + 自有 | 8 / 12 | 毛玻璃 |
| AI Elements | 跟宿主（Geist） | — | lucide | `rounded-md/lg/xl` | 1px 线 |
| assistant-ui 新组件 | 跟宿主 | — | lucide | **16px 卡 + 全圆胶囊** | 无描边，3–6% 前景色淡底 |

观察：**最“不方”的两家（Craft Agents、assistant-ui 新组件）都不是靠把圆角调大，而是靠去掉 1px 实线描边**——一个换成分层 ring-shadow，一个换成极淡的底色。圆角 10px 的 shadcn 默认皮（Superset / Jean / T3）看起来仍然是“方盒子”。

---

## 四、值得偷的 15 个点子（按对 claude-web 的影响排序）

每条：是什么 → 具体怎么动 → 来源。带“落点”的是它在 claude-web 里对应的现有部件。

**1. 描边换成分层 ring-shadow，面板之间留缝，聚焦面板给渐变边**
- 怎么做：面板 / 卡片 / 输入框去掉 `border: 1px solid`，改 `box-shadow: rgba(fg,0.06) 0 0 0 1px, rgba(0,0,0,.06) 0 1px 1px -0.5px, rgba(0,0,0,.06) 0 3px 3px -1.5px`（暗色把 0.06 提到 0.12–0.15）；侧栏 / 列表 / 对话做成浮在底色上的独立圆角板；键盘焦点所在的那块用 `::before` + mask-composite 画 1px 渐变线 `rgba(fg,.1) → rgba(fg,.3)`（上浅下深），其它面板文字降到 80%。
- 来源：Craft Agents `apps/electron/src/renderer/index.css`（https://github.com/craft-ai-agents/craft-agents-oss/blob/main/apps/electron/src/renderer/index.css ）；opencode `--shadow-xs-border*`（https://github.com/anomalyco/opencode/blob/dev/packages/ui/src/styles/theme.css ）。
- 落点：`--edge-*` 令牌和 `.pane` / `.composer` / `.fcard` / `.pdock`。这是对“方、盒子感”最直接的一刀。

**2. 状态文字的换字动画 + 逐字微光（替掉“spinner + 静态文字”）**
- 怎么动：运行中的标题叠一层微光（高光 5.2ch 宽，1200ms linear 循环）；状态词变化时新字从上方 mask 擦入、旧字向下擦出（450ms，`cubic-bezier(0.34,1.08,0.64,1)`），容器宽度同步过渡；一步完成时“进行态 → 完成态”两个词原位交叉（opacity 240ms + blur 0.9px + 位移 0.03em），完成态颜色更深；微光停止时先 220ms 淡出再停。
- 来源：opencode `text-shimmer.css` / `text-reveal.css` / `tool-status-title.css`（https://github.com/anomalyco/opencode/tree/dev/packages/ui/src/components 、`packages/session-ui/src/components`）。
- 落点：`RunCard` 的“正在做什么”、`Steps` 里进行中的那一步、「思考中」。配套把状态词换成 opencode 那张人话表（Exploring → Explored…）。

**3. 回合摘要里的数字滚动、新计数“挤”出来**
- 怎么动：数字每一位是 0–9 竖条，滚到目标位 560ms `cubic-bezier(0.22,1,0.36,1)`，上下 18% mask 渐隐，`tabular-nums`；摘要里新出现一类（“· 搜索 2 次”）时用 `grid-template-columns: 0fr → 1fr` 480ms 展开 + blur 2px → 0 + 淡入，旁边的字被平滑推开。
- 来源：opencode `animated-number.css`、`tool-count-summary.css`（同上仓库）。
- 落点：运行中回合顶上可以直接放一行实时摘要（现在是完成后才出 `turn-sum`）；会话头 `+N −M`、审阅 tab 的数字、上下文百分比。

**4. 会话 = 收件箱：状态流 + 标记，侧栏按状态看**
- 怎么做：每个对话一个状态（Backlog / Todo / Needs Review / Done / Cancelled，可自定义）和一个旗标；侧栏导航出状态子项，各带一个小图标；列表行显示状态图标 + 权限模式小徽标 + 时间。agent 跑完自动进 Needs Review，用户看过手动 Done。Jean 的变体：列表顶上一排带计数的筛选 tab（All 22 / PRs 15 / Needs testing 8…），行尾彩色状态胶囊。Nimbalyst 的变体：同一批状态画成看板。
- 来源：Craft Agents README + 截图（https://github.com/craft-ai-agents/craft-agents-oss ）；Jean `screenshots/worktrees.webp`（https://github.com/coollabsio/jean ）；Nimbalyst（https://nimbalyst.com/ ）。
- 落点：claude-web 侧栏已有「需要你」和置顶 / 归档，缺的是“我看完了没有”这一维——现在跑完的对话和没跑完的在列表里长得一样。

**5. 对话小地图 / 任务时间线条**
- 怎么动（竖版）：对话右缘一条轨，每条消息一根 12px 短线，当前的加粗；鼠标进入轨道，线伸长到 18–24px（200ms `cubic-bezier(0.23,1,0.32,1)`），悬停 120ms 弹出该消息的预览卡，点击跳转。
- 怎么动（横版）：任务头下一条色块条，每步一根，颜色 = 类型，宽高 = 内容量；悬停 tooltip，点击滚到那步，运行时自动贴右。
- 再加：向下滚时把最近一条用户消息钉在顶上。
- 来源：assistant-ui `conversation-map.tsx`（https://github.com/assistant-ui/assistant-ui/blob/main/packages/ui/src/components/react/assistant-ui/elements/conversation-map.tsx ）；Kilo `TaskTimeline.tsx`（https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-vscode/webview-ui/src/components/chat/TaskTimeline.tsx ）；Cline `StickyUserMessage.tsx`。
- 落点：长对话（几十轮、每轮折叠）里现在只能滚；`groupTurns` 已经有回合边界，小地图一根线 = 一轮正合适。

**6. diff 上选行写评论 → 变成输入框里的附件，攒着一次发**
- 怎么动：在审阅里点行号 / 拖选范围 → 行下方出评论框 → 提交后该行挂一个评论气泡，同时输入框里多一个「文件:行号」芯片；可以攒多条，发送时一起带给 agent。
- 来源：Conductor 文档（https://www.conductor.build/docs/concepts/workflow ）；Vibe Kanban README；Superset README；opencode 的 `ui.sessionReview.selection.lines`；实现可用 `@pierre/diffs` 的 `enableLineSelection` + annotation（https://diffs.com/ ）。
- 落点：`ReviewView`。现在审阅只能 暂存 / 还原 / 提交，对 agent 的反馈要回到输入框手打“第几行怎么怎么”。

**7. diff 的行标记换成左侧色条 + “已看”勾选 + 四档范围**
- 怎么做：新增行左边 4px 实心绿条、删除行红色虚线条（代替整行浓底色，底色只留很淡一层）；每个文件头一个 ☐ Viewed，勾了自动折叠；范围切换补一档「上一轮的改动」；文件行尾放状态小方块（改 = 橙点，新 = 绿加号）。
- 来源：Superset `diff-viewer.png`（https://github.com/superset-sh/superset ）；opencode `Session / Git / Branch / Last turn changes`。
- 落点：`ReviewView` 的范围菜单目前是 未提交 / 已暂存 / 本次对话 / 某次提交，没有“上一轮”。

**8. 思考块的完整生命周期**
- 怎么动：开始流式 → 自动展开成限高“预览窗”，上下各 32px 渐变遮罩，文字在里面滚；标题是微光「思考中…」；结束 → 停 1 秒 → 自动收起成「思考了 12 秒 ›」；只自动收一次，用户手动开过就不再管。超过一定时间在右侧给一个点状下划线的「直接回答」。
- 来源：AI Elements `reasoning.tsx`（`AUTO_CLOSE_DELAY = 1000`，https://github.com/vercel/ai-elements/blob/main/packages/elements/src/reasoning.tsx ）；assistant-ui `reasoning.tsx`（`ReasoningFade`，200ms）；prompt-kit `thinking-bar.tsx`。
- 落点：`ThinkingBlock`（现在是 `ui.showThinking` 一刀切的开 / 关）。

**9. 流式文字淡入，最新两个词带色**
- 怎么动：每个新 token 100ms ease-out 淡入（最省的做法）；或按词切（`Intl.Segmenter`，中文可用）每词 ~220ms 淡入；更花一点：最新 2 个词先是强调色，700ms 内褪回正文色；末尾一条 2px 宽、圆头、呼吸的光标。整块的新段落（代码块、表格）用 320ms 淡入。
- 来源：Open WebUI `.fade-in-token`（https://github.com/open-webui/open-webui/blob/main/src/app.css ）；prompt-kit `response-stream.tsx`；assistant-ui `streaming-text.tsx`；Superset `block-fade`。
- 落点：markdown 流式渲染。注意 claude-web 用 lowlight 同步高亮、频繁重渲染——按词包 span 的做法要评估成本，100ms 的整块淡入最稳。

**10. “谁需要我”的蓝框 + 侧栏显示最后一句话**
- 怎么动：分屏里需要确认的那个窗格外套一圈 2px 蓝色实线（持续到处理为止）；侧栏对应行亮点 + 第二行直接显示 agent 最后那句话 / 待批准的命令；一个快捷键跳到“最新一条需要我的”；完成时可选提示音 + 任务栏角标。
- 来源：cmux（https://github.com/manaflow-ai/cmux ，`docs/assets/notification-rings.png`）；Superset README（chime + dock badge）。
- 落点：窗格目前只有 `.pane` 焦点色；「需要你」分区只有标题和状态字，看不到 agent 在问什么。

**11. 全窗页盖上来时，底下的应用后退**
- 怎么动：设置页 / 自动化页打开 → 底下整个应用 `scale(0.92) translateY(20px)`、圆角变 16px，0.4s `cubic-bezier(0.16,1,0.3,1)`；关闭 0.3s `cubic-bezier(0.7,0,0.84,0)` 回位。配合已有的 `inert`，用户一眼明白“下面的东西还在、只是暂时退后”。
- 来源：Craft Agents `apps/electron/src/renderer/lib/animations.ts`（https://github.com/craft-ai-agents/craft-agents-oss/blob/main/apps/electron/src/renderer/lib/animations.ts ）。
- 落点：`.modal.settings.sp`、`.main-stack` 上的自动化层。

**12. 输入框和贴在它上面的东西做成“一个物体”**
- 怎么做：输入框用一个被负扩散收住的软投影（`0 12px 28px -18px rgb(0 0 0 / 40%)`）而不是描边；贴在上沿的 RunCard / 权限卡、贴在下沿的状态条，接缝处画 10px 的渐变内阴影，看起来是从输入框后面抽出来的；抽出 / 收回用 `cubic-bezier(0.32,0.72,0,1)`。Vibe Kanban 的变体：把「N files changed +a −b」和 todo 进度做成输入框卡片的顶条。
- 来源：T3 Code `apps/web/src/index.css`（`--shadow-composer`、`--background-image-composer-seam-*`，https://github.com/pingdotgg/t3code/blob/main/apps/web/src/index.css ）；Vibe Kanban 截图。
- 落点：`.composer .run-card`、`PermissionDock`——现在是“同宽内缩、无下边框、顶部圆角”的拼接。

**13. 换掉通用转圈 spinner，做一个有辨识度的**
- 怎么做：4×4 圆角小方点，四角去掉，内圈亮外圈暗，各点周期 1–2s 随机、相位随机地呼吸（像一小块活的像素）；或 3×3 方格按对角线波动（1.3s）。18px、`currentColor`。
- 来源：opencode `spinner.tsx`（https://github.com/anomalyco/opencode/blob/dev/packages/ui/src/components/spinner.tsx ）；Craft Agents `.spinner`（SpinKit Grid）。
- 落点：侧栏行尾、RunCard、步骤节点——目前到处是同一个转圈。成本极低，辨识度高。

**14. 检查点做成对话里的一行，三种还原**
- 怎么做：每轮（或每次写文件后）在对话里出一行「🔖 检查点 ┄┄┄ 对比 · 还原」，点线把图标和按钮连起来、平时很淡；还原弹三选：只还原文件 / 只回退对话 / 两者都；编辑旧消息时提供“还原到这里再重发”。
- 来源：Cline（https://docs.cline.bot/core-workflows/checkpoints ）；AI Elements `checkpoint.tsx`；Zed「Restore Checkpoint」（https://zed.dev/docs/ai/agent-panel ）；1Code「从任意用户气泡回滚」。
- 落点：claude-web 已有 分叉 / 编辑重发 / 审阅里的还原，但三者分散、且“还原文件”是整文件回到 HEAD。需要引擎侧的文件快照支持，所以排在后面。

**15. 多 agent 画成“有角色的人”，首页给“可点的东西”**
- 怎么做（编排）：主 agent 一张卡（名字 + 角色标签 + 在线点 + 一句话状态 + 当前任务及其 状态 · 强度），子 agent 沿一条竖线挂在下面；没上场的排在“板凳席”网格里，一点就加入；对话里每个 agent 的发言带自己的头和技能 chip；输入框旁显示这一轮点了谁。
- 怎么做（首页）：四个起手建议换成分组的图标启动台（做方案 / 写代码 / 审阅改动 / 部署…），或者至少让建议卡按 `y:16 → 0`、0.4s、每张错 60ms 依次浮上来，标题两行先后上浮（延迟 0.35s / 0.5s）。
- 来源：Crow5 `multi-agent-mode.png`、`desktop-welcome.png`（https://www.crow5.com/ ）；Vercel ai-chatbot `greeting.tsx` / `suggested-actions.tsx`；Factory Mission Control。
- 落点：`features/orchestra/`（现在是节点图）和 `workbench/Welcome.tsx`。这是老板点名的参照物里最直观的两处，但做重了容易变花哨，所以放最后——先做 1–3、13，界面气质就已经变了。

### 顺带的三条工程规矩（不算点子，抄了省事）

- **常驻动画只在可见时跑**：`animation-play-state: var(--visible-animation-state, paused)`，IntersectionObserver 置 running（T3 Code）。长对话里几十个微光 / spinner 不会拖慢滚动。
- **微光用 `steps(30)`** 而不是 linear（T3 Code），或用 mask 调 alpha 而不是盖渐变（Sculptor）——后者在有颜色的文字上也成立。按**像素速度**而不是固定时长（assistant-ui tw-shimmer），长短文字观感一致。
- **滚动跟随**：向上滚轮才脱离、嵌套滚动区（`data-scrollable`）里滚不算、自己触发的滚动 1.5s 内不当用户操作、跟随时不用 smooth（opencode `create-auto-scroll.tsx`）。

### 许可证提醒

[V]（GitHub license API 或 LICENSE 文件头）：opencode / assistant-ui / prompt-kit / T3 Code / Sculptor / CodexMonitor / Kilo Code = MIT；Craft Agents / AI Elements / Emdash / Vibe Kanban / Goose / Jean / Cline = Apache-2.0——数值和写法可以直接参考。**cmux = GPL-3.0-or-later（服务端目录另是 BUSL-1.1）、opcode 与 Cherry Studio = AGPL-3.0、Superset = Elastic License 2.0**——这几家只取想法，不要搬代码。Crow5、Conductor、Nimbalyst 的桌面端是闭源产品，只看了官网截图 / 文档。
