# 自己的引擎 + 所有模型同一套能力（设计）

日期：2026-10-08。状态：用户已逐节确认（第 1–5 节），待审阅本文档。

## 0. 目标与范围

**用户要的**：不管接的是哪家供应商（官方 DeepSeek、OpenAI / Gemini / Grok 格式的中转、任何 OpenAI 兼容接口、
Claude 格式的中转、Claude 账号），模型菜单里的东西一样，而且每一样在那个模型上**真的起作用**，不是藏起来或摆设。
为此我们改引擎本身：用户的私有仓库 `ypyik0669/claude-code`（ccb 2.8.4 的完整源码，bun 构建）。

**这一轮**（本文档）：

1. 自己的引擎包（第 1 节）；
2. 思考强度在所有模型上生效（第 2 节）；
3. 深度编排、自动判断在所有模型上生效（第 3 节）；
4. claude-web 这边的配合（第 4 节）；
5. 测试与上线（第 5 节）。

**不在这一轮**（各自下一轮、各自一份设计）：更多接口类型（Azure OpenAI、本机 Ollama / LM Studio 免 Key 等）、
工具兼容（函数调用弱的模型、MCP 细节）；其它 agent（Codex / Gemini CLI / ACP）这一轮不动——Codex 已有自己的档位，
ACP 协议没有这种接口。

**已确认的用户决定**：引擎发到 npm 换个包名；不支持思考强度的模型照样显示、改用提示词生效（被拒自动退回并记住）；
翻译全放在引擎里（做法 A）。

### 引擎现状（2026-10-08 读源码确认，行号指 fork 的 2.8.4）

- 思考强度只在 Claude 路径（`claude.ts` 的 `configureEffortParams` → `output_config.effort`）和 ChatGPT 登录的
  Responses 路径发出去；chat/completions（DeepSeek、中转）、Gemini、Grok 一个字都不发（`reasoning_effort` 在整个仓库里不存在）。
  `modelSupportsEffort()`（`src/utils/effort.ts:34`）是名字白名单（`opus-4-7` / `opus-4-6` / `sonnet-4-6` / `deepseek-v4-pro`），
  第三方 Claude 名字一律 false，`claude-opus-5-5` 也不算；`*_SUPPORTED_CAPABILITIES` 覆盖在 firstParty（含
  `ANTHROPIC_BASE_URL` 中转）上不生效（`modelSupportOverrides.ts:48`）。
- 对话中途改强度：headless 没有 `/effort`、也没有对应的控制请求（只有 `apply_flag_settings` 改 `effortLevel`，且 setting 的
  枚举不收 `max`）；所以 claude-web 现在每改一次就重启进程，提示缓存作废。`--effort` 不收 `xhigh`（`main.tsx:1374`）。
- 思考开关：`--thinking disabled` / `MAX_THINKING_TOKENS=0` / `CLAUDE_CODE_DISABLE_THINKING` 只管 Claude 路径；
  OpenAI 路径开不开思考只看模型名里有没有 `deepseek` / `mimo`（`requestBody.ts:21`）；Gemini 关思考时也不发 `thinkingBudget:0`。
- 深度编排：Workflow 工具已编进去（`WORKFLOW_SCRIPTS` 默认开、`isEnabled: () => true`）；「ultracode is on」本来就该由宿主注入，
  引擎里**没有任何东西**会产生它（`src/skills/bundled/ultracode.ts` 只是知识型技能）。
- 自动判断：vite 构建把**每个** `.txt` 都变成了网址字符串——`rawAssetPlugin` 注册在 `build.rollupOptions.plugins` 里，
  排在 vite 自带的资源插件后面、`enforce:'pre'` 不起作用；> 4096 字节的成了不存在的 `/assets/…txt`，小的成了
  `data:text/plain;base64,…`。受影响：分类器主提示词、规则模板、ultraplan 的几份提示词。判断请求走单独的非流式
  `sideQuery`（`src/utils/sideQuery.ts:632`），强制 `classify_result`、不发 thinking 字段；官方 DeepSeek 默认在思考模式，
  回 400「Thinking mode does not support this tool_choice」；这几条路径完全没有重试（OpenAI 客户端 `maxRetries:0` 且被缓存共用）。

