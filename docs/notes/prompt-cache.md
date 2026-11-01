# 提示缓存（2026-09-28）

历史：这篇以前大半在讲模型网关的转换路径（`cacheKeyOf`、`cache_control` 注入、`prompt_cache_key` / 亲和头）、给 OpenAI / Grok 档案的
**缓存垫片**（`gateway/shim.ts`、`/gateway/~p/…`、`/v1/responses` 改写、强制工具 + 思考模型的重试、`CW_SHIM_DEBUG`）、Codex 的用量计算（`CodexUsageMeter`）、
ccb 的 Gemini 适配器去重和 `ws-phase18.mjs`。2026-11-01 这些全删了（见「只留 Claude」）。下面是还在的部分。

- **费用裁决**：不维护第三方价表（中转各自定价、常变），**未知就说未知，不写 $0**：runner 发出 `result` 之前 `usage/pricing.ts markUnknownCost()` 把 `modelUsage` 里有非 Claude 模型的结果（`trustsCliCost`：Claude Code 按 Claude 价表算所有模型，中转上的别家模型就不对）改成 `total_cost_usd: 0` + `cost_unknown: true`（目标 / 编排 / IM / Mission 读到 0 本来就不显示）；账本行 `costUnknown`，用量桶 `costUnknown` 计数。前端 `web/src/model/cost.ts`：`fmtCost()` → 「费用未知」 / 部分未知时「≥ $x」，`sumCosts()` 给 composer 合计；对话结果行、composer 状态栏、账本（单元格「未知」、合计「N 次未知」）、用量面板都走它。用量面板各组**按 token 排序**、条形也按 token（按费用排会把未知价的模型全沉底）。
- **每轮按当时的供应商归属**（`usage/service.ts`）：不拿会话**当前**的 `providerId` 给全部历史定性（热切换过 / 档案删了就全错）。热切换时 `session/swap.ts` 往 canonical 写的 `switch` 行带 `fromProviderId`（切换前的，`claude` = 账号；已有对话带另一个供应商 `session.open` 时也写——没在跑的开成功后记、在跑的就是一次热切换，`openOnProvider()`，见「界面改版 阶段 3」），`canonical.providerSwitches(sid)` 读出来（按 size + mtime 缓存，只解析含 `"switch"` 的行），`usage/timeline.ts providerTimeline()` 按时间戳给每轮定供应商：第一次切换之前 = 那条的 `fromProviderId`；**老日志没有 `fromProviderId` → 「未知档案」而不是「Claude 账号」**；档案已删 → `<记录名>（已删除）`。费用、「按供应商 × 模型」都按那一轮的算；`globalCache` 的键带上时间线，切换后会重算。
- 账本面板「缓存命中 · 按供应商 × 模型」（`features/panels/ledger-stats.ts hitRates`，已删档案显示「已删除的供应商」——`profileName()`）；用量面板每行带命中率 + 「按供应商 × 模型」分组。账本里以前网关写的行（`kind: 'gateway'`）读的时候跳过（`usage/ledger.ts`）；`pickRows()` 现在原样返回（以前给「全部」来源去掉和会话行重复的网关 / 垫片行）。
- **1h TTL**：anthropic 档案 `cache1h` → `ENABLE_PROMPT_CACHING_1H=1`（官方二进制认；1h 写入 2× 基础价，5m 是 1.25×），默认关。
- **闲置回收**（`runtime/pool.ts idleTtlFor()`）：anthropic + 1h TTL 65 min，其余 30 min。闲置的 Claude 进程另有上限 `MAX_IDLE_CLAUDE = 12`，超出按最近活动 LRU 关。缓存还热的时候回收 = 下一轮全价重付。会话里切模型 / 供应商的 toast 写明「下一轮会按全价重新计费全部上下文」（`models/route.ts switchedNote`）。
- **分叉的缓存键**：hub 在 fork 换 id 之前用 `runtime/cache-key.ts cacheParentFor()` 定键（父会话记录的 `SessionMeta.cacheKey` → 父 id），写进新会话的 `SessionMeta.cacheKey`，runner 记成 `cacheKey`。原来是给垫片路由用的，垫片删了以后没有地方读它，只是还在记。
- **踩过的坑**：bash 里 `node -e "…"` 带反引号会被 shell 当命令替换执行（模板字符串整段消失且不报错）——含反引号的改动用 Edit；`http.request` 的 `headers` 传扁平数组，服务器回空 body 的 400，要逐个 `setHeader` 才能控制头顺序和大小写。
- **验证**：单测 `usage/{ledger,service,timeline,pricing}.test.ts`、`session/{canonical,swap}.test.ts`、`runtime/{pool,cache-key,session-runner}.test.ts`，web `ledger-stats.test.ts`、`model/cost.test.ts`、`conversation.test.ts`。

- **「缓存 0%」的说明**（2026-10-14 朋友：super-nb 上一轮 211K、$1.09、缓存 0%）：多半是隔了 5 分钟以上才发下一条，提示缓存过期，整段上下文按全价重读（打开供应商的「1 小时提示缓存」就有效）。reducer 给每个 result 记 `idleBeforeMs`（这一轮开始 − 上一个 result 的时间），`tokens.ts coldCache()`：输入 ≥ 20K、命中 < 5%、间隔 > 5 分钟时，那一行多一段「隔了 12 分钟，缓存已过期」，悬停说明和「1 小时提示缓存」在哪。
- **没在本窗口跑的轮次也有那一行**：CLI 的记录里没有 result 行。`transcript.load` 前 `sessions/history.ts withTurnStats()` 在每一轮（人打的消息到下一条之间）末尾补一个 `cw_history` 的 result：账本里有这一轮（`LedgerService.rowsFor()`，按会话建一次索引、之后随 `record()` 更新）就用账本的时间 / 步数 / 费用 / token，没有就按回答的 usage（每个 message.id 一次调用）算、不带费用（`cw_cost_absent` → 那一行不写费用，合计算「未知」）。正在跑的对话最后一轮不补；最后一条回答停在 tool_use 且账本没有的也不补（被打断的、中途插话的）。
