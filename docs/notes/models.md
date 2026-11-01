# 多模型管理（2026-09-28）

- **拉模型列表**：`ProviderService.refreshModels(ids?)`（请求 `providers.refreshModels`）对档案并发（上限 4）调 `probeProvider()`——只 GET `/v1/models`（或该类型的等价接口），**从不发对话**。成功写 `models` + `modelsAt` 并清 `modelsError`；失败只写 `modelsError`、**保留旧列表**（中转挂一小时不能把菜单清空）。`upsertProvider` 里值为 `null` 的可选字段会被删掉（`modelsError: null` 就是清错），新增字段要加进那张清理表。启动后 5 秒 `autoRefreshModels()`（unref 定时器）刷新 `needsModelRefresh()` 为真的档案：有 key、从没拉过或超过 24 小时。`providers.probe` 成功时也记 `modelsAt`。列表里给了显示名的（中转转发的 DeepSeek / OpenRouter 的 `name`、Anthropic 的 `display_name`、Gemini 式的 `displayName`；和 id 一样的不算）存在 `Provider.modelNames`（`parseModelList()`，随列表一起换，列表里没有就清掉；快速连接和供应商表单保存时也带上），菜单 / 芯片显示它（`menu.ts` 的 `providerModelName()`，菜单行的 hint 是真实 id，搜索两个都认）：官方 DeepSeek 的 `deepseek-flash` 是「DeepSeek-V4.1-Flash」（2026-10-08 实测，`deepseek-chat` 也映射到它）。
- **统一菜单**是纯函数 `web/src/features/models/menu.ts`（`buildModelMenu` / `filterMenu` / `chipLabel` / `modelTable`，`menu.test.ts` 覆盖）。兼容性 `compatibleTypes(agent)` = `@catalog` 的 `providerTypesFor`：claude → `anthropic` / `claude-account`，别的（`claudeai` 导入）→ 没有。（历史：以前还有 gemini / openai / gateway 类型、网关档案的模型、其它 agent 的分区，2026-11-01 只留 Claude 时删了，见「只留 Claude」。）
- **键**：`ui.disabledModels` / `ui.favoriteModels` 用 `<providerId>:<model>`；官方 Claude 登录沿用历史的**裸模型 id**（老设置页就这么写的，别改）。`ui.recentModels` 是 `recentKey()`：`<providerId>:<model>`，官方 Claude 是 `claude:<model>`。（以前其它 agent 的 `<agent>:<model>` / `@<agent>:<model>` 键留在老设置里，没人读。）
- **会话内切换**：路由是纯函数 `models/route.ts` 的 `routePick()`（`route.test.ts`）：同档案 → `session.setModel`；别的档案 → `session.setProvider {providerId, model}`。「默认模型」项在客户端解析成具体值（Claude 账号 → `default`；档案 → 它的 `defaultModel`，没有就报错让用户选）。服务端 `swapProvider` **换了档案又没给 model 时不继承旧模型**（旧档案的模型 id 在新端点多半不存在），同档案重启才沿用。`session.setProvider` 先用 `ProviderService.fitError()` 校验档案类型（`@catalog` 的 `providerTypesFor` / `profileFitError`，前端菜单用同一张表）；`swapProvider`（`session/swap.ts`）自己在内部按 sessionId 走 `withSessionLock` 串行（federation 交接等绕过 hub 的路径也受保护；锁不可重入，别在锁内再调它们）；`session.open` 带显式 providerId 时同样先过 `fitError`（欢迎页、定时任务、IM、编排新建会话都走这里），前端切换期间芯片禁用。只有切换成功（或确认框点了确定）才记入最近。
- 接不了的类型直接不列（`profileUnavailable`）。（历史：以前「能接但眼下用不了」的整节灰显——ccb 不在时的 openai / gemini / grok 档案、没启用的网关档案；这些类型都删了。）
- 后台写回（`refreshModels`、`probe`）一律 `upsertProvider(…, {mustExist:true})`：刷新途中删掉的档案不会被写回复活。200 但空列表不覆盖旧的非空列表（记 `modelsError`）。`CW_NO_MODEL_REFRESH=1` 关掉启动刷新（`scripts/e2e.mjs` 设了）。远端（`peer_`）会话锁定为只换模型。
- **踩过的坑**：① 菜单挂在窗格里会被 `.pane{overflow:hidden}` 裁掉，所以 `ModelChip` 把菜单 portal 到 body、按锚点算 fixed 坐标（纯函数 `models/place.ts`：哪边空间大开哪边、高度取可用空间且 ≥120、不超视口；ResizeObserver 盯锚点、composer、pane，分屏拖动和输入框变高都跟着走；第一帧之后量一次菜单的自然高度 `need`，偏好的一边放不下就开到空间大的一边——欢迎页输入框在屏幕中间，下面空间更大——之后不再换边，免得边用边跳）。② 通用的 `.menu button{width:100%}` 会把行尾星标按钮撑到 500px、把模型名挤成 0 宽；星标的规则都写成 `.menu.mm .mm-star` 抬优先级。③ `width:max-content` 的弹层里 `flex:1`（basis 0%）的子项在 Chromium 下贡献 0 宽，名字列要 `flex:1 1 auto`。④ shot.cjs 的 JS 里别写 `{section:'models'}` 这种带冒号的字面量（Electron 当 URL 退出），用 `Object.fromEntries`；打开会话后布局存进了截图用的 Electron profile，下一张欢迎页截图要换 `?win=`。
- **调试**：`server/ws-phase16.mjs` 末尾的假上游对 `GET /v1/models` 返回列表，断言每个档案的结果、写回、失败保留、只发了 GET。单测 `server/src/providers/refresh.test.ts` 用 node:http 假 `/v1/models`（按 key 决定行为，数并发峰值）。

