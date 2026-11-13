# 多模型管理（2026-09-28）

- **拉模型列表**：`ProviderService.refreshModels(ids?)`（请求 `providers.refreshModels`）对档案并发（上限 4）调 `probeProvider()`——只 GET `/v1/models`（或该类型的等价接口），**从不发对话**。成功写 `models` + `modelsAt` 并清 `modelsError`；失败只写 `modelsError`、**保留旧列表**（中转挂一小时不能把菜单清空）。gateway 档案跳过。`upsertProvider` 里值为 `null` 的可选字段会被删掉（`modelsError: null` 就是清错），新增字段要加进那张清理表。启动后 5 秒 `autoRefreshModels()`（unref 定时器）刷新 `needsModelRefresh()` 为真的档案：有 key、非 gateway、从没拉过或超过 24 小时。`providers.probe` 成功时也记 `modelsAt`。列表里给了显示名的（DeepSeek / OpenRouter 的 `name`、Anthropic 的 `display_name`、Gemini 的 `displayName`；和 id 一样的不算）存在 `Provider.modelNames`（`parseModelList()`，随列表一起换，列表里没有就清掉；快速连接和供应商表单保存时也带上），菜单 / 芯片显示它（`menu.ts` 的 `providerModelName()`，菜单行的 hint 是真实 id，搜索两个都认）：官方 DeepSeek 的 `deepseek-flash` 是「DeepSeek-V4.1-Flash」（2026-10-08 实测，`deepseek-chat` 也映射到它）。
- **统一菜单**是纯函数 `web/src/features/models/menu.ts`（`buildModelMenu` / `filterMenu` / `chipLabel` / `modelTable`，`menu.test.ts` 覆盖）。兼容性 `compatibleTypes(agent)`：claude → 全部类型；gemini → gemini / gateway；codex 与其它 ACP → openai / gateway（和 server `providerEnv` / `agentLaunch` 实际接得上的一致，`agentLaunch` 为此补了 Gemini CLI 用 gemini 类型档案）。网关档案的模型 = 组成员模型 + 成员固定模型 + 默认模型 + modelMap 非通配键，与 `GatewayService.serveModels` 同口径（前端从 `gateway.status` 自己算）。**其它 agent 也是同一张平铺表里的几节**（`otherAgents` → `kind:'agent'` 的 section，id `agent:<kind>`，条目带 `agent`，key 沿用 `<agent>:<model>`；没装的整节灰显「未安装」），不进收藏 / 最近、没有星标；档案只按**当前** agent 的兼容性列一次。
- **键**：`ui.disabledModels` / `ui.favoriteModels` 用 `<providerId>:<model>`；官方 Claude 登录沿用历史的**裸模型 id**，其它 agent 自带的模型是 `<agent>:<model>`（老设置页就这么写的，别改）。`ui.recentModels` 是 `recentKey()`：`<providerId>:<model>`，官方 Claude 是 `claude:<model>`，其它 agent 自己的登录是 `@<agent>:<model>`（否则 Codex 的「默认模型」会出现在 Claude 的最近里）。
- **会话内切换**：路由是纯函数 `models/route.ts` 的 `routePick()`（`route.test.ts`）：同档案 → `session.setModel`；别的档案 → `session.setProvider {providerId, model}`。「默认模型」项在客户端解析成具体值（Claude 账号 → `default`，外部 agent → 它配置的默认模型，没有就报错让用户选；档案 → 它的 `defaultModel`）。服务端 `swapProvider` **换了档案又没给 model 时不继承旧模型**（旧档案的模型 id 在新端点多半不存在），同档案重启才沿用。`session.setProvider` 先用 `ProviderService.fitError()` 校验 agent / 档案类型 / 实际引擎（`@catalog` 的 `providerTypesFor` / `profileFitError`，前端菜单用同一张表）；`swapProvider` / `swapAgent` 自己在内部按 sessionId 走 `withSessionLock` 串行（federation 交接等绕过 hub 的路径也受保护；锁不可重入，别在锁内再调它们）；`session.open` 带显式 providerId 时同样先过 `fitError`（欢迎页、定时任务、IM、编排新建会话都走这里），前端切换期间芯片禁用。只有切换成功（或确认框点了确定）才记入最近。
- **不可用 ≠ 不兼容**：agent 接不了的类型直接不列；能接但眼下用不了的整节灰显并写原因——Claude 会话跑在官方二进制上（档案强制 `runtime:'claude'`，或 ccb 不在时的静默回退，前端按 `engine.info` 的 runtime / fallback 推断，见 `effectiveRuntime()`）时的 openai / gemini / grok 档案；网关没启用或组不存在的网关档案（`gateway.status` 没到之前不判定）。
- 后台写回（`refreshModels`、`probe`）一律 `upsertProvider(…, {mustExist:true})`：刷新途中删掉的档案不会被写回复活。200 但空列表不覆盖旧的非空列表（记 `modelsError`）。`CW_NO_MODEL_REFRESH=1` 关掉启动刷新（`scripts/e2e.mjs` 设了）。外部 agent 会话现在也记 `SessionMeta.providerId`（resume 沿用）并由 pool 往 info 里写 `providerId/providerName`，芯片才能显示 `档案 / 模型`。远端（`peer_`）会话锁定为只换模型。
- **踩过的坑**：① 菜单挂在窗格里会被 `.pane{overflow:hidden}` 裁掉，所以 `ModelChip` 把菜单 portal 到 body、按锚点算 fixed 坐标（纯函数 `models/place.ts`：哪边空间大开哪边、高度取可用空间且 ≥120、不超视口；ResizeObserver 盯锚点、composer、pane，分屏拖动和输入框变高都跟着走；第一帧之后量一次菜单的自然高度 `need`，偏好的一边放不下就开到空间大的一边——欢迎页输入框在屏幕中间，下面空间更大——之后不再换边，免得边用边跳）。② 通用的 `.menu button{width:100%}` 会把行尾星标按钮撑到 500px、把模型名挤成 0 宽；星标的规则都写成 `.menu.mm .mm-star` 抬优先级。③ `width:max-content` 的弹层里 `flex:1`（basis 0%）的子项在 Chromium 下贡献 0 宽，名字列要 `flex:1 1 auto`。④ shot.cjs 的 JS 里别写 `{section:'models'}` 这种带冒号的字面量（Electron 当 URL 退出），用 `Object.fromEntries`；打开会话后布局存进了截图用的 Electron profile，下一张欢迎页截图要换 `?win=`。
- **调试**：`server/ws-phase16.mjs` 末尾的假上游对 `GET /v1/models` 返回列表，断言每个档案的结果、写回、失败保留、gateway 跳过、只发了 GET。单测 `server/src/providers/refresh.test.ts` 用 node:http 假 `/v1/models`（按 key 决定行为，数并发峰值）。

