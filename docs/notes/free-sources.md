# 免费来源与托管程序（2026-10-26，spec「统一模型来源」切片 4）

设计：`docs/superpowers/specs/2026-10-26-unified-model-sources-design.md` §3.1 / §3.2 / §5.3 / §6。界面在
`web/src/features/gateway/`（另一个切片），本切片只出服务端：`channels.*` 和 `engines.*`。

## 结构

- `server/src/channels/catalog.ts` — 来源目录。三层：内置基线 `BASELINE`（离线可用）< 签名远程目录 < 用户改动
  （`meta.channelCatalog`：`hidden` / `patch`）。第四层是来源自己的实时 `/models`，在投影时用。
  - 基线的每个值都来自调研笔记（`research_notes/免费模型来源深度调研/B_official_free_tiers.md`、`A_keyless_pools.md`、
    `research_notes/可反代的模型上游调研/cherry-studio.md` 的 34 家 Anthropic 端点表）。**笔记里没有的值就不填**
    （比如 Cerebras 的注册页、各家 authStyle、大部分模型 id），别凭记忆补。
  - `notes` 是不带语言的代码（`real-name` / `one-concurrent` / `parallel-tools-off` / `list-any-key` / `logged` …），
    界面自己翻成字。`limits` 是厂商（或聚合清单）原话，英文。
  - 远程目录：设置 `channels.remoteCatalog = { enabled, url, publicKey }`，默认关。Ed25519 签名覆盖 `entries` 的
    JSON；字段白名单、只收 https / 本机地址、`modelFilter` 必须是合法正则；远程不能新加引擎 / 登录类条目，也不能改
    内置条目的 `driver`；验过的副本存 `<dataDir>/channels/catalog-remote.json`，更新失败用上次的。
    **还没有正式的公钥和发布地址**——这是个桩，等有人维护目录再填。
- `server/src/channels/drivers/` — ChannelDriver 注册表：`provider`（供应商档案，含免费 / 免 key）、
  `upstream:claude|gemini|workbuddy`（包现有账号池）、`engine:cliproxyapi|magpie`。凭据只走现有的存储：
  key 进 ProviderService（meta 加密），登录走 upstreams，托管程序的 key 走 SecretService。驱动自己不存任何凭据。
- `server/src/channels/service.ts` — `status()` 返回 `sources` + `available`（目录，带 `added` / `overridden`）；
  `add(catalogId, key?)` 一步建好；`remove(id)`；`setCatalog` / `updateCatalog`。
- `meta.channelLinks`：供应商 id → 它来自哪条目录（`keyless` / `engine` 标记）。供应商被删时链接留着也无害。
- `server/src/engines/` — EngineManager（`manager.ts`）、进程（`process.ts`）、清单（`manifests/index.ts`）、
  `handlers.ts`。`engines.*` 和 `channels.*` 都不带 sessionId，所以**不进联邦路由表**。

## 一步添加（channels.add）

1. 按目录条目建供应商：`type` = 条目 protocol，`baseUrl` 原样，key 存 ProviderService；条目有 `authStyle` 就一起写
   （隐私切片会给 Provider 加这个字段，现在 meta 原样存着）。
2. 拉 `/models`；失败就**删掉刚建的档案**再报错（不留半成品）。
3. 按 quick connect 的规则选默认模型（`channels/plan.ts`；Anthropic 格式顺带三家族映射）。
4. 免费专用来源（Kilo、OpenRouter :free、GLM-Flash）有 `modelFilter`：`ProviderService.modelFilter` 钩子让之后
   每次自动刷新也只留免费模型——Kilo 的列表有 400 个，大多是要登录的付费模型（`PAID_MODEL_AUTH_REQUIRED`）。

## 免 key（Kilo）

- 实测（2026-10-26）：`https://api.kilo.ai/api/gateway/v1/models` 和 `/v1/chat/completions` 不带鉴权、带随便一个
  Bearer 都是 200。所以免 key 来源存一个占位 key `anonymous`（`KEYLESS_KEY`）——CLI 和网关总会发 Bearer，
  而 refreshModels 没 key 会直接报「没有 API Key」。