## 子代理用的模型（2026-10-14，用户要求）

- **为什么**：用户朋友的子代理全跑在贵的主模型上，额度很快用完。主任务用主模型，子代理换个便宜的。
- **入口**：输入框里模型按钮右边的「子代理」按钮（`models/SubagentChip.tsx`），只有本机的 Claude 对话有（别的机器上的、claude.ai 导入的不显示）。菜单就是模型菜单加了 `subagent` 选项：锁在当前供应商（`lockProvider`），最上面一行「跟主模型一样」，不列收藏 / 最近 / 默认项，没有星标，选了不记进最近；底下一个勾「新对话都这样」（全局设置 `subagentModel`，见下面「子代理用任何模型」）。欢迎页、在跑的对话、没在跑的对话都能选。
- **生效**：`CLAUDE_CODE_SUBAGENT_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`。**新版官方二进制不加 `_FORCE` 时顺序是 工具给的 model → agent 定义的 `model:` → 这个变量**，Explore 定义的是 inherit（带上限），于是跑在主模型上（2026-10-19 真机：Opus 5.5 + DeepSeek，Explore 子代理是 Opus；用户中转上看到的 claude-sonnet-5 也是这么来的）。加了 `_FORCE` 之后变量压过前两者。环境变量只在启动时读：runner 的 `plan().key` 里带 `:sub-<model>`，换了就 `respawnWhenIdle()`（这一轮跑完再换，已经派出去的子代理不受影响）。1M 的 Claude 也加 `[1m]`（`engineModel`）。用官方账号时用户 settings.json 里自己写了这个变量，选了的会用 `--settings` 压过去（`ownOverride`，以前叫 `ownSubagentOverride`）。
- **存哪**：每个对话 `SessionMeta.subagent = { providerId, model }`（`''` = 跟主模型一样，也是一种选择）。纯函数在 `server/src/models/subagent.ts`（前端经相对路径用同一份）。解析在 pool：调用方给了 `subagentModel` 就用并记进 SessionMeta（新对话记在它拿到的 id 下，分叉不记）；没给就是「这个对话选过的」→ 否则新对话默认（`subagentModelFor`）——IM、定时任务、目标、重开都走这里。存法和默认后来改了，见「子代理用任何模型」。
- **请求**：`session.setSubagentModel { sessionId, model, providerId }`（进了联邦路由表）。在跑：`runner.setSubagentModel()`；没在跑：只记 SessionMeta，下次启动用。
- **布局**：这个按钮让输入框那一行变挤了。宽的行（> 560px）里主模型按钮先缩（`flex-shrink: 100`，`.cb-right` 也是），「proj」「深入」这些短的保持完整；没选时「子代理」三个字不缩。窄的行（分屏、手机）只剩图标，选了模型时图标是强调色。
- **测试**：`server/src/models/subagent.test.ts`、`runtime/session-runner.test.ts`（环境变量、换了重启、`[1m]`）、`runtime/pool.test.ts`（解析和记录）；e2e `server/ws-phase28.mjs`（假上游 + 官方二进制：主对话请求用主模型、子代理请求用选的；改回跟主模型一样后子代理用主模型；旧的按供应商默认）；ui-smoke `subagent-chip` 段。真中转 super-nb 实测：Sonnet 5.5 主模型 + Haiku 4.5 子代理，子代理的 transcript 和 modelUsage 都是 Haiku；改回后子代理是 Sonnet 5.5。

