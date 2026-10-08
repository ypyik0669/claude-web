# 自己的引擎 + 所有模型同一套能力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用用户的 ccb fork 发一个自己的引擎包 `claude-web-engine`，让思考强度、深度编排、自动判断在每种接口、每个模型上都真的生效，并把 claude-web 换到这个引擎上。

**Architecture:** 引擎里新增一层能力规划（`effortPlan`）：每个请求构建处只问它「这个模型这一档发什么」——原生参数、提示词（每轮一条 system-reminder），或被拒后自动退回；claude-web 用环境变量告诉引擎每个模型的能力，引擎用一条 `cw_capability` 系统消息报回被拒。改强度 / 深度编排走 SDK 现成的 `applyFlagSettings`，不重启进程。

**Tech Stack:** 引擎：TypeScript + bun 1.4（`bun test`、`bun run build:vite`，vite 8）。claude-web：Node 22 + TypeScript + vitest，`@anthropic-ai/claude-agent-sdk`。

**Spec:** `docs/superpowers/specs/2026-10-08-own-engine-uniform-capabilities-design.md`

## Global Constraints

- 两个仓库：**引擎** = 用户的私有仓库 `https://github.com/ypyik0669/claude-code.git`，本地完整克隆在 `C:\Users\YPY\claude-code`，所有改动在 `claude-web` 分支（`main` 不动）；**claude-web** = `C:\Users\YPY\claude-web`（当前 `main`）。
- 引擎包：npm 名 `claude-web-engine`，版本 `2.8.4-cw.1`，`bin` 只有 `claude-web-engine` → `dist/cli-node.js`。claude-web 写死精确版本。
- 档位顺序 `low < medium < high < xhigh < max`；档位不全时向最近的档靠，**距离相同往高的靠**（DeepSeek `{low,high,max}`：medium → high、xhigh → max）。
- 思考预算：low 2048 · medium 8192 · high 16384 · xhigh 32768 · max 63999；Claude 路径不超过 `max_tokens − 1`；Gemini 2.5 Flash 上限 24576、Pro 上限 32768。
- 环境变量 `CLAUDE_WEB_MODEL_CAPS`，形状 `{"<model>": {"levels": EffortLevel[], "default"?: EffortLevel, "reasoning"?: boolean, "native"?: boolean}}`；`native:false` = 已记下只能提示词。
- 被拒事件：SDK 消息 `{type:'system', subtype:'cw_capability', model, capability:'native_effort', supported:false, param, status, session_id, uuid}`。
- 提示词方式、深度编排的原文以 spec §2.3 / §3.1 为准，一字不改。
- 提示词方式**不压输出长度**。
- 被拒判据：HTTP 400 / 422。点名参数（`reasoning_effort` / `reasoning` / `thinking` / `thinkingLevel` / `thinkingBudget` / `output_config` / `effort`）才记住；没点名的这一次也去掉参数重发一次，但不记。
- 不在仓库里放真实密钥；测试只用通用假值；每次提交前扫 staged 的 `sk-` 长串。
- 不碰真实的 `~/.claude`、`~/.codex`、`~/.claude-web`（只读可以）；跑 server 一律临时 HOME + `CLAUDE_WEB_DIR`；不连、不停 127.0.0.1:3090；只杀自己起的进程。
- 两个仓库的提交身份都是 `ypyik0669 <112962935+ypyik0669@users.noreply.github.com>`；Windows 上用 Edit / Write 改文件（不用 Python 文本模式、不在双引号 `node -e` 里写反引号）。
- **推送 fork 的 `claude-web` 分支、npm 发布、claude-web 推送和发版：每一项都先问用户。**
- claude-web 默认界面的文字规则不变（`wording.test.ts`：不出现「档案 / 引擎 / effort / ultracode」等实现词，tooltip 除外）。

## Review Focus

1. **中转对 `reasoning_effort` 回一个没点名的 400**（「invalid request」）：这一轮必须照样答出来（去掉参数重发一次），不能每轮都失败——测试加在 Task E6。
2. **`CLAUDE_WEB_MODEL_CAPS` 是坏 JSON、不是对象、或某个模型的值不对**：引擎当作没有这个变量，绝不崩——测试加在 Task E3。
3. **各种写法的模型 id**：`claude-opus-5-5[1m]`、`anthropic/claude-sonnet-4.6`（OpenRouter 的点号）、`claude-opus-4-6-20260101`、`us.anthropic.claude-sonnet-4-6-v1:0`（Bedrock）都要认出版本——测试加在 Task E4。
4. **深度编排开着时改强度**：等于离开深度编排（和现在 claude-web 的规则一致），两件事一次发过去，不能留下「深度编排开着、档位却是 low」——测试加在 Task W4。
5. **「保存后重新检测」之后**：已记下的「只能提示词」被清掉，下一个对话又试原生参数——测试加在 Task W2。

---

## 引擎（fork）

所有命令在 `C:\Users\YPY\claude-code` 里执行。单测放在被测文件旁边的 `__tests__/`（仓库现有约定），`bun test <文件>` 跑。

### Task E1: 工作区与包身份

**Files:**
- Modify: `package.json`（`name`、`version`、`bin`）
- Modify: `src/cli/updateCCB.ts:19`（`PACKAGE_NAME`）
- Test: `src/cli/__tests__/updateCCB.test.ts`（新建）

**Interfaces:**
- Produces: 能 `bun run build:vite` 的 `claude-web` 分支；`dist/cli-node.js --version` 打印 `2.8.4-cw.1`。

- [ ] **Step 1: 完整克隆并建分支**

```bash
git clone https://github.com/ypyik0669/claude-code.git /c/Users/YPY/claude-code
cd /c/Users/YPY/claude-code
git config user.name ypyik0669 && git config user.email 112962935+ypyik0669@users.noreply.github.com && git config core.autocrlf false
git checkout -b claude-web
bun install --frozen-lockfile
```
Expected: 安装成功（postinstall 下载 ripgrep，失败也 exit 0）。