## 1. 自己的引擎包

- **分支**：改动做在 fork 的 `claude-web` 分支；`main` 保持上游 ccb 的样子，以后上游更新合并进来。
- **包**：npm 包名 `claude-web-engine`（2026-10-08 查过未被占用）。版本号 `<上游版本>-cw.<N>`，第一个是 `2.8.4-cw.1`；
  claude-web 写死精确版本。`bin` 只有 `claude-web-engine` → `dist/cli-node.js`（不装 `ccb` / `claude-code-best`，
  不和用户全局装的 ccb 抢名字）。`files`、`postinstall`（下载 ripgrep、装 Chrome 扩展桥）照旧。
- **引擎里认包名的地方**：`src/cli/updateCCB.ts` 的 `PACKAGE_NAME` 改成 `claude-web-engine`（`update` 子命令和 bun 全局安装检测跟着走）。
  ChatGPT 登录路径的 `originator: 'claude-code-best'` 不动（那是对 OpenAI 的标识，不是包名）。
- **发布**：fork 加 `.github/workflows/publish.yml`：推 `v*-cw.*` tag → bun ≥ 1.3 → `bun install --frozen-lockfile` →
  本设计新增的测试 → `bun run build:vite` → 构建后检查（第 3 节）→ `npm publish --access public`（`NODE_AUTH_TOKEN` =
  仓库 secret `NPM_TOKEN`，用户加一次）。第一次发布由用户登录 npm 手动执行（我准备好产物和命令）。
- **claude-web**：
  - 根 `package.json`：去掉 `claude-code-best`，加 `"claude-web-engine": "2.8.4-cw.1"`（精确版本）。
  - `server/src/claude-exe.ts` 的 `resolveEngine()`：内置的 `claude-web-engine` 优先；**不再认全局的 claude-code-best**
    （它没有这些修复）；环境变量指定路径的方式保留。官方二进制兜底不变。内部 `runtime` 值仍叫 `'ccb'`（不改协议），
    显示文字写「claude-web-engine（基于 ccb 2.8.4）」。
  - `electron-builder.yml` 的 `asarUnpack` 换成 `**/node_modules/claude-web-engine/**`（`@claude-code-best/**` 保留，
    Chrome 扩展桥还是那个包）；`search/service.ts` 找 ripgrep 改认新包。
  - 去掉引擎的「更新」按钮和 `engine.update` 请求（`npm i -g claude-code-best@latest`）：引擎跟应用一起更新；
    设置页只显示引擎版本。`UpdateSection` 的说明跟着改。

## 2. 思考强度：所有模型都有、都生效

### 2.1 档位从哪来（菜单显示什么）

按优先级：

1. 供应商模型列表自己声明的：例如官方 DeepSeek `/models` 每个模型带
   `effort: {supported_levels: ["low","high","max"], default_level: "high"}`。拉模型列表时存进
   `Provider.modelEfforts`（和 `modelNames` 同一处解析、同样随列表一起换）。
2. 我们的表（`server/src/models/catalog.ts`，web 经 `@catalog` 共用）：Claude（按版本：4.6 起有 `output_config.effort`，
   更早的只有思考预算）、OpenAI o 系列 / gpt-5 系列（low / medium / high）、Gemini 2.5（预算）/ 3（`thinkingLevel`）、
   Grok（grok-3-mini 系列 low / high）、DeepSeek（v3.1 起、flash、reasoner）。表里标 `unverified` 的照样用，出错走 2.4。
3. 都不认识的模型：五档全给（快 · 均衡 · 深入 · 更深 · 极限），走提示词方式（2.3）。

