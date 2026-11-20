# 界面改版（2026-11）阶段 2：设置弹窗 / 自定义（2026-11-20）

方案：私有 Artifact「Claude Web 新界面」第 7 版（#ia、#pages「设置弹窗」「自定义」、#phone、#plan 阶段 2）。接着「界面改版
（2026-11）阶段 1」：设置从整窗页变成弹窗、4 组 14 页；MCP / 插件 / Skills 离开设置（自定义有）；配置中心拆掉；自定义
四个标签；手机上设置是推进来的整页。**这一篇和「界面改版 阶段 6：设置重组」冲突的地方以这一篇为准。**

## 设置弹窗

- `SettingsModal.tsx`：`SettingsModal` 先看 `awayTarget(open)`（下面「离开设置的」），是就直接去新地方、不挂弹窗（没有
  一闪）；否则挂 `SettingsDialog`。结构：`.sp-layer`（fixed 全窗，grid 居中）> `.sp-scrim` + `.modal.settings.sp`
  （最大 1080×800，左栏 248px）。左栏 `.sp-nav`：搜索框 · 四组（`.sp-g[data-group]`，组之间一条发丝线，**桌面不显示组名**，
  照 mock）· 版本行；右边 `.sp-main`：右上角 ×（`.sp-x`）+ 滚动区。Esc 先清搜索再关，× 关；`coverApp` 让底下的应用
  inert，关掉时焦点回到原处。`cover.ts` 的 `ABOVE_COVER` 加了 `.win-ctl`（桌面版窗口按钮不被盖住）。桌面版弹窗从标题栏
  下面开始，上面那条能拖窗口。
- 打开：账号菜单「设置」、账号行 ⚙、Ctrl+,，`openSettings({ section?, tab?, query?, reveal? })`（加了 `tab`，旧调用不用改）。
  弹窗开着时再调：有页就换页，没有（Ctrl+, 再按）就留在这页、清空并聚焦搜索。
- **手机**（`.sp-layer.phone`）：一列卡片，组名在卡片上面；点一行推进那一页（`.phone-page`），页顶 `‹ 标题 ×`；系统返回键
  先退回列表再关（两层 `pushBackLayer`）。搜索框 16px、没有「/」提示；有搜索时列表顶栏和搜索框留着、结果占下面。行里宽的
  控件（选择、分段、输入框）放到说明下面（问题 11），单独一个开关留在右边；**整行能点**：`EntryRow` 的 `rowTap` 只在手机上、
  只在 `.ctl` 里只有一个 `[role=switch]` 时替它点。开关 51×31（`phone.css`，共用组件的手机尺寸归这一阶段），点按圈 45 高
  （`::before`，旋钮是 `::after`）。
- **说明里不出现键盘字**（问题 8）：`EntryMeta.touchHint` 是手机上的那句（查看模式、下一句提示、显示工作台工具、编辑器自动
  保存四行），`catalog.test.ts` 用 `KEYBOARD_WORDS` 查：带 Ctrl / 按 Tab / Enter / ⌘ 的行必须有 touchHint，touchHint 里不能有。

## 4 组 14 页（`catalog.ts`）

| 组 | 页（id） |
| --- | --- |
| 账号 | 账号与登录（account，更多选项：运行内核）· 用量与账本（usage = 右侧面板的 UsagePanel） |
| 应用 | 外观（appearance：开场 + custom.css）· 通知与窗口（window）· 手机与远程（remote：远程监听、其它电脑、IM；更多选项：在外面也能用、SSH 主机）· 隐私与密钥（secrets：密钥 + 打开隐私） |
| Claude Code | 对话（conversation，默认页）· 模型（model：来源 · 路由 · 模型 三个标签）· 联网与浏览器（web）· Agents 与子代理（agents）· 记忆与对话库（memory：共享记忆 + 对话库） |
| 高级 | 环境变量（env：本机 + settings.json 的）· Hooks 与 settings.json（hooks）· 诊断与更新（diagnostics：诊断包、更新、命令行工具） |

- **通用拆成两页**：新对话 / 显示 / 对话之间 / PR 与 MR 这些到「对话」，通知 / 窗口 / 工作台 / 软件渲染到「通知与窗口」。
  `catalog.test.ts` 的 `SPLIT` 记了每一行去了哪页。
