# 只留 Claude（2026-11-01，用户要求）

用户先让默认引擎换成官方 Claude Code，接着要求「把 ccb 彻底去掉，不需要支持 Claude 之外的供应商」，并选了最彻底的一档：连其它 agent 也删。
分支 `remove-non-claude`。删掉的代码都在这之前的提交里（`git log --diff-filter=D --stat -- server/src/gateway` 之类能找回）。

## 删了什么

- **我们自己的引擎**（claude-web-engine，ccb 2.8.4 的 fork）：根依赖、`resolveCcbEntry`、运行时选择（`RuntimeKind`、`Provider.runtime`、
  `CLAUDE_WEB_RUNTIME` / `CLAUDE_WEB_CCB`）、runner 里只为 ccb 的分支（`ccbModel` / `ccbAccountEnv` / `ccbMisthinks` / `cw_capability` /
  `CLAUDE_WEB_MODEL_CAPS` / `CLAUDE_WEB_CONTEXT_WINDOWS` / `--ultracode` / `ExecuteExtraTool` 放行）、ccb 专属开关（协调者、主动模式、频道）。
- **别的供应商格式**：`ProviderType` 只剩 `anthropic` / `claude-account`。OpenAI / Gemini / Grok / 模型网关档案、缓存垫片、
  「通过提示词」的思考强度、快速连接里的 DeepSeek / Kimi / GLM / 通义 / 硅基 / OpenRouter / Gemini 预设。
- **模型网关一族**（`server/src/{gateway,routing,channels,upstreams,engines,plugins,share,telemetry}`）：故障转移、协议转换、局域网监听、
  分享密钥、请求记录 / OTLP、智能路由、免费来源 / CLIProxyAPI / Magpie、Gemini 网页 / WorkBuddy 托管程序、来源插件、
  子代理用别家供应商的模型（分流路由）。前端 `features/{gateway,routing,share,plugins}`、设置里的「模型网关」。
- **其它 agent**（Codex、Gemini CLI、Qwen、Kimi、OpenCode、自定义 ACP、Cursor、DeepSeek Harness）：驱动、注册表、它们的配置中心、
  对话库里读它们的记录、「本机发现」、对话交给别的 agent、模型菜单里的 agent 分区、IM / 目标 / 编排选 agent、隐私中心的「自己登录的 Agent」。
- **侧栏里跟其它 agent 有关的两处**：对话库的发现提示（「把 Codex 里的对话也列在这里？」；`library.detect` / `announce` / `dismiss`、
  `library.discovered` 事件、`SourceStatus.dismissed`），和 显示 菜单里的「其它 agent 的对话」筛选（`SidebarView.show.otherAgents`；
  老 meta.json 里存着的这个键没人读）。

## 留下、挪动了的

- 隐私中转（`privacy/relay.ts`）以前挂在网关的监听上，现在由 `index.ts` 直接挂 `/gateway/~v/…`（路径没变，只收本机回环）；
  `gateway/upstream.ts` 挪到 `privacy/upstream.ts`，`plugins/archive.ts`（隐私模型的下载解压）挪到 `privacy/model/archive.ts`。
- `agents/` 里通用的进程工具（`resolve.ts` / `kill-tree.ts` / `locate.ts`）挪到 `server/src/proc/`。
- 图标栏原来的「模型」分区改叫「用量与隐私」：用量 / 隐私 / 操控 / 备份四页（备份只同步供应商、`models.*` 设置和隐私规则）。
- 对话库：Claude Code + claude.ai 数据导出（只读，「接着聊」开一个 Claude 对话）。
- 其它电脑上的对话：「交给本机的 Agent 继续」变成「在本机继续」（`session/swap.ts` 的 `handOverToClaude`）。
- 编排还在，节点都跑 Claude；「三方比选」模板删了，编辑器新建时不再给「比选」节点（存着的旧工作流照常显示）。
- 共享记忆还在（现在是对话之间共用）。

## 老数据

- meta.json 里的 OpenAI / Gemini / Grok / 网关档案：读文件时挪进 `removedProviders`（原样，钥匙也在），默认供应商是它们之一就清掉。
  网关组、账号池、密钥组等顶层字段留在文件里没人读。
- 账本里网关写的行（`kind: 'gateway'`）读的时候跳过。
- `~/.claude-web/agents/*.jsonl`（别的 agent 的对话镜像）不再列出，也没删。

## ui-smoke

- 以前要真权限请求 / 多轮目标的段落用 mock ACP agent；现在用 `scripts/fake-anthropic.cjs`：一个假的 Messages API（SSE），
  ui-smoke 建一个 `anthropic` 供应商指向它，**真的 Claude Code** 跑对话，不要 key、不花 token。按最后一条提示回答：
  「tool」→ Read 项目外的 `~/outside-note.txt`（CLI 先问权限）、「slow」→ `sleep 6`（种子 `~/.claude/settings.json` 放行，
  目标在每步询问下也不停）、工具结果出错 →「denied」、目标第一轮 `GOAL_STATUS: continue`、之后 `complete`；
  只有带 Read + Bash 工具的主对话请求才会拿到工具调用（标题生成等侧请求只回 Echo）。
- 临时 HOME 用 `realpathSync`：macOS 的 tmpdir 是 `/var → /private/var` 软链，SDK 按 cwd 的真实路径找项目目录，
  种在 `/var/...` 下的对话读回来是空的（Windows 上没这个问题，所以以前没暴露）。
- 输入框一行的检查用 780 宽：≤ 760 是手机布局（`MOBILE_QUERY`），那里一行就是 40px 的发送按钮高。

## 相关笔记

已删除的笔记：模型网关、上游页、智能路由、免费来源、其它 agent 的配置中心、多 agent（阶段 5）。

同一天把其余笔记清了一遍（只删 / 缩讲已删功能的段落，还能解释现有代码的留一行「历史」）：

- 大改、改了标题：「供应商：IM / 定时任务」（原「…/ 其它 Agent」）、「思考强度 / 深度编排」（原「…/ 自动判断在所有模型上」）、
  「续接位置 / 费用 / 切换竞态」（原「引擎切换 / …」）、「首次使用：接一个模型」（原「…/ Agent 检测」）、「网络代理 / 外部写入的对话」
  （原「…/ Codex 读取」）、「同步 / 出网守卫」（原「插件 / 同步 / 远程共享」：插件、市场、共享密钥、OTLP 只剩一段历史）。
- 大改、标题没变：「多模型管理」（子代理用别家模型 / 分流路由缩成一节历史，现在别家的选择 = 跟主模型）、「统一会话库」（只剩 Claude + claude.ai 两个来源）、
  「提示缓存」（缓存垫片、网关转换缩成历史）、「会话内核」、「ego lite」（ACP / Codex 两条路删了）、「从其它工具导入」（扫描只交出 MCP 和 Anthropic 格式供应商）。
- 小改（ccb / 其它 agent / 网关的句子改成现状或标成历史）：其余提到它们的笔记，包括侧栏、输入框、对话渲染、录屏界面、设置、首页、联邦、健壮性、
  安全审计（SEC-02 / 08 / 09 的代码已删）、macOS / CI（e2e 段落表）、桌面版（不再打包 sidecar）等。
- 没动：「多 agent 编排」（另行处理）。