## 子代理用的模型（2026-10-14，用户要求）

- **为什么**：用户朋友的子代理全跑在贵的主模型上，额度很快用完。主任务用主模型，子代理换个便宜的。
- **入口**：输入框里模型按钮右边的「子代理」按钮（`models/SubagentChip.tsx`），只有 Claude 对话有（其它 Agent、别的机器上的对话不显示）。菜单就是模型菜单加了 `subagent` 选项：锁在当前供应商（`lockProvider`），最上面一行「跟主模型一样」，不列收藏 / 最近 / 默认项 / 其它 Agent，没有星标，选了不记进最近；底下一个勾「这个供应商的新对话都这样」。欢迎页、在跑的对话、没在跑的对话都能选。
- **生效**：`CLAUDE_CODE_SUBAGENT_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`。ccb 总是先认前者；**新版官方二进制不加 `_FORCE` 时顺序是 工具给的 model → agent 定义的 `model:` → 这个变量**，Explore 定义的是 inherit（带上限），于是跑在主模型上（2026-10-19 真机：Opus 5.5 + DeepSeek，Explore 子代理是 Opus；用户中转上看到的 claude-sonnet-5 也是这么来的）。加了 `_FORCE` 之后变量压过前两者。环境变量只在启动时读：runner 的 `plan().key` 里带 `:sub-<model>`，换了就 `respawnWhenIdle()`（这一轮跑完再换，已经派出去的子代理不受影响）。官方二进制上 1M 的 Claude 也加 `[1m]`（`engineModel`）；ccb 上子代理模型也进 `CLAUDE_WEB_MODEL_CAPS` / `CLAUDE_WEB_CONTEXT_WINDOWS`。用官方账号时用户 settings.json 里自己写了这个变量，选了的会用 `--settings` 压过去（`ownOverride`，以前叫 `ownSubagentOverride`）。
- **存哪**：每个对话 `SessionMeta.subagent = { providerId, model }`（`''` = 跟主模型一样，也是一种选择）；每个供应商的新对话默认在设置 `subagentModels`（供应商 id → 模型，官方账号是 `claude`）。纯函数在 `server/src/models/subagent.ts`（前端经相对路径用同一份）。解析在 pool：调用方给了 `subagentModel` 就用并记进 SessionMeta（新对话记在它拿到的 id 下，分叉不记）；没给就是「这个对话为这个供应商选过的」→ 否则「这个供应商的默认」——IM、定时任务、目标、重开都走这里。对话换了供应商，旧的选择不再用（模型 id 是旧供应商的），按新供应商的默认来。
- **请求**：`session.setSubagentModel { sessionId, model, providerId }`（进了联邦路由表）。在跑：校验 providerId 还是它跑的那个（别的窗口刚换了供应商就报错），再 `runner.setSubagentModel()`；没在跑：只记 SessionMeta，下次启动用。
- **布局**：这个按钮让输入框那一行变挤了。宽的行（> 560px）里主模型按钮先缩（`flex-shrink: 100`，`.cb-right` 也是），「proj」「深入」这些短的保持完整；没选时「子代理」三个字不缩。窄的行（分屏、手机）只剩图标，选了模型时图标是强调色。
- **测试**：`server/src/models/subagent.test.ts`、`runtime/session-runner.test.ts`（环境变量、换了重启、`[1m]`）、`runtime/pool.test.ts`（解析和记录）；e2e `server/ws-phase28.mjs`（假上游，两个内核：主对话请求用主模型、子代理请求用选的；改回跟主模型一样后子代理用主模型；供应商默认）；ui-smoke `subagent-chip` 段。真中转 super-nb（官方二进制）实测：Sonnet 5.5 主模型 + Haiku 4.5 子代理，子代理的 transcript 和 modelUsage 都是 Haiku；改回后子代理是 Sonnet 5.5。super-nb 拒收 ccb 的请求，ccb 这条路只有假上游的 e2e。