- `EntryMeta.tab`：行只出现在页的某个标签上（思考用的语言在 模型 › 模型）；`entriesOn(section, tab)` 过滤，`moreHint`、
  搜索的 reveal 都按它走。
- 页名「对话」「模型」「来源」「环境变量」用 `trAs(中文, 英文)`：同一个中文在别处已有英文（「对话」= Conversation 单数），
  这里要复数 / 别的词。
- **旧 id**：`LEGACY_SECTIONS`——general / session → 对话，interface → 通知与窗口，engine → 账号（更多选项），models /
  providers / gateway → 模型的三个标签，subagents，im → 手机与远程 #im，library → 记忆与对话库 #library，raw → Hooks #raw，
  update / tools → 诊断与更新。和别的部分同页的打开时滚到那一块（`body`）。`catalog.test.ts` 把 2026-09 的平铺 id 和阶段 1
  的 id 全列着，每个都要落地。
- **离开设置的**（`AWAY_SECTIONS`）：mcp → 自定义 › 连接器，plugins → 插件，mcp-json → 连接器的「手动添加（JSON）」表单，
  skills → Skills，bots → 自动化 › Bot › 设置；`reveal: 'bots.*'` 也去那里并高亮那一行。`goAway()` 先关设置再
  `openExtensions(tab, { json })` / `openBotSettings(reveal)`。搜索照样搜得到：Bot 的行在结果里原样可改（`away-entry`，
  面包屑「自动化 › Bot › 设置」），MCP / 插件 / Skills 是一行跳转（`away`）。
- 设置 › 模型 顶上「账号额度、每一轮去了哪个模型、用量和费用，在模型看板里看 [打开看板]」（`HubLinks.tsx` 的
  `ModelHubLink`，关设置再 `openHub()`）；隐私与密钥里的「打开隐私」→ `openHub('privacy')`。模型菜单的「管理来源」不变
  （`openHub('sources')`）。

## 配置中心拆掉

- `features/panels/ConfigPanel.tsx` 删了，它的零件搬到 `settings/config-parts.tsx`（Overview 的运行内核、SimpleList、
  settings.json 原文 `Settings`、`ProviderProfiles`、`McpAddJson`、`MCP_CHANGED` 等），设置和自定义从这里引。
- 右侧面板的 `config` 从 `PANELS` 去掉；`sanitizeLayout` 丢掉存档布局里已经不存在的面板标签（老布局里开着配置中心的不会
  空一块）。Ctrl+Shift+4（`panel.config`）空出来了；桌面版菜单「配置中心（右侧面板）」、⚙ 的右键都去掉。
- 命令面板认旧名字（`palette/moved.ts`）：配置中心 → 自定义 › 插件 / 设置 › Hooks 与 settings.json / 设置 › 环境变量；
  通用 → 设置 › 对话 / 通知与窗口；共享记忆 → 设置 › 记忆与对话库；值班 Bot → 自动化 › Bot › 设置（`to: 'bots-settings'`）；
  Artifact 类型 → 自定义 › Artifact 类型。
- 设置 › Agents 卡片上原来也叫「配置中心」的按钮（其它 agent 的配置编辑，「其它 agent 的配置中心」那篇）改叫**配置文件**，
  免得和拆掉的那个混；搜索关键词两个名字都留着。

## 自定义

- 标签顺序 Skills · 连接器 · 插件 · Artifact 类型（`EXTENSION_TABS`，默认 Skills）。`openExtensions(tab?, { json })`：
  `json` 让连接器页展开 JSON 表单（`askJson` 计数，`.cx-json`）。Skills 的备份从设置搬到 Skills 标签底下。
- **Artifact 类型**（`ArtifactTypesView.tsx`）是占位：open-artifact 还没接，没有内置类型可列、也没有开关。只列用户自己
  放的：服务端 `library/artifact-types.ts` 读 `~/.agents/artifact-types/*`（open-artifact 的用户类型目录），一个文件夹
  一个类型——有 `artifact-type.json` 读 title / name / summary / version，有 SKILL.md 读 front matter，只有
  `index.html` 也算（claude.ai 的格式）；请求 `artifactTypes.list`。没有就是空状态 `EMPTY.artifactTypes` + 怎么自己加 +
  「打开这个文件夹 / 重新读取」。**不编内置列表。**
