# 引擎与供应商档案

- **只有官方 Claude Code**（2026-11-01 用户决定，见「只留 Claude」笔记）：`server/src/claude-exe.ts` 的 `resolveEngine()` 回
  SDK 自带的官方二进制（`@anthropic-ai/claude-agent-sdk-<平台>`；`CLAUDE_WEB_EXE` 可指定别的，找不到时退回全局 npm 的
  `@anthropic-ai/claude-code`）。`engineInfo()` 给配置中心显示版本和来源。WSL 对话用发行版自己 PATH 上的 `claude`。
  `claude <子命令>`（配置中心、`-p` 测试连接）也走 `runClaudeCli()` 同一个二进制。
- **官方 claude 的别名**（2026-09-29 用 `system/init` 实测，`--model <别名>`）：Claude Code 2.1.283（Max 账号）默认 →
  `claude-opus-5-5[1m]`、opus → `claude-opus-5-5`、sonnet → `claude-sonnet-5`、haiku → `claude-haiku-4-5-20251001`、
  fable / best → `claude-fable-5-1`（`models/catalog.ts` 的 `OFFICIAL_ALIAS_TARGETS` / catalog 的 `aliases` 同一张表，芯片上的名字就是
  真正在跑的模型）。**升级 SDK 自带的 claude 二进制后要重新量一遍**（`--model <别名>` 起一次、读 init 行的 `model`）。