## 挑要用的模型 / Codex 报的列表（2026-10-15，忍冬的反馈）

- **挑模型**：`web/src/features/settings/ModelPicker.tsx`（搜索、全选 / 全不选、勾选；`withPicked` / `pickedOf` 是纯函数，`model-picker.test.ts`）。写的是现成的 `ui.disabledModels`（`<providerId>:<model>`，和 设置 → 模型 的开关同一份），不另起一份允许名单——所以以后刷新多出来的模型默认是显示的。入口在供应商编辑页「用哪些模型」（`ConfigPanel.tsx`，网关档案没有）；**新加的供应商**「测试连接」成功且模型多于 3 个时自动弹一次。新供应商还没有 id：挑的结果先放在表单里，保存拿到 id 再写。`probe.ok` 为假（对话测试没过）时表单本来就不存列表，所以也不弹。
- **Codex 报的列表**：目录里写死的 Codex 模型会过时（2026-10-15 本机 0.162 报的是 gpt-6-luna / gpt-5.6-terra / gpt-5.6-luna，目录里还是 5.6 Sol / Pro）。`server/src/agents/reported-models.ts`：`askCodexModels` 起一个短命的 `codex app-server`（initialize → model/list 翻页 → kill，不开 thread），`codexReported` 去掉 hidden。`AgentRegistry`（`agents/types.ts`）：存在设置 `agents.reportedModels`（`{ codex: { at, models } }`，空列表不覆盖），`list()` 时装了且超过 6 小时（或 `refresh`）就后台问一次，变了发 `agents.changed`，前端重拉 `agents.list`；Codex 对话启动时 driver 自己的 model/list 也经 `onModels` 写进去（走网关 / 供应商时不写——那是供应商的列表）。`AgentInfo.reportedModels` → `menu.ts agentModels()` 先用它，再目录；`Composer.tsx` 的 `wBuiltin`、设置 → 模型「按供应商」也一样。`CW_NO_MODEL_REFRESH` 时不自动问。
- **真机验证的坑**：本机的 `codex.cmd` 启动的是 `%USERPROFILE%\.codex\cli-app-sync\launch.cjs`，临时 HOME 里 Codex 根本起不来（`codex --version` 也失败）——验证 Codex 列表得用真的用户目录 + 临时 `CLAUDE_WEB_DIR`。

