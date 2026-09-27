# 统一会话库 设计

日期：2026-09-27 · 状态：待审

## 背景与路线

用户希望 claude-web 成为本机所有 CLI agent 的中枢，参考 Mirasim、[magpie](https://github.com/yetone/magpie)、[AiMaMi](https://github.com/borawong/AiMaMi)。整体拆成四个子项目，按依赖顺序各自走 spec → plan → 实施：

1. **统一会话库**（本文档）
2. 多 agent 编排：步骤分派给不同 agent、各自 worktree 并行比选、审批节点、执行图
3. 跨机器会话：多台机器的会话合并到一个侧栏，远程会话直接打开 / 交接
4. 模型网关：Anthropic / OpenAI / Gemini 协议转换 + 故障转移组；多账号额度耗尽自动切换（AiMaMi）

暂不排期、可能的第 5 块：其它 agent 的配置中心（Codex 的 MCP / Skills / AGENTS.md 等，对应 AiMaMi 的配置管理）。

明确不做：借用 Claude / ChatGPT / Google 订阅登录给别的 agent 用（magpie 的「订阅共享」）——违反服务条款、有封号风险。

## 目标

本机任何 agent 开过的会话，都能在 claude-web 里：

1. **找回和翻看**：统一列表、跨 agent 全文搜索、完整历史（工具卡片 / diff 照常渲染）
2. **在原 agent 里续聊**：原生恢复，新的轮次写回 agent 自己的记录，命令行里也看得到
3. **换个 agent 接着干**：用已有的交接机制（canonical 时间线 + 交接简报）
4. **作为素材引用**：把历史会话当上下文引用进新会话；编排（子项目 2）复用同一机制

成功标准：侧栏能看到本机 Claude（122）、Codex（约 720）、OpenCode（11）的全部会话并标明来源；一个搜索框搜所有；点开看完整历史；能续聊。

## 约束（用户决定）

- **修改只走官方接口**：rename / archive / delete 等只在 agent 提供官方 API 时开放；没有 API 的只读。不直接改写 agent 的数据文件。
- **架构 A**：每个 agent 一个适配器，实时查询、真相留在 agent 那边；另建全文索引做跨 agent 搜索。
- 删除前先备份。
- **加入是可选的**（用户 2026-09-27 补充）：系统自动检测本机有哪些 agent，但除 Claude 外默认不加入；用户在侧栏提示或「设置 → 会话库」里逐个选择加入 / 移出。未加入的来源不启动后台进程、不列会话、不建索引。后续的编排（子项目 2）同样只用用户选定的 agent。

## 架构

新目录 `server/src/library/`。

### SessionSource（适配器接口）

```ts
interface SessionSource {
  kind: AgentKind;                       // 'claude' | 'codex' | 'opencode' | 'acp:<id>' …
  detect(): Promise<SourceStatus>;       // installed / version / enabled / disabledReason
  list(o: { cursor?: string; limit: number; archived?: boolean }): Promise<{ items: LibrarySession[]; next?: string }>;
  read(nativeId: string, o: { cursor?: string; limit: number }): Promise<{ messages: SDKMessageLike[]; next?: string }>;
  caps: { resume: boolean; rename: boolean; archive: boolean; delete: boolean; fork: boolean };
  rename?(nativeId: string, title: string): Promise<void>;
  archive?(nativeId: string, archived: boolean): Promise<void>;
  remove?(nativeId: string): Promise<void>;
  exportForBackup?(nativeId: string): Promise<unknown>;   // 删除前的完整导出
}
```

- `read()` 的输出是 claude-web 现有的 SDK 消息形状，前端 reducer / 工具卡片 / diff / 时间线零改动。
- `LibrarySession` 在 `SessionSummary` 基础上加 `source`（cli / vscode / exec / appServer …）、`parentId`（子代理线程挂到父会话下）、`archived`。

### LibraryService

- 汇总所有启用的适配器，按时间排序、分页（游标跨来源合并）。
- 取代 hub 里现在的 `sessions.list = sessions.list() + transcripts.list()` 拼接；Claude 的行为不变。
- **去重**：在 claude-web 里开过的 Codex 会话（`~/.claude-web/agents/<sid>.jsonl`，头部有 `nativeSessionId`）按线程 id 与导入的线程合并，只显示一条。

### 会话 id

- Claude：原 UUID 不变。
- 其它：`<agent>-<原生 id>`，例如 `codex-019a…`、`opencode-ses_0d7a…`。不用冒号（Windows 文件名不允许）。
- 置顶、标签、草稿、runner 键都按这个 id。

### 真相与续聊

- 导入会话的历史**永远从 agent 自己读**。在这里续聊时，新轮次写进 agent 的原生记录（Codex 线程 / OpenCode 会话），命令行里也能看到。
- 续聊 = `RunnerPool.open({ sessionId: 'codex-…' })` → 按前缀选驱动，驱动拿原生 id 直接 `thread/resume` / ACP `session/load`。
- 换 agent 接着干 = 现有 `session.switchAgent`（`session/swap.ts` 的 `swapAgent`）交接路径，简报从适配器 `read()` 的结果生成。

### 搜索索引

- `~/.claude-web/library.db`，`node:sqlite` + FTS5（与共享记忆同一套，含中文 LIKE 回退）。
- 每个会话存：id、agent、source、cwd、标题、首条消息、更新时间、正文摘录（用户与助手文本，单会话上限约 20 KB）。
- 增量刷新：按各来源的更新时间倒序翻页，碰到已索引且更新时间没变的就停。首次全量（约 720 个 Codex 会话）在后台节流进行，不阻塞界面。
- 文件变化（`~/.claude/projects`、`~/.codex/sessions`、OpenCode 数据目录）触发去抖后的增量刷新。

## 适配器

| Agent | 列表 / 读取 | 续聊 | 修改（仅官方接口） |
| --- | --- | --- | --- |
| Claude Code | SDK `listSessions` / `getSessionMessages`（不变） | 原生 resume、fork | 重命名、删除（SDK）；归档 / 置顶仍是 claude-web 自己的 |
| Codex | 专用 `codex app-server` 进程（按需启动，闲置 5 分钟退出）。`thread/list` 取 cli / vscode / exec / appServer 来源；`subAgent*` 线程按 `parentThreadId` 挂到父会话下。历史用 `thread/turns/list` 分页 | `thread/resume` | `thread/name/set`、`thread/archive` / `thread/unarchive`、`thread/fork`、`thread/delete` |
| OpenCode | 专用 `opencode serve`（回环、随机端口、闲置退出）。`GET /session`（跨项目）、`GET /session/{id}/message` | ACP（`opencode acp`）`session/load` | 按其 OpenAPI 文档（`/doc`）里存在的接口开放重命名 / 删除 |
| Gemini / Qwen / Kimi 等 ACP agent | 仅当 agent 声明支持 ACP `session/list` 时导入；否则只有在 claude-web 里开的（同现状） | 仅当声明 `loadSession` | 无 |
| Copilot | 本机没装 CLI，本期不做 | — | — |

- Codex 事项 → 消息的转换从 `codex-driver.ts` 抽成共享函数，实时对话与历史展示用同一套。
- 版本守卫：适配器启动时检查所需方法是否存在（Codex 用 `generate-ts` 同源的方法名，OpenCode 读 `/doc`）；缺了就禁用自己并在设置里写明原因，不影响其它来源。
- 删除：先 `exportForBackup()` 写到 `~/.claude-web/library-trash/<id>.json`（保留 30 天），再调官方删除；界面二次确认；批量操作默认归档。
- 库专用后台进程与正在跑的会话进程互不共用。

## 界面

- **侧栏**：顶部来源筛选（全部 / Claude / Codex / OpenCode …，带数量）；每行 agent 图标；去掉 500 上限，滚动加载 + 虚拟列表；仍按工作区分组，不属于任何工作区的会话归入「其它目录」；Ctrl / Shift 多选批量归档 / 打标签 / 删除，菜单按能力显示。
- **搜索**：侧栏筛选框与命令面板（Ctrl+K）查索引；结果带 agent、目录、高亮片段；支持 `agent:codex`、`in:<目录名>`。
- **打开导入的会话**：历史从最新一轮往上分页；输入框提示「用 Codex 继续」；会话头菜单：交给其它 agent 继续、重命名 / 归档 / 删除（按能力）、在原生 CLI 打开（终端标签执行 `codex resume <id>` 等）。
- **引用为上下文**：右键「引用」在输入框插入会话芯片；发送时服务端展开成该会话摘要（复用交接简报）。
- **设置 → 会话库**：每个 agent 的检测状态、版本、会话数、上次索引时间、禁用原因；开关；重建索引。

## 错误处理

- 单个适配器失败不影响其它：它的筛选项显示警告，继续提供上次缓存的列表。
- 后台进程崩溃按退避重启；读历史失败显示原因与重试。
- 索引损坏：备份后自动重建。
- 被引用的会话已删除 / 不可读：芯片标红，发送时提示而不是静默丢掉。

## 测试

- 单元：每个适配器配假的后端——假 Codex app-server（沿用现有 JSON-RPC mock）、假 OpenCode HTTP 服务（本机真实响应脱敏后做夹具）；分页合并与去重；索引增量刷新；中文搜索回归。
- 端到端：`server/ws-phase13.mjs`，临时 HOME + mock，加入 `scripts/e2e.mjs` 默认列表与 CI。
- 真实数据：对本机 Codex / OpenCode 会话只做列出、搜索、读历史、续聊；重命名 / 归档 / 删除只在测试时新建的会话上做。

## 不在本期

- Copilot / Cursor 等没有安装或没有官方接口的 agent 的导入。
- 跨机器（子项目 3）、编排本身（子项目 2）、模型网关（子项目 4）。
- 修改其它 agent 的配置文件。