- **供应商档案**（`Provider`，存 `~/.claude-web/meta.json`，不写 `~/.claude/settings.json`）只有两种：`anthropic`（官方 API 或
  Anthropic 兼容的中转）和 `claude-account`（另一个 Claude 账号的 setup-token，见「其它 Claude 账号」笔记）。`server/src/providers/service.ts`
  的 `providerEnv()`：anthropic → `ANTHROPIC_BASE_URL`（不带 `/v1`，CLI 自己补 `/v1/messages`；隐私保护开着时换成本机隐私中转）+
  `ANTHROPIC_AUTH_TOKEN`（Bearer；`authStyle` 可改成 `x-api-key` / 两个都带）+ `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`
  （+ `ANTHROPIC_SMALL_FAST_MODEL`）+ `cache1h` → `ENABLE_PROMPT_CACHING_1H=1`；claude-account → `CLAUDE_CODE_OAUTH_TOKEN`，并把
  `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 置空。`session-runner.ts` 只注入到那个会话的进程；本进程的 `ANTHROPIC_*` /
  `CLAUDE_CODE_USE_*` env 会被清掉以免混入。会话用的档案记在 `SessionMeta.providerId`，resume / fork 沿用。wire 上 `apiKey` 一律打码。
  以前存下的 OpenAI / Gemini / Grok / 模型网关档案在读 meta.json 时挪到 `removedProviders`（原样保留，不再用）。
- 会话级开关 `SessionFeatures`（`--chrome`、`--brief`、只聊天；操控电脑是我们自己的 `computer` MCP）在 `session-runner.ts` 的
  `featureArgs()/featureEnv()`。
- **上下文窗口**（2026-10-14 用户报告：中转的 Claude 175K 就压缩）：官方二进制只认得自己表里的模型，其它一律 200K（`[1m]` 后缀 = 1M）。
  `server/src/models/context-window.ts`：用户设的（`Provider.contextWindows`）> 模型列表写的（`modelContext`：`context_length` /
  `max_input_tokens`…，随列表一起拉）> 按名字拉满（`knownContextWindow`：Claude 1M、Haiku 200K…）> 默认 200K。官方二进制没有按模型的开关：
  `officialWindow()`——Claude 模型超过 200K 就以 `<model>[1m]` 启动 / setModel（runner 的 `engineModel()`；没选模型时用供应商默认模型加后缀），
  比它会假设的小就设 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（只能往小调；按启动时的模型算，中途换模型不跟着变）。设置页：编辑供应商里「上下文窗口」
  （ConfigPanel 的 `ContextWindows`，空着显示默认值和来源）。实测（super-nb，2026-10-14）：claude-sonnet-5-5 → init 模型 `claude-sonnet-5-5[1m]`、
  `getContextUsage` 的 `raw_max_tokens` 1,000,000；设成 400K → 400,000。
- **思考的 display**（2026-10-17）：官方二进制用 `--thinking-display summarized`（只在启动模型是 Claude 时加：别家模型的 Anthropic 兼容中转可能不认这个字段）。
  原因见 `recording-ux` 笔记「第三轮」。
- **中转指纹（api.super-nb.me 实测）**：只放行官方 Claude Code 构建发的 `/messages`。三处判据都踩过：① User-Agent 里不能有 SDK 附加的 `agent-sdk/x.y.z`（来自 env `CLAUDE_AGENT_SDK_VERSION`，`spawnClaude` 见到 `CLAUDE_WEB_PLAIN_UA` 就删掉）；② `CLAUDE_CODE_ENTRYPOINT` 必须是 CLI 默认的 `cli`（`sdk-ts`/`claude-web` 都 400「请求可能被第三方中转改写」）；③ 必须带 Claude Code 的主系统提示（Agent SDK 默认是**空**系统提示，runner 显式传 `systemPrompt: {type:'preset', preset:'claude_code'}`）。`ProviderService.probe()` 除了 `/v1/models` 还真跑一轮 `-p`（`chatProbe`），一个中转收不收这个客户端，只有这样才看得出来。
- **中转还卡最低 CLI 版本**（2026-09-27 实测 super-nb 要求 ≥ 2.1.280）：官方二进制来自 `@anthropic-ai/claude-agent-sdk-<平台>`，版本跟 SDK 走（SDK 0.3.x ↔ Claude Code 2.1.x），被拒时报「客户端版本过低」就升级 SDK。
- **用户 settings 文件里的 `env` 压过我们给 CLI 的 env**（2026-10-07 实测，经 SDK 也一样）：`~/.claude/settings.json`（以及项目的 `.claude/settings.json` / `settings.local.json`）的 `env` 会在启动后盖到进程环境上。cc-switch 之类的工具会往那里写 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`，结果供应商对话拿旧 Key 发到我们的中转（401，CLI 默认重试 10 次、几分钟），或者整个发到旧中转去（「测试连接」也照样「通过」）；模型列表是我们自己用新 Key 拉的，所以看上去 Key 没问题。修法：供应商对话（`SessionRunner.start`）和 `chatProbe` 用 `runtime/user-env.ts` 的 `settingsOverride(ours, cwd)` 算出冲突——settings 文件里出现、我们也设了的键用我们的值，出现了而我们没设的路由键（`ROUTING_ENV`，和清进程 env 同一个正则）设成 `''`（CLI 当作没设：不发多余的 x-api-key、用自己的默认模型）——经 `--settings <文件>`（flag 层，优先于 user / project / local）传进去。**用文件不用内联 JSON**：SDK 的 `settings` 对象会原样放进命令行（`--settings {"env":…}`），macOS / Linux 上别的用户 `ps` 看得到 Key。文件 `runtime/flag-settings.ts` 写在 `<dataDir>/runtime/flag-settings/<server pid>-<uuid>.json`（0600，目录 0700），只在有冲突时才写，跟着那个 CLI 进程（`exit` / `error` 时删，`close()` 兜底没起来的），别的 server 已经不在的文件在第一次写时清掉。账号对话不动（用户自己在 settings.json 配的中转就是他要的）——只压我们自己设的键（`ownOverride`）：子代理模型、开了隐私中转时的 `ANTHROPIC_BASE_URL`、用户给账号设的自动压缩点（以前还有子代理用别家模型时分流路由的 base URL，分流已删）。没有冲突就什么都不写、不传。
- 注意本机开发 shell 继承了 `CLAUDE_CODE_ENTRYPOINT=sdk-cli`（因为在 Claude Code 里跑），测指纹要用 `env -u` 或显式赋值，别被继承值骗了。
- Langfuse / Artifacts / Web Search 等配置仍是 `~/.claude/settings.json` 的 `env`；设置 → 高级 → 环境变量编辑（`features/settings/EnvEditor.tsx`，停靠面板配置中心「供应商 / 环境」tab 下半段是同一个组件）。
- **自动压缩点压过 settings.json**（2026-10-24，A7；用户的 settings.json env 有 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=700000`）：用户在供应商 / 账号上设了
  「自动压缩」，runner 在 fenv 里写 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（和官方二进制的提前压缩点取小，plan key 带 `:compact-<n>`，换进程）。
  供应商 / 其它 Claude 账号本来就经 `settingsOverride(fenv)`；**自己的登录经 `ownOverride(ours)`，它只带「我们设了、settings 文件也设了」的键**——
  以前 `ours` 里没有这个键所以从来不压，现在用户值成立时放进 `ours`。用户没设就不写这个键，settings.json 的照旧生效；用户值也压过本机环境变量 /
  对话的 env（引擎自己算的值还是让着它们）。`config.compactSource` 告诉界面现在生效的值来自 settings.json / 环境 / 没有（settings.json 有这个键就以它为准，
  空 / 0 = 不设上限，和 CLI 一样）。e2e `ws-phase32.mjs` 用 Bash 工具在引擎里 `echo` 这个变量核对（假上游让模型调 Bash，下一个请求里读工具结果）。
- **换模型和上下文窗口**（2026-10-14 用户要求）：① 官方二进制的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 是启动时读的，runner 的 `plan()` key 带上 `:compact-<n>`（`officialCompactWindow()`），换到需要另一个值的模型 = 另一个进程（`respawnWhenIdle`，resume 原对话）。**官方二进制给这个变量设了 100K 的下限**（设 50K 报 100K，120K 报 120K，phase 27 实测）。② `fitBeforeSwitch()`：`setModel` 先 `getContextUsage`，用量超过新模型窗口（`windowOf()`：供应商设置 / 引擎默认；账号上 `[1m]` 1M、其它 200K、`default` 不管）的 80%（`FIT_SHARE`）就发 `cw_notice`（reducer 的 `cw_notice` → 一行 info 系统消息，不进 transcript），再 `send('/compact')` 等这一轮的 result，然后才换。真中转（super-nb，官方二进制）：Sonnet 5.5 用到 402K → 换 Haiku（设成 100K）→ 提示、Sonnet 压缩 402K → 1.4K（16 s，$0.14）、换过去窗口 100K、Haiku 答对压缩前清单里的规律。③ **SDK 的 `getContextUsage` 回的是驼峰**（`totalTokens` / `rawMaxTokens`），`/context` 结果行才是下划线；以前前端只读下划线，上下文小环的悬停一直是 0 / 0——`conversation.ts` 的 `contextUsageOf()` 两种都认。
- **允许时带上 updatedInput**（2026-10-14 用户报告，当时在 ccb 上）：「允许一次」/ 手机 / IM / 总览只发 `{behavior:'allow'}`；按 SDK 的 schema `updatedInput` 是必填，校验严的 CLI 会把它当成 `Tool permission request failed`。`respondPermission()` 统一补 `updatedInput: event.input`。e2e phase 27 测（默认权限模式下 Write，回一个光秃秃的 allow，文件要写出来）。