档位比我们少时，**向最近的档靠**，距离相同往高的靠（顺序 low < medium < high < xhigh < max）：DeepSeek 的
medium → high、xhigh → max。

### 2.2 每种接口发什么（引擎 `src/services/api/effortPlan.ts`，新）

`effortPlan({provider, model, level, caps}) → {mode: 'native' | 'prompt', body?: …, thinking?: …}`，所有请求构建处
（Claude 路径、OpenAI chat、Responses、Gemini、Grok、`sideQuery` 的各分支）都只问它。

| 接口 | 原生参数 |
| --- | --- |
| Claude 格式，Claude 4.6 起（账号、中转） | `output_config.effort = level`（白名单去掉，按版本判断；caps 里声明的也算） |
| Claude 格式，只有思考预算的（老 Claude、DeepSeek `/anthropic`、其它兼容端点） | `thinking: {type:'enabled', budget_tokens}`，low 2048 · medium 8192 · high 16384 · xhigh 32768 · max 63999，不超过 `max_tokens − 1` |
| OpenAI chat/completions，会推理的模型 | `reasoning_effort = <最近档>`；DeepSeek 一类默认思考的同时发 `thinking:{type:'enabled'}`（现有三种写法保留） |
| Responses（ChatGPT 登录、垫片转发的 gpt-*） | `reasoning: {effort}` |
| Gemini 3 | `thinkingConfig.thinkingLevel`：low / medium → `low`，high 及以上 → `high` |
| Gemini 2.5 | `thinkingConfig.thinkingBudget`：同上表的预算，Flash 上限 24576、Pro 上限 32768 |
| Grok（grok-3-mini 系列） | `reasoning_effort`：low / medium → `low`，其余 → `high` |
| 其它（不认识的、caps 说不会推理的、已记下「只能提示词」的） | 不发参数，走 2.3 |

同时把 Claude 路径的**自适应思考**也按版本判断（Claude 4.6 起发 `{type:'adaptive'}`），修掉
「claude-opus-5-5 在中转上 400：requires adaptive thinking」；修好并实测后再去掉 claude-web 的 `ccbMisthinks()` 绕行
（只认官方客户端指纹的中转仍按原规则走官方二进制，那是另一回事）。

### 2.3 提示词方式

不改系统提示（改了会让整段提示缓存作废），而是像 ultrathink 那样**每轮在用户消息里附一条 system-reminder**
（引擎附件类型 `reasoning_depth`）。原文（英文，给模型看的）：

- low：`Reasoning depth: low. Answer directly and keep exploration minimal; act on the most likely interpretation without extended deliberation.`
- medium：`Reasoning depth: medium. Think briefly before acting and check the obvious alternatives.`
- high：`Reasoning depth: high. Think carefully before acting: consider alternatives, read the relevant code before changing it, and verify the result.`
- xhigh：`Reasoning depth: very high. Work thoroughly: plan before acting, weigh several approaches, and verify each step and the final result.`
- max：`Reasoning depth: maximum. Be exhaustive: explore alternatives, check edge cases, verify every step, and do not stop at the first plausible answer.`

**不压输出长度**（用户确认的偏离）：压了会把长文件改动、长命令截断；有思考预算的接口才调预算。

### 2.4 参数被拒：退回并记住

- 判据：HTTP 400 / 422，且错误文本**点名**这个参数（`reasoning_effort` / `reasoning` / `thinking` / `thinkingLevel` /
  `thinkingBudget` / `output_config` / `effort`）。没点名的 400 不记（和缓存键同一条规则）。
- 处理：同一个请求去掉参数再发一次，这个进程里这个模型之后都用提示词方式；在消息流里发一条
  `{type:'system', subtype:'cw_capability', model, capability:'native_effort', supported:false, param, status}`。
- claude-web 收到后在供应商上记 `Provider.promptEffortModels`（模型 id 列表，`upsertProvider(…, {mustExist:true})`），
  下次开对话直接提示词方式；「保存后重新检测」一起清掉（和 `noPromptCacheKey` 等三个自动标记同一处）。