## 挑要用的模型（2026-10-15，忍冬的反馈）

- **挑模型**：`web/src/features/settings/ModelPicker.tsx`（搜索、全选 / 全不选、勾选；`withPicked` / `pickedOf` 是纯函数，`model-picker.test.ts`）。写的是现成的 `ui.disabledModels`（`<providerId>:<model>`，和 设置 → 模型 的开关同一份），不另起一份允许名单——所以以后刷新多出来的模型默认是显示的。入口在供应商编辑页「用哪些模型」（`ConfigPanel.tsx`）；**新加的供应商**「测试连接」成功且模型多于 3 个时自动弹一次。新供应商还没有 id：挑的结果先放在表单里，保存拿到 id 再写。`probe.ok` 为假（对话测试没过）时表单本来就不存列表，所以也不弹。
- （历史：同一天还加了「Codex 报的列表」——`agents/reported-models.ts` 问 `codex app-server` 的 model/list；随 Codex 一起删了。）

## 子代理用别家的模型 / 任何模型（2026-10-17～18，已删 2026-11-01）

历史。当时子代理可以选**别的供应商**的模型（`cw-x:<供应商>:<模型>`），runner 把 `ANTHROPIC_BASE_URL` 换成网关的分流路由
（`gateway/split.ts`、`GatewayService.serveSplit`），按模型别名 `cw-sub/…` 把子代理请求送到另一家、主请求原样转；设计
`docs/superpowers/specs/2026-10-18-subagent-any-model-design.md`。网关删了以后**没有从一家转到另一家的路**：
`subagentTarget(value, 主供应商)` 只在选择的供应商就是主对话的供应商时给出模型，否则 `null` = 子代理跟主模型（不报错）；
子代理菜单锁在当前供应商，所以新选的总是同一家。留下来的是存法：

- **选择是整对（供应商, 模型）**：一律存 `cw-x:<供应商>:<模型>`（账号是 `claude`，`crossValue` / `crossPick`）。以前存的普通 id 按记录它时的
  `subagent.providerId` 补全（`fullPick`）；对话换供应商不作废（换回那家又生效）。新对话默认是全局设置 `subagentModel`（菜单底下「新对话都这样」）；
  没有它时才读旧的 `subagentModels`（按供应商）补全。`subagentModel` 设成 `''` 也算设过（新对话跟主模型），会盖住旧的那份。
- 测试：`models/subagent.test.ts`、web `subagent-cross.test.ts`、`session-runner.test.ts`、`pool.test.ts`。
- 账号走用户自己 settings.json 里的中转时，我们设的 `CLAUDE_CODE_SUBAGENT_MODEL` 仍经 `--settings` 压过去（`ownOverride`，`user-env.test.ts`）。

## DeepSeek V4 的上下文窗口 / 改了供应商设置对正在跑的对话生效（2026-10-19 用户报告：缓存率低）

