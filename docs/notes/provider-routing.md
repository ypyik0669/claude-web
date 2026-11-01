# 供应商：IM / 定时任务（2026-09-30 用户报告）

- **供应商在对话池里定**（`RunnerPool.open` 的 `resolveProvider()`）：调用方没给 `providerId` 时——IM、定时任务、目标、编排都直接 `pool.open`，不经过 hub 的 `session.open`——恢复用记录的（`SessionMeta.providerId`，还存在、类型合用才算），新对话用设置 → 供应商的「设为默认」（`settings.defaultProviderId`，`defaultProviderFor()`）。记录的供应商没了 → 默认；恢复时什么都没记 → 账号登录（账号已知登出时也走默认）。池自己选的会写回 `SessionMeta.providerId`。显式给的（含 `'claude'` = 账号）永远优先，由调用方记录。以前钉钉机器人发的消息永远走 Claude 账号（用户报告）。
- **IM**：`ImGatewayConfig.providerId`（'' = 跟新对话一样，`'claude'` = 账号，其它 = 供应商；`ImService.set` 的字段表里要列出新字段），设置 → IM 机器人卡片上「用哪个供应商」；选的供应商用不了（删了 / 类型不合）→ 退回默认（`pool.providerFitError`）。`/new`、`/status` 的回复写「· 供应商 X」。组件 `features/providers/ProviderSelect.tsx`（末项「添加供应商…」走快速连接）。
- **钉钉接口可以指到假服务**：`CW_DINGTALK_API`（默认 `https://api.dingtalk.com`），只给端到端检查用。
- `server/ws-phase19.mjs`（`npm run e2e` 默认列表里；**自己起 server**：要带死代理 `HTTP(S)_PROXY=127.0.0.1:9` 和 `CW_DINGTALK_API`）：真 Claude Code + 假 Anthropic 格式中转 + 假钉钉（Stream 网关 http + ws，sessionWebhook 收回复）：钉钉消息走默认供应商且 `/status` 写出来、重开保留、机器人选另一个供应商、定时任务走默认、选的模型就是发出去的模型、中转不回时停止能结束、终端是 shell——全程系统代理是死的。
- 历史（2026-11-01 删了，见「只留 Claude」）：其它 agent 各自的「新对话用」供应商（`AgentConfig.providerId`）、`ImBinding.agent`、Codex 经缓存垫片走 openai 型供应商（`/v1/responses` 转 chat/completions）、模型菜单里 agent 分区带供应商。