- [ ] **Step 2: 写失败的测试** `updateCCB.test.ts`：`expect(PACKAGE_NAME).toBe('claude-web-engine')`（需要时把 `PACKAGE_NAME` export 出来）。
- [ ] **Step 3: 跑** `bun test src/cli/__tests__/updateCCB.test.ts` → FAIL。
- [ ] **Step 4: 改** `package.json`：`"name": "claude-web-engine"`、`"version": "2.8.4-cw.1"`、`"bin": {"claude-web-engine": "dist/cli-node.js"}`；`updateCCB.ts` 的 `PACKAGE_NAME = 'claude-web-engine'`。`repository`、`files`、`scripts.postinstall` 不动。
- [ ] **Step 5: 跑测试 + 构建** `bun test src/cli/__tests__/updateCCB.test.ts && bun run build:vite && node dist/cli-node.js --version` → PASS，最后一行含 `2.8.4-cw.1`。
- [ ] **Step 6: 提交** `git commit -am "chore: publish as claude-web-engine 2.8.4-cw.1"`（新测试文件 `git add`）。

### Task E2: 构建把所有 `.txt` 内联成文字 + 构建后检查

**Files:**
- Modify: `vite.config.ts:104-108`（`rawAssetPlugin` 从 `build.rollupOptions.plugins` 挪到顶层 `plugins`）
- Create: `scripts/check-inlined-text.ts`
- Modify: `package.json` 的 `build:vite`（末尾加 `&& bun run scripts/check-inlined-text.ts`）
- Test: `scripts/__tests__/check-inlined-text.test.ts`

**Interfaces:**
- Produces: `export function findTextAssetProblems(files: {path: string; text: string}[]): string[]`（空数组 = 通过）；脚本对 `dist/**/*.js` 调它，非空就打印并 `process.exit(1)`。

- [ ] **Step 1: 写失败的测试**：
  - 含 `"/assets/auto_mode_system_prompt-BOUkwTgh.txt"` 的文件 → 结果里有一条点名它；
  - 含 `"data:text/plain;base64,IyMg"` → 有一条；
  - 两句原文 `You are an automated security classifier for Claude Code` 和 `The following types of actions should be auto-approved:` 都不在任何文件里 → 各有一条「缺少 …」；
  - 两句都在、没有坏地址 → `[]`。
- [ ] **Step 2: 跑** `bun test scripts/__tests__/check-inlined-text.test.ts` → FAIL。
- [ ] **Step 3: 实现** `findTextAssetProblems`，并挪 `rawAssetPlugin`。
- [ ] **Step 4: 验证** `bun test scripts/__tests__/check-inlined-text.test.ts && bun run build:vite` → 测试 PASS，构建成功；`grep -rl "You are an automated security classifier" dist/chunks | head -1` 有输出，`grep -rlE "/assets/[^\"']+\.txt|data:text/plain;base64" dist | wc -l` 为 0。
- [ ] **Step 5: 提交** `fix(build): inline every .txt (auto-mode classifier prompt, permissions template, ultraplan prompts) and fail the build if one is not`。

### Task E3: 读 claude-web 给的模型能力；记住被拒的模型

**Files:**
- Create: `src/utils/model/webCaps.ts`
- Test: `src/utils/model/__tests__/webCaps.test.ts`

**Interfaces:**
- Produces:
  - `export type WebModelCaps = { levels?: EffortLevel[]; default?: EffortLevel; reasoning?: boolean; native?: boolean }`
  - `export function getWebModelCaps(model: string): WebModelCaps | undefined`：读 `process.env.CLAUDE_WEB_MODEL_CAPS`，按环境变量的字符串缓存；精确 id 优先，其次去掉 `[1m]` 后缀再比；`levels` 只留五个合法值并按档位顺序排序。
  - `export function markNativeEffortRejected(model: string, param: string): boolean`（这个进程里第一次记下返回 true）
  - `export function isNativeEffortRejected(model: string): boolean`（被记下，或 caps 的 `native === false`）
  - `export function capabilityMessage(model: string, param: string, status: number): SystemMessage`：内部系统消息，`subtype: 'cw_capability'`，带这三个字段（形状照 `createSystemMessage` 的现有写法）。

- [ ] **Step 1: 写失败的测试**：
  - 正常 JSON → 取得到，`levels` 顺序被纠正为 `['low','high','max']`；
  - `claude-opus-5-5[1m]` 能匹配到键 `claude-opus-5-5`；
  - 坏 JSON / 数组 / `levels: ['huge']` → `undefined` 或 `levels: []`，不抛错（Review Focus 2）；
  - `markNativeEffortRejected` 第二次返回 false，`isNativeEffortRejected` 为 true；
  - caps `native:false` → `isNativeEffortRejected` 为 true。
- [ ] **Step 2: 跑** → FAIL。 **Step 3: 实现。** **Step 4: 跑** → PASS。
- [ ] **Step 5: 提交** `feat: model capabilities from CLAUDE_WEB_MODEL_CAPS, and the models whose native effort was refused`。

### Task E4: `effortPlan`——每个模型、每一档发什么

**Files:**
- Create: `src/services/api/effortPlan.ts`
- Test: `src/services/api/__tests__/effortPlan.test.ts`

**Interfaces:**
- Consumes: E3 的 `getWebModelCaps`、`isNativeEffortRejected`；`APIProvider`（`src/utils/model/providerClassification.ts`）；`EffortLevel`（`src/utils/effort.ts`）。
- Produces:
  - `export const EFFORT_ORDER: readonly EffortLevel[]`（low → max）
  - `export const EFFORT_BUDGET: Record<EffortLevel, number>`（Global Constraints 的五个数）
  - `export function nearestLevel(level: EffortLevel, available: readonly EffortLevel[]): EffortLevel`
  - `export function claudeVersion(model: string): number | undefined`（`opus-4-6`、`sonnet-4.6`、`opus-5-5`、`opus-5`、Bedrock / OpenRouter 前缀都认；`claude-opus-5-5` → 5.5、`claude-sonnet-4-6` → 4.6）
  - `export type EffortTarget = 'anthropic' | 'anthropic-budget' | 'openai-chat' | 'openai-responses' | 'gemini3' | 'gemini25' | 'grok'`
  - `export type EffortPlan = { mode: 'default' } | { mode: 'prompt'; level: EffortLevel } | { mode: 'native'; target: EffortTarget; level: EffortLevel; body: Record<string, unknown> }`
  - `export function effortPlan(i: { provider: APIProvider; model: string; level: EffortLevel | undefined; chatgpt?: boolean }): EffortPlan`