### 2.5 对话中途改强度、思考开关

- 新控制请求 `set_effort {level: 'low'|'medium'|'high'|'xhigh'|'max'|null}`（null = 模型默认）：直接改
  `AppState.effortValue`，下一个请求生效，**不重启进程**；`get_settings` 照旧报当前值。`--effort` 加收 `xhigh`。
  子代理照旧继承。
- OpenAI 路径开不开思考改为看「这个模型会不会推理」（caps / 2.1 的表），名字判断（deepseek / mimo）留作兜底；
  `OPENAI_ENABLE_THINKING` 仍然优先。各家的思考内容（DeepSeek `reasoning_content`、Gemini thoughts、Responses 推理摘要）
  都进同一种思考块，界面上一样是「思考了 N 秒」。

## 3. 深度编排、自动判断：所有模型都能用

### 3.1 深度编排

- 引擎的会话开关：控制请求 `set_ultracode {on: boolean}` + 启动参数 `--ultracode`（续接时带上）。
- 开着：每轮附一条 system-reminder `Ultracode is on for this session: author and run a workflow for every substantive task by default.`；
  刚打开的那一轮再附一次 `/ultracode` 技能的说明全文（`src/skills/bundled/ultracode.ts` 的 `ULTRACODE_PROMPT`），之后只附短句。
  强度切到模型最高的原生档（有 xhigh 用 xhigh，否则按 2.1 的就近规则；提示词方式用 xhigh 那句）。
- 关掉：附一次 `Ultracode is off for this session.`，强度回到打开之前的那档。
- Workflow 工具、子代理不能再起工作流、工作流里的子代理不带思考——这些都照引擎原样。

### 3.2 自动判断

- **修构建**：`rawAssetPlugin` 挪到 vite 顶层 `plugins`（`enforce:'pre'` 在那里才生效），所有 `.txt` 都内联成文字。
  新增构建后检查 `scripts/check-inlined-text.ts`（`build:vite` 的最后一步）：`dist` 里出现 `/assets/` 开头的 `.txt` 地址或
  `data:text/plain;base64,` 字面量就失败；并断言两句原文出现在产物里：分类器主提示词的开头
`You are an automated security classifier for Claude Code` 和规则模板的 `The following types of actions should be auto-approved:`。
- **强制工具 + 思考**：`sideQuery` 是判断、命令解释（`explain_command`）等强制工具调用的共同出口（联网搜索的 haiku 路径走主循环，同样处理）：
  - 默认会思考的模型（caps 说会推理、或名字兜底）在强制工具的请求上一开始就关思考：OpenAI 兼容端点发
    `thinking:{type:'disabled'}`（有 `enable_thinking` / `chat_template_kwargs` 写法的模型一并关）；官方 OpenAI 端点
    （`api.openai.com`）不发这些字段（它会拒绝不认识的参数）。
  - 仍被拒且错误同时提到 thinking 和 tool_choice → 关思考再发一次；还被拒且提到 tool_choice → 改成 `tool_choice:'auto'`
    （工具照给）再发一次，回答里有这个工具调用就照常读，没有才按原规则判为不可用。
- **重试**：这些侧路请求在 OpenAI / Grok / Gemini 路径上，遇到连接错误、超时、5xx、429 重试一次（429 按 `retry-after`，最多等 10 s，
  其余等 1.5 s）。OpenAI 侧路请求用自己的客户端实例，不再拿主循环那个 `maxRetries:0` 的缓存实例。
- 判断用的模型仍是对话本身的模型（现状）。claude-web 缓存垫片里已经加的「强制工具被拒就关思考重发」保留，作为第二层。

## 4. claude-web 这边