- `knownContextWindow` 以前把所有 `deepseek` 当 128K。中转的 deepseek-v4.1-flash 在 128K 上每 1.5–2 分钟自动压缩一次，后期每一轮都压缩
  （压缩后上下文已经接近上限），缓存命中 26–33%；用户把窗口设成 1M 后：201 次调用不压缩、提示到 272K、命中 97%。
  api.deepseek.com 自己的模型列表给 `deepseek-v4-pro` / `deepseek-flash` 报 1,048,576。现在 `deepseek-v4+` / `deepseek-flash` / `deepseek-pro` → 1,048,576，
  其它 deepseek（chat / reasoner / v3.x）还是 128K。
- 窗口（官方二进制的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`；以前 ccb 还有 `CLAUDE_WEB_CONTEXT_WINDOWS`）是进程启动时读的，runner 的 `provider` 也是开的时候拿的：
  以前在设置里改了窗口，正在跑的对话照旧。现在 `providers.upsert` 之后 `pool.providerSaved(id)` → 这个供应商上每个 Claude 对话 `runner.reprovide()`：
  设置有变（不算 `modelsAt`）就等这一轮跑完重开进程（resume），没变什么都不做。只有用户在设置里保存才触发，后台刷新模型列表不触发。

## 自动压缩点 / Claude 账号的 200K · 1M（2026-10-24 用户：「有时候新对话还是 Opus 5.5 200k，很怪」，spec 2026-10-24 「A7」）

- **现象**：账号上普通的 `claude-opus-5-5` 是 200K，只有 `[1m]` 才是 1M（runner `windowOf`），所以从菜单直接选 Opus 5.5 的新对话落在 200K；
  另外用户 `~/.claude/settings.json` 的 env 有 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000`，界面上看不出来压缩点是哪来的。
- **做了什么**：① 「自动压缩」：每个供应商 `Provider.compactAt`、自己的登录设置键 `claude.compactAt`、「其它 Claude 账号」档案自己的 `compactAt`；
  设了就写 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（和官方二进制自己算的提前压缩点取小：`effectiveCompact`），压过 settings.json（见 `engine-providers`
  笔记「A7」那条）；不设 settings.json 照旧。输入 50K 起、不超过该模型窗口（`compactAtOk`）。runner 里 50K 以下不用；**超过当前模型窗口的封顶到窗口**
  （`userCompact` = `min(值, 窗口)`，窗口不知道就照用）——账号的值是按最大的那一族检查的，700K 碰到 200K 的 Sonnet 以前被直接丢掉，settings.json
  又赢了，和编辑框说的「设了就以这里为准」相反（最终审查 M4）。官方二进制把这个变量的下限定在 100K，所以 `info.compactWindow` 报
  `max(值, 100K)`（M6）。编辑框里点「在这个大小时压缩」时，settings.json / 环境里的值只有在这个窗口下合格才预填，否则留空（M2）。
  ② 账号的窗口：自己的登录设置键 `claude.contextWindows`（`opus` / `sonnet` / `fable` → `200000 | 1000000`，没写 = 1M），档案用自己的
  `contextWindows`（同样的族键）；选 1M 的族在账号上一律带 `[1m]`（`accountModel`，子代理模型也一样），haiku 固定 200K，`default` 不动。
  帮手在 `server/src/models/account-window.ts`（web 别名 `@account-window`）。③ 看得到：`info.contextWindow`（+ 原有的 `info.compactWindow`），
  上下文卡标题行下面一行「窗口 1M · 700K 内压缩」（`.info-card[data-card="context"] > .ic-window`；spec 写的是放在标题行上，但和折叠时的百分比、
  小条挤在 288px 的一行里，「上下文」被挤成一字一行、英文把小条挤出卡片，所以挪到下一行）、小环按 `min(窗口, 压缩点)`，模型菜单 Claude 行标 1M / 200K。
  ④ 编辑：设置 → 账号与登录 → Claude 账号「编辑」（`AccountWindows.tsx`，档案行也有「编辑」），供应商编辑页的「自动压缩」（`CompactAt.tsx`）；
  「现在：…」那一行来自 `config.compactSource`（settings.json / 环境 / 没有）。