- 手机：标签行和连接器分类各一行、横着滑（问题 13，`.over-tabs` / `.cx-cats`），搜索框 44 高。

## 自动化 › Bot › 设置

`bots/BotSettings.tsx`：Bot 页多一个 `view: 'settings'`，花名册标题旁的 ⚙（`data-act="bot-settings"`）打开；画的是设置
自己的行（`EntryRow` + `BOT_ENTRIES`，七行，和原来 设置 › 值班 Bot 一样存）。Esc 回到对话；手机上在 thread 那一屏。Bot 页
别的组件没动。

## 路径文字

报错说明、提示里写的设置路径都换成新的（设置 → 模型 → 来源 / 路由、手机与远程、通知与窗口）：server 的 explain /
federation / gateway / im / providers / session-runner，web 的 health、tokens、quick、QuickConnect、云端对话框等。
**没改的**：`web/src/shell/*`（手机壳也连旧版桌面）、`chat/PermissionCards.tsx`（阶段 4 的）、`sidebar/hint.tsx`（阶段 3
的）——里面还有旧名字的话合并后再看。

## 手机体检（ui-smoke 的 phone-audit 段）

- 新加的范围：自定义四个标签整页、设置列表；设置每一页（含标签和更多选项）在 390×844 浅色全查，360 / 430 和深色查最挤的
  四页（账号、手机与远程、模型、Agents）——全查六遍会让 ui-smoke 超时。另外一段查行为：14 页 4 组、点一行推进去 ‹ 回来、
  搜索 16px 没提示、开关 51×31 整行能点、宽控件在说明下面、没有键盘字。
- 体检的 `overflowX` 只看整页；设置页自己的滚动区横滑它看不见，所以每页另查 `.sp-scroll` 的 `scrollWidth`。
- 为了过 44：`phone.css` 里一条规则管设置 / 自定义 / Bot 设置——输入框、选择、分段控件的选项真的 44 高；按钮、chip、标签、
  链接画的大小不变，点按圈用 `::after` 长到 44；**说明句子里的链接真的 44 高**（inline-block）——长出去的圈会盖住说明
  下面那个控件的上沿。分段控件的选项自己 `overflow: hidden`（字太长打 …），`::after` 被裁掉，所以只能真的变高。
- 各部分的正文是给桌面那一栏写的，手机上：`.row` 允许折行（`.grow` 至少 160px，按钮放不下就到下一行）；用内联样式
  `display: flex` 的标题行（Agents、其它机器、机器人…）折行，说明句子排到最后一行；Agents 卡片第一行点 + 图标 + 名字，
  开关和按钮下一行；`code` 变 inline-block（几个地址挨着没有空格，原来是一个拆不开的长「词」）；`overflow-wrap:
  break-word`（settings.json 路径）。
- `phone-audit.cjs`：中心落在窗口最后一行 / 一列像素上的控件当作不在屏上（`elementFromPoint` 在那儿返回 null，报成
  「被盖住 ← ?」）。

## 坑

- ui-smoke 读 catalog 的正则：标签的 `l: trAs('…', '…')` 里有逗号，原来的 `[^,]+` 读不到，模型页的三个标签全丢；
  `i18n-smoke.cjs` 有同一份解析，一起改了。
- 自定义现在 Skills 在前：`document.querySelector('.ext-page .cx-search input')` 拿到的是 Skills 的搜索框，测试里要带上
  `.ext-body[data-body="connectors"]`。
- Bot 页是自己的 `OverPage name="bots"`（`.bots-page`），不是 `.auto-page[data-tab=bots]`。
- 标题字：`heading-text.ts` 是 14 个页名，`npx tsx scripts/subset-heading-font.ts` 重切了 `cw-heading.woff2`；合并时冲突
  就合完 `heading-text.ts` 再切一次。

## 和方案不一样的地方

- 模型看板没有并进设置：设置 › 模型 是来源 / 路由 / 模型三个标签 + 一个「打开看板」整页打开；「管理来源」照旧直接去看板的
  上游。
- Artifact 类型只是占位（只列 `~/.agents/artifact-types`），每种一行的开关 / 用在哪些项目 / ⋯ 要等 open-artifact。
- 桌面导航不写组名、只画分隔线（mock 就是这样）；手机写组名。
- Agents 卡片的「配置中心」改名「配置文件」（方案没提，名字冲突）。
