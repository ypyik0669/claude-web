# 模型网关 设计（子项目 4）

日期：2026-09-28 · 状态：用户授权一次性实施

## 目标

本机一个 HTTP 网关，对 agent 暴露 Anthropic / OpenAI / Gemini 三种协议，后面接用户的供应商档案，做协议转换和故障转移组；同类型多个档案（多账号）在额度耗尽时自动切换（AiMaMi 的思路）。任何 agent（Claude Code、Codex、Gemini CLI…）都能用。

## 明确不做

借用 Claude / ChatGPT / Google 的**订阅登录**转给别的 agent 用（magpie 的订阅共享）——违反服务条款。网关只转发用户自己配置的 API 档案（`Provider`，含中转）。

## 设计

- 挂在主 HTTP 服务上，路径前缀 `/gateway/<groupId>/`，**只接受回环连接**（远程监听器上一律 404）。鉴权：`x-api-key` 或 `Authorization: Bearer <网关密钥>`（首次启用时生成，存 enc）。
- 入口协议：
  - Anthropic：`POST /gateway/<g>/v1/messages`（含 `stream`）、`GET /v1/models`、`POST /v1/messages/count_tokens`（能透传就透传，否则估算）。
  - OpenAI：`POST /gateway/<g>/v1/chat/completions`、`POST /v1/responses`（Codex 用 Responses API）、`GET /v1/models`。
  - Gemini：`POST /gateway/<g>/v1beta/models/<m>:generateContent` 与 `:streamGenerateContent?alt=sse`。
- **故障转移组**（`meta.gatewayGroups: {id, name, members: [{providerId, model?, weight?}], strategy: 'failover'|'round-robin', modelMap?: Record<入口模型, 出口模型>}`）：按顺序尝试成员；触发切换：连接失败、超时（首字节 60s）、HTTP 5xx、429、401/403（该成员停用并提示）、额度用尽类错误文本。429 带 `retry-after` / `anthropic-ratelimit-*-reset` 时该成员冷却到重置时间，否则冷却 60s 起指数退避（上限 30 分钟）。**流式响应一旦开始向客户端吐字就不再切换**（只能如实报错）。
- **转换**：同协议（入口 = 出口）走**透传**：请求体与关键头原样转发（保留 UA、`anthropic-beta`、`anthropic-version`、系统提示——中转指纹靠这个），只换 base URL 与鉴权、按 modelMap 改 `model`。跨协议走归一中间表示：messages（文本 / 图片 / tool_use / tool_result / thinking 丢弃）、tools（JSON Schema）、tool_choice、max_tokens、temperature、stop、system；流式 SSE 双向转换（Anthropic `message_start/content_block_*/message_delta/message_stop` ↔ OpenAI `chat.completion.chunk` / Responses 事件 ↔ Gemini `candidates`），usage 映射。只实现这三种之间的 6 个方向里常用的：anthropic入→openai出、anthropic入→gemini出、openai入→anthropic出、openai(responses)入→anthropic出、gemini入→anthropic出、openai入→gemini出；其余组合返回 400 明说不支持。
- **会话接入**：`ProviderType` 加 `gateway`：档案只选一个组；`providerEnv()` 把它映射成本 agent 期望的变量（Claude → `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/gateway/<g>` + `ANTHROPIC_AUTH_TOKEN=<网关密钥>`；Codex → `OPENAI_BASE_URL=.../gateway/<g>/v1` + key；Gemini → `GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY`）。桌面模式端口每次变，env 在开会话时计算即可。
- **观测**：每个请求记一行到账本（`ledger.jsonl` 加 `kind:'gateway'`：组、入口协议、实际成员、上游状态、切换次数、延迟、首字节、tokens）；组状态（每个成员 健康 / 冷却到何时 / 最近错误）实时事件 `gateway.changed`。
- 密钥永不出现在日志与 wire 上。

## 界面

设置新分区「模型网关」：总开关、网关地址与密钥（复制 / 重新生成）、组编辑（成员拖序 / 策略 / 模型映射）、每个成员的健康与冷却倒计时、「测试」按钮（向组发一条最小请求并显示走了哪个成员）；供应商档案编辑里新增类型「模型网关」选组；用量面板账本可按 gateway 过滤。

## 测试

- 单元：每个转换方向的请求 / 非流式响应 / 流式事件序列（用录制形状的夹具）、透传保头、故障转移（假上游：500 → 下一个；429+retry-after → 冷却；流开始后出错不切换）、modelMap、鉴权与回环限制。
- 端到端 `server/ws-phase16.mjs`：本地起两个假上游（一个 Anthropic 形状、一个 OpenAI 形状，第一个先返回 529），配置组，经网关用 Anthropic 与 OpenAI 两种入口各发流式 / 非流式请求，断言切换、转换、账本记录、远程监听器上 404。加入 `scripts/e2e.mjs` 默认列表。不碰真供应商。