- **改了对在跑的对话**：自己登录的设置走 meta 的 `'changed'` → `pool.accountPrefsChanged` → `runner.setAccountPrefs`（等空闲重开进程；
  窗口变小且用量超过新窗口 80% 先 `/compact`，同 `fitBeforeSwitch`）；档案 / 供应商走原来的 `providerSaved → reprovide`——「其它 Claude 账号」
  的档案窗口变小也先压缩（`fitForShrink`，两条路共用；正在跑一轮就等结束，`deferredChange`，最终审查 I2）。
- **两次保存只算一次**（最终审查 I1）：编辑框先存 `claude.contextWindows` 再存 `claude.compactAt`，两个 `'changed'` 只差几毫秒；以前两次
  `setAccountPrefs` 都过了忙闲检查、各发一次 `/compact`，或者一个在进程里 `setModel`、一个重启，`setModel` 失败又重启一次，留下两个引擎进程。
  现在三层都挡：pool 把 400 ms 内的保存合成一次推送（`ACCOUNT_PREFS_DEBOUNCE_MS`）；`fitBeforeSwitch` 同时只跑一个（后来的等它，问完用量再查一次
  忙闲 / 进程有没有换）；`setAccountPrefs` 的 `setModel` 失败时只有自己还是最新一次才重启；`respawn()` 正在跑时再调用就并进去。
  pool 的 `accountKey` 只在推送时（和启动时）更新，`open()` 不再改它：保存写盘期间新开的对话读到了新值，以前就把这次变更当成推过了，旧对话收不到（M1）。
- **「默认 1M」只在 Max 账号上实测过**：套餐没有长上下文的账号发 `[1m]` 会被拒，让用户在「编辑」里把对应的族改成 200K。
- **坑**：
  - 账号的 plain id 就是 200K——以前只有带 `[1m]` 的选项才是 1M，现在默认 1M 是我们加的后缀，不是 CLI 的。
  - 自己的登录走用户自己的中转（settings.json / 环境里有 `ANTHROPIC_BASE_URL` / token）时**不改模型名**（那个中转可能不认 1M beta），
    压缩点照样生效；但模型菜单的 1M / 200K 标记照设置显示，可能和实际（中转上 200K）不一致。小环和卡片标题用 server 报的窗口，是对的。
  - server 报的窗口压过前端的猜测（`estimateContext` 有 `contextWindow` 就不再按用量涨到 1M）：窗口刚改小、还没压缩的对话、或钉在 200K 的不认识的模型，
    小环会显示 100%，这是有意的。
  - `info.compactWindow` 可能比窗口还大（200K 的 Opus + settings.json 的 700000），前端取小，别把它当真正的压缩点。
- **测试**：单测 `account-window.test.ts`、`session-runner.test.ts` 的 A7 一组、`pool.test.ts`、`compact-model.test.ts`、`stats.test.ts` / `info-model.test.ts` / `menu.test.ts`；
  e2e `server/ws-phase32.mjs`（假上游 + 真引擎，临时 HOME 的 settings.json 写 700000：账号 / 档案的 Opus 默认带 context-1m beta、设 200K 后不带、
  开着的对话收到 200K；压缩点 500K / 150K / 供应商 400K 在引擎里 `echo` 出来压过 700000）；ui-smoke 的 `a7` 段（编辑框、供应商编辑页、卡片标题含英文宽度、菜单标记）。
  e2e 里账号对话经对话自己的环境（`features.env` 的 `ANTHROPIC_BASE_URL`）接到假上游——不经 settings.json，所以不算「用户自己的中转」，走的是真账号那条路。

## 思考用的语言（2026-10-19，用户要求：照 DeepSeek Harness 插件 dsh-thinking-language）