**选目标的规则**（caps 和被拒记录优先于名字）：
- `level` 为 undefined → `{mode:'default'}`（什么都不发，模型自己的默认）；
- `isNativeEffortRejected(model)` → prompt；
- firstParty / bedrock / vertex / foundry：`claudeVersion ≥ 4.6` → `anthropic`；其它 Claude → `anthropic-budget`；非 Claude 名字：caps `reasoning` → `anthropic-budget`，否则 prompt；
- openai：`chatgpt` → `openai-responses`；caps `reasoning` 或名字是会推理的家族（`/^(o[134]|gpt-5)/`、含 `deepseek`、`qwq`、`reasoner`）→ `openai-chat`；否则 prompt；
- gemini：`gemini-3` → `gemini3`；`gemini-2.5` → `gemini25`；否则 prompt；
- grok：`grok-3-mini` → `grok`；否则 prompt。

**各目标的档位和 body**：

| target | 可用档位 | body |
| --- | --- | --- |
| anthropic | 五档 | `{output_config: {effort: L}}` |
| anthropic-budget | 五档 | `{thinking: {type:'enabled', budget_tokens: EFFORT_BUDGET[L]}}` |
| openai-chat | caps `levels` ?? `['low','medium','high']` | `{reasoning_effort: L}` |
| openai-responses | caps `levels` ?? `['low','medium','high','xhigh']` | `{reasoning: {effort: L}}` |
| gemini3 | `['low','high']` | `{thinkingLevel: L}` |
| gemini25 | 五档 | `{thinkingBudget: min(EFFORT_BUDGET[L], 含 flash ? 24576 : 32768)}` |
| grok | `['low','high']` | `{reasoning_effort: L}` |

其中 `L = nearestLevel(level, 可用档位)`。

- [ ] **Step 1: 写失败的测试**（表驱动），至少：
  - `nearestLevel('medium', ['low','high','max'])` → `'high'`；`nearestLevel('xhigh', ['low','high','max'])` → `'max'`；`nearestLevel('low', ['high'])` → `'high'`。
  - Review Focus 3：`claudeVersion` 对 `claude-opus-5-5[1m]`（5.5）、`anthropic/claude-sonnet-4.6`（4.6）、`claude-opus-4-6-20260101`（4.6）、`us.anthropic.claude-sonnet-4-6-v1:0`（4.6）、`claude-3-5-sonnet-20241022`（3.5）、`gpt-5`（undefined）。
  - `effortPlan({provider:'firstParty', model:'claude-opus-5-5', level:'max'})` → native anthropic、body `{output_config:{effort:'max'}}`。
  - `claude-3-7-sonnet` + high → anthropic-budget、16384。
  - openai + caps `{reasoning:true, levels:['low','high','max']}` 的 `deepseek-flash` + medium → `{reasoning_effort:'high'}`。
  - openai `gpt-4o` + high → prompt。
  - gemini `gemini-2.5-flash` + max → `{thinkingBudget: 24576}`；`gemini-3-pro` + medium → `{thinkingLevel:'low'}`。
  - grok `grok-3-mini` + xhigh → `{reasoning_effort:'high'}`；`grok-4` + high → prompt。
  - level undefined → default；被拒记录过 → prompt。
- [ ] **Step 2: 跑** → FAIL。 **Step 3: 实现。** **Step 4: 跑** → PASS。
- [ ] **Step 5: 提交** `feat: effortPlan — what each provider and model gets for each thinking-strength level`。

### Task E5: 把原生参数接进每个请求构建处

**Files:**
- Modify: `src/services/api/claude.ts:434-460`（`configureEffortParams`：不再看 `modelSupportsEffort` 白名单，改问 `effortPlan`；anthropic → 照现在的 `outputConfig.effort` + beta 头；anthropic-budget → 交给 thinking 那段）
- Modify: `src/services/api/claude.ts:1679-1713`（thinking：`claudeVersion ≥ 4.6` 发 `{type:'adaptive'}`；anthropic-budget 用计划的 `budget_tokens`，并 `min(maxOut − 1, …)`）
- Modify: `src/utils/effort.ts:34-72`（`modelSupportsEffort`：凡是 `effortPlan` 不返回 default 的都算支持——也就是所有模型；保留 `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`）
- Modify: `src/services/api/openai/requestBody.ts:21-31, 70-125`（`buildOpenAIRequestBody` 新参数 `nativeEffort?: Record<string, unknown>` 原样合进 body；`isOpenAIThinkingEnabled(model)` 先看 caps `reasoning`，`OPENAI_ENABLE_THINKING` 仍最优先，名字判断兜底）
- Modify: `src/services/api/openai/index.ts:313-315, 376-404`（算 `effortPlan`，chat 路径传 `nativeEffort`，Responses 路径仍用现有 `reasoning`）
- Modify: `src/services/api/gemini/index.ts:84-111`（`thinkingConfig` 合进计划的 `thinkingLevel` / `thinkingBudget`）
- Modify: `src/services/api/grok/index.ts:102-119`（合进 `reasoning_effort`）
- Test: `src/services/api/openai/__tests__/requestBody.effort.test.ts`、`src/services/api/gemini/__tests__/effort.test.ts`、`src/services/api/grok/__tests__/effort.test.ts`、`src/services/api/__tests__/claude.effort.test.ts`

**Interfaces:**
- Consumes: E4 的 `effortPlan`、`claudeVersion`、`EFFORT_BUDGET`；当前档位从 `resolveAppliedEffort`（`src/utils/effort.ts:182`）取。