- base 要带 `/v1`：`modelsUrl` / `openaiBase` 会补 `/v1`，不带的话变成 `/api/gateway/v1/...` 也恰好能用，但存带的更稳。
- 提示词可能被上游记录 / 训练（`mayTrain`、`logged`）。

## 托管程序（engines）

- **桌面安装包自带一份**（2026-10-28，用户要求「打进桌面安装包」）：`server/src/engines/manifests/bundled.json`
  钉住 CLIProxyAPI / Magpie 的版本、平台 asset、URL、大小和 SHA-256；`scripts/engines/fetch.mjs` 在打包前下载、
  校验、解压到 `vendor/engines/<platform>/<id>/`（`version.txt` 记版本）。`electron-builder.yml` 把它作为
  extraResources 放到 `<resources>/engines`，`desktop/src/server-host.ts` 用 `CLAUDE_WEB_ENGINES` 告诉服务器；
  `EngineManager` 先找用户装过的版本，再找随包的 build（`bundled: true`），两者都没有才联网下载。所以新装的桌面版
  第一次点「启动」不会先下载引擎。`build:desktop*` 和 release workflow 都会先跑 `engines:fetch`。
- 下载（开发 / 浏览器版，或随包版本缺失）：GitHub releases API（`/releases/latest` 或某个 tag）。按文件名里的
  系统 / CPU 词挑 asset，排除校验文件和安装器。下面这些 asset 名是 2026-10-26 当时测的（随包版本见上）：
  - CLIProxyAPI `router-for-me/CLIProxyAPI` v8.0.44：`CLIProxyAPI_<v>_<os>_<amd64|aarch64>.tar.gz|zip`，另有
    `_no-plugin` 版（不选）、`checksums.txt`。
  - Magpie `yetone/magpie-releases` v0.1.1657：`magpie-cli-<os>-<arch>[.exe]`（选这个，纯命令行）和桌面版
    `magpie-<os>-<arch>`、`.dmg` / `.zip`，`SHA256SUMS`。
  - 两边每个 asset 都有 GitHub 的 `digest: sha256:…`，先用它，其次 checksums 文件；都没有才「首次安装记下哈希」
    并在状态里警告（`verified: 'recorded'`）。
- 版本：随包版本写在 `bundled.json`（当前 CLIProxyAPI v8.0.45 / Magpie v0.1.1803）；手动安装装的是 latest，
  之后**不自动升级**；`engines.upgrade` 装新的、切过去、启动失败自动回到旧的；`engines.rollback` 手动回退。
  只留当前和上一个版本。随包 build 不能卸载（装的是应用的一部分），「更新」会装一份用户目录里的新 build 覆盖它。
- 运行：`127.0.0.1` + 分配的端口（上次的端口空着就沿用，供应商地址不变）；`windowsHide: true`；POSIX 上独立进程组，
  停止时 Windows `taskkill /T /F`、POSIX 杀整个组。日志 `<dataDir>/engines/logs/<id>.log`，5 MB 轮转。
  意外退出 10 分钟内最多重启 3 次。服务退出时停掉，下次启动时把上次在跑的再拉起来（`autoStart`）。
- CLIProxyAPI：写 `<dataDir>/engines/cliproxyapi/data/config.yaml`（v8 布局：`server.host/port`、
  `management.secret-key` + `allow-remote: false`、`access.api-keys`、`oauth.auth-dir`），`--config` 启动。
  客户端 key / 管理 key 生成后用 SecretService 加密存 meta。订阅登录走管理 API（见「引擎登录」一节），
  不再要求用户自己跑 `--login`。
- Magpie：`magpie serve` + `MAGPIE_ADDR=127.0.0.1:<port>`；本机任意 key 都收，用 `magpie-claudeweb`；
  健康 = `GET /api/hello` 回 `{name:"magpie"}`。它会自己后台更新（状态里有警告）。