## 子代理用别家的模型（2026-10-17，用户要求「我想要什么模型都能调用，不只是 claude 模型」）

- 对话在 **Anthropic 格式的供应商**（中转 / API）上时，子代理菜单除了这个供应商，还列出其它所有网关能转过去的供应商（anthropic / openai /
  grok / gemini 类型；`subagent-label.ts` 的 `crossProviders`），主供应商排第一。用 Claude 账号登录的对话没有可以替它转发的 key，只列账号的
  模型，菜单里有一句说明；OpenAI / Gemini 格式的对话也一样只列自己的。
- 选了别家的模型，存成 `cw-x:<供应商 id>:<模型>`（`models/subagent.ts` 的 `crossValue` / `crossPick`）——和普通选择同一个字段，存 / 默认 /
  重开 / 联邦都不用改。runner 启动时解开：`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 换成网关的分流路由（`gateway/split.ts` →
  `GatewayService.splitEndpoint`），`CLAUDE_CODE_SUBAGENT_MODEL` 给**别名** `cw-sub/<模型>`（`subAlias`）——分流路由靠模型名分辨主对话和子代理，两家都有同名模型（两个中转都有
  claude-opus-5-5）时用原名会把主对话也送到子代理那家（独立验证抓到的）；网关把别名换回真名再发。分流路由见 `gateway` 笔记。
- 测试：`gateway/service.test.ts` 的 subagent split、`runtime/session-runner.test.ts`（换地址、给原样模型 id、OpenAI 格式对话不分流）、
  `models/subagent.test.ts`、web `subagent-cross.test.ts`。没有真中转 + 真子代理的端到端实测。

## 子代理用任何模型（2026-10-18，用户：「主模型 / 会话不影响子代理的设置」「任何模型都能设置和切换」）

上一节的改写。设计 `docs/superpowers/specs/2026-10-18-subagent-any-model-design.md`，计划 `docs/superpowers/plans/2026-10-18-subagent-any-model.md`。

- **选择是整对（供应商, 模型）**：一律存 `cw-x:<供应商>:<模型>`（账号是 `claude`）。以前存的普通 id 按记录它时的 `subagent.providerId`
  补全（`fullPick`）；对话换供应商**不再作废**。新对话默认改成一个全局设置 `subagentModel`（菜单底下「新对话都这样」）；没有它时才读旧的
  `subagentModels`（按供应商）补全。`subagentModel` 设成 `''` 也算设过（新对话跟主模型），会盖住旧的那份。hub 的 `session.setSubagentModel`
  不再报「刚刚换了供应商」。
- **哪些组合能接**（`splitSupport`，前后端同一份）：任何供应商的模型在任何主对话下都行（网关翻译；gemini→openai 这个方向是这次加的）；
  另一个账号（`claude-account`，用它存的令牌）只能在 Anthropic 格式的主对话下（供应商 / 网关 / 账号）；**本机登录**只能在 Anthropic 格式
  的供应商主对话下；网关档案也能当子代理目标（2026-10-26 用户报告：WorkBuddy 的模型只在网关里，主模型换到 super-nb.me 这类中转后子代理菜单里整组不见了——以前 `splitSupport` 拒了 `gateway`）：`SplitSub` 多一种 `{ kind: 'gateway', groupId }`（`providers.subagentTarget` 给出档案的 `gatewayGroupId`），`serveSplit` 把别名请求交给**那个真组**跑（成员、故障转移、账号池都照组的规则，冷却也记在组上），组没了回 404。phase 28 两个引擎各有一轮。不能接的不出现在菜单里。
- **分流路由改成「主请求原样转」**（`GatewayService.serveSplit`）：地址 `/gateway/~s/<token>/k/<key>/…`，key 在路径里（Authorization 留给
  引擎自己的登录）。不是别名的请求 → `main.base + 路径`，带引擎自己的头和凭据（账号的 OAuth、缓存垫片的 key、Gemini 的 x-goog-api-key 都
  原样过去，`forwardHeaders`），回包原样回去；是别名的 → 账号：转 api.anthropic.com（另一个账号就换成它的令牌并补 oauth beta），供应商：
  走网关的 `run`（换成它的 key，去掉 oauth beta）。本机登录当子代理目标时，引擎保留账号登录（runner 去掉 `ANTHROPIC_AUTH_TOKEN`），主请求
  由路由换成供应商的 key（`rekey`）并去掉 oauth beta。
- **runner**（`subagentSplit`）：按主对话的格式换对应的变量（`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `GROK_BASE_URL` /
  `GEMINI_BASE_URL`），原来的值（没设就是官方默认地址）作为 `main.base`。别名：Anthropic 格式还是 `cw-sub/<模型>`；其它格式是
  `cw-sub-<十六进制>`——ccb 的 Gemini / Grok 客户端会把名字里带 haiku / sonnet / opus 的 id 换成家族默认，没有 OpenAI 那种
  `CLAUDE_WEB_SERVED_MODELS` 可以绕。用户自己 settings.json / 环境变量里配了中转的账号对话也接，见下面「已知的缺口」那条（已补）。