- [ ] **Step 1: 写失败的测试**：
  - OpenAI chat：`buildOpenAIRequestBody({…, nativeEffort:{reasoning_effort:'high'}})` 的结果含 `reasoning_effort:'high'`；caps `reasoning:true` 的非 deepseek 名字也开思考三件套；`OPENAI_ENABLE_THINKING=0` 时不开。
  - Gemini：gemini-3 + high 的 `generationConfig.thinkingConfig` 含 `thinkingLevel:'high'` 且 `includeThoughts:true`。
  - Grok：grok-3-mini + low 的 body 含 `reasoning_effort:'low'`。
  - Claude 路径：claude-opus-5-5 + max 的参数含 `output_config:{effort:'max'}` 且 `thinking:{type:'adaptive'}`；claude-3-7-sonnet + low 的 `thinking.budget_tokens === 2048`；`max_tokens = 1000` 时预算被压到 999。
  - 提示词方式（gpt-4o + high）：body 里没有任何 effort / reasoning 字段。
  - 思考内容（钉住现有行为，spec §2.5 最后一句）：OpenAI 流里的 `reasoning_content` 增量、Gemini 的 `thought:true` 部分都变成 `thinking` 块；不成立就在这个 task 里补上转换。
- [ ] **Step 2: 跑这四个测试文件** → FAIL。 **Step 3: 实现。** **Step 4: 跑** → PASS，再跑 `bun test src/services/api src/utils/__tests__/effort.test.ts` 确认原有测试不坏（坏了的只按新规则改断言，并在提交说明里写清）。
- [ ] **Step 5: 提交** `feat: send each provider its native thinking-strength parameter (reasoning_effort, thinkingLevel/Budget, output_config.effort, budgets); adaptive thinking for Claude 4.6+ by version`。

### Task E6: 参数被拒——去掉重发、记住、报回

**Files:**
- Create: `src/services/api/effortRejection.ts`
- Modify: `src/services/api/openai/index.ts`（chat 请求最多两次：第一次 400/422 → 第二次不带 `nativeEffort`）、`src/services/api/gemini/index.ts`、`src/services/api/grok/index.ts`（同样）
- Modify: `src/services/api/withRetry.ts:384-416` 一带（Claude 路径：400/422 且请求带了原生 effort / 思考预算 → 立刻重试一次；重试时 `effortPlan` 已看到被拒记录，参数自然去掉）
- Modify: `src/QueryEngine.ts:983-1001`（内部 `cw_capability` 系统消息转成 SDK 消息 `{type:'system', subtype:'cw_capability', model, capability:'native_effort', supported:false, param, status, session_id, uuid}`）
- Test: `src/services/api/__tests__/effortRejection.test.ts`、`src/services/api/openai/__tests__/effortRetry.test.ts`

**Interfaces:**
- Consumes: E3 的 `markNativeEffortRejected`、`capabilityMessage`。
- Produces: `export function namedEffortParam(status: number, text: string): string | undefined`（400/422 且文本点名 Global Constraints 里的七个参数之一 → 返回那个名字）；`export function isParamRejection(status: number): boolean`（400 或 422）。

- [ ] **Step 1: 写失败的测试**：
  - `namedEffortParam(400, 'Unrecognized request argument supplied: reasoning_effort')` → `'reasoning_effort'`；`(422, '... thinkingLevel is not supported')` → `'thinkingLevel'`；`(400, 'invalid request')` → undefined；`(500, 'reasoning_effort')` → undefined。
  - OpenAI 重发（假客户端）：第一次 400 点名 `reasoning_effort` → 第二次请求没有它、回答正常给出、流里有一条 `cw_capability` 消息、`isNativeEffortRejected` 为 true。
  - Review Focus 1：第一次 400 文本是 `invalid request` → 第二次照样不带参数且回答给出，但**没有** `cw_capability`、`isNativeEffortRejected` 仍为 false。
  - 第二次也失败 → 照现在的方式报 `API Error: …`，不再重发第三次。
- [ ] **Step 2: 跑** → FAIL。 **Step 3: 实现。** **Step 4: 跑** → PASS。
- [ ] **Step 5: 提交** `feat: a refused thinking-strength parameter is dropped for that request, remembered when the error names it, and reported as cw_capability`。

### Task E7: 提示词方式、深度编排、对话中途改档

**Files:**
- Modify: `src/utils/attachments.ts`（类型表约 :708 加两个附件；:885 一带用 `maybe(…)` 注册，**只在主线程**）
- Modify: `src/utils/messages.ts:4610` 一带（两个附件渲染成 system-reminder）
- Modify: `src/state/AppStateStore.ts:434, 573`（加 `ultracode?: boolean`、`ultracodeNotice?: 'on' | 'off'`）
- Modify: `src/utils/effort.ts:182-191`（`resolveAppliedEffort`：`ultracode` 开着时用 `'xhigh'`，effortValue 不动，所以关掉后回到原档）
- Modify: `src/utils/settings/types.ts:760-767`（`effortLevel` 枚举对所有人都含 `max`；新增 `ultracode: z.boolean().optional()`）
- Modify: `src/utils/settings/applySettingsChange.ts:70-89`（`ultracode` 变了就写 `AppState.ultracode` 和 `ultracodeNotice`）
- Modify: `src/main.tsx:1374-1384`（`--effort` 收 `xhigh`；新增 `--ultracode`，启动时 `ultracode:true, ultracodeNotice:'on'`）
- Test: `src/utils/__tests__/reasoningDepth.test.ts`、`src/utils/__tests__/ultracodeMode.test.ts`、`src/utils/settings/__tests__/applySettingsChange.ultracode.test.ts`

