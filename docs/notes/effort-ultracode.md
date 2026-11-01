# 思考强度 / 深度编排（2026-10-08）

历史：这篇原来写的是「在所有模型上」——我们自己的引擎（ccb fork）把强度翻译成各家接口的参数（OpenAI `reasoning_effort`、Gemini `thinkingLevel`…）、
不能发参数的走提示词、被拒记进 `promptEffortModels`（`cw_capability`）、`CLAUDE_WEB_MODEL_CAPS` / `CLAUDE_WEB_SERVED_MODELS`、网关里的强度转换、
自动判断的逐级退回（fork 的 `sideQueryRetry.ts`）。2026-11-01 引擎、别的供应商格式和网关都删了（见「只留 Claude」），这些都不在了；
spec `docs/superpowers/specs/2026-10-08-own-engine-uniform-capabilities-design.md` 只当历史看。

- **档位**：low < medium < high < xhigh < max；模型档位不全时就近，距离相同往高的靠（`catalog.ts` 的 `nearestLevel()`；DeepSeek `{low,high,max}`：medium → high、xhigh → max）。
- **每个模型的档位**（`models/catalog.ts` 的 `modelCaps(provider, model)`）：供应商 `/v1/models` 里每个模型的 `effort.supported_levels` / `default_level`（`providers/service.ts` 的 `parseModelList` 记进 `Provider.modelEfforts`）> 表（`tableCaps()`：Claude 的 id 用 catalog 的逐模型档位，Opus / Sonnet 4.6、Sonnet 4.5 没有 xhigh；catalog 里没有的按版本）> 全部五档。`reasoning` = 两边有一边认识。账号的模型表是别名（default / opus / sonnet…），先按 catalog 的 `aliases` 换成真模型。
- **菜单给不给强度**（`session-runner.ts` 的 `modelEntry`）：账号照 Claude Code 自己报的（`supportsEffort` / `supportedEffortLevels`）；供应商的模型只有 `modelCaps().reasoning` 的才给——Claude Code 只对它认识的模型发强度，没有提示词方式。欢迎页、运行中、没在跑的对话都用 `features/models/intelligence.ts` 的 `claudeEffortView()`。
- **深度编排**（`supportsUltracode`）：Claude Code 只有对话里的 `/effort ultracode`。开对话时就选了（欢迎页、重开）：runner 在第一条消息之前补发（开对话时就发会凭空生成一个以这条命令为标题的对话）。欢迎页 / 没在跑的对话上选档位会同时关掉深度编排（`store/reopen.ts` 的 `mergeResume()`，和运行中的 `setEffort` 同一条规则）。