- **先验证的**：`scripts/probe-oauth-base.mjs`——用假令牌、临时 HOME，两个内核在 `ANTHROPIC_BASE_URL` 指向本地时都照样带
  `Authorization: Bearer <OAuth 令牌>` 和 `oauth-2025-04-20` beta，路径里的段也保留。
- **测试**：`models/subagent.test.ts`（整对、换算、全局默认、`splitSupport`、别名）、`gateway/service.test.ts`（每种主对话：账号主请求带
  登录、供应商子代理拿不到登录、另一个账号的令牌、`rekey`、OpenAI / Gemini 主对话、钥匙错 401）、`session-runner.test.ts`（每种主对话的
  环境变量、不能接的组合不设）、`pool.test.ts`、web `subagent-cross.test.ts`；e2e `ws-phase28.mjs` 加了「别家的模型」一轮（两个内核：主请求
  带主供应商的 key，子代理请求带另一家的 key 和真名）。
- **别名的痕迹**：引擎按它请求的名字（别名）记 `modelUsage` 和子代理消息的 model（OpenAI / Gemini 线上回包的名字它不用）。runner 收到
  `result` / assistant 消息时 `unalias` 换回真名，`sessions.subagent()` 读子代理 transcript 时也换。磁盘上的 transcript 里还是别名；
  子代理被问「你是什么模型」时会报别名（引擎的系统提示里写的是它）——这个改不了，不影响计费和显示。
- **真机**（2026-10-18，`scripts/real-subagent-split.mjs <主> <子> <子模型> [主模型]`：临时数据目录里放用户 meta.json 的副本——key 是
  这个 Windows 用户的 DPAPI，副本能解；真 HOME 的账号登录；临时项目目录，跑完连 `~/.claude/projects` 里那一项一起删）：
  - 账号（ccb，Opus 5.5）主对话 + DeepSeek（官方，openai 格式）子代理：子代理 transcript 是 `deepseek-chat`，回答正确。
  - super-nb（只放行官方二进制）主对话 Sonnet 5.5 + **本机账号的 Haiku 4.5** 子代理（反向，`rekey`）：两边都通，super-nb 收下了
    OAuth 模式的官方二进制换了 key、去了 oauth beta 的请求。
  - DeepSeek（ccb，OpenAI 格式）主对话 deepseek-flash + aizhongzhuan 的 claude-haiku-5-5 子代理（十六进制别名 + OpenAI→Anthropic 翻译）：通。
  - 先验风险脚本 `scripts/probe-oauth-base.mjs` 见上。