**Interfaces:**
- Consumes: E4 的 `effortPlan`。
- Produces:
  - 附件 `{type:'reasoning_depth'; level: EffortLevel}`：主线程每轮、`effortPlan(当前 provider, 主模型, 生效档位)` 是 prompt 时加；
  - 附件 `{type:'ultracode_mode'; on: boolean; playbook: boolean}`：`ultracodeNotice === 'on'` 时 `{on:true, playbook:true}` 并清掉 notice；之后 `ultracode` 开着的每轮 `{on:true, playbook:false}`；`ultracodeNotice === 'off'` 时一次 `{on:false, playbook:false}`；
  - 渲染文字：`reasoning_depth` 用 spec §2.3 的五句原文；`ultracode_mode` on 用 `Ultracode is on for this session: author and run a workflow for every substantive task by default.`，`playbook:true` 时后面再接 `src/skills/bundled/ultracode.ts` 的 `ULTRACODE_PROMPT`（需要时 export）；off 用 `Ultracode is off for this session.`
  - claude-web 在运行中用 `query.applyFlagSettings({effortLevel, ultracode})` 改这两件事。

**Ruling（偏离 spec §2.5 / §3.1 的实现方式）**：spec 写的是新控制请求 `set_effort` / `set_ultracode`；但 Agent SDK 的 `Query`
发不了自定义的控制请求，而它现成的 `applyFlagSettings` 在引擎里已经会把新的 `effortLevel` 写进 AppState
（`applySettingsChange.ts:70-89`）。所以改用 settings 键 `effortLevel`（对所有人都收 `max`）+ 新键 `ultracode`，
效果和 spec 相同（不重启、下一个请求生效），协议不加东西。代价：如果用户的 `~/.claude/settings.json` 里写了 `effortLevel`，
它只决定启动时的初始值，之后以我们发的为准（和现在 `--effort` 的优先级一致）。

- [ ] **Step 1: 写失败的测试**：
  - `reasoning_depth` low / max 渲染出的文字与 spec §2.3 原文完全相同（逐字比较）；原生模型（claude-opus-5-5）不产生这个附件；gpt-4o + high 产生；
  - 深度编排：第一轮 `playbook:true`，第二轮 `playbook:false`，关掉后一轮 `on:false`，再一轮什么都没有；
  - 开着时 `resolveAppliedEffort` 为 `xhigh`，关掉后回到原来的 `low`；
  - `applySettingsChange` 收到 `{ultracode:true}` → AppState.ultracode 为 true、notice `'on'`；收到 `{effortLevel:'max'}`（非 ant 用户）→ effortValue 为 `'max'`；
  - `--effort xhigh` 能解析。
- [ ] **Step 2: 跑** → FAIL。 **Step 3: 实现。** **Step 4: 跑** → PASS。
- [ ] **Step 5: 提交** `feat: thinking strength through a per-turn reminder on models without the parameter; ultracode for every model (flag, setting, reminder); effort xhigh/max via settings and --effort`。

### Task E8: 自动判断——强制工具关思考、逐级退回、重试

**Files:**
- Modify: `src/utils/sideQuery.ts:632-807`（OpenAI / Grok 分支）、`:814` 起（Gemini 分支只加重试）
- Modify: `src/services/api/openai/requestBody.ts`（主循环里的强制工具调用——联网搜索的 haiku 路径 `WebSearchTool/adapters/apiAdapter.ts:81-83`——`toolChoice` 是指名 / `required` 时不开思考三件套，改发上面同样的关闭字段）
- Test: `src/utils/__tests__/sideQuery.forcedTool.test.ts`、`src/services/api/openai/__tests__/requestBody.forcedTool.test.ts`

**Interfaces:**
- Consumes: E3 的 `getWebModelCaps`；E6 的 `isParamRejection`。
- Produces: `export function thinksByDefault(model: string): boolean`（caps `reasoning === true`，或名字含 `deepseek` / `mimo`）。

**Ruling（偏离 spec §3.2 的一句）**：spec 说「OpenAI 侧路请求用自己的客户端实例」，那是为了能重试；这里自己写一次重试循环，主循环那个 `maxRetries:0` 的缓存客户端照用，不另建实例——效果相同，少一处状态。

- [ ] **Step 1: 写失败的测试**（假 OpenAI 客户端记录每次请求）：
  - 强制工具 + `deepseek-flash` + 非官方地址 → 第一次请求就带 `thinking:{type:'disabled'}`、`enable_thinking:false`、`chat_template_kwargs:{thinking:false, enable_thinking:false}`；
  - 基地址是 `https://api.openai.com/v1` → 这三个字段都不发；
  - 400「Thinking mode does not support this tool_choice」→ 第二次关思考；再 400 点名 `tool_choice` → 第三次 `tool_choice:'auto'`，回答里有 `classify_result` 调用就照常返回；
  - 503 → 等 1.5 s 重试一次后成功（用假计时器）；429 带 `retry-after: 3` → 等 3 s；`retry-after: 30` → 只等 10 s；
  - 不是强制工具的侧路请求不加思考字段；
  - `buildOpenAIRequestBody` 对 `deepseek-flash` + `toolChoice: {type:'function', function:{name:'web_search'}}` 不带 `thinking:{type:'enabled'}`，而是带 `thinking:{type:'disabled'}`。
- [ ] **Step 2: 跑** → FAIL。 **Step 3: 实现。** **Step 4: 跑** → PASS，再跑 `bun test src/utils/__tests__/sideQuery.chatgptAuth.test.ts`。
- [ ] **Step 5: 提交** `fix: auto mode on thinking-by-default models — forced tool calls go with thinking off, fall back step by step, and side queries retry once`。

### Task E9: 发布工作流 + 本地包

**Files:**
- Create: `.github/workflows/publish.yml`
- Create: `CLAUDE-WEB.md`（这个分支和上游的差别：一节一个改动、对应文件；以后合并上游时看）

**Interfaces:**
- Produces: `C:\Users\YPY\claude-code\claude-web-engine-2.8.4-cw.1.tgz`（`npm pack` 产物，claude-web 在发布前用它）。

