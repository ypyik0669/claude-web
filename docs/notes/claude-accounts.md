# 其它 Claude 账号（2026-10-15，用户要求）

用户问能不能「切换 Claude 账号或者多账户一起存在，随时切换」。做成：每个额外的账号是一个供应商档案，类型 `claude-account`，`apiKey` 存 `claude setup-token` 打出来的长期令牌（`sk-ant-oat01-…`，一年有效，只有 inference 权限）。`~/.claude` 里原来的登录照旧是「Claude 账号」（`providerId: 'claude'`），不动它。

## 为什么是档案而不是换登录文件

- 换 `~/.claude/.credentials.json`（社区的 account switcher 那种）是全局的：命令行也跟着换；正在跑的进程刷新令牌时会把旧账号写回去；macOS 在钥匙串里。不要。
- `CLAUDE_CONFIG_DIR` 一个账号一个目录：对话记录（projects/）也跟着分家，侧栏就看不到了。不要。
- `CLAUDE_CODE_OAUTH_TOKEN` 是 CLI 自己支持的（`ANTHROPIC_AUTH_TOKEN` 比它优先，所以要清掉；当时在 ccb 源码的 `LC()` 里查到的），按进程给，对话之间互不影响，切换就是已有的「换供应商 = 无感重启」。

## 怎么接的

- `providers/service.ts`：`providerEnv` 的 `claude-account` 分支 = `CLAUDE_CODE_OAUTH_TOKEN` + 把 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` 设成 `''`（空串 CLI 当没设）。`upsert` 时 `models` / `modelNames` 填 Claude 的目录（`accountModels()`），`refreshModels` 也只是重填目录，不拉列表。`probe` 走 `probeAccount()`：先看令牌形状（`OAUTH_TOKEN`），再用 haiku 真跑一轮（`chatProbe`）。
- `catalog.ts`：`providerTypesFor('claude')` 加上它（只有 Claude 能用）；`modelCaps` 把它当 Anthropic。
- **runner**（`session-runner.ts`）：`claude-account` 的档案不放进 `this.provider`，放 `this.account`，走「Claude 账号」那条路——CLI 自己的模型列表、别名、强度、窗口都和 ~/.claude 登录一样；只是 env 里多了令牌，`userAnthropicEnv()` 换成 `NO_RELAY`（用户 settings.json 里指向中转的 env 不算），进程 env 里的 `ANTHROPIC_*` 删掉，settings 文件里的路由键经 `settingsOverride` 清空。`info.providerId / providerName` 还是这个档案，芯片显示「工作号 / Opus 5.5」。
- **界面**：设置 → 账号与登录 → 其它 Claude 账号（`settings/ClaudeAccounts.tsx`）：列表（设为默认 / 测试 / 改名 / 移除）和「添加账号」。添加的对话框画在 App 里（`AddAccountHost`）：点「在终端里运行 claude setup-token」会开终端标签，这会关掉设置页——对话框放在设置页里的话就跟着没了，令牌永远收不到（第一版就是这样，smoke 抓到的）。终端跑的时候对话框缩成右下角的小卡片，不挡终端（登录过程可能要按键 / 粘贴）。令牌从终端输出里读（`account-token.ts tokenIn()`：去掉 ANSI、ConPTY 用光标移动代替换行、行尾补空格、被窗口折成两行都要认；行没收完不算），用户自己在框里打了字就不再覆盖。
- 设置 → 供应商的列表里不显示这些档案（它们没有地址、没有模型列表），只有一行「其它 Claude 账号 · N 个」指过去。模型菜单里这类分组的标签显示「Claude 账号」、图标用 Claude 的。上下文小环按 server 报的 `info.contextWindow` 算（A7 起是档案自己的 200K / 1M，见下一节）。

## 200K / 1M 和自动压缩（2026-10-24，A7）

- 档案自己存 `contextWindows`（族键 `opus` / `sonnet` / `fable` → `200000 | 1000000`，没写 = 1M）和 `compactAt`；在「其它 Claude 账号」那一行点「编辑」
  （`data-act="account-profile-edit"`，title 是摘要），和自己登录用同一个框（`AccountWindowsDialog`），保存走 `providers.upsert`，`null` 清掉。
- runner 走账号那条路：选 1M 的族带 `[1m]`，`compactAt` 经 `settingsOverride` 压过 settings.json；
  改了档案 → `reprovide`（以前 `reprovide` 对 `this.account` 直接返回，A7 补上了）。正在跑的对话不用重新打开：这一轮结束后换过去（重启进程、resume）；
  窗口变小（Opus 1M → 200K）而对话已经超过新窗口的 80% 时，先在现在的窗口上 `/compact` 再换（`fitForShrink`，和自己登录的 `setAccountPrefs` 共用；
  正在跑一轮就等这一轮结束，`deferredChange`）。以前档案这条路直接重启，新进程连对话都读不下（最终审查 I2）。
- 「默认 1M」只在 Max 账号上实测过；套餐没有长上下文的账号发 `[1m]` 会被拒，那就在「编辑」里把对应的族改成 200K。
- 档案的 env 把 `ANTHROPIC_BASE_URL` 设成 `''`，但对话自己的环境（`features.env`）排在后面能盖过它——e2e `ws-phase32.mjs` 就是这样把档案的对话接到假上游的
  （请求带 `oauth-2025-04-20` 和 `context-1m-2025-08-07` beta、Bearer 是档案的令牌）。

## 验证

- 单测：`providers/service.test.ts`（env、存的模型、形状检查、只给 Claude）、`runtime/session-runner.test.ts`（账号那条路 + 令牌 + 环境里的中转被清掉）、`settings/account-token.test.ts`（真实的 cmd 输出、ConPTY 光标、两行、没收完）。
- `server/ws-phase29.mjs` 最后一段：存下、令牌不上线、形状不对直接拒、刷新保持目录。
- **真机**（2026-10-15）：用本机 Max 账号的访问令牌当 `claude-account` 的令牌，临时 HOME（没有 ~/.claude 登录），进程环境里故意放一个假中转（`ANTHROPIC_AUTH_TOKEN` + 不可达的 `ANTHROPIC_BASE_URL`）：当时 ccb 和官方二进制都测试通过、真对话回答 `account-ok`。测试脚本只在临时目录里，令牌不打印。
- 没在真机上走完 `claude setup-token`（要在浏览器里登另一个账号）；令牌读取用 cmd 真实输出验证。