- 纯提示词：在系统提示的 `append` 后面加一节 `# Thinking language`（`server/src/runtime/thinking-language.ts` 的 `thinkingLanguagePrompt`），
  让模型用某种语言写思考过程，代码 / 标识符 / 路径照旧，**回答仍跟着用户说的语言**。和 `.claude/launch.json` 的自动验证那段用空行接在一起。
- 设置键 `ai.thinkingLanguage`（设置 → 模型与智能程度 → 思考用的语言）：`''` / `'off'` / 没设 = 不指定（默认，不加任何字）；`'auto'` = 跟随界面语言
  （`getLocale()`：zh → 简体中文，en → English）；其余是语言 id（zh-CN / zh-TW / en / ja / ko / fr / de / es / ru / pt / ar，未知 id 当没设）。
  每个对话可以单独改：`SessionMeta.thinkingLanguage`（对话头 ··· 菜单的「思考语言」，`ThinkingLanguageRow.tsx`）：`''` = 跟随设置，`'off'` = 这个对话不指定。
  server 端在 `index.ts` 启动时 / `settings.set` 时用 `setThinkingLanguageSetting()` 存一份；pool 开 runner 时把对话自己的那份当第三个参数给它。
- 为什么只放系统提示、不在每条用户消息前加提醒：系统提示稳定，前缀缓存不受影响；每条消息前加隐藏前缀要改 reducer 藏它、改历史回显，
  还会把每轮的缓存前缀切碎。代价是进程启动时才读：改了（设置、对话自己的、界面语言变了而设置是 auto）→ `pool.thinkingLanguageChanged()` →
  `runner.refreshThinkingLanguage()`：算出来的那段字和进程启动时的不一样才 `respawnWhenIdle()`（这一轮跑完再 resume），一样就什么都不做。
- 对任何供应商都一样（Claude 账号 / 其它 Claude 账号 / Anthropic 格式中转）：都是 SDK 的 `systemPrompt.append`。菜单里那一行只给本机的 Claude 对话。
- 分叉出来的对话开的时候跟父对话的设定；新 id 没有单独记，下次重开跟设置走。
- 测试：`server/src/runtime/thinking-language.test.ts`（解析与文字）、`session-runner.test.ts` 的「思考用的语言」（进系统提示、改了重启一次、一样不重启）、
  `web/src/features/settings/thinking-language.test.ts`、`catalog.test.ts`。语言自称的名字在两个文件里（server 的那份给提示词用），都进了 `coverage.test.ts` 的 ALLOWED。

## 子代理硬绑定：设了子代理模型，主模型就把活派给子代理（2026-10-19 用户要求）

- 用户：「子代理设置什么样，那就会派什么子代理，硬绑定，不要用户在提示词还要另外 trigger」。以前设了子代理模型，主模型要不要派子代理全凭它自己判断，常常自己干完了；用户得在提示词里写「用子代理」。
- 做法（`runtime/subagent-policy.ts`）：对话选了子代理模型（不是「跟主模型一样」），系统提示词末尾加一段 `# Subagents`：这是用户的常设指令，默认用 Agent 工具把探索 / 读文件 / 调研 / 范围清楚的实现 / 跑测试 / 审查交给子代理，独立的并行派，主模型只留理解需求、规划、决定、整合、管计划和跟用户说话——凡是要动工具（读 / 搜文件、跑命令、改代码）的都交给子代理，再小也一样（2026-10-19 真机：第一版允许「几步就完的小事自己做」，Opus 读三个小文件就没派）；每个子代理给完整的简报；不要给 Agent 工具传 `model`。只聊天的对话不加。模型本身的绑定还是 `CLAUDE_CODE_SUBAGENT_MODEL`（压过 agent 定义的 `model:` 和工具调用给的模型）。
- 子代理模型在 plan key 里（`:sub-<model>`），换了会重启进程（等这一轮和后台子代理都结束），这一段跟着重新读。测试：`subagent-policy.test.ts`、`session-runner.test.ts`「a subagent model picked → the work is delegated」。
- 这是提示词，不是强制：主模型偶尔仍可能自己动手；不用工具就能答的问题它直接答。
- 真机（当时用的 `scripts/real-subagent-split.mjs` 已随分流路由删掉；Opus 5.5 主模型 + 另一家的 deepseek-v4.1-flash 子代理，提示词不提子代理，项目里放几个小文件）：加 `# Subagents` 段之前 Opus 自己读完；第一版段落（允许「几步就完的小事」）也自己读；声明「压过 Agent 工具说明里 读指定文件用 Read 的建议」之后派了 Explore；再加 `_FORCE` 之后 Explore 的 transcript 是 `deepseek-v4.1-flash`。`[Agent call]` 那行打印主模型调 Agent 的参数。