- [ ] **Step 1: 写工作流**：`on: push: tags: ['v*-cw.*']`；`ubuntu-latest`；`oven-sh/setup-bun`（固定到提交 SHA，bun `1.4.2`）；`bun install --frozen-lockfile`；`bun test src/services/api/__tests__ src/utils/model/__tests__ src/utils/__tests__/reasoningDepth.test.ts src/utils/__tests__/ultracodeMode.test.ts src/utils/__tests__/sideQuery.forcedTool.test.ts scripts/__tests__`；`bun run build:vite`；`actions/setup-node`（固定 SHA，registry `https://registry.npmjs.org`）；`npm publish --access public`，`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`；`permissions: contents: read`。
- [ ] **Step 2: 本地全量验证** `bun run typecheck && bun test && bun run build:vite && npm pack` → typecheck / 测试通过（原本就挂的上游测试先记下名单，不算回归）、产出 tgz。
- [ ] **Step 3: 冒烟**：临时 HOME 下 `node dist/cli-node.js -p "say ok" --output-format stream-json --verbose`，环境 `CLAUDE_CODE_USE_OPENAI=1`、`OPENAI_BASE_URL` 指向一个只回固定流的本地假服务器（照 claude-web `server/ws-phase18.mjs` 的 chat 假上游写在 scratchpad）→ 有 `result` 行、exit 0。
- [ ] **Step 4: 提交** `ci: publish claude-web-engine on v*-cw.* tags; notes on what differs from upstream`。**推送分支先问用户。**

---

## claude-web

所有命令在 `C:\Users\YPY\claude-web`。单测 `npx vitest run --root server <文件>` / `--root web`。

### Task W1: 换到 claude-web-engine

**Files:**
- Modify: `package.json:31`（`"claude-code-best": "^2.8.4"` → `"claude-web-engine": "file:../claude-code/claude-web-engine-2.8.4-cw.1.tgz"`；发布后在 W7 换成 `"2.8.4-cw.1"`）
- Modify: `server/src/claude-exe.ts:84-100, 133-230`（候选只剩内置的 `claude-web-engine` 和环境变量指定的路径；删全局 claude-code-best、删 `engine.update` 的 `npm i -g`）
- Modify: `server/src/search/service.ts:14`（`require.resolve('claude-web-engine/package.json')`）
- Modify: `electron-builder.yml:45`（`**/node_modules/claude-web-engine/**`；`@claude-code-best/**` 保留）
- Modify: `server/src/protocol.ts:387`（删 `engine.update`）、`server/src/ws/hub.ts`（删对应 case）
- Modify: `web/src/features/panels/ConfigPanel.tsx:71-72`（去掉「更新」按钮；显示 `claude-web-engine（基于 ccb 2.8.4）v<版本>`）、`web/src/features/settings/UpdateSection.tsx:30`（说明改成「运行内核随应用一起更新」）、`web/src/features/settings/catalog.ts:68`（keywords 加 `claude-web-engine`）
- Test: `server/src/claude-exe.test.ts`

**Interfaces:**
- Produces: `resolveEngine()` 返回内置 `claude-web-engine`（`runtime: 'ccb'`、`source: 'bundled'`）；`engineInfo().version` 为 `2.8.4-cw.1`。

- [ ] **Step 1: 改测试**：`claude-exe.test.ts` 里造的 `ccb/cli-node.js` 候选改成 `claude-web-engine` 的目录形状；新增：全局 npm 目录里放一个 `claude-code-best/dist/cli-node.js` 也**不会**被选中；版本解析认 `2.8.4-cw.1`。
- [ ] **Step 2: 跑** `npx vitest run --root server src/claude-exe.test.ts` → FAIL。
- [ ] **Step 3: 实现**，`npm install` 装上本地 tgz。
- [ ] **Step 4: 验证** 单测 PASS；`npm run typecheck`；`npm run build -w server`；`node server/ccb-smoke.mjs node_modules/claude-web-engine/dist/cli-node.js` 能跑通（脚本里的默认路径改成新包）。
- [ ] **Step 5: 提交** `feat: run on our own engine (claude-web-engine 2.8.4-cw.1) instead of claude-code-best`。

### Task W2: 供应商的模型档位与「只能提示词」记录

**Files:**
- Modify: `server/src/protocol.ts`（`Provider` 加 `modelEfforts?: Record<string, {levels: EffortLevel[]; default?: EffortLevel}>`、`promptEffortModels?: string[]`；`ProbeResult` 同步加 `modelEfforts`）
- Modify: `server/src/providers/service.ts`（`parseModelList()` 也解析 `effort.supported_levels` / `default_level`，只收五个合法值；`refreshModels` / `probe` 写 `modelEfforts`（没有就 null 清掉））
- Modify: `server/src/meta/store.ts:179`（清理表加 `modelEfforts`、`promptEffortModels`）
- Modify: `web/src/features/providers/QuickConnect.tsx`、`web/src/features/panels/ConfigPanel.tsx`（照 `modelNames` 的方式带上 `modelEfforts`；「保存后重新检测」那一处一并发 `promptEffortModels: null`）
- Test: `server/src/providers/refresh.test.ts`

**Interfaces:**
- Produces: `parseModelList(raw) → {models, modelNames?, modelEfforts?}`。

- [ ] **Step 1: 写失败的测试**：
  - DeepSeek 形状 `{id:'deepseek-flash', effort:{supported_levels:['low','high','max'], default_level:'high'}}` → `modelEfforts['deepseek-flash']` 为 `{levels:['low','high','max'], default:'high'}`；
  - `supported_levels:['turbo']` → 不出现这个模型；
  - refresh 存下、下一次列表里没有就清掉；
  - Review Focus 5：`upsertProvider({id, promptEffortModels: null})` 之后字段不存在。
- [ ] **Step 2: 跑** → FAIL。 **Step 3: 实现。** **Step 4: 跑** → PASS，`npm run typecheck`。
- [ ] **Step 5: 提交** `feat: keep each provider model's thinking-strength levels from its model list, and which models only take the prompt way`。

### Task W3: 能力表、给引擎的 caps、会话 info