- 已经在跑的：Magpie 查 `127.0.0.1:3425/api/hello`；CLIProxyAPI 查 `127.0.0.1:8317/v1/models` 有没有 JSON 回应
  （没 key 是 401）。查到就在 `engine.detected` 里给出，`channels.add` / `engines.connect` 走「连接」不装第二份；
  CLIProxyAPI 连接要用户给它 `access.api-keys` 里的一把 key。
- 起来之后注册成 Anthropic 格式的供应商（`http://127.0.0.1:<port>`，不带 `/v1`），`channelLinks` 标 `engine`，
  所以来源列表里只显示成托管程序那一条，模型也挂在它下面。

## 第三方登录（2026-10-28）

- `upstreams/oauth-registry.ts` 是每家登录的**数据**（公开 client id、端点、scope、回调端口、本地凭据路径、token → 账号映射）；`oauth.ts` 是 PKCE S256 / loopback / device code / Copilot token exchange；`provider-login.ts` 管会话、粘贴和本机凭据；`ProviderLoginWizard.tsx` 是界面。token 只在内存里，落地前走 `SecretService`。
- 真的能用：**Codex**（Codex CLI 的公开 OAuth client，固定 1455 回调 → ChatGPT backend `/backend-api/codex/responses`，新增 Responses 出站）、**GitHub Copilot**（GitHub device flow → `copilot_internal/v2/token` → `api.githubcopilot.com/chat/completions`）、**OpenCode**（读 `auth.json`：Anthropic OAuth 变 Claude 账号，OpenAI / Google key 变 provider 账号）、**Claude Code 本机**（`~/.claude/.credentials.json` 或 `CLAUDE_CONFIG_DIR`）。
- 原生 OAuth 列不出来、明确标不可用的：Gemini（Code Assist 不是网关的三种 wire）、Antigravity、Kimi、Grok、Devin、Kiro、Cline、Qoder、Trae、WorkBuddy、ZCode、Factory、MiMo。**不要为了凑数伪造 OAuth client 或接口地址。** 这些现在通过「引擎登录」交给 Magpie / CLIProxyAPI 的原生实现（见下一节），不是 `upstreams/oauth-registry.ts` 里的假 client。
- 账号模型：`UpstreamKind` 加了 `provider`；账号带 `providerId`，探测走 vendor 的 `/models`，网关按 `protocol` / `chatPath` / 额外 headers（Copilot 的 editor 头、Codex 的 originator / account id）发请求。`responses` 出站只在 Codex 这一类目标上用。
- 局限：Codex / Copilot 没有真实账号联网验过（单测用 fake fetch + 真 loopback）；Codex 的 ChatGPT backend 可能改流式要求；Copilot 受 GitHub 滥用 / 限流策略限制；provider 账号的额度卡还没做。

## 引擎登录：直接拿 Magpie / CLIProxyAPI 的实现（2026-10-28）

- 不重写厂商协议。`engines.login.*` 把登录交给已经能跑这些订阅的本地网关：
  - **CLIProxyAPI**：`/v0/management/{anthropic,codex,antigravity,kimi,xai}-auth-url?is_webui=true`（management key 走 `Authorization: Bearer`），状态 `get-auth-status?state=`，取消 `DELETE oauth-session?state=`；它保存 auth 文件，网关直接供模型。
  - **Magpie**：托管启动时加 `--web=127.0.0.1:<webPort>` + `MAGPIE_WEB_KEY`，调它的 `/api/signin`、`/api/signin/{id}`、`/api/signin/{id}/cancel`；provider 插件（Qoder、Trae CN、WorkBuddy、ZCode、Kiro、Devin、Factory、MiMo、Cline 等）由 Magpie 自己安装/登录。