- **把模型能力告诉引擎**：开对话（含续接、热切换、IM / 定时任务 / 目标 / 编排经 pool 开的）时，runner 设环境变量
  `CLAUDE_WEB_MODEL_CAPS`，值是这个供应商（或账号）每个模型的能力 JSON：
  `{"<model>": {"levels": ["low","high","max"], "default": "high", "reasoning": true, "native": false}}`
  （`native:false` = 已记下只能提示词）。来源：`Provider.modelEfforts` > catalog 的表 > 不写（引擎按 2.1 的第 3 条处理）。
- **收引擎报回的被拒**：runner 认 `cw_capability` 消息，写 `Provider.promptEffortModels`，不往前端转发这条（前端只从
  session info 读结果）。
- **供应商数据**：`Provider.modelEfforts?: Record<string, {levels: EffortLevel[]; default?: EffortLevel}>`、
  `Provider.promptEffortModels?: string[]`；两个字段进 `upsertProvider` 的清理表。`parseModelList()` 一并解析
  `effort.supported_levels` / `default_level`（只收我们认识的五个值）。
- **会话 info**：在我们的引擎上每个模型 `supportsEffort: true`、`supportedEffortLevels` 按 2.1 算，并多一个
  `effortMode: 'native' | 'prompt'`；`supportsUltracode` 在我们的引擎上为 true。
- **菜单**：去掉 `effortStaysHome()`；「智能程度」对所有供应商、所有模型出现，下面那句说明后加「（原生）」/「（通过提示词）」，
  提示词方式的 tooltip 写明「这个模型没有思考强度参数，通过提示词告诉它想多深」；深度编排开关在我们的引擎上对所有模型出现，
  说明里写「会开很多个子任务，费 token」。芯片文字不变（`DeepSeek-V4.1-Flash · 深入`）。
- **改强度 / 深度编排**：我们的引擎上走 `set_effort` / `set_ultracode`，不再 `respawnWhenIdle()`；官方二进制保持现在的
  `/effort` 路径。

## 5. 测试与上线

- **引擎（fork，bun test）**：`effortPlan` 每种接口 × 每档的输出、就近规则；各请求构建器的请求体（OpenAI chat 的
  `reasoning_effort`、Gemini `thinkingLevel` / `thinkingBudget`、Grok、Claude `output_config.effort` / 预算 / 自适应）；
  被拒后去参数重发 + `cw_capability` 事件；提示词方式的 reminder；`set_effort` / `set_ultracode` 控制请求；
  sideQuery 强制工具关思考与逐级退回、重试；构建后检查；`node dist/cli-node.js -p` 对着假服务器跑一遍。
- **claude-web**：单测（`parseModelList` 的档位、caps 环境变量、`cw_capability` 写回、菜单、runner 不重启）；新 e2e
  `server/ws-phase22.mjs`（进 `scripts/e2e.mjs` 默认列表）：每种接口一个假上游，断言真引擎实际发出的参数、提示词方式的
  reminder、被拒退回并记住、改强度进程不换、深度编排的 reminder、判断请求关思考；原有 phase 18 / 19 / 20、ui-smoke。
- **真机**（小请求，Key 只放 scratchpad）：官方 DeepSeek 上强度 / 提示词方式 / 自动判断 / 深度编排各跑一次；一个 Claude 格式中转
  （之前测试用过的 Key）上 Claude 的强度和自适应思考。
- **上线顺序**：引擎 `2.8.4-cw.1`（第一次由用户登录 npm 发布）→ claude-web 换依赖 → 和之前没推的提交一起发 v0.1.8。
  推送、发版都等用户点头。

## 6. 风险

- 引擎和上游分叉：改动集中在新文件（`effortPlan.ts`、附件、控制请求）和少数调用点，`main` 跟上游、`claude-web` 分支合并上游。
- 表里的参数写法有的没在官方文档核实（标 `unverified`）：出错时 2.4 自动退回提示词方式，不会让对话失败。
- 提示词方式的效果不如原生参数可量化：菜单里如实标「通过提示词」。
- npm 发布依赖用户的账号；公开的 npm 包等于公开构建产物（和现在的 ccb 一样，源码本来就公开）。