### 思考用的语言：每轮提醒 + Claude 的限制（2026-10-20 用户：换了语言思考还是英文）

- **2026-10-22 撤掉了每轮提醒**：开着它时，`claude-opus-5-5` 和 `claude-fable-5-1` 在这个应用里频繁被接口判「appears to violate our Usage Policy」（账本里 opus-5-5 官方请求约 20% 被拒，`deepseek-v4.1-flash` 只有 0.1%），而官方桌面版同模型、同权限模式（都是 bypass）、同一段对话不拒；用户把思考语言设成「不指定」后，同一对话马上能继续 → 触发源是提醒。现在只留系统提示里的一节，措辞也改平（`Think in …` 一句，去掉 chain-of-thought / analysis / planning / deliberation 这种「改写思维过程」的说法）。代价：Claude 可能又用英文思考（本来也管不住，见下面那条）。
- 只有系统提示那一段不够，照参考插件加了**每轮提醒**（2026-10-20，2026-10-22 已撤）：SDK 钩子 `UserPromptSubmit` / `PostToolUse` 返回 `additionalContext`，引擎把它作为 system reminder 放进最新一条消息，对话里不显示，也不动缓存前缀。
- 假上游抓包（`cw-real/fake-upstream.cjs`）确认请求里有 `# Thinking language` 段和 `[Thinking language]` 提醒。
- 真机（当时还能接 OpenAI 格式）：DeepSeek V4.1（aizhongzhuan）设日语 → 三段思考全是日语；设简体中文 + 中文提问 → 中文。**Claude（Opus 5.5，账号）不照做**：连用户消息里直接写「思考过程必须全部用简体中文」都还是英文——Claude 显示的思考是官方的摘要（`thinking.display: summarized`），语言我们管不了。设置里的说明写了这一点。

## 工作流里的代理显示成主模型（2026-10-30 用户报告：「子代理没有按我设置的来，还是用的主代理模型」）

- 用户：主模型 Magpie（Anthropic 格式，当时的免费来源，已删）上的 routego/gpt-6.1-sol，子代理选另一家的 DeepSeek V4.1 Flash（当时经分流路由，已删），深度编排。工作流卡片和悬停都写 routego/gpt-6.1-sol。
- 查下来**请求是对的**：`.probe/wf-sub.mjs`（照 `ws-phase28.mjs` 的假上游，主轮调 Workflow 工具，脚本里一个 `agent()`）——工作流代理的请求是
  子代理模型。CLI 的工作流（当时看的是 ccb 源码 `claudeCodeBackend.ts`）真跑走 `runAgent → getAgentModel`（`CLAUDE_CODE_SUBAGENT_MODEL` 优先），但进度里报的是
  `params.model ?? mainLoopModel`，所以**显示错**。
- 修法：runner 记下这个进程真正给子代理的模型（`subRuns`），收到 `workflow_progress` 时把每个 `workflow_agent.model` 换成它
  （`trackBackground` 之前，聊天里的运行卡和后台页都用这一份）；跑完的 run 文件（CLI 自己写的，同样是主模型）在 `disk.ts readRun` 里按每个代理自己 transcript
  第一条助手消息的 model 改（`firstModel`）。运行行「routego/gpt-6.1-sol · 任务输出」是主对话自己在等 TaskOutput，那是对的。
- 测试：`session-runner.test.ts`「a workflow's agents are reported on the subagent model」、`disk.test.ts`「an agent's model is what its own transcript asked for」。