**Files:**
- Modify: `server/src/models/catalog.ts`（新增下面三个函数；`supportsUltracode` 在 ccb 运行时也为 true）
- Modify: `server/src/runtime/session-runner.ts:290-300`（spawn env 加 `CLAUDE_WEB_MODEL_CAPS`）、`:376-387`（`info.models`：所有模型 `supportsEffort:true`、`supportedEffortLevels`、`effortMode`；删掉 `effortGoesOut`；`supportsUltracode` 去掉 `runtime !== 'ccb'`）
- Modify: `server/src/protocol.ts`（会话模型信息加 `effortMode?: 'native' | 'prompt'`）
- Test: `server/src/models/catalog.test.ts`、`server/src/runtime/session-runner.test.ts`

**Interfaces:**
- Consumes: W2 的 `Provider.modelEfforts` / `promptEffortModels`。
- Produces:
  - `export function nearestLevel(level: EffortLevel, available: readonly EffortLevel[]): EffortLevel`（规则同引擎 E4）
  - `export function modelCaps(p: Pick<Provider, 'type' | 'modelEfforts' | 'promptEffortModels'> | undefined, model: string): {levels: EffortLevel[]; default?: EffortLevel; reasoning: boolean; native: boolean}`：levels 来源 `modelEfforts` > 表（与 E4 的目标规则同口径：Claude 4.6 起五档、老 Claude 五档（预算）、OpenAI 推理家族 low/medium/high、DeepSeek low/high/max、Gemini 3 low/high、Gemini 2.5 五档、grok-3-mini low/high）> 五档；`native` = 表里能原生 && 不在 `promptEffortModels`；`p` 为 undefined = Claude 账号（firstParty）
  - `export function webCapsEnv(p, models: string[]): string`（`CLAUDE_WEB_MODEL_CAPS` 的值）
  - 这里的档位类型是 `type ClaudeEffort = Exclude<EffortLevel, 'ultra'>`（`ultra` 是 Codex 自己的一档，不进 caps）。

- [ ] **Step 1: 写失败的测试**：
  - `modelCaps(deepseek 档位, 'deepseek-flash')` → levels `['low','high','max']`、default `'high'`、native true；
  - 同一模型在 `promptEffortModels` 里 → native false；
  - openai 的 `gpt-4o` → 五档、native false；
  - 账号的 `claude-opus-5-5` → 五档、native true；
  - runner 起进程时 env 里有 `CLAUDE_WEB_MODEL_CAPS` 且能 JSON 解析出这个供应商的模型；`info.models` 每项 `supportsEffort` 为 true，gpt-4o 的 `effortMode` 为 `'prompt'`；ccb 运行时 `supportsUltracode` 为 true。
- [ ] **Step 2: 跑** → FAIL。 **Step 3: 实现。** **Step 4: 跑** → PASS。
- [ ] **Step 5: 提交** `feat: tell the engine what each model can do (CLAUDE_WEB_MODEL_CAPS); every model offers thinking strength and 深度编排 on our engine`。

### Task W4: 改档 / 深度编排不重启；收被拒事件

**Files:**
- Modify: `server/src/runtime/session-runner.ts:666-690`（ccb 运行时：`setEffort` → `q.applyFlagSettings({effortLevel: level === 'ultra' ? 'max' : level, ultracode: false})`；`setUltracode(on)` → `q.applyFlagSettings({ultracode: on})`；都不 `respawnWhenIdle()`；官方二进制保持 `/effort`）；启动参数在 `info.ultracode` 时 `extraArgs.ultracode = null`（→ `--ultracode`）
- Modify: 同文件的消息泵（认 `subtype === 'cw_capability'`：通过注入的回调写 `Provider.promptEffortModels`（去重，`upsertProvider(…, {mustExist:true})`），刷新 `info.models` 的 `effortMode`，不往外 emit 这条消息）
- Modify: `server/src/runtime/pool.ts`（给 runner 注入写回回调，同 `cacheKey` 等依赖的注入方式）
- Test: `server/src/runtime/session-runner.test.ts`

- [ ] **Step 1: 写失败的测试**（现有 mock query）：
  - ccb 上 `setEffort('max')` 调了一次 `applyFlagSettings({effortLevel:'max', ultracode:false})`，**没有**新进程；
  - Review Focus 4：深度编排开着时 `setEffort('low')` → 同一次调用带 `ultracode:false`，`info.ultracode` 为 false；
  - `setUltracode(true)` → `applyFlagSettings({ultracode:true})`；之后 respawn（换供应商）时 argv 含 `--ultracode`；
  - 官方二进制上 `setEffort` 仍发 `/effort high`；
  - 收到 `cw_capability`（model `gpt-x`、param `reasoning_effort`）→ 回调被调一次、参数是供应商 id 和 `gpt-x`；`info.models` 里它变成 `'prompt'`；这条消息没有被 emit 出去。
- [ ] **Step 2: 跑** → FAIL。 **Step 3: 实现。** **Step 4: 跑** → PASS，`npm test -w server`。
- [ ] **Step 5: 提交** `feat: change thinking strength and 深度编排 without restarting the conversation; remember models whose native parameter was refused`。

### Task W5: 菜单

**Files:**
- Modify: `web/src/features/models/menu.ts`（删 `effortStaysHome()` 及调用处）
- Modify: `web/src/features/models/intelligence.ts`（`effortSegments` 用会话 info / `modelCaps` 的档位；`effortCaption` 在原句后接「（原生）」或「（通过提示词）」；提示词方式的 tooltip `这个模型没有思考强度参数，通过提示词告诉它想多深`）
- Modify: `web/src/features/composer/Composer.tsx:164, 719, 751`（「深度编排」开关的出现条件：欢迎页按将要用的运行内核——ccb 上所有模型；运行中的对话看 `info.supportsUltracode`）、`web/src/features/models/ModelMenu.tsx`（开关说明末尾加「会开很多个子任务，费 token」）
- Modify: 欢迎页（没有会话 info 时）用 `@catalog` 的 `modelCaps` 算档位（`Composer.tsx` 里现在算欢迎页档位的地方）
- Test: `web/src/features/models/intelligence.test.ts`、`web/src/features/models/menu.test.ts`