- **账号走用户自己的中转**（以前的缺口，2026-10-19 用户报告补上：主对话 Opus 5.5 走 settings.json 里配的中转 kiro，子代理选了另一家的
  DeepSeek V4.1，中转日志里却是 claude-sonnet-5——runner 不接分流，选择被忽略，只打一行警告，子代理落回 haiku → 中转映射的模型）。
  现在照常接：`main.base` 是引擎真正发往的地址（`user-env.ts` 的 `ownAnthropicBase(cwd)`：settings 文件的 env，user → project → local
  后者优先，压过进程环境变量；都没有才是 api.anthropic.com），主请求原样转过去，**凭据是引擎自己从 settings.json 读的那个**（Bearer 或
  x-api-key，路由原样带上）——我们不读、不存用户的 token。路由地址要压过 settings.json 里的 `ANTHROPIC_BASE_URL`：和子代理模型一样走
  `--settings` 文件（flag 层，两个内核都认），`ownOverride(ours, cwd)` 只放我们设的、settings 文件里也出现的键（`CLAUDE_CODE_SUBAGENT_MODEL`
  / `ANTHROPIC_BASE_URL`），token / 模型映射不进这个文件；中转只在进程环境变量里时直接覆盖，不写文件。这种对话默认跑官方二进制（`plan()`），
  有 ccb 才有的开关时跑 ccb，两条都通。测试：`user-env.test.ts`（`ownOverride` / `ownAnthropicBase`）、`session-runner.test.ts`（两个内核：
  `main.base` 是用户的中转、`--settings` 里只有路由地址；只在环境变量里时不写文件）、`gateway/service.test.ts`（主地址带路径、Bearer 和
  x-api-key 都原样到中转，子代理那家看不到用户的 token）；e2e `ws-phase28.mjs` 末尾一轮（临时 HOME 的 settings.json 指向假中转 `/relayA`
  + token，两个内核：主请求到 relayA 带用户 token，子代理请求到另一家带它的 key 和真名，`--settings` 文件里没有用户 token）。没有真中转实测。

## DeepSeek V4 的上下文窗口 / 改了供应商设置对正在跑的对话生效（2026-10-19 用户报告：缓存率低）

- `knownContextWindow` 以前把所有 `deepseek` 当 128K。中转的 deepseek-v4.1-flash 在 128K 上每 1.5–2 分钟自动压缩一次，后期每一轮都压缩
  （压缩后上下文已经接近上限），缓存命中 26–33%；用户把窗口设成 1M 后：201 次调用不压缩、提示到 272K、命中 97%。
  api.deepseek.com 自己的模型列表给 `deepseek-v4-pro` / `deepseek-flash` 报 1,048,576。现在 `deepseek-v4+` / `deepseek-flash` / `deepseek-pro` → 1,048,576，
  其它 deepseek（chat / reasoner / v3.x）还是 128K。
- 窗口（`CLAUDE_WEB_CONTEXT_WINDOWS` / 官方二进制的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`）是进程启动时读的，runner 的 `provider` 也是开的时候拿的：
  以前在设置里改了窗口，正在跑的对话照旧。现在 `providers.upsert` 之后 `pool.providerSaved(id)` → 这个供应商上每个 Claude 对话 `runner.reprovide()`：
  设置有变（不算 `modelsAt`）就等这一轮跑完重开进程（resume），没变什么都不做。只有用户在设置里保存才触发，后台刷新模型列表不触发。

## 自动压缩点 / Claude 账号的 200K · 1M（2026-10-24 用户：「有时候新对话还是 Opus 5.5 200k，很怪」，spec 2026-10-24 「A7」）

- **现象**：账号上普通的 `claude-opus-5-5` 是 200K，只有 `[1m]` 才是 1M（runner `windowOf`），所以从菜单直接选 Opus 5.5 的新对话落在 200K；
  另外用户 `~/.claude/settings.json` 的 env 有 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000`，界面上看不出来压缩点是哪来的。
- **做了什么**：① 「自动压缩」：每个供应商 `Provider.compactAt`、自己的登录设置键 `claude.compactAt`、「其它 Claude 账号」档案自己的 `compactAt`；
  设了就写 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（和官方二进制自己算的提前压缩点取小：`effectiveCompact`），压过 settings.json（见 `engine-providers`
  笔记「A7」那条）；不设 settings.json 照旧。输入 50K 起、不超过该模型窗口（`compactAtOk`）。runner 里 50K 以下不用；**超过当前模型窗口的封顶到窗口**
  （`userCompact` = `min(值, 窗口)`，窗口不知道就照用）——账号的值是按最大的那一族检查的，700K 碰到 200K 的 Sonnet 以前被直接丢掉，settings.json
  又赢了，和编辑框说的「设了就以这里为准」相反（最终审查 M4）。官方二进制把这个变量的下限定在 100K，所以官方二进制上 `info.compactWindow` 报
  `max(值, 100K)`，ccb 照实（M6）。编辑框里点「在这个大小时压缩」时，settings.json / 环境里的值只有在这个窗口下合格才预填，否则留空（M2）。
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
- 对任何供应商都一样（官方二进制 / ccb，Claude 账号 / Anthropic 格式中转 / OpenAI 格式）：都是 SDK 的 `systemPrompt.append`。
  Codex / ACP 的 agent 不管（菜单里那一行只给本机的 Claude 对话）。