- 映射：`mimo-app → mimo`、`trae-cn → trae`、`xai → grok`、`anthropic → claude`；`EngineLoginProvider` 是唯一的对照表。
- 界面：MCP 引擎详情/来源页有「登录账号」；来源卡片的添加向导在原生登录不可用时显示「通过 CLIProxyAPI / Magpie 登录」。账号留在引擎的账户库里，模型出现在引擎来源下，不把 token 复制到 claude-web。Magpie 的每行还有「从文件导入…」，走它的 `/api/signin/import`，可吃 Sub2API / CLIProxyAPI / Codex / Claude / Antigravity 的导出文件（8 MB 上限；文件只在内存里转给本机 Magpie）。
- 不是托管启动的 Magpie / CLIProxyAPI（用户自己起的）不登录：它们的令牌/配置归用户，界面明确说去它们自己的管理页。Magpie 的 `--web` 端口和 key 都存在本机 meta（key 加密）。
- 测试：`EngineManager.loginProviders` 的映射；真实 v7 `/v0/management/anthropic-auth-url?is_webui=true` 实测返回 URL/state；UI 探针确认 Antigravity 卡会出现两条引擎登录入口。**没有真实账号完整走完厂商授权**（需要用户的账号和浏览器）。
- 桌面安装包自带这两个引擎，所以这条登录路径开箱可用，不需要用户先下载 Magpie / CLIProxyAPI（见「托管程序」一节）。

## 还没做 / 不知道的

- 远程目录：有公钥 / 地址的验签和合并，但 `CATALOG_PUBLIC_KEYS` 还是空的，发版带公钥前远程层不生效。
- 来源健康（2026-10-28，`channels/health.ts`，`channels.health.status / probe`）：来源卡片上的「检查」= 读模型列表，
  免费来源再真调一次（`max_tokens: 1`）；列表每来源 60 秒最多一次、真调用 10 分钟最多一次，冷却中不发。卡片显示
  429 冷却倒计时、剩余额度（来自 `routing/quota.ts`，网关的每次回应也在喂）、上次检查结果。没有自动定时检查。
- CLIProxyAPI 自己的订阅登录（`--login`）和 Magpie 的账号页现在走引擎登录（见上一节）；但用户自己启动的副本仍要在它们自己的管理页登录。CLIProxyAPI 的检测只是「有 JSON 回应」。
- Cherry 列表里 opencode（base 带 `/v1`，不确定）、vertex / bedrock（SDK 拼地址）、new-api / aionly（没地址）没收。

## Grok 网页账号（2026-11-04，用户反馈「没有 grok 账号反代」）

- 目录项 `grok-web`（driver `grok-web`，`channels/drivers/grok-web{,-core}.ts`）：本机起一个 OpenAI chat-completions 小接口（127.0.0.1 随机端口），每个账号一条 openai 供应商档案指向它。**档案的 key 就是凭据**（`grok1.<base64url JSON>`：sso / cf_clearance / __cf_bm / ua），接口自己不存东西，一个接口服务所有账号。
- 协议照 CNFlyCat/GrokProxy（MIT）和 AIClient2API 的 grok-web（GPL-3.0，只读协议没抄代码）：`POST grok.com/rest/app-chat/conversations/new`，body 的 `modeId`（auto/fast/expert/heavy/grok-4-1-thinking/grok-4-1-mini），`temporary: true`；整段对话压成一条 message；返回 NDJSON（`result.response.token`、`isThinking`、`modelResponse.generatedImageUrls`）。思考走 `reasoning_content`。
- 工具调用靠提示词模拟（`<tool_call>{…}</tool_call>`），带 tools 时整段答完才吐出。
- 添加时用 `/rest/rate-limits` 探一下：401 拒绝添加，其它问题（Cloudflare 403 等）照样加上、卡片显示原因。Cloudflare 拦时让用户粘整段 Cookie（带 cf_clearance）并在末尾加 `; ua=<浏览器 UA>`。没做 utls 指纹垫片。
- **没验的**：真 grok.com 账号（这台机器没有）；只有单测 + 假 grok 的端到端。