- [ ] **Step 1: 写失败的测试**：
  - openai 供应商的 `deepseek-flash`（档位 low/high/max）→ 分段只有三档，默认亮「深入」；说明含「（原生）」；
  - `gpt-4o` → 五档，说明含「（通过提示词）」；
  - Gemini 供应商的模型也有分段（以前没有）；
  - 深度编排开关对 openai 供应商的模型出现。
- [ ] **Step 2: 跑** → FAIL。 **Step 3: 实现。** **Step 4: 跑** `npm test -w web`（含 `wording.test.ts`）→ PASS。
- [ ] **Step 5: 提交** `feat(web): every provider and model shows 智能程度 (native or via the prompt) and 深度编排`。

### Task W6: 端到端 phase 22 + 回归

**Files:**
- Create: `server/ws-phase22.mjs`
- Modify: `scripts/e2e.mjs`（默认列表加 22）

**Interfaces:**
- Consumes: 真引擎（W1 装上的）、W2–W4 的全部行为。

- [ ] **Step 1: 写 phase 22**（自己起 server：临时 HOME、`CW_NO_PUBLIC_BROKERS=1`、`CW_NO_MODEL_REFRESH=1`；假上游在本进程里，记录每个请求体），断言：
  - Anthropic 格式供应商 `claude-opus-5-5` + max → `/v1/messages` 体含 `output_config.effort:"max"`、`thinking.type:"adaptive"`；
  - OpenAI 格式供应商 + `deepseek-flash`（假 `/v1/models` 带 `effort.supported_levels`）+ 选「更深」→ chat 体 `reasoning_effort:"max"`；
  - 同一对话改成 low → 进程 pid 不变，下一个请求 `reasoning_effort:"low"`；
  - `gpt-4o` + high → 体里没有 effort 字段，最后一条 user 消息含 `Reasoning depth: high.`；
  - 假上游对 `reasoning_effort` 回 400「Unrecognized request argument supplied: reasoning_effort」→ 回答照样给出、供应商 `promptEffortModels` 含该模型、下一轮请求带提示词不带参数；
  - Gemini 格式 `gemini-3-pro` + high → `thinkingConfig.thinkingLevel:"high"`；
  - 打开深度编排 → 下一个请求的 user 消息含 `Ultracode is on for this session`；
  - 权限模式「自动判断」+ `deepseek-flash` 跑一条 Bash → 判断请求带 `thinking:{"type":"disabled"}` 和 `tool_choice` 指名 `classify_result`。
- [ ] **Step 2: 跑** `npm run build:all && node scripts/e2e.mjs 22` → 全部 PASS。
- [ ] **Step 3: 回归** `node scripts/e2e.mjs`（默认全部）、`npm test`、`npm run typecheck`、`node scripts/ui-smoke.cjs` → 全过（ui-smoke 的偶发项重跑一次再判断）。
- [ ] **Step 4: 提交** `test(e2e): phase 22 — each provider gets its native thinking-strength parameter, the prompt way, refusal fallback, no restart on change, ultracode, auto-mode classifier`。

### Task W7: 真机、文档、发布准备

**Files:**
- Modify: `CLAUDE.md`（「引擎（单运行时）与供应商档案」一节：引擎是 `claude-web-engine`、fork 与分支、发布流程；`ccb 2.8.4 的「自动判断」没有判断提示词` 那条改成「已在 cw.1 修好」；「ccb 没有 headless 的 `/effort`」那条改成 `applyFlagSettings`；新增「思考强度 / 深度编排在所有模型上」一节，写 caps 环境变量、`cw_capability`、提示词方式）
- Modify: `CHANGELOG.md`（「未发布」：新增 3 条——所有模型都有智能程度（原生或提示词）、深度编排所有模型可用、换成自己的引擎；修复 1 条——自动判断的判断规则以前没有加载）
- Modify: `README.md:418, 488`、`site/index.html:447`、`site/page.html:440`（引擎名字）
- Modify: `package.json`（发布后把依赖换成 `"claude-web-engine": "2.8.4-cw.1"`，`npm install` 重生成 lock）

- [ ] **Step 1: 真机**（Key 只在 scratchpad，脚本也在 scratchpad）：用 W1 后的 server（临时 HOME）接官方 DeepSeek：
  - `deepseek-flash` 选 low / max 各一轮，抓包确认 `reasoning_effort`；
  - 「自动判断」跑 `python -c "print(6*7)"` 不弹权限、拿到 42；
  - 打开深度编排问一个小任务，看到 Workflow 工具被调用；
  - 用之前测试过的 Claude 格式中转跑 `claude-opus-5-5` + high 一轮，不再 400「requires adaptive thinking」。

  四项结果记进 scratchpad 的报告。
- [ ] **Step 2: 去掉绕行**（只在 Step 1 的 Claude 中转一项通过时做；不通过就留着并在报告里写原因）：删 `server/src/models/catalog.ts` 的 `ccbMisthinks()` 和 `preferredRuntime()` 里按它选官方二进制的分支，`server/src/runtime/user-env.ts` 里同样的判断、`session-runner.ts` 的 `plan()` 里 `noThinking`（`CLAUDE_CODE_DISABLE_THINKING=1`）那条退路；对应单测改成「Claude 5 在 ccb 上照常跑」。只认官方客户端指纹的中转（档案 `runtime:'claude'`）不受影响。跑 `npm test -w server`。
- [ ] **Step 3: 改文档**（上面的文件）。
- [ ] **Step 4: 提交** `docs: our own engine, the same thinking strength / 深度编排 / 自动判断 on every model`（Step 2 做了的话另起一个提交 `refactor: Claude 5 runs on our engine again — drop the ccbMisthinks detour`）。
- [ ] **Step 5: 停下来问用户**：
  1. 推送 fork 的 `claude-web` 分支；
  2. 在 fork 里 `npm login` + `npm publish --access public`（或者给 fork 加 `NPM_TOKEN` 后推 `v2.8.4-cw.1` tag）；
  3. 发布后 claude-web 换成 registry 版本、重跑 `npm test` + `node scripts/e2e.mjs 18 19 20 22`；
  4. 推送 claude-web、发 v0.1.8。

  每一项都等用户点头。