- 分叉出来的对话开的时候跟父对话的设定；新 id 没有单独记，下次重开跟设置走。
- 测试：`server/src/runtime/thinking-language.test.ts`（解析与文字）、`session-runner.test.ts` 的「思考用的语言」（进系统提示、改了重启一次、一样不重启）、
  `web/src/features/settings/thinking-language.test.ts`、`catalog.test.ts`。语言自称的名字在两个文件里（server 的那份给提示词用），都进了 `coverage.test.ts` 的 ALLOWED。

## 子代理硬绑定：设了子代理模型，主模型就把活派给子代理（2026-10-19 用户要求）

- 用户：「子代理设置什么样，那就会派什么子代理，硬绑定，不要用户在提示词还要另外 trigger」。以前设了子代理模型，主模型要不要派子代理全凭它自己判断，常常自己干完了；用户得在提示词里写「用子代理」。
- 做法（`runtime/subagent-policy.ts`）：对话选了子代理模型（不是「跟主模型一样」），系统提示词末尾加一段 `# Subagents`：这是用户的常设指令，默认用 Agent 工具把探索 / 读文件 / 调研 / 范围清楚的实现 / 跑测试 / 审查交给子代理，独立的并行派，主模型只留理解需求、规划、决定、整合、管计划和跟用户说话——凡是要动工具（读 / 搜文件、跑命令、改代码）的都交给子代理，再小也一样（2026-10-19 真机：第一版允许「几步就完的小事自己做」，Opus 读三个小文件就没派）；每个子代理给完整的简报；不要给 Agent 工具传 `model`。只聊天的对话不加。模型本身的绑定还是 `CLAUDE_CODE_SUBAGENT_MODEL`（压过 agent 定义的 `model:` 和工具调用给的模型）。
- 子代理模型在 plan key 里（`:sub-<model>`），换了会重启进程（等这一轮和后台子代理都结束），这一段跟着重新读。测试：`subagent-policy.test.ts`、`session-runner.test.ts`「a subagent model picked → the work is delegated」。
- 这是提示词，不是强制：主模型偶尔仍可能自己动手；不用工具就能答的问题它直接答。
- 真机（`PROMPT=… node scripts/real-subagent-split.mjs nvm1u37t ntuxdq7p deepseek-v4.1-flash claude-opus-5-5`，提示词不提子代理，项目里放几个小文件）：加 `# Subagents` 段之前 Opus 自己读完；第一版段落（允许「几步就完的小事」）也自己读；声明「压过 Agent 工具说明里 读指定文件用 Read 的建议」之后派了 Explore；再加 `_FORCE` 之后 Explore 的 transcript 是 `deepseek-v4.1-flash`。`[Agent call]` 那行打印主模型调 Agent 的参数。

### 思考用的语言：每轮提醒 + Claude 的限制（2026-10-20 用户：换了语言思考还是英文）

- **2026-10-22 撤掉了每轮提醒**：开着它时，`claude-opus-5-5` 和 `claude-fable-5-1` 在这个应用里频繁被接口判「appears to violate our Usage Policy」（账本里 opus-5-5 官方请求约 20% 被拒，`deepseek-v4.1-flash` 只有 0.1%），而官方桌面版同模型、同权限模式（都是 bypass）、同一段对话不拒；用户把思考语言设成「不指定」后，同一对话马上能继续 → 触发源是提醒。现在只留系统提示里的一节，措辞也改平（`Think in …` 一句，去掉 chain-of-thought / analysis / planning / deliberation 这种「改写思维过程」的说法）。代价：Claude 可能又用英文思考（本来也管不住，见下面那条）。
- 只有系统提示那一段不够，照参考插件加了**每轮提醒**（2026-10-20，2026-10-22 已撤）：SDK 钩子 `UserPromptSubmit` / `PostToolUse` 返回 `additionalContext`，引擎把它作为 system reminder 放进最新一条消息，对话里不显示，也不动缓存前缀。
- 假上游抓包（`cw-real/fake-upstream.cjs`）确认请求里有 `# Thinking language` 段和 `[Thinking language]` 提醒。
- 真机：DeepSeek V4.1（aizhongzhuan，OpenAI 格式）设日语 → 三段思考全是日语；设简体中文 + 中文提问 → 中文。**Claude（Opus 5.5，账号）不照做**：连用户消息里直接写「思考过程必须全部用简体中文」都还是英文——Claude 显示的思考是官方的摘要（`thinking.display: summarized`），语言我们管不了。设置里的说明写了这一点。

