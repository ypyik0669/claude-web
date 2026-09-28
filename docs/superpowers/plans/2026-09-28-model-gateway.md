# 模型网关 实现计划（子项目 4）

spec：`docs/superpowers/specs/2026-09-28-model-gateway-design.md`

## 任务

1. **中间表示与协议文件**（`server/src/gateway/`）
   - `ir.ts`：`IrRequest / IrMessage / IrPart / IrTool / IrResponse / IrUsage / IrEvent`（流式事件：start / text / tool / args / usage / end / error）。
   - `sse.ts`：增量 SSE 解析（`SseParser.feed(chunk) → {event,data}[]`）与写出。
   - `anthropic.ts`、`openai-chat.ts`、`openai-responses.ts`、`gemini.ts`：每个协议一个文件，按需导出 `parseRequest`（入口 → IR）、`renderRequest`（IR → 出口）、`parseResponse`（出口响应 → IR）、`renderResponse`（IR → 入口响应）、`StreamParser`（出口 SSE → IrEvent）、`StreamRenderer`（IrEvent → 入口 SSE）、`renderError`。
   - 测试：`convert.test.ts` 覆盖 6 个方向的请求 / 非流式 / 流式序列（夹具按官方文档形状手写）。
2. **上游调用与透传**：`upstream.ts`（node:http/https，精确控制请求头；首字节 60s 超时；错误体解压）、`passthrough.ts`（`replaceTopLevelString` 只改顶层 `model` 保持其余字节不变；头过滤：去掉 hop-by-hop 与鉴权头，按客户端原风格换鉴权）。测试：透传保头 / 保字节。
3. **故障转移**：`failover.ts`（成员排序：failover / 平滑加权轮询；冷却：429 看 `retry-after` / `anthropic-ratelimit-*-reset`，否则 60s 起指数退避上限 30 分钟；5xx / 网络 / 超时短冷却；401/403 停用；额度文本 → 按 429 处理）。测试：纯函数 + 假上游。
4. **服务**：`service.ts`（`GatewayService`：配置 / 密钥 / 状态 / `handle(req,res)`：回环限制、鉴权、路由、尝试成员、账本、`changed` 事件；`test(groupId)`）、`handlers.ts`（hub 的 `gateway.*` 请求）、`types.ts`（协议类型，protocol.ts `export *`）。测试：`service.test.ts` 起假上游跑 500→下一个、429+retry-after 冷却、流开始后出错不切换、modelMap、鉴权、cwRemote 404。
5. **接入**：`ProviderType` 加 `gateway`（`Provider.gatewayGroupId`）；`ProviderService.forSession` 解析网关地址与密钥；`providerEnv(p, agent)` 按 agent 映射；`RunnerPool` 给非 Claude agent 注入网关档案的 env；`index.ts` 在 handler 最前面分流 `/gateway/`；MetaStore 追加 `gatewayGroups` / `gateway` 存取。
6. **界面**：设置分区「模型网关」（`GatewaySection.tsx`）、供应商编辑新增类型「模型网关」选组、账本「来源」过滤。
7. **收尾**：`server/ws-phase16.mjs` + e2e 列表、CLAUDE.md / README 小节、截图、报告。

## 裁决

| 裁决 | 理由 | 代价 |
| --- | --- | --- |
| 只开放 spec 列出的 6 个跨协议方向 + 同协议透传（anthropic / openai chat / responses / gemini），其余组合 400 | spec 明说；其余方向没有测试 | IR 其实能拼出更多方向，但暂不开放 |
| OpenAI 家族出口统一走 Chat Completions；Responses 入口只透传到 openai / grok 成员或转到 anthropic 成员 | spec 方向表 | Responses → gemini 不支持 |
| grok 档案按 OpenAI 协议出口（默认 `https://api.x.ai`） | xAI 是 OpenAI 兼容 | — |
| 上游用 `node:http/https` 而不是 fetch | fetch（undici）会自己加 `accept-encoding` / `sec-fetch-mode` 等头并自动解压，透传就不再是原样 | 不走系统代理（`HTTPS_PROXY`），需要代理的直连官方端点暂不支持 |
| 透传时鉴权按客户端原风格替换：客户端用 `x-api-key` 就发 `x-api-key`，用 Bearer 就发 Bearer；跨协议到 anthropic 两个都带 | 保持指纹，与直接用档案时的行为一致 | — |
| 透传改模型只改顶层 `model` 字段的字节（小型 JSON 扫描器），其余字节不动；模型不变时整个请求体原样 | 中转可能校验请求体形状 | — |
| 5xx / 网络错误 / 首字节超时：切下一个成员并冷却 15s（不做指数退避） | spec 只规定了 429 的冷却；短冷却避免每个请求都先撞坏成员，又能很快恢复 | 15s 内恢复的上游会被晚用一会儿 |
| 冷却中的成员直接跳过；全部冷却 / 停用时返回 429（有限流冷却）或 503，带 `retry-after` | 冷却的意义就是不去撞 | — |
| 401/403 停用成员，直到用户在界面点「恢复」或改组配置 | spec | — |
| 其它 4xx（400/404/413/422）不切换，原样回给客户端 | 请求本身有问题，换成员也一样 | — |
| 首字节：拿到 2xx 响应头后还要等到第一块 body 才向客户端写头（`commit`） | 上游回 200 后卡住也能切换 | 首字节延迟里包含第一块 body |
| 模型：`member.model` > `group.modelMap`（精确，其次 `*` 通配）> 原值 | 成员可能是完全不同的供应商，需要各自钉模型 | — |
| `/v1/models` 返回 OpenAI 与 Anthropic 兼容的合并形状 | 两个协议同一路径 | — |
| `count_tokens`：第一个可用成员是 anthropic 就透传（带故障转移），否则按 4 字符 ≈ 1 token 估算 | spec | 估算不准 |
| Gemini 出口：历史里的 functionCall 带 `thoughtSignature: 'skip_thought_signature_validator'`，schema 做 OpenAPI 子集清洗 | Gemini 3 对缺签名的历史函数调用报 400；`parameters` 不接受 `$schema` / `additionalProperties` 等 | 该哑签名值来自记忆，官方文档未能核实 |
| 网关密钥 `cwg-` + 48 位 hex，存 meta `gateway.key`（`enc:`），wire 上打码；`gateway.revealKey` 按需取明文供复制 | 界面要能复制 | 已配对的手机也能取到（但网关只接回环连接） |
| 账本行 `kind:'gateway'`，`sessionId` 取 Claude Code 的 `x-claude-code-session-id` 头（没有就空） | 能和会话对上 | 同一次调用在会话 `result` 行和网关行各算一次，账本「来源」过滤可分开看 |
| 非 Claude agent 只有「模型网关」类型的档案会注入 env（Codex：`OPENAI_BASE_URL` + `OPENAI_API_KEY`；Gemini/Qwen 等 ACP：`GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY` + OpenAI 变量） | 其它档案类型原本就只给 Claude 用 | Codex 用 ChatGPT 登录时可能忽略 `OPENAI_API_KEY` |