## 工作流里的代理显示成主模型（2026-10-30 用户报告：「子代理没有按我设置的来，还是用的主代理模型」）

- 用户：主模型 Magpie（Anthropic 格式）上的 routego/gpt-6.1-sol，子代理选 DeepSeek V4.1 Flash，深度编排。工作流卡片和悬停都写 routego/gpt-6.1-sol。
- 查下来**请求是对的**：`.probe/wf-sub.mjs`（照 `ws-phase28.mjs` 的假上游，主轮调 Workflow 工具，脚本里一个 `agent()`）——工作流代理的请求是
  子代理模型、带另一家的 key。引擎 `claudeCodeBackend.ts` 真跑走 `runAgent → getAgentModel`（`CLAUDE_CODE_SUBAGENT_MODEL` 优先），但进度里报的是
  `params.model ?? mainLoopModel`，所以**显示错**。
- 修法（不发引擎）：runner 记下这个进程真正给子代理的模型（`subRuns`，别名换回真名），收到 `workflow_progress` 时把每个 `workflow_agent.model` 换成它
  （`trackBackground` 之前，聊天里的运行卡和后台页都用这一份）；跑完的 run 文件（引擎自己写的，同样是主模型）在 `disk.ts readRun` 里按每个代理自己 transcript
  第一条助手消息的 model 改（`firstModel`）。运行行「routego/gpt-6.1-sol · 任务输出」是主对话自己在等 TaskOutput，那是对的。
- 测试：`session-runner.test.ts`「a workflow's agents are reported on the subagent model」、`disk.test.ts`「an agent's model is what its own transcript asked for」。

## 供应商改了类型 / 被删了，在跑的对话（2026-11-13 用户报告：「API Error: 404 没有这个 OpenAI / Grok 型档案：085wm1p2」）

- **现象**：对话在 OpenAI 格式的供应商上跑着（进程的 `OPENAI_BASE_URL` 指向缓存垫片 `/gateway/~p/<id>`），用户把这个供应商改成
  Anthropic 格式保存。保存会 `reprovide` → 重开进程，但有后台任务时一直等；旧进程每一轮都打到垫片，垫片只认 openai / grok，
  回 404（11ms、$0，请求没出本机）。重试、重选模型都不换进程，所以怎么点都一样；把类型改回 OpenAI 就又通了。
- **改了什么**：
  - `reprovide` 发现 `type` 变了 → `respawnWhenIdle(true)`（`respawnForced`）：不等后台任务（那个进程已经发不出请求，后台的也是死的），
    正在跑的一轮还是等它结束。其它设置变更照旧等后台任务。
  - 删除供应商：`ProviderService.onRemoved` → `pool.providerRemoved(id)`（index.ts 接的，设置里删、来源 / 托管程序移除都走这里）：
    空闲的对话马上关进程，正在跑的等这一轮结束再关。下一句话重开时 `resolveProvider` 落到默认供应商。
  - 垫片的 404 分两句：档案没了 / 类型改过了，都说该怎么做，不再甩 id。
- **顺带：分叉报 `Message …-000000000001 not found in session`**。CLI 给多块内容的消息在流上按块派生 uuid（消息自己的 uuid 前 24 位 +
  块序号 12 位十六进制，二进制里 `cMn`），磁盘上只有消息自己的 uuid，`forkSession({ upToMessageId })` 找不到。从磁盘加载的对话没这个问题，
  所以只有「在跑的对话里点刚出来的回复分叉」会中。`sessions/fork-anchor.ts` 的 `forkAnchor` 在磁盘上没有这个 uuid 时按前 24 位找回原 uuid
  （`sessions.fork` 和 runner 的 `resumeSessionAt` 都过一遍）。
- **没做 / 没验**：只有单元测试（runner、pool、垫片、fork-anchor），没有在真机上复现整条经过。`providers.upsert` 以外改类型的路
  （来源驱动直接写 meta）不会触发 `reprovide`。
